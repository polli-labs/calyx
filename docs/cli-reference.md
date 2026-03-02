# Calyx CLI Reference

Complete command reference for the `calyx` CLI. All commands support `--json` for machine-readable output.

## Config Commands

Fleet/host YAML compilation to Codex TOML.

### `calyx config compile`

Compile fleet/host YAML inputs to Codex TOML with semantic parity checking.

```bash
calyx config compile --fleet <path> --hosts-dir <path> --host <host> [options]
```

**Options:**
- `--fleet <path>` (required) — Path to fleet.v2.yaml
- `--hosts-dir <path>` (required) — Path to hosts directory
- `--host <host>` (required) — Host key to compile
- `--out <path>` — Write output TOML path
- `--mode <mode>` — Validation mode: `strict` or `advisory` (default: `strict`)
- `--write` — Write TOML to `--out` path
- `--parity <path>` — Expected TOML fixture path for semantic parity check
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Success
- `1` — Runtime error (file not found, parse failure, parity mismatch)

**Example:**
```bash
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

---

### `calyx config show`

Show resolved source paths for all domains (config file, environment variables).

```bash
calyx config show [options]
```

**Options:**
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Success

**Example:**
```bash
calyx config show
calyx config show --json
```

---

## Instructions Commands

Instruction template rendering and parity verification.

### `calyx instructions render`

Render instruction templates with deterministic token and partial semantics.

```bash
calyx instructions render --fleet <path> --hosts-dir <path> --template <path> --partials-dir <path> [options]
```

**Options:**
- `--fleet <path>` (required) — Path to fleet instructions YAML
- `--hosts-dir <path>` (required) — Path to host instructions directory
- `--template <path>` (required) — Path to instruction template (`*.md.mustache`)
- `--partials-dir <path>` (required) — Path to partial templates directory
- `--host <host>` — Host alias to render (single host)
- `--all` — Render all hosts under `--hosts-dir`
- `--out-dir <path>` — Write rendered output files to this directory
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Success
- `1` — Runtime error (missing template, parse failure)

**Example:**
```bash
calyx instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade
```

### `calyx instructions verify`

Verify rendered instruction outputs against expected fixtures, reporting drift.

```bash
calyx instructions verify --fleet <path> --hosts-dir <path> --template <path> --partials-dir <path> --expected-dir <path> [options]
```

**Options:**
- All options from `instructions render`, plus:
- `--expected-dir <path>` (required) — Path to expected rendered outputs

**Exit codes:**
- `0` — Verification passed (no drift)
- `1` — Runtime error
- `3` — Verification failed (drift detected)

**Example:**
```bash
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

---

## Skills Commands

Skills registry management: index, sync, and validate.

### `calyx skills index`

Index skills from a registry, filtering by lifecycle status.

```bash
calyx skills index --registry <path> [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--include-archived` — Include archived skills in output
- `--exclude-deprecated` — Exclude deprecated skills from output
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error

### `calyx skills sync`

Sync skills from a registry into target backend(s) using the plan/apply contract.

```bash
calyx skills sync --registry <path> [--backend <backend>] [--apply] [--prune-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--backend <backend>` — Sync backend: `claude`, `codex`, `agents`, or `all` (default: `all`)
- `--apply` — Apply sync actions (default: plan-only)
- `--include-archived` — Include archived skills
- `--exclude-deprecated` — Exclude deprecated skills
- `--prune-deprecated` — Plan or apply prune actions for deprecated skills
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx skills validate`

Validate skills registry structure and lifecycle constraints.

```bash
calyx skills validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed (errors found)

---

## Tools Commands

Tools registry management: index, sync, and validate.

### `calyx tools index`

Index tools from a registry.

```bash
calyx tools index --registry <path> [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--json` — Print machine-readable JSON summary

### `calyx tools sync`

Sync tools from a registry into host targets.

```bash
calyx tools sync --registry <path> [--host <alias> | --all] [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--host <alias>` — Single host alias to target
- `--all` — Sync all known hosts
- `--apply` — Apply sync actions
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — `--host` and `--all` used together

### `calyx tools validate`

Validate tools registry structure and version metadata.

```bash
calyx tools validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed

---

## Prompts Commands

Prompts registry management: index, sync, and validate.

### `calyx prompts index`

Index prompts from a registry.

```bash
calyx prompts index --registry <path> [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--json` — Print machine-readable JSON summary

### `calyx prompts sync`

Sync prompts from a registry into backend targets.

```bash
calyx prompts sync --registry <path> [--backend <backend>] [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--backend <backend>` — Sync backend: `claude`, `codex`, or `all` (default: `all`)
- `--apply` — Apply sync actions
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx prompts validate`

Validate prompts registry structure and variable contracts.

```bash
calyx prompts validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed

---

## Agents Commands

Manage the agents registry: index, render profiles, deploy, sync, and validate.

### `calyx agents index`

Index agents from a registry, filtering by lifecycle status.

```bash
calyx agents index --registry <path> [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to agents registry JSON
- `--include-archived` — Include archived agents in output (default: excluded)
- `--exclude-deprecated` — Exclude deprecated agents from output
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error

**Example:**
```bash
calyx agents index --registry fixtures/domains/agents/registry.valid.json
calyx agents index --registry registry.json --json
```

### `calyx agents render-profiles`

Render agent profiles from a registry, including hosts, capabilities, and lifecycle status.

```bash
calyx agents render-profiles --registry <path> [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to agents registry JSON
- `--include-archived` — Include archived agents in profile output
- `--exclude-deprecated` — Exclude deprecated agents from profile output
- `--json` — Print machine-readable JSON with full profile objects

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error

### `calyx agents deploy`

Deploy agents from a registry into target backend(s) using the plan/apply contract.

```bash
calyx agents deploy --registry <path> [--backend <backend>] [--apply] [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to agents registry JSON
- `--backend <backend>` — Target backend: `claude`, `codex`, or `all` (default: `all`)
- `--apply` — Execute the deploy actions (default: plan-only)
- `--include-archived` — Include archived agents
- `--exclude-deprecated` — Exclude deprecated agents
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan generated or deploy applied)
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx agents sync`

Sync agents from a registry into target backend(s).

```bash
calyx agents sync --registry <path> [--backend <backend>] [--apply] [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to agents registry JSON
- `--backend <backend>` — Target backend: `claude`, `codex`, or `all` (default: `all`)
- `--apply` — Execute sync actions
- `--include-archived` — Include archived agents
- `--exclude-deprecated` — Exclude deprecated agents
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx agents validate`

Validate agents registry structure and lifecycle constraints.

```bash
calyx agents validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to agents registry JSON
- `--strict` — Escalate warnings (e.g., missing `archived_at`) to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed (errors found)

---

## Knowledge Commands

Manage the knowledge artifact registry: index, search, link, and validate.

### `calyx knowledge index`

Index knowledge artifacts from a registry, optionally filtering by kind.

```bash
calyx knowledge index --registry <path> [--kind <kind>] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--kind <kind>` — Filter by artifact kind: `execplan`, `transcript`, `report`, `runbook`, `reference`
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--kind` value

### `calyx knowledge search`

Search knowledge artifacts by query string, matching against title, id, tags, and linked issues.

```bash
calyx knowledge search --registry <path> --query <query> [--kind <kind>] [--tags <tags>] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--query <query>` (required) — Search query string (case-insensitive)
- `--kind <kind>` — Filter by artifact kind
- `--tags <tags>` — Comma-separated tag filter (all tags must match)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (including zero matches)
- `1` — Registry read/parse/validation error
- `2` — Invalid `--kind` value

### `calyx knowledge link`

Link a knowledge artifact to a Linear issue using the plan/apply contract.

```bash
calyx knowledge link --registry <path> --artifact <id> --issue <id> [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--artifact <id>` (required) — Artifact ID to link
- `--issue <id>` (required) — Linear issue ID to link to
- `--apply` — Apply the link action
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan-link, link, or already-linked)
- `1` — Artifact not found or registry error

### `calyx knowledge validate`

Validate knowledge registry structure and artifact contracts.

```bash
calyx knowledge validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--strict` — Escalate warnings (e.g., duplicate tags) to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed (errors found)

---

## Exec Commands

Execution lifecycle management: launch, status, logs, and receipt.

The exec domain provides a durable run-record contract for tracking command execution through lifecycle states (`queued` → `running` → `succeeded`/`failed`/`cancelled`). All commands operate against a JSON run store.

### `calyx exec launch`

Launch a new execution run. Without `--apply`, plans the launch. With `--apply`, creates a run record.

```bash
calyx exec launch --store <path> --command <command> [--apply] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--command <command>` (required) — Command string to launch
- `--apply` — Create a real run record (default: plan-only)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan or launch applied)
- `1` — Store read/parse/validation error

### `calyx exec status`

Get the current status of an execution run.

```bash
calyx exec status --store <path> --run-id <id> [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Store error or run not found

### `calyx exec logs`

View logs for an execution run, with optional filtering.

```bash
calyx exec logs --store <path> --run-id <id> [--level <level>] [--tail <n>] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--level <level>` — Filter by log level: `info`, `warn`, `error`
- `--tail <n>` — Show only the last N log entries
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (including zero log entries)
- `1` — Store error or run not found
- `2` — Invalid `--level` value

### `calyx exec receipt`

Generate a receipt for an execution run, including duration, log summary, and human-readable summary.

```bash
calyx exec receipt --store <path> --run-id <id> [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--json` — Print full machine-readable JSON receipt

**Exit codes:**
- `0` — Success
- `1` — Store error or run not found

### `calyx exec validate`

Validate exec run store structure and lifecycle constraints.

```bash
calyx exec validate --store <path> [--strict] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Store read/parse error
- `3` — Validation failed (errors found)

---

## Compatibility Wrappers

Migration wrappers that forward to canonical `calyx` subcommands. Each wrapper emits a deprecation warning and a `calyx.wrapper.invoked` telemetry marker to stderr, making migration usage measurable. See [migration-wrappers.md](./migration-wrappers.md) for the full replacement map.

| Wrapper command | Forwards to | Legacy surface |
|---|---|---|
| `calyx skills-sync` | `calyx skills sync` | `dev/run/skills-sync` |
| `calyx skills-sync-claude` | `calyx skills sync --backend claude` | `dev/run/skills-sync-claude` |
| `calyx skills-sync-codex` | `calyx skills sync --backend codex` | `dev/run/skills-sync-codex` |
| `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` | `dev/run/prompts-sync-claude` |
| `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` | `dev/run/prompts-sync-codex` |
| `calyx agents-render` | `calyx instructions render` | `dev/run/agents-render` |
| `calyx exec-launch` | `calyx exec launch` | `dev/run/launch-runner` |

**Telemetry output** (stderr):
```
[calyx][deprecated] skills-sync-claude is a compatibility wrapper. Use "calyx skills sync --backend claude".
[calyx][telemetry] {"event":"calyx.wrapper.invoked","wrapper":"skills-sync-claude","target":"calyx skills sync --backend claude","timestamp":"..."}
```

**JSON mode:** When `--json` is passed, wrappers return a `{ wrapper, result }` envelope:
```json
{
  "wrapper": { "event": "calyx.wrapper.invoked", "wrapper": "...", "target": "...", "timestamp": "..." },
  "result": { ... }
}
```

---

## Exit Code Convention

All calyx commands follow a consistent exit code convention:

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Unhandled runtime error (file not found, parse failure, etc.) |
| `2`  | Invalid CLI arguments (bad flag values, missing required options) |
| `3`  | Domain validation failure (registry has structural or lifecycle errors) |
