# POL-672 GA Version Decision

## Decision: Path B — Patch GA cut (`v0.1.1`)

## Evidence

1. **npm state**: All four `@polli-labs/calyx-*` packages already have `0.1.0` published on npm with `latest` dist-tag as of 2026-03-02T18:01Z.

2. **Workflow readiness**: The release workflow (`.github/workflows/release.yml`) executes `pnpm publish --provenance` unconditionally for each package. There is no skip-if-exists or idempotency guard. Pushing a `v0.1.0` tag would trigger publish attempts that fail with HTTP 403/409 duplicate version errors.

3. **Path A analysis**: Path A would require adding skip-if-exists logic to the release workflow before tagging. This is:
   - More invasive than a simple version bump
   - Introduces error-masking risk (skip-if-exists could hide real publish failures)
   - Would not produce fresh publish receipts (the existing `0.1.0` was published during smoke testing, not a formal GA workflow run)

4. **Path B analysis**: Bumping to `0.1.1` is:
   - Minimal change (version strings in 5 package.json files + root)
   - Produces clean, unambiguous publish receipts from a real GA workflow run
   - Justified by 6 meaningful commits since `v0.1.0-rc.1` (P4 through P7A-2 — migration wrappers, CI hardening, promotion hardening, legacy wrapper guardrails)
   - The first canonical GA cut with full trusted-publishing provenance

## Decision Rule Applied

> Choose the smallest change that yields a successful, repeatable, policy-compliant GA release with green receipts.

Path B is the smallest change. Path A requires workflow modifications that are larger in scope and introduce masking risk. Path B produces stronger evidence (fresh publish receipts) with less risk.

## Execution Plan

1. Bump all package versions from `0.1.0` to `0.1.1` (root + 4 packages)
2. Update workspace dependency references if any use exact versions
3. Run local quality gate (`pnpm install --frozen-lockfile && pnpm verify`)
4. Commit, PR to `calyx-dev`, merge
5. Promote to public repo
6. Push `v0.1.1` tag to public remote to trigger release workflow
7. Verify publish + provenance receipts
