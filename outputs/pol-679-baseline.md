# POL-679 Baseline: Wrapper Port Inventory

**Date:** 2026-03-03
**Branch:** pol-679-wrapper-port-r1
**Baseline commit:** 3e36c1b (main, clean)

## Current Wrapper Registry Status

### Retired (7 wrappers — P9, 2026-03-02)
All producing exit code 6 with clear "removed" messages. No changes needed.

| Wrapper | Target | Status |
|---------|--------|--------|
| skills-sync | calyx skills sync | retired |
| skills-sync-claude | calyx skills sync --backend claude | retired |
| skills-sync-codex | calyx skills sync --backend codex | retired |
| prompts-sync-claude | calyx prompts sync --backend claude | retired |
| prompts-sync-codex | calyx prompts sync --backend codex | retired |
| agents-render | calyx instructions render | retired |
| exec-launch | calyx exec launch | retired |

### Deferred — POL-679 Target Set (9 wrappers)
All currently producing exit code 5 with "not yet implemented" tombstone.

| Wrapper | Target | Canonical exists? | Gap |
|---------|--------|-------------------|-----|
| agents-toolkit-doctor | calyx doctor | No | Need new top-level `doctor` command |
| agents-tools-bump | calyx tools versions bump | No | Need `tools versions` parent + `bump` subcommand |
| agent-notify | calyx exec notify | No | Need `exec notify` subcommand; delegates to Python backend |
| docstore | calyx knowledge docstore * | No | Need `knowledge docstore` adapter subcommands |
| agents-fleet-smoke | calyx verify fleet | No | Need new `verify` parent + `fleet` subcommand |
| agents-bundle-build | calyx bundle build | No | Need new `bundle` parent + `build` subcommand |
| agent-mail | calyx extensions agent-mail * | No | Extension-mediated pass-through |
| execplan-new | calyx knowledge execplan new | No | Need `knowledge execplan` parent + `new` subcommand |
| agents-bootstrap | calyx install bootstrap | No | Need new `install` parent + `bootstrap` subcommand |

### Deferred — Out of Scope (3 wrappers, tracked in POL-680)

| Wrapper | Target | Notes |
|---------|--------|-------|
| agents-fleet | calyx (domain commands) | Split across domain commands |
| agents-fleet-apply | calyx (convergent domain applies) | Decompose by subsystem |
| agents-worktree-init | calyx workspace init | Low core leverage |

## Canonical Command Availability Matrix

| Domain | Commands | Status |
|--------|----------|--------|
| config | compile, show | Complete |
| instructions | render, verify | Complete |
| skills | index, sync, validate | Complete |
| tools | index, sync, validate | Complete (versions subgroup missing) |
| prompts | index, sync, validate | Complete |
| agents | index, render-profiles, deploy, sync, validate | Complete |
| knowledge | index, search, link, validate | Complete (docstore/execplan adapters missing) |
| exec | launch, status, logs, receipt, validate | Complete (notify missing) |
| extensions | list, validate, check | Complete |
| doctor | (none) | Missing — needs top-level command |
| verify | (none) | Missing — needs top-level parent + fleet |
| bundle | (none) | Missing — needs top-level parent + build |
| install | (none) | Missing — needs top-level parent + bootstrap |

## Test Baseline

- `pnpm verify` passes (lint, typecheck, test, build)
- 7 retired wrappers: exit code 6
- 12 deferred wrappers: exit code 5
- 0 implemented wrappers

## Implementation Plan

For each wrapper, implement a minimal v1 canonical command surface:
- Commands that delegate to external tools use `child_process.execFile` pass-through
- Commands with pure-calyx semantics implement logic in `@polli-labs/calyx-core`
- All commands support `--json` for structured output
- Wrapper registry entries transition from `deferred` to `implemented`
- Telemetry and deprecation messaging preserved via wrapper CLI stubs
