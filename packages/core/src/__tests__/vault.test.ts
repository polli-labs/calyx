import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadStateDriver } from "../state/driver";
import {
  fetchVaultArtifact,
  getVaultFrontmatter,
  getVaultSection,
  getVaultStatus,
  getVaultTableOfContents,
  putVaultArtifact,
  queryVaultFrontmatter,
  relatedVaultArtifacts,
  searchVault,
} from "../vault";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempVault(): Promise<{ root: string; vaultPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-test-"));
  tempDirs.push(root);
  const vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });
  return { root, vaultPath };
}

describe("vault domain", () => {
  test("toc returns stable heading ids, byte spans, and section hashes for a markdown note", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = path.join(vaultPath, "50-projects", "calyx", "workstreams", "lane.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "---",
        "type: workstream",
        "project: calyx",
        "---",
        "",
        "# Overview",
        "",
        "Opening.",
        "",
        "## Current Plan",
        "",
        "Focus lane.",
        "",
        "### Step",
        "",
        "Nested detail.",
        "",
        "## Current Plan",
        "",
        "Second duplicate.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await getVaultTableOfContents("50-projects/calyx/workstreams/lane.md", { vaultPath });

    expect(result.uri).toBe("vault://fieldwork/50-projects/calyx/workstreams/lane.md");
    expect(result.headings.map((heading) => heading.id)).toEqual([
      "overview",
      "current-plan",
      "step",
      "current-plan-2",
    ]);
    expect(result.headings[1]).toMatchObject({
      level: 2,
      text: "Current Plan",
      line_start: 10,
    });
    expect(result.headings[1]?.byte_start).toBeLessThan(result.headings[1]?.byte_end ?? 0);
    expect(result.headings[1]?.section_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("toc and section ignore frontmatter lines that look like headings and redact secret-like section lines", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = path.join(vaultPath, "30-reports", "annotated.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "---",
        "type: report",
        "# yaml comment line",
        "project: calyx",
        "---",
        "",
        "# Real Heading",
        "",
        "api_key: abc123",
        "Body stays readable.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await getVaultTableOfContents("30-reports/annotated.md", { vaultPath });
    expect(result.headings.map((heading) => heading.text)).toEqual(["Real Heading"]);

    const section = await getVaultSection("30-reports/annotated.md", { heading: "real-heading", vaultPath });
    expect(section.content).toContain("# Real Heading");
    expect(section.content).toContain("Body stays readable.");
    expect(section.content).toContain("api_key: <redacted>");
    expect(section.content).not.toContain("abc123");
  });

  test("section get returns a bounded heading section with truncation facts", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = path.join(vaultPath, "50-projects", "calyx", "README.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "# Calyx",
        "",
        "Intro.",
        "",
        "## Current Plan",
        "",
        "First paragraph stays visible.",
        "",
        "### Nested",
        "",
        "Nested detail stays inside the parent section.",
        "",
        "## Later",
        "",
        "Not included.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await getVaultSection("vault://fieldwork/50-projects/calyx/README.md", {
      heading: "current-plan",
      maxChars: 49,
      vaultPath,
    });

    expect(result.heading).toMatchObject({ id: "current-plan", text: "Current Plan", level: 2 });
    expect(result.content).toBe("## Current Plan\n\nFirst paragraph stays visible.\n\n");
    expect(result.truncation).toEqual({
      truncated: true,
      max_chars: 49,
      original_chars: expect.any(Number),
    });
    expect(result.content).not.toContain("## Later");
    expect(result.section_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("frontmatter get returns parsed metadata with source provenance", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = path.join(vaultPath, "30-reports", "refresh.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "---",
        "type: report",
        "project: calyx",
        "tags: [vault, knowledge]",
        "api_token: should-not-leak",
        "---",
        "",
        "# Refresh",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await getVaultFrontmatter("30-reports/refresh.md", { vaultPath });

    expect(result.uri).toBe("vault://fieldwork/30-reports/refresh.md");
    expect(result.frontmatter).toMatchObject({
      type: "report",
      project: "calyx",
      tags: ["vault", "knowledge"],
      api_token: "<redacted>",
    });
    expect(result.frontmatter_span).toMatchObject({ byte_start: 0 });
    expect(result.frontmatter_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("frontmatter query filters local vault notes with deterministic provenance rows", async () => {
    const { vaultPath } = await createTempVault();
    const workstreams = path.join(vaultPath, "50-projects", "calyx", "workstreams");
    await mkdir(workstreams, { recursive: true });
    await writeFile(
      path.join(workstreams, "focus.md"),
      [
        "---",
        "type: workstream",
        "project: calyx",
        "attention: focus",
        "api_key: abc123",
        "---",
        "# Focus",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workstreams, "later.md"),
      [
        "---",
        "type: workstream",
        "project: calyx",
        "attention: later",
        "---",
        "# Later",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await queryVaultFrontmatter({
      type: "workstream",
      where: 'attention == "focus"',
      vaultPath,
      limit: 10,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      uri: "vault://fieldwork/50-projects/calyx/workstreams/focus.md",
      relative_path: "50-projects/calyx/workstreams/focus.md",
      frontmatter: {
        type: "workstream",
        attention: "focus",
        api_key: "<redacted>",
      },
      matched_fields: [
        { field: "type", operator: "==", expected: "workstream", actual: "workstream" },
        { field: "attention", operator: "==", expected: "focus", actual: "focus" },
      ],
    });
    expect(result.truncated).toBe(false);
    expect(result.rows[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("frontmatter query skips poisoned notes and reports a per-file warning", async () => {
    const { vaultPath } = await createTempVault();
    const notesDir = path.join(vaultPath, "30-reports");
    await mkdir(notesDir, { recursive: true });
    await writeFile(
      path.join(notesDir, "good.md"),
      "---\ntype: report\nproject: calyx\n---\n# Good\n",
      "utf8",
    );
    await writeFile(
      path.join(notesDir, "poisoned.md"),
      "---\n- not\n- a\n- mapping\n---\n# Poisoned\n",
      "utf8",
    );

    const result = await queryVaultFrontmatter({
      type: "report",
      vaultPath,
      limit: 10,
    });

    expect(result.rows.map((row) => row.relative_path)).toEqual(["30-reports/good.md"]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "frontmatter_query_file_skipped",
        message: expect.stringContaining("30-reports/poisoned.md"),
      }),
    ]);
  });

  test("put routes workstreams to the canonical semantic home in dry-run mode", async () => {
    const { vaultPath } = await createTempVault();

    const result = await putVaultArtifact(
      {
        type: "workstream",
        title: "Run substrate and agents infra",
        project: "calyx",
        workstream: "run-substrate-and-agents-infra",
        assignee: "codex:blade:test-session",
        updated: "2026-03-13T23:59:59Z",
        updatedBy: "codex:blade:test-session",
        dryRun: true,
        vaultPath,
      },
      {
        env: { HOME: path.dirname(vaultPath), USER: "caleb" },
        hostnameImpl: () => "blade.example",
      },
    );

    expect(result.relativePath).toBe("50-projects/calyx/workstreams/run-substrate-and-agents-infra.md");
    expect(result.type).toBe("workstream");
    expect(result.content).toContain("type: workstream");
    expect(result.content).toContain("project: calyx");
    expect(result.content).toContain("workstream: run-substrate-and-agents-infra");
    expect(result.content).toContain("assignee: codex:blade:test-session");
    expect(result.content).toContain("updated_by: codex:blade:test-session");
  });

  test("put writes daily artifacts and posts a best-effort Linear backlink", async () => {
    const { vaultPath } = await createTempVault();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        text: async () => JSON.stringify({ data: { issue: { id: "issue-1", identifier: "POL-815" } } }),
      })
      .mockResolvedValueOnce({
        text: async () => JSON.stringify({ data: { commentCreate: { success: true } } }),
      });

    const result = await putVaultArtifact(
      {
        daily: true,
        issue: "POL-815",
        title: "oracle-ctxpack",
        stdinText: "## Summary\n",
        vaultPath,
      },
      {
        env: {
          HOME: path.dirname(vaultPath),
          USER: "caleb",
          LINEAR_API_KEY: "test-linear-key",
          CODEX_SESSION_ID: "019cf773-d865-74b3-938e-b4193d7525de",
        },
        hostnameImpl: () => "blade",
        fetchImpl: fetchSpy as unknown as typeof fetch,
        now: new Date("2026-03-17T20:00:00Z"),
      },
    );

    expect(result.relativePath).toBe("10-daily/2026-03-17/pol-815-oracle-ctxpack.md");
    expect(result.backlink.status).toBe("posted");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const written = await readFile(result.outputPath, "utf8");
    expect(written).toContain("type: daily");
    expect(written).toContain("issue: POL-815");
    expect(written).toContain("author: codex:blade:019cf773-d865-74b3-938e-b4193d7525de");
    expect(written).toContain("## Summary");
  });

  test("put rejects project notes without a project slug", async () => {
    const { vaultPath } = await createTempVault();

    await expect(
      putVaultArtifact({
        type: "project",
        title: "Calyx",
        dryRun: true,
        vaultPath,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("--type project requires --project"),
      exitCode: 2,
    });
  });

  test("search scopes project/workstream queries through frontmatter-aware file discovery", async () => {
    const { vaultPath } = await createTempVault();
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `${path.join(vaultPath, "50-projects", "calyx", "workstreams", "lane.md")}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "match output\n",
        stderr: "",
      });

    const result = await searchVault(
      "reconcile",
      { type: "workstream", filesOnly: true, vaultPath },
      { spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync },
    );

    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      1,
      "rg",
      ["-l", "^type:\\s*workstream$", path.join(vaultPath, "50-projects"), "--glob", "*.md"],
      expect.any(Object),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("match output");
    expect(result.fileScope).toEqual([path.join(vaultPath, "50-projects", "calyx", "workstreams", "lane.md")]);
  });

  test("search reports unavailable semantic mode explicitly", async () => {
    const { vaultPath } = await createTempVault();

    const result = await searchVault("POL-1516", { mode: "semantic", vaultPath });

    expect(result.schema_version).toBe("calyx.vault.search/v1");
    expect(result.status).toBe(4);
    expect(result.matches).toEqual([]);
    expect(result.warnings?.[0]).toMatchObject({ code: "capability_unavailable" });
  });

  test("search falls back to bounded JavaScript literal scan when ripgrep is unavailable", async () => {
    const { vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    const notePath = path.join(vaultPath, "40-context", "fallback-source.md");
    await writeFile(notePath, "# Fallback Source\nNeedle survives without rg.\n", "utf8");
    const spawnSyncImpl = vi.fn().mockReturnValue({
      error: new Error("spawn rg ENOENT"),
      status: null,
      stdout: "",
      stderr: "",
    });

    const result = await searchVault(
      "Needle",
      { vaultPath },
      { spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync },
    );

    expect(result.status).toBe(0);
    expect(result.command[0]).toBe("js-fallback-search");
    const matches = result.matches ?? [];
    expect(matches[0]?.vaultUri).toBe("vault://fieldwork/40-context/fallback-source.md");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ripgrep_unavailable_fallback" }),
      ]),
    );
  });

  test("search structured matches ignore ripgrep context lines", async () => {
    const { vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    const notePath = path.join(vaultPath, "40-context", "search-source.md");
    await writeFile(notePath, "# Search Source\nBefore\nneedle\nAfter\n", "utf8");
    const spawnSyncImpl = vi.fn().mockReturnValue({
      status: 0,
      stdout: [
        `${notePath}-2-Before`,
        `${notePath}:3:needle`,
        `${notePath}-4-After`,
      ].join("\n"),
      stderr: "",
    });

    const result = await searchVault(
      "needle",
      { vaultPath },
      { spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches?.[0]).toMatchObject({
      vaultUri: "vault://fieldwork/40-context/search-source.md",
      lineNumbers: [3],
      matchCount: 1,
      snippet: "needle",
    });
  });

  test("fetch resolves stable vault URIs, bounds markdown, and annotates links", async () => {
    const { vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "40-context", "target-note.md"),
      "---\ntitle: Target Note\nissue: POL-1516\n---\n# Target Note\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultPath, "40-context", "source.md"),
      [
        "---",
        "title: Source Note",
        "issue: POL-1516",
        "---",
        "# Source Note",
        "This note points to [[target-note]].",
        "secret_token: should-not-leak",
        "Extra context that should be truncated by the byte bound.",
      ].join("\n"),
      "utf8",
    );

    const result = await fetchVaultArtifact("vault://fieldwork/40-context/source.md", {
      vaultPath,
      maxBytes: 96,
      withFrontmatter: true,
      withLinks: true,
    });

    expect(result.schema_version).toBe("calyx.vault.fetch/v1");
    expect(result.vaultUri).toBe("vault://fieldwork/40-context/source.md");
    expect(result.relativePath).toBe("40-context/source.md");
    expect(result.frontmatter).toMatchObject({ issue: "POL-1516", title: "Source Note" });
    expect(result.bytes.truncated).toBe(true);
    expect(result.text).not.toContain("should-not-leak");
    expect(result.links?.outbound[0]).toMatchObject({
      kind: "wikilink",
      target: "target-note",
      resolvedVaultUri: "vault://fieldwork/40-context/target-note.md",
    });
    expect(result.trust.untrustedSourceContent).toBe(true);
  });

  test("fetch rejects paths outside the vault", async () => {
    const { root, vaultPath } = await createTempVault();
    const outsidePath = path.join(root, "outside.md");
    await writeFile(outsidePath, "# outside\n", "utf8");

    await expect(fetchVaultArtifact(outsidePath, { vaultPath })).rejects.toMatchObject({
      message: expect.stringContaining("refuses to read outside the vault"),
      exitCode: 2,
    });
  });

  test("fetch rejects in-vault symlinks that resolve outside the vault", async () => {
    const { root, vaultPath } = await createTempVault();
    const outsidePath = path.join(root, "outside.md");
    const linkPath = path.join(vaultPath, "40-context", "evil.md");
    await mkdir(path.dirname(linkPath), { recursive: true });
    await writeFile(outsidePath, "# outside\n", "utf8");
    await symlink(outsidePath, linkPath);

    await expect(fetchVaultArtifact("40-context/evil.md", { vaultPath })).rejects.toMatchObject({
      message: expect.stringContaining("refuses to read outside the vault"),
      exitCode: 2,
    });
  });

  test("fetch allows in-vault symlinks that resolve inside the vault", async () => {
    const { vaultPath } = await createTempVault();
    const targetPath = path.join(vaultPath, "40-context", "target.md");
    const linkPath = path.join(vaultPath, "40-context", "alias.md");
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, "# Target\ninside vault\n", "utf8");
    await symlink(targetPath, linkPath);

    const result = await fetchVaultArtifact("40-context/alias.md", { vaultPath });

    expect(result.relativePath).toBe("40-context/alias.md");
    expect(result.vaultUri).toBe("vault://fieldwork/40-context/alias.md");
    expect(result.text).toContain("inside vault");
  });

  test("fetch reports dangling in-vault symlinks as structured not-found, not raw ENOENT", async () => {
    const { vaultPath } = await createTempVault();
    const linkPath = path.join(vaultPath, "40-context", "dangling.md");
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(path.join(vaultPath, "40-context", "missing-target.md"), linkPath);

    await expect(fetchVaultArtifact("40-context/dangling.md", { vaultPath })).rejects.toMatchObject({
      message: expect.stringContaining("file not found: 40-context/dangling.md"),
      exitCode: 1,
    });
  });

  test("fetch rejects unsupported vault URI namespaces and oversized files", async () => {
    const { vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    const largePath = path.join(vaultPath, "40-context", "large.md");
    await writeFile(largePath, "x".repeat(250_001), "utf8");

    await expect(fetchVaultArtifact("vault://other/40-context/large.md", { vaultPath })).rejects.toMatchObject({
      message: expect.stringContaining("unsupported vault URI namespace"),
      exitCode: 2,
    });
    await expect(fetchVaultArtifact("40-context/large.md", { vaultPath })).rejects.toMatchObject({
      message: expect.stringContaining("file exceeds maximum fetch size"),
      exitCode: 2,
    });
  });

  test("related follows wikilinks and same-issue frontmatter with bounds", async () => {
    const { vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "40-context", "source.md"),
      "---\ntitle: Source\nissue: POL-1516\n---\n# Source\n[[target]]\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultPath, "40-context", "target.md"),
      "---\ntitle: Target\nissue: POL-1516\n---\n# Target\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultPath, "40-context", "other.md"),
      "---\ntitle: Other\nissue: POL-1516\n---\n# Other\n",
      "utf8",
    );

    const wikilinkResult = await relatedVaultArtifacts("40-context/source.md", {
      vaultPath,
      relation: "wikilink",
      withFrontmatter: true,
    });
    expect(wikilinkResult.results).toHaveLength(1);
    expect(wikilinkResult.results[0]).toMatchObject({
      vaultUri: "vault://fieldwork/40-context/target.md",
      relation: "wikilink",
      depth: 1,
      frontmatter: { title: "Target" },
    });

    const sameIssueResult = await relatedVaultArtifacts("40-context/source.md", {
      vaultPath,
      relation: "same-issue",
      limit: 1,
    });
    expect(sameIssueResult.results).toHaveLength(1);
    expect(sameIssueResult.bounds.omitted).toBe(1);
    expect(sameIssueResult.bounds.scannedFiles).toBe(3);
    expect(sameIssueResult.bounds.scanTruncated).toBe(false);
    expect(sameIssueResult.results[0]?.evidence[0]).toContain("POL-1516");
  });

  test("status counts semantic homes and probes Obsidian sync state when available", async () => {
    const { root, vaultPath } = await createTempVault();
    await mkdir(path.join(vaultPath, "20-plans"), { recursive: true });
    await writeFile(path.join(vaultPath, "20-plans", "POL-872.md"), "# plan\n", "utf8");
    await mkdir(path.join(vaultPath, "50-projects", "calyx", "workstreams"), { recursive: true });
    await writeFile(path.join(vaultPath, "50-projects", "calyx", "README.md"), "# Calyx\n", "utf8");
    await writeFile(
      path.join(vaultPath, "50-projects", "calyx", "workstreams", "run-substrate-and-agents-infra.md"),
      "# lane\n",
      "utf8",
    );
    await mkdir(path.join(vaultPath, "10-daily", "2026-03-17"), { recursive: true });
    await writeFile(path.join(vaultPath, "10-daily", "2026-03-17", "oracle-ctxpack.md"), "# daily\n", "utf8");

    const syncConfigRoot = path.join(root, ".config", "obsidian-headless");
    const syncDir = path.join(syncConfigRoot, "sync", "fieldwork-test");
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      path.join(syncDir, "config.json"),
      JSON.stringify(
        {
          vaultId: "fieldwork-test",
          vaultPath,
          ignoreFolders: ["_local"],
        },
        null,
        2,
      ),
      "utf8",
    );
    const driver = await loadStateDriver();
    const db = driver.open(path.join(syncDir, "state.db"));
    try {
      db.exec("CREATE TABLE local_files (path TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE server_files (path TEXT PRIMARY KEY, data TEXT NOT NULL)");
      db.exec("CREATE TABLE pending_files (path TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO local_files (path) VALUES (?)").run("_local/qmd/index.json");
      db.prepare("INSERT INTO server_files (path, data) VALUES (?, ?)").run(
        "_local/qmd/index.json",
        JSON.stringify({ path: "_local/qmd/index.json", deleted: false }),
      );
      db.prepare("INSERT INTO server_files (path, data) VALUES (?, ?)").run(
        "_local/qmd/deleted.json",
        JSON.stringify({ path: "_local/qmd/deleted.json", deleted: true }),
      );
      db.prepare("INSERT INTO server_files (path, data) VALUES (?, ?)").run(
        ".exports/report.zip",
        JSON.stringify({ path: ".exports/report.zip", deleted: false }),
      );
      db.prepare("INSERT INTO pending_files (path) VALUES (?)").run(".exports/report.zip");
    } finally {
      db.close();
    }

    const obPath = path.join(root, ".agents", "run", "ob");
    const healthPath = path.join(root, ".agents", "run", "ob-fieldwork-sync-health");
    await mkdir(path.dirname(obPath), { recursive: true });
    await writeFile(obPath, "#!/usr/bin/env bash\necho 'sync ok'\n", "utf8");
    await writeFile(healthPath, "#!/usr/bin/env python3\n", "utf8");
    await chmod(obPath, 0o755);
    await chmod(healthPath, 0o755);

    const spawnSyncImpl = vi.fn((command: string) => command === healthPath
      ? { status: 0, stdout: JSON.stringify({ health: "healthy", service: { active_state: "active" }, warnings: [] }), stderr: "" }
      : { status: 0, stdout: "sync ok\n", stderr: "" });

    const result = await getVaultStatus(
      { vaultPath },
      {
        env: { HOME: root },
        platformImpl: () => "linux",
        spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
      },
    );

    expect(result.totalFiles).toBe(4);
    expect(result.counts.execplan).toBe(1);
    expect(result.counts.project).toBe(1);
    expect(result.counts.workstream).toBe(1);
    expect(result.counts.daily).toBe(1);
    expect(result.syncStatus.available).toBe(true);
    expect(result.syncStatus.attempted).toBe(true);
    expect(result.syncStatus.provider).toBe("obsidian-headless");
    expect(result.syncStatus.health).toBe("healthy");
    expect(result.syncStatus.stdout).toBe("sync ok\n");
    expect(result.syncStatus.runtime).toEqual(expect.objectContaining({ active: true }));
    expect(result.syncHygiene.applicable).toBe(true);
    expect(result.syncHygiene.available).toBe(true);
    expect(result.syncHygiene.configPath).toBe(path.join(syncDir, "config.json"));
    expect(result.syncHygiene.missingExcludedFolders).toEqual([".exports"]);
    expect(result.syncHygiene.trackedPrefixes).toEqual([
      { prefix: "_local", localFiles: 1, serverFiles: 1, pendingFiles: 0 },
      { prefix: ".exports", localFiles: 0, serverFiles: 1, pendingFiles: 1 },
    ]);
    expect(result.syncHygiene.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "fieldwork_sync_missing_exclusions" }),
        expect.objectContaining({ code: "fieldwork_sync_server_tracked_local_only" }),
      ]),
    );
  });

  test("status uses the desktop CLI without requiring Headless hygiene", async () => {
    const { root, vaultPath } = await createTempVault();
    const cliPath = path.join(root, "obsidian");
    await writeFile(cliPath, "#!/usr/bin/env bash\necho desktop sync ok\n", "utf8");
    await chmod(cliPath, 0o755);
    const spawnSyncImpl = vi.fn().mockReturnValue({ status: 0, stdout: "status: synced\nvault: fieldwork\n", stderr: "" });

    const result = await getVaultStatus(
      { vaultPath },
      {
        env: { HOME: root, OBSIDIAN_DESKTOP_CLI: cliPath },
        platformImpl: () => "darwin",
        spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
      },
    );

    expect(result.syncStatus.provider).toBe("obsidian-desktop");
    expect(result.syncStatus.health).toBe("healthy");
    expect(spawnSyncImpl).toHaveBeenCalledWith(cliPath, ["sync:status"], expect.objectContaining({ cwd: vaultPath }));
    expect(result.syncHygiene.applicable).toBe(false);
    expect(result.syncHygiene.attempted).toBe(false);
    expect(result.syncHygiene.missingExcludedFolders).toEqual([]);
    expect(result.syncHygiene.warnings).toEqual([]);
  });

  test("status degrades when the desktop CLI exits zero but reports a Sync error", async () => {
    const { root, vaultPath } = await createTempVault();
    const cliPath = path.join(root, "obsidian");
    await writeFile(cliPath, "#!/usr/bin/env bash\n", "utf8");
    await chmod(cliPath, 0o755);
    const spawnSyncImpl = vi.fn().mockReturnValue({ status: 0, stdout: "status: error\nvault: fieldwork\n", stderr: "" });

    const result = await getVaultStatus(
      { vaultPath },
      {
        env: { HOME: root, OBSIDIAN_DESKTOP_CLI: cliPath },
        platformImpl: () => "darwin",
        spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
      },
    );

    expect(result.syncStatus.health).toBe("degraded");
    expect(result.syncStatus.warnings).toEqual([
      expect.objectContaining({ code: "obsidian_desktop_sync_unhealthy" }),
    ]);
  });

  test("status reports a missing desktop CLI without falling back to Headless", async () => {
    const { root, vaultPath } = await createTempVault();
    const missingCli = path.join(root, "missing-obsidian");

    const result = await getVaultStatus(
      { vaultPath },
      {
        env: { HOME: root, OBSIDIAN_DESKTOP_CLI: missingCli },
        platformImpl: () => "darwin",
      },
    );

    expect(result.syncStatus.provider).toBe("obsidian-desktop");
    expect(result.syncStatus.health).toBe("unavailable");
    expect(result.syncStatus.attempted).toBe(false);
    expect(result.syncStatus.warnings).toEqual([
      expect.objectContaining({ code: "obsidian_desktop_cli_missing" }),
    ]);
    expect(result.syncHygiene.applicable).toBe(false);
  });

  test("status degrades Headless health when the continuous service is inactive", async () => {
    const { root, vaultPath } = await createTempVault();
    const syncDir = path.join(root, ".config", "obsidian-headless", "sync", "fieldwork-test");
    await mkdir(syncDir, { recursive: true });
    await writeFile(
      path.join(syncDir, "config.json"),
      JSON.stringify({ vaultId: "fieldwork-test", vaultPath, ignoreFolders: ["_local", ".exports"] }),
      "utf8",
    );
    const obPath = path.join(root, ".agents", "run", "ob");
    const healthPath = path.join(root, ".agents", "run", "ob-fieldwork-sync-health");
    await mkdir(path.dirname(obPath), { recursive: true });
    await writeFile(obPath, "#!/usr/bin/env bash\n", "utf8");
    await writeFile(healthPath, "#!/usr/bin/env python3\n", "utf8");
    await chmod(obPath, 0o755);
    await chmod(healthPath, 0o755);
    const spawnSyncImpl = vi.fn((command: string) => command === healthPath
      ? {
          status: 1,
          stdout: JSON.stringify({
            health: "degraded",
            service: { active_state: "inactive" },
            warnings: [{ code: "headless_service_inactive", message: "service is inactive" }],
          }),
          stderr: "",
        }
      : { status: 0, stdout: "Sync Configuration:\n", stderr: "" });

    const result = await getVaultStatus(
      { vaultPath },
      {
        env: { HOME: root },
        platformImpl: () => "linux",
        spawnSyncImpl: spawnSyncImpl as unknown as typeof import("node:child_process").spawnSync,
      },
    );

    expect(result.syncStatus.provider).toBe("obsidian-headless");
    expect(result.syncStatus.health).toBe("degraded");
    expect(result.syncStatus.runtime).toEqual(expect.objectContaining({ active: false, exitCode: 1 }));
    expect(result.syncStatus.warnings).toEqual([expect.objectContaining({ code: "headless_service_inactive" })]);
  });
});
