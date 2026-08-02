import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CalyxDaemonDescriptor } from "@polli-labs/calyx-core";
import {
  detectSupervisor,
  detectSupervisorKind,
  listDescriptors,
  readDescriptor,
  pruneStaleDescriptors,
  removeDescriptor,
  removeDescriptorForPid,
  writeDescriptor,
} from "../daemon-registry.js";

function makeDescriptor(overrides: Partial<CalyxDaemonDescriptor> = {}): CalyxDaemonDescriptor {
  return {
    schema_version: "calyx-daemon/v1",
    daemon_id: "run-serve",
    daemon_kind: "run-service",
    pid: process.pid,
    argv: ["calyx", "run", "serve", "--host", "0.0.0.0"],
    cwd: "/home/caleb",
    runs_root: "/home/caleb/.calyx/runs",
    health_url: "http://blade:8740",
    livez_url: "http://blade:8740/livez",
    supervisor: {
      kind: "direct",
      stop_grace_ms: 5_000,
    },
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: "build-sha",
      built_at: "2026-04-20T00:00:00.000Z",
      package_version: "0.2.0",
    },
    restart_order: 10,
    depends_on: [],
    maintenance_mode: false,
    ...overrides,
  };
}

describe("daemon registry", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calyx-daemon-registry-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes and removes daemon descriptors", async () => {
    const targetPath = await writeDescriptor(makeDescriptor(), { root });
    const saved = JSON.parse(await readFile(targetPath, "utf8")) as CalyxDaemonDescriptor;
    expect(saved.daemon_id).toBe("run-serve");
    expect(saved.build.git_head).toBe("build-sha");
    expect(saved.maintenance_mode).toBe(false);

    await removeDescriptor("run-serve", { root });
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("pid-scoped removal preserves a newer live descriptor", async () => {
    const targetPath = await writeDescriptor(makeDescriptor({ pid: 101 }), { root });
    await writeDescriptor(makeDescriptor({ pid: 202 }), { root });

    await expect(removeDescriptorForPid("run-serve", 101, { root })).resolves.toBe(false);

    const saved = JSON.parse(await readFile(targetPath, "utf8")) as CalyxDaemonDescriptor;
    expect(saved.pid).toBe(202);

    await expect(removeDescriptorForPid("run-serve", 202, { root })).resolves.toBe(true);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("compare-and-swap publication refuses a newer descriptor", async () => {
    const accepted = makeDescriptor({ pid: 101, maintenance_mode: false });
    await writeDescriptor(accepted, { root });
    await writeDescriptor(makeDescriptor({ pid: 202, maintenance_mode: true }), { root });

    await expect(writeDescriptor(
      { ...accepted, maintenance_mode: true },
      { root, expectedDescriptor: accepted },
    )).rejects.toThrow(/changed before compare-and-swap publication/);

    await expect(readDescriptor("run-serve", { root })).resolves.toMatchObject({
      pid: 202,
      maintenance_mode: true,
    });
  });

  test("reads and lists daemon descriptors", async () => {
    await writeDescriptor(makeDescriptor({ daemon_id: "run-serve-a" }), { root });
    await writeDescriptor(makeDescriptor({ daemon_id: "run-serve-b" }), { root });

    await expect(readDescriptor("run-serve-a", { root })).resolves.toMatchObject({
      daemon_id: "run-serve-a",
    });
    await expect(listDescriptors({ root })).resolves.toHaveLength(2);
  });

  test("prunes stale descriptors and keeps live ones", async () => {
    await writeDescriptor(makeDescriptor({ daemon_id: "run-serve-stale", pid: 101 }), { root });
    const livePath = await writeDescriptor(makeDescriptor({ daemon_id: "run-serve-live", pid: 202 }), { root });

    const pruned = await pruneStaleDescriptors({
      root,
      isProcessAlive: (pid) => pid === 202,
    });

    expect(pruned).toEqual(["run-serve-stale"]);
    const live = JSON.parse(await readFile(livePath, "utf8")) as CalyxDaemonDescriptor;
    expect(live.daemon_id).toBe("run-serve-live");
  });

  test("detects systemd supervisor via INVOCATION_ID", () => {
    expect(detectSupervisorKind({ INVOCATION_ID: "abc123" })).toBe("systemd");
    expect(detectSupervisorKind({})).toBe("direct");
  });

  test("detects launchd supervisor on darwin via launchd env and resolves plist path", () => {
    const plistPath = "/Users/carbon/Library/LaunchAgents/com.pollilabs.calyx.run-serve.plist";
    expect(detectSupervisorKind({ XPC_SERVICE_NAME: "com.pollilabs.calyx.run-serve" }, "darwin")).toBe("launchd");
    expect(
      detectSupervisor(
        "run-serve",
        { XPC_SERVICE_NAME: "com.pollilabs.calyx.run-serve", INVOCATION_ID: "abc123" },
        "darwin",
        {
          homeDir: "/Users/carbon",
          pathExists: (candidate) => candidate === plistPath,
        },
      ),
    ).toEqual({
      kind: "launchd",
      label: "com.pollilabs.calyx.run-serve",
      plistPath,
    });
  });

  test("detects direct and systemd supervisor descriptors", () => {
    expect(detectSupervisor("run-serve", {})).toEqual({
      kind: "direct",
      stop_grace_ms: 5_000,
    });
    expect(
      detectSupervisor(
        "run-serve",
        { __CFBundleIdentifier: "com.pollilabs.calyx.run-serve" },
        "darwin",
        {
          homeDir: "/Users/carbon",
          pathExists: () => false,
        },
      ),
    ).toEqual({
      kind: "direct",
      stop_grace_ms: 5_000,
    });
    expect(detectSupervisor("run-serve", { INVOCATION_ID: "abc123", CALYX_SYSTEMD_UNIT: "calyx.service" })).toEqual({
      kind: "systemd",
      unit_name: "calyx.service",
    });
  });
});
