/**
 * @polli-labs/calyx-runner — Failure classifier.
 *
 * Five-level precedence chain:
 *   1. Structured exit code
 *   2. Backend events (typed error events)
 *   3. Heuristic: completed_dirty detection
 *   4. Stderr pattern matching
 *   5. Default classification
 *
 * The first level that produces a definitive result wins.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type { ClassificationResult, ClassifierInput, FailureClass, FailureSource } from "./types.js";
import { EXIT_CODE_MAP, matchPatterns } from "./patterns.js";

const DEFAULT_DIRTY_THRESHOLD = 10;

/** Build a ClassificationResult, omitting raw_exit_code when undefined. */
function result(
  cls: FailureClass,
  source: FailureSource,
  confidence: "definitive" | "heuristic",
  signal: string,
  effective_exit_code: number,
  raw_exit_code?: number,
): ClassificationResult {
  const r: ClassificationResult = {
    class: cls,
    source,
    confidence,
    signal,
    effective_exit_code,
  };
  if (raw_exit_code !== undefined) {
    r.raw_exit_code = raw_exit_code;
  }
  return r;
}

/**
 * Classify a run's outcome through the 5-level precedence chain.
 *
 * @param input - Signals collected from the run (exit code, stderr, events, artifacts).
 * @returns Classification result with class, source, confidence, and effective exit code.
 */
export function classify(input: ClassifierInput): ClassificationResult {
  const { exit_code, stderr, event_count, final_artifact_present, backend_events } = input;
  const dirty_threshold = input.dirty_threshold ?? DEFAULT_DIRTY_THRESHOLD;

  // ── Priority 1: Structured exit code ────────────────────────────
  // Only definitive for codes with specific semantics (0=success, 3-9=typed errors).
  // Exit code 1 is the generic "task_failure" default — it falls through to allow
  // heuristic reclassification (e.g., completed_dirty at P3).
  if (exit_code !== undefined && exit_code in EXIT_CODE_MAP) {
    const mapped = EXIT_CODE_MAP[exit_code]!;
    if (mapped !== "task_failure") {
      return result(mapped, "exit_code", "definitive", `exit code ${exit_code}`, exit_code, exit_code);
    }
  }

  // ── Priority 2: Structured backend events ───────────────────────
  if (backend_events && backend_events.length > 0) {
    for (const ev of backend_events) {
      if (ev.event === "auth_failure") {
        return result("auth_error", "backend_event", "definitive", `backend event: ${ev.event}`, 8, exit_code);
      }
      if (ev.event === "infra_failure") {
        return result("infra_error", "backend_event", "definitive", `backend event: ${ev.event}`, 6, exit_code);
      }
    }
  }

  // ── Priority 3: Heuristic — completed_dirty ─────────────────────
  if (
    exit_code !== undefined &&
    exit_code !== 0 &&
    event_count !== undefined &&
    event_count >= dirty_threshold &&
    final_artifact_present === true
  ) {
    // Only classify as dirty if no auth/infra signals in stderr
    const stderrMatch = stderr ? matchPatterns(stderr) : null;
    if (!stderrMatch || (stderrMatch.class !== "auth_error" && stderrMatch.class !== "infra_error")) {
      return result(
        "completed_dirty", "heuristic", "heuristic",
        `event_count=${event_count} >= threshold=${dirty_threshold}, final artifact present`,
        0, exit_code,
      );
    }
  }

  // ── Priority 4: Stderr pattern matching ─────────────────────────
  if (stderr) {
    const match = matchPatterns(stderr);
    if (match) {
      const effective = match.class === "auth_error" ? 8 : match.class === "infra_error" ? 6 : 1;
      return result(match.class, match.source, match.confidence, match.signal, effective, exit_code);
    }
  }

  // ── Priority 5: Default classification ──────────────────────────
  if (exit_code === 0) {
    return result("success", "exit_code", "definitive", "exit code 0", 0, exit_code);
  }

  if (exit_code === undefined) {
    // Per contract precedence, missing exit code defaults to infra_error.
    return result("infra_error", "exit_code", "definitive", "no exit code", 6);
  }

  return result("task_failure", "exit_code", "definitive", `unrecognized exit code ${exit_code}`, exit_code, exit_code);
}
