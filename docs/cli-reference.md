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

## Exit Code Convention

All calyx commands follow a consistent exit code convention:

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Unhandled runtime error (file not found, parse failure, etc.) |
| `2`  | Invalid CLI arguments (bad flag values, missing required options) |
| `3`  | Domain validation failure (registry has structural or lifecycle errors) |
