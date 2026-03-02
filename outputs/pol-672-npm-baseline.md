# POL-672 npm Registry Baseline

Captured: 2026-03-02 via `registry.npmjs.org` API queries.

## @polli-labs/calyx-core

| Field | Value |
|-------|-------|
| latest | 0.1.0 |
| trusted-smoke | 0.1.5-trusted.0 |
| published versions | 0.1.0, 0.1.5-trusted.0 |
| latest publish time | 2026-03-02T18:01:22.783Z |

## @polli-labs/calyx-sdk

| Field | Value |
|-------|-------|
| latest | 0.1.0 |
| trusted-smoke | 0.1.5-trusted.0 |
| published versions | 0.1.0, 0.1.5-trusted.0 |
| latest publish time | 2026-03-02T18:01:25.670Z |

## @polli-labs/calyx

| Field | Value |
|-------|-------|
| latest | 0.1.0 |
| trusted-smoke | 0.1.5-trusted.0 |
| published versions | 0.1.0, 0.1.5-trusted.0 |
| latest publish time | 2026-03-02T18:01:27.996Z |

## @polli-labs/calyx-web

| Field | Value |
|-------|-------|
| latest | 0.1.0 |
| trusted-smoke | 0.1.5-trusted.0 |
| published versions | 0.1.0, 0.1.5-trusted.0 |
| latest publish time | 2026-03-02T18:01:30.500Z |

## Summary

All four packages are published at `0.1.0` with `latest` dist-tag. The `trusted-smoke` dist-tag points to `0.1.5-trusted.0` across all four packages (from prior trusted-publisher verification runs). No GA tag (`v0.1.0`) exists in the git history, but the npm versions were published during the RC/smoke phase.

## Implication for GA Cut

Publishing `0.1.0` again would fail with a duplicate version error. A version bump is required for a clean GA release (see ga-decision.md).
