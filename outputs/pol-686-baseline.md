# POL-686 Baseline: P10B Extension Breadth + Starter Template

## Current Extension Capabilities (post-P10A)

### Runtime
- Extension loader (`packages/core/src/extensions.ts`): discovery, manifest validation, API version compat, dynamic import, export validation
- `ExtensionRunner` class: deterministic lifecycle management (activate → beforeCommand → afterCommand → deactivate)
- Domain filtering: hooks only fire for extensions targeting the relevant domain
- Conflict detection: domain-conflict warnings (or errors in strict mode)
- Shadowing: later search paths override earlier ones by extension name

### First-Party Extension
- `packages/calyx-ext-polli` — targets `skills`, `tools`, `agents`
  - Pre-flight checks on sync/deploy/validate commands
  - Environment readiness diagnostics (env var hints)
  - Exit-code diagnostic summaries

### Example Extension
- `examples/calyx-ext-hello` — minimal demo targeting `skills`
  - Console-log lifecycle hooks
  - Standalone manifest validation script (`src/validate.ts`)

### Test Fixtures
- `fixtures/extensions/valid-ext` — basic valid extension
- `fixtures/extensions/another-valid-ext` — multi-domain extension
- `fixtures/extensions/bad-api-version-ext` — API version mismatch
- `fixtures/extensions/invalid-manifest-ext` — invalid manifest
- `fixtures/extensions/missing-calyx-ext` — no calyx key

### SDK Contract
- 8 domains: config, instructions, skills, tools, prompts, agents, knowledge, exec
- 4 lifecycle hooks: activate, beforeCommand, afterCommand, deactivate
- API version: "1"
- Manifest validation with 7 error codes
- Core loader with 7 diagnostic codes

### Docs
- `docs/extension-sdk.md` — full SDK reference
- `docs/cli-reference.md` — includes extensions commands
- `docs/operator-runbook.md` — extension management section

## Target Deltas (P10B)

### 1. `calyx-ext-linear` — second first-party extension
- **Target domains:** `agents`, `exec`
- **Behavior:**
  - `activate`: check for `LINEAR_API_KEY` or `LINEAR_TEAM` env hints
  - `beforeCommand`: validate exec/agents inputs have issue references; hint if missing
  - `afterCommand`: structured diagnostic on failure with Linear-friendly context
  - `deactivate`: clean teardown message
- **Non-destructive:** advisory messages only, never blocks

### 2. Third-party starter template
- **Location:** `examples/extensions/starter/`
- **Contents:**
  - `package.json` with complete calyx manifest
  - `src/index.ts` — annotated extension entrypoint with all hooks
  - `src/validate.ts` — standalone manifest validation
  - `src/__tests__/extension.test.ts` — test scaffold
  - `tsconfig.json`
  - `README.md` — quickstart for external authors
- **Compatible with:** current discovery semantics (search-path parent scan)

### 3. Tests
- `calyx-ext-linear` unit tests (manifest, all hooks, runner integration)
- Starter template fixture-based validation test
- Multi-extension discovery test (polli + linear + hello)

### 4. Doc Updates
- `docs/extension-sdk.md` — add calyx-ext-linear section, starter template workflow
- `docs/cli-reference.md` — no changes expected
- `docs/operator-runbook.md` — mention calyx-ext-linear
- `README.md` — add starter template pointer

## Naming/Layout Decisions
- `calyx-ext-linear` goes in `packages/calyx-ext-linear` (first-party, workspace member)
- Starter template goes in `examples/extensions/starter/` (clear separation from named examples)
- Starter is a workspace member via `examples/*` pattern in pnpm-workspace.yaml
