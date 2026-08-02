# Production Wiring Guide

This guide explains how to configure Calyx for production use — resolving registry and store paths automatically instead of requiring explicit `--registry` / `--store` flags on every command.

## Configuration Model

Calyx resolves source paths using a strict precedence chain:

```
CLI flag  >  environment variable  >  config file
```

When you provide `--registry <path>` or `--store <path>`, that value is always used. When omitted, Calyx checks environment variables, then the config file.

If no explicit source is configured, Calyx can materialize production-backed adapter sources when `CALYX_SOURCE_MODE` is `auto` (default) or `adapter`.

## Quick Start

### Option 1: Environment Variables

Set environment variables for the domains you use:

```bash
export CALYX_SKILLS_REGISTRY=~/.agents/registries/skills.json
export CALYX_TOOLS_REGISTRY=~/.agents/registries/tools.json
export CALYX_PROMPTS_REGISTRY=~/.agents/registries/prompts.json
export CALYX_AGENTS_REGISTRY=~/dev/agents-infra/dev/instructions/agents/AGENTS.json
export CALYX_KNOWLEDGE_REGISTRY=~/.agents/registries/knowledge.json
export CALYX_EXEC_STORE=~/.agents/stores/exec.json
```

Then run commands without explicit paths:

```bash
calyx skills index                    # resolves from CALYX_SKILLS_REGISTRY
calyx agents validate --strict        # resolves from CALYX_AGENTS_REGISTRY
calyx exec status --run-id run-001    # resolves from CALYX_EXEC_STORE
```

### Run orchestration environment

The canonical `calyx run` surface uses a dedicated run root and remote-control-plane environment variables instead of the registry/store config file:

```bash
export CALYX_RUNS_ROOT=~/.calyx/runs
export CALYX_RUNNER_WORKTREE_BASE=~/projects
export CALYX_RUN_SERVER_URL_TEMPLATE='http://{host}:8740'

calyx run launch --host local --prompt "verify run surface" --foreground --json
calyx run serve
```

`calyx run serve` loads per-client verifier declarations from the current
host's `consumer_api_credentials` truth and refuses to start when the
credential catalog or ambient token isolation is invalid. Operator calls
resolve the named `operator_cli` outbound row; no shared bearer fallback
exists.

Operational probes for `calyx run serve`:
- `GET /livez` is unauthenticated shallow liveness.
- `GET /v1/admin/health` requires an operator credential and returns a bounded health projection; `GET /v1/internal/health` returns full daemon metadata only to the host-daemon credential.

On Linux hosts where `calyx run serve` itself runs under systemd, detached run
workers are launched through per-run transient `systemd-run --user` units. Keep
the daemon unit's normal `KillMode=mixed` shutdown discipline: daemon restart or
self-upgrade should stop only the daemon service, while the run worker continues
inside its own `calyx-run-<run-id>.service` cgroup and leaves the worker
supervisor/unit/cgroup receipt in the run event stream.
This isolation path assumes the daemon is a **user** systemd service with a
working user manager, because workers are launched with `systemd-run --user`.
For a system-level daemon, treat `worker_supervisor=direct` as unprotected by
this restart-survival mechanism unless a system-scope worker launcher is added.

`CALYX_RUNNER_WORKTREE_BASE` controls where runtime-managed **target-repo** worktrees are created for `calyx run` when `kernel=agent_runner`. It is intentionally distinct from Calyx's own source checkout layout (for example `~/dev/calyx/dev` and `~/dev/calyx/wt/<branch>`). `host_process` launches do not use this base path.

`CALYX_RUN_SERVER_URL_TEMPLATE` must contain a `{host}` placeholder. Remote `calyx run launch --host <host>` requests use that template when `--server-url` is omitted.

### Option 2: Config File

Create `~/.config/calyx/config.json`:

```json
{
  "version": "1",
  "registries": {
    "skills": "~/.agents/registries/skills.json",
    "tools": "~/.agents/registries/tools.json",
    "prompts": "~/.agents/registries/prompts.json",
    "agents": "~/dev/agents-infra/dev/instructions/agents/AGENTS.json",
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

### Option 4: Production Adapter Mode (no fixture paths)

Enable adapter-backed fallback when explicit paths are not configured:

```bash
export CALYX_SOURCE_MODE=adapter
export CALYX_POLLI_ROOT=/home/caleb/repo/polli
export CALYX_DOCSTORE_ROOT=$HOME/.agents/docstore
```

`CALYX_POLLI_ROOT` has no default — the adapters below fail naming the variable
rather than guessing a checkout location that is wrong on every host but one.

With adapter mode enabled, Calyx resolves these domains from Polli/docstore truths:

- `skills` -> `${CALYX_POLLI_ROOT}/docs/org-kb/agents/skills/SOURCES.json`
- `tools` -> `${CALYX_POLLI_ROOT}/docs/org-kb/agents/tools/TOOLS.json`
- `prompts` -> `${CALYX_POLLI_ROOT}/docs/org-kb/agents/prompts/REGISTRY.json`
- `agents` -> `${CALYX_AGENTS_INFRA_ROOT}/instructions/agents/AGENTS.json`
- `knowledge` -> materialized from `${CALYX_DOCSTORE_ROOT}/execplan/*`
- `exec` -> materialized local store scaffold in adapter cache

Adapter cache location defaults to `~/.cache/calyx/adapters` and is overrideable via `CALYX_ADAPTER_CACHE`.

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
agents    /home/user/dev/agents-infra/dev/instructions/agents/AGENTS.json [env]
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
| `CALYX_RUNS_ROOT` | run | `--runs-root` |
| `CALYX_CONFIG` | (config file location) | — |
| `CALYX_RUNNER_WORKTREE_BASE` | run worker target-repo worktree base | `--worktree-base` |
| `CALYX_RUN_SERVER_URL_TEMPLATE` | run server URL template | `--server-url` |
| `CALYX_SOURCE_MODE` | source fallback policy (`auto`/`explicit`/`adapter`) | — |
| `CALYX_POLLI_ROOT` | Polli repo root for adapter-backed registries; required for the `skills`/`tools`/`prompts` adapters, which have no default root | — |
| `CALYX_DOCSTORE_ROOT` | Docstore root for knowledge adapter | — |
| `CALYX_ADAPTER_CACHE` | Local cache for materialized adapter outputs | — |

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

## Telemetry

Each domain command emits a source-resolution telemetry event on stderr:

```json
{
  "event": "calyx.source.resolved",
  "domain": "skills",
  "source": "adapter",
  "fallback": true,
  "path": "/home/user/.cache/calyx/adapters/skills.registry.json",
  "timestamp": "2026-03-04T22:00:00.000Z"
}
```

Use `fallback: true` to detect when commands are running in adapter mode instead of explicit path mode.

## Error Messages

When no source is found for a domain, Calyx reports:

```
No skills source path found. Provide --registry <path>,
set CALYX_SKILLS_REGISTRY, or configure it in ~/.config/calyx/config.json.
```
