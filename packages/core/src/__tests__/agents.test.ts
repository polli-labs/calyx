import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AgentDefinitionLifecycleError,
  compileAgentLaunch,
  indexAgentsRegistry,
  showAgentDefinition,
  validateAgentsRegistry,
} from "../agents";

function fixtureRegistryPath(): string {
  return path.resolve(process.cwd(), "fixtures/domains/agents/AGENTS.json");
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function createGitRepo(root: string): Promise<{ repo: string; headSha: string; baseSha: string; mergeBaseSha: string }> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execFileText("git", ["init", "--initial-branch=main"], repo);
  await execFileText("git", ["config", "user.email", "fixture@example.com"], repo);
  await execFileText("git", ["config", "user.name", "Fixture"], repo);
  await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
  await execFileText("git", ["add", "README.md"], repo);
  await execFileText("git", ["commit", "-m", "base"], repo);
  const baseSha = await execFileText("git", ["rev-parse", "main"], repo);
  await execFileText("git", ["checkout", "-b", "feature/pol-1799"], repo);
  await writeFile(path.join(repo, "README.md"), "base\nfeature\n", "utf8");
  await execFileText("git", ["commit", "-am", "feature"], repo);
  const headSha = await execFileText("git", ["rev-parse", "feature/pol-1799"], repo);
  const mergeBaseSha = await execFileText("git", ["merge-base", "main", "feature/pol-1799"], repo);
  return { repo, headSha, baseSha, mergeBaseSha };
}

async function createGitRepoWithStaleLocalPrRef(
  root: string,
  options: { remotePrHead?: "old" | "new" } = {},
): Promise<{
  repo: string;
  origin: string;
  oldHeadSha: string;
  newHeadSha: string;
  baseSha: string;
  mergeBaseSha: string;
}> {
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  await mkdir(repo, { recursive: true });
  await execFileText("git", ["init", "--bare", origin], root);
  await execFileText("git", ["init", "--initial-branch=main"], repo);
  await execFileText("git", ["config", "user.email", "fixture@example.com"], repo);
  await execFileText("git", ["config", "user.name", "Fixture"], repo);
  await execFileText("git", ["remote", "add", "origin", origin], repo);
  await writeFile(path.join(repo, "README.md"), "base\n", "utf8");
  await execFileText("git", ["add", "README.md"], repo);
  await execFileText("git", ["commit", "-m", "base"], repo);
  const baseSha = await execFileText("git", ["rev-parse", "main"], repo);
  await execFileText("git", ["push", "origin", "main"], repo);
  await execFileText("git", ["fetch", "origin", "main:refs/remotes/origin/main"], repo);
  await execFileText("git", ["checkout", "-b", "feature/pol-1848"], repo);
  await writeFile(path.join(repo, "README.md"), "base\nold head\n", "utf8");
  await execFileText("git", ["commit", "-am", "old head"], repo);
  const oldHeadSha = await execFileText("git", ["rev-parse", "HEAD"], repo);
  await execFileText("git", ["update-ref", "refs/pull/223/head", oldHeadSha], repo);
  await execFileText("git", ["push", "origin", `${oldHeadSha}:refs/pull/223/head`], repo);
  await writeFile(path.join(repo, "README.md"), "base\nnew head\n", "utf8");
  await execFileText("git", ["commit", "-am", "new head"], repo);
  const newHeadSha = await execFileText("git", ["rev-parse", "HEAD"], repo);
  if ((options.remotePrHead ?? "new") === "new") {
    await execFileText("git", ["push", "origin", `${newHeadSha}:refs/pull/223/head`], repo);
  }
  const mergeBaseSha = await execFileText("git", ["merge-base", "main", newHeadSha], repo);
  return { repo, origin, oldHeadSha, newHeadSha, baseSha, mergeBaseSha };
}

async function advanceOriginMain(root: string, origin: string): Promise<string> {
  const repo = path.join(root, "origin-main-updater");
  await execFileText("git", ["clone", origin, repo], root);
  await execFileText("git", ["checkout", "-b", "main", "origin/main"], repo);
  await execFileText("git", ["config", "user.email", "fixture@example.com"], repo);
  await execFileText("git", ["config", "user.name", "Fixture"], repo);
  await writeFile(path.join(repo, "BASE.md"), "new remote base\n", "utf8");
  await execFileText("git", ["add", "BASE.md"], repo);
  await execFileText("git", ["commit", "-m", "advance main"], repo);
  const headSha = await execFileText("git", ["rev-parse", "HEAD"], repo);
  await execFileText("git", ["push", "origin", "HEAD:main"], repo);
  return headSha;
}

async function createSkillRoot(root: string): Promise<string> {
  const skillRoot = path.join(root, "skills");
  const skillDir = path.join(skillRoot, "fixture-review-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    ["# Fixture Review Skill", "", "Use findings-first review output.", ""].join("\n"),
    "utf8",
  );
  return skillRoot;
}

async function createOutputCaptureRegistry(
  root: string,
  options: {
    artifactWrites?: Array<Record<string, unknown>>;
    workspaceMutation?: "forbidden" | "allowed" | "restricted";
  } = {},
): Promise<string> {
  const registryRoot = path.join(root, "output-capture-agents");
  const agentRoot = path.join(registryRoot, "typed-output-reviewer");
  await mkdir(agentRoot, { recursive: true });
  await writeFile(
    path.join(registryRoot, "AGENTS.json"),
    JSON.stringify({
      version: "1",
      agents: [{
        id: "typed-output-reviewer",
        path: "typed-output-reviewer/agent.yaml",
        status: "active",
        description: "POL-2057 typed output capture fixture.",
      }],
    }),
    "utf8",
  );
  const artifactWrites = options.artifactWrites ?? [
    { path: "legacy-findings.md", location: "run-artifact" },
    {
      path: "review-verdict.json",
      location: "run-artifact",
      source: "agent_terminal_message",
      media_type: "application/json",
      schema: {
        type: "object",
        properties: { verdict: { enum: ["pass", "fail"] } },
        required: ["verdict"],
        additionalProperties: false,
      },
      max_bytes: 4096,
      required: true,
    },
  ];
  await writeFile(
    path.join(agentRoot, "agent.yaml"),
    [
      "version: 1",
      "kind: agent",
      "id: typed-output-reviewer",
      "status: active",
      "owner: polli-labs",
      "contract_version: 1",
      "description: POL-2057 typed output capture fixture.",
      "persona:",
      "  template: prompt.md",
      "execution:",
      "  kernel: agent_runner",
      "  backend:",
      "    strategy: first_available",
      "    fallback_order: [codex, claude]",
      "    allowed: [codex, claude]",
      "posture:",
      `  workspace_mutation: ${options.workspaceMutation ?? "forbidden"}`,
      "  artifact_writes:",
      ...artifactWrites.map((artifact) => `    - ${JSON.stringify(artifact)}`),
      "context:",
      "  worktree: {mode: existing}",
      "output:",
      "  required_artifacts: [legacy-findings.md, review-verdict.json]",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(agentRoot, "prompt.md"), "Return the typed review verdict.\n", "utf8");
  return path.join(registryRoot, "AGENTS.json");
}

async function createAgentsInfraRepoRegistry(root: string, repo: string): Promise<string> {
  const agentsInfraRoot = path.join(root, "agents-infra");
  await mkdir(path.join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
  await writeFile(
    path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
    [
      "hosts:",
      "  fixture-host:",
      "    repos:",
      "      calyx:",
      `        path: ${JSON.stringify(repo)}`,
      "        aliases:",
      "          - polli-labs/calyx-dev",
      "          - github:polli-labs/calyx-dev",
      "",
    ].join("\n"),
    "utf8",
  );
  return agentsInfraRoot;
}

describe("agent definitions", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("validates and indexes fixture definitions", async () => {
    const registryPath = fixtureRegistryPath();
    const validation = await validateAgentsRegistry(registryPath, { strict: true });
    const index = await indexAgentsRegistry(registryPath);

    expect(validation.ok).toBe(true);
    expect(validation.total).toBe(2);
    expect(validation.blocked).toBe(1);
    expect(index.items).toEqual([
      expect.objectContaining({
        id: "fixture-reviewer",
        status: "active",
        description: "Fixture reviewer used by POL-1799 launch tests.",
      }),
    ]);
  });

  test("keeps blocked definitions inspectable but out of default launch inventory", async () => {
    const registryPath = fixtureRegistryPath();
    const defaultIndex = await indexAgentsRegistry(registryPath);
    const completeIndex = await indexAgentsRegistry(registryPath, { includeBlocked: true });
    const shown = await showAgentDefinition(registryPath, "fixture-blocked");

    expect(defaultIndex.items.map((item) => item.id)).not.toContain("fixture-blocked");
    expect(completeIndex.items).toContainEqual(expect.objectContaining({
      id: "fixture-blocked",
      status: "blocked",
      lifecycle: {
        status: "blocked",
        blocked_reason: "Prerequisite safety receipts are incomplete.",
        blocked_by: ["POL-2058", "POL-2060"],
      },
    }));
    expect(shown).toMatchObject({
      status: "blocked",
      lifecycle: {
        status: "blocked",
        blocked_reason: "Prerequisite safety receipts are incomplete.",
        blocked_by: ["POL-2058", "POL-2060"],
      },
      agent: { id: "fixture-blocked", status: "blocked" },
    });
  });

  test("rejects a blocked definition with a typed actionable error before prompt resolution", async () => {
    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-blocked")).rejects.toMatchObject({
      name: "AgentDefinitionLifecycleError",
      exitCode: 2,
      code: "agent_definition_not_launchable",
      agentId: "fixture-blocked",
      status: "blocked",
      blockedReason: "Prerequisite safety receipts are incomplete.",
      blockedBy: ["POL-2058", "POL-2060"],
    });
    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-blocked")).rejects.toThrow(
      /lifecycle state "blocked"[\s\S]*Blocked by: POL-2058, POL-2060[\s\S]*set every declared lifecycle state to "active"/u,
    );
  });

  test("fails closed when a forged registry marks a blocked definition active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-forged-lifecycle-"));
    roots.add(root);
    const definitionPath = path.resolve(process.cwd(), "fixtures/domains/agents/fixture-blocked/agent.yaml");
    const registryPath = path.join(root, "AGENTS.json");
    await writeFile(registryPath, JSON.stringify({
      version: "1",
      agents: [{
        id: "fixture-blocked",
        path: definitionPath,
        lifecycle: { status: "active" },
      }],
    }), "utf8");

    const validation = await validateAgentsRegistry(registryPath, { strict: true });
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "agents.lifecycle-status-mismatch",
    }));

    try {
      await compileAgentLaunch(registryPath, "fixture-blocked");
      throw new Error("expected lifecycle rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentDefinitionLifecycleError);
      expect(error).toMatchObject({
        code: "agent_definition_lifecycle_mismatch",
        status: "blocked",
        declaredStatuses: ["active", "blocked"],
      });
    }
  });

  test("requires a reason for blocked registry entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-blocked-reason-"));
    roots.add(root);
    const definitionPath = path.resolve(process.cwd(), "fixtures/domains/agents/fixture-blocked/agent.yaml");
    const registryPath = path.join(root, "AGENTS.json");
    await writeFile(registryPath, JSON.stringify({
      version: "1",
      agents: [{
        id: "fixture-blocked",
        path: definitionPath,
        lifecycle: { status: "blocked" },
      }],
    }), "utf8");

    const validation = await validateAgentsRegistry(registryPath, { strict: true });
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "agents.blocked-missing-reason",
    }));
  });

  test("compiles an agent definition into an existing run launch packet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-compile-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const skillRoot = await createSkillRoot(root);

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
        focus: ["security", "tests"],
      },
      cwd: git.repo,
      requesterBackend: "claude",
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-13T00:00:00.000Z",
    });

    expect(compiled.backend).toBe("codex");
    expect(compiled.model).toBe("gpt-5.4-codex");
    expect(compiled.reasoning_effort).toBe("high");
    expect(compiled.worktree_mode).toBe("managed");
    expect(compiled.worktree_ref).toBe(git.headSha);
    expect(compiled.required_artifacts).toEqual(["findings.md", "findings.json"]);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "branch",
      branch: "feature/pol-1799",
      base_sha: git.baseSha,
      head_sha: git.headSha,
      merge_base_sha: git.mergeBaseSha,
    });
    expect(compiled.prompt).toContain(`Review ${git.repo} at ${git.headSha}`);
    expect(compiled.prompt).toContain("- security");
    expect(compiled.prompt).toContain("# Materialized Curricula");
    expect(compiled.backend_options).toMatchObject({
      sandbox: "read-only",
      env: { CALYX_AGENT_WORKSPACE_MUTATION: "forbidden" },
      agent_activity: { hard_timeout_ms: 5_400_000 },
    });
    expect(compiled.backend_options).not.toHaveProperty("sandbox_class");
    expect(compiled.metadata.agent_definition).toMatchObject({
      definition_ref: "fixture-reviewer",
      agent_ref: expect.stringMatching(/^fixture-reviewer@sha256:/),
      definition_digest_algorithm: "agent-dir-v1",
      target_repin_policy: "re-pin-or-fail",
      target_unavailable_handback: "target-moved; re-pin required",
      required_artifacts: ["findings.md", "findings.json"],
    });
    expect(compiled.provenance.procedure_refs.map((ref) => `${ref.kind}:${ref.id}:${ref.mode}`)).toEqual([
      "curriculum:review-and-merge:embedded",
      "skill:fixture-review-skill:host-resolved",
    ]);
  });

  test("compiles typed terminal artifact writes into output_capture without legacy artifact discovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-capture-"));
    roots.add(root);
    const registryPath = await createOutputCaptureRegistry(root);

    const validation = await validateAgentsRegistry(registryPath, { strict: true });
    expect(validation.ok).toBe(true);

    const compiled = await compileAgentLaunch(registryPath, "typed-output-reviewer", {
      cwd: root,
      now: () => "2026-07-21T00:00:00.000Z",
    });

    const expectedCapture = {
      name: "review-verdict.json",
      source: "agent_terminal_message",
      media_type: "application/json",
      schema: {
        type: "object",
        properties: { verdict: { enum: ["pass", "fail"] } },
        required: ["verdict"],
        additionalProperties: false,
      },
      max_bytes: 4096,
      required: true,
    };
    expect(compiled.backend).toBe("codex");
    expect(compiled.backend_options).toMatchObject({
      sandbox: "read-only",
      env: { CALYX_AGENT_WORKSPACE_MUTATION: "forbidden" },
    });
    expect(compiled.output_capture).toEqual(expectedCapture);
    expect(compiled.required_artifacts).toEqual(["legacy-findings.md"]);
    expect(compiled.required_artifacts).not.toContain("review-verdict.json");
    expect(compiled.metadata.agent_definition).toMatchObject({
      output_capture: expectedCapture,
      required_artifacts: ["legacy-findings.md"],
      workspace_mutation: "forbidden",
    });
  });

  test.each([
    ["absolute", "/tmp/review-verdict.json"],
    ["parent traversal", "../review-verdict.json"],
    ["nested path", "receipts/review-verdict.json"],
    ["Windows separator", "receipts\\review-verdict.json"],
    ["current directory", "."],
    ["parent directory", ".."],
  ])("rejects %s typed terminal capture paths", async (_label, capturePath) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-path-"));
    roots.add(root);
    const registryPath = await createOutputCaptureRegistry(root, {
      artifactWrites: [{
        path: capturePath,
        location: "run-artifact",
        source: "agent_terminal_message",
        media_type: "application/json",
        schema: { type: "object" },
        max_bytes: 1024,
        required: true,
      }],
    });

    await expect(compileAgentLaunch(registryPath, "typed-output-reviewer", { cwd: root }))
      .rejects.toThrow("Typed terminal capture path must be a safe basename");
  });

  test("rejects partial and multiple typed terminal capture declarations", async () => {
    const partialRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-partial-"));
    roots.add(partialRoot);
    const partialRegistry = await createOutputCaptureRegistry(partialRoot, {
      artifactWrites: [{
        path: "review-verdict.json",
        location: "run-artifact",
        source: "agent_terminal_message",
      }],
    });
    await expect(compileAgentLaunch(partialRegistry, "typed-output-reviewer", { cwd: partialRoot }))
      .rejects.toThrow(/Typed terminal capture requires (media_type|schema|max_bytes|required)/);

    const multipleRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-multiple-"));
    roots.add(multipleRoot);
    const capture = {
      location: "run-artifact",
      source: "agent_terminal_message",
      media_type: "application/json",
      schema: { type: "object" },
      max_bytes: 1024,
      required: true,
    };
    const multipleRegistry = await createOutputCaptureRegistry(multipleRoot, {
      artifactWrites: [
        { path: "first.json", ...capture },
        { path: "second.json", ...capture },
      ],
    });
    await expect(compileAgentLaunch(multipleRegistry, "typed-output-reviewer", { cwd: multipleRoot }))
      .rejects.toThrow("Agent definitions support exactly one typed terminal capture");
  });

  test("requires Codex and a forbidden workspace-mutation posture for typed output capture", async () => {
    const backendRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-backend-"));
    roots.add(backendRoot);
    const backendRegistry = await createOutputCaptureRegistry(backendRoot);
    await expect(compileAgentLaunch(backendRegistry, "typed-output-reviewer", {
      backend: "claude",
      cwd: backendRoot,
    })).rejects.toThrow('Agent "typed-output-reviewer" output capture requires the Codex backend');

    const mutationRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-output-mutation-"));
    roots.add(mutationRoot);
    const mutationRegistry = await createOutputCaptureRegistry(mutationRoot, { workspaceMutation: "allowed" });
    await expect(compileAgentLaunch(mutationRegistry, "typed-output-reviewer", { cwd: mutationRoot }))
      .rejects.toThrow('Agent "typed-output-reviewer" output capture requires posture.workspace_mutation=forbidden');
  });

  test("compiles read-only posture to Claude allowed tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-claude-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const skillRoot = await createSkillRoot(root);

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      backend: "claude",
      variables: {
        repo: [git.repo],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
      },
      cwd: git.repo,
      skillInstallRoots: [skillRoot],
    });

    expect(compiled.backend).toBe("claude");
    expect(compiled.backend_options.allowed_tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
  });

  test("resolves PR targets from origin before stale local pull refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root);
    const skillRoot = await createSkillRoot(root);

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["main"],
      },
      cwd: git.repo,
      targetHeadPoll: { attempts: 2, delayMs: 0 },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(compiled.worktree_ref).toBe(git.newHeadSha);
    expect(compiled.worktree_ref).not.toBe(git.oldHeadSha);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      base_sha: git.baseSha,
      head_ref: "refs/pull/223/head",
      head_sha: git.newHeadSha,
      merge_base_sha: git.mergeBaseSha,
    });
    expect(compiled.prompt).toContain(`Review ${git.repo} at ${git.newHeadSha}`);
  });

  test("refreshes a remote-tracking base before compiling a PR target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-base-refresh-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root);
    const skillRoot = await createSkillRoot(root);
    const remoteBaseSha = await advanceOriginMain(root, git.origin);
    expect(await execFileText("git", ["rev-parse", "origin/main"], git.repo)).toBe(git.baseSha);

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["origin/main"],
      },
      cwd: git.repo,
      targetHeadPoll: { attempts: 2, delayMs: 0 },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      base_ref: "origin/main",
      base_sha: remoteBaseSha,
      head_sha: git.newHeadSha,
      merge_base_sha: git.baseSha,
    });
  });

  test("waits for a stable remote PR head when no explicit SHA is supplied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-stable-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root, { remotePrHead: "old" });
    const skillRoot = await createSkillRoot(root);
    let sleeps = 0;

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["main"],
      },
      cwd: git.repo,
      targetHeadPoll: {
        attempts: 3,
        delayMs: 0,
        sleep: async () => {
          sleeps += 1;
          if (sleeps === 1) {
            await execFileText("git", ["push", "origin", `${git.newHeadSha}:refs/pull/223/head`], git.repo);
          }
        },
      },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(sleeps).toBe(2);
    expect(compiled.worktree_ref).toBe(git.newHeadSha);
    expect(compiled.worktree_ref).not.toBe(git.oldHeadSha);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      head_sha: git.newHeadSha,
      merge_base_sha: git.mergeBaseSha,
      warnings: [
        expect.stringContaining("No --sha was supplied"),
      ],
    });
    expect(compiled.prompt).toContain("## Target Resolution Warnings");
    expect(compiled.prompt).toContain("For reviews immediately after a force-push, pass --sha <head>");
  });

  test("warns local PR head fallback may be stale when origin head is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-local-fallback-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root);
    await execFileText("git", ["--git-dir", git.origin, "update-ref", "-d", "refs/pull/223/head"], root);
    const skillRoot = await createSkillRoot(root);

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["main"],
      },
      cwd: git.repo,
      targetHeadPoll: { attempts: 2, delayMs: 0 },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(compiled.worktree_ref).toBe(git.oldHeadSha);
    expect(compiled.worktree_ref).not.toBe(git.newHeadSha);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      head_ref: "refs/pull/223/head",
      head_sha: git.oldHeadSha,
      warnings: [
        expect.stringContaining("origin refs/pull/223/head was unavailable"),
      ],
    });
    expect(compiled.prompt).toContain("That local pull ref may be stale");
    expect(compiled.prompt).toContain("pass --sha <head>");
  });

  test("polls PR target head until origin catches the expected SHA", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-poll-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root, { remotePrHead: "old" });
    const skillRoot = await createSkillRoot(root);
    let sleeps = 0;

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["main"],
      },
      cwd: git.repo,
      expectedTargetHeadSha: git.newHeadSha,
      targetHeadPoll: {
        attempts: 3,
        delayMs: 0,
        sleep: async () => {
          sleeps += 1;
          await execFileText("git", ["push", "origin", `${git.newHeadSha}:refs/pull/223/head`], git.repo);
        },
      },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(sleeps).toBe(1);
    expect(compiled.worktree_ref).toBe(git.newHeadSha);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      head_sha: git.newHeadSha,
      merge_base_sha: git.mergeBaseSha,
    });
    expect(compiled.target?.warnings).toBeUndefined();
  });

  test("falls back to an explicit expected PR head when origin does not catch up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-fallback-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root, { remotePrHead: "old" });
    const skillRoot = await createSkillRoot(root);
    let sleeps = 0;

    const compiled = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["pr"],
        pr: ["223"],
        base: ["main"],
      },
      cwd: git.repo,
      expectedTargetHeadSha: git.newHeadSha,
      targetHeadPoll: {
        attempts: 2,
        delayMs: 0,
        sleep: async () => {
          sleeps += 1;
        },
      },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    });

    expect(sleeps).toBe(1);
    expect(compiled.worktree_ref).toBe(git.newHeadSha);
    expect(compiled.worktree_ref).not.toBe(git.oldHeadSha);
    expect(compiled.target).toMatchObject({
      repo: git.repo,
      scope: "pr",
      pr: 223,
      head_sha: git.newHeadSha,
      merge_base_sha: git.mergeBaseSha,
      warnings: [
        expect.stringContaining(`Pinned --sha ${git.newHeadSha} was not observed on origin refs/pull/223/head`),
      ],
    });
    expect(compiled.metadata.agent_definition).toMatchObject({
      target: {
        warnings: [
          expect.stringContaining("review target may not be on the PR head"),
        ],
      },
    });
    expect(compiled.prompt).toContain("## Target Resolution Warnings");
    expect(compiled.prompt).toContain("review target may not be on the PR head");
  });

  test("refuses an expected PR head when fetching the stale PR ref does not provide that object", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-pr-head-object-missing-"));
    roots.add(root);
    const git = await createGitRepoWithStaleLocalPrRef(root, { remotePrHead: "old" });
    const reviewClone = path.join(root, "review-clone");
    await execFileText("git", ["clone", git.origin, reviewClone], root);
    const skillRoot = await createSkillRoot(root);

    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [reviewClone],
        scope: ["pr"],
        pr: ["223"],
        base: ["origin/main"],
      },
      cwd: reviewClone,
      expectedTargetHeadSha: git.newHeadSha,
      targetHeadPoll: { attempts: 1, delayMs: 0 },
      skillInstallRoots: [skillRoot],
      now: () => "2026-06-22T00:00:00.000Z",
    })).rejects.toThrow(
      `Unable to fetch PR head object ${git.newHeadSha} from origin (refs/pull/223/head) before target pinning.`,
    );
  });

  test("resolves repo aliases and full slugs from outside the clone via the host repo registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-registry-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    const skillRoot = await createSkillRoot(root);
    const agentsInfraRoot = await createAgentsInfraRepoRegistry(root, git.repo);

    async function compileFor(repo: string) {
      return compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: [repo],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
        },
        cwd: outside,
        agentsInfraRoot,
        localHostAlias: "fixture-host.example",
        skillInstallRoots: [skillRoot],
        now: () => "2026-06-13T00:00:00.000Z",
      });
    }

    const aliasCompiled = await compileFor("calyx");
    const slugCompiled = await compileFor("polli-labs/calyx-dev");
    const privateLeafCompiled = await compileFor("calyx-dev");

    expect(aliasCompiled.target).toMatchObject({
      repo: "calyx",
      base_sha: git.baseSha,
      head_sha: git.headSha,
      merge_base_sha: git.mergeBaseSha,
    });
    expect(aliasCompiled.worktree_ref).toBe(git.headSha);
    expect(slugCompiled.target).toMatchObject({
      repo: "calyx",
      requested_repo: "polli-labs/calyx-dev",
      repo_resolution_source: "registry",
      base_sha: git.baseSha,
      head_sha: git.headSha,
      merge_base_sha: git.mergeBaseSha,
    });
    expect(slugCompiled.repo).toBe("calyx");
    expect(slugCompiled.resolved_vars).toMatchObject({ repo: "polli-labs/calyx-dev" });
    expect(privateLeafCompiled.target).toMatchObject({
      repo: "calyx",
      requested_repo: "calyx-dev",
      repo_resolution_source: "registry",
      head_sha: git.headSha,
    });
    expect(privateLeafCompiled.repo).toBe("calyx");
    expect(privateLeafCompiled.prompt).toContain("Resolution source: registry");
    expect(privateLeafCompiled.prompt).toContain("Requested repo: calyx-dev");
    expect(privateLeafCompiled.metadata.agent_definition).toMatchObject({
      target_template_namespace: expect.arrayContaining([
        "target.requested_repo",
        "target.repo_resolution_source",
      ]),
    });
    expect(slugCompiled.worktree_ref).toBe(git.headSha);
  });

  test("keeps explicit paths but refuses cwd fallback for managed targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-fallbacks-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    const skillRoot = await createSkillRoot(root);

    const fromExplicitPath = await compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: [git.repo],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
      },
      cwd: outside,
      skillInstallRoots: [skillRoot],
    });
    expect(fromExplicitPath.target).toMatchObject({
      repo: git.repo,
      head_sha: git.headSha,
    });
    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: ["repo"],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
      },
      cwd: git.repo,
      skillInstallRoots: [skillRoot],
    })).rejects.toThrow("requires host-truth resolution before planning");
  });

  test("does not let a matching cwd rescue an ambiguous managed repo alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-ambiguous-cwd-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    const skillRoot = await createSkillRoot(root);
    const agentsInfraRoot = await createAgentsInfraRepoRegistry(root, git.repo);
    await writeFile(
      path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      [
        "hosts:",
        "  fixture-host:",
        "    repos:",
        "      calyx-polli:",
        `        path: ${JSON.stringify(git.repo)}`,
        "        aliases:",
        "          - polli-labs/calyx-dev",
        "      calyx-shadow:",
        `        path: ${JSON.stringify(path.join(root, "shadow"))}`,
        "        aliases:",
        "          - frontierkodiak/calyx-dev",
        "",
      ].join("\n"),
      "utf8",
    );

    for (const cwd of [outside, git.repo]) {
      await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: ["calyx-dev"],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
        },
        cwd,
        agentsInfraRoot,
        localHostAlias: "fixture-host.example",
        skillInstallRoots: [skillRoot],
      })).rejects.toThrow(
        /Repo identifier "calyx-dev" is ambiguous[\s\S]*calyx-polli[\s\S]*calyx-shadow[\s\S]*Refuse to guess/,
      );
    }
  });

  test("requires an explicit path instead of cwd shorthand for an unregistered managed repo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-managed-cwd-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const skillRoot = await createSkillRoot(root);
    const agentsInfraRoot = await createAgentsInfraRepoRegistry(root, git.repo);

    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: ["repo"],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
      },
      cwd: git.repo,
      agentsInfraRoot,
      localHostAlias: "fixture-host.example",
      skillInstallRoots: [skillRoot],
    })).rejects.toThrow("pass an explicit path");
  });

  test("does not let an owner-qualified unknown alias masquerade as a relative path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-owner-alias-cwd-"));
    roots.add(root);
    const registered = await createGitRepo(root);
    const nestedRoot = path.join(root, "unknown-owner");
    await createGitRepo(nestedRoot);
    const skillRoot = await createSkillRoot(root);
    const agentsInfraRoot = await createAgentsInfraRepoRegistry(root, registered.repo);

    await expect(compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
      variables: {
        repo: ["unknown-owner/repo"],
        scope: ["branch"],
        branch: ["feature/pol-1799"],
        base: ["main"],
      },
      cwd: root,
      agentsInfraRoot,
      localHostAlias: "fixture-host.example",
      skillInstallRoots: [skillRoot],
    })).rejects.toThrow(
      'Host "fixture-host" does not have repo slug or alias "unknown-owner/repo" in fleet/truths/hosts.yaml.',
    );
  });

  test("reports host-scoped available repos for unknown aliases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-unknown-repo-"));
    roots.add(root);
    const git = await createGitRepo(root);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    const skillRoot = await createSkillRoot(root);
    const agentsInfraRoot = await createAgentsInfraRepoRegistry(root, git.repo);

    await expect(
      compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: ["linnaeus"],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
        },
        cwd: outside,
        agentsInfraRoot,
        localHostAlias: "fixture-host.example",
        skillInstallRoots: [skillRoot],
      }),
    ).rejects.toThrow(
      'Host "fixture-host" does not have repo slug or alias "linnaeus" in fleet/truths/hosts.yaml. Available repos on fixture-host: calyx.',
    );
    await expect(
      compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: ["linnaeus"],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
        },
        cwd: outside,
        agentsInfraRoot,
        localHostAlias: "fixture-host.example",
        skillInstallRoots: [skillRoot],
      }),
    ).rejects.toThrow("Add the alias to fleet/truths/hosts.yaml or pass an explicit path.");
  });

  test("fails loudly on unknown vars and missing skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agent-errors-"));
    roots.add(root);
    const git = await createGitRepo(root);

    await expect(
      compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: [git.repo],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
          unknown: ["nope"],
        },
        cwd: git.repo,
        skillInstallRoots: [path.join(root, "missing-skills")],
      }),
    ).rejects.toThrow("Unknown --var unknown");

    await expect(
      compileAgentLaunch(fixtureRegistryPath(), "fixture-reviewer", {
        variables: {
          repo: [git.repo],
          scope: ["branch"],
          branch: ["feature/pol-1799"],
          base: ["main"],
        },
        cwd: git.repo,
        skillInstallRoots: [path.join(root, "missing-skills")],
      }),
    ).rejects.toThrow("is not installed");
  });
});
