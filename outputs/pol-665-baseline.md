# POL-665 Baseline Gap Ledger — P8 Production Wiring

**Date:** 2026-03-02
**Branch:** `pol-665-p8-production-wiring-r1`
**Version:** 0.1.1

## Executive Summary

All 8 Calyx domains currently operate in **fixture-only mode**: every command requires explicit `--registry <path>` or `--store <path>` as a `requiredOption()`. There is no environment variable resolution, config file support, or well-known default path resolution. Production use requires operators to supply full paths to registry JSON files for every invocation.

## Per-Domain Gap Analysis

### Registry Domains (skills, tools, prompts, agents, knowledge)

| Aspect | Current State | Production Gap |
|--------|--------------|----------------|
| Path resolution | `requiredOption('--registry <path>')` | No env var, config file, or default path fallback |
| Source type | Local JSON file only | No remote/API-backed registry support |
| Config integration | None | No `~/.config/calyx/` or `CALYX_*` env vars |
| Default paths | None | No well-known paths (e.g., `~/.agents/registries/`) |
| Multi-source | Single file per invocation | No composition of multiple registry sources |

**Affected commands (29 total):**
- `calyx skills {index,sync,validate}` — 3 commands × `--registry`
- `calyx tools {index,sync,validate}` — 3 commands × `--registry`
- `calyx prompts {index,sync,validate}` — 3 commands × `--registry`
- `calyx agents {index,render-profiles,deploy,sync,validate}` — 5 commands × `--registry`
- `calyx knowledge {index,search,link,validate}` — 4 commands × `--registry`
- Wrapper commands (7) — also pass `--registry` through

### Exec Domain

| Aspect | Current State | Production Gap |
|--------|--------------|----------------|
| Path resolution | `requiredOption('--store <path>')` | No env var or default store path |
| Store management | Single JSON file, append-only | No store rotation/archival |
| Config integration | None | No `CALYX_EXEC_STORE` env var |

**Affected commands:** `calyx exec {launch,status,logs,receipt,validate}` — 5 commands × `--store`

### Config Domain

| Aspect | Current State | Production Gap |
|--------|--------------|----------------|
| Fleet/host paths | `requiredOption` for both | No default fleet/host discovery |
| Output | Stdout or `--out` | No auto-write to config dir |

**Note:** Config domain is less affected — fleet/host YAML paths are inherently site-specific. Production wiring for config is lower priority than registry domains.

### Instructions Domain

| Aspect | Current State | Production Gap |
|--------|--------------|----------------|
| Template paths | `requiredOption` for fleet, hosts-dir, template, partials-dir | No template discovery |
| Output | Stdout or `--out-dir` | Already supports output paths |

**Note:** Instructions domain has many required paths by nature (fleet, hosts, templates, partials). Not a primary target for production wiring — paths are inherently complex and site-specific.

## Adapter Contract Gaps

### Registry Source Resolution

**Gap:** No abstraction layer between CLI flag parsing and domain function calls. Every domain function takes a raw `registryPath: string` parameter.

**Target:** Introduce a `resolveRegistryPath(domain, cliValue?)` function that implements:
1. CLI flag (explicit path) — highest precedence
2. Environment variable (`CALYX_SKILLS_REGISTRY`, etc.)
3. Config file (`~/.config/calyx/config.json` → `registries.<domain>`)
4. Well-known default path (`~/.agents/registries/<domain>.json`)

### Knowledge Backend

**Gap:** Knowledge domain reads a local JSON registry file. No bridge to external knowledge backends (docstore, org-KB).

**Target:** Define a knowledge adapter interface that supports local JSON (current) and external backends (future). For P8, land the interface + local adapter; defer remote backends to follow-up issues.

### Exec Store Backend

**Gap:** Exec store is a single local JSON file. No bridge to external run stores or distributed state.

**Target:** Define an exec store adapter interface. For P8, land the interface + local JSON adapter; defer remote adapters.

## Configuration Model Gaps

### Missing: Calyx Config File

No config file format exists. Operators cannot set default registry paths, preferred backends, or store locations without CLI flags.

**Target format** (`~/.config/calyx/config.json`):
```json
{
  "version": "1",
  "registries": {
    "skills": "~/.agents/registries/skills.json",
    "tools": "~/.agents/registries/tools.json",
    "prompts": "~/.agents/registries/prompts.json",
    "agents": "~/.agents/registries/agents.json",
    "knowledge": "~/.agents/registries/knowledge.json"
  },
  "stores": {
    "exec": "~/.agents/stores/exec.json"
  }
}
```

### Missing: Environment Variable Convention

No `CALYX_*` environment variables are recognized. All configuration must be passed via CLI flags.

**Target env vars:**
- `CALYX_CONFIG` — path to config file (overrides default location)
- `CALYX_SKILLS_REGISTRY` — skills registry path
- `CALYX_TOOLS_REGISTRY` — tools registry path
- `CALYX_PROMPTS_REGISTRY` — prompts registry path
- `CALYX_AGENTS_REGISTRY` — agents registry path
- `CALYX_KNOWLEDGE_REGISTRY` — knowledge registry path
- `CALYX_EXEC_STORE` — exec store path

## Cross-References

- **POL-668** unresolved gaps: registry wiring was identified as a key post-P7 item
- **POL-605** unified agents platform: production registry resolution is a prerequisite
- **migration-guide.md** Phase 3/4: canonical commands assume explicit paths — needs update for production mode

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking existing fixture tests | High | Preserve `requiredOption` behavior when explicit flags are passed; resolution is fallback only |
| Inconsistent config across hosts | Medium | Strict precedence rules; `calyx config show` diagnostic command |
| Scope creep into remote backends | Medium | Land interfaces only; defer implementations to follow-up issues |

## Deliverable Checklist

- [ ] Source resolution module (`resolve.ts`)
- [ ] Calyx config file schema + loader
- [ ] CLI: `--registry`/`--store` become optional with resolution fallback
- [ ] CLI: `calyx config show` diagnostic command
- [ ] Tests: resolution precedence, fallback behavior
- [ ] Tests: existing fixture tests unchanged
- [ ] Docs: production wiring guide
- [ ] Docs: updated operator runbook
