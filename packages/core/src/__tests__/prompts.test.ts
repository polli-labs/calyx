import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { syncPromptsRegistry } from "../prompts";

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function yamlValue(value: string): string {
  return JSON.stringify(
    value
      .replaceAll("\r", "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(" ")
      .trim()
  );
}

function renderClaudePrompt(options: {
  description: string;
  body: string;
  argumentHint?: string;
  allowedTools?: string;
  model?: string;
  disableModelInvocation?: string;
}): string {
  const lines = ["---", `description: ${yamlValue(options.description)}`];
  if (options.argumentHint) {
    lines.push(`argument-hint: ${yamlValue(options.argumentHint)}`);
  }
  if (options.allowedTools) {
    lines.push(`allowed-tools: ${yamlValue(options.allowedTools)}`);
  }
  if (options.model) {
    lines.push(`model: ${yamlValue(options.model)}`);
  }
  if (options.disableModelInvocation) {
    lines.push(`disable-model-invocation: ${yamlValue(options.disableModelInvocation)}`);
  }
  lines.push("---", "", options.body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function renderCodexPrompt(options: {
  description: string;
  body: string;
  argumentHint?: string;
}): string {
  const lines = ["---", `description: ${yamlValue(options.description)}`];
  if (options.argumentHint) {
    lines.push(`argument-hint: ${yamlValue(options.argumentHint)}`);
  }
  lines.push("---", "", options.body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

async function listCalyxScratchPaths(root: string): Promise<string[]> {
  const matches: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (!(await pathExists(currentDir))) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.name.startsWith(".calyx-prompt-stage-") || entry.name.startsWith(".calyx-prompt-backup-")) {
        matches.push(absolutePath);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
      }
    }
  }

  await walk(root);
  return matches.sort();
}

async function createPromptsSyncFixture(): Promise<{
  root: string;
  home: string;
  registryPath: string;
  reviewBody: string;
  planBody: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-prompts-sync-"));
  const home = path.join(root, "home");
  const registryPath = path.join(root, "instructions", "prompts", "REGISTRY.json");
  const reviewPath = path.join(root, "instructions", "prompts", "review-pr.md");
  const planPath = path.join(root, "instructions", "prompts", "plan-review.md");
  const reviewBody = "# Review PR {{pr_number}}\n\nInspect the branch carefully.\n";
  const planBody = "# Review Plan {{plan_path}}\n\nCheck completeness.\n";

  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    reviewPath,
    [
      "---",
      "argument-hint: PR_NUMBER",
      "allowed-tools: Bash, Read",
      "model: sonnet",
      "disable-model-invocation: true",
      "---",
      "",
      reviewBody
    ].join("\n"),
    "utf8"
  );
  await writeFile(planPath, planBody, "utf8");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: "2026-04-18",
        schema_version: "1.0.0",
        prompts: [
          {
            id: "review-pr",
            name: "Review Pull Request",
            description: "Review a pull request",
            category: "review",
            template_path: "instructions/prompts/review-pr.md",
            variables: ["pr_number"],
            optional_variables: ["focus_areas"],
            targets: ["async-runner"]
          },
          {
            id: "plan-review",
            name: "Review Plan",
            description: "Review an implementation plan",
            category: "review",
            template_path: "instructions/prompts/plan-review.md",
            variables: ["plan_path"],
            targets: ["async-runner"]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return {
    root,
    home,
    registryPath,
    reviewBody,
    planBody
  };
}

describe("syncPromptsRegistry apply writer", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];
  const originalCodexHome = process.env["CODEX_HOME"];

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    if (originalCodexHome === undefined) {
      delete process.env["CODEX_HOME"];
    } else {
      process.env["CODEX_HOME"] = originalCodexHome;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("apply writes prompt files to Claude and Codex install trees", async () => {
    const fixture = await createPromptsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    expect(result.actions).toEqual([
      { action: "sync", id: "review-pr", details: "backend=all" },
      { action: "sync", id: "plan-review", details: "backend=all" }
    ]);

    const claudeDir = path.join(fixture.home, ".claude", "commands");
    const codexDir = path.join(fixture.home, ".codex", "prompts");
    await expect(readFile(path.join(claudeDir, "review-pr.md"), "utf8")).resolves.toBe(
      renderClaudePrompt({
        description: "Review a pull request",
        body: fixture.reviewBody,
        argumentHint: "PR_NUMBER",
        allowedTools: "Bash, Read",
        model: "sonnet",
        disableModelInvocation: "true"
      })
    );
    await expect(readFile(path.join(codexDir, "review-pr.md"), "utf8")).resolves.toBe(
      renderCodexPrompt({
        description: "Review a pull request",
        body: fixture.reviewBody,
        argumentHint: "PR_NUMBER"
      })
    );
    await expect(readFile(path.join(claudeDir, ".polli-managed-commands.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(["plan-review", "review-pr"], null, 2)}\n`
    );
    await expect(readFile(path.join(codexDir, ".polli-managed-prompts.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(["plan-review", "review-pr"], null, 2)}\n`
    );
  });

  test("apply is idempotent when prompt files already match expected content", async () => {
    const fixture = await createPromptsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    const claudeReviewPath = path.join(fixture.home, ".claude", "commands", "review-pr.md");
    await writeFile(path.join(fixture.home, ".claude", "commands", ".consumer-meta"), "keep me\n", "utf8");
    const before = await stat(claudeReviewPath);

    await new Promise((resolve) => setTimeout(resolve, 25));

    await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    const after = await stat(claudeReviewPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    await expect(readFile(path.join(fixture.home, ".claude", "commands", ".consumer-meta"), "utf8")).resolves.toBe("keep me\n");
  });

  test("dry-run plans sync without writing prompt install trees", async () => {
    const fixture = await createPromptsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false
    });

    expect(result.actions).toEqual([
      { action: "plan-sync", id: "review-pr", details: "backend=all" },
      { action: "plan-sync", id: "plan-review", details: "backend=all" }
    ]);

    await expect(pathExists(path.join(fixture.home, ".claude", "commands"))).resolves.toBe(false);
    await expect(pathExists(path.join(fixture.home, ".codex", "prompts"))).resolves.toBe(false);
  });

  test("apply prunes stale managed prompt files that fall out of the registry", async () => {
    const fixture = await createPromptsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    await writeFile(
      fixture.registryPath,
      `${JSON.stringify(
        {
          version: "2026-04-18",
          schema_version: "1.0.0",
          prompts: [
            {
              id: "review-pr",
              name: "Review Pull Request",
              description: "Review a pull request",
              category: "review",
              template_path: "instructions/prompts/review-pr.md",
              variables: ["pr_number"],
              optional_variables: ["focus_areas"],
              targets: ["async-runner"]
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await syncPromptsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    expect(result.actions).toEqual([
      { action: "sync", id: "review-pr", details: "backend=all" },
      { action: "prune", id: "plan-review", details: "backend=all" }
    ]);
    await expect(pathExists(path.join(fixture.home, ".claude", "commands", "plan-review.md"))).resolves.toBe(false);
    await expect(pathExists(path.join(fixture.home, ".codex", "prompts", "plan-review.md"))).resolves.toBe(false);
  });

  test("apply is registry-atomic when a prompt template cannot be resolved", async () => {
    const fixture = await createPromptsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    await writeFile(
      fixture.registryPath,
      `${JSON.stringify(
        {
          version: "2026-04-18",
          schema_version: "1.0.0",
          prompts: [
            {
              id: "review-pr",
              name: "Review Pull Request",
              description: "Review a pull request",
              category: "review",
              template_path: "instructions/prompts/review-pr.md",
              variables: ["pr_number"],
              targets: ["async-runner"]
            },
            {
              id: "broken-prompt",
              name: "Broken Prompt",
              description: "Missing template",
              category: "review",
              template_path: "instructions/prompts/missing.md",
              variables: ["value"],
              targets: ["async-runner"]
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      syncPromptsRegistry(fixture.registryPath, {
        backend: "all",
        apply: true
      })
    ).rejects.toThrow('Unable to resolve template for prompt "broken-prompt"');

    await expect(pathExists(path.join(fixture.home, ".claude", "commands", "review-pr.md"))).resolves.toBe(false);
    await expect(pathExists(path.join(fixture.home, ".codex", "prompts", "review-pr.md"))).resolves.toBe(false);
    await expect(listCalyxScratchPaths(fixture.root)).resolves.toEqual([]);
  });
});
