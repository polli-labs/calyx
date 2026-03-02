# POL-673 Baseline Audit — P7B-2 Public Onboarding Docs

**Date:** 2026-03-02
**Branch:** `pol-673-p7b-onboarding-docs-r1`
**Calyx version:** 0.1.1 (post-GA)

## Existing Documentation Inventory

| Document | Lines | Status |
|----------|-------|--------|
| `README.md` | 186 | Has operator quick start; no adopter onboarding |
| `docs/cli-reference.md` | 610 | Complete (8 domains, 25 subcommands, 7 wrappers) |
| `docs/migration-guide.md` | 171 | Complete 4-phase path; assumes legacy familiarity |
| `docs/extension-sdk.md` | 239 | Complete SDK reference with working example |
| `docs/operator-runbook.md` | 226 | Daily operator reference; not an entry point |
| `docs/skills-subsumption-catalogue.md` | 281 | Authoritative disposition matrix v1.0 |
| `docs/migration-wrappers.md` | — | Wrapper replacement map + telemetry |
| `docs/rc-checklist.md` | — | Release candidate process |
| `docs/ci-reliability-runbook.md` | — | CI failure taxonomy |
| `docs/post-ga-support-playbook.md` | — | Support ownership and cadence |
| `docs/post-ga-watchlist.md` | — | Telemetry and monitoring |
| `docs/post-ga-incident-checklist.md` | — | Incident response |

## Docs-Coherence Test Suite

17 tests, all passing. Covers:
- CLI reference completeness (3 tests)
- Migration wrappers completeness (2 tests)
- README completeness (5 tests)
- Extension SDK completeness (2 tests)
- Migration guide completeness (1 test)
- Operator runbook completeness (3 tests)
- Skills subsumption catalogue completeness (4 tests)
- RC checklist completeness (1 test)

## Identified Onboarding Gaps

1. **No dedicated adopter quickstart** — README has a 3-line "operator quick start" that's dev-oriented (`pnpm install` + `pnpm verify`); no public install → first command → orientation narrative.
2. **No conceptual overview for newcomers** — No explanation of what Calyx does or why it exists in plain terms for someone who hasn't used the legacy scripts.
3. **No install contract** — Migration guide mentions `npm install -g @polli-labs/calyx` but there's no environment validation checklist (Node version, pnpm, etc.) in a discoverable entry point.
4. **No first-run contract** — No deterministic "run this single command and see this output" path for a new user.
5. **No surface map** — No concise guide to which doc answers which question (CLI reference vs. operator runbook vs. extension SDK).
6. **No migration signpost for adopters** — Migration guide exists but isn't linked from a natural first-run path.
7. **No extension primer for adopters** — Extension SDK is comprehensive but there's no brief "what extensions can do" summary in an entry-point doc.
8. **No troubleshooting section** — Common first-run issues (wrong Node version, missing pnpm, registry file not found) undocumented in an entry-point context.

## Onboarding Contract Requirements (from ExecPlan)

- **Install contract:** how to install and verify Calyx is callable.
- **First-run contract:** a deterministic first command path with expected outcome.
- **Surface map contract:** where to find command/API docs and when to use each.
- **Migration contract:** where legacy users should go next.
- **Extension contract:** where and how to begin extension development.

## Plan

Create `docs/onboarding.md` covering all five contracts. Update README docs table + links. Add docs-coherence test for new doc. Cross-link from migration guide and operator runbook where appropriate.
