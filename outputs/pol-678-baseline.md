# POL-678 Baseline: `calyx --help` ordering

Captured: 2026-03-03

## Current ordering (BEFORE)

```
Commands:
  skills-sync            [retired] Removed in P9 — use: calyx skills sync
  skills-sync-claude     [retired] Removed in P9 — use: calyx skills sync --backend claude
  skills-sync-codex      [retired] Removed in P9 — use: calyx skills sync --backend codex
  prompts-sync-claude    [retired] Removed in P9 — use: calyx prompts sync --backend claude
  prompts-sync-codex     [retired] Removed in P9 — use: calyx prompts sync --backend codex
  agents-render          [retired] Removed in P9 — use: calyx instructions render
  exec-launch            [retired] Removed in P9 — use: calyx exec launch
  agents-fleet           [deferred] Not yet implemented — target: calyx (domain commands)
  agents-fleet-apply     [deferred] Not yet implemented — target: calyx (convergent domain applies)
  agents-fleet-smoke     [deferred] Not yet implemented — target: calyx verify fleet
  agents-toolkit-doctor  [deferred] Not yet implemented — target: calyx doctor
  agents-bundle-build    [deferred] Not yet implemented — target: calyx bundle build
  agents-tools-bump      [deferred] Not yet implemented — target: calyx tools versions bump
  agent-notify           [deferred] Not yet implemented — target: calyx exec notify
  agent-mail             [deferred] Not yet implemented — target: calyx ext agent-mail
  docstore               [deferred] Not yet implemented — target: calyx knowledge * + adapter
  execplan-new           [deferred] Not yet implemented — target: calyx knowledge execplan new
  agents-bootstrap       [deferred] Not yet implemented — target: calyx install bootstrap
  agents-worktree-init   [deferred] Not yet implemented — target: calyx workspace init
  config                 Config compiler commands
  instructions           Instructions rendering and parity commands
  skills                 Skills registry index/sync/validate commands
  tools                  Tools registry index/sync/validate commands
  prompts                Prompts registry index/sync/validate commands
  agents                 Agents registry index/sync/validate commands
  knowledge              Knowledge artifact index/search/link/validate commands
  exec                   Execution lifecycle commands (launch/status/logs/receipt)
  extensions             Extension discovery, loading, and validation commands
  help [command]         display help for command
```

## Problem

All 19 wrapper tombstones (7 retired + 12 deferred) appear **before** the 9 canonical domain commands. New operators see a wall of deprecated/deferred wrappers before seeing the actual commands they should use.

## Root cause

In `run-cli.ts`, wrapper tombstones are registered via `program.command()` in the retired/deferred loops (lines 1227-1252) **before** domain commands are added via `program.addCommand()` (lines 1413-1421). Commander.js displays commands in registration order.
