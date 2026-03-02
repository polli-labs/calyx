# Post-GA Incident Response Checklist

Version: v0.1.1 GA
Effective: 2026-03-02 (first week of public availability)

Step-by-step incident response for the most likely failure classes during early Calyx adoption. Each scenario includes detection, containment, resolution, and communication steps.

## General incident protocol

For any incident:

1. **Detect** — identify the failure class using the sections below.
2. **Contain** — limit blast radius (deprecate broken packages, disable pipelines, post notice).
3. **Fix** — resolve root cause.
4. **Verify** — confirm fix with `pnpm verify` and production smoke test.
5. **Communicate** — post status update using the [communication template](#communication-template).
6. **Close** — file Linear issue with receipt, update tracking issues.

---

## Scenario 1: Install failure

**Symptoms:** Users report `npm install @polli-labs/calyx` fails. Errors include peer dependency conflicts, missing packages, or resolution failures.

### Detection

```bash
# Reproduce in clean environment
tmp=$(mktemp -d) && cd "$tmp" && npm init -y --silent
npm install @polli-labs/calyx@latest 2>&1
echo "Exit: $?"
cd - && rm -rf "$tmp"
```

### Containment

- If the package itself is broken: `npm deprecate @polli-labs/calyx@<bad-version> "Install issue identified, use <good-version>"`
- If a dependency is broken: document workaround (e.g., resolution override) and post to GitHub Issues.

### Resolution checklist

- [ ] Reproduce locally with exact Node.js version (>= 22) and npm version.
- [ ] Check `package.json` peer dependencies and engines field.
- [ ] Check if `pnpm install --frozen-lockfile` succeeds in repo.
- [ ] If package tarball is corrupt: re-publish with patch version bump.
- [ ] If peer dependency conflict: update dependency constraints and publish patch.
- [ ] Verify fix: run install smoke test from [watchlist](post-ga-watchlist.md#1b-package-install-smoke-test).

### Severity: S1 (if affects all installs) or S2 (if environment-specific)

---

## Scenario 2: Publish / provenance failure

**Symptoms:** Tag push to GitHub does not trigger publish, or publish completes but provenance attestation is missing or invalid.

### Detection

```bash
# Check if release workflow ran
gh run list --repo polli-labs/calyx --workflow release.yml --limit 3

# Check if package version is on npm
npm info @polli-labs/calyx@<expected-version> --json | jq '{version, deprecated}'

# Check provenance
npm audit signatures 2>&1 | head -20
```

### Containment

- If publish did not trigger: do not re-tag. Investigate workflow trigger conditions first.
- If published without provenance: the package is functional but trust-degraded. Document and plan re-publish.

### Resolution checklist

- [ ] Verify tag format matches `release.yml` trigger pattern (`v*`).
- [ ] Check GitHub Actions permissions: `id-token: write` and `packages: write` must be present.
- [ ] Check npm trusted publishing configuration (no static `NPM_TOKEN` — uses OIDC).
- [ ] If workflow failed mid-publish: check which packages published and which didn't.
- [ ] If partial publish: manually publish missing packages from local with `npm publish --provenance --access public` (requires npm login with 2FA — escalate to backup owner if needed).
- [ ] Verify fix: check `npm info` and `npm audit signatures` for all 4 packages.

### Severity: S1 (if no packages published) or S2 (if provenance-only)

---

## Scenario 3: Auth / permission failure

**Symptoms:** GitHub Actions cannot authenticate to npm, or npm org permissions have changed preventing publish.

### Detection

```bash
# Check npm access
npm access list packages @polli-labs 2>&1

# Check GitHub Actions workflow run logs for auth errors
gh run view <run-id> --repo polli-labs/calyx --log 2>&1 | grep -i "auth\|permission\|403\|401"
```

### Containment

- Do not attempt manual publish with personal tokens — this would break the trusted publishing chain.
- Document the auth failure and escalate to npm org admin.

### Resolution checklist

- [ ] Verify npm org 2FA policy has not changed.
- [ ] Verify GitHub Actions OIDC provider is configured for the npm org.
- [ ] Check if npm org billing/plan affects publish permissions.
- [ ] If GitHub-side: verify repository Actions permissions (Settings → Actions → General).
- [ ] If npm-side: verify trusted publishing link between GitHub repo and npm packages.
- [ ] After fix: trigger a test publish with a prerelease version to validate pipeline end-to-end.

### Severity: S1 (blocks all future releases until resolved)

---

## Scenario 4: CI / release pipeline outage

**Symptoms:** CI workflows queue indefinitely, fail at setup, or produce infrastructure errors unrelated to code.

### Detection

```bash
# Check GitHub Actions status
gh run list --repo polli-labs/calyx-dev --limit 5

# Check if it reproduces locally
pnpm install --frozen-lockfile && pnpm verify
```

### Containment

- If local verify passes: this is infrastructure-only. Follow [CI Reliability Runbook](ci-reliability-runbook.md) outage override protocol.
- If local verify fails: this is a product failure. Do not use override protocol.

### Resolution checklist

- [ ] Classify failure per [CI Reliability Runbook](ci-reliability-runbook.md) decision tree.
- [ ] If billing/quota: check GitHub org billing settings. Contact org admin.
- [ ] If runner issue: re-run workflow (up to 2 retries).
- [ ] If GitHub Actions incident: check [githubstatus.com](https://githubstatus.com). Wait for resolution.
- [ ] If merge is urgent: use outage override protocol (document evidence in PR).
- [ ] After resolution: re-run CI on latest main to confirm retroactive green.

### Severity: S2 (blocks releases but not existing installs)

---

## Scenario 5: CLI runtime crash

**Symptoms:** Users report `calyx <domain> <verb>` crashes with unhandled exception, stack trace, or silent exit.

### Detection

```bash
# Reproduce with the reported command
calyx <domain> <verb> <flags> 2>&1
echo "Exit: $?"

# Check against fixture corpus
pnpm test 2>&1 | tail -20
```

### Containment

- If crash affects a core workflow: document workaround (direct Node.js invocation, alternative flags).
- If crash is edge-case: label S3 and schedule fix.

### Resolution checklist

- [ ] Reproduce with exact inputs, Node.js version, and OS.
- [ ] Check exit code semantics (0/1/2/3/4/5 — see [Migration Wrappers](migration-wrappers.md#exit-codes)).
- [ ] Add failing test case to vitest suite.
- [ ] Fix and verify: `pnpm verify` must pass.
- [ ] Publish patch release if S1/S2.

### Severity: S1 (if core workflow unusable) or S3 (if edge case)

---

## Communication template

Use this template for status updates on S1/S2 incidents. Post to:
- GitHub Issue on `polli-labs/calyx` (public-facing).
- Linear issue on Calyx project (internal tracking).

```markdown
## Incident Update — [TITLE]

**Status:** [Investigating | Identified | Fix deployed | Resolved]
**Severity:** [S1 | S2]
**Affected:** [packages / commands / pipelines affected]
**Impact:** [What users experience]

### Timeline
- **HH:MM UTC** — [Event description]

### Current status
[What we know and what we're doing]

### Workaround
[If available, steps users can take now]

### Next update
[Expected time of next update]
```

## Closure criteria

An incident is closed when:

- [ ] Root cause is identified and documented.
- [ ] Fix is deployed (patch release published or pipeline restored).
- [ ] Smoke test passes (install + CLI help + `pnpm verify`).
- [ ] Communication posted: final status update with root cause and resolution.
- [ ] Linear issue created with receipt linking to fix PR and incident timeline.
- [ ] Post-incident review captured (for S1 incidents): what happened, why, what we'll change.

## Related documents

- [Post-GA Support Playbook](post-ga-support-playbook.md) — ownership, intake, severity, escalation
- [Post-GA Watchlist](post-ga-watchlist.md) — monitoring signals and collection commands
- [CI Reliability Runbook](ci-reliability-runbook.md) — CI-specific failure taxonomy and override protocol
- [RC Checklist](rc-checklist.md) — release process and rollback procedures
- [Migration Wrappers](migration-wrappers.md) — exit code semantics and wrapper telemetry
