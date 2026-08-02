import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CALYX_INTERFACE_MANIFEST } from "@polli-labs/calyx-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

async function createSkillsFixture(): Promise<{ root: string; home: string; registryPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-cli-skills-show-"));
  const home = path.join(root, "home");
  const skillDir = path.join(root, "instructions", "skills", "fieldwork-conventions");
  const registryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");

  await mkdir(skillDir, { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "title: Fieldwork conventions",
      "description: Shared fieldwork conventions",
      "---",
      "",
      "# Fieldwork",
      "",
      "Use the vault.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    registryPath,
    `${JSON.stringify({
      version: "test",
      skills: [
        {
          id: "fieldwork-conventions",
          status: "active",
          source: {
            type: "internal",
            path: "instructions/skills/fieldwork-conventions",
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify({
      globals: {
        hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
        variants: [],
        legacy: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    hostsPath,
    ["hosts:", "  carbon:", `    home: ${JSON.stringify(home)}`, ""].join("\n"),
    "utf8",
  );

  return { root, home, registryPath };
}

async function createTraceFixture(): Promise<{ root: string; home: string; claudeTargetPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-cli-trace-"));
  const home = path.join(root, "home");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const registryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const templatePath = path.join(root, "instructions", "templates", "global", "AGENTS.global.hot.md.mustache");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");
  const claudeTargetPath = path.join(home, ".claude", "CLAUDE.md");

  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(path.dirname(templatePath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await mkdir(path.dirname(claudeTargetPath), { recursive: true });
  await writeFile(
    skillsRegistryPath,
    `${JSON.stringify({
      version: "test",
      skills: [],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    registryPath,
    `${JSON.stringify({
      globals: {
        hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
        variants: [],
        legacy: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(templatePath, "Global hot surface.\n", "utf8");
  await writeFile(
    hostsPath,
    [
      "hosts:",
      "  carbon:",
      `    home: ${JSON.stringify(home)}`,
      "    ram_gb: 64",
      "    roles: [dev]",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(claudeTargetPath, "Global hot surface.\n", "utf8");

  return { root, home, claudeTargetPath };
}

describe("introspection commands", () => {
  const originalHome = process.env["HOME"];
  const originalCodexHome = process.env["CODEX_HOME"];
  const originalClaudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  const originalAgentsRegistry = process.env["CALYX_AGENTS_REGISTRY"];
  const originalAgentsInfraRoot = process.env["CALYX_AGENTS_INFRA_ROOT"];
  const roots = new Set<string>();

  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalCodexHome === undefined) {
      delete process.env["CODEX_HOME"];
    } else {
      process.env["CODEX_HOME"] = originalCodexHome;
    }
    if (originalClaudeConfigDir === undefined) {
      delete process.env["CLAUDE_CONFIG_DIR"];
    } else {
      process.env["CLAUDE_CONFIG_DIR"] = originalClaudeConfigDir;
    }
    if (originalAgentsRegistry === undefined) {
      delete process.env["CALYX_AGENTS_REGISTRY"];
    } else {
      process.env["CALYX_AGENTS_REGISTRY"] = originalAgentsRegistry;
    }
    if (originalAgentsInfraRoot === undefined) {
      delete process.env["CALYX_AGENTS_INFRA_ROOT"];
    } else {
      process.env["CALYX_AGENTS_INFRA_ROOT"] = originalAgentsInfraRoot;
    }
    process.exitCode = undefined;

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("registers the new subcommands in the canonical namespaces", () => {
    const program = buildProgram();
    const instructions = program.commands.find((command) => command.name() === "instructions");
    const skills = program.commands.find((command) => command.name() === "skills");

    expect(instructions?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["stack", "trace"]));
    expect(skills?.commands.map((command) => command.name())).toContain("show");
    expect(program.commands.map((command) => command.name())).toContain("agent-context");
  });

  test("agent-context emits bounded command inventory and operator recipes", async () => {
    process.env["CALYX_AGENTS_REGISTRY"] = path.resolve(process.cwd(), "fixtures/domains/agents/AGENTS.json");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "agent-context", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schema_version: string;
      generated_from: string;
      commands: Array<{ path: string; description?: string; mutation_class?: string }>;
      recipes: Array<{ id: string; commands: string[]; notes: string[] }>;
      legacy_wrappers: { visible_in_help: boolean; invocation_policy: string };
      agent_definitions: { status: string; items: Array<{ id: string; description?: string }> };
    };
    expect(payload.schema_version).toBe("calyx.agent-context/v1");
    expect(payload.generated_from).toBe("commander-introspection");
    expect(payload.commands.map((command) => command.path)).toContain("run daemon tick");
    expect(payload.commands.map((command) => command.path)).toContain("run await");
    expect(payload.commands.map((command) => command.path)).toContain("activity turns");
    expect(payload.commands.map((command) => command.path)).toContain("agent-context");
    expect(payload.commands.find((command) => command.path === "instructions stack")?.mutation_class).toBe("read_only");
    const selfUpgrade = payload.commands.find((command) => command.path === "self upgrade");
    expect(selfUpgrade?.description).toContain("preserve proven-safe runs");
    expect(selfUpgrade?.description).toContain("run.readopt_on_boot/v1");
    expect(selfUpgrade?.description).toContain("run.detached_worker_isolation/v1");
    expect(selfUpgrade?.description).toContain("--drain-all");
    expect(selfUpgrade?.description).toContain("operation IDs");
    expect(selfUpgrade?.description).toContain("rollback");
    expect(selfUpgrade?.description).toContain("receipts");
    expect(selfUpgrade?.description).toContain("status --watch");
    expect(payload.recipes.map((recipe) => recipe.id)).toContain("runner-supervision");
    expect(payload.recipes.find((recipe) => recipe.id === "runner-supervision")?.commands).toContain(
      "calyx activity turns run:<run-id> --role assistant --last 1 --with-tools --json",
    );
    expect(payload.recipes.find((recipe) => recipe.id === "runner-supervision")?.commands).toContain(
      "calyx run await --host <host> <run-id> --json",
    );
    expect(JSON.stringify(payload)).not.toContain("poll-until-terminal");
    const timingInsensitive = payload.recipes.find(
      (recipe) => recipe.id === "timing-insensitive-runner-supervision",
    );
    const correspondence = payload.recipes.find((recipe) => recipe.id === "message-correspondence");
    expect(timingInsensitive?.commands).toEqual(expect.arrayContaining([
      "calyx monitor create --preset runner-supervision --run <run-id> --assigned-host <host> --owner interactive:<backend>:<session-id> --provenance conductor --json",
      "calyx monitor inbox --host <host> --json",
      "calyx monitor ack <wake-id> --host <host> --json",
    ]));
    expect(correspondence?.commands).toEqual(expect.arrayContaining([
      "calyx msg send --to run:<run-id> --subject <subject> --body <body> --ack-required --json",
      "calyx msg send --to interactive:<backend>:<session-id> --subject <subject> --body <body> --wake --json",
      "calyx msg inbox --json",
      "calyx msg ack <message-id> --json",
    ]));
    const monitor = program.commands.find((command) => command.name() === "monitor");
    const docsRoot = path.resolve(process.cwd(), "docs");
    const docPaths = (await readdir(docsRoot, { recursive: true }))
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    const documentation = (await Promise.all(
      docPaths.map(async (entry) => `${entry}\n${await readFile(path.join(docsRoot, entry), "utf8")}`),
    )).join("\n");
    const canonicalAgentSurfaces = {
      agent_context: JSON.stringify(payload),
      root_help: program.helpInformation(),
      monitor_help: monitor?.helpInformation() ?? "",
      interface_manifest: JSON.stringify(CALYX_INTERFACE_MANIFEST),
      documentation,
    };
    for (const forbiddenLegacyToken of [
      "completion-reinvoke",
      "codex_automation",
      "codex_app_server_steer",
      "claude_reinvoke",
      "claude_channel",
      "claude-channel-receiver",
      "--channels",
      "127.0.0.1:8788",
      "private-IPC",
    ]) {
      for (const [surface, text] of Object.entries(canonicalAgentSurfaces)) {
        expect(text, `${surface} leaked retired agent wake token ${forbiddenLegacyToken}`)
          .not.toContain(forbiddenLegacyToken);
      }
    }
    expect(canonicalAgentSurfaces.agent_context).toContain("--port 8787");
    expect(canonicalAgentSurfaces.documentation).toContain("default port is `8787`");
    expect(payload.recipes.map((recipe) => recipe.id)).toContain("vault-markdown-frontmatter-read");
    expect(payload.recipes.find((recipe) => recipe.id === "vault-markdown-frontmatter-read")?.commands).toEqual(
      expect.arrayContaining([
        "calyx vault toc vault://fieldwork/<path>.md --json",
        "calyx vault section get vault://fieldwork/<path>.md --heading <heading-id-or-text> --max-chars 4000 --json",
        "calyx vault frontmatter get vault://fieldwork/<path>.md --json",
        "calyx vault frontmatter query --type <type> --where '<field> == \"<value>\"' --limit 25 --json",
      ]),
    );
    // P2-1 regression: agent-context must teach the CAS-bound approve flow (inspect pending -> approve with
    // the content_hash), never the bare approve string that the CLI now refuses with exit 2.
    expect(payload.recipes.map((recipe) => recipe.id)).toContain("memory-curated-facts");
    const memoryRecipe = payload.recipes.find((recipe) => recipe.id === "memory-curated-facts");
    expect(memoryRecipe?.commands).toEqual(
      expect.arrayContaining([
        "calyx memory get <key> --status pending --json",
        "calyx memory approve <key> --expected-content-hash <content_hash> --author <id> --json",
      ]),
    );
    expect(memoryRecipe?.commands).not.toContain("calyx memory approve <key> --author <id> --json");
    expect(payload.legacy_wrappers.visible_in_help).toBe(false);
    expect(payload.legacy_wrappers.invocation_policy).toBe("preparse-diagnostics");
    expect(payload.agent_definitions.status).toBe("available");
    expect(payload.agent_definitions.items).toEqual([
      expect.objectContaining({
        id: "fixture-reviewer",
        description: "Fixture reviewer used by POL-1799 launch tests.",
      }),
    ]);
  });

  test("skills show emits a JSON success envelope", async () => {
    const fixture = await createSkillsFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = path.join(fixture.home, ".codex");

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "skills",
      "show",
      "fieldwork-conventions",
      "--registry",
      fixture.registryPath,
      "--agents-infra-root",
      fixture.root,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      result: { id: string; source: { available: boolean } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("skills.show");
    expect(payload.result.id).toBe("fieldwork-conventions");
    expect(payload.result.source.available).toBe(true);
  });

  test("instructions trace emits a JSON failure envelope and sets exitCode for unmanaged targets", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "instructions",
      "trace",
      path.join(fixture.root, "unknown", "TARGET.md"),
      "--agents-infra-root",
      fixture.root,
      "--host",
      "carbon",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe("instructions.trace");
    expect(payload.error.code).toBe("unmanaged_target");
    expect(process.exitCode).toBe(3);
  });

  test("instructions stack keeps advisory prose findings non-blocking in JSON", async () => {
    const fixture = await createTraceFixture();
    roots.add(fixture.root);
    process.env["HOME"] = fixture.home;
    process.env["CLAUDE_CONFIG_DIR"] = path.join(fixture.home, ".claude");
    const globalText = [
      "---",
      "owner: polli-labs",
      "status: active",
      "scope: global",
      "---",
      "Always run the green gate.",
      "Review policy source of truth is /docs/review-policy.md.",
      "Run POL-2030 only on blade from /home/caleb/dev/calyx.",
      "",
    ].join("\n");
    await writeFile(
      path.join(fixture.root, "instructions", "templates", "global", "AGENTS.global.hot.md.mustache"),
      globalText,
      "utf8",
    );
    await writeFile(fixture.claudeTargetPath, globalText, "utf8");
    const project = path.join(fixture.root, "project");
    const nested = path.join(project, "nested");
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(project, "CLAUDE.md"),
      "---\nowner: polli-labs\nstatus: active\nscope: project\n---\nAlways run the green gate.\nEvery change must receive independent review.\n",
      "utf8",
    );
    await writeFile(
      path.join(nested, "CLAUDE.md"),
      "Independent review is not required for every change; use it only when risk warrants it.\n",
      "utf8",
    );

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "calyx",
      "instructions",
      "stack",
      "--cwd",
      nested,
      "--harness",
      "claude",
      "--host",
      "carbon",
      "--agents-infra-root",
      fixture.root,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      ok: boolean;
      command: string;
      result: { structural: { ok: boolean }; advisories: Array<{ kind: string }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("instructions.stack");
    expect(payload.result.structural.ok).toBe(true);
    expect(payload.result.advisories.map((advisory) => advisory.kind)).toEqual(expect.arrayContaining([
      "conflicting_claim",
      "repeated_imperative",
      "stale_child_after_authority_moved",
      "wrong_altitude",
    ]));
    expect(process.exitCode).toBeUndefined();
  });

  test("instructions stack help and manifest agree that the command is read-only", () => {
    const program = buildProgram();
    const instructions = program.commands.find((command) => command.name() === "instructions");
    const stack = instructions?.commands.find((command) => command.name() === "stack");
    const manifest = CALYX_INTERFACE_MANIFEST.records.find((record) => record.id === "instructions.stack");

    expect(stack?.description()).toContain("read-only");
    expect(stack?.helpInformation()).toContain("--cwd <path>");
    expect(stack?.helpInformation()).toContain("not remote inspection");
    expect(manifest).toMatchObject({ mutation_class: "read_only", path: ["instructions", "stack"] });
  });
});
