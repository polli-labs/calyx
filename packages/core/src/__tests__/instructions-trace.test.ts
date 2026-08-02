import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import { applyInstructionSurfaces } from "../instructions-surfaces";
import { traceInstructionTarget, InstructionTraceLookupError } from "../instructions-trace";

async function createTraceFixture(): Promise<{
  root: string;
  home: string;
  bladeHome: string;
  surfacesDir: string;
  partialsDir: string;
  registryPath: string;
  hotTemplatePath: string;
  legacyTemplatePath: string;
  repoTemplatePath: string;
  managedTargetPath: string;
  claudeTargetPath: string;
  legacyStagedTargetPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-instructions-trace-"));
  const home = path.join(root, "home");
  const bladeHome = path.join(root, "fixture-home", "blade");
  const surfacesDir = path.join(root, "instructions", "surfaces");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const partialsDir = path.join(root, "instructions", "templates", "partials");
  const templateDir = path.join(root, "instructions", "templates", "global");
  const repoTemplatePath = path.join(root, "instructions", "templates", "surface", "AGENTS.surface.md.mustache");
  const fleetPath = path.join(root, "fleet", "manifests", "fleet.yaml");
  const hostPath = path.join(root, "fleet", "manifests", "hosts", "carbon.yaml");
  const bladeHostPath = path.join(root, "fleet", "manifests", "hosts", "blade.yaml");
  const wormHostPath = path.join(root, "fleet", "manifests", "hosts", "worm.yaml");
  const hostsTruthPath = path.join(root, "fleet", "truths", "hosts.yaml");
  const registryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const managedDir = path.join(root, "managed");
  const managedTargetPath = path.join(managedDir, "AGENTS.md");
  const claudeTargetPath = path.join(home, ".claude", "CLAUDE.md");
  const hotTemplatePath = path.join(templateDir, "AGENTS.global.hot.md.mustache");
  const legacyTemplatePath = path.join(templateDir, "AGENTS.global.md.mustache");
  const legacyStagedTargetPath = path.join(root, "generated", "staged", "carbon", "AGENTS.global.staged.md");

  await mkdir(surfacesDir, { recursive: true });
  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(partialsDir, { recursive: true });
  await mkdir(templateDir, { recursive: true });
  await mkdir(path.dirname(repoTemplatePath), { recursive: true });
  await mkdir(path.dirname(fleetPath), { recursive: true });
  await mkdir(path.dirname(hostPath), { recursive: true });
  await mkdir(path.dirname(hostsTruthPath), { recursive: true });
  await mkdir(bladeHome, { recursive: true });
  await mkdir(path.dirname(claudeTargetPath), { recursive: true });
  await mkdir(path.dirname(legacyStagedTargetPath), { recursive: true });
  await mkdir(managedDir, { recursive: true });

  await writeFile(
    skillsRegistryPath,
    `${JSON.stringify({
      version: "test",
      skills: [],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    registryPath,
    `${JSON.stringify({
      globals: {
        hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
        variants: [],
        legacy: ["instructions/templates/global/AGENTS.global.md.mustache"],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(hotTemplatePath, "Global hot surface.\n", "utf8");
  await writeFile(legacyTemplatePath, "Legacy start\n{{{HARNESS_SKILLS}}}\nRender host: {{RENDER_HOST}}\n", "utf8");
  await writeFile(path.join(partialsDir, "harness.codex-cli.skills.md.mustache"), "Harness skills block\n", "utf8");
  await writeFile(repoTemplatePath, "Hello {{HOST}} {{GREETING}} {{SUBJECT}}\n", "utf8");
  await writeFile(
    fleetPath,
    YAML.stringify({
      instructions: {
        context: {
          GREETING: "from-fleet",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    hostPath,
    YAML.stringify({
      user: "carbon",
      home,
      instructions: {
        context: {
          SUBJECT: "from-host",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    bladeHostPath,
    YAML.stringify({
      user: "caleb",
      home: bladeHome,
      instructions: {
        context: {
          SUBJECT: "blade-host",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    wormHostPath,
    YAML.stringify({
      user: "caleb",
      home: bladeHome,
      instructions: {
        context: {
          SUBJECT: "worm-host",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    hostsTruthPath,
    YAML.stringify({
      hosts: {
        blade: {
          home: bladeHome,
          ram_gb: 128,
          roles: ["compute"],
        },
        worm: {
          home: bladeHome,
          ram_gb: 64,
          roles: ["compute"],
        },
        carbon: {
          home,
          ram_gb: 64,
          roles: ["dev"],
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(surfacesDir, "sample-surface.yaml"),
    [
      "surface_id: sample-surface",
      "status: active",
      "owner: polli-labs",
      "description: Sample trace surface.",
      "source_ref:",
      `  fleet_path: ${fleetPath}`,
      `  hosts_dir: ${path.dirname(hostPath)}`,
      `  template_path: ${repoTemplatePath}`,
      `  partials_dir: ${partialsDir}`,
      "target_bindings:",
      "  - binding_id: managed-directory",
      "    class: directory_root",
      `    path: ${managedDir}`,
      "    managed_files:",
      "      - AGENTS.md",
      "    selectors:",
      "      hosts: [carbon]",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    root,
    home,
    bladeHome,
    surfacesDir,
    partialsDir,
    registryPath,
    hotTemplatePath,
    legacyTemplatePath,
    repoTemplatePath,
    managedTargetPath,
    claudeTargetPath,
    legacyStagedTargetPath,
  };
}

describe("traceInstructionTarget", () => {
  const originalHome = process.env["HOME"];
  const roots = new Set<string>();

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("traces a manifest-backed managed target", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await applyInstructionSurfaces(fixture.surfacesDir, {
      host: "carbon",
      surfaceId: "sample-surface",
    });

    const result = await traceInstructionTarget(fixture.managedTargetPath, {
      surfacesDir: fixture.surfacesDir,
      host: "carbon",
      includeVariables: true,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("surface_binding");
    expect(result.matches[0]?.status).toBe("matches_current_render");
    expect(result.matches[0]?.source).toMatchObject({
      surfaceId: "sample-surface",
      bindingId: "managed-directory",
    });
    expect(result.matches[0]?.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "GREETING", value: "from-fleet" }),
        expect.objectContaining({ name: "SUBJECT", value: "from-host" }),
        expect.objectContaining({ name: "HOST", value: "carbon" }),
      ]),
    );
  });

  test("traces the global hot template fanout target", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    await writeFile(fixture.claudeTargetPath, "Global hot surface.\n", "utf8");

    const result = await traceInstructionTarget("~/.claude/CLAUDE.md", {
      agentsInfraRoot: fixture.root,
      host: "carbon",
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("template_fanout");
    expect(result.matches[0]?.status).toBe("matches_current_render");
    expect(result.matches[0]?.source).toMatchObject({
      templateId: "global.hot",
      channel: "claude",
      fanoutTargetPath: fixture.claudeTargetPath,
    });
  });

  test("reverse-maps another host's fanout install path using hosts truth home paths", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    const result = await traceInstructionTarget(path.join(fixture.bladeHome, ".claude", "CLAUDE.md"), {
      agentsInfraRoot: fixture.root,
      host: "blade",
    });

    expect(result.target.host).toBe("blade");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("template_fanout");
    expect(result.matches[0]?.status).toBe("missing");
    expect(result.matches[0]?.source).toMatchObject({
      templateId: "global.hot",
      channel: "claude",
      fanoutTargetPath: path.join(fixture.bladeHome, ".claude", "CLAUDE.md"),
    });
  });

  test("collapses shared-path multi-host bindings into one match for the requested host", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await writeFile(
      path.join(fixture.surfacesDir, "shared-dev-root.yaml"),
      [
        "surface_id: shared-dev-root",
        "status: active",
        "owner: polli-labs",
        "description: Shared linux dev root.",
        "source_ref:",
        `  fleet_path: ${path.join(fixture.root, "fleet", "manifests", "fleet.yaml")}`,
        `  hosts_dir: ${path.join(fixture.root, "fleet", "manifests", "hosts")}`,
        `  template_path: ${fixture.repoTemplatePath}`,
        `  partials_dir: ${fixture.partialsDir}`,
        "target_bindings:",
        "  - binding_id: dev-root-linux",
        "    class: directory_root",
        `    path: ${path.join(fixture.bladeHome, "dev")}`,
        "    managed_files:",
        "      - AGENTS.md",
        "      - CLAUDE.md",
        "    selectors:",
        "      hosts: [blade, worm]",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await traceInstructionTarget(path.join(fixture.bladeHome, "dev", "AGENTS.md"), {
      surfacesDir: fixture.surfacesDir,
      agentsInfraRoot: fixture.root,
      host: "blade",
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("surface_binding");
    expect(result.matches[0]?.host).toBe("blade");
    expect(result.matches[0]?.source).toMatchObject({
      surfaceId: "shared-dev-root",
      bindingId: "dev-root-linux",
      targetBinding: expect.objectContaining({
        selectors: { hosts: ["blade", "worm"] },
      }),
    });
  });

  test("matches current render for legacy templates that use triple-brace tokens", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await writeFile(
      fixture.legacyStagedTargetPath,
      `Legacy start\nHarness skills block\n\nRender host: ${os.hostname()}\n`,
      "utf8",
    );

    const result = await traceInstructionTarget(fixture.legacyStagedTargetPath, {
      agentsInfraRoot: fixture.root,
      host: "carbon",
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("template_fanout");
    expect(result.matches[0]?.status).toBe("matches_current_render");
    expect(result.matches[0]?.source).toMatchObject({
      templateId: "global",
      channel: "agents",
      stagedTargetPath: fixture.legacyStagedTargetPath,
    });
  });

  test("guards against circular partial expansion", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await writeFile(fixture.hotTemplatePath, "{{> cycle-a}}\n", "utf8");
    await writeFile(path.join(fixture.partialsDir, "cycle-a.md.mustache"), "{{> cycle-b}}\n", "utf8");
    await writeFile(path.join(fixture.partialsDir, "cycle-b.md.mustache"), "{{> cycle-a}}\n", "utf8");

    await expect(
      traceInstructionTarget("~/.claude/CLAUDE.md", {
        agentsInfraRoot: fixture.root,
        host: "carbon",
      }),
    ).rejects.toThrow(/Circular partial include detected: cycle-a -> cycle-b -> cycle-a/);
  });

  test("reports malformed template registry JSON with file context", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await writeFile(fixture.registryPath, "{ not-valid-json\n", "utf8");

    await expect(
      traceInstructionTarget("~/.claude/CLAUDE.md", {
        agentsInfraRoot: fixture.root,
        host: "carbon",
      }),
    ).rejects.toThrow(new RegExp(`Failed to parse JSON at ${fixture.registryPath}`));
  });

  test("reports ambiguous ownership when a target matches both a surface and template fanout", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    await writeFile(fixture.claudeTargetPath, "Global hot surface.\n", "utf8");
    await writeFile(
      path.join(fixture.surfacesDir, "claude-surface.yaml"),
      [
        "surface_id: claude-surface",
        "status: active",
        "owner: polli-labs",
        "description: Surface that also owns ~/.claude/CLAUDE.md.",
        "source_ref:",
        `  fleet_path: ${path.join(fixture.root, "fleet", "manifests", "fleet.yaml")}`,
        `  hosts_dir: ${path.join(fixture.root, "fleet", "manifests", "hosts")}`,
        `  template_path: ${path.join(fixture.root, "instructions", "templates", "surface", "AGENTS.surface.md.mustache")}`,
        `  partials_dir: ${path.join(fixture.root, "instructions", "templates", "partials")}`,
        "target_bindings:",
        "  - binding_id: claude-home",
        "    class: directory_root",
        `    path: ${path.join(fixture.home, ".claude")}`,
        "    managed_files:",
        "      - CLAUDE.md",
        "    selectors:",
        "      hosts: [carbon]",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      traceInstructionTarget("~/.claude/CLAUDE.md", {
        surfacesDir: fixture.surfacesDir,
        agentsInfraRoot: fixture.root,
        host: "carbon",
      }),
    ).rejects.toMatchObject({
      code: "ambiguous_target",
      matches: expect.arrayContaining([
        expect.stringContaining("surface:claude-surface"),
        expect.stringContaining("template:global.hot:fanout:claude"),
      ]),
    } satisfies Partial<InstructionTraceLookupError>);
  });

  test("reports unmanaged targets with suggestions when no source matches", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await expect(
      traceInstructionTarget(path.join(fixture.root, "random", "CLAUDE.md"), {
        surfacesDir: fixture.surfacesDir,
        agentsInfraRoot: fixture.root,
        host: "carbon",
      }),
    ).rejects.toMatchObject({
      code: "unmanaged_target",
      suggestions: expect.arrayContaining([fixture.claudeTargetPath]),
    } satisfies Partial<InstructionTraceLookupError>);
  });
});
