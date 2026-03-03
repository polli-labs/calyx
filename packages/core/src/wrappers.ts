import type {
  WrapperDefinition,
  WrapperDeprecationPhase,
  WrapperGuardrailResult,
  WrapperTelemetryEvent
} from "./types";

// ── Canonical wrapper registry ──────────────────────────────────────
// Single source of truth for all wrapper definitions — retired,
// deferred, and (historically) implemented. Tests, CLI, and docs all
// derive from this constant.

export const WRAPPER_REGISTRY: WrapperDefinition[] = [
  // Retired (P9 — removed from CLI, 2026-03-02)
  { wrapper: "skills-sync", target: "calyx skills sync", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "skills-sync-claude", target: "calyx skills sync --backend claude", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "skills-sync-codex", target: "calyx skills sync --backend codex", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "prompts-sync-claude", target: "calyx prompts sync --backend claude", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "prompts-sync-codex", target: "calyx prompts sync --backend codex", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "agents-render", target: "calyx instructions render", status: "retired", phase: "P9", retiredAt: "2026-03-02" },
  { wrapper: "exec-launch", target: "calyx exec launch", status: "retired", phase: "P9", retiredAt: "2026-03-02" },

  // Deferred — tombstone commands emit a clear error with sunset info
  { wrapper: "agents-fleet", target: "calyx (domain commands)", status: "deferred", phase: "P2-P4", notes: "Split across domain commands; sunset: design fleet convergence meta-command by 2026-06-01 or confirm non-goal" },
  { wrapper: "agents-fleet-apply", target: "calyx (convergent domain applies)", status: "deferred", phase: "P2-P4", notes: "Decompose by subsystem; sunset: design calyx fleet apply by 2026-06-01 or confirm non-goal" },
  { wrapper: "agents-fleet-smoke", target: "calyx verify fleet", status: "deferred", phase: "P4+", notes: "Fold into verification matrix; sunset: 2026-06-01 — remove tombstone if no progress" },
  { wrapper: "agents-toolkit-doctor", target: "calyx doctor", status: "deferred", phase: "P3+", notes: "Health check surface; sunset: 2026-06-01 — remove tombstone if no progress" },
  { wrapper: "agents-bundle-build", target: "calyx bundle build", status: "deferred", phase: "P4+", notes: "Bundle schema required; sunset: 2026-07-01 — depends on extension ecosystem" },
  { wrapper: "agents-tools-bump", target: "calyx tools versions bump", status: "deferred", phase: "P3+", notes: "Atomic version updates; sunset: 2026-06-01 — remove tombstone if no progress" },
  { wrapper: "agent-notify", target: "calyx exec notify", status: "deferred", phase: "P3+", notes: "Keep Python backend initially; sunset: 2026-07-01 — evaluate exec extension model" },
  { wrapper: "agent-mail", target: "calyx ext agent-mail", status: "deferred", phase: "P4+", notes: "Extension package, not core; sunset: 2026-07-01 — depends on extension registry" },
  { wrapper: "docstore", target: "calyx knowledge * + adapter", status: "deferred", phase: "P3+", notes: "Backend retained; sunset: 2026-07-01 — depends on knowledge domain B2 adapter" },
  { wrapper: "execplan-new", target: "calyx knowledge execplan new", status: "deferred", phase: "P4+", notes: "Depends on knowledge UX; sunset: 2026-07-01 — remove tombstone if knowledge UX not progressed" },
  { wrapper: "agents-bootstrap", target: "calyx install bootstrap", status: "deferred", phase: "P4+", notes: "After core stabilizes; sunset: 2026-08-01 — low priority, remove tombstone if no demand" },
  { wrapper: "agents-worktree-init", target: "calyx workspace init", status: "deferred", phase: "post-v1", notes: "Low core leverage; sunset: 2026-08-01 — remove tombstone if no demand" }
];

// ── Guardrail helpers ───────────────────────────────────────────────

const ENV_FAIL_ON_DEPRECATED = "CALYX_FAIL_ON_DEPRECATED";

/**
 * Read the deprecation phase from the environment.
 *
 * - `CALYX_FAIL_ON_DEPRECATED=1` → phase "error" (wrappers exit non-zero)
 * - Otherwise → phase "warn" (emit warning, continue)
 *
 * There is no "active" runtime state — once a wrapper exists it is always
 * deprecated. "active" is reserved for future phase transitions in the
 * registry.
 */
export function getWrapperDeprecationPhase(): WrapperDeprecationPhase {
  const envValue = process.env[ENV_FAIL_ON_DEPRECATED];
  if (envValue === "1" || envValue === "true") {
    return "error";
  }
  return "warn";
}

/**
 * Check whether a wrapper invocation is allowed under current guardrails.
 *
 * In "error" phase (CALYX_FAIL_ON_DEPRECATED=1), the wrapper is blocked
 * and the caller should exit with a non-zero code.
 */
export function checkWrapperGuardrail(wrapper: string, target: string): WrapperGuardrailResult {
  const phase = getWrapperDeprecationPhase();
  if (phase === "error") {
    return {
      allowed: false,
      phase,
      message: `[calyx][error] Wrapper "${wrapper}" is blocked by CALYX_FAIL_ON_DEPRECATED. Use "${target}" instead.`
    };
  }
  return { allowed: true, phase };
}

/**
 * Build a clear error message for a deferred (not-yet-implemented) wrapper.
 */
export function getDeferredWrapperMessage(wrapper: string): string {
  const def = WRAPPER_REGISTRY.find((d) => d.wrapper === wrapper && d.status === "deferred");
  if (!def) {
    return `[calyx][error] Unknown wrapper "${wrapper}".`;
  }
  const notes = def.notes ? ` (${def.notes})` : "";
  return `[calyx][error] "${wrapper}" is not yet implemented (deferred to ${def.phase})${notes}. Target: ${def.target}`;
}

/**
 * Build a clear error message for a retired wrapper that was removed in P9.
 */
export function getRetiredWrapperMessage(wrapper: string): string {
  const def = WRAPPER_REGISTRY.find((d) => d.wrapper === wrapper && d.status === "retired");
  if (!def) {
    return `[calyx][error] Unknown wrapper "${wrapper}".`;
  }
  return `[calyx][error] "${wrapper}" was removed in ${def.phase} (${def.retiredAt ?? "unknown date"}). Use "${def.target}" instead.`;
}

/**
 * Emit wrapper telemetry and deprecation warning to stderr.
 *
 * Returns the structured telemetry event. In "error" phase, the warning
 * is still emitted (for log capture) before the caller exits.
 */
export function emitWrapperTelemetry(wrapper: string, target: string): WrapperTelemetryEvent {
  const phase = getWrapperDeprecationPhase();
  const event: WrapperTelemetryEvent = {
    event: "calyx.wrapper.invoked",
    wrapper,
    target,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    deprecation_phase: phase
  };

  console.error(`[calyx][deprecated] ${wrapper} is a compatibility wrapper. Use "${target}".`);
  console.error(`[calyx][telemetry] ${JSON.stringify(event)}`);
  return event;
}
