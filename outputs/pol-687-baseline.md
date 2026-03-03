# POL-687 Baseline: P10C Extension Compatibility Policy + Harness-Target Seed

**Captured:** 2026-03-03
**Branch:** `pol-687-p10c-compat-policy-seed-r1`
**Base commit:** `6328efb` (P10B merge)

## Current State

### Extension System

- **SDK API version:** `"1"` (constant `CALYX_SDK_API_VERSION` in `packages/sdk/src/index.ts`)
- **Domains:** 8 supported (`config`, `instructions`, `skills`, `tools`, `prompts`, `agents`, `knowledge`, `exec`)
- **Hooks:** 4 lifecycle hooks (`activate`, `beforeCommand`, `afterCommand`, `deactivate`) — all optional
- **Discovery:** Alphabetical order, last-write-wins shadowing across search paths
- **Conflict detection:** Domain overlap reported as warning (advisory) or error (strict mode)

### Shipped Extensions

| Extension | Version | Domains | Purpose |
|-----------|---------|---------|---------|
| `calyx-ext-polli` | 0.1.0 | skills, tools, agents | Pre-flight checks, env hints, failure summaries |
| `calyx-ext-linear` | 0.1.0 | agents, exec | Issue context hints, exec failure diagnostics |

### Starter Template

- `examples/extensions/starter/` — copy-and-customize scaffold for new extensions

### Test Coverage

- **24 tests** across 5 `describe` blocks in `packages/core/src/__tests__/extensions.test.ts`
- **5 fixture extensions** covering valid, invalid manifest, bad API version, missing calyx key
- Tests cover: manifest read, API version check, load, discover, runner lifecycle

### `pnpm verify` Green

All four stages pass: `lint`, `typecheck`, `test`, `build`.

## Identified Gaps (Motivating P10C)

### 1. No explicit compatibility policy

- The SDK docs mention `apiVersion` but don't define a version matrix or support window.
- No guidance on what happens when apiVersion advances (migration path, deprecation period).
- No documentation of semver expectations for extension packages vs SDK.

### 2. Conflict governance is shallow

- Domain conflicts are detected and reported with severity based on `strict` flag.
- But: no test covers the strict-mode path treating conflicts as errors.
- No test validates that conflict diagnostics include actionable operator guidance.
- Advisory vs strict behavioral difference is undocumented for operators.

### 3. No harness-target extension proof point

- SDK docs mention the `calyx-ext-<harness>` naming convention but no implementation exists.
- No demonstration that the hook lifecycle works for non-destructive harness-specific diagnostics.
- Gap between naming convention and proven pattern.

### 4. Operator runbook gaps

- Extension management section is basic (list, validate, check).
- No guidance on conflict resolution, extension ordering, or troubleshooting harness-target extensions.

## Plan (P10C Deliverables)

1. **Compatibility policy** — Add explicit version matrix and support-window docs to `extension-sdk.md`.
2. **Conflict governance hardening** — Add strict-mode tests, actionable diagnostics, deterministic ordering tests.
3. **Harness-target seed** — Implement `calyx-ext-cursor` with non-destructive hooks and tests.
4. **Docs/runbook** — Update SDK docs, operator runbook with policy and harness-target guidance.
