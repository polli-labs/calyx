# calyx-dev

Private development monorepo for the Calyx agent control plane.

## Workspace layout

- `packages/core` - config compiler and core contracts (`@polli-labs/calyx-core`)
- `packages/cli` - `calyx` CLI (`@polli-labs/calyx`)
- `packages/sdk` - extension SDK contracts (`@polli-labs/calyx-sdk`)
- `packages/web` - web companion placeholder (`@polli-labs/calyx-web`)
- `fixtures/config-compiler` - P1A compiler fixtures (inputs + staged expected outputs)
- `fixtures/instructions` - P2A instruction renderer fixtures (template, partials, host/fleet context, expected outputs)

## Local verification

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Config compile example

```bash
node packages/cli/dist/bin.js config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

## Instructions render example

```bash
node packages/cli/dist/bin.js instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade
```

## Instructions verify example

```bash
node packages/cli/dist/bin.js instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```
