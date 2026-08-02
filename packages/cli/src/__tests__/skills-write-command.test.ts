import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  // process.exitCode is set by JSON-mode error paths; capture + reset.
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

function parseJsonResult(io: CapturedIO): { ok: boolean; command: string; result?: unknown; error?: { code: string; matches?: string[] } } {
  return JSON.parse(io.stdout.join("\n"));
}

const SKILL_MD = "---\ntitle: My CLI Skill\ndescription: a thing\n---\n# My CLI Skill\n\nhello body\n";

describe("calyx skills write / delete CLI (POL-1729 Slice 1)", () => {
  let workRoot: string;
  let sandboxHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-skills-write-cli-"));
    sandboxHome = path.join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    // SAFETY rule 2: sandbox the install mirrors.
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = path.join(sandboxHome, ".codex");
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = path.join(workRoot, "state");
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

  function claudeMirror(name: string): string {
    return path.join(sandboxHome, ".claude", "skills", name);
  }

  /** All skill_content rows (live + tombstoned), across every host. */
  async function allSkillRows(): Promise<Array<{ skill_name: string; deleted_at: string | null }>> {
    const opened = await openStateStore();
    try {
      return listSkillContent(opened.db, { includeTombstoned: true }).map((r) => ({
        skill_name: r.skill_name,
        deleted_at: r.deleted_at,
      }));
    } finally {
      opened.db.close();
    }
  }

  test("write --content installs the mirror and reports live-after-rematerialize (#7 latency)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["skills", "write", "cli-skill", "--content", SKILL_MD, "--author", "claude:test", "--json"]);
    expect(io.thrown).toBeUndefined();
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(true);
    const result = parsed.result as { action: string; visibility: { codex: string; claude: string } };
    expect(result.action).toBe("installed");
    expect(result.visibility.codex).toBe("live-after-rematerialize");
    expect(result.visibility.claude).toBe("next-session");

    // The mirror file exists on disk (agents == codex alias by default).
    const live = await readFile(path.join(agentsMirror("cli-skill"), "SKILL.md"), "utf8");
    expect(live).toContain("hello body");
  });

  test("a second identical write is a no-op against the rendered tree (#2 idempotency)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "s", "--content", SKILL_MD, "--json"]);
    const io = await runCalyx(["skills", "write", "s", "--content", SKILL_MD, "--json"]);
    const result = parseJsonResult(io).result as { backends: Array<{ action: string }> };
    expect(result.backends.every((b) => b.action === "noop")).toBe(true);
  });

  test("name normalization: 'My-Skill' then 'my-skill' resolve to ONE DB row and ONE mirror dir per backend (FIX B no split-brain)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);

    // First write with mixed casing: the result reports the canonical name + a note.
    const first = await runCalyx(["skills", "write", "My-Skill", "--content", SKILL_MD, "--json"]);
    const firstResult = parseJsonResult(first).result as { skillName: string; note?: string };
    expect(firstResult.skillName).toBe("my-skill");
    expect(firstResult.note).toBe("skill name normalized to my-skill");

    // Second write with the already-canonical form: same row, no note, no-op mirrors.
    const second = await runCalyx(["skills", "write", "my-skill", "--content", SKILL_MD, "--json"]);
    const secondResult = parseJsonResult(second).result as {
      skillName: string;
      note?: string;
      backends: Array<{ action: string }>;
    };
    expect(secondResult.skillName).toBe("my-skill");
    expect(secondResult.note).toBeUndefined();
    expect(secondResult.backends.every((b) => b.action === "noop")).toBe(true);

    // Exactly ONE DB row exists (no split-brain My-Skill vs my-skill).
    const rows = await allSkillRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skill_name).toBe("my-skill");

    // Exactly ONE mirror dir per backend, named canonically (no orphan/collision).
    expect((await readdir(path.dirname(agentsMirror("my-skill")))).sort()).toEqual(["my-skill"]);
    expect((await readdir(path.dirname(claudeMirror("my-skill")))).sort()).toEqual(["my-skill"]);
    expect(await readFile(path.join(agentsMirror("my-skill"), "SKILL.md"), "utf8")).toContain("hello body");
  });

  test("gate-sharpest refuses content with a sharp finding (#5 scan gate)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const dangerous = "---\ntitle: bad\n---\nRun `rm -rf /` now\n";
    const io = await runCalyx(["skills", "write", "danger", "--content", dangerous, "--json"]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("gated_sharp_content");
    expect(parsed.error?.matches?.some((m) => m.includes("shell-destructive"))).toBe(true);
    // Nothing was written to the mirror.
    await expect(readFile(path.join(agentsMirror("danger"), "SKILL.md"), "utf8")).rejects.toThrow();
    // And NO skill_content DB row was created: the gate refuses BEFORE the upsert.
    expect(await allSkillRows()).toHaveLength(0);
  });

  test("--gate-policy free commits dangerous content and records the findings (#5 free path)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const dangerous = "---\ntitle: bad\n---\nRun `rm -rf /tmp/x` now\n";
    const io = await runCalyx([
      "skills",
      "write",
      "danger",
      "--content",
      dangerous,
      "--gate-policy",
      "free",
      "--json",
    ]);
    expect(io.thrown).toBeUndefined();
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(true);
    const result = parsed.result as { action: string; scan: { ok: boolean; findings: unknown[] }; gate_policy: string };
    expect(result.action).toBe("installed");
    expect(result.gate_policy).toBe("free");
    expect(result.scan.ok).toBe(false);
    expect(result.scan.findings.length).toBeGreaterThan(0);
    // It DID write to the mirror under free policy.
    expect(await readFile(path.join(agentsMirror("danger"), "SKILL.md"), "utf8")).toContain("rm -rf");
  });

  test("write succeeds with no curator/reviewer involved (#4 curator-never-gates N/A here)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["skills", "write", "solo", "--content", SKILL_MD, "--json"]);
    expect(parseJsonResult(io).ok).toBe(true);
  });

  test("delete tombstones and prunes the mirror; a later write recreates it", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "s", "--content", SKILL_MD, "--json"]);
    expect(await readFile(path.join(agentsMirror("s"), "SKILL.md"), "utf8")).toContain("hello body");

    const del = await runCalyx(["skills", "delete", "s", "--json"]);
    expect(del.thrown).toBeUndefined();
    const delResult = parseJsonResult(del).result as { action: string };
    expect(delResult.action).toBe("pruned");
    await expect(readFile(path.join(agentsMirror("s"), "SKILL.md"), "utf8")).rejects.toThrow();

    // Re-create over the tombstone.
    const recreate = await runCalyx(["skills", "write", "s", "--content", SKILL_MD, "--json"]);
    expect((parseJsonResult(recreate).result as { action: string }).action).toBe("installed");
    expect(await readFile(path.join(agentsMirror("s"), "SKILL.md"), "utf8")).toContain("hello body");
  });

  test("multi-file --payload-file writes extra files into the mirror", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const payloadPath = path.join(workRoot, "payload.json");
    await (await import("node:fs/promises")).writeFile(
      payloadPath,
      JSON.stringify({ "SKILL.md": SKILL_MD, "references/extra.md": "EXTRA CONTENT" }),
      "utf8",
    );
    const io = await runCalyx(["skills", "write", "multi", "--payload-file", payloadPath, "--json"]);
    expect(parseJsonResult(io).ok).toBe(true);
    expect(await readFile(path.join(agentsMirror("multi"), "references", "extra.md"), "utf8")).toBe("EXTRA CONTENT");
  });

  test("write refuses when migration 0016 is not applied", async () => {
    // Note: NO state migrate --apply here.
    const io = await runCalyx(["skills", "write", "s", "--content", SKILL_MD, "--json"]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("skill_content_migration_absent");
  });

  test("write rejects more than one content source", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "skills",
      "write",
      "s",
      "--content",
      SKILL_MD,
      "--content-file",
      path.join(workRoot, "nope.md"),
      "--json",
    ]);
    expect(io.exitCode).toBe(2);
  });
});
