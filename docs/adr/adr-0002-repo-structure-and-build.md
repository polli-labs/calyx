# ADR-0002: Repository Structure, Build System, Naming, Namespace, and Template Engine

Status: Accepted (P0 locked)
Date: 2026-02-26
Owners: POL-605 umbrella lane

## Context
P1 currently says "create repo scaffold" but does not define what scaffold to create. That leaves too much room for runner drift and incompatible implementation choices.

This ADR locks the bootstrap baseline for:
- repository identity,
- package naming and namespace strategy,
- workspace layout,
- build and CI system,
- runtime target and module strategy,
- extension ecosystem shape,
- template engine behavior for instruction rendering.

## Decision A: Repository Identity and Core Packages
### A1) GitHub repository
- GitHub org: `polli-labs`
- Primary development repo: `polli-labs/calyx-dev` (private)
- Public release repo: `polli-labs/calyx` (public)
- Remote convention:
  - `origin` -> `polli-labs/calyx-dev`
  - `public` -> `polli-labs/calyx`
- Flow convention:
  - all daily development and CI occur in `calyx-dev`
  - curated release syncs/tags are promoted to `calyx`
  - mirrors POL-499 private-dev/public pattern

### A2) Core package namespace
- `@polli-labs/calyx` (CLI package)
- `@polli-labs/calyx-core` (domain contracts + core runtime)
- `@polli-labs/calyx-sdk` (extension SDK)
- `@polli-labs/calyx-web` (human-facing companion surface)

### A3) CLI command contract
- Canonical command name: `calyx`
- v1 package exports `calyx` as the primary bin.
- Name is locked; no fallback CLI aliases are planned for P1.

### A4) Local workspace topology (POL-501 aligned)
- Clone path: `~/dev/calyx/dev` (tracks `origin` = `calyx-dev`)
- Worktrees: `~/dev/calyx/wt/<branch>`
- Optional read-only archive clones under `~/repo` are non-authoritative for new work.

## Decision B: Name Lock and Availability Record
Name lock source:
- locked in Claude lane and posted to `POL-605` with availability receipts and rationale.

Decision impact:
- treat `calyx` as final for P0/P1 planning and implementation,
- remove provisional naming language from planning docs,
- move forward with namespace design around `calyx`,
- keep POL-499/POL-501 topology as the default operational path.

## Decision C: Monorepo Layout
Use a pnpm workspace with explicit package boundaries:

```text
calyx/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/workflows/
    ci.yml
    release.yml
    smoke.yml
  packages/
    core/         # @polli-labs/calyx-core
    cli/          # @polli-labs/calyx
    sdk/          # @polli-labs/calyx-sdk
    web/          # @polli-labs/calyx-web
  fixtures/
    config-compiler/
      inputs/
      expected/
  docs/
    adr/
    execplans/
```

Notes:
- `packages/web` may stay minimal in P1 and grow in P3+.
- `fixtures/config-compiler` is first-class from day one to enforce parity discipline.

## Decision D: Build Tooling and Test Stack
### D1) Package manager
- `pnpm` workspace (single lockfile)

### D2) Build tool
- `tsup` for package builds (fast ESM output, CLI bundling with shebang support)
- `tsc --noEmit` for type checking as a separate gate

### D3) Test and lint
- `vitest` for unit/integration tests
- `eslint` + `@typescript-eslint` for linting
- `prettier` for formatting consistency

### D4) Release
- npm publish via GitHub Actions with provenance enabled
- release tags drive publish workflow; no manual local publish path for v1

## Decision E: CI Pipeline Shape
### E1) `ci.yml` (required on PR)
Runs on `ubuntu-latest`:
1. install (`pnpm install --frozen-lockfile`)
2. lint (`pnpm lint`)
3. typecheck (`pnpm typecheck`)
4. test (`pnpm test`)
5. build (`pnpm build`)

### E2) `smoke.yml` (required on PR)
Matrix: `ubuntu-latest`, `macos-latest`:
1. build CLI package
2. run `calyx --help`
3. run `calyx config --help`

### E3) `release.yml` (tag-triggered)
1. run full CI gates
2. publish scoped packages
3. attach changelog + artifact checksums

## Decision F: Runtime Target and Module Strategy
- Node target: `>=22` (LTS baseline)
- TypeScript target: `ES2022`
- Module strategy: ESM-only for v1

Why ESM-only:
- aligns with modern Node tooling and current Polli TS direction,
- reduces dual-build complexity in the proving lane,
- keeps import/exports and loader behavior deterministic.

Fallback policy:
- if a high-value integration strictly requires CJS entrypoints, add a narrow CJS compatibility shim in a follow-up phase; do not dual-publish everything in P1.

## Decision G: Namespace and Extension Ecosystem Plan
### G1) First-party extension namespace
- `calyx-ext-polli`
- `calyx-ext-linear`
- `calyx-ext-codescan`
- `calyx-ext-notify`
- `calyx-ext-b2`

### G2) Harness-target extension namespace
- `calyx-ext-cursor`
- `calyx-ext-aider`
- `calyx-ext-continue`
- `calyx-ext-windsurf`
- `calyx-ext-zed`

### G3) Community extension namespace
- unscoped: `calyx-ext-<name>`
- scoped: `@user/calyx-ext-<name>`

### G4) Extension manifest key
- package manifest uses a top-level `calyx` key in `package.json` for extension metadata and compatibility declaration.

## Decision H: Template Engine Strategy
Current renderer in `polli` is not full Mustache; it performs:
- token replacement (`{{VAR}}`),
- partial includes (`{{> partial}}`),
- no conditionals/loops/escaping semantics.

Decision:
- keep this constrained renderer model for v1 of the unified package,
- formalize it as a deterministic "token + partial" renderer,
- do not adopt Handlebars/EJS/Mustache-proper in P1/P2.

Rationale:
- minimal moving parts in critical migration lane,
- deterministic output is easier to parity-test,
- avoids injecting template-language complexity before core contracts stabilize.

Revisit triggers:
- two or more concrete use cases require conditionals/iteration that cannot be handled by precomputed context,
- or renderer complexity starts leaking into caller code in a way that hurts maintainability.

## Consequences
Positive:
- P1 can start without scaffold ambiguity.
- Name and namespace are stable for implementation planning.
- Repo promotion model (private `-dev` -> public) is explicit before coding.
- CI/build contracts are runner-operable.
- Extension ecosystem boundaries are explicit before coding.

Tradeoffs:
- ESM-only may require targeted shims for some consumers.
- constrained renderer may require revisiting once extension ecosystem matures.

## Implementation Checklist (P0 lock criteria covered by this ADR)
- [x] repo/org decision
- [x] core package namespace decision
- [x] monorepo structure decision
- [x] build/CI decision
- [x] Node + module strategy decision
- [x] name lock alignment (`calyx`)
- [x] extension ecosystem namespace plan
- [x] template engine decision
