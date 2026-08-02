import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

function surfacesDir(): string {
  return path.resolve(process.cwd(), "fixtures/instructions/surfaces");
}

async function createTempReconcileFixture(
  targetFiles: Record<string, string>,
  options: {
    bindingClass?: "directory_root" | "repo_root";
    createTargetRoot?: boolean;
  } = {},
): Promise<{ root: string; surfacesDir: string; targetRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-cli-instruction-reconcile-"));
  const surfacesDir = path.join(root, "surfaces");
  const targetRoot = path.join(root, "targets");
  await mkdir(surfacesDir, { recursive: true });
  if (options.createTargetRoot ?? true) {
    await mkdir(targetRoot, { recursive: true });
  }
  const manifest = [
    "surface_id: sample-global",
    "status: active",
    "owner: polli-labs",
    "description: CLI reconcile fixture surface.",
    "source_ref:",
    `  fleet_path: ${path.resolve(process.cwd(), "fixtures/instructions/inputs/fleet.v1.yaml")}`,
    `  hosts_dir: ${path.resolve(process.cwd(), "fixtures/instructions/inputs/hosts")}`,
    `  template_path: ${path.resolve(process.cwd(), "fixtures/instructions/templates/AGENTS.sample.md.mustache")}`,
    `  partials_dir: ${path.resolve(process.cwd(), "fixtures/instructions/templates/partials")}`,
    `  expected_dir: ${path.resolve(process.cwd(), "fixtures/instructions/expected")}`,
    "target_bindings:",
    "  - binding_id: managed-directory",
    `    class: ${options.bindingClass ?? "directory_root"}`,
    `    path: ${targetRoot}`,
    "    managed_files:",
    "      - AGENTS.md",
    "      - CLAUDE.md",
    "    selectors:",
    "      hosts: [blade]",
    "",
  ].join("\n");
  await writeFile(path.join(surfacesDir, "sample-global.yaml"), manifest, "utf8");

  for (const [filename, contents] of Object.entries(targetFiles)) {
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, filename), contents, "utf8");
  }

  return { root, surfacesDir, targetRoot };
}

function wrapManagedInstruction(body: string): string {
  return [
    "---",
    "calyx:",
    "  managed_by: instructions",
    "  surface_id: sample-global",
    "  binding_id: managed-directory",
    "---",
    body,
  ].join("\n");
}

describe("instructions command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("instructions list reports named surfaces", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "instructions",
      "list",
      "--surfaces-dir",
      surfacesDir(),
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as { total: number; items: Array<{ surfaceId: string }> };
    expect(payload.total).toBe(1);
    expect(payload.items.map((item) => item.surfaceId)).toEqual(["sample-global"]);
  });

  test("instructions render supports named surface mode", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "instructions",
      "render",
      "--surfaces-dir",
      surfacesDir(),
      "--surface",
      "sample-global",
      "--host",
      "blade",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      surfaceId: string;
      results: Array<{ host: string; output: string }>;
    };
    expect(payload.surfaceId).toBe("sample-global");
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.host).toBe("blade");
    expect(payload.results[0]?.output).toContain("Host alias is blade");
  });

  test("instructions verify supports named surface mode", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "instructions",
      "verify",
      "--surfaces-dir",
      surfacesDir(),
      "--surface",
      "sample-global",
      "--all",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      surfaceId: string;
      ok: boolean;
      expectedDir: string;
    };
    expect(payload.surfaceId).toBe("sample-global");
    expect(payload.ok).toBe(true);
    expect(payload.expectedDir).toContain("fixtures/instructions/expected");
  });

  test("instructions reconcile emits JSON and exits 3 when unmanaged matches still need migration", async () => {
    const expectedOutput = await readFile(
      path.resolve(process.cwd(), "fixtures/instructions/expected/blade.instructions.md"),
      "utf8",
    );
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": expectedOutput,
      "CLAUDE.md": expectedOutput,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "instructions",
          "reconcile",
          "--surfaces-dir",
          fixture.surfacesDir,
          "--host",
          "blade",
          "--json",
        ]),
      ).rejects.toMatchObject({ exitCode: 3 });

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: { findings: number; byStatus: { unmanaged_match: number } };
      };
      expect(payload.summary.findings).toBe(2);
      expect(payload.summary.byStatus.unmanaged_match).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions reconcile succeeds when local targets are already managed", async () => {
    const expectedOutput = await readFile(
      path.resolve(process.cwd(), "fixtures/instructions/expected/blade.instructions.md"),
      "utf8",
    );
    const managedDocument = wrapManagedInstruction(expectedOutput);
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": managedDocument,
      "CLAUDE.md": managedDocument,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "reconcile",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: { findings: number; okTargets: number };
      };
      expect(payload.summary.findings).toBe(0);
      expect(payload.summary.okTargets).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions apply exits 3 when unmanaged matches still require explicit adoption", async () => {
    const expectedOutput = await readFile(
      path.resolve(process.cwd(), "fixtures/instructions/expected/blade.instructions.md"),
      "utf8",
    );
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": expectedOutput,
      "CLAUDE.md": expectedOutput,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "instructions",
          "apply",
          "--surfaces-dir",
          fixture.surfacesDir,
          "--host",
          "blade",
          "--json",
        ]),
      ).rejects.toMatchObject({ exitCode: 3 });

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: { blockedTargets: number };
      };
      expect(payload.summary.blockedTargets).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions apply --dry-run --reviewed-overwrite plans unmanaged divergent replacement without writing", async () => {
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": "# old live guide\n",
      "CLAUDE.md": "# old live guide\n",
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "apply",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--dry-run",
        "--reviewed-overwrite",
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        dryRun: boolean;
        reviewedOverwrite: boolean;
        summary: {
          changedTargets: number;
          blockedTargets: number;
          byAction: { reviewed_overwrite: number };
        };
        plannedChanges: Array<{ action: string; liveContentSha256?: string; expectedContentSha256?: string }>;
      };
      expect(payload.dryRun).toBe(true);
      expect(payload.reviewedOverwrite).toBe(true);
      expect(payload.summary.changedTargets).toBe(0);
      expect(payload.summary.blockedTargets).toBe(0);
      expect(payload.summary.byAction.reviewed_overwrite).toBe(2);
      expect(payload.plannedChanges).toHaveLength(2);
      expect(payload.plannedChanges.every((change) => change.action === "reviewed_overwrite")).toBe(true);
      expect(payload.plannedChanges.every((change) => change.liveContentSha256 && change.expectedContentSha256)).toBe(
        true,
      );

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toBe("# old live guide\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions apply --reviewed-overwrite backs up and replaces unmanaged divergent files", async () => {
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": "# old live guide\n",
      "CLAUDE.md": "# old live guide\n",
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "apply",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--reviewed-overwrite",
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: {
          changedTargets: number;
          blockedTargets: number;
          byAction: { reviewed_overwrite: number };
        };
        changes: Array<{ managedFile: string; action: string; backupPath?: string }>;
      };
      expect(payload.summary.changedTargets).toBe(2);
      expect(payload.summary.blockedTargets).toBe(0);
      expect(payload.summary.byAction.reviewed_overwrite).toBe(2);
      expect(payload.changes).toHaveLength(2);
      expect(payload.changes.every((change) => change.action === "reviewed_overwrite" && change.backupPath)).toBe(
        true,
      );

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");
      expect(agentsText).toContain("Host alias is blade");

      const agentsBackupPath = payload.changes.find((change) => change.managedFile === "AGENTS.md")?.backupPath;
      expect(agentsBackupPath).toBeTruthy();
      await expect(readFile(agentsBackupPath ?? "", "utf8")).resolves.toBe("# old live guide\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions apply --reviewed-overwrite --backup-dir writes backups under the requested root", async () => {
    const fixture = await createTempReconcileFixture(
      {
        "AGENTS.md": "# old live guide\n",
        "CLAUDE.md": "# old live guide\n",
      },
      { bindingClass: "repo_root" },
    );
    const backupRoot = path.join(fixture.root, "operator-reviewed-backups");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "apply",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--reviewed-overwrite",
        "--backup-dir",
        backupRoot,
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        changes: Array<{ managedFile: string; backupPath?: string }>;
      };
      expect(payload.changes).toHaveLength(2);
      expect(payload.changes.every((change) => change.backupPath?.startsWith(backupRoot))).toBe(true);
      const agentsBackupPath = payload.changes.find((change) => change.managedFile === "AGENTS.md")?.backupPath;
      await expect(readFile(agentsBackupPath ?? "", "utf8")).resolves.toBe("# old live guide\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions adopt converts unmanaged matching files into managed targets", async () => {
    const expectedOutput = await readFile(
      path.resolve(process.cwd(), "fixtures/instructions/expected/blade.instructions.md"),
      "utf8",
    );
    const fixture = await createTempReconcileFixture({
      "AGENTS.md": expectedOutput,
      "CLAUDE.md": expectedOutput,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "adopt",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: { changedTargets: number; blockedTargets: number };
      };
      expect(payload.summary.changedTargets).toBe(2);
      expect(payload.summary.blockedTargets).toBe(0);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("instructions apply honors --repo-root for repo_root surfaces", async () => {
    const fixture = await createTempReconcileFixture(
      {},
      {
        createTargetRoot: false,
        bindingClass: "repo_root",
      },
    );
    const overrideRoot = path.join(fixture.root, "worktree-root");
    await mkdir(overrideRoot, { recursive: true });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "instructions",
        "apply",
        "--surfaces-dir",
        fixture.surfacesDir,
        "--host",
        "blade",
        "--surface",
        "sample-global",
        "--repo-root",
        overrideRoot,
        "--json",
      ]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        summary: { changedTargets: number; blockedTargets: number };
      };
      expect(payload.summary.changedTargets).toBe(2);
      expect(payload.summary.blockedTargets).toBe(0);

      const agentsText = await readFile(path.join(overrideRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
