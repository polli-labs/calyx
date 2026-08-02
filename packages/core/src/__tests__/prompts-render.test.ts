import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderPromptTemplate } from "../prompts.js";

describe("renderPromptTemplate", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "calyx-prompts-render-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeRegistry(registry: unknown): Promise<string> {
    const registryPath = path.join(rootDir, "nested", "deep", "instructions", "prompts", "REGISTRY.json");
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    return registryPath;
  }

  async function writeTemplate(relativePath: string, content: string): Promise<string> {
    const templatePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(templatePath, content, "utf8");
    return templatePath;
  }

  test("renders a prompt by walking upward from the registry path", async () => {
    const templatePath = await writeTemplate(
      "instructions/prompts/review-pr.md",
      "# Review {{pr_number}}\n{{#focus_areas}}Focus: {{focus_areas}}\n{{/focus_areas}}",
    );
    const registryPath = await writeRegistry({
      version: "test",
      prompts: [
        {
          id: "review-pr",
          name: "Review PR",
          description: "Review a PR",
          category: "review",
          template_path: "instructions/prompts/review-pr.md",
          variables: ["pr_number"],
          optional_variables: ["focus_areas"],
          targets: ["manual-compose"],
        },
      ],
    });

    const result = await renderPromptTemplate({
      registryPath,
      promptId: "review-pr",
      variables: {
        pr_number: "57",
        focus_areas: "tests,docs",
      },
    });

    expect(result.registryPath).toBe(registryPath);
    expect(result.templatePath).toBe(templatePath);
    expect(result.renderedPrompt).toContain("# Review 57");
    expect(result.renderedPrompt).toContain("Focus: tests,docs");
    expect(result.unresolvedPlaceholders).toEqual([]);
  });

  test("fails when required variables are missing", async () => {
    const registryPath = await writeRegistry({
      version: "test",
      prompts: [
        {
          id: "review-pr",
          name: "Review PR",
          description: "Review a PR",
          category: "review",
          template_path: "instructions/prompts/review-pr.md",
          variables: ["pr_number"],
          targets: ["manual-compose"],
        },
      ],
    });
    await writeTemplate("instructions/prompts/review-pr.md", "# Review {{pr_number}}\n");

    await expect(
      renderPromptTemplate({
        registryPath,
        promptId: "review-pr",
        variables: {},
      }),
    ).rejects.toThrow(/missing required variables: pr_number/i);
  });

  test("fails on undeclared variables by default", async () => {
    const registryPath = await writeRegistry({
      version: "test",
      prompts: [
        {
          id: "review-pr",
          name: "Review PR",
          description: "Review a PR",
          category: "review",
          template_path: "instructions/prompts/review-pr.md",
          variables: ["pr_number"],
          targets: ["manual-compose"],
        },
      ],
    });
    await writeTemplate("instructions/prompts/review-pr.md", "# Review {{pr_number}}\n");

    await expect(
      renderPromptTemplate({
        registryPath,
        promptId: "review-pr",
        variables: {
          pr_number: "57",
          issue: "POL-891",
        },
      }),
    ).rejects.toThrow(/undeclared variables: issue/i);
  });

  test("can allow undeclared variables for caller-managed context injection", async () => {
    const registryPath = await writeRegistry({
      version: "test",
      prompts: [
        {
          id: "review-pr",
          name: "Review PR",
          description: "Review a PR",
          category: "review",
          template_path: "instructions/prompts/review-pr.md",
          variables: ["pr_number"],
          targets: ["manual-compose"],
        },
      ],
    });
    await writeTemplate("instructions/prompts/review-pr.md", "# Review {{pr_number}}\n");

    const result = await renderPromptTemplate({
      registryPath,
      promptId: "review-pr",
      variables: {
        pr_number: "57",
        issue: "POL-891",
      },
      failOnUndeclaredVariables: false,
    });

    expect(result.renderedPrompt).toContain("# Review 57");
    expect(result.undeclaredVariables).toEqual(["issue"]);
  });

  test("fails when placeholders remain unresolved after render", async () => {
    const registryPath = await writeRegistry({
      version: "test",
      prompts: [
        {
          id: "review-pr",
          name: "Review PR",
          description: "Review a PR",
          category: "review",
          template_path: "instructions/prompts/review-pr.md",
          variables: ["pr_number"],
          targets: ["manual-compose"],
        },
      ],
    });
    await writeTemplate("instructions/prompts/review-pr.md", "# Review {{pr_number}} for {{owner}}\n");

    await expect(
      renderPromptTemplate({
        registryPath,
        promptId: "review-pr",
        variables: {
          pr_number: "57",
        },
      }),
    ).rejects.toThrow(/unresolved placeholders.*owner/i);
  });
});
