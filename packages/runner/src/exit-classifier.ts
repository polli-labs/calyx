/**
 * @polli-labs/calyx-runner — Exit classification pipeline.
 *
 * Ordered pipeline of classifiers that determine the terminal state of a run
 * from observable evidence. First definitive match wins.
 *
 * Pipeline order:
 *   1. ExitZeroClassifier — exit 0 → succeeded
 *   2. SessionEvidenceClassifier — session content → partial or pass-through
 *   3. StderrPatternClassifier — known stderr patterns → failed or partial
 *   4. DurationHeuristicClassifier — long run fallback → partial (low confidence)
 *   5. DefaultClassifier — everything else → failed
 *
 * Design principles:
 *   - Backend-agnostic: no dependency on specific CLI exit codes
 *   - Evidence-based: uses observable session data, not brittle heuristics
 *   - Extensible: new classifiers slot into the pipeline without modifying existing ones
 *   - Graceful degradation: missing session data falls through to duration/default
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type { FailureClass } from "./types.js";
import type { PartialReason } from "./types.js";
import {
  parseClaudeAssistantMessages,
  type AssistantMessage,
} from "./adapters/session-parser.js";
import type { SessionParserFs } from "./adapters/session-parser.js";

export type AssistantMessageParser = (
  sessionPath: string,
  fs?: SessionParserFs,
) => Promise<AssistantMessage[]>;

// ── Interfaces ──────────────────────────────────────────────────────

/** Raw signals available after a run completes. */
export interface ExitEvidence {
  exit_code: number | undefined;
  signal?: string;
  duration_ms: number;
  stderr: string;
  session_path?: string;
  terminal_message?: string;
  backend: "claude" | "codex" | string;
  /** Set when the spawn itself failed (e.g., buffer overflow, ENOENT). */
  spawn_error?: string;
}

/** Classified outcome of a run. */
export interface RunOutcome {
  state: "succeeded" | "failed" | "partial";
  failure_class?: FailureClass;
  partial_reason?: PartialReason;
  confidence: "high" | "medium" | "low";
}

/** A single classifier in the pipeline. Returns an outcome or undefined to pass. */
export interface RunClassifier {
  name: string;
  classify(evidence: ExitEvidence): RunOutcome | undefined | Promise<RunOutcome | undefined>;
}

// ── Built-in classifiers ────────────────────────────────────────────

/**
 * Exit code 0 → succeeded. No ambiguity.
 */
export class ExitZeroClassifier implements RunClassifier {
  name = "ExitZeroClassifier";

  classify(evidence: ExitEvidence): RunOutcome | undefined {
    if (evidence.exit_code === 0) {
      return { state: "succeeded", confidence: "high" };
    }
    return undefined;
  }
}

/**
 * Spawn-level error classifier.
 *
 * Detects when the spawn itself failed (buffer overflow, ENOENT, etc.)
 * before the backend even had a chance to run. These are always infra_error.
 */
export class SpawnErrorClassifier implements RunClassifier {
  name = "SpawnErrorClassifier";

  classify(evidence: ExitEvidence): RunOutcome | undefined {
    if (evidence.spawn_error) {
      return {
        state: "failed",
        failure_class: "infra_error",
        confidence: "high",
      };
    }
    return undefined;
  }
}

/** Progress-indicating words in terminal messages. */
const PROGRESS_PATTERNS = [
  /\bmerged\b/i,
  /\bcreated\b/i,
  /\bupdated\b/i,
  /\bcompleted\b/i,
  /\bfiled\b/i,
  /\bmaterialized\b/i,
  /\bcommitted\b/i,
  /\bpushed\b/i,
  /\bdeployed\b/i,
  /\bimplemented\b/i,
  /\bfinished\b/i,
  /\bwrote\b/i,
  /\bgenerated\b/i,
  /\bapplied\b/i,
  /\binstalled\b/i,
  /\bpublished\b/i,
];

/**
 * Analyzes session content for evidence of partial completion.
 *
 * When a session_path is available, parses the session file to count
 * assistant messages and examine the terminal message for progress indicators.
 */
export class SessionEvidenceClassifier implements RunClassifier {
  name = "SessionEvidenceClassifier";

  private fs: SessionParserFs | undefined;
  private readonly parsers: Record<string, AssistantMessageParser>;

  constructor(options?: {
    fs?: SessionParserFs;
    parsers?: Record<string, AssistantMessageParser>;
  }) {
    this.fs = options?.fs ?? undefined;
    this.parsers = {
      claude: parseClaudeAssistantMessages,
      ...(options?.parsers ?? {}),
    };
  }

  async classify(evidence: ExitEvidence): Promise<RunOutcome | undefined> {
    // Only applies to non-zero exits with session data available
    if (evidence.exit_code === 0) return undefined;
    if (!evidence.session_path) return undefined;

    try {
      const parser = this.parsers[evidence.backend];
      if (!parser) return undefined;
      const messages = this.fs
        ? await parser(evidence.session_path, this.fs)
        : await parser(evidence.session_path);

      // No messages or very few → not partial, pass through (likely crash)
      if (messages.length <= 1) return undefined;

      // Multiple assistant messages indicate the agent did work
      const terminalText = evidence.terminal_message ?? messages[messages.length - 1]?.text ?? "";

      // Check terminal message for progress indicators
      const hasProgress = PROGRESS_PATTERNS.some((p) => p.test(terminalText));
      if (hasProgress) {
        return {
          state: "partial",
          partial_reason: "budget_exhaustion",
          confidence: "high",
        };
      }

      // Many tool-call rounds but no clear terminal progress indicator
      if (messages.length > 5) {
        return {
          state: "partial",
          partial_reason: "unknown",
          confidence: "medium",
        };
      }
    } catch {
      // Session parsing failed — graceful degradation, pass to next classifier
    }

    return undefined;
  }
}

/** Known OOM / kill patterns. */
const OOM_KILL_PATTERN = /\b(Out of memory|OOM|SIGKILL|Killed|signal\s*9)\b/i;
/** Known operator-stop patterns. */
const SIGTERM_PATTERN = /\b(SIGTERM|SIGINT)\b/i;
/** Known budget/context patterns. */
const BUDGET_PATTERN = /\b(context window|token limit|budget|max.turns|rate.limit)\b/i;

/**
 * Checks stderr text AND exit code / signal for known failure or partial modes.
 *
 * Signal-killed processes (SIGKILL=137, SIGINT=130) may have empty stderr,
 * so we check the exit code and signal field in addition to text patterns.
 */
export class StderrPatternClassifier implements RunClassifier {
  name = "StderrPatternClassifier";

  classify(evidence: ExitEvidence): RunOutcome | undefined {
    // Exit-code-based signal detection (may have empty stderr)
    if (evidence.exit_code === 137 || evidence.signal === "SIGKILL") {
      return {
        state: "failed",
        failure_class: "infra_error",
        confidence: "high",
      };
    }
    if (evidence.exit_code === 130 || evidence.signal === "SIGTERM" || evidence.signal === "SIGINT") {
      return {
        state: "partial",
        partial_reason: "operator_stop",
        confidence: "high",
      };
    }

    if (!evidence.stderr) return undefined;

    // OOM / killed → hard failure (infra)
    if (OOM_KILL_PATTERN.test(evidence.stderr)) {
      return {
        state: "failed",
        failure_class: "infra_error",
        confidence: "high",
      };
    }

    // SIGTERM / SIGINT in stderr text → operator stop, partial
    if (SIGTERM_PATTERN.test(evidence.stderr)) {
      return {
        state: "partial",
        partial_reason: "operator_stop",
        confidence: "high",
      };
    }

    // Budget / context / token limit patterns → partial
    if (BUDGET_PATTERN.test(evidence.stderr)) {
      return {
        state: "partial",
        partial_reason: "budget_exhaustion",
        confidence: "medium",
      };
    }

    return undefined;
  }
}

/** Minimum duration (ms) to consider a run as potentially partial rather than a crash. */
const DURATION_PARTIAL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Duration-based heuristic fallback.
 *
 * A long-running process that exits 1 (not a signal) is categorically different
 * from a 3-second crash. This is a low-confidence classifier.
 *
 * Note: this fires even when session_path is set, because the
 * SessionEvidenceClassifier may have passed through (e.g., corrupt session
 * file or too few messages). If SessionEvidence already classified the run
 * as partial, this classifier is never reached (pipeline short-circuits).
 */
export class DurationHeuristicClassifier implements RunClassifier {
  name = "DurationHeuristicClassifier";

  classify(evidence: ExitEvidence): RunOutcome | undefined {
    // Only for exit code 1 (generic failure, not signal-killed)
    if (evidence.exit_code !== 1) return undefined;

    if (evidence.duration_ms > DURATION_PARTIAL_THRESHOLD_MS) {
      return {
        state: "partial",
        partial_reason: "unknown",
        confidence: "low",
      };
    }

    return undefined;
  }
}

/**
 * Default classifier — fallback to current behavior.
 * Everything unclassified becomes a task_failure.
 */
export class DefaultClassifier implements RunClassifier {
  name = "DefaultClassifier";

  classify(_evidence: ExitEvidence): RunOutcome {
    return {
      state: "failed",
      failure_class: "task_failure",
      confidence: "high",
    };
  }
}

// ── Pipeline ────────────────────────────────────────────────────────

/**
 * Ordered classifier pipeline. Runs classifiers in sequence;
 * the first to return a definitive RunOutcome wins.
 */
export class ClassifierPipeline {
  private classifiers: RunClassifier[];

  constructor(classifiers?: RunClassifier[]) {
    this.classifiers = classifiers ?? [
      new ExitZeroClassifier(),
      new SpawnErrorClassifier(),
      new SessionEvidenceClassifier(),
      new StderrPatternClassifier(),
      new DurationHeuristicClassifier(),
      new DefaultClassifier(),
    ];
  }

  async classify(evidence: ExitEvidence): Promise<RunOutcome> {
    for (const c of this.classifiers) {
      const result = await c.classify(evidence);
      if (result !== undefined) {
        return result;
      }
    }

    // Should never reach here since DefaultClassifier always returns
    return { state: "failed", failure_class: "task_failure", confidence: "high" };
  }
}

/**
 * Convenience function: classify run outcome using the default pipeline.
 */
export async function classifyRunOutcome(evidence: ExitEvidence): Promise<RunOutcome> {
  const pipeline = new ClassifierPipeline();
  return pipeline.classify(evidence);
}
