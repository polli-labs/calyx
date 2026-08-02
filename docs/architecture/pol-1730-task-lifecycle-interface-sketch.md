# POL-1730 Task Lifecycle Interface Sketch

Status: implementation sketch for POL-1730

This slice adds the native task install and task-run lifecycle as a thin layer
over the POL-1732a monitor predicate substrate. It does not add a second
scheduler loop, a private trigger grammar, a new daemon, app mutation paths, or
default unattended launching.

## Boundary With Monitors

The shared substrate rule from the monitor/wakeup design note is binding:

- Monitor = `predicate/v1` + delivery policy.
- Task = `predicate/v1` + launch policy + task-run history.

Task triggers therefore persist a `predicate/v1` object. Existing phase-1 task
manifests may still contain schedule RRULEs for Codex app rendering, but the
native scheduler layer translates the supported schedule shape into
`time.cron` at install time. Manifests may also carry a literal
`predicate/v1` trigger object when the task needs `time.after` or another
already-landed predicate kind. The evaluator vocabulary remains owned by
`packages/core/src/state/monitors.ts`.

## Task Install Object

`task_installs` is the authoritative SQLite install table. An install has:

- `install_id`, `schema_version`, `status`, `created_at`, `updated_at`.
- Identity: `task_id`, `host`, `manifest_path`, `manifest_hash`.
- Ownership/provenance: `owner`, `installed_by`.
- Runtime copy: bounded `task_json` from the validated manifest.
- Trigger: `predicate_json` using `predicate/v1`.
- Launch policy: backend, cwd/worktree, prompt, model/effort, and safety mode.
- Safety: `mode`, `unattended_enabled`, `app_mutation_enabled`.
- Runtime state: last evaluation, transition, task-run id, run id, and error.

Install statuses are `active | paused | retired | failed_needs_attention`.
`paused` is the default install posture. `active` allows predicate evaluation,
but it still does not launch a run unless a later slice explicitly enables
unattended scheduling. For this slice, scheduler matches create typed
launch-intent task-run records.

`task_install_cursors` stores predicate cursor state using the same cursor shape
as monitor evaluation.

## Task Run Object

`task_runs` records every manual run and scheduler launch intent:

- `task_run_id`, `schema_version`, `task_id`, optional `install_id`.
- `trigger_kind`: `manual | predicate`.
- `status`: `planned | launch_intent_recorded | launched | succeeded | failed`.
- Safety: `mode`, `dry_run`.
- Linkage: optional `run_id` for actual Calyx runs.
- Payloads: launch policy, predicate evaluation, summary, receipt path.

Manual `calyx tasks run <task-id>` launches a normal Calyx run and links the
task-run row to the resulting `run_id`. Scheduler evaluation in this slice
records a `launch_intent_recorded` task-run row with no `run_id` because
unattended scheduling remains off by default.

`task_history` records install, pause, resume, reconcile, scheduler match, and
manual launch events. JSONL task-run receipts are exported under
`$CALYX_STATE_HOME/receipts/task-runs.jsonl`.

## Finding Model

Task findings are returned by `tasks reconcile` and `tasks doctor`. They are
not separate truth. Findings are typed, bounded records:

- `code`
- `severity`: `info | warn | error`
- `message`
- optional `task_id`, `install_id`, `manifest_path`

Reconcile findings cover missing manifests, manifest hash drift, predicate
conversion failures, host/backend drift, paused/retired state, and safety
posture. Doctor findings cover schema drift, absent migration, malformed rows,
active installs with unattended launch disabled, and active installs with app
mutation disabled.

## Command Surface

The phase-1 manifest bridge remains:

- `calyx tasks validate`
- `calyx tasks list`
- `calyx tasks show`
- `calyx tasks import codex`
- `calyx tasks render codex`

POL-1730 adds:

- `calyx tasks install <task-id>`
- `calyx tasks pause <task-id-or-install-id>`
- `calyx tasks resume <task-id-or-install-id>`
- `calyx tasks reconcile [task-id-or-install-id]`
- `calyx tasks history [task-id-or-install-id]`
- `calyx tasks doctor`
- `calyx tasks run <task-id>`

Every data-bearing command supports `--json`. State-changing commands append
history rows. `tasks reconcile` is read-only by default and requires `--apply`
to refresh stored install metadata from the manifest.

## Safety Posture

V1 safety is explicit:

- Installs default to `paused`.
- Manual `tasks run` is allowed.
- App mutation is not performed by Calyx tasks.
- Scheduler matches create launch-intent records only.
- `unattended_enabled` and `app_mutation_enabled` persist as explicit false
  fields.
- Advisory mode is the default mode. Mutating mode can be recorded only as
  metadata for future policy; it does not grant additional capability here.

This keeps `daily-maintenance` provable as an advisory paused install while
preserving the later path to an explicit unattended enablement decision.

## Codex Desktop Observation Boundary

`calyx tasks observe codex` adds a read-only bridge across three facts without
collapsing their authority:

1. A Calyx task manifest or a time-bounded source-governance exemption says why
   a definition is governed. A Calyx install row is local lifecycle provenance,
   not proof that Codex Desktop installed or runs the definition.
2. Codex Desktop's `automation.toml` is `definition_authority=codex_toml` for
   the app scheduler definition currently on disk.
3. Codex Desktop's SQLite `automations` row is an optional runtime projection.
   Its absence or disagreement is reported as
   `projection=missing|drifted|unavailable`, never treated as deletion or rewrite
   authority.

The Calyx CLI reports `mutation_authority=unavailable`. It has no supported
path to the app-injected `automation_update` tool and does not import private
Electron functions. Observation therefore never renders, applies, activates,
pauses, deletes, consolidates, or writes a definition/projection. A future app
surface may report `mutation_authority=codex_app_tool`, but that capability and
its operator authorization remain outside this lifecycle slice.

Observation fails closed when a definition changes during its double read,
when a POL-1960 representability receipt is lossy, or when a finite schedule has
neither next nor last runtime projection. Same-name definitions remain distinct
when their exact cwd coverage differs. These rules make drift visible without
turning absence, display-name similarity, or prompt prose into an authority
claim.
