# POL-680 Baseline: Post-v1 Deferred Wrappers

## Captured: 2026-03-03

## Wrappers in Scope

| Wrapper | Current Status | Phase | Target | Notes |
|---|---|---|---|---|
| `agents-fleet` | deferred | P2-P4 | `calyx (domain commands)` | Split across domain commands; sunset: design fleet convergence meta-command by 2026-06-01 or confirm non-goal |
| `agents-fleet-apply` | deferred | P2-P4 | `calyx (convergent domain applies)` | Decompose by subsystem; sunset: design calyx fleet apply by 2026-06-01 or confirm non-goal |
| `agents-worktree-init` | deferred | post-v1 | `calyx workspace init` | Low core leverage; sunset: 2026-08-01 — remove tombstone if no demand |

## Current Runtime Behavior

All three wrappers are registered as **tombstone CLI commands** in `run-cli.ts`:
- Accept any flags (`allowUnknownOption`)
- Exit with code **5** (deferred wrapper invoked)
- Emit message via `getDeferredWrapperMessage()`:
  ```
  [calyx][error] "agents-fleet" is not yet implemented (deferred to P2-P4) (Split across domain commands; sunset: ...). Target: calyx (domain commands)
  ```

## Registry Snapshot

From `packages/core/src/wrappers.ts` lines 35–37:
```typescript
{ wrapper: "agents-fleet", target: "calyx (domain commands)", status: "deferred", phase: "P2-P4", notes: "..." },
{ wrapper: "agents-fleet-apply", target: "calyx (convergent domain applies)", status: "deferred", phase: "P2-P4", notes: "..." },
{ wrapper: "agents-worktree-init", target: "calyx workspace init", status: "deferred", phase: "post-v1", notes: "..." }
```

## Doc References

- `docs/migration-wrappers.md` §Deferred — lists all 3 with sunset dates
- `docs/cli-reference.md` §Exit Code Convention — code 5 = deferred wrapper invoked
- `README.md` §Migration status — mentions retired wrappers but not deferred specifically

## Type System

`WrapperStatus = "implemented" | "deferred" | "retired"` — no `deprecated` status exists.
`WrapperDefinition` has optional `notes` and `retiredAt` fields but no structured alternatives or rationale.

## Contradictions / Ambiguity

1. Status `"deferred"` conflates "not yet decided" with "decided not to implement now" — these are semantically different.
2. Messages say "not yet implemented" which implies it _will_ be implemented eventually, even when the real decision may be "non-goal."
3. No structured field for canonical alternatives — operators must parse free-text notes.
4. Test `"POL-680 scope remains deferred"` asserts the current state but doesn't capture a final decision.
