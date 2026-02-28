# P6A Promotion Strategy

**Issue:** POL-640
**Date:** 2026-02-28
**Source:** `polli-labs/calyx-dev` (private)
**Target:** `polli-labs/calyx` (public)

## Strategy Selection

**Mode: Direct push (first-public-bootstrap)**

Since `polli-labs/calyx` had no existing `main` branch, PR-based promotion was
not possible. The baseline commit was pushed directly to initialize `main`.

### Decision Criteria

| Option | Viable | Notes |
|--------|--------|-------|
| `git subtree` | No | Unnecessary complexity for full-repo promotion |
| Mirror push | No | Would carry private branch history |
| Cherry-pick | No | Single baseline commit; no selective picking needed |
| Direct ref push | **Yes** | Clean, deterministic, auditable for first bootstrap |

### Promotion Command

```bash
git push public ac1b887347419ac393b60faf11605e6bf8495eb7:refs/heads/main
```

### Source Baseline

- **Tag:** `v0.1.0-rc.1`
- **Commit:** `ac1b887347419ac393b60faf11605e6bf8495eb7`
- **Message:** `feat: P5 publishability + release candidate lane (POL-639) (#7)`
- **Includes:** P1 through P5 proving lanes (POL-627, POL-633, POL-637, POL-638, POL-639)

### Future Promotions

Once `public/main` exists, subsequent promotions should use PR-based flow:

```bash
# Create promotion branch in calyx-dev
git checkout -b promote/v0.1.1-rc.1 v0.1.1-rc.1

# Push to public remote
git push public promote/v0.1.1-rc.1

# Open PR: promote/v0.1.1-rc.1 -> main on polli-labs/calyx
gh pr create --repo polli-labs/calyx \
  --base main \
  --head promote/v0.1.1-rc.1 \
  --title "Promote v0.1.1-rc.1 from calyx-dev" \
  --body "Source: calyx-dev@<sha>"
```

This ensures review gates and CI validation before public main advances.
