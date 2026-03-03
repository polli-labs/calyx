# POL-680 Decision: Per-Wrapper Disposition

## Date: 2026-03-03

## Decision Policy Applied

> If safe, coherent canonical delegation exists and is low-risk to add now → implement.
> Otherwise → deprecate in place with rationale, alternatives, phase hint, and revisit triggers.

---

## 1. `agents-fleet` → **deprecate-in-place**

**Rationale:** `agents-fleet` was a meta-command that converged multiple domain syncs (skills, tools, prompts, agents, instructions) in a single invocation. No single canonical calyx command subsumes this — it would require orchestrating 5+ domain commands. Building fleet convergence is explicitly out of v1 scope (POL-680 constraint) and is architecturally complex (ordering, error rollback, partial failure semantics).

**Canonical alternatives (run these now):**
- `calyx skills sync --registry <path> --apply`
- `calyx tools sync --registry <path> --all --apply`
- `calyx prompts sync --registry <path> --apply`
- `calyx agents sync --registry <path> --apply`
- `calyx agents deploy --registry <path> --apply`
- `calyx verify fleet` (post-sync validation)

**Defer horizon:** P4+ / post-v1
**Revisit trigger:** If operators routinely run 4+ domain syncs in sequence and request a single entry point, revisit as `calyx fleet converge` or similar. Sunset deadline: 2026-06-01 — remove tombstone or promote to real command.

---

## 2. `agents-fleet-apply` → **deprecate-in-place**

**Rationale:** `agents-fleet-apply` was the `--apply` variant of the fleet convergence meta-command. Same architectural blockers as `agents-fleet` — no safe single-command delegation target exists. The convergent apply pattern requires transaction semantics that calyx v1 does not provide.

**Canonical alternatives (run these now):**
- Same as `agents-fleet` above, with `--apply` flag on each domain command.
- `calyx verify fleet --strict` (post-apply validation)

**Defer horizon:** P4+ / post-v1
**Revisit trigger:** Same as `agents-fleet`. If fleet convergence is promoted, `fleet-apply` becomes its `--apply` mode. Sunset deadline: 2026-06-01.

---

## 3. `agents-worktree-init` → **deprecate-in-place**

**Rationale:** `agents-worktree-init` maps to a hypothetical `calyx workspace init` command. No `workspace` domain exists in calyx, and the existing shell script (`~/.agents/run/agents-worktree-init`) is simple, stable, and well-understood. Adding a workspace domain to calyx for a single wrapper is over-engineering. The shell script creates `~/projects/<YYYY-W##>/<lane>/<branch>` worktrees — a 10-line operation with no complex orchestration.

**Canonical alternatives (run these now):**
- `agents-worktree-init` shell script (unchanged, remains in `~/.agents/run/`)
- Manual: `git worktree add ~/projects/$(date +%Y-W%V)/<lane>/<branch> -b <branch>`

**Defer horizon:** post-v1
**Revisit trigger:** If calyx adds a `workspace` domain for broader workspace management (multi-repo, environment setup), `worktree-init` could become `calyx workspace init`. Sunset deadline: 2026-08-01.

---

## Implementation Summary

| Wrapper | Decision | New Status | Exit Code | Messaging |
|---|---|---|---|---|
| `agents-fleet` | deprecate-in-place | `deprecated` | 5 | Explicit alternatives + defer horizon |
| `agents-fleet-apply` | deprecate-in-place | `deprecated` | 5 | Explicit alternatives + defer horizon |
| `agents-worktree-init` | deprecate-in-place | `deprecated` | 5 | Explicit alternatives + defer horizon |

### Type System Changes

- Add `"deprecated"` to `WrapperStatus` — distinguishes "decided not to implement" from "not yet decided"
- Add `deprecatedAt` (ISO date), `alternatives` (string[]), and `rationale` (string) to `WrapperDefinition`
- Add `getDeprecatedWrapperMessage()` function with structured output
- Wire deprecated wrappers in CLI with enhanced messaging
