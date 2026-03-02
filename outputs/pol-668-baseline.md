# POL-668 Baseline: Skills Subsumption Inventory

**Issue:** POL-668 — Skills subsumption catalogue v1 + retirement sequencing
**Date:** 2026-03-02
**Branch:** `pol-668-skills-subsumption-v1-r1`

## Pre-conditions verified

| Check | Status |
|-------|--------|
| POL-668 status | In Progress (was Todo at plan time) |
| POL-673 blocked by POL-668 | Confirmed |
| POL-665 blocked by POL-668 | Confirmed |
| No existing subsumption catalogue in docs/ | Confirmed |
| Migration surfaces exist (migration-guide, migration-wrappers, operator-runbook) | Confirmed |
| `pnpm verify` passes on clean branch | Pending (verified after catalogue lands) |

## Calyx domain coverage (v0.1.1 GA)

Calyx implements 8 domain command groups, each with typed contracts:

| Domain | Verbs | Phase landed |
|--------|-------|-------------|
| config | compile | P1 |
| instructions | render, verify | P2 |
| skills | index, sync, validate | P2 |
| tools | index, sync, validate | P3 |
| prompts | index, sync, validate | P2 |
| agents | index, render-profiles, deploy, sync, validate | P3 |
| knowledge | index, search, link, validate | P3 |
| exec | launch, status, logs, receipt, validate | P3 |

## Existing wrapper registry

### Implemented wrappers (7)

| Wrapper | Target canonical command | Phase |
|---------|------------------------|-------|
| skills-sync | `calyx skills sync` | P2 |
| skills-sync-claude | `calyx skills sync --backend claude` | P4 |
| skills-sync-codex | `calyx skills sync --backend codex` | P4 |
| prompts-sync-claude | `calyx prompts sync --backend claude` | P4 |
| prompts-sync-codex | `calyx prompts sync --backend codex` | P4 |
| agents-render | `calyx instructions render` | P4 |
| exec-launch | `calyx exec launch` | P4 |

### Deferred wrappers (12, tombstone commands)

| Wrapper | Target | Phase | Notes |
|---------|--------|-------|-------|
| agents-fleet | calyx (domain commands) | P2-P4 | Split across domain commands |
| agents-fleet-apply | calyx (convergent domain applies) | P2-P4 | Decompose by subsystem |
| agents-fleet-smoke | calyx verify fleet | P4+ | Verification matrix |
| agents-toolkit-doctor | calyx doctor | P3+ | Health check surface |
| agents-bundle-build | calyx bundle build | P4+ | Bundle schema |
| agents-tools-bump | calyx tools versions bump | P3+ | Atomic version updates |
| agent-notify | calyx exec notify | P3+ | Keep Python backend |
| agent-mail | calyx ext agent-mail | P4+ | Extension package |
| docstore | calyx knowledge * + adapter | P3+ | Backend retained |
| execplan-new | calyx knowledge execplan new | P4+ | Depends on knowledge UX |
| agents-bootstrap | calyx install bootstrap | P4+ | After core stabilizes |
| agents-worktree-init | calyx workspace init | post-v1 | Low core leverage |

## Active skills inventory (45 skills)

Source: `~/.agents/skills/` directory scan + SOURCES.json registry

### Fleet operations skills (9) — primary subsumption targets

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| agents-fleet | v2.0.0 | Fleet maintenance: instructions, skills, tools, config deployment | Very high |
| launch-async-runner | v3.1.0 | Async runners with durable logs and ExecPlan guardrails | Very high |
| docstore | v0.1.0 | B2-backed artifact store for ExecPlans, reports, transcripts | Very high |
| agent-mail | v1.0.0 | MCP cross-agent inbox/outbox, threads, file reservations | High |
| agent-notify | v1.0.0 | Long-running command wrapper with completion notifications | Medium |
| ingest-execplan | v1.1.0 | File draft ExecPlans into docstore with runnable structure | Medium |
| issue-to-execplan | v1.1.0 | Synthesize ExecPlans from Linear issues | Medium |
| transform-into-execplan | — | Convert conversations/notes into ExecPlans | Medium |
| skill-creator | v1.0.1 | Guide for creating and updating skill packages | Low |

### Infrastructure & tooling skills (4)

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| add-agent-tool | v1.2.0 | Checklist for adding/upgrading toolkit CLI/MCP tools | Medium |
| mcp-builder | v1.0.0 | Guide for designing MCP servers | Low-medium |
| configs | v0.1.0 | Personal infrastructure configs for multi-host fleet | Low |
| astral | v0.1.0 | Python tooling: uv, ruff, ty | Very high |

### Repo knowledge skills (11) — orthogonal to Calyx

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| polli-monorepo | v0.1.0 | Polli monorepo workspace knowledge | Very high |
| polli-dev-conventions | — | Org-wide engineering standards | High |
| typus | v0.2.0 | Taxonomy primitives and geometry DTOs | Medium |
| ibrida-dev | v0.1.0 | Vision toolkit: SAM3, motion detection | Medium |
| cosmos | v0.2.0 | Provenance-first video normalization | Medium |
| linnaeus | — | PyTorch classification training/profiling | Medium |
| ibridadb | v0.1.0 | PostgreSQL/PostGIS biodiversity database | Low-medium |
| pollinalysis-tools | v0.1.0 | Video preprocessing utilities | Low |
| utils | v0.1.0 | Config-driven codebase exporter | Medium |
| work | v0.1.0 | Personal weekly working area | Low |
| configs | v0.1.0 | Infrastructure configs | Low |

### Planning & review skills (5)

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| project-audit | — | Audit Linear projects for staleness | Medium |
| release-acceptance-oracle | v1.0.0 | Ship/no-ship release feedback | Medium |
| create-cli | — | CLI design guidance | Low-medium |
| oracle-cli | v1.1.0 | Bundle prompts for second-model review | Medium |
| design-review-oracle | — | Design review prompts | Low |

### Content & search skills (7)

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| export-repo | v1.0.0 | Nav-first repo export for LLM review | High |
| cass | v2.0.0 | Cross-agent session search | High |
| rlm | v0.4.0 | Recursive Language Model for large inputs | High |
| visual-explainer | v0.1.0 | Self-contained HTML diagrams | Medium |
| marker-convert | v0.1.0 | PDF to markdown conversion | Medium |
| zotero-docstore | v0.1.0 | Zotero library sync and paper prep | Low-medium |
| chatgpt-transcript | — | ChatGPT transcript onboarding | Low |

### External service skills (6)

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| brave-search | v1.0.0 | Web search via Brave API | Medium |
| playwright-cli | v0.1.1 | Browser automation | Medium |
| gogcli | — | Google Workspace CLI | Low-medium |
| transcribe | v1.0.0 | Speech-to-text via Groq Whisper | Low |
| youtube-transcript | — | YouTube transcript extraction | Low |
| review-gallery | v1.0.0 | Visual review UI for Cosmos outputs | Low |

### Session & environment skills (3)

| Skill | Version | Purpose | Frequency |
|-------|---------|---------|-----------|
| tmux-control-mode | v1.0.0 | Tmux control-mode rules | Low |
| obsidian-vault | v1.0.0 | Obsidian vault management | Very low |
| vscode | v1.0.0 | VS Code diff/compare integration | Low |

### Already deprecated skills (8)

| Skill | Superseded by | Reason |
|-------|--------------|--------|
| agents-fleet-bootstrap | agents-fleet | Consolidated |
| agents-harness-update | agents-fleet | Consolidated |
| agents-instructions | agents-fleet | Consolidated |
| browser-tools | playwright-cli | Token efficiency |
| gccli | gogcli | Unified CLI |
| gdcli | gogcli | Unified CLI |
| gmcli | gogcli | Unified CLI |
| ibrida (v1) | ibrida-dev (v2) | Architecture rewrite |

## Subsumption surface area summary

| Category | Count | Calyx relevance |
|----------|-------|----------------|
| Fleet operations (primary targets) | 9 | Direct overlap with Calyx domains |
| Infrastructure & tooling | 4 | Partial overlap (tool registration) |
| Repo knowledge | 11 | Orthogonal — not subsumed |
| Planning & review | 5 | Minimal overlap (knowledge domain) |
| Content & search | 7 | Partial overlap (knowledge domain) |
| External services | 6 | Orthogonal — not subsumed |
| Session & environment | 3 | Orthogonal — not subsumed |
| Already deprecated | 8 | Already retired |
| **Total** | **53** | |

**Key finding:** Of 45 active skills, ~13 have meaningful overlap with Calyx domain surfaces (fleet operations + partial infrastructure/content). The remaining ~32 are orthogonal (repo knowledge, external services, planning rituals) and are not candidates for Calyx subsumption.
