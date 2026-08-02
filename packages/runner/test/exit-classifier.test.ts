/**
 * Tests for the exit classifier pipeline (POL-904).
 *
 * Covers each built-in classifier in isolation, pipeline ordering,
 * and graceful degradation when session evidence is missing.
 */

import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ExitZeroClassifier,
  SpawnErrorClassifier,
  SessionEvidenceClassifier,
  StderrPatternClassifier,
  DurationHeuristicClassifier,
  DefaultClassifier,
  ClassifierPipeline,
  classifyRunOutcome,
} from "@polli-labs/calyx-runner";
const FIXTURE_DIR = resolve(import.meta.dirname, "../../../fixtures/domains/runner/sessions");

// ── ExitZeroClassifier ──────────────────────────────────────────────

describe("ExitZeroClassifier", () => {
  const classifier = new ExitZeroClassifier();

  test("exit 0 → succeeded (high confidence)", () => {
    const result = classifier.classify({
      exit_code: 0,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("succeeded");
    expect(result!.confidence).toBe("high");
  });

  test("exit 1 → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeUndefined();
  });

  test("exit undefined → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: undefined,
      duration_ms: 1000,
      stderr: "",
      backend: "codex",
    });
    expect(result).toBeUndefined();
  });
});

// ── SpawnErrorClassifier ─────────────────────────────────────────────

describe("SpawnErrorClassifier", () => {
  const classifier = new SpawnErrorClassifier();

  test("maxBuffer exceeded → failed with infra_error (high confidence)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 60_000,
      stderr: "",
      backend: "claude",
      spawn_error: "maxBuffer exceeded",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("failed");
    expect(result!.failure_class).toBe("infra_error");
    expect(result!.confidence).toBe("high");
  });

  test("no spawn_error → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 60_000,
      stderr: "some error",
      backend: "claude",
    });
    expect(result).toBeUndefined();
  });

  test("arbitrary spawn_error string → failed with infra_error", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 1000,
      stderr: "",
      backend: "codex",
      spawn_error: "ENOENT: command not found",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("failed");
    expect(result!.failure_class).toBe("infra_error");
  });
});

// ── SessionEvidenceClassifier ───────────────────────────────────────

describe("SessionEvidenceClassifier", () => {
  const classifier = new SessionEvidenceClassifier();

  test("budget-exhausted claude session → partial with budget_exhaustion", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-budget-exhausted.jsonl"),
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("budget_exhaustion");
    expect(result!.confidence).toBe("high");
  });

  test("budget-exhausted codex session → partial with budget_exhaustion", async () => {
    const codexAwareClassifier = new SessionEvidenceClassifier({
      parsers: {
        codex: async () => [
          { text: "Investigating the current state.", timestamp: "2026-03-18T10:00:01Z" },
          { text: "Implemented the first slice and updated the tests.", timestamp: "2026-03-18T10:05:00Z" },
        ],
      },
    });

    const result = await codexAwareClassifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "",
      backend: "codex",
      session_path: "/tmp/codex-session.jsonl",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("budget_exhaustion");
    expect(result!.confidence).toBe("high");
  });

  test("immediate crash (0 assistant messages) → undefined (passes through)", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 3000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-immediate-crash.jsonl"),
    });
    expect(result).toBeUndefined();
  });

  test("graceful stop with progress language → partial", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 120_000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-graceful-stop.jsonl"),
      terminal_message: "I finished the first two features but could not complete the remaining work.",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
  });

  test("exit 0 → undefined (skips, let ExitZero handle it)", async () => {
    const result = await classifier.classify({
      exit_code: 0,
      duration_ms: 60_000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-session.jsonl"),
    });
    expect(result).toBeUndefined();
  });

  test("no session_path → undefined (passes through)", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeUndefined();
  });

  test("nonexistent session file → undefined (graceful degradation)", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "",
      backend: "claude",
      session_path: "/nonexistent/session.jsonl",
    });
    expect(result).toBeUndefined();
  });

  test("session with many messages but no progress language → partial with unknown reason", async () => {
    const result = await classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-session.jsonl"),
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    // "implemented" in the terminal message matches progress patterns
    expect(result!.partial_reason).toBe("budget_exhaustion");
  });
});

// ── StderrPatternClassifier ─────────────────────────────────────────

describe("StderrPatternClassifier", () => {
  const classifier = new StderrPatternClassifier();

  test("OOM → failed with infra_error", () => {
    const result = classifier.classify({
      exit_code: 137,
      duration_ms: 60_000,
      stderr: "Out of memory: Killed process 12345",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("failed");
    expect(result!.failure_class).toBe("infra_error");
    expect(result!.confidence).toBe("high");
  });

  test("SIGKILL → failed with infra_error", () => {
    const result = classifier.classify({
      exit_code: 137,
      duration_ms: 60_000,
      stderr: "process received SIGKILL",
      backend: "codex",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("failed");
    expect(result!.failure_class).toBe("infra_error");
  });

  test("SIGTERM → partial with operator_stop", () => {
    const result = classifier.classify({
      exit_code: 143,
      duration_ms: 120_000,
      stderr: "Received SIGTERM, shutting down",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("operator_stop");
    expect(result!.confidence).toBe("high");
  });

  test("SIGINT → partial with operator_stop", () => {
    const result = classifier.classify({
      exit_code: 130,
      duration_ms: 60_000,
      stderr: "SIGINT received",
      backend: "codex",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("operator_stop");
  });

  test("budget/token limit in stderr → partial with budget_exhaustion", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "Error: token limit exceeded",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("budget_exhaustion");
    expect(result!.confidence).toBe("medium");
  });

  test("context window in stderr → partial with budget_exhaustion", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "context window limit reached",
      backend: "codex",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("budget_exhaustion");
  });

  test("empty stderr → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 60_000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeUndefined();
  });

  test("non-matching stderr → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 60_000,
      stderr: "Some generic error occurred",
      backend: "codex",
    });
    expect(result).toBeUndefined();
  });
});

// ── DurationHeuristicClassifier ─────────────────────────────────────

describe("DurationHeuristicClassifier", () => {
  const classifier = new DurationHeuristicClassifier();

  test("long run (>5min) with exit 1 and no session → partial (low confidence)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 600_000, // 10 minutes
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
    expect(result!.partial_reason).toBe("unknown");
    expect(result!.confidence).toBe("low");
  });

  test("short crash (3 seconds) with exit 1 → undefined (passes through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 3000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeUndefined();
  });

  test("exit code 137 (signal) → undefined (only triggers for exit 1)", () => {
    const result = classifier.classify({
      exit_code: 137,
      duration_ms: 600_000,
      stderr: "",
      backend: "codex",
    });
    expect(result).toBeUndefined();
  });

  test("fires even with session_path set (session classifier may have passed through)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 600_000,
      stderr: "",
      backend: "claude",
      session_path: "/some/session.jsonl",
    });
    // Duration heuristic fires as fallback when SessionEvidence passed through
    // (e.g., corrupt session file or too few messages)
    expect(result).toEqual({
      state: "partial",
      partial_reason: "unknown",
      confidence: "low",
    });
  });

  test("exactly at 5-min threshold → undefined (not strictly greater)", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 5 * 60 * 1000, // exactly 5 minutes
      stderr: "",
      backend: "codex",
    });
    expect(result).toBeUndefined();
  });

  test("just above 5-min threshold → partial", () => {
    const result = classifier.classify({
      exit_code: 1,
      duration_ms: 5 * 60 * 1000 + 1,
      stderr: "",
      backend: "codex",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("partial");
  });
});

// ── DefaultClassifier ───────────────────────────────────────────────

describe("DefaultClassifier", () => {
  const classifier = new DefaultClassifier();

  test("always returns failed with task_failure", () => {
    const result = classifier.classify({
      exit_code: 42,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
    });
    expect(result).toBeDefined();
    expect(result!.state).toBe("failed");
    expect(result!.failure_class).toBe("task_failure");
    expect(result!.confidence).toBe("high");
  });

  test("returns failed for exit undefined", () => {
    const result = classifier.classify({
      exit_code: undefined,
      duration_ms: 1000,
      stderr: "",
      backend: "codex",
    });
    expect(result!.state).toBe("failed");
  });
});

// ── ClassifierPipeline ──────────────────────────────────────────────

describe("ClassifierPipeline", () => {
  test("first match wins — ExitZero beats SessionEvidence", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 0,
      duration_ms: 300_000,
      stderr: "",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-budget-exhausted.jsonl"),
    });
    expect(result.state).toBe("succeeded");
  });

  test("session evidence beats stderr when session available", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "some generic error",
      backend: "claude",
      session_path: resolve(FIXTURE_DIR, "claude-budget-exhausted.jsonl"),
    });
    expect(result.state).toBe("partial");
    expect(result.partial_reason).toBe("budget_exhaustion");
  });

  test("falls through to default for unrecognized short failure", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 42,
      duration_ms: 2000,
      stderr: "",
      backend: "claude",
    });
    expect(result.state).toBe("failed");
    expect(result.failure_class).toBe("task_failure");
  });

  test("graceful degradation: no session file → falls through to duration or default", async () => {
    const pipeline = new ClassifierPipeline();

    // Long run without session → duration heuristic
    const longResult = await pipeline.classify({
      exit_code: 1,
      duration_ms: 600_000,
      stderr: "",
      backend: "codex",
    });
    expect(longResult.state).toBe("partial");
    expect(longResult.confidence).toBe("low");

    // Short run without session → default (failed)
    const shortResult = await pipeline.classify({
      exit_code: 1,
      duration_ms: 2000,
      stderr: "",
      backend: "codex",
    });
    expect(shortResult.state).toBe("failed");
  });

  test("custom pipeline with only ExitZero and Default", async () => {
    const pipeline = new ClassifierPipeline([
      new ExitZeroClassifier(),
      new DefaultClassifier(),
    ]);

    const successResult = await pipeline.classify({
      exit_code: 0,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
    });
    expect(successResult.state).toBe("succeeded");

    const failResult = await pipeline.classify({
      exit_code: 1,
      duration_ms: 600_000,
      stderr: "",
      backend: "claude",
    });
    // No session/duration classifier → straight to default
    expect(failResult.state).toBe("failed");
  });

  test("stderr OOM wins when no session evidence", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 137,
      duration_ms: 60_000,
      stderr: "Out of memory: Killed process 12345",
      backend: "codex",
    });
    expect(result.state).toBe("failed");
    expect(result.failure_class).toBe("infra_error");
  });

  test("SIGTERM in stderr → partial with operator_stop", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 143,
      duration_ms: 300_000,
      stderr: "Received SIGTERM",
      backend: "claude",
    });
    expect(result.state).toBe("partial");
    expect(result.partial_reason).toBe("operator_stop");
  });

  test("spawn_error takes precedence over stderr patterns", async () => {
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 1,
      duration_ms: 300_000,
      stderr: "token limit exceeded",
      backend: "claude",
      spawn_error: "maxBuffer exceeded",
    });
    // SpawnErrorClassifier fires before StderrPatternClassifier
    expect(result.state).toBe("failed");
    expect(result.failure_class).toBe("infra_error");
  });

  test("spawn_error does not override exit 0", async () => {
    // This edge case shouldn't happen in practice, but verifies pipeline ordering
    const pipeline = new ClassifierPipeline();
    const result = await pipeline.classify({
      exit_code: 0,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
      spawn_error: "maxBuffer exceeded",
    });
    // ExitZeroClassifier fires first
    expect(result.state).toBe("succeeded");
  });
});

// ── classifyRunOutcome convenience function ─────────────────────────

describe("classifyRunOutcome", () => {
  test("returns RunOutcome via default pipeline", async () => {
    const result = await classifyRunOutcome({
      exit_code: 0,
      duration_ms: 1000,
      stderr: "",
      backend: "claude",
    });
    expect(result.state).toBe("succeeded");
    expect(result.confidence).toBe("high");
  });

  test("classifies long failure as partial", async () => {
    const result = await classifyRunOutcome({
      exit_code: 1,
      duration_ms: 600_000,
      stderr: "",
      backend: "codex",
    });
    expect(result.state).toBe("partial");
  });
});
