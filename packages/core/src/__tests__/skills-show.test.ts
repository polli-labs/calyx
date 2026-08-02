import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import { showSkill, SkillShowLookupError } from "../skills-show";

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
    "",
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
    "",
  ].join("\n");
}

async function createSkillFixture(): Promise<{
  root: string;
  home: string;
  registryPath: string;
  rawSkillText: string;
  body: string;
  title: string;
  description: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-skills-show-"));
  const home = path.join(root, "home");
  const skillDir = path.join(root, "instructions", "skills", "fieldwork-conventions");
  const registryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");
  const skillPath = path.join(skillDir, "SKILL.md");
  const refPath = path.join(skillDir, "references", "style.md");

  const rawSkillText = [
    "---",
    "title: Fieldwork conventions",
    "description: Shared fieldwork conventions",
    "---",
    "",
    "# Fieldwork",
    "",
    "Use the vault as the canonical artifact store.",
    "",
  ].join("\n");
  const body = [
    "# Fieldwork",
    "",
    "Use the vault as the canonical artifact store.",
    "",
  ].join("\n");

  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.dirname(refPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await writeFile(skillPath, rawSkillText, "utf8");
  await writeFile(refPath, "Reference file.\n", "utf8");
  await writeFile(
    registryPath,
    `${JSON.stringify({
      version: "test",
      skills: [
        {
          id: "fieldwork-conventions",
          status: "active",
          source: {
            type: "internal",
            path: "instructions/skills/fieldwork-conventions",
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
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
        carbon: {
          home,
        },
      },
    }),
    "utf8",
  );

  return {
    root,
    home,
    registryPath,
    rawSkillText,
    body,
    title: "Fieldwork conventions",
    description: "Shared fieldwork conventions",
  };
}

describe("showSkill", () => {
  const originalHome = process.env["HOME"];
  const originalCodexHome = process.env["CODEX_HOME"];
  const roots = new Set<string>();

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

  test("returns resolved source and matching local install state", async () => {
    const fixture = await createSkillFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const agentsDir = path.join(fixture.home, ".agents", "skills", "fieldwork-conventions");
    const claudeDir = path.join(fixture.home, ".claude", "skills", normalizeName("fieldwork-conventions"));
    const codexDir = path.join(fixture.home, ".codex", "skills", "polli", "fieldwork-conventions");
    for (const dir of [agentsDir, claudeDir, codexDir]) {
      await mkdir(path.join(dir, "references"), { recursive: true });
      await writeFile(path.join(dir, "references", "style.md"), "Reference file.\n", "utf8");
    }
    await writeFile(path.join(agentsDir, "SKILL.md"), `${fixture.rawSkillText.replace(/\s+$/, "")}\n`, "utf8");
    await writeFile(
      path.join(claudeDir, "SKILL.md"),
      renderClaudeSkill(normalizeName("fieldwork-conventions"), fixture.description, fixture.body),
      "utf8",
    );
    await writeFile(
      path.join(codexDir, "SKILL.md"),
      renderCodexSkill("fieldwork-conventions", fixture.title, fixture.description, fixture.body),
      "utf8",
    );

    const result = await showSkill("fieldwork-conventions", {
      registryPath: fixture.registryPath,
      agentsInfraRoot: fixture.root,
      showInstallHashes: true,
    });

    expect(result.source.available).toBe(true);
    expect(result.source.provenance_class).toBe("repo-managed");
    expect(result.source.resolvedSkillPath).toContain("instructions/skills/fieldwork-conventions/SKILL.md");
    expect(result.localInstallations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ backend: "agents", state: "matches_expected", present: true }),
        expect.objectContaining({ backend: "claude", present: true }),
        expect.objectContaining({ backend: "codex", present: true }),
      ]),
    );
    expect(result.validation.ok).toBe(true);
    expect(result.validation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "registry_entry", status: "ok" }),
        expect.objectContaining({ id: "source_exists", status: "ok" }),
      ]),
    );
    expect(result.fleetInstallations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "carbon",
          backend: "agents",
          expectedPath: path.join(fixture.home, ".agents", "skills", "fieldwork-conventions"),
        }),
      ]),
    );
  });

  test("suggests nearby skill ids on lookup miss", async () => {
    const fixture = await createSkillFixture();
    roots.add(fixture.root);

    await expect(
      showSkill("fieldwork", {
        registryPath: fixture.registryPath,
        agentsInfraRoot: fixture.root,
      }),
    ).rejects.toMatchObject({
      code: "skill_not_found",
      suggestions: ["fieldwork-conventions"],
    } satisfies Partial<SkillShowLookupError>);
  });
});
