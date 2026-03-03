# POL-680 Receipts

## Date: 2026-03-03
## Branch: pol-680-wrapper-decision-r1

## Decision Summary

All 3 POL-680 wrappers received an explicit **deprecate-in-place** decision:

| Wrapper | Decision | Status | Sunset |
|---|---|---|---|
| `agents-fleet` | deprecate-in-place | `deprecated` | 2026-06-01 |
| `agents-fleet-apply` | deprecate-in-place | `deprecated` | 2026-06-01 |
| `agents-worktree-init` | deprecate-in-place | `deprecated` | 2026-08-01 |

## Changed Files

### Core types + registry
- `packages/core/src/types.ts` — Added `"deprecated"` to `WrapperStatus`; added `deprecatedAt`, `rationale`, `alternatives` fields to `WrapperDefinition`
- `packages/core/src/wrappers.ts` — Changed 3 wrappers from `deferred` to `deprecated` with full metadata; added `getDeprecatedWrapperMessage()` function
- `packages/core/src/index.ts` — Exported `getDeprecatedWrapperMessage`

### CLI
- `packages/cli/src/run-cli.ts` — Imported `getDeprecatedWrapperMessage`; added deprecated wrapper loop before deferred loop
- `packages/cli/src/calyx-core.d.ts` — Updated ambient module declaration with `"deprecated"` status, new fields, and new function

### Tests
- `packages/core/src/__tests__/wrappers.test.ts` — Replaced deferred tests with deprecated tests; updated registry count expectations (3 deprecated, 0 deferred); added metadata completeness assertions
- `packages/core/src/__tests__/docs-coherence.test.ts` — Updated expected section from `## Deferred` to `## Deprecated`

### Docs
- `docs/migration-wrappers.md` — Replaced "Deferred" section with "Deprecated (POL-680)" section; updated tombstone example; updated exit code description
- `docs/cli-reference.md` — Updated exit code 5 description

### Artifacts
- `outputs/pol-680-baseline.md` — Baseline inventory
- `outputs/pol-680-decision.md` — Per-wrapper decision rationale
- `outputs/pol-680-receipts.md` — This file

## Verification

```
pnpm install --frozen-lockfile  ✅
pnpm verify (lint → typecheck → test → build)  ✅
  17 test files, 286 tests passed
```

## Acceptance Criteria Check

- [x] Every POL-680 wrapper has an explicit decision (`deprecated`) in code and docs
- [x] Deprecated wrappers provide clear actionable alternatives and defer horizon guidance
- [x] No wrapper marked `implemented` (all 3 are deprecated as designed)
- [x] Tests and `pnpm verify` pass (286/286)
- [x] Linear POL-680 receipts posted
