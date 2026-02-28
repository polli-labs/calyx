# P6A CI/Release Evaluation

**Issue:** POL-640
**Date:** 2026-02-28
**Repo:** `polli-labs/calyx`

## CI Runs After Promotion

| Workflow | Run ID | URL | Status | Classification |
|----------|--------|-----|--------|---------------|
| `ci` | 22509760052 | [link](https://github.com/polli-labs/calyx/actions/runs/22509760052) | success | Product |
| `CodeQL Setup` | 22509760718 | [link](https://github.com/polli-labs/calyx/actions/runs/22509760718) | success | Infra |

**Result: All workflows passed.**

## Local Verification (calyx-dev)

| Gate | Status | Notes |
|------|--------|-------|
| `pnpm build` | Pass | 4 packages (core, sdk, web, cli) |
| `pnpm lint` | Pass | eslint clean |
| `pnpm typecheck` | Pass | tsc --noEmit across 4 packages |
| `pnpm test` | Pass | 103/103 tests (9 suites) |

### Advisory Notes

- Node engine warning: host runs v20.19.4, repo requires >=22.0.0. All gates pass regardless; upgrade blade node version when convenient.
- Parity test snapshots emit advisory stderr for format drift (blade, carbon, worm, mba). Semantic parity passes — format-only; not a blocker.

## Failure Classification

No failures to classify. All product and infra workflows green.

## Blockers

None identified. The public repo CI is fully operational on first push.
