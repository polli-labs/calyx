/**
 * @polli-labs/calyx-runner — Stderr pattern registry.
 *
 * Version-pinned pattern set for failure classification from stderr output.
 * Each pattern has an explicit false-positive guard (negated_by).
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type { FailureClass, StderrPattern, ClassificationResult } from "./types.js";

export const PATTERN_VERSION = "1.0.0";

export const STDERR_PATTERNS: readonly StderrPattern[] = [
  {
    id: "auth-401",
    pattern: /\b(401|Unauthorized)\b/i,
    class: "auth_error",
    negated_by: [/mock|test|fixture/i],
    since: "1.0.0",
  },
  {
    id: "auth-403",
    pattern: /\b(403|Forbidden)\b/i,
    class: "auth_error",
    negated_by: [/mock|test|fixture/i],
    since: "1.0.0",
  },
  {
    id: "auth-token",
    pattern: /token.*(expired|invalid|revoked)/i,
    class: "auth_error",
    since: "1.0.0",
  },
  {
    id: "infra-ssh",
    pattern: /Connection refused|Connection reset/i,
    class: "infra_error",
    since: "1.0.0",
  },
  {
    id: "infra-spawn",
    pattern: /command not found|ENOENT/i,
    class: "infra_error",
    negated_by: [/mock|test/i],
    since: "1.0.0",
  },
  {
    id: "infra-oom",
    pattern: /Out of memory|OOM|SIGKILL/i,
    class: "infra_error",
    since: "1.0.0",
  },
  {
    id: "infra-panic",
    pattern: /panic|SIGSEGV|core dumped/i,
    class: "infra_error",
    since: "1.0.0",
  },
];

/**
 * Match stderr against the pattern registry.
 * Returns the first matching pattern's classification, or null if none match.
 * False-positive guards (negated_by) are checked for each match.
 */
export function matchPatterns(
  stderr: string,
  patterns: readonly StderrPattern[] = STDERR_PATTERNS,
): Pick<ClassificationResult, "class" | "source" | "signal" | "confidence"> | null {
  for (const entry of patterns) {
    // Skip retired patterns
    if (entry.retired) continue;

    if (entry.pattern.test(stderr)) {
      // Check false-positive guards
      if (entry.negated_by?.some((neg) => neg.test(stderr))) {
        continue;
      }
      return {
        class: entry.class,
        source: "stderr_pattern",
        signal: `stderr matched pattern: ${entry.id}`,
        confidence: "definitive",
      };
    }
  }
  return null;
}

/** Exit code → FailureClass mapping for structured exit codes. */
export const EXIT_CODE_MAP: Readonly<Record<number, FailureClass>> = {
  0: "success",
  1: "task_failure",
  3: "dispatch_rejected",
  4: "infra_error",
  5: "infra_error",
  6: "infra_error",
  7: "infra_error",
  8: "auth_error",
  9: "dispatch_rejected",
};
