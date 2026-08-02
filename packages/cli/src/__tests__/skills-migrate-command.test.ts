import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listSkillContent, openStateStore } from "@polli-labs/calyx-core";

import { buildProgram } from "../run-cli";

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  thrown?: unknown;
}

async function runCalyx(argv: string[]): Promise<CapturedIO> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    err.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });

  let thrown: unknown;
  let exitCode: number | null = null;
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
  } catch (e) {
    thrown = e;
    if (e && typeof e === "object" && "exitCode" in e) {
      const code = (e as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") exitCode = code;
    }
  } finally {
    if (exitCode === null && typeof process.exitCode === "number") {
      exitCode = process.exitCode;
    }
    process.exitCode = priorExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out, stderr: err, exitCode, thrown };
}

function parseJsonResult(io: CapturedIO): {
  ok: boolean;
  command: string;
  result?: unknown;
  error?: { code: string; suggestions?: string[] };
} {
  return JSON.parse(io.stdout.join("\n"));
}

const INTERNAL_SKILL_MD =
  "---\ntitle: CLI First Party\ndescription: a first-party skill\n---\n# CLI First Party\n\nbody text\n";

describe("calyx skills migrate CLI (POL-1729 Slice 2)", () => {
  let workRoot: string;
  let sandboxHome: string;
  let agentsInfraRoot: string;
  let registryPath: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
      CALYX_SKILLS_REGISTRY: process.env["CALYX_SKILLS_REGISTRY"],
      CALYX_AGENTS_INFRA_ROOT: process.env["CALYX_AGENTS_INFRA_ROOT"],
    };
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-skills-migrate-cli-"));
    sandboxHome = path.join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    // SAFETY rule 2: sandbox the install mirrors + state DB. NO live cutover.
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = path.join(sandboxHome, ".codex");
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = path.join(workRoot, "state");

    // Build a SANDBOXED agents-infra root with the 3 markers so
    // resolveAgentsInfraRoot resolves the explicit --agents-infra-root.
    agentsInfraRoot = path.join(workRoot, "agents-infra");
    await mkdir(path.join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(path.join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await mkdir(path.join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(path.join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"), "{}", "utf8");
    await writeFile(path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"), "hosts: {}\n", "utf8");

    // The internal git source skill.
    const internalDir = path.join(agentsInfraRoot, "skills", "cli-first-party");
    await mkdir(internalDir, { recursive: true });
    await writeFile(path.join(internalDir, "SKILL.md"), INTERNAL_SKILL_MD, "utf8");

    // The registry is the canonical SOURCES.json marker path AND our registry.
    registryPath = path.join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: "2026-06-22",
          skills: [
            { id: "cli-first-party", source: { type: "internal", path: "skills/cli-first-party" } },
            {
              id: "vendored",
              source: { type: "external", repo: "https://github.com/x/y", path: "vendored" },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  function agentsMirror(name: string): string {
    return path.join(sandboxHome, ".agents", "skills", name);
  }

  async function allSkillRows(): Promise<Array<{ skill_name: string; regime: string; deleted_at: string | null }>> {
    const opened = await openStateStore();
    try {
      return listSkillContent(opened.db, { includeTombstoned: true }).map((r) => ({
        skill_name: r.skill_name,
        regime: r.regime,
        deleted_at: r.deleted_at,
      }));
    } finally {
      opened.db.close();
    }
  }

  test("migrate <skill> applies: seeds db-regime + re-materializes the mirror, with a SOURCES.json next_step", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "cli-first-party",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(true);
    const result = parsed.result as {
      action: string;
      next_step: string;
      rematerialize: { action: string };
    };
    expect(result.action).toBe("installed");
    expect(result.rematerialize.action).toBe("installed");
    expect(result.next_step).toContain("SOURCES.json");
    expect(result.next_step).toContain("regime");

    // The mirror exists on disk with the verbatim content.
    const live = await readFile(path.join(agentsMirror("cli-first-party"), "SKILL.md"), "utf8");
    expect(live).toContain("body text");

    // The DB row is regime=db.
    const rows = await allSkillRows();
    expect(rows.find((r) => r.skill_name === "cli-first-party")?.regime).toBe("db");
  });

  test("migrate --dry-run writes NOTHING (no db row, no mirror)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "cli-first-party",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--dry-run",
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const result = parseJsonResult(io).result as { action: string; dryRun: boolean };
    expect(result.action).toBe("planned");
    expect(result.dryRun).toBe(true);

    // No mirror, no db row.
    await expect(readFile(path.join(agentsMirror("cli-first-party"), "SKILL.md"), "utf8")).rejects.toThrow();
    expect(await allSkillRows()).toHaveLength(0);
  });

  test("migrate refuses a non-internal skill (not_first_party) and lists valid skills", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "vendored",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("not_first_party");
    expect(parsed.error?.suggestions?.some((s) => s.includes("cli-first-party"))).toBe(true);
  });

  test("--all-internal apply WITHOUT --confirm refuses (confirm_required)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "--all-internal",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("confirm_required");
    // Nothing migrated.
    expect(await allSkillRows()).toHaveLength(0);
  });

  test("--all-internal --confirm migrates every internal skill (and leaves non-internal alone)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "--all-internal",
      "--confirm",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const result = parseJsonResult(io).result as {
      results: Array<{ skillId: string; action: string }>;
      failures: unknown[];
    };
    expect(result.results.map((r) => r.skillId)).toEqual(["cli-first-party"]);
    expect(result.results[0]!.action).toBe("installed");
    expect(result.failures).toHaveLength(0);

    // Only the internal skill is in the db (regime db); vendored is untouched.
    const rows = await allSkillRows();
    expect(rows.map((r) => r.skill_name)).toEqual(["cli-first-party"]);
    expect(rows[0]!.regime).toBe("db");
  });

  test("--all-internal --dry-run is allowed without --confirm and writes nothing", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "--all-internal",
      "--dry-run",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const result = parseJsonResult(io).result as { dryRun: boolean; results: Array<{ action: string }> };
    expect(result.dryRun).toBe(true);
    expect(result.results.every((r) => r.action === "planned")).toBe(true);
    expect(await allSkillRows()).toHaveLength(0);
  });

  test("--all-internal --confirm against a registry with ONLY external skills reports the none-found note and writes nothing", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    // A registry whose only entries are non-internal (external/repo-maintained).
    const externalOnlyRegistry = path.join(agentsInfraRoot, "instructions", "skills", "external-only.json");
    await writeFile(
      externalOnlyRegistry,
      JSON.stringify(
        {
          version: "2026-06-22",
          skills: [
            { id: "vendored-a", source: { type: "external", repo: "https://github.com/x/a", path: "vendored-a" } },
            { id: "repo-b", source: { type: "repo-maintained", repo: "org/repo-b", path: "repo-b" } },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    const io = await runCalyx([
      "skills",
      "migrate",
      "--all-internal",
      "--confirm",
      "--registry",
      externalOnlyRegistry,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const result = parseJsonResult(io).result as {
      results: unknown[];
      failures: unknown[];
      note?: string;
    };
    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.note).toContain("no first-party (internal) skills");
    // Nothing written.
    expect(await allSkillRows()).toHaveLength(0);
  });

  test("migrate refuses when migration 0016 is not applied", async () => {
    // No state migrate --apply here.
    const io = await runCalyx([
      "skills",
      "migrate",
      "cli-first-party",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("skill_content_migration_absent");
  });

  test("migrate with no skill-id and no --all-internal is a usage error (exit 2)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "migrate",
      "--registry",
      registryPath,
      "--agents-infra-root",
      agentsInfraRoot,
      "--json",
    ]);
    expect(io.exitCode).toBe(2);
  });
});
