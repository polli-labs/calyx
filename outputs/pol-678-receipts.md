# POL-678 Receipts

## Changes

### `packages/cli/src/run-cli.ts`
- Moved retired and deferred wrapper tombstone registration **after** `program.addCommand()` calls for all 9 domain commands.
- Extracted `buildProgram()` function (exported) from `runCli()` to enable test access to Commander program structure.
- Net effect: `calyx --help` now shows domain commands first, wrappers at the bottom.

### `packages/cli/src/index.ts`
- Added `buildProgram` to package exports.

### `packages/cli/src/__tests__/help-ordering.test.ts` (new)
- 6 regression tests enforcing:
  1. All 9 domain commands are registered.
  2. Domain commands appear before any wrapper tombstones.
  3. Domain commands appear in canonical order.
  4. All retired wrappers are registered after domain commands.
  5. All deferred wrappers are registered after domain commands.
  6. Retired wrappers appear before deferred wrappers.

### `outputs/pol-678-baseline.md` (new)
- Snapshot of pre-change help output for audit trail.

## Verification

```
pnpm verify  →  lint ✓  typecheck ✓  test (217/217) ✓  build ✓
calyx --help →  domain commands first ✓
```

## Help output (AFTER)

```
Commands:
  config                 Config compiler commands
  instructions           Instructions rendering and parity commands
  skills                 Skills registry index/sync/validate commands
  tools                  Tools registry index/sync/validate commands
  prompts                Prompts registry index/sync/validate commands
  agents                 Agents registry index/sync/validate commands
  knowledge              Knowledge artifact index/search/link/validate commands
  exec                   Execution lifecycle commands (launch/status/logs/receipt)
  extensions             Extension discovery, loading, and validation commands
  skills-sync            [retired] Removed in P9 — use: calyx skills sync
  ...                    (19 wrapper tombstones follow)
  help [command]         display help for command
```
