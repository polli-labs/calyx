# POL-670 Dry-Run Receipts

Date: 2026-03-02
Runner: async-runner (claude)
Branch: `pol-670-p7a-runbook-cutover-r1`
Commit base: `cba5c64` (main)

## Summary

Executed the full operator verification checklist from `docs/operator-runbook.md` against the fixture corpus. **All 16 commands exited 0.** No product bugs, no fixture issues, no CLI argument errors.

## Verification checklist results

### Core verification (8 domains)

| # | Command | Exit | Result |
|---|---------|------|--------|
| 01 | `calyx config compile --host blade --parity ...` | 0 | Parity match confirmed |
| 02 | `calyx instructions verify --all --expected-dir ...` | 0 | 2 hosts verified, 0 drifts |
| 03 | `calyx skills validate --strict` | 0 | 3 entries, 0 errors |
| 04 | `calyx tools validate --strict` | 0 | 2 entries, 0 errors |
| 05 | `calyx prompts validate --strict` | 0 | 2 entries, 0 errors |
| 06 | `calyx agents validate --strict` | 0 | 4 entries, 0 errors |
| 07 | `calyx knowledge validate --strict` | 0 | 3 entries, 0 errors |
| 08 | `calyx exec validate --strict` | 0 | 5 runs, 0 errors |

### Extended exec lifecycle

| # | Command | Exit | Result |
|---|---------|------|--------|
| 09 | `calyx exec launch --command "..." (plan-only)` | 0 | Run ID generated, state=queued |
| 10 | `calyx exec status --run-id run-001-succeeded` | 0 | state=succeeded, exit_code=0 |
| 11 | `calyx exec logs --run-id run-001-succeeded` | 0 | 4 entries (3 info, 1 warn) |
| 12 | `calyx exec receipt --run-id run-001-succeeded` | 0 | duration=4.0s, summary OK |

### Additional operator flows

| # | Command | Exit | Result |
|---|---------|------|--------|
| 13 | `calyx skills index` | 0 | 3 items indexed |
| 14 | `calyx skills sync --backend codex (plan-only)` | 0 | 2 plan-sync actions |
| 15 | `calyx knowledge search --query "exec"` | 0 | 1 match found |
| 16 | `calyx --help` | 0 | All 8 domains + 7 wrappers listed |

## Friction points observed

### FR-1: `--help` lists wrappers before domain commands (LOW)

The `calyx --help` output lists compatibility wrappers (`skills-sync`, `skills-sync-claude`, etc.) before the canonical domain command groups (`config`, `instructions`, etc.). A new operator seeing `--help` for the first time gets the deprecated wrappers as the first 7 entries, which could create a wrong first impression.

**Severity:** Low — cosmetic, does not affect functionality.
**Recommendation:** Reorder help output to show domain commands first in a future UX pass (post-GA).

### FR-2: No `--help` per-domain without building (LOW)

Running `calyx config --help` requires building first (`pnpm build`). This is expected for a dev monorepo, but worth noting for operator onboarding — the runbook should mention the build step prerequisite.

**Severity:** Low — documented in prerequisites section.
**Action:** Already addressed in `docs/operator-runbook.md` prerequisites.

## Artifact inventory

All raw command outputs are stored in `outputs/pol-670-dry-run/`:

```
outputs/pol-670-dry-run/
  01-config-compile-blade.txt
  02-instructions-verify.txt
  03-skills-validate.txt
  04-tools-validate.txt
  05-prompts-validate.txt
  06-agents-validate.txt
  07-knowledge-validate.txt
  08-exec-validate.txt
  09-exec-launch-plan.txt
  10-exec-status.txt
  11-exec-logs.txt
  12-exec-receipt.txt
  13-skills-index.txt
  14-skills-sync-plan.txt
  15-knowledge-search.txt
  16-help.txt
```

## Conclusion

The operator runbook is executable end-to-end on the current fixture corpus. All canonical `calyx <domain> <verb>` commands work as documented. Friction points are cosmetic (help ordering) and already mitigated in the runbook. No blocking issues found.
