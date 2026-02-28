# calyx-dev

Private development monorepo for the Calyx agent control plane.

## Workspace layout

- `packages/core` - config compiler and core contracts (`@polli-labs/calyx-core`)
- `packages/cli` - `calyx` CLI (`@polli-labs/calyx`)
- `packages/sdk` - extension SDK contracts (`@polli-labs/calyx-sdk`)
- `packages/web` - web companion placeholder (`@polli-labs/calyx-web`)
- `fixtures/config-compiler` - P1A compiler fixtures (inputs + staged expected outputs)
- `fixtures/instructions` - P2A instruction renderer fixtures (template, partials, host/fleet context, expected outputs)
- `fixtures/domains` - domain registry fixtures (skills, tools, prompts, agents, knowledge, exec)
- `docs/cli-reference.md` - complete CLI command reference
- `docs/migration-wrappers.md` - legacy-to-calyx replacement map

## Local verification

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Domain commands

The CLI is organized into 8 domain command groups plus compatibility wrappers.

### Config compile

```bash
node packages/cli/dist/bin.js config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

### Instructions render / verify

```bash
node packages/cli/dist/bin.js instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade

node packages/cli/dist/bin.js instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

### Skills index / sync / validate

```bash
node packages/cli/dist/bin.js skills index \
  --registry fixtures/domains/skills/registry.valid.json

node packages/cli/dist/bin.js skills sync \
  --registry fixtures/domains/skills/registry.valid.json \
  --backend codex

node packages/cli/dist/bin.js skills validate \
  --registry fixtures/domains/skills/registry.valid.json --strict
```

### Tools index / sync / validate

```bash
node packages/cli/dist/bin.js tools index \
  --registry fixtures/domains/tools/registry.valid.json

node packages/cli/dist/bin.js tools sync \
  --registry fixtures/domains/tools/registry.valid.json --all

node packages/cli/dist/bin.js tools validate \
  --registry fixtures/domains/tools/registry.valid.json --strict
```

### Prompts index / sync / validate

```bash
node packages/cli/dist/bin.js prompts index \
  --registry fixtures/domains/prompts/registry.valid.json

node packages/cli/dist/bin.js prompts sync \
  --registry fixtures/domains/prompts/registry.valid.json --backend claude

node packages/cli/dist/bin.js prompts validate \
  --registry fixtures/domains/prompts/registry.valid.json --strict
```

### Agents index / render-profiles / deploy / sync / validate

```bash
node packages/cli/dist/bin.js agents index \
  --registry fixtures/domains/agents/registry.valid.json

node packages/cli/dist/bin.js agents render-profiles \
  --registry fixtures/domains/agents/registry.valid.json --json

node packages/cli/dist/bin.js agents deploy \
  --registry fixtures/domains/agents/registry.valid.json --backend claude

node packages/cli/dist/bin.js agents validate \
  --registry fixtures/domains/agents/registry.valid.json --strict
```

### Knowledge index / search / link / validate

```bash
node packages/cli/dist/bin.js knowledge index \
  --registry fixtures/domains/knowledge/registry.valid.json

node packages/cli/dist/bin.js knowledge search \
  --registry fixtures/domains/knowledge/registry.valid.json --query "exec"

node packages/cli/dist/bin.js knowledge link \
  --registry fixtures/domains/knowledge/registry.valid.json \
  --artifact execplan-unified-agents --issue POL-605

node packages/cli/dist/bin.js knowledge validate \
  --registry fixtures/domains/knowledge/registry.valid.json --strict
```

### Exec launch / status / logs / receipt / validate

```bash
node packages/cli/dist/bin.js exec launch \
  --store fixtures/domains/exec/store.valid.json --command "calyx config compile --host blade"

node packages/cli/dist/bin.js exec status \
  --store fixtures/domains/exec/store.valid.json --run-id run-001

node packages/cli/dist/bin.js exec logs \
  --store fixtures/domains/exec/store.valid.json --run-id run-001

node packages/cli/dist/bin.js exec receipt \
  --store fixtures/domains/exec/store.valid.json --run-id run-001

node packages/cli/dist/bin.js exec validate \
  --store fixtures/domains/exec/store.valid.json --strict
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

See [docs/migration-wrappers.md](docs/migration-wrappers.md) for the full replacement map and retirement policy.
