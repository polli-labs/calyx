import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CtxpackOutputEnvelopeV1, CtxpackPlanResponseDataV1 } from "../types";
import {
  buildCalyxMcpVaultContextManifestV1,
  callCalyxMcpVaultContextToolV1,
  validateCalyxMcpVaultContextManifestV1
} from "../mcp-vault-context";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function createVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-mcp-vault-context-"));
  roots.add(root);
  const vaultPath = path.join(root, "vault");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(vaultPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return vaultPath;
}

describe("Calyx MCP vault-context manifest", () => {
  test("emits the ten read-only v0 tool descriptors with live backing metadata", () => {
    const manifest = buildCalyxMcpVaultContextManifestV1();

    expect(manifest.schema_version).toBe("calyx.mcp.vault-context/v0");
    expect(manifest.surface).toBe("vault-context");
    expect(manifest.validation.ok).toBe(true);
    expect(manifest.security.write_tools_exposed).toBe(false);
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "vault_search",
      "vault_fetch",
      "vault_related",
      "vault_footnotes_list",
      "vault_footnotes_get",
      "vault_journal_entries",
      "vault_journal_get",
      "context_plan",
      "context_fetch_pack",
      "agent_context"
    ]);
    for (const tool of manifest.tools) {
      expect(tool.read_only).toBe(true);
      expect(tool.input_schema.type).toBe("object");
      expect(JSON.stringify(tool.input_schema)).not.toContain("vault_path");
      expect(tool.output_schema_ref).toBeTruthy();
      expect(tool.backing_command.interface_record_id).toBeTruthy();
      expect(tool.description.startsWith("Use when ")).toBe(true);
    }
  });

  test("fails validation when a backing command path disappears", () => {
    const manifest = buildCalyxMcpVaultContextManifestV1();
    const commandPaths = manifest.tools
      .flatMap((tool) => [tool.backing_command, ...(tool.related_backing_commands ?? [])])
      .map((command) => command.path)
      .filter((commandPath) => commandPath !== "vault search");

    const validation = validateCalyxMcpVaultContextManifestV1(manifest.tools, { commandPaths });

    expect(validation.ok).toBe(false);
    expect(validation.checks.find((check) => check.id === "vault_search.command_path.vault.search")?.status).toBe("error");
  });
});

describe("Calyx MCP vault-context tools", () => {
  test("searches, fetches, plans, and fetches a read-only context pack from a vault fixture", async () => {
    const vaultPath = await createVault({
      "40-context/source.md": [
        "---",
        "title: POL-1521 MCP source",
        "type: context",
        "---",
        "",
        "# POL-1521 MCP source",
        "",
        "This note carries Calyx MCP context connector evidence.",
        "",
      ].join("\n")
    });

    const search = await callCalyxMcpVaultContextToolV1("vault_search", {
      query: "Calyx MCP context connector",
      limit: 5
    }, { vaultPath });
    expect(search.ok).toBe(true);
    expect(search.markdown).toContain("vault://fieldwork/40-context/source.md");

    const fetch = await callCalyxMcpVaultContextToolV1("vault_fetch", {
      vault_uri: "vault://fieldwork/40-context/source.md",
      include_frontmatter: true
    }, { vaultPath });
    expect(fetch.ok).toBe(true);
    expect(fetch.markdown).toContain("This note carries Calyx MCP context connector evidence.");

    const plan = await callCalyxMcpVaultContextToolV1("context_plan", {
      goal: "Build MCP context connector context.",
      seeds: ["vault://fieldwork/40-context/source.md"]
    }, { vaultPath });
    expect(plan.ok).toBe(true);
    const planEnvelope = (plan.data?.envelope ?? {}) as CtxpackOutputEnvelopeV1;
    expect(planEnvelope.ok).toBe(true);
    if (!planEnvelope.ok) {
      return;
    }
    const planHash = (planEnvelope.data as CtxpackPlanResponseDataV1).plan_hash;
    expect(planHash).toBeTruthy();

    const pack = await callCalyxMcpVaultContextToolV1("context_fetch_pack", {
      plan_hash: planHash,
      goal: "Build MCP context connector context.",
      seeds: ["vault://fieldwork/40-context/source.md"]
    }, { vaultPath });
    expect(pack.ok).toBe(true);
    expect(pack.sources?.[0]?.vault_uri).toBe("vault://fieldwork/40-context/source.md");
    expect(pack.markdown).toContain("This note carries Calyx MCP context connector evidence.");
  });

  test("does not let tool arguments override the server-selected vault root", async () => {
    const vaultPath = await createVault({
      "40-context/source.md": "# Source\nAuthoritative server vault.\n"
    });
    const decoyVaultPath = await createVault({
      "40-context/source.md": "# Source\nDecoy vault override.\n"
    });

    const result = await callCalyxMcpVaultContextToolV1("vault_fetch", {
      vault_uri: "vault://fieldwork/40-context/source.md",
      vault_path: decoyVaultPath
    }, { vaultPath });

    expect(result.ok).toBe(true);
    expect(result.markdown).toContain("Authoritative server vault.");
    expect(result.markdown).not.toContain("Decoy vault override.");
  });

  test("indexes and fetches journal entries through read-only MCP tools", async () => {
    const vaultPath = await createVault({
      "90-meta/meta-log.md": [
        "# Meta Log",
        "",
        "> Entry format. Newest at the top.",
        "",
        "## 2026-06-12 -- Journal shipped",
        "",
        "Journal body.",
        "",
      ].join("\n")
    });

    const entries = await callCalyxMcpVaultContextToolV1("vault_journal_entries", {
      vault_uri: "vault://fieldwork/90-meta/meta-log.md",
      last: 5
    }, { vaultPath });
    expect(entries.ok).toBe(true);
    expect(entries.markdown).toContain("2026-06-12/journal-shipped");

    const get = await callCalyxMcpVaultContextToolV1("vault_journal_get", {
      vault_uri: "vault://fieldwork/90-meta/meta-log.md",
      key: "2026-06-12/journal-shipped"
    }, { vaultPath });
    expect(get.ok).toBe(true);
    expect(get.markdown).toContain("Journal body.");
  });

  test("rejects file path seeds at the MCP boundary", async () => {
    const result = await callCalyxMcpVaultContextToolV1("context_plan", {
      goal: "Do not read files through the vault-context MCP boundary.",
      seeds: ["README.md"]
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("File path seed rejected");
  });
});
