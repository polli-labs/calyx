import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveRunIntent } from "../resolve.js";

describe("resolveRunIntent", () => {
  let rootDir: string;
  let previousPromptsRegistry: string | undefined;
  let previousDocstoreRoot: string | undefined;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "calyx-run-resolve-"));
    previousPromptsRegistry = process.env["CALYX_PROMPTS_REGISTRY"];
    previousDocstoreRoot = process.env["DOCSTORE_ROOT"];
    process.env["DOCSTORE_ROOT"] = join(rootDir, "docstore");
  });

  afterEach(async () => {
    if (previousPromptsRegistry === undefined) {
      delete process.env["CALYX_PROMPTS_REGISTRY"];
    } else {
      process.env["CALYX_PROMPTS_REGISTRY"] = previousPromptsRegistry;
    }
    if (previousDocstoreRoot === undefined) {
      delete process.env["DOCSTORE_ROOT"];
    } else {
      process.env["DOCSTORE_ROOT"] = previousDocstoreRoot;
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  test("walks upward from the registry path to resolve repo-root-relative template paths", async () => {
    const templatePath = join(rootDir, "docs", "org-kb", "agents", "prompts", "templated.md");
    const registryPath = join(rootDir, "nested", "deep", "layout", "docs", "org-kb", "agents", "prompts", "REGISTRY.json");

    await mkdir(join(rootDir, "docs", "org-kb", "agents", "prompts"), { recursive: true });
    await mkdir(join(rootDir, "nested", "deep", "layout", "docs", "org-kb", "agents", "prompts"), { recursive: true });
    await writeFile(templatePath, "Prompt for {{name}}.\n", "utf8");
    await writeFile(registryPath, `${JSON.stringify({
      version: "test",
      prompts: [
        {
          id: "templated",
          name: "Templated",
          description: "Templated prompt",
          category: "execution",
          template_path: "docs/org-kb/agents/prompts/templated.md",
          variables: ["name"],
          targets: ["manual-compose"],
        },
      ],
    }, null, 2)}\n`, "utf8");

    process.env["CALYX_PROMPTS_REGISTRY"] = registryPath;

    const spec = await resolveRunIntent({
      run_id: "run-template-1",
      host: "local",
      created_at: "2026-03-11T12:00:00.000Z",
      template: "templated",
      template_vars: { name: "Calyx" },
      require_execplan: false,
    });

    expect(spec.prompt).toContain("Prompt for Calyx.");
    expect(spec.require_execplan).toBe(false);
    expect(spec.resolution_log.some((step) => step.detail.includes(templatePath))).toBe(true);
  });

  test("resolves direct template intents when issue-linked ExecPlan resolution misses", async () => {
    const templatePath = join(rootDir, "docs", "org-kb", "agents", "prompts", "issue-template.md");
    const registryPath = join(rootDir, "docs", "org-kb", "agents", "prompts", "REGISTRY.json");

    await mkdir(dirname(templatePath), { recursive: true });
    await writeFile(templatePath, "Review {{issue}} without pretending this is an implementation plan.\n", "utf8");
    await writeFile(registryPath, `${JSON.stringify({
      version: "test",
      prompts: [
        {
          id: "issue-template",
          name: "Issue Template",
          description: "Issue prompt",
          category: "execution",
          template_path: "docs/org-kb/agents/prompts/issue-template.md",
          variables: ["issue"],
          targets: ["manual-compose"],
        },
      ],
    }, null, 2)}\n`, "utf8");

    process.env["CALYX_PROMPTS_REGISTRY"] = registryPath;

    const spec = await resolveRunIntent({
      run_id: "run-template-no-plan",
      host: "local",
      issue: "POL-1321",
      created_at: "2026-03-11T12:00:00.000Z",
      template: "issue-template",
      template_vars: { issue: "POL-1321" },
      require_execplan: false,
    });

    expect(spec.prompt).toContain("Review POL-1321");
    expect(spec.require_execplan).toBe(false);
    expect(spec.execplan_source).toBeUndefined();
    expect(spec.resolution_log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "execplan_ref",
          status: "skipped",
          detail: "No local ExecPlan found for POL-1321.",
        }),
      ]),
    );
  });

  test("carries resolved system prompt fields into the agent runner spec", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-system-prompt-1",
      host: "local",
      created_at: "2026-03-11T12:00:00.000Z",
      prompt: "Do the work.",
      system_prompt: "Replacement base instructions.",
      append_system_prompt: "Additional developer instructions.",
      require_execplan: false,
    });

    expect(spec.system_prompt).toBe("Replacement base instructions.");
    expect(spec.append_system_prompt).toBe("Additional developer instructions.");
    expect(spec.require_execplan).toBe(false);
  });

  test("preserves typed terminal output capture in the resolved runner spec", async () => {
    const outputCapture = {
      name: "proposal-bundle.json",
      source: "agent_terminal_message" as const,
      media_type: "application/json" as const,
      schema: {
        type: "object",
        required: ["proposals"],
        properties: { proposals: { type: "array" } },
        additionalProperties: false,
      },
      max_bytes: 32_768,
      required: true as const,
    };
    const spec = await resolveRunIntent({
      run_id: "run-output-capture",
      host: "local",
      backend: "codex",
      created_at: "2026-07-21T12:00:00.000Z",
      prompt: "Return the typed proposal bundle.",
      require_execplan: false,
      output_capture: outputCapture,
      backend_options: { sandbox: "read-only" },
    });

    expect(spec.output_capture).toEqual(outputCapture);
  });

  test("resolves direct inline prompt intents when issue-linked ExecPlan resolution misses", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-prompt-no-plan",
      host: "local",
      issue: "POL-1321",
      created_at: "2026-03-11T12:00:00.000Z",
      prompt: "Do a bounded review without an implementation ExecPlan.",
      require_execplan: false,
    });

    expect(spec.prompt).toBe("Do a bounded review without an implementation ExecPlan.");
    expect(spec.require_execplan).toBe(false);
    expect(spec.execplan_source).toBeUndefined();
    expect(spec.resolution_log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "execplan_ref",
          status: "skipped",
          detail: "No local ExecPlan found for POL-1321.",
        }),
      ]),
    );
  });

  test("carries backend-native typed backend options into the agent runner spec", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-reasoning-effort-1",
      host: "local",
      backend: "claude",
      created_at: "2026-03-11T12:00:00.000Z",
      prompt: "Do the work.",
      backend_options: { reasoning_effort: "max" },
      require_execplan: false,
    });

    expect(spec.backend_options).toEqual({ reasoning_effort: "max" });
  });

  test("explains target-local semantics for unresolved direct prompt_file intents", async () => {
    await expect(
      resolveRunIntent({
        run_id: "run-missing-prompt-file",
        host: "blade",
        created_at: "2026-03-11T12:00:00.000Z",
        prompt_file: join(rootDir, "missing.md"),
        require_execplan: false,
      }),
    ).rejects.toThrow(
      /Prompt file not found on target host: .*ship the file content as inline prompt text before remote dispatch/s,
    );
  });

  test("distinguishes empty direct prompt_file intents from missing files", async () => {
    const promptPath = join(rootDir, "empty.md");
    await writeFile(promptPath, "\n", "utf8");

    await expect(
      resolveRunIntent({
        run_id: "run-empty-prompt-file",
        host: "blade",
        created_at: "2026-03-11T12:00:00.000Z",
        prompt_file: promptPath,
        require_execplan: false,
      }),
    ).rejects.toThrow("Prompt file resolved to an empty prompt on target host");
  });

  test("resolves vault:// execplan refs against the target host vault_root", async () => {
    const agentsInfraRoot = join(rootDir, "agents-infra");
    const execplanPath = join(rootDir, "blade-home", "vault", "fieldwork", "20-plans", "foo.md");
    const hostsPath = join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
    const skillsRegistryPath = join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    const templateRegistryPath = join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");

    await mkdir(dirname(execplanPath), { recursive: true });
    await mkdir(dirname(hostsPath), { recursive: true });
    await mkdir(dirname(skillsRegistryPath), { recursive: true });
    await mkdir(dirname(templateRegistryPath), { recursive: true });
    await writeFile(execplanPath, "# ExecPlan\n\nShip it.\n", "utf8");
    await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
    await writeFile(
      templateRegistryPath,
      `${JSON.stringify({
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: join(rootDir, "blade-home"),
            vault_root: join(rootDir, "blade-home", "vault", "fieldwork"),
          },
        },
      }),
      "utf8",
    );

    const spec = await resolveRunIntent(
      {
        run_id: "run-vault-1",
        host: "blade",
        backend: "codex",
        execplan_ref: "vault://20-plans/foo.md",
        created_at: "2026-03-11T12:00:00.000Z",
      },
      {
        now: () => "2026-03-11T12:00:00.000Z",
        agentsInfraRoot,
      },
    );

    expect(spec.execplan_source).toBe(execplanPath);
    expect(spec.execplan_content).toContain("Ship it.");
    expect(spec.require_execplan).toBe(true);
    expect(spec.prompt).toContain("--- ExecPlan follows ---");
    expect(spec.resolution_log.some((step) => step.detail.includes(execplanPath))).toBe(true);
  });

  test("resolves repo aliases to canonical slugs in resolved worktree specs", async () => {
    const agentsInfraRoot = join(rootDir, "agents-infra-repos");
    const hostsPath = join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
    const skillsRegistryPath = join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    const templateRegistryPath = join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");
    const repoPath = join(rootDir, "blade-home", "dev", "polli", "dev");

    await mkdir(dirname(hostsPath), { recursive: true });
    await mkdir(dirname(skillsRegistryPath), { recursive: true });
    await mkdir(dirname(templateRegistryPath), { recursive: true });
    await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
    await writeFile(
      templateRegistryPath,
      `${JSON.stringify({
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: join(rootDir, "blade-home"),
            repos: {
              polli: {
                path: repoPath,
                aliases: ["polli-labs/polli"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    const spec = await resolveRunIntent(
      {
        run_id: "run-repo-alias-1",
        host: "blade",
        backend: "codex",
        repo: "https://github.com/polli-labs/polli.git",
        prompt: "Use the repo.",
        branch: "calyx-run/pol-1402",
        require_execplan: false,
        created_at: "2026-03-11T12:00:00.000Z",
      },
      {
        now: () => "2026-03-11T12:00:00.000Z",
        agentsInfraRoot,
      },
    );

    expect(spec.worktree.repo).toBe("polli");
    expect(spec.resolution_log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "repo_identity",
          detail: "Resolved repo identifier https://github.com/polli-labs/polli.git to canonical host-truth slug polli.",
        }),
      ]),
    );
  });

  test("fails when no prompt source and no ExecPlan source resolves", async () => {
    await expect(
      resolveRunIntent({
        run_id: "run-missing-plan-and-prompt",
        host: "local",
        issue: "POL-MISSING",
        created_at: "2026-03-11T12:00:00.000Z",
      }),
    ).rejects.toThrow(
      "Run run-missing-plan-and-prompt requires an ExecPlan, but none was resolved.",
    );
  });

  test("fails when ExecPlan is optional but no prompt source exists", async () => {
    await expect(
      resolveRunIntent({
        run_id: "run-missing-prompt",
        host: "local",
        created_at: "2026-03-11T12:00:00.000Z",
        require_execplan: false,
      }),
    ).rejects.toThrow(
      "Run run-missing-prompt has no prompt source. Provide --prompt, --prompt-file, --template, or an ExecPlan.",
    );
  });

  test("derives calyx-run/<lowercase issue> for managed repo launches without an explicit branch", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-managed-derived-branch",
      host: "local",
      created_at: "2026-05-10T12:00:00.000Z",
      issue: "POL-1325",
      repo: "calyx",
      worktree_mode: "managed",
      prompt: "Inline prompt for derived-branch test.",
      require_execplan: false,
    });

    expect(spec.worktree.branch).toBe("calyx-run/pol-1325");
    expect(spec.worktree.repo).toBe("calyx");
    expect(spec.worktree.mode).toBe("managed");
    expect(spec.worktree.path).toBeUndefined();
  });

  test("skips repo registry resolution for an existing-mode worktree (POL-1807)", async () => {
    // An existing-mode run is worktree-path-authoritative; a local checkout path
    // is not a registered slug, so resolution must not registry-resolve it.
    // Without the existing-mode skip this throws "does not have repo slug ...".
    const spec = await resolveRunIntent({
      run_id: "run-existing-no-registry",
      host: "local",
      created_at: "2026-05-10T12:00:00.000Z",
      repo: "/tmp/calyx-existing/unregistered-worktree",
      worktree_mode: "existing",
      worktree_path: "/tmp/calyx-existing/unregistered-worktree",
      prompt: "Inline prompt for existing-mode review.",
      require_execplan: false,
    });

    expect(spec.worktree.mode).toBe("existing");
    expect(spec.worktree.path).toBe("/tmp/calyx-existing/unregistered-worktree");
    expect(spec.worktree.branch).toBeUndefined();
  });

  test("derives the managed branch when worktree_mode is left to default to managed", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-managed-default-mode",
      host: "local",
      created_at: "2026-05-10T12:00:00.000Z",
      issue: "POL-1326",
      repo: "calyx",
      prompt: "Inline prompt for default-managed test.",
      require_execplan: false,
    });

    expect(spec.worktree.branch).toBe("calyx-run/pol-1326");
  });

  test("preserves an explicit --worktree-branch override over the issue-derived branch", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-managed-explicit-branch",
      host: "local",
      created_at: "2026-05-10T12:00:00.000Z",
      issue: "POL-1325",
      repo: "calyx",
      worktree_mode: "managed",
      branch: "caleb/pol-1325-experiment-a",
      prompt: "Inline prompt for explicit-branch test.",
      require_execplan: false,
    });

    expect(spec.worktree.branch).toBe("caleb/pol-1325-experiment-a");
  });

  test("preserves the managed worktree reset-on-reuse intent flag", async () => {
    const spec = await resolveRunIntent({
      run_id: "run-managed-reset-on-reuse",
      host: "local",
      created_at: "2026-05-10T12:00:00.000Z",
      repo: "calyx",
      worktree_mode: "managed",
      worktree_ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
      worktree_reset_on_reuse: true,
      branch: "calyx-review/pr-242-adversarial",
      prompt: "Inline prompt for reused review branch.",
      require_execplan: false,
    });

    expect(spec.worktree).toMatchObject({
      mode: "managed",
      repo: "calyx",
      ref: "806cab6749819a2733a21ef507d8c9d5804829b5",
      branch: "calyx-review/pr-242-adversarial",
      reset_on_reuse: true,
    });
  });

  test("rejects managed repo launches without --worktree-branch and without --issue", async () => {
    await expect(
      resolveRunIntent({
        run_id: "run-managed-no-branch-no-issue",
        host: "local",
        created_at: "2026-05-10T12:00:00.000Z",
        repo: "calyx",
        worktree_mode: "managed",
        prompt: "Inline prompt without identity.",
        require_execplan: false,
      }),
    ).rejects.toThrow(/Managed worktree launch for repo "calyx" requires either --worktree-branch <branch> or --issue <id>\./);
  });

  test("fails with an actionable error when the target host lacks vault_root", async () => {
    const agentsInfraRoot = join(rootDir, "agents-infra");
    const hostsPath = join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
    const skillsRegistryPath = join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    const templateRegistryPath = join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");

    await mkdir(dirname(hostsPath), { recursive: true });
    await mkdir(dirname(skillsRegistryPath), { recursive: true });
    await mkdir(dirname(templateRegistryPath), { recursive: true });
    await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
    await writeFile(
      templateRegistryPath,
      `${JSON.stringify({
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: join(rootDir, "blade-home"),
          },
        },
      }),
      "utf8",
    );

    await expect(
      resolveRunIntent(
        {
          run_id: "run-vault-missing-root",
          host: "blade",
          backend: "codex",
          execplan_ref: "vault://20-plans/foo.md",
          created_at: "2026-03-11T12:00:00.000Z",
        },
        {
          now: () => "2026-03-11T12:00:00.000Z",
          agentsInfraRoot,
        },
      ),
    ).rejects.toThrow(
      'Host "blade" has no vault_root configured in fleet/truths/hosts.yaml. Add it or pass an absolute --execplan-ref path.',
    );
  });
});
