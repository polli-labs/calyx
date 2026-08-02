# ADR-0001: Core Runtime and Packaging Strategy

Status: Accepted (P0 locked)
Date: 2026-02-26
Owners: POL-605 umbrella lane

## Context
The unified package must be publishable, harness-agnostic, and capable of porting existing operational logic currently spread across TypeScript/Node, Bash, and Python wrappers.

Current landscape (observed):
- TypeScript/Node: `agents:render`, portions of truth-store and script tooling
- JavaScript/Node: `agents-fleet`, `agents-fleet-apply`
- Bash: wrapper and sync orchestration (`dev/run/*`)
- Python: `async-runner` and portions of docstore helper logic

## Decision
Use **TypeScript/Node** as the core runtime for `calyx-core` + `calyx` CLI.

### Why
- Best porting path from currently active logic that already runs in Node/TS.
- Straightforward npm publish/distribution model for open-source release.
- Strong ecosystem for YAML/JSON schema handling and TOML serialization.
- Cross-platform CLI packaging options are mature.

### What this is not
- Not a rejection of Python. Python remains a first-class integration target via extensions and subprocess adapters.
- Not a requirement to rewrite all existing Python/Bash capabilities immediately.

## Alternatives considered
### Python-first core
Pros:
- Strong agent ecosystem and packaging with `uv`.
- Existing `async-runner` implementation alignment.

Cons:
- Higher near-term migration burden from existing Node-based config/render flows.
- More friction for npm-oriented publish/discovery expectations.

### Mixed-language core from day one
Pros:
- Max flexibility.

Cons:
- Higher architecture/packaging complexity before first useful release.
- Harder to enforce stable core contracts.

## Consequences
Positive:
- Faster P1 proving lane for config compiler and CLI baseline.
- Easier initial publish path.

Negative / tradeoffs:
- Need explicit process boundary strategy for Python-backed subsystems.
- Need disciplined extension API to avoid Node-only assumptions.

## Implementation guidance
- Core package: TypeScript (ESM) with typed contracts.
- Extension SDK supports:
  - in-process JS/TS extensions
  - external command adapters (Python/Bash) via stable JSON IO contracts
- Add a `runtime-adapter` contract early to prevent lock-in.

## Revisit triggers
Re-open this ADR if either occurs:
- Python-backed domains dominate >60% of net-new implementation burden.
- Node packaging/operational constraints materially block adoption.

## Related decisions
- Repository/bootstrap/build decisions are locked in `adr-0002-repo-structure-and-build.md`.
- Name lock (`calyx`) and extension namespace strategy are tracked in ADR-0002.
