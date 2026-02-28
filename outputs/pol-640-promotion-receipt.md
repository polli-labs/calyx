# P6A Promotion Receipt

**Issue:** POL-640
**Date:** 2026-02-28T00:55Z
**Operator:** async-runner (blade)

## SHA Mapping

| Field | Value |
|-------|-------|
| Source repo | `polli-labs/calyx-dev` |
| Source tag | `v0.1.0-rc.1` |
| Source commit | `ac1b887347419ac393b60faf11605e6bf8495eb7` |
| Target repo | `polli-labs/calyx` |
| Target branch | `main` |
| Target SHA | `ac1b887347419ac393b60faf11605e6bf8495eb7` |
| Promotion mode | Direct push (first-public-bootstrap) |

## Remotes

```
origin  https://github.com/polli-labs/calyx-dev.git (fetch/push)
public  git@github.com:polli-labs/calyx.git (fetch/push)
```

## Commands Executed

```bash
# 1. Verify tag resolves to expected commit
git rev-parse v0.1.0-rc.1^{commit}
# → ac1b887347419ac393b60faf11605e6bf8495eb7 ✓

# 2. Check public/main existence
git ls-remote public refs/heads/main
# → (empty) — branch does not exist

# 3. Push baseline to initialize public/main
git push public ac1b887347419ac393b60faf11605e6bf8495eb7:refs/heads/main
# → [new branch] ac1b887... -> main ✓

# 4. Verify push
git ls-remote public refs/heads/main
# → ac1b887347419ac393b60faf11605e6bf8495eb7 ✓
```

## Verification

Deterministic: source and target SHA are identical. No merge commits, no rewriting.
