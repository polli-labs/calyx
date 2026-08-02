import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { doctorPlugins, listPlugins, showPlugin, tracePluginComponent } from "../plugins";

const roots = new Set<string>();

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-plugins-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function seedCodexPlugin(home: string): Promise<void> {
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
      apps: "./.app.json",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(pluginRoot, "skills", "linear", "SKILL.md"), "# Linear\n", "utf8");
  await writeFile(
    path.join(pluginRoot, ".app.json"),
    `${JSON.stringify({ apps: { linear: { id: "connector_linear" } } }, null, 2)}\n`,
    "utf8",
  );

  const catalogPath = path.join(home, ".codex", ".tmp", "plugins", ".agents", "plugins", "marketplace.json");
  await mkdir(path.dirname(catalogPath), { recursive: true });
  await writeFile(
    catalogPath,
    `${JSON.stringify({
      name: "openai-curated",
      plugins: [
        { name: "linear", source: { source: "local", path: "./plugins/linear" } },
        { name: "figma", source: { source: "local", path: "./plugins/figma" } },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const configPath = path.join(home, ".codex", "config.toml");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[plugins."linear@openai-curated"]\nenabled = true\n', "utf8");
}

async function seedClaudePlugin(home: string): Promise<void> {
  const pluginRoot = path.join(home, ".claude", "plugins", "cache", "claude-code-plugins", "frontend-design", "1.0.0");
  await mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(pluginRoot, "skills", "frontend-design"), { recursive: true });
  await mkdir(path.join(pluginRoot, "commands"), { recursive: true });
  await mkdir(path.join(pluginRoot, "hooks"), { recursive: true });
  await writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "frontend-design",
      version: "1.0.0",
      description: "Frontend design skill.",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(pluginRoot, "skills", "frontend-design", "SKILL.md"), "# Frontend\n", "utf8");
  await writeFile(path.join(pluginRoot, "commands", "polish-ui.md"), "Polish UI.\n", "utf8");
  await writeFile(path.join(pluginRoot, "hooks", "hooks.json"), "{}\n", "utf8");

  const marketplaceRoot = path.join(home, ".claude", "plugins", "marketplaces", "claude-code-plugins");
  const marketplacePluginRoot = path.join(marketplaceRoot, "plugins", "code-review");
  await mkdir(path.join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  await mkdir(path.join(marketplacePluginRoot, "commands"), { recursive: true });
  await writeFile(path.join(marketplacePluginRoot, "commands", "review-code.md"), "Review code.\n", "utf8");
  await writeFile(
    path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({
      name: "claude-code-plugins",
      plugins: [
        {
          name: "code-review",
          description: "Review code.",
          source: "./plugins/code-review",
        },
        {
          name: "pyright-lsp",
          description: "Python language server.",
          source: "./plugins/pyright-lsp",
          lspServers: {
            pyright: { command: "pyright-langserver" },
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
  await mkdir(path.dirname(knownPath), { recursive: true });
  await writeFile(
    knownPath,
    `${JSON.stringify({
      "claude-code-plugins": {
        source: { source: "github", repo: "anthropics/claude-code" },
        installLocation: marketplaceRoot,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

describe("plugins inventory", () => {
  test("lists Codex cached, cataloged, and enabled plugin state separately", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    await seedCodexPlugin(home);

    const result = await listPlugins({ home, harness: "codex", includeCatalog: true, observedAt: "2026-04-26T12:00:00.000Z" });
    const linear = result.plugins.find((plugin) => plugin.plugin === "linear");
    const figma = result.plugins.find((plugin) => plugin.plugin === "figma");

    expect(linear).toMatchObject({
      harness: "codex",
      marketplace: "openai-curated",
      state: expect.arrayContaining(["cataloged", "cached", "enabled"]),
      paths: {
        marketplace: expect.stringContaining("marketplace.json"),
        root: expect.stringContaining(path.join(".codex", "plugins", "cache")),
      },
      components: {
        skills: ["linear"],
        apps: ["linear"],
      },
    });
    expect(figma).toMatchObject({
      harness: "codex",
      marketplace: "openai-curated",
      state: expect.arrayContaining(["cataloged"]),
    });
    expect(result.summary.byState.cataloged).toBe(2);
    expect(result.summary.byState.cached).toBe(1);
    expect(result.summary.byState.enabled).toBe(1);
  });

  test("omits catalog-only entries by default", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    await seedCodexPlugin(home);

    const result = await listPlugins({ home, harness: "codex" });

    expect(result.plugins.map((plugin) => plugin.plugin)).toEqual(["linear"]);
  });

  test("lists Claude installed plugin components and marketplace-only entries", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    await seedClaudePlugin(home);

    const result = await listPlugins({ home, harness: "claude", includeCatalog: true });
    const frontend = result.plugins.find((plugin) => plugin.plugin === "frontend-design");
    const codeReview = result.plugins.find((plugin) => plugin.plugin === "code-review");

    expect(frontend).toMatchObject({
      harness: "claude",
      marketplace: "claude-code-plugins",
      state: ["installed"],
      components: {
        skills: ["frontend-design"],
        commands: ["polish-ui"],
        hooks: ["hooks"],
      },
    });
    expect(codeReview).toMatchObject({
      harness: "claude",
      marketplace: "claude-code-plugins",
      state: ["cataloged"],
      components: {
        commands: ["review-code"],
      },
    });
    expect(result.plugins.find((plugin) => plugin.plugin === "pyright-lsp")).toMatchObject({
      harness: "claude",
      marketplace: "claude-code-plugins",
      state: ["cataloged"],
      components: {
        lspServers: ["pyright"],
      },
    });
  });

  test("resolves Claude marketplace tilde paths from --claude-home without --home", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    await seedClaudePlugin(home);
    const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
    await writeFile(
      knownPath,
      `${JSON.stringify({
        "claude-code-plugins": {
          source: { source: "github", repo: "anthropics/claude-code" },
          installLocation: "~/.claude/plugins/marketplaces/claude-code-plugins",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await listPlugins({
      claudeHome: path.join(home, ".claude"),
      harness: "claude",
      includeCatalog: true,
    });

    expect(result.plugins.find((plugin) => plugin.plugin === "code-review")).toMatchObject({
      harness: "claude",
      marketplace: "claude-code-plugins",
      state: ["cataloged"],
      components: {
        commands: ["review-code"],
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("show and trace expose plugin-owned provenance", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    await seedCodexPlugin(home);

    const show = await showPlugin("linear@openai-curated", { home, harness: "codex" });
    const trace = await tracePluginComponent("linear", { home, harness: "codex", kind: "skills" });

    expect(show.matches).toHaveLength(1);
    expect(show.matches[0]?.state).toContain("enabled");
    expect(trace.matches).toHaveLength(1);
    expect(trace.matches[0]?.kind).toBe("skills");
    expect(trace.matches[0]?.plugin.plugin).toBe("linear");
  });

  test("doctor reports enabled-missing-cache as an error", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    const configPath = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '[plugins."missing@openai-curated"]\nenabled = true\n', "utf8");

    const result = await doctorPlugins({ home, harness: "codex" });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enabled_missing_cache",
          severity: "error",
          plugin: "missing",
        }),
      ]),
    );
  });

  test("keeps scanning Claude marketplaces when one marketplace JSON is malformed", async () => {
    const root = await makeRoot();
    const home = path.join(root, "home");
    const badMarketplaceRoot = path.join(home, ".claude", "plugins", "marketplaces", "bad-marketplace");
    const goodMarketplaceRoot = path.join(home, ".claude", "plugins", "marketplaces", "good-marketplace");
    await mkdir(path.join(badMarketplaceRoot, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(goodMarketplaceRoot, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(goodMarketplaceRoot, "plugins", "code-review", "commands"), { recursive: true });
    await writeFile(path.join(badMarketplaceRoot, ".claude-plugin", "marketplace.json"), "{not json", "utf8");
    await writeFile(
      path.join(goodMarketplaceRoot, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "good-marketplace",
        plugins: [
          {
            name: "code-review",
            source: "./plugins/code-review",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(goodMarketplaceRoot, "plugins", "code-review", "commands", "review-code.md"), "Review.\n", "utf8");
    const knownPath = path.join(home, ".claude", "plugins", "known_marketplaces.json");
    await mkdir(path.dirname(knownPath), { recursive: true });
    await writeFile(
      knownPath,
      `${JSON.stringify({
        "bad-marketplace": {
          installLocation: "~/.claude/plugins/marketplaces/bad-marketplace",
        },
        "good-marketplace": {
          installLocation: "~/.claude/plugins/marketplaces/good-marketplace",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await listPlugins({ home, harness: "claude", includeCatalog: true });

    expect(result.plugins.find((plugin) => plugin.plugin === "code-review")).toMatchObject({
      harness: "claude",
      marketplace: "good-marketplace",
      components: {
        commands: ["review-code"],
      },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "claude_marketplace_parse_failed",
        path: path.join(badMarketplaceRoot, ".claude-plugin", "marketplace.json"),
      }),
    ]);
  });
});
