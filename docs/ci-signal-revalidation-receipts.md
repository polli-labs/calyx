# CI Signal Revalidation Receipts

Tracking issue: POL-642
Parent umbrella: POL-605
Date: 2026-02-28
Operator: async-runner (POL-642 P6C lane)

## Baseline

- Prior merge: `e1031d5` — P6B CI reliability governance + promotion hardening (PR #9)
- Local `pnpm verify`: PASS (103 tests, lint, typecheck, build — all green on `e1031d5`)
- Node version: v22.22.0 (matching CI target)

## Revalidation — calyx-dev (private)

| Run ID | Workflow | Commit | Attempt | Status | Steps | Duration | Runner |
|---|---|---|---|---|---|---|---|
| [22510067771](https://github.com/polli-labs/calyx-dev/actions/runs/22510067771) | ci | `e1031d5` | 1 | failure | 0 | 2s | none |
| [22510067771](https://github.com/polli-labs/calyx-dev/actions/runs/22510067771) | ci | `e1031d5` | 2 | failure | 0 | 2s | none |
| [22510067611](https://github.com/polli-labs/calyx-dev/actions/runs/22510067611) | CodeQL | `e1031d5` | 1 | failure | 0 | 2s | none |
| [22509847409](https://github.com/polli-labs/calyx-dev/actions/runs/22509847409) | ci | `bb0eb69` | 1 | failure | 0 | 3s | none |
| [22509847279](https://github.com/polli-labs/calyx-dev/actions/runs/22509847279) | CodeQL | `bb0eb69` | 1 | failure | 0 | 5s | none |
| [22509588122](https://github.com/polli-labs/calyx-dev/actions/runs/22509588122) | ci | `ac1b887` | 1 | failure | 0 | 2s | none |
| [22509587969](https://github.com/polli-labs/calyx-dev/actions/runs/22509587969) | CodeQL | `ac1b887` | 1 | failure | 0 | 4s | none |

**Classification: Billing / plan outage**

Evidence:
- All runs complete in 2-3 seconds with zero executed steps and no runner assignment.
- Failure pattern is identical across all commits on main (P3B through P6B).
- The same commit (`ac1b887`) passes CI on calyx (public repo) — confirming code is not the issue.
- Local `pnpm verify` passes on all commits.
- Public repos receive unlimited GitHub Actions minutes; private repos are subject to org billing limits.

## Revalidation — calyx (public)

| Run ID | Workflow | Commit | Status | Steps | Duration |
|---|---|---|---|---|---|
| [22510215562](https://github.com/polli-labs/calyx/actions/runs/22510215562) | ci | `e1031d5` | success | 10 | 24s |
| [22510215469](https://github.com/polli-labs/calyx/actions/runs/22510215469) | CodeQL | `e1031d5` | success | 11 | 39s |
| [22510216838](https://github.com/polli-labs/calyx/actions/runs/22510216838) | release | `v0.1.0-rc.1` | partial | ci: pass, publish: fail (ENEEDAUTH) | 28s + 19s |
| [22509760052](https://github.com/polli-labs/calyx/actions/runs/22509760052) | ci | `ac1b887` | success | 13 | 28s |
| [22509760718](https://github.com/polli-labs/calyx/actions/runs/22509760718) | CodeQL | `ac1b887` | success | 11 | 39s |

**CI signal: GREEN** — All verification gates pass on the public repo for both `ac1b887` (P5) and `e1031d5` (P6B).

**Release publish failure**: The `release.yml` publish step failed with `ENEEDAUTH` — the calyx (public) repo does not have the `NPM_TOKEN` secret configured. This is an infrastructure setup dependency, not a product defect. The CI gate (`pnpm verify`) within the release workflow passed.

## Promotion Parity

| Check | Result |
|---|---|
| `origin/main` SHA | `e1031d514d360364ebadb86458880eb0a9f7a572` |
| `public/main` SHA | `e1031d514d360364ebadb86458880eb0a9f7a572` |
| Parity | **MATCH** (restored during this session) |
| RC tag `v0.1.0-rc.1` on origin | `ac1b887` (P5 commit) |
| RC tag `v0.1.0-rc.1` on public | `ac1b887` (P5 commit) — pushed during this session |

Prior state: `public/main` was 2 commits behind (`ac1b887` vs `e1031d5`), missing P6A and P6B. RC tag was absent from public.

Action taken: Synced `public/main` to `e1031d5` and pushed `v0.1.0-rc.1` tag to public, per the steady-state promotion process in [RC Checklist](rc-checklist.md).

## External Dependencies

### 1. GitHub Actions billing on calyx-dev (private)

- **Owner**: GitHub org admin (polli-labs)
- **Required action**: Increase Actions spending limit or upgrade plan to restore CI on private repos.
- **Impact**: All CI workflows on calyx-dev are non-functional. Merges can proceed under the override protocol documented in [CI Reliability Runbook](ci-reliability-runbook.md), but automated CI signal is unavailable for the private repo.
- **Workaround**: CI signal is fully available on calyx (public). Local `pnpm verify` provides equivalent product-level verification.
- **Retry window**: Re-run calyx-dev CI after billing limit is adjusted. Use `gh run rerun <run-id> --repo polli-labs/calyx-dev`.

### 2. NPM_TOKEN secret on calyx (public)

- **Owner**: GitHub org admin (polli-labs)
- **Required action**: Add `NPM_TOKEN` repository secret to the calyx (public) repo for npm publish access.
- **Impact**: Release workflow cannot publish packages to npm from the public repo.
- **Workaround**: Publish from calyx-dev if NPM_TOKEN is configured there, or publish manually.

## Summary

| Dimension | Status |
|---|---|
| Product quality (pnpm verify) | **GREEN** — local + public CI |
| calyx-dev CI signal | **BLOCKED** — billing/plan outage (not a product issue) |
| calyx CI signal | **GREEN** — ci + CodeQL pass on `e1031d5` |
| calyx release pipeline | **PARTIAL** — CI gate green, publish blocked by missing NPM_TOKEN |
| Promotion parity | **RESTORED** — both repos at `e1031d5`, RC tag on both |
| External blockers | 2 items: billing limit (calyx-dev), NPM_TOKEN (calyx publish) |

## Required Next Actions

1. **Billing**: Org admin adjusts GitHub Actions spending limit for private repos → re-run calyx-dev CI.
2. **NPM_TOKEN**: Org admin adds NPM_TOKEN secret to calyx (public) repo → re-run release workflow or cut new tag.
3. **GA readiness**: Once both external blockers are resolved, proceed to GA release preparation (version bump, CHANGELOG, `v0.1.0` tag).

## Related Documents

- [CI Reliability Runbook](ci-reliability-runbook.md) — failure taxonomy, override protocol
- [RC Checklist](rc-checklist.md) — release process, promotion paths
