import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  getExecLogs,
  getExecReceipt,
  getExecStatus,
  launchExecRun,
  validateExecStore
} from "../exec";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

describe("exec domain – validate", () => {
  test("validates a well-formed run store", async () => {
    const root = fixtureRoot();
    const result = await validateExecStore(path.join(root, "exec/store.valid.json"));

    expect(result.ok).toBe(true);
    expect(result.total).toBe(5);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.running).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  test("reports duplicate run_id errors", async () => {
    const root = fixtureRoot();
    const result = await validateExecStore(path.join(root, "exec/store.invalid.json"));

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "exec.duplicate-run-id")).toBe(true);
  });

  test("reports succeeded-nonzero-exit error", async () => {
    const root = fixtureRoot();
    const result = await validateExecStore(path.join(root, "exec/store.invalid.json"));

    expect(result.errors.some((e) => e.code === "exec.succeeded-nonzero-exit")).toBe(true);
  });

  test("reports timestamp-order error", async () => {
    const root = fixtureRoot();
    const result = await validateExecStore(path.join(root, "exec/store.invalid.json"));

    expect(result.errors.some((e) => e.code === "exec.timestamp-order")).toBe(true);
  });

  test("throws on missing store file", async () => {
    await expect(validateExecStore("/nonexistent/path/store.json")).rejects.toThrow(
      "Failed to read exec run store"
    );
  });
});

describe("exec domain – launch", () => {
  test("plans a launch with new run_id", async () => {
    const root = fixtureRoot();
    const result = await launchExecRun(path.join(root, "exec/store.valid.json"), {
      command: "calyx agents validate --registry r.json"
    });

    expect(result.run_id).toBeTruthy();
    expect(result.command).toBe("calyx agents validate --registry r.json");
    expect(result.state).toBe("queued");
    expect(result.apply).toBe(false);
    expect(result.created_at).toBeTruthy();
  });

  test("applies a launch with apply flag", async () => {
    const root = fixtureRoot();
    const result = await launchExecRun(path.join(root, "exec/store.valid.json"), {
      command: "calyx skills sync",
      apply: true
    });

    expect(result.apply).toBe(true);
    expect(result.state).toBe("queued");
  });

  test("launch rejects on invalid store", async () => {
    const root = fixtureRoot();
    await expect(
      launchExecRun(path.join(root, "exec/store.invalid.json"), {
        command: "calyx test"
      })
    ).rejects.toThrow("Exec run store validation failed");
  });
});

describe("exec domain – status", () => {
  test("returns status for a succeeded run", async () => {
    const root = fixtureRoot();
    const result = await getExecStatus(path.join(root, "exec/store.valid.json"), {
      run_id: "run-001-succeeded"
    });

    expect(result.run_id).toBe("run-001-succeeded");
    expect(result.state).toBe("succeeded");
    expect(result.exit_code).toBe(0);
    expect(result.command).toBe("calyx config compile --host blade");
    expect(result.started_at).toBe("2026-02-28T10:00:01Z");
    expect(result.completed_at).toBe("2026-02-28T10:00:05Z");
    expect(result.metadata).toEqual({ host: "blade", lane: "config-compiler" });
  });

  test("returns status for a failed run with error", async () => {
    const root = fixtureRoot();
    const result = await getExecStatus(path.join(root, "exec/store.valid.json"), {
      run_id: "run-002-failed"
    });

    expect(result.state).toBe("failed");
    expect(result.exit_code).toBe(3);
    expect(result.error).toBe("Instruction verify failed for 2 drift(s).");
  });

  test("returns status for a running run (no completed_at)", async () => {
    const root = fixtureRoot();
    const result = await getExecStatus(path.join(root, "exec/store.valid.json"), {
      run_id: "run-003-running"
    });

    expect(result.state).toBe("running");
    expect(result.started_at).toBeTruthy();
    expect(result.completed_at).toBeUndefined();
    expect(result.exit_code).toBeUndefined();
  });

  test("throws when run_id not found", async () => {
    const root = fixtureRoot();
    await expect(
      getExecStatus(path.join(root, "exec/store.valid.json"), {
        run_id: "nonexistent-run"
      })
    ).rejects.toThrow('Run "nonexistent-run" not found');
  });
});

describe("exec domain – logs", () => {
  test("returns all logs for a run", async () => {
    const root = fixtureRoot();
    const result = await getExecLogs(path.join(root, "exec/store.valid.json"), {
      run_id: "run-001-succeeded"
    });

    expect(result.run_id).toBe("run-001-succeeded");
    expect(result.total).toBe(4);
    expect(result.entries).toHaveLength(4);
  });

  test("filters logs by level", async () => {
    const root = fixtureRoot();
    const result = await getExecLogs(path.join(root, "exec/store.valid.json"), {
      run_id: "run-002-failed",
      level: "error"
    });

    expect(result.total).toBe(2);
    expect(result.entries.every((e) => e.level === "error")).toBe(true);
  });

  test("applies tail limit", async () => {
    const root = fixtureRoot();
    const result = await getExecLogs(path.join(root, "exec/store.valid.json"), {
      run_id: "run-001-succeeded",
      tail: 2
    });

    expect(result.total).toBe(2);
    expect(result.entries[0]!.message).toBe("Advisory: codex.otel section has no schema");
    expect(result.entries[1]!.message).toBe("Config compile succeeded");
  });

  test("returns empty entries for run with no logs", async () => {
    const root = fixtureRoot();
    const result = await getExecLogs(path.join(root, "exec/store.valid.json"), {
      run_id: "run-004-queued"
    });

    expect(result.total).toBe(0);
    expect(result.entries).toHaveLength(0);
  });
});

describe("exec domain – receipt", () => {
  test("generates receipt for a succeeded run", async () => {
    const root = fixtureRoot();
    const result = await getExecReceipt(path.join(root, "exec/store.valid.json"), {
      run_id: "run-001-succeeded"
    });

    expect(result.run_id).toBe("run-001-succeeded");
    expect(result.state).toBe("succeeded");
    expect(result.exit_code).toBe(0);
    expect(result.duration_ms).toBe(4000);
    expect(result.log_summary).toEqual({ total: 4, info: 3, warn: 1, error: 0 });
    expect(result.summary).toContain("run-001-succeeded");
    expect(result.summary).toContain("succeeded");
    expect(result.summary).toContain("exit_code=0");
    expect(result.summary).toContain("duration=4.0s");
  });

  test("generates receipt for a failed run with error", async () => {
    const root = fixtureRoot();
    const result = await getExecReceipt(path.join(root, "exec/store.valid.json"), {
      run_id: "run-002-failed"
    });

    expect(result.state).toBe("failed");
    expect(result.exit_code).toBe(3);
    expect(result.error).toBe("Instruction verify failed for 2 drift(s).");
    expect(result.duration_ms).toBe(9000);
    expect(result.log_summary.error).toBe(2);
    expect(result.summary).toContain("failed");
    expect(result.summary).toContain("error:");
  });

  test("generates receipt for a queued run (no duration)", async () => {
    const root = fixtureRoot();
    const result = await getExecReceipt(path.join(root, "exec/store.valid.json"), {
      run_id: "run-004-queued"
    });

    expect(result.state).toBe("queued");
    expect(result.duration_ms).toBeUndefined();
    expect(result.log_summary.total).toBe(0);
  });

  test("receipt includes machine-readable fields", async () => {
    const root = fixtureRoot();
    const result = await getExecReceipt(path.join(root, "exec/store.valid.json"), {
      run_id: "run-001-succeeded"
    });

    // Verify the receipt can be serialized to JSON cleanly
    const json = JSON.parse(JSON.stringify(result));
    expect(json.run_id).toBe("run-001-succeeded");
    expect(json.command).toBe("calyx config compile --host blade");
    expect(json.state).toBe("succeeded");
    expect(json.log_summary.total).toBe(4);
    expect(typeof json.summary).toBe("string");
  });

  test("receipt throws for nonexistent run", async () => {
    const root = fixtureRoot();
    await expect(
      getExecReceipt(path.join(root, "exec/store.valid.json"), {
        run_id: "ghost"
      })
    ).rejects.toThrow('Run "ghost" not found');
  });
});
