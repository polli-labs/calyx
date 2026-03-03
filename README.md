# calyx-dev

Private development monorepo for the **Calyx** agent control plane — a unified, contract-first CLI that replaces fragmented operational scripts with typed domain commands.

## Packages

| Package | npm | Purpose |
|---------|-----|---------|
| `@polli-labs/calyx-core` | `packages/core` | Domain contracts, compilers, validators, registry logic |
| `@polli-labs/calyx` | `packages/cli` | CLI binary (`calyx` command) |
| `@polli-labs/calyx-sdk` | `packages/sdk` | Extension SDK — contracts, lifecycle hooks, manifest validation |
| `@polli-labs/calyx-web` | `packages/web` | Web companion surface (placeholder) |

### Extension model

Extensions are npm packages that depend on `@polli-labs/calyx-sdk` and declare a `calyx` key in their `package.json`. They can hook into the CLI lifecycle (activate, beforeCommand, afterCommand, deactivate) and target any of the 8 domains.

Two first-party extensions ship in the monorepo:

| Extension | Domains | Purpose |
|-----------|---------|---------|
| [`calyx-ext-polli`](packages/calyx-ext-polli) | skills, tools, agents | Registry pre-flight checks, fleet diagnostics |
| [`calyx-ext-linear`](packages/calyx-ext-linear) | agents, exec | Linear issue context hints, exec failure diagnostics |

See [docs/extension-sdk.md](docs/extension-sdk.md) for the full SDK reference, [examples/calyx-ext-hello](examples/calyx-ext-hello) for a minimal sample, and [examples/extensions/starter](examples/extensions/starter) for a copy-and-customize starter template.

Extension naming: `calyx-ext-<name>` (first-party), `@user/calyx-ext-<name>` (community).

## Workspace layout

```
packages/core       @polli-labs/calyx-core     domain contracts + compiler
packages/cli        @polli-labs/calyx          CLI binary
packages/sdk        @polli-labs/calyx-sdk      extension SDK
packages/web        @polli-labs/calyx-web      web companion
examples/           sample extensions
fixtures/           test fixture corpus
docs/               ADRs, CLI reference, SDK docs, migration guides
```

## Getting started

New to Calyx? Start with the **[Onboarding Guide](docs/onboarding.md)** — install, first commands, surface map, migration pointers, and extension primer.

For daily Calyx operations, see the **[Operator Runbook](docs/operator-runbook.md)** — a condensed reference covering all 8 domain commands, verification checklists, and failure classification.

Quick verification (all domains, fixture-based):

```bash
pnpm install
pnpm verify                          # lint → typecheck → test → build
node packages/cli/dist/bin.js --help # smoke-test CLI
```

For command-by-command reference, see [docs/cli-reference.md](docs/cli-reference.md).

## Local verification

```bash
pnpm install
pnpm verify   # lint → typecheck → test → build
```

Individual stages can also be run separately: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

See [CI Reliability Runbook](docs/ci-reliability-runbook.md) for failure classification and CI override policy.

## Production wiring

Registry and store paths can be resolved automatically via environment variables or a config file, so you don't need to pass `--registry` / `--store` on every command. See [docs/production-wiring.md](docs/production-wiring.md) for the full guide.

Quick setup:
```bash
export CALYX_SKILLS_REGISTRY=~/.agents/registries/skills.json
calyx skills index    # resolves automatically
calyx config show     # see all resolved paths
```

## Domain commands

The CLI is organized into 8 domain command groups plus compatibility wrappers. See [docs/cli-reference.md](docs/cli-reference.md) for the full reference.

### Config compile

```bash
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

### Instructions render / verify

```bash
calyx instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade

calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

### Skills index / sync / validate

```bash
calyx skills index --registry fixtures/domains/skills/registry.valid.json
calyx skills sync --registry fixtures/domains/skills/registry.valid.json --backend codex
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict
```

### Tools index / sync / validate

```bash
calyx tools index --registry fixtures/domains/tools/registry.valid.json
calyx tools sync --registry fixtures/domains/tools/registry.valid.json --all
calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict
```

### Prompts index / sync / validate

```bash
calyx prompts index --registry fixtures/domains/prompts/registry.valid.json
calyx prompts sync --registry fixtures/domains/prompts/registry.valid.json --backend claude
calyx prompts validate --registry fixtures/domains/prompts/registry.valid.json --strict
```

### Agents index / render-profiles / deploy / sync / validate

```bash
calyx agents index --registry fixtures/domains/agents/registry.valid.json
calyx agents render-profiles --registry fixtures/domains/agents/registry.valid.json --json
calyx agents deploy --registry fixtures/domains/agents/registry.valid.json --backend claude
calyx agents validate --registry fixtures/domains/agents/registry.valid.json --strict
```

### Knowledge index / search / link / validate

```bash
calyx knowledge index --registry fixtures/domains/knowledge/registry.valid.json
calyx knowledge search --registry fixtures/domains/knowledge/registry.valid.json --query "exec"
calyx knowledge link --registry fixtures/domains/knowledge/registry.valid.json \
  --artifact execplan-unified-agents --issue POL-605
calyx knowledge validate --registry fixtures/domains/knowledge/registry.valid.json --strict
```

### Exec launch / status / logs / receipt / validate

```bash
calyx exec launch --store fixtures/domains/exec/store.valid.json --command "calyx config compile --host blade"
calyx exec status --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec logs --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec receipt --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

## Migration status

Legacy `dev/run/*` compatibility wrappers were retired in P9 (2026-03-02). All operator workflows now use canonical `calyx <domain> <verb>` commands exclusively. Invoking a retired wrapper name produces a clear error with the canonical replacement.

See [docs/migration-wrappers.md](docs/migration-wrappers.md) for the full history and replacement map, or [docs/migration-guide.md](docs/migration-guide.md) for the migration reference.

## Documentation

| Document | Description |
|----------|-------------|
| [Onboarding Guide](docs/onboarding.md) | First-time setup, quickstart, and surface orientation |
| [Production Wiring](docs/production-wiring.md) | Environment variables, config file, and source resolution |
| [CLI Reference](docs/cli-reference.md) | Complete command reference for all 8 domains |
| [Extension SDK](docs/extension-sdk.md) | SDK contracts, lifecycle hooks, and quick start |
| [Migration Guide](docs/migration-guide.md) | Step-by-step legacy → calyx transition |
| [Migration Wrappers](docs/migration-wrappers.md) | Wrapper replacement map and telemetry |
| [RC Checklist](docs/rc-checklist.md) | Release candidate checklist, promotion paths, and rollback |
| [Operator Runbook](docs/operator-runbook.md) | Canonical operator reference for daily Calyx-first operations |
| [CI Reliability Runbook](docs/ci-reliability-runbook.md) | CI failure taxonomy, decision tree, and override policy |
| [Post-GA Support Playbook](docs/post-ga-support-playbook.md) | Support ownership, intake, severity classification, and first-week cadence |
| [Post-GA Watchlist](docs/post-ga-watchlist.md) | Telemetry signals, package health checks, and monitoring commands |
| [Post-GA Incident Checklist](docs/post-ga-incident-checklist.md) | Incident response steps for install, publish, auth, and CI failures |
| [Skills Subsumption Catalogue](docs/skills-subsumption-catalogue.md) | Authoritative skill-by-skill disposition, retirement sequencing, and migration mapping |
| [ADR-0002](docs/adr/adr-0002-repo-structure-and-build.md) | Repo structure, build, and naming decisions |

## Release

Tag-triggered publishing via GitHub Actions. See [docs/rc-checklist.md](docs/rc-checklist.md) for the full release process.

```bash
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```
