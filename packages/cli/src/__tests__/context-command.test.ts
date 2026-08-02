import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CtxpackOutputEnvelopeV1, CtxpackPackResponseDataV1, CtxpackPlanResponseDataV1 } from "@polli-labs/calyx-core";
import { buildProgram } from "../run-cli";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-context-command-"));
  tempDirs.push(root);
  const vaultPath = path.join(root, "vault");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(vaultPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return vaultPath;
}

describe("calyx context command", () => {
  test("plans, packs, and renders docs for chatgpt-web vault seeds", async () => {
    const vaultPath = await createVault({
      "40-context/source.md": "# Source\nPOL-1518 CLI smoke.\n"
    });
    const outDir = path.join(path.dirname(vaultPath), "ctxpack-out");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    const planProgram = buildProgram();
    await planProgram.parseAsync([
      "node",
      "calyx",
      "context",
      "plan",
      "--goal",
      "CLI smoke",
      "--profile",
      "chatgpt-web",
      "--seed",
      "vault://fieldwork/40-context/source.md",
      "--vault-path",
      vaultPath,
      "--json"
    ]);

    const planEnvelope = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as CtxpackOutputEnvelopeV1;
    expect(planEnvelope.ok).toBe(true);
    if (!planEnvelope.ok) {
      return;
    }
    const planData = planEnvelope.data as CtxpackPlanResponseDataV1;
    expect(planData.profile).toBe("chatgpt-web");
    expect(planData.source_graph?.nodes[0]?.vault_uri).toBe("vault://fieldwork/40-context/source.md");

    const packProgram = buildProgram();
    await packProgram.parseAsync([
      "node",
      "calyx",
      "context",
      "pack",
      "--goal",
      "CLI smoke",
      "--profile",
      "chatgpt-web",
      "--seed",
      "vault://fieldwork/40-context/source.md",
      "--vault-path",
      vaultPath,
      "--plan-hash",
      planData.plan_hash ?? "",
      "--out-dir",
      outDir,
      "--apply",
      "--json"
    ]);
    const packEnvelope = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as CtxpackOutputEnvelopeV1;
    expect(packEnvelope.ok).toBe(true);
    if (!packEnvelope.ok) {
      return;
    }
    const packData = packEnvelope.data as CtxpackPackResponseDataV1;
    expect(packData.docs_path).toBe(path.join(outDir, "bundle.docs.md"));

    const docsProgram = buildProgram();
    await docsProgram.parseAsync([
      "node",
      "calyx",
      "context",
      "docs",
      "--bundle-path",
      outDir,
      "--format",
      "markdown",
      "--json"
    ]);
    const docsEnvelope = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as CtxpackOutputEnvelopeV1;
    expect(docsEnvelope.ok).toBe(true);
    const docsText = await readFile(path.join(outDir, "bundle.docs.md"), "utf8");
    expect(docsText).toContain("ChatGPT-Web Context Pack");
  });
});
