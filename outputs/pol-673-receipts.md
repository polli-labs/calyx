# POL-673 Receipts — P7B-2 Public Onboarding Docs

**Date:** 2026-03-02
**Branch:** `pol-673-p7b-onboarding-docs-r1`
**Calyx version:** 0.1.1

## Changes

### New files
- `docs/onboarding.md` — Adopter-facing onboarding guide covering install contract, first-run contract, surface map contract, migration contract, and extension contract.
- `outputs/pol-673-baseline.md` — Baseline audit of existing docs and identified onboarding gaps.
- `outputs/pol-673-quickstart-validation.md` — Command transcript validating all quickstart paths (7 commands, all exit 0).
- `outputs/pol-673-receipts.md` — This file.

### Modified files
- `README.md` — Added "Getting started" section with onboarding guide link; added onboarding guide to documentation table.
- `docs/migration-guide.md` — Added cross-link to onboarding guide in intro paragraph.
- `docs/operator-runbook.md` — Added cross-link to onboarding guide in intro paragraph.
- `packages/core/src/__tests__/docs-coherence.test.ts` — Added 3 new tests: onboarding sections, reference links, and 8-domain surface map coverage. Added `docs/onboarding.md` to README link completeness check.

## Onboarding Contract Coverage

| Contract | Section | Status |
|----------|---------|--------|
| Install contract | `## Install` (global, npx, source paths + verification) | COVERED |
| First-run contract | `## First commands` (validate, index, JSON output) | COVERED |
| Surface map contract | `## Command surface map` (25 subcommands, 8 domains) | COVERED |
| Migration contract | `## Migrating from legacy scripts` (4-phase path + links) | COVERED |
| Extension contract | `## Building extensions` (minimal example + SDK links) | COVERED |

## Verification Gate

```
$ pnpm verify
  lint        ✅ PASS
  typecheck   ✅ PASS (4 packages)
  test        ✅ PASS (129 tests, 9 test files)
  build       ✅ PASS (4 packages)
```

**Docs-coherence tests:** 24 tests (was 17 in prior baselines; +3 onboarding tests, +4 from prior POL-668/POL-674 additions).

### New test assertions (3)
1. `onboarding.md exists and has required sections` — 7 sections
2. `onboarding.md links to key reference docs` — 5 reference links
3. `onboarding.md covers all 8 domains in surface map` — 8 domains

## Quickstart Validation Summary

All 7 quickstart commands validated with exit code 0:
- `pnpm install && pnpm build`
- `calyx --help`
- `calyx skills --help`
- `calyx skills validate --strict` (fixture-backed)
- `calyx skills index` (human-readable)
- `calyx skills index --json` (machine-readable)
- `calyx tools index + validate` (cross-domain)

Full transcript: `outputs/pol-673-quickstart-validation.md`
