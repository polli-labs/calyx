import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

describe("prompts command", () => {
  let rootDir: string;
  let previousPromptsRegistry: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "calyx-prompts-cli-"));
    previousPromptsRegistry = process.env["CALYX_PROMPTS_REGISTRY"];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousPromptsRegistry === undefined) {
      delete process.env["CALYX_PROMPTS_REGISTRY"];
    } else {
      process.env["CALYX_PROMPTS_REGISTRY"] = previousPromptsRegistry;
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  async function createPromptFixture(): Promise<{ registryPath: string; varsFilePath: string }> {
    const templatePath = path.join(rootDir, "instructions", "prompts", "review-pr.md");
    const registryPath = path.join(rootDir, "instructions", "prompts", "REGISTRY.json");
    const varsFilePath = path.join(rootDir, "vars.json");

    await mkdir(path.dirname(templatePath), { recursive: true });
    await writeFile(templatePath, "Review #{{pr_number}} for {{focus_areas}}.\n", "utf8");
    await writeFile(
      registryPath,
      `${JSON.stringify({
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
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      varsFilePath,
      `${JSON.stringify({
        pr_number: 58,
        focus_areas: "docs",
      }, null, 2)}\n`,
      "utf8",
    );

    return { registryPath, varsFilePath };
  }

  test("prompts render emits a machine-readable render receipt", async () => {
    const { registryPath } = await createPromptFixture();
    process.env["CALYX_PROMPTS_REGISTRY"] = registryPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "prompts",
      "render",
      "--prompt",
      "review-pr",
      "--var",
      "pr_number=57",
      "--var",
      "focus_areas=tests",
      "--json",
    ]);

    expect(err).toHaveBeenCalled();
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      promptId: string;
      renderedPrompt: string;
      requiredVariables: string[];
      optionalVariables: string[];
    };

    expect(payload.promptId).toBe("review-pr");
    expect(payload.renderedPrompt).toContain("Review #57 for tests.");
    expect(payload.requiredVariables).toEqual(["pr_number"]);
    expect(payload.optionalVariables).toEqual(["focus_areas"]);
  });

  test("prompts render writes rendered prompt to stdout and merges vars-file with explicit overrides", async () => {
    const { registryPath, varsFilePath } = await createPromptFixture();
    process.env["CALYX_PROMPTS_REGISTRY"] = registryPath;

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "prompts",
      "render",
      "--prompt",
      "review-pr",
      "--vars-file",
      varsFilePath,
      "--var",
      "focus_areas=tests",
    ]);

    expect(stdoutWrite).toHaveBeenCalled();
    expect(String(stdoutWrite.mock.calls[0]?.[0])).toContain("Review #58 for tests.");
  });

  test("prompts render rejects undeclared variables", async () => {
    const { registryPath } = await createPromptFixture();
    process.env["CALYX_PROMPTS_REGISTRY"] = registryPath;

    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "prompts",
        "render",
        "--prompt",
        "review-pr",
        "--var",
        "pr_number=57",
        "--var",
        "issue=POL-891",
      ]),
    ).rejects.toMatchObject({
      message: expect.stringContaining("undeclared variables: issue"),
      exitCode: 1,
    });
  });
});
