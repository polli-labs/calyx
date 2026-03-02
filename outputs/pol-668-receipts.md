# POL-668 Receipts: Skills Subsumption Catalogue v1

**Issue:** POL-668
**Date:** 2026-03-02
**Branch:** `pol-668-skills-subsumption-v1-r1`

## Verification receipts

### pnpm install --frozen-lockfile
- **Status:** Pass
- **Packages:** 187 reused, 0 downloaded
- **Warning:** Node.js version advisory (wanted >=22, have v20.19.4) — non-blocking

### pnpm verify (lint → typecheck → test → build)
- **Status:** Pass
- **Test results:** 9 test files, 126 tests passed, 0 failed
- **New tests added:** 4 tests in `skills subsumption catalogue completeness` describe block
- **Build:** All 4 packages built successfully (core, cli, sdk, web)

## Deliverables

### New files
| File | Purpose |
|------|---------|
| `docs/skills-subsumption-catalogue.md` | Canonical v1 subsumption catalogue with disposition matrix, migration examples, gap list, and retirement sequencing |
| `outputs/pol-668-baseline.md` | Pre-work baseline inventory of 53 skills/surfaces |
| `outputs/pol-668-receipts.md` | This file |

### Modified files
| File | Change |
|------|--------|
| `README.md` | Added Skills Subsumption Catalogue to docs table |
| `docs/migration-guide.md` | Added Skills subsumption section with catalogue cross-reference |
| `docs/operator-runbook.md` | Added catalogue to Related documents section |
| `packages/core/src/__tests__/docs-coherence.test.ts` | Added catalogue link to README link test; added 4 catalogue coherence tests |

## Catalogue summary

| Disposition | Count |
|-------------|-------|
| `subsumed` | 7 |
| `partially_subsumed` | 4 |
| `defer_phase` | 7 |
| `not_planned` | 27 |
| Already deprecated | 8 |
| **Total inventoried** | **53** |

### Unresolved gaps: 8
All gaps have explicit issue linkage (POL-665) or clear phase assignment.

### Retirement phases defined: 4
- Phase 7 (current): Wrappers deprecated, catalogue published
- Phase 8: Production wiring, fleet convergence, knowledge adapter
- Phase 9: Wrapper removal, ExecPlan authoring UX
- Post-v1: Low-priority surfaces (workspace init, bundle build, bootstrap)

## Acceptance checklist

| Requirement | Status |
|-------------|--------|
| Coverage of all high-frequency active skills | Done (53 skills inventoried) |
| Explicit disposition field for each row | Done (subsumed / partially_subsumed / defer_phase / not_planned) |
| Explicit replacement surface or `none` rationale | Done |
| Explicit retirement phase tag and owner | Done |
| Explicit issue linkage for unresolved/deferred rows | Done (POL-665 for all P8 gaps) |
| Discoverable from README | Done (docs table entry) |
| Discoverable from migration guide | Done (Skills subsumption section) |
| Discoverable from operator runbook | Done (Related documents) |
| Docs coherence tests pass | Done (4 new tests, 126 total passing) |
| `pnpm verify` passes | Done |

## Blocker resolution

| Issue | Action |
|-------|--------|
| POL-673 (onboarding docs) | Unblocked — catalogue provides the skill-by-skill mapping needed for migration notes and CLI/API surface map |
| POL-665 (production wiring) | Updated — catalogue provides explicit dependency map for P8 adapter work |
| POL-664 (P7B GA bridge) | Progress note — POL-668 child lane completing |
| POL-605 (umbrella) | Progress note — subsumption mapping adds to operational readiness |
