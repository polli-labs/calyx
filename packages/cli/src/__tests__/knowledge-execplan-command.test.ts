import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  delete process.env["VAULT_PATH"];
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("knowledge execplan command", () => {
  test("knowledge execplan new emits canonical scaffold metadata in json mode", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "knowledge",
      "execplan",
      "new",
      "--title",
      "Runner Plan",
      "--issue-id",
      "POL-894",
      "--kind",
      "planning",
      "--runner-mode",
      "exec",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      id: string;
      kind: string;
      state: string;
      content: string;
      action: string;
    };

    expect(payload.id).toBe("execplan-pol-894");
    expect(payload.kind).toBe("planning");
    expect(payload.state).toBe("draft");
    expect(payload.action).toBe("plan-create");
    expect(payload.content).toContain("doc_type: execplan");
    expect(payload.content).toContain("mode: exec");
  });

  test("knowledge execplan promote preserves source metadata in dry-run json mode", async () => {
    const root = await createTempRoot("calyx-knowledge-execplan-cli-");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;

    const draftPath = path.join(root, "execplan-pol-894.md");
    await writeFile(
      draftPath,
      [
        "---",
        'title: "Runner Plan"',
        'doc_type: "execplan"',
        "status: active",
        "owner: polli-labs",
        'last_modified: "2026-03-17T22:00:00Z"',
        'last_reviewed: "2026-03-17T22:00:00Z"',
        'scope: "repo"',
        "execplan:",
        '  id: "execplan-pol-894"',
        '  kind: "implementation"',
        '  state: "draft"',
        "  linear:",
        "    issues:",
        '      - "POL-894"',
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

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "knowledge",
      "execplan",
      "promote",
      draftPath,
      "--dry-run",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      relativePath: string;
      action: string;
      content: string;
    };

    expect(payload.relativePath).toBe(path.join("20-plans", "POL-894-runner-plan.md"));
    expect(payload.action).toBe("plan-promote");
    expect(payload.content).toContain("type: execplan");
    expect(payload.content).toContain("doc_type: execplan");
    expect(payload.content).toContain("execplan:");
  });

  test("knowledge execplan promote rejects invalid source metadata", async () => {
    const root = await createTempRoot("calyx-knowledge-execplan-cli-invalid-");
    const draftPath = path.join(root, "notes.md");
    await writeFile(draftPath, "# Not an ExecPlan\n", "utf8");

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "knowledge",
        "execplan",
        "promote",
        draftPath,
        "--dry-run",
      ]),
    ).rejects.toMatchObject({
      message: expect.stringContaining("not a compatible ExecPlan draft"),
      exitCode: 2,
    });
  });
});
