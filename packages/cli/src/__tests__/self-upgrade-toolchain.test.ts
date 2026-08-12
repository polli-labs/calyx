import { access, chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  attestSelfUpgradeToolchain,
  buildSelfUpgradeBootstrapChildEnvironment,
  cleanupSelfUpgradeBootstrapSandbox,
  createProductionToolchainCheckForHost,
  createSelfUpgradeBootstrapSandbox,
  initializeSelfUpgradeBootstrapSandbox,
  runSelfUpgradeBuild,
  spawnSelfUpgradeChild,
  type SelfUpgradeChildSpawn,
} from "../self-upgrade-toolchain.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("C1 bootstrap toolchain attestation (POL-2140)", () => {
  test("evaluates the declared Node range and keeps bounded parent PATH evidence diagnostic", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-path-"));
    roots.push(repoRoot);
    const relativeBin = path.join(repoRoot, "relative-bin");
    await mkdir(relativeBin);
    await mkdir(path.join(relativeBin, "node"));
    await writeFile(path.join(relativeBin, "pnpm"), "#!/bin/sh\n", "utf8");
    await chmod(path.join(relativeBin, "pnpm"), 0o755);
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.1",
      engines: { node: ">=22.13.0 <27" },
    }), "utf8");
    const pathEntries = [
      "relative-bin",
      ...Array.from({ length: 33 }, (_, index) => path.join(repoRoot, `path-${index}`)),
    ];
    const childSpawn: SelfUpgradeChildSpawn = async (_command, args) => {
      if (args[0] === "--version") {
        return { code: 0, stdout: "10.34.1\n", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          node: {
            executable_realpath: "/opt/homebrew/bin/node",
            version: "v26.5.0",
            exit_code: 0,
          },
          pnpm: {
            executable_realpath: path.join(relativeBin, "pnpm"),
            resolution_source: "pnpm-exec-node-path",
            intrinsic: { version: "10.34.1", exit_code: 0, probe: "with-current" },
            nested: { version: "10.34.1", exit_code: 0 },
          },
        }),
        stderr: "",
      };
    };

    const check = await attestSelfUpgradeToolchain({
      host: "mba",
      repoRoot,
      targetSha: "8".repeat(40),
      checkedAt: "2026-08-02T00:00:00.000Z",
      env: { PATH: pathEntries.join(path.delimiter) },
      childSpawn,
      processIdentity: { execPath: process.execPath, version: "v26.5.0" },
    });

    expect(check.status).toBe("pass");
    expect(check.failures).toEqual([]);
    expect(check.observed.path_resolution).toMatchObject({
      observer: "parent_diagnostic",
      total_entries: 34,
      truncated: true,
    });
    expect(check.observed.path_resolution.entries).toHaveLength(32);
    expect(check.observed.path_resolution.entries[0]).toEqual({
      index: 0,
      directory: "$CWD/relative-bin",
      pnpm_candidate: "$CWD/relative-bin/pnpm",
    });
  });

  test("blocks the real pnpm >=10 self-dispatch versus nested executable split through the build spawn path", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-mba-"));
    roots.push(repoRoot);
    const fakeBin = path.join(repoRoot, "bin");
    const pnpmPath = path.join(fakeBin, "pnpm");
    await mkdir(fakeBin);
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.1",
      engines: { node: ">=22.13.0" },
    }), "utf8");

    // This executable models pnpm >=10's real behavior on mba: a root
    // `pnpm --version` self-dispatches to packageManager 10.34.1, while the
    // underlying PATH executable and a lifecycle child are still pnpm 11.17.
    // `pnpm exec node` executes a real Node process with that lifecycle PATH.
    await writeFile(pnpmPath, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "with" && args[1] === "current" && args[2] === "--version") {
  process.stdout.write("11.17.0\\n");
  process.exit(0);
}
if (args.includes("--config.manage-package-manager-versions=false") && args.at(-1) === "--version") {
  process.stdout.write("11.17.0\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(process.env.PNPM_LIFECYCLE_CHILD === "1" ? "11.17.0\\n" : "10.34.1\\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "node" && args[2] === "-e") {
  const result = spawnSync(process.execPath, ["-e", args[3]], {
    cwd: process.cwd(),
    env: { ...process.env, PNPM_LIFECYCLE_CHILD: "1" },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
if (args[0] === "install") process.exit(0);
if (args[0] === "-w" && args[1] === "build") {
  const nested = spawnSync(process.argv[1], ["--version"], {
    cwd: process.cwd(),
    env: { ...process.env, PNPM_LIFECYCLE_CHILD: "1" },
    encoding: "utf8",
  });
  process.exit(nested.stdout.trim() === "10.34.1" ? 0 : 42);
}
process.stderr.write("unexpected fixture invocation: " + JSON.stringify(args) + "\\n");
process.exit(64);
`, "utf8");
    await chmod(pnpmPath, 0o755);

    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      captureOutput: boolean | undefined;
    }> = [];
    const recordingSpawn: SelfUpgradeChildSpawn = async (command, args, options) => {
      calls.push({
        command,
        args,
        cwd: options.cwd,
        env: options.env,
        captureOutput: options.captureOutput,
      });
      return spawnSelfUpgradeChild(command, args, options);
    };
    const env = buildSelfUpgradeBootstrapChildEnvironment(
      { PATH: [fakeBin, path.dirname(process.execPath)].join(path.delimiter) },
      path.join(repoRoot, "bootstrap-sandbox"),
    );
    const check = await attestSelfUpgradeToolchain({
      host: "mba",
      repoRoot,
      targetSha: "9".repeat(40),
      checkedAt: "2026-08-02T00:00:00.000Z",
      env,
      childSpawn: recordingSpawn,
      // Node 26 is valid because the declared contract is >=22.13.0; it is
      // deliberately not treated as an exact-major fleet policy.
      processIdentity: { execPath: process.execPath, version: "v26.5.0" },
    });

    expect(check).toMatchObject({
      schema_version: "fleet-convergence-check/v1",
      surface: "toolchain",
      status: "blocked",
      host: "mba",
      expected: {
        node_range: ">=22.13.0",
        package_manager: "pnpm",
        pnpm_version: "10.34.1",
      },
      observed: {
        child_node: { version: process.version, exit_code: 0 },
        child_pnpm: {
          executable_realpath: "$CWD/bin/pnpm",
          resolution_source: "pnpm-exec-node-path",
          self_dispatched: { version: "10.34.1", exit_code: 0 },
          intrinsic: { version: "11.17.0", exit_code: 0, probe: "with-current" },
          nested: { version: "11.17.0", exit_code: 0 },
        },
        bootstrap_cwd: "$CWD",
      },
    });
    expect(check.failures.map((failure) => failure.code)).toEqual([
      "child_pnpm_intrinsic_version_mismatch",
      "nested_pnpm_version_mismatch",
    ]);
    expect(check.next_action?.kind).toBe("repair_toolchain");

    const build = await runSelfUpgradeBuild(
      repoRoot,
      recordingSpawn,
      env,
    );
    expect(build).toEqual({
      phase: "build",
      command: "pnpm",
      args: ["-w", "build"],
      code: 42,
    });
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ["pnpm", "--version"],
      ["pnpm", "exec", "node", "-e", expect.any(String)],
      ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      ["pnpm", "-w", "build"],
    ]);
    expect(new Set(calls.map((call) => call.cwd))).toEqual(new Set([repoRoot]));
    expect(new Set(calls.map((call) => call.env))).toEqual(new Set([env]));
    expect(Object.isFrozen(env)).toBe(true);
    expect(calls.map((call) => call.captureOutput)).toEqual([
      undefined,
      undefined,
      false,
      false,
    ]);
  });

  test("reaps a timed-out probe and reports bounded timeout evidence", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-timeout-"));
    roots.push(repoRoot);
    const startedAt = Date.now();
    const result = await spawnSelfUpgradeChild(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      cwd: repoRoot,
      env: { ...process.env },
      timeoutMs: 25,
      terminationGraceMs: 25,
      maxCaptureBytes: 256,
    });

    expect(result).toMatchObject({ code: 124, timed_out: true });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("does not resolve a timeout until a SIGTERM-resistant descendant is reaped", async () => {
    if (process.platform === "win32") return;
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-timeout-tree-"));
    roots.push(repoRoot);
    const descendantPidPath = path.join(repoRoot, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = await spawnSelfUpgradeChild(process.execPath, [
        "-e",
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(process.argv[1], String(descendant.pid));
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
        descendantPidPath,
      ], {
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 100,
        terminationGraceMs: 100,
        maxCaptureBytes: 256,
      });
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));

      expect(result).toMatchObject({ code: 124, timed_out: true });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The assertion above expects the happy path to have reaped it.
        }
      }
    }
  });

  test("rejects a zero-exit leader until its ordinary process group is terminal", async () => {
    if (process.platform === "win32") return;
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-normal-tree-"));
    roots.push(repoRoot);
    const descendantPidPath = path.join(repoRoot, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const result = await spawnSelfUpgradeChild(process.execPath, [
        "-e",
        `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(process.argv[1], String(descendant.pid));
process.exit(0);
`,
        descendantPidPath,
      ], {
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 1_000,
        terminationGraceMs: 25,
        maxCaptureBytes: 256,
      });
      descendantPid = Number(await readFile(descendantPidPath, "utf8"));

      expect(result).toMatchObject({ code: 125, process_group_violation: true });
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The assertion above verifies the expected supervisor behavior.
        }
      }
    }
  });

  test("projects only PATH/locale/TZ and operation-owned home, config, and temp roots", () => {
    const sandboxRoot = path.join("/tmp", "calyx-bootstrap-sandbox");
    const parentCanary = "generic-parent-canary";
    const childEnv = buildSelfUpgradeBootstrapChildEnvironment({
      PATH: "/fixture/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      HOME: "/host/home",
      XDG_CONFIG_HOME: "/host/config",
      TMPDIR: "/host/tmp",
      PARENT_CANARY: parentCanary,
      UNLISTED_CREDENTIAL: parentCanary,
      NODE_OPTIONS: "--require=/host/hook.js",
    }, sandboxRoot);

    expect(childEnv).toEqual({
      HOME: path.join(sandboxRoot, "home"),
      XDG_CONFIG_HOME: path.join(sandboxRoot, "config"),
      TMPDIR: path.join(sandboxRoot, "tmp"),
      TMP: path.join(sandboxRoot, "tmp"),
      TEMP: path.join(sandboxRoot, "tmp"),
      PATH: "/fixture/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
    });
    expect(Object.isFrozen(childEnv)).toBe(true);
    expect(JSON.stringify(childEnv)).not.toContain(parentCanary);
    expect(childEnv.HOME).not.toBe("/host/home");
    expect(childEnv.XDG_CONFIG_HOME).not.toBe("/host/config");
    expect(childEnv.TMPDIR).not.toBe("/host/tmp");
  });

  test("drains and discards raw build output while preserving a structured phase result", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-build-output-"));
    roots.push(repoRoot);
    const childCanary = "generic-child-output-canary";
    const rawResults: Array<{ code: number; stdout: string; stderr: string }> = [];
    const childSpawn: SelfUpgradeChildSpawn = async (_command, _args, options) => {
      expect(options.captureOutput).toBe(false);
      const raw = await spawnSelfUpgradeChild(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(childCanary)}); process.stderr.write(${JSON.stringify(childCanary)}); process.exit(17);`],
        {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: 1_000,
          captureOutput: false,
        },
      );
      rawResults.push(raw);
      return raw;
    };

    const result = await runSelfUpgradeBuild(
      repoRoot,
      childSpawn,
      buildSelfUpgradeBootstrapChildEnvironment(
        { PATH: process.env.PATH },
        path.join(repoRoot, "bootstrap-sandbox"),
      ),
    );

    expect(result).toEqual({
      phase: "install",
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
      code: 17,
    });
    expect(rawResults).toEqual([{ code: 17, stdout: "", stderr: "" }]);
    expect(JSON.stringify(result)).not.toContain(childCanary);
  });

  test("keeps schema-parsed attestation free of arbitrary failed-child output", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-attestation-output-"));
    roots.push(repoRoot);
    const childCanary = "generic-child-output-canary";
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.1",
      engines: { node: ">=22.13.0" },
    }), "utf8");

    const check = await attestSelfUpgradeToolchain({
      host: "blade",
      repoRoot,
      targetSha: "a".repeat(40),
      checkedAt: "2026-08-03T00:00:00.000Z",
      env: buildSelfUpgradeBootstrapChildEnvironment(
        { PATH: process.env.PATH },
        path.join(repoRoot, "bootstrap-sandbox"),
      ),
      childSpawn: async () => ({
        code: 1,
        stdout: childCanary,
        stderr: childCanary,
      }),
      processIdentity: { execPath: process.execPath, version: process.version },
    });

    expect(JSON.stringify(check)).not.toContain(childCanary);
    expect(check.failures.map((failure) => failure.code)).toContain("child_pnpm_unavailable");
  });

  test("keeps UTF-8 output captures within their byte ceiling", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-utf8-capture-"));
    roots.push(repoRoot);
    const result = await spawnSelfUpgradeChild(process.execPath, ["-e", "process.stdout.write('€');"], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
      maxCaptureBytes: 1,
    });

    expect(result.stdout_truncated).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("�");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(1);
  });

  test("decodes a split UTF-8 scalar before applying capture ceilings", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-utf8-split-"));
    roots.push(repoRoot);
    const splitScalar = [
      "process.stdout.write(Buffer.from([0xe2]));",
      "setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 100);",
    ].join(" ");

    const complete = await spawnSelfUpgradeChild(process.execPath, ["-e", splitScalar], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
      maxCaptureBytes: 3,
    });
    const clipped = await spawnSelfUpgradeChild(process.execPath, ["-e", splitScalar], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
      maxCaptureBytes: 2,
    });

    expect(complete).toMatchObject({ code: 0, stdout: "€" });
    expect(complete.stdout).not.toContain("�");
    expect(clipped).toMatchObject({ code: 0, stdout: "", stdout_truncated: true });
    expect(clipped.stdout).not.toContain("�");
  });

  test("uses a private frozen sandbox for the production current-host checker", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-production-check-"));
    roots.push(homeDirectory);
    const repoRoot = path.join(homeDirectory, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.1",
      engines: { node: ">=22.13.0 <27" },
    }), "utf8");
    const parentCanary = "generic-parent-canary";
    const calls: Array<{ env: NodeJS.ProcessEnv; captureOutput?: boolean }> = [];
    const childSpawn: SelfUpgradeChildSpawn = async (_command, args, options) => {
      calls.push({
        env: options.env,
        ...(options.captureOutput === undefined ? {} : { captureOutput: options.captureOutput }),
      });
      await access(options.env.HOME!);
      await access(options.env.XDG_CONFIG_HOME!);
      await access(options.env.TMPDIR!);
      if (args[0] === "--version") {
        return { code: 0, stdout: "10.34.1\n", stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          node: {
            executable_realpath: process.execPath,
            version: process.version,
            exit_code: 0,
          },
          pnpm: {
            executable_realpath: path.join(repoRoot, "pnpm"),
            resolution_source: "pnpm-exec-node-path",
            intrinsic: {
              version: "10.34.1",
              exit_code: 0,
              probe: "manage-package-manager-versions-disabled",
            },
            nested: { version: "10.34.1", exit_code: 0 },
          },
        }),
        stderr: "",
      };
    };
    const productionCheck = createProductionToolchainCheckForHost({
      currentHostAlias: "blade",
      homeDir: () => homeDirectory,
      bootstrapEnvSource: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        TZ: "UTC",
        HOME: "/ambient-home",
        PARENT_CANARY: parentCanary,
      },
      childSpawn,
      processIdentity: { execPath: process.execPath, version: process.version },
    });

    const observation = await productionCheck({
      host: "blade",
      repoRoot,
      targetSha: "b".repeat(40),
      checkedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(observation.check.status).toBe("pass");
    expect(observation.diagnostics).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.env)).size).toBe(1);
    const [env] = calls;
    expect(env?.env).toBeDefined();
    expect(Object.isFrozen(env?.env)).toBe(true);
    expect(env?.env).not.toHaveProperty("PARENT_CANARY");
    expect(env?.env.HOME).not.toBe("/ambient-home");
    await expect(access(path.dirname(env!.env.HOME!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps local cleanup residue non-authoritative while surfacing a bounded current-host diagnostic", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-cleanup-nonauthoritative-"));
    const repoRoot = await mkdtemp(path.join(tmpdir(), "calyx-c1-cleanup-repo-"));
    roots.push(homeDirectory, repoRoot);
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      packageManager: "pnpm@10.34.1",
      engines: { node: ">=22.13.0" },
    }), "utf8");
    const productionCheck = createProductionToolchainCheckForHost({
      currentHostAlias: "blade",
      homeDir: () => homeDirectory,
      bootstrapEnvSource: { PATH: process.env.PATH },
      processIdentity: { execPath: process.execPath, version: process.version },
      childSpawn: async (_command, args, options) => {
        if (args[0] === "--version") {
          return { code: 0, stdout: "10.34.1\n", stderr: "" };
        }
        const sandboxRoot = path.dirname(options.env.HOME!);
        await rm(sandboxRoot, { recursive: true, force: true });
        await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
        return {
          code: 0,
          stdout: JSON.stringify({
            node: {
              executable_realpath: process.execPath,
              version: process.version,
              exit_code: 0,
            },
            pnpm: {
              executable_realpath: path.join(repoRoot, "pnpm"),
              resolution_source: "pnpm-exec-node-path",
              intrinsic: {
                version: "10.34.1",
                exit_code: 0,
                probe: "manage-package-manager-versions-disabled",
              },
              nested: { version: "10.34.1", exit_code: 0 },
            },
          }),
          stderr: "",
        };
      },
    });

    const observation = await productionCheck({
      host: "blade",
      repoRoot,
      targetSha: "c".repeat(40),
      checkedAt: "2026-08-04T00:00:00.000Z",
    });

    expect(observation.check.status).toBe("pass");
    expect(observation.diagnostics).toEqual([{
      kind: "operation_cleanup",
      severity: "warning",
      detail: "residue",
      message: expect.stringContaining("left residue"),
      actions: [],
    }]);
    expect(JSON.stringify(observation.diagnostics)).not.toContain(homeDirectory);
  });

  test("repairs only this invocation's marker-gated workspace root", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-sandbox-cleanup-"));
    roots.push(homeDirectory);
    const cleanupSandbox = createSelfUpgradeBootstrapSandbox({
      homeDirectory,
      sourceEnv: { PATH: process.env.PATH },
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    await initializeSelfUpgradeBootstrapSandbox(cleanupSandbox);
    const deniedDirectory = path.join(cleanupSandbox.root, "pnpm", "store");
    await mkdir(deniedDirectory, { recursive: true });
    await writeFile(path.join(deniedDirectory, "cache"), "private", "utf8");
    await chmod(path.dirname(deniedDirectory), 0o000);

    const earlierWorkspace = createSelfUpgradeBootstrapSandbox({
      homeDirectory,
      sourceEnv: { PATH: process.env.PATH },
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    await initializeSelfUpgradeBootstrapSandbox(earlierWorkspace);

    await expect(cleanupSelfUpgradeBootstrapSandbox(cleanupSandbox)).resolves.toEqual({ status: "cleaned" });
    await expect(access(cleanupSandbox.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(earlierWorkspace.root)).resolves.toBeUndefined();
  });

  test("removes an exact-root symlink without traversing or mutating its target", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-cleanup-root-link-"));
    roots.push(homeDirectory);
    const sandbox = createSelfUpgradeBootstrapSandbox({
      homeDirectory,
      sourceEnv: { PATH: process.env.PATH },
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    await initializeSelfUpgradeBootstrapSandbox(sandbox);
    const externalTarget = path.join(homeDirectory, "external-target");
    const canary = path.join(externalTarget, "must-survive");
    await writeFile(path.join(sandbox.root, "must-survive"), "external canary", "utf8");
    await rename(sandbox.root, externalTarget);
    await symlink(externalTarget, sandbox.root, "dir");

    await expect(cleanupSelfUpgradeBootstrapSandbox(sandbox)).resolves.toEqual({ status: "cleaned" });
    await expect(access(sandbox.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(canary, "utf8")).resolves.toBe("external canary");
  });

  test("classifies a root recreated after rm success as residue instead of claiming cleanup", async () => {
    const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-cleanup-recreated-"));
    roots.push(homeDirectory);
    const sandbox = createSelfUpgradeBootstrapSandbox({
      homeDirectory,
      sourceEnv: { PATH: process.env.PATH },
      operationId: "33333333-3333-4333-8333-333333333333",
    });
    await initializeSelfUpgradeBootstrapSandbox(sandbox);

    await expect(cleanupSelfUpgradeBootstrapSandbox(sandbox, {
      afterSuccessfulRemoval: async (root) => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await writeFile(path.join(root, "replacement"), "unowned", "utf8");
      },
    })).resolves.toEqual({ status: "residue" });

    await expect(access(sandbox.root)).resolves.toBeUndefined();
  });

  test.each(["EACCES", "EIO"])(
    "classifies a %s post-removal root probe as inspection_unavailable",
    async (code) => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "calyx-c1-cleanup-unavailable-"));
      roots.push(homeDirectory);
      const sandbox = createSelfUpgradeBootstrapSandbox({
        homeDirectory,
        sourceEnv: { PATH: process.env.PATH },
      });
      await initializeSelfUpgradeBootstrapSandbox(sandbox);

      await expect(cleanupSelfUpgradeBootstrapSandbox(sandbox, {
        lstatRoot: async () => {
          throw Object.assign(new Error(`fixture ${code}`), { code });
        },
      })).resolves.toEqual({ status: "inspection_unavailable" });
    },
  );
});
