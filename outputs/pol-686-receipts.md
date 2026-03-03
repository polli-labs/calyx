# POL-686 Receipts: P10B Extension Breadth + Starter Template

## Verification

### `pnpm verify` — PASS

```
lint:      ✓ (eslint, 0 errors)
typecheck: ✓ (6 packages: sdk, core, cli, web, calyx-ext-polli, calyx-ext-linear)
test:      ✓ (14 test files, 211 tests, 0 failures)
build:     ✓ (all packages built successfully)
```

### Test breakdown

| Suite | Tests | Status |
|-------|-------|--------|
| SDK manifest validation | 12 | PASS |
| Core extensions (loader, discovery, runner) | 24 | PASS |
| Core domains | 24 | PASS |
| Core exec | 21 | PASS |
| Core resolve | 20 | PASS |
| Core wrappers | 28 | PASS |
| Core compiler | 2 | PASS |
| Core parity | 8 | PASS |
| Core instructions | 5 | PASS |
| Core instructions parity | 2 | PASS |
| Docs coherence | 27 | PASS |
| calyx-ext-polli | 15 | PASS |
| **calyx-ext-linear** | **15** | **PASS** |
| **starter template** | **8** | **PASS** |

### Smoke tests

#### `calyx extensions list --search-path packages`
- Loaded: `calyx-ext-linear` (agents, exec), `calyx-ext-polli` (skills, tools, agents)
- Failed: 0
- Conflicts: `agents` domain (advisory, both polli + linear claim it)

#### `calyx extensions check --path packages/calyx-ext-linear`
- Result: `ok: true`, 0 diagnostics

#### `calyx extensions check --path examples/extensions/starter`
- Result: `ok: true` (after build), 0 diagnostics

#### `CALYX_EXTENSIONS_PATH=packages calyx exec validate --store <fixture>`
- Both extensions activate, fire hooks, and deactivate cleanly
- calyx-ext-linear outputs: `Linear extension activated`, env hints, `Linear extension deactivated`
- No hook blocks, no errors

## Deliverables

### 1. `packages/calyx-ext-linear/` — second first-party extension

| File | Purpose |
|------|---------|
| `package.json` | Manifest: name=calyx-ext-linear, domains=[agents, exec], apiVersion=1 |
| `src/index.ts` | Extension implementation: env hints, issue context, failure diagnostics |
| `src/__tests__/linear-ext.test.ts` | 15 tests: manifest, all 4 hooks, runner integration |
| `tsconfig.json` | TypeScript config extending base |

**Hook behavior:**
- `activate`: checks LINEAR_API_KEY and LINEAR_TEAM env vars
- `beforeCommand`: advisory hints for exec launch and agents deploy
- `afterCommand`: failure diagnostics with Linear-friendly suggestions
- `deactivate`: clean teardown message
- **Non-destructive**: never blocks (always ok: true)

### 2. `examples/extensions/starter/` — third-party starter template

| File | Purpose |
|------|---------|
| `package.json` | Complete calyx manifest block |
| `src/index.ts` | Annotated entrypoint with all 4 lifecycle hooks |
| `src/validate.ts` | Standalone manifest validation script |
| `src/__tests__/extension.test.ts` | 8 tests: manifest, all hooks |
| `tsconfig.json` | TypeScript config |
| `README.md` | Quickstart for external extension authors |

### 3. Infrastructure changes

| File | Change |
|------|--------|
| `pnpm-workspace.yaml` | Added `examples/extensions/*` pattern |
| `vitest.config.ts` | Added `examples/**/*.test.ts` to include |

### 4. Documentation updates

| File | Change |
|------|--------|
| `docs/extension-sdk.md` | Added calyx-ext-linear section, starter template workflow |
| `docs/operator-runbook.md` | Extension table with both first-party extensions |
| `README.md` | Extension table with polli + linear, starter template pointer |

## Changed files summary

```
packages/calyx-ext-linear/package.json          (new)
packages/calyx-ext-linear/tsconfig.json          (new)
packages/calyx-ext-linear/src/index.ts           (new)
packages/calyx-ext-linear/src/__tests__/linear-ext.test.ts (new)
examples/extensions/starter/package.json         (new)
examples/extensions/starter/tsconfig.json        (new)
examples/extensions/starter/README.md            (new)
examples/extensions/starter/src/index.ts         (new)
examples/extensions/starter/src/validate.ts      (new)
examples/extensions/starter/src/__tests__/extension.test.ts (new)
pnpm-workspace.yaml                             (modified)
vitest.config.ts                                 (modified)
docs/extension-sdk.md                            (modified)
docs/operator-runbook.md                         (modified)
README.md                                        (modified)
outputs/pol-686-baseline.md                      (new)
outputs/pol-686-receipts.md                      (new)
```
