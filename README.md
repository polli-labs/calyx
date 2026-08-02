# calyx-dev

Private development monorepo for the **Calyx control plane**: typed local and
fleet configuration, agent instructions, knowledge workflows, and durable run
orchestration behind one CLI and authenticated HTTP service.

## Current program

The active Symphony-ready v2 program lives in the shared Fieldwork vault, not
in repo documentation:

- [master plan](obsidian://open?vault=fieldwork&file=50-projects%2Fcalyx%2Fworkstreams%2Factive%2Fcalyx-v2-symphony-ready-master-plan)
- [workstream tracker](obsidian://open?vault=fieldwork&file=50-projects%2Fcalyx%2Fworkstreams%2Factive%2Fagent-growth-substrate)

The master plan and active wave charter add scope-time gates for substrate,
run, backend-capability, and interface-governance work. Repo docs describe
current code-adjacent contracts; they are not a program journal.

## Packages

| Package | Path | Role |
| --- | --- | --- |
| `@polli-labs/calyx-sdk` | `packages/sdk` | Public extension contracts and lifecycle hooks |
| `@polli-labs/calyx-core` | `packages/core` | Domain logic, registries, config, instructions, vault, and interface metadata |
| `@polli-labs/calyx` | `packages/cli` | CLI and composition root |
| `@polli-labs/calyx-runner` | `packages/runner` | Backend adapters, worktrees, classification, and receipts |
| `@polli-labs/calyx-run-service` | `packages/run-service` | Run store, kernels, reconciliation, and daemon loop |
| `@polli-labs/calyx-server` | `packages/server` | Authenticated HTTP control plane |
| `@polli-labs/calyx-client` | `packages/client` | Generated consumer and privileged-admin transport |
| `@polli-labs/calyx-web` | `packages/web` | Knowledge browse/search surface |
| `calyx-ext-codex` | `packages/calyx-ext-codex` | Codex run adapter package |
| `calyx-ext-polli` | `packages/calyx-ext-polli` | Polli advisory extension |
| `calyx-ext-linear` | `packages/calyx-ext-linear` | Linear advisory extension |
| `calyx-ext-cursor` | `packages/calyx-ext-cursor` | Cursor harness-target extension |

Extensions depend on `@polli-labs/calyx-sdk` and declare their hookable domains
in `package.json`. Canonical lifecycle semantics stay in Calyx core; extensions
are optional adapters or advisory overlays. See
[docs/extension-sdk.md](docs/extension-sdk.md).

## Start here

Requirements: Node 22 and the repository `pnpm` lockfile.

```bash
pnpm install --frozen-lockfile
pnpm verify
node packages/cli/dist/bin.js --help
```

Use:

- [`AGENTS.md`](AGENTS.md) for the repo map and contributor routing;
- [`docs/onboarding.md`](docs/onboarding.md) for installation and a short first
  workflow;
- [`docs/architecture/README.md`](docs/architecture/README.md) for the current
  control-plane model;
- [`docs/operator-runbook.md`](docs/operator-runbook.md) for standing
  operational procedures;
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for the green gate and engineering laws.

## Interface discovery

Runtime command registration currently lives in
`packages/cli/src/run-cli.ts`.

```bash
calyx --help
calyx <domain> --help
calyx agent-context --json
```

[`docs/cli-reference.md`](docs/cli-reference.md) is still a hand-authored,
partially drift-checked reference. The interface manifest in
`packages/core/src/interface-manifest.ts` classifies every visible top-level
domain and carries full records for a subset of operations; it does not yet
generate Commander help, the reference, or `agent-context`.

Data-bearing commands expose `--json` where their help documents it. JSON is
not a blanket property of every command.

## Source and runtime boundaries

- Work in a worktree, not the clean clone.
- `packages/cli/src/run-cli.ts` is the composition root.
- `agents-infra` owns shared instruction, skill, prompt, and fleet-config source
  truth.
- Daemons serve immutable installs under `~/.calyx/installs/current`, not a
  development checkout.
- Long-running or cross-host mutations belong in daemon-owned resumable state
  machines with durable receipts.

Production registry/store resolution and environment precedence are documented
in [docs/production-wiring.md](docs/production-wiring.md).

## Current documentation

| Document | Contract |
| --- | --- |
| [Architecture](docs/architecture/README.md) | Current substrate, primitives, and placement laws |
| [Consumer API](docs/architecture/consumer-api.md) | Capability and profile model |
| [Wire contracts](docs/architecture/wire-contracts.md) | Envelopes, errors, provenance, bounds, and streaming |
| [Session ingress](docs/architecture/session-ingress.md) | Exact activity binding and wake semantics |
| [Operator runbook](docs/operator-runbook.md) | Current operational procedures |
| [Production wiring](docs/production-wiring.md) | Source resolution and environment/config precedence |
| [Extension SDK](docs/extension-sdk.md) | Public extension contract |
| [CI reliability](docs/ci-reliability-runbook.md) | CI failure classification and override policy |
| [ADR-0001](docs/adr/adr-0001-runtime-and-packaging.md) | Runtime and packaging decision |
| [ADR-0002](docs/adr/adr-0002-repo-structure-and-build.md) | Repository structure and naming |

Historical plans, migration archaeology, rollout receipts, and release-era
checklists live in Git, Linear, or the vault rather than this current-state
documentation tree.

## Release

Publishing is tag-triggered through the repository workflows under
`.github/workflows/`. Treat the workflow and package manifests as current
release authority.
