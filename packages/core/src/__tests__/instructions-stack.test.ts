import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { inspectInstructionStack } from "../instructions-stack";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "instructions-stack",
  "polli-wfc",
);

interface Fixture {
  root: string;
  home: string;
  codexHome: string;
  claudeConfigDir: string;
  repo: string;
  agentsInfra: string;
}

async function baseFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-instructions-stack-"));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const claudeConfigDir = path.join(home, ".claude");
  const repo = path.join(root, "repo");
  const agentsInfra = path.join(root, "agents-infra");
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(claudeConfigDir, { recursive: true }),
    mkdir(path.join(repo, ".git"), { recursive: true }),
    mkdir(path.join(agentsInfra, "instructions", "skills"), { recursive: true }),
    mkdir(path.join(agentsInfra, "instructions", "templates", "global"), { recursive: true }),
    mkdir(path.join(agentsInfra, "instructions", "templates", "partials"), { recursive: true }),
    mkdir(path.join(agentsInfra, "fleet", "truths"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(agentsInfra, "instructions", "skills", "SOURCES.json"), "{\"skills\":[]}\n", "utf8"),
    writeFile(
      path.join(agentsInfra, "fleet", "truths", "hosts.yaml"),
      `hosts:\n  carbon:\n    home: ${JSON.stringify(home)}\n`,
      "utf8",
    ),
  ]);
  return { root, home, codexHome, claudeConfigDir, repo, agentsInfra };
}

async function writeGlobalTemplate(
  fixture: Fixture,
  text: string,
  options: { partial?: string; registry?: boolean } = {},
): Promise<string> {
  const templatePath = path.join(
    fixture.agentsInfra,
    "instructions",
    "templates",
    "global",
    "AGENTS.global.hot.md.mustache",
  );
  await writeFile(templatePath, text, "utf8");
  if (options.partial !== undefined) {
    await writeFile(
      path.join(fixture.agentsInfra, "instructions", "templates", "partials", "shared.md.mustache"),
      options.partial,
      "utf8",
    );
  }
  await writeFile(
    path.join(fixture.agentsInfra, "instructions", "templates", "REGISTRY.json"),
    `${JSON.stringify({
      globals: options.registry === false
        ? {}
        : { hot: "instructions/templates/global/AGENTS.global.hot.md.mustache", variants: [], legacy: [] },
    }, null, 2)}\n`,
    "utf8",
  );
  return templatePath;
}

async function writeSurface(
  fixture: Fixture,
  id: string,
  owner: string,
  templatePath: string,
  targetDir: string,
): Promise<void> {
  const surfacesDir = path.join(fixture.agentsInfra, "instructions", "surfaces");
  const hostsDir = path.join(fixture.agentsInfra, "fleet", "hosts");
  const fleetPath = path.join(fixture.agentsInfra, "fleet", "fleet.yaml");
  await Promise.all([
    mkdir(surfacesDir, { recursive: true }),
    mkdir(hostsDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(fleetPath, "version: test\n", "utf8"),
    writeFile(
      path.join(hostsDir, "carbon.yaml"),
      `host: carbon\nuser: fixture\nhome: ${JSON.stringify(fixture.home)}\n`,
      "utf8",
    ),
  ]);
  await writeFile(
    path.join(surfacesDir, `${id}.yaml`),
    [
      `surface_id: ${id}`,
      "status: active",
      `owner: ${owner}`,
      "source_ref:",
      `  fleet_path: ${fleetPath}`,
      `  hosts_dir: ${hostsDir}`,
      `  template_path: ${templatePath}`,
      `  partials_dir: ${path.join(fixture.agentsInfra, "instructions", "templates", "partials")}`,
      "target_bindings:",
      `  - binding_id: ${id}-target`,
      "    class: directory_root",
      `    path: ${targetDir}`,
      "    managed_files:",
      "      - AGENTS.md",
      "    selectors:",
      "      hosts: [carbon]",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeGuide(filePath: string, body: string, metadata = true): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const prefix = metadata
    ? "---\nowner: polli-labs\nstatus: active\nscope: fixture\n---\n\n"
    : "";
  await writeFile(filePath, `${prefix}${body}\n`, "utf8");
}

async function writeResolvedCodexGlobal(fixture: Fixture, body: string): Promise<string> {
  const text = `---\nowner: polli-labs\nstatus: active\nscope: global\n---\n\n${body}\n`;
  const templatePath = await writeGlobalTemplate(fixture, text, { registry: false });
  const targetPath = path.join(fixture.codexHome, "AGENTS.md");
  await writeFile(targetPath, text, "utf8");
  await writeSurface(fixture, "global-hot-codex-carbon", "polli-labs", templatePath, fixture.codexHome);
  return targetPath;
}

describe("inspectInstructionStack", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots.clear();
  });

  test("replays the pinned four-source Polli WFC baseline without exposing bodies", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    const files = [
      ["AGENTS.md", "AGENTS.md"],
      ["apps/explorer/AGENTS.md", "apps/explorer/AGENTS.md"],
      ["apps/explorer/src/features/wfc4/AGENTS.md", "apps/explorer/src/features/wfc4/AGENTS.md"],
    ] as const;
    for (const [from, to] of files) {
      const destination = path.join(fixture.repo, to);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(fixtureRoot, from), destination);
    }
    const globalTarget = path.join(fixture.codexHome, "AGENTS.md");
    await copyFile(path.join(fixtureRoot, "global-AGENTS.md"), globalTarget);
    const templatePath = await writeGlobalTemplate(
      fixture,
      await readFile(path.join(fixtureRoot, "global-AGENTS.md"), "utf8"),
    );
    await writeSurface(fixture, "global-hot-codex-carbon", "polli-labs", templatePath, fixture.codexHome);

    const result = await inspectInstructionStack({
      cwd: path.join(fixture.repo, "apps", "explorer", "src", "features", "wfc4"),
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      claudeConfigDir: fixture.claudeConfigDir,
      agentsInfraRoot: fixture.agentsInfra,
    });

    expect(result.sources.map((source) => source.selectedAs)).toEqual([
      "AGENTS.md",
      "AGENTS.md",
      "AGENTS.md",
      "AGENTS.md",
    ]);
    expect(result.totals).toMatchObject({
      sourceCount: 4,
      rawLines: 1060,
      rawBytes: 57278,
      includedBytes: 57278,
    });
    expect(result.sources[0]).toMatchObject({
      contentSha256: "4218ffa3cbce4d8c1faf8963d6b6b8c8f7fdb069e4e10085f8eb54d8e036497f",
      status: "ambiguous_provenance",
    });
    expect(result.structural.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ambiguous_source", candidateOwners: ["polli-labs"] }),
    ]));
    expect(JSON.stringify(result)).not.toContain("Polli Agent Constitution");
  });

  test("loads the global and project-root guides but not a nested guide from a root cwd", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    const globalTarget = await writeResolvedCodexGlobal(fixture, "Use the global gate.");
    await writeGuide(path.join(fixture.repo, "AGENTS.md"), "Use the root gate.");
    await writeGuide(path.join(fixture.repo, "nested", "AGENTS.md"), "Use the nested gate.");

    const result = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    expect(result.sources.map((source) => source.targetPath)).toEqual([
      globalTarget,
      path.join(fixture.repo, "AGENTS.md"),
    ]);
  });

  test("honors configured Codex fallback selection and one concatenated byte budget exactly", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeFile(
      path.join(fixture.codexHome, "config.toml"),
      [
        'project_doc_fallback_filenames = ["INSTRUCTIONS.md"]',
        "project_doc_max_bytes = 16",
        'project_root_markers = [".git"]',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(fixture.repo, "INSTRUCTIONS.md"), "1234567890\n", "utf8");
    await mkdir(path.join(fixture.repo, "nested"), { recursive: true });
    await writeFile(path.join(fixture.repo, "nested", "INSTRUCTIONS.md"), "abcdefghijklmnopqrst\n", "utf8");

    const result = await inspectInstructionStack({
      cwd: path.join(fixture.repo, "nested"),
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });

    expect(result.resolution.projectDocMaxBytes).toBe(16);
    expect(result.resolution.perDirectoryCandidates).toContain("INSTRUCTIONS.md");
    expect(result.sources.map((source) => source.selectedAs)).toEqual([
      "INSTRUCTIONS.md",
      "INSTRUCTIONS.md",
    ]);
    expect(result.sources.map((source) => source.metrics)).toEqual([
      expect.objectContaining({ rawBytes: 11, includedBytes: 11, truncated: false }),
      expect.objectContaining({ rawBytes: 21, includedBytes: 5, truncated: true }),
    ]);
    expect(result.totals).toMatchObject({ rawBytes: 32, includedBytes: 16 });
    expect(result.limitations).toEqual(expect.arrayContaining([
      expect.stringContaining("dated observation"),
      expect.stringContaining("does not inspect a remote host filesystem"),
    ]));
  });

  test("loads a nested Codex guide only when cwd enters its subtree and honors override selection", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeGlobalTemplate(fixture, "", { registry: false });
    await writeGuide(path.join(fixture.repo, "AGENTS.md"), "Use the root gate.");
    await writeGuide(path.join(fixture.repo, "nested", "AGENTS.md"), "This file is shadowed.");
    await writeGuide(path.join(fixture.repo, "nested", "AGENTS.override.md"), "Use the override gate.");

    const rootResult = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    const nestedResult = await inspectInstructionStack({
      cwd: path.join(fixture.repo, "nested"),
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    expect(rootResult.sources).toHaveLength(1);
    expect(nestedResult.sources.map((source) => source.selectedAs)).toEqual(["AGENTS.md", "AGENTS.override.md"]);
    expect(nestedResult.sources.map((source) => source.targetPath)).not.toContain(path.join(fixture.repo, "nested", "AGENTS.md"));
  });

  test("represents byte-identical AGENTS and CLAUDE mirrors without adding the mirror to totals", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeGlobalTemplate(fixture, "", { registry: false });
    const body = "---\nowner: polli-labs\nstatus: active\nscope: fixture\n---\n\nUse the mirror gate.\n";
    await writeFile(path.join(fixture.repo, "AGENTS.md"), body, "utf8");
    await writeFile(path.join(fixture.repo, "CLAUDE.md"), body, "utf8");

    const result = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      claudeConfigDir: fixture.claudeConfigDir,
      agentsInfraRoot: fixture.agentsInfra,
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.mirrorTargets).toEqual([path.join(fixture.repo, "CLAUDE.md")]);
    expect(result.totals.sourceCount).toBe(1);
    expect(result.totals.mirrorTargetCount).toBe(1);
  });

  test("reports rendered-template and partial provenance by hashes and locators only", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    const template = "---\nowner: polli-labs\nstatus: active\nscope: global\n---\nRoot\n{{> shared}}\n";
    const partial = "Partial instructions.\n";
    await writeGlobalTemplate(fixture, template, { partial });
    await writeFile(
      path.join(fixture.codexHome, "AGENTS.md"),
      template.replace("{{> shared}}", partial.trimEnd()),
      "utf8",
    );

    const result = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    const global = result.sources[0]!;
    expect(global.status).toBe("resolved");
    expect(global.provenance[0]).toMatchObject({ kind: "template_fanout", owner: "polli-labs" });
    expect(global.provenance[0]?.partials).toEqual([
      expect.objectContaining({ name: "shared", missing: false, rawBytes: Buffer.byteLength(partial) }),
    ]);
    expect(JSON.stringify(global.provenance)).not.toContain("Partial instructions.");
  });

  test("fails structurally and emits candidate owners for ambiguous ownership", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    const text = "---\nstatus: active\nscope: global\n---\nGlobal.\n";
    const templatePath = await writeGlobalTemplate(fixture, text, { registry: false });
    await writeFile(path.join(fixture.codexHome, "AGENTS.md"), text, "utf8");
    await writeSurface(fixture, "owner-a", "team-a", templatePath, fixture.codexHome);
    await writeSurface(fixture, "owner-b", "team-b", templatePath, fixture.codexHome);

    const result = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    expect(result.structural.ok).toBe(false);
    expect(result.structural.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ambiguous_owner", candidateOwners: ["team-a", "team-b"] }),
    ]));
  });

  test("keeps literal owner, version, canonical-locator, and review-policy conflicts advisory-only", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeGlobalTemplate(fixture, "", { registry: false });
    await writeGuide(
      path.join(fixture.repo, "AGENTS.md"),
      [
        "Canonical owner: team-a.",
        "Canonical version: v1.",
        "Review policy source of truth is /docs/review-v1.md.",
        "Every change must receive independent review.",
      ].join("\n"),
    );
    await writeGuide(
      path.join(fixture.repo, "nested", "AGENTS.md"),
      [
        "Canonical owner: team-b.",
        "Canonical version: v2.",
        "Review policy source of truth is /docs/review-v2.md.",
        "Independent review is not required for every change; use it only when risk warrants it.",
      ].join("\n"),
      false,
    );

    const result = await inspectInstructionStack({
      cwd: path.join(fixture.repo, "nested"),
      harness: "codex",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    });
    const conflicts = result.advisories.filter((advisory) => advisory.kind === "conflicting_claim");
    expect(conflicts).toHaveLength(4);
    expect(conflicts.every((conflict) => conflict.confidence === "high")).toBe(true);
    expect(conflicts.every((conflict) => conflict.locators.length === 2)).toBe(true);
    expect(result.structural.findings.map((finding) => finding.code)).not.toContain("conflicting_claim");
  });

  test("emits a stable repeated-imperative fingerprint without changing structural status", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeResolvedCodexGlobal(fixture, "Always run the green gate.");
    await writeGuide(path.join(fixture.repo, "AGENTS.md"), "Always run the green gate.");

    const options = {
      cwd: fixture.repo,
      harness: "codex" as const,
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    };
    const first = await inspectInstructionStack(options);
    const second = await inspectInstructionStack(options);
    const advisory = first.advisories.find((entry) => entry.kind === "repeated_imperative");

    expect(first.structural.ok).toBe(true);
    expect(advisory).toMatchObject({
      id: "repeated_imperative:bb8e183a01c6",
      confidence: "high",
      fingerprint: "bb8e183a01c6e75543e510af724f606bb269ab8d245165d5e72aad9fb4451da0",
    });
    expect(second.advisories.find((entry) => entry.kind === "repeated_imperative")).toEqual(advisory);
  });

  test("emits a stable wrong-altitude fingerprint without changing structural status", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeResolvedCodexGlobal(
      fixture,
      "Run POL-2030 only on blade from /home/caleb/dev/calyx.",
    );

    const options = {
      cwd: fixture.repo,
      harness: "codex" as const,
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    };
    const first = await inspectInstructionStack(options);
    const second = await inspectInstructionStack(options);
    const advisory = first.advisories.find((entry) => entry.kind === "wrong_altitude");

    expect(first.structural.ok).toBe(true);
    expect(advisory).toMatchObject({ kind: "wrong_altitude", confidence: "high" });
    expect(advisory?.id).toBe(`wrong_altitude:${advisory?.fingerprint.slice(0, 12)}`);
    expect(second.advisories.find((entry) => entry.kind === "wrong_altitude")).toEqual(advisory);
  });

  test("emits a stable stale-child fingerprint without changing structural status", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeResolvedCodexGlobal(
      fixture,
      "Review policy source of truth is /docs/review-policy.md.",
    );
    await writeGuide(
      path.join(fixture.repo, "AGENTS.md"),
      "Every change must follow the review procedure.",
    );

    const options = {
      cwd: fixture.repo,
      harness: "codex" as const,
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      agentsInfraRoot: fixture.agentsInfra,
    };
    const first = await inspectInstructionStack(options);
    const second = await inspectInstructionStack(options);
    const advisory = first.advisories.find((entry) => entry.kind === "stale_child_after_authority_moved");

    expect(first.structural.ok).toBe(true);
    expect(advisory).toMatchObject({
      kind: "stale_child_after_authority_moved",
      confidence: "medium",
    });
    expect(advisory?.id).toBe(`stale_child_after_authority_moved:${advisory?.fingerprint.slice(0, 12)}`);
    expect(second.advisories.find((entry) => entry.kind === "stale_child_after_authority_moved")).toEqual(advisory);
  });

  test("matches observed Claude eager order, excludes path-scoped rules, and expands safe imports", async () => {
    const fixture = await baseFixture();
    roots.add(fixture.root);
    await writeGlobalTemplate(fixture, "", { registry: false });
    await writeGuide(path.join(fixture.claudeConfigDir, "CLAUDE.md"), "Use user guidance.");
    await writeGuide(
      path.join(fixture.repo, "CLAUDE.md"),
      "Read @docs/imported.md for shared guidance.\nRead @~/.ssh/id_ed25519 for private guidance.",
    );
    await writeGuide(path.join(fixture.repo, ".claude", "CLAUDE.md"), "Use dot-Claude guidance.");
    await writeGuide(path.join(fixture.repo, ".claude", "rules", "unscoped.md"), "Use the unscoped rule.");
    await writeGuide(
      path.join(fixture.repo, ".claude", "rules", "scoped.md"),
      "Use the scoped rule.",
      false,
    );
    await writeFile(
      path.join(fixture.repo, ".claude", "rules", "scoped.md"),
      "---\npaths:\n  - src/**\n---\nUse the scoped rule.\n",
      "utf8",
    );
    await writeGuide(path.join(fixture.repo, "CLAUDE.local.md"), "Use local guidance.");
    await writeGuide(path.join(fixture.repo, "docs", "imported.md"), "Use imported guidance.");
    await mkdir(path.join(fixture.home, ".ssh"), { recursive: true });
    await writeFile(path.join(fixture.home, ".ssh", "id_ed25519"), "NEVER-EXPOSE-THIS-SECRET\n", "utf8");

    const result = await inspectInstructionStack({
      cwd: fixture.repo,
      harness: "claude",
      host: "carbon",
      homeDir: fixture.home,
      codexHome: fixture.codexHome,
      claudeConfigDir: fixture.claudeConfigDir,
      agentsInfraRoot: fixture.agentsInfra,
      claudeManagedInstructionPaths: [],
    });
    expect(result.sources.map((source) => source.selectedAs)).toEqual([
      "CLAUDE.md",
      "CLAUDE.md",
      "imported.md",
      "id_ed25519",
      ".claude/CLAUDE.md",
      ".claude/rules/unscoped.md",
      "CLAUDE.local.md",
    ]);
    expect(result.sources.map((source) => source.targetPath)).not.toContain(
      path.join(fixture.repo, ".claude", "rules", "scoped.md"),
    );
    expect(result.sources[2]).toMatchObject({ kind: "import", loadReason: "include" });
    expect(result.sources[3]).toMatchObject({
      kind: "import",
      status: "refused_sensitive_import",
    });
    expect(result.sources[3]).not.toHaveProperty("contentSha256");
    expect(result.sources[3]).not.toHaveProperty("metrics");
    expect(result.structural.findings.map((finding) => finding.code)).toContain("sensitive_import_refused");
    expect(JSON.stringify(result)).not.toContain("NEVER-EXPOSE-THIS-SECRET");
  });
});
