import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { classify, matchPatterns, EXIT_CODE_MAP } from "@polli-labs/calyx-runner";
import type { ClassifierInput } from "@polli-labs/calyx-runner";

const FIXTURE_DIR = resolve(import.meta.dirname, "../../../fixtures/domains/runner");

interface ClassifierSample {
  _description: string;
  input: ClassifierInput;
  expected: { class: string; source: string };
}

// ── Fixture-driven classifier tests ─────────────────────────────────

describe("classifier (fixture-driven)", () => {
  let samples: ClassifierSample[];

  test("load fixtures", async () => {
    const raw = await readFile(resolve(FIXTURE_DIR, "classifier-samples.json"), "utf8");
    samples = JSON.parse(raw) as ClassifierSample[];
    expect(samples.length).toBeGreaterThan(0);
  });

  test("all fixture samples classify correctly", () => {
    for (const sample of samples!) {
      const result = classify(sample.input);
      expect(result.class, sample._description).toBe(sample.expected.class);
      expect(result.source, sample._description).toBe(sample.expected.source);
    }
  });
});

// ── Precedence chain ────────────────────────────────────────────────

describe("classifier precedence", () => {
  test("P1: structured exit code takes priority over stderr", () => {
    const result = classify({
      exit_code: 8, // auth_error via exit code
      stderr: "Connection refused", // would be infra_error via pattern
    });
    expect(result.class).toBe("auth_error");
    expect(result.source).toBe("exit_code");
  });

  test("P2: backend events take priority over stderr patterns", () => {
    const result = classify({
      exit_code: 99, // unmapped exit code
      backend_events: [{ event: "auth_failure" }],
      stderr: "Connection refused", // infra pattern
    });
    expect(result.class).toBe("auth_error");
    expect(result.source).toBe("backend_event");
  });

  test("P3: completed_dirty heuristic over stderr when no auth/infra signal", () => {
    const result = classify({
      exit_code: 1,
      event_count: 15,
      final_artifact_present: true,
      stderr: "some non-matching error text",
    });
    expect(result.class).toBe("completed_dirty");
    expect(result.source).toBe("heuristic");
  });

  test("P3: completed_dirty does NOT override auth_error stderr", () => {
    const result = classify({
      exit_code: 1,
      event_count: 15,
      final_artifact_present: true,
      stderr: "Error: 401 Unauthorized",
    });
    // auth_error signal in stderr prevents completed_dirty,
    // so it falls through to stderr pattern match
    expect(result.class).toBe("auth_error");
    expect(result.source).toBe("stderr_pattern");
  });

  test("P4: stderr pattern match when no higher-priority signals", () => {
    const result = classify({
      exit_code: 42, // unmapped
      stderr: "SIGKILL received",
    });
    expect(result.class).toBe("infra_error");
    expect(result.source).toBe("stderr_pattern");
  });

  test("P5: default — unmapped exit code → task_failure", () => {
    const result = classify({ exit_code: 42 });
    expect(result.class).toBe("task_failure");
    expect(result.source).toBe("exit_code");
  });

  test("P5: default — no exit code → infra_error", () => {
    const result = classify({});
    expect(result.class).toBe("infra_error");
    expect(result.source).toBe("exit_code");
    expect(result.effective_exit_code).toBe(6);
  });
});

// ── completed_dirty threshold ───────────────────────────────────────

describe("completed_dirty threshold", () => {
  test("below threshold → task_failure", () => {
    const result = classify({
      exit_code: 1,
      event_count: 9,
      final_artifact_present: true,
    });
    expect(result.class).toBe("task_failure");
  });

  test("at threshold → completed_dirty", () => {
    const result = classify({
      exit_code: 1,
      event_count: 10,
      final_artifact_present: true,
    });
    expect(result.class).toBe("completed_dirty");
  });

  test("custom threshold respected", () => {
    const result = classify({
      exit_code: 1,
      event_count: 5,
      final_artifact_present: true,
      dirty_threshold: 5,
    });
    expect(result.class).toBe("completed_dirty");
  });

  test("missing artifact prevents completed_dirty", () => {
    const result = classify({
      exit_code: 1,
      event_count: 15,
      final_artifact_present: false,
    });
    expect(result.class).toBe("task_failure");
  });

  test("exit code 0 prevents completed_dirty path", () => {
    // exit code 0 → success at P1, never reaches P3
    const result = classify({
      exit_code: 0,
      event_count: 100,
      final_artifact_present: true,
    });
    expect(result.class).toBe("success");
  });

  test("effective_exit_code is 0 for completed_dirty", () => {
    const result = classify({
      exit_code: 1,
      event_count: 15,
      final_artifact_present: true,
    });
    expect(result.effective_exit_code).toBe(0);
    expect(result.raw_exit_code).toBe(1);
  });
});

// ── Pattern matching ────────────────────────────────────────────────

describe("matchPatterns", () => {
  test("matches auth-401", () => {
    const result = matchPatterns("HTTP 401 Unauthorized");
    expect(result?.class).toBe("auth_error");
    expect(result?.signal).toContain("auth-401");
  });

  test("matches auth-403", () => {
    const result = matchPatterns("Access Denied: 403 Forbidden");
    expect(result?.class).toBe("auth_error");
    expect(result?.signal).toContain("auth-403");
  });

  test("matches auth-token", () => {
    const result = matchPatterns("API token expired, please refresh");
    expect(result?.class).toBe("auth_error");
    expect(result?.signal).toContain("auth-token");
  });

  test("matches infra-ssh", () => {
    const result = matchPatterns("Connection refused on port 22");
    expect(result?.class).toBe("infra_error");
    expect(result?.signal).toContain("infra-ssh");
  });

  test("matches infra-spawn", () => {
    const result = matchPatterns("bash: codex: command not found");
    expect(result?.class).toBe("infra_error");
    expect(result?.signal).toContain("infra-spawn");
  });

  test("matches infra-oom", () => {
    const result = matchPatterns("Out of memory: Killed process 12345");
    expect(result?.class).toBe("infra_error");
    expect(result?.signal).toContain("infra-oom");
  });

  test("matches infra-panic", () => {
    const result = matchPatterns("SIGSEGV: segmentation fault");
    expect(result?.class).toBe("infra_error");
    expect(result?.signal).toContain("infra-panic");
  });

  test("false-positive guard: mock context negates auth-401", () => {
    const result = matchPatterns("mock: testing 401 Unauthorized handling");
    expect(result).toBeNull();
  });

  test("false-positive guard: test context negates auth-403", () => {
    const result = matchPatterns("test fixture returns 403 Forbidden");
    expect(result).toBeNull();
  });

  test("false-positive guard: test context negates infra-spawn", () => {
    const result = matchPatterns("test: simulated command not found error");
    expect(result).toBeNull();
  });

  test("returns null for non-matching stderr", () => {
    const result = matchPatterns("Everything completed normally.");
    expect(result).toBeNull();
  });

  test("skips retired patterns", () => {
    const patterns = [
      {
        id: "retired-pattern",
        pattern: /always-match/i,
        class: "auth_error" as const,
        since: "0.1.0",
        retired: "1.0.0",
      },
    ];
    const result = matchPatterns("always-match", patterns);
    expect(result).toBeNull();
  });
});

// ── Exit code map ───────────────────────────────────────────────────

describe("EXIT_CODE_MAP", () => {
  const expectedMappings: [number, string][] = [
    [0, "success"],
    [1, "task_failure"],
    [3, "dispatch_rejected"],
    [4, "infra_error"],
    [5, "infra_error"],
    [6, "infra_error"],
    [7, "infra_error"],
    [8, "auth_error"],
    [9, "dispatch_rejected"],
  ];

  test.each(expectedMappings)("exit code %d → %s", (code, expected) => {
    expect(EXIT_CODE_MAP[code]).toBe(expected);
  });

  test("exit code 2 is not mapped (usage error, not a classification)", () => {
    expect(EXIT_CODE_MAP[2]).toBeUndefined();
  });
});

// ── Backend event classification ────────────────────────────────────

describe("backend events", () => {
  test("auth_failure event → auth_error", () => {
    const result = classify({
      exit_code: 99,
      backend_events: [{ event: "auth_failure" }],
    });
    expect(result.class).toBe("auth_error");
    expect(result.source).toBe("backend_event");
    expect(result.effective_exit_code).toBe(8);
  });

  test("infra_failure event → infra_error", () => {
    const result = classify({
      exit_code: 99,
      backend_events: [{ event: "infra_failure" }],
    });
    expect(result.class).toBe("infra_error");
    expect(result.source).toBe("backend_event");
    expect(result.effective_exit_code).toBe(6);
  });

  test("unrecognized event falls through", () => {
    const result = classify({
      exit_code: 99,
      backend_events: [{ event: "progress_update" }],
    });
    // Falls through to P5 default
    expect(result.class).toBe("task_failure");
    expect(result.source).toBe("exit_code");
  });
});
