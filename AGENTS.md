# Calyx — agent & contributor guide

Calyx is the development monorepo for the **Calyx control plane**: a
contract-first TypeScript CLI and runtime stack for config, local runtime
convergence, instructions, registries, vault/knowledge workflows, and durable
run orchestration across an agent fleet. Typed domain commands replace shell
scripts; a run substrate executes and reconciles work; an authenticated HTTP
daemon exposes it to other tools.

**Start here:** [`README.md`](README.md) → [`docs/onboarding.md`](docs/onboarding.md)
→ [`docs/architecture/README.md`](docs/architecture/README.md) (mental model +
primitives) → [`CONTRIBUTING.md`](CONTRIBUTING.md) (engineering principles + the
green gate).

> **Active program.** A multi-wave substrate transformation (Symphony-ready v2)
> is in flight; while it is, its master plan + active wave charter add scope-time
> gates for substrate / run / backend-capability / interface-governance work.
> They live in the vault, not here —
> `~/vault/fieldwork/50-projects/calyx/workstreams/active/calyx-v2-symphony-ready-master-plan.md`
> (+ the current `wave-N-charter.md`). Read them before scoping that kind of
> work; everything below is the durable repo posture.

## Build & verify

- **Node 22** (the root `engines.node` floor) and the repo `pnpm` lockfile.
- `pnpm install --frozen-lockfile`
- `pnpm verify` — the green gate; run it before any PR or handoff that claims repo health.
  It builds once up front, then lints, typechecks, tests, and checks the client
  package + contract, printing a per-phase wall-time summary. It is self-contained
  from a frozen-lockfile install; it never relies on a warm `dist/`.
- `pnpm verify:cold` — the same gate with every `packages/*/dist` removed first.
  Same result, or the build graph has regressed.
- `node packages/cli/dist/bin.js --help` — exercise the built CLI.

Work in a worktree (`~/dev/calyx/wt/<branch>`), not the clean clone. Treat
`~/dev/calyx/dev` as a build/work surface; daemons serve from
`~/.calyx/installs/current` (a clone serving path is a `calyx doctor` error).

## Workspace map

`pnpm` monorepo (`packages/*`, `examples/*`); the table below is the current package map.

| Package | Role |
| --- | --- |
| `@polli-labs/calyx-sdk` | Public extension contract: domains, manifest, hooks, validation |
| `@polli-labs/calyx-core` | Domain logic: config compile, instructions, registries, vault, extension discovery |
| `@polli-labs/calyx` | The `calyx` CLI and **composition root** (`packages/cli/src/run-cli.ts`) |
| `@polli-labs/calyx-runner` | Execution runtime: adapters, worktrees, classifier, receipts |
| `@polli-labs/calyx-run-service` | Run store, kernels, reconciliation, daemon/workflow loop |
| `@polli-labs/calyx-server` | Authenticated HTTP control plane over `RunService` |
| `@polli-labs/calyx-client` | Generated capability-separated consumer/admin transport over the HTTP contract |
| `@polli-labs/calyx-web` | Knowledge browse/search surface |
| `calyx-ext-{codex,linear,polli,cursor}` | Runtime + advisory extensions |

## Key surfaces

- **Composition root:** `packages/cli/src/run-cli.ts` (wires core + run-service + runner + server + ext factories).
- **Core contracts & domain logic:** `packages/core/src/`.
- **Extension SDK:** `packages/sdk/src/index.ts` (+ [`docs/extension-sdk.md`](docs/extension-sdk.md)).
- **Run substrate:** `packages/runner/src/`, `packages/run-service/src/`.
- **HTTP control plane:** `packages/server/src/server.ts`.
- **Interface manifest** — the current hand-authored operation catalog and
  partial drift-check substrate: `packages/core/src/interface-manifest.ts`.

## Engineering principles

The durable rules — defended LoC, no backwards-compat shims, no `*_v2` files,
two-callers-before-an-abstraction, absorption discipline, receipts-with-PRs, the
composition-root / feature-gate / adapter-validation disciplines, and the
evidence-first, risk-proportional review posture — live in
[`CONTRIBUTING.md`](CONTRIBUTING.md).
Read it before opening a PR.

## Docs & skill maintenance

- **The repo owns posture.** Architecture and contributor guidance live in
  `AGENTS.md` + `docs/` — keep them canonical and current. `CLAUDE.md` is a
  symlink to this file.
- **`skills/calyx-dev/SKILL.md` is a router**, not a second posture surface: it
  points here and into `docs/` and carries only cross-skill routing. When you
  change package layout, commands, contracts, or run-service architecture,
  update the canonical doc (`AGENTS.md` / `docs/`) — never a parallel copy in the
  skill.
- Commander registration, `docs/cli-reference.md`, `agent-context`, and the
  interface manifest are still separate authoring surfaces. Keep covered
  records coherent through `docs-coherence.test.ts`; do not claim generation
  until the generator replaces those paths.

## Scope boundaries (route, don't repeat)

| Need | Surface |
| --- | --- |
| Repo architecture, packages, primitives, extension model | `AGENTS.md` + `docs/architecture/` |
| Engineering principles, the green gate, review posture | `CONTRIBUTING.md` |
| Operator-facing `calyx run` launch/status/receipt guidance | `polli-dev-conventions/references/calyx.md` |
| Edit `agents-infra` skills/templates/`SOURCES.json`, propagate fleet content | `calyx-systems` skill |
| Fleet daemon health, drift, `calyx self upgrade` | `calyx-fleet-ops` skill |
| Active continuity / wave context | vault `50-projects/calyx/workstreams/` |
| Issue tracking | Linear project "Agents Tooling (Ongoing)" |
