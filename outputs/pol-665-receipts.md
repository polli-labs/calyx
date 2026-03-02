# POL-665 — P8 Production Wiring Receipts

## Summary

Replaced fixture-only `requiredOption("--registry")` / `requiredOption("--store")` on all 29+ CLI subcommands with a 3-tier source resolution chain:

**CLI flag → environment variable → config file → error**

All existing tests pass unchanged (explicit `--registry` still works identically). 23 new tests added. Full verify gate green.

## Changed files

### New files
| File | Purpose |
|------|---------|
| `packages/core/src/resolve.ts` | Source resolution engine: `resolveSourcePath()`, `requireSourcePath()`, `loadCalyxConfig()`, `showConfig()` |
| `packages/core/src/__tests__/resolve.test.ts` | 20 tests covering precedence, config loading, tilde expansion, error messages |
| `docs/production-wiring.md` | Full production wiring guide (env vars, config file, fixture mode) |
| `outputs/pol-665-baseline.md` | Gap ledger documenting per-domain baseline vs production gaps |

### Modified files
| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Added `RegistryDomain`, `StoreDomain`, `SourceDomain`, `CalyxConfig`, `ResolveSourceOptions`, `ResolveSourceResult`, `ConfigShowResult` types |
| `packages/core/src/index.ts` | Re-exported resolve module symbols and types |
| `packages/cli/src/run-cli.ts` | Changed all `requiredOption("--registry")` → `option("--registry")` with `resolve()` fallback; added `calyx config show` subcommand |
| `packages/cli/src/calyx-core.d.ts` | Added production wiring type declarations |
| `docs/cli-reference.md` | Added `calyx config show` section |
| `docs/operator-runbook.md` | Added source resolution section in Prerequisites |
| `README.md` | Added "Production wiring" section and docs link |
| `packages/core/src/__tests__/docs-coherence.test.ts` | Added 3 new doc coherence assertions for production-wiring.md |

## Environment variables

| Variable | Domain |
|----------|--------|
| `CALYX_SKILLS_REGISTRY` | skills |
| `CALYX_TOOLS_REGISTRY` | tools |
| `CALYX_PROMPTS_REGISTRY` | prompts |
| `CALYX_AGENTS_REGISTRY` | agents |
| `CALYX_KNOWLEDGE_REGISTRY` | knowledge |
| `CALYX_EXEC_STORE` | exec |
| `CALYX_CONFIG` | config file path override |

## Config file

Default path: `~/.config/calyx/config.json`

```json
{
  "version": "1",
  "registries": {
    "skills": "~/.agents/registries/skills.json"
  },
  "stores": {
    "exec": "~/.agents/stores/exec.json"
  }
}
```

## Verification

```
pnpm verify  →  lint ✓  typecheck ✓  test (152 passed, 0 failed) ✓  build ✓
```

- 129 existing tests: all pass unchanged
- 23 new tests: 20 resolve + 3 docs-coherence

## Deferred (follow-up issues)

- Remote registry backends (HTTP/S3 adapters)
- Knowledge adapter bridge to docstore
- Exec store remote adapters
- Config file `init` command
