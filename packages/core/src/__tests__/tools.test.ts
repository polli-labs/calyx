import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import { syncToolsRegistry } from "../tools";

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function renderAgentToolsConfig(version: string, tools: Array<Record<string, unknown>>): string {
  const renderedTools: Record<string, Record<string, unknown>> = {};
  for (const tool of tools) {
    const { name, ...rest } = tool;
    renderedTools[String(name)] = rest as Record<string, unknown>;
  }
  return `${JSON.stringify({ version, tools: renderedTools }, null, 2)}\n`;
}

async function listCalyxScratchPaths(root: string): Promise<string[]> {
  const matches: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    if (!(await pathExists(currentDir))) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.name.startsWith(".calyx-tool-stage-") || entry.name.startsWith(".calyx-tool-backup-")) {
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

async function createToolsSyncFixture(): Promise<{
  root: string;
  home: string;
  carbonHome: string;
  registryPath: string;
  tools: Array<Record<string, unknown>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-tools-sync-"));
  const home = path.join(root, "home");
  const carbonHome = path.join(root, "carbon-home");
  const registryPath = path.join(root, "fleet", "catalog", "tool-versions.json");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");
  const agentsLocalConfigPath = path.join(home, ".config", "polli", "agents.local.json");

  const tools = [
    {
      name: "calyx",
      version: "0.1.1",
      package: "@polli-labs/calyx"
    },
    {
      name: "cass",
      version: "v0.1.55"
    }
  ];

  await mkdir(path.dirname(registryPath), { recursive: true });
  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await mkdir(path.dirname(agentsLocalConfigPath), { recursive: true });

  await writeFile(
    registryPath,
    `${JSON.stringify({ version: "2026-04-18", tools }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify({ globals: { hot: "instructions/templates/global/AGENTS.global.hot.md.mustache", variants: [], legacy: [] } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    hostsPath,
    YAML.stringify({
      hosts: {
        blade: { home },
        carbon: { home: carbonHome }
      }
    }),
    "utf8"
  );
  await writeFile(agentsLocalConfigPath, `${JSON.stringify({ hostAlias: "blade" }, null, 2)}\n`, "utf8");

  return {
    root,
    home,
    carbonHome,
    registryPath,
    tools
  };
}

describe("syncToolsRegistry apply writer", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];

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

  test("apply writes the current host tool registry", async () => {
    const fixture = await createToolsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    const result = await syncToolsRegistry(fixture.registryPath, {
      apply: true
    });

    expect(result.target).toBe("host:blade");
    expect(result.actions).toEqual([
      { action: "sync", id: "calyx", details: "target=host:blade" },
      { action: "sync", id: "cass", details: "target=host:blade" }
    ]);

    const installedPath = path.join(fixture.home, ".config", "polli", "agent-tools.json");
    await expect(readFile(installedPath, "utf8")).resolves.toBe(
      renderAgentToolsConfig("2026-04-18", fixture.tools)
    );
  });

  test("apply is idempotent when the current host config already matches", async () => {
    const fixture = await createToolsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    await syncToolsRegistry(fixture.registryPath, {
      apply: true
    });

    const installedPath = path.join(fixture.home, ".config", "polli", "agent-tools.json");
    const before = await stat(installedPath);

    await new Promise((resolve) => setTimeout(resolve, 25));

    await syncToolsRegistry(fixture.registryPath, {
      apply: true
    });

    const after = await stat(installedPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  test("dry-run plans sync without writing the current host config", async () => {
    const fixture = await createToolsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    const result = await syncToolsRegistry(fixture.registryPath, {
      apply: false
    });

    expect(result.target).toBe("host:blade");
    expect(result.actions).toEqual([
      { action: "plan-sync", id: "calyx", details: "target=host:blade" },
      { action: "plan-sync", id: "cass", details: "target=host:blade" }
    ]);

    await expect(pathExists(path.join(fixture.home, ".config", "polli", "agent-tools.json"))).resolves.toBe(false);
  });

  test("apply rewrites the installed config when the registry removes a tool", async () => {
    const fixture = await createToolsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    const primaryTool = fixture.tools[0];
    if (!primaryTool) {
      throw new Error("Expected fixture to include at least one tool.");
    }

    await syncToolsRegistry(fixture.registryPath, {
      apply: true
    });

    await writeFile(
      fixture.registryPath,
      `${JSON.stringify({ version: "2026-04-18", tools: [primaryTool] }, null, 2)}\n`,
      "utf8"
    );

    await syncToolsRegistry(fixture.registryPath, {
      apply: true
    });

    const installedPath = path.join(fixture.home, ".config", "polli", "agent-tools.json");
    await expect(readFile(installedPath, "utf8")).resolves.toBe(
      renderAgentToolsConfig("2026-04-18", [primaryTool])
    );
  });

  test("apply cleans staged files when a target host home cannot be resolved", async () => {
    const fixture = await createToolsSyncFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    const hostsPath = path.join(fixture.root, "fleet", "truths", "hosts.yaml");
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: { home: fixture.home },
          carbon: {}
        }
      }),
      "utf8"
    );

    await expect(
      syncToolsRegistry(fixture.registryPath, {
        all: true,
        apply: true
      })
    ).rejects.toThrow('Unable to resolve home for tools sync target "carbon"');

    await expect(pathExists(path.join(fixture.home, ".config", "polli", "agent-tools.json"))).resolves.toBe(false);
    await expect(listCalyxScratchPaths(fixture.root)).resolves.toEqual([]);
  });
});
