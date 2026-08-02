import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import { deriveProvenanceClass, syncSkillsRegistry } from "../skills";

function normalizeName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 64) : "skill";
}

function renderClaudeSkill(name: string, description: string, body: string): string {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    body.replace(/\s+$/, ""),
    ""
  ].join("\n");
}

function renderCodexSkill(skillId: string, title: string, description: string, body: string): string {
  return [
    "---",
    `name: ${JSON.stringify(skillId)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.replace(/\s+$/, ""),
    ""
  ].join("\n");
}

function extractBody(rawText: string): string {
  return rawText.startsWith("---")
    ? rawText.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "")
    : rawText;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createSkillsSyncFixture(options: {
  skillId?: string;
  status?: "active" | "deprecated" | "retired";
  deprecated?: boolean;
} = {}): Promise<{
  root: string;
  home: string;
  registryPath: string;
  skillId: string;
  title: string;
  description: string;
  body: string;
  rawSkillText: string;
  refContent: string;
}> {
  const skillId = options.skillId ?? "fieldwork-conventions";
  const title = "Fieldwork conventions";
  const description = "Shared fieldwork conventions";
  const body = [
    "# Fieldwork",
    "",
    "Use the vault as the canonical artifact store.",
    ""
  ].join("\n");
  const rawSkillText = [
    "---",
    "title: Fieldwork conventions",
    "description: Shared fieldwork conventions",
    "---",
    "",
    body
  ].join("\n");
  const refContent = "Reference file.\n";

  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-skills-sync-"));
  const home = path.join(root, "home");
  const skillDir = path.join(root, "instructions", "skills", skillId);
  const registryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");
  const skillPath = path.join(skillDir, "SKILL.md");
  const refPath = path.join(skillDir, "references", "style.md");

  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(refPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });

  await writeFile(skillPath, rawSkillText, "utf8");
  await writeFile(refPath, refContent, "utf8");
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: "test",
        skills: [
          {
            id: skillId,
            ...(options.status ? { status: options.status } : {}),
            ...(options.deprecated ? { deprecated: true } : {}),
            ...(options.status === "retired" ? { retired_at: "2026-05-09" } : {}),
            ...(options.status === "deprecated" || options.deprecated ? { deprecated_by: "fieldwork" } : {}),
            source: {
              type: "internal",
              path: `instructions/skills/${skillId}`
            }
          },
          ...(options.status === "deprecated" || options.deprecated
            ? [
                {
                  id: "fieldwork",
                  status: "active",
                  source: {
                    type: "internal",
                    path: "instructions/skills/fieldwork-conventions"
                  }
                }
              ]
            : [])
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify(
      {
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: []
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    hostsPath,
    YAML.stringify({
      hosts: {
        blade: {
          home
        }
      }
    }),
    "utf8"
  );

  return {
    root,
    home,
    registryPath,
    skillId,
    title,
    description,
    body,
    rawSkillText,
    refContent
  };
}

function installPaths(home: string, skillId: string): Record<"agents" | "claude" | "codex", string> {
  return {
    agents: path.join(home, ".agents", "skills", skillId),
    claude: path.join(home, ".claude", "skills", normalizeName(skillId)),
    codex: path.join(home, ".codex", "skills", "polli", skillId)
  };
}

function nestedDeprecatedAgentsInstallPath(home: string, skillId: string): string {
  return path.join(home, ".agents", "skills", "_deprecated", skillId);
}

async function listCalyxScratchDirs(root: string): Promise<string[]> {
  const matches: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (!(await pathExists(currentDir))) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.name.startsWith(".calyx-skill-stage-") || entry.name.startsWith(".calyx-skill-backup-")) {
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

describe("syncSkillsRegistry apply writer", () => {
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

  test("apply writes all backend skills to agents and claude while codex aliases agents by default", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    expect(result.actions).toEqual([
      {
        action: "sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      }
    ]);

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(readFile(path.join(installs.agents, "SKILL.md"), "utf8")).resolves.toBe(
      `${fixture.rawSkillText.replace(/\s+$/, "")}\n`
    );
    await expect(readFile(path.join(installs.claude, "SKILL.md"), "utf8")).resolves.toBe(
      renderClaudeSkill(normalizeName(fixture.skillId), fixture.description, extractBody(fixture.rawSkillText))
    );
    await expect(readFile(path.join(installs.agents, "references", "style.md"), "utf8")).resolves.toBe(fixture.refContent);
    await expect(readFile(path.join(installs.claude, "references", "style.md"), "utf8")).resolves.toBe(fixture.refContent);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
  });

  test("native codex mode writes the independent codex skill namespace", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true,
      codexMode: "native"
    });

    expect(result.actions).toEqual([
      {
        action: "sync",
        id: fixture.skillId,
        details: "backend=all"
      }
    ]);

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(readFile(path.join(installs.codex, "SKILL.md"), "utf8")).resolves.toBe(
      renderCodexSkill(fixture.skillId, fixture.title, fixture.description, extractBody(fixture.rawSkillText))
    );
    await expect(readFile(path.join(installs.codex, "references", "style.md"), "utf8")).resolves.toBe(fixture.refContent);
  });

  test("direct codex backend sync aliases to the agents install tree by default", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "codex",
      apply: true
    });

    expect(result.actions).toEqual([
      {
        action: "sync",
        id: fixture.skillId,
        details: "backend=codex(alias=agents)"
      }
    ]);

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(pathExists(installs.agents)).resolves.toBe(true);
    await expect(pathExists(installs.claude)).resolves.toBe(false);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
  });

  test("apply is idempotent when install trees already match expected content", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    const installs = installPaths(fixture.home, fixture.skillId);
    await writeFile(path.join(installs.claude, ".consumer-meta"), "keep me\n", "utf8");
    const before = await Promise.all([
      stat(path.join(installs.agents, "SKILL.md")),
      stat(path.join(installs.claude, "SKILL.md"))
    ]);

    await new Promise((resolve) => setTimeout(resolve, 25));

    await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    const after = await Promise.all([
      stat(path.join(installs.agents, "SKILL.md")),
      stat(path.join(installs.claude, "SKILL.md"))
    ]);

    expect(after.map((item) => item.mtimeMs)).toEqual(before.map((item) => item.mtimeMs));
    expect(after.map((item) => item.ino)).toEqual(before.map((item) => item.ino));
    await expect(readFile(path.join(installs.claude, ".consumer-meta"), "utf8")).resolves.toBe("keep me\n");
  });

  test("dry-run plans sync actions without writing install trees", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false
    });

    expect(result.actions).toEqual([
      {
        action: "plan-sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      }
    ]);

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(pathExists(installs.agents)).resolves.toBe(false);
    await expect(pathExists(installs.claude)).resolves.toBe(false);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
  });

  test("dry-run marks unresolved repo-backed skills as skipped and continues planning internal skills", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8")) as {
      version: string;
      skills: Array<Record<string, unknown>>;
    };
    registry.skills.push({
      id: "visual-explainer",
      status: "active",
      source: {
        type: "external",
        repo: "https://github.com/example/visual-explainer",
        path: "skills/visual-explainer"
      }
    });
    registry.skills.push({
      id: "polli-monorepo",
      status: "active",
      source: {
        type: "repo-maintained",
        repo: "polli-labs/polli",
        path: "skills/polli-monorepo/SKILL.md"
      }
    });
    await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false
    });

    expect(result.actions).toEqual([
      {
        action: "plan-sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      },
      {
        action: "plan-skip",
        id: "visual-explainer",
        details: "unresolvable source type=external"
      },
      {
        action: "plan-skip",
        id: "polli-monorepo",
        details: "unresolvable source type=repo-maintained"
      }
    ]);
  });

  test("apply skips unresolved repo-backed skills without aborting internal installs", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8")) as {
      version: string;
      skills: Array<Record<string, unknown>>;
    };
    registry.skills.push({
      id: "visual-explainer",
      status: "active",
      source: {
        type: "external",
        repo: "https://github.com/example/visual-explainer",
        path: "skills/visual-explainer"
      }
    });
    registry.skills.push({
      id: "polli-monorepo",
      status: "active",
      source: {
        type: "repo-maintained",
        repo: "polli-labs/polli",
        path: "skills/polli-monorepo/SKILL.md"
      }
    });
    await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true
    });

    expect(result.actions).toEqual([
      {
        action: "sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      },
      {
        action: "skip",
        id: "visual-explainer",
        details: "unresolvable source type=external"
      },
      {
        action: "skip",
        id: "polli-monorepo",
        details: "unresolvable source type=repo-maintained"
      }
    ]);

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(pathExists(installs.agents)).resolves.toBe(true);
    await expect(pathExists(installs.claude)).resolves.toBe(true);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
    await expect(pathExists(path.join(fixture.home, ".agents", "skills", "visual-explainer"))).resolves.toBe(false);
  });

  test("apply prune leaves native codex tree untouched when codex aliases agents by default", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "legacy-skill",
      deprecated: true
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const installs = installPaths(fixture.home, fixture.skillId);
    for (const installDir of Object.values(installs)) {
      await mkdir(path.join(installDir, "references"), { recursive: true });
      await writeFile(path.join(installDir, "SKILL.md"), "stale\n", "utf8");
      await writeFile(path.join(installDir, "references", "style.md"), "stale\n", "utf8");
    }

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true,
      pruneDeprecated: true,
      includeActive: false
    });

    expect(result.actions).toEqual([
      {
        action: "prune",
        id: fixture.skillId,
        details: "deprecated skill"
      }
    ]);

    await expect(pathExists(installs.agents)).resolves.toBe(false);
    await expect(pathExists(installs.claude)).resolves.toBe(false);
    await expect(pathExists(installs.codex)).resolves.toBe(true);
  });

  test("native codex mode prune removes independent codex deprecated install trees", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "legacy-skill",
      deprecated: true
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const installs = installPaths(fixture.home, fixture.skillId);
    for (const installDir of Object.values(installs)) {
      await mkdir(path.join(installDir, "references"), { recursive: true });
      await writeFile(path.join(installDir, "SKILL.md"), "stale\n", "utf8");
      await writeFile(path.join(installDir, "references", "style.md"), "stale\n", "utf8");
    }

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: true,
      pruneDeprecated: true,
      includeActive: false,
      codexMode: "native"
    });

    expect(result.actions).toEqual([
      {
        action: "prune",
        id: fixture.skillId,
        details: "deprecated skill"
      }
    ]);

    await expect(pathExists(installs.agents)).resolves.toBe(false);
    await expect(pathExists(installs.claude)).resolves.toBe(false);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
  });

  test("apply prune removes legacy nested agents deprecated install trees when root install is absent", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "legacy-skill",
      deprecated: true
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const nestedInstallDir = nestedDeprecatedAgentsInstallPath(fixture.home, fixture.skillId);
    await mkdir(path.join(nestedInstallDir, "references"), { recursive: true });
    await writeFile(path.join(nestedInstallDir, "SKILL.md"), "stale\n", "utf8");
    await writeFile(path.join(nestedInstallDir, "references", "style.md"), "stale\n", "utf8");

    const sourceArchiveDir = path.join(fixture.root, "instructions", "skills", "_deprecated", fixture.skillId);
    await mkdir(sourceArchiveDir, { recursive: true });
    await writeFile(path.join(sourceArchiveDir, "SKILL.md"), "source archive\n", "utf8");
    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8")) as {
      version: string;
      skills: Array<{ source?: { path?: string } }>;
    };
    registry.skills[0]!.source!.path = `instructions/skills/_deprecated/${fixture.skillId}`;
    await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "agents",
      apply: true,
      pruneDeprecated: true,
      includeActive: false
    });

    expect(result.actions).toEqual([
      {
        action: "prune",
        id: fixture.skillId,
        details: "deprecated skill"
      }
    ]);

    await expect(pathExists(installPaths(fixture.home, fixture.skillId).agents)).resolves.toBe(false);
    await expect(pathExists(nestedInstallDir)).resolves.toBe(false);
    await expect(pathExists(path.dirname(nestedInstallDir))).resolves.toBe(false);
    await expect(readFile(path.join(sourceArchiveDir, "SKILL.md"), "utf8")).resolves.toBe("source archive\n");
  });

  test("apply prune removes retired legacy nested agents install trees by default", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "retired-skill",
      status: "retired"
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const nestedInstallDir = nestedDeprecatedAgentsInstallPath(fixture.home, fixture.skillId);
    await mkdir(path.join(nestedInstallDir, "references"), { recursive: true });
    await writeFile(path.join(nestedInstallDir, "SKILL.md"), "stale\n", "utf8");
    await writeFile(path.join(nestedInstallDir, "references", "style.md"), "stale\n", "utf8");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "agents",
      apply: true,
      pruneDeprecated: true,
      includeActive: false
    });

    expect(result.actions).toEqual([
      {
        action: "prune",
        id: fixture.skillId,
        details: "retired skill"
      }
    ]);

    await expect(pathExists(nestedInstallDir)).resolves.toBe(false);
    await expect(pathExists(path.dirname(nestedInstallDir))).resolves.toBe(false);
  });

  test("exclude-deprecated omits legacy deprecated skills from the plan", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8")) as {
      version: string;
      skills: Array<Record<string, unknown>>;
    };
    registry.skills.push({
      id: "vault-spec-to-execution",
      deprecated: true,
      deprecated_by: fixture.skillId,
      source: {
        type: "internal",
        path: "instructions/skills/_deprecated/vault-spec-to-execution"
      }
    });
    await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false,
      includeDeprecated: false
    });

    expect(result.actions).toEqual([
      {
        action: "plan-sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      }
    ]);
  });

  test("legacy deprecated skills still sync when no deprecation flags are set", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "legacy-skill",
      deprecated: true
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false
    });

    expect(result.actions).toEqual([
      {
        action: "plan-sync",
        id: fixture.skillId,
        details: "backend=all(codex=agents)"
      },
      {
        action: "plan-sync",
        id: "fieldwork",
        details: "backend=all(codex=agents)"
      }
    ]);
  });

  test("exclude-deprecated wins over prune-deprecated for legacy deprecated skills", async () => {
    const fixture = await createSkillsSyncFixture({
      skillId: "legacy-skill",
      deprecated: true
    });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const result = await syncSkillsRegistry(fixture.registryPath, {
      backend: "all",
      apply: false,
      includeDeprecated: false,
      pruneDeprecated: true
    });

    expect(result.actions).toEqual([
      {
        action: "plan-sync",
        id: "fieldwork",
        details: "backend=all(codex=agents)"
      }
    ]);
  });

  test("apply is atomic across registry items and cleans staged trees on failure", async () => {
    const fixture = await createSkillsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const registry = JSON.parse(await readFile(fixture.registryPath, "utf8")) as {
      version: string;
      skills: Array<Record<string, unknown>>;
    };
    registry.skills.push({
      id: "broken-skill",
      status: "active",
      source: {
        type: "internal",
        path: "instructions/skills/broken-skill"
      }
    });
    await writeFile(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

    await expect(
      syncSkillsRegistry(fixture.registryPath, {
        backend: "all",
        apply: true
      })
    ).rejects.toThrow('Unable to resolve source for skill "broken-skill"');

    const installs = installPaths(fixture.home, fixture.skillId);
    await expect(pathExists(installs.agents)).resolves.toBe(false);
    await expect(pathExists(installs.claude)).resolves.toBe(false);
    await expect(pathExists(installs.codex)).resolves.toBe(false);
    await expect(listCalyxScratchDirs(fixture.home)).resolves.toEqual([]);
  });
});

describe("deriveProvenanceClass (POL-1729)", () => {
  test("maps the three documented source types to their git regimes", () => {
    expect(deriveProvenanceClass({ type: "internal", path: "x/SKILL.md" })).toBe("repo-managed");
    expect(deriveProvenanceClass({ type: "external", path: "x/SKILL.md" })).toBe("vendored");
    expect(deriveProvenanceClass({ type: "repo-maintained", path: "x/SKILL.md" })).toBe("repo-maintained");
  });

  test("is case- and whitespace-insensitive on source.type", () => {
    expect(deriveProvenanceClass({ type: "  Internal ", path: "x/SKILL.md" })).toBe("repo-managed");
    expect(deriveProvenanceClass({ type: "EXTERNAL", path: "x/SKILL.md" })).toBe("vendored");
  });

  test("returns undefined for unknown/free-form types (surfaced as unclassified, not mis-bucketed)", () => {
    expect(deriveProvenanceClass({ type: "mystery", path: "x/SKILL.md" })).toBeUndefined();
    expect(deriveProvenanceClass({ type: "", path: "x/SKILL.md" })).toBeUndefined();
  });

  test("never returns the db-regime or installed-mirror classes (those are not derivable from source.type)", () => {
    const derivable = ["internal", "external", "repo-maintained"].map((type) =>
      deriveProvenanceClass({ type, path: "x/SKILL.md" }),
    );
    expect(derivable).not.toContain("agent-proposed");
    expect(derivable).not.toContain("local-manual");
    expect(derivable).not.toContain("installed-mirror");
  });
});
