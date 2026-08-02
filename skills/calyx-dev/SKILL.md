---
name: calyx-dev
description: >-
  Router into the Calyx control-plane repo (polli-labs/calyx-dev). It points to
  the repo's canonical posture — AGENTS.md, docs/architecture, CONTRIBUTING —
  and carries only cross-skill routing and scope boundaries, not deep
  architecture or command detail. Load it when editing or reviewing Calyx
  implementation code, designing a command or provider, or debugging
  run-substrate behavior, then read the repo docs it points to. Pair with
  calyx-systems (agents-infra propagation) and calyx-fleet-ops (fleet daemon
  health, drift, self-upgrade).
version: "0.5.0"
metadata:
  short-description: "Router into the Calyx control-plane repo's canonical docs"
triggers:
  - calyx-dev
  - calyx command surface
  - calyx core package
  - calyx extension SDK
  - calyx run-service
  - calyx runner adapter
  - calyx daemon
---

# Calyx Dev — router

This skill is a **router**, not a posture surface. The Calyx repo owns its
architecture and contributor guidance; read it there, and keep it current there.
Do not re-grow a command encyclopedia or a per-PR changelog in this file.

## Start here (in the calyx-dev repo)

1. `AGENTS.md` — mental model, workspace map, key surfaces, build & verify.
2. `docs/architecture/README.md` — the current substrate (primitives + the design laws) + where current truth lives (Linear + recency-filtered vault). Legacy `docs/` is zero-trust.
3. `CONTRIBUTING.md` — engineering principles (defended LoC, no compat shims,
   absorption discipline, …) + the green gate (`pnpm verify`, Node 22) + the
   risk-proportional review posture.
4. `docs/onboarding.md`, `docs/operator-runbook.md`, `docs/extension-sdk.md` — setup, daily ops, and the extension contract.

(Paths are relative to the calyx-dev repo root.)

## Active program

A substrate transformation (Symphony-ready v2) is in flight; its master plan +
wave charters live in the vault and add scope-time gates for substrate / run /
interface-governance work:
`~/vault/fieldwork/50-projects/calyx/workstreams/active/calyx-v2-symphony-ready-master-plan.md`
(+ the current `wave-N-charter.md`). Read them before scoping that kind of work.

## First moves

1. Read `AGENTS.md` + the task-relevant doc above.
2. `git status --short` in the target worktree before editing; work in a worktree, not the clean clone.
3. Node 22 + the repo `pnpm` lockfile; `pnpm verify` is the green gate.
4. If a merged change affects live daemons, switch to `calyx-fleet-ops` for the post-merge health/drift/upgrade ritual.

## Boundary — when to load a neighboring skill

| Task | Primary skill |
| --- | --- |
| Edit `agents-infra` skills, templates, `SOURCES.json`, rendered hot surfaces, or harness config | `calyx-systems` |
| Fleet daemon health, drift classification, `calyx self upgrade`, recover broken run-service hosts | `calyx-fleet-ops` |
| Launch / monitor / land async work via `calyx run` | `orchestrate` + `polli-dev-conventions/references/calyx.md` |
| Org-wide TypeScript, PR, release, or review policy | `polli-dev-conventions` |
| Vault artifact conventions | `fieldwork-vault` |

For mixed tasks, use this skill (→ repo docs) for implementation and the
neighboring skill for the operational follow-through.

## Scope boundaries (route, don't repeat)

- **Repo architecture / packages / extension model / primitives** → calyx-dev `AGENTS.md` + `docs/architecture/`.
- **Engineering principles, green gate, review posture** → calyx-dev
  `CONTRIBUTING.md` (+ org-wide `polli-dev-conventions`).
- **Operator `calyx run` guidance** → `polli-dev-conventions/references/calyx.md`.
- **Active continuity / wave context** → vault `50-projects/calyx/workstreams/`.
- **Issue tracking** → Linear "Agents Tooling (Ongoing)".

These surfaces must not duplicate each other. This skill routes; the repo and the
neighboring skills hold the content.

## Self-maintenance

Update this **router** only when the routing changes — a doc moves, or a
neighboring skill's scope shifts. Architecture, command, and contract detail
belong in the repo docs it points to. Edit the source in the calyx-dev repo
(`skills/calyx-dev/`), then run `calyx skills sync` (it resolves this
repo-maintained skill from the local calyx-dev clone). Use `calyx-systems` for
`SOURCES.json` / backend-sync receipts.
