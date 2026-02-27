import path from "node:path";
import { describe, expect, test } from "vitest";
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
