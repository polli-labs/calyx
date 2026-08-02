import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listSkillContent, openStateStore, readSkillContent } from "@polli-labs/calyx-core";

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

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let thrown: unknown;
  let exitCode: number | null = null;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
    if (typeof process.exitCode === "number") {
      exitCode = process.exitCode;
    }
  } catch (e) {
    thrown = e;
    if (e && typeof e === "object" && "exitCode" in e) {
      const code = (e as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") exitCode = code;
    }
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out, stderr: err, exitCode, thrown };
}

const VECTOR_BODY = JSON.stringify({
  status: "success",
  data: {
    resultType: "vector",
    result: [
      { metric: { skill_name: "high-skill" }, value: [1718000000, "9"] },
      { metric: { skill_name: "low-skill" }, value: [1718000000, "2"] },
    ],
  },
});

describe("calyx skills usage CLI (POL-1729)", () => {
  let server: Server;
  let endpoint: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VECTOR_BODY);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("--json emits the stable envelope with parsed rows", async () => {
    const result = await runCalyx(["skills", "usage", "--json", "--endpoint", endpoint, "--limit", "10"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("skills.usage");
    expect(parsed.result.schema_version).toBe("skills.usage/v1");
    expect(parsed.result.status).toBe("ok");
    expect(parsed.result.limit).toBe(10);
    expect(parsed.result.skills.map((row: { skill_name: string }) => row.skill_name)).toEqual([
      "high-skill",
      "low-skill",
    ]);
    expect((result.exitCode ?? 0)).toBe(0);
  });

  test("--limit over the max is clamped to 100", async () => {
    const result = await runCalyx(["skills", "usage", "--json", "--endpoint", endpoint, "--limit", "5000"]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.result.limit).toBe(100);
  });

  test("--json: unavailable backend exits 0, carries suggestions in-band, and writes NOTHING to stderr", async () => {
    // Point at an unreachable port to force the unavailable path.
    const result = await runCalyx([
      "skills",
      "usage",
      "--json",
      "--endpoint",
      "http://127.0.0.1:9",
    ]);
    expect(result.thrown).toBeUndefined();
    expect((result.exitCode ?? 0)).toBe(0);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.result.status).toBe("unavailable");
    expect(parsed.result.notes.join(" ")).toContain("POL-1834");
    // Suggestions ride in the JSON result, not on stderr.
    expect(parsed.result.suggestions.join(" ")).toContain("CALYX_LOKI_ENDPOINT");
    expect(result.stderr.join("\n")).toBe("");
  });

  test("text mode: unavailable backend prints the unavailable reason + suggestions to stderr", async () => {
    const result = await runCalyx(["skills", "usage", "--endpoint", "http://127.0.0.1:9"]);
    expect(result.thrown).toBeUndefined();
    expect((result.exitCode ?? 0)).toBe(0);
    const stderr = result.stderr.join("\n");
    expect(stderr).toContain("unreachable");
    expect(stderr).toContain("CALYX_LOKI_ENDPOINT");
  });

  test("rejects a malformed --since with an enumerated error (exit 2)", async () => {
    const result = await runCalyx(["skills", "usage", "--since", "lastweek", "--endpoint", endpoint, "--json"]);
    expect(result.exitCode).toBe(2);
    const message = result.thrown && typeof result.thrown === "object" && "message" in result.thrown
      ? String((result.thrown as { message?: unknown }).message)
      : "";
    expect(message).toContain("--since");
    expect(message).toContain("7d");
  });
});

describe("calyx skills curator CLI (POL-1729)", () => {
  let workRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "calyx-curator-cli-"));
    registryPath = join(workRoot, "SOURCES.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: "curator-cli-test",
        skills: [
          { id: "alpha", source: { type: "internal", repo: "polli-labs/agents-infra", path: "a/SKILL.md" } },
          {
            id: "beta",
            status: "deprecated",
            deprecated_by: "alpha",
            source: { type: "internal", repo: "polli-labs/agents-infra", path: "b/SKILL.md" },
          },
        ],
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  test("curator run --apply without --confirm refuses (exit 2)", async () => {
    // Slice 3: --apply WORKS, but it is mutating and requires --confirm. The
    // refusal happens before any store/registry work.
    const result = await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--json",
      "--registry",
      registryPath,
    ]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("skills.curator.run");
    expect(parsed.error.code).toBe("confirm_required");
    expect(result.exitCode).toBe(2);
  });

  test("curator run --dry-run --json emits the stable report envelope", async () => {
    // No --endpoint reachable -> backend unavailable, recs suppressed, exit 0.
    const result = await runCalyx([
      "skills",
      "curator",
      "run",
      "--dry-run",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      "http://127.0.0.1:9",
    ]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("skills.curator.run");
    expect(parsed.result.schema_version).toBe("skills.curator-report/v1");
    expect(parsed.result.mode).toBe("dry-run");
    expect(parsed.result.total_skills).toBe(2);
    expect(parsed.result.usage_backend.status).toBe("unavailable");
    expect(parsed.result.recommendations).toEqual([]);
    expect(parsed.result.notes[0]).toContain("usage-grounded recommendations suppressed");
  });

  test("curator run --limit over the max clamps the listed recommendations to 100 (summary stays full)", async () => {
    // An ok backend with an empty vector -> every 0-load skill earns a recommendation.
    const okServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }));
    });
    await new Promise<void>((resolve) => okServer.listen(0, "127.0.0.1", resolve));
    const okEndpoint = `http://127.0.0.1:${(okServer.address() as AddressInfo).port}`;
    const bigRegistryPath = join(workRoot, "BIG_SOURCES.json");
    const skillCount = 150;
    await writeFile(
      bigRegistryPath,
      JSON.stringify({
        version: "curator-cli-clamp",
        skills: Array.from({ length: skillCount }, (_unused, i) => ({
          id: `skill-${i}`,
          source: { type: "internal", repo: "polli-labs/agents-infra", path: `s${i}/SKILL.md` },
        })),
      }),
      "utf8",
    );

    try {
      const result = await runCalyx([
        "skills",
        "curator",
        "run",
        "--dry-run",
        "--json",
        "--registry",
        bigRegistryPath,
        "--endpoint",
        okEndpoint,
        "--limit",
        "5000",
      ]);
      expect(result.thrown).toBeUndefined();
      const parsed = JSON.parse(result.stdout.join("\n"));
      expect(parsed.result.usage_backend.status).toBe("ok");
      // Listed recommendations are bounded to the max...
      expect(parsed.result.recommendations).toHaveLength(100);
      // ...but the summary reflects the full (un-clamped) total.
      expect(parsed.result.summary["low-signal"]).toBe(skillCount);
    } finally {
      await new Promise<void>((resolve) => okServer.close(() => resolve()));
    }
  });
});

describe("calyx skills curator apply/mutation CLI (POL-1729 Slice 3)", () => {
  let workRoot: string;
  let sandboxHome: string;
  let registryPath: string;
  let okServer: Server;
  let okEndpoint: string;
  let original: Record<string, string | undefined>;

  // An ok Loki backend with an EMPTY vector → every db skill reads use_count 0,
  // so a deprecated skill becomes an archive-candidate. Mocked (no real Loki).
  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CODEX_HOME: process.env["CODEX_HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    workRoot = await mkdtemp(join(tmpdir(), "calyx-curator-apply-cli-"));
    sandboxHome = join(workRoot, "home");
    await mkdir(sandboxHome, { recursive: true });
    // SAFETY rule 2: sandbox install mirrors + state DB.
    process.env["HOME"] = sandboxHome;
    process.env["CODEX_HOME"] = join(sandboxHome, ".codex");
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = join(workRoot, "state");

    registryPath = join(workRoot, "SOURCES.json");

    okServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }));
    });
    await new Promise<void>((resolve) => okServer.listen(0, "127.0.0.1", resolve));
    okEndpoint = `http://127.0.0.1:${(okServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => okServer.close(() => resolve()));
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  function skillMd(title: string, description: string, body = "hello body"): string {
    return `---\ntitle: ${title}\ndescription: ${description}\n---\n# ${title}\n\n${body}\n`;
  }

  async function writeRegistry(entries: Array<{ id: string; status?: string }>): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: "slice3-apply-cli",
        skills: entries.map((e) => ({
          id: e.id,
          ...(e.status ? { status: e.status } : {}),
          source: { type: "internal", repo: "polli-labs/agents-infra", path: `${e.id}/SKILL.md`, regime: "db" },
        })),
      }),
      "utf8",
    );
  }

  async function dbRow(name: string): Promise<{ deleted_at: string | null; pinned: boolean } | undefined> {
    const opened = await openStateStore();
    try {
      // The CLI scopes rows to ALL hosts only via host-keyed reads; list across
      // all hosts and match by name so we read the same row the CLI wrote
      // regardless of the test host's hostname.
      const row = listSkillContent(opened.db, { includeTombstoned: true, limit: 2000 }).find(
        (r) => r.skill_name === name,
      );
      void readSkillContent; // keep import used
      return row ? { deleted_at: row.deleted_at, pinned: row.pinned } : undefined;
    } finally {
      opened.db.close();
    }
  }

  test("curator run --apply --confirm with a non-ok backend BLOCKS all mutations (blind-sensor, exit 3)", async () => {
    await writeRegistry([{ id: "stale-skill", status: "deprecated" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "stale-skill", "--content", skillMd("Stale", "old"), "--json"]);

    const result = await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--confirm",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      "http://127.0.0.1:9", // unreachable → usage unavailable
    ]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("usage_backend_blocked");
    expect(parsed.error.message).toContain("blind-sensor");
    expect(result.exitCode).toBe(3);
    // NOTHING mutated: the skill is still live.
    expect((await dbRow("stale-skill"))!.deleted_at).toBeNull();
  });

  test("curator run --apply --confirm archives a deprecated+unused db skill and prunes the mirror", async () => {
    await writeRegistry([{ id: "stale-skill", status: "deprecated" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "stale-skill", "--content", skillMd("Stale", "old"), "--json"]);
    expect(await readFile(join(sandboxHome, ".agents", "skills", "stale-skill", "SKILL.md"), "utf8")).toContain("hello body");

    const result = await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--confirm",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      okEndpoint,
    ]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.schema_version).toBe("skills.curator-apply/v1");
    expect(parsed.result.archived).toEqual(["stale-skill"]);
    expect(parsed.result.rollback_cursor).not.toBeNull();
    // Tombstoned + mirror pruned.
    expect((await dbRow("stale-skill"))!.deleted_at).not.toBeNull();
    await expect(
      readFile(join(sandboxHome, ".agents", "skills", "stale-skill", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("pinning fences archive: a pinned deprecated skill is pinned_skipped, not tombstoned", async () => {
    await writeRegistry([{ id: "pinned-skill", status: "deprecated" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "pinned-skill", "--content", skillMd("Pinned", "keep"), "--json"]);
    const pin = await runCalyx(["skills", "curator", "pin", "pinned-skill", "--json"]);
    expect(JSON.parse(pin.stdout.join("\n")).result.pinned).toBe(true);

    const result = await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--confirm",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      okEndpoint,
    ]);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.result.archived).toEqual([]);
    expect(parsed.result.pinned_skipped).toEqual(["pinned-skill"]);
    expect((await dbRow("pinned-skill"))!.deleted_at).toBeNull();
  });

  test("consolidate via CLI folds sources into the target; refuses a pinned source", async () => {
    await writeRegistry([{ id: "src-a" }, { id: "src-b" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "src-a", "--content", skillMd("A", "alpha"), "--json"]);
    await runCalyx(["skills", "write", "src-b", "--content", skillMd("B", "bravo"), "--json"]);
    const mergedPath = join(workRoot, "merged.md");
    await writeFile(mergedPath, skillMd("Merged", "the survivor"), "utf8");

    const ok = await runCalyx([
      "skills",
      "curator",
      "consolidate",
      "src-a",
      "src-b",
      "--into",
      "merged",
      "--content-file",
      mergedPath,
      "--json",
    ]);
    const okParsed = JSON.parse(ok.stdout.join("\n"));
    expect(okParsed.ok).toBe(true);
    expect(okParsed.result.consolidated.sort()).toEqual(["src-a", "src-b"]);
    expect(await readFile(join(sandboxHome, ".agents", "skills", "merged", "SKILL.md"), "utf8")).toContain("the survivor");
    expect((await dbRow("src-a"))!.deleted_at).not.toBeNull();

    // Now a pinned-source refusal: recreate + pin, then consolidate must refuse.
    await runCalyx(["skills", "write", "keep-me", "--content", skillMd("K", "keep"), "--json"]);
    await runCalyx(["skills", "curator", "pin", "keep-me", "--json"]);
    const refused = await runCalyx([
      "skills",
      "curator",
      "consolidate",
      "keep-me",
      "--into",
      "merged2",
      "--content-file",
      mergedPath,
      "--json",
    ]);
    const refusedParsed = JSON.parse(refused.stdout.join("\n"));
    expect(refusedParsed.ok).toBe(false);
    expect(refusedParsed.error.code).toBe("pinned_source");
    expect(refused.exitCode).toBe(3);
    // keep-me untouched.
    expect((await dbRow("keep-me"))!.deleted_at).toBeNull();
  });

  test("rollback --last restores the most recent apply pass", async () => {
    await writeRegistry([{ id: "recover-me", status: "deprecated" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "recover-me", "--content", skillMd("Recover", "back"), "--json"]);

    const apply = await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--confirm",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      okEndpoint,
    ]);
    expect(JSON.parse(apply.stdout.join("\n")).result.archived).toEqual(["recover-me"]);
    expect((await dbRow("recover-me"))!.deleted_at).not.toBeNull();

    const rb = await runCalyx(["skills", "curator", "rollback", "--last", "--json"]);
    const rbParsed = JSON.parse(rb.stdout.join("\n"));
    expect(rbParsed.ok).toBe(true);
    expect(rbParsed.result.restored).toEqual(["recover-me"]);
    // Live again + mirror restored.
    expect((await dbRow("recover-me"))!.deleted_at).toBeNull();
    expect(await readFile(join(sandboxHome, ".agents", "skills", "recover-me", "SKILL.md"), "utf8")).toContain("back");
  });

  test("NEVER-GATES-A-WRITE (#4): a free `skills write` succeeds regardless of curator state", async () => {
    await writeRegistry([{ id: "stale-skill", status: "deprecated" }]);
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["skills", "write", "stale-skill", "--content", skillMd("Stale", "old"), "--json"]);
    // Pin some skills + run an apply pass (curator is "active" / has mutated).
    await runCalyx(["skills", "write", "pinned-one", "--content", skillMd("P", "pinned"), "--json"]);
    await runCalyx(["skills", "curator", "pin", "pinned-one", "--json"]);
    await runCalyx([
      "skills",
      "curator",
      "run",
      "--apply",
      "--confirm",
      "--json",
      "--registry",
      registryPath,
      "--endpoint",
      okEndpoint,
    ]);

    // A free write lands cleanly alongside the curator's activity — no long lock
    // ever blocks it (each curator archive is its own short transaction).
    const write = await runCalyx(["skills", "write", "fresh-skill", "--content", skillMd("Fresh", "new"), "--json"]);
    expect(write.thrown).toBeUndefined();
    const parsed = JSON.parse(write.stdout.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.action).toBe("installed");
    expect(await readFile(join(sandboxHome, ".agents", "skills", "fresh-skill", "SKILL.md"), "utf8")).toContain("new");
  });
});
