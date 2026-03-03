# POL-687 Receipts: P10C Extension Compatibility Policy + Harness-Target Seed

**Date:** 2026-03-03
**Branch:** `pol-687-p10c-compat-policy-seed-r1`
**Base commit:** `6328efb`

## Deliverables

### 1. Compatibility Policy + Version Matrix

**Files changed:**
- `docs/extension-sdk.md` — Added "Compatibility Policy" section with:
  - API Version Matrix table (current: `"1"`)
  - Semver expectations for SDK, extension packages, and apiVersion
  - Extension package semver guidance
  - Migration path when apiVersion advances
  - Unsupported/deprecated behavior table with diagnostic codes

### 2. Conflict Governance Hardening

**Files changed:**
- `packages/core/src/extensions.ts` — Enhanced `DOMAIN_CONFLICT` diagnostic messages with:
  - Advisory mode: actionable guidance mentioning `--strict` flag
  - Strict mode: actionable guidance to remove or reconfigure conflicting extensions
- `packages/core/src/__tests__/extensions.test.ts` — Added 4 new tests:
  - Advisory mode produces warning-severity conflict diagnostics
  - Strict mode produces error-severity conflict diagnostics
  - Conflict diagnostics list all claiming extension names
  - No conflicts reported for domains with single owner
- `docs/extension-sdk.md` — Added "Conflict Governance" section with:
  - Advisory vs strict mode behavior table
  - Conflict resolution strategies
  - Deterministic ordering documentation
- `docs/operator-runbook.md` — Added "Conflict resolution" section with operator guidance

### 3. Harness-Target Extension Seed (`calyx-ext-cursor`)

**Files created:**
- `packages/calyx-ext-cursor/package.json` — Manifest targeting config, instructions, skills
- `packages/calyx-ext-cursor/src/index.ts` — Non-destructive hooks with:
  - Environment detection (CURSOR_SESSION_ID, CURSOR_WORKSPACE)
  - Command hints for config compile, instructions render, skills sync
  - Failure diagnostics with Cursor-specific troubleshooting
  - Rules file awareness (.cursor/rules, .cursorrules)
- `packages/calyx-ext-cursor/src/__tests__/cursor-ext.test.ts` — 17 tests:
  - Manifest validation (4 tests)
  - Hook behavior (7 tests)
  - Non-destructive guarantee (1 test)
  - ExtensionRunner integration (4 tests)
  - Runner count (1 test)
- `packages/calyx-ext-cursor/tsconfig.json`

**Files updated:**
- `tsconfig.json` — Added calyx-ext-linear and calyx-ext-cursor to references
- `docs/extension-sdk.md` — Added calyx-ext-cursor description and harness-target extensions section
- `docs/operator-runbook.md` — Added cursor to extension table and harness-target smoke test guide

### 4. Docs + Runbook Updates

- `docs/extension-sdk.md` — Comprehensive compatibility policy, conflict governance, harness-target extensions
- `docs/operator-runbook.md` — Updated extension table, conflict resolution, compatibility, harness-target testing

## Verification

### pnpm verify

```
✓ lint (eslint)
✓ typecheck (7 packages including calyx-ext-cursor)
✓ test (15 test files, 232 tests passed — up from 215)
✓ build (all 7 packages built successfully)
```

### Smoke tests

```bash
# Extension discovery — all 3 extensions discovered
CALYX_EXTENSIONS_PATH=packages calyx extensions list
# Output: calyx-ext-cursor, calyx-ext-linear, calyx-ext-polli — 3 extensions

# Strict mode validation — correctly reports conflicts as errors
CALYX_EXTENSIONS_PATH=packages calyx extensions validate --strict
# Exit 3: DOMAIN_CONFLICT errors with actionable guidance

# Hook invocation — config compile with extensions
CALYX_EXTENSIONS_PATH=packages calyx config compile --fleet ... --host blade --parity ...
# Exit 0: Semantic parity OK with extension hooks running
```

### Test count delta

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Test files | 14 | 15 | +1 |
| Total tests | 215 | 232 | +17 |
| Conflict governance tests | 1 | 5 | +4 |
| Cursor extension tests | 0 | 17 | +17 |

## Acceptance Criteria

- [x] Compatibility matrix + policy published and test-backed
- [x] Conflict governance deterministic in advisory and strict modes
- [x] Harness-target extension seed package shipped with tests/docs
- [x] `pnpm verify` passes
- [ ] Dev PR merged (pending)
- [ ] Linear receipts posted (pending)
