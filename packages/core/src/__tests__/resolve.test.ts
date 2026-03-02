import path from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { resolveSourcePath, requireSourcePath, loadCalyxConfig, showConfig, ENV_VARS, CONFIG_ENV_VAR } from "../resolve";

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
    }
  });

  test("error message includes flag, env var, and config file hints", async () => {
    const originals: Record<string, string | undefined> = {};
    for (const [, envVar] of Object.entries(ENV_VARS)) {
      originals[envVar] = process.env[envVar];
      delete process.env[envVar];
    }

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
