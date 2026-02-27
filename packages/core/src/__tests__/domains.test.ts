import path from "node:path";
import { describe, expect, test } from "vitest";
import { deployAgentsRegistry, indexAgentsRegistry, renderAgentProfiles, validateAgentsRegistry } from "../agents";
import { indexKnowledgeRegistry, searchKnowledgeRegistry, linkKnowledgeArtifact, validateKnowledgeRegistry } from "../knowledge";
import { indexPromptsRegistry, validatePromptsRegistry } from "../prompts";
import { indexSkillsRegistry, validateSkillsRegistry } from "../skills";
import { indexToolsRegistry, validateToolsRegistry } from "../tools";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

describe("skills domain", () => {
  test("indexes active + deprecated skills by default", async () => {
    const root = fixtureRoot();
    const indexResult = await indexSkillsRegistry(path.join(root, "skills/registry.valid.json"));

    expect(indexResult.total).toBe(3);
    expect(indexResult.items.map((entry) => entry.id)).toEqual(["agents-fleet", "agents-fleet-bootstrap"]);
  });

  test("can include archived skills in index output", async () => {
    const root = fixtureRoot();
    const indexResult = await indexSkillsRegistry(path.join(root, "skills/registry.valid.json"), {
      includeArchived: true
    });

    expect(indexResult.items.some((entry) => entry.status === "archived")).toBe(true);
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
  test("indexes active + deprecated agents by default", async () => {
    const root = fixtureRoot();
    const indexResult = await indexAgentsRegistry(path.join(root, "agents/registry.valid.json"));

    expect(indexResult.total).toBe(4);
    expect(indexResult.items.map((entry) => entry.id)).toEqual(["blade-runner", "carbon-runner", "legacy-agent"]);
  });

  test("can include archived agents in index output", async () => {
    const root = fixtureRoot();
    const indexResult = await indexAgentsRegistry(path.join(root, "agents/registry.valid.json"), {
      includeArchived: true
    });

    expect(indexResult.items.some((entry) => entry.status === "archived")).toBe(true);
  });

  test("reports lifecycle validation errors for invalid registry", async () => {
    const root = fixtureRoot();
    const validation = await validateAgentsRegistry(path.join(root, "agents/registry.invalid.json"), {
      strict: true
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((issue) => issue.code === "agents.duplicate-id")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "agents.deprecated-missing-replacement")).toBe(true);
    expect(validation.errors.some((issue) => issue.code === "agents.archived-missing-date")).toBe(true);
  });

  test("renders agent profiles with hosts and capabilities", async () => {
    const root = fixtureRoot();
    const result = await renderAgentProfiles(path.join(root, "agents/registry.valid.json"));

    expect(result.profiles.length).toBe(3);
    const bladeRunner = result.profiles.find((p) => p.id === "blade-runner");
    expect(bladeRunner).toBeDefined();
    expect(bladeRunner!.name).toBe("Blade Runner");
    expect(bladeRunner!.status).toBe("active");
    expect(bladeRunner!.hosts).toEqual([{ host: "blade", role: "primary" }]);
    expect(bladeRunner!.capabilities).toEqual(["async-runner", "compute"]);
  });

  test("renders profiles including archived agents when requested", async () => {
    const root = fixtureRoot();
    const result = await renderAgentProfiles(path.join(root, "agents/registry.valid.json"), {
      includeArchived: true
    });

    expect(result.profiles.length).toBe(4);
    const archived = result.profiles.find((p) => p.id === "retired-agent");
    expect(archived).toBeDefined();
    expect(archived!.status).toBe("archived");
    expect(archived!.hosts).toEqual([]);
    expect(archived!.capabilities).toEqual([]);
  });

  test("render-profiles throws on invalid registry", async () => {
    const root = fixtureRoot();
    await expect(
      renderAgentProfiles(path.join(root, "agents/registry.invalid.json"))
    ).rejects.toThrow("Agents registry validation failed");
  });

  test("deploys agents with plan action by default", async () => {
    const root = fixtureRoot();
    const result = await deployAgentsRegistry(path.join(root, "agents/registry.valid.json"));

    expect(result.apply).toBe(false);
    expect(result.backend).toBe("all");
    expect(result.actions.length).toBe(3);
    expect(result.actions.every((a) => a.action === "plan-deploy")).toBe(true);
  });

  test("deploys agents with apply action when requested", async () => {
    const root = fixtureRoot();
    const result = await deployAgentsRegistry(path.join(root, "agents/registry.valid.json"), {
      apply: true,
      backend: "claude"
    });

    expect(result.apply).toBe(true);
    expect(result.backend).toBe("claude");
    expect(result.actions.every((a) => a.action === "deploy")).toBe(true);
    expect(result.actions.every((a) => a.details === "backend=claude")).toBe(true);
  });

  test("deploy throws on invalid registry", async () => {
    const root = fixtureRoot();
    await expect(
      deployAgentsRegistry(path.join(root, "agents/registry.invalid.json"))
    ).rejects.toThrow("Agents registry validation failed");
  });

  test("deploy throws on missing registry file", async () => {
    await expect(
      deployAgentsRegistry("/nonexistent/path/registry.json")
    ).rejects.toThrow("Failed to read agents registry");
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
