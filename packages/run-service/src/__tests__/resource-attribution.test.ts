import { describe, expect, test } from "vitest";
import type { ExecFileAsync } from "../host-resources.js";
import {
  collectResourceAttribution,
  parseNvidiaSmiComputeAppsCsv,
  parsePsProcessRows,
} from "../resource-attribution.js";

const CHECKED_AT = "2026-05-20T12:00:00.000Z";

function fakeExecFile(outputs: Record<string, string>): ExecFileAsync {
  return async (file: string): Promise<{ stdout: string; stderr: string }> => {
    const stdout = outputs[file];
    if (stdout === undefined) {
      const error = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return { stdout, stderr: "" };
  };
}

describe("resource attribution", () => {
  test("parsePsProcessRows preserves command text and numeric process stats", () => {
    const rows = parsePsProcessRows(`
      100     1  12.5  64000 /usr/bin/python train.py --epochs 10
      101   100  25.0 128000 /usr/bin/python worker.py --rank 0
      200     1   4.0  32000 /usr/bin/node unrelated.js
    `);

    expect(rows).toEqual([
      {
        pid: 100,
        ppid: 1,
        cpu_percent: 12.5,
        rss_kib: 64000,
        command: "/usr/bin/python train.py --epochs 10",
      },
      {
        pid: 101,
        ppid: 100,
        cpu_percent: 25,
        rss_kib: 128000,
        command: "/usr/bin/python worker.py --rank 0",
      },
      {
        pid: 200,
        ppid: 1,
        cpu_percent: 4,
        rss_kib: 32000,
        command: "/usr/bin/node unrelated.js",
      },
    ]);
  });

  test("parseNvidiaSmiComputeAppsCsv parses process rows and used memory", () => {
    const rows = parseNvidiaSmiComputeAppsCsv(`
      101, /usr/bin/python, GPU-111, 512
      200, /usr/bin/node, GPU-222, [N/A]
    `);

    expect(rows).toEqual([
      {
        pid: 101,
        process_name: "/usr/bin/python",
        gpu_uuid: "GPU-111",
        used_gpu_memory_mib: 512,
      },
      {
        pid: 200,
        process_name: "/usr/bin/node",
        gpu_uuid: "GPU-222",
      },
    ]);
  });

  test("collectResourceAttribution maps CPU, RSS, and GPU rows to the run process tree", async () => {
    const attribution = await collectResourceAttribution({
      rootPid: 100,
      now: () => CHECKED_AT,
      execFile: fakeExecFile({
        ps: `
          100     1  12.5  64000 /usr/bin/python train.py --epochs 10
          101   100  25.0 128000 /usr/bin/python worker.py --rank 0
          200     1   4.0  32000 /usr/bin/node unrelated.js
        `,
        "nvidia-smi": `
          101, /usr/bin/python, GPU-111, 512
          200, /usr/bin/node, GPU-222, 1024
        `,
      }),
    });

    expect(attribution).toMatchObject({
      schema_version: "run-resource-attribution/v1",
      checked_at: CHECKED_AT,
      root_pid: 100,
      status: "attributed",
      process_tree: {
        provider: "ps",
        status: "attributed",
        process_count: 2,
        total_cpu_percent: 37.5,
        total_rss_kib: 192000,
        truncated: false,
        max_processes: 32,
      },
      gpu_processes: {
        provider: "nvidia-smi",
        status: "attributed",
        host_process_count: 2,
        attributed_process_count: 1,
        attributed_memory_used_mib: 512,
      },
    });
    expect(attribution.process_tree.processes.map((process) => process.pid)).toEqual([100, 101]);
    expect(attribution.gpu_processes.processes.map((process) => process.pid)).toEqual([101]);
  });

  test("collectResourceAttribution reports host-only GPU work when no GPU row belongs to the run tree", async () => {
    const attribution = await collectResourceAttribution({
      rootPid: 100,
      now: () => CHECKED_AT,
      execFile: fakeExecFile({
        ps: `
          100     1   0.0  64000 /usr/bin/python train.py --epochs 10
          101   100   0.0 128000 /usr/bin/python worker.py --rank 0
          200     1  90.0  32000 /usr/bin/python unrelated-gpu.py
        `,
        "nvidia-smi": "200, /usr/bin/python, GPU-222, 1024",
      }),
    });

    expect(attribution.status).toBe("host_only");
    expect(attribution.process_tree.process_count).toBe(2);
    expect(attribution.gpu_processes).toMatchObject({
      status: "host_only",
      host_process_count: 1,
      attributed_process_count: 0,
      attributed_memory_used_mib: 0,
      processes: [],
    });
  });

  test("collectResourceAttribution distinguishes missing pid and unavailable providers", async () => {
    const pidMissing = await collectResourceAttribution({
      now: () => CHECKED_AT,
      execFile: fakeExecFile({
        "nvidia-smi": "200, /usr/bin/python, GPU-222, 1024",
      }),
    });

    expect(pidMissing.status).toBe("pid_missing");
    expect(pidMissing.process_tree.status).toBe("pid_missing");
    expect(pidMissing.gpu_processes.status).toBe("host_only");

    const unavailable = await collectResourceAttribution({
      rootPid: 100,
      now: () => CHECKED_AT,
      execFile: fakeExecFile({}),
    });

    expect(unavailable.status).toBe("process_provider_unavailable");
    expect(unavailable.process_tree.status).toBe("provider_unavailable");
    expect(unavailable.gpu_processes.status).toBe("unavailable");
  });
});
