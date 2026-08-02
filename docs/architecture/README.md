# Calyx architecture

This page is the **current** mental model of the Calyx control plane — the
substrate as it is now, plus the laws that constrain how it grows. It is not a
history or a spec archive; for *where calyx's current plans and decisions live*,
see "Where current truth lives" below.

> New here? Read [`../onboarding.md`](../onboarding.md) for setup, then this page
> for the mental model + the laws, then [`consumer-api.md`](consumer-api.md) for
> the ratified capability model behind the consumer API/SDK,
> [`wire-contracts.md`](wire-contracts.md) for how every typed surface speaks,
> and [`workflow-engine.md`](workflow-engine.md) for the caller-first admission
> contract governing any future shared coordination layer.

## Mental model

Three layers, bottom to top:

- **Contracts & domain logic** — `@polli-labs/calyx-core` (registries, config
  compile, instructions, vault, extension discovery) and `@polli-labs/calyx-sdk`
  (the public extension contract). The CLI imports these directly.
- **Execution substrate** — `@polli-labs/calyx-runner` (adapters, worktrees,
  classifier, receipts) and `@polli-labs/calyx-run-service` (run store, kernels,
  reconciliation, and the daemon control loop). Durable, resumable,
  host-routed.
- **Surfaces** — `@polli-labs/calyx` (the CLI and composition root),
  `@polli-labs/calyx-server` (the authenticated HTTP control plane over
  `RunService`), `@polli-labs/calyx-client` (generated consumer and explicitly
  privileged admin projections of that capability contract), and
  `@polli-labs/calyx-web`. How humans, agents, and other programs reach the
  substrate.

Package roles + the composition root (`packages/cli/src/run-cli.ts`) are mapped
in [`../../AGENTS.md`](../../AGENTS.md).

**Design law:** CLI commands are request/observation surfaces. Long-running or
cross-host mutations belong in daemon-owned resumable state machines with
persisted state, evidence, explicit declared compensation where possible, and
operator-visible receipts. Calyx does not promise implicit rollback of
arbitrary external effects.

## Primitives (and the abstractions they earned)

Calyx's value is a small set of typed primitives that replaced ad-hoc scripts.
Each earned its abstraction by having real, repeated callers — not by being
designed up front.

| Primitive | Command surface | What it is |
| --- | --- | --- |
| **run** | `run launch/resume/status/await/ps/logs/receipt/doctor` | Durable, resumable, host-routed agent/process execution with typed receipts. The substrate everything else rides. |
| **activity** | `activity list/overview/turns/messages` | Cross-session recall over Codex/Claude/Calyx transcripts — read the swarm without parsing raw rollouts. |
| **monitor** | `monitor create/inbox/ack` | Typed wake records + delivery bindings (a Tier-0 store, optional push). Not a second daemon or scheduler. |
| **lease** | `lease acquire/renew/release` | Advisory conflict organ over named resources (`worktree:`/`session:`/`vault:`/`issue:`). |
| **msg** | `msg send/inbox/thread` | Directed agent-to-agent correspondence — claimable rows + TTL scope bulletins; distinct from `activity` recall. |
| **review** | `review` | The first sugar verb over launch-time agent definitions; returns a typed conduct receipt. |

Three cross-cutting contracts hold the current substrate together:

- **The wire contracts** ([`wire-contracts.md`](wire-contracts.md)) — how every
  typed surface speaks: envelopes and schema versioning, the `calyx.error/v1`
  contract, provenance actors, idempotency, submit-and-observe, bounds and
  pagination, streaming, locality, and profile-scoped auth.
- **The interface manifest** (`packages/core/src/interface-manifest.ts`,
  `calyx.interface-manifest/v0`) — a hand-authored catalog that classifies every
  visible top-level domain and carries full operation records for a subset of
  commands and HTTP surfaces. Commander remains runtime registration authority;
  `docs/cli-reference.md` and `calyx agent-context` remain separately authored.
  Current tests check selected coherence across them, but no generator exists
  yet. The manifest anchors *operation metadata and drift control* without
  becoming the consumer API's resource model (see "Projections over
  capabilities" below).
- **The extension SDK** (`@polli-labs/calyx-sdk`) — the public contract third
  parties build against: eight hookable domains plus manifest + lifecycle hooks.
  See [`../extension-sdk.md`](../extension-sdk.md).

The [workflow-coordination admission contract](workflow-engine.md) constrains a
possible future shared reducer. No generic workflow engine exists today. It may
be extracted only after two caller-specific state machines independently soak
and the extraction deletes their proven duplication.

## Projections over capabilities

**Design law.** A *capability* is something Calyx can do over a shared store —
recall a session, mark a turn high-signal, lease a resource, launch a run. The
**CLI command groups, the daemon HTTP routes, and any SDK namespaces are
different projections over those capabilities** — shaped for a shell-literate
agent, a network client, and a typed app respectively. They are siblings, not a
hierarchy; none is the source of the others.

The interface manifest is the current **drift-control and operation-metadata**
catalog across these projections. Its partial records and coherence tests do
not make it the source of Commander, docs, or the consumer API's resource
model. The existence of a top-level CLI noun is **not** a reason to expose a
consumer endpoint. A consumer API is designed from the capability inward:
[`consumer-api.md`](consumer-api.md) is its spine, and the
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) "consumer-API review gate" is the
entry check.

## Where current truth lives

This repo is mid-reorientation: for most of its life calyx was an agent-owned
repo whose plans, decisions, and postures landed in **Linear** and the **vault**,
not here. So:

- **Plans / decisions / RFCs / status** → **Linear** (the Calyx project) + the
  **vault** (`30-reports/` · `20-plans/` · `40-context/` · `50-projects/calyx/`),
  read **recency-first**. That is the canonical record — not `docs/`.
- **What is true *now* and must stay true** → here (`AGENTS.md` + `docs/`), as
  current, code-adjacent, PR-reviewed contracts. The capability model
  ([`consumer-api.md`](consumer-api.md)) is the first piece authored under this
  posture; more land as the reorientation proceeds.
- **Zero-trust the legacy `docs/`.** Much of the existing tree predates this
  reorientation and was never owned — verify currency before trusting any file,
  and do not treat it as canonical. The currency audit + retirement is **POL-1902**.
  *(Exception worth keeping the shape of: a few docs are genuinely code-adjacent —
  e.g. the runner contract in `async-runner-vnext-contracts.md`, referenced by
  `@see` from `packages/runner` — that is the form `docs/` should take, pending a
  currency pass.)*

## See also

- [`../onboarding.md`](../onboarding.md) — setup + quickstart.
- [`session-ingress.md`](session-ingress.md) — exact activity binding, pointer-only wakes, private IPC, and no-auto-ack law.
- [`../operator-runbook.md`](../operator-runbook.md) — daily operations.
- [`../extension-sdk.md`](../extension-sdk.md) — the extension contract.
- [`workflow-engine.md`](workflow-engine.md) — the caller-first durable
  coordination admission law and proof bar.
- [`../adr/`](../adr/) — accepted architecture decisions.
- [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) — engineering principles + the
  green gate + the consumer-API & documentation-ownership gates.
