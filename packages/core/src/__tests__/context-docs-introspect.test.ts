import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type {
  CtxpackDocsResponseDataV1,
  CtxpackIntrospectResponseDataV1,
  CtxpackPackResponseDataV1,
  CtxpackPlanResponseDataV1
} from "../types";
import { runCtxpackContractStubV1, runCtxpackContractV1, stableStringifyCtxpackV1 } from "../index";

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-context-docs-"));
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

describe("ctxpack docs + introspect primitives", () => {
  test("docs renders deterministic markdown + json from bundle receipts only", async () => {
    const workspace = await createWorkspace({
      "src/secrets.env": "TOKEN=ghp_123456789012345678901234567890123456\n",
      "src/plain.txt": "plain text\n",
      "docs/readme.md": "# fixture\n"
    });
    const outDir = path.join(workspace, ".ctxpack-out");

    try {
      const pack = await withinWorkspace(workspace, async () =>
        runCtxpackContractStubV1("pack", {
          include: ["src/**", "docs/**"],
          redaction_mode: "strict",
          apply: true,
          out_dir: outDir
        })
      );
      expect(pack.ok).toBe(true);
      if (!pack.ok) {
        return;
      }

      const packData = pack.data as CtxpackPackResponseDataV1;
      const [markdownFirst, markdownSecond, jsonResult, topicResult] = await withinWorkspace(workspace, async () => [
        runCtxpackContractStubV1("docs", {
          bundle_path: outDir,
          format: "markdown"
        }),
        runCtxpackContractStubV1("docs", {
          bundle_path: outDir,
          format: "markdown"
        }),
        runCtxpackContractStubV1("docs", {
          bundle_path: outDir,
          format: "json"
        }),
        runCtxpackContractStubV1("docs", {
          bundle_path: outDir,
          format: "json",
          topic: "redaction"
        })
      ]);

      expect(markdownFirst.ok).toBe(true);
      expect(markdownSecond.ok).toBe(true);
      expect(jsonResult.ok).toBe(true);
      expect(topicResult.ok).toBe(true);
      expect(stableStringifyCtxpackV1(markdownFirst)).toBe(stableStringifyCtxpackV1(markdownSecond));

      if (!markdownFirst.ok || !jsonResult.ok || !topicResult.ok) {
        return;
      }

      const markdownData = markdownFirst.data as CtxpackDocsResponseDataV1;
      const jsonData = jsonResult.data as CtxpackDocsResponseDataV1;
      const topicData = topicResult.data as CtxpackDocsResponseDataV1;

      expect(markdownData.format).toBe("markdown");
      expect(markdownData.markdown).toContain("## Bundle");
      expect(markdownData.markdown).toContain("## Redaction");
      expect(markdownData.plan_hash).toBe(packData.plan_hash);
      expect(jsonData.format).toBe("json");
      expect(jsonData.sections.length).toBeGreaterThan(1);
      expect(topicData.sections).toHaveLength(1);
      expect(topicData.sections[0]?.id).toBe("redaction");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("introspect is gated by --enable-experimental and returns deterministic metrics when enabled", async () => {
    const workspace = await createWorkspace({
      "src/secrets.env": "API_KEY=sk-this-looks-like-a-real-key-1234567890\n",
      "src/plain.ts": "export const value = 1;\n",
      "docs/readme.md": "# fixture\n"
    });
    const outDir = path.join(workspace, ".ctxpack-out");

    try {
      const pack = await withinWorkspace(workspace, async () =>
        runCtxpackContractStubV1("pack", {
          include: ["src/**", "docs/**"],
          redaction_mode: "strict",
          apply: true,
          out_dir: outDir
        })
      );
      expect(pack.ok).toBe(true);

      const disabled = await withinWorkspace(workspace, async () =>
        runCtxpackContractStubV1("introspect", {
          bundle_path: outDir
        })
      );
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) {
        expect(disabled.error.code).toBe("capability_unavailable");
        expect(disabled.error.exit_code).toBe(4);
      }

      const [enabledFirst, enabledSecond, rootsTarget] = await withinWorkspace(workspace, async () => [
        runCtxpackContractStubV1("introspect", {
          bundle_path: outDir,
          enable_experimental: true
        }),
        runCtxpackContractStubV1("introspect", {
          bundle_path: outDir,
          enable_experimental: true
        }),
        runCtxpackContractStubV1("introspect", {
          bundle_path: outDir,
          enable_experimental: true,
          target: "roots"
        })
      ]);

      expect(enabledFirst.ok).toBe(true);
      expect(enabledSecond.ok).toBe(true);
      expect(rootsTarget.ok).toBe(true);
      expect(stableStringifyCtxpackV1(enabledFirst)).toBe(stableStringifyCtxpackV1(enabledSecond));

      if (!enabledFirst.ok || !rootsTarget.ok) {
        return;
      }

      const metrics = (enabledFirst.data as CtxpackIntrospectResponseDataV1).metrics;
      const rootsMetrics = (rootsTarget.data as CtxpackIntrospectResponseDataV1).metrics;

      expect(metrics.files_total).toBe(3);
      expect(metrics.redacted_files).toBeGreaterThanOrEqual(1);
      expect(metrics.extensions.some((entry) => entry.key === ".md")).toBe(true);
      expect(rootsMetrics.extensions).toEqual([]);
      expect(rootsMetrics.roots.length).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("docs render chatgpt-web source graph provenance from bundle receipts", async () => {
    const vaultPath = await createWorkspace({
      "40-context/source.md": "# Source\nPOL-1518 source graph docs.\n"
    });
    const outDir = path.join(vaultPath, ".ctxpack-chatgpt");

    try {
      const plan = await runCtxpackContractV1("plan", {
        goal: "Render ChatGPT web docs",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) {
        return;
      }
      const planHash = (plan.data as CtxpackPlanResponseDataV1).plan_hash;
      const pack = await runCtxpackContractV1("pack", {
        goal: "Render ChatGPT web docs",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        plan_hash: planHash,
        out_dir: outDir,
        apply: true
      });
      expect(pack.ok).toBe(true);

      const docs = await runCtxpackContractV1("docs", {
        bundle_path: outDir,
        format: "markdown"
      });
      expect(docs.ok).toBe(true);
      if (!docs.ok) {
        return;
      }
      const data = docs.data as CtxpackDocsResponseDataV1;
      expect(data.sections.some((section) => section.id === "profile")).toBe(true);
      expect(data.sections.some((section) => section.id === "sources")).toBe(true);
      expect(data.markdown).toContain("## Sources");
      expect(data.markdown).toContain("vault://fieldwork/40-context/source.md");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
