# CI Reliability Runbook

This runbook classifies CI failure modes, provides an operator decision tree, and documents merge/promotion policy under degraded conditions.

## Canonical verification gate

All CI verification runs through a single command:

```bash
pnpm verify
```

This executes, in order: `lint → typecheck → test → build`. Both `ci.yml` and `release.yml` call `pnpm verify`. The `smoke.yml` workflow is separate and validates CLI surface availability across platforms.

## Failure taxonomy

### 1. Product failures

**Definition:** The code itself fails lint, typecheck, test, or build.

**Detection cues:**
- Error output references source files in `packages/` or `examples/`.
- Failures reproduce locally with `pnpm verify`.

**Action:** Fix the code. Do not merge until `pnpm verify` passes locally and in CI.

### 2. Infrastructure / transient failures

**Definition:** CI fails due to runner environment issues unrelated to the code (network timeouts, registry outages, runner provisioning failures, GitHub Actions service degradation).

**Detection cues:**
- Error occurs during `pnpm install`, `actions/checkout`, or `actions/setup-node`.
- Error messages reference network, DNS, registry, or runner allocation.
- The same commit passes locally with `pnpm verify`.
- GitHub Status (githubstatus.com) reports an incident.

**Action:** Re-run the failed workflow. If persistent, document the incident and wait for resolution. Do not merge with red checks unless the failure is fully classified as transient and local verification passes (see override policy below).

### 3. Billing / plan outage failures

**Definition:** GitHub Actions checks fail at startup or are queued indefinitely because the org has hit a spending limit, exhausted included minutes, or has billing restrictions.

**Detection cues:**
- Workflow runs show "queued" indefinitely or fail immediately with billing/quota errors.
- GitHub org settings → Billing shows spending limit reached or Actions disabled.
- All workflows across all repos in the org are affected, not just this repo.
- The code passes `pnpm verify` locally with no issues.

**Action:** This is an external dependency. Follow the outage override protocol below.

## Operator decision tree

```
CI check failed
│
├─ Can you reproduce locally with `pnpm verify`?
│  ├─ YES → Product failure. Fix the code.
│  └─ NO  → Infrastructure or billing issue. Continue ↓
│
├─ Is GitHub Actions reporting an incident or is this a known billing limit?
│  ├─ BILLING → Outage override protocol (see below).
│  └─ INFRA   → Re-run workflow. If still failing after 2 retries,
│               document and wait.
│
└─ None of the above?
   └─ Investigate further. Check runner logs, compare with recent
      passing runs, and escalate if needed.
```

## Outage override protocol

When CI checks cannot run due to billing or org-level infrastructure issues, merges may proceed under these conditions:

### Required evidence (all must be documented in the PR)

1. **Local gate pass:** Full output of `pnpm verify` passing locally, with timestamp and commit SHA.
2. **Failure classification:** Screenshot or link showing the billing/quota condition or GitHub status incident.
3. **Operator attestation:** The PR author or reviewer explicitly states the failure is infrastructure-only and not a product regression.

### PR comment template

```markdown
## CI Override — Infrastructure Outage

**Commit:** `<SHA>`
**Local `pnpm verify`:** PASS (timestamp: YYYY-MM-DD HH:MM UTC)
**Failure class:** Billing limit / GitHub Actions outage
**Evidence:** [link or screenshot]
**Decision:** Merge with local verification. CI will be re-validated when Actions are restored.
**Operator:** @<github-handle>
```

### Constraints

- Override is only valid for billing/infrastructure failures. Product failures must never be overridden.
- The override must be documented in the PR, not just communicated verbally.
- When Actions are restored, re-run CI on the merged commit to confirm retroactive green status.

## Merge policy summary

| Failure class | Local `pnpm verify` | CI status | Merge allowed? |
|---|---|---|---|
| Product | FAIL | RED | No |
| Product | PASS | RED | No — investigate discrepancy |
| Infra/transient | PASS | RED | Re-run; merge after green |
| Billing/outage | PASS | BLOCKED | Yes, with override protocol |
| All clear | PASS | GREEN | Yes |

## Rollback

If a merge under override is later found to have introduced a regression:

1. Open a revert PR immediately.
2. Document the regression and the original override decision in the revert PR.
3. Update the original PR with a note linking to the revert.

## Related documents

- [RC Checklist](rc-checklist.md) — release candidate process and promotion paths
- [README](../README.md) — local verification instructions
