# Skills Subsumption Catalogue v1

> Authoritative mapping from legacy skills, wrappers, and operational surfaces to Calyx command/API replacements. This catalogue defines disposition, retirement phase, and ownership for every high-frequency active skill relevant to Calyx adoption.

## Status

- **Version:** 1.0 (2026-03-02)
- **Calyx GA:** v0.1.1 (2026-03-02)
- **Tracking issue:** [POL-668](https://linear.app/polli-labs/issue/POL-668)
- **Next:** Feeds [POL-673](https://linear.app/polli-labs/issue/POL-673) (onboarding docs) and [POL-665](https://linear.app/polli-labs/issue/POL-665) (production wiring)

## Scope and terminology

This catalogue covers the agent skill and wrapper surfaces relevant to Calyx adoption — primarily fleet operations, coordination, and knowledge management skills. Repo knowledge skills, external service integrations, and other orthogonal surfaces are listed for completeness but are explicitly **not planned** for Calyx subsumption.

### Disposition values

| Disposition | Meaning |
|-------------|---------|
| `subsumed` | Calyx domain command fully replaces this surface. Wrapper exists or will exist. |
| `partially_subsumed` | Calyx covers the core function; auxiliary features remain outside Calyx scope. |
| `not_planned` | Orthogonal to Calyx. Not a subsumption target. Retained as-is. |
| `defer_phase` | Planned for Calyx subsumption but deferred to a future phase (P8/P9/post-v1). |

### Skills vs. commands

This catalogue distinguishes two surface types:

- **Skills** are knowledge/ritual packages loaded into agent harnesses (Claude, Codex). They provide context, instructions, and sometimes wrap CLI invocations.
- **Commands/wrappers** are executable surfaces (CLI binaries, shell scripts, `dev/run/*` entries). Calyx replaces these with typed `calyx <domain> <verb>` commands.

Some skills primarily *wrap* commands (e.g., `agents-fleet` wraps `skills-sync`, `agents-render`, etc.). These have both a skill disposition and a command-level replacement path.

## Disposition matrix

### Fleet operations — primary subsumption targets

| Skill / Surface | Current purpose | Calyx replacement | Disposition | Phase | Owner | Issues |
|----------------|----------------|-------------------|-------------|-------|-------|--------|
| `agents-fleet` (skill) | Unified fleet maintenance: config, instructions, skills, tools, prompts, agents deployment | `calyx config compile`, `calyx instructions render`, `calyx skills sync`, `calyx tools sync`, `calyx prompts sync`, `calyx agents deploy` | `partially_subsumed` | P7–P8 | Calyx core | [POL-665](https://linear.app/polli-labs/issue/POL-665) |
| `skills-sync` (wrapper) | Sync skills registry to backends | `calyx skills sync` | `subsumed` | P7 (done) | Calyx core | — |
| `skills-sync-claude` (wrapper) | Sync skills to Claude harness | `calyx skills sync --backend claude` | `subsumed` | P7 (done) | Calyx core | — |
| `skills-sync-codex` (wrapper) | Sync skills to Codex harness | `calyx skills sync --backend codex` | `subsumed` | P7 (done) | Calyx core | — |
| `prompts-sync-claude` (wrapper) | Sync prompts to Claude harness | `calyx prompts sync --backend claude` | `subsumed` | P7 (done) | Calyx core | — |
| `prompts-sync-codex` (wrapper) | Sync prompts to Codex harness | `calyx prompts sync --backend codex` | `subsumed` | P7 (done) | Calyx core | — |
| `agents-render` (wrapper) | Render agent instruction templates | `calyx instructions render` | `subsumed` | P7 (done) | Calyx core | — |
| `exec-launch` (wrapper) | Launch async execution runs | `calyx exec launch` | `subsumed` | P7 (done) | Calyx core | — |
| `launch-async-runner` (skill) | Durable async runner dispatch with ExecPlan guardrails, docstore receipts | `calyx exec launch` (core lifecycle); runner orchestration remains skill-level | `partially_subsumed` | P8 | Calyx core + runner ext | [POL-665](https://linear.app/polli-labs/issue/POL-665) |
| `skill-creator` (skill) | Guide for creating/updating skill packages | `calyx skills validate` (validation); authoring guidance remains skill-level | `partially_subsumed` | P8 | Calyx core | — |
| `add-agent-tool` (skill) | Checklist for adding/upgrading toolkit CLI/MCP tools | `calyx tools index`, `calyx tools validate` (registration/validation); onboarding ritual remains skill-level | `partially_subsumed` | P8 | Calyx core | — |

### Coordination & infrastructure — deferred subsumption

| Skill / Surface | Current purpose | Calyx replacement | Disposition | Phase | Owner | Issues |
|----------------|----------------|-------------------|-------------|-------|-------|--------|
| `docstore` (skill + CLI) | B2-backed artifact store: ExecPlans, reports, transcripts | `calyx knowledge *` + B2 adapter (backend retained) | `defer_phase` | P8 | Calyx knowledge ext | [POL-665](https://linear.app/polli-labs/issue/POL-665) |
| `agent-mail` (skill + MCP) | Cross-agent inbox/outbox, threads, file reservations | `calyx ext agent-mail` (extension package, not core) | `defer_phase` | P8+ | Extension author | [POL-665](https://linear.app/polli-labs/issue/POL-665) |
| `agent-notify` (skill + CLI) | Long-running command wrapper with notifications | `calyx exec notify` (deferred; keep Python backend initially) | `defer_phase` | P8+ | Calyx exec ext | [POL-665](https://linear.app/polli-labs/issue/POL-665) |
| `ingest-execplan` (skill) | File draft ExecPlans into docstore with proper structure | `calyx knowledge execplan new` (depends on knowledge UX) | `defer_phase` | P9 | Calyx knowledge ext | — |
| `issue-to-execplan` (skill) | Synthesize ExecPlans from Linear issues with org context | `calyx knowledge` + Linear extension | `defer_phase` | P9 | Extension author | — |
| `transform-into-execplan` (skill) | Convert conversations/notes into runnable ExecPlans | `calyx knowledge` + extension | `defer_phase` | P9 | Extension author | — |
| `mcp-builder` (skill) | Guide for designing MCP servers | `calyx ext` scaffold (future) | `defer_phase` | post-v1 | Extension SDK | — |

### Knowledge & content — partial overlap

| Skill / Surface | Current purpose | Calyx replacement | Disposition | Phase | Owner | Issues |
|----------------|----------------|-------------------|-------------|-------|-------|--------|
| `export-repo` (skill + CLI) | Nav-first repo export bundles for LLM review | None — distinct purpose (export, not registry) | `not_planned` | — | Retained | — |
| `cass` (skill + CLI) | Cross-agent session search | None — distinct purpose (session mining) | `not_planned` | — | Retained | — |
| `rlm` (skill) | Recursive Language Model for large-input decomposition | None — distinct purpose (cognitive orchestration) | `not_planned` | — | Retained | — |
| `visual-explainer` (skill) | Self-contained HTML diagram generation | None | `not_planned` | — | Retained | — |
| `marker-convert` (skill + CLI) | PDF to markdown/HTML conversion | None | `not_planned` | — | Retained | — |
| `zotero-docstore` (skill) | Zotero library sync and paper prep | None | `not_planned` | — | Retained | — |

### Repo knowledge skills — orthogonal

These skills inject domain-specific context into agent sessions. They are complementary to Calyx (which manages operational commands), not replaceable by it.

| Skill | Purpose | Disposition |
|-------|---------|-------------|
| `polli-monorepo` | Polli monorepo workspace knowledge | `not_planned` |
| `polli-dev-conventions` | Org-wide engineering standards and audit playbooks | `not_planned` |
| `typus` | Taxonomy primitives, canonical geometry DTOs | `not_planned` |
| `ibrida-dev` | Vision toolkit: SAM3 segmentation, motion detection | `not_planned` |
| `cosmos` | Provenance-first video normalization toolkit | `not_planned` |
| `linnaeus` | PyTorch classification training and profiling | `not_planned` |
| `ibridadb` | PostgreSQL/PostGIS biodiversity database | `not_planned` |
| `pollinalysis-tools` | Video preprocessing utilities | `not_planned` |
| `utils` | Config-driven codebase exporter | `not_planned` |
| `work` | Personal weekly working area | `not_planned` |
| `configs` | Infrastructure configs for multi-host fleet | `not_planned` |
| `astral` | Python tooling: uv, ruff, ty | `not_planned` |

### External service skills — orthogonal

| Skill | Purpose | Disposition |
|-------|---------|-------------|
| `brave-search` | Web search via Brave API | `not_planned` |
| `playwright-cli` | Browser automation | `not_planned` |
| `gogcli` | Unified Google Workspace CLI | `not_planned` |
| `transcribe` | Speech-to-text via Groq Whisper | `not_planned` |
| `youtube-transcript` | YouTube transcript extraction | `not_planned` |
| `review-gallery` | Visual review UI for Cosmos outputs | `not_planned` |
| `oracle-cli` | Bundle prompts for second-model review | `not_planned` |

### Planning & review skills — minimal overlap

| Skill | Purpose | Disposition | Notes |
|-------|---------|-------------|-------|
| `project-audit` | Audit Linear projects for staleness and hygiene | `not_planned` | Linear-specific; no Calyx domain |
| `release-acceptance-oracle` | Ship/no-ship release feedback prompt | `not_planned` | Review ritual, not operational command |
| `create-cli` | CLI design guidance | `not_planned` | Design-time skill, not runtime |
| `design-review-oracle` | Design review prompts | `not_planned` | Review ritual |
| `chatgpt-transcript` | ChatGPT transcript onboarding | `not_planned` | Content ingestion |

### Already deprecated skills

These skills were retired before Calyx and are not subsumption targets. Listed for completeness.

| Skill | Superseded by | Retirement reason |
|-------|--------------|-------------------|
| `agents-fleet-bootstrap` | `agents-fleet` | Consolidated into unified fleet skill |
| `agents-harness-update` | `agents-fleet` | Consolidated into unified fleet skill |
| `agents-instructions` | `agents-fleet` | Consolidated into unified fleet skill |
| `browser-tools` | `playwright-cli` | 4x token efficiency improvement |
| `gccli` | `gogcli` | Unified Google Workspace CLI |
| `gdcli` | `gogcli` | Unified Google Workspace CLI |
| `gmcli` | `gogcli` | Unified Google Workspace CLI |
| `ibrida` (v1) | `ibrida-dev` (v2) | Architecture rewrite |

## Migration examples

### Example 1: Skills sync (fully subsumed)

**Before** — `agents-fleet` skill wrapping `dev/run/skills-sync-claude`:

```bash
# Legacy: skill tells agent to run wrapper
dev/run/skills-sync-claude --registry ~/.agents/skills/SOURCES.json
```

**After** — Calyx canonical command:

```bash
calyx skills sync --registry ~/.agents/skills/SOURCES.json --backend claude --apply
```

The `agents-fleet` skill's sync instructions now reference canonical Calyx commands. The `calyx skills-sync-claude` wrapper still works but emits deprecation telemetry.

### Example 2: Instruction rendering (fully subsumed)

**Before** — `agents-fleet` skill wrapping `pnpm agents:render` / `dev/run/agents-render`:

```bash
dev/run/agents-render --fleet fleet.yaml --host blade
```

**After** — Calyx canonical command:

```bash
calyx instructions render \
  --fleet fleet.yaml \
  --hosts-dir hosts/ \
  --template AGENTS.md.mustache \
  --partials-dir partials/ \
  --host blade
```

### Example 3: Async runner launch (partially subsumed)

**Before** — `launch-async-runner` skill wrapping `dev/run/async-runner`:

```bash
dev/run/async-runner --execplan execplan.md --host blade --backend claude
```

**After** — Calyx exec domain handles lifecycle tracking:

```bash
calyx exec launch --store runs.json --command "calyx config compile --host blade" --apply
calyx exec status --store runs.json --run-id <run-id>
calyx exec receipt --store runs.json --run-id <run-id>
```

The `launch-async-runner` skill retains value for higher-level orchestration (ExecPlan guardrails, docstore receipts, cross-host dispatch) that sits above the `calyx exec` lifecycle surface. Full subsumption requires runner extension work in P8.

### Example 4: Docstore (deferred)

**Current** — `docstore` skill wrapping `dev/run/docstore`:

```bash
docstore search "POL-668"
docstore put --key pol-668-baseline --file outputs/pol-668-baseline.md
```

**Future (P8+)** — `calyx knowledge` with B2 adapter:

```bash
calyx knowledge search --query "POL-668"
calyx knowledge index --registry knowledge.json
```

The B2 backend and artifact type taxonomy are retained; Calyx provides the registry/search/link contract layer. Full migration depends on knowledge domain UX maturity.

## Unresolved gaps

| Gap | Description | Severity | Issue |
|-----|-------------|----------|-------|
| Fleet convergence command | `agents-fleet` provides a single `apply` entry that converges config + instructions + skills + tools + prompts + agents. Calyx has no equivalent meta-command. | Medium | Deferred wrapper `agents-fleet-apply` targets `calyx (convergent domain applies)` — needs design in P8. Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |
| Health check surface | `agents-toolkit-doctor` provides fleet-wide health diagnostics. No `calyx doctor` exists. | Low | Deferred wrapper `agents-toolkit-doctor` targets `calyx doctor` — P8+ design. Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |
| Bundle build | `agents-bundle-build` packages agent bundles for deployment. No `calyx bundle` domain exists. | Low | Deferred wrapper targets `calyx bundle build` — P8+ pending bundle schema. Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |
| Tool version bumping | `agents-tools-bump` atomically bumps tool versions. `calyx tools` has index/sync/validate but no version mutation. | Low | Deferred wrapper targets `calyx tools versions bump` — P8+. Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |
| Bootstrap/install | `agents-bootstrap` initializes a new host. No `calyx install` domain exists. | Low | Deferred to P8+ (after core stabilizes). Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |
| Workspace init | `agents-worktree-init` creates isolated worktrees. Low Calyx leverage. | Very low | Deferred to post-v1. |
| ExecPlan authoring UX | `ingest-execplan`, `issue-to-execplan`, `transform-into-execplan` provide rich ExecPlan workflows. `calyx knowledge` has basic artifact ops but no authoring UX. | Medium | P9 — depends on knowledge domain extension maturity. |
| Agent-mail as extension | `agent-mail` MCP server needs packaging as a Calyx extension. Extension registry + discovery not yet designed. | Medium | P8+ — depends on extension ecosystem maturity. Tracked under [POL-665](https://linear.app/polli-labs/issue/POL-665). |

## Retirement sequencing

### Phase 7 (current — P7B, GA bridge)

**Completed actions:**
- 7 compatibility wrappers implemented with deprecation telemetry (POL-671)
- Operator runbook cut over to canonical commands (POL-670)
- All new workflows use `calyx <domain> <verb>` form
- Skills subsumption catalogue v1 published (POL-668, this document)

**Retirement state:** Wrappers functional but deprecated. `CALYX_FAIL_ON_DEPRECATED=1` available for enforcement.

### Phase 8 (P8 — production wiring)

| Action | Owner | Dependency |
|--------|-------|-----------|
| Replace fixture-backed adapters with production registries | Calyx core | POL-665 |
| Wire `agents-fleet` skill to exclusively use Calyx commands | Calyx core | POL-665 |
| Implement `calyx knowledge` B2 adapter for docstore migration | Knowledge ext | POL-665 |
| Package `agent-mail` as Calyx extension | Extension author | Extension SDK maturity |
| Design fleet convergence meta-command (`calyx fleet apply`) | Calyx core | POL-665 |
| Design `calyx doctor` health check surface | Calyx core | POL-665 |
| Wire `launch-async-runner` to use `calyx exec` lifecycle | Runner ext | POL-665 |

**Retirement target:** After P8, `CALYX_FAIL_ON_DEPRECATED=1` becomes default on all fleet hosts. Wrapper invocation count should reach zero.

### Phase 9 (P9 — migration completion)

| Action | Owner | Dependency |
|--------|-------|-----------|
| Remove deprecated wrappers from CLI | Calyx core | Zero wrapper invocation confirmed via telemetry |
| Remove legacy `dev/run/*` scripts | Fleet ops | All hosts on canonical commands |
| Implement ExecPlan authoring UX in knowledge domain | Knowledge ext | Knowledge domain maturity |
| Implement Linear-to-ExecPlan extension | Extension author | Knowledge ext + Linear API |
| Full `launch-async-runner` → `calyx exec` migration | Runner ext | Runner extension complete |

### Post-v1

| Action | Owner | Dependency |
|--------|-------|-----------|
| `calyx workspace init` (worktree management) | Calyx core | Low priority |
| `calyx bundle build` (agent bundle packaging) | Calyx core | Bundle schema design |
| `calyx install bootstrap` (host bootstrapping) | Calyx core | Core stability |
| Extension discovery and marketplace | Calyx SDK | Extension ecosystem growth |

## Summary counts

| Disposition | Count | Examples |
|-------------|-------|---------|
| `subsumed` | 7 | skills-sync, agents-render, exec-launch (all implemented wrappers) |
| `partially_subsumed` | 4 | agents-fleet, launch-async-runner, skill-creator, add-agent-tool |
| `defer_phase` | 7 | docstore, agent-mail, agent-notify, ingest-execplan, issue-to-execplan, transform-into-execplan, mcp-builder |
| `not_planned` | 27 | All repo knowledge, external services, planning/review, content/search skills |
| Already deprecated | 8 | agents-fleet-bootstrap, browser-tools, gccli/gdcli/gmcli, etc. |
| **Total inventoried** | **53** | |

## Related documents

- [CLI Reference](cli-reference.md) — complete Calyx command reference
- [Migration Guide](migration-guide.md) — step-by-step legacy → Calyx transition
- [Migration Wrappers](migration-wrappers.md) — wrapper replacement map and telemetry contract
- [Operator Runbook](operator-runbook.md) — canonical daily operations reference
- [Extension SDK](extension-sdk.md) — extension contracts and lifecycle hooks
