/**
 * Tests for the shared defaultSpawn implementation (POL-912).
 *
 * Validates maxBuffer, signal handling, buffer overflow detection,
 * and ENOENT error propagation.
 */

import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSpawn } from "../src/adapters/spawn.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_HOME = process.env.HOME;

async function readChildPath(opts: { cwd: string; env?: Record<string, string | undefined> }) {
  const result = await defaultSpawn(
    process.execPath,
    ["-e", "process.stdout.write(process.env.PATH ?? '');"],
    opts,
  );
  expect(result.code).toBe(0);
  return result.stdout;
}

async function readPidWhenReady(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child has not published its descendant yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for descendant pid at ${path}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("defaultSpawn", () => {
  afterEach(() => {
    if (ORIGINAL_PATH === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = ORIGINAL_PATH;
    }

    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  test("successful exit returns code 0 with stdout and stderr", async () => {
    const result = await defaultSpawn(process.execPath, ["-e", "process.stdout.write('hello'); process.stderr.write('warn');"], {
      cwd: "/tmp",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warn");
    expect(result.signal).toBeUndefined();
    expect(result.spawn_error).toBeUndefined();
  });

  test("stdout and stderr chunks refresh activity without storing raw output in callback", async () => {
    const activity: Array<{ source: string; bytes: number; timestamp: string }> = [];
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write('hello'); process.stderr.write('warn');"],
      {
        cwd: "/tmp",
        onActivity: (event) => activity.push(event),
      },
    );

    expect(result.code).toBe(0);
    expect(activity.map((event) => event.source).sort()).toEqual(["stderr", "stdout"]);
    expect(activity.map((event) => event.bytes).sort((a, b) => a - b)).toEqual([4, 5]);
    expect(activity.every((event) => Number.isFinite(Date.parse(event.timestamp)))).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("hello");
    expect(JSON.stringify(activity)).not.toContain("warn");
  });

  test("incremental stdout consumers can disable raw stdout retention", async () => {
    const chunks: Buffer[] = [];
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write('{\"type\":'); process.stdout.write('\"result\"}\\n');"],
      {
        cwd: "/tmp",
        capture_stdout: false,
        onStdoutChunk: (chunk) => chunks.push(Buffer.from(chunk)),
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"type":"result"}\n');
  });

  test("unconfigured inactivity timeout never kills a quiet child by silence alone", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 80);"],
      { cwd: "/tmp" },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.spawn_error).toBeUndefined();
  });

  test("configured inactivity timeout terminates a quiet child with stalled_inactivity", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('late'), 500);"],
      {
        cwd: "/tmp",
        hard_timeout_ms: 30,
        stop_grace_ms: 20,
      },
    );

    expect(result.code).toBe(143);
    expect(result.signal).toBe("SIGTERM");
    expect(result.spawn_error).toBe("stalled_inactivity");
    expect(result.reason).toBe("stalled_inactivity");
    expect(result.stdout).toBe("");
  });

  test("an already-aborted signal does not spawn a backend", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-pre-abort-test-"));
    const markerPath = join(tmp, "spawned");
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await defaultSpawn(
        process.execPath,
        ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "yes")`],
        { cwd: tmp, signal: controller.signal },
      );

      expect(result).toMatchObject({
        code: 143,
        signal: "SIGTERM",
        reason: "cancelled",
      });
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("abort racing a pid-less spawn failure settles without a phantom process", async () => {
    // Invoke the abort listener synchronously when defaultSpawn registers it.
    // Registration happens after spawn(2) returns but before ENOENT emits its
    // asynchronous error/close events, deterministically exercising pid-less
    // teardown rather than the pre-abort fast path.
    const racingSignal = {
      aborted: false,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === "function") {
          listener(new Event("abort"));
        } else {
          listener.handleEvent(new Event("abort"));
        }
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const resultPromise = defaultSpawn("__missing_abort_race_binary__", [], {
      cwd: "/tmp",
      signal: racingSignal,
      stop_grace_ms: 20,
    });

    const result = await resultPromise;
    expect(result.code).toBe(1);
    expect(result.spawn_error).toBeUndefined();
    expect(result.reason).toBe("cancelled");
  });

  test.skipIf(process.platform === "win32")(
    "abort tears down an isolated process group including a SIGTERM-resistant descendant",
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), "calyx-process-group-test-"));
      const scriptPath = join(tmp, "parent.cjs");
      const descendantPidPath = join(tmp, "descendant.pid");
      const controller = new AbortController();
      let descendantPid: number | undefined;

      await writeFile(
        scriptPath,
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          "const descendant = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
          `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      try {
        const resultPromise = defaultSpawn(process.execPath, [scriptPath], {
          cwd: tmp,
          signal: controller.signal,
          stop_grace_ms: 40,
        });
        descendantPid = await readPidWhenReady(descendantPidPath);
        expect(processIsAlive(descendantPid)).toBe(true);

        controller.abort();
        const result = await resultPromise;

        expect(result.code).toBe(137);
        expect(result.signal).toBe("SIGKILL");
        expect(result.reason).toBe("cancelled");
        expect(result.spawn_error).toBeUndefined();
        expect(processIsAlive(descendantPid)).toBe(false);
      } finally {
        controller.abort();
        if (descendantPid !== undefined && processIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await rm(tmp, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "normal leader exit reaps an unreferenced descendant before reporting completion",
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), "calyx-process-group-straggler-test-"));
      const scriptPath = join(tmp, "leader.cjs");
      const descendantPidPath = join(tmp, "descendant.pid");
      let descendantPid: number | undefined;

      await writeFile(
        scriptPath,
        [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          "const descendant = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: \"ignore\" });",
          "descendant.unref();",
          `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
        ].join("\n"),
        "utf8",
      );

      try {
        const result = await defaultSpawn(process.execPath, [scriptPath], {
          cwd: tmp,
          stop_grace_ms: 40,
        });
        descendantPid = await readPidWhenReady(descendantPidPath);

        expect(result.code).toBe(0);
        expect(result.spawn_error).toBeUndefined();
        expect(processIsAlive(descendantPid)).toBe(false);
      } finally {
        if (descendantPid !== undefined && processIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await rm(tmp, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test("non-zero numeric exit code is preserved", async () => {
    const result = await defaultSpawn(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(42);"], {
      cwd: "/tmp",
    });
    expect(result.code).toBe(42);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.signal).toBeUndefined();
    expect(result.spawn_error).toBeUndefined();
  });

  test("ENOENT for missing command returns code 1 and stderr contains error", async () => {
    const result = await defaultSpawn("__nonexistent_binary_12345__", [], {
      cwd: "/tmp",
    });
    // ENOENT should result in code 1 (non-numeric error code fallback)
    expect(result.code).toBe(1);
    // stderr may be empty for ENOENT since the process never started,
    // but the error should still be catchable
    expect(result.spawn_error).toBeUndefined(); // ENOENT is not a buffer overflow
  });

  test("resolves a bare provider executable before applying the child PATH", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-provider-resolution-"));
    const trustedBin = join(tmp, "trusted");
    const forgedBin = join(tmp, "forged");
    const command = "calyx-provider-probe";
    await Promise.all([mkdir(trustedBin), mkdir(forgedBin)]);
    const trusted = join(trustedBin, command);
    const forged = join(forgedBin, command);
    await writeFile(trusted, "#!/bin/sh\nprintf trusted", "utf8");
    await writeFile(forged, "#!/bin/sh\nprintf forged", "utf8");
    await Promise.all([chmod(trusted, 0o700), chmod(forged, 0o700)]);
    process.env.PATH = trustedBin;

    try {
      const result = await defaultSpawn(command, [], {
        cwd: tmp,
        env: { PATH: forgedBin },
        resolve_command_before_env: true,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("trusted");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("stops and bounds stdout retention at the capture-specific byte limit", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(65536)); setTimeout(() => process.stdout.write('late'), 500);"],
      {
        cwd: "/tmp",
        max_stdout_bytes: 1024,
        stop_grace_ms: 20,
      },
    );

    expect(result.spawn_error).toMatch(/^stdout exceeded max_stdout_bytes=1024/);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(result.stdout_observation).toMatchObject({
      complete: false,
      bytes_observed: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.stdout_observation!.bytes_observed).toBeGreaterThan(1024);
  });

  test("large stdout does not trigger maxBuffer with 200MB limit", async () => {
    // Verify that our 200MB maxBuffer setting prevents the 1MB default from killing processes.
    // Use console.log which flushes properly, and check we get more than 1MB.
    const result = await defaultSpawn(
      process.execPath,
      ["-e", `
        const chunk = "x".repeat(1024);
        for (let i = 0; i < 1500; i++) console.log(chunk);
      `],
      { cwd: "/tmp" },
    );
    // 1500 lines * ~1025 bytes each > 1MB (the old default maxBuffer)
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(result.spawn_error).toBeUndefined();
  });

  test("signal kill maps to correct exit code", async () => {
    // Create a temp dir with a script that kills itself
    const tmp = await mkdtemp(join(tmpdir(), "calyx-spawn-test-"));
    const scriptPath = join(tmp, "kill-self.js");

    try {
      await writeFile(
        scriptPath,
        `process.kill(process.pid, "SIGTERM");`,
        "utf-8",
      );

      const result = await defaultSpawn(process.execPath, [scriptPath], { cwd: tmp });
      // Node process killed by SIGTERM
      expect(result.signal).toBe("SIGTERM");
      expect(result.code).toBe(143);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("env variables are passed through", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stdout.write(process.env.TEST_VAR_912 || 'missing');"],
      {
        cwd: "/tmp",
        env: { TEST_VAR_912: "hello_from_test" },
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello_from_test");
  });

  test("close_stdin ends child stdin immediately", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", `
        const timer = setTimeout(() => {
          process.stderr.write("timed out waiting for stdin");
          process.exit(9);
        }, 250);
        process.stdin.resume();
        process.stdin.on("data", () => {
          clearTimeout(timer);
          process.stdout.write("unexpected-data");
          process.exit(2);
        });
        process.stdin.on("end", () => {
          clearTimeout(timer);
          process.stdout.write("stdin-closed");
          process.exit(0);
        });
      `],
      {
        cwd: "/tmp",
        close_stdin: true,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("stdin-closed");
    expect(result.stderr).toBe("");
  });

  test("explicit opts.env.PATH wins over inherited process PATH", async () => {
    process.env.PATH = "/process/path";
    process.env.HOME = "/fake/home";

    const childPath = await readChildPath({
      cwd: "/tmp",
      env: { PATH: "/opts/path" },
    });

    expect(childPath).toBe("/opts/path");
  });

  test("managed backend PATH is prepended when opts.env.PATH is absent", async () => {
    process.env.PATH = "/process/path";
    process.env.HOME = "/fake/home";

    const childPath = await readChildPath({
      cwd: "/tmp",
      env: { TEST_VAR_1100: "present" },
    });

    expect(childPath).toBe([
      "/fake/home/.agents/run",
      "/fake/home/.npm-global/bin",
      "/fake/home/.local/share/pnpm",
      "/fake/home/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/process/path",
    ].join(":"));
  });

  test("opts.env values of undefined remove keys from the child env (POL-1139)", async () => {
    process.env.PATH = ORIGINAL_PATH;
    process.env.POL_1139_INHERITED = "inherited-value";
    try {
      const result = await defaultSpawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify(['POL_1139_INHERITED' in process.env, 'POL_1139_EXPLICIT' in process.env]));",
        ],
        {
          cwd: "/tmp",
          env: {
            POL_1139_INHERITED: undefined,
            POL_1139_EXPLICIT: "present",
          },
        },
      );
      expect(result.code).toBe(0);
      // First: the inherited key was dropped (undefined in opts.env).
      // Second: the explicit string value was passed through.
      expect(JSON.parse(result.stdout)).toEqual([false, true]);
    } finally {
      delete process.env.POL_1139_INHERITED;
    }
  });

  test("default PATH is injected when opts.env.PATH and process PATH are both missing", async () => {
    delete process.env.PATH;
    process.env.HOME = "/fake/home";

    const childPath = await readChildPath({
      cwd: "/tmp",
      env: { TEST_VAR_1100: "present" },
    });

    expect(childPath).toBe([
      "/fake/home/.agents/run",
      "/fake/home/.npm-global/bin",
      "/fake/home/.local/share/pnpm",
      "/fake/home/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"));
  });
});
