# Migration Guide: Legacy Scripts → Calyx

This guide documents the completed migration from legacy `dev/run/*` shell scripts to the unified `calyx` CLI. If you're new to Calyx, start with the [Onboarding Guide](onboarding.md) for install and first-run orientation.

## Current status (P9 — migration complete)

> **Migration is complete.** All 7 compatibility wrappers were retired in P9 (2026-03-02). All operator workflows now use canonical `calyx <domain> <verb>` commands exclusively. Invoking a retired wrapper produces exit code 6 with a clear error pointing to the canonical command. See the [Operator Runbook](operator-runbook.md) for the canonical daily reference.

## Overview

Calyx replaced a constellation of ad-hoc Bash/Python scripts under `dev/run/` with a single, typed CLI organized into 8 domain command groups. The migration was completed in four phases:

1. **P1–P4:** Calyx domain commands implemented; compatibility wrappers provided.
2. **P7A:** Internal adoption cutover — all workflows on canonical commands.
3. **P7B–P8:** Production wiring, GA release (v0.1.1), operator runbooks.
4. **P9:** Wrapper retirement — all compatibility wrappers removed from CLI.

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- Install: `npm install -g @polli-labs/calyx`

## Command mapping

### Config compilation

```bash
calyx config compile \
  --fleet fleet.v2.yaml \
  --hosts-dir hosts/ \
  --host blade \
  --parity expected/blade.config.toml
```

### Instruction rendering

```bash
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
| `5` | Deferred wrapper invoked (not yet implemented) |
| `6` | Retired wrapper invoked (removed in P9) |

## Skills subsumption

For a complete skill-by-skill mapping of legacy skills/wrappers to Calyx replacements — including disposition, retirement phase, and migration examples — see the **[Skills Subsumption Catalogue](skills-subsumption-catalogue.md)**.

## FAQ

**Q: I'm getting exit code 6 — what happened?**
A: You invoked a retired wrapper command (e.g., `calyx skills-sync-claude`). These were removed in P9. The error message tells you the canonical command to use instead.

**Q: Do I need to change my CI pipeline?**
A: If your CI uses canonical `calyx <domain> <verb>` commands, no changes needed. If it uses wrapper commands (e.g., `calyx skills-sync`), update to the canonical form.

**Q: What about extensions?**
A: See [extension-sdk.md](./extension-sdk.md) for building custom extensions using `@polli-labs/calyx-sdk`.
