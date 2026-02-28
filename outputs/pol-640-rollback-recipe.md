# P6A Rollback Recipe

**Issue:** POL-640
**Date:** 2026-02-28

## Scenario: Revert Public Main

If the promoted baseline needs to be removed from `polli-labs/calyx`:

### Option A: Delete public main (nuclear — first-bootstrap only)

Only appropriate when `main` has zero downstream consumers/forks:

```bash
# From calyx-dev worktree with public remote configured
git push public --delete main
```

Verify:
```bash
git ls-remote public refs/heads/main
# → (empty)
```

### Option B: Revert commit on public main

If public main has been consumed (forks, clones, CI integrations):

```bash
# Fetch current public state
git fetch public main

# Create revert branch
git checkout -b revert/v0.1.0-rc.1 public/main
git revert --no-edit ac1b887347419ac393b60faf11605e6bf8495eb7

# Push revert and open PR
git push public revert/v0.1.0-rc.1
gh pr create --repo polli-labs/calyx \
  --base main \
  --head revert/v0.1.0-rc.1 \
  --title "Revert v0.1.0-rc.1 promotion" \
  --body "Reverting baseline promotion per POL-640 rollback."
```

### Option C: Force-push to earlier state

Only if repo is still internal-only and no external refs exist:

```bash
git push public --force <earlier-sha>:refs/heads/main
```

**Warning:** Destructive. Requires `--force` and rewrites public history.

## Dry-Run Validation

Rollback Option A was validated during this session:

```bash
# Dry-run: verify we can address the ref
git ls-remote public refs/heads/main
# → ac1b887347419ac393b60faf11605e6bf8495eb7
# Confirmed: ref is addressable and matches expected SHA.
# Actual deletion NOT executed (dry-run only).
```

## Recommendation

For this first-bootstrap promotion:
- **Option A** is the safest rollback path (no history to preserve).
- Transition to **Option B** once public main has external consumers.
- **Option C** should be avoided unless no other option exists.
