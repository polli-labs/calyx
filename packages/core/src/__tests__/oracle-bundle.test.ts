import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyOracleBundleV1,
  doctorOracleBundleV1,
  initOracleBundleV1,
  parseOracleBundleRecipeV1,
  planOracleBundleV1,
  planOracleRunV1,
  synthesizeOracleResponsesV1,
  writeOracleRunResultV1,
} from "../oracle-bundle";

const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempRoot(prefix = "calyx-oracle-bundle-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function initGitRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "README.md"), "# fixture repo\n", "utf8");
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "codex@example.invalid"], { cwd: root });
  await execFile("git", ["config", "user.name", "Codex"], { cwd: root });
  await execFile("git", ["add", "README.md"], { cwd: root });
  await execFile("git", ["commit", "-m", "init"], { cwd: root });
}

async function writeExecutableScript(root: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(root, name);
  await writeFile(scriptPath, `#!/usr/bin/env node\n${body}`, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("oracle bundle domain", () => {
  test("parses recipe defaults and validates v1 shape", () => {
    const recipe = parseOracleBundleRecipeV1(`
version: oracle-bundle/v1
id: POL-1087 Oracle Bundle
prompt:
  path: oracle-prompt.md
vault:
  files:
    - 40-context/hooks-reference.md
linear:
  issues: [POL-1087]
repos:
  - path: /tmp/calyx
    mode: archive
sessions:
  - id: 019da27a-1000-77d0-88be-9996061b9d2c
activity:
  queries:
    - id: recent-calyx-work
      host: carbon
      since_hours: 72
      include_interactive: true
      agent_kind: all
      include: [summary, worktrees]
`);

    expect(recipe.id).toBe("pol-1087-oracle-bundle");
    expect(recipe.policy.inclusion).toBe("broad");
    expect(recipe.policy.redaction).toBe("strict");
    expect(recipe.variants.map((variant) => variant.id)).toEqual(["sandbox"]);
    expect(recipe.linear.include_comments).toBe(true);
    expect(recipe.activity.queries[0]?.id).toBe("recent-calyx-work");
  });

  test("rejects ids that normalize to empty slugs", () => {
    expect(() =>
      parseOracleBundleRecipeV1(`
version: oracle-bundle/v1
id: "!!!"
`),
    ).toThrow(/id must not be empty after slugify/);

    expect(() =>
      parseOracleBundleRecipeV1(`
version: oracle-bundle/v1
id: valid
variants:
  - id: "!!!"
`),
    ).toThrow(/variants\[0\]\.id must not be empty after slugify/);
  });

  test("rejects unsafe recipe-relative paths and duplicate repo outputs", () => {
    expect(() =>
      parseOracleBundleRecipeV1(`
version: oracle-bundle/v1
id: valid
prompt:
  path: ../oracle-prompt.md
`),
    ).toThrow(/prompt\.path must be a relative path inside the inquiry/);

    expect(() =>
      parseOracleBundleRecipeV1(`
version: oracle-bundle/v1
id: valid
repos:
  - id: calyx
    path: /tmp/one
    mode: archive
  - id: calyx
    path: /tmp/two
    mode: archive
`),
    ).toThrow(/duplicate output path/);
  });

  test("init writes inquiry scaffold files", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");

    const result = await initOracleBundleV1({
      slug: "POL-1087 Oracle Bundle",
      outDir,
      issue: "POL-1087",
      project: "calyx",
      variants: ["sandbox", "tools"],
      author: "codex:carbon",
    });

    expect(result.inquiry_dir).toBe(outDir);
    expect(result.files).toHaveLength(4);

    const recipe = await readFile(path.join(outDir, "inquiry.yaml"), "utf8");
    const readme = await readFile(path.join(outDir, "README.md"), "utf8");
    const prompt = await readFile(path.join(outDir, "oracle-prompt.md"), "utf8");
    const skeleton = await readFile(path.join(outDir, "oracle-response-skeleton.md"), "utf8");

    expect(recipe).toContain("version: oracle-bundle/v1");
    expect(recipe).toContain("POL-1087");
    expect(recipe).toContain("tools: true");
    expect(readme).toContain("calyx oracle bundle . --recipe inquiry.yaml --plan --json");
    expect(readme).not.toContain("after running `calyx oracle bundle --apply`");
    expect(prompt).toContain("# Oracle Consultation");
    expect(skeleton).toContain("variant: sandbox");
  });

  test("init rejects empty normalized slugs and uses the first configured response variant", async () => {
    const root = await tempRoot();
    await expect(initOracleBundleV1({ slug: "!!!", outDir: path.join(root, "bad") })).rejects.toThrow(
      /slug must not be empty after slugify/,
    );

    const outDir = path.join(root, "inquiry");
    await initOracleBundleV1({
      slug: "pol-1087-oracle-bundle-rfc",
      outDir,
      variants: ["tools"],
      now: new Date("2026-04-28T12:00:00Z"),
    });

    const skeleton = await readFile(path.join(outDir, "oracle-response-skeleton.md"), "utf8");
    expect(skeleton).toContain("created: 2026-04-28");
    expect(skeleton).toContain("variant: tools");
  });

  test("bundle plan is deterministic and reports expected outputs", async () => {
    const root = await tempRoot();
    const vaultPath = path.join(root, "vault", "fieldwork");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(path.join(vaultPath, "40-context", "hooks-reference.md"), "# hooks\n", "utf8");

    const outDir = path.join(root, "inquiry");
    const repoPath = path.join(root, "calyx");
    await initOracleBundleV1({
      slug: "pol-1087-oracle-bundle-rfc",
      outDir,
      issue: "POL-1087",
      project: "calyx",
    });
    const recipePath = path.join(outDir, "inquiry.yaml");
    await writeFile(
      recipePath,
      `version: oracle-bundle/v1
id: pol-1087-oracle-bundle-rfc
policy:
  inclusion: broad
  budget_tokens: 1000
  redaction: strict
prompt:
  path: oracle-prompt.md
vault:
  files:
    - ${path.join(vaultPath, "40-context", "hooks-reference.md")}
linear:
  issues: [POL-1087]
repos:
  - id: calyx-dev
    path: ${repoPath}
    mode: archive
sessions:
  - id: 019da27a-1000-77d0-88be-9996061b9d2c
activity:
  queries:
    - id: recent-calyx-work
      host: carbon
      include_interactive: true
`,
      "utf8",
    );

    const first = await planOracleBundleV1(outDir);
    const second = await planOracleBundleV1(outDir);

    expect(first.plan_hash).toBe(second.plan_hash);
    expect(first.counts).toMatchObject({
      linear_issues: 1,
      repos: 1,
      sessions: 1,
      activity_queries: 1,
      vault_files: 1,
    });
    expect(first.outputs.map((output) => output.path)).toContain(path.posix.join("context", "vault-context.md"));
    expect(first.outputs.map((output) => output.path)).toContain(path.posix.join("context", "activity-summary.md"));
    expect(first.outputs.map((output) => output.path)).toContain(path.posix.join("code", "calyx-dev-codebase.zip"));
    expect(first.budget.sources_missing).toBe(0);
  });

  test("bundle plan hash is independent of inquiry directory path", async () => {
    const root = await tempRoot();
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    const recipe = `version: oracle-bundle/v1
id: pol-1087-oracle-bundle-rfc
prompt:
  path: oracle-prompt.md
linear:
  issues: [POL-1087]
`;
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await writeFile(path.join(firstDir, "inquiry.yaml"), recipe, "utf8");
    await writeFile(path.join(secondDir, "inquiry.yaml"), recipe, "utf8");

    const first = await planOracleBundleV1(firstDir);
    const second = await planOracleBundleV1(secondDir);

    expect(first.inquiry_dir).not.toBe(second.inquiry_dir);
    expect(first.plan_hash).toBe(second.plan_hash);
  });

  test("doctor distinguishes scaffold errors from warnings", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    await initOracleBundleV1({
      slug: "pol-1087-oracle-bundle-rfc",
      outDir,
    });

    const healthy = await doctorOracleBundleV1(outDir);
    expect(healthy.ok).toBe(true);
    expect(healthy.findings.some((finding) => finding.code === "manifest_missing")).toBe(true);

    await rm(path.join(outDir, "oracle-prompt.md"));
    const broken = await doctorOracleBundleV1(outDir);
    expect(broken.ok).toBe(false);
    expect(broken.findings.some((finding) => finding.code === "missing_authored_file")).toBe(true);

    await mkdir(path.join(outDir, "oracle-prompt.md"));
    const unreadable = await doctorOracleBundleV1(outDir);
    expect(unreadable.ok).toBe(false);
    expect(unreadable.findings.some((finding) => finding.code === "prompt_unreadable")).toBe(true);
  });

  test("apply materializes vault, linear, repo archive, receipts, and manifest", async () => {
    const root = await tempRoot();
    const vaultPath = path.join(root, "vault", "fieldwork");
    const repoPath = path.join(root, "repo");
    const outDir = path.join(root, "inquiry");
    await mkdir(path.join(vaultPath, "50-projects", "calyx"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "50-projects", "calyx", "oracle.md"),
      "# Oracle note\nAPI_KEY=sk-this-looks-like-a-real-key-1234567890\n",
      "utf8",
    );
    await initGitRepo(repoPath);
    await initOracleBundleV1({ slug: "pol-1180-oracle-apply", outDir, issue: "POL-1180", project: "calyx" });
    await writeFile(path.join(outDir, "linear-seed.json"), `${JSON.stringify({ issue: "POL-1180" })}\n`, "utf8");
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1180-oracle-apply
policy:
  redaction: strict
  fail_on_secret: true
prompt:
  path: oracle-prompt.md
vault:
  files:
    - 50-projects/calyx/oracle.md
linear:
  issues: [POL-1180]
  context_path: linear-seed.json
repos:
  - id: fixture
    path: ${repoPath}
    mode: archive
`,
      "utf8",
    );

    const result = await applyOracleBundleV1(outDir, {
      vaultPath,
      now: new Date("2026-04-28T12:00:00Z"),
    });

    expect(result.version).toBe("oracle-bundle-apply/v1");
    expect(result.manifest.outputs.map((output) => output.path)).toContain("context/vault-context.md");
    expect(result.manifest.outputs.map((output) => output.path)).toContain("context/linear-context.json");
    expect(result.manifest.outputs.map((output) => output.path)).toContain("code/fixture-codebase.zip");
    expect(result.manifest.redaction.redaction_events).toBeGreaterThan(0);

    const vaultContext = await readFile(path.join(outDir, "context", "vault-context.md"), "utf8");
    expect(vaultContext).toContain("[calyx-oracle-redacted:strict:");
    expect(vaultContext).not.toContain("sk-this-looks-like-a-real-key");

    const manifestRaw = await readFile(path.join(outDir, "receipts", "bundle.manifest.json"), "utf8");
    expect(manifestRaw).toContain("\"version\": \"oracle-bundle-manifest/v1\"");

    const doctor = await doctorOracleBundleV1(outDir);
    expect(doctor.findings.some((finding) => finding.code === "manifest_missing")).toBe(false);
  });

  test("apply materializes activity summary from calyx run ps", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const fakeCalyx = await writeExecutableScript(
      root,
      "fake-calyx.js",
      `const payload = [
  {
    entry_kind: "interactive_session",
    run_id: "interactive:codex:session-a",
    state: "interactive",
    summary: "Implemented oracle activity",
    created_at: "2026-04-28T12:00:00.000Z",
    updated_at: "2026-04-28T12:05:00.000Z",
    host: "carbon",
    backend: "codex",
    session_id: "session-a",
    session_path: "/tmp/session-a.jsonl",
    cwd: "/repo",
    source: "codex_sessions",
    bytes: 123
  }
];
console.log(JSON.stringify(payload));`,
    );
    await initOracleBundleV1({ slug: "pol-1181-oracle-activity", outDir });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1181-oracle-activity
prompt:
  path: oracle-prompt.md
activity:
  queries:
    - id: recent-calyx-work
      host: carbon
      since_hours: 72
      include_interactive: true
      agent_kind: codex
      limit: 5
      include: [summary, worktrees, transcripts]
`,
      "utf8",
    );

    const result = await applyOracleBundleV1(outDir, { calyxCommand: fakeCalyx });

    expect(result.manifest.outputs.map((output) => output.path)).toContain("context/activity-summary.md");
    const activitySummary = await readFile(path.join(outDir, "context", "activity-summary.md"), "utf8");
    expect(activitySummary).toContain("## Query: recent-calyx-work");
    expect(activitySummary).toContain("interactive:codex:session-a");
    expect(activitySummary).toContain("Implemented oracle activity");
  });

  test("apply materializes selected session excerpts through ctxkit", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const sessionRoot = path.join(root, "repo");
    await mkdir(sessionRoot, { recursive: true });
    const fakeCtx = await writeExecutableScript(
      root,
      "fake-ctx.js",
      `console.log(\`--- README.md ---
repo context
--- .ctxkit/sessions/codex/not-session-a ---
wrong excerpt
--- .ctxkit/sessions/codex/session-a ---
assistant excerpt from ctxkit
--- .ctxkit/sessions/codex/session-b ---
second assistant excerpt from ctxkit
--- ctxkit/omitted ---
none\`);`,
    );
    await initOracleBundleV1({ slug: "pol-1181-oracle-sessions", outDir });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1181-oracle-sessions
prompt:
  path: oracle-prompt.md
sessions:
  - id: session-a
    provider: codex
    mode: summary
    root: ${sessionRoot}
    scope: recent
    bytes: 64
  - id: session-b
    provider: codex
    mode: summary
    root: ${sessionRoot}
    scope: all
    bytes: 64
`,
      "utf8",
    );

    const result = await applyOracleBundleV1(outDir, { ctxCommand: fakeCtx });

    expect(result.manifest.outputs.map((output) => output.path)).toContain("context/session-context.md");
    const sessionContext = await readFile(path.join(outDir, "context", "session-context.md"), "utf8");
    expect(sessionContext).toContain("## codex/session-a");
    expect(sessionContext).toContain("assistant excerpt from ctxkit");
    expect(sessionContext).toContain("## codex/session-b");
    expect(sessionContext).toContain("second assistant excerpt from ctxkit");
    expect(sessionContext).not.toContain("wrong excerpt");
    expect(result.manifest.warnings.map((warning) => warning.code)).toContain("session_scope_conflict");
  });

  test("apply records explicit warnings for unavailable ctxkit session/repo providers", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);
    await initOracleBundleV1({ slug: "pol-1180-oracle-apply", outDir });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1180-oracle-apply
prompt:
  path: oracle-prompt.md
repos:
  - id: fixture
    path: ${repoPath}
    mode: ctxpack
sessions:
  - id: 019da27a-1000-77d0-88be-9996061b9d2c
`,
      "utf8",
    );

    const result = await applyOracleBundleV1(outDir, { ctxCommand: "missing-ctx-command-for-test" });

    expect(result.manifest.outputs.map((output) => output.path)).not.toContain("code/fixture-ctxpack.txt");
    expect(result.manifest.outputs.map((output) => output.path)).toContain("context/session-context.md");
    expect(result.manifest.warnings.map((warning) => warning.code)).toContain("ctxkit_unavailable");
  });

  test("apply emits ctxpack repo attachments as text/plain-safe .txt outputs", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const repoPath = path.join(root, "repo");
    await initGitRepo(repoPath);
    const fakeCtx = await writeExecutableScript(
      root,
      "fake-ctx.js",
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--output");
fs.writeFileSync(args[outIndex + 1], "# repo ctxpack\\nrepo context for oracle\\n");`,
    );
    await initOracleBundleV1({ slug: "pol-1335-oracle-ctxpack", outDir });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1335-oracle-ctxpack
prompt:
  path: oracle-prompt.md
repos:
  - id: fixture
    path: ${repoPath}
    mode: ctxpack
`,
      "utf8",
    );

    const result = await applyOracleBundleV1(outDir, { ctxCommand: fakeCtx });

    expect(result.manifest.outputs.map((output) => output.path)).toContain("code/fixture-ctxpack.txt");
    expect(result.manifest.outputs.map((output) => output.path)).not.toContain("code/fixture-ctxpack");

    const plan = await planOracleRunV1(outDir, { variant: "sandbox" });
    const ctxpackAttachment = plan.attachments.find((attachment) => attachment.path === "code/fixture-ctxpack.txt");
    expect(ctxpackAttachment).toBeDefined();
    expect(ctxpackAttachment?.mime_type).toBe("text/plain");
  });

  test("oracle run plan consumes bundle manifest and rejects GPT Pro API policy", async () => {
    const root = await tempRoot();
    const vaultPath = path.join(root, "vault", "fieldwork");
    const outDir = path.join(root, "inquiry");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(path.join(vaultPath, "note.md"), "# note\ncontext for oracle\n", "utf8");
    await initOracleBundleV1({ slug: "pol-1232-oracle-run", outDir, issue: "POL-1232", project: "calyx" });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1232-oracle-run
prompt:
  path: oracle-prompt.md
vault:
  files:
    - note.md
`,
      "utf8",
    );
    await applyOracleBundleV1(outDir, { vaultPath });

    const plan = await planOracleRunV1(outDir, { variant: "sandbox" });

    expect(plan.version).toBe("oracle-run-plan/v1");
    expect(plan.provider).toBe("gemini");
    expect(plan.model).toContain("gemini");
    expect(plan.ready).toBe(true);
    expect(plan.attachments.map((attachment) => attachment.path)).toContain("context/vault-context.md");
    expect(plan.receipt_path).toBe("receipts/oracle-run-gemini-sandbox.json");

    await expect(planOracleRunV1(outDir, { provider: "openai", model: "gpt-5.4-pro" })).rejects.toThrow(
      /OpenAI\/GPT Pro API oracle runs are not supported/,
    );
    await expect(planOracleRunV1(outDir, { model: "gpt-5.4-pro" })).rejects.toThrow(/not allowed/);
    await expect(planOracleRunV1(outDir, { model: "gpt5-pro" })).rejects.toThrow(/not allowed/);
  });

  test("oracle run writes response markdown and receipt", async () => {
    const root = await tempRoot();
    const vaultPath = path.join(root, "vault", "fieldwork");
    const outDir = path.join(root, "inquiry");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(path.join(vaultPath, "note.md"), "# note\ncontext for oracle\n", "utf8");
    await initOracleBundleV1({ slug: "pol-1232-oracle-run", outDir });
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1232-oracle-run
prompt:
  path: oracle-prompt.md
vault:
  files:
    - note.md
`,
      "utf8",
    );
    await applyOracleBundleV1(outDir, { vaultPath });
    const plan = await planOracleRunV1(outDir, { variant: "sandbox" });

    const result = await writeOracleRunResultV1({
      plan,
      responseText: "Oracle says ship the Gemini route.",
      startedAt: new Date("2026-05-01T12:00:00Z"),
      completedAt: new Date("2026-05-01T12:01:00Z"),
      usage: { prompt_tokens: 10, response_tokens: 5, total_tokens: 15 },
      providerResponseId: "gemini-response-1",
    });

    const response = await readFile(result.response_path, "utf8");
    const receipt = await readFile(result.receipt_path, "utf8");
    expect(response).toContain("provider: gemini");
    expect(response).toContain("Oracle says ship the Gemini route.");
    expect(receipt).toContain("\"version\": \"oracle-run-receipt/v1\"");
    expect(receipt).toContain("\"provider_response_id\": \"gemini-response-1\"");
  });

  test("oracle synthesize discovers response files and writes scaffold", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "oracle-response-skeleton.md"), "# skeleton\n", "utf8");
    await writeFile(path.join(outDir, "oracle-response-gemini-sandbox.md"), "# response\n", "utf8");

    const result = await synthesizeOracleResponsesV1(outDir, {
      now: new Date("2026-05-01T12:00:00Z"),
    });

    expect(result.responses.map((response) => response.path)).toEqual(["oracle-response-gemini-sandbox.md"]);
    expect(result.wrote).toBe(true);
    const synthesis = await readFile(result.synthesis_path, "utf8");
    expect(synthesis).toContain("## Strong Convergence");
    expect(synthesis).toContain("oracle-response-gemini-sandbox.md");
  });
});
