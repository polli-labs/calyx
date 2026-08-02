import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-plugins-cli-"));
  tempRoots.push(root);
  return root;
}

async function seedPluginFixture(home: string): Promise<void> {
  const pluginRoot = path.join(home, ".codex", "plugins", "cache", "openai-curated", "linear", "hash");
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(path.join(pluginRoot, "skills", "linear"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "linear",
      version: "0.0.0",
      description: "Find and reference issues.",
      skills: "./skills/",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(pluginRoot, "skills", "linear", "SKILL.md"), "# Linear\n", "utf8");
  const configPath = path.join(home, ".codex", "config.toml");
  await writeFile(configPath, '[plugins."linear@openai-curated"]\nenabled = true\n', "utf8");
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugins command", () => {
  test("plugins list emits machine-readable inventory", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "list",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schemaVersion: string;
      plugins: Array<{ plugin: string; state: string[] }>;
    };
    expect(payload.schemaVersion).toBe("plugins.inventory/v1");
    expect(payload.plugins).toEqual([
      expect.objectContaining({
        plugin: "linear",
        state: expect.arrayContaining(["cached", "enabled"]),
      }),
    ]);
  });

  test("plugins trace emits component provenance envelope", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "trace",
      "linear",
      "--kind",
      "skills",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      result: { schemaVersion: string; matches: Array<{ kind: string; plugin: { plugin: string } }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("plugins.trace");
    expect(payload.result.schemaVersion).toBe("plugins.trace/v1");
    expect(payload.result.matches).toEqual([
      expect.objectContaining({
        kind: "skills",
        plugin: expect.objectContaining({ plugin: "linear" }),
      }),
    ]);
  });

  test("plugins show emits plugin detail envelope", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "show",
      "linear",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      result: { schemaVersion: string; matches: Array<{ plugin: string; harness: string }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("plugins.show");
    expect(payload.result.schemaVersion).toBe("plugins.show/v1");
    expect(payload.result.matches).toEqual([
      expect.objectContaining({
        plugin: "linear",
        harness: "codex",
      }),
    ]);
  });

  test("plugins show emits JSON error and exit 3 when no plugin matches", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "show",
      "missing",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
    };
    expect(payload).toMatchObject({
      ok: false,
      command: "plugins.show",
      error: {
        code: "plugin_not_found",
      },
    });
    expect(payload.error.message).toContain("missing");
    expect(process.exitCode).toBe(3);
  });

  test("plugins trace emits JSON error and exit 3 when no component matches", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "trace",
      "missing",
      "--kind",
      "skills",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
    };
    expect(payload).toMatchObject({
      ok: false,
      command: "plugins.trace",
      error: {
        code: "plugin_component_not_found",
      },
    });
    expect(payload.error.message).toContain("missing");
    expect(process.exitCode).toBe(3);
  });

  test("plugins doctor emits doctor envelope", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    await seedPluginFixture(home);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "plugins",
      "doctor",
      "--home",
      home,
      "--harness",
      "codex",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schemaVersion: string;
      ok: boolean;
      summary: { error: number };
    };
    expect(payload.schemaVersion).toBe("plugins.doctor/v1");
    expect(payload.ok).toBe(true);
    expect(payload.summary.error).toBe(0);
  });
});
