import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
    logSpy.mockRestore();
    errSpy.mockRestore();
  }

  return { stdout: out, stderr: err, exitCode, thrown };
}

describe("calyx state CLI", () => {
  let stateHome: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    delete process.env["CALYX_STATE_DB"];
    const root = await mkdtemp(join(tmpdir(), "calyx-state-cli-"));
    stateHome = join(root, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const parent = stateHome.replace(/\/state$/, "");
    await rm(parent, { recursive: true, force: true });
  });

  test("state path --json prints structured paths", async () => {
    const result = await runCalyx(["state", "path", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.stateDir).toBe(stateHome);
    expect(parsed.dbPath).toBe(join(stateHome, "calyx.db"));
    expect(parsed.envVars).toEqual({ home: "CALYX_STATE_HOME", db: "CALYX_STATE_DB" });
  });

  test("state migrate --plan --json reports pending without writing", async () => {
    const result = await runCalyx(["state", "migrate", "--plan", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.driver).toBe("node:sqlite");
    expect(parsed.current).toBeNull();
    expect(Array.isArray(parsed.pending)).toBe(true);
    expect(parsed.pending.length).toBeGreaterThan(0);
    // Read-only contract: planning a missing DB must not create the
    // state directory or database file.
    await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateHome, "calyx.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("state migrate without --plan or --apply errors", async () => {
    const result = await runCalyx(["state", "migrate", "--json"]);
    expect(result.thrown).toBeDefined();
    expect(result.exitCode).toBe(2);
  });

  test("state migrate --apply --json applies idempotently", async () => {
    const first = await runCalyx(["state", "migrate", "--apply", "--json"]);
    expect(first.thrown).toBeUndefined();
    const firstParsed = JSON.parse(first.stdout.join("\n"));
    expect(firstParsed.applied.length).toBeGreaterThan(0);
    expect(firstParsed.current).toBe(firstParsed.target);

    const second = await runCalyx(["state", "migrate", "--apply", "--json"]);
    expect(second.thrown).toBeUndefined();
    const secondParsed = JSON.parse(second.stdout.join("\n"));
    expect(secondParsed.applied).toEqual([]);
    expect(secondParsed.current).toBe(secondParsed.target);
  });

  test("state health --json fails with exit 4 when migrations pending", async () => {
    const result = await runCalyx(["state", "health", "--json"]);
    expect(result.thrown).toBeDefined();
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stdout.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.pendingMigrations).toBeGreaterThan(0);
    expect(parsed.driver).toBe("node:sqlite");
  });

  test("state doctor --json reports findings and clears after migrate", async () => {
    const before = await runCalyx(["state", "doctor", "--json"]);
    expect(before.exitCode).toBe(4);
    const beforeParsed = JSON.parse(before.stdout.join("\n"));
    expect(beforeParsed.ok).toBe(false);
    const codes = beforeParsed.findings.map((f: { code: string }) => f.code);
    expect(codes).toContain("pending-migrations");

    await runCalyx(["state", "migrate", "--apply", "--json"]);

    const after = await runCalyx(["state", "doctor", "--json"]);
    expect(after.thrown).toBeUndefined();
    const afterParsed = JSON.parse(after.stdout.join("\n"));
    expect(afterParsed.ok).toBe(true);
    expect(afterParsed.appliedMigrations.length).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      expect(afterParsed.directoryMode.modeOctal).toBe("700");
      expect(afterParsed.databaseMode.modeOctal).toBe("600");
    }
    const dbStat = await stat(join(stateHome, "calyx.db"));
    if (process.platform !== "win32") {
      expect(dbStat.mode & 0o777).toBe(0o600);
    }
  });
});
