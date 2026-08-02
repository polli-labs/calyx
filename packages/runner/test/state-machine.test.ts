import { describe, expect, test } from "vitest";
import {
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  SUCCESSFUL_STATES,
  ALL_STATES,
  isValidTransition,
  assertTransition,
  isTerminal,
  isSuccessful,
  InvalidTransitionError,
} from "@polli-labs/calyx-runner";
import type { RunState } from "@polli-labs/calyx-runner";

// ── Terminal state invariants ───────────────────────────────────────

describe("TERMINAL_STATES", () => {
  const expected: RunState[] = [
    "succeeded", "failed", "partial", "cancelled",
    "auth_error", "infra_error", "completed_dirty",
  ];

  test("contains exactly 7 terminal states", () => {
    expect(TERMINAL_STATES.size).toBe(7);
  });

  test.each(expected)("%s is terminal", (state) => {
    expect(TERMINAL_STATES.has(state)).toBe(true);
  });

  test("queued is not terminal", () => {
    expect(TERMINAL_STATES.has("queued")).toBe(false);
  });

  test("dispatching is not terminal", () => {
    expect(TERMINAL_STATES.has("dispatching")).toBe(false);
  });

  test("running is not terminal", () => {
    expect(TERMINAL_STATES.has("running")).toBe(false);
  });
});

// ── Transition map invariants ───────────────────────────────────────

describe("VALID_TRANSITIONS", () => {
  test("covers all 10 states", () => {
    expect(Object.keys(VALID_TRANSITIONS)).toHaveLength(10);
  });

  test("every non-terminal state has >= 1 outgoing transition", () => {
    for (const state of ALL_STATES) {
      if (!TERMINAL_STATES.has(state)) {
        expect(
          VALID_TRANSITIONS[state].size,
          `${state} should have outgoing transitions`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("every terminal state has 0 outgoing transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(
        VALID_TRANSITIONS[state].size,
        `${state} should have no outgoing transitions`,
      ).toBe(0);
    }
  });

  test("no self-transitions", () => {
    for (const state of ALL_STATES) {
      expect(
        VALID_TRANSITIONS[state].has(state),
        `${state} → ${state} should not be allowed`,
      ).toBe(false);
    }
  });
});

// ── Specific valid transitions ──────────────────────────────────────

describe("valid transitions", () => {
  const validPaths: [RunState, RunState][] = [
    ["queued", "dispatching"],
    ["queued", "cancelled"],
    ["dispatching", "running"],
    ["dispatching", "cancelled"],
    ["dispatching", "auth_error"],
    ["dispatching", "infra_error"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "partial"],
    ["running", "cancelled"],
    ["running", "auth_error"],
    ["running", "infra_error"],
    ["running", "completed_dirty"],
  ];

  test.each(validPaths)("%s → %s is valid", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });
});

// ── Invalid transitions ─────────────────────────────────────────────

describe("invalid transitions", () => {
  const invalidPaths: [RunState, RunState][] = [
    // Skip states
    ["queued", "running"],
    ["queued", "succeeded"],
    ["queued", "failed"],
    // Backward transitions
    ["dispatching", "queued"],
    ["running", "queued"],
    ["running", "dispatching"],
    // Terminal → anything
    ["succeeded", "running"],
    ["succeeded", "failed"],
    ["failed", "running"],
    ["failed", "queued"],
    ["cancelled", "queued"],
    ["auth_error", "running"],
    ["infra_error", "queued"],
    ["completed_dirty", "running"],
    ["partial", "running"],
    ["partial", "queued"],
    // dispatching → succeeded/failed directly
    ["dispatching", "succeeded"],
    ["dispatching", "failed"],
    ["dispatching", "completed_dirty"],
  ];

  test.each(invalidPaths)("%s → %s is invalid", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});

// ── assertTransition ────────────────────────────────────────────────

describe("assertTransition", () => {
  test("does not throw for valid transition", () => {
    expect(() => assertTransition("queued", "dispatching")).not.toThrow();
  });

  test("throws InvalidTransitionError for invalid transition", () => {
    expect(() => assertTransition("queued", "succeeded")).toThrow(InvalidTransitionError);
  });

  test("error contains from/to state", () => {
    try {
      assertTransition("succeeded", "running");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe("succeeded");
      expect(err.to).toBe("running");
      expect(err.message).toContain("succeeded");
      expect(err.message).toContain("running");
    }
  });
});

// ── isTerminal ──────────────────────────────────────────────────────

describe("isTerminal", () => {
  test.each(["succeeded", "failed", "partial", "cancelled", "auth_error", "infra_error", "completed_dirty"] as RunState[])(
    "%s is terminal",
    (state) => {
      expect(isTerminal(state)).toBe(true);
    },
  );

  test.each(["queued", "dispatching", "running"] as RunState[])(
    "%s is not terminal",
    (state) => {
      expect(isTerminal(state)).toBe(false);
    },
  );
});

describe("isSuccessful", () => {
  test("publishes the two successful terminal outcomes", () => {
    expect([...SUCCESSFUL_STATES]).toEqual(["succeeded", "completed_dirty"]);
  });

  test.each(["succeeded", "completed_dirty"] as RunState[])(
    "%s is successful",
    (state) => {
      expect(isSuccessful(state)).toBe(true);
    },
  );

  test.each([
    "queued",
    "dispatching",
    "running",
    "failed",
    "partial",
    "cancelled",
    "auth_error",
    "infra_error",
  ] as RunState[])("%s is not successful", (state) => {
    expect(isSuccessful(state)).toBe(false);
  });
});

// ── Full path reachability ──────────────────────────────────────────

describe("reachability", () => {
  test("every terminal state is reachable from queued", () => {
    // BFS from queued
    const visited = new Set<RunState>();
    const queue: RunState[] = ["queued"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of VALID_TRANSITIONS[current]) {
        queue.push(next);
      }
    }
    for (const terminal of TERMINAL_STATES) {
      expect(visited.has(terminal), `${terminal} should be reachable from queued`).toBe(true);
    }
  });

  test("happy path: queued → dispatching → running → succeeded", () => {
    expect(isValidTransition("queued", "dispatching")).toBe(true);
    expect(isValidTransition("dispatching", "running")).toBe(true);
    expect(isValidTransition("running", "succeeded")).toBe(true);
  });
});
