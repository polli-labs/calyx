# calyx-dev

Private development monorepo for the Calyx agent control plane.

## Workspace layout

- `packages/core` - config compiler and core contracts (`@polli-labs/calyx-core`)
- `packages/cli` - `calyx` CLI (`@polli-labs/calyx`)
- `packages/sdk` - extension SDK contracts (`@polli-labs/calyx-sdk`)
- `packages/web` - web companion placeholder (`@polli-labs/calyx-web`)
- `fixtures/config-compiler` - P1A compiler fixtures (inputs + staged expected outputs)

## P1A verification

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
