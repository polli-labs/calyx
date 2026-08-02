import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const execFile = promisify(execFileCallback);

async function createBootstrapWorkspaceFixture(): Promise<{ root: string; executablePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-cli-bootstrap-"));
  const packageDir = path.join(root, "packages", "cli");
  const distDir = path.join(packageDir, "dist");
  const srcDir = path.join(packageDir, "src");
  const siblingSrcDir = path.join(root, "packages", "core", "src");
  await mkdir(distDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });
  await mkdir(siblingSrcDir, { recursive: true });
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  const packageJsonPath = path.join(packageDir, "package.json");
  await writeFile(packageJsonPath, JSON.stringify({ name: "@polli-labs/calyx-cli" }), "utf8");
  await writeFile(path.join(distDir, "bin.js"), "#!/usr/bin/env node\nconsole.log('built');\n", "utf8");
  await writeFile(path.join(srcDir, "run-cli.ts"), "export const cli = true;\n", "utf8");
  await writeFile(path.join(siblingSrcDir, "index.ts"), "export const core = true;\n", "utf8");

  const executablePath = path.join(distDir, "bin.js");
  const older = new Date("2026-03-16T00:00:00Z");
  const newer = new Date("2026-03-16T00:05:00Z");
  await utimes(executablePath, older, older);
  await utimes(packageJsonPath, older, older);
  await utimes(path.join(srcDir, "run-cli.ts"), newer, newer);
  await utimes(path.join(siblingSrcDir, "index.ts"), newer, newer);

  return { root, executablePath };
}

describe("install bootstrap command", () => {
  const originalArgv1 = process.argv[1] ?? process.execPath;
  const originalInstallsRoot = process.env["CALYX_INSTALLS_ROOT"];

  afterEach(async () => {
    vi.restoreAllMocks();
    process.argv[1] = originalArgv1;
    if (originalInstallsRoot === undefined) {
      delete process.env["CALYX_INSTALLS_ROOT"];
    } else {
      process.env["CALYX_INSTALLS_ROOT"] = originalInstallsRoot;
    }
  });

  test("install bootstrap --json exits 3 and prints a blocked result when build artifacts are stale", async () => {
    const fixture = await createBootstrapWorkspaceFixture();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();
    process.argv[1] = fixture.executablePath;
    process.env["CALYX_INSTALLS_ROOT"] = path.join(fixture.root, "missing-installs");

    try {
      await expect(
        program.parseAsync(["node", "calyx", "install", "bootstrap", "--apply", "--json"]),
      ).rejects.toMatchObject({ exitCode: 3 });

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        action: string;
        staleBuild?: { executablePath: string; newestSourcePath: string };
      };
      expect(payload.action).toBe("blocked-bootstrap");
      expect(payload.staleBuild?.executablePath).toBe(await realpath(fixture.executablePath));
      expect(payload.staleBuild?.newestSourcePath).toContain("/packages/");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("install bootstrap renders the wrapper to the promoted current install when available", async () => {
    const fixture = await createBootstrapWorkspaceFixture();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();
    const installsRoot = path.join(fixture.root, "installs");
    const installPath = path.join(installsRoot, "c".repeat(40));
    const promotedBin = path.join(installPath, "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
    const currentBin = path.join(installsRoot, "current", "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
    const secondInstallPath = path.join(installsRoot, "d".repeat(40));
    const secondPromotedBin = path.join(secondInstallPath, "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
    const target = path.join(fixture.root, "agents");
    const currentLink = path.join(installsRoot, "current");
    process.argv[1] = fixture.executablePath;
    process.env["CALYX_INSTALLS_ROOT"] = installsRoot;

    await mkdir(path.dirname(promotedBin), { recursive: true });
    await writeFile(promotedBin, "#!/usr/bin/env node\nconsole.log('promoted');\n", "utf8");
    await chmod(promotedBin, 0o755);
    await mkdir(path.dirname(secondPromotedBin), { recursive: true });
    await writeFile(secondPromotedBin, "#!/usr/bin/env node\nconsole.log('promoted-next');\n", "utf8");
    await chmod(secondPromotedBin, 0o755);
    await symlink(path.basename(installPath), currentLink, "dir");

    try {
      await program.parseAsync(["node", "calyx", "install", "bootstrap", "--target", target, "--apply", "--json"]);

      const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
        action: string;
        sourceExecutablePath?: string;
        warnings?: string[];
      };
      expect(payload.action).toBe("bootstrap");
      expect(payload.sourceExecutablePath).toBe(currentBin);
      expect(payload.warnings?.join("\n")).toContain("using promoted Calyx install");
      const wrapperPath = path.join(target, "run", "calyx");
      const wrapper = await readFile(wrapperPath, "utf8");
      expect(wrapper).toContain(`SOURCE_EXECUTABLE_PATH='${currentBin}'`);
      expect((await execFile(wrapperPath, [], { env: process.env })).stdout.trim()).toBe("promoted");

      await rename(currentLink, path.join(installsRoot, "previous-current"));
      await symlink(path.basename(secondInstallPath), currentLink, "dir");
      expect((await execFile(wrapperPath, [], { env: process.env })).stdout.trim()).toBe("promoted-next");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
