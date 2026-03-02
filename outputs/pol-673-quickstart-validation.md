# POL-673 Quickstart Validation Transcript

**Date:** 2026-03-02
**Branch:** `pol-673-p7b-onboarding-docs-r1`
**Environment:** blade (Linux 5.15.0-168-generic), Node v22.x, pnpm 9.15.9

All commands executed from repository root using `node packages/cli/dist/bin.js` (source build path, equivalent to globally installed `calyx`).

## 1. Install & build

```
$ pnpm install --frozen-lockfile
Done in 1.4s using pnpm v9.15.9

$ pnpm build
packages/core build: ESM ⚡️ Build success
packages/sdk build: ESM ⚡️ Build success
packages/cli build: ESM ⚡️ Build success
```

**Status:** PASS

## 2. `calyx --help`

```
$ calyx --help
Usage: calyx [options] [command]

Calyx control plane CLI

Commands:
  config          Config compiler commands
  instructions    Instructions rendering and parity commands
  skills          Skills registry index/sync/validate commands
  tools           Tools registry index/sync/validate commands
  prompts         Prompts registry index/sync/validate commands
  agents          Agents registry index/sync/validate commands
  knowledge       Knowledge artifact index/search/link/validate commands
  exec            Execution lifecycle commands (launch/status/logs/receipt)
  ...             (compatibility wrappers and deferred stubs)
```

**Status:** PASS — All 8 domain groups listed.

## 3. Domain help: `calyx skills --help`

```
$ calyx skills --help
Usage: calyx skills [options] [command]

Skills registry index/sync/validate commands

Commands:
  index [options]     Index skills from a registry
  sync [options]      Sync skills from a registry into target backend(s)
  validate [options]  Validate skills registry structure and lifecycle constraints
```

**Status:** PASS — Three verbs listed with descriptions.

## 4. First-run command: `calyx skills validate`

```
$ calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict
Skills validate OK: total=3, active=1, deprecated=1, archived=1.
```

**Exit code:** 0
**Status:** PASS — Read-only, fixture-backed, deterministic.

## 5. Registry index

```
$ calyx skills index --registry fixtures/domains/skills/registry.valid.json
agents-fleet	active
agents-fleet-bootstrap	deprecated
Indexed 2/3 skills from fixtures/domains/skills/registry.valid.json.
```

**Exit code:** 0
**Status:** PASS

## 6. JSON output mode

```
$ calyx skills index --registry fixtures/domains/skills/registry.valid.json --json
{
  "version": "2026-02-27",
  "total": 3,
  "items": [
    { "id": "agents-fleet", "source": { "type": "internal", ... } },
    { "id": "agents-fleet-bootstrap", "status": "deprecated", ... }
  ]
}
```

**Exit code:** 0
**Status:** PASS — Valid JSON, suitable for `jq` piping.

## 7. Cross-domain: tools

```
$ calyx tools index --registry fixtures/domains/tools/registry.valid.json
cass	v0.1.55
oracle	0.8.4
Indexed 2 tools from fixtures/domains/tools/registry.valid.json.

$ calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict
Tools validate OK: total=2.
```

**Exit codes:** 0, 0
**Status:** PASS — Consistent cross-domain pattern confirmed.

## Summary

| Step | Command | Exit | Status |
|------|---------|------|--------|
| Install/build | `pnpm install && pnpm build` | 0 | PASS |
| Top-level help | `calyx --help` | 0 | PASS |
| Domain help | `calyx skills --help` | 0 | PASS |
| Validate (skills) | `calyx skills validate --strict` | 0 | PASS |
| Index (skills) | `calyx skills index` | 0 | PASS |
| JSON output | `calyx skills index --json` | 0 | PASS |
| Cross-domain (tools) | `calyx tools index + validate` | 0 | PASS |

All onboarding quickstart paths validated successfully. Every command is read-only and fixture-backed — safe for clean-environment first runs.
