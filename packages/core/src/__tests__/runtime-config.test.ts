import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { afterEach, describe, expect, test } from "vitest";
import { applyRuntimeConfig, planRuntimeConfig, verifyRuntimeConfig } from "../runtime-config";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function seedManagedConfigs(root: string): Promise<{ managedConfigsRoot: string }> {
  const managedConfigsRoot = path.join(root, "managed-configs");
  await mkdir(path.join(managedConfigsRoot, "shared"), { recursive: true });
  await mkdir(path.join(managedConfigsRoot, "carbon"), { recursive: true });

  await writeFile(
    path.join(managedConfigsRoot, "shared", "config.toml"),
    [
      "# Shared fallback",
      'profile = "full-auto"',
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(managedConfigsRoot, "carbon", "config.toml"),
    [
      "# Host override",
      'profile = "full-auto"',
      'model = "gpt-5.4-pro"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
      '[projects."/Users/carbon/dev/calyx/dev"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
    `${JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        alwaysThinkingEnabled: true,
        includeCoAuthoredBy: false,
        permissions: { defaultMode: "allowEdits" },
        env: {
          LINEAR_API_KEY: "{{ SET_VIA_ENVIRONMENT_OR_LOCAL_FILE }}",
          AGENT_MAIL_BEARER: "{{ SET_VIA_ENVIRONMENT_OR_LOCAL_FILE }}",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(managedConfigsRoot, "shared", "claude.mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          "linear-server": {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(managedConfigsRoot, "carbon", "claude.mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          "linear-server": {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
          },
          executor_carbon: {
            type: "http",
            url: "https://carbon.tailc29f0.ts.net/mcp",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { managedConfigsRoot };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-config backend", () => {
  test("rejects non-canonical host selectors before managed-source lookup", async () => {
    const root = await makeTempRoot("calyx-runtime-config-host-selector-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);

    await expect(planRuntimeConfig({
      host: "carbon.../../../attacker",
      managedConfigsRoot,
      liveHome: path.join(root, "home"),
      components: ["codex"],
    })).rejects.toThrow("not a canonical host segment");
  });

  test("rejects managed source directories reached through symlinks", async () => {
    const root = await makeTempRoot("calyx-runtime-config-source-symlink-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const outsideHostRoot = path.join(root, "outside-carbon");
    await mkdir(outsideHostRoot, { recursive: true });
    await writeFile(path.join(outsideHostRoot, "config.toml"), 'model = "attacker"\n', "utf8");
    await rm(path.join(managedConfigsRoot, "carbon"), { recursive: true });
    await symlink(outsideHostRoot, path.join(managedConfigsRoot, "carbon"), "dir");

    await expect(planRuntimeConfig({
      host: "carbon",
      managedConfigsRoot,
      liveHome: path.join(root, "home"),
      components: ["codex"],
    })).rejects.toThrow("must be a real directory");
  });

  test("plan reports drift against managed truth with a versioned receipt envelope", async () => {
    const root = await makeTempRoot("calyx-runtime-config-plan-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(liveHome, ".codex", "config.toml"),
      'profile = "full-auto"\nmodel = "gpt-5.2"\n',
      "utf8",
    );

    const result = await planRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    expect(result.contractVersion).toBe("local-backend/v1");
    expect(result.backend).toBe("runtime-config");
    expect(result.mode).toBe("plan");
    expect(result.requestedHost).toBe("carbon");
    expect(result.ok).toBe(false);
    expect(result.summary.total).toBe(3);
    expect(result.summary.drift).toBe(3);
    expect(result.items.map((item) => item.component)).toEqual(["codex", "claude-settings", "claude-mcp"]);
    expect(result.items[0]?.changes).toContain("codex: converge model from managed truth");
  });

  test("apply writes targets, preserves local Claude env placeholders, and creates backups", async () => {
    const root = await makeTempRoot("calyx-runtime-config-apply-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });
    await mkdir(path.join(liveHome, ".claude"), { recursive: true });

    const liveCodexPath = path.join(liveHome, ".codex", "config.toml");
    const liveClaudePath = path.join(liveHome, ".claude", "settings.json");

    await writeFile(
      liveCodexPath,
      [
        'profile = "full-auto"',
        'model = "gpt-5.2"',
        "",
        '[projects."/Users/carbon/scratch"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      liveClaudePath,
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/claude-code-settings.json",
          env: {
            LINEAR_API_KEY: "preserve-me",
            AGENT_MAIL_BEARER: "also-preserve-me",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(liveHome, ".claude.json"),
      `${JSON.stringify(
        {
          numStartups: 4,
          mcpServers: {
            "linear-server": {
              type: "http",
              url: "https://stale.example/mcp",
            },
            "custom-local": {
              type: "stdio",
              command: "custom-tool",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("apply");
    expect(result.summary.applied).toBe(3);
    expect(result.items.every((item) => item.status === "applied")).toBe(true);
    expect(result.items.every((item) => typeof item.backupPath === "string")).toBe(true);

    const nextCodex = await readFile(liveCodexPath, "utf8");
    const nextClaude = JSON.parse(await readFile(liveClaudePath, "utf8")) as {
      model?: string;
      env?: Record<string, string>;
      permissions?: { defaultMode?: string };
    };
    const nextClaudeRoot = JSON.parse(await readFile(path.join(liveHome, ".claude.json"), "utf8")) as {
      numStartups?: number;
      mcpServers?: Record<string, Record<string, string>>;
    };

    expect(nextCodex).toContain('model = "gpt-5.4-pro"');
    expect(nextCodex).toContain('[projects."/Users/carbon/dev/calyx/dev"]');
    expect(nextCodex).toContain('[projects."/Users/carbon/scratch"]');
    expect(nextClaude.permissions?.defaultMode).toBe("allowEdits");
    expect(nextClaude.env?.LINEAR_API_KEY).toBe("preserve-me");
    expect(nextClaude.env?.AGENT_MAIL_BEARER).toBe("also-preserve-me");
    expect(nextClaudeRoot.numStartups).toBe(4);
    expect(nextClaudeRoot.mcpServers?.["linear-server"]?.url).toBe("https://mcp.linear.app/mcp");
    expect(nextClaudeRoot.mcpServers?.executor_carbon?.url).toBe("https://carbon.tailc29f0.ts.net/mcp");
    expect(nextClaudeRoot.mcpServers?.["custom-local"]?.command).toBe("custom-tool");
  });

  test("verify succeeds after apply", async () => {
    const root = await makeTempRoot("calyx-runtime-config-verify-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");

    await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    const result = await verifyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    expect(result.mode).toBe("verify");
    expect(result.ok).toBe(true);
    expect(result.summary.ok).toBe(3);
    expect(result.summary.drift).toBe(0);
    expect(result.items.every((item) => item.status === "ok")).toBe(true);
  });

  test("preserves plugin-owned Codex notify when managed truth omits notify", async () => {
    const root = await makeTempRoot("calyx-runtime-config-notify-preserve-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });

    const liveCodexPath = path.join(liveHome, ".codex", "config.toml");
    await writeFile(
      liveCodexPath,
      [
        'profile = "full-auto"',
        'model = "gpt-5.2"',
        'notify = ["/Applications/Codex Computer Use.app/notify", "turn-ended"]',
        "",
      ].join("\n"),
      "utf8",
    );

    const plan = await planRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["codex"],
    });

    expect(plan.items[0]?.changes).not.toContain("codex: remove notify absent from managed truth");

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["codex"],
    });

    expect(result.ok).toBe(true);
    const nextCodex = parseToml(await readFile(liveCodexPath, "utf8")) as Record<string, unknown>;
    expect(nextCodex.notify).toEqual(["/Applications/Codex Computer Use.app/notify", "turn-ended"]);
  });

  test("converges Codex notify when managed truth explicitly owns notify", async () => {
    const root = await makeTempRoot("calyx-runtime-config-notify-managed-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });

    const liveCodexPath = path.join(liveHome, ".codex", "config.toml");
    await writeFile(
      liveCodexPath,
      [
        'profile = "full-auto"',
        'model = "gpt-5.2"',
        'notify = ["/Applications/Codex Computer Use.app/notify", "turn-ended"]',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "carbon", "config.toml"),
      [
        "# Host override",
        'profile = "full-auto"',
        'model = "gpt-5.4-pro"',
        'notify = ["managed-notifier", "turn-ended"]',
        "",
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["codex"],
    });

    expect(result.ok).toBe(true);
    expect(result.items[0]?.changes).toContain("codex: converge notify from managed truth");
    const nextCodex = parseToml(await readFile(liveCodexPath, "utf8")) as Record<string, unknown>;
    expect(nextCodex.notify).toEqual(["managed-notifier", "turn-ended"]);
  });

  test("clears Codex notify when managed truth explicitly owns an empty notify list", async () => {
    const root = await makeTempRoot("calyx-runtime-config-notify-clear-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });

    const liveCodexPath = path.join(liveHome, ".codex", "config.toml");
    await writeFile(
      liveCodexPath,
      [
        'profile = "full-auto"',
        'model = "gpt-5.2"',
        'notify = ["/Applications/Codex Computer Use.app/notify", "turn-ended"]',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "carbon", "config.toml"),
      [
        "# Host override",
        'profile = "full-auto"',
        'model = "gpt-5.4-pro"',
        "notify = []",
        "",
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["codex"],
    });

    expect(result.ok).toBe(true);
    expect(result.items[0]?.changes).toContain("codex: converge notify from managed truth");
    const nextCodex = parseToml(await readFile(liveCodexPath, "utf8")) as Record<string, unknown>;
    expect(nextCodex.notify).toEqual([]);
  });

  test("plan ignores Claude env key ordering when the effective values are unchanged", async () => {
    const root = await makeTempRoot("calyx-runtime-config-env-order-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".claude"), { recursive: true });
    await writeFile(
      path.join(liveHome, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/claude-code-settings.json",
          alwaysThinkingEnabled: true,
          includeCoAuthoredBy: false,
          permissions: { defaultMode: "allowEdits" },
          env: {
            AGENT_MAIL_BEARER: "also-preserve-me",
            LINEAR_API_KEY: "preserve-me",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await planRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["claude-settings"],
    });

    expect(result.ok).toBe(true);
    expect(result.summary.total).toBe(1);
    expect(result.summary.drift).toBe(0);
    expect(result.items[0]?.status).toBe("ok");
    expect(result.items[0]?.changes).toEqual([]);
  });

  test("plan ignores Claude MCP field ordering when the managed value is semantically equal", async () => {
    const root = await makeTempRoot("calyx-runtime-config-mcp-order-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(liveHome, { recursive: true });
    await writeFile(
      path.join(liveHome, ".claude.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "linear-server": {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: {
                Extra: "ignored-local",
                Authorization: "Bearer ${LINEAR_API_KEY}",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await writeFile(
      path.join(managedConfigsRoot, "shared", "claude.mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "linear-server": {
              headers: {
                Authorization: "Bearer ${LINEAR_API_KEY}",
                Extra: "ignored-local",
              },
              url: "https://mcp.linear.app/mcp",
              type: "http",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await planRuntimeConfig({
      managedConfigsRoot,
      host: "blade",
      liveHome,
      components: ["claude-mcp"],
    });

    expect(result.ok).toBe(true);
    expect(result.summary.total).toBe(1);
    expect(result.summary.drift).toBe(0);
    expect(result.items[0]?.status).toBe("ok");
    expect(result.items[0]?.changes).toEqual([]);
  });
  test("apply removes previously managed entries that disappear from truth while preserving local extras", async () => {
    const root = await makeTempRoot("calyx-runtime-config-managed-deletions-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });

    await writeFile(
      path.join(liveHome, ".codex", "config.toml"),
      [
        'profile = "full-auto"',
        'model = "gpt-5.2"',
        "",
        "[mcp_servers.custom_local]",
        'url = "http://127.0.0.1:9999/mcp"',
        "",
        '[projects."/Users/carbon/scratch"]',
        'trust_level = "trusted"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(liveHome, ".claude.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "custom-local": {
              type: "stdio",
              command: "custom-tool",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    await writeFile(
      path.join(managedConfigsRoot, "shared", "config.toml"),
      [
        "# Shared fallback",
        'profile = "full-auto"',
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "carbon", "config.toml"),
      [
        "# Host override",
        'profile = "full-auto"',
        'model = "gpt-5.4-pro"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "carbon", "claude.mcp.json"),
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "utf8",
    );

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
    });

    expect(result.ok).toBe(true);

    const nextCodex = await readFile(path.join(liveHome, ".codex", "config.toml"), "utf8");
    expect(nextCodex).not.toContain("[mcp_servers.linear]");
    expect(nextCodex).toContain("[mcp_servers.custom_local]");
    expect(nextCodex).not.toContain('[projects."/Users/carbon/dev/calyx/dev"]');
    expect(nextCodex).toContain('[projects."/Users/carbon/scratch"]');

    const nextClaudeRoot = JSON.parse(await readFile(path.join(liveHome, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, Record<string, string>>;
    };
    expect(nextClaudeRoot.mcpServers?.["linear-server"]).toBeUndefined();
    expect(nextClaudeRoot.mcpServers?.executor_carbon).toBeUndefined();
    expect(nextClaudeRoot.mcpServers?.["custom-local"]?.command).toBe("custom-tool");
  });

  test("apply removes stale managed Claude MCP fields that disappear from truth", async () => {
    const root = await makeTempRoot("calyx-runtime-config-managed-field-deletions-");
    const { managedConfigsRoot } = await seedManagedConfigs(root);
    const liveHome = path.join(root, "home");
    await mkdir(liveHome, { recursive: true });

    await writeFile(
      path.join(liveHome, ".claude.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "linear-server": {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
              command: "stale-wrapper",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await applyRuntimeConfig({
      managedConfigsRoot,
      host: "carbon",
      liveHome,
      components: ["claude-mcp"],
    });

    expect(result.ok).toBe(true);
    expect(result.items[0]?.changes).toContain("claude-mcp: remove mcpServers.linear-server.command");

    const nextClaudeRoot = JSON.parse(await readFile(path.join(liveHome, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    expect(nextClaudeRoot.mcpServers?.["linear-server"]?.command).toBeUndefined();
    expect(nextClaudeRoot.mcpServers?.["linear-server"]?.headers).toEqual({
      Authorization: "Bearer ${LINEAR_API_KEY}",
    });
  });
  test("plan falls back to the canonical target-local agents-infra path when managedConfigsRoot is omitted", async () => {
    const root = await makeTempRoot("calyx-runtime-config-default-root-");
    const liveHome = path.join(root, "home");
    const managedConfigsRoot = path.join(liveHome, "dev", "agents-infra", "dev", "fleet", "configs");
    await mkdir(path.join(managedConfigsRoot, "shared"), { recursive: true });
    await writeFile(
      path.join(managedConfigsRoot, "shared", "config.toml"),
      'profile = "full-auto"\nmodel = "gpt-5.4"\n',
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/claude-code-settings.json",
          permissions: { defaultMode: "allowEdits" },
          env: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "shared", "claude.mcp.json"),
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "utf8",
    );

    const result = await planRuntimeConfig({
      host: "carbon",
      liveHome,
    });

    expect(result.managedConfigsRoot).toBe(managedConfigsRoot);
    expect(result.requestedHost).toBe("carbon");
    expect(result.summary.total).toBe(3);
  });
});
