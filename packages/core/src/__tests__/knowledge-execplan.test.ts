import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createExecPlan, promoteExecPlan } from "../knowledge";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("knowledge execplan lifecycle", () => {
  test("createExecPlan returns canonical scaffold content in plan mode", async () => {
    const result = await createExecPlan({
      title: "Runner Plan",
      issueId: "POL-894",
      targetRepo: "calyx-dev",
      targetBranch: "main",
      targetWorkdir: "/home/caleb/dev/calyx/wt/pol-894-knowledge-authoring-surface",
      targetHosts: ["blade"],
      runnerHarness: "codex-cli",
      runnerMode: "exec",
    });

    expect(result.id).toBe("execplan-pol-894");
    expect(result.kind).toBe("implementation");
    expect(result.state).toBe("draft");
    expect(result.apply).toBe(false);
    expect(result.action).toBe("plan-create");
    expect(result.content).toContain('doc_type: execplan');
    expect(result.content).toContain("execplan:");
    expect(result.content).toContain("id: execplan-pol-894");
    expect(result.content).toContain("- POL-894");
    expect(result.content).toContain("repo: calyx-dev");
    expect(result.content).toContain("harness: codex-cli");
    expect(result.content).toContain("## Execution receipts");
  });

  test("createExecPlan writes derived output path when apply is requested without an explicit path", async () => {
    const root = await createTempRoot("calyx-execplan-create-");
    process.chdir(root);

    const result = await createExecPlan({
      title: "Runner Plan",
      issueId: "POL-894",
      apply: true,
    });

    expect(result.outPath).toBe(path.join(await realpath(root), "execplan-pol-894.md"));
    const written = await readFile(result.outPath!, "utf8");
    expect(written).toContain("# Runner Plan");
    expect(written).toContain("## Plan (ordered)");
  });

  test("createExecPlan refuses to overwrite an existing scaffold path", async () => {
    const root = await createTempRoot("calyx-execplan-overwrite-");
    process.chdir(root);

    await createExecPlan({
      title: "Runner Plan",
      issueId: "POL-894",
      apply: true,
    });

    await expect(
      createExecPlan({
        title: "Runner Plan",
        issueId: "POL-894",
        apply: true,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("file already exists"),
      exitCode: 1,
    });
  });

  test("promoteExecPlan preserves execplan metadata during fieldwork filing", async () => {
    const root = await createTempRoot("calyx-execplan-promote-");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const draftPath = path.join(root, "execplan-pol-894.md");

    const draft = await createExecPlan({
      title: "Runner Plan",
      issueId: "POL-894",
      targetRepo: "calyx-dev",
      targetHosts: ["blade"],
    });

    await writeFile(draftPath, draft.content, "utf8");

    const result = await promoteExecPlan({
      inputPath: draftPath,
      vaultPath,
      dryRun: true,
    });

    expect(result.relativePath).toBe(path.join("20-plans", "POL-894-runner-plan.md"));
    expect(result.action).toBe("plan-promote");
    expect(result.issueId).toBe("POL-894");
    expect(result.content).toContain("type: execplan");
    expect(result.content).toContain("doc_type: execplan");
    expect(result.content).toContain("execplan:");
    expect(result.content).toContain("id: execplan-pol-894");
    expect(result.content).toContain("issue: POL-894");
    expect(result.content).toContain("## Goal");
  });

  test("promoteExecPlan fails with a structured error when the source file is missing", async () => {
    const root = await createTempRoot("calyx-execplan-promote-missing-");
    const missingPath = path.join(root, "missing-execplan.md");

    await expect(
      promoteExecPlan({
        inputPath: missingPath,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: `[knowledge execplan promote] source file not found: ${missingPath}`,
    });
  });

  test("promoteExecPlan applies title and issue overrides coherently", async () => {
    const root = await createTempRoot("calyx-execplan-promote-override-");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const draftPath = path.join(root, "execplan-pol-894.md");

    const draft = await createExecPlan({
      title: "Old Title",
      issueId: "POL-894",
    });

    await writeFile(draftPath, draft.content, "utf8");

    const result = await promoteExecPlan({
      inputPath: draftPath,
      title: "New Title",
      issueId: "POL-999",
      vaultPath,
      dryRun: true,
    });

    expect(result.relativePath).toBe(path.join("20-plans", "POL-999-new-title.md"));
    expect(result.content).toContain("title: New Title");
    expect(result.content).toContain("# New Title");
    expect(result.content).toContain("issue: POL-999");
    expect(result.content).toContain("- POL-999");
  });

  test("promoteExecPlan drops stale note-layer metadata from the source draft", async () => {
    const root = await createTempRoot("calyx-execplan-promote-sanitize-");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    const draftPath = path.join(root, "execplan-pol-894.md");

    await writeFile(
      draftPath,
      [
        "---",
        'title: "Runner Plan"',
        'doc_type: "execplan"',
        "status: archived",
        "author: old-author",
        "project: stale-project",
        "workstream: stale-workstream",
        'last_modified: "2026-03-17T22:00:00Z"',
        'last_reviewed: "2026-03-17T22:00:00Z"',
        'scope: "repo"',
        "execplan:",
        '  id: "execplan-pol-894"',
        '  kind: "implementation"',
        '  state: "draft"',
        "---",
        "",
        "# Runner Plan",
        "",
        "## Goal",
        "Do the work.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await promoteExecPlan({
      inputPath: draftPath,
      vaultPath,
      dryRun: true,
    });

    expect(result.content).not.toContain("author: old-author");
    expect(result.content).not.toContain("project: stale-project");
    expect(result.content).not.toContain("workstream: stale-workstream");
    expect(result.content).toContain("status: active");
  });

  test("promoteExecPlan rejects non-execplan drafts", async () => {
    const root = await createTempRoot("calyx-execplan-promote-invalid-");
    const draftPath = path.join(root, "notes.md");
    await writeFile(draftPath, "# Not an ExecPlan\n", "utf8");

    await expect(
      promoteExecPlan({
        inputPath: draftPath,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("not a compatible ExecPlan draft"),
      exitCode: 2,
    });
  });
});
