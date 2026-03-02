# POL-670 Runbook Audit

Date: 2026-03-02
Auditor: async-runner (claude)
Branch: `pol-670-p7a-runbook-cutover-r1`

## Audit scope

Inventory of all operator-facing documentation in the Calyx repo, assessed for:
- Whether canonical `calyx <domain> <verb>` commands are the default path
- Whether legacy wrappers are clearly marked as transitional
- Presence of an operator-oriented quick reference / daily checklist
- Failure classification and verification flow documentation

## Document inventory

| Document | Calyx-first? | Wrapper mentions | Status |
|----------|-------------|-----------------|--------|
| `README.md` | Yes | Section exists, framed as "Migration wrappers" | Minor gaps |
| `docs/cli-reference.md` | Yes | Wrappers section at end, properly framed | Good |
| `docs/ci-reliability-runbook.md` | Yes | None | Good |
| `docs/rc-checklist.md` | Yes | None | Good |
| `docs/migration-guide.md` | Mixed | Core content is about wrappers (by design) | Needs P7A callout |
| `docs/migration-wrappers.md` | N/A (reference) | Full wrapper map | Good as-is |
| `docs/extension-sdk.md` | N/A | None | Good |

## Findings

### F1: No dedicated operator runbook (HIGH)

There is no single document an operator can follow for daily Calyx usage. The README has full domain command examples, and the CI runbook covers failure triage, but there is no condensed "here are the 5 commands you run daily and how to verify success" checklist.

**Action:** Create `docs/operator-runbook.md` with:
- Canonical command patterns for all 8 domains
- Operator verification flow (what "success" looks like)
- Failure classification decision tree (product bug vs infra vs external)
- Quick reference table for common tasks

### F2: README lacks operator quick-start section (MEDIUM)

The README is comprehensive but developer-oriented. An operator scanning the README for "how do I run the daily config compile" must read through package descriptions, workspace layout, and build instructions first.

**Action:** Add a concise "Operator quick start" section near the top of the README, linking to the operator runbook.

### F3: Migration Guide has no "current phase" marker (LOW)

The migration guide walks through Phases 1-4 but doesn't indicate that internal operators should now be at Phase 3 (canonical commands). A new operator reading the guide might start at Phase 1.

**Action:** Add a prominent "P7A status" callout box indicating that internal operations are at Phase 3 and all new runbooks should use canonical commands.

### F4: No explicit wrapper deprecation timeline (LOW)

Wrappers are documented as "transitional" but there's no explicit timeline or criteria for when they will be removed beyond "usage drops to zero."

**Action:** Add a note to migration-wrappers.md documenting P7A as the canonical cutover point and stating that wrapper removal is targeted for post-GA.

### F5: Exec domain dry-run path underdocumented (MEDIUM)

The README and CLI reference show `exec launch` with fixtures, but there's no documented "validate the entire exec lifecycle end-to-end" sequence that an operator would follow.

**Action:** Include exec lifecycle verification in the operator runbook with the full launch → status → logs → receipt chain.

## Gap summary

| ID | Severity | Fix in this PR | Follow-up issue? |
|----|----------|---------------|-----------------|
| F1 | HIGH | Yes — create operator runbook | No |
| F2 | MEDIUM | Yes — add README section | No |
| F3 | LOW | Yes — add migration guide callout | No |
| F4 | LOW | Yes — add timeline note | No |
| F5 | MEDIUM | Yes — cover in operator runbook | No |

All gaps are addressable within this lane. No blocking issues identified.
