# Post-GA Support Playbook

Version: v0.1.1 GA
Effective: 2026-03-02 (first week of public availability)

This playbook defines the support operating model for the first week after Calyx GA release. It covers ownership, intake, severity classification, escalation, and operating cadence.

## Ownership map

| Role | Owner | Scope |
|------|-------|-------|
| Primary support | Caleb (caleb) | All Calyx issues: CLI, SDK, core, publishing, CI |
| Backup / escalation | Polli Labs eng | Architecture decisions, org-level policy, npm org admin |

During the first week, the primary owner monitors all intake channels daily and triages incoming issues within one business day.

## Intake channels

| Channel | Purpose | Response window |
|---------|---------|-----------------|
| GitHub Issues (`polli-labs/calyx`) | Bug reports, feature requests, install problems | 1 business day (triage) |
| Linear project (Calyx) | Internal tracking, agent-filed issues | Same day |
| GitHub Discussions (`polli-labs/calyx`) | Usage questions, community help | 2 business days |

All support interactions are tracked in Linear. GitHub Issues are triaged and linked to Linear issues for unified tracking.

## Severity classification

| Severity | Definition | Response target | Examples |
|----------|-----------|-----------------|----------|
| **S1 — Critical** | Package unusable; install broken for all users; security vulnerability | 4 hours | npm install fails globally, published package contains vulnerability |
| **S2 — High** | Major feature broken; workaround exists but painful | 1 business day | CLI command crashes on valid input, wrapper telemetry emits invalid JSON |
| **S3 — Medium** | Minor feature issue; cosmetic; docs gap | 3 business days | Help text typo, missing example in docs, edge case in fixture handling |
| **S4 — Low** | Enhancement request; nice-to-have | Next sprint | New domain command, additional output formats |

## Escalation protocol

```
Issue received
│
├─ S1 (Critical)
│  ├─ Primary owner investigates immediately.
│  ├─ If npm package is affected: deprecate bad version, prepare hotfix.
│  ├─ If security: follow responsible disclosure; do not publish details until fix ships.
│  └─ Post status update within 4 hours. Escalate to backup if primary unavailable.
│
├─ S2 (High)
│  ├─ Primary owner triages within 1 business day.
│  ├─ Create Linear issue with reproduction steps.
│  ├─ Ship fix in next patch release or document workaround.
│  └─ Escalate to backup if root cause is in org-level infrastructure.
│
├─ S3/S4 (Medium/Low)
│  ├─ Triage and label within response window.
│  ├─ Schedule for current or next sprint.
│  └─ No escalation required unless pattern indicates systemic issue.
│
└─ Unknown severity
   └─ Default to S2 until classified.
```

## First-week operating cadence

### Daily (business days)

1. **Morning scan** (15 min):
   - Check GitHub Issues and Discussions on `polli-labs/calyx`.
   - Check Linear inbox for agent-filed or internal issues.
   - Review npm package health (see [Post-GA Watchlist](post-ga-watchlist.md)).

2. **Watchlist check** (10 min):
   - Run telemetry and package health commands from the watchlist.
   - Flag any signal that crosses a threshold.

3. **Triage** (as needed):
   - Classify new issues by severity.
   - Link GitHub Issues to Linear.
   - Assign or self-assign based on ownership map.

### End of first week

4. **First-week retrospective**:
   - Summarize issues received, classified, and resolved.
   - Identify any recurring patterns or systemic gaps.
   - Decide whether to extend first-week cadence or transition to steady-state.
   - Post retrospective summary to POL-674 and POL-605.

## Steady-state transition

After the first week, if no S1/S2 issues remain open:

- Reduce daily scan to 3x/week.
- Reduce watchlist check to weekly.
- Maintain GitHub Issue → Linear triage pipeline.
- Continue severity classification and escalation protocol as-is.

## Related documents

- [Post-GA Watchlist](post-ga-watchlist.md) — telemetry signals, thresholds, and collection commands
- [Post-GA Incident Checklist](post-ga-incident-checklist.md) — step-by-step incident response
- [Operator Runbook](operator-runbook.md) — canonical daily CLI operations
- [CI Reliability Runbook](ci-reliability-runbook.md) — CI failure taxonomy and override policy
- [RC Checklist](rc-checklist.md) — release process and rollback procedures
