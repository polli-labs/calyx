# Calyx CLI Reference

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
# Index all active + deprecated agents
calyx agents index --registry fixtures/domains/agents/registry.valid.json

# Machine-readable output
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

**Example:**
```bash
# Render profiles as tab-separated text
calyx agents render-profiles --registry registry.json

# Output:
# blade-runner   Blade Runner   active   hosts=blade(primary)   capabilities=async-runner, compute
# carbon-runner  Carbon Runner  active   hosts=carbon(primary)  capabilities=interactive

# JSON output for programmatic consumption
calyx agents render-profiles --registry registry.json --json
```

### `calyx agents deploy`

Deploy agents from a registry into target backend(s) using the plan/apply contract.

Without `--apply`, prints a plan of deploy actions. With `--apply`, executes the deploy.

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

**Example:**
```bash
# Plan deploy actions (dry run)
calyx agents deploy --registry registry.json --backend claude

# Apply deploy actions
calyx agents deploy --registry registry.json --backend claude --apply
```

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

**Example:**
```bash
calyx agents validate --registry registry.json --strict
# Agents validate FAILED: total=3, active=1, deprecated=1, archived=1.
# [agents] errors:
# - (agents.duplicate-id) agents[1].id: Duplicate agent id "blade-runner".
```

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

**Example:**
```bash
# Index all artifacts
calyx knowledge index --registry registry.json

# Filter by kind
calyx knowledge index --registry registry.json --kind execplan
```

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

**Example:**
```bash
# Search by text
calyx knowledge search --registry registry.json --query "async runner"

# Search by linked issue
calyx knowledge search --registry registry.json --query "POL-605"
```

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

**Example:**
```bash
# Plan a link
calyx knowledge link --registry registry.json --artifact execplan-unified-agents --issue POL-633

# Apply the link
calyx knowledge link --registry registry.json --artifact execplan-unified-agents --issue POL-633 --apply
```

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

**Example:**
```bash
# Plan a launch (dry run)
calyx exec launch --store store.json --command "calyx config compile --host blade"

# Apply the launch
calyx exec launch --store store.json --command "calyx agents deploy --apply" --apply
```

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

**Example:**
```bash
# Human-readable status
calyx exec status --store store.json --run-id run-001

# JSON status for scripting
calyx exec status --store store.json --run-id run-001 --json
```

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

**Example:**
```bash
# View all logs
calyx exec logs --store store.json --run-id run-001

# View only errors
calyx exec logs --store store.json --run-id run-001 --level error

# Last 5 entries
calyx exec logs --store store.json --run-id run-001 --tail 5
```

### `calyx exec receipt`

Generate a receipt for an execution run, including duration, log summary, and human-readable summary.

The receipt includes both machine-readable JSON fields and a `summary` string for human consumption.

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

**Example:**
```bash
# Human-readable receipt
calyx exec receipt --store store.json --run-id run-001
# Output:
# run run-001: succeeded, exit_code=0, duration=4.0s
#   command: calyx config compile --host blade
#   created: 2026-02-28T10:00:00Z
#   started: 2026-02-28T10:00:01Z
#   completed: 2026-02-28T10:00:05Z
#   duration: 4000ms
#   logs: 4 total (3 info, 1 warn, 0 error)

# JSON receipt for agent consumption
calyx exec receipt --store store.json --run-id run-001 --json
```

### `calyx exec validate`

Validate exec run store structure and lifecycle constraints.

```bash
calyx exec validate --store <path> [--strict] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--strict` — Escalate warnings (e.g., missing `completed_at` on terminal states) to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Store read/parse error
- `3` — Validation failed (errors found)

**Validation checks:**
- Duplicate `run_id` values
- Succeeded runs with non-zero `exit_code`
- Timestamp ordering (`created_at` ≤ `started_at` ≤ `completed_at`)
- Terminal states missing `completed_at` (warning; error in strict mode)
- Active states missing `started_at` (warning; error in strict mode)
- Failed runs missing both `exit_code` and `error` (warning; error in strict mode)

**Example:**
```bash
calyx exec validate --store store.json --strict
# Exec validate FAILED: total=4, queued=0, running=0, succeeded=3, failed=1, cancelled=0.
# [exec] errors:
# - (exec.duplicate-run-id) runs[1].run_id: Duplicate run_id "run-dup-001".
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
