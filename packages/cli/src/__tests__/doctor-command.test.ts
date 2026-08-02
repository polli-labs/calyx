import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const execFileP = promisify(execFile);

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  thrown?: unknown;
}

const tempRoots: string[] = [];
const originalAgentsInfraRoot = process.env["CALYX_AGENTS_INFRA_ROOT"];
const originalDaemonsRoot = process.env["CALYX_DAEMONS_ROOT"];
const originalHome = process.env["HOME"];

async function runCalyx(argv: string[]): Promise<CapturedIO> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    stdout.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    stderr.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });

  let thrown: unknown;
  let exitCode: number | null = null;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
  } catch (error) {
    thrown = error;
    if (error && typeof error === "object" && "exitCode" in error) {
      const code = (error as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") {
        exitCode = code;
      }
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }

  return { stdout, stderr, exitCode, thrown };
}

async function createAgentsInfraFixture(): Promise<{ root: string; repoRoot: string; hostsPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-doctor-cli-"));
  tempRoots.push(root);

  const repoRoot = path.join(root, "home", "carbon", "dev", "calyx", "dev");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");

  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await mkdir(repoRoot, { recursive: true });

  await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify({ globals: { hot: "instructions/templates/global/AGENTS.global.hot.md.mustache" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    hostsPath,
    [
      "hosts:",
      "  carbon:",
      `    home: ${path.join(root, "home", "carbon")}`,
      "    repos:",
      `      calyx: ${repoRoot}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await execFileP("git", ["init"], { cwd: repoRoot });

  return { root, repoRoot, hostsPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (originalAgentsInfraRoot === undefined) {
    delete process.env["CALYX_AGENTS_INFRA_ROOT"];
  } else {
    process.env["CALYX_AGENTS_INFRA_ROOT"] = originalAgentsInfraRoot;
  }
  if (originalDaemonsRoot === undefined) {
    delete process.env["CALYX_DAEMONS_ROOT"];
  } else {
    process.env["CALYX_DAEMONS_ROOT"] = originalDaemonsRoot;
  }
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("doctor command", () => {
  test("doctor --host --json includes repo registry output shape", async () => {
    const fixture = await createAgentsInfraFixture();
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;

    const result = await runCalyx(["doctor", "--host", "carbon", "--json"]);

    expect(result.thrown).toBeUndefined();
    const payload = JSON.parse(result.stdout.join("\n")) as {
      ok: boolean;
      repoRegistry?: {
        ok: boolean;
        host: string;
        source_path: string;
        roots: Array<{ repo: string; configured_root: string; git_toplevel?: string }>;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.repoRegistry).toEqual(
      expect.objectContaining({
        ok: true,
        host: "carbon",
        source_path: fixture.hostsPath,
      }),
    );
    expect(payload.repoRegistry?.roots).toEqual([
      expect.objectContaining({
        repo: "calyx",
        configured_root: fixture.repoRoot,
        git_toplevel: expect.stringContaining(fixture.repoRoot),
      }),
    ]);
  });

  test("doctor --json flags daemon descriptors and wrappers that serve from the clone", async () => {
    const fixture = await createAgentsInfraFixture();
    const home = path.join(fixture.root, "home", "carbon");
    const daemonsRoot = path.join(fixture.root, "daemons");
    const descriptorDir = path.join(daemonsRoot, "run-serve");
    const wrapperPath = path.join(home, ".agents", "run", "calyx");
    const cloneBin = path.join(fixture.repoRoot, "packages", "cli", "dist", "bin.js");
    process.env["CALYX_AGENTS_INFRA_ROOT"] = fixture.root;
    process.env["CALYX_DAEMONS_ROOT"] = daemonsRoot;
    process.env["HOME"] = home;

    await mkdir(descriptorDir, { recursive: true });
    await mkdir(path.dirname(wrapperPath), { recursive: true });
    await writeFile(
      path.join(descriptorDir, "descriptor.json"),
      `${JSON.stringify({
        schema_version: "calyx-daemon/v1",
        daemon_id: "run-serve",
        daemon_kind: "run-service",
        pid: 123,
        argv: [process.execPath, cloneBin, "run", "serve"],
        cwd: fixture.repoRoot,
        runs_root: path.join(home, ".calyx", "runs"),
        health_url: "http://127.0.0.1:8740",
        livez_url: "http://127.0.0.1:8740/livez",
        supervisor: { kind: "systemd", unit_name: "calyx-run-serve.service" },
        started_at: "2026-06-12T00:00:00.000Z",
        build: { git_head: "a".repeat(40), built_at: "2026-06-12T00:00:00.000Z", package_version: "0.2.0" },
        restart_order: 10,
        depends_on: [],
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(wrapperPath, `SOURCE_EXECUTABLE_PATH='${cloneBin}'\n`, "utf8");

    const result = await runCalyx(["doctor", "--host", "carbon", "--json"]);

    expect(result.thrown).toBeUndefined();
    const payload = JSON.parse(result.stdout.join("\n")) as {
      ok: boolean;
      findings?: Array<{ code: string; severity: string; evidence: string[]; remediation: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.findings).toEqual([
      expect.objectContaining({
        code: "daemon-serves-from-clone",
        severity: "error",
        evidence: expect.arrayContaining([
          expect.stringContaining("descriptor run-serve argv references clone path"),
          expect.stringContaining("wrapper"),
        ]),
        remediation: expect.stringContaining("calyx self upgrade --host <this-host>"),
      }),
    ]);
  });
});
