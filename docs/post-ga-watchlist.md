# Post-GA Telemetry Watchlist

Version: v0.1.1 GA
Effective: 2026-03-02 (first week of public availability)

This watchlist defines the signals to monitor during the first week after Calyx GA. Each signal has a source, collection command, threshold, and response action.

## Signal categories

1. [Package health](#1-package-health)
2. [Install and publish](#2-install-and-publish)
3. [CI and release pipeline](#3-ci-and-release-pipeline)
4. [Wrapper deprecation telemetry](#4-wrapper-deprecation-telemetry)
5. [Adoption and usage](#5-adoption-and-usage)

---

## 1. Package health

### 1a. npm registry availability

**Source:** npm registry
**Collection:**

```bash
# Check all 4 packages are resolvable and show latest version
npm info @polli-labs/calyx-core --json | jq '{name: .name, version: .version, deprecated: .deprecated}'
npm info @polli-labs/calyx --json | jq '{name: .name, version: .version, deprecated: .deprecated}'
npm info @polli-labs/calyx-sdk --json | jq '{name: .name, version: .version, deprecated: .deprecated}'
npm info @polli-labs/calyx-web --json | jq '{name: .name, version: .version, deprecated: .deprecated}'
```

**Threshold:** Any package returns an error or shows `deprecated: true` unexpectedly.
**Action:** Investigate immediately (S1). Check npm org permissions, trusted publishing pipeline, and recent publish actions.

### 1b. Package install smoke test

**Source:** Clean install in temp directory
**Collection:**

```bash
# Smoke test install from registry
tmp=$(mktemp -d) && cd "$tmp" && npm init -y --silent && \
  npm install @polli-labs/calyx@latest 2>&1 && \
  npx calyx --help && \
  echo "PASS: install smoke test" && \
  cd - && rm -rf "$tmp"
```

**Threshold:** Install fails or `calyx --help` returns non-zero exit.
**Action:** Classify as S1 if reproducible. Check package tarball integrity, peer dependency conflicts, and Node.js version requirements (>= 22).

### 1c. Provenance attestation

**Source:** npm provenance via Sigstore
**Collection:**

```bash
# Verify provenance attestation exists for latest published version
npm audit signatures 2>&1 | head -20
```

**Threshold:** Missing or invalid provenance attestation on any published package.
**Action:** Investigate trusted publishing pipeline. Check GitHub Actions `release.yml` logs for provenance generation step. Classify as S2 (provenance is a trust signal, not a functional blocker).

---

## 2. Install and publish

### 2a. GitHub Actions release pipeline

**Source:** GitHub Actions (`release.yml`)
**Collection:**

```bash
# Check latest release workflow run status (calyx-dev)
gh run list --repo polli-labs/calyx-dev --workflow release.yml --limit 3

# Check latest release workflow run status (calyx public)
gh run list --repo polli-labs/calyx --workflow release.yml --limit 3
```

**Threshold:** Most recent release run is failed or cancelled.
**Action:** Check run logs. If product failure, fix and re-release. If infra, follow [CI Reliability Runbook](ci-reliability-runbook.md).

### 2b. npm publish permissions

**Source:** npm org settings
**Collection:**

```bash
# Verify publish access for the org scope
npm access list packages @polli-labs 2>&1 | head -10
```

**Threshold:** Publish access revoked or changed unexpectedly.
**Action:** Escalate to npm org admin (backup owner). Restore permissions before next release.

---

## 3. CI and release pipeline

### 3a. CI workflow health

**Source:** GitHub Actions (`ci.yml`, `smoke.yml`)
**Collection:**

```bash
# Check CI status on main branch (calyx-dev)
gh run list --repo polli-labs/calyx-dev --branch main --limit 5

# Check CI status on main branch (calyx public)
gh run list --repo polli-labs/calyx --branch main --limit 5
```

**Threshold:** Two consecutive failures on main that are not transient retries.
**Action:** Investigate per [CI Reliability Runbook](ci-reliability-runbook.md) decision tree. If billing/quota, follow outage override protocol.

### 3b. Local verification gate

**Source:** Local clone
**Collection:**

```bash
# Run the canonical verification gate
pnpm install --frozen-lockfile && pnpm verify
```

**Threshold:** Any stage fails (lint, typecheck, test, build).
**Action:** Product failure — fix before next release. This is the ground-truth gate.

---

## 4. Wrapper deprecation telemetry

### 4a. Wrapper invocation volume

**Source:** stderr logs from hosts running `calyx` wrappers
**Collection:**

```bash
# Search for wrapper telemetry events in recent logs
# (Adjust log path per host; example for blade)
grep -r '"event":"calyx.wrapper.invoked"' ~/.agents/logs/ 2>/dev/null | \
  jq -s 'group_by(.wrapper) | map({wrapper: .[0].wrapper, count: length})' 2>/dev/null || \
  echo "No wrapper telemetry events found (expected if all usage is canonical)"
```

**Threshold:** Any wrapper showing increasing invocation count week-over-week after GA.
**Action:** Identify the host/workflow still using legacy entrypoints. Update the workflow to use canonical commands per [Migration Guide](migration-guide.md).

### 4b. Deprecation enforcement status

**Source:** Environment configuration
**Collection:**

```bash
# Check which hosts have enforcement enabled
# (Run on each fleet host)
echo "CALYX_FAIL_ON_DEPRECATED=${CALYX_FAIL_ON_DEPRECATED:-unset}"
```

**Threshold:** No hosts have enforcement enabled by end of first week.
**Action:** Plan rollout of `CALYX_FAIL_ON_DEPRECATED=1` to at least one non-production host as a migration signal.

---

## 5. Adoption and usage

### 5a. npm download trends

**Source:** npm registry
**Collection:**

```bash
# Check weekly downloads (available after ~48h of publishing)
npm info @polli-labs/calyx --json | jq '.downloads'
# Or use the npm API directly:
# curl -s "https://api.npmjs.org/downloads/point/last-week/@polli-labs/calyx" | jq .
```

**Threshold:** Informational only during first week. Establish baseline.
**Action:** Record baseline download count for week-over-week tracking.

### 5b. GitHub issue volume

**Source:** GitHub Issues
**Collection:**

```bash
# Count open issues on public repo
gh issue list --repo polli-labs/calyx --state open --json number | jq length
```

**Threshold:** More than 5 open issues in first week suggests systemic adoption friction.
**Action:** Prioritize triage. If pattern emerges (e.g., all install-related), escalate to S2 and investigate root cause.

---

## Daily watchlist runsheet

Quick-reference command block for the daily morning scan:

```bash
echo "=== Package Health ==="
npm info @polli-labs/calyx --json 2>&1 | jq '{v: .version, dep: .deprecated}'

echo "=== CI Status (calyx-dev) ==="
gh run list --repo polli-labs/calyx-dev --branch main --limit 3

echo "=== CI Status (calyx public) ==="
gh run list --repo polli-labs/calyx --branch main --limit 3

echo "=== Open Issues ==="
gh issue list --repo polli-labs/calyx --state open --limit 10

echo "=== Wrapper Telemetry ==="
grep -c '"calyx.wrapper.invoked"' ~/.agents/logs/*.log 2>/dev/null || echo "No wrapper events"
```

## Related documents

- [Post-GA Support Playbook](post-ga-support-playbook.md) — ownership, intake, escalation
- [Post-GA Incident Checklist](post-ga-incident-checklist.md) — step-by-step incident response
- [Migration Wrappers](migration-wrappers.md) — wrapper telemetry contract and deprecation policy
- [CI Reliability Runbook](ci-reliability-runbook.md) — CI failure taxonomy and override policy
