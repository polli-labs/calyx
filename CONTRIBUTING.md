# Contributing to Calyx

Calyx is a contract-first control plane. The bar is **earned abstractions and
defended scope**, not feature accretion: Calyx aims to be the tool that ends
tools, so every change should make the surface *more* coherent, not just larger.

These are the durable engineering principles. An active substrate program
(Symphony-ready v2) layers additional scope-time gates on top while it is in
flight — see the calyx workstream master plan in the vault when one applies.

## The green gate

- **Node 22** (the root `engines.node` floor) and the repo `pnpm` lockfile
  (`packageManager` pins pnpm 10.34.1).
- `pnpm install --frozen-lockfile`, then **`pnpm verify`** is the merge gate —
  run it before any PR or handoff that claims repo health. Use focused tests
  while iterating.
- `pnpm verify` is self-contained from a frozen-lockfile install: it runs
  `build` first and exactly once, then `lint`, `typecheck`, `test`,
  `client:package-check`, `contract:check`, and prints a per-phase wall-time
  summary. Nothing in the gate may depend on `dist/` left over from an earlier
  run — `@polli-labs/calyx-client` in particular is consumed through its built
  exports by both `typecheck` and `test`.
- `pnpm verify:cold` deletes every `packages/*/dist` first and then runs the
  same gate. Use it to prove a change did not reintroduce a warm-tree
  dependency; it must produce the same result as `pnpm verify`.
- CI (`.github/workflows/ci.yml`) runs the same `pnpm verify` on Node 22, on
  every pull request and every push to `main`. A runner checkout is always
  cold, so CI *is* the clean-checkout regression.
- The suite's worker count and test timeout are **declared** in
  `vitest.config.ts`, not inherited from vitest's defaults, and the reasoning is
  recorded there. Do not add a per-test timeout to make one test pass — that is
  the pattern the declared bound replaced, fifteen times over. A test that needs
  more than the global bound is telling you it has an inner deadline racing an
  outer one, or that it is waiting on wall-clock instead of on an event.
- **Tests must not require anything the host happens to have.** A test that
  needs an executable resolves it through a documented override pointed at a
  fixture (see `app-server-adapter.test.ts`); a test that needs fleet identity
  injects a hosts-truth fixture (see `run-command.test.ts`). Reading the real
  machine is how this suite became unrunnable on CI for a month.

## Scope discipline (anti-slop)

1. **Defended LoC.** Every PR body carries a `Deleted:` line. If nothing was
   deleted, justify it.
2. **One issue → one PR → one rationale paragraph** — the rationale describes
   what got *cut*, not what got added.
3. **No backwards-compat shims.** When a new version replaces an old one, the old
   one is deleted *in the same PR*. No `--legacy-X` flags, no fallback paths.
4. **No `*_v2` / `_old` files, no `// removed` comments.** Refactor in place.
5. **No new abstraction without two real callers.** Three similar lines is fine;
   premature abstraction is not. Durable coordination is the worked boundary:
   land and soak two caller-specific state machines independently, then extract
   only their proven duplication and delete both copies in the same change.
6. **Absorption discipline.** Every new surface answers: *what existing tool does
   this absorb, and when does that tool leave the stack?* Additive surfaces that
   retire nothing erode the goal.

## Repo disciplines

- **The composition root is `packages/cli/src/run-cli.ts`.** If runtime wiring
  changes, update docs and tests in the same PR. Command-shape changes move
  `run-cli.ts` and `docs/cli-reference.md` together.
- **Feature-gate new daemon behavior** through `daemon-features.ts`: a new typed
  run-spec field requires a daemon feature flag with issue provenance.
- **Adapter cross-validation.** Backend-typed options (reasoning effort, system
  prompt, …) validate at the CLI, the daemon feature gate, *and* the adapter
  spawn — a forged spec must not slip through.
- **Daemon-owned state machines.** If a command spans hosts, restarts daemons,
  or mutates durable runtime state, the CLI submits and observes; `RunService` /
  the daemon owns the state machine, evidence, receipts, and any explicitly
  declared compensation the capability defines. Arbitrary external effects
  have no implicit rollback. A generic coordinator additionally satisfies the
  caller-first, create-or-adopt, cleanup, output, and authority laws in
  [`docs/architecture/workflow-engine.md`](docs/architecture/workflow-engine.md).
- **Extensions depend on `@polli-labs/calyx-sdk`** for the public contract; do
  not reach into `@polli-labs/calyx-core` internals as the extension API.
- **Name the current interface authority honestly.** Commander registration is
  runtime authority today. The interface manifest is a hand-authored partial
  catalog, and `docs/cli-reference.md` plus `agent-context` are separately
  authored projections with selected drift tests. Until one generator replaces
  those paths, command-shape changes update every affected surface in the same
  PR; do not describe the current stack as generated.

## Verification and review

Every PR has the same evidence floor:

- Inspect the final diff directly, run the green gate, and exercise the changed
  behavior at the narrowest useful level. Report what was verified and any
  residual uncertainty; do not substitute reviewer activity for evidence.
- Ask *"is there a meaningfully simpler version of this PR?"* as an author or
  conductor scope check. Cut accidental scope when the answer is yes; the
  question is not a mandatory redispatch or review gate.

Independent review is **risk-proportional**, not a ritual for every substantial
change. Commission a standard or adversarial review only when it has a named
job: a concrete high-risk property makes an undetected defect unusually costly,
or the author still has unresolved uncertainty. Signals that can justify it
include:

- auth, secrets, or security boundaries;
- durable migrations, data-loss exposure, or irreversible operations;
- concurrency, lease, ownership, or recovery semantics;
- a new public or shared contract;
- unfamiliar architecture whose invariants are not yet understood; or
- an explicit request for independent review.

These signals inform judgment; they do not impose a round count or require a
review detached from the named risk.

`calyx review` remains the preferred way to commission that pass. Bind it to an
exact published SHA, choose `--adversarial` for premise-level challenge, and
record findings, dispositions, and residuals on the PR or Linear. Re-run review
only when material fixes invalidate the earlier evidence; there is no required
round count or zero-findings ceremony.

Ship a **receipt** with non-trivial PRs (linked from the PR body), including
"what we considered and didn't build."

## Consumer-API review gate

**Consumer APIs are capability contracts.** New HTTP/client surfaces must name
the app-facing capability they expose, the daemon/store that owns truth, and the
submit/observe boundary. **Do not mirror CLI command groups into OpenAPI without
a consumer capability model.**

Calyx's CLI, daemon routes, and SDK are **projections over shared capabilities**
(see [`docs/architecture/README.md`](docs/architecture/README.md)), and
`docs/architecture/consumer-api.md` is the capability spine. Before adding any
consumer HTTP route, OpenAPI operation, or `@polli-labs/calyx-client` surface
area, the PR states:

1. **The app-facing capability** it serves — the verb a consumer wants ("mark a
   turn high-signal", "export selected turns"), not a CLI noun.
2. **The owning daemon / store** and the **mutation class** (read · idempotent
   write · stateful/long-running · destructive).
3. **The receipt / error contract** (`calyx.error/v1` envelope + the typed result).
4. **Idempotency and provenance** (an idempotency key wherever it writes; who /
   what / when recorded on every mutation).
5. **The CLI or shell caller it absorbs** — absorption discipline applies to the
   API surface too.

**Do not** justify a consumer endpoint by one app's current callsite, or by the
existence of a top-level CLI noun. `interface-manifest` `wave4_disposition`
grades the *agent-facing CLI*; it is **not** a consumer-API profile.

## Documentation ownership

`docs/` holds **current, code-adjacent, PR-reviewed contracts** — what is true
*now* and must stay true. Three things belong: the substrate as it is now (the
architecture overview + the capability taxonomy), the contracts where drift =
breakage (the consumer-API capability model, error/auth contracts, the extension
SDK contract, the placement/projection laws), and the engineering law
(`AGENTS.md` + this file). **History does not belong** — changelogs, per-PR
archaeology, plans, RFCs, and incident receipts live in git, **Linear** (the flow
of work and decisions), and the **vault** (durable lineage, recency-weighted).
The rule: *Linear = what we're doing; vault = what we explored/decided;* `docs/`
*= what is true now.* When a decision hardens into a standing contract, distil it
into `docs/` as current-state and leave the vault RFC as its lineage.

**Zero-trust the legacy `docs/`.** Much of the pre-reorientation tree (roughly
pre-`POL-841` / the Feb–Mar scaffolding, plus the GA-era root files) is stale and
was never owned — do **not** cite it as current. Verify currency before trusting
any existing doc; the audit + retirement is tracked in POL-1902. New current docs
are born small and grow only with earned current-state content, never a port of
history.

## Where things live

- **Repo architecture & posture:** `AGENTS.md` + [`docs/architecture/`](docs/architecture/).
- **Current plans / decisions / RFCs:** Linear (the Calyx project) + the vault
  (`30-reports/` · `20-plans/` · `40-context/` · `50-projects/calyx/`),
  recency-weighted — **not** `docs/`.
- **Operator-facing `calyx run` guidance:** `polli-dev-conventions/references/calyx.md`.
- **The repo-local `skills/calyx-dev/SKILL.md` is a router** to the above — keep
  deep guidance in the repo (`AGENTS.md` + `docs/`), not in the skill.
