import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { syncSkillsRegistry } from "../skills";
import { syncPromptsRegistry } from "../prompts";
import { bumpToolVersion } from "../tools";
import { execNotify } from "../exec";
import { createExecPlan } from "../knowledge";
import { runDoctor } from "../doctor";
import { installBootstrap } from "../install";
import { INTERFACE_DOMAIN_CLASSIFICATIONS, INTERFACE_MANIFEST_RECORDS } from "../interface-manifest";
import { buildBundle } from "../bundle";
import {
  WRAPPER_REGISTRY,
  emitWrapperTelemetry,
  checkWrapperGuardrail,
  getWrapperDeprecationPhase,
  getDeferredWrapperMessage,
  getDeprecatedWrapperMessage,
  getRetiredWrapperMessage
} from "../wrappers";
import type { WrapperTelemetryEvent } from "../types";

const execFile = promisify(execFileCallback);

/**
 * Wrapper behavior tests.
 *
 * These tests validate the wrapper lifecycle contract:
 * 1. Retired wrappers (P9) produce clear "removed" messages.
 * 2. Deferred wrappers produce clear "not yet implemented" messages.
 * 3. Implemented wrappers (POL-679) have canonical command targets.
 * 4. The canonical WRAPPER_REGISTRY is complete and consistent.
 * 5. Telemetry and guardrail helpers remain functional for audit.
 * 6. Domain functions are called with the correct backend routing.
 * 7. New canonical command functions return structured results.
 */

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function createBootstrapWorkspaceFixture(): Promise<{ root: string; executablePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-workspace-"));
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

function isValidTelemetryEvent(event: WrapperTelemetryEvent): boolean {
  return (
    event.event === "calyx.wrapper.invoked" &&
    typeof event.wrapper === "string" &&
    event.wrapper.length > 0 &&
    typeof event.target === "string" &&
    event.target.length > 0 &&
    typeof event.timestamp === "string" &&
    !isNaN(Date.parse(event.timestamp)) &&
    typeof event.pid === "number" &&
    event.pid > 0 &&
    typeof event.cwd === "string" &&
    event.cwd.length > 0 &&
    typeof event.deprecation_phase === "string" &&
    (event.deprecation_phase === "warn" || event.deprecation_phase === "error" || event.deprecation_phase === "active")
  );
}

afterEach(() => {
  delete process.env["CALYX_FAIL_ON_DEPRECATED"];
});

const tempDirs: string[] = [];
let previousInstallEnv: {
  CALYX_HOME?: string | undefined;
  CALYX_INSTALLS_ROOT?: string | undefined;
};

beforeEach(async () => {
  previousInstallEnv = {
    CALYX_HOME: process.env["CALYX_HOME"],
    CALYX_INSTALLS_ROOT: process.env["CALYX_INSTALLS_ROOT"],
  };
  const installsRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-test-installs-"));
  tempDirs.push(installsRoot);
  delete process.env["CALYX_HOME"];
  process.env["CALYX_INSTALLS_ROOT"] = installsRoot;
});

async function isolatedInstallsRoot(prefix = "calyx-test-installs-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  if (previousInstallEnv.CALYX_HOME === undefined) {
    delete process.env["CALYX_HOME"];
  } else {
    process.env["CALYX_HOME"] = previousInstallEnv.CALYX_HOME;
  }
  if (previousInstallEnv.CALYX_INSTALLS_ROOT === undefined) {
    delete process.env["CALYX_INSTALLS_ROOT"];
  } else {
    process.env["CALYX_INSTALLS_ROOT"] = previousInstallEnv.CALYX_INSTALLS_ROOT;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ── Telemetry contract ──────────────────────────────────────────────

describe("wrapper telemetry contract", () => {
  test("telemetry event shape is valid with enriched fields", () => {
    const event = emitWrapperTelemetry("test-wrapper", "calyx test command");
    expect(isValidTelemetryEvent(event)).toBe(true);
    expect(event.pid).toBe(process.pid);
    expect(event.cwd).toBe(process.cwd());
    expect(event.deprecation_phase).toBe("warn");
  });

  test("telemetry event rejects invalid timestamp", () => {
    const event: WrapperTelemetryEvent = {
      event: "calyx.wrapper.invoked",
      wrapper: "test-wrapper",
      target: "calyx test command",
      timestamp: "not-a-date",
      pid: 1,
      cwd: "/tmp",
      deprecation_phase: "warn"
    };
    expect(isValidTelemetryEvent(event)).toBe(false);
  });

  test("telemetry event includes deprecation_phase=error when env is set", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const event = emitWrapperTelemetry("test-wrapper", "calyx test command");
    expect(event.deprecation_phase).toBe("error");
  });
});

// ── Guardrail behavior ──────────────────────────────────────────────

describe("wrapper guardrails", () => {
  test("default phase is warn (wrappers allowed)", () => {
    expect(getWrapperDeprecationPhase()).toBe("warn");
  });

  test("CALYX_FAIL_ON_DEPRECATED=1 sets phase to error", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    expect(getWrapperDeprecationPhase()).toBe("error");
  });

  test("CALYX_FAIL_ON_DEPRECATED=true sets phase to error", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "true";
    expect(getWrapperDeprecationPhase()).toBe("error");
  });

  test("checkWrapperGuardrail allows in warn phase", () => {
    const result = checkWrapperGuardrail("test-wrapper", "calyx test command");
    expect(result.allowed).toBe(true);
    expect(result.phase).toBe("warn");
  });

  test("checkWrapperGuardrail blocks in error phase", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const result = checkWrapperGuardrail("test-wrapper", "calyx test command");
    expect(result.allowed).toBe(false);
    expect(result.phase).toBe("error");
    expect(result.message).toContain("CALYX_FAIL_ON_DEPRECATED");
    expect(result.message).toContain("calyx test command");
  });
});

// ── Deprecated wrapper messages (POL-680) ───────────────────────────

describe("deprecated wrapper tombstones (POL-680)", () => {
  test("getDeprecatedWrapperMessage returns actionable message for agent-notify", () => {
    const msg = getDeprecatedWrapperMessage("agent-notify");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-13");
    expect(msg).toContain("calyx run launch --kernel host_process");
    expect(msg).toContain("calyx exec notify");
    expect(msg).toContain("low-level notification primitive");
  });

  test("getDeprecatedWrapperMessage returns actionable message for agents-fleet", () => {
    const msg = getDeprecatedWrapperMessage("agents-fleet");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("calyx skills sync");
    expect(msg).toContain("calyx agents validate");
    expect(msg).toContain("calyx verify fleet");
    expect(msg).not.toContain("calyx agents sync");
    expect(msg).not.toContain("calyx agents deploy");
  });

  test("getDeprecatedWrapperMessage returns actionable message for agents-fleet-apply", () => {
    const msg = getDeprecatedWrapperMessage("agents-fleet-apply");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("calyx agents validate");
    expect(msg).toContain("--apply");
    expect(msg).not.toContain("calyx agents sync");
    expect(msg).not.toContain("calyx agents deploy");
  });

  test("getDeprecatedWrapperMessage returns actionable message for agents-worktree-init", () => {
    const msg = getDeprecatedWrapperMessage("agents-worktree-init");
    expect(msg).toContain("will not be implemented in v1");
    expect(msg).toContain("deprecated 2026-03-03");
    expect(msg).toContain("Rationale:");
    expect(msg).toContain("Use instead:");
    expect(msg).toContain("shell script");
  });

  test("getDeprecatedWrapperMessage handles unknown wrapper", () => {
    const msg = getDeprecatedWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });

  test("all deprecated wrappers have required metadata", () => {
    const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
    expect(deprecated).toHaveLength(4);
    for (const def of deprecated) {
      expect(def.deprecatedAt, `${def.wrapper} missing deprecatedAt`).toBeTruthy();
      expect(def.rationale, `${def.wrapper} missing rationale`).toBeTruthy();
      expect(def.alternatives, `${def.wrapper} missing alternatives`).toBeDefined();
      expect(def.alternatives!.length, `${def.wrapper} has no alternatives`).toBeGreaterThan(0);
      expect(def.notes, `${def.wrapper} missing notes with sunset info`).toContain("Sunset");
    }
  });

  test("all deprecated wrappers produce messages with alternatives and sunset info", () => {
    const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
    for (const def of deprecated) {
      const msg = getDeprecatedWrapperMessage(def.wrapper);
      expect(msg).toContain("will not be implemented in v1");
      expect(msg).toContain("Use instead:");
      expect(msg).toContain("Rationale:");
    }
  });

  test("getDeferredWrapperMessage handles unknown wrapper (no deferred wrappers remain)", () => {
    const msg = getDeferredWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });
});

// ── Retired wrapper messages ────────────────────────────────────────

describe("retired wrapper tombstones", () => {
  test("getRetiredWrapperMessage returns clear message for known retired wrapper", () => {
    const msg = getRetiredWrapperMessage("skills-sync");
    expect(msg).toContain("removed in P9");
    expect(msg).toContain("calyx skills sync");
    expect(msg).toContain("2026-03-02");
  });

  test("getRetiredWrapperMessage handles unknown wrapper", () => {
    const msg = getRetiredWrapperMessage("nonexistent-wrapper");
    expect(msg).toContain("Unknown wrapper");
  });

  test("all retired wrappers produce messages with retirement date", () => {
    const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
    expect(retired.length).toBeGreaterThan(0);
    for (const def of retired) {
      const msg = getRetiredWrapperMessage(def.wrapper);
      expect(msg).toContain("removed in");
      expect(msg).toContain(def.target);
      expect(def.retiredAt).toBeTruthy();
    }
  });
});

// ── Wrapper registry completeness ───────────────────────────────────

describe("wrapper registry", () => {
  const retired = WRAPPER_REGISTRY.filter((d) => d.status === "retired");
  const deprecated = WRAPPER_REGISTRY.filter((d) => d.status === "deprecated");
  const deferred = WRAPPER_REGISTRY.filter((d) => d.status === "deferred");
  const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

  test("registry has 7 retired wrappers", () => {
    expect(retired).toHaveLength(7);
  });

  test("registry has 4 deprecated wrappers after the agent-notify cutover", () => {
    expect(deprecated).toHaveLength(4);
  });

  test("registry has 0 deferred wrappers (all resolved by POL-680)", () => {
    expect(deferred).toHaveLength(0);
  });

  test("registry has 8 implemented wrappers (POL-679 without agent-notify cutover)", () => {
    expect(implemented).toHaveLength(8);
  });

  test("all retired wrappers have calyx targets", () => {
    for (const def of retired) {
      expect(def.target).toMatch(/^calyx /);
    }
  });

  test("all retired wrappers have retiredAt dates", () => {
    for (const def of retired) {
      expect(def.retiredAt).toBeTruthy();
      expect(new Date(def.retiredAt!).toISOString()).toContain("2026");
    }
  });

  test("all implemented wrappers have calyx targets", () => {
    for (const def of implemented) {
      expect(def.target).toMatch(/^calyx /);
    }
  });

  test("all implemented wrappers have P7A-4 phase", () => {
    for (const def of implemented) {
      expect(def.phase).toBe("P7A-4");
    }
  });

  test("POL-679 target set is fully implemented", () => {
    const expectedImplemented = [
      "agents-toolkit-doctor",
      "agents-tools-bump",
      "docstore",
      "agents-fleet-smoke",
      "agents-bundle-build",
      "agent-mail",
      "execplan-new",
      "agents-bootstrap"
    ];

    for (const name of expectedImplemented) {
      const def = implemented.find((d) => d.wrapper === name);
      expect(def, `expected "${name}" to be implemented`).toBeDefined();
    }
  });

  test("POL-680 scope is deprecated (explicit decision)", () => {
    const expectedDeprecated = [
      "agent-notify",
      "agents-fleet",
      "agents-fleet-apply",
      "agents-worktree-init"
    ];

    for (const name of expectedDeprecated) {
      const def = deprecated.find((d) => d.wrapper === name);
      expect(def, `expected "${name}" to be deprecated`).toBeDefined();
    }
  });

  test("all deprecated wrappers have deprecatedAt dates", () => {
    for (const def of deprecated) {
      expect(def.deprecatedAt).toBeTruthy();
      expect(new Date(def.deprecatedAt!).toISOString()).toContain("2026");
    }
  });

  test("all deprecated wrappers have rationale", () => {
    for (const def of deprecated) {
      expect(def.rationale, `${def.wrapper} missing rationale`).toBeTruthy();
    }
  });

  test("all deprecated wrappers have alternatives", () => {
    for (const def of deprecated) {
      expect(def.alternatives, `${def.wrapper} missing alternatives`).toBeDefined();
      expect(def.alternatives!.length).toBeGreaterThan(0);
    }
  });

  test("no duplicate wrapper names", () => {
    const names = WRAPPER_REGISTRY.map((d) => d.wrapper);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all entries have phase tags", () => {
    for (const def of WRAPPER_REGISTRY) {
      expect(def.phase).toBeTruthy();
    }
  });

  test("total registry size is 19 (7 retired + 8 implemented + 4 deprecated)", () => {
    expect(WRAPPER_REGISTRY).toHaveLength(19);
  });
});

// ── Implemented wrapper delegation (POL-679) ────────────────────────

describe("implemented wrapper canonical command functions", () => {
  test("execNotify returns structured result", async () => {
    const result = await execNotify({
      message: "test notification",
      level: "info",
      channel: "stdout"
    });
    expect(result.message).toBe("test notification");
    expect(result.level).toBe("info");
    expect(result.channel).toBe("stdout");
    expect(result.delivered).toBe(true);
    expect(result.timestamp).toBeTruthy();
  });

  test("execNotify defaults level and channel", async () => {
    const result = await execNotify({ message: "minimal" });
    expect(result.level).toBe("info");
    expect(result.channel).toBe("stdout");
  });

  test("bumpToolVersion returns plan result for known tool", async () => {
    const registryPath = path.join(fixtureRoot(), "tools/registry.valid.json");
    const result = await bumpToolVersion(registryPath, {
      tool: "cass",
      to: "2.0.0"
    });
    expect(result.tool).toBe("cass");
    expect(result.to).toBe("2.0.0");
    expect(result.action).toBe("plan-bump");
    expect(result.apply).toBe(false);
    expect(result.from).toBeTruthy();
  });

  test("bumpToolVersion returns not-found for unknown tool", async () => {
    const registryPath = path.join(fixtureRoot(), "tools/registry.valid.json");
    const result = await bumpToolVersion(registryPath, {
      tool: "nonexistent-tool",
      to: "2.0.0"
    });
    expect(result.action).toBe("not-found");
    expect(result.from).toBeUndefined();
  });

  test("createExecPlan returns plan result", async () => {
    const result = await createExecPlan({
      title: "Test ExecPlan",
      issueId: "POL-999"
    });
    expect(result.id).toContain("execplan-pol-999");
    expect(result.title).toBe("Test ExecPlan");
    expect(result.action).toBe("plan-create");
    expect(result.apply).toBe(false);
  });

  test("createExecPlan generates id from issueId", async () => {
    const result = await createExecPlan({
      title: "Another Plan",
      issueId: "POL-123"
    });
    expect(result.id).toBe("execplan-pol-123");
  });

  test("runDoctor returns structured health report", async () => {
    const result = await runDoctor();
    expect(result.timestamp).toBeTruthy();
    expect(Array.isArray(result.domains)).toBe(true);
    expect(result.domains.length).toBeGreaterThan(0);
    // Without configured paths, all domains should be unconfigured
    for (const domain of result.domains) {
      expect(domain.domain).toBeTruthy();
      expect(["ok", "warning", "error", "unconfigured"]).toContain(domain.health);
    }
  });

  test("installBootstrap returns plan result", async () => {
    const result = await installBootstrap({
      target: "/tmp/test-agents",
      executablePath: "/tmp/test-calyx-bin",
      installsRoot: await isolatedInstallsRoot(),
    });
    expect(result.target).toBe("/tmp/test-agents");
    expect(result.action).toBe("plan-bootstrap");
    expect(result.apply).toBe(false);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.wrapperPath).toBe("/tmp/test-agents/run/calyx");
    expect(result.sourceExecutablePath).toBe("/tmp/test-calyx-bin");
  });

  test("installBootstrap apply retires the legacy shadow wrapper and installs the source wrapper", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-"));
    tempDirs.push(target);

    const sourceBinPath = path.join(target, "source-calyx");
    await writeFile(sourceBinPath, "#!/usr/bin/env bash\nprintf 'source\\n'\n", "utf8");
    await chmod(sourceBinPath, 0o755);

    const existingWrapperPath = path.join(target, "run", "calyx");
    const legacyWrapperPath = path.join(target, "run", "calyx.legacy");
    await mkdir(path.join(target, "run"), { recursive: true });
    await writeFile(existingWrapperPath, "#!/usr/bin/env bash\nprintf 'legacy\\n'\n", "utf8");
    await chmod(existingWrapperPath, 0o755);
    await writeFile(legacyWrapperPath, "#!/usr/bin/env bash\nprintf 'stale shadow\\n'\n", "utf8");
    await chmod(legacyWrapperPath, 0o755);

    const result = await installBootstrap({
      target,
      apply: true,
      executablePath: sourceBinPath,
      installsRoot: await isolatedInstallsRoot(),
    });

    const installedWrapper = await readFile(existingWrapperPath, "utf8");

    expect(result.action).toBe("bootstrap");
    expect(result.wrapperPath).toBe(existingWrapperPath);
    expect(result.retiredLegacyWrapperPath).toBe(legacyWrapperPath);
    expect(installedWrapper).toContain("CALYX_BOOTSTRAP_WRAPPER=1");
    expect(installedWrapper).toContain("CALYX_NODE_MIN_VERSION='22.13.0'");
    expect(installedWrapper).toContain("node_version_supported");
    expect(installedWrapper).toContain("find_calyx_node");
    expect(installedWrapper).toContain('exec "$CALYX_NODE_BIN" "$SOURCE_EXECUTABLE_PATH" "$@"');
    expect(installedWrapper).toContain(sourceBinPath);
    await expect(readFile(legacyWrapperPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("installBootstrap wrapper routes every manifest command to the current CLI", async () => {
    // The wrapper is written at install-time-N and read at run-time-N+k on a
    // host the writer never sees again, so any command name it knows about is a
    // frozen restatement of a command tree that keeps moving — the exact shape
    // that made `calyx doctor` exec a retired Python script on two fleet hosts
    // for four months, with no error anywhere. The wrapper must therefore route
    // *nothing*: argv goes to the current CLI verbatim. Deriving the command
    // list here is what makes a reintroduced branch fail immediately, including
    // for commands that do not exist yet.
    const target = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-passthrough-"));
    tempDirs.push(target);

    const argvOut = path.join(target, "argv.json");
    const sourceBinPath = path.join(target, "source-calyx.js");
    await writeFile(
      sourceBinPath,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.CALYX_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(sourceBinPath, 0o755);

    await installBootstrap({
      target,
      apply: true,
      executablePath: sourceBinPath,
      installsRoot: await isolatedInstallsRoot(),
    });
    const wrapperPath = path.join(target, "run", "calyx");

    // Both manifest catalogs are hand-authored and partial (see AGENTS.md), so
    // neither alone is the command tree — the union is a broad argv sample, and
    // the property under test holds for argv the sample misses too.
    const sampledArgv = [
      ...INTERFACE_MANIFEST_RECORDS.filter((record) => record.surface_kind === "cli_command").map((record) =>
        record.path.filter((segment) => !segment.startsWith("<") && !segment.startsWith("[")),
      ),
      ...INTERFACE_DOMAIN_CLASSIFICATIONS.map((classification) => classification.domain.split(" ")),
      ["a-command-that-does-not-exist-yet"],
    ].filter((segments) => segments.length > 0);
    const commandPaths = Array.from(
      new Map(sampledArgv.map((segments) => [segments.join(" "), segments] as const)).values(),
    );
    expect(commandPaths.length).toBeGreaterThan(20);
    // The live casualty: `doctor` reached a retired Python script on blade and mba.
    expect(commandPaths.map((segments) => segments.join(" "))).toContain("doctor");

    for (const segments of commandPaths) {
      const argv = [...segments, "--json"];
      await rm(argvOut, { force: true });
      await execFile(wrapperPath, argv, { env: { ...process.env, CALYX_TEST_ARGV_OUT: argvOut } });
      expect(JSON.parse(await readFile(argvOut, "utf8"))).toEqual(argv);
    }
  });

  test("installBootstrap wrapper fails closed when the source executable is gone", async () => {
    // The deleted delegation path used a missing source executable as its cue
    // to silently run some other program. Missing means broken, and broken must
    // be loud.
    const target = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-missing-source-"));
    tempDirs.push(target);

    const sourceBinPath = path.join(target, "source-calyx");
    await writeFile(sourceBinPath, "#!/usr/bin/env bash\nprintf 'source\\n'\n", "utf8");
    await chmod(sourceBinPath, 0o755);

    await installBootstrap({
      target,
      apply: true,
      executablePath: sourceBinPath,
      installsRoot: await isolatedInstallsRoot(),
    });
    await rm(sourceBinPath, { force: true });

    await expect(execFile(path.join(target, "run", "calyx"), ["doctor"])).rejects.toMatchObject({ code: 1 });
  });

  test("installBootstrap source wrapper bypasses stale PATH node with a supported runtime", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-node-"));
    tempDirs.push(target);
    const binDir = path.join(target, "bin");
    await mkdir(binDir, { recursive: true });

    const staleNode = path.join(binDir, "node");
    await writeFile(
      staleNode,
      [
        "#!/usr/bin/env bash",
        "if [[ \"$1\" == \"--version\" ]]; then printf 'v20.19.4\\n'; exit 0; fi",
        "if [[ \"$1\" == \"-e\" ]]; then exit 1; fi",
        "printf 'stale Node 20 should not execute Calyx\\n' >&2",
        "exit 42",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(staleNode, 0o755);

    const supportedNode = path.join(binDir, "node22");
    await writeFile(
      supportedNode,
      [
        "#!/usr/bin/env bash",
        `exec ${shellQuote(process.execPath)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(supportedNode, 0o755);

    const sourceBinPath = path.join(target, "source-calyx.js");
    const runtimeOut = path.join(target, "runtime.json");
    await writeFile(
      sourceBinPath,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.CALYX_TEST_RUNTIME_OUT, JSON.stringify({",
        "  node: process.versions.node,",
        "  args: process.argv.slice(2),",
        "}));",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(sourceBinPath, 0o755);

    await installBootstrap({
      target,
      apply: true,
      executablePath: sourceBinPath,
      installsRoot: await isolatedInstallsRoot(),
    });

    await execFile(path.join(target, "run", "calyx"), ["activity", "list"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
        CALYX_NODE: supportedNode,
        CALYX_TEST_RUNTIME_OUT: runtimeOut,
      },
    });

    const payload = JSON.parse(await readFile(runtimeOut, "utf8")) as { node: string; args: string[] };
    expect(payload.node).toBe(process.versions.node);
    expect(payload.args).toEqual(["activity", "list"]);
  });

  test("installBootstrap source wrapper fails closed for unsupported CALYX_NODE override", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "calyx-bootstrap-node-override-"));
    tempDirs.push(target);
    const binDir = path.join(target, "bin");
    await mkdir(binDir, { recursive: true });

    const staleNode = path.join(binDir, "node20");
    await writeFile(
      staleNode,
      [
        "#!/usr/bin/env bash",
        "if [[ \"$1\" == \"--version\" ]]; then printf 'v20.19.4\\n'; exit 0; fi",
        "printf 'explicit stale node should not execute Calyx\\n' >&2",
        "exit 42",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(staleNode, 0o755);

    const sourceBinPath = path.join(target, "source-calyx.js");
    const runtimeOut = path.join(target, "runtime.json");
    await writeFile(
      sourceBinPath,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync(process.env.CALYX_TEST_RUNTIME_OUT, 'should-not-run');",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(sourceBinPath, 0o755);

    await installBootstrap({
      target,
      apply: true,
      executablePath: sourceBinPath,
      installsRoot: await isolatedInstallsRoot(),
    });

    try {
      await execFile(path.join(target, "run", "calyx"), ["activity", "list"], {
        env: {
          ...process.env,
          CALYX_NODE: staleNode,
          CALYX_TEST_RUNTIME_OUT: runtimeOut,
        },
      });
      throw new Error("expected wrapper to reject unsupported CALYX_NODE");
    } catch (error) {
      expect(error).toMatchObject({ code: 1 });
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      expect(stderr).toContain("CALYX_NODE is v20.19.4");
      expect(stderr).toContain(staleNode);
    }

    await expect(readFile(runtimeOut, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("installBootstrap plan reports stale built executables before apply", async () => {
    const fixture = await createBootstrapWorkspaceFixture();
    tempDirs.push(fixture.root);

    const result = await installBootstrap({
      target: path.join(fixture.root, ".agents"),
      executablePath: fixture.executablePath,
      installsRoot: await isolatedInstallsRoot(),
    });

    expect(result.action).toBe("plan-bootstrap");
    expect(result.staleBuild?.executablePath).toBe(await realpath(fixture.executablePath));
    expect(result.warnings?.[0]).toContain("stale built executable detected");
  });

  test("installBootstrap apply blocks instead of wiring a stale built executable", async () => {
    const fixture = await createBootstrapWorkspaceFixture();
    tempDirs.push(fixture.root);
    const target = path.join(fixture.root, ".agents");

    const result = await installBootstrap({
      target,
      apply: true,
      executablePath: fixture.executablePath,
      installsRoot: await isolatedInstallsRoot(),
    });

    expect(result.action).toBe("blocked-bootstrap");
    expect(result.staleBuild?.newestSourcePath).toContain("/packages/");
    await expect(readFile(path.join(target, "run", "calyx"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("buildBundle returns plan result for valid package", async () => {
    // Use the calyx-ext-hello example as a test target
    const pkgPath = path.resolve(process.cwd(), "examples/calyx-ext-hello");
    const result = await buildBundle({ path: pkgPath });
    expect(result.name).toBeTruthy();
    expect(result.version).toBeTruthy();
    expect(result.action).toBe("plan-build");
    expect(result.apply).toBe(false);
  });
});

// ── Backend routing ─────────────────────────────────────────────────

describe("domain backend routing", () => {
  const root = fixtureRoot();
  const skillsPath = path.join(root, "skills/registry.valid.json");
  const promptsPath = path.join(root, "prompts/registry.valid.json");

  test("skills sync routes to claude backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("skills sync routes to codex backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });

  test("skills sync defaults to all backend", async () => {
    const result = await syncSkillsRegistry(skillsPath, { backend: "all", apply: false });
    expect(result.backend).toBe("all");
    expect(result.apply).toBe(false);
  });

  test("prompts sync routes to claude backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "claude", apply: false });
    expect(result.backend).toBe("claude");
    expect(result.apply).toBe(false);
  });

  test("prompts sync routes to codex backend", async () => {
    const result = await syncPromptsRegistry(promptsPath, { backend: "codex", apply: false });
    expect(result.backend).toBe("codex");
    expect(result.apply).toBe(false);
  });
});

// ── E2E telemetry validation ────────────────────────────────────────

describe("e2e telemetry validation", () => {
  test("telemetry emit writes valid events to stderr", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    emitWrapperTelemetry("test-wrapper", "calyx test command");

    expect(stderrSpy).toHaveBeenCalledTimes(2);

    // First call: deprecation warning
    const deprecationCall = stderrSpy.mock.calls[0]?.[0] as string;
    expect(deprecationCall).toContain("[calyx][deprecated]");
    expect(deprecationCall).toContain("test-wrapper");
    expect(deprecationCall).toContain("calyx test command");

    // Second call: telemetry JSON
    const telemetryCall = stderrSpy.mock.calls[1]?.[0] as string;
    expect(telemetryCall).toContain("[calyx][telemetry]");
    const jsonPart = telemetryCall.replace("[calyx][telemetry] ", "");
    const parsed = JSON.parse(jsonPart) as WrapperTelemetryEvent;
    expect(isValidTelemetryEvent(parsed)).toBe(true);
    expect(parsed.wrapper).toBe("test-wrapper");
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.deprecation_phase).toBe("warn");

    stderrSpy.mockRestore();
  });

  test("telemetry with domain function produces enriched envelope", async () => {
    const root = fixtureRoot();
    const skillsPath = path.join(root, "skills/registry.valid.json");

    const telemetry = emitWrapperTelemetry("test-wrapper", "calyx skills sync --backend claude");
    const result = await syncSkillsRegistry(skillsPath, { backend: "claude", apply: false });
    const envelope = { wrapper: telemetry, result };

    // Validate complete envelope
    expect(envelope.wrapper.event).toBe("calyx.wrapper.invoked");
    expect(envelope.wrapper.pid).toBeGreaterThan(0);
    expect(envelope.wrapper.cwd).toBeTruthy();
    expect(envelope.wrapper.deprecation_phase).toBe("warn");
    expect(envelope.result.backend).toBe("claude");
    expect(envelope.result.apply).toBe(false);
    expect(Array.isArray(envelope.result.actions)).toBe(true);

    // JSON round-trip
    const serialized = JSON.stringify(envelope);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.wrapper.event).toBe("calyx.wrapper.invoked");
    expect(deserialized.wrapper.pid).toBe(process.pid);
  });
});
