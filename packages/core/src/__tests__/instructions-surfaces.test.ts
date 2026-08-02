import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import YAML from "yaml";
import {
  adoptInstructionSurfaces,
  applyInstructionSurfaces,
  listInstructionSurfaces,
  listInstructionTargets,
  reconcileInstructionSurfaces,
  renderInstructionSurface,
  showInstructionSurface,
  verifyInstructionSurface,
} from "../instructions-surfaces";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/instructions");
}

async function createTempSurfacesDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-instruction-surfaces-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
  return root;
}

async function createTempReconcileFixture(options: {
  status?: "active" | "archived";
  targetFiles?: Record<string, string>;
  createTargetRoot?: boolean;
  renderedOutput?: string;
  bindingClass?: "directory_root" | "repo_root";
  managedFiles?: string[];
  markerMode?: "frontmatter" | "none";
} = {}): Promise<{ root: string; surfacesDir: string; targetRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-instruction-reconcile-"));
  const surfacesDir = path.join(root, "surfaces");
  const targetRoot = path.join(root, "targets");
  const expectedDir = options.renderedOutput ? path.join(root, "expected") : path.join(fixtureRoot(), "expected");
  const templatePath = options.renderedOutput
    ? path.join(root, "template", "AGENTS.sample.md.mustache")
    : path.join(fixtureRoot(), "templates", "AGENTS.sample.md.mustache");
  const partialsDir = options.renderedOutput
    ? path.join(root, "template", "partials")
    : path.join(fixtureRoot(), "templates", "partials");
  await mkdir(surfacesDir, { recursive: true });
  if (options.createTargetRoot ?? true) {
    await mkdir(targetRoot, { recursive: true });
  }
  if (options.renderedOutput) {
    await mkdir(path.dirname(templatePath), { recursive: true });
    await mkdir(partialsDir, { recursive: true });
    await mkdir(expectedDir, { recursive: true });
    await writeFile(templatePath, options.renderedOutput, "utf8");
    await writeFile(path.join(expectedDir, "blade.instructions.md"), options.renderedOutput, "utf8");
  }

  const managedFiles = options.managedFiles ?? ["AGENTS.md", "CLAUDE.md"];
  const managedFileLines = managedFiles.flatMap((managedFile) =>
    options.markerMode === "none"
      ? [`      - path: ${managedFile}`, "        marker: none"]
      : [`      - ${managedFile}`],
  );
  const manifest = [
    "surface_id: sample-global",
    `status: ${options.status ?? "active"}`,
    "owner: polli-labs",
    "description: Reconcile fixture surface.",
    "source_ref:",
    `  fleet_path: ${path.join(fixtureRoot(), "inputs", "fleet.v1.yaml")}`,
    `  hosts_dir: ${path.join(fixtureRoot(), "inputs", "hosts")}`,
    `  template_path: ${templatePath}`,
    `  partials_dir: ${partialsDir}`,
    `  expected_dir: ${expectedDir}`,
    "target_bindings:",
    "  - binding_id: managed-directory",
    `    class: ${options.bindingClass ?? "directory_root"}`,
    `    path: ${targetRoot}`,
    "    managed_files:",
    ...managedFileLines,
    "    selectors:",
    "      hosts: [blade]",
    "",
  ].join("\n");
  await writeFile(path.join(surfacesDir, "sample-global.yaml"), manifest, "utf8");

  for (const [filename, contents] of Object.entries(options.targetFiles ?? {})) {
    await writeFile(path.join(targetRoot, filename), contents, "utf8");
  }

  return { root, surfacesDir, targetRoot };
}

function expectedBladeOutput(): Promise<string> {
  return readFile(path.join(fixtureRoot(), "expected", "blade.instructions.md"), "utf8");
}

function wrapManagedInstruction(body: string, overrides: { surfaceId?: string; bindingId?: string } = {}): string {
  return [
    "---",
    YAML.stringify({
      calyx: {
        managed_by: "instructions",
        surface_id: overrides.surfaceId ?? "sample-global",
        binding_id: overrides.bindingId ?? "managed-directory",
      },
    }).trimEnd(),
    "---",
    body,
  ].join("\n");
}

describe("instruction surfaces", () => {
  test("lists active surfaces by default", async () => {
    const result = await listInstructionSurfaces(path.join(fixtureRoot(), "surfaces"));
    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.surfaceId)).toEqual(["sample-global"]);
  });

  test("includes archived surfaces when requested", async () => {
    const result = await listInstructionSurfaces(path.join(fixtureRoot(), "surfaces"), {
      includeArchived: true,
    });
    expect(result.items.map((item) => item.surfaceId)).toEqual(["archived-legacy", "sample-global"]);
  });

  test("shows resolved source refs and target bindings", async () => {
    const result = await showInstructionSurface(path.join(fixtureRoot(), "surfaces"), "sample-global");
    expect(result.surfaceId).toBe("sample-global");
    expect(result.sourceRef.expectedDir).toBe(path.join(fixtureRoot(), "expected"));
    expect(result.targetBindings.map((binding) => binding.bindingId)).toEqual(["expected-preview", "dev-directory"]);
    expect(result.targetBindings[0]?.path).toBe(path.join(fixtureRoot(), "expected"));
  });

  test("lists targets across surfaces", async () => {
    const result = await listInstructionTargets(path.join(fixtureRoot(), "surfaces"));
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.bindingId)).toEqual(["expected-preview", "dev-directory"]);
  });

  test("explains when a requested surface exists but is archived", async () => {
    await expect(
      listInstructionTargets(path.join(fixtureRoot(), "surfaces"), {
        surfaceId: "archived-legacy",
      }),
    ).rejects.toThrow('Instruction surface "archived-legacy" is archived');
  });

  test("renders a named surface through the existing engine", async () => {
    const result = await renderInstructionSurface(path.join(fixtureRoot(), "surfaces"), "sample-global", {
      host: "blade",
    });
    expect(result.surfaceId).toBe("sample-global");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.output).toContain("Host alias is blade");
  });

  test("verifies a named surface using expected_dir from the surface manifest", async () => {
    const result = await verifyInstructionSurface(path.join(fixtureRoot(), "surfaces"), "sample-global", {
      all: true,
    });
    expect(result.expectedDir).toBe(path.join(fixtureRoot(), "expected"));
    expect(result.ok).toBe(true);
    expect(result.drifts).toEqual([]);
  });

  test("rejects duplicate surface ids in a surfaces directory", async () => {
    const sampleManifest = await readFile(path.join(fixtureRoot(), "surfaces", "sample-global.yaml"), "utf8");
    const surfacesDir = await createTempSurfacesDir({
      "alpha.yaml": sampleManifest,
      "beta.yaml": sampleManifest.replace("sample-global", "duplicate-surface"),
      "gamma.yaml": sampleManifest.replace("sample-global", "duplicate-surface"),
    });

    try {
      await expect(listInstructionSurfaces(surfacesDir, { includeArchived: true })).rejects.toThrow(
        'Duplicate surface_id "duplicate-surface"',
      );
    } finally {
      await rm(surfacesDir, { recursive: true, force: true });
    }
  });

  test("rejects nested surfaces directories instead of silently skipping them", async () => {
    const sampleManifest = await readFile(path.join(fixtureRoot(), "surfaces", "sample-global.yaml"), "utf8");
    const surfacesDir = await createTempSurfacesDir({
      "sample-global.yaml": sampleManifest,
      "nested/archived-legacy.yaml": sampleManifest.replace("sample-global", "nested-surface"),
    });

    try {
      await expect(listInstructionSurfaces(surfacesDir, { includeArchived: true })).rejects.toThrow(
        "must be flat. Nested directories are not supported",
      );
    } finally {
      await rm(surfacesDir, { recursive: true, force: true });
    }
  });

  test("reconcile classifies unmanaged matching files without a compatibility bridge", async () => {
    const expectedOutput = await expectedBladeOutput();
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": expectedOutput,
        "CLAUDE.md": expectedOutput,
      },
    });

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.totalTargets).toBe(2);
      expect(result.summary.findings).toBe(2);
      expect(result.summary.byStatus.unmanaged_match).toBe(2);
      expect(result.findings.every((finding) => finding.status === "unmanaged_match")).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile classifies unmanaged matching files with frontmatter as unmanaged_match", async () => {
    const expectedOutput = [
      "---",
      'title: "Repo Guide"',
      'doc_type: "agents"',
      "---",
      "",
      "# Hello",
      "",
      "Frontmatter-bearing content.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": expectedOutput,
        "CLAUDE.md": expectedOutput,
      },
    });
    await writeFile(
      path.join(fixture.surfacesDir, "sample-global.yaml"),
      [
        "surface_id: sample-global",
        "status: active",
        "owner: polli-labs",
        "description: Reconcile fixture surface.",
        "source_ref:",
        `  fleet_path: ${path.join(fixtureRoot(), "inputs", "fleet.v1.yaml")}`,
        `  hosts_dir: ${path.join(fixtureRoot(), "inputs", "hosts")}`,
        `  template_path: ${path.join(fixture.root, "templates", "AGENTS.frontmatter.md")}`,
        `  partials_dir: ${path.join(fixtureRoot(), "templates", "partials")}`,
        "target_bindings:",
        "  - binding_id: managed-directory",
        "    class: directory_root",
        `    path: ${fixture.targetRoot}`,
        "    managed_files:",
        "      - AGENTS.md",
        "      - CLAUDE.md",
        "    selectors:",
        "      hosts: [blade]",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(fixture.root, "templates"), { recursive: true });
    await writeFile(path.join(fixture.root, "templates", "AGENTS.frontmatter.md"), expectedOutput, "utf8");

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.findings).toBe(2);
      expect(result.summary.byStatus.unmanaged_match).toBe(2);
      expect(result.findings.every((finding) => finding.status === "unmanaged_match")).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile reports managed_ok when markers and content match current ownership", async () => {
    const expectedOutput = await expectedBladeOutput();
    const managedDocument = wrapManagedInstruction(expectedOutput);
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": managedDocument,
        "CLAUDE.md": managedDocument,
      },
    });

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.totalTargets).toBe(2);
      expect(result.summary.findings).toBe(0);
      expect(result.summary.okTargets).toBe(2);
      expect(result.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile reports managed_drift for legacy double-frontmatter managed files and apply rewrites them", async () => {
    const renderedOutput = [
      "---",
      "title: Managed Surface",
      "doc_type: agents",
      "---",
      "",
      "# Managed Surface",
      "",
      "Hello from a rendered guide.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({
      renderedOutput,
      targetFiles: {
        "AGENTS.md": wrapManagedInstruction(renderedOutput),
        "CLAUDE.md": wrapManagedInstruction(renderedOutput),
      },
    });

    try {
      const reconcileBefore = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcileBefore.summary.byStatus.managed_drift).toBe(2);
      expect(
        reconcileBefore.findings.every((finding) => finding.reason === "marker_document_shape_mismatch"),
      ).toBe(true);

      const applyResult = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(applyResult.summary.byAction.update_managed).toBe(2);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).not.toContain("\n---\n---\n");

      const reconcileAfter = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcileAfter.summary.findings).toBe(0);
      expect(reconcileAfter.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile reports missing_expected when target roots are absent", async () => {
    const fixture = await createTempReconcileFixture({ createTargetRoot: false });

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.findings).toBe(2);
      expect(result.summary.byStatus.missing_expected).toBe(2);
      expect(result.findings.map((finding) => finding.reason)).toEqual(["target_root_missing", "target_root_missing"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile reports ownership_conflict when markers point at a different surface", async () => {
    const expectedOutput = await expectedBladeOutput();
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": wrapManagedInstruction(expectedOutput, { surfaceId: "legacy-surface" }),
        "CLAUDE.md": wrapManagedInstruction(expectedOutput, { surfaceId: "legacy-surface" }),
      },
    });

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.findings).toBe(2);
      expect(result.summary.byStatus.ownership_conflict).toBe(2);
      expect(result.findings.every((finding) => finding.reason === "marker_surface_mismatch")).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconcile reports archived_managed_present for archived surfaces with live targets", async () => {
    const expectedOutput = await expectedBladeOutput();
    const fixture = await createTempReconcileFixture({
      status: "archived",
      targetFiles: {
        "AGENTS.md": expectedOutput,
      },
    });

    try {
      const result = await reconcileInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        surfaceId: "sample-global",
        includeArchived: true,
      });
      expect(result.summary.totalTargets).toBe(1);
      expect(result.summary.findings).toBe(1);
      expect(result.summary.byStatus.archived_managed_present).toBe(1);
      expect(result.findings[0]?.managedFile).toBe("AGENTS.md");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply writes missing declared local targets with managed markers", async () => {
    const fixture = await createTempReconcileFixture();

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.changedTargets).toBe(2);
      expect(result.summary.blockedTargets).toBe(0);
      expect(result.summary.byAction.write_missing).toBe(2);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");
      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply honors repoRoot overrides for repo_root bindings", async () => {
    const fixture = await createTempReconcileFixture({
      bindingClass: "repo_root",
      createTargetRoot: false,
    });
    const overrideRoot = path.join(fixture.root, "worktree-root");
    await mkdir(overrideRoot, { recursive: true });

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        repoRoot: overrideRoot,
      });
      expect(result.summary.changedTargets).toBe(2);
      expect(result.summary.blockedTargets).toBe(0);

      const agentsText = await readFile(path.join(overrideRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");

      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        repoRoot: overrideRoot,
      });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply manages host_home targets and per-file static sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-instruction-host-home-"));
    const surfacesDir = path.join(root, "surfaces");
    const sourceDir = path.join(root, "sources");
    const targetRoot = path.join(root, "home", ".codex");
    await mkdir(surfacesDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(sourceDir, "config.toml"), "model = \"gpt-5.4\"\n", "utf8");
    await writeFile(
      path.join(surfacesDir, "codex-config.yaml"),
      [
        "surface_id: codex-config",
        "status: active",
        "owner: polli-labs",
        "description: Codex config fixture.",
        "source_ref:",
        `  fleet_path: ${path.join(fixtureRoot(), "inputs", "fleet.v1.yaml")}`,
        `  hosts_dir: ${path.join(fixtureRoot(), "inputs", "hosts")}`,
        `  template_path: ${path.join(fixtureRoot(), "templates", "AGENTS.sample.md.mustache")}`,
        `  partials_dir: ${path.join(fixtureRoot(), "templates", "partials")}`,
        "target_bindings:",
        "  - binding_id: codex-home",
        "    class: host_home",
        `    path: ${targetRoot}`,
        "    managed_files:",
        "      - path: config.toml",
        "        source_path: ../sources/config.toml",
        "        marker: none",
        "    selectors:",
        "      hosts: [blade]",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = await applyInstructionSurfaces(surfacesDir, { host: "blade" });
      expect(result.summary.changedTargets).toBe(1);
      expect(result.summary.byAction.write_missing).toBe(1);

      const text = await readFile(path.join(targetRoot, "config.toml"), "utf8");
      expect(text).toBe('model = "gpt-5.4"\n');

      const reconcile = await reconcileInstructionSurfaces(surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("raw managed frontmatter-bearing targets keep reconcile idempotent across NOW_ISO", async () => {
    const renderedOutput = [
      "---",
      'last_modified: "{{NOW_ISO}}"',
      "---",
      "",
      "# Hot guide",
      "",
      "Rendered at {{NOW_ISO}}.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({
      renderedOutput,
      managedFiles: ["AGENTS.md"],
      markerMode: "none",
    });

    try {
      const firstApply = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(firstApply.summary.changedTargets).toBe(1);

      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(1);

      const secondApply = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(secondApply.summary.changedTargets).toBe(0);
      expect(secondApply.summary.unchangedTargets).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("raw managed targets prefer live rendered_at over authored last_modified", async () => {
    const renderedOutput = [
      "---",
      'last_modified: "2026-07-21T00:00:00Z"',
      'rendered_at: "{{NOW_ISO}}"',
      "---",
      "",
      "# Hot guide",
      "",
      "Rendered at {{NOW_ISO}}.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({
      renderedOutput,
      managedFiles: ["AGENTS.md"],
      markerMode: "none",
    });

    try {
      const firstApply = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(firstApply.summary.changedTargets).toBe(1);

      const liveText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      const renderedAt = liveText.match(/^rendered_at: "(.+)"$/m)?.[1];
      expect(renderedAt).toBeDefined();
      expect(renderedAt).not.toBe("2026-07-21T00:00:00Z");
      expect(liveText).toContain(`Rendered at ${renderedAt}.`);

      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(1);

      const secondApply = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(secondApply.summary.changedTargets).toBe(0);
      expect(secondApply.summary.unchangedTargets).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("malformed or missing rendered_at falls back without hiding managed drift", async () => {
    const renderedOutput = [
      "---",
      'last_modified: "2026-07-21T00:00:00Z"',
      'rendered_at: "{{NOW_ISO}}"',
      "---",
      "",
      "# Hot guide",
      "",
      "Stable body.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({
      renderedOutput,
      managedFiles: ["AGENTS.md"],
      markerMode: "none",
    });

    try {
      await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      const targetPath = path.join(fixture.targetRoot, "AGENTS.md");
      const liveText = await readFile(targetPath, "utf8");

      for (const driftedText of [
        liveText.replace(/^rendered_at: .+$/m, 'rendered_at: "not-a-timestamp"'),
        liveText.replace(/^rendered_at: .+\n/m, ""),
        liveText.replace("Stable body.", "Body drifted."),
      ]) {
        await writeFile(targetPath, driftedText, "utf8");
        const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
        expect(reconcile.summary.findings).toBe(1);
        expect(reconcile.summary.byStatus.managed_drift).toBe(1);
        expect(reconcile.findings[0]?.reason).toBe("marker_content_mismatch");
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply updates already-managed targets whose content has drifted", async () => {
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": wrapManagedInstruction("# stale\n"),
        "CLAUDE.md": wrapManagedInstruction("# stale\n"),
      },
    });

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.changedTargets).toBe(2);
      expect(result.summary.byAction.update_managed).toBe(2);

      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply blocks instead of silently adopting unmanaged matching files", async () => {
    const expectedOutput = await expectedBladeOutput();
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": expectedOutput,
        "CLAUDE.md": expectedOutput,
      },
    });

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.changedTargets).toBe(0);
      expect(result.summary.blockedTargets).toBe(2);
      expect(result.blockedFindings.every((finding) => finding.status === "unmanaged_match")).toBe(true);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toBe(expectedOutput);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply dry-run plans reviewed overwrites for unmanaged divergent files without writing", async () => {
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": "# old live guide\n",
        "CLAUDE.md": "# old live guide\n",
      },
    });

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        dryRun: true,
        reviewedOverwrite: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.reviewedOverwrite).toBe(true);
      expect(result.summary.changedTargets).toBe(0);
      expect(result.summary.blockedTargets).toBe(0);
      expect(result.summary.byAction.reviewed_overwrite).toBe(2);
      expect(result.plannedChanges.map((change) => change.action)).toEqual([
        "reviewed_overwrite",
        "reviewed_overwrite",
      ]);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toBe("# old live guide\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply reviewed overwrite backs up unmanaged divergent files before managing them", async () => {
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": "# old live guide\n",
        "CLAUDE.md": "# old live guide\n",
      },
    });

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        reviewedOverwrite: true,
      });

      expect(result.summary.changedTargets).toBe(2);
      expect(result.summary.blockedTargets).toBe(0);
      expect(result.summary.byAction.reviewed_overwrite).toBe(2);
      expect(result.changes.every((change) => change.backupPath)).toBe(true);

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      expect(agentsText).toContain("managed_by: instructions");
      expect(agentsText).toContain("Host alias is blade");

      const agentsBackupPath = result.changes.find((change) => change.managedFile === "AGENTS.md")?.backupPath;
      expect(agentsBackupPath).toBeTruthy();
      await expect(readFile(agentsBackupPath ?? "", "utf8")).resolves.toBe("# old live guide\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply reviewed overwrite keeps repo_root backups out of the repo by default", async () => {
    const fixture = await createTempReconcileFixture({
      bindingClass: "repo_root",
      targetFiles: {
        "AGENTS.md": "# old repo guide\n",
        "CLAUDE.md": "# old repo guide\n",
      },
    });
    const backupRoot = path.join(fixture.root, "calyx-backups");
    const previousBackupRoot = process.env.CALYX_INSTRUCTION_BACKUP_DIR;
    process.env.CALYX_INSTRUCTION_BACKUP_DIR = backupRoot;

    try {
      const result = await applyInstructionSurfaces(fixture.surfacesDir, {
        host: "blade",
        reviewedOverwrite: true,
      });

      expect(result.summary.byAction.reviewed_overwrite).toBe(2);
      expect(result.changes.every((change) => change.backupPath?.startsWith(backupRoot))).toBe(true);
      const repoRootEntries = await readdir(fixture.targetRoot);
      expect(repoRootEntries.filter((entry) => entry.includes(".calyx-backup-"))).toEqual([]);

      const agentsBackupPath = result.changes.find((change) => change.managedFile === "AGENTS.md")?.backupPath;
      expect(agentsBackupPath).toBeTruthy();
      await expect(readFile(agentsBackupPath ?? "", "utf8")).resolves.toBe("# old repo guide\n");
    } finally {
      if (previousBackupRoot === undefined) {
        delete process.env.CALYX_INSTRUCTION_BACKUP_DIR;
      } else {
        process.env.CALYX_INSTRUCTION_BACKUP_DIR = previousBackupRoot;
      }
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("adopt converts unmanaged matching files into managed targets", async () => {
    const expectedOutput = await expectedBladeOutput();
    const fixture = await createTempReconcileFixture({
      targetFiles: {
        "AGENTS.md": expectedOutput,
        "CLAUDE.md": expectedOutput,
      },
    });

    try {
      const result = await adoptInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(result.summary.changedTargets).toBe(2);
      expect(result.summary.blockedTargets).toBe(0);
      expect(result.summary.byAction.adopt_unmanaged).toBe(2);

      const reconcile = await reconcileInstructionSurfaces(fixture.surfacesDir, { host: "blade" });
      expect(reconcile.summary.findings).toBe(0);
      expect(reconcile.summary.byStatus.managed_ok).toBe(2);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("apply merges the Calyx marker into existing frontmatter instead of stacking a second YAML block", async () => {
    const renderedOutput = [
      "---",
      "title: Managed Surface",
      "doc_type: agents",
      "---",
      "",
      "# Managed Surface",
      "",
      "Hello from a rendered guide.",
      "",
    ].join("\n");
    const fixture = await createTempReconcileFixture({ renderedOutput });

    try {
      await applyInstructionSurfaces(fixture.surfacesDir, { host: "blade" });

      const agentsText = await readFile(path.join(fixture.targetRoot, "AGENTS.md"), "utf8");
      const frontmatterMatch = agentsText.match(/^---\n([\s\S]*?)\n---\n/);
      expect(frontmatterMatch?.[1]).toBeTruthy();
      expect(agentsText).not.toContain("\n---\n---\n");

      const parsedFrontmatter = YAML.parse(frontmatterMatch?.[1] ?? "");
      expect(parsedFrontmatter.title).toBe("Managed Surface");
      expect(parsedFrontmatter.doc_type).toBe("agents");
      expect(parsedFrontmatter.calyx.managed_by).toBe("instructions");
      expect(parsedFrontmatter.calyx.surface_id).toBe("sample-global");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
