# WFC v4 scope guide (auto-loaded — you are editing the live product experience)

**Read `DESIGN.md` in this directory before any visual, motion, or copy
change.** It is the dimensionally-reduced design language: locked nouns,
motion laws, presence language, and operator decision locks you may not
re-litigate. Cohesion is enforced by shared rendered code (the kit + this
engine); DESIGN.md is the map and the ledger.

## Anti-entropy contract (assume the operator never has this repo open)

1. **Same-pass law.** Any change that adds/retunes motion, introduces or
   renames a product noun, changes user-facing copy, or implements an
   operator taste decision MUST update `DESIGN.md` in the same PR. A
   decision that lands only in a vault note or PR body is invisible here
   and WILL rot.
2. **Tripwire.** `pnpm audit:wfc4-design` (runs in required `explorer-build`
   CI) asserts the blessed dials listed in DESIGN.md exist byte-identical in
   the engine, and that this routing surface stays intact. If you changed a
   blessed value deliberately (operator re-bless required!), update
   DESIGN.md **and** `scripts/audit-wfc4-design.mjs` in the same PR — the
   friction is the point.
3. **Merge, don't append.** DESIGN.md stays dimensionally reduced: fold new
   decisions into the existing axes; supersede stale locks explicitly
   (move them, dated, to the receipt they died in).
4. **Review gates** live in the repo-root guide (Branch Rules): adversarial
   correctness review to zero findings for nontrivial changes, PLUS a
   design-lens review (HUX / polish / cross-experience consistency) for
   anything visually affecting. Blessed values stay byte-verbatim under
   mechanics work; new motion needs purpose-fit motion evidence + operator
   bless.

## Routing-scale module map

| Surface | Owner |
|---|---|
| `Wfc4Page.tsx` | Thin React mount, build/query option resolution, test-only page-context injection. |
| `engine/experience.js` | Experience orchestration, lifecycle, per-frame ownership, and narrow adjunct contexts. |
| `engine/meadowMap.{js,css}` | Map Focus DOM, choreography, navigation, and juice behind the engine context. |
| `engine/arcSweep.js` | Pure, unit-pinned swept-arc clearance geometry. |
| `engine/buddyPhysics.{js,d.ts}` | Accepted coupled cause-physics response; the engine owns the causes. |
| `engine/lab/` | Dynamically loaded development rehearsal code; never production-promoted. |

The detailed ownership map lives in
`../../../../../skills/polli-monorepo/references/wfc-architecture.md`.

## Local receipt lanes

- Real-WebKit motion receipts: `apps/explorer/tests/wfc4-webkit-motion.spec.ts`
  (mid-flight sampling; settled-state checks are not motion evidence).
- Producer/embed contract: `pnpm test:wfc4-smoke` against the exact origin.
- Dev-lab (`engine/lab/`) is build-gated (`VITE_WFC4_LAB`) and fail-closed in
  the deploy lane; rehearsal geometry NEVER promotes into the clip contract.

## Deterministic capture

From the repository root, build and serve a hermetic preview:

```bash
ENV_FILE=env/demo.env make explorer.build.env
pnpm --filter @polli/explorer preview --host 127.0.0.1 --port 4173 --strictPort
```

In another shell, wait for the real engine ready gate before capturing:

```bash
pnpm --filter @polli/explorer exec playwright screenshot \
  --channel chrome \
  --viewport-size "1440,900" \
  --wait-for-selector '[data-wfc4-ready="1"]' \
  'http://127.0.0.1:4173/wfc?cap' \
  wfc-cap-before.png
```

Repeat after the candidate change for `wfc-cap-after.png`. Record the relevant
dial/flag values and the precise operator bless ask beside the pair. Runtime
inventory: `?cap` disables transition choreography; `?juice=0` disables Map
Focus/strip physics; `?lab=<mode>` works only in a development build with
`VITE_WFC4_LAB=1`. Test seeding is page-context injection, never a public URL
or runtime parameter.

## Design-skill routing

- Default composite pass: `better-ui` beside `emil-design-eng` and
  `make-interfaces-feel-better`.
- Add `better-typography` or `better-colors` only when that dimension is
  materially touched.
- Route motion by purpose to `animation-vocabulary`, `apple-design`,
  `review-animations`, and read-only `improve-animations`; do not mandate the
  whole stack for every edit.
- Do not prescribe or apply `cockpit` to WFC v4.
