---
title: "Explorer Demo App Agent Guide"
doc_type: "agents"
status: "active"
owner: "polli-labs"
last_modified: "2026-07-17"
last_reviewed: "2026-07-17"
scope: "apps/explorer"
---

# Explorer Demo App Agent Guide

This app is the Vite/React host for Polli Explorer experiences. The current
public experience is WFC at `https://demo.polli.ai/wfc`. The package name is
`@polli/explorer`; "Dash" is historical vocabulary only. WFC v4 owns `/wfc`;
the v3 shell remains available at `/wfc-v3` as the fallback.

Root repo guidance still applies. This file adds explorer/WFC-specific routing.

## Fresh Worktree Baseline

From a new worktree, install once and then build the app directly:

```bash
pnpm bootstrap:worktree
pnpm --filter @polli/explorer build
```

`pnpm bootstrap:worktree` runs the frozen workspace install and dependency
readiness check. Use `pnpm check:worktree` if a build/test failure looks like a
missing fresh-worktree install.

The active explorer app no longer consumes `@polli-labs/typus-geometry`. Do not
re-add that package or prebuild `packages/typus-geometry/dist` unless a new,
explicit product contract needs it.

## @polli/ui Boundary

The active explorer uses `@polli/ui` only for the post-shell brand/tokens/assets
contract:

- `@polli/ui/brand-assets` in Vite config for the brand asset copy contract;
- `@polli/ui/tokens.css` in `src/main.tsx`;
- `@polli/ui/tailwind-preset` in `tailwind.config.js`;
- optimized assets served under `/brand/optimized/*`.

Do not import explorer components from the `@polli/ui` root, `@polli/ui/brand`,
or `@polli/ui/components/*` without a new issue that names the shared product
contract. WFC/explorer UI should stay app-local by default.

## Explorer Host vs WFC Experience

The Explorer host owns app lifecycle and deploy substrate. WFC owns the current
route content. Keep that boundary visible:

| Concern | Path | Owner |
|---|---|---|
| React app export | `src/App.tsx` | Host shim; should stay boring. |
| Providers, router, redirects, error boundary | `src/host/ExplorerHost.tsx` | Explorer host. |
| Experience registry | `src/host/experiences.tsx` | Explorer host; new durable experiences register here. |
| Runtime query params, theme default, embed postMessage | `src/host/runtime.ts` | Explorer host. |
| WFC v4 route/page/engine | `src/features/wfc4/**` | Active `/wfc` experience. |
| WFC v3 fallback/data | `src/features/wfc/**` | `/wfc-v3`, static-bundle data, and compatibility tests. |
| WFC assets/tests | `public/assets/wfc/**`, `public/wfc-data/**`, `tests/wfc*.spec.ts` | Shared deploy and evidence surfaces. |

Do not generalize WFC internals into host abstractions just because WFC is the
only current experience. Future Explorer experiences should start with a route
adapter and app-local feature directory, then earn shared contracts from real
reuse.

## Current WFC Entry Points

WFC v4 is the public producer/embed route. WFC v3 remains the explicit fallback;
the older `WfcExplorerPage` shell was removed in POL-1262 and should be
recovered from git history only with explicit product need.

| Surface | Path | Notes |
|---|---|---|
| V4 route/page | `src/features/wfc4/Wfc4Route.tsx`, `Wfc4Page.tsx` | Active `/wfc` wrapper and engine mount. |
| V4 engine | `src/features/wfc4/engine/**` | Vendored WFC v4 experience and styling. |
| V3 route adapter | `src/features/wfc/WfcRoute.tsx` | Keeps `/wfc-v3` available as the fallback. |
| V3 game orchestrator | `src/features/wfc/WfcV3DemoPage.tsx` | Main state, gadget, Buddy/dialogue, notebook, classifier reveal, persistence, and stage integration. Large by sprint pressure; prefer extracting carefully over adding more inline sprawl. |
| V3 stylesheet | `src/features/wfc/wfc-v3-demo.css` | Primary visual system for the v3 demo. Treat pixel-art placement constants as product-critical. |
| Notebook | `src/features/wfc/NotebookPanel.tsx` | Field notebook artifact, field guide, observations, and synthesis-facing pages. |
| Classifier reveal | `src/features/wfc/ClassificationOverlay.tsx`, `src/features/wfc/BeliefSunburst.tsx` | Demo bridge for S5 / belief trace, not the final POL-980/POL-1048 canonical classifier contract. |
| Shared WFC helpers/data | `src/features/wfc/data.ts`, `sitePack.ts`, `sitePack.demo.json`, `wfcMomentSchema.ts` | Keep runtime data-contract fixes here; avoid parsing markdown/vault artifacts in browser code. |

## Pollidex / Shell Assets

Runtime assets served by Vite live under:

```text
public/assets/wfc/
  buddy/
  depth/
  icons/
  shell/
```

Candidate generated/Ruthie source packets that are not yet runtime assets live
under:

```text
assets/wfc/shell-source/
```

Use that repo-local intake surface for app-candidate art packets. Do not point
source packet assets at runtime files, the fieldwork vault, Google Drive,
Downloads, or an absolute local path; those places can be provenance, not
executable source truth.

The Pollidex shell is currently a monolithic chassis plus sidecars:

| Part | Runtime path | Current posture |
|---|---|---|
| Chassis | `public/assets/wfc/shell/pollidex-gadget-chassis-iter12.png` | Stable `1264x848` coordinate frame. |
| Scoutscope PTZ | `public/assets/wfc/shell/scoutscope/*.png` | Bridge pose bank. Rev2 should bake a fixed mount anchor into source sprites. |
| Mode toggle | `public/assets/wfc/shell/mode-toggle/*.png` | Bridge state sprites for viewfinder/network toggle. |
| Gadget patches | `public/assets/wfc/shell/gadget-patches/*.png` | Transparent overlays that cover or replace stale chassis details. |

Historical source/review context for generated assets may still be linked from
the fieldwork vault while POL-1240 migrates the lane out of its exploratory
layout:

- `vault://50-projects/wfc/workstreams/active/pol-962-pollidex-decomposition-takeover`
- `vault://50-projects/wfc/shell-parts/provisional/pollidex/manifest.json`
- `vault://50-projects/wfc/shell-parts/review/`
- `vault://50-projects/wfc/buses/active/wfc-v3-demo-delivery-bus`

The repo-side `manifest.json` is the current asset-contract ledger for part
IDs, canvas sizes, anchors, bounding boxes, runtime paths, and repo-local QA
artifact paths. Treat it as the single current tracker for app-consumed shell
asset state. Use `pnpm report:wfc-shell-assets` when you need a quick readable
status table, and `pnpm report:wfc-shell-assets -- --json` when an agent needs
machine-readable tracker state. Validate the contract with
`pnpm verify:wfc-shell-assets`; add `-- --strict-qa` when missing contact sheets
or alpha checks should fail the run.

Do not make the fieldwork vault or POL-962 Google Sheet part of the runtime or
validation contract. `vault://` links in the manifest are historical provenance
only until the source asset store is formalized. If a vault packet, Google Sheet
row, generated image, or Ruthie-authored delivery should affect the app, promote
it into repo-local runtime assets plus this manifest, then regenerate/review the
repo-local QA artifacts.

Use `pnpm promote:wfc-shell-asset -- --packet <source-packet.json>` to promote
an already-reviewed source packet into the repo-local runtime path and
manifest. Start with `--dry-run --json`; after a real promotion, run
`pnpm generate:wfc-shell-qa -- --force` and
`pnpm verify:wfc-shell-assets -- --strict-qa`. The promotion command accepts
optional `--source-ref` provenance. `--part <partId> --source <path>` remains
available as a lower-level escape hatch, but packet promotion is the preferred
generated/Ruthie bridge.

Before promotion, validate a repo-local source packet:

```bash
pnpm --silent check:wfc-shell-source-packet -- --packet apps/explorer/assets/wfc/shell-source/<part-slug>-rev<n>/source-packet.json --strict --json
```

The packet checker validates manifest `partId`, frame names, dimensions, alpha
expectations, and repo-local source paths. It is deliberately read-only: passing
source-packet review means the candidate is shaped correctly enough to move to
part-specific checks and promotion.

When creating a packet, do not hand-write the packet JSON unless you are
repairing a malformed packet. Scaffold it from the manifest:

```bash
pnpm scaffold:wfc-shell-source-packet -- --part <partId> --author <name> --source-ref <provenance>
```

If a generated or Ruthie-authored drop already exists as local PNGs, copy it
into the repo-local packet during scaffolding:

```bash
pnpm scaffold:wfc-shell-source-packet -- --part <partId> --from <png-file-or-frame-dir> --author <name> --source-ref <provenance>
```

The scaffolder prints the next checker, part-specific gate, and dry-run
promotion commands. It is intended as the first move in fresh worktrees and
multi-agent asset lanes.

For generated/Ruthie model sheets, slice directly into the same source-packet
surface instead of manually cropping frames:

```bash
pnpm slice:wfc-shell-source-sheet -- --part <partId> --sheet <model-sheet.png> --cols <n> --author <name> --source-ref <provenance>
```

The slicer writes a packet plus fixed-canvas `frames/<frame>.png` files in
manifest frame order. Use `--cell-width`, `--cell-height`, `--crop-x`, and
`--crop-y` only when the sheet is not an even row-major grid.

For Scoutscope replacements, check source-packet readiness before promotion:

```bash
pnpm bake:wfc-scoutscope-anchor -- --source <frame-dir> --strict-source --json
```

This is a measurement gate, not a runtime repair. It verifies that the incoming
pose bank already has a fixed mount-foot anchor and enough canvas headroom
before `promote:wfc-shell-asset` copies frames into the app. If this fails, fix
or regenerate the source packet rather than baking another bridge rescue.

## Asset-Contract Rules

For shell sidecars, do not rely on one-off visual placement alone. A usable
asset lane should name:

- source canvas size and chassis coordinate frame;
- runtime path and optional historical/source references;
- alpha/keying method and repo-local alpha QA artifact;
- logical layer (`chassis`, `panel-patch`, `screen-data`,
  `hardware-ambient`, `hardware-control`, `overlay`);
- source-local anchor and chassis anchor;
- intended bounding box, protected zones, and repo-local contact sheet;
- whether the current asset is production art or a bridge.

Use transparent PNGs for runtime overlays. For generated sprites, keyed
backgrounds plus downstream alpha cleanup are acceptable when direct generated
transparency is unreliable, but always inspect the alpha against checker or
magenta backgrounds before promotion.

## Bridge / Replacement Workflow

The launch plan assumes generated or scripted bridge assets will be swapped for
Ruthie-authored pixel art over several beta and post-launch builds. Make that a
boring replacement path, not a new integration each time:

- keep the existing `partId` stable unless the product concept actually changes;
- preserve frame names, source canvas, source anchor, chassis anchor, and
  protected-zone semantics when replacing a sidecar;
- bump `rev`, update `runtimeType` from `bridge` to `production` only after the
  authored art passes the same validator/contact-sheet/alpha checks;
- prefer replacing files behind an existing manifest entry over adding a sibling
  `*-v2` component;
- keep historical `vault://` or Sheet references as provenance only; promotion
  into the game means repo-local runtime files plus manifest coverage.

Bridge assets in the manifest must include `replacementPolicy` so future agents
know what to preserve when substituting authored art.

## Local Preview

Use the static preview lane to review a build, run smokes, or take screenshots;
it rebuilds on start and has no HMR:

```bash
VITE_WFC_ENABLE=1 make explorer.dev
# or: ENV_FILE=env/demo.env make explorer.dev
```

Use Vite directly while iterating on code; this is the live-rebuild/HMR lane:

```bash
VITE_WFC_ENABLE=1 pnpm --filter @polli/explorer dev --port 5179
```

The preview defaults to port 5179; use a different `PORT` for sidecar worktrees,
or a different `--port` in the HMR lane, so concurrent servers do not collide.
`env/dev.defaults.env` does not enable WFC; `env/demo.env` does. Client-visible
feature/config values exposed through `import.meta.env` bind at build time in
the preview lane; `VITE_API_URL`, when explicitly set, configures the legacy v3
proxy when the server starts and is not provided by `env/demo.env`. If `/wfc`
appears missing or mock-only, verify `VITE_WFC_ENABLE`,
`VITE_WFC_MOCK_DATA`,
`VITE_WFC_STATIC_BASE`, `VITE_WFC_MOMENT_ENDPOINT`, and `VITE_API_BASE` in the
active environment. The canonical two-lane and server-lifecycle details live in
`../../skills/polli-monorepo/references/dev-server-guide.md`.

For v3 fallback data work only, WFC data source selection (POL-1767,
`src/features/wfc/data.ts` +
`staticBundle.ts`): `VITE_WFC_MOCK_DATA=1` → bundled fixtures;
`VITE_WFC_STATIC_BASE=<bundle root>` → static `wfc-static-bundle.v1` mode
(production; `env/demo.env` uses `/wfc-data`); otherwise legacy remote mode
against a dev ibrida API. Static mode resolves bundle-relative asset URLs
against the bundle root (or `manifest.mediaBase`) and must not be routed
through the remote-mode page-origin rewriting. A local preview of the
production config needs a bundle tree at `apps/explorer/dist/wfc-data/` (copy
one in after the build) or a dev-server proxy serving it.

## Verification

Use the smallest gate that covers the changed surface:

```bash
python3 scripts/validate-skills.py
git diff --check
pnpm verify:wfc-shell-assets
pnpm report:wfc-shell-assets

set -a; source env/demo.env; set +a
pnpm --filter @polli/explorer build

WFC_DEMO_BASE=<origin> pnpm test:wfc4-smoke
WFC_CONSUMER_URL=<page-url> WFC_EXPECTED_EMBED_URL=<embed-url> \
  pnpm test:wfc4-consumer-smoke
```

`test:wfc4-smoke` is the canonical real-Chrome/H.264 producer/embed suite. Run
it against both the generated Vercel deployment and the canonical
`https://demo.polli.ai` origin. Only a deployed/non-loopback run earns the
deterministic cross-origin receipt; deploy-owned lanes require it, while an
ordinary loopback run may skip those cases. `test:wfc4-consumer-smoke` remains
a separate consumer-page check and requires both explicit URL variables; it
does not infer a public consumer page or expected iframe.

For the fast boot and embed-handshake inner loop, run:

```bash
WFC_DEMO_BASE=<origin> pnpm test:wfc4-smoke -- --grep @wfc4-boot
WFC_DEMO_BASE=<origin> pnpm test:wfc4-smoke -- --grep "<test title>"
```

The focused commands are iteration tools; the full `test:wfc4-smoke` suite is
still the receipt lane.

Keep five receipts explicit: build, generated deployment, canonical Polli
origin, deterministic cross-origin fixture, and live consumer page. Production
deploys are CLI-driven through Vercel:

```bash
with-polli-secrets make wfc-demo.deploy-vercel
with-polli-secrets make wfc-demo.deploy-vercel PROD=1
```

`skills/polli-monorepo/references/deploy-guide.md` is the canonical source for
manifest gates, CLI and receipt fields, retry behavior, consumer overrides, and
rollback. Keep this first-contact guide limited to commands and evidence
boundaries.

The v3 `@public-smoke` and `@static-smoke` checks remain fallback-only evidence;
older pre-v3 playtest checklists are not deploy evidence. The opt-in
`pnpm test:wfc-perf` suite also retains v3/Safari semantics. Set
`WFC_PERF_RESULTS_DIR=<directory>` only when a JSON artifact is wanted.

If Playwright reports mock media or localhost/blade backend failures, restart
the preview with both `env/demo.env` and `VITE_API_URL` pointed at a live
backend; `VITE_API_URL` is consumed by the Vite proxy, while browser runtime
API calls continue to use `VITE_API_BASE=/api/v1`.

## Cross-Browser Animation (WebKit / Safari)

The WFC experience animates over footage (the bloom-bud scene-switcher, the
weave, summoned surfaces). These are authored in Chromium but **ship to Safari**
(iOS + macOS), which composites differently. There is a class of bugs that
renders perfectly in Chrome and breaks only in WebKit — e.g. the v4 bloom-bud's
blossoms "flew" to the left mid-transition, and the whole bloom read as
low-fps/janky, in Safari only. Author to these rules; they are cheap and prevent
the entire class:

- **Never transition a `transform` that mixes a `%` translate with `scale()`.**
  WebKit shifts the percentage during interpolation, so the element drifts
  sideways. Split the two jobs across two elements: a **static** centering
  transform (`translate(-50%,-50%)`, never transitioned) on the positioned
  element, and the **animated** transform (scale + **px / unitless** translate
  only) on an inner layer.
- **Animate `opacity` + px/scale on a promoted layer** (`will-change: transform,
  opacity`). Do not transition layout-affecting or non-composited properties on
  the main thread — that is the "flash-animation" jank Safari shows and Chrome
  hides.
- **On raw SVG `<g>`, animate `opacity` only.** Do not transition `transform` /
  `transform-origin` on SVG nodes; WebKit resolves the origin against a
  different box and flings them. Wrap and transform an HTML element instead.
- **Resident "trusted" chrome must not reflow when an overlay flips state.** The
  transport pill keeps a fixed-slot layout: the divider is its own element (never
  a `border` on variable-width text), and labels live in fixed-width ellipsis
  slots. A control the user trusts should not jump when the bloom opens.

Verify in **real WebKit**, not just Chromium (WebKit is installed for
Playwright). The durable lane is `tests/wfc4-webkit-motion.spec.ts` (gated
`webkit` project in `playwright.config.ts`): it drives the actual transitions
and samples `getBoundingClientRect()` **mid-transition** — a settled-state
check will not catch a fly-left. Run it against a built preview:

```bash
WFC_DEMO_BASE=http://127.0.0.1:4173 pnpm --filter @polli/explorer test:wfc4-webkit-motion
```

Known limit: the rect probe reads the layout model. A compositor-side slide
that never reaches the model needs the ad-hoc screenshot pair (mid-flight +
settled) on top.

## Reviewer and deploy provenance

Bind WFC v4 review and deploy claims to the exact source commit SHA, the
generated Vercel deployment origin, the canonical origin when promoted, and the
SHA-256 of the deployed v3 static-bundle `manifest.json` when present. Keep the
deploy guide's generated/canonical/cross-origin/consumer smoke receipts
separate; a visible UI coordinate is not a substitute for any of them.

## Review Guide Maintenance

Treat the `Review guide` popover as living reviewer truth, not static
marketing copy. When a WFC PR changes what is ready, temporary, or headed for
replacement, update the guide in the same branch.

## Reviewer Changelog Maintenance

The `What changed` popover is for non-technical reviewers who may see several
builds in one day. When a WFC PR creates a noticeable reviewer-facing change,
add or refresh one pithy bullet in the current day’s changelog entry. Keep each
bullet under ~15 words, group entries by date, and do not
turn this into a commit log.

Current stance:

- `Feedback needed` is for surfaces where Caleb/Megan feedback is genuinely
  useful now.
- `Still being polished` is for active bridge/polish work such as onboarding,
  Buddy focus, gadget shell fit, notebook/About role, and smaller-screen layout.
- `Overhaul inbound` is for surfaces that should not receive fine-grained copy
  polish because a known replacement lane exists. As of POL-1250, the
  classifier/belief-trace sunburst belongs here pending the canonical
  ClassificationResult contract.
- `Known temporary pieces` is for demo-data/art limitations that reviewers may
  notice but should not mistake for final product direction.

Keep the Google Form link optional through `VITE_WFC_REVIEW_FORM_URL` until the
form exists; do not hard-code a placeholder URL.

## First Prompt / Follow Camera

The first Buddy ID prompt is part of the reviewer first impression. The active
visitor evidence must be visible when the prompt appears; do not regress to a
fully zoomed-out default that lets the gadget/dialogue cover the pollinator
track.

Current stance:

- WFC v3 starts active visits in `follow` camera mode and uses an intermediate
  zoom to center the current visitor trace.
- Let the footage breathe before the first Buddy ID stop. The current first
  prompt lead-in is intentionally several seconds; do not collapse it back to
  an immediate jump-to-question.
- Buddy prompt entry is a pause, not a rewind. Do not seek the clip back to
  `visit.t0` once playback has advanced; early full-clip visits otherwise look
  like an accidental reset to `0:00`.
- Manual stage pan/zoom or gadget-viewfinder interaction releases follow mode
  to `free`; the transport Compass button re-enables visitor follow.
- Stage pan/zoom math must account for the cover-fitted media plane, not just
  the visible frame. In portrait, the clip has real horizontal media extent
  outside the frame; panning must be able to reach it.
- Keep first-prompt/iPad-style visibility covered in Playwright whenever
  touching viewport, Buddy dialogue, gadget placement, or transport controls.
- Stage wheel zoom uses a native non-passive listener so `preventDefault()` does
  not generate passive-listener console warnings.

## Editing Guidance

- Keep user-facing game/product changes out of generic repo cleanup PRs.
- Do not mix public demo promotion with asset-system refactors unless the user
  explicitly asks for promotion.
- When touching the Pollidex, update the WFC session bus
  (`vault://50-projects/wfc/buses/active/wfc-v3-demo-delivery-bus`) or the
  active Pollidex decomposition workstream
  (`vault://50-projects/wfc/workstreams/active/pol-962-pollidex-decomposition-takeover`)
  with product/art-contract reasoning.
- Prefer small extracted helpers/components over adding more bulk to
  `WfcV3DemoPage.tsx`, but avoid broad refactors during visual hill-climbs.
