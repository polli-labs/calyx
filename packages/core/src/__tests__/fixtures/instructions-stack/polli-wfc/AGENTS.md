---
title: "Polli Monorepo Agent Guide"
doc_type: "agents"
status: "active"
owner: "polli-labs"
last_modified: "2026-07-17T00:00:00Z"
last_reviewed: "2026-07-17T00:00:00Z"
scope: "monorepo"
---

# Polli Monorepo Agent Guide

This repo is Polli's active frontend product workspace. It is not the org
knowledge base, report archive, fleet-ops repo, generic agent-tool installer,
or historical prototype graveyard.

Load `skills/polli-monorepo/SKILL.md` before modifying this repo. That skill is
the main curriculum; this file is the routing card.

## Branch Rules

`main` is protected:

- no direct pushes to `main`;
- a PR is required and review conversations must be resolved;
- `website-build` and `explorer-build` are always required status checks for
  merges to `main`; each workflow may internally fast-path when its surface is
  unaffected;
- the GitHub ruleset requires zero approving reviews. For nontrivial changes,
  repo convention still requires two independent skeptical agent reviews.
- visually-affecting Explorer changes additionally get a **design-lens
  review** (HUX, polish, cross-experience consistency — e.g. the
  emil-design-eng / make-interfaces-feel-better / web-design-guidelines
  lenses), and every composite gets one before a production deploy nod.
  Correctness review does not substitute for it.

If merge is blocked, read the PR banner for the exact requirement.

## Fresh Worktree Baseline

Use Node `^20.0.0 || ^22.0.0 || ^24.0.0` with `corepack enable`; the root
`packageManager` pin selects pnpm. WFC browser evidence additionally needs real
Chrome.

```bash
pnpm bootstrap:worktree
pnpm verify
```

`pnpm bootstrap:worktree` performs the frozen install and dependency check;
`pnpm verify` covers repo-wide contracts. Use the changed app's build/test gate
as well. The [dev-server guide](skills/polli-monorepo/references/dev-server-guide.md)
owns preview lanes and the legacy `VITE_API_URL` proxy exception.

Use `~/dev/polli/dev` as the clean clone and `~/dev/polli/wt/<branch>` for
editing worktrees. Do not edit the clean clone except for fast-forward pulls and
diagnostics. After your PR merges, remove the worktree
(`git -C ~/dev/polli/dev worktree remove ../wt/<branch>`); `make worktree.stale`
lists cleanup candidates.

## Active Map

| Surface | Purpose |
|---|---|
| `apps/website` | Next.js marketing site for `polli.ai`. |
| `apps/explorer` | Explorer host; current public experience is WFC at `demo.polli.ai/wfc`. |
| `apps/explorer/src/host` | Explorer host substrate: providers, routing, runtime params, embed behavior. |
| `apps/explorer/src/features/wfc4` | Active WFC v4 engine and route implementation. **Read `src/features/wfc4/DESIGN.md` (design language + decision locks) before any WFC v4 visual, motion, or copy change.** |
| `apps/explorer/src/features/wfc` | WFC v3 fallback, data, and compatibility tests. |
| `packages/ui` | Brand assets, tokens, Tailwind preset, fonts, and narrow brand helpers. |
| `packages/config` | Shared frontend config. |
| `docs/monorepo-surface-ledger.md` | Active/deleted/extracted/compatibility surface ledger. |
| `skills/polli-monorepo` | Repo-managed project skill source. |

Dash is historical vocabulary only. Do not recreate `apps/dash`, `@polli/dash`,
or old dashboard/gallery/video route surfaces without a new issue and explicit
product need.

## Product Boundaries

Use this model:

- **Durable app**: long-lived product surface with deploy target, tests,
  ownership, and guidance. Current apps are Website and Explorer.
- **Experience**: app-local product instance inside a durable app. WFC is the
  current Explorer experience.
- **Product lab**: exploratory product concept that has not earned durable app
  or shared package surface.

Product-lab ideas should start in Fieldwork and/or Linear RFCs before adding
new durable repo directories. Shared abstractions require real consumers; until
reuse is real, keep UI, state, data contracts, and scripts app-local.

## Deployment Risk

- Website changes need `pnpm --filter @polli/website run verify:content` and
  `pnpm --filter @polli/website build`; Vercel Git integration owns deployment.
- Explorer deploys are CLI-driven: `with-polli-secrets make
  wfc-demo.deploy-vercel PROD=1`. Its required checks, evidence ladder, and
  rollback live in the [deploy guide](skills/polli-monorepo/references/deploy-guide.md).
- `ci:held-candidate` selects the Website CI fast path; `ci:run-frontend`
  requests full hosted frontend validation.

## `@polli/ui`

`@polli/ui` is the shared brand/tokens/assets/fonts package, not a component
library. Keep app UI local; root and `components/*` imports are forbidden.
Run `pnpm audit:ui-package` before changing that boundary.

## Content Placement

Tasks/status → Linear; code/PRs/CI → GitHub; durable knowledge → Fieldwork;
executable local truth → nearby repo docs; deeper injected curriculum →
`skills/polli-monorepo/SKILL.md`; fleet configuration → agents-infra. Do not
restore org-kb, report, runbook, or generic agent-tool residue here.

## Retired Surface Policy

POL-1281 removed historical `reports/**`, `tools/**`, `ops/**`, `configs/**`,
repo-ops archives under `dev/**`, `tests/dev/run/**`, old org-kb docs, and
broad agent-tool wrappers.

Retained `dev/run/**` entries are temporary compatibility shims. Do not add new
consumers; see `docs/monorepo-surface-ledger.md` for owner/reason/expiry.

Surviving agentops service definitions moved to
`frontierkodiak/configs/services/agentops/blade/**`; the live blade cutover
completed 2026-06-10 (POL-1739/POL-1751 — telemetry+zotero migrated, the rest
retired). No blade service runs from this repo.

## Instruction Maintenance

Keep the two root guidance mirrors byte-identical and aligned with
`skills/polli-monorepo/SKILL.md`. Run:

```bash
python3 scripts/validate-skills.py
git diff --check
```

`python3 scripts/validate-skills.py` is executable truth: it fails on root,
Explorer, or WFC mirror drift; tracked `.codex`/`.remote-body` residue; invalid
documented shell commands; and expired or malformed `Expiry:` markers.
