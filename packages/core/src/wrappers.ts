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

  // Implemented (POL-679 — canonical command surfaces, 2026-03-03)
  { wrapper: "agents-toolkit-doctor", target: "calyx doctor", status: "implemented", phase: "P7A-4" },
  { wrapper: "agents-tools-bump", target: "calyx tools versions bump", status: "implemented", phase: "P7A-4" },
  { wrapper: "agent-notify", target: "calyx exec notify", status: "implemented", phase: "P7A-4" },
  { wrapper: "docstore", target: "calyx knowledge docstore", status: "implemented", phase: "P7A-4" },
  { wrapper: "agents-fleet-smoke", target: "calyx verify fleet", status: "implemented", phase: "P7A-4" },
  { wrapper: "agents-bundle-build", target: "calyx bundle build", status: "implemented", phase: "P7A-4" },
  { wrapper: "agent-mail", target: "calyx extensions agent-mail-status", status: "implemented", phase: "P7A-4" },
  { wrapper: "execplan-new", target: "calyx knowledge execplan new", status: "implemented", phase: "P7A-4" },
  { wrapper: "agents-bootstrap", target: "calyx install bootstrap", status: "implemented", phase: "P7A-4" },

  // Deprecated (POL-680 — explicit decision: not implementing in v1, 2026-03-03)
  {
    wrapper: "agents-fleet",
    target: "calyx skills sync, calyx tools sync, calyx prompts sync, calyx agents sync, calyx verify fleet",
    status: "deprecated",
    phase: "P4+",
    deprecatedAt: "2026-03-03",
    rationale: "Fleet convergence requires orchestrating 5+ domain commands with ordering, error rollback, and partial-failure semantics — out of v1 scope.",
    alternatives: [
      "calyx skills sync --registry <path> --apply",
      "calyx tools sync --registry <path> --all --apply",
      "calyx prompts sync --registry <path> --apply",
      "calyx agents sync --registry <path> --apply",
      "calyx agents deploy --registry <path> --apply",
      "calyx verify fleet"
    ],
    notes: "Sunset: 2026-06-01 — remove tombstone or promote to calyx fleet converge if operator demand warrants"
  },
  {
    wrapper: "agents-fleet-apply",
    target: "calyx skills sync --apply, calyx tools sync --apply, calyx prompts sync --apply, calyx agents sync --apply",
    status: "deprecated",
    phase: "P4+",
    deprecatedAt: "2026-03-03",
    rationale: "Convergent apply requires transaction semantics across domains — same architectural blockers as agents-fleet.",
    alternatives: [
      "calyx skills sync --registry <path> --apply",
      "calyx tools sync --registry <path> --all --apply",
      "calyx prompts sync --registry <path> --apply",
      "calyx agents sync --registry <path> --apply",
      "calyx agents deploy --registry <path> --apply",
      "calyx verify fleet --strict"
    ],
    notes: "Sunset: 2026-06-01 — remove tombstone or promote as --apply mode of calyx fleet converge"
  },
  {
    wrapper: "agents-worktree-init",
    target: "agents-worktree-init shell script or manual git worktree add",
    status: "deprecated",
    phase: "post-v1",
    deprecatedAt: "2026-03-03",
    rationale: "No workspace domain exists in calyx; the existing shell script is simple, stable, and sufficient.",
    alternatives: [
      "agents-worktree-init (shell script in ~/.agents/run/)",
      "git worktree add ~/projects/$(date +%Y-W%V)/<lane>/<branch> -b <branch>"
    ],
    notes: "Sunset: 2026-08-01 — remove tombstone if no demand; revisit if calyx adds a workspace domain"
  }
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
 * Build a clear, actionable error message for a deprecated wrapper (POL-680).
 *
 * Deprecated wrappers are those where an explicit decision was made not to
 * implement them in v1. The message includes rationale, canonical alternatives,
 * and the defer horizon for revisiting the decision.
 */
export function getDeprecatedWrapperMessage(wrapper: string): string {
  const def = WRAPPER_REGISTRY.find((d) => d.wrapper === wrapper && d.status === "deprecated");
  if (!def) {
    return `[calyx][error] Unknown wrapper "${wrapper}".`;
  }
  const lines: string[] = [
    `[calyx][deprecated] "${wrapper}" will not be implemented in v1 (deprecated ${def.deprecatedAt ?? "unknown"}).`
  ];
  if (def.rationale) {
    lines.push(`  Rationale: ${def.rationale}`);
  }
  if (def.alternatives && def.alternatives.length > 0) {
    lines.push("  Use instead:");
    for (const alt of def.alternatives) {
      lines.push(`    - ${alt}`);
    }
  }
  if (def.notes) {
    lines.push(`  ${def.notes}`);
  }
  return lines.join("\n");
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
