# Migration Guide: Legacy Scripts → Calyx

This guide helps teams transition from the legacy `dev/run/*` shell scripts to the unified `calyx` CLI.

## Current status (P7A)

> **Internal operators should be at Phase 3 (canonical commands).** As of P7A internal adoption cutover, all new runbooks and operator workflows must use canonical `calyx <domain> <verb>` commands. Compatibility wrappers remain functional but are deprecated. See the [Operator Runbook](operator-runbook.md) for the canonical daily reference.

## Overview

Calyx replaces a constellation of ad-hoc Bash/Python scripts under `dev/run/` with a single, typed CLI organized into 8 domain command groups. The migration is incremental — compatibility wrappers let you switch at your own pace.

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- Install: `npm install -g @polli-labs/calyx`

## Migration path

### Phase 1: Install Calyx alongside legacy scripts

Install the `calyx` CLI globally or in your project. Legacy scripts continue to work unmodified.

```bash
npm install -g @polli-labs/calyx
calyx --help
```

### Phase 2: Use compatibility wrappers

Calyx ships wrapper commands that mirror legacy entrypoints. These emit deprecation warnings and telemetry to stderr, so you can measure usage before removing old scripts.

| Legacy script | Calyx wrapper | Canonical command |
|---|---|---|
| `dev/run/skills-sync` | `calyx skills-sync` | `calyx skills sync` |
| `dev/run/skills-sync-claude` | `calyx skills-sync-claude` | `calyx skills sync --backend claude` |
| `dev/run/skills-sync-codex` | `calyx skills-sync-codex` | `calyx skills sync --backend codex` |
| `dev/run/prompts-sync-claude` | `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` |
| `dev/run/prompts-sync-codex` | `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` |
| `dev/run/agents-render` | `calyx agents-render` | `calyx instructions render` |
| `dev/run/launch-runner` | `calyx exec-launch` | `calyx exec launch` |

Example: replace `dev/run/skills-sync-claude` with `calyx skills-sync-claude` first, then later switch to the canonical `calyx skills sync --backend claude`.

### Phase 3: Adopt canonical commands

Once comfortable, switch from wrappers to canonical commands. The canonical form is stable and will not be deprecated.

```bash
# Before (wrapper)
calyx skills-sync-claude --registry registry.json

# After (canonical)
calyx skills sync --registry registry.json --backend claude
```

### Phase 4: Remove legacy scripts

After wrapper usage drops to zero (monitor via `calyx.wrapper.invoked` telemetry events in stderr), remove the legacy `dev/run/*` scripts.

```bash
# Check for remaining wrapper usage
grep -r "calyx.wrapper.invoked" /var/log/agent/ | wc -l
```

## Command mapping

### Config compilation

```bash
# Before: manual YAML → TOML scripts or Makefile targets
# After:
calyx config compile \
  --fleet fleet.v2.yaml \
  --hosts-dir hosts/ \
  --host blade \
  --parity expected/blade.config.toml
```

### Instruction rendering

```bash
# Before: pnpm agents:render / dev/run/agents-render
# After:
calyx instructions render \
  --fleet fleet.v1.yaml \
  --hosts-dir hosts/ \
  --template AGENTS.md.mustache \
  --partials-dir partials/ \
  --all
```

### Registry management (skills, tools, prompts, agents, knowledge)

All registry domains follow the same pattern:

```bash
# Index entries
calyx skills index --registry skills.json

# Sync to backends
calyx skills sync --registry skills.json --backend codex --apply

# Validate schema
calyx skills validate --registry skills.json --strict
```

Replace `skills` with `tools`, `prompts`, `agents`, or `knowledge` as needed.

### Execution lifecycle

```bash
# Before: dev/run/async-runner + dev/run/execplan-receipt
# After:
calyx exec launch --store runs.json --command "calyx config compile --host blade" --apply
RUN_ID="<run-id-from-launch-or-existing-store>"
calyx exec status --store runs.json --run-id "$RUN_ID"
calyx exec logs --store runs.json --run-id "$RUN_ID" --tail 20
calyx exec receipt --store runs.json --run-id "$RUN_ID"
```

## Output modes

All commands support `--json` for machine-readable output, making them suitable for scripts and CI pipelines.

```bash
calyx skills index --registry skills.json --json | jq '.items | length'
```

## Exit codes

Calyx uses consistent exit codes across all commands:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (file not found, parse failure) |
| `2` | Invalid CLI arguments |
| `3` | Domain validation failure |

## Telemetry

Compatibility wrappers emit structured telemetry to stderr:

```json
{
  "event": "calyx.wrapper.invoked",
  "wrapper": "skills-sync-claude",
  "target": "calyx skills sync --backend claude",
  "timestamp": "2026-02-28T00:00:00.000Z"
}
```

Use this to track migration progress and decide when to retire wrappers.

## FAQ

**Q: Can I use calyx and legacy scripts side by side?**
A: Yes. Calyx reads the same YAML/JSON inputs. Both can coexist until you're ready to remove the old scripts.

**Q: Do I need to change my CI pipeline?**
A: Replace `dev/run/*` invocations with `calyx` equivalents. The exit codes and output formats are documented and stable.

**Q: What about extensions?**
A: See [extension-sdk.md](./extension-sdk.md) for building custom extensions using `@polli-labs/calyx-sdk`.
