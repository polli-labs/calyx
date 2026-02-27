# ExecPlan POL-627

## Title
ExecPlan (Runner): P1A calyx bootstrap + config compiler proving lane

## Goal
Deliver the first implementation slice for calyx by completing P1A end-to-end:
1. establish POL-499/POL-501 repo/workspace topology for calyx (`calyx-dev` private origin + `calyx` public release remote),
2. scaffold the calyx monorepo baseline per ADR-0002,
3. implement only the config compiler proving lane with semantic parity harness,
4. open a PR in `polli-labs/calyx-dev` with verification receipts and links back to POL-627 + POL-605.

## Constraints
- Scope lock: config domain only. Do not implement P2/P3 domains.
- Runtime/tooling lock: Node >=22, ESM-only, pnpm workspace, tsup + vitest.
- Topology lock: local paths under `~/dev/calyx/dev` and `~/dev/calyx/wt/<branch>`.
- Repo topology lock: `origin=calyx-dev`, `public=calyx`.
- Parity lock: semantic TOML equivalence (parse + deep compare); formatting snapshots advisory-only.
- Secrets lock: no literal secrets in repo or test fixtures.

## Inputs
- ADR runtime: `/home/caleb/repo/work/weeks/2026-W09/2026-02-25_wed/unified-agents-package-reprompt-codex/planning/adr-0001-runtime-and-packaging.md`
- ADR repo/build/namespace: `/home/caleb/repo/work/weeks/2026-W09/2026-02-25_wed/unified-agents-package-reprompt-codex/planning/adr-0002-repo-structure-and-build.md`
- Config input spec: `/home/caleb/repo/work/weeks/2026-W09/2026-02-25_wed/unified-agents-package-reprompt-codex/planning/config-compiler-input-spec-v0.md`
- Migration map: `/home/caleb/repo/work/weeks/2026-W09/2026-02-25_wed/unified-agents-package-reprompt-codex/planning/migration-map-current-to-calyx-v0.md`
- Mega ExecPlan: `/home/caleb/repo/work/weeks/2026-W09/2026-02-25_wed/unified-agents-package-reprompt-codex/planning/execplan-unified-agents-package-implementation-mega.md`
- Staged output fixtures source:
  - `/home/caleb/repo/polli/docs/org-kb/agents/staged/blade/config.toml`
  - `/home/caleb/repo/polli/docs/org-kb/agents/staged/carbon/config.toml`
  - `/home/caleb/repo/polli/docs/org-kb/agents/staged/worm/config.toml`
  - `/home/caleb/repo/polli/docs/org-kb/agents/staged/mba/config.toml`

## Deliverables
- Repo pair exists with correct visibility/remotes (`calyx-dev`, `calyx`).
- Monorepo scaffold committed in `polli-labs/calyx-dev`.
- Config compiler package code with:
  - input parsing + schema validation modes,
  - merge-policy registry,
  - TOML emission,
  - fixture-based semantic parity tests.
- CI baseline workflows (`ci`, `smoke`) and passable local verification commands.
- PR opened against `calyx-dev` default branch, linked in POL-627.

## Plan
1. Topology bootstrap
- Ensure GitHub repos exist:
  - create `polli-labs/calyx-dev` (private) if missing,
  - create `polli-labs/calyx` (public) if missing.
- Ensure local layout:
  - `~/dev/calyx/dev` clone of `calyx-dev`,
  - `public` remote set to `polli-labs/calyx`.
- Create worktree branch:
  - `~/dev/calyx/wt/pol-627-p1a-calyx-bootstrap-config-compiler`.

2. Scaffold monorepo baseline
- Create workspace structure:
  - `packages/core`, `packages/cli`, `packages/sdk`, `packages/web`,
  - `fixtures/config-compiler/inputs`, `fixtures/config-compiler/expected`,
  - `.github/workflows/{ci.yml,smoke.yml}`.
- Add baseline package scripts:
  - `build`, `typecheck`, `lint`, `test`.
- Ensure Node >=22 requirement documented and enforced.

3. Implement config proving lane
- Implement compiler entrypoints for:
  - parse fleet/host YAML input model,
  - token expansion (`{{home}}`, `{{user}}`, `{{host}}`),
  - deep merge with path-aware array policies,
  - strict/advisory validation modes,
  - TOML emit.
- Build fixture corpus:
  - input YAML files under `fixtures/config-compiler/inputs/...`,
  - expected TOML snapshots for blade/carbon/worm/mba under `fixtures/config-compiler/expected/...`.

4. Parity + verification
- Implement semantic parity tests:
  - parse generated and expected TOML,
  - deep-compare object structure.
- Add optional formatting snapshot tests as advisory.
- Run local verification:
  - `pnpm install`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm build`

5. PR + tracker receipts
- Commit with clear message set and push branch.
- Open PR to `polli-labs/calyx-dev`.
- Update POL-627 with:
  - PR URL,
  - verification command outputs summary,
  - any residual risks.
- Add POL-605 comment summarizing P1A execution receipts.

## Verification Gates
- Gate A: topology is correct (`origin/public` remotes + `~/dev/calyx/*` paths).
- Gate B: scaffold and scripts exist with successful local runs.
- Gate C: semantic parity harness passes for all 4 host fixtures.
- Gate D: PR is open and linked in POL-627.

## Escalation Rules
- Escalate immediately if:
  - repo creation permissions fail,
  - branch protection blocks required actions,
  - parity semantics conflict with locked spec assumptions.
- Do not expand scope to non-config domains without explicit instruction.

## Execution receipts
- Capture:
  - branch/worktree path,
  - changed file list,
  - command summary,
  - verification summary,
  - PR URL,
  - Linear comments posted.

## Done / Next / Blocked
- Done:
- Next:
- Blocked:
