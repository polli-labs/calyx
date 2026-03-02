# POL-674 Support Readiness Baseline Audit

**Date:** 2026-03-02
**Branch:** `pol-674-p7b-support-readiness-r1`
**GA Version:** v0.1.1
**Auditor:** async-runner (POL-674)

## Current Documentation Inventory

| Document | Path | Status |
|----------|------|--------|
| CLI Reference | `docs/cli-reference.md` | Current — all 8 domains + wrappers |
| Extension SDK | `docs/extension-sdk.md` | Current — contracts, lifecycle, quick start |
| Migration Guide | `docs/migration-guide.md` | Current — 4-phase walkthrough |
| Migration Wrappers | `docs/migration-wrappers.md` | Current — 7 implemented, 12 deferred tombstones |
| RC Checklist | `docs/rc-checklist.md` | Current — v0.1.0-rc.1 process, promotion paths |
| Operator Runbook | `docs/operator-runbook.md` | Current — canonical daily reference (POL-670) |
| CI Reliability Runbook | `docs/ci-reliability-runbook.md` | Current — failure taxonomy, override protocol |
| CI Signal Revalidation | `docs/ci-signal-revalidation-receipts.md` | Current — POL-642 receipts |
| ADR-0002 | `docs/adr/adr-0002-repo-structure-and-build.md` | Current — repo structure decisions |

## Existing Support-Adjacent Coverage

### Operational coverage (STRONG)
- Operator runbook provides daily workflow reference for all 8 domains.
- CI reliability runbook covers failure taxonomy, decision tree, and override protocol.
- Operator runbook escalation path: product bug → Linear, infra → CI runbook, external → wait.
- Exit code semantics documented (0, 2, 3, 4, 5).

### Telemetry coverage (GOOD)
- `calyx.wrapper.invoked` telemetry fully implemented (POL-671).
- Schema: `{ event, wrapper, target, timestamp, pid, cwd, deprecation_phase }`.
- 6 unit tests covering wrapper telemetry contract.
- `CALYX_FAIL_ON_DEPRECATED` env var for warn/error phase control.

### Release coverage (GOOD)
- RC checklist covers pre-release verification, promotion paths, rollback.
- GA decision documented in `outputs/pol-672-ga-decision.md`.
- Trusted publishing posture (no static NPM_TOKEN).

## Identified Gaps (POL-674 Scope)

### GAP-1: No post-GA support playbook
- No formal support ownership map (primary/backup roles).
- No intake channel definitions or response windows.
- No severity classification for support requests.
- No escalation protocol beyond "file a Linear issue."
- No first-week operating cadence defined.

### GAP-2: No telemetry watchlist
- Wrapper telemetry exists but no consolidated watchlist of signals to monitor.
- No defined thresholds or alert conditions.
- No collection commands for operators to run during first-week monitoring.
- No package health check procedures (npm download counts, install success).

### GAP-3: No incident response checklist
- CI reliability runbook covers CI failures but not:
  - Install failures (user-side `npm install` issues).
  - Publish/provenance failures (trusted publishing pipeline).
  - Auth/permission failures (npm access, GitHub Actions permissions).
  - Communication templates for status updates.
  - Closure criteria for incidents.

### GAP-4: No README or release-doc links to support surfaces
- Documentation table in README lists 8 docs but no support-facing content.
- RC checklist post-RC section mentions "collect feedback" but doesn't link to support resources.

## Planned Deliverables

| Deliverable | Target Path | Gaps Addressed |
|-------------|-------------|----------------|
| Post-GA Support Playbook | `docs/post-ga-support-playbook.md` | GAP-1 |
| Post-GA Watchlist | `docs/post-ga-watchlist.md` | GAP-2 |
| Post-GA Incident Checklist | `docs/post-ga-incident-checklist.md` | GAP-3 |
| README update | `README.md` | GAP-4 |
| RC Checklist update | `docs/rc-checklist.md` | GAP-4 |

## Evidence References

- Git log: 10 commits from P3A through P7B-1 (latest: `741e608`).
- Outputs directory: 9 receipt files from POL-640, POL-670, POL-672.
- Package version: `0.1.1` (root `package.json`).
- All 4 packages published to npm at `0.1.0` with `latest` tag.
