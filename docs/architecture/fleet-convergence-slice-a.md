# Fleet Convergence Slice A

POL-1754 is an observe-and-read slice for the convergence model ratified on
2026-06-10. It persists the facts Calyx already computes and adds one typed
read surface. It does not reconcile, poke, apply, escalate, or change the
semantics of `self upgrade`.

## State Row

Migration `0005` adds `fleet_convergence`, keyed by `(host, leg)`.
Migration `0006` preserves that table shape while allowing an unknown
`target_rev` to be stored as `null`; non-SHA target refs are not persisted as
target revisions.

| Column | Meaning |
| --- | --- |
| `host` | Fleet host alias. |
| `leg` | Closed v1 set: `daemon_build`, `skills`, `instructions`. |
| `target_rev` | Desired revision for the leg: a resolved full SHA, or `null` when the target is unknown. Never a ref string such as `origin/main`. |
| `observed_rev` | Observed revision, when reachable. |
| `converged_from` | Class-0 source-checkout SHA used for the observation or attempted convergence. |
| `policy` | Closed policy vocabulary: `auto`, `windowed`, `operator_gated`. |
| `last_checked_at` | ISO timestamp from the observation/update. |
| `verdict` | Closed verdict vocabulary: `fresh`, `pending`, `structural`. |
| `receipt_path` | Optional receipt or aggregate receipt path. |
| `receipt_id` | Optional receipt/event identifier. |
| `detail` | Optional bounded human-readable detail. |
| `payload_json` | JSON detail for the observation source. |

`self freshness` maps its existing daemon host verdicts into convergence
verdicts: `fresh` stays `fresh`, `usable_with_warnings` and `stale` become
`pending`, unreachable/offline `blocked` hosts become `pending`, and structural
blocked causes such as broken/critical/incompatible drift become `structural`.
Freshness write-through is best-effort: unavailable or unmigrated state emits
a structured warning and never changes the freshness exit code. Routine
freshness updates preserve existing receipt linkage.

`self upgrade --fleet` writes `pending` rows for failed or skipped hosts, using
the fleet target SHA when available, recording the conductor checkout HEAD as
`converged_from`, and linking the aggregate receipt path. Dry-runs do not write
pending rows. Persistence is best-effort and happens after the receipt/control
event path so it cannot mask the upgrade outcome.

## Read Surface

`calyx fleet status [--host <host>] [--json]` is read-only and answers one
question: "which hosts are converged per leg?"

JSON envelope:

```json
{
  "schema_version": "fleet-convergence-status/v1",
  "checked_at": "2026-06-10T20:00:00.000Z",
  "hosts": [
    {
      "host": "mba",
      "verdict": "pending",
      "legs": [
        {
          "leg": "daemon_build",
          "verdict": "pending",
          "policy": "auto",
          "target_rev": "e0574b2...",
          "observed_rev": null,
          "converged_from": "a0b1c2d...",
          "last_checked_at": "2026-06-10T19:00:00.000Z",
          "receipt_path": "/Users/carbon/.calyx/self-upgrade-receipts/.../summary.json"
        }
      ]
    }
  ],
  "summary": {
    "fresh": 0,
    "pending": 1,
    "structural": 0,
    "missing": 0
  }
}
```

The command does not reach out to hosts. It reads the local state store only.
Freshness and upgrade remain the observation/write-through surfaces.
