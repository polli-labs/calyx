# POL-1732 Monitor Wake Interface Sketch

Status: implemented base sketch for POL-1732a plus delivery extensions
from POL-1732b/POL-1761.

This slice adds the first monitor/wakeup bridge without creating a second
daemon, scheduler, harness hook dependency, or predicate DSL. The run service
evaluates typed predicates while `calyx run serve` is alive. Tier-0 delivery is
durable local state plus JSONL receipts plus the existing server-sent event
stream; delivery bindings add ntfy, Linear comment, vault receipt, Codex
automation, and Claude re-invocation
adapters as delivery side effects only.

## Predicate Vocabulary

All persisted predicates use `schema_version: "predicate/v1"` and a typed
`kind`. The v1 evaluator accepts only this bounded vocabulary:

- Run predicates: `run.terminal`, `run.failed`, `run.health_stale`.
- Artifact predicates: `artifact.exists`, `artifact.changed`.
- Receipt predicate: `receipt.appeared`.
- Tracker predicates: `tracker.state_changed`, `tracker.label_changed`.
- Vault predicate: `vault.path_changed`.
- Time predicates: `time.cron`, `time.after`.
- Shallow combinators: `all_of`, `any_of`, `debounce`, `for_duration`.

Every evaluation returns a `predicate-evaluation/v1` record with `matched`,
`transition_hash`, a persisted cursor, and evidence records. Evidence records
name the source, locator, observed value or cursor, and status; transcript
content is never embedded.

## Monitor Object

`monitors` is the authoritative SQLite object table. A monitor has:

- `monitor_id`, `schema_version`, `status`, `created_at`, `updated_at`.
- Ownership/provenance: `owner`, `created_by`, `create_provenance`.
- Scope: `assigned_host`, `source_run_id`, `preset`.
- Trigger: `predicate_json`, `rearm_policy`.
- Delivery policy: `delivery_json` with unconditional Tier-0 semantics and
  optional delivery bindings.
- Runtime state: `last_evaluated_at`, `last_match`, `last_transition_hash`,
  `last_wake_id`, `last_error`.

`monitor_cursors` persists predicate cursors and debounce/for-duration state so
daemon restarts resume evaluation. `monitor_history` records create, evaluate,
wake, ack, cancel, delivery, and error events. `monitor_wakes` records pending
and acked wake records with a unique `(monitor_id, transition_hash)` key for
idempotency. `monitor_deliveries` records delivery-state rows keyed by
`(wake_id, binding_id)` so re-evaluation or daemon restart cannot duplicate a
delivery. Wake retention is indefinite until an explicit operator policy
changes it.

## Edge Triggering

The evaluator is edge-triggered by default and stores enough state to make
repeated evaluation idempotent:

- `once`: fire the first matched transition only. For terminal
  `runner-supervision` wakes, record the durable wake and then mark the monitor
  `cancelled` so it leaves the active evaluator set while wake history remains
  pullable.
- `rearm_on_reset`: fire when the predicate changes from false to true.
- `every_change`: fire each matched transition whose hash differs from the
  prior matched transition.

Repeated evaluation of the same matched transition uses the SQLite uniqueness
constraint to avoid duplicate wakes.

## Tier-0 Delivery

Tier-0 delivery writes one wake row, appends one JSONL receipt, and emits one
`monitor.wake.created` event through the existing run-service stream. The event
contains the monitor id, wake id, transition hash, source run id, summary,
suggested follow-up commands, receipt path, and bounded evidence metadata.

## Delivery Bindings

Delivery is a typed per-monitor policy. Each binding has an adapter and its own
materiality filter; there is no global score or global wake materiality.
Bindings currently support:

- `ntfy`: posts a compact wake summary to the existing fleet ntfy URL/topic
  convention, with per-binding `url` and `topic` overrides. The conservative
  built-in fallback topic is `agent-notify`; operators should set scratch topics
  during dogfood.
- `linear_comment`: creates a Linear issue comment using the existing
  `LINEAR_API_KEY` environment available to the daemon through sanctioned
  `with-polli-secrets` conventions. If no credential is available, the adapter
  records a typed `credential_unavailable` failure. `dry_run=true` records a
  prepared external write without posting.
- `vault_receipt`: writes a Fieldwork-compatible markdown receipt under
  `10-daily/<date>/calyx-monitor-receipts/` by default, or under a binding
  `vault_root`/`directory` override.

Delivery rows move through `attempted`, `delivered`, or `failed`. Failed pushes
do not consume or delete wake rows; the durable pull fallback remains
`calyx monitor inbox`. `monitor show`, `monitor history`, `monitor inbox`, and
`monitor doctor` expose delivery state. Exact agent-session acceleration is a
separate generation-bound session-ingress route; notification bindings do not
launch, resume, or steer an agent turn.

There is no `agent-mail` adapter. `agent_mail_thread` in run reply hints is
legacy provenance only.

## CLI Shape

`calyx monitor create --preset runner-supervision --run <id>` is the common
case. `create` records `create_provenance` as `operator` by default and rejects
non-conductor/operator provenance in v1. Runner supervision default bindings
route failure/stall to ntfy, success to Linear comment, and artifact churn to a
debounced vault receipt. Pass `--no-default-deliveries` for Tier-0 only, or
repeat `--deliver <adapter[,key=value...]>` for explicit bindings.

The bounded command surface is:

- `calyx monitor create`
- `calyx monitor list`
- `calyx monitor show`
- `calyx monitor cancel`
- `calyx monitor history`
- `calyx monitor inbox`
- `calyx monitor ack`
- `calyx monitor doctor`

`runner-supervision` creates an `any_of` predicate over terminal, failed, and
health-stale run signals with `every_change` re-arming, so a stale wake and a
later terminal wake can both be represented without a scheduler.
