import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CtxpackPlanResponseDataV1 } from "../types";
import { runCtxpackContractStubV1, runCtxpackContractV1, stableStringifyCtxpackV1 } from "../index";

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-context-plan-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

async function createEmptyPathDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "calyx-empty-path-"));
}

describe("ctxpack plan primitive", () => {
  test("small workspace plan is deterministic and within budget", async () => {
    const workspace = await createWorkspace({
      "src/index.ts": "export const value = 1;\n",
      "docs/readme.md": "# Small fixture\n"
    });

    try {
      const request = {
        roots: [workspace],
        include: ["src/**", "docs/**"],
        include_git_meta: false,
        budget: { max_bytes: 50_000, max_tokens: 20_000 }
      };

      const first = runCtxpackContractStubV1("plan", request);
      const second = runCtxpackContractStubV1("plan", request);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(stableStringifyCtxpackV1(first)).toBe(stableStringifyCtxpackV1(second));
      if (first.ok && second.ok) {
        expect(first.determinism.plan_hash).toBe(second.determinism.plan_hash);
        const data = first.data as CtxpackPlanResponseDataV1;
        expect(data.files.selected).toHaveLength(2);
        expect(data.budget.within_budget).toBe(true);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("large workspace emits truncation preflight reason codes", async () => {
    const fileMap: Record<string, string> = {};
    for (let index = 0; index < 80; index += 1) {
      fileMap[`src/segment-${String(index).padStart(3, "0")}.txt`] = "x".repeat(400);
    }
    const workspace = await createWorkspace(fileMap);

    try {
      const result = runCtxpackContractStubV1("plan", {
        roots: [workspace],
        include: ["src/**"],
        include_git_meta: false,
        budget: { max_bytes: 8_000, max_tokens: 2_000 }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.budget.within_budget).toBe(false);
      expect(data.budget.truncation_candidates.length).toBeGreaterThan(0);
      expect(
        data.budget.truncation_candidates.some(
          (entry) =>
            entry.reason_code === "budget_bytes_exceeded" ||
            entry.reason_code === "budget_bytes_and_tokens_exceeded"
        )
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reports no-git scenario without failing plan", async () => {
    const workspace = await createWorkspace({
      "src/main.ts": "console.log('hello');\n"
    });

    try {
      const result = runCtxpackContractStubV1("plan", {
        roots: [workspace],
        include: ["src/**"],
        include_git_meta: true
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.git_meta.detected).toBe(false);
      expect(data.git_meta.reason_code).toBe("git_repo_not_detected");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("returns not_found for missing requested roots", () => {
    const result = runCtxpackContractStubV1("plan", {
      roots: ["/tmp/calyx-context-plan-missing-root-fixture"],
      include_git_meta: false
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.exit_code).toBe(3);
    }
  });

  test("chatgpt-web plan resolves a vault uri seed into a provenance-rich source graph", async () => {
    const vaultPath = await createWorkspace({
      "40-context/source.md": [
        "---",
        "title: Source Note",
        "issue: POL-1514",
        "---",
        "# Source Note",
        "POL-1514 oracle decomposition context."
      ].join("\n")
    });

    try {
      const result = await runCtxpackContractV1("plan", {
        goal: "Prepare ChatGPT web context for POL-1514",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        budget: { max_bytes: 50_000 }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.profile).toBe("chatgpt-web");
      expect(data.plan_hash).toBe(result.determinism.plan_hash);
      expect(data.apply_command).toContain("calyx context pack");
      expect(data.apply_command).toContain("--plan-hash");
      expect(data.source_graph?.nodes).toHaveLength(1);
      expect(data.source_graph?.nodes[0]?.vault_uri).toBe("vault://fieldwork/40-context/source.md");
      expect(data.source_graph?.nodes[0]?.trust?.untrustedSourceContent).toBe(true);
      expect(data.files.selected).toHaveLength(0);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web query seed records selected and omitted vault candidates", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 7; index += 1) {
      files[`40-context/pol-1514-${index}.md`] = `# Candidate ${index}\nPOL-1514 oracle decomposition.\n`;
    }
    const vaultPath = await createWorkspace(files);

    try {
      const result = await runCtxpackContractV1("plan", {
        goal: "Gather POL-1514 notes",
        profile: "chatgpt-web",
        seeds: ["POL-1514 oracle decomposition"],
        vault_path: vaultPath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes.length).toBe(5);
      expect(data.vault_candidates?.selected.length).toBe(5);
      expect(data.vault_candidates?.omitted_count).toBeGreaterThanOrEqual(2);
      expect(data.source_graph?.seeds[0]?.source_type).toBe("vault_query");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web query seed has deterministic fallback when rg is unavailable", async () => {
    const vaultPath = await createWorkspace({
      "40-context/fallback.md": "# Fallback\nPOL-1514 fallback search evidence.\n"
    });
    const emptyPath = await createEmptyPathDir();
    const priorPath = process.env["PATH"];

    try {
      process.env["PATH"] = emptyPath;
      const result = await runCtxpackContractV1("plan", {
        goal: "Gather fallback note",
        profile: "chatgpt-web",
        seeds: ["POL-1514 fallback search evidence"],
        vault_path: vaultPath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(1);
      expect(data.source_graph?.nodes[0]?.vault_uri).toBe("vault://fieldwork/40-context/fallback.md");
      expect(data.source_graph?.warnings.map((warning) => warning.code)).toContain("vault_search_fallback_used");
      expect(data.source_graph?.seeds[0]?.warnings.map((warning) => warning.code)).toContain(
        "vault_search_fallback_used"
      );
    } finally {
      if (priorPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = priorPath;
      }
      await rm(emptyPath, { recursive: true, force: true });
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web fallback query seed reports incomplete oversized-file coverage", async () => {
    const vaultPath = await createWorkspace({
      "40-context/oversized.md": `# Oversized\n${"x".repeat(260_000)}\n`
    });
    const emptyPath = await createEmptyPathDir();
    const priorPath = process.env["PATH"];

    try {
      process.env["PATH"] = emptyPath;
      const result = await runCtxpackContractV1("plan", {
        goal: "Gather fallback note",
        profile: "chatgpt-web",
        seeds: ["POL-1514 oversized marker"],
        vault_path: vaultPath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(0);
      expect(data.source_graph?.seeds[0]?.status).toBe("omitted");
      expect(data.source_graph?.seeds[0]?.reason).toContain("incomplete");
      expect(data.source_graph?.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(["vault_search_fallback_used", "vault_search_fallback_incomplete"])
      );
      expect(data.source_graph?.omitted[0]?.reason_code).toBe("candidate_limit_exceeded");
      expect(data.vault_candidates?.omitted_count).toBeGreaterThanOrEqual(1);
    } finally {
      if (priorPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = priorPath;
      }
      await rm(emptyPath, { recursive: true, force: true });
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web plan reports unsupported activity seeds without failing", async () => {
    const vaultPath = await createWorkspace({});

    try {
      const result = await runCtxpackContractV1("plan", {
        goal: "Unsupported seed check",
        profile: "chatgpt-web",
        seeds: ["run:abc123"],
        vault_path: vaultPath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(0);
      expect(data.source_graph?.warnings[0]?.code).toBe("unsupported_seed_type");
      expect(data.source_graph?.seeds[0]?.status).toBe("unsupported");
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web query seed with no matches is an empty bounded plan, not an error", async () => {
    const vaultPath = await createWorkspace({
      "40-context/other.md": "# Other\nNo relevant marker here.\n"
    });

    try {
      const result = await runCtxpackContractV1("plan", {
        goal: "No match query",
        profile: "chatgpt-web",
        seeds: ["POL-DOES-NOT-EXIST"],
        vault_path: vaultPath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(0);
      expect(data.source_graph?.seeds[0]?.source_type).toBe("vault_query");
      expect(data.source_graph?.seeds[0]?.status).toBe("omitted");
      expect(data.source_graph?.warnings.map((warning) => warning.code)).not.toContain(
        "vault_search_fallback_incomplete"
      );
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web plan materializes explicit markdown file seeds as file refs", async () => {
    const workspace = await createWorkspace({
      "notes/local.md": "# Local\nExplicit local markdown seed.\n"
    });
    const prior = process.cwd();

    try {
      process.chdir(workspace);
      const result = await runCtxpackContractV1("plan", {
        goal: "File seed check",
        profile: "chatgpt-web",
        seeds: ["./notes/local.md"]
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes[0]?.source_type).toBe("file_ref");
      expect(data.source_graph?.nodes[0]?.relative_path).toBe("notes/local.md");
    } finally {
      process.chdir(prior);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("chatgpt-web plan rejects large explicit file seeds before reading them", async () => {
    const workspace = await createWorkspace({
      "notes/large.md": "x".repeat(260_000)
    });
    const prior = process.cwd();

    try {
      process.chdir(workspace);
      const result = await runCtxpackContractV1("plan", {
        goal: "Large file seed check",
        profile: "chatgpt-web",
        seeds: ["./notes/large.md"]
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(0);
      expect(data.source_graph?.seeds[0]?.status).toBe("error");
      expect(data.source_graph?.warnings[0]?.message).toContain("exceeds maximum source size");
    } finally {
      process.chdir(prior);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("chatgpt-web plan hash replays when exclude is supplied without roots or include", async () => {
    const vaultPath = await createWorkspace({
      "40-context/source.md": "# Source\nPOL-1518 exclude replay.\n"
    });
    const prior = process.cwd();

    try {
      process.chdir(vaultPath);
      const plan = await runCtxpackContractV1("plan", {
        goal: "Exclude replay",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        exclude: ["tmp/**"]
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) {
        return;
      }
      const planData = plan.data as CtxpackPlanResponseDataV1;
      const pack = await runCtxpackContractV1("pack", {
        goal: "Exclude replay",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/source.md"],
        vault_path: vaultPath,
        exclude: ["tmp/**"],
        plan_hash: planData.plan_hash
      });
      expect(pack.ok).toBe(true);
    } finally {
      process.chdir(prior);
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  test("chatgpt-web plan omits source graph nodes that exceed budget", async () => {
    const vaultPath = await createWorkspace({
      "40-context/large.md": `# Large\n${"x".repeat(200)}\n`
    });

    try {
      const result = await runCtxpackContractV1("plan", {
        goal: "Budget check",
        profile: "chatgpt-web",
        seeds: ["vault://fieldwork/40-context/large.md"],
        vault_path: vaultPath,
        budget: { max_bytes: 20 }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const data = result.data as CtxpackPlanResponseDataV1;
      expect(data.source_graph?.nodes).toHaveLength(0);
      expect(data.source_graph?.omitted[0]?.reason_code).toBe("budget_bytes_exceeded");
      expect(data.source_graph?.warnings.some((warning) => warning.code === "source_budget_exceeded")).toBe(true);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
