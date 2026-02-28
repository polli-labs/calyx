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

See [docs/extension-sdk.md](docs/extension-sdk.md) for the full SDK reference and [examples/calyx-ext-hello](examples/calyx-ext-hello) for a working sample extension.

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

## Local verification

```bash
pnpm install
pnpm verify   # lint → typecheck → test → build
```

Individual stages can also be run separately: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

See [CI Reliability Runbook](docs/ci-reliability-runbook.md) for failure classification and CI override policy.

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
calyx exec status --store fixtures/domains/exec/store.valid.json --run-id run-001
calyx exec logs --store fixtures/domains/exec/store.valid.json --run-id run-001
calyx exec receipt --store fixtures/domains/exec/store.valid.json --run-id run-001
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

## Migration wrappers

Compatibility wrappers forward legacy `dev/run/*` entrypoints to canonical calyx subcommands, emitting deprecation warnings and `calyx.wrapper.invoked` telemetry markers.

| Wrapper | Canonical command |
|---|---|
| `calyx skills-sync` | `calyx skills sync` |
| `calyx skills-sync-claude` | `calyx skills sync --backend claude` |
| `calyx skills-sync-codex` | `calyx skills sync --backend codex` |
| `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` |
| `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` |
| `calyx agents-render` | `calyx instructions render` |
| `calyx exec-launch` | `calyx exec launch` |

See [docs/migration-wrappers.md](docs/migration-wrappers.md) for the full replacement map and retirement policy, or [docs/migration-guide.md](docs/migration-guide.md) for a step-by-step migration walkthrough.

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Reference](docs/cli-reference.md) | Complete command reference for all 8 domains |
| [Extension SDK](docs/extension-sdk.md) | SDK contracts, lifecycle hooks, and quick start |
| [Migration Guide](docs/migration-guide.md) | Step-by-step legacy → calyx transition |
| [Migration Wrappers](docs/migration-wrappers.md) | Wrapper replacement map and telemetry |
| [RC Checklist](docs/rc-checklist.md) | Release candidate checklist, promotion paths, and rollback |
| [CI Reliability Runbook](docs/ci-reliability-runbook.md) | CI failure taxonomy, decision tree, and override policy |
| [ADR-0002](docs/adr/adr-0002-repo-structure-and-build.md) | Repo structure, build, and naming decisions |

## Release

Tag-triggered publishing via GitHub Actions. See [docs/rc-checklist.md](docs/rc-checklist.md) for the full release process.

```bash
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```
