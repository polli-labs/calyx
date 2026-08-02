import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CtxpackPackResponseDataV1, CtxpackPlanResponseDataV1 } from "../types";
import { runCtxpackContractStubV1, runCtxpackContractV1, stableStringifyCtxpackV1 } from "../index";

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-context-pack-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

async function withinWorkspace<T>(workspace: string, run: () => Promise<T> | T): Promise<T> {
  const prior = process.cwd();
  process.chdir(workspace);
  try {
    return await run();
  } finally {
    process.chdir(prior);
  }
}

describe("ctxpack pack primitive", () => {
  test("preview mode is deterministic and emits redaction + truncation receipts", async () => {
    const workspace = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "src/secrets.env": "API_KEY=sk-this-looks-like-a-real-key-1234567890\n",
      "docs/readme.md": "# fixture\n"
    });

    try {
      const [first, second] = await withinWorkspace(workspace, async () => {
        const request = {
          include: ["src/**", "docs/**"],
          redaction_mode: "strict" as const
        };
        return [
          runCtxpackContractStubV1("pack", request),
          runCtxpackContractStubV1("pack", request)
        ];
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(stableStringifyCtxpackV1(first)).toBe(stableStringifyCtxpackV1(second));

      if (!first.ok || !second.ok) {
        return;
      }

      const data = first.data as CtxpackPackResponseDataV1;
      expect(data.manifest.length).toBe(3);
      expect(data.redaction.redacted_files).toBeGreaterThan(0);
      expect(data.redaction.entries.some((entry) => entry.path === "src/secrets.env")).toBe(true);
      expect(data.truncation.reason_counters.sessions_opted_out).toBe(1);
      expect(first.determinism.plan_hash).toBe(second.determinism.plan_hash);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("apply mode writes bundle manifest, summary, and redacted file payloads", async () => {
    const workspace = await createWorkspace({
      "src/secrets.env": "TOKEN=ghp_123456789012345678901234567890123456\n",
      "src/plain.txt": "plain text\n"
    });
    const outDir = path.join(workspace, ".tmp-pack-output");

    try {
      const result = await withinWorkspace(workspace, async () =>
        runCtxpackContractStubV1("pack", {
          include: ["src/**"],
          redaction_mode: "strict",
          apply: true,
          out_dir: outDir
        })
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const data = result.data as CtxpackPackResponseDataV1;
      expect(data.apply).toBe(true);

      const manifestRaw = await readFile(path.join(outDir, "bundle.manifest.json"), "utf8");
      const summaryRaw = await readFile(path.join(outDir, "bundle.summary.json"), "utf8");
      expect(manifestRaw).toContain("\"pack_version\": \"ctxpack.pack.v1\"");
      expect(summaryRaw).toContain("\"redacted_files\":");

      const redactedOutput = await readFile(path.join(outDir, "files", "_root", "src", "secrets.env"), "utf8");
      expect(redactedOutput).toContain("[ctxpack-redacted:strict:");
      expect(redactedOutput).not.toContain("ghp_123456789012345678901234567890123456");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("returns validation_error when supplied plan_hash does not match computed hash", async () => {
    const workspace = await createWorkspace({
      "src/index.ts": "export const value = 1;\n"
    });

    try {
      const result = await withinWorkspace(workspace, async () =>
        runCtxpackContractStubV1("pack", {
          include: ["src/**"],
          plan_hash: "intentional-mismatch"
        })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("validation_error");
        expect(result.error.exit_code).toBe(2);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("chatgpt-web apply requires and validates a source graph plan hash", async () => {
    const vaultPath = await createWorkspace({
      "40-context/source.md": "# Source\nPOL-1518 context planner.\n"
    });
    const outDir = path.join(vaultPath, ".ctxpack-chatgpt");

    try {
      const noHash = await runCtxpackContractV1("pack", {
        goal: "Prepare ChatGPT web context",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        apply: true,
        out_dir: outDir
      });
      expect(noHash.ok).toBe(false);
      if (!noHash.ok) {
        expect(noHash.error.code).toBe("validation_error");
      }

      const plan = await runCtxpackContractV1("plan", {
        goal: "Prepare ChatGPT web context",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) {
        return;
      }

      const planData = plan.data as CtxpackPlanResponseDataV1;
      const mismatch = await runCtxpackContractV1("pack", {
        goal: "Prepare ChatGPT web context",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        apply: true,
        out_dir: outDir,
        plan_hash: "wrong-hash"
      });
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) {
        expect(mismatch.error.code).toBe("validation_error");
      }

      const packed = await runCtxpackContractV1("pack", {
        goal: "Prepare ChatGPT web context",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        apply: true,
        out_dir: outDir,
        plan_hash: planData.plan_hash
      });
      expect(packed.ok).toBe(true);
      if (!packed.ok) {
        return;
      }

      const data = packed.data as CtxpackPackResponseDataV1;
      expect(data.profile).toBe("chatgpt-web");
      expect(data.plan_hash).toBe(planData.plan_hash);
      expect(data.source_graph?.nodes).toHaveLength(1);
      expect(data.manifest[0]?.vault_uri).toBe("vault://fieldwork/40-context/source.md");
      expect(data.docs_path).toBe(path.join(outDir, "bundle.docs.md"));

      const manifestRaw = await readFile(path.join(outDir, "bundle.manifest.json"), "utf8");
      const docsRaw = await readFile(path.join(outDir, "bundle.docs.md"), "utf8");
      const packedSource = await readFile(path.join(outDir, "files", "vault", "40-context", "source.md"), "utf8");
      expect(manifestRaw).toContain("\"source_graph\"");
      expect(docsRaw).toContain("ChatGPT-Web Context Pack");
      expect(packedSource).toContain("POL-1518 context planner");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
