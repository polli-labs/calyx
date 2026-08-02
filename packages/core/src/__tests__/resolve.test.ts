import path from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  resolveSourcePath,
  requireSourcePath,
  loadCalyxConfig,
  showConfig,
  ENV_VARS,
  CONFIG_ENV_VAR,
  SOURCE_MODE_ENV_VAR,
  POLLI_ROOT_ENV_VAR,
  DOCSTORE_ROOT_ENV_VAR,
  ADAPTER_CACHE_ENV_VAR
} from "../resolve";
import { AGENTS_INFRA_ROOT_ENV_VAR } from "../agents-infra";

function tempDir(): string {
  return path.join(tmpdir(), `calyx-test-${randomUUID()}`);
}

describe("resolveSourcePath", () => {
  test("returns cli source when cliValue is provided", async () => {
    const result = await resolveSourcePath("skills", { cliValue: "/explicit/path.json" });
    expect(result.path).toBe("/explicit/path.json");
    expect(result.source).toBe("cli");
  });

  test("cli value takes precedence over env var", async () => {
    const original = process.env[ENV_VARS.skills];
    process.env[ENV_VARS.skills] = "/env/path.json";
    try {
      const result = await resolveSourcePath("skills", { cliValue: "/cli/path.json" });
      expect(result.path).toBe("/cli/path.json");
      expect(result.source).toBe("cli");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.skills];
      } else {
        process.env[ENV_VARS.skills] = original;
      }
    }
  });

  test("returns env source when env var is set and no cli value", async () => {
    const original = process.env[ENV_VARS.tools];
    process.env[ENV_VARS.tools] = "/env/tools.json";
    try {
      const result = await resolveSourcePath("tools", {});
      expect(result.path).toBe("/env/tools.json");
      expect(result.source).toBe("env");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.tools];
      } else {
        process.env[ENV_VARS.tools] = original;
      }
    }
  });

  test("returns config source when config file contains domain path", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      registries: { prompts: "/config/prompts.json" }
    }));

    try {
      const result = await resolveSourcePath("prompts", { configPath });
      expect(result.path).toBe("/config/prompts.json");
      expect(result.source).toBe("config");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns config source for exec store domain", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      stores: { exec: "/config/exec.json" }
    }));

    try {
      const result = await resolveSourcePath("exec", { configPath });
      expect(result.path).toBe("/config/exec.json");
      expect(result.source).toBe("config");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns none when no source is available", async () => {
    // Ensure no env vars are set
    const originals: Record<string, string | undefined> = {};
    for (const [domain, envVar] of Object.entries(ENV_VARS)) {
      originals[domain] = process.env[envVar];
      delete process.env[envVar];
    }
    const origConfig = process.env[CONFIG_ENV_VAR];
    delete process.env[CONFIG_ENV_VAR];

    try {
      const result = await resolveSourcePath("agents", { configPath: "/nonexistent/config.json" });
      expect(result.path).toBeUndefined();
      expect(result.source).toBe("none");
    } finally {
      for (const [domain, envVar] of Object.entries(ENV_VARS)) {
        if (originals[domain] === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = originals[domain];
        }
      }
      if (origConfig === undefined) {
        delete process.env[CONFIG_ENV_VAR];
      } else {
        process.env[CONFIG_ENV_VAR] = origConfig;
      }
    }
  });

  test("expands ~ in cli value", async () => {
    const result = await resolveSourcePath("skills", { cliValue: "~/my-registry.json" });
    expect(result.path).not.toContain("~");
    expect(result.source).toBe("cli");
  });

  test("ignores empty cli value", async () => {
    const original = process.env[ENV_VARS.skills];
    process.env[ENV_VARS.skills] = "/env/skills.json";
    try {
      const result = await resolveSourcePath("skills", { cliValue: "" });
      expect(result.path).toBe("/env/skills.json");
      expect(result.source).toBe("env");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.skills];
      } else {
        process.env[ENV_VARS.skills] = original;
      }
    }
  });

  test("ignores whitespace-only env var", async () => {
    const original = process.env[ENV_VARS.skills];
    process.env[ENV_VARS.skills] = "   ";
    try {
      const result = await resolveSourcePath("skills", { configPath: "/nonexistent/config.json" });
      expect(result.source).toBe("none");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.skills];
      } else {
        process.env[ENV_VARS.skills] = original;
      }
    }
  });
});

describe("requireSourcePath", () => {
  test("returns resolved path when available", async () => {
    const result = await requireSourcePath("skills", { cliValue: "/explicit/path.json" });
    expect(result).toBe("/explicit/path.json");
  });

  test("throws descriptive error when no source found", async () => {
    const originals: Record<string, string | undefined> = {};
    for (const [, envVar] of Object.entries(ENV_VARS)) {
      originals[envVar] = process.env[envVar];
      delete process.env[envVar];
    }
    const sourceModeOriginal = process.env[SOURCE_MODE_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "explicit";

    try {
      await expect(
        requireSourcePath("knowledge", { configPath: "/nonexistent/config.json" })
      ).rejects.toThrow("No knowledge source path found");
    } finally {
      for (const [envVar, original] of Object.entries(originals)) {
        if (original === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = original;
        }
      }
      if (sourceModeOriginal === undefined) {
        delete process.env[SOURCE_MODE_ENV_VAR];
      } else {
        process.env[SOURCE_MODE_ENV_VAR] = sourceModeOriginal;
      }
    }
  });

  test("error message includes flag, env var, and config file hints", async () => {
    const originals: Record<string, string | undefined> = {};
    for (const [, envVar] of Object.entries(ENV_VARS)) {
      originals[envVar] = process.env[envVar];
      delete process.env[envVar];
    }
    const sourceModeOriginal = process.env[SOURCE_MODE_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "explicit";

    try {
      await expect(
        requireSourcePath("exec", { configPath: "/nonexistent/config.json" })
      ).rejects.toThrow("--store");
    } finally {
      for (const [envVar, original] of Object.entries(originals)) {
        if (original === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = original;
        }
      }
      if (sourceModeOriginal === undefined) {
        delete process.env[SOURCE_MODE_ENV_VAR];
      } else {
        process.env[SOURCE_MODE_ENV_VAR] = sourceModeOriginal;
      }
    }
  });

  test("adapter mode names the unset variable instead of guessing a Polli root", async () => {
    // A hardcoded default here is a machine-shaped literal read on whichever
    // host runs the process: on mac it can never exist, and on the host it was
    // written for it survived the repo it named. Either way the operator was
    // told a stranger's file was missing, not that nothing was configured.
    const originals = {
      sourceMode: process.env[SOURCE_MODE_ENV_VAR],
      polliRoot: process.env[POLLI_ROOT_ENV_VAR],
      skills: process.env[ENV_VARS.skills],
      configPath: process.env[CONFIG_ENV_VAR]
    };

    delete process.env[ENV_VARS.skills];
    delete process.env[CONFIG_ENV_VAR];
    delete process.env[POLLI_ROOT_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "adapter";

    try {
      const failure = await requireSourcePath("skills", { configPath: "/nonexistent/config.json" }).catch(
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      expect(failure).toContain(POLLI_ROOT_ENV_VAR);
      expect(failure).not.toContain("/repo/polli");
    } finally {
      if (originals.sourceMode === undefined) delete process.env[SOURCE_MODE_ENV_VAR];
      else process.env[SOURCE_MODE_ENV_VAR] = originals.sourceMode;
      if (originals.polliRoot === undefined) delete process.env[POLLI_ROOT_ENV_VAR];
      else process.env[POLLI_ROOT_ENV_VAR] = originals.polliRoot;
      if (originals.skills === undefined) delete process.env[ENV_VARS.skills];
      else process.env[ENV_VARS.skills] = originals.skills;
      if (originals.configPath === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = originals.configPath;
    }
  });

  test("falls back to polli adapter for skills when explicit sources are missing", async () => {
    const dir = tempDir();
    const polliRoot = path.join(dir, "polli");
    const skillsPath = path.join(polliRoot, "docs/org-kb/agents/skills/SOURCES.json");

    await mkdir(path.dirname(skillsPath), { recursive: true });
    await writeFile(skillsPath, JSON.stringify({ version: "1", skills: [] }));

    const originals = {
      sourceMode: process.env[SOURCE_MODE_ENV_VAR],
      polliRoot: process.env[POLLI_ROOT_ENV_VAR],
      skills: process.env[ENV_VARS.skills],
      configPath: process.env[CONFIG_ENV_VAR]
    };

    delete process.env[ENV_VARS.skills];
    delete process.env[CONFIG_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "adapter";
    process.env[POLLI_ROOT_ENV_VAR] = polliRoot;

    try {
      const resolved = await requireSourcePath("skills", { configPath: "/nonexistent/config.json" });
      expect(resolved).toBe(skillsPath);
    } finally {
      if (originals.sourceMode === undefined) delete process.env[SOURCE_MODE_ENV_VAR];
      else process.env[SOURCE_MODE_ENV_VAR] = originals.sourceMode;
      if (originals.polliRoot === undefined) delete process.env[POLLI_ROOT_ENV_VAR];
      else process.env[POLLI_ROOT_ENV_VAR] = originals.polliRoot;
      if (originals.skills === undefined) delete process.env[ENV_VARS.skills];
      else process.env[ENV_VARS.skills] = originals.skills;
      if (originals.configPath === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = originals.configPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves agents registry from agents-infra in adapter mode", async () => {
    const dir = tempDir();
    const polliRoot = path.join(dir, "polli");
    const agentsInfraRoot = path.join(dir, "agents-infra");
    const cacheRoot = path.join(dir, "cache");
    const agentsRegistryPath = path.join(agentsInfraRoot, "instructions/agents/AGENTS.json");

    await mkdir(path.join(agentsInfraRoot, "instructions/agents"), { recursive: true });
    await mkdir(path.join(agentsInfraRoot, "instructions/skills"), { recursive: true });
    await mkdir(path.join(agentsInfraRoot, "instructions/templates"), { recursive: true });
    await mkdir(path.join(agentsInfraRoot, "fleet/truths"), { recursive: true });
    await writeFile(path.join(agentsInfraRoot, "instructions/skills/SOURCES.json"), "{}\n", "utf8");
    await writeFile(path.join(agentsInfraRoot, "instructions/templates/REGISTRY.json"), "{}\n", "utf8");
    await writeFile(path.join(agentsInfraRoot, "fleet/truths/hosts.yaml"), "hosts: {}\n", "utf8");
    await writeFile(agentsRegistryPath, JSON.stringify({
      version: "1",
      agents: [
        {
          id: "fixture-reviewer",
          path: "fixture-reviewer/agent.yaml",
          status: "active",
          description: "Fixture reviewer used by POL-1799 launch tests."
        }
      ]
    }, null, 2), "utf8");

    const originals = {
      sourceMode: process.env[SOURCE_MODE_ENV_VAR],
      polliRoot: process.env[POLLI_ROOT_ENV_VAR],
      agentsInfraRoot: process.env[AGENTS_INFRA_ROOT_ENV_VAR],
      cacheRoot: process.env[ADAPTER_CACHE_ENV_VAR],
      agents: process.env[ENV_VARS.agents],
      configPath: process.env[CONFIG_ENV_VAR]
    };

    delete process.env[ENV_VARS.agents];
    delete process.env[CONFIG_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "adapter";
    process.env[POLLI_ROOT_ENV_VAR] = polliRoot;
    process.env[AGENTS_INFRA_ROOT_ENV_VAR] = agentsInfraRoot;
    process.env[ADAPTER_CACHE_ENV_VAR] = cacheRoot;

    try {
      const resolved = await requireSourcePath("agents");
      expect(resolved).toBe(agentsRegistryPath);

      const payload = JSON.parse(await readFile(resolved, "utf8")) as { agents: Array<{ id: string }> };
      expect(payload.agents.map((entry) => entry.id)).toEqual(["fixture-reviewer"]);
    } finally {
      if (originals.sourceMode === undefined) delete process.env[SOURCE_MODE_ENV_VAR];
      else process.env[SOURCE_MODE_ENV_VAR] = originals.sourceMode;
      if (originals.polliRoot === undefined) delete process.env[POLLI_ROOT_ENV_VAR];
      else process.env[POLLI_ROOT_ENV_VAR] = originals.polliRoot;
      if (originals.agentsInfraRoot === undefined) delete process.env[AGENTS_INFRA_ROOT_ENV_VAR];
      else process.env[AGENTS_INFRA_ROOT_ENV_VAR] = originals.agentsInfraRoot;
      if (originals.cacheRoot === undefined) delete process.env[ADAPTER_CACHE_ENV_VAR];
      else process.env[ADAPTER_CACHE_ENV_VAR] = originals.cacheRoot;
      if (originals.agents === undefined) delete process.env[ENV_VARS.agents];
      else process.env[ENV_VARS.agents] = originals.agents;
      if (originals.configPath === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = originals.configPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("materializes knowledge registry from docstore execplans in adapter mode", async () => {
    const dir = tempDir();
    const polliRoot = path.join(dir, "polli");
    const docstoreRoot = path.join(dir, "docstore");
    const execPlanDir = path.join(docstoreRoot, "execplan", "POL-725");
    const cacheRoot = path.join(dir, "cache");

    await mkdir(path.join(polliRoot, "docs/org-kb/agents/staged/blade"), { recursive: true });
    await mkdir(execPlanDir, { recursive: true });
    await writeFile(path.join(execPlanDir, "EXECPLAN.md"), "# Production Wiring Plan\n\nBody\n", "utf8");

    const originals = {
      sourceMode: process.env[SOURCE_MODE_ENV_VAR],
      polliRoot: process.env[POLLI_ROOT_ENV_VAR],
      docstoreRoot: process.env[DOCSTORE_ROOT_ENV_VAR],
      cacheRoot: process.env[ADAPTER_CACHE_ENV_VAR],
      knowledge: process.env[ENV_VARS.knowledge],
      configPath: process.env[CONFIG_ENV_VAR]
    };

    delete process.env[ENV_VARS.knowledge];
    delete process.env[CONFIG_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "adapter";
    process.env[POLLI_ROOT_ENV_VAR] = polliRoot;
    process.env[DOCSTORE_ROOT_ENV_VAR] = docstoreRoot;
    process.env[ADAPTER_CACHE_ENV_VAR] = cacheRoot;

    try {
      const resolved = await requireSourcePath("knowledge");
      expect(resolved).toBe(path.join(cacheRoot, "knowledge.registry.json"));
      const payload = JSON.parse(await readFile(resolved, "utf8")) as { artifacts: Array<{ id: string; linked_issues?: string[] }> };
      expect(payload.artifacts.length).toBe(1);
      expect(payload.artifacts[0]!.id).toBe("POL-725");
      expect(payload.artifacts[0]!.linked_issues).toEqual(["POL-725"]);
    } finally {
      if (originals.sourceMode === undefined) delete process.env[SOURCE_MODE_ENV_VAR];
      else process.env[SOURCE_MODE_ENV_VAR] = originals.sourceMode;
      if (originals.polliRoot === undefined) delete process.env[POLLI_ROOT_ENV_VAR];
      else process.env[POLLI_ROOT_ENV_VAR] = originals.polliRoot;
      if (originals.docstoreRoot === undefined) delete process.env[DOCSTORE_ROOT_ENV_VAR];
      else process.env[DOCSTORE_ROOT_ENV_VAR] = originals.docstoreRoot;
      if (originals.cacheRoot === undefined) delete process.env[ADAPTER_CACHE_ENV_VAR];
      else process.env[ADAPTER_CACHE_ENV_VAR] = originals.cacheRoot;
      if (originals.knowledge === undefined) delete process.env[ENV_VARS.knowledge];
      else process.env[ENV_VARS.knowledge] = originals.knowledge;
      if (originals.configPath === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = originals.configPath;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit source mode disables adapter fallback", async () => {
    const originals = {
      sourceMode: process.env[SOURCE_MODE_ENV_VAR],
      skills: process.env[ENV_VARS.skills],
      configPath: process.env[CONFIG_ENV_VAR]
    };

    delete process.env[ENV_VARS.skills];
    delete process.env[CONFIG_ENV_VAR];
    process.env[SOURCE_MODE_ENV_VAR] = "explicit";

    try {
      await expect(requireSourcePath("skills", { configPath: "/nonexistent/config.json" })).rejects.toThrow(
        "No skills source path found"
      );
    } finally {
      if (originals.sourceMode === undefined) delete process.env[SOURCE_MODE_ENV_VAR];
      else process.env[SOURCE_MODE_ENV_VAR] = originals.sourceMode;
      if (originals.skills === undefined) delete process.env[ENV_VARS.skills];
      else process.env[ENV_VARS.skills] = originals.skills;
      if (originals.configPath === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = originals.configPath;
    }
  });
});

describe("loadCalyxConfig", () => {
  test("loads valid config from explicit path", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      registries: { skills: "/path/skills.json" },
      stores: { exec: "/path/exec.json" }
    }));

    try {
      const result = await loadCalyxConfig(configPath);
      expect(result.config).toBeDefined();
      expect(result.config!.version).toBe("1");
      expect(result.config!.registries?.skills).toBe("/path/skills.json");
      expect(result.config!.stores?.exec).toBe("/path/exec.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined config for missing file", async () => {
    const result = await loadCalyxConfig("/nonexistent/path/config.json");
    expect(result.config).toBeUndefined();
  });

  test("returns undefined config for invalid JSON", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, "not valid json");

    try {
      const result = await loadCalyxConfig(configPath);
      expect(result.config).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined config for invalid schema", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ not_valid: true }));

    try {
      const result = await loadCalyxConfig(configPath);
      expect(result.config).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads config from CALYX_CONFIG env var", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: "1" }));

    const original = process.env[CONFIG_ENV_VAR];
    process.env[CONFIG_ENV_VAR] = configPath;

    try {
      const result = await loadCalyxConfig();
      expect(result.config).toBeDefined();
      expect(result.source).toBe("env");
    } finally {
      if (original === undefined) {
        delete process.env[CONFIG_ENV_VAR];
      } else {
        process.env[CONFIG_ENV_VAR] = original;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("showConfig", () => {
  test("returns resolved paths for all domains", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      registries: {
        skills: "/cfg/skills.json",
        agents: "/cfg/agents.json"
      },
      stores: { exec: "/cfg/exec.json" }
    }));

    try {
      const result = await showConfig(configPath);
      expect(result.resolved.skills.path).toBe("/cfg/skills.json");
      expect(result.resolved.skills.source).toBe("config");
      expect(result.resolved.agents.path).toBe("/cfg/agents.json");
      expect(result.resolved.agents.source).toBe("config");
      expect(result.resolved.exec.path).toBe("/cfg/exec.json");
      expect(result.resolved.exec.source).toBe("config");
      // Non-configured domains return none
      expect(result.resolved.tools.source).toBe("none");
      expect(result.resolved.prompts.source).toBe("none");
      expect(result.resolved.knowledge.source).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("env vars override config values in show", async () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      registries: { skills: "/cfg/skills.json" }
    }));

    const original = process.env[ENV_VARS.skills];
    process.env[ENV_VARS.skills] = "/env/skills.json";

    try {
      const result = await showConfig(configPath);
      expect(result.resolved.skills.path).toBe("/env/skills.json");
      expect(result.resolved.skills.source).toBe("env");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.skills];
      } else {
        process.env[ENV_VARS.skills] = original;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("precedence chain integration", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = tempDir();
    configPath = path.join(dir, "config.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      version: "1",
      registries: { skills: "/config/skills.json" }
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("cli > env > config", async () => {
    const original = process.env[ENV_VARS.skills];
    process.env[ENV_VARS.skills] = "/env/skills.json";

    try {
      // CLI wins
      const r1 = await resolveSourcePath("skills", { cliValue: "/cli/skills.json", configPath });
      expect(r1.source).toBe("cli");
      expect(r1.path).toBe("/cli/skills.json");

      // Env wins over config
      const r2 = await resolveSourcePath("skills", { configPath });
      expect(r2.source).toBe("env");
      expect(r2.path).toBe("/env/skills.json");

      // Config used when env cleared
      delete process.env[ENV_VARS.skills];
      const r3 = await resolveSourcePath("skills", { configPath });
      expect(r3.source).toBe("config");
      expect(r3.path).toBe("/config/skills.json");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_VARS.skills];
      } else {
        process.env[ENV_VARS.skills] = original;
      }
    }
  });
});
