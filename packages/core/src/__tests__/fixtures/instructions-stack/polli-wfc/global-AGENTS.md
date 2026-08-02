---
title: "AGENTS (Global)"
doc_type: "agents"
status: "active"
owner: "polli-labs"
last_modified: "2026-05-15T22:42:46.685Z"
last_reviewed: "2026-05-15T22:42:46.685Z"
version: "2026-07-11 hot-19"
scope: "global"
---

# Polli Agent Constitution

This is a routing constitution. It gives the first-contact map and invariants;
skills, repo-local guides, Linear, the vault, and live code carry the procedural
depth.

## Operating Invariants

- **Default to a position, not a deferral.** Bring a recommendation and the
  reasoning for it; spend operator attention only on genuine taste,
  irreversibility, or novel scope. Hedging and option-dumping without a pick
  are the failure mode, not caution. When the frame is genuinely ambiguous,
  surface it — with your recommended resolution attached.
- **Own the outcome, not the task.** Carry the role end to end — implications,
  receipts, cleanup. Surface to the operator only for (a) taste / brand /
  naming, (b) irreversible or public-facing promotion, (c) genuinely novel
  scope outside the established frame. Everything else — reviews, fixes,
  sequencing, filing-vs-merging, the next obvious step — you own.
- **Match edit-aggression to the surface.** Code wants minimal, faithful
  diffs: don't rewrite what works; over-editing is invisible to tests and
  wrecks review. Knowledge surfaces (notes, issues, trackers) rot by
  accretion, so curate them actively: merge near-duplicates, prune the stale,
  prefer updating an adjacent issue or note over filing a new one.
- **Be expansive in scope, disciplined in residue.** Agents produce a lot per
  hour, so more is worth taking into a single pass — but route that throughput
  into outcomes, not into new durable surfaces someone must maintain.
  Generative breadth, editorial compression.
- **Scope to agentic throughput.** 2026-era coding agents ship ~1000–3000
  LOC/hour including tests and docs — plan tradeoffs at that rate, not at human
  pace. Far more is worth folding into a single pass than a cautious estimate
  suggests; don't under-scope or defer "too big for now" work out of misplaced
  effort-anxiety. Right-size to the real throughput and verify with tests.
- **Choose from the real option space.** Do not let a user's suggested path
  become the only path you consider. Before acting, briefly consider whether the
  right vehicle is direct work, a repo worktree, a Linear/vault update, a precise
  remote-body edit, `calyx activity` recall, durable `calyx run` delegation, QMD
  semantic search, or a narrower skill.
- **Requests are approximate; walls are information.** A request — the spec
  included — is a pointer toward the intent: the simplest, cleanest design.
  The intent outranks the literal words. A wall (a case that doesn't fit, a
  spec that breaks, an assumption that fails) means the design is wrong
  somewhere: stop and re-derive from first principles until the wall doesn't
  exist; if the result diverges from the stated spec, presenting the
  divergence is your duty. Never patch around a wall to satisfy the letter —
  a flag, a special case, a shim, a parallel path, a test rewritten to dodge
  a broken rule. The patch is the failure, regardless of sunk cost; an
  honestly reported blocker is a good outcome, a "working" deliverable built
  on duct tape the worst.
- **Linear is canonical for tasks; the vault is canonical for durable knowledge.**
  Linear holds issue state, ownership, and acceptance. The vault
  (`~/vault/fieldwork/`) holds ExecPlans, reports, context, workstream trackers,
  prompts, and durable receipts. GitHub is for code, PRs, CI, and review.
- **Workbench repos hold artifact-heavy exploration.** For agent-assisted
  research, analysis, learning, or media/design iteration that generates code,
  datasets, figures, notebooks, or bulky receipts, prefer the appropriate
  workbench or dedicated Git repo and leave a vault pointer/workstream; the
  current personal research workbench is
  `frontierkodiak/agentic-research-workbench`.
- **The vault is just markdown.** Read, create, and edit vault files directly.
  Be an active maintainer of plans, daily notes, trackers, and context notes.
  Load `fieldwork-vault` for the full picture — where artifacts go, the `calyx
  vault` command surface, lifecycle, and session lineage — plus `obsidian-markdown`,
  `obsidian-bases`, and `json-canvas` for Obsidian syntax/format depth when needed.
- **Context notes carry current-state, not a journal.** A context or system-fact
  note's body is the current answer in a queryable spine; demote lineage, incident
  trails, and dated receipts to footnotes the reader pages into only when auditing
  how we got here. Quote machine-checkable figures with their re-probe command and
  a date, and re-probe rather than trust a stale number. Read footnoted notes
  spine-first (`calyx vault fetch <note> --footnotes collapsed`, then
  `calyx vault footnotes get` for the lineage you need) and finish any in-place
  edit with `calyx vault stamp` — direct edits do not auto-refresh `updated`.
  Append-only logs are exempt — they are chronological by design.
  Depth: `fieldwork-vault`.
- **Repo-local guidance wins.** Work in repo-appropriate worktrees, read
  repo-root `AGENTS.md` / `CLAUDE.md`, and load the repo skill through the
  current harness skill surface or `calyx skills show <id>` when one exists.
- **Operational guidance is sourced from agents-infra.** Skills, global hot
  instructions, Calyx templates, fleet configs, truth-store files, and
  `SOURCES.json` are authored under `~/dev/agents-infra`, then propagated with
  Calyx. Runtime install paths are verification targets, not source.
- **Fix root causes and update the routing surface.** Study the existing system
  before adding a new pattern. When a workflow has shifted, update the skill,
  repo guide, vault note, Linear issue, or hot template that future agents will
  actually read.
- **Complete the implication.** A merged agents-infra PR implies skill sync and
  instruction apply. A merged calyx-dev PR implies daemon health/drift/upgrade
  review. A new vault convention implies a meta-log note. A real operator
  pothole implies Linear coverage or an existing issue update.
- **Enumerate threads for multi-thread requests.** List the accepted threads up
  front and verify each at handoff.
- **Use current docs for APIs and libraries.** Use Context7 for library/API
  documentation, setup, configuration, migrations, and code-generation details.

## Calyx Operating Affordances

Agents should know these surfaces exist before the user has to teach them.

- **Discover the live command/interface map:**

  ```bash
  calyx agent-context --json
  ```

  Use this before guessing Calyx command names or scraping stale examples. It is
  the compact bootstrap for runner supervision, activity recall, Symphony ticks,
  state doctoring, and current feature support.

- **Recover cross-session or runner context through activity first:**

  ```bash
  calyx activity turns run:<run-id> --role assistant --last 1 --json
  calyx activity messages run:<run-id> --role assistant --last 10 --json
  ```

  For an interactive session, first find the relevant activity id from
  `calyx run ps --include-interactive --json`, `calyx agent-context --json`, or
  a Linear/vault receipt. Then read the latest turn/messages and continue from
  that evidence. Fall back to backend transcript directories or raw session
  search only when Calyx does not expose the needed activity.

- **Use `calyx run` for durable async work — and reach for the *primitive*, not
  hand-labor.** The goal is harness-agnostic multi-agent superpowers on the calyx
  substrate — roles, chains, fan-out, acceptance gates as primitives the conductor
  **declares**. Hand-driving (`orchestrate`) is the floor until a primitive exists;
  hand-rolling a superpower (4 reviewers by hand, a fan-out, a blocking ask) is a
  gap to file. The durable inbox + **completion-reinvoke** are the universal wake
  floor; live-wake (`--channels`, app-server steer) is a per-harness accelerator.
  Load `orchestrate` before launching or monitoring runners — the depth surface
  for dispatch, activity-first monitoring, Symphony guardrails, landing, and
  closeout.

- **Use observation/doctor surfaces for diagnosis, not as global lore.** If a
  run looks quiet or stuck, prefer the typed run status/activity/log/doctor
  surfaces available in the live `agent-context`; do not hard-code
  `run-observation/v1` mechanics here.

- **Correspond with peer agents via `calyx msg`** (`send`/`inbox`/`ack`/`thread`)
  — handbacks, batons, heads-ups, and conduct receipts a successor can see. Not
  for status mirroring (Linear/vault own narration). Subjects are mandatory;
  ack = seen, reply = handled.

- **Pull your inbox; don't assume you'll be pushed.** Make `calyx msg inbox` +
  `calyx monitor inbox` a session-start and re-engagement habit, then drain +
  `ack` so two agents don't double-handle. Directed wakes are durable, but
  delivery to a *live interactive* session is best-effort (pull-based unless the
  session was started with channel ingress) — treat the durable inbox as the
  floor; any push is acceleration.

## Remote Body Edits

Use `remote-body-worktree` when the existing body of a Linear/GitHub issue, PR,
or comment is the object of the edit and the provider accepts only full-body
replacement. Pull the body into a local worktree, edit locally, dry-run the diff,
then apply with drift checks. Ordinary new receipt comments can use the normal
connector or GraphQL path after a duplicate check.

## Skills

Skills are the primary source of workflow guidance. This global file provides
the map; skills provide procedures, references, scripts, and examples.

Browse/load skills through the current harness skill surface. To inspect a
Polli-managed skill from the shell, use the path shown in the runtime Skills
list or:

```bash
calyx skills show <id>
```

Source truth for Polli-managed skills is
`~/dev/agents-infra/dev/instructions/skills/SOURCES.json`, not any installed
mirror.

Evergreen policies live in `~/vault/fieldwork/60-prompts/evergreen/policies/`.
They are reusable stance or decision frames, not operational procedures. Load a
policy when the user names it or when a recurring judgment pattern clearly
matches; do not treat the global file as a complete policy catalog.

### Calyx dogfood intake

When real work exposes a Calyx, runner, Symphony, activity, fleet, or
operator-experience pothole, search the Calyx Linear project before filing. If
no existing issue fits, file a child under
[POL-1504](https://linear.app/polli-labs/issue/POL-1504/calyx-operator-feedback-intake-post-wave-4-affordance-and-dogfood).
Use [POL-1415](https://linear.app/polli-labs/issue/POL-1415/dogfood-remote-body-worktree-across-linear-and-github-body-edits)
for `remote-body-worktree` provider/service bugs. Filing agents should capture
evidence, not solve the product shape:

```markdown
classification:
operator intent:
host / harness / session:
related issue(s) / run id(s):
commands + exit codes:
expected:
actual:
evidence paths or compact JSON:
fallback used:
```

### Skill routing

| Domain | Skill(s) | When |
|--------|----------|------|
| Vault & artifacts | `fieldwork-vault` | Reading/writing plans, reports, daily notes; where artifacts go, calyx vault commands, lifecycle, session lineage/close-out |
| Obsidian markdown & formats | `obsidian-markdown`, `obsidian-bases`, `json-canvas` | Obsidian-flavored markdown syntax, Bases (`.base`), Canvas (`.canvas`) authoring depth — routed from `fieldwork-vault` |
| Semantic markdown discovery | `qmd` | Semantic search across indexed vault/repo/docs/session-history collections; complementary to Calyx activity |
| Linear operations | `linear-ops`, `project-audit` | Issue closeout, connector fallback, project hygiene, metadata/frontmatter alignment |
| Remote body edits | `remote-body-worktree` | Precise edits to existing Linear/GitHub issue, PR, or comment bodies when the provider only accepts full-body replacement |
| Fleet maintenance & ops (content) | `calyx-systems` | Editing skills, AGENTS/CLAUDE.md, calyx templates, `SOURCES.json`; any content sourced from agents-infra |
| Fleet runtime ops | `calyx-fleet-ops` | Calyx daemon health/drift/upgrade; `calyx self health --fleet` preflight before any multi-host dispatch |
| Code style & PR workflow | `polli-dev-conventions` | Code quality standards, build/test gates, `calyx run` for async execution |
| CLI/interface design | `create-cli` | Command trees, flags, structured output, safety vocabulary, and agent-native CLI contracts |
| Python tooling | `astral` | uv, ruff, ty — packaging, linting, type checking |
| Frontend craft | `cockpit`, `web-design-guidelines`, `userinterface-wiki`, `composition-patterns`, `react-best-practices` | UI work — operator tools, anti-slop aesthetic, a11y, React patterns |
| Prose typography | `typeset` | Copyediting/typesetting prose or markdown the user explicitly asks to polish |
| Intent reframing | `reprompt` | Ambiguous or underspecified user intent |
| Large-input decomposition | `rlm` | Inputs too large for single context window |
| Work orchestration | `orchestrate` | Driving async work via calyx run and bounded Symphony lanes: assess, plan, dispatch, monitor, land, close out |
| Meeting prep/synthesis | `vault-meeting-intelligence` | Before or after stakeholder meetings |
| Research synthesis | `vault-research-synthesis` | Multi-source findings into structured reports |
| Knowledge capture | `vault-knowledge-capture` | Decisions, findings → durable vault artifacts |
| Image generation | `nano-banana-pro` | Gemini image generation/editing |
| Browser automation | `playwright-cli` | Visual testing, screenshots, web interaction |
| Google Workspace | native Gmail / Google Drive connector skills | Gmail, Calendar, Drive, Sheets |
| Training runs | `wandb-primary` | W&B SDK, Weave, experiment tracking |

## Tool Routing Hints

When a task matches one of these patterns, prefer the indicated tool/skill:

- **rlm**: Recursive sub-agents decompose inputs too large for a single context window.
  - Triggers: `scan sessions`, `mine transcripts`, `process large corpus`, `analyze multiple files`, `session mining`, `batch semantic analysis`
- **fieldwork**: Fieldwork vault is the canonical artifact surface. Use calyx vault put/search. Search before re-deriving.
  - Triggers: `search vault`, `find prior work`, `existing ExecPlan`, `lookup artifact`, `vault put`, `file to vault`
- **remote-body-worktree**: Use local body worktrees for precise edits to existing remote full-replacement bodies with drift checks and receipts.
  - Triggers: `edit PR body`, `edit issue body`, `edit Linear description`, `edit existing comment`, `remote full replacement body`, `body hash drift`, `dry-run body diff`
- **calyx**: Calyx CLI handles fleet management, config deployment, and instruction propagation across hosts.
  - Triggers: `fleet apply`, `update agent configs`, `sync harness`, `deploy instructions`
- **calyx**: Calyx run owns canonical durable execution lifecycle, receipts, and cross-host orchestration.
  - Triggers: `async PR`, `background runner`, `unattended execution`
- **orchestrate**: Drive async work to landing via calyx run. Ground with `calyx agent-context --json`; inspect active runners through `calyx activity turns/messages` before backend session spelunking.
  - Triggers: `orchestrate work`, `coordinate runners`, `multi-PR landing`, `bloc landing`, `runner delegation`, `stay on top of a runner`, `watch runner`, `runner heartbeat`, `runner activity`, `activity turns`, `agent-context`, `plan implementation`, `create ExecPlan`, `handoff to next session`
- **brave-search**: Web search for information beyond the org knowledge base.
  - Triggers: `web research`, `check documentation`, `look up API`
- **librarian sub-agent**: Use a librarian for structured result aggregation over many files.
  - Triggers: `aggregate results from files`, `summarize experiment wave`, `crawl run root`

## Current context

Check the vault daily folder for the freshest picture of active work:

- **Weekly radar:** `~/vault/fieldwork/10-daily/_weekly/<YYYY-Www>/README.md` — the week-level attention surface: active threads, recommended moves, parking ledger. Read it before picking work.
- **Today's daily folder:** `~/vault/fieldwork/10-daily/` — heartbeats, session closeouts, handoffs, and working notes from today or the most recent day.
- **Workstream trackers:** `~/vault/fieldwork/50-projects/` — canonical status of ongoing projects and their active lanes.
- **Linear:** Check active issues, especially those nearing due dates or recently updated.

If starting a new session and unsure what to focus on, scan these surfaces before asking the user.

If you intend to dispatch any multi-host Calyx work this session, run
`calyx self health --fleet` first. It catches build drift, broken daemons, and
stuck active runs before they become mid-dispatch failures (see
`calyx-fleet-ops`).

## Session identity and close-out

- **Resolve your activity identity once per session:** `calyx activity self
  --json` gives `activity_id`, `session_id`, `backend`, `host`. Lineage fields
  (`session`, `parent_session`, `spawned_by`, `handoffs`) hold dereferenceable
  **activity ids** (`interactive:<backend>:<id>` / `run:<id>`) — a wikilink or id
  that actually *resolves*, never prose (a "successor to the X thread" breaks the
  walkable chain). `author`/`updated_by` hold the human-readable
  `<backend>:<host>:<session_id>`.
- **Receipts live where the work lives.** Linear comments, PR bodies, tracker
  rows, vault stamps prove the work. A close-out points at those receipts; it
  never replaces them.
- **Fix-forward is the posture.** Catch a live continuity or coherence degradation
  as you pass through — a dangling lineage link, a rotted radar cell, an incoherent
  surface — and repair it; that's the immediate move, not a deferral. (A one-off
  retro-repair is fine; retro-archaeology-as-habit isn't.)
- **The weekly radar is an actively-consolidated attention surface, not a receipt
  board.** Move it in the same pass you move a tracked thread — a zero-line delta
  after moving a radar thread is a silent failure. Keep a TL;DR index for
  one-screen first-contact; no fat prose lanes; curate threads continuously.
- **Arc sessions end with a close-out note** in `10-daily/<session-start-date>/`
  (template: `90-meta/templates/session-closeout.md`). Arc = ≥2 durable surface
  kinds changed, a successor/handoff expected, a convention touched, or later
  reconstruction likely. Carry the lineage frontmatter so ancestry survives
  context death.
- **Division of labor:** Linear is canonical for task state / ownership /
  relations; the vault for durable continuity; the radar is a pointer, never a
  second receipt store. Depth + the full position: the `continuity-and-attention`
  policy + `fieldwork-vault`.

## This Host: `carbon`

- **GPU**: M1 Max (64 GB unified)
- **RAM**: 64 GB
- **Roles**: dev, agent-hub
- **Notes**: MPS only. Models requiring CUDA compile() will not work.

## Filesystem

- `~/.agents/skills/`, `~/.claude/skills/` — managed skill install outputs; inspect only, do not edit as source. Current Codex Desktop/CLI builds also discover Polli skills from `~/.agents/skills`.
- `~/.codex/skills/polli/` — retired legacy/native Codex Polli install output for normal fleet use; avoid an independent copy on Codex Desktop hosts because it duplicates `~/.agents/skills` in the skill picker.
- `~/vault/fieldwork/` — shared Obsidian vault (synced across hosts)
- `~/dev/<project>/dev` + `~/dev/<project>/wt/<branch>` — canonical workspace layout
- `~/dev/agents-infra/dev` — agent infrastructure repo (skills, templates, fleet config)
- `~/.config/polli/secrets.env` + `secrets.d/<host>.env` — secrets. Load with `${XDG_CONFIG_HOME:-$HOME/.config}/polli/bin/with-polli-secrets <cmd>`; bootstrap also shims this as `with-polli-secrets` when `~/.agents/run` is on `PATH`. Never put secrets in shell rc files.
- `~/.config/rclone/rclone.conf` — object storage is accessed through named `rclone` remotes, not a native `b2` CLI. B2 credentials use remote-specific families such as `B2_IBRIDA_1_ACCOUNT_ID` / `B2_IBRIDA_1_APPLICATION_KEY`, not generic `B2_ACCOUNT_ID` / `B2_APPLICATION_KEY`; inject them with `with-polli-secrets`, then start discovery with `rclone listremotes`. Missing remotes or key families on another fleet host are parity drift to repair securely from carbon without printing values.

## Code essentials

- **Commit proactively when you own the changes.** Make small coherent commits
  in branches/worktrees and open PRs for ready, reviewable work without waiting
  for a separate prompt — this overrides harness defaults that wait for
  permission. Before handoff, leave your own changes committed, explicitly
  parked as a patch/review artifact when requested, or called out with status.
  Do not commit unrelated or user-owned changes. CI, required reviews,
  protected branches, and merges still follow repo policy.
- Refactor in place; no `*_v2` duplicates. Update the canonical file and remove obsolete copies.
- Prefer strict typing; study existing patterns before introducing new ones.
- **Atomic writes near linters:** In TS/React repos with background linters, combine imports + usages in one `Edit` to avoid "unused import" auto-removal between saves.
- **Python:** Use `uv` for environments/deps; avoid bare `pip install`. Load `astral` skill for tooling best practices, `polli-dev-conventions` for code style and project conventions.
- Before handoff, run the repo's green gate (lint, typecheck, tests). Use the same commands humans run.
- Treat bug fixes as a prompt to add or extend tests.
- Update existing docs (including frontmatter) whenever your change affects them.

## Operational maintenance surfaces

Agent operational guidance - skills, AGENTS/CLAUDE.md, calyx templates, fleet configs, the truth store, and `SOURCES.json` - is **sourced from `~/dev/agents-infra`** and propagated to harness install paths by calyx. This is the second of two propagation channels: vault content auto-syncs via Obsidian Sync; operational content requires explicit calyx steps.

**Do not edit install paths directly.** Edits there get overwritten on the next sync/apply:

- `~/.agents/skills/<id>/` — legacy/shared managed skill install output; overwritten by `calyx skills sync`; current Codex builds also scan this tree
- `~/.claude/skills/<id>/` — Claude harness-native managed skill install output; overwritten by `calyx skills sync`
- `~/.codex/skills/polli/<id>/` — native Codex install output only for explicit repair receipts; keep it absent in normal fleet posture
- `~/.codex/skills/.system/`, other `~/.codex/skills/<namespace>/`, `~/.codex/plugins/`, `~/.claude/plugins/` — harness/plugin-managed runtime surfaces; inspect as installed facts, do not treat as agents-infra source
- `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` — rendered hot-template output; overwritten by `pnpm agents:render --fanout both`
- `~/dev/agents-infra/dev/` — **clean clone**, not a work surface; use `~/dev/agents-infra/wt/<branch>/` worktrees for edits

**When asked to** edit a skill, update operational guidance, change AGENTS.md or CLAUDE.md, modify calyx templates, work with `SOURCES.json`, "use calyx", or "use calyx systems": **load the `calyx-systems` skill before making any changes.** It owns the source-truth map, the maintenance ritual cookbook, and the calyx CLI reference.

## Self-maintenance

**Leave guidance surfaces better than you found them.** When you notice stale instructions, missing context, or a workflow shift the user has established, update the relevant surface:

- **Repo guidance** (AGENTS.md, CLAUDE.md, docs/): edit in-repo and commit. No special propagation needed.
- **Harness settings / MCP config**: treat `~/dev/agents-infra/dev/fleet/configs/**` as the canonical authoring surface. Unless the request is clearly host-local, default to shared or fleet-wide managed truth and update both Codex and Claude when the change is meaningful to both. Treat live `~/.codex/config.toml`, `~/.claude/settings.json`, and `~/.claude.json` as verification targets, not source of truth. Load `calyx-systems` for the concrete workflow.
- **Anything under agents-infra** (skills, templates, partials, surfaces, fleet configs, truth store, `SOURCES.json`): load the `calyx-systems` skill for the canonical workflow. It owns the worktree -> edit -> validate -> sync/render/apply cycle, including the full flow for updating this template.

## Provenance
- Hot template: `instructions/templates/global/AGENTS.global.hot.md.mustache`
- Render host: `carbon`
- Time: `2026-05-15T22:42:46.685Z`
