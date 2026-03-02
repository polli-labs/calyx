# Production Wiring Guide

This guide explains how to configure Calyx for production use — resolving registry and store paths automatically instead of requiring explicit `--registry` / `--store` flags on every command.

## Configuration Model

Calyx resolves source paths using a strict precedence chain:

```
CLI flag  >  environment variable  >  config file
```

When you provide `--registry <path>` or `--store <path>`, that value is always used. When omitted, Calyx checks environment variables, then the config file.

## Quick Start

### Option 1: Environment Variables

Set environment variables for the domains you use:

```bash
export CALYX_SKILLS_REGISTRY=~/.agents/registries/skills.json
export CALYX_TOOLS_REGISTRY=~/.agents/registries/tools.json
export CALYX_PROMPTS_REGISTRY=~/.agents/registries/prompts.json
export CALYX_AGENTS_REGISTRY=~/.agents/registries/agents.json
export CALYX_KNOWLEDGE_REGISTRY=~/.agents/registries/knowledge.json
export CALYX_EXEC_STORE=~/.agents/stores/exec.json
```

Then run commands without explicit paths:

```bash
calyx skills index                    # resolves from CALYX_SKILLS_REGISTRY
calyx agents validate --strict        # resolves from CALYX_AGENTS_REGISTRY
calyx exec status --run-id run-001    # resolves from CALYX_EXEC_STORE
```

### Option 2: Config File

Create `~/.config/calyx/config.json`:

```json
{
  "version": "1",
  "registries": {
    "skills": "~/.agents/registries/skills.json",
    "tools": "~/.agents/registries/tools.json",
    "prompts": "~/.agents/registries/prompts.json",
    "agents": "~/.agents/registries/agents.json",
    "knowledge": "~/.agents/registries/knowledge.json"
  },
  "stores": {
    "exec": "~/.agents/stores/exec.json"
  }
}
```

Override the config file location with `CALYX_CONFIG`:

```bash
export CALYX_CONFIG=/path/to/custom/config.json
```

### Option 3: Mix and Match

You can combine approaches. For example, set most paths in the config file but override one domain via environment variable:

```bash
# Config file sets defaults for all domains
# Override just skills for a specific workflow
CALYX_SKILLS_REGISTRY=./local-skills.json calyx skills sync --backend claude
```

## Diagnostic: `calyx config show`

See the resolved paths for all domains:

```bash
calyx config show
```

Output:

```
Config file: /home/user/.config/calyx/config.json (source: default)

skills    /home/user/.agents/registries/skills.json     [config]
tools     /home/user/.agents/registries/tools.json      [config]
prompts   (not configured)                               [none]
agents    /home/user/.agents/registries/agents.json     [env]
knowledge (not configured)                               [none]
exec      /home/user/.agents/registries/exec.json       [config]
```

Use `--json` for machine-readable output.

## Environment Variable Reference

| Variable | Domain | CLI Flag |
|----------|--------|----------|
| `CALYX_SKILLS_REGISTRY` | skills | `--registry` |
| `CALYX_TOOLS_REGISTRY` | tools | `--registry` |
| `CALYX_PROMPTS_REGISTRY` | prompts | `--registry` |
| `CALYX_AGENTS_REGISTRY` | agents | `--registry` |
| `CALYX_KNOWLEDGE_REGISTRY` | knowledge | `--registry` |
| `CALYX_EXEC_STORE` | exec | `--store` |
| `CALYX_CONFIG` | (config file location) | — |

## Config File Schema

```json
{
  "version": "1",
  "registries": {
    "skills": "<path>",
    "tools": "<path>",
    "prompts": "<path>",
    "agents": "<path>",
    "knowledge": "<path>"
  },
  "stores": {
    "exec": "<path>"
  }
}
```

All fields under `registries` and `stores` are optional. Paths support `~` expansion.

## Fixture Mode (Testing)

For testing and CI, continue to pass explicit paths:

```bash
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict
```

Explicit `--registry` / `--store` flags always take precedence, so existing scripts and CI pipelines work unchanged.

## Error Messages

When no source is found for a domain, Calyx reports:

```
No skills source path found. Provide --registry <path>,
set CALYX_SKILLS_REGISTRY, or configure it in ~/.config/calyx/config.json.
```
