# Operator Runbook: Calyx-First Daily Operations

This runbook is the canonical reference for internal Polli operators using the Calyx CLI. All commands use the canonical `calyx <domain> <verb>` form. Legacy compatibility wrappers were removed in P9 (2026-03-02). For first-time setup, see the [Onboarding Guide](onboarding.md).

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- `calyx` CLI installed: `npm install -g @polli-labs/calyx`
- Verify installation: `calyx --help`
- (Optional) Configure production source paths — see [Production Wiring](production-wiring.md)

## Source resolution

Registry and store paths are resolved using: CLI flag > environment variable > config file. With production wiring configured, most commands work without explicit `--registry` / `--store` flags. Run `calyx config show` to see resolved paths.

## Command pattern

All Calyx commands follow a consistent pattern:

```
calyx [global-flags] <domain> <verb> [options]
```

Domains: `config`, `instructions`, `skills`, `tools`, `prompts`, `agents`, `knowledge`, `exec`

Every command supports `--json` for machine-readable output.

## Daily operator workflows

### 1. Config compilation

Compile fleet/host YAML to Codex TOML with parity checking.

```bash
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

**Success signal:** Exit code 0, output reports parity match.
**Failure signal:** Exit code 1, stderr describes mismatch or missing file.

### 2. Instruction rendering and verification

Render instruction templates, then verify against expected outputs.

```bash
# Render for a single host
calyx instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade

# Verify all hosts against expected outputs
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

**Success signal:** Exit 0, "Verification passed" in output.
**Failure signal:** Exit 3, drift details reported.

### 3. Registry management (skills, tools, prompts, agents, knowledge)

All registry domains share the same verb pattern: `index`, `sync`, `validate`.

```bash
# Index — list entries
calyx skills index --registry fixtures/domains/skills/registry.valid.json

# Sync — deploy to backends (plan-only by default)
calyx skills sync --registry fixtures/domains/skills/registry.valid.json --backend codex

# Sync with apply — actually deploy
calyx skills sync --registry fixtures/domains/skills/registry.valid.json --backend claude --apply

# Validate — check registry structure
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict
```

Replace `skills` with `tools`, `prompts`, `agents`, or `knowledge` for other domains. The `agents` domain adds `render-profiles` and `deploy` verbs.

### 4. Execution lifecycle

Launch, monitor, and receipt command runs through the exec domain.

```bash
# Launch (plan-only)
calyx exec launch --store fixtures/domains/exec/store.valid.json \
  --command "calyx config compile --host blade"

# Launch (apply — creates run record)
calyx exec launch --store fixtures/domains/exec/store.valid.json \
  --command "calyx config compile --host blade" --apply

# Check status
calyx exec status --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded

# View logs
calyx exec logs --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded

# Generate receipt
calyx exec receipt --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded

# Validate store
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

**Success signal:** Receipt shows `status: succeeded` with duration and log summary.

### 5. Knowledge search and linking

Search artifacts and link them to Linear issues.

```bash
# Search
calyx knowledge search --registry fixtures/domains/knowledge/registry.valid.json --query "exec"

# Link artifact to issue
calyx knowledge link --registry fixtures/domains/knowledge/registry.valid.json \
  --artifact execplan-unified-agents --issue POL-605 --apply

# Validate
calyx knowledge validate --registry fixtures/domains/knowledge/registry.valid.json --strict
```

## Operator verification checklist

Run this sequence to verify a clean Calyx installation and fixture corpus:

```bash
# 1. Config domain
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml

# 2. Instructions domain
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected

# 3. Skills domain
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict

# 4. Tools domain
calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict

# 5. Prompts domain
calyx prompts validate --registry fixtures/domains/prompts/registry.valid.json --strict

# 6. Agents domain
calyx agents validate --registry fixtures/domains/agents/registry.valid.json --strict

# 7. Knowledge domain
calyx knowledge validate --registry fixtures/domains/knowledge/registry.valid.json --strict

# 8. Exec domain
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

All 8 commands must exit 0. Any non-zero exit indicates a product or fixture issue.

## Failure classification

When a command fails, classify the failure:

```
Command failed (exit != 0)
|
+-- Exit 1: Runtime error
|   +-- File not found? -> Check path, fixture corpus may be incomplete.
|   +-- Parse failure? -> Corrupt input file. Validate upstream.
|   +-- Parity mismatch? -> Config drift. Re-baseline or fix compiler.
|
+-- Exit 2: Invalid arguments
|   +-- Check --help for the command. Likely a typo or missing required flag.
|
+-- Exit 3: Domain validation failure
    +-- Registry or store has structural errors.
    +-- Run without --strict to see advisory-only warnings.
```

### Escalation path

1. **Product bug:** Command fails on valid input. File a Linear issue on **Calyx** project with reproduction steps and the command receipt.
2. **Infra outage:** CI/CD unavailable. Follow the [CI Reliability Runbook](ci-reliability-runbook.md) outage override protocol.
3. **External dependency:** npm registry, GitHub Actions, etc. Wait for resolution; document in PR if merge is needed.

## Retired wrappers

The following legacy compatibility wrappers were retired and **removed in P9** (2026-03-02). Invoking them produces exit code 6 with a message directing to the canonical command:

| Removed wrapper | Canonical replacement |
|---|---|
| `calyx skills-sync` | `calyx skills sync` |
| `calyx skills-sync-claude` | `calyx skills sync --backend claude` |
| `calyx skills-sync-codex` | `calyx skills sync --backend codex` |
| `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` |
| `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` |
| `calyx agents-render` | `calyx instructions render` |
| `calyx exec-launch` | `calyx exec launch` |

If you encounter scripts or automation still using these commands, update them to the canonical form. See [migration-wrappers.md](migration-wrappers.md) for the full history.

## Related documents

- [CLI Reference](cli-reference.md) — complete command reference
- [Skills Subsumption Catalogue](skills-subsumption-catalogue.md) — authoritative skill-by-skill disposition and retirement sequencing
- [Migration Guide](migration-guide.md) — legacy-to-calyx transition walkthrough
- [Migration Wrappers](migration-wrappers.md) — wrapper replacement map and telemetry
- [CI Reliability Runbook](ci-reliability-runbook.md) — CI failure classification and override policy
- [RC Checklist](rc-checklist.md) — release candidate process
- [Post-GA Support Playbook](post-ga-support-playbook.md) — support ownership and first-week cadence
- [Post-GA Watchlist](post-ga-watchlist.md) — monitoring signals and collection commands
- [Post-GA Incident Checklist](post-ga-incident-checklist.md) — incident response for common failure classes
