/**
 * @polli-labs/calyx-runner — Lifecycle state machine.
 *
 * Defines valid state transitions for the 9-state runner lifecycle
 * and provides validation helpers.
 *
 * Invariants:
 * - Every non-terminal state has >= 1 outgoing transition.
 * - Every terminal state has 0 outgoing transitions.
 * - Transitions are monotonic (no backward edges).
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type { RunState } from "./types.js";

/** Canonical ordered list of every valid RunState value. */
export const ALL_STATES = [
  "queued",
  "dispatching",
  "running",
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "auth_error",
  "infra_error",
  "completed_dirty",
] as const satisfies readonly RunState[];

/** Terminal states — no outgoing transitions allowed. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "auth_error",
  "infra_error",
  "completed_dirty",
]);

/** Terminal states that represent a successful workload outcome. */
export const SUCCESSFUL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded",
  "completed_dirty",
]);

/** Complete transition map: state → set of allowed next states. */
export const VALID_TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  queued: new Set(["dispatching", "cancelled"]),
  dispatching: new Set(["running", "cancelled", "auth_error", "infra_error"]),
  running: new Set([
    "succeeded",
    "failed",
    "partial",
    "cancelled",
    "auth_error",
    "infra_error",
    "completed_dirty",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  partial: new Set(),
  cancelled: new Set(),
  auth_error: new Set(),
  infra_error: new Set(),
  completed_dirty: new Set(),
};

/** Check whether a transition from `from` to `to` is valid. */
export function isValidTransition(from: RunState, to: RunState): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Thrown when an invalid state transition is attempted. */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: RunState,
    public readonly to: RunState,
  ) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Assert that a transition is valid; throws InvalidTransitionError otherwise. */
export function assertTransition(from: RunState, to: RunState): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Check whether a state is terminal (no further transitions possible). */
export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Check whether a terminal state represents a successful workload outcome. */
export function isSuccessful(state: RunState): boolean {
  return SUCCESSFUL_STATES.has(state);
}
