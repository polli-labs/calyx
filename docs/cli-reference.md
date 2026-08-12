# Calyx CLI Reference

Hand-authored detailed reference for the `calyx` CLI. Runtime help is
authoritative for the installed command shape. Data-bearing commands expose
`--json` where their command section documents it.

## Doctor

Health check across all configured Calyx domains and the selected host's repo
registry roots on the filesystem where the command is running.

### `calyx doctor`

Check domain health: resolves source paths for all registry and store domains,
reporting ok/warning/error/unconfigured status. When an agents-infra truth root
is discoverable, the command also validates repo registry roots for the selected
host before `calyx run` reaches worktree acquisition. This is a local filesystem
probe: `--host <host>` selects the `fleet/truths/hosts.yaml` slice, but the path
checks still run on the machine where the CLI process is executing. Run the
command on the target host for meaningful repo-root results.

```bash
calyx doctor [--json] [--host <host>]
```

**Options:**
- `--json` — Print machine-readable JSON summary
- `--host <host>` — Host alias whose repo-registry slice should be validated.
  Defaults to the current host. This does not SSH to that host.

**Exit codes:**
- `0` — All domains healthy
- `3` — One or more domain or repo-registry errors

**Example:**
```bash
calyx doctor
calyx doctor --json
calyx doctor --host carbon --json
```

---

## Agent Context

Machine-readable CLI inventory and operator recipes for agents. This is the
first Wave 4 interface-inspection surface: it lets a conductor or runner find
canonical Calyx paths without scraping stale wrapper rows from `calyx --help`.

### `calyx agent-context`

Print agent-facing command inventory and high-value recipes for run
supervision, activity recall, Symphony daemon ticks, and state doctoring.

```bash
calyx agent-context [--json]
```

**Options:**
- `--json` — Print the `calyx.agent-context/v1` JSON envelope.

**Behavior:**
- The JSON envelope includes the current CLI version, a Commander-derived
  command inventory, curated operator recipes, and the legacy-wrapper policy.
- Legacy wrapper and tombstone commands are not listed in top-level help or the
  default command inventory. Direct legacy invocations still route through the
  pre-parse diagnostics path so operators get the existing actionable
  delegation, deprecation, or retirement message.
- This surface is intentionally a bridge toward the Wave 4 interface manifest;
  it is not yet the full manifest generator.

**Exit codes:**
- `0` — Agent context printed successfully

**Example:**
```bash
calyx agent-context --json
```

---

## Interface Manifest

The machine-readable interface manifest uses schema version
`calyx.interface-manifest/v0`. It remains a hand-authored validation substrate,
not a Commander or documentation generator: Commander is the runtime
registration surface, while tests compare selected manifest records against
Commander, `calyx agent-context --json`, and this reference.

The manifest classifies every visible top-level Commander domain with:
`domain`, `lifecycle_status`, `domain_status`, `agent_facing`,
`mutation_risk`, `owner`, `source_of_truth`, and `wave4_disposition`.
`unknown` domain status is allowed in the first slice; an unclassified
top-level domain is not.

Full first-slice records cover:

- `calyx agent-context`
- `calyx run daemon plan`
- `calyx run daemon tick`
- `calyx run status`
- `calyx run await`
- `calyx run receipt`
- `calyx run doctor`
- `calyx review`
- `calyx self freshness`
- `calyx activity self`
- `calyx activity overview`
- `calyx activity mark`
- `calyx activity unmark`
- `calyx activity marks`
- `calyx activity turns`
- `calyx activity messages`
- `calyx activity text`
- `calyx activity attachments`
- `calyx context capture`
- `calyx context plan`
- `calyx context pack`
- `calyx context docs`
- `calyx mcp manifest`
- `calyx mcp serve`
- `calyx oracle bundle`
- `calyx oracle run`

Each record splits identity into `surface_kind`, `execution_boundary`, and
`invocation_kind`, then describes `mutation_class`, `effects`,
`safety_contract`, `output_contract`, `error_contract`, `async_contract`, and
agent-context linkage. Symphony guardrail concepts are reserved as contract
references only: `selection_contract_ref`, `workflow_policy_contract_ref`,
`receipt_contract_ref`, `reconciliation_contract_ref`, and
`grouping_contract_ref`, plus `stop_condition_contract_ref`. POL-1418 owns
the behavior behind those contracts.

External services can be described without absorbing them into a CLI command
record. Current descriptors include:

- `monitor-delivery-ntfy` for the Tier-1 monitor ntfy external write adapter.
- `monitor-delivery-linear-comment` for the Tier-1 monitor Linear comment
  external write adapter.
- `remote-body-worktree`, labeled as Remote Body Worktree with
  `surface_kind: external_service` and `execution_boundary: external_descriptor`.

These records capture mutation semantics, provider adapters, effects, and
receipt expectations. Monitor delivery descriptors point at Calyx-owned adapter
code while still marking ntfy and Linear as external writes; Remote Body
Worktree remains implemented outside this repo.

---

## Verify Commands

Fleet-wide validation across all domains.

### `calyx verify fleet`

Run validators across all 6 domain registries/stores, surfacing errors and warnings per domain.

```bash
calyx verify fleet [--strict] [--json]
```

**Options:**
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — All domains pass
- `3` — One or more domain validation failures

**Example:**
```bash
calyx verify fleet
calyx verify fleet --strict --json
```

---

## Fleet Commands

Read persisted fleet convergence state through the enrolled-host topology
snapshot. The state store supplies observations; it never supplies membership.

### `calyx fleet status`

Answer whether desired-active hosts are converged per persisted leg without
probing the fleet. Rows are written by observation commands such as `calyx self
freshness` and partial-failure handling in `calyx self upgrade --fleet`.

```bash
calyx fleet status [--host <host>] [--json]
```

**Options:**
- `--host <host>` — Filter to one host alias
- `--json` — Print a `fleet-convergence-status/v2` payload

**Behavior:**
- Resolves one read-only `fleet-topology-snapshot/v1`, names its source commit
  and projection digest, then reads the local `fleet_convergence` SQLite table.
- Projects rows over `desired_active`, even when a host has no persisted row.
  Rolls leg rows up per host. Host verdict precedence is
  `structural` > `pending` > `fresh`; a requested host with no rows reports
  `missing` with effective state `unavailable` and fails the aggregate.
- Reports `withdrawn` hosts under `excluded_withdrawn`; they are never counted
  in `desired_active_total` or the green verdict denominator.
- A non-authoritative topology snapshot remains inspectable but cannot emit a
  green verdict.
- Does not apply, reconcile, poke, escalate, or contact remote hosts.

**Exit codes:**
- `0` — Every desired-active host is fresh and the topology snapshot is authoritative
- `6` — A desired-active host is pending, structural, missing/unavailable, or the topology snapshot cannot emit green

**Examples:**
```bash
calyx fleet status
calyx fleet status --host mba --json
```

---

## Bundle Commands

Extension bundle build.

### `calyx bundle build`

Build an extension bundle from a package directory.

```bash
calyx bundle build --path <path> [--out-dir <dir>] [--apply] [--json]
```

**Options:**
- `--path <path>` (required) — Path to extension package directory
- `--out-dir <dir>` — Output directory for the built bundle (default: `dist`)
- `--apply` — Execute the build (default: plan-only)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan or build applied)
- `1` — Build error (missing package.json, invalid manifest)

**Example:**
```bash
calyx bundle build --path packages/calyx-ext-cursor
calyx bundle build --path packages/calyx-ext-cursor --apply
```

---

## Install Commands

Agent installation and bootstrapping.

### `calyx install bootstrap`

Bootstrap the `~/.agents` directory structure and install a canonical
`~/.agents/run/calyx` wrapper. When `~/.calyx/installs/current` exists, the
wrapper delegates to that promoted immutable install. Before the first promote,
bootstrap can still delegate to the built checkout executable as a bring-up
path.

The wrapper never inspects the command being run: it finds a supported Node
runtime and execs the current CLI with argv untouched, so which program answers
`calyx <anything>` is decided by the CLI, not by a shell script frozen at
install time. Bootstrap deletes any `~/.agents/run/calyx.legacy` left by earlier
versions, which is reported as `retired-legacy-wrapper=` (`will-retire-` in plan
mode).

```bash
calyx install bootstrap [--target <path>] [--apply] [--json]
```

Run this after `calyx self upgrade --host <host>` when you need the local
`~/.agents/run/calyx` path to expose the promoted daemon-serving CLI surface,
including `calyx run`.

**Options:**
- `--target <path>` — Target directory (default: `~/.agents`)
- `--apply` — Create directories (default: plan-only)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan or bootstrap applied)
- `3` — Bootstrap blocked because the selected built executable is stale relative to workspace source
- `1` — Filesystem error

**Behavior:**
- In apply mode before the first promote, bootstrap fails fast if the selected
  checkout `dist/bin.js` is older than workspace source inputs.
- When `~/.calyx/installs/current` resolves to a runnable install, bootstrap
  verifies the symlink target executable and writes the wrapper through
  `current/node_modules/@polli-labs/calyx/dist/bin.js` so later promotes and
  rollbacks are visible without rerunning bootstrap.
- The JSON result includes `action: "blocked-bootstrap"`, `warnings`, and `staleBuild` metadata so operators and agents can remediate deterministically.
- The intended remediation is to rebuild the checkout first, then rerun `calyx install bootstrap --apply`.
- The installed source wrapper runs the selected Calyx executable with a Node runtime that satisfies the Calyx floor (`>=22.13.0`). If `CALYX_NODE` is set it must satisfy that floor; otherwise the wrapper checks the visible `node`, common Homebrew/system paths, and local nvm installs before failing with an actionable runtime message.

**Example:**
```bash
calyx install bootstrap
calyx install bootstrap --apply
calyx install bootstrap --target /opt/agents --apply
```

## Self Drift, Freshness, and Nudge

Daemon drift inspection against the local Calyx source checkout.

### `calyx self drift`

Compare one daemon, or the desired-active topology set, against a target git
ref from the local Calyx clone.

```bash
calyx self drift [--host <h>] [--fleet] [--against <ref>] [--json]
```

**Options:**
- `--host <h>` — Single host to inspect (default: `local`)
- `--fleet` — Inspect the `desired_active` set from one fleet topology snapshot
- `--against <ref>` — Target ref resolved through the conductor's validated Calyx compare checkout (default: `origin/main`)
- `--json` — Print a machine-readable per-host result array, or a
  `self-drift-fleet/v1` topology-bound envelope in fleet mode

**Behavior:**
- Reads each target daemon's authenticated `GET /v1/admin/health` endpoint and inspects `build.git_head`.
- Local-host checks use `http://127.0.0.1:8740/v1/admin/health`; remote hosts default to `http://<host>:8740/v1/admin/health`.
- Authentication resolves the target host's named `operator_cli` outbound credential; this command does not expose an inline `--auth-token` flag.
- `--fleet` resolves membership once through the topology resolver. Every
  desired-active host remains in the result even when unreachable; its
  effective state is `unavailable`, and it fails the aggregate.
- Fleet output names `topology_snapshot.source.commit` and
  `topology_snapshot.projection_sha256`. Withdrawn hosts appear under
  `excluded_withdrawn`, outside the active denominator, and non-authoritative
  topology cannot emit green.
- Drift is classified as `current`, `minor`, `major`, `critical`, `needs_fetch`, or `broken`.
- A `schema` column and a `schema` JSON object report each host's state-store
  migration head, measured against the migration source of the calyx build
  running the command — one reference frame for every host. `0024 -10` means the
  host's ledger is ten migrations behind that source; `0034 ahead` means the
  store was migrated by a newer build than the daemon reading it; `-` means the
  daemon is unreachable or predates the health field, which is *unknown*, not
  parity. A multi-host table ends with a one-line convergence summary
  (`state schema: 4 versions across 4 hosts - 0019 (mba), ...`).
- **Schema divergence is reported, never gated on.** It does not change the
  `drift` severity and does not affect the exit code. `calyx self upgrade` is
  the operation that converges a schema, so a schema-driven gate would refuse
  exactly the repair path an out-of-date host needs.
- The compare checkout is resolved from the conductor host's
  `fleet/truths/hosts.yaml` `repos.calyx.path`, then the conventional
  `~/dev/calyx/dev`, and must validate as a git worktree before any git repair
  command is emitted.
- `critical` and `major` classifications consult the append-only `OPERATIONAL_FIXES` registry in `packages/core/src/operational-fixes.ts`.
- A `major` result also fires when a daemon is more than 20 commits behind the target ref, even if no registered operational fix is missing.
- `broken` means admin health is unreachable, invalid, or does not advertise `schema_version: "calyx.admin-health/v1"`.
- `needs_fetch` means daemon health is usable, but the local compare clone cannot
  resolve the target ref or compare `build.git_head` to the target. JSON output
  includes `diagnostics[]` entries with `kind`, `severity`, `message`, and
  `actions`; the first action is the local repair command, usually
  `git -C <repo> fetch --all --prune`.
- If no validated compare checkout exists, diagnostics use
  `kind = "compare_repo_unavailable"` and intentionally do **not** synthesize a
  `git -C ... fetch` action from the Calyx package install path.

**Exit codes:**
- `0` — All desired-active hosts are `current` and the topology snapshot is authoritative
- `1` — One or more hosts are not `current`, including local compare repair
  states such as `needs_fetch`
- `2` — Usage error or missing target-host `operator_cli` outbound credential
- `6` — Local git or host-truth resolution failure

**Example:**
```bash
calyx self drift --host blade
calyx self drift --fleet --json
```

### `calyx self freshness`

Summarize whether one host, or the desired-active topology set, is ready to take work.
Freshness composes daemon reachability, git drift, advertised daemon feature
support, maintenance mode, and active-run count into one verdict plus a compact
next action.

```bash
calyx self freshness [--host <h>] [--fleet] [--against <ref>] [--json]
```

**Options:**
- `--host <h>` — Single host to inspect (default: `local`)
- `--fleet` — Inspect the `desired_active` set from one fleet topology snapshot
- `--against <ref>` — Target ref for drift comparison (default: `origin/main`)
- `--json` — Print a `self-freshness/v1` payload

**Behavior:**
- Reuses the same health and drift collectors as `calyx self health` and
  `calyx self drift`. Health, install, capability, and daemon-drift facts for
  each host derive from one admin-health observation so a restart cannot
  produce a mixed-generation freshness row.
- Fleet mode binds health and drift to the same topology snapshot, includes its
  source commit and projection digest, and reports withdrawn hosts separately
  under `excluded_withdrawn`.
- An unreachable desired-active host has effective state `unavailable`, remains
  in `desired_active_total`, and makes `fleet_summary.green` false. Withdrawn
  hosts never enter that denominator. A non-authoritative snapshot cannot emit
  green even if every observed host is fresh.
- Separately reports running daemon build (`/v1/admin/health` `build.git_head`),
  promoted build (`~/.calyx/installs/current/.build-info.json`), and clone HEAD
  (`git rev-parse HEAD`) so operators can distinguish built-but-not-promoted
  from promoted-but-not-restarted.
- Writes the daemon-build observation to the local `fleet_convergence` state
  table best-effort when invoked through the CLI and migration `0006` is
  already applied. Persistence warnings are included in JSON/text output and
  never change the freshness exit code.
- Persists `target_rev` only as a resolved SHA or `null`; the `--against` ref
  remains `target_ref` in the command envelope, not a row target revision.
- Records `converged_from` as the source checkout HEAD used by the observation.
  The checkout is resolved through the same validated compare-root path used by
  `calyx self drift`, so package installs are never mistaken for git clones.
- Compares each daemon's `supports_features` against the current run-server
  `SUPPORTED_FEATURES` set.
- Reports `fresh`, `usable_with_warnings`, `stale`, or `blocked`.
- Treats active runs as a warning, not a freshness failure, and points the
  operator to `calyx run ps --host <host> --json`.
- Treats missing daemon features or daemon-build drift as stale and points to
  `calyx self upgrade --host <host> --dry-run`.
- Treats `install_drift.status = clone_not_promoted` or
  `promoted_not_restarted` as stale. `unknown` is reported when any of the
  three version facts cannot be read.
- Reconciles drift `needs_fetch` against install convergence: when the running,
  promoted, and clone heads all converge, a `needs_fetch` is a local compare
  limitation, not daemon staleness, and is reported as `usable_with_warnings` —
  health convergence is trusted over a local compare resolution failure. Without
  convergence evidence `needs_fetch` remains `stale`. Either way the raw
  `drift.status` stays `needs_fetch` and the `next_action` column carries the
  diagnostic git-fetch command instead of a daemon upgrade command.
- Treats unreachable, unauthorized, legacy, broken, critical, or incompatible
  hosts as blocked for the command verdict; persisted convergence rows map
  unreachable/offline hosts to `pending` and structural broken/critical/
  incompatible drift to `structural`.

**Exit codes:**
- `0` — All inspected hosts are fresh
- `1` — One or more hosts are usable with warnings, including a health-converged
  host whose local git comparison still needs a fetch
- `2` — Usage error or missing target-host `operator_cli` outbound credential
- `3` — One or more hosts are stale; a healthy daemon whose local git comparison
  needs a fetch is only stale when install convergence is absent (a converged
  install reconciles to `usable_with_warnings`, exit `1`)
- `6` — One or more hosts are blocked, or freshness collection failed

**Examples:**
```bash
calyx self freshness --host blade
calyx self freshness --fleet --json
```

### `calyx self nudge`

File or reconcile one standing Linear drift issue per host without attempting
any repair.

```bash
calyx self nudge [--fleet] [--project <slug>] [--dry-run] [--json]
```

**Options:**
- `--fleet` — Inspect the desired-active topology set; omit to check only the local host
- `--project <slug>` — Linear project slug or name; defaults to `CALYX_LINEAR_PROJECT`, then `LINEAR_PROJECT`, then the repo convention `Agents Tooling (Ongoing)`
- `--dry-run` — Print the intended Linear mutations without creating labels, issues, comments, or state changes
- `--json` — Print the full machine-readable filing/reconciliation result

**Behavior:**
- Reuses the same in-process drift collector as `calyx self drift`; it does not shell out or launch nested `calyx run` jobs.
- Requires target-host `operator_cli` outbound credentials (for authenticated admin-health checks) and `LINEAR_API_KEY` (for Linear GraphQL reads/writes).
- Resolves the target Linear team from `LINEAR_TEAM` and falls back to `Polli Labs`.
- For host drift severities `minor`, `major`, `critical`, `broken`, and `incompatible`, the command fingerprints the standing issue with a Linear label `drift-fingerprint-<host>`.
- For local compare repair states such as `needs_fetch`, the command no-ops and
  reports the local repair action instead of filing a daemon-drift Linear issue.
- If an open issue in the target project already carries that fingerprint label, the command updates its title/body in place instead of creating a second issue.
- If no open issue exists for that host fingerprint, the command creates one titled `calyx daemon drift — <host> (<severity>)` with the current drift report, missing operational fixes, and the exact remediation command `calyx self upgrade --host <host>`.
- If a previously drifted host has returned to `current`, the command comments `drift resolved YYYY-MM-DD` and moves the standing issue into a completed workflow state.
- Unlike `calyx self drift`, this command exits successfully when it files, updates, closes, or no-ops on drift so it can be used from cron or standup workflows.

**Exit codes:**
- `0` — Success, including create/update/close/no-op outcomes
- `2` — Missing target-host `operator_cli` outbound credential
- `6` — Drift collection, Linear resolution, or Linear mutation failure

**Examples:**
```bash
LINEAR_API_KEY="$LINEAR_API_KEY" \
  calyx self nudge --json

LINEAR_API_KEY="$LINEAR_API_KEY" \
  calyx self nudge --fleet --dry-run
```

## Runtime Config Commands

Managed local runtime configuration convergence for host-specific operator files.

### `calyx runtime-config plan`

Plan local runtime configuration convergence without mutating live files.

```bash
calyx runtime-config plan --host <host> [options]
```

**Options:**
- `--managed-configs-root <path>` — Path to the managed runtime configs root. Defaults to `~/dev/agents-infra/dev/fleet/configs` under the selected live home.
- `--host <host>` (required) — Host alias used to resolve host-specific truth before falling back to `shared/`
- `--home <path>` — Home directory whose live config targets should be inspected (default: current user home)
- `--component <name>` — Limit to one component; repeatable. Supported values: `codex`, `claude-settings`, `claude-mcp`
- `--json` — Print the versioned local-backend receipt envelope

**Behavior:**
- `plan` is read-only.
- The current backend contract is `contractVersion: "local-backend/v1"` with `backend: "runtime-config"`.
- Runtime configuration is a target-local authority surface. The CLI does not project it through the admin API; fleet convergence belongs to the scoped internal daemon/deployment path.
- The current runtime-config slice owns three truth-backed components:
  - `codex` (`~/.codex/config.toml`)
  - `claude-settings` (`~/.claude/settings.json`)
  - `claude-mcp` (`~/.claude.json`, additive convergence of the managed `mcpServers` subset)
- Managed truth resolves `host/<file>` first, then `shared/<file>`.

**Exit codes:**
- `0` — Success (including when drift is present)
- `2` — Usage error
- `10` — Internal/runtime failure

### `calyx runtime-config apply`

Apply managed runtime configuration convergence to live local targets.

```bash
calyx runtime-config apply --host <host> [options]
```

**Options:**
- Same as `runtime-config plan`

**Behavior:**
- Writes changed targets only.
- Creates `<target>.bak.<timestamp>` backups before rewriting an existing file.
- Codex config convergence preserves plugin-owned keys such as `notify` unless managed truth explicitly includes them.
- Claude settings preserve live values for env keys whose managed truth explicitly uses `{{ SET_VIA_ENVIRONMENT_OR_LOCAL_FILE }}` placeholders.
- Claude MCP convergence preserves un-managed root state in `~/.claude.json` and only adds, updates, or removes the managed `mcpServers` entries.
- Managed ownership is recorded in `~/.calyx/runtime-config-state.json` so entries removed from managed truth converge away on later applies without deleting unmanaged local additions.

**Exit codes:**
- `0` — Apply completed successfully
- `2` — Usage error
- `10` — Internal/runtime failure

### `calyx runtime-config verify`

Verify live runtime configuration matches managed truth.

```bash
calyx runtime-config verify --host <host> [options]
```

**Options:**
- Same as `runtime-config plan`

**Exit codes:**
- `0` — All selected components match managed truth
- `2` — Usage error
- `3` — Drift detected
- `10` — Internal/runtime failure

**Example:**
```bash
calyx runtime-config plan \
  --host carbon \
  --json

calyx runtime-config apply \
  --host carbon

calyx runtime-config verify \
  --host carbon
```

Use `--managed-configs-root <path>` only when the target host is intentionally
using a non-canonical managed truth checkout.

## Self Health and Upgrade

Daemon health inspection and guarded upgrade operations.

### `calyx self health`

Probe authenticated run-server health for the local host, one named host, or
the desired-active topology set.

```bash
calyx self health [options]
```

**Options:**
- `--host <h>` — Probe one host alias from `fleet/truths/hosts.yaml`
- `--fleet` — Probe the `desired_active` set from one fleet topology snapshot
- `--json` — Print an array for single-host mode, or a
  `self-health-fleet/v1` topology-bound envelope for fleet mode

**Behavior:**
- No flag defaults to the current host and falls back to loopback `http://127.0.0.1:8740` when no `run_serve_url` is configured in truth.
- `--host <h>` uses that host's configured `run_serve_url` when present; otherwise it falls back to `http://<host>:8740`.
- `--fleet` uses topology membership, not the presence of `run_serve_url`, as
  its enumeration authority. B2 validation requires usable routing for active
  members; a route can never promote a non-member into the fleet.
- Desired-active hosts are never skipped because they are offline. Connection
  failures become effective state `unavailable`, remain in the active
  denominator, and make the aggregate non-green.
- Withdrawn hosts are emitted under `excluded_withdrawn` and are never probed
  or counted in the active denominator. The envelope names the topology source
  commit and projection digest; a non-authoritative snapshot cannot emit green.
- Auth resolves the target host's named `operator_cli` outbound credential from `consumer_api_credentials`; `--auth-token` is an explicit override only.
- Responses without `schema_version` (for example surface-only pre-PR1 `/health` payloads) are reported as `legacy_daemon`.
- Connection refusal, DNS/request failure, and timeout are `unreachable`.
  A received non-success response is `http_error` with `http_status` (plus a
  declared error code/retryability when present), while a received success
  response that fails the bound JSON/protocol contract is `invalid_response`
  with its response phase. These causes remain distinct in composed freshness
  and fleet-postflight evidence.
- Successful rich health includes the running daemon build, promoted install
  build, and clone HEAD when each can be resolved. Text output shows these as
  `running_build`, `promoted_build`, and `clone_head`; JSON preserves the full
  structured `promoted_build` and `clone_head` objects.
- `state_schema` reports the host's state-store migration position as its own
  build measures it: `status` (`current` · `behind` · `ahead` · `unavailable`),
  the applied ledger head `current`, the build's declared `target`, and the
  `pending` count. The ledger is read per request, so a store migrated by
  another process under a running daemon shows as `ahead` rather than the
  parity the daemon booted with. Text output prints the applied id, or
  `<current> <status> <target>` when the two diverge; a daemon predating the
  field prints `unknown`.
- Probing more than one host appends a convergence line —
  `state schema: converged at 0034 across 4 hosts.` or
  `state schema: 4 versions across 4 hosts - 0019 (mba), 0024 (blade), ...`.
  A host's schema only advances when something runs there, so fleet-wide drift
  is the default state; this line is how it becomes visible before an upgrade
  fails on it.
- Human fleet output starts with `topology commit=<sha> digest=<sha256>
  authority=<status>`, followed by a compact one-line-per-host table, an
  `excluded_withdrawn` section, and a strict summary. Fleet JSON mode prints:

```json
{
  "schema_version": "self-health-fleet/v1",
  "topology_snapshot": {
    "source": { "commit": "14f1ce31..." },
    "projection_sha256": "9ad0..."
  },
  "hosts": [
    {
    "host": "blade",
    "ok": true,
    "desired_membership": "active",
    "effective_state": "active",
    "health": {
      "schema_version": "daemon-health/v1",
      "advertised_host": "blade"
    }
    }
  ],
  "excluded_withdrawn": [],
  "summary": {
    "desired_active_total": 1,
    "withdrawn_total": 0,
    "active": 1,
    "repair": 0,
    "unavailable": 0,
    "green": true
  }
}
```

**Exit codes:**
- `0` — Every desired-active host returned rich daemon health and the topology snapshot is authoritative
- `2` — Usage error
- `6` — One or more hosts were unreachable, returned an HTTP/protocol error, or reported a legacy daemon
- `8` — Authentication failure talking to one or more target servers

**Examples:**
```bash
calyx self health
calyx self health --host worm --json
calyx self health --fleet
```

### `calyx self upgrade`

Upgrade one daemon host, or the desired-active run-service topology set, to a
target Calyx ref.

```bash
calyx self upgrade --host <host> [options]
calyx self upgrade --fleet [options]
```

**Options:**
- `--host <host>` — Upgrade one host alias. If the alias is the current host,
  Calyx runs the local guarded upgrade path. If it is a remote host, Calyx
  dispatches a one-host fleet upgrade over SSH.
- `--fleet` — Upgrade every desired-active host from one authoritative topology
  snapshot. Mutation refuses non-authoritative topology.
- `--hosts <csv>` — With `--fleet`, limit the fleet run to a comma-separated
  subset of desired-active hosts. Withdrawn hosts cannot be selected.
- `--to <ref>` — Git ref to converge to (default: `origin/main`).
- `--target-sha <sha>` — Full 40-character SHA to converge to, bypassing
  per-host ref resolution. Use the `plan.target_head` from a standalone dry-run
  when the later apply must execute that exact assessment.
- `--startup-contract-payload <base64url>` — Internal fleet transport for the
  conductor's digest-verified, SHA-bound target manifest evidence. Requires
  `--target-sha`; operators normally never supply this directly.
- `--target-fetch-remote <remote>` / `--target-fetch-ref <ref>` — Internal
  conductor transport for the normalized remote and source fetch ref paired
  with `--target-sha`; operators normally never supply these directly.
- `--dry-run` — Print the point-in-time plan (including the pinned
  `target_head` and per-host `startup_contract` verdict) without mutating the
  target. A later invocation replans unless it receives that SHA via
  `--target-sha`.
- `--parallel` — With `--fleet`, run remote hosts concurrently.
- `--fail-fast` — With serial `--fleet`, skip remaining hosts after the first
  `failed` host. An `unverified` host has completed its mutation without a
  current-invocation receipt proof, so it does not suppress later dispatches.
- `--force` — Override local upgrade guards for the selected host.
- `--abort-runs` — With `--force`, the explicit interrupt for blocking active
  runs instead of waiting for a clean drain.
- `--drain-deadline <ms>` — Maximum wait for active runs to drain before restart
  (default: 600000). The deadline applies only to active runs that the classifier
  cannot prove restart-safe.
- `--drain-all` — Override transparent preservation and drain every active run
  before restart.
- `--continuous` — Deprecated warn-once no-op alias for the transparent-update
  default. Use no flag for automatic preservation or `--drain-all` for a full
  drain. Scheduled for removal in `0.4.0`.
- `--auth-token <token>` — Local current-host health token override. Remote
  `--host` and `--fleet` upgrades load target-host secrets with
  `with-polli-secrets` instead of forwarding inline tokens.
- `--json` — Print machine-readable output. Fleet and remote-host envelopes
  include `operation_path` plus the required `operation_projection`
  availability discriminator.

**Behavior:**
- Fleet planning resolves topology exactly once before dispatch. The aggregate
  plan and durable receipt name the source commit, projection digest, authority,
  desired-active count, and `excluded_withdrawn` records. The same frozen target
  set is used through scheduling and final receipt construction; neither URL
  presence nor a stale convergence row can add or remove a host.
- The durable `self-upgrade-operation/v1` record also carries
  `topology_snapshot.source.commit` and `topology_snapshot.projection_sha256`,
  so status/watch can identify the exact topology used before a final receipt
  exists.
- **Bootstrap toolchain attestation (POL-2140) is a planner-local mutation
  gate.** Once the target planner enters `executeSelfUpgradePipeline`, Calyx
  observes the real child-spawn context for that planner's upgrade: the running
  Node process, `pnpm --version` self-dispatch, `pnpm exec node`, pnpm's
  intrinsic executable identity, and a nested lifecycle pnpm. A pass requires a
  resolved target SHA, a valid declared `engines.node` range, the exact declared
  `packageManager` pnpm pin, the exact child-spawn contract, and current
  host/target/timestamp binding. Probe children have a finite 30-second
  deadline. On POSIX Calyx does not treat either an ordinary child exit or a
  timeout as terminal until its whole process group is proven gone: a surviving
  ordinary descendant is reaped and returns a typed terminality failure, while
  a timeout uses `SIGTERM` then `SIGKILL`; only `ESRCH` proves the group is
  gone. A timeout, incomplete capture, version mismatch, process-group
  terminality failure, or contract mismatch is a typed `blocked/toolchain`
  plan, never a mutation. The planner's attestation, source build, and
  versioned-install `pnpm pack`/`pnpm install` children share one immutable
  bootstrap-child environment: `PATH` plus locale/timezone selectors may be
  inherited, while `HOME`, `XDG_CONFIG_HOME`, and all temporary-directory
  selectors are unique, operation-owned private roots. The source dependency
  install is `pnpm install --frozen-lockfile --ignore-scripts`; versioned pack
  and install commands also use `--ignore-scripts`, so the explicit workspace
  build is the only intended source-script authority. Build and package-manager
  stdout/stderr are drained and discarded rather than logged or copied into
  errors, receipts, events, or operation projections; failures retain only
  their structured phase/command identity, exit status, and timeout status.
  Each invocation makes one bounded best-effort cleanup attempt for its exact
  private workspace root, repairing inaccessible child directories and retrying
  once if necessary. Root absence is clean only after an `ENOENT` probe; residue
  or another post-removal probe failure becomes a bounded, non-authoritative
  direct-result / outer drift-freshness diagnostic and never changes the
  toolchain or drift verdict. It creates no durable recovery authority,
  receipt/event/operation/fleet field, workspace locator, reference, stale
  sweep, tombstone, or deletion-completeness claim. Attestation persists only schema-parsed
  Node/pnpm identity fields and stable failure categories. Fleet dispatch first uses
  `scripts/calyx-upgrade-agent.mjs` to build that target planner; this
  pre-planner bootstrap currently inherits its ambient environment and relays
  raw child output to conductor stderr, so it is explicitly outside this
  guarantee and tracked by [POL-2147](https://linear.app/polli-labs/issue/POL-2147/convergence-c1b-isolate-target-planner-bootstrap-and-suppress-raw).
- Current-host `--host` performs the guarded local sequence: inspect daemon
  descriptors, reconcile active runs, refuse dirty trees unless forced, fetch
  the target ref, prove the planned SHA is reachable, adopt that exact SHA,
  build, promote an immutable install under
  `~/.calyx/installs/<git-head>/`, atomically update
  `~/.calyx/installs/current`, migrate the bootstrap wrapper to that `current`
  path, restart daemon supervisors, verify authenticated `/v1/admin/health` plus the
  wrapper/descriptor executable path, then prune protected-aware old installs.
- Transparent update is the default (POL-2048). Calyx applies the post-U1
  classifier per run: proven restart-safe detached workers are preserved and
  re-adopted, healthy runs without preservation proof drain and wait, and
  blocked or unhealthy classes refuse with their named blockers and a resumable
  plan. Preservation is available only when the live daemon advertises both
  `run.readopt_on_boot/v1` and `run.detached_worker_isolation/v1`; otherwise the
  plan reports `preservation.status=unavailable`, names the missing feature or
  failed probe, and drains all active work. `--drain-all` explicitly selects a
  full drain. `--force --abort-runs` remains the explicit interrupt for blocking
  classes. Receipts retain `drain_mode`, `active_run_classification`, and exact
  `readopted_run_ids` identity proof.
- **State-schema convergence is a step of the upgrade, not a side effect.**
  Before the cutover, the *prepared* target's `calyx state migrate --plan`
  declares its pending migrations and their `MigrationGrowthBound`s; that sum is
  admitted against free space alongside the rollback snapshot. After daemons are
  stopped and the rollback image is pinned — and before the supervisor unit or
  the `current` symlink has moved — the prepared target runs
  `calyx state migrate --apply`, journalled as `state_migrating` /
  `state_migrated`. The apply must execute exactly the admitted migration set
  against exactly the observed pre-existing ledger and converge on the declared
  target; anything else fails the upgrade. Observed growth is measured against
  the snapshot while the store is quiet, so it is migration growth and not
  daemon runtime writes. A migration failure therefore unwinds state alone,
  through the existing rollback domain, with no binary or supervisor change to
  reverse. Receipts carry `target_state_migrated`; the post-restart
  `target_state_applied` is the promoted binary's convergence proof.
- Promote uses packed workspace tarballs plus generated `pnpm.overrides` so
  private workspace dependencies install from local tarballs and third-party
  dependencies are pinned to the workspace `pnpm-lock.yaml`. The staging install
  also writes `minimum-release-age=10080` and keeps `--ignore-scripts`.
- Receipts include the promoted install path, verified version, pruned install
  directories, swept stale promote temp paths, rollback hint, and automatic
  rollback result when restart verification fails after promote. That rollback
  repoints `current` to the prior install, restarts through the same supervisor
  discipline, and verifies the previous build before reporting success.
- **Startup-contract preflight (POL-2045).** `buildPlan` compares the target
  binary's versioned startup-environment contract against the live supervisor
  definition, yielding a per-host `startup_contract` verdict of `compatible`,
  `incompatible` (with the named missing/foreign-secret/projector diff), or
  `unknown`. The committed `packages/core/startup-contract.json` is imported by
  the boot path as its canonical authority. The fleet conductor reads and
  validates those exact target bytes once, binds their digest to the pinned SHA,
  and passes that evidence to every host. The typed evidence retains the
  operator's original spelling, pinned SHA, normalized remote, and normalized
  source fetch ref; planning, host fetch/reachability, apply, postflight, and
  receipts all consume that same authority. Unpinned `--to <ref>` resolution uses
  a targeted fetch and validates `FETCH_HEAD^{commit}`, including for bare local
  branch spellings and non-default remote-tracking refmaps. SHA resolution or payload validation
  failure emits a typed `target_evidence.status=failed` non-verdict receipt and
  dispatches zero hosts; per-host refs never regain target authority. It carries
  consumer-secret env var **names only, never secret values**; the contract may
  additionally require exact non-secret protocol marker values. Definitive supervisor verdicts are
  restricted to an attested `with-scoped-polli-secrets/v2` projector. Canonical
  wrapper/child paths, complete flag grammar, matching command host plus fixed
  `CALYX_HOST_ALIAS`, and the generated fixed-env baseline prove argv shape but
  not the installed external script's semantics. A definitive verdict therefore
  also requires fixed
  `CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT=with-scoped-polli-secrets/v2` in the
  supervisor command and the exact same value in the target startup contract's
  boot-enforced `required_env_values`. The runtime boot gate and preflight share
  this authority. Current unmarked generated units are `unknown + block`;
  POL-2053 owns the agents-infra generator change and later units-first rollout.
  Host tokens must be required with `--opaque-env`; every verifier must be
  required with `--sha256-env`. Consumer secrets supplied through fixed,
  preserved, conditional, or foreign projections are rejected.
  Broad `with-polli-secrets` wrappers,
  unavailable authoritative `systemctl --user cat`, systemd resets,
  `UnsetEnvironment`, `PassEnvironment`, drop-in composition,
  and other unmodeled shapes are `unknown`. Verdict status is epistemic;
  `mutation_disposition` is the durable authorization axis. `--dry-run` prints
  both. A real run refuses before mutation and at the adopted-worktree/live-
  supervisor recheck on any blocking disposition (not overridable by `--force`).
  Only absence on a target proven to predate commit
  `836082a6a9210a733382ee84e957415c3ffce121` is `unknown + allow`;
  uninspectable supervisors and missing two-sided attestation on post-contract
  targets are `unknown + block`. Missing,
  malformed, or unsupported-newer contracts on post-contract targets are
  `unknown + block` with typed `target_contract_invalid` kinds. Missing or
  corrupt target content requires target-side repair; only an unsupported-newer
  schema tells the operator to upgrade the upgrader. The durable fleet receipt stores
  compatible/incompatible/unknown-blocked/unknown-nonblocking/unassessed counts
  and host lists, and the text summary is derived from that block.
- If no descriptor exists under `~/.calyx/daemons` but authenticated `/v1/admin/health`
  responds, Calyx treats the daemon as out-of-registration and refuses the
  automated drain/restart path. JSON output includes a typed
  `diagnostics[].kind = "daemon_out_of_registration"` entry with the observed
  daemon id, pid, active-run count, and manual systemd-oriented repair steps.
- Remote `--host` is a convenience wrapper around the same SSH dispatcher used
  by `--fleet --hosts <host>`. It emits an aggregate receipt containing one
  `per_host` entry.
- Fleet and remote dispatch write conductor receipts under
  `~/.calyx/self-upgrade-receipts/fleet-*/summary.json` plus per-host stdout
  and stderr artifacts. Every receipt includes typed conductor-owned
  `target_evidence`: original ref spelling, resolved SHA, normalized fetch
  remote/source ref, and payload digest, or the pre-dispatch failure code and
  error.
- A fleet run attempts to create a bounded conductor observation record before
  dispatch at `~/.calyx/self-upgrade-operations/<operation-id>.json`. The
  versioned `self-upgrade-operation/v1` projection carries operation identity,
  pinned target, policy, per-host reduced observations, typed transitions, and
  the final receipt locator/table after receipt authority exists. Its writer
  claim and revision checks prevent projection corruption, but claim, write,
  and release failures are bounded and fail open: they cannot stop host work or
  final-receipt persistence. Status/watch may read this record, but must treat
  host-local durable state and verified final receipts as truth rather than
  introduce a second mutation state model.
- Non-dry-run fleet receipts include an additive `postflight` block
  (`self-upgrade-fleet-postflight/v1`) sourced from `calyx self freshness` for
  each successfully upgraded host. The postflight summary carries the reconciled
  freshness verdict counts, the conductor-resolved `target_sha`,
  `freshness_exit_code`, and compact per-host next actions. The original target
  spelling remains provenance only. Dry-runs omit `postflight`; there is no placeholder or
  `pending_s1` state in the durable receipt.
- A stale same-target blocked toolchain row in `fleet_convergence` remains a
  normal `self drift`/`self freshness` safety signal until it is superseded by
  the later host's **verified** canonical passing receipt and a `fresh`
  postflight for that exact target. An SSH/receipt outage or an `unverified`
  success cannot erase that durable block.
- Every upgraded host gets a first postflight probe. A daemon restarted by its
  own upgrade can still be rebinding the health plane when that probe lands,
  which wrote `blocked` (health unreachable plus a full missing-feature list)
  for hosts a `self freshness` seconds later proved clean. Only typed
  restart-transient evidence is re-probed: request-stage
  `health.error_kind=unreachable` (refusal, request failure, or timeout), or
  `install_drift.status=promoted_not_restarted` when both the promoted and clone
  heads equal the conductor-pinned target SHA. In the latter state, drift and
  capability facts describe the old daemon that is still serving and do not
  veto the retry. Once the promoted target serves, any remaining structural
  drift or required-feature gap stops immediately as `not_retryable`, as do
  authentication/legacy-daemon errors, clone-not-promoted state, and unproven
  promotion evidence; waiting cannot repair them.
  Received HTTP failures and rejected JSON/protocol responses are typed as
  `http_error` / `invalid_response`, stop as `not_retryable`, and retain their
  status or response phase in each observed probe's `health_error` evidence.
  Eligible hosts use a 5s/15s/25s backoff ramp (the last delay repeats) until
  the 45s per-host sleep budget or the 8-probe backstop stops the sequence.
- Retries never soften the answer: an exhausted bound keeps the last observed
  `blocked`/`stale` verdict. That is a completed upgrade mutation with a nested
  nonzero `freshness_exit_code`, not a fabricated probe failure. Because the
  settled postflight is authoritative, that nonzero result marks the enclosing
  receipt failed and the command exits with the freshness code. A command,
  missing-row, delay, or unexpected probe error likewise cannot erase an earlier
  observation or fabricate freshness: it marks both postflight and the enclosing
  receipt failed, emits `daemon.upgrade.fleet.failed`, exits nonzero, and probing
  continues for later upgraded hosts. Every upgrade result gets a `per_host` row.
- Each probed host records `settle.outcome` (`settled_first_probe`,
  `settled_after_retries`, `unsettled_no_retries`, `unsettled_after_retries`, or
  `probe_error`) and the exact `settle.stop_reason` (`settled`,
  `not_retryable`, `retries_disabled`, `no_delay_fits`, `window_budget`,
  `attempt_backstop`, or `probe_error`). `attempts`, `waited_ms`, and
  `elapsed_ms` use an injectable monotonic clock. Each `probes[]` row is
  discriminated as `status=observed` (wall-clock `observed_at` from the source
  freshness result, verdict, health, missing-feature count, and an optional
  typed `retry_reason`) or `status=error` (typed code/message plus conductor
  wall-clock `occurred_at`), with monotonic start/completion offsets and
  duration. Fleet `postflight.checked_at` is the completion anchor, not a claim
  that serial host observations were simultaneous; the per-probe timestamps
  preserve their common timeline. The fleet-level `postflight.settle`
  summarizes outcomes without treating a probe error as a freshness verdict.
  Text output projects the same stop reason and ordered probe results on
  `postflight_settle:` / `postflight_host:` lines.
- Full `--fleet` intentionally rejects `--force`, `--abort-runs`, and
  `--auth-token`; use an explicit single `--host` when you are accepting a
  host-specific forced recovery.

**Operation observability (POL-1881):**
- An **operation id** is announced on stderr before the long-running work
  begins (single-host: the collision-resistant receipt basename
  `self-upgrade-<ts>-<uuid>`; fleet: the collision-resistant aggregate-receipt
  dir basename `fleet-<ts>-<uuid>`). It is also carried on every
  `daemon.upgrade.*` event for the operation, surfaced as `operation_id` in
  `--json`, and printed in the human fleet summary. Each remote's stdout stays
  exactly one final JSON object. Continuous phase records use stderr, so the
  conductor never parses arbitrary stdout or relies on a last-line convention.
- For fleet execution, each host's durable operation state and verified final
  receipt are execution authority. The conductor attempts one crash-durable,
  revisioned `self-upgrade-operation/v1` observation before dispatch; stale
  writers are fenced from that projection, while unavailable, rejected, or
  slow projection writes fail open and never fence host mutation. Remote NDJSON
  frames, the conductor record, event-log copies, human lines, machine progress,
  heartbeats, and the final table are typed projections. The conductor reduces
  transitions by stable identity: exact replay is a no-op, conflicting reuse is
  reported, and delayed/reordered frames cannot move a host backward. Missing
  frames leave execution status untouched. Host and conductor event-log
  appends and operation-record writes have a one-second settle bound; the first
  rejection or timeout opens the relevant local projection circuit so a dead
  sink cannot delay mutation or final authority.
- Relay capability is private process context in the existing SSH invocation;
  it adds no help-visible CLI or consumer API. Remotes without canonical phase
  frames continue with the unchanged final-JSON protocol. Frame absence alone
  cannot identify binary generation—even a current binary can validly produce
  only final JSON—so the conductor records `progress_relay.mode=missing` with
  no synthetic phase or generation claim. Observability is degraded, never
  correctness.
- The first deployment of this wire contract requires a U4/current conductor;
  a predecessor's strict terminal parser cannot be changed in flight. Current
  conductors accept additive remote terminal fields, and a partially completed
  rollout must be retried only from that same conductor generation or a newer
  one. This ordering rule does not itself authorize `--fleet` activation.
- The conductor emits one reduced per-host state line as transitions arrive.
  After 15 seconds without a state change for a particular host it emits that
  host's compact heartbeat; activity from another host cannot hide a stall.
  With `--json`, stderr is NDJSON under
  `calyx.self-upgrade-fleet-progress/v1`; the final aggregate object remains the
  sole stdout payload. Its `operation_started` record names both
  `operation_path` and `operation_projection`, so a locator is never presented
  without its typed availability. Every typed `warning` record repeats the
  current `operation_projection`, including a trailing correction when bounded
  writer cleanup degrades after `fleet_final`. Closed or slow projection sinks
  and bounded diagnostic capture never stop an in-flight mutation.
- The upgrade emits `daemon.upgrade.progress` **phase events** on the existing
  event plane (the idempotent `event_log` mirror + the `/v1/admin/events/stream` SSE
  surface) at each phase boundary. Single-host phases: `fetch`, `build`,
  `promote`, `drain`, `restart`, `health_wait`, `finalize`. The fleet conductor
  emits a `finalize` phase after the per-host loop, before it writes
  `summary.json`, so "all hosts at target, collecting receipts" is observable.
  Relayed remote phases are appended idempotently to the conductor event log
  under the fleet operation id. This removes the previously silent ~1–2 minute
  build/drain/restart gap without making event delivery authoritative.
- Only after bounded postflight settling has produced the authoritative
  decision and the aggregate receipt is durable does the human result end with
  a compact host table containing execution status, a separate freshness
  verdict, before-to-after head, monotonic elapsed time, and a host-qualified
  receipt locator. Machine progress emits
  the equivalent typed `fleet_final` record on stderr. Neither appears until
  postflight has returned its authoritative bounded-settle answer (POL-1933),
  and `summary.json` is durable. The conductor attempts the fleet terminal
  event first, but event-log or stderr projection failure is reported as a
  warning and cannot change execution truth or suppress the durable final.
  Per-host receipt locators are portable control-plane-admin routes of the form
  `<host>:/v1/admin/self-upgrade-receipts/<operation-id>`; host-local absolute
  receipt paths are never persisted in the cross-host locator field.
  If a remote reports a blocked bootstrap-toolchain result but that canonical
  route cannot be reread, the aggregate and operation record retain only the
  explicitly non-authoritative `projected_receipt_path` and
  `projected_toolchain_check` with `receipt_verification.status=unavailable`.
  They deliberately omit `receipt_locator`, `receipt`, and `plan`; projected
  stdout cannot become receipt authority.
  When the complete aggregate would exceed its hard byte limit, the durable
  receipt is explicitly marked `bounded.reason=size_limit`; optional nested
  plans, host receipts, relay frames, postflight detail, and artifact captures
  are omitted while host/status/exit/elapsed/head/locator/verification/error
  authority remains. Size pressure therefore degrades detail, not finalization.
- **Watch / second-shell recovery** uses the durable operation observation:
  ```bash
  calyx self upgrade status [<operation-id>] --watch
  ```
  Omit the id to select the newest genuinely active writer first, then the
  newest readable observation. The status result classifies ownership as
  `active`, `orphaned`, `indeterminate`, or `terminal`, includes projection
  availability and last-update age, and points to verified receipt evidence
  when available. It never claims ownership or re-drives an interrupted
  mutation.
- Each SSH host keeps its own phase event projection, and supporting remotes
  relay the same content-addressed typed phase identity to the conductor. The
  conductor reduces it idempotently behind a 32-frame/128-KiB live budget,
  reconciles a deterministic bounded top set when the child closes, and appends
  a conductor-side event-log projection under the fleet operation id. Alternate
  JSON spellings remain opaque diagnostics and cannot negotiate stream mode.
  The local fast path enters that same reducer directly. Plain-JSON-only remote
  transport remains valid, while missing frames stay evidence-neutral; a
  pre-binding legacy receipt is reported as `unverified`, not promoted to
  current fleet success from projected stdout alone.
- A fleet-dispatched host persists its host `operation_id` and the
  conductor-generated `fleet_operation_id` in the host-owned receipt. The
  private admin route checks that its path matches the durable host operation,
  and the conductor requires the durable fleet binding to match the value
  generated before SSH. Unbound legacy receipts remain readable but yield a
  typed `unverified` fleet result rather than authorizing current success.

**Exit codes:**
- `0` — Every requested mutation succeeded and every authoritative postflight
  verdict was fresh, or every requested dry-run plan was emitted
- `1` — One or more target hosts failed or completed without a verifiable
  current-invocation receipt (`unverified`), or authoritative postflight
  returned any nonzero freshness exit (including usable-with-warnings) after
  bounded settling
- `2` — Usage error
- `6` — Local git, host truth, daemon descriptor, or build setup failure

**Examples:**
```bash
calyx self upgrade --host blade --dry-run --json
calyx self upgrade --host blade --json
calyx self upgrade --fleet --dry-run
calyx self upgrade --fleet --hosts blade,worm --json
calyx self upgrade status --watch
```

### `calyx self upgrade status`

Read the conductor-host `self-upgrade-operation/v1` observation for one
operation.

```bash
calyx self upgrade status [<operation-id>] [--watch] [--json]
```

- With an id, reads that exact operation. Without one, selects the newest
  genuinely live operation first, then the newest readable retained record.
- `--watch` follows a live writer and exits successfully when the operation
  becomes terminal or conclusively orphaned. It rechecks transient
  `indeterminate` evidence finitely, then exits `6` if liveness remains
  unavailable. It is observation only: no claim, resume, or re-drive occurs.
- JSON uses `self-upgrade-operation-status/v1`. Transition history is omitted,
  durability detail and diagnostic strings are bounded, and every JSON mode
  uses the same compact encoding. The exact emitted record, including its
  delimiter, has a 512-KiB ceiling. `--watch --json` emits one object per
  changed observation.
- `projection.running_state` and `projection.owner_liveness` are separate from
  the projected operation outcome. A frozen `running` record with a dead or
  released writer is `orphaned`, never current work. The owner record must
  match both the operation id and writer id before PID/process-generation
  evidence can classify it `active`; a mismatch is degraded and non-active.
- The operation record, event rows, phase stream, and this command are
  projections. Host-local durable state and verified final receipts decide
  mutation and terminal result truth.

**Exit codes:**
- `0` — The selected observation was rendered
- `2` — Usage error
- `4` — The requested operation or operation store does not exist
- `6` — The projection is unreadable, owner liveness remains indeterminate
  after bounded rechecks, or the exact JSON record violates the output ceiling

### `calyx vault`

Fieldwork vault filing, read, search, markdown section, journal entries,
session provenance, footnote disclosure, frontmatter query, freshness stamping,
related-context, and status commands.
`calyx vault` is the Fieldwork-local safe file/read operation surface;
host-agnostic retrieval/provider routing stays under `calyx knowledge`.

```bash
calyx vault <command> [options]
calyx vault --help
calyx vault put --type workstream --project calyx --workstream lane --title "My lane"
calyx vault search POL-871 --mode literal --limit 10 --json
calyx vault fetch vault://fieldwork/50-projects/calyx/README.md --with-frontmatter --with-links --json
calyx vault fetch vault://fieldwork/40-context/fleet-systems/blade.md --footnotes collapsed --json
calyx vault related vault://fieldwork/50-projects/calyx/README.md --relation same-project --limit 10 --json
calyx vault toc vault://fieldwork/50-projects/calyx/README.md --json
calyx vault section get vault://fieldwork/50-projects/calyx/README.md --heading "Current Plan" --max-chars 4000 --json
calyx vault close-out --parent interactive:claude:<session-id> --spawned-by '[[handoff-note]]' --json
calyx vault lineage-check --session --json
calyx vault radar-receipt --week current --json
calyx vault journal entries vault://fieldwork/90-meta/meta-log.md --json
calyx vault journal get vault://fieldwork/90-meta/meta-log.md 2026-06-12/session-close-out --json
calyx vault journal append vault://fieldwork/90-meta/meta-log.md --title "Policy note" --body-stdin --dry-run --json
calyx vault footnotes list vault://fieldwork/40-context/fleet-systems/blade.md --json
calyx vault footnotes get vault://fieldwork/40-context/fleet-systems/blade.md arc-hardening --json
calyx vault frontmatter get vault://fieldwork/50-projects/calyx/README.md --json
calyx vault frontmatter query --type workstream --where 'attention == "focus"' --limit 25 --json
calyx vault stamp vault://fieldwork/40-context/fleet-systems/blade.md --last-probed --json
calyx vault status
```

Supported verbs:
- `put`
- `search`
- `fetch`
- `related`
- `toc`
- `section get`
- `close-out`
- `radar-receipt`
- `lineage-check`
- `journal entries`
- `journal get`
- `journal append`
- `footnotes list`
- `footnotes get`
- `footnotes add`
- `footnotes lint`
- `footnotes gc`
- `frontmatter get`
- `frontmatter query`
- `stamp`
- `status`

`put` writes new artifacts into the fieldwork vault with stamped frontmatter.
It supports:

- `--type <execplan|report|context|project|workstream|prompt|library|meta>`
- `--daily`
- `--issue <POL-XXX>`
- `--project <slug>`
- `--workstream <slug>`
- `--author`
- `--assignee`
- `--updated`
- `--updated-by`
- `--status`
- `--stdin`
- `--dry-run`
- `--json`

### `calyx vault search`

`search` is the frontmatter-aware ripgrep wrapper used by fieldwork guidance.
JSON output uses schema version `calyx.vault.search/v1` and includes canonical
`vault://fieldwork/<relative-path>` identifiers, absolute local paths,
vault-relative paths, bounded structured matches, and a trust posture. Literal
search is implemented now. `semantic` and `hybrid` currently return an explicit
`capability_unavailable` diagnostic instead of silently falling back.

```bash
calyx vault search <query> [--mode literal|semantic|hybrid] [--type <type>] [--issue] [--files] [--limit <n>] [--json]
```

It supports:

- `--mode <literal|semantic|hybrid>` (default: `literal`)
- `--type <type>`
- `--issue`
- `--files`
- `--limit <n>`
- `--json`

### `calyx vault fetch`

`fetch` reads one vault note by `vault://fieldwork/<relative-path>`,
vault-relative path, or absolute path under the resolved vault root. JSON output
uses schema version `calyx.vault.fetch/v1` and includes the canonical vault URI,
absolute path, vault-relative path, bounded markdown text, byte counts,
truncation status, content hash, mtime checkpoint, optional parsed frontmatter,
optional outbound links, and a trust posture marking vault markdown as
untrusted source content.

```bash
calyx vault fetch <vault-uri|path> [--max-bytes <n>] [--with-frontmatter] [--with-links] [--footnotes collapsed|expanded] [--json]
```

It supports:

- `--max-bytes <n>` (default: `24000`, maximum: `250000`)
- `--with-frontmatter`
- `--with-links`
- `--footnotes <collapsed|expanded>`
- `--json`

`--footnotes collapsed` returns the note's current-state spine: every footnote
reference is rewritten to an in-band elision marker carrying the literal next
command (`[^arc-hardening: 412 chars elided - calyx vault footnotes get
40-context/fleet-systems/blade.md arc-hardening]`), and the trailing
`## Footnotes` definition block is replaced with one block marker carrying the
`footnotes list` command. The projection runs before `--max-bytes` bounding, so
the byte budget pays for the spine, not the footnote bodies — the same bounded
retrieval economics as `calyx activity` (POL-1737). JSON output adds a
`footnotes` object with the mode, collapsed keys, char accounting, and the
parser's recall-confidence receipt. `--footnotes expanded` keeps the default
full-note behavior while still reporting the receipt.

Safety behavior:

- Rejects absolute or relative targets that resolve outside the fieldwork vault.
- Rejects non-`vault://fieldwork/...` vault URI namespaces.
- Rejects source files larger than `250000` bytes in this first read-substrate
  slice so fetch cost remains bounded.
- Emits `vault://fieldwork/...` as the stable identifier for follow-up calls.
- Redacts obvious secret-like frontmatter keys and markdown lines on a
  best-effort basis.

### `calyx vault related`

`related` traverses bounded relationships from one source note. JSON output uses
schema version `calyx.vault.related/v1` and returns the source note, relation,
bounded related results, relation evidence, traversal depth, omitted-result
counts, scan-cap metadata, warnings, and the same local-vault trust posture.

```bash
calyx vault related <vault-uri|path> [--relation wikilink|backlink|same-issue|same-project] [--depth <n>] [--limit <n>] [--with-frontmatter] [--json]
```

It supports:

- `--relation <wikilink|backlink|same-issue|same-project>` (default: `wikilink`)
- `--depth <n>` (default: `1`, maximum: `3`)
- `--limit <n>` (default: `20`)
- `--with-frontmatter`
- `--json`

Traversal scans at most `5000` markdown files while looking for same-issue,
same-project, backlink, or basename fallback relations. JSON output reports
`bounds.scanLimit`, `bounds.scannedFiles`, and `bounds.scanTruncated` so callers
can detect when a future indexed provider is needed.

### `calyx vault toc`

`toc` reads one markdown note and returns heading entries with stable heading
ids, heading text, line and byte spans, and section hashes. Notes may be
addressed as vault-relative paths or `vault://fieldwork/...` URIs.

```bash
calyx vault toc <vault-uri|path> [--vault-path <path>] [--json]
```

It supports:

- `--vault-path <path>`
- `--json`

### `calyx vault section get`

`section get` reads one heading section by heading id or exact heading text and
returns a bounded markdown slice with source URI, hash, heading metadata, and
truncation facts.

```bash
calyx vault section get <vault-uri|path> --heading <id-or-text> [--max-chars <n>] [--vault-path <path>] [--json]
```

It supports:

- `--heading <id-or-text>`
- `--max-chars <n>`
- `--vault-path <path>`
- `--json`

`--max-chars` bounds the returned section text, not file IO: the whole note is
still read to locate headings. Obvious secret-like lines in the returned
section are redacted best-effort, matching `vault fetch`.

### `calyx vault` session provenance helpers

Session provenance helpers make the Fieldwork close-out ritual
provenance-by-construction. They compose the existing activity, journal, and
stamp primitives: `close-out` resolves the current session through
`calyx activity self`, writes a close-out scaffold, and stamps the note;
`radar-receipt` appends through the weekly radar's `journal:` contract; and
`lineage-check` validates the frontmatter for hook use.

```bash
calyx vault close-out [--parent <activity-id>] [--spawned-by <wikilink-or-id>] [--slug <slug>] [--title <title>] [--runs-root <path>] [--host <host>] [--vault-path <path>] [--dry-run] [--json]
calyx vault radar-receipt [--week current|YYYY-Www] [--runs-root <path>] [--host <host>] [--vault-path <path>] [--dry-run] [--json]
calyx vault lineage-check [<file>] [--session] [--runs-root <path>] [--host <host>] [--vault-path <path>] [--json]
```

`close-out` scaffolds
`10-daily/<anchor>/session-closeout-<slug>.md`. The anchor date comes from the
indexed activity `created_at` when available, then `updated_at`, then command
time. The slug defaults to the activity cwd basename; pass `--title` or
`--slug` when a repo-root or multi-thread session needs a reader-meaningful
filename. Frontmatter is pre-filled with `created`, `author`,
`type: report`, `subtype: session-closeout`, `status: final`, `tags:
[closeout]`, `session`, optional `parent_session`, optional `spawned_by`, empty
`handoffs`, `related`, and `related_issues` arrays. `author` uses the human-readable
`<backend>:<host>:<session-id>` handle; `session` and `parent_session` use
activity ids such as `interactive:codex:<session-id>` or `run:<id>`.

`radar-receipt` finds the close-out whose frontmatter `session` matches the
current activity and appends a `Session Receipts` bullet to
`10-daily/_weekly/<week>/README.md` through `calyx vault journal append`. The
bullet body carries the activity id, author handle, and close-out wikilink.

`lineage-check` reads a close-out note by path or `--session`, emits JSON
schema `calyx.vault.lineage-check/v1`, and exits non-zero when a lineage field
or close-out frontmatter discriminator is invalid. `type` must be `report` and
`subtype` must be `session-closeout`. `session`/`parent_session` must be
activity ids, with `parent_session` dereferencing through Calyx activity/run
storage. `spawned_by` must be a wikilink or compact id, not prose.

### `calyx vault journal`

Journal tooling covers chronological vault log notes: meta logs, maintenance
logs, weekly radar receipt sections, session-bus files, and read-only ledger
tables. It is the log-note sibling of `calyx vault footnotes`: read structure
best-effort, return typed recall receipts, and avoid hand-rolled markdown
splices. The command noun and contract key are `journal` throughout.

Read-side parsing is intentionally slack. It skips fenced code blocks, tolerates
same-day collisions, accepts dated headings such as `## 2026-06-12 -- Title`
or session-bus `## FROM agent - 2026-06-12 - Topic` headings, accepts
date-leading bullets with hanging continuations inside named sections, and
indexes well-formed table rows read-only. Malformed rows or mixed order degrade
`recall_confidence` and add guard hits instead of crashing.

Append is conservative. It writes heading entries and date-leading bullet
entries only when appendability is high-confidence: a `journal:` frontmatter
contract, an equivalent declared prose/header shape, or monotonic unambiguous
inference. Table-row append exits `2` as `unsupported-entry-kind`; table
sections are read-only in v1. Append inserts at the resolved write position,
never by date sorting, and sets `date_out_of_order` when the supplied date is
older/newer than the adjacent entry for that write position. Applied appends
stamp `updated` and `updated_by` in the same file write.

Exit codes:

- `0` success, including blocked dry-runs that emit `suggested_contract`.
- `2` invalid usage or unsafe applied append precondition.
- `3` note, section, or entry key not found.
- `4` reserved for vault-domain capability unavailable.
- `5` append conflict after one content-hash re-read retry.
- `10` internal invariant failure.

#### `calyx vault journal entries`

Cheap index tier for one note. Without `--section`, returns the top-level entry
stream and advertises discovered sub-document log sections in `sections[]`;
section entries are not merged into the default stream. `--last` means most
recent according to resolved order, not physical file tail.

```bash
calyx vault journal entries <vault-uri|path> [--section <heading-id-or-text>] [--kind auto|heading|bullet|table-row] [--last <n>] [--vault-path <path>] [--json]
```

JSON output uses schema version `calyx.vault.journal-entries/v1` and includes
entry records (`key`, kind, date/title/slug, line and character spans, preview,
fields, body size), section metadata, content hash, and a
`VaultJournalRecallReceipt`.

#### `calyx vault journal get`

Read one entry body by the exact key returned from `entries`. Supported key
forms include `<date>/<slug>`, `<date>/<slug>:N`, and `<date>:N`. `--range A:B`
returns an exact character slice; long bodies use head+tail elision with an
in-band continuation command and integer `text_cursor`.

```bash
calyx vault journal get <vault-uri|path> <entry-key> [--section <heading-id-or-text>] [--range A:B] [--max-chars <n>] [--vault-path <path>] [--json]
```

Unknown keys fail with exit `3` and a bounded available-key list.

#### `calyx vault journal append`

Append one heading or date-leading bullet entry. `--field k=v` fills declared
heading field skeletons only; it is not a template language. `--body-stdin`
is the safe shape for multi-line bodies.

```bash
calyx vault journal append <vault-uri|path> --title <title> [--date YYYY-MM-DD] [--body <markdown>|--body-stdin] [--field k=v]... [--section <heading-id-or-text>] [--dry-run] [--vault-path <path>] [--json]
```

When appendability is blocked, `append --dry-run` exits `0`, writes nothing,
and emits a pasteable `journal:` contract: human mode prints YAML to stdout and
a one-line no-write diagnostic to stderr; JSON mode returns
`changed=false` with `suggested_contract`. The same blocked applied append exits
`2` and prints the suggestion on stderr. There is no `--adopt-contract` in v1.

### `calyx vault footnotes`

Footnote progressive disclosure for vault context notes (the vault-side
instance of the POL-1737 activity recall contract). Named footnote keys are
the stable cursors; `list → get` is the drill-down ladder; the parser is
best-effort with slack — it tolerates numeric and named keys mixed,
definitions interleaved with prose or outside the trailing block, a missing
blank line before the block, inline `^[…]` footnotes, duplicate keys, and
references without definitions, and it reports a recall-confidence receipt
(`high|medium|low` plus ambiguous spans and guard hits) instead of crashing.

#### `calyx vault footnotes list`

Enumerate footnotes in one note: key, kind (`named|numeric|inline`), reference
count and lines, first-line preview, body size, and orphan/dangling flags.
This is the cheap index tier — see what detail exists without paying for any
of it.

```bash
calyx vault footnotes list <vault-uri|path> [--vault-path <path>] [--json]
```

#### `calyx vault footnotes get`

Page one or more footnote bodies on demand. `--range A:B` returns an exact
character slice of a single body (the `activity text --range` idiom); bodies
past `--max-chars` project head+tail with an in-band elision marker carrying
the copyable `--range` continuation command and an integer `text_cursor`.

```bash
calyx vault footnotes get <vault-uri|path> [key] [--keys a,b,c] [--range A:B] [--max-chars <n>] [--vault-path <path>] [--json]
```

Unknown keys fail with exit 3 and the available key list.

#### `calyx vault footnotes add`

Insert a footnote without hunting for the edit point: places `[^key]` at a
unique anchor (literal spine text or an Obsidian `^block-id`) and appends the
definition to a found-or-created trailing `## Footnotes` block. The verb is
`add`, not `attach` — POL-1737 owns the attachment noun (`att:sha256:`).

```bash
calyx vault footnotes add <vault-uri|path> --key <name> --anchor <text|^block-id> [--body <text>|--body-stdin] [--renumber] [--dry-run] [--vault-path <path>] [--json]
```

- Anchors must match exactly one spine location; ambiguous anchors fail with
  the candidate line numbers, missing anchors fail with exit 3.
- Existing keys are refused — keys are stable cursors.
- `--renumber` renormalizes numeric keys to a monotonic sequence in
  appearance order after insertion.

#### `calyx vault footnotes lint`

Advisory findings: orphaned definitions, dangling references, duplicate keys,
definitions outside the block, missing block / blank-line hygiene, inline
footnotes, and ambiguous spans. Also reports altitude metrics — spine vs
footnote line/char counts, `footnote_share`, and `days_since_updated` /
`days_since_last_probed` from frontmatter — as groundwork for the
Archaeologist vault stratum (POL-1386); policy thresholds belong to the
consumer.

```bash
calyx vault footnotes lint <vault-uri|path> [--vault-path <path>] [--json]
```

#### `calyx vault footnotes gc`

Loss-less normalization: relocates stray definitions into the trailing block,
dedupes exact duplicates, normalizes spacing, and optionally renumbers.
Orphan removal is a destructive opt-in (`--drop-orphans`); duplicate keys with
differing bodies are kept for lint to surface. Idempotent on a normalized
note.

```bash
calyx vault footnotes gc <vault-uri|path> [--drop-orphans] [--renumber] [--dry-run] [--vault-path <path>] [--json]
```

### `calyx vault stamp`

Refresh staleness/provenance frontmatter after an in-place edit, leaving the
note body byte-identical (verified by content hash before any write — the
receipt carries the body sha256). Defaults set `updated` to today and
`updated_by` to the detected agent identity; `--last-probed` (optional value,
default today) and repeatable `--field k=v` cover other staleness fields.
Identity fields (`type`/`created`/`author`) and multi-line frontmatter nodes
are refused — stamp is not a frontmatter rewriter (POL-843 family, POL-1764).

```bash
calyx vault stamp <vault-uri|path> [--updated <ts>] [--updated-by <who>] [--last-probed [ts]] [--field k=v]... [--dry-run] [--vault-path <path>] [--json]
```

Notes without frontmatter get a minimal block created (with a warning), body
untouched. `--dry-run` prints the frontmatter diff without writing.

### `calyx vault frontmatter get`

`frontmatter get` parses one note's leading YAML frontmatter and returns the
source URI, body hash, frontmatter byte span, and parsed mapping.

```bash
calyx vault frontmatter get <vault-uri|path> [--vault-path <path>] [--json]
```

It supports:

- `--vault-path <path>`
- `--json`

### `calyx vault frontmatter query`

`frontmatter query` scans markdown files under the local Fieldwork vault and
returns deterministic rows with source URIs, frontmatter mappings, source hashes,
and matched field provenance. The first read-only slice supports equality and
inequality predicates in the form `field == "value"` / `field != "value"` plus
`--type <type>` as a first-class Fieldwork frontmatter filter. Cross-source
aggregation, semantic recall, and QMD provider routing remain `calyx knowledge`
responsibilities. It supports:

- `--type <type>`
- `--where <expr>`
- `--limit <n>`
- `--vault-path <path>`
- `--json`

`status` reports vault counts plus host-aware Obsidian Sync health. Attended
macOS hosts use the official desktop `obsidian sync:status` command and require
it to report `status: synced`; they do not require Headless configuration.
Linux server hosts with a matching Headless config use the managed `ob` wrapper
and `ob-fieldwork-sync-health` probe, which checks supervision, continuous
process count, and recent journal evidence. For Headless fieldwork providers,
`status` also audits `_local` and `.exports` exclusions and reports rows under
those prefixes in `local_files`, `server_files`, or `pending_files`. JSON output
exposes the provider and health under `syncStatus` and makes Headless-only
applicability explicit under `syncHygiene.applicable`.

- `--json`

---

## Config Commands

Fleet/host YAML compilation to Codex TOML.

### `calyx config compile`

Compile fleet/host YAML inputs to Codex TOML with semantic parity checking.

```bash
calyx config compile --fleet <path> --hosts-dir <path> --host <host> [options]
```

**Options:**
- `--fleet <path>` (required) — Path to fleet.v2.yaml
- `--hosts-dir <path>` (required) — Path to hosts directory
- `--host <host>` (required) — Host key to compile
- `--out <path>` — Write output TOML path
- `--mode <mode>` — Validation mode: `strict` or `advisory` (default: `strict`)
- `--write` — Write TOML to `--out` path
- `--parity <path>` — Expected TOML fixture path for semantic parity check
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Success
- `1` — Runtime error (file not found, parse failure, parity mismatch)

**Example:**
```bash
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

---

### `calyx config show`

Show resolved source paths for all domains (config file, environment variables).

```bash
calyx config show [options]
```

**Options:**
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Success

**Example:**
```bash
calyx config show
calyx config show --json
```

---

## Instructions Commands

Instruction surface inspection plus render and parity verification.

### `calyx instructions list`

List named instruction surfaces from a manifests directory.

```bash
calyx instructions list --surfaces-dir <path> [--include-archived] [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--include-archived` — Include archived surfaces in output
- `--json` — Print machine-readable summary

### `calyx instructions show`

Show one named instruction surface, including resolved source refs and target bindings.

```bash
calyx instructions show <surface-id> --surfaces-dir <path> [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--json` — Print machine-readable summary

### `calyx instructions stack`

Inspect the effective inherited instruction source stack for one working
directory using the observed Codex or Claude resolution rules. The command is
read-only: it reads source metadata and bytes for hashing/counting, but never
executes, installs, syncs, applies, or prints instruction or partial bodies.

```bash
calyx instructions stack --cwd <path> --harness <codex|claude> --host <host> [--agents-infra-root <path>] [--json]
```

**Options:**
- `--cwd <path>` (required) — Working directory whose inherited stack is inspected
- `--harness <codex|claude>` (required) — Apply the current harness-specific discovery rules
- `--host <host>` (required) — Host alias used to select installed/rendered
  provenance from the locally available agents-infra truth. This is provenance
  selection, not remote host inspection; run the command on the target host to
  inspect that host's live filesystem.
- `--agents-infra-root <path>` — Optional source root override for rendered surface/template provenance
- `--json` — Emit the stable `calyx.instructions-stack/v1` receipt

**Receipt contract:**
- Sources are ordered as the harness presents them and include logical target,
  canonical path, scope, owner, lifecycle, content SHA-256, optional Git
  revision, raw line/byte counts, deterministic `ceil(bytes / 4)` token
  estimate, Codex included-byte/truncation state, mirrors, and source/template/
  partial provenance.
- Byte-identical AGENTS/CLAUDE counterparts are represented as mirror targets;
  a counterpart not loaded by the selected harness is not added to totals.
- Structural findings include unresolved/ambiguous provenance, candidate
  owners, missing owner/lifecycle metadata, missing globals, and refused
  sensitive-looking Claude imports.
- Repeated-imperative, wrong-altitude, conflicting-claim, and stale-child
  findings are advisory-only. Every advisory carries locator(s), confidence,
  reason, and a stable fingerprint. Zero advisories is not a semantic
  correctness claim.
- JSON is a metadata-only envelope:
  `{ "ok": <structural-ok>, "command": "instructions.stack", "result": ... }`.
  It excludes instruction bodies, partial bodies, config values, secrets, and
  behavioral/attention telemetry.

**Observed resolution differences:**
- This model is a dated observation of the named 2026-07-21 harness probes and
  versions carried in the receipt. Re-probe and update the contract after a
  harness change; the command does not claim timeless resolver equivalence.
- Codex selects the first non-empty global `AGENTS.override.md`/`AGENTS.md`,
  then at most one `AGENTS.override.md`/`AGENTS.md`/configured fallback per
  directory from project root to cwd. Its configured byte budget applies to
  the concatenated project documents.
- Claude loads managed and user instructions, then `CLAUDE.md`,
  `.claude/CLAUDE.md`, unscoped `.claude/rules/**/*.md`, and
  `CLAUDE.local.md` from broad to narrow directories. Safe `@` imports are
  represented recursively; path-scoped rules and child guides remain lazy
  until matching files/subtrees are touched.

**Exit codes:**
- `0` — Structural receipt resolved; advisory findings may still be present
- `1` — Runtime read or parse failure
- `2` — Usage error
- `3` — Structural provenance/ownership/lifecycle failure; the JSON receipt is still emitted

**Examples:**
```bash
calyx instructions stack --cwd /Users/carbon/dev/polli/dev/apps/explorer/src/features/wfc4 --harness codex --host carbon --json
calyx instructions stack --cwd /Users/carbon/dev/polli/dev/apps/explorer/src/features/wfc4 --harness claude --host carbon --json
```

### `calyx instructions trace`

Trace one rendered or installed instruction file back to the source surface or
template fanout that currently explains it.

```bash
calyx instructions trace <target> [--surfaces-dir <path>] [--agents-infra-root <path>] [--host <host>] [--include-archived] [--include-variables] [--include-partial-contents] [--json]
```

**Options:**
- `--surfaces-dir <path>` — Optional instruction surfaces directory override; defaults to `<agents-infra-root>/instructions/surfaces` when available
- `--agents-infra-root <path>` — Agents-infra source root used to discover surfaces, template registry, partials, and truth-store inputs
- `--host <host>` — Host alias used for host-scoped trace resolution (defaults to the local host alias)
- `--include-archived` — Include archived surfaces when tracing manifest-backed targets
- `--include-variables` — Include resolved variable values instead of only variable names plus provenance
- `--include-partial-contents` — Include partial template contents in the JSON payload
- `--json` — Print machine-readable summary

**Behavior:**
- `trace` is read-only and never mutates live instruction files.
- The command can return either `surface_binding` for manifest-backed targets or `template_fanout` for the legacy global template fanout such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and staged markdown under `generated/staged/<host>/`.
- Success requires exactly one explaining source. Zero matches produce `unmanaged_target`. More than one match produces `ambiguous_target`.
- `--json` emits a stable envelope on both success and semantic lookup failure:
  - success: `{ "ok": true, "command": "instructions.trace", "result": ... }`
  - semantic miss: `{ "ok": false, "command": "instructions.trace", "error": ... }`

**Exit codes:**
- `0` — Exact successful trace
- `1` — Runtime error (missing agents-infra root, read failure, parse failure)
- `2` — Usage error
- `3` — Semantic lookup failure (`unmanaged_target`, `ambiguous_target`)

**Examples:**
```bash
calyx instructions trace ~/.claude/CLAUDE.md
calyx instructions trace /Users/carbon/dev/AGENTS.md --host carbon --json
```

### `calyx instructions targets`

List target bindings across named instruction surfaces.

```bash
calyx instructions targets --surfaces-dir <path> [--surface <surface-id>] [--include-archived] [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--surface <surface-id>` — Filter to a single instruction surface
- `--include-archived` — Include archived surfaces in output
- `--json` — Print machine-readable summary

When filtering with `--surface`, archived surfaces require `--include-archived`; otherwise the command fails fast with an archived-surface diagnostic instead of silently pretending the manifest is missing.

### `calyx instructions reconcile`

Reconcile declared local instruction targets for a specific host without mutating them.

```bash
calyx instructions reconcile --surfaces-dir <path> --host <host> [--surface <surface-id>] [--repo-root <path>] [--include-archived] [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--host <host>` (required) — Host alias whose declared local targets should be reconciled
- `--surface <surface-id>` — Filter to a single instruction surface
- `--repo-root <path>` — Override declared `repo_root` bindings with the current checkout path
- `--include-archived` — Include archived surfaces in the reconcile pass
- `--json` — Print machine-readable summary

**Behavior:**
- Reconcile is local-target only in this slice: it evaluates declared `directory_root` and `repo_root` bindings.
- Reconcile is no-bridge by design: files that match current rendered output but lack Calyx ownership markers are reported as `unmanaged_match`, not treated as implicitly managed.
- Archived surfaces are opt-in and are surfaced as `archived_managed_present` when live local targets still exist.

**Exit codes:**
- `0` — All examined local targets are `managed_ok`
- `2` — Usage or validation error
- `3` — One or more non-OK reconcile findings were detected
- `10` — Internal/runtime failure

### `calyx instructions apply`

Write declared local instruction targets only when they are missing or already Calyx-managed.

```bash
calyx instructions apply --surfaces-dir <path> --host <host> [--surface <surface-id>] [--repo-root <path>] [--dry-run] [--reviewed-overwrite] [--backup-dir <path>] [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--host <host>` (required) — Host alias whose declared local targets should be applied
- `--surface <surface-id>` — Filter to a single instruction surface
- `--repo-root <path>` — Override declared `repo_root` bindings with the current checkout path
- `--dry-run` — Print the planned mutation set without writing files
- `--reviewed-overwrite` — After reviewing a dry-run plan, allow replacement of unmanaged divergent files with backups
- `--backup-dir <path>` — Override the reviewed-overwrite backup root for this apply
- `--json` — Print machine-readable summary

**Behavior:**
- `apply` is hard-cut and no-bridge: it will write missing declared files and update already-managed files, but it will not silently adopt unmanaged files.
- `unmanaged_match`, `unmanaged_present`, `ownership_conflict`, and archived-surface leftovers block the command and are reported in the summary.
- `--reviewed-overwrite` only changes the handling of `unmanaged_present` targets. It does not adopt unmanaged matching files, override ownership conflicts, or mutate archived leftovers.
- Use `--dry-run --reviewed-overwrite` first for reviewed overwrite workflows; dry-run output includes `plannedChanges`, live/expected content hashes, and `reviewed_overwrite` action counts without writing targets.
- Successful writes add or refresh a frontmatter `calyx:` ownership marker with surface, binding, host, and content-hash provenance.
- Reviewed overwrites create backups before replacing unmanaged files. For `repo_root` targets, backups default under `${CALYX_INSTRUCTION_BACKUP_DIR:-~/.calyx/instruction-backups}/<surface>/<host>/<binding>/` so Git checkouts stay clean. Other target classes keep sibling backups named `<target>.calyx-backup-<timestamp>` unless `--backup-dir` is provided.

**Exit codes:**
- `0` — Apply completed successfully
- `2` — Usage or validation error
- `3` — One or more targets blocked apply
- `10` — Internal/runtime failure

### `calyx instructions adopt`

Adopt existing unmanaged local instruction targets only when they already match the current declared render output.

```bash
calyx instructions adopt --surfaces-dir <path> --host <host> [--surface <surface-id>] [--repo-root <path>] [--dry-run] [--json]
```

**Options:**
- `--surfaces-dir <path>` (required) — Path to a flat instruction surface manifests directory; nested subdirectories are rejected
- `--host <host>` (required) — Host alias whose declared local targets should be adopted
- `--surface <surface-id>` — Filter to a single instruction surface
- `--repo-root <path>` — Override declared `repo_root` bindings with the current checkout path
- `--dry-run` — Print the planned mutation set without writing files
- `--json` — Print machine-readable summary

**Behavior:**
- `adopt` is explicit ownership capture for `unmanaged_match` targets only.
- Drifted unmanaged files are not rewritten here; they remain findings that require source cleanup or manual replacement first.
- Already-managed files are left in place, with summary output marking them as `already_managed`.
- Use `apply --dry-run --reviewed-overwrite` followed by `apply --reviewed-overwrite` when the operator has reviewed and chosen to replace an unmanaged divergent guide.

**Exit codes:**
- `0` — Adopt completed successfully
- `2` — Usage or validation error
- `3` — One or more targets blocked adoption
- `10` — Internal/runtime failure

### `calyx instructions render`

Render a named instruction surface or raw instruction template inputs with deterministic token and partial semantics.

```bash
calyx instructions render [--surfaces-dir <path> --surface <surface-id>] [--fleet <path> --hosts-dir <path> --template <path> --partials-dir <path>] [options]
```

**Options:**
- `--surfaces-dir <path>` — Path to a flat instruction surface manifests directory
- `--surface <surface-id>` — Named surface to render
- `--fleet <path>` — Path to fleet instructions YAML (raw engine mode)
- `--hosts-dir <path>` — Path to host instructions directory (raw engine mode)
- `--template <path>` — Path to instruction template (`*.md.mustache`) (raw engine mode)
- `--partials-dir <path>` — Path to partial templates directory (raw engine mode)
- `--host <host>` — Host alias to render (single host)
- `--all` — Render all hosts under `--hosts-dir`
- `--out-dir <path>` — Write rendered output files to this directory
- `--json` — Print machine-readable summary

`render` accepts either named-surface mode or the raw file quartet, not both. Named-surface mode also fails fast on duplicate `surface_id` values under `--surfaces-dir`.

**Exit codes:**
- `0` — Success
- `1` — Runtime error (missing template, parse failure)
- `2` — Usage error (mixed modes or missing required mode-specific flags)

**Example:**
```bash
calyx instructions render \
  --surfaces-dir fixtures/instructions/surfaces \
  --surface sample-global \
  --host blade

# Raw engine mode
calyx instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade
```

### `calyx instructions verify`

Verify a named instruction surface or raw rendered instruction outputs against expected fixtures, reporting drift.

```bash
calyx instructions verify [--surfaces-dir <path> --surface <surface-id>] [--fleet <path> --hosts-dir <path> --template <path> --partials-dir <path>] [--expected-dir <path>] [options]
```

**Options:**
- All options from `instructions render`, plus:
- `--expected-dir <path>` — Path to expected rendered outputs

For named-surface mode, `--expected-dir` is optional if the surface manifest
defines `source_ref.expected_dir` or a `staged_preview` target binding. Raw
engine mode still requires `--expected-dir`.

**Exit codes:**
- `0` — Verification passed (no drift)
- `1` — Runtime error
- `2` — Usage error
- `3` — Verification failed (drift detected)

**Example:**
```bash
calyx instructions verify \
  --surfaces-dir fixtures/instructions/surfaces \
  --surface sample-global \
  --all

# Raw engine mode
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

---

## Skills Commands

Skills registry management: index, sync, and validate.

### `calyx skills index`

Index skills from a registry, filtering by lifecycle status.

```bash
calyx skills index --registry <path> [--include-archived] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--include-archived` — Include archived skills in output
- `--exclude-deprecated` — Exclude deprecated skills from output
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error

### `calyx skills show`

Show one skill's registry entry, resolved source path, expected install targets,
current local install state, and projected fleet install locations.

```bash
calyx skills show <skill-id> [--registry <path>] [--agents-infra-root <path>] [--check] [--show-install-hashes] [--json]
```

**Options:**
- `--registry <path>` — Path to a skills registry JSON file; falls back to the standard Calyx registry resolution chain
- `--agents-infra-root <path>` — Agents-infra source root used to resolve internal skill sources and fleet host projections
- `--check` — Exit non-zero when any source or local install check is not fully healthy
- `--show-install-hashes` — Include expected/live skill and tree hashes in the result
- `--json` — Print machine-readable summary

**Behavior:**
- `show` is read-only and never syncs or rewrites any install tree.
- The result distinguishes source-of-truth metadata, resolved local source availability, expected local install targets for `agents`, `claude`, and `codex`, current local install state, and projected fleet install targets.
- `source.provenance_class` is derived from `source.type` (`internal` → `repo-managed`, `external` → `vendored`, `repo-maintained` → `repo-maintained`); it is omitted for unknown source types. Provenance is orthogonal to lifecycle status.
- `source.regime` (POL-1729 Slice 2) is the current source-of-truth: `git` (the default when `source.regime` is absent) or `db` (agent-owned, re-materializer-rendered; set by `calyx skills migrate`). Regime is orthogonal to `provenance_class` — a migrated first-party skill stays `repo-managed` but becomes `regime: db`.
- `--json` emits a stable envelope on both success and semantic lookup failure:
  - success: `{ "ok": true, "command": "skills.show", "result": ... }`
  - semantic miss: `{ "ok": false, "command": "skills.show", "error": ... }`

**Exit codes:**
- `0` — Skill found and displayed successfully
- `1` — Runtime error (registry read failure, source resolution failure)
- `2` — Usage error
- `3` — Semantic lookup failure (`skill_not_found`) or `--check` failure

**Examples:**
```bash
calyx skills show fieldwork-conventions
calyx skills show fieldwork-conventions --check --json
```

### `calyx skills sync`

Sync skills from a registry into target backend(s) using the plan/apply contract.

```bash
calyx skills sync --registry <path> [--backend <backend>] [--apply] [--prune-deprecated] [--native-codex-skills] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--backend <backend>` — Sync backend: `claude`, `codex`, `agents`, or `all` (default: `all`)
- `--apply` — Apply sync actions (default: plan-only)
- `--include-archived` — Include archived skills
- `--include-retired` — Include retired skills in non-prune sync plans
- `--exclude-deprecated` — Exclude deprecated skills
- `--prune-deprecated` — Plan or apply prune actions for deprecated or retired skills, including legacy nested `_deprecated/<id>` runtime install trees
- `--native-codex-skills` — Write the independent `~/.codex/skills/polli`
  namespace. By default, Codex skill sync aliases to `~/.agents/skills`
  because current Codex Desktop/CLI builds already discover that tree.
- `--json` — Print machine-readable JSON summary

**Regime skip (POL-1729 Slice 2):** an entry whose `source.regime` is `db`
(agent-owned; see `calyx skills migrate` below) is **skipped** by sync — it emits
a `plan-skip`/`skip` action with details `db-regime (re-materializer-owned)` and
its mirror is never touched. The Slice-1 re-materializer owns db-regime mirrors;
sync only manages `git`-regime (the default) entries. This is the
no-cross-regime-clobber contract.

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx skills validate`

Validate skills registry structure and lifecycle constraints.

```bash
calyx skills validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to skills registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed (errors found)

### `calyx skills propose` (wave 2.4)

Local skill proposal lifecycle. State lives in `~/.calyx/state/calyx.db` via
migration `0004` (`skill_proposals` + `skill_proposal_events`). Every command
in this family is local: it never edits installed harness mirrors
(`~/.agents/skills/**`, `~/.claude/skills/**`, `~/.codex/skills/**`) and
never invokes `calyx skills sync` or fleet propagation.

Status vocabulary is closed: `proposed`, `validated`, `materialized`,
`accepted`, `rejected`, `superseded`.

Kinds:

- `create` — propose a brand-new skill source draft.
- `patch` — propose a unified-diff against an existing skill.
- `file` — propose whole-file content for a relative path inside a skill.

```bash
calyx skills propose create <skill-id> [--target agents-infra|repo-local] [--source-root <path>]
  [--content <text>|--content-file <path>|--body-file <path>|--stdin]
  [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] [--json]

calyx skills propose patch <skill-id> [--target ...] [--source-root <path>]
  [--diff <text>|--diff-file <path>|--body-file <path>|--stdin]
  [--summary ...] [--author ...] [--json]

calyx skills propose file <skill-id> <relative-source-file> [--target ...] [--source-root <path>]
  [--content <text>|--content-file <path>|--body-file <path>|--stdin]
  [--summary ...] [--author ...] [--json]
```

**Resolution:**
- `--target agents-infra` (default) resolves the source root via
  `resolveAgentsInfraRoot()` unless `--source-root` overrides it. Install
  mirror paths are refused with an explicit alternative.
- `--target repo-local` requires `--source-root` and resolves the source
  path as `<source-root>/skills/<skill-id>`.
- `<relative-source-file>` is constrained to non-empty relative paths with
  no leading slash and no `..` traversal.

**Examples:**
```bash
calyx skills propose create fieldwork-conventions \
  --target agents-infra --content-file SKILL.md \
  --summary "learned in POL-1318" --json

calyx skills propose patch calyx-dev \
  --target repo-local --source-root ~/dev/calyx/wt/caleb/example \
  --diff-file change.patch --json

calyx skills propose file fieldwork-conventions references/checklist.md \
  --target agents-infra --content-file checklist.md --json
```

**Exit codes:**
- `0` — Proposal created.
- `2` — Usage / vocabulary error (invalid `--kind`/`--target`/`--status`,
  missing body, install-mirror `--source-root`, etc.).
- `7` — Underlying state-driver error (e.g. unsupported Node runtime).

### `calyx skills proposals list|show|review|validate|materialize` (wave 2.4)

Inspect, transition, validate, and materialize local skill proposals.

```bash
calyx skills proposals list [--status <status>] [--skill-id <id>] [--limit <n>] [--json]
calyx skills proposals show <proposal-id> [--json]
calyx skills proposals validate <proposal-id> [--actor <id>] [--json]
calyx skills proposals materialize <proposal-id> (--output <path> | --worktree <dir>) [--actor <id>] [--json]
calyx skills proposals review <proposal-id> --status accepted|rejected|superseded [--actor <id>] [--note <text>] [--json]
```

**Materialization rule:**
`materialize` writes a reviewable patch artifact (kind=patch) or a whole-file
content snapshot (kind=create/file) to `--output <path>` or to
`<worktree>/calyx-skill-proposals/<proposal-id>.{patch,content}`. A sibling
`.manifest.json` is always written. Materialization never invokes
`calyx skills sync` and refuses output paths under installed harness
mirrors with a named alternative.

**Exit codes:**
- `0` — Operation succeeded.
- `2` — Usage / vocabulary error.
- `3` — Proposal not found, validation failed, or refused install-mirror target.
- `7` — Underlying state-driver error.

**Examples:**
```bash
calyx skills proposals list --status proposed --limit 10 --json
calyx skills proposals show <proposal-id> --json
calyx skills proposals validate <proposal-id> --json
calyx skills proposals materialize <proposal-id> \
  --output ~/dev/agents-infra/wt/example/patches/<proposal-id>.patch --json
calyx skills proposals review <proposal-id> --status accepted --note "ready"
```

---

### `calyx skills write` / `calyx skills delete` (POL-1729 Slice 1)

Write **agent-owned** skill content to the local DB-of-record and immediately
re-materialize the harness install mirrors. The DB (`skill_content`, migration
`0016`) is the source of truth for regime `db` skills; the re-materializer
renders them into the install mirrors using the same atomic full-directory swap
as `calyx skills sync`. git/vendored/repo-maintained skills are sourced from
their repos and are never written or re-materialized through these verbs.

```bash
calyx skills write <name> (--content <text> | --content-file <path> | --payload-file <path>) \
  [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] \
  [--gate-policy gate-sharpest|free] [--json]
calyx skills delete <name> [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] [--json]
```

The `<name>` is normalized to a canonical skill id (lowercased, non-`[a-z0-9-]`
collapsed to `-`) at the entry of both verbs, so the DB row and every backend
mirror agree regardless of the raw casing. When the canonical name differs from
the raw input, the result carries a `note: skill name normalized to <canonical>`.

**Content sources (write, exactly one required):**
- `--content <text>` / `--content-file <path>` — single-file SKILL.md (common case).
- `--payload-file <path>` — a JSON map of `relpath -> content` for multi-file
  documents (must include a non-empty `SKILL.md`; keys must be relative, no `..`).

**Security gate (Posture A):** every payload file is scanned (advisory, not a
trust boundary). Under the default `--gate-policy gate-sharpest`, a SHARP finding
(shell-destructive, network-exfil, or credential shape) refuses the write
(exit 3, `gated_sharp_content`) — use `calyx skills propose` for the reviewed
path, or `--gate-policy free` to override and record the findings. SOFT findings
(invisible/bidi unicode) are always recorded and never block.

**Re-materialize semantics:**
- `write` UPSERTs the full document (clearing any prior tombstone), then renders
  every backend mirror. A second identical write is a no-op against the rendered
  tree. Removed payload files are purged (full-directory swap).
- `delete` records a tombstone (the row is retained, not hard-deleted) and prunes
  every mirror. A later `write` over the tombstone recreates the skill.
- Visibility: `codex: live-after-rematerialize`, `claude: next-session`.
- The `materialized_at` stamp is a compare-and-set; a newer write that lands
  mid-flight is left for its own re-materialize pass (no error).

**Exit codes:**
- `0` — Operation succeeded.
- `2` — Usage error (missing/conflicting content source, bad `--gate-policy`).
- `3` — Gated on sharp content, or migration `0016` not applied.
- `7` — Underlying state-driver error.

**Examples:**
```bash
calyx skills write my-skill --content-file SKILL.md --author claude:carbon --summary "first draft" --json
calyx skills write my-skill --payload-file payload.json --json   # {"SKILL.md":"...","references/x.md":"..."}
calyx skills delete my-skill --summary "retired" --json
```

---

### `calyx skills migrate` (POL-1729 Slice 2)

Migrate a **first-party** (`source.type=internal`) skill from its git source to
the agent-owned **db regime**. It reads the skill's current git-source content
(`SKILL.md` + extra files), seeds `skill_content` with `regime=db`, and
re-materializes every harness mirror through the SAME path-traversal-guarded,
atomic re-materializer as `calyx skills write`. After migration the DB is the
source of truth and `calyx skills sync` skips the entry (see the regime-skip note
under `calyx skills sync`).

```bash
calyx skills migrate [skill-id] [--all-internal] [--confirm] [--dry-run] \
  [--registry <path>] [--agents-infra-root <path>] [--json]
```

**Regime vs provenance** are orthogonal: a migrated skill keeps its provenance
class (`repo-managed`) but its current source-of-truth (`regime`) becomes `db`.
Both are shown by `calyx skills show`.

**This verb does NOT edit SOURCES.json.** That file lives in agents-infra (a
separate repo); migrating it there is a reviewed, operator-gated commit. Every
result carries a `next_step`: set `"regime": "db"` on the entry in agents-infra
`instructions/skills/SOURCES.json` and commit, after which `calyx skills sync`
skips it (the re-materializer owns the mirror). Until you make that edit, sync
still treats the registry entry as git-regime.

**Options:**
- `skill-id` — Skill id to migrate. Omit only with `--all-internal`.
- `--all-internal` — Migrate every `source.type=internal` skill. Applying
  requires `--confirm` (otherwise refused, exit 3, `confirm_required`);
  `--dry-run` is always allowed without `--confirm`.
- `--confirm` — Confirm an `--all-internal` apply.
- `--dry-run` — Plan only: report the would-be `content_hash` + payload file list;
  write nothing (no DB row, no mirror).
- `--registry <path>` — Path to skills registry JSON (or `CALYX_SKILLS_REGISTRY`).
- `--agents-infra-root <path>` — agents-infra source tree (for resolving the
  internal source path).
- `--json` — Print machine-readable summary (`skills.migrate`).

**Idempotency:** migrating a skill that is already `regime=db` with identical
content is a `noop`. Re-running after the source changed re-materializes the new
content. Only `internal` skills migrate — vendored/repo-maintained are refused
(`not_first_party`, exit 3, with the valid internal skill ids enumerated).

**Exit codes:**
- `0` — Migrated (or planned / no-op).
- `2` — Usage error (no skill-id and no `--all-internal`, or both supplied).
- `3` — `not_first_party`, `confirm_required`, `source_unresolved`,
  `skill_not_found`, or migration `0016` not applied.
- `7` — Underlying state-driver error.

**Examples:**
```bash
calyx skills migrate calyx-dev --dry-run --json          # preview the hash + payload files
calyx skills migrate calyx-dev --json                    # apply: seed db-regime + re-materialize
calyx skills migrate --all-internal --dry-run --json     # preview migrating every internal skill
calyx skills migrate --all-internal --confirm --json     # apply to every internal skill
```

---

### `calyx skills usage` (POL-1729, read-only)

Report per-skill load counts from fleet Loki telemetry. Read-only and
graceful-degrading: an unreachable or malformed backend never fails the command.

```bash
calyx skills usage [--since <dur>] [--limit <n>] [--endpoint <url>] [--json]
```

**Options:**
- `--since <dur>` — Loki lookback window (default `7d`; e.g. `24h`, `30d`)
- `--limit <n>` — Bound returned skills (default `20`, max `100`)
- `--endpoint <url>` — Loki base URL override (default: `$CALYX_LOKI_ENDPOINT` or `http://blade:3100`)
- `--json` — Print machine-readable summary (`skills.usage/v1`)

**Signal scope:** counts reflect Claude `Skill`-tool loads only. Codex
skill-injection telemetry is the POL-1834 gap and is not represented.

**Behavior:**
- Network error → `status: "unavailable"` with the endpoint and cause.
- Non-200 → `status: "unavailable"` with the HTTP status code.
- Malformed / unsuccessful body → `status: "degraded"` with a note.
- A degraded/unavailable backend still exits `0`; the unavailable reason and
  reachability suggestions are written to stderr.

**Examples:**
```bash
calyx skills usage --since 30d --json
calyx skills usage --limit 10
```

Agent question: *"which skills are actually being loaded, and how often?"*

---

### `calyx skills curator status | run | pin | unpin | consolidate | rollback` (POL-1729)

A two-phase curator over the skills registry plus Loki usage signal. **Phase 1**
(`status`, `run` without `--apply`) is the read-only recommendations report.
**Phase 2** (Slice 3) is the apply mechanics: a deterministic recoverable
archive, a judged multi-row consolidation, pinning, and rollback. The curator
gates on **Claude-primary** usage — POL-1834 shipped an interim WARN-mining
fallback panel, NOT a clean Codex signal.

```bash
calyx skills curator status [--registry <path>] [--since <dur>] [--endpoint <url>] [--json]
calyx skills curator run [--dry-run | --apply --confirm] [--registry <path>] [--since <dur>] [--endpoint <url>] [--limit <n>] [--json]
calyx skills curator pin <id> [--json]
calyx skills curator unpin <id> [--json]
calyx skills curator consolidate <source...> --into <targetId> --content-file <SKILL.md> [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] [--json]
calyx skills curator rollback (--last | --pass <id> --cursor <n>) [--json]
```

**`run` behavior:**
- `status` summarizes registry size, provenance breakdown, lifecycle breakdown,
  and usage backend status (`skills.curator-status/v1`).
- `run` (default dry-run) computes deterministic, RECOMMEND-ONLY recommendations
  (`skills.curator-report/v1`):
  - `low-signal` — zero Claude loads in the window AND the usage backend is `ok`.
  - `archive-candidate` — `deprecated` AND zero Claude loads.
  - `consolidate-candidate` — near-duplicate **db-regime** skills (normalized
    title/description token-overlap ≥ 0.85). Computed from `skill_content`
    payloads (no extra I/O); NOT usage-gated. Git-regime entries carry no
    description without extra reads and keep the skipped note.
- Blind-sensor rule: when the usage backend is not `ok`, zero usage-grounded
  recommendations are emitted and a suppression note is added.
- `--apply` (mutating; **requires `--confirm`**) runs `applyCuratorReport`:
  - **Blind-sensor gate:** a non-`ok` usage backend BLOCKS all mutations and
    exits `3` (`usage_backend_blocked`). A blind sensor never drives an actuator.
  - **Deterministic archive only:** each non-pinned, live db-regime
    `archive-candidate` is recoverable-archived (tombstoned with payload
    retained) and its mirrors pruned. Pinned candidates are `pinned_skipped`.
    Stale (active + 0 usage) is RECOMMEND-ONLY and never auto-applied.
  - **No auto-consolidation** — consolidation needs judgment; candidates are
    reported for the `consolidate` verb.
  - Returns `skills.curator-apply/v1`: applied/skipped/pinned-skipped counts, the
    `pass_id`, and the `rollback_cursor`.

**`pin` / `unpin`** set/clear the curator-apply protection fence (migration
`0017`) on an agent-owned db skill. Pinning does NOT affect manual `skills
write` / `delete`.

**`consolidate`** folds N agent-owned sources INTO a target survivor via a
multi-row compare-and-set (`consolidateSkillContent`), then re-materializes the
target and prunes the source mirrors. **ALL-OR-NOTHING:** a concurrent write to
any source aborts the whole consolidation (`ConsolidationAborted`); refuses any
pinned source, any non-`db` source, self-consolidation, and empty sources.

**`rollback`** replays the `skill_write_log` window in reverse to un-archive a
curator pass. `--last` derives the most recent pass on this host; `--pass`/`--cursor`
target an explicit pass from a receipt. Guarantees: it only un-archives (never
re-deletes a skill (re)created after the pass) and is idempotent. Curator
archives are recoverable (payload retained); a manual `skills delete` hard
tombstone is reported `unrestorable`.

**Exit codes:**
- `0` — report produced / mutation applied. A blind/degraded backend never
  changes the exit code on the read path.
- `2` — `--apply` without `--confirm`; `rollback` without `--cursor`/`--last`;
  unreadable `--content-file`.
- `3` — registry unresolved; migration `0017` absent; `--apply` blocked by the
  blind-sensor gate; `consolidate` aborted (pinned/concurrent/not-found); no
  pass to roll back.

**Examples:**
```bash
calyx skills curator status
calyx skills curator run --dry-run --json
calyx skills curator run --apply --confirm --json          # deterministic recoverable archive
calyx skills curator pin my-skill --json
calyx skills curator consolidate old-a old-b --into merged --content-file SKILL.md --json
calyx skills curator rollback --last --json
```

Agent question: *"which skills are stale / unused / archival candidates, and on what signal — and can I safely apply the archive?"*

The scheduled `skills-curator` agent + task that drive this are operator-installed
draft templates (see `docs/curator-agent-def-template.md`); this PR ships the
calyx-dev mechanics only.

---

## Memory Commands

`calyx memory` is the curated-facts store (POL-1729 Slice 4), the always-injected
sibling of skills on the shared learned-state store (`memory_content`, migration
`0018`). Because a poisoned memory has a **100% blast radius** (it would detonate
in every future prompt), the posture is **strict by construction, DIFFERENT from
skills**:

- A `calyx memory write` does **not** land active. It lands as
  `review_status = pending` and must be explicitly **approved** before it is
  considered active. Approval is the operator/review gate; an agent can write,
  but approval is a separate step.
- The security scan is **strict**: ANY sharp finding (shell-destructive,
  network-exfil, credential shape, invisible/bidi unicode is soft) **rejects** the
  write (exit 3, `rejected_sharp_content`, no row written). There is **no
  `--gate-policy` override** like `skills write` — memory's blast radius does not
  tolerate the long-tail.
- **Recall defaults to approved-only.** `get`, `list`, and `search` return
  **approved** facts by default — an agent recalling memory never sees
  unapproved (pending/rejected) facts unless it explicitly opts in. Pass
  `--status pending|rejected|all` to widen for triage; `get` also accepts
  `--include-unapproved`. `list --status pending` is the approval queue.
- **Approval is bound to the reviewed content hash (CAS).** `approve` **requires**
  `--expected-content-hash <hash>` — the hash the reviewer read from
  `calyx memory get <key> --status pending`. If the value was rewritten since the read, approve refuses
  with the review-conflict exit (3). This makes the read → approve flow safe on a
  100%-blast-radius surface (an unseen concurrent rewrite cannot be approved).
  `reject` accepts the same flag optionally.
- **Surfacing/injection is out of scope and deferred.** This store is **inert**
  re: injection — nothing here auto-injects memory into any prompt. The surfacing
  model (always-injected tiny core vs check-at-will `memory search` vs a tiered
  model) is the operator's open call; see `docs/calyx-memory-surfacing-seed.md`.

```bash
calyx memory write <key> (--value <text> | --content-file <path>) --category <user|project|reference|feedback> \
  [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] [--json]
calyx memory approve <key> --expected-content-hash <hash> [--author <id>] [--note <text>] [--json]
calyx memory reject  <key> [--expected-content-hash <hash>] [--author <id>] [--note <text>] [--json]
calyx memory get <key> [--status <approved|pending|rejected|all>] [--include-unapproved] [--json]
calyx memory list [--category <category>] [--status <approved|pending|rejected|all>] [--include-tombstoned] [--limit <n>] [--json]
calyx memory search <query> [--category <category>] [--status <approved|pending|rejected|all>] [--limit <n>] [--json]
calyx memory delete <key> [--summary <text>] [--author <id>] [--from-activity <id>] [--from-message <id>] [--json]
```

The `<key>` is normalized to a canonical id (lowercased, non-`[a-z0-9-]` collapsed
to `-`) at entry, so the row always targets the same canonical key regardless of
raw casing. The fact is a single string `value`; its `content_hash` is a
deterministic sha256 of the value. `category` is one of the vault memory types
(`user`, `project`, `reference`, `feedback`).

**Semantics:**
- `write` UPSERTs the fact and lands `pending`. A re-write of a fact (the content
  changed) resets an already-approved row back to `pending` — the prior approval
  is void and re-approval is required. A write over a tombstone recreates the
  fact (pending).
- `approve` / `reject` are the explicit review transitions; `approve` stamps
  `approved_at`. `approve` **requires** `--expected-content-hash` (the CAS guard):
  the reviewer reads the current `content_hash` via `calyx memory get <key> --status pending`, then
  approves that exact value. If the value changed under the reviewer between read
  and approve, the transition refuses (exit 3, review conflict) — re-review the
  current value. `reject` accepts the same flag optionally.
- `get` / `list` / `search` recall **approved facts only** by default. Pass
  `--status pending|rejected|all` (or, for `get`, `--include-unapproved`) to
  inspect unapproved rows for triage. `get` on a live-but-unapproved key exits 3
  (`memory_not_approved`, naming the actual status). `list --status pending` is
  the approval queue.
- `search` is a literal case-insensitive substring over key + value + summary,
  ranked by recency — **not** a semantic engine.
- `delete` records a tombstone (the row is retained, not hard-deleted).

**Exit codes:**
- `0` — Operation succeeded.
- `2` — Usage error (missing/conflicting value source, bad `--category`/`--status`/`--limit`, or `approve` without `--expected-content-hash`).
- `3` — Rejected on sharp content; migration `0018` not applied; review conflict (content-hash drift on approve/reject); or `get` on a live-but-unapproved key (`memory_not_approved`).
- `4` — Key not found (`get`, `approve`, `reject`).

**Examples:**
```bash
calyx memory write caleb-prefers-organic --value "Caleb prefers organic shapes over glassmorphism." --category user --author claude:carbon --json
# read the current content_hash of the pending row, then approve that exact value (CAS-safe):
calyx memory get caleb-prefers-organic --status pending --json
calyx memory approve caleb-prefers-organic --expected-content-hash <hash> --author caleb --json
calyx memory search glassmorphism --json          # approved facts only (default recall)
calyx memory list --status pending --json         # the approval queue
calyx memory delete stale-fact --summary "no longer true" --json
```

---

## Plugins Commands

Read-only local inventory and provenance tracing for harness plugins. This
surface does not install, remove, sync, promote, or mutate plugins.

### `calyx plugins list`

List local Codex and Claude plugin observations.

```bash
calyx plugins list [--harness <codex|claude|all>] [--home <path>] [--codex-home <path>] [--claude-home <path>] [--include-catalog] [--json]
```

**Options:**
- `--harness <codex|claude|all>` — Harness selector (default: `all`)
- `--home <path>` — Home directory to inspect (default: current user home)
- `--codex-home <path>` — Codex home override (default: `$CODEX_HOME` or `<home>/.codex`)
- `--claude-home <path>` — Claude home override (default: `<home>/.claude`)
- `--include-catalog` — Include catalog-only marketplace entries, not only cached/installed/enabled observations
- `--json` — Print machine-readable JSON summary

**Behavior:**
- Codex plugin cache is read from `~/.codex/plugins/cache/**/.codex-plugin/plugin.json`.
- Codex enabled state is read from `~/.codex/config.toml`.
- Codex marketplace catalogs are read from `.agents/plugins/marketplace.json`
  surfaces under `~/.agents/plugins`, `~/.codex/.tmp/plugins`, and bundled
  marketplace sync directories.
- Claude installed plugin cache is read from
  `~/.claude/plugins/cache/**/.claude-plugin/plugin.json`.
- Claude marketplace state is read from
  `~/.claude/plugins/known_marketplaces.json` and each marketplace clone.
- Catalog-only marketplace entries can still expose component provenance when
  the local marketplace clone contains plugin manifests, commands, agents,
  skills, hooks, LSP definitions, or MCP metadata.
- Plugin state is intentionally multi-valued: `cataloged`, `cached`,
  `enabled`, and `installed` are current observations; `active` is reserved
  for future host-aware/live-thread tracing.

**Exit codes:**
- `0` — Inventory completed
- `1` — Runtime error
- `2` — Usage error

**Examples:**

```bash
calyx plugins list
calyx plugins list --harness codex --json
calyx plugins list --harness claude --include-catalog
```

### `calyx plugins show`

Show a single plugin observation by plugin name or `plugin@marketplace`.

```bash
calyx plugins show <plugin-ref> [--harness <codex|claude|all>] [--home <path>] [--codex-home <path>] [--claude-home <path>] [--include-catalog] [--json]
```

**Options:**
- `--harness <codex|claude|all>` — Harness selector (default: `all`)
- `--home <path>` — Home directory to inspect
- `--codex-home <path>` — Codex home override
- `--claude-home <path>` — Claude home override
- `--include-catalog` — Include catalog-only marketplace entries
- `--json` — Print machine-readable JSON envelope

**Exit codes:**
- `0` — Exactly one matching plugin displayed
- `1` — Runtime error
- `2` — Usage error
- `3` — No match or ambiguous match

**Examples:**

```bash
calyx plugins show linear@openai-curated
calyx plugins show frontend-design --harness claude --json
```

### `calyx plugins trace`

Trace a plugin-provided component such as a skill, MCP server, app, hook, agent,
or command.

```bash
calyx plugins trace <component> [--kind <kind>] [--harness <codex|claude|all>] [--home <path>] [--codex-home <path>] [--claude-home <path>] [--include-catalog] [--json]
```

**Options:**
- `--kind <kind>` — Component kind filter: `skills`, `mcpServers`, `apps`, `hooks`, `agents`, `commands`, `lspServers`, `monitors`, `bin`, or `settings`
- `--harness <codex|claude|all>` — Harness selector (default: `all`)
- `--home <path>` — Home directory to inspect
- `--codex-home <path>` — Codex home override
- `--claude-home <path>` — Claude home override
- `--include-catalog` — Include catalog-only marketplace entries
- `--json` — Print machine-readable JSON envelope

**Exit codes:**
- `0` — One or more matching components found
- `1` — Runtime error
- `2` — Usage error
- `3` — No matching component

**Examples:**

```bash
calyx plugins trace linear --kind skills
calyx plugins trace hooks --kind hooks --harness claude --json
```

### `calyx plugins doctor`

Report suspicious plugin inventory states without mutating anything.

```bash
calyx plugins doctor [--harness <codex|claude|all>] [--home <path>] [--codex-home <path>] [--claude-home <path>] [--include-catalog] [--check] [--json]
```

**Options:**
- `--harness <codex|claude|all>` — Harness selector (default: `all`)
- `--home <path>` — Home directory to inspect
- `--codex-home <path>` — Codex home override
- `--claude-home <path>` — Claude home override
- `--include-catalog` — Accepted for symmetry; doctor always includes catalog-only entries
- `--check` — Exit non-zero when doctor reports an error-level issue
- `--json` — Print machine-readable JSON summary

**Behavior:**
- Reports parse/inventory diagnostics.
- Reports Codex plugins that are enabled in config but missing from cache as
  errors.
- Reports duplicate plugin-provided components as warnings.
- Reports catalog-only plugins as informational observations.

**Exit codes:**
- `0` — Doctor completed, or `--check` found no error-level issues
- `1` — Runtime error
- `2` — Usage error
- `3` — `--check` found error-level issues

**Examples:**

```bash
calyx plugins doctor
calyx plugins doctor --harness codex --check --json
```

---

## Tools Commands

Tools registry management: index, sync, and validate.

### `calyx tools index`

Index tools from a registry.

```bash
calyx tools index --registry <path> [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--json` — Print machine-readable JSON summary

### `calyx tools sync`

Sync tools from a registry into host targets.

```bash
calyx tools sync --registry <path> [--host <alias> | --all] [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--host <alias>` — Single host alias to target
- `--all` — Sync all known hosts
- `--apply` — Apply sync actions
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — `--host` and `--all` used together

### `calyx tools validate`

Validate tools registry structure and version metadata.

```bash
calyx tools validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed

### `calyx tools versions bump`

Bump the version of a named tool in the tools registry.

```bash
calyx tools versions bump --registry <path> --tool <name> --to <version> [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to tools registry JSON
- `--tool <name>` (required) — Tool name to bump
- `--to <version>` (required) — Target version string
- `--apply` — Write the bumped version (default: plan-only)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan-bump, bump, or not-found)
- `1` — Registry read/parse/validation error

**Example:**
```bash
calyx tools versions bump --registry tools.json --tool cass --to v0.2.0
calyx tools versions bump --registry tools.json --tool cass --to v0.2.0 --apply
```

---

## Prompts Commands

Prompts registry management: index, sync, and validate.

### `calyx prompts index`

Index prompts from a registry.

```bash
calyx prompts index --registry <path> [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--json` — Print machine-readable JSON summary

### `calyx prompts render`

Render a prompt template from the registry with explicit variables.

```bash
calyx prompts render --prompt <id> [--registry <path>] [--var <name=value>]... [--vars-file <path>] [--json]
```

**Options:**
- `--prompt <id>` (required) — Prompt id to render
- `--registry <path>` — Path to prompts registry JSON
- `--var <name=value>` — Prompt variable assignment (repeatable)
- `--vars-file <path>` — JSON object file containing prompt variables
- `--json` — Print a machine-readable render receipt instead of the rendered prompt body

**Behavior:**
- Default stdout is the rendered prompt body only, so the command is pipe-friendly.
- `--vars-file` values load first, and repeated `--var` flags override them.
- Undeclared variables and unresolved placeholders fail fast instead of being ignored.

**Exit codes:**
- `0` — Success
- `1` — Registry/template resolution or prompt render failure
- `2` — Invalid variable assignment or vars-file shape

### `calyx prompts sync`

Sync prompts from a registry into backend targets.

```bash
calyx prompts sync --registry <path> [--backend <backend>] [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--backend <backend>` — Sync backend: `claude`, `codex`, or `all` (default: `all`)
- `--apply` — Apply sync actions
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--backend` value

### `calyx prompts validate`

Validate prompts registry structure and variable contracts.

```bash
calyx prompts validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to prompts registry JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed

---

## Tasks Commands

Task manifest, native lifecycle, and automation bridge commands. Calyx task
YAML remains source governance for Calyx-managed tasks; native installs and
task-run history live in the local SQLite state store, with task-run JSONL
receipts exported under `$CALYX_STATE_HOME/receipts/task-runs.jsonl`. For
existing Codex Desktop automations, `automation.toml` is the app's definition
authority and its SQLite `automations` table is only an optional runtime
projection.

POL-1730 safety posture: installs default to `paused`; manual `tasks run` is
the only run-launch path; unattended schedule matches record launch-intent
task-runs only; app mutation stays off by default.

### `calyx tasks validate`

Validate YAML task manifests from a directory.

```bash
calyx tasks validate --tasks-dir <dir> [--strict] [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing `*.task.yaml` / `*.task.yml` task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--strict` — Escalate task warnings, such as missing schedule timezones, to errors.
- `--json` — Print machine-readable validation summary.

**Behavior:**
- Recursively loads `*.task.yaml` / `*.task.yml` task manifests under `--tasks-dir`; incidental YAML files are ignored.
- Validates schema shape, lifecycle status, runtime backend, trigger shape, and duplicate task ids.
- Validation is non-mutating; install/run/history state is created only by the POL-1730 lifecycle commands below.

**Exit codes:**
- `0` — Validation passed
- `2` — Missing `--tasks-dir` / `CALYX_TASKS_DIR`
- `3` — Validation failed

### `calyx tasks list`

List task manifests with lifecycle filtering.

```bash
calyx tasks list --tasks-dir <dir> [--include-paused] [--include-retired] [--status <status>]... [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--include-paused` — Include paused tasks in default listing.
- `--include-retired` — Include retired tasks in default listing.
- `--status <status>` — Filter to explicit status values; repeatable or comma-separated. Supported values are `draft`, `active`, `paused`, `retired`, and `failed_needs_attention`.
- `--json` — Print machine-readable list result.

**Behavior:**
- By default, paused and retired tasks are hidden while `draft`, `active`, and `failed_needs_attention` remain visible.
- Passing `--status` replaces the default lifecycle filter with an explicit status filter.

### `calyx tasks show`

Show one task manifest.

```bash
calyx tasks show <id> --tasks-dir <dir> [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--json` — Print the full task manifest and source path.

**Exit codes:**
- `0` — Task found
- `3` — Task not found or manifest validation failed

### `calyx tasks install`

Install one validated task manifest into local task lifecycle state.

```bash
calyx tasks install <id> --tasks-dir <dir> [--host <host>] [--status paused|active|retired|failed_needs_attention] [--mode advisory|mutating] [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--host <host>` — Host binding for the install. Defaults to the current host alias.
- `--status <status>` — Initial install status. Defaults to `paused`.
- `--mode <mode>` — Safety-mode metadata. Defaults to `advisory`.
- `--installed-by <actor>` — Actor recorded in task history.
- `--json` — Print machine-readable install, created/updated flag, and findings.

**Behavior:**
- Converts the selected trigger to `predicate/v1`. Supported phase-1 RRULE schedules become `time.cron`; literal `predicate/v1` trigger objects are preserved.
- Writes `task_installs` and `task_history` rows only. It does not mutate Codex app automation files.
- Persists `unattended_enabled=false` and `app_mutation_enabled=false`.
- A `codex_app` task must pass the same exact-representation preflight as
  `tasks render codex` before any lifecycle row is written. Lossy tasks exit 3;
  `--json` prints the `calyx.task-render-preflight/v1` receipt.

### `calyx tasks run`

Run one task manually through the normal Calyx run lifecycle.

```bash
calyx tasks run <id> --tasks-dir <dir> [--dry-run] [--foreground] [--host <host>] [--run-id <id>] [--runs-root <path>] [--worktree-path <path>] [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--dry-run` — Record a task-run launch intent without launching a Calyx run.
- `--foreground` — Run the launched Calyx run in the foreground.
- `--host <host>` — Target host label for the Calyx run. Defaults to `local`.
- `--run-id <id>` — Optional run id for the launched Calyx run.
- `--runs-root <path>` — Run store root.
- `--worktree-path <path>` — Override `runtime.workspace.cwd` for this manual run.
- `--json` — Print machine-readable task-run and run result.

**Behavior:**
- Creates a `task_runs` row for every invocation.
- Without `--dry-run`, launches a normal `agent_runner` Calyx run and stores the returned `run_id` on the task-run row.
- Adds advisory-first task safety framing to the run prompt.
- Supports `codex_app`, `claude_desktop`, and `claude_routine` task runtimes in this slice.

### `calyx tasks pause`

Pause an installed task.

```bash
calyx tasks pause <task-id-or-install-id> [--host <host>] [--actor <actor>] [--json]
```

### `calyx tasks resume`

Resume an installed task without enabling unattended launch.

```bash
calyx tasks resume <task-id-or-install-id> [--host <host>] [--actor <actor>] [--json]
```

**Behavior:**
- `pause` sets install status to `paused`; the evaluator skips paused installs.
- `resume` sets install status to `active`; predicate matches record launch-intent task-runs while unattended launch remains disabled.
- Resuming a historical `codex_app` install reruns exact-representation
  preflight against its persisted task. A loss exits 3 and leaves the install
  paused; `--json` prints the loss receipt.

### `calyx tasks reconcile`

Compare installed tasks against current manifests.

```bash
calyx tasks reconcile [task-id-or-install-id] --tasks-dir <dir> [--host <host>] [--limit <n>] [--apply] [--json]
```

**Behavior:**
- Read-only by default.
- Reports missing manifests, manifest hash drift, runtime drift, explicit safety
  posture findings, and historical `codex_app` render losses as errors with the
  typed preflight receipt.
- `--apply` refreshes local install metadata from the current manifest only
  when that install has no blocking error. It does not mutate app-backed
  installs or enable unattended launch.

### `calyx tasks history`

Show task install and task-run history.

```bash
calyx tasks history [task-id-or-install-id] [--limit <n>] [--json]
```

### `calyx tasks doctor`

Inspect task lifecycle schema, install counts, and task-run counts.

```bash
calyx tasks doctor [--codex-home <dir>] [--codex-db <path>] [--tasks-dir <dir>] [--governance <path>] [--calyx-state-db <path>] [--json]
```

**Behavior:**
- Projects `calyx state doctor --domain tasks`.
- Lists recent installs when the task lifecycle schema is available.
- Scans persisted `codex_app` tasks for historical render loss. Each lossy
  install is an error finding with its `calyx.task-render-preflight/v1`
  receipt, and doctor exits 3.
- The scan is bounded to 500 recent installs in this version. If more installs
  exist, the incomplete-coverage finding is itself an error and doctor exits 3
  instead of reporting unverified state as healthy.
- Codex Desktop observation is opt-in on doctor. Passing any Codex observation
  option adds the same read-only receipt as `tasks observe codex`; an observed
  error makes doctor exit 3. Without those options, doctor preserves its native
  Calyx lifecycle-only scope.

### `calyx tasks observe codex`

Join Codex Desktop definition authority, source governance, optional Calyx
install identity, and the optional Codex SQLite runtime projection without
changing any of them.

```bash
calyx tasks observe codex [--codex-home <dir>] [--codex-db <path>] [--tasks-dir <dir>] [--governance <path>] [--calyx-state-db <path>] [--json]
```

**Options:**

- `--codex-home <dir>` — Codex home containing
  `automations/<id>/automation.toml`; defaults to `CODEX_HOME` or `~/.codex`.
- `--codex-db <path>` — Codex SQLite runtime projection database; defaults to
  `<codex-home>/sqlite/codex-dev.db` and is opened read-only.
- `--tasks-dir <dir>` — Optional governing Calyx task manifest directory.
- `--governance <path>` — Optional Codex automation exemption registry. When
  `--tasks-dir` is present, defaults to
  `codex-desktop-automation-exemptions.yaml` in that directory.
- `--calyx-state-db <path>` — Optional Calyx task lifecycle database used only
  to attach an existing install id; defaults to the normal Calyx state path and
  is opened read-only.
- `--json` — Print `calyx.tasks-codex-observation/v1`.

**Behavior:**

- Emits `definition_authority=codex_toml`,
  `projection=observed|missing|drifted|unavailable`, and
  `mutation_authority=unavailable` for the CLI surface.
- Uses stable definition ids and exact cwd arrays. Equal display names with
  different cwd coverage remain distinct project bindings; only equal name,
  prompt, status, schedule, and cwd coverage is a duplicate candidate.
- Reads each TOML definition twice around file metadata checks. A changing
  digest fails closed with no stable classification.
- Flags malformed or unreadable definitions, new ungoverned active
  definitions, exemption drift/expiry, lossy POL-1960 manifest renders,
  definition/projection disagreements, file-present/projection-missing rows,
  and finite `COUNT` schedules with neither next nor last runtime state.
- A finite schedule with absent runtime state is indeterminate, not safely
  expired or deletable.
- Performs no `automation_update`, TOML write, SQLite write, private Electron
  import, activation, pause, deletion, consolidation, render, or apply action.

**Exit codes:**

- `0` — All observed definitions have current governance and no blocking drift.
- `3` — At least one definition is invalid, ungoverned active, lossy,
  finite-indeterminate, or definition/projection drifted.

### `calyx tasks import codex`

Import Codex app `automation.toml` files into Calyx task manifest drafts.

```bash
calyx tasks import codex --codex-home <dir> --out-dir <dir> [--id <id>] [--json]
```

**Options:**
- `--codex-home <dir>` (required) — Codex home containing `automations/<id>/automation.toml`.
- `--out-dir <dir>` (required) — Directory where imported `*.task.yaml` manifests are written.
- `--id <id>` — Import one automation id. When omitted, all automation directories under `--codex-home` are imported.
- `--json` — Print machine-readable import receipt.

**Mapping:**
- Codex `ACTIVE` / `PAUSED` becomes task `active` / `paused`.
- Codex `rrule`, prompt, model, reasoning effort, execution environment, and cwd list are preserved.
- Imported manifests include a local `codex_app` install target and an `imported_from` provenance block.
- Codex app automations do not expose an explicit timezone in the observed TOML shape; imports leave `trigger.timezone` unset and emit a warning rather than inventing a durable timezone.
- Host-local Codex `memory.md` is not copied into `state.memory`; the import emits a warning so the operator can choose a portable vault or relative state path.

### `calyx tasks render codex`

Render one Calyx task into a Codex app automation directory.

```bash
calyx tasks render codex <id> --tasks-dir <dir> --out-dir <dir> [--host <host>] [--json]
```

**Options:**
- `--tasks-dir <dir>` — Directory containing task manifests. May be omitted when `CALYX_TASKS_DIR` is set.
- `--out-dir <dir>` (required) — Output root for rendered `<id>/automation.toml`.
- `--host <host>` — Select one `codex_app` install target by host when a task has multiple Codex targets.
- `--json` — Print machine-readable render receipt including the TOML text and output path.

**Behavior:**
- Requires exactly one schedule trigger and renders Codex `kind = "cron"`.
- Requires `runtime.workspace.cwd` or `runtime.workspace.cwds`.
- Runs a complete representability preflight before creating the automation
  directory. A safe task renders only when every declared runtime semantic is
  preserved exactly.
- Refuses explicit trigger timezone, misfire policy, predicate, or additional
  triggers; unrepresentable root fields such as `owner`, `description`, or an
  extension key; `prompt.skills`; every declared `state` and `safety` field;
  workspace mode or conflicting `cwd`/`cwds`; non-Codex runtime semantics;
  extra fields such as `metadata` or `note` on the selected target; and a
  selected status other than `active` or `paused`.
- Renders `active` as Codex `ACTIVE` and `paused` as Codex `PAUSED`; it never
  downgrades another status.
- Preserves imported Codex `created_at` when available and refreshes `updated_at` on render.
- Writes only under the explicit `--out-dir`; it does not mutate `~/.codex/automations`.
- On refusal, no output file or parent automation directory is created.
  `--json` prints the `calyx.task-render-preflight/v1` receipt, including one
  stable loss entry per exact manifest field path.
- `state` pointers are intentionally blocking, even though they are Calyx-side
  control metadata: rendering without them would sever declared control or
  output continuity. Repair a historical loss by installing a corrected,
  exactly representable manifest; `tasks reconcile --apply` will not activate
  or rewrite a lossy persisted task.

**Exit codes:**
- `0` — Render succeeded
- `2` — Missing required arguments
- `3` — Task or install target cannot be represented exactly; with `--json`,
  stdout is the typed loss receipt

---

## Agents Commands

Manage launch-time agent definitions from `instructions/agents/AGENTS.json`.
The old POL-534 projection verbs (`index`, `render-profiles`, `deploy`, and
`sync`) are tombstoned in this CLI; use `list`, `show`, and `validate` here.
Harness projection content is owned by the follow-on registry-content work.

### `calyx agents list`

List agent definitions from `AGENTS.json`, filtering by lifecycle status.

```bash
calyx agents list --registry <path> [--include-blocked] [--include-archived] [--include-retired] [--exclude-deprecated] [--json]
```

**Options:**
- `--registry <path>` — Path to `instructions/agents/AGENTS.json`; otherwise resolved from `CALYX_AGENTS_REGISTRY`, config, or the agents-infra adapter path
- `--include-blocked` — Include blocked, non-launchable definitions and their lifecycle metadata (default: excluded)
- `--include-archived` — Include archived definitions in output (default: excluded)
- `--include-retired` — Include retired definitions in output (default: excluded)
- `--exclude-deprecated` — Exclude deprecated definitions from output
- `--json` — Print machine-readable JSON summary

**Example:**
```bash
calyx agents list --registry fixtures/domains/agents/AGENTS.json
calyx agents list --json
```

### `calyx agents show`

Show one agent definition and its typed launch contract.

```bash
calyx agents show <agent-id> --registry <path> [--json]
```

**Options:**
- `--registry <path>` — Path to `instructions/agents/AGENTS.json`
- `--json` — Print the parsed definition, registry path, definition path, effective status, and lifecycle metadata

A blocked definition remains inspectable here, including its required
`blocked_reason` and optional `blocked_by` issue ids, but `run launch --agent`
refuses it before creating a run intent or spawning a backend.

### `calyx agents validate`

Validate the registry index, referenced `agent.yaml` files, prompt templates,
materialized curriculum references, lifecycle agreement, and blocked-state
reasons. The accepted blocked shape is `status: blocked` in `agent.yaml` plus a
matching registry `lifecycle.status: blocked` and non-empty
`lifecycle.blocked_reason`; `lifecycle.blocked_by` may name prerequisite issue
ids.

```bash
calyx agents validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` — Path to `instructions/agents/AGENTS.json`
- `--strict` — Enable stricter lifecycle checks
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `3` — Validation failed (errors found)

### Retired POL-534 Verbs

```bash
calyx agents index
calyx agents render-profiles
calyx agents deploy
calyx agents sync
```

These commands intentionally fail with a POL-1799 tombstone and a reroute to
`calyx agents list|show|validate`.

---

## Knowledge Commands

Manage the knowledge artifact registry: index, search, link, and validate.

### `calyx knowledge index`

Index knowledge artifacts from a registry, optionally filtering by kind.

```bash
calyx knowledge index --registry <path> [--kind <kind>] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--kind <kind>` — Filter by artifact kind: `execplan`, `transcript`, `report`, `runbook`, `reference`
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Registry read/parse/validation error
- `2` — Invalid `--kind` value

### `calyx knowledge search`

Search knowledge artifacts by query string with metadata/frontmatter-aware matching.

```bash
calyx knowledge search --registry <path> --query <query> [--kind <kind>] [--tags <tags>] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--query <query>` (required) — Search query string (case-insensitive)
  - Plain tokens match across id, title, kind, source path, tags, linked issues, metadata values, and frontmatter values
  - Field selectors use `field:value` syntax (AND semantics across tokens)
  - Supported selector aliases:
    - Core fields: `id:`, `title:`, `kind:`, `path:`/`source_path:`, `linked_issues:`, `tags:`
    - Metadata: `meta.<key>:` / `metadata.<key>:`
    - Frontmatter: `fm.<key>:` / `frontmatter.<key>:` plus top-level keys like `doc_type:`, `scope:`, `owner:`
- `--kind <kind>` — Filter by artifact kind
- `--tags <tags>` — Comma-separated tag filter (all tags must match, case-insensitive)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (including zero matches)
- `1` — Registry read/parse/validation error
- `2` — Invalid `--kind` value

**Examples:**
```bash
calyx knowledge search --registry knowledge.json --query "doc_type:runbook scope:operations"
calyx knowledge search --registry knowledge.json --query "meta.docstore_id:ep-2026-0225"
calyx knowledge search --registry knowledge.json --query "owner:polli-labs" --tags "async,operations"
```

### `calyx knowledge link`

Link a knowledge artifact to a Linear issue using the plan/apply contract.

```bash
calyx knowledge link --registry <path> --artifact <id> --issue <id> [--apply] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--artifact <id>` (required) — Artifact ID to link
- `--issue <id>` (required) — Linear issue ID to link to
- `--apply` — Apply the link action
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan-link, link, or already-linked)
- `1` — Artifact not found or registry error

### `calyx knowledge execplan new`

Create a canonical ExecPlan scaffold with frontmatter, a nested `execplan:`
metadata block, and standard sections for execution.

```bash
calyx knowledge execplan new \
  --title <title> \
  [--issue-id <id>] \
  [--kind <implementation|planning|research>] \
  [--state <draft|ready|in_progress|done|blocked|superseded>] \
  [--target-repo <repo>] \
  [--target-branch <branch>] \
  [--target-workdir <path>] \
  [--target-host <host> ...] \
  [--runner-harness <codex-cli|claude-code|human>] \
  [--runner-mode <interactive|exec>] \
  [--out-path <path>] \
  [--apply] \
  [--json]
```

**Options:**
- `--title <title>` (required) — ExecPlan title
- `--issue-id <id>` — Linked Linear issue ID
- `--kind <kind>` — ExecPlan kind: `implementation`, `planning`, `research`
- `--state <state>` — ExecPlan lifecycle state
- `--owner <owner>` — Frontmatter owner (default: `polli-labs`)
- `--scope <scope>` — Frontmatter scope (default: `repo`)
- `--target-repo <repo>` — Target repository name
- `--target-branch <branch>` — Target repository branch
- `--target-workdir <path>` — Target workdir path
- `--target-host <host>` — Target host (repeatable)
- `--runner-harness <harness>` — Runner harness: `codex-cli`, `claude-code`, `human`
- `--runner-mode <mode>` — Runner mode: `interactive`, `exec`
- `--out-path <path>` — Output file path; when omitted with `--apply`, defaults to `./<execplan-id>.md`
- `--apply` — Write the ExecPlan file (default: plan-only)
- `--json` — Print machine-readable JSON summary

When `--apply` is used, Calyx fails fast if the destination file already
exists; it does not overwrite an existing ExecPlan scaffold silently.

**Exit codes:**
- `0` — Success (plan-create or create)
- `1` — Filesystem error
- `2` — Invalid option value

**Example:**
```bash
calyx knowledge execplan new --title "Port wrapper surfaces"
calyx knowledge execplan new --title "Port wrapper surfaces" --issue-id POL-679 --apply
```

### `calyx knowledge execplan promote`

Promote a scaffold or compatible draft into the fieldwork continuity plane while
preserving canonical ExecPlan metadata.

Compatible drafts must already carry canonical ExecPlan metadata, including a
top-level `execplan:` block with `id`, `kind`, and `state`.

```bash
calyx knowledge execplan promote <file> \
  [--title <title>] \
  [--issue-id <id>] \
  [--project <slug>] \
  [--workstream <slug>] \
  [--author <author>] \
  [--assignee <who>] \
  [--updated <ts>] \
  [--updated-by <who>] \
  [--status <status>] \
  [--vault-path <path>] \
  [--dry-run] \
  [--json]
```

**Options:**
- `<file>` — Input scaffold or compatible draft markdown file
- `--title <title>` — Override title coherently across the promoted note frontmatter and first `#` heading
- `--issue-id <id>` — Override the linked issue coherently in both top-level note metadata and `execplan.linear.issues`
- `--project <slug>` — Optional fieldwork project slug
- `--workstream <slug>` — Optional fieldwork workstream slug
- `--author <author>` — Override fieldwork author
- `--assignee <who>` — Optional assignee frontmatter
- `--updated <ts>` — Optional updated timestamp
- `--updated-by <who>` — Optional updated_by frontmatter
- `--status <status>` — Status field (default: `active`)
- `--vault-path <path>` — Override vault root
- `--dry-run` — Print the promoted artifact without writing
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan-promote or promote)
- `1` — Filesystem or write error
- `2` — Invalid source metadata or option value

**Example:**
```bash
calyx knowledge execplan promote ./execplan-pol-894.md --dry-run
calyx knowledge execplan promote ./execplan-pol-894.md --project calyx --workstream run-substrate-and-agents-infra
```

### `calyx knowledge docstore`

Delegate search, get, or list operations to the docstore CLI adapter.

```bash
calyx knowledge docstore <verb> [--query <query>] [--id <id>] [--json]
```

**Verbs:** `search`, `get`, `list`

**Options:**
- `--query <query>` — Search query (for `search` verb)
- `--id <id>` — Artifact ID (for `get` verb)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Docstore delegation error
- `2` — Invalid verb

**Example:**
```bash
calyx knowledge docstore search --query "POL-679"
calyx knowledge docstore get --id ep-2026-0301-wrapper-port
calyx knowledge docstore list
```

### `calyx knowledge validate`

Validate knowledge registry structure and artifact contracts.

```bash
calyx knowledge validate --registry <path> [--strict] [--json]
```

**Options:**
- `--registry <path>` (required) — Path to knowledge registry JSON
- `--strict` — Escalate warnings (e.g., duplicate tags) to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Registry read/parse error
- `3` — Validation failed (errors found)

---

## Oracle Commands

Consultation inquiry scaffolding, bundle planning, materialization, Gemini execution, response capture, and synthesis scaffolding for external model review.

`calyx oracle` is intentionally narrower than `calyx context`: it owns the human/agent-facing oracle workflow, while lower-level context tools remain available for generic packing and provider capability work. The v1 surface creates inquiry packets, emits deterministic plans, materializes safe attachment outputs, runs approved automated Gemini consultations, and writes reviewable receipts. OpenAI/GPT Pro-class API oracle runs are blocked by policy; use human ChatGPT web only when a user explicitly asks for that path.

### `calyx oracle init`

Create a durable oracle inquiry scaffold containing `inquiry.yaml`, `README.md`, `oracle-prompt.md`, and `oracle-response-skeleton.md`.

```bash
calyx oracle init <inquiry-slug> [--issue <id>] [--project <slug>] [--daily] [--out-dir <dir>] [--vault-path <path>] [--variants <ids>] [--author <who>] [--force] [--json]
```

**Options:**
- `<inquiry-slug>` — Inquiry identifier; normalized to a stable slug
- `--issue <id>` — Linked Linear issue, also seeded into `linear.issues`
- `--project <slug>` — Fieldwork project slug
- `--daily` — Create under `<vault>/10-daily/<date>/<slug>`
- `--out-dir <dir>` — Explicit output directory; overrides `--daily`
- `--vault-path <path>` — Vault root for `--daily` (default: `VAULT_PATH`, then `~/vault/fieldwork`)
- `--variants <ids>` — Comma-separated oracle variants (default: `sandbox`)
- `--author <who>` — Recipe `created_by`
- `--force` — Overwrite existing scaffold files
- `--json` — Print machine-readable scaffold result

**Exit codes:**
- `0` — Scaffold written
- `2` — Invalid option, recipe shape, or overwrite refusal
- `10` — Internal error

**Examples:**

```bash
calyx oracle init pol-1087-oracle-bundle-rfc --issue POL-1087 --project calyx --daily
calyx oracle init pol-1179-smoke --out-dir /tmp/pol-1179-smoke --variants sandbox,tools --json
```

### `calyx oracle bundle`

Read an inquiry recipe, emit a deterministic bundle plan, or materialize context/code/receipt outputs.

```bash
calyx oracle bundle <inquiry-dir> [--recipe <file>] [--plan] [--apply] [--vault-path <path>] [--ctx-command <command>] [--calyx-command <command>] [--json]
```

**Options:**
- `<inquiry-dir>` — Directory containing the oracle inquiry scaffold
- `--recipe <file>` — Recipe path relative to the inquiry directory, or absolute path (default: `inquiry.yaml`)
- `--plan` — Emit the plan without materializing files; default unless `--apply` is passed
- `--apply` — Materialize `context/`, `code/`, and `receipts/` outputs
- `--vault-path <path>` — Override fieldwork vault root for vault source materialization
- `--ctx-command <command>` — ctxkit command for `repos[].mode: ctxpack` and selected `sessions[]` excerpts (default: `ctx`)
- `--calyx-command <command>` — calyx command used to materialize `activity.queries[]` via `calyx run ps --json` (default: `calyx`)
- `--json` — Print machine-readable plan or error

**Exit codes:**
- `0` — Plan emitted or bundle materialized
- `2` — Invalid recipe or option
- `10` — Internal error

`--apply` currently supports explicit vault files/globs, static Linear context via `linear.context_path`, git archive repo attachments, optional ctxkit repo packing when `ctx` is available, `activity.queries[]` summaries from `calyx run ps --json`, and selected `sessions[]` excerpts delegated to ctxkit session capture. Activity `include` values control which available metadata classes are rendered; transcript bodies still come from explicit `sessions[]` selections.

Activity query recipe shape:

```yaml
activity:
  queries:
    - id: recent-calyx-work
      host: carbon
      since_hours: 72
      include_interactive: true
      agent_kind: all
      limit: 100
      include: [summary, receipts, worktrees, prompts, transcripts]
```

Selected session excerpts use ctxkit rather than Calyx-internal transcript parsing:

```yaml
sessions:
  - id: 019da27a-1000-77d0-88be-9996061b9d2c
    provider: codex
    mode: summary
    root: /Users/carbon/dev/calyx/dev
    scope: all
    bytes: 8192
```

**Examples:**

```bash
calyx oracle bundle ~/vault/fieldwork/10-daily/2026-04-28/pol-1087-oracle-bundle-rfc --plan --json
calyx oracle bundle ~/vault/fieldwork/10-daily/2026-04-28/pol-1087-oracle-bundle-rfc --apply --json
```

### `calyx oracle run`

Run a materialized inquiry through the approved automated provider. The command reads `inquiry.yaml`, `receipts/bundle.manifest.json`, the authored prompt, and the manifest-listed context/code outputs. Always use `--dry-run` before an actual provider call.

```bash
calyx oracle run <inquiry-dir> [--recipe <file>] [--manifest <file>] [--provider gemini] [--model <model>] [--variant <id>] [--write-response <file>] [--dry-run] [--json]
```

**Options:**
- `<inquiry-dir>` — Directory containing the materialized oracle inquiry
- `--recipe <file>` — Recipe path relative to the inquiry directory, or absolute path (default: `inquiry.yaml`)
- `--manifest <file>` — Bundle manifest path relative to the inquiry directory, or absolute path (default: `receipts/bundle.manifest.json`)
- `--provider <provider>` — Automated provider; only `gemini` is supported
- `--model <model>` — Gemini model name (default: `gemini-3.1-pro`)
- `--variant <id>` — Response variant id used in output names (default: `sandbox`)
- `--write-response <file>` — Response markdown path relative to the inquiry directory
- `--dry-run` — Emit a non-mutating run plan with prompt/attachment hashes, estimated tokens, output paths, and warnings
- `--json` — Print machine-readable plan or result

**Exit codes:**
- `0` — Dry-run plan emitted or response/receipt written
- `2` — Invalid option, unsupported provider/model, missing Gemini key, or provider execution error
- `3` — Run plan is not ready because required manifest attachments are missing/unreadable
- `10` — Internal error

`calyx oracle run` writes `oracle-response-<provider>-<variant>.md` by default and a machine-readable receipt at `receipts/oracle-run-<provider>-<variant>.json`. Response frontmatter records provider, model, variant, prompt hash, manifest hash, run plan hash, and receipt path.

Examples:

```bash
calyx oracle run ~/vault/fieldwork/10-daily/2026-05-01/pol-1232-oracle --dry-run --json
with-polli-secrets calyx oracle run ~/vault/fieldwork/10-daily/2026-05-01/pol-1232-oracle --provider gemini --variant sandbox
```

### `calyx oracle synthesize`

Create a durable synthesis scaffold after one or more oracle responses exist.

```bash
calyx oracle synthesize <inquiry-dir> [--write <file>] [--dry-run] [--force] [--json]
```

**Options:**
- `<inquiry-dir>` — Directory containing `oracle-response*.md` files
- `--write <file>` — Synthesis markdown path relative to the inquiry directory (default: `oracle-synthesis.md`)
- `--dry-run` — Discover response files without writing a scaffold
- `--force` — Overwrite an existing synthesis scaffold
- `--json` — Print machine-readable synthesis result

The command writes sections for source responses, strong convergence, disagreements requiring human judgment, plan updates, and Linear/PR receipts. It does not silently treat the oracle response as authoritative; the primary agent still owns synthesis and verification.

### `calyx oracle doctor`

Validate scaffold readiness before an oracle consultation.

```bash
calyx oracle doctor <inquiry-dir> [--recipe <file>] [--json]
```

**Options:**
- `<inquiry-dir>` — Directory containing the oracle inquiry scaffold
- `--recipe <file>` — Recipe path relative to the inquiry directory, or absolute path (default: `inquiry.yaml`)
- `--json` — Print machine-readable findings

**Exit codes:**
- `0` — No blocking scaffold errors
- `3` — One or more blocking findings
- `10` — Internal error

Warnings such as `no_context_sources` are non-blocking because an inquiry can be scaffolded before its context list is complete. `manifest_missing` means the inquiry has not yet been materialized with `calyx oracle bundle --apply`.

---

## Context Commands

Ctxpack `v1` context primitives plus fixture-corpus validation.

`calyx context` currently ships implemented primitives for `capabilities`, `plan`, `pack`, `docs`, and `fixtures run`. `introspect` is implemented behind an explicit experimental gate (`--enable-experimental`) and returns `capability_unavailable` when disabled. `context capture` is a separate operator affordance for turning selected Calyx activity into a durable vault note.

### `calyx context capture plan|apply`

Preview or write selected activity turns into a fieldwork vault note. This is
for session handoff and evidence capture; it does not construct an oracle
consultation bundle.

```bash
calyx context capture plan --from-activity <id|self|latest:backend> (--daily | --type <type>) --title <title> [options]
calyx context capture apply --from-activity <id|self|latest:backend> (--daily | --type <type>) --title <title> [options]
```

Options:
- `--from-activity <id|self|latest:backend>` (required) — Activity selector. Use `self` for the current harness session when `calyx activity self` can resolve it, or `latest:codex` / `latest:claude` to capture the newest indexed interactive session for that backend.
- `--turn <role:first|last:n>` — Repeatable turn selector, e.g. `human:last:1` or `assistant:last:2`. Defaults to `human:last:1` plus `assistant:last:1`.
- `--around-id <message-id>` / `--around-text <text>` with `--context <n>` — Also include selected message context around a known message id or matching text. These selectors reuse `calyx activity messages` and dedupe messages already included by selected turns.
- `--max-text-chars <n>` — Maximum message text characters per selected turn/context message (default `4000`; larger values raise the cap).
- `--daily` / `--type <type>` — Mutually exclusive vault destination policy.
- `--title <title>` (required) — Vault note title.
- `--issue <POL-XXX>`, `--project <slug>`, `--workstream <slug>`, `--author <author>`, `--status <status>` — Vault frontmatter controls.
- `--notes <text>` / `--notes-file <path>` — Additional framing to include above selected turns.
- `--vault-path <path>` — Override the fieldwork vault root.
- `--host <host>`, `--server-url <url>`, `--auth-token <token>`, `--runs-root <path>` — Activity lookup controls.
- `--json` — Print the `context.capture/v1` result.

`plan` performs the same selection and vault-path computation without writing,
and returns `estimated_bytes` plus an `apply_command` so agents can review and
then execute the same capture shape without rebuilding the selector.
`apply` writes the note and a sidecar `*.receipt.json` with schema
`context.capture.receipt/v1`. Both the note summary and JSON result/receipt
record the requested/effective text cap and any selected message ids whose text
was truncated.

Examples:

```bash
calyx context capture plan --from-activity self --daily --title "Session Handoff" --json
calyx context capture plan --from-activity latest:codex --daily --title "Recent Codex Handoff" --around-text "next step" --context 2 --json
calyx context capture apply --from-activity run:3b519ec4-d18f-4ff2-8057-75f7508d935d --daily --issue POL-1513 --title "Runner Handoff" --turn human:last:1 --turn assistant:last:2 --notes-file handoff.md --json
```

### `calyx context capabilities`

Show frozen `v1` primitive capabilities and exit-code map.

```bash
calyx context capabilities [--include-undetected] [--providers <ids>] [--json]
```

Notes:
- Default output includes detected first-party providers in deterministic provider order.
- `--include-undetected` expands output to include undetected providers with explicit reason codes.
- `--providers <ids>` filters provider rows (comma-separated).
- Provider rows include `tier` plus `primitive_status` maps; every non-ready primitive includes a `reason_code` and evidence pointers that resolve into that provider's `evidence` array.

### `calyx context plan`

Build a deterministic planning manifest (include/exclude policy, budget preflight, sessions policy, and git metadata probes).

```bash
calyx context plan [--roots <paths>] [--include <paths>] [--exclude <paths>] [--goal <text>] [--seed <seed>] [--profile <default|chatgpt-web>] [--vault-path <path>] [--include-sessions] [--include-git-meta] [--budget-bytes <n>] [--budget-tokens <n>] [--json]
```

Notes:
- Deterministic ordering is guaranteed for roots, selected files, omitted files, and truncation candidates.
- Session planning is opt-in (`--include-sessions`); default behavior records explicit opted-out policy.
- Git metadata planning is enabled by default and degrades gracefully to `git_repo_not_detected` when roots are outside a git repo.
- Budget preflight emits explicit truncation candidates with reason codes (`budget_bytes_exceeded`, `budget_tokens_exceeded`, `budget_bytes_and_tokens_exceeded`).
- `--profile chatgpt-web` enables the vault-seeded source graph planner. Repeat `--seed` for each `vault://fieldwork/...` URI, vault query, explicit file path, activity id, or capture ref. The POL-1518 slice materializes vault URI, vault query, and explicit file seeds; activity/capture seeds are recognized and returned as bounded unsupported-source warnings.
- ChatGPT-web plans include `data.plan_hash`, `data.apply_command`, `data.source_graph`, selected/omitted vault candidates, per-source hashes/checkpoints, and an explicit trust posture that vault text is source evidence, not instructions.
- Query seeds use literal vault search in this slice. Semantic and hybrid vault search remain future provider capabilities.

### `calyx context pack`

Materialize deterministic bundle manifests from normalized planning inputs with redaction and truncation receipts.

```bash
calyx context pack [--goal <text>] [--seed <seed>] [--profile <default|chatgpt-web>] [--vault-path <path>] [--include <paths>] [--exclude <paths>] [--budget-bytes <n>] [--budget-tokens <n>] [--plan-hash <hash>] [--out-dir <path>] [--apply] [--redaction-mode <strict|advisory>] [--json]
```

Notes:
- `--apply` writes `bundle.manifest.json`, `bundle.summary.json`, and packed files into `--out-dir` (default: `.calyx/ctxpack/<plan_hash>`).
- `--redaction-mode` controls line-level secret masking policy (`strict` default, `advisory` supported).
- Response payload includes manifest hashes, redaction event receipts, and truncation reason counters.
- For `chatgpt-web` packs, `--apply` requires the plan hash returned by `calyx context plan`. Repeat the same goal, seed, profile, vault path, and budget inputs; pack recomputes the source graph and rejects stale or mismatched hashes before writing files.
- ChatGPT-web apply writes bounded source files, `bundle.manifest.json`, `bundle.summary.json`, and `bundle.docs.md`. Manifest entries include `source_type`, `vault_uri` when applicable, packed/source hashes, byte counts, and trust posture.

### `calyx context docs`

Render deterministic docs sections from bundle receipt artifacts (`bundle.manifest.json` + `bundle.summary.json`).

```bash
calyx context docs --bundle-path <path> [--format <markdown|json>] [--topic <bundle|profile|sources|files|redaction|truncation>] [--json]
```

Notes:
- Reads only bundle receipts from `--bundle-path` (directory or manifest/summary file path).
- Markdown rendering is deterministic for fixed bundle inputs.
- `--topic` filters to a single deterministic section.

### `calyx context introspect`

Render experimental introspection metrics from bundle receipts.

```bash
calyx context introspect --bundle-path <path> [--enable-experimental] [--target <roots|extensions>] [--json]
```

Notes:
- Requires `--enable-experimental`; otherwise returns `capability_unavailable`.
- `--target` optionally filters metrics output to roots or extensions.

### `calyx context fixtures run`

Execute a deterministic fixture corpus and emit a JSON receipt artifact.

```bash
calyx context fixtures run --catalog <path> --receipt <path> [--fail-fast] [--json]
```

Notes:
- `--catalog` defaults to `fixtures/context/v1/corpus.catalog.json`.
- Receipt rows include: fixture id, primitive, expected/actual outcome, error/exit codes, stable digest, replay match, and duration.
- Receipt summary includes: total fixtures, passed, failed, and deterministic replay failures.
- Command exits non-zero when any fixture fails.

Tier-1 provider promotion requires the real-session adapter parity gate in addition to the deterministic corpus:

```bash
pnpm test -- packages/core/src/__tests__/context-session-adapters-real.test.ts
```

Real-format fixtures and expected parity outcomes live in `fixtures/context/v1/session-adapters/`.

**Shared options:**
- `--json` — Print machine-readable JSON envelope

**Exit codes (ctxpack v1):**
- `0` — Success
- `2` — `validation_error`
- `3` — `not_found`
- `4` — `capability_unavailable`
- `5` — `adapter_error`
- `10` — `internal_error`

**Example:**
```bash
calyx context capabilities --json
calyx context plan --roots src,. --include src,docs --exclude tmp --budget-bytes 90000 --json
calyx context docs --bundle-path .calyx/ctxpack/<plan_hash> --format markdown --json
calyx context introspect --bundle-path .calyx/ctxpack/<plan_hash> --enable-experimental --json
calyx context fixtures run --catalog fixtures/context/v1/corpus.catalog.json --receipt outputs/context-fixtures.receipt.json --json
```

---

## MCP Commands

Generated and validated MCP packaging over Calyx interface contracts. This
surface is intentionally a connector wrapper, not a second source of truth:
`vault-context` descriptors are backed by `calyx vault`, `calyx context`, and
`calyx agent-context` contracts, while `activity-attachments` descriptors are
backed by `calyx activity attachments` and the POL-1771 attachment
record/byte/cache contract. The manifest validator fails if referenced Calyx
command paths drift.

### `calyx mcp manifest`

Emit the generated/validated MCP manifest for a named Calyx connector surface.

```bash
calyx mcp manifest --surface vault-context --json
calyx mcp manifest --surface activity-attachments --json
```

Notes:
- Supported surfaces are `vault-context` and `activity-attachments`.
- `vault-context` exposes ten read-only tools:
  `vault_search`, `vault_fetch`, `vault_related`, `vault_footnotes_list`,
  `vault_footnotes_get`, `vault_journal_entries`, `vault_journal_get`,
  `context_plan`, `context_fetch_pack`, and `agent_context`.
- `activity-attachments` exposes three read-only tools:
  `activity_attachments_list`, `activity_attachment_record`, and
  `activity_attachment_image`.
- The activity metadata tools return records and diagnostics only; no base64,
  data URLs, or raw bytes are present in list/record output.
- `activity_attachment_image` returns a selected supported image ref as one MCP
  image content block (`type: "image"`, base64 `data`, `mimeType`) with no text
  fallback and no `structuredContent` on successful calls.
- Tool descriptors include JSON input/output schemas, per-tool bounds,
  examples, backing command references, and a trust posture that vault content
  is source evidence rather than trusted instruction text and activity
  projections remain byte-free.
- The command validates the manifest against the Wave 4 interface records and
  live Commander/agent-context inventory before printing it.
- The manifest is suitable for connector review and drift tests; it does not
  start a server.

Example:

```bash
pnpm --filter @polli-labs/calyx build
calyx mcp manifest --surface vault-context --json
calyx mcp manifest --surface activity-attachments --json
```

From a fresh source checkout, build first and then use
`node packages/cli/dist/bin.js mcp manifest --surface vault-context --json`
if the `calyx` binary is not installed on PATH.

### `calyx mcp serve`

Serve a read-only Calyx MCP surface over a local Streamable HTTP endpoint.

```bash
calyx mcp serve --surface vault-context [--host <host>] [--port <port>] [--auth-token-env <name>] [--vault-path <path>] [--json]
calyx mcp serve --surface activity-attachments [--host <host>] [--port <port>] [--auth-token-env <name>] [--runs-root <path>] [--attachment-cache-dir <path>] [--json]
```

Notes:
- Default host is `127.0.0.1`; default port is `8787`; the MCP endpoint is
  `/mcp`.
- Set `--auth-token-env CALYX_CONTEXT_MCP_TOKEN` and export that environment
  variable before serving when a tunnel, non-local client, or shared machine can
  reach the endpoint. Non-local hosts are refused unless the named token env var
  is set.
- Browser-readable CORS is not enabled in v0, even on localhost. Use MCP
  clients, ChatGPT server-side connector traffic, or a reviewed tunnel/auth
  setup rather than treating localhost as a browser security boundary.
- Local binds reject non-local Host headers to reduce DNS-rebinding exposure.
- The server accepts MCP JSON-RPC requests through Streamable HTTP. Data-bearing
  responses are bounded by the selected surface's underlying Calyx tools.
- Vault root selection is a server-side option (`--vault-path` for development
  fixtures, otherwise the default Fieldwork vault). MCP callers cannot pass a
  local filesystem root override.
- Activity run-root and attachment-cache selection are server-side options
  (`--runs-root` and `--attachment-cache-dir`) for isolated dogfood fixtures.
  MCP callers can pass only `activity_id`, `ref`, and optional explicit `host`.
- Tool calls are read-only. The server does not write vault notes, issue bodies,
  Linear records, GitHub records, context-pack files, activity projections, or
  remote hosts. `activity_attachment_image` may materialize sha256-verified
  bytes into the local content-addressed attachment cache before returning the
  MCP image block.
- Server logs include tool name, source ids, byte counts, warnings, and errors;
  they intentionally avoid logging raw vault note bodies or activity attachment
  base64 payloads.
- The activity surface preserves the hard invariant: `calyx activity messages`,
  `calyx activity turns`, `calyx activity text`, and metadata/list MCP tools
  never inline attachment bytes. The sanctioned byte paths are the authenticated
  daemon byte route, local sha256 cache files, and explicit MCP image content
  blocks.

Example:

```bash
CALYX_CONTEXT_MCP_TOKEN="<token>" \
  calyx mcp serve \
    --surface vault-context \
    --host 127.0.0.1 \
    --port 8787 \
    --auth-token-env CALYX_CONTEXT_MCP_TOKEN \
    --json

CALYX_CONTEXT_MCP_TOKEN="<token>" \
  calyx mcp serve \
    --surface activity-attachments \
    --host 127.0.0.1 \
    --port 8788 \
    --auth-token-env CALYX_CONTEXT_MCP_TOKEN \
    --attachment-cache-dir /tmp/calyx-mcp-attachments \
    --json
```

---

## Activity Commands

Top-level facade over agent activity discovered by Calyx (interactive Codex
and Claude sessions today; calyx_run activities later). Slice 1A (POL-1352)
adds semantic message selectors so agents can read what a human asked, and
what the assistant replied, without raw transcript knowledge or `jq` glue.
Local reads such as `calyx activity self --json` and same-host transcript
queries can work bare. Remote `calyx activity ... --host <host>` reads go
through that host's authenticated daemon. Normal calls resolve the host's named
`operator_cli` outbound credential; `--auth-token <token>` is an explicit
override. The normal Polli path is to run them through `with-polli-secrets`.

Interactive activities are **host-local**: a read resolves against exactly one
host's session stores, so a miss means "not on that host", not "gone". Every
not-found error names the host it searched, and `run:` handles whose run record
names a different executing host say so and point at `--host <host>`.

### `calyx activity list`

```bash
calyx activity list [--host <host>] [--include-runs] [--agent-kind <all|codex|claude>] [--since-hours <n>] [--limit <n>] [--server-url <url>] [--auth-token <token>] [--json]
```

Lists recent interactive Codex and Claude sessions by default. Pass
`--include-runs` to also include calyx_run rows. The remote variant uses the
existing `interactive.activity_surface/v1` daemon feature; new semantics
arrive in the message and event subcommands below.

Examples:

```bash
calyx activity list --since-hours 24 --json
calyx activity list --host mba --agent-kind codex --limit 10
```

### `calyx activity overview`

```bash
calyx activity overview [--host <host>] [--agent-kind <all|codex|claude>] [--since-hours <n>] [--limit <n>] [--turn-role <human|assistant|unknown|all>] [--max-messages <n>] [--max-text-chars <n>] [--server-url <url>] [--auth-token <token>] [--json]
```

Lists recent interactive sessions and attaches exactly one compact
most-recent turn preview per returned activity. This is the agent-native
birds-eye surface for questions like "which Claude sessions changed in the
last 12 hours, and what did each most recently say?" It is a bounded live
read over the existing activity inventory and turn projection; it is not the
derived search/freshness index from POL-1738.

Defaults are tuned for operator meta-management: `--agent-kind claude`,
`--since-hours 12`, `--limit 20`, `--turn-role all`,
`--max-messages 4`, and `--max-text-chars 240`.

The JSON envelope uses schema `activity.overview/v1`. Each row includes
activity/session metadata, `updated_age_seconds`, and, when a turn is
available inside the lookback window, compact turn metadata plus preview
messages with role, age, and truncated text. The row includes
`returned_message_count` and `omitted_message_count`; use
`calyx activity turns <activity-id> --last 1 --json` when a compact preview
needs progressive disclosure.

Examples:

```bash
calyx activity overview --json
calyx activity overview --agent-kind claude --since-hours 12 --limit 30 --json
calyx activity overview --agent-kind all --turn-role assistant --max-messages 2 --max-text-chars 160
```

### `calyx activity self`

Resolve the current Codex or Claude harness session to a canonical Calyx
activity id when the harness exposes a session id in the environment.

```bash
calyx activity self [--runs-root <path>] [--host <host>] [--json]
```

The JSON envelope uses schema `activity.self/v1`. It reports the resolved
`activity_id`, `backend`, `session_id`, whether the session was found in the
activity inventory, and any warning if the harness identity was available but
not indexed yet.

Examples:

```bash
calyx activity self --json
calyx activity turns "$(calyx activity self --json | jq -r .activity_id)" --role assistant --last 1 --json
```

### `calyx activity mark`

Create or converge one durable, host-local attention mark through the daemon's
generated consumer client. The target must already exist in the daemon's
consumer-visible local activity projection. Canonical `:msg:<line>` and
`:turn:<line>` suffixes select message and turn targets; other valid handles
select an activity. `--target-kind` may state that inferred kind explicitly,
but a grammar/kind mismatch is a usage error. Reusing an idempotency key with
the same request replays the original receipt, while reusing it for a different
request is rejected.

```bash
calyx activity mark <target-id> \
  --kind <high_signal|foundational> \
  [--target-kind <activity|turn|message>] [--reason <text>] \
  [--idempotency-key <key>] \
  [--host <host> | --server-url <url>] [--auth-token <token>] \
  [--asserted-actor <actor>] [--json]
```

Examples:

```bash
with-polli-secrets calyx activity mark --host blade interactive:codex:<session-id>:msg:42 --kind high_signal --reason "Decision boundary" --json
calyx activity mark --server-url https://calyx.example --auth-token <token> run:<run-id>:turn:17 --kind foundational --idempotency-key mark:POL-1996:17 --json
```

### `calyx activity unmark`

Revoke an owned mark without deleting its history. Revocation uses a bodyless,
request-target-idempotent consumer operation; repeating the same mark id
converges on the original revocation receipt.

```bash
calyx activity unmark <mark-id> \
  [--host <host> | --server-url <url>] [--auth-token <token>] \
  [--asserted-actor <actor>] [--json]
```

### `calyx activity marks`

List active marks at one mutation-stable daemon snapshot. Filters are
independent; when both target filters are supplied their grammar must agree.
Continue pagination only with the opaque `next_cursor` returned by the prior
page.

```bash
calyx activity marks \
  [--kind <high_signal|foundational>] \
  [--target-kind <activity|turn|message>] [--target-id <id>] \
  [--since <timestamp>] [--limit <n>] [--cursor <cursor>] \
  [--host <host> | --server-url <url>] [--auth-token <token>] [--json]
```

Examples:

```bash
with-polli-secrets calyx activity marks --host blade --kind high_signal --limit 25 --json
with-polli-secrets calyx activity marks --host blade --target-id interactive:codex:<session-id>:msg:42 --json
with-polli-secrets calyx activity marks --host blade --cursor '<next_cursor>' --json
```

### `calyx activity show` and `calyx activity export`

Top-level aliases over the existing `calyx run activity show / export`
substrate. Same options, same output. `calyx run activity ...` continues to
work but emits a stderr deprecation warning pointing to `calyx activity ...`.
`--activity-id` accepts the same interactive activity locators as
`calyx activity messages`, including Codex `codex://threads/<uuid>` deeplinks.

### `calyx activity messages`

Read semantic messages from an interactive activity. Default visibility skips
harness context (AGENTS.md payloads), tool calls/results, system notices, and
reasoning summaries; pass `--visibility +detail` or `+hidden`/`all` to widen
the slice.

`--role human` is semantic: it returns genuine human-authored prompt text, not
every raw provider event whose role is `user`. Tool results, task notifications,
attachment/source metadata, skill/plugin/harness payloads, and automation
heartbeats stay out of human slices; audit them with
`calyx activity events --raw-role user --classify`.

```bash
calyx activity messages [<activity-id>] \
  [--role <human|assistant|harness-context|tool-call|tool-result|system-notice|reasoning-summary|unknown>] \
  [--first <n> | --last <n>] \
  [--latest-session --backend <codex|claude>] \
  [--around-id <message-id> | --around-text <query>] \
  [--context <n>] \
  [--visibility <default|+detail|+hidden|all>] \
  [--grep <pattern>] \
  [--summary-only] \
  [--max-text-chars <n>] \
  [--explain-classification] \
  [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

`<activity-id>` accepts the full `interactive:<backend>:<session-id>` form,
the vault authorship alias `<backend>:<host>:<session-id>` (the
`author:`/`updated_by:` frontmatter identity), Codex thread deeplinks
(`codex://threads/<uuid>`), the bare Codex rollout filename UUID,
`run:<run-id>` for Calyx `agent_runner` runs with durable backend-session
metadata (full run id or unique short prefix), a short prefix (errors loud on
ambiguity), or can be omitted with `--latest-session --backend <codex|claude>`.
Run-backed JSON responses include both `run_id` and the resolved `activity_id`,
plus an `activity_resolution` object naming the metadata source used for the
bridge.

**The host is never a segment of the id.** `--host <host>` selects which host's
session stores are searched; the canonical id stays
`interactive:<backend>:<session-id>` on every host. A composite such as
`interactive:blade:codex:<session-id>` is a *grammar* error, not a missing
activity — see the id-grammar rules below.

### Activity id grammar and its errors

An activity id that matches no accepted form fails as a malformed locator
before any session store is scanned. The three failure classes are kept
distinct so an absent activity is never confused with a mistyped one:

| Condition | Error | Exit | HTTP |
|-----------|-------|------|------|
| Id matches no accepted locator form | `Activity id "…" is malformed: …` plus the corrected id and the accepted grammar | `2` | `400 invalid_activity_id` |
| Id is well-formed but no session matches on the searched host | `Interactive activity "…" not found on host "<host>". Activity ids are host-local; …` | `3` | `404 activity_unknown` |
| Short prefix matches more than one session or run | `Short-prefix handle "…" matches N …` plus the candidates | `4` | `409 activity_ambiguous` |

Malformed ids are rejected client-side, so the verdict and its exit code are
identical for local and `--host <host>` reads and need no credentials:

```console
$ calyx activity turns interactive:blade:codex:019f869d-d664-7870-a1ee-6bc3d66626c3 --json
Activity id "interactive:blade:codex:019f869d-d664-7870-a1ee-6bc3d66626c3" is malformed: the host segment "blade" belongs in --host, not in the activity id.
Use: interactive:codex:019f869d-d664-7870-a1ee-6bc3d66626c3 --host blade
Accepted activity locators:
  interactive:<backend>:<session-id>  canonical activity id (backend: codex|claude)
  <backend>:<host>:<session-id>       vault authorship alias
  codex://threads/<uuid>              Codex thread deeplink
  run:<run-id>                        Calyx run handle
  <session-id-prefix>                 unique prefix of a session id
The host is a separate `--host <host>` argument, never a segment of the id.
$ echo $?
2
```

Validation rules:

- `--first` and `--last` are mutually exclusive.
- `--around-id` and `--around-text` are mutually exclusive.
- `--context` requires one of `--around-id` / `--around-text`.
- `--max-text-chars` defaults to `4000` and can be raised for long-message
  handoff packets; returned messages carry `truncated: true` when their text is
  still clipped at the effective cap. Truncated text includes inline elision
  markers with exact character offsets and a copyable `calyx activity text`
  command. JSON responses also include `text_cursor.total_chars`,
  `text_cursor.returned`, and `text_cursor.next`.
- `--grep` and `--around-text` scan full message text in the streaming reader,
  independent of the projection cap. Matching messages project hit-centered
  windows when the hit is outside the default head/tail view.
- `--role user` is rejected with a corrective error pointing at
  `--role human` and `calyx activity events --raw-role user`.
- `run:<run-id>` accepts the same unique short prefixes as `calyx run status`
  and `calyx run receipt`. A prefix matching several runs lists them; a prefix
  matching none says so and tells you to pass the full run id.
- `run:<run-id>` requires backend session metadata in the run record,
  recovery checkpoint, or kernel receipt. Missing metadata fails loudly and
  points operators at `calyx run logs --full`, `calyx run receipt`, or the run
  record. When the run record names a different executing host than the one
  queried, the error names that host so you can retry with `--host <host>`.
- `<backend>:<host>:<session-id>` authorship aliases resolve against the
  queried host's session stores: exact session-id match always, session-id
  prefix expansion only when the alias names that host. A cross-host miss
  names the locator host in the error so you can retry with `--host <host>`.

Stable IDs round-trip: each message id is `<activity-id>:msg:<source-line>`,
returned in the JSON response and accepted by `--around-id`. The response
includes `classifier_version`, `source_receipt` (`bytes_scanned`, streaming
mode, decoded/skipped record counts, and guard hits), per-message
`classification.rule_id` / `classification.reason`, source/raw role, event
refs, source lines, attachment rollups, and live or partial-source warnings.
Attachment bytes are never returned inline; projected messages use
`att:sha256:<digest>` refs with source-shape metadata.

When the per-host recall store (POL-1838, migration `0013`) is reachable, the
response also carries an additive `recall_freshness` block
(`store_state: fresh | behind | absent | unavailable`, `fully_indexed`,
`pending_bytes`, `store_message_count`, `classifier_current`, `indexed_through`,
`last_index_run_at`) so an agent can see how current the transcript-tailer store
is for this source. Message bodies are still served from the live truth-plane
parse in this slice; the block is freshness signal only.

Remote queries are gated on the daemon feature `activity.messages/v1`.

Examples:

```bash
calyx activity messages --latest-session --backend codex --role human --first 1 --json
with-polli-secrets calyx activity messages --host blade interactive:claude:ab00b584-d699-4f54-8e5b-c9541b3e0d2b --role assistant --last 1 --json
calyx activity messages run:3b519ec4-d18f-4ff2-8057-75f7508d935d --role human --first 1 --json
calyx activity messages 'codex://threads/019dcafe' --role assistant --last 1 --json
calyx activity messages claude:blade:0baf9eee --role assistant --last 1 --json   # vault authorship alias
calyx activity messages 019dcafe --role assistant --last 1 --json
calyx activity messages interactive:codex:019dcafe --grep "POL-1352" --role assistant --last 3 --summary-only
calyx activity messages interactive:codex:019dcafe --around-text "dependency cooldown" --context 3 --json
```

### `calyx activity text`

Fetch an exact character slice from one projected activity message. This is the
progressive-disclosure companion to `calyx activity messages`: copy the command
embedded in an elision marker, or pass a returned message id manually.

```bash
calyx activity text <message-id> \
  [--range <A:B> | --from <A>] \
  [--classifier-version <version>] \
  [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

`<message-id>` has the same `<activity-id>:msg:<source-line>` form returned by
`calyx activity messages`. `--range A:B` and `--from A` use zero-based integer
character offsets into the semantic message text. When
`--classifier-version` is supplied, Calyx validates it against the current
activity classifier before slicing so stale cursors fail explicitly instead of
silently returning a different range.

The text reader decodes only the source JSONL record for the requested message.
Attachment bytes remain represented by `att:sha256:<digest>` refs in returned
text. Remote queries are gated on daemon feature `activity.text/v1`.

Examples:

```bash
calyx activity text interactive:codex:019dcafe:msg:42 --range 4000:8000 --classifier-version v1.2026.06.02 --json
calyx activity text interactive:claude:a0db0b5e:msg:17 --from 12000
```

### `calyx activity attachments`

List or extract content-addressed attachments referenced by an activity.
Projected messages never inline base64 image bytes; they expose
`att:sha256:<digest>` tokens and this command resolves those tokens to metadata
or local files.

```bash
calyx activity attachments <activity-id> \
  [--turn <n>] \
  [--message <message-id>] \
  [--ref <att:sha256:digest>] \
  [--extract] \
  [--out <dir>] \
  [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

Without `--extract`, the command returns attachment records only: ref, sha256,
MIME type, byte size, source shape, source line, event index, and recoverable
detail such as `original` or `resized`. With `--extract`, matching attachments
are decoded from the original source record, sha256-verified, and written
idempotently by content address. The default extraction cache is
`~/.calyx/cache/attachments/sha256/`; `--out <dir>` overrides it. Each cache
object is paired with `<digest>.provenance.json`, recording source host,
served-by host, source tier, classifier version, and observation history.

When `--host <host> --extract` names a non-local daemon, the CLI performs a
single-host pull-through: it reads the remote attachment record, reuses an
already verified current-host cache object when present, otherwise fetches raw
bytes from the daemon byte route, verifies sha256 before the final write, and
returns current-host paths. It never returns a remote filesystem path as local
evidence. Repeated extraction of a verified digest updates provenance but does
not re-transfer bytes.

The daemon exposes authenticated attachment record and byte routes:

```text
GET  /v1/admin/activity/{activity_id}/attachments/{encoded_ref}
GET  /v1/admin/activity/{activity_id}/attachments/{encoded_ref}/bytes
HEAD /v1/admin/activity/{activity_id}/attachments/{encoded_ref}/bytes
```

`encoded_ref` is `encodeURIComponent("att:sha256:<digest>")`. The byte route
sets `Content-Type`, `Content-Length`, `ETag: "sha256:<digest>"`,
`Digest: sha-256=<base64>`, `X-Calyx-Attachment-Ref`, and source-host headers.
The descriptor, OpenAPI response, daemon header schema, and pull-through
client all enforce the same 64 MiB maximum before a cache write. Cache object
identity includes the full sha256 MIME digest, and bounded provenance is
validated from the same opened handle before it is trusted.
Remote extraction requires daemon features `activity.attachments/v1` and
`activity.attachment_bytes/v1`.

If the explicitly named origin host is unreachable and an explicit `--ref` was
provided, the first slice can fall back to the POL-1041 raw session archive on
blade. Archive fallback keeps `origin_host` as the original host, records
`source_tier: "blade-archive"`, and still writes only after local sha256
verification. It does not perform fleet fan-out or owner discovery.

The normalizer handles Codex `input_image` data URLs and both Claude base64
spellings (`source.type=base64` and `file.base64`) with the same refs, cursors,
and list/extract surfaces. Typed diagnostics include
`attachment_ref_unknown`, `attachment_bytes_unavailable`,
`attachment_digest_mismatch`, `activity_owner_unreachable`, `auth_failure`, and
`attachment_archive_unavailable`. Projected messages, turns, and text keep the
hard invariant: attachment bytes are never returned inline.

The MCP activity attachment adapter is a viewer over the same refs and cache,
not a projection change. Use
`calyx mcp serve --surface activity-attachments ...` to expose
`activity_attachments_list`, `activity_attachment_record`, and
`activity_attachment_image` to an MCP client. The list and record tools return
metadata only; the image tool resolves through the same sha256-verified
pull-through cache and returns one MCP image content block for supported image
MIME types.

Examples:

```bash
calyx activity attachments interactive:codex:019dcafe --json
calyx activity attachments interactive:claude:a0db0b5e --message interactive:claude:a0db0b5e:msg:17 --extract --json
calyx activity attachments run:3b519ec4-d18f-4ff2-8057-75f7508d935d --ref att:sha256:<digest> --extract
with-polli-secrets calyx activity attachments interactive:codex:019dcafe --host carbon --ref att:sha256:<digest> --extract --json
```

### `calyx activity events`

Audit raw activity events for classifier/harness debugging.

```bash
calyx activity events [<activity-id>] \
  [--classify] \
  [--raw-role <user|assistant|tool|system|unknown>] \
  [--tail <n>] \
  [--around-id <message-id>] \
  [--context <n>] \
  [--within-turn] \
  [--latest-session --backend <codex|claude>] \
  [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

`--classify` annotates each event with `classification.projected_role`,
`classification.visibility`, `classification.rule_id`, the raw role/kind, and
the stable `message_id` so audits can confirm why a raw `user` event projects
to `harness_context` vs `human`. Remote queries also gate on
`activity.messages/v1`. `<activity-id>` accepts the same handle forms as
`calyx activity messages`, including `run:<run-id>` when backend activity
metadata is available.

`--within-turn` requires `--around-id <message-id>`. It returns every raw event
for the human/assistant turn that contains the anchor message (`tool_call`,
`tool_result`, reasoning summaries, and harness payloads included). It is
mutually exclusive with `--tail`, `--context`, and `--raw-role`. Remote queries
for `--within-turn` gate on `activity.turns/v1`.

Examples:

```bash
calyx activity events 'codex://threads/019dcafe' --raw-role user --tail 10 --classify --json
calyx activity events run:3b519ec4-d18f-4ff2-8057-75f7508d935d --around-id interactive:codex:019dcafe:msg:42 --within-turn --json
calyx activity events 019dcafe --around-id interactive:codex:019dcafe:msg:42 --context 8 --json
calyx activity events 019dcafe --around-id interactive:codex:019dcafe:msg:42 --within-turn --json
```

### `calyx activity turns`

Group an interactive activity into stable human/assistant turns with explicit
`complete | in_flight` state. Each returned `ActivityTurn` exposes a stable
`turn_id` (`<activity-id>:turn:<line>`), source-line range, tool-call/result
counts, and the projected messages that fall inside the turn.

```bash
calyx activity turns [<activity-id>] \
  [--role <human|assistant|unknown|all>] \
  [--first <n> | --last <n>] \
  [--latest-session --backend <codex|claude>] \
  [--with-tools] \
  [--summary-only] \
  [--max-text-chars <n>] \
  [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

Turn boundary rules (versioned via `classifier_version`):

- A `human` message starts a new human turn.
- An `assistant` message continues the current assistant turn or opens a new
  one.
- `tool_call` and `tool_result` events attach to the current assistant turn.
  If the previous turn was a human turn (or there is no turn), they open a new
  assistant turn — tools cannot exist inside a human turn.
- `--max-text-chars` defaults to `4000` and can be raised; turn messages carry
  `truncated: true` when their text is clipped at the effective cap.
- Harness context, system notices, reasoning summaries, and unclassified
  events attach to the current open turn for raw audit and do not force a
  default turn to appear unless `--role unknown` or `--role all` is requested.
- Pre-prompt harness/system events form a synthetic `unknown` preamble turn,
  hidden by default.

`--with-tools` includes the turn's tool calls/results in the returned messages.
Without it, the turn is the bounded, agent-readable slice (human + assistant
text only); tool counts remain in `tool_call_count` / `tool_result_count`.

The last turn of a `live` session reports `state: "in_flight"`; all earlier
turns are `state: "complete"`. Remote queries gate on the new
`activity.turns/v1` daemon feature.

`<activity-id>` accepts the same handle forms as `calyx activity messages`,
including `<backend>:<host>:<session-id>` authorship aliases, Codex
`codex://threads/<uuid>` deeplinks, and `run:<run-id>` for Calyx
`agent_runner` runs with durable backend-session metadata. Run-backed JSON
responses include both `run_id` and the resolved `activity_id`, plus
`activity_resolution.resolution_source`.

Examples:

```bash
calyx activity turns --latest-session --backend codex --role assistant --last 1 --with-tools --json
with-polli-secrets calyx activity turns --host blade interactive:claude:ab00b584-d699-4f54-8e5b-c9541b3e0d2b --role assistant --last 1 --json
calyx activity turns run:3b519ec4-d18f-4ff2-8057-75f7508d935d --role assistant --last 1 --with-tools --json
calyx activity turns 'codex://threads/019dcafe' --role assistant --last 1 --json
calyx activity turns codex:blade:019dcafe --role assistant --last 1 --json   # vault authorship alias
calyx activity turns 019dcafe --role human --first 1 --json
calyx activity turns 019dcafe --role assistant --last 3 --summary-only
```

Use `calyx activity events <activity-id> --around-id <message-id> --within-turn --json`
to drop from a turn's `first_message_id` (or any contained message) into the
raw events that constitute the turn.

---

## Review Commands

`calyx review` is the first POL-1792 sugar verb over launch-time agent
definitions. It compiles through the same loader as `calyx run launch --agent`;
it does not resolve reviewer definitions itself.

```bash
calyx review [--adversarial] [--scope pr|branch] [--base <ref>] \
  [--focus <text>]... [--backend <backend>] [--host <host>] \
  [--no-handback] (--repo <slug> | --worktree-path <path>) (--pr <n> | --branch <ref>) \
  [--sha <full-commit-sha>] [--issue <POL>] [--dry-run] [--json]
```

Behavior:

- `reviewer` is the default agent definition; `--adversarial` selects
  `reviewer-adversarial`.
- `--scope` is inferred from `--pr` or `--branch` when omitted. Exactly one
  target must be supplied.
- For PR targets, target pinning first refreshes remote-tracking bases such as
  `origin/main`, then resolves the PR head from `origin` before falling back to
  any local `refs/pull/<n>/head`, so stale local pull refs do not silently pin
  pre-push heads. Without `--sha`, Calyx waits for the remote PR head to match
  across consecutive reads as a best-effort guard, but GitHub's async
  `refs/pull/<n>/head` can still lag immediately after a force-push; pass
  `--sha <full-commit-sha>` to guarantee a known post-push PR head during
  force-push races. Target-resolution warnings are included in the review
  conduct receipt and reviewer prompt when the pin is best-effort or an
  explicit `--sha` is not observed on the PR ref. Abbreviated SHAs are refused
  because managed worktree fetches require full commit IDs.
- Subject: exactly one of `--repo <slug-or-alias>` (a canonical slug, configured
  alias, or collision-free private `<repo>-dev` leaf derived from an explicit
  owner-qualified `<repo>-dev` alias, reviewed in a fresh managed worktree) or
  `--worktree-path <path>` (an explicit existing local checkout, reviewed as-is
  — for unregistered/local repos). Derived leaves are convention identities,
  not basename fallback: ambiguous leaves and leaves colliding with canonical
  slugs are refused. The conduct target records `requested_repo` separately
  from the canonical executable `repo`, plus `repo_resolution_source`. The
  `--worktree-path` flow resolves the `--pr`/`--branch` target against the
  checkout's own `origin`/refs and overrides the reviewer agent's managed
  default to `existing` mode.
- Backend selection comes from the agent definition strategy, commonly
  `prefer_different_from_requester` and also schema-permitted
  `first_available`. The requester backend is resolved from the caller activity
  identity; `--backend` is an explicit override.
- Default handback persists a run-spec `handback` binding to the caller
  activity with `ack_required`. When the run reaches a terminal state, run-service
  emits the bound `calyx msg` on success or failure. The reviewer prompt and
  environment still include the same voluntary `calyx msg send` command with a
  shared idempotency key, so a compliant reviewer and the system terminal send
  dedupe instead of double-delivering.
- If the target daemon lacks `message.correspondence/v1`, the binding degrades
  to a receipt-only handback artifact and the conduct receipt reports
  `handback_status: unavailable`; manual relay can still be performed from the
  run artifact plus PR/Linear review comment.
- The reviewer handback body is limited to status axes, verdict, counts, and
  locators; findings belong on the PR/Linear/run-artifact surfaces.
- `--no-handback` is an explicit opt-out. It is not the default posture.
- `--dry-run --json` returns the resolved `calyx.review.conduct/v1` receipt
  without creating a run.

The `--json` conduct receipt includes:

- `run_id`
- `agent_ref` as `<agent-id>@sha256:<digest>`
- the resolved target object from agent-definition target pinning
- selected backend, strategy, requester backend, override flag, and reason
- requester activity reconciliation status and any env-only warning
- handback status/address/thread/body contract, manual-relay status, and
  `run:<id>` reviewer reply locator

Examples:

```bash
calyx review --repo polli-labs/calyx-dev --pr 123 --issue POL-1801 --dry-run --json
calyx review --adversarial --repo polli-labs/calyx-dev --pr 123 --issue POL-1801 --json
calyx review --repo polli-labs/calyx-dev --pr 123 --sha 385c33b000000000000000000000000000000000 --issue POL-1801 --json
calyx review --repo polli-labs/calyx-dev --branch calyx-run/pol-1801 --base origin/main --focus handback --json
calyx review --adversarial --worktree-path /Users/me/dev/other/saffron-switchyard-wt/pr-8 --pr 8 --issue POL-1811 --json
```

Underlying mechanism note:

```bash
calyx run launch --agent reviewer --var repo=<slug> --var scope=pr --var pr=<n>
```

Use the sugar for reviewer commissioning so conduct receipts, backend selection
reasoning, and terminal handback bindings stay uniform.

## Generated Client Recovery

Every remote keyed write uses the generated client's exact serialized bytes,
bounded recovery loop, credential binding, and encrypted receipt custody. The
CLI reserves replay authority before dispatch; if that reservation cannot be
made, the mutation is not sent. An indeterminate result reports a managed
receipt path and never prints its sensitive `body_bytes`.

```bash
calyx client replay <receipt-path> [--auth-token <token>]
```

This generic command is the recovery projection for lease and monitor writes.
It decrypts an owner-only `calyx.client-recovery-envelope/v1`, authenticates the
embedded `calyx.client-indeterminate-result/v1`, resolves the exact endpoint and
credential binding, and invokes generated `replayIndeterminate`; it exposes no
raw method, URL, header, or media-type override. Only a schema-valid success
removes the receipt: an API, transport, or protocol failure after an earlier
ambiguous admission retains the same stable encrypted slot.
Run launch and message send also expose their existing, operation-specific
`--replay-request` forms.

With `CALYX_STATE_HOME` set, receipts and the protected recovery key live under
`$CALYX_STATE_HOME/recovery/client`; otherwise they use private
`~/.calyx-recovery/client`. Directories are current-user-owned mode `0700`, the
key and envelopes are mode `0600`, and receipt payloads are encrypted with
AES-256-GCM. Bearer tokens never enter an envelope.

## Run Commands

Run orchestration over `@polli-labs/calyx-run-service`: unresolved intent, frozen spec, kernel receipt, and authoritative `RunRecord`.

### `calyx run launch`

Launch a Calyx run locally or dispatch it to an authenticated remote run server.

```bash
calyx run launch \
  --host <host> \
  [--kernel <agent_runner|host_process>] \
  [--run-id <id>] \
  [--idempotency-key <key>] \
  [--foreground] \
  [--json]
calyx run launch --replay-request <artifact-path> [--auth-token <token>] [--json]
```

`calyx run launch` is the single operator-facing orchestration surface. `agent_runner` remains the default kernel for agent sessions; `host_process` is the first non-agent adapter and the direct long-process replacement path for legacy `agent-notify`-style wrappers.

Operator ergonomics are intentionally explicit here: v1 keeps one `calyx run` launch surface and asks callers to pass host-process argv token-by-token with repeated `--argv` flags. There is no secondary `calyx run process` alias and `calyx exec notify` is not the durable-process path.

**Kernel-specific shapes:**
- `agent_runner` (default)

  ```bash
  calyx run launch \
    --host <host> \
    [--backend <claude|codex>] \
    [--model <model>] \
    [--agent <id> | --prompt <text> | --prompt-file <path> | --template <id>] \
    [--agent-registry <path>] \
    [--var NAME=VALUE] \
    [--system-prompt <text> | --system-prompt-file <path>] \
    [--append-system-prompt <text> | --append-system-prompt-file <path>] \
    [--template-var NAME=VALUE] \
    [--execplan-ref <ref>] \
    [--require-execplan | --no-require-execplan] \
    [--foreground] \
    [--json]
  ```

- `host_process`

  ```bash
  calyx run launch \
    --kernel host_process \
    --host <host> \
    --cwd <path> \
    --argv <token> \
    [--argv <token> ...] \
    [--env KEY=VALUE] \
    [--stop-grace-ms <ms>] \
    [--health-source <stdout|stderr>] \
    [--health-path <path>] \
    [--health-stale-after-ms <ms>] \
    [--health-poll-interval-ms <ms>] \
    [--agent-activity-stale-after-ms <ms>] \
    [--agent-activity-poll-interval-ms <ms>] \
    [--agent-inactivity-timeout-ms <ms>] \
    [--agent-inactivity-stop-grace-ms <ms>] \
    [--foreground] \
    [--json]
  ```

**Options:**
- `--host <host>` (default: `local`) — Local host alias or remote execution target
- `--run-id <id>` — Stable caller-selected run identity; especially useful with remote submit-and-observe.
- `--idempotency-key <key>` — Stable remote launch binding. When omitted, the CLI derives one from the run id.
- `--replay-request <artifact-path>` — Replay the exact serialized body and media contract retained after an indeterminate remote launch. This bypasses launch reconstruction and refuses artifacts whose operation, host, media type, or idempotency binding does not match.
- `--kernel <kernel>` (default: `agent_runner`) — Execution kernel selector
- `--backend <backend>` (default: `claude` for `agent_runner`) — Adapter backend (`claude` or `codex`) for `agent_runner`
- `--model <model>` — One-off backend model for `agent_runner`; currently forwarded to Claude CLI as `--model <model>`. Use this for model selection, not `--profile`.
- `--agent <id>` — Resolve an agent definition from `instructions/agents/AGENTS.json` on the launcher, compile it to existing run launch fields, and persist definition provenance plus the pinned `target` object in run metadata.
- `--agent-registry <path>` — Optional path to `AGENTS.json`; otherwise uses `CALYX_AGENTS_REGISTRY`, config, or the agents-infra adapter path.
- `--var NAME=VALUE` — Agent variable assignment (repeatable). Unknown variables fail before dispatch. Repeatable definition inputs render as a section boolean plus `<name>_list`; pinned targets render as `target.*`.
- `--prompt <text>` / `--prompt-file <path>` / `--template <id>` — Direct prompt source for `agent_runner` (at most one, mutually exclusive with `--agent`). Direct prompt/template/agent launches do not require an ExecPlan by default.
- `--system-prompt <text>` / `--system-prompt-file <path>` — Replace the backend's default system prompt for `agent_runner`
- `--append-system-prompt <text>` / `--append-system-prompt-file <path>` — Append extra instructions to the backend's default system prompt for `agent_runner`
- `--template-var NAME=VALUE` — Template variable assignment for `agent_runner` (repeatable)
- `--execplan-ref <ref>` — Optional ExecPlan reference path for `agent_runner`; when no direct prompt source is supplied, the resolved ExecPlan supplies the prompt.
- `--require-execplan` — Require a resolved ExecPlan even when a direct prompt source is supplied.
- `--no-require-execplan` — Allow `agent_runner` dispatch without an ExecPlan even when no direct prompt source is supplied. A prompt source is still required unless an ExecPlan resolves.
- `--pull-execplan` — Pull the docstore ExecPlan namespace before `agent_runner` resolution
- `--repo <slug-or-alias>` — Canonical repo slug, configured alias, or collision-free private `<repo>-dev` leaf derived from an explicit owner-qualified `<repo>-dev` alias for repo-backed `agent_runner` worktrees. Derived leaves are rejected on ambiguity or canonical-slug collision; unknown registry identifiers cannot be rescued by the launcher's current directory. Resolved run specs use the canonical host-truth slug while receipts retain the requested spelling and resolution source.
- `--worktree-base <path>` — Base directory for runtime-managed target-repo worktrees when `kernel=agent_runner`
- `--worktree-mode <existing|managed|create>` — Worktree acquisition mode for `agent_runner`
- `--worktree-path <path>` / `--worktree-ref <ref>` / `--worktree-branch <branch>` / `--steal-lock` — Worktree controls for `agent_runner`
- `--lock-timeout-ms <ms>` — Worktree lock timeout for `agent_runner`
- `--required-artifact <name>` — Required artifact name for `agent_runner` (repeatable). Completion checks the run artifact directory first, then the worktree mirror.
- `--artifact-root <path>` — Artifact/output root for `run doctor` liveness summaries (repeatable). Relative roots resolve from the worktree; absolute roots are used as-is.
- `--argv <token>` — Host-process argv token for `host_process` (repeat once per token to avoid shell ambiguity)
- `--cwd <path>` — Host-process working directory on the target host for `host_process`
- `--stop-grace-ms <ms>` — Host-process stop grace period before SIGKILL for `host_process`
- `--health-source <stdout|stderr>` — Built-in host-process freshness source (repeatable)
- `--health-path <path>` — Extra file path to watch for host-process freshness (repeatable, resolved relative to `--cwd`)
- `--health-stale-after-ms <ms>` — Required staleness window when host-process health monitoring is configured
- `--health-poll-interval-ms <ms>` — Optional polling cadence for host-process health checks
- `--allowed-tool <tool>` / `--dangerously-skip-permissions` — Backend options for `agent_runner`
- `--max-threads <n>` — Codex-only sub-agent concurrency (`agents.max_threads`); Claude rejects it
- `--max-turns <n>` — Claude-only native turn cap (`--max-turns`); Codex rejects it
- `--reasoning-effort <effort>` — One-off backend reasoning effort for `agent_runner`; Claude accepts `low|medium|high|xhigh|max`, and Codex accepts `none|minimal|low|medium|high|xhigh`
- `--agent-activity-stale-after-ms <ms>` — Override the default agent-runner staleness window. Calyx marks active `agent_runner` health `stale` after this much silence but does not stop the backend by default.
- `--agent-activity-poll-interval-ms <ms>` — Optional recompute cadence for active `agent_runner` health.
- `--agent-inactivity-timeout-ms <ms>` — Opt in to hard inactivity stop for spawn-backed `agent_runner` backends. When this fires, Calyx reports terminal `infra_error` with reason/detail `stalled_inactivity`.
- `--agent-inactivity-stop-grace-ms <ms>` — Grace period between SIGTERM and SIGKILL for the spawn-backed hard inactivity stop.
- `--env <KEY=VALUE>` — Environment override for the selected kernel: backend env for `agent_runner`, process env for `host_process`
- `--ntfy-topic <topic>` / `--agent-mail-thread <thread>` — Notification metadata
- `--foreground` — Execute inline instead of spawning a detached worker. This is local-only; remote launch is always asynchronous and rejects `--foreground` before network access.
- `--runs-root <path>` — Run store root (default: `CALYX_RUNS_ROOT` or `~/.calyx/runs`)
- `--server-url <url>` — Explicit remote RunService base URL
- `--auth-token <token>` — Explicit remote bearer override; otherwise the target host's `operator_cli` credential is resolved.
- `--json` — Print machine-readable launch summary

A remote `202` launch receipt is authoritative even when the immediate follow-up
observation is not yet available. Before the mutation POST, the generated
client reserves the exact request bytes in the encrypted custody described
above. It releases that reservation only after a schema-valid success or
declared definitive API failure. A network interruption, redirect, retryable or
unknown error, or malformed representation retains the artifact and reports
the sole safe replay command. The encrypted artifact contains the generated
headers and exact request body needed for replay, but never the bearer token.

ExecPlan is a prompt/context source, not the identity of every `agent_runner`
run. If `--prompt`, `--prompt-file`, or `--template` is supplied, the launch
defaults to `require_execplan=false`; pass `--require-execplan` to preserve the
strict old behavior. If no direct prompt source is supplied, the launch defaults
to requiring a resolvable ExecPlan from `--execplan-ref` or issue-linked
docstore state.

System prompt file variants are read by the launching CLI before the intent is sent to a local or remote daemon, so the daemon never needs access to the caller's filesystem. Inline and file forms within each pair are mutually exclusive, and each resolved replacement or append string is capped at 32 KiB. Remote dispatch that uses either field requires daemon feature `run.system_prompt/v1`; older daemons refuse before launch and point operators to `calyx self upgrade --host <host>`.

For `agent_runner --backend codex`, the app-server executable is resolved before
spawn with an explicit operator override and a macOS Homebrew preference.
Resolution order: `CALYX_CODEX_BIN` (canonical override), `CODEX_BIN` (alias),
macOS Homebrew defaults (`/opt/homebrew/bin/codex`, then
`/usr/local/bin/codex`), then the first executable `codex` on PATH, then bare
`codex` only when PATH is not available to inspect. On Linux, the default path
remains PATH-compatible with previous behavior; set `CALYX_CODEX_BIN` to bypass
a stale or broken PATH launcher on any host. If an explicit override is invalid,
or if PATH was searchable and no executable exists, launch fails before spawn
with an actionable `Codex executable not found` error.

`agent_runner` supports three worktree modes:

- `existing` uses an explicit pre-existing `--worktree-path` and only writes the Calyx runner lock. This is the backward-compatible default when `--worktree-path` is supplied without `--worktree-mode`.
- `managed` lets Calyx choose the repo-managed worktree path under `<repo-clone-parent>/wt/<branch>`. Omit `--worktree-path` and supply `--repo <slug-or-alias>`. The branch is resolved in this priority order:
  1. `--worktree-branch <branch>` if supplied (explicit caller branch always wins).
  2. Otherwise, when `--issue <id>` is supplied, Calyx derives `calyx-run/<lowercase issue>` (for example, `--issue POL-1325` yields branch `calyx-run/pol-1325`).
  3. Otherwise the launch fails before any git mutation with an actionable error requiring `--worktree-branch` or an `--issue`.

  Two managed launches for the same issue intentionally collide on the same derived branch and worktree path; the runner's `.calyx-runner.lock` enforces one active run at a time. Parallel experiments for the same issue must pass distinct `--worktree-branch` values explicitly.

  When the derived branch already exists locally but the worktree directory has been removed (for example, a prior run was cleaned up), Calyx adopts the existing branch via `git worktree add <path> <branch>` rather than failing on `branch already exists`. For read-only `calyx-review/*` branches, Calyx then resets the managed worktree to the requested pinned ref so repeated reviews do not carry stale heads; the runner refuses that reset for non-review branches or tracked local modifications. Implementation branches such as `calyx-run/*` are preserved rather than reset, so unpushed work is not silently discarded.

- `create` intentionally creates the exact explicit path as a git worktree. Use `--worktree-mode create --repo <slug-or-alias> --worktree-path <path> --worktree-branch <branch>`. `--worktree-branch` is always required for `create`; it is never derived.

For `managed` and `create` modes, when Calyx is about to consume a
remote-tracking ref such as `origin/main` to create a new branch or reset a
review worktree, it first refreshes that ref
with `git fetch <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` in the actual
source clone used for `git worktree add`. A failed refresh refuses acquisition
before branch creation unless the same source clone can verify that the local
remote-tracking ref already matches the advertised remote head, preventing
stale-base phantom deletion diffs without inheriting compare-clone freshness
false positives.
Offline or otherwise unverified remote freshness is intentionally fail-closed
when that ref must be consumed. Plain reuse of an existing managed branch skips
the remote freshness check because `git worktree add <path> <branch>` does not
branch from the remote ref. Use `--worktree-mode existing --worktree-path
<path>` when the operator intentionally wants to run against an already-prepared
local checkout without remote freshness checks.

For `kernel=agent_runner`, Calyx injects run metadata into the backend session
environment before adapter launch: `CALYX_RUN_ID`, `CALYX_RUN_DIR`,
`CALYX_RUN_HOST`, `CALYX_RUN_ISSUE`, and `CALYX_RUN_WORKTREE` when those values
exist. These keys are Calyx-owned receipt identity, so computed metadata wins
over conflicting `--env CALYX_RUN_*=...` values while preserving unrelated
backend env overrides. The metadata contract is intentionally small; Calyx does
not serialize arbitrary run specs or secrets into backend env.

When `host_process` health monitoring is configured, Calyx keeps lifecycle state (`running`, `succeeded`, etc.) separate from workload health. Active runs persist a `health` snapshot on the `RunRecord` and terminal `HostProcessReceipt`, using only explicit progress signals (`stdout`, `stderr`, and watched files) rather than raw child-process liveness.

On Unix hosts, `kernel=host_process` launches the workload in a dedicated process group. `calyx run stop` durably admits a cancellation request. The worker observes that marker, targets the workload process group with `SIGTERM`, waits through `--stop-grace-ms`, and escalates to `SIGKILL` when descendants remain alive after the grace window. Command success proves request admission, not terminal cancellation; observe `calyx run status` for the later terminal state.

### `calyx run resume`

Resume an existing backend session under Calyx lifecycle management. The resumed run gets full lifecycle tracking (receipts, logs, status, stop) and the receipt includes provenance via `metadata.resumed_from_session_id`.

When `--worktree-path` is omitted, Calyx resolves the resume working directory
in order: the most recent stored run for that backend session, then the
same-host interactive activity inventory (the most recent recorded `cwd` for
that session id). The adopted path must exist as a directory on the target
host; it does not need to be a git worktree. Resolution provenance is recorded
on the run as `worktree_source` (`run_spec`, `explicit_flag`, or
`activity_inventory_cwd`) and surfaced in `calyx run status` pickup fields. If
neither source records a usable working directory, or the recorded directory
no longer exists, `calyx run resume` fails loudly — naming what the activity
inventory found — instead of falling back to a shared default worktree.

```bash
# Resume with explicit session ID
calyx run resume <session-id> --prompt "Continue implementing..." [options]

# Resume the most recent session (auto-detect backend)
calyx run resume --last --prompt "Continue implementing..." [options]

# Resume the most recent codex session
calyx run resume --last --backend codex --prompt "Continue implementing..." [options]
```

**Options:**
- `<session-id>` (positional, optional) — Backend session ID to resume; omit when using `--last`
- `--prompt <text>` (required) — Prompt for the resumed session
- `--last` — Discover and resume the most recent session instead of providing an explicit ID
- `--backend <backend>` — Backend (`claude` or `codex`); required with `--last` to scope discovery, or auto-detected
- `--run-id <id>` — Optional run ID (auto-generated UUID if omitted)
- `--host <host>` (default: `local`) — Target host label
- `--profile <profile>` — Backend profile label retained in the run spec/receipts. It does not select a backend model; use `--model <model>` for that.
- `--worktree-path <path>` — Explicit worktree path
- `--dangerously-skip-permissions` — Set `backend_options.dangerously_skip_permissions=true`
- `--foreground` — Execute inline instead of spawning a detached worker
- `--runs-root <path>` — Run store root (default: `CALYX_RUNS_ROOT` or `~/.calyx/runs`)
- `--server-url <url>` — Explicit remote RunService base URL
- `--auth-token <token>` — Explicit remote bearer override; otherwise the target host's `operator_cli` credential is resolved.
- `--json` — Print machine-readable launch summary

**Exit codes:**
- `0` — Resumed session completed successfully
- `1` — Backend process exited with an error
- `2` — Invalid arguments (e.g., missing prompt, conflicting session-id and --last)
- `3` — Session not found (--last with no sessions available)

**Examples:**

Resume a known Claude session:
```bash
calyx run resume sess-abc-123 --prompt "Finish the PR and run pnpm verify" --foreground
```

Resume the most recent session from any backend:
```bash
calyx run resume --last --prompt "Continue where you left off" --json
```

Resume the most recent Codex session in the background:
```bash
calyx run resume --last --backend codex --prompt "Complete the remaining test cases"
```

### `calyx run status`

Show the current operator-facing state for a run.

```bash
calyx run status <id-or-prefix> [--host <host>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--details] [--json]
calyx run status --run-id <id-or-prefix> [--host <host>] [options]
```

`<id-or-prefix>` accepts a full run id or a unique short prefix. If a prefix is
ambiguous, Calyx lists the matching runs and asks for a longer handle. `--run-id`
remains supported for scripts. `--host <host>` queries the authenticated
RunService for that host using `fleet/truths/hosts.yaml` when `--server-url` is
omitted.

The default plain-text view is a compact one-shot snapshot for conductor
pickup. It prints cause, partial reason when present, and the typed next
operation before bounded identity, diagnostics, health freshness, artifact
counts, and the explicit detail operations. It never
prints summaries, terminal-message bodies, filesystem paths, or artifact names.
The text result targets 1,024 bytes and has a 4,096-byte hard ceiling. Add
`--details` to enter the explicit expanded text tier, which includes
health/recovery detail, paths, artifact names, and exact follow-up commands.

`--json` returns a compact `calyx.run-status/v2` projection. Lifecycle,
normalized `cause`, `partial_reason`, and `next_action` lead the object;
continuation, identity, timestamps, diagnostics, bounded health freshness, and
artifact counts follow. Continuation
preserves accepted non-secret `--host`, `--runs-root`, and `--server-url`
addressing once; authentication tokens are never emitted. Explicit
`--host`, `--runs-root`, and `--server-url` values that cannot fit the exact
continuation contract are rejected before handle resolution or any run read.
Externally sourced strings are projected through field byte caps, and
schema-valid timestamps are canonicalized to millisecond ISO form. The normal
target is 4,096 bytes and the hard ceiling is 16,384 bytes. Field-level caps and
omissions are reported under `response_economics.overflow`; Calyx never repairs
an oversized result by chopping serialized JSON. The payload and interface
manifest declare the text and JSON budgets separately under
`response_economics.formats`.

Default output size is independent of the stored prompt, resolved spec, run
record, receipt, health observations, artifact names, and filesystem paths.
Those classes are declared under `response_economics.omitted_classes`, with
one narrow declared exception for the exact accepted non-secret
`continuation.scope.runs_root` address. Typed detail operations sit alongside
that disclosure policy. Use the canonical `terminal` and
`successful` booleans rather than copying Calyx's private run-state union into a
caller. Use `run receipt` or `run kernel-receipt` when the authoritative full
record or execution evidence is actually required. `--details` does not expand
the JSON schema.

For terminal `infra_error` runs, the plain-text view also prints
`infra_error: <failure_layer>/<failure_reason>` and, when available,
`infra_message: <message>`. `--json` returns the bounded typed diagnostic
under `diagnostics.infra_error`, including `failure_layer`,
`failure_reason`, and a message with explicit field-level overflow metadata when
needed.

For active runs with health monitoring enabled, including default `agent_runner`
freshness and configured `host_process` health, the detailed plain-text view
prints:

- lifecycle state
- `updated` time
- `health` status (`healthy`, `stale`, or `unknown`)
- `health_checked`
- `last_progress`
- `stale_after`
- `progress_source`, `progress_signal`, and `progress_signal_reason` when the
  backend exposes a typed progress channel; `progress_expected_silence_until`
  when a bounded backend retry interval currently extends freshness
- `terminal_source` and `terminal_reason` after typed terminal evidence exists

### `calyx run await`

Wait finitely for a run to reach a canonical terminal state.

```bash
calyx run await <id-or-prefix> [--host <host>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--timeout <duration>] [--require-success] [--json]
calyx run await --run-id <id-or-prefix> [--host <host>] [options]
```

Addressing and remote authentication match `calyx run status`. The default
timeout is `1h`; explicit durations accept positive integer `ms`, `s`, `m`, or
`h` units. `run await` returns immediately when the first authoritative status
read is terminal. Otherwise it establishes the local run-directory watcher or
remote durable event-stream boundary, immediately rereads canonical status to
close the subscription race, and reconciles status after watcher/stream
disconnects before reconnecting. Stream replay is cursor-resumable and
duplicate terminal events are harmless because `run_record.json`, not the
event, remains the source of truth.

`--json` emits exactly one `calyx.run-await/v2` object for completion or
timeout. It contains `terminal`, `successful`, `timed_out`, the final state,
the same bounded outcome/diagnostics/health/artifact/continuation projection
as `run status`, and bounded last-terminal-event references when one
participated in completion. Both JSON surfaces use compact encoding and the
same 4,096-byte target / 16,384-byte hard contract. Timeout emits the final
observed canonical state and exits 124. Ctrl-C exits 130. Neither case cancels,
stops, resumes, or otherwise mutates the run.

Without `--require-success`, a successfully observed terminal run exits 0 even
when the workload failed. With `--require-success`, the JSON or human result is
written first and the workload outcome then maps to these stable exit codes:

| Final state | Exit code |
|-------------|-----------|
| `succeeded`, `completed_dirty` | 0 |
| `failed`, `cancelled` | 1 |
| `partial` | 2 |
| `infra_error` | 6 |
| `auth_error` | 8 |

Use `run status` for a one-shot snapshot and `run await` for a bounded wait.
Callers should consume `terminal` and `successful`; they should not implement a
polling loop or maintain their own terminal-state list.

### `calyx run receipt`

Print the authoritative `run_record.json` view for a run.

```bash
calyx run receipt <id-or-prefix> [--host <host>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run receipt --run-id <id-or-prefix> [--host <host>] [options]
```

When present, `RunRecord.health` is the last persisted active-health snapshot.
For `host_process` and `agent_runner`, the terminal kernel receipt also carries
the final `health` snapshot where available so operators can see whether the run
exited after recent progress or after a stale window. Agent-runner snapshots are
sparse. Claude snapshots record completed semantic facts from the structured
stream and expose a typed progress source, availability, and reason; they never
include raw thinking, partial deltas, tool arguments, or tool results. An
unavailable or failed Claude semantic channel is `unknown`; only an established
channel can age into `stale`.

Plain-text receipt output includes the same pickup fields as `run status`:
short handle, issue/host/backend, worktree, branch, run record path, kernel
receipt path, event log path, artifact counts/names, and follow-up commands.
For terminal `infra_error` runs, it also includes the same `infra_error` and
`infra_message` lines; `--json` returns the authoritative
`RunRecord.infra_error_classification` payload.
When present, plain text also prints `terminal_source`, `terminal_status`,
`terminal_reason`, and the backend subtype. JSON retains the full bounded
`terminal_evidence` object, including numeric usage and malformed/unknown record
counts. `run ps` and activity JSON carry only those bounded facts. The full
final assistant message remains on the canonical status/receipt and terminal
lifecycle event rather than being duplicated into list/activity rows.

### `calyx run kernel-receipt`

Print the raw kernel receipt emitted by the selected execution kernel.

```bash
calyx run kernel-receipt <id-or-prefix> [--host <host>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run kernel-receipt --run-id <id-or-prefix> [--host <host>] [options]
```

### `calyx run doctor`

Inspect a run through the bounded `run-observation/v1` read model. This is the
operator pickup surface for questions that cross normal command boundaries:
log source freshness, required artifact liveness, worker pid status, and host
GPU/resource availability. It also includes run-attributed resource evidence
from the visible worker process tree and NVIDIA compute-process rows when those
providers are available. Daemons that include this richer payload advertise
`run.resource_attribution/v1`; newer CLIs degrade to a clear unavailable line
when pointed at an older daemon. Launches that declare `--artifact-root <path>`
also get bounded output-root summaries for existence, file count, newest mtime,
and truncation.

```bash
calyx run doctor <id-or-prefix> [--host <host>] [--tail <n>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run doctor --run-id <id-or-prefix> [--host <host>] [options]
```

`--json` returns `run-observation/v1` with:

- the compact run state and persisted health snapshot;
- run/worktree paths;
- worker pid liveness when a pid is recorded;
- `resource_attribution` with process-tree CPU/RSS totals and NVIDIA
  compute-process rows mapped back to the run tree when possible;
- `run-logs/v1` source summaries for stdout/stderr without dumping log bodies;
- required/discovered artifact status, size, and modification time when paths
  exist;
- declared artifact root status, file count, directory count, total byte size,
  newest modification time, and whether the bounded scan truncated;
- a best-effort host resource snapshot. The first provider is `nvidia-smi`;
  hosts without that command report `gpu.status = "unavailable"` rather than
  faking GPU telemetry.

Use `calyx run logs` when you need log bodies. Use `calyx activity turns
run:<id>` when you need the latest semantic assistant turn. `run doctor` is the
reconciliation view that tells a conductor whether those sources are alive and
where to look next.

### `calyx run ps`

List known runs from the RunService store. Add `--include-interactive` to fold
recent Codex and Claude sessions from the target host's harness session stores
into the same activity list.

```bash
calyx run ps [--runs-root <path>] [--host <host>] [--include-interactive] [--agent-kind <all|codex|claude>] [--since-hours <hours>] [--limit <n>] [--server-url <url>] [--auth-token <token>] [--json]
```

Plain-text output includes a header and the columns `SHORT_ID`, `STATE`,
`HEALTH`, `HOST`, `ISSUE`, `BACKEND`, `BRANCH`, `UPDATED`, and `SUMMARY`. Runs
without a persisted health snapshot render `-`. The summary column strips the
tautological `Run <id> <state>` prefix when the state column already carries
that information. Claude agent-runner summaries retain the semantic progress
source/reason while active and append `terminal=<source>/<reason>` after typed
terminal evidence exists, so the compact list agrees with status, receipt, and
activity projections without copying private stream payloads. Interactive
sessions render with state `interactive`, backend
in the backend column, and health `-`. Remote host queries use the
authenticated RunService for that host; when `--server-url` is omitted, Calyx
uses the host's `run_serve_url` from agents-infra truth and falls back to
`http://<host>:8740`.

`--limit` caps the recent Calyx run list. With `--include-interactive`, it caps
the final activity list after Calyx runs and interactive sessions are merged and
sorted by recent activity.

Examples:

```bash
calyx run ps --include-interactive
calyx run ps --include-interactive --host mba --agent-kind codex --since-hours 12 --json
```

### `calyx run activity` (deprecated — use `calyx activity ...`)

Each `calyx run activity ...` invocation now prints a stderr deprecation
warning pointing to `calyx activity ...`. The behavior is unchanged — these
forms remain available for compatibility. Inspect bounded detail from
interactive Codex and Claude sessions discovered by
`calyx run ps --include-interactive`. Interactive activity IDs have the form
`interactive:<codex|claude>:<session-id>`.

```bash
calyx run activity show --activity-id <id> [--host <host>] [--around <line-or-query>] [--context <n>] [--tail <n>] [--include-tools] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run activity logs --activity-id <id> [--host <host>] [--tail <n>] [--include-tools] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run activity export --activity-id <id> [--host <host>] [--around <line-or-query>] [--context <n>] [--tail <n>] [--include-tools] [--format <markdown|json>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
```

By default, activity detail returns a small recent slice and hides tool call and
tool output bodies. Use `--around` to center the slice on a line number, event
index, or text match; use `--include-tools` only when the tool transcript is
needed. Remote detail queries are gated on daemon feature
`interactive.activity_detail/v1`.

Examples:

```bash
calyx run activity show --activity-id interactive:codex:019dcafe --around "RunService is not answering"
calyx run activity logs --activity-id interactive:claude:a0db0b5e --tail 20 --json
calyx run activity export --activity-id interactive:codex:019dcafe --include-tools --format markdown
```

### `calyx run logs`

Print persisted lifecycle and integration events for a run, plus bounded
stdout/stderr stream tails when the run has persisted stream logs. Stream
entries preserve stream identity (`stdout` or `stderr`); stderr is not treated
as a failure severity by itself.

```bash
calyx run logs <id-or-prefix> [--host <host>] [--tail <n>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run logs --run-id <id-or-prefix> [--host <host>] [options]
```

`--json` returns a `run-logs/v1` object with typed entries, source summaries,
and truncation warnings. Human output labels stream lines as
`[host_process:stdout]`, `[host_process:stderr]`, or `[run_worker:<stream>]`.
Local reads may enrich that payload from the local backend-session file. Remote
reads remain daemon-authoritative and never dereference the remote record's
session path on the caller host.

### `calyx run audit-terminal-authority`

Read-only pre-deploy audit for the already-materialized local terminal-event
graph. It prefers `events.authority.sqlite3`; when SQLite is absent, it strictly
parses the predecessor `events.index.jsonl` authority instead:

```bash
calyx run audit-terminal-authority [--runs-root <path>] [--json]
```

Run this locally on each daemon host before promoting the infra-error census,
for example on `carbon`, `blade`, and `mba`. It never runs startup preparation,
imports JSONL into SQLite, repairs projections, rewrites historical events, or
calls a remote daemon. If SQLite exists, it is the only source inspected and a
malformed sibling JSONL file is ignored. If SQLite is absent, every JSONL row
must be newline-committed, schema-valid, uniquely identified, and cursor-ordered;
otherwise the command exits `6` instead of creating or repairing authority.

A completed audit emits
`calyx.infra-error-census-authority-audit/v1`. Its `authority_source` is
`sqlite` or `legacy_jsonl`. It reports bounded event-ID-only
locators for legacy chain roots and graph ambiguities, plus authoritative totals
and `truncated`; terminal summaries, classifications, messages, prompts, and
paths are never included. Exit `0` means the graph is safe to project. Exit `1`
means the audit completed but a missing parent, cross-run edge, branch, cycle,
duplicate incarnation root, or incarnation conflict blocks deployment.
Across both locator arrays and their nested event IDs, the receipt admits at
most 1,024 locators and 64 KiB of locator text. A single event ID over 256 bytes
is represented by its SHA-256 locator; any hash substitution or omitted nested
locator sets `truncated=true`. Deployment-blocking ambiguity locators receive
the shared budget before the informational legacy-root inventory.

The projection law is the same one used by
`calyx_run_infra_error_current`: each chain containing a pre-POL-2009 terminal
event is identified by its immutable root event ID, while fully current chains
use their durable `(run_id, incarnation_id)` claim. Only the unique current leaf
contributes. Distinct legacy roots remain distinct even when run IDs and
timestamps repeat. A chain mixing legacy and UUID identities is malformed, and
ordinary run-record updates cannot change the incarnation of an extant claim.
Terminal corrections follow the unique supersession leaf rather than producer
wall-clock order. Leaf selection walks the globally connected indexed terminal
component in both directions, so an incoming edge from another run cannot be
hidden by a per-run filter before correction publication.

Runtime startup validates the complete raw SQLite authority, then protects its
identity columns as append-only. Each later raw row advances a validation
high-water exactly once before indexed `event_type`/`run_id` replay may observe
it; indexed queries are capped at that validated ordinal. Nonmatching control
tails therefore do not rescan on every exporter interval or filtered SSE drain,
while denormalized-column drift still cannot hide an event. The additive
`supersedes_event_id` index is backfilled at startup, and compatibility triggers
derive it for rolling older writers that do not yet supply the column.

Historical bounded label tuples are exported at zero after
a correction so a long-lived OpenTelemetry gauge cannot retain stale positive
classifications.

This JSONL fallback exists only for the read-only pre-deploy audit of hosts that
have not yet prepared SQLite. The live metric continues to consume the
startup-prepared SQLite replay authority; JSONL is not a second runtime metric
authority.

### `calyx run stop`

Durably request cancellation of a detached run. The worker observes the request and performs kernel-specific shutdown. A successful command proves cancellation-request admission; it does not prove that the run is already terminal. Observe `calyx run status` for terminal cancellation.

```bash
calyx run stop <id-or-prefix> [--host <host>] [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
calyx run stop --run-id <id-or-prefix> [--host <host>] [options]
```

### `calyx run reconcile`

Classify incomplete runs after orchestrator loss without claiming orchestration resumption.

```bash
calyx run reconcile [--runs-root <path>] [--server-url <url>] [--auth-token <token>] [--json]
```

Local and remote execution both return the canonical
`calyx.admin-reconcile-result/v1` receipt. The result includes a discriminated
`projection` repair outcome. A failed
run-index repair is reported as incomplete and exits nonzero; it is never
collapsed into a successful reconciliation receipt.
Noncanonical-directory reporting is a bounded v1 summary: `changed` carries
the authoritative total while the current writer's
`noncanonical_directories` array carries exactly `min(total, 64)`
length-bounded examples. The rolling reader additionally accepts the exact
predecessor's full array and longer example strings, so a mixed-version fleet
does not reject an otherwise valid receipt. A greater total than the current
array length is the truncation signal; omitted examples never permit a
completed status. Unresolved rows remain unique, their reason histogram must
sum to the authoritative unresolved total, and any one-way incomplete signal
forces the normalized receipt to `incomplete`.

The versioned `events.authority.sqlite3` database under the physical runs root
is the global replay and cursor authority. Reconciliation validates its schema
and sequence, then exact-idempotently backfills `events.index.jsonl`, per-run
receipts, and the state `event_log`; lexical and symlink aliases cannot create a
second sequence. Corrupt global-receipt bytes remain in place and block further
global-receipt publication, but can neither shrink SQLite replay history nor
recycle a committed cursor. A corrupt per-run projection stays pending until
RunService can make the authority-aware quarantine decision. An existing legacy
JSONL authority is imported once only after a fail-closed full validation.

Remote reconciliation posts only to
`POST /v1/admin/runs/reconcile-preserving/v1`. The versioned route's existence,
not a prior health response, is the mutation-time proof that noncanonical
run-root entries are preserved. The predecessor route is deleted rather than
retained as a compatibility shim.

### `calyx run daemon`

Symphony-style daemon lifecycle commands over a project's `WORKFLOW.md`. The daemon claims eligible tracker issues, dispatches `calyx run launch` per issue, and persists state under `--daemons-root` (default `~/.calyx/daemons`).

Manual tick for the calyx repo's root `WORKFLOW.md` (no long-running process required):

```bash
calyx run daemon plan --project calyx --json
calyx run daemon tick --project calyx --json
```

`plan` is read-only: it polls the tracker, reads daemon state when present, and returns eligible issues, skipped issues with reasons, active run state, available launch slots, selected issues, warnings, reconciliation flags, and a safe/unsafe verdict. It does not claim issues, move tracker state, create worktrees, launch runs, or post handoff comments.

A tick is deterministic: it first evaluates the same preflight verdict, then polls the tracker, claims eligible issues, launches one run per claim up to `max_concurrent_agents`, and prints the launched runs, current active-run count, eligible-issue count, warnings, and `next_poll_at`. Workflows may set `selection.max_selected_issues` as a hard selection cap distinct from `max_concurrent_agents`; if a tick would select more than the cap, launch is rejected before any claim. Daemon handoff defaults to `In Review`; `handoff_state: Done` is rejected unless the workflow explicitly sets `workflow_policy.allow_done_handoff: true`.

Subcommands: `start`, `status`, `logs`, `stop`, `plan`, `tick` (run `calyx run daemon <subcommand> --help` for full options).

### `calyx run serve`

Start the authenticated run-control plane over `@polli-labs/calyx-server`.

```bash
calyx run serve [--host <host>] [--port <port>] [--runs-root <path>] [--worktree-base <path>] [--monitor-interval-ms <ms>] [--message-outbox-interval-ms <ms>] [--activity-tailer-interval-ms <ms>] [--no-activity-tailer] [--json]
```

`run serve` starts the monitor evaluator in-process. The evaluator uses the
same run store and event stream as the server; it does not start a second
daemon. `--monitor-interval-ms` defaults to `5000`. Monitor delivery bindings
are dispatched from this evaluator after the unconditional Tier-0 wake row/JSONL
receipt path succeeds.

`run serve` also starts the POL-1789 message sender outbox forwarder. The
forwarder opportunistically drains local `outbox` rows to recipient-host
`/v1/internal/messages/receive` endpoints with the selected host-daemon credential, retries transient failures, and marks entries older
than 72 hours `delivery_failed`. `--message-outbox-interval-ms` defaults to
`15000`.

`run serve` also starts the POL-1838/POL-1839 activity tailer in-process. The
tailer watches the harness-native transcript roots (`~/.codex/sessions`,
`~/.claude/projects`) plus Calyx run event streams (`~/.calyx/runs/*/events.jsonl`),
resumes each source from its persisted byte cursor (`activity_source_cursors`),
feeds the bytes through the same streaming reader and semantic-origin normalizer
that `calyx activity` uses, strips attachments to `att:sha256:` refs, and upserts
normalized rows into `activity_messages` idempotently on `content_hash`.
Migration `0014` adds per-message `timestamp`, nullable `payload_json`, and the
metadata-only `activity_attachments` table (`sha256`, `mime`, `byte_size` plus
message/origin linkage); attachment bytes remain lazy-fetched from the origin
transcript or daemon. It is a debounced file-watch plus an interval backstop
(`--activity-tailer-interval-ms`, default `15000`), not a second daemon; pass
`--no-activity-tailer` to disable it.

Each tick cheaply discovers the *whole* local transcript history, then fully
reads and ingests a bounded **page** of up to 500 sources that still need work
(no cursor, an un-ingested tail, or a classifier bump), newest first. Sources
beyond that page are registered as `pending` cursors — so a read reports
`behind` (the tailer is catching up), never `absent` (silently unindexed) — and
backfill across subsequent ticks until the store has covered the entire history,
then steady-states on whatever is freshest. So a daemon started against a host
with thousands of prior transcripts eventually indexes all of them while staying
bounded per tick; `calyx state doctor --domain activity` reports the remaining
backlog as `activity-index-pending-sources`. The store is per-host,
privacy-neutral, and rebuildable from transcripts; `calyx activity messages` and
`calyx activity turns` carry a `recall_freshness` block reporting how current the
store is for the read source. When freshness is `fresh`, the classifier version
matches, and every row has `payload_json`, local `messages`/`turns` reads are
served from the store and keep the agent-facing DTO contract byte-equivalent to
the live projection. Behind, absent, classifier-stale, or pre-0014 rows fall
back to the live truth-plane parse. Cross-host blade aggregate shipping remains
outside this local read-flip slice.

Runtime probes:
- `GET /livez` is unauthenticated liveness only and returns `{"ok":true}` when the HTTP listener is up.
- `GET /v1/admin/health` is control-plane bearer-protected and returns the bounded admin health projection. Full daemon-only health is `GET /v1/internal/health`.

### `calyx run execute-stored`

Internal worker entrypoint used by detached `calyx run launch` executions to realize a persisted intent from the run store.

```bash
calyx run execute-stored --run-id <id> [--runs-root <path>]
```

## Message Commands

POL-1789 message commands manage Calyx correspondence rows. Messages are a
separate noun from activity projection: `calyx activity` recalls what happened,
while `calyx msg` creates explicit correspondence with inbox, ack, thread, and
delivery state.

Directed messages target a single recipient address and behave like a claimable
queue. Scope messages target a host or fleet bulletin board and are peek-only.
Remote writes are sender-host canonical: the CLI submits to its current/source
daemon with that daemon's local consumer credential and grant-authorized reply
address. The source daemon writes the message plus an `outbox` row atomically,
returns `202` with the operation locator, then `run serve` forwards to the target
host daemon. The recipient address selects the outbox destination; it never
selects the CLI's consumer credential or submission endpoint. Unreachable target
daemons leave durable source outbox evidence; the CLI does not silently open a
remote SQLite database or report direct-to-recipient success.

Message timestamps distinguish durable storage from confirmed delivery:
`spooled_at` means the row reached a durable message store, while
`delivered_at` is set only after a delivery adapter confirms delivery (for
example an authenticated daemon-outbox acknowledgement or an exact
session-ingress receiver accepting a pointer). A bare send is
durable-only for every recipient type: it never launches or resumes a turn,
claims a message, or acknowledges it. `--wake` is the only live acceleration
mode. It spools first, then attempts one body-free pointer delivery to one exact,
generation-bound activity ingress lease. The send result keeps durable
`delivery_state` separate from `wake_state`, so agents do not infer handling
from transport acceptance.

Address forms:

- `run:<id>` — directed message for a Calyx run. With `--wake`, Calyx may resolve
  the run's exact backend activity binding; unresolved runs remain durably
  spooled with `wake_state=target_unresolved`. No run target implicitly resumes
  a turn or auto-acks.
- `interactive:<backend>:<session-id>` — directed pointer for an interactive
  Codex or Claude session.
- `<backend>:<host>:<session-id>` — POL-1774 authorship alias, normalized to an
  `interactive:<backend>:<session-id>` recipient with the embedded host.
- `role:<name>[@host]` or unqualified `<name>` — directed role inbox. An
  unqualified role resolves to the coordinator host.
- `host:<host>` — scope bulletin for one host.
- `fleet` — scope bulletin owned by the coordinator host.

Scope messages require a TTL through `--ttl-ms` or `--expires-at`. Directed
messages may be claimed by `calyx msg inbox`; `calyx msg inbox --peek` reads
without claiming. Claimed messages whose claim expires cycle back to pending;
after the bounded retry cycle they become `dead_letter`.

### `calyx msg send`

Send a directed message or scope bulletin.

```bash
calyx msg send --to <address> --subject <text> [--body <text>|--body-file <path>] [--thread <key>] [--reply-to <message-id>] [--idempotency-key <key>] [--urgency low|normal|high] [--ack-required] [--ttl-ms <ms>|--expires-at <iso>] [--host <host>] [--coordinator-host <host>] [--server-url <url>] [--auth-token <token>] [--spool-only] [--wake] [--json]
calyx msg send --replay-request <artifact-path> [--auth-token <token>] [--json]
calyx msg send --to-active host:<host> --subject <text> --body <text> [--json]
```

`--to-active` fans out to the currently observable interactive sessions returned
by `calyx run ps --include-interactive` for one explicit host scope; it does
not create a scope bulletin. Fleet-wide active-session fan-out is not
implemented, so use `host:<host>` to keep the target query explicit. Each
active listener receives a directed message with its own row and receipt.
`--wake` cannot be combined with `--to-active`; that ambiguous fan-out is
rejected before session discovery or any durable write.

Remote inert correspondence uses the same durable exact-wire recovery law as
remote run launch. `--server-url` and `--auth-token` select an enrolled source
daemon's submission authority, not the recipient daemon. They are rejected for a
cross-host `--wake`: exact-session ingress resolves only through named-host
truth and the authenticated admin control plane. The inert-correspondence
artifact freezes its source origin, generated idempotency key, and absolute
`expires_at` resolved from `--ttl-ms`, so a later replay cannot extend the
bulletin lifetime.
Use only the reported `calyx msg send --replay-request <path>` command after an
indeterminate result; reconstructing the send from ordinary flags is not an
equivalent retry.

`--wake` accepts only an exact `interactive:<codex|claude>:<session-id>` target,
an authorship alias that normalizes to one, or a `run:<id>` that resolves to one.
Role, client, host, fleet, and other ambiguous targets are rejected before any
write. After spooling succeeds, missing/expired bindings, unsupported
capabilities, and definitive adapter failure return exit 0 with
`delivery_state=spooled`, a non-success `wake_state`, and the human line
`MESSAGE SPOOLED; WAKE NOT DELIVERED`. Do not retry the whole command: the
durable message already exists. `wake_delivered` only means the private receiver
accepted the pointer; the recipient must still pull/claim it with `msg inbox`
and explicitly `msg ack` after handling.

Session wake uses the deterministic `delivery_id` as generated retry authority.
If exact replay finds the persisted crash-window state `attempted`, the daemon
returns `wake_state=delivery_indeterminate`, the CLI reports
`MESSAGE SPOOLED; LIVE WAKE DELIVERY UNKNOWN`, and no second daemon-local session-ingress wake is
sent. The wake may already have arrived; use the durable inbox as authority and
never resend the message or reconstruct a wake request from this result. A
client-side response loss after dispatch has the same unknown-delivery
semantics and reports the exact encrypted `calyx client replay <receipt>`
command when recovery custody is available.

Cross-host exact-session wake submission first writes a sender outbox row and
synchronously proves destination durable admission through authenticated
`/v1/internal/messages/receive`. Only then does it preflight the destination
daemon's `session.wake/v1` feature and call the strict pointer-only
`POST /v1/admin/session-wakes/deliver` operation. That daemon resolves the exact
generation-bound binding, rejects a ghost message pointer, and performs private
IPC. Missing named-host access,
an older daemon, or a definitive transport failure leaves the durable message intact and
returns a typed `destination_unavailable`, `destination_unsupported`, or
`transport_failure` wake state with exit 0. No socket path, endpoint reference,
receiver token, message body, caller URL, or caller bearer crosses this route.
If the source daemon loses the generated forward response after dispatch,
destination admission is instead `message_forward_indeterminate`: live wake is
not attempted, the result stays in sender-outbox custody, and the CLI reports an
exact `calyx msg operation <outbox-id> --server-url <source-endpoint> --json`
command. The origin, port, and base path are part of that observation authority;
an absent or unchanged observation is inconclusive, and the forward must not be
repeated blindly.
Bare remote execution-capable recipients also use the normal durable sender
outbox without invoking the Consumer API; they simply do not synchronously
forward or attempt live ingress unless `--wake` is explicit.

Ordinary Claude and Codex sessions do not register ingress. The Calyx package
contract prepares a one-use launch nonce and private endpoint reference; an
explicit conductor lifecycle exchanges that nonce after the harness exposes the
real session id, renews the generation-bound lease by heartbeat, and retires the
same generation on `SessionEnd`. The launcher/hook configuration that selects
conductor mode is owned by POL-2007 and is not silently added to normal launchers.

Examples:

```bash
calyx msg send --to run:abc123 --subject "Baton" --body "Continue from the latest receipt." --ack-required --json
calyx msg send --to interactive:claude:<session-id> --subject "Review ready" --body "Pull the durable handback." --wake --json
calyx msg send --to role:conductor --subject "Review ready" --body "PR is open; issue remains In Review." --json
calyx msg send --to host:blade --subject "Heads up" --body "Daemon restart at 23:00Z." --ttl-ms 3600000 --json
calyx msg send --to-active host:blade --subject "Thread moved" --body "Use the new issue receipt." --json
```

### `calyx msg reply`

Reply to a message without remembering the `send --reply-to` shape.

```bash
calyx msg reply <message-id> [--to <address>] [--subject <text>] [--body <text>|--body-file <path>] [--thread <key>] [--idempotency-key <key>] [--urgency low|normal|high] [--ack-required] [--host <host>] [--json]
```

Without `--to`, `reply` defaults to the original sender; if the current sender
matches the original sender, it replies to the original recipient instead. The
new message keeps the original thread key when present, sets `reply_to` to the
positional message id, and otherwise behaves like `calyx msg send`.

Example:

```bash
calyx msg reply msg_123 --body "Handled; receipt is on the issue." --json
```

### `calyx msg inbox`

Read directed inbox messages or peek scope bulletins.

```bash
calyx msg inbox [--for <address>] [--peek] [--claimed-by <activity-id>] [--claim-ttl-ms <ms>] [--limit <n>] [--json]
calyx msg inbox --scope host:<host> [--limit <n>] [--json]
calyx msg inbox --scope fleet [--limit <n>] [--json]
```

Without `--for`, the directed inbox defaults to the current activity identity
when available. Scope inboxes are always peek-only.

### `calyx msg ack`

Acknowledge a directed message.

```bash
calyx msg ack <message-id> [--acked-by <activity-id>] [--json]
```

### `calyx msg thread`

Show messages by thread key.

```bash
calyx msg thread <thread-key> [--limit <n>] [--json]
```

### `calyx msg operation`

Observe one exact cross-host sender-outbox operation and its terminal receipt.

```bash
calyx msg operation <outbox-id> [--host <source-host>] [--server-url <source-endpoint>] [--auth-token <token>] [--json]
```

With no remote selector, the command reads the local message state store. The
indeterminate-forward path always reports `--server-url` so reconciliation is
bound to the original source-daemon origin, port, and base path rather than a
mutable host alias. Re-supply credentials through `--auth-token` or the selected
host's configured operator credential; bearer material is never printed.

### `calyx msg doctor`

Inspect message schema parity and pending counts.

```bash
calyx msg doctor [--json]
```

Daemon route used by recipient-host forwarding:

- `POST /v1/internal/messages/receive` — authenticated daemon-to-daemon sender outbox delivery into the receiving
  daemon's message state store. The route accepts the `calyx.msg-forward/v1`
  request contract (whose retained wire discriminator is `calyx.msg-send/v1`), returns
  `calyx.msg-receive/v1`, preserves remote sender receipt paths as evidence,
  and is correspondence-only even for explicit `run:<id>` targets. Execution
  requires a separate control-plane-authorized operation.
## Lease Commands

POL-1790 lease commands provide typed conflict evidence for named resources.
Lease keys are:

- `worktree:<host>:<absolute-path>`
- `session:<activity-id>`
- `vault:<path>`
- `issue:<id>`

`worktree` and `session` leases are owned by the resource host. `vault` and
`issue` leases are owned by the coordinator host, which defaults to `blade` and
can be overridden with `--coordinator-host` or `CALYX_COORDINATOR_HOST`.
Mutations for a remote owner go through that owner's authenticated `calyx run
serve` daemon using its named `operator_cli` credential (`--auth-token` is an
explicit override). If the owning host is unreachable, acquisition fails
closed with a typed owner-daemon error instead of writing fallback local state.
Acquire, renew, release, and steal carry caller-generated idempotency keys and
use encrypted pre-dispatch recovery custody. If their result remains
indeterminate, replay only the reported `calyx client replay <path>` command.

Leases are advisory conflict records except where Calyx owns the action path:
`calyx run launch` refuses a worktree whose DB lease is actively held by another
holder. The `.calyx-runner.lock` file remains a crash-safety belt, but the lease
row is the dispatch truth. Expiry does not silently reopen a run-held worktree:
an expired `run:<run-id>` worktree row remains fenced until terminal-run
reconciliation releases it or an operator explicitly steals it. When a
historical publisher is gone but its inherited process group may still be
using the worktree, Calyx records a typed resource quarantine in the row. That
quarantine survives TTL expiry and generic terminal GC; ordinary acquire,
renew, and release remain blocked until independently proven resource
settlement performs an authority-bound release. Malformed quarantine evidence
fails closed. Every automatic terminal release first commits a monotonic lease
ledger receipt. An API-attributed run-journal projection is complete only when
an exact receipt observation is bracketed by a matching
`terminal_lease_release` intent and completed result under the same request
provenance. Reconciliation recovers either torn write boundary from that receipt
and never releases a later holder of the key.

Common mutation options:

- `--holder <activity-id>` — holder recorded in the lease row.
- `--ttl-ms <ms>` — lease TTL, default `1800000`.
- `--coordinator-host <host>` — owner for `vault:` and `issue:` keys.
- `--server-url <url>` — explicit owning daemon URL.
- `--auth-token <token>` — bearer token for the owning daemon.
- `--json` — machine-readable output.

### `calyx lease acquire`

Acquire a lease when no active holder owns it. Reacquiring with the same holder
renews the row; a different active holder returns holder evidence and exits
with code `6`. An expired run-held worktree or resource-quarantined worktree
also exits with code `6` and retains the historical holder evidence.

```bash
calyx lease acquire <key> --holder <activity-id> [--ttl-ms <ms>] [--coordinator-host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

Examples:

```bash
calyx lease acquire "worktree:blade:/home/caleb/dev/calyx/wt/calyx-run/pol-1790" \
  --holder "codex:blade:<session-id>" \
  --json

calyx lease acquire "issue:POL-1790" --holder "run:<run-id>" --json
```

### `calyx lease renew`

Renew a lease held by the supplied holder. Renewal fails if the lease is
missing, expired, held by another holder, or resource-quarantined. Quarantine
blocks renewal even by the recorded holder.

```bash
calyx lease renew <key> --holder <activity-id> [--ttl-ms <ms>] [--coordinator-host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

### `calyx lease release`

Release a lease. By default the holder must match; `--force` bypasses the holder
match for operator repair. Ordinary release cannot clear an expired run-held
worktree fence or resource quarantine; terminal reconciliation owns the safe
automatic path, while `--force` is the explicit operator override.

```bash
calyx lease release <key> [--holder <activity-id>] [--force] [--coordinator-host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

### `calyx lease steal`

Explicitly take over a lease and record provenance plus previous-holder
evidence. When a `calyx msg` notification surface is present, steal should notify
the previous holder there; this build feature-detects that sibling surface and
falls back to receipt-only notification evidence when it is absent.
Steal is also the explicit override for an expired run-held worktree or resource
quarantine and should be used only after ownership transfer or resource
extinction is independently proven.

```bash
calyx lease steal <key> --holder <activity-id> --provenance <text> [--ttl-ms <ms>] [--coordinator-host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

### `calyx lease list`

List leases from the local state store or a selected owning-host daemon.

```bash
calyx lease list [--holder <activity-id>] [--kind <worktree|session|vault|issue>] [--owner-host <host>] [--include-expired] [--limit <n>] [--server-url <url>] [--auth-token <token>] [--json]
```

### `calyx lease doctor`

Inspect lease schema parity, row count, and expired-row count. This is the
focused form of `calyx state doctor --domain leases`.

```bash
calyx lease doctor [--json]
```

## Monitor Commands

POL-1732 monitor commands manage typed wake records and delivery state. Durable
delivery is unconditional: SQLite wake row, JSONL receipt, and the existing SSE
event stream. POL-1732b adds optional human-facing delivery bindings for `ntfy`,
`linear_comment`, and `vault_receipt`. Each binding has its own materiality
filter; failed notifications leave the wake pullable through
`calyx monitor inbox`. Agent wakes use the exact, generation-bound session
ingress path documented under `calyx msg send --wake`; there is no parallel
backend-specific receiver or continuation command. Wake retention is
indefinite. `agent-mail` is not a delivery adapter.

Remote monitor create and wake claim are keyed generated-client writes with the
same encrypted pre-dispatch recovery law. If either remains indeterminate, use
only the reported `calyx client replay <path>` command. Peek/list/show remain
reads; ack and cancel are unkeyed writes reconciled through `monitor inbox` and
`monitor show` as specified by the wire contract.

### `calyx monitor create`

Create a conductor/operator-owned monitor from a bounded preset.

```bash
calyx monitor create --preset runner-supervision --run <id> [--owner <owner>] [--created-by <actor>] [--provenance <operator|conductor>] [--assigned-host <host>] [--rearm <once|rearm_on_reset|every_change>] [--stale-after-ms <ms>] [--deliver <binding>]... [--no-default-deliveries] [--server-url <url>] [--auth-token <token>] [--json]
```

`--preset runner-supervision` creates a `predicate/v1` `any_of` predicate over
`run.failed`, `run.health_stale`, and `run.terminal` for the supplied run id.
`--owner` defaults to the current Calyx activity identity, falling back to the
same `<user>@<host>` identity used by `monitor inbox` and `monitor ack`. This
shared default makes the suggested `calyx monitor inbox --json` command able to
claim a default-created monitor without weakening explicit exact-activity
ownership.
`--provenance` defaults to `operator`; any non-operator/conductor provenance is
rejected in v1.
`--assigned-host` declares the evaluator host that owns the row. If it names a
non-local host, the CLI resolves that host's run serve daemon and bearer token
from `fleet/truths/hosts.yaml` or the explicit `--server-url`/`--auth-token`
flags, checks daemon feature `monitor.remote/v1`, and writes through
`POST /v1/admin/monitors` on the target daemon. It never creates a local row with a
foreign `assigned_host`. Successful proxied creates report `owner_host` plus a
note such as `inspect with --host <host>`.

For `runner-supervision`, the run id must resolve in the target host's run
store before any monitor row is written. Unknown runs fail with
`monitor_run_unknown` and a `calyx run ps --host <host>` hint. Unknown hosts
enumerate known hosts from the hosts truth. Unreachable daemons, missing bearer
tokens, or daemons without `monitor.remote/v1` fail closed and include an SSH
fallback of the form `ssh <host> '~/.agents/run/calyx monitor create ...'`.
With `--rearm once`, a terminal runner-supervision wake records the durable wake
row and then marks the monitor `cancelled` so it leaves the active evaluator
set; the wake remains visible through `calyx monitor inbox`.

Runner supervision defaults to:

- failure or stale health: `ntfy`
- success: `linear_comment`
- artifact churn: debounced `vault_receipt`

Use `--no-default-deliveries` for durable-state-only delivery. Repeat
`--deliver` to provide an explicit binding set; each binding is
`adapter[,key=value...]`. Supported
adapters are `ntfy`, `linear_comment`, and `vault_receipt`. Supported
materiality values are `always`, `run_failed_or_stalled`, `run_success`, and
`artifact_churn`. These adapters notify people or write receipts; they are not
agent session wake paths.

Examples:

```bash
calyx monitor create --preset runner-supervision --run <id> \
  --deliver ntfy,materiality=run_failed_or_stalled,topic=calyx-monitor-test \
  --json

calyx monitor create --preset runner-supervision --run <id> \
  --deliver linear_comment,materiality=run_success,issue=POL-123,dry_run=true \
  --deliver vault_receipt,materiality=always,root=/tmp/calyx-vault-fixture \
  --json

calyx monitor create --preset runner-supervision --run <blade-run-id> \
  --assigned-host blade \
  --json
```

### `calyx monitor list`

List monitors from the local state store, or from a target host daemon with
`--host`.

```bash
calyx monitor list [--status <active|cancelled|all>] [--run <id>] [--assigned-host <host>] [--limit <n>] [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

`--host` scopes the read to that host's daemon; `--assigned-host` remains a row
filter.

### `calyx monitor show`

Show one persisted monitor object, including predicate, delivery binding, last
evaluation state, and delivery-state rows for the monitor.

```bash
calyx monitor show <monitor-id> [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

### `calyx monitor cancel`

Cancel an active monitor and append a monitor-history event.

```bash
calyx monitor cancel <monitor-id> [--reason <text>] [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

With `--host`, cancel is sent to `POST /v1/admin/monitors/{id}/cancel` on the owning
daemon.

### `calyx monitor history`

Show create/evaluate/wake/ack/cancel and delivery history rows for a monitor.
JSON output also includes delivery-state counts and rows.

```bash
calyx monitor history <monitor-id> [--limit <n>] [--json]
```

### `calyx monitor inbox`

Claim pending wake records owned by the current activity identity. `--peek`
lists without claiming; `--status claimed|acked|all` inspects later states.
JSON output includes persisted claimant lease and delivery-state rows for the
returned wakes.

```bash
calyx monitor inbox [--status <pending|claimed|acked|all>] [--monitor <id>] [--limit <n>] [--claimed-by <actor>] [--peek] [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

Remote claim and acknowledgement mutations require `monitor.claim/v1` in
addition to `monitor.remote/v1`; older daemons remain available for read-only
`--peek` but are refused before a claim or acknowledgement POST.

### `calyx monitor ack`

Acknowledge a claimed wake without deleting wake history. The wake must have an
unexpired claimant lease, and `--acked-by` must equal the persisted claimant;
it defaults to the same current activity identity as create and inbox.

```bash
calyx monitor ack <wake-id> [--acked-by <actor>] [--host <host>] [--server-url <url>] [--auth-token <token>] [--json]
```

With `--host`, ack is sent to
`POST /v1/admin/monitors/wakes/{wakeId}/ack` on the owning daemon.

### `calyx monitor doctor`

Inspect monitor schema parity plus monitor, wake, and delivery-state row counts.

```bash
calyx monitor doctor [--json]
```

`monitor doctor` and `calyx state doctor --domain monitors` report
`monitors-foreign-assigned-host` as an error when an active local row has an
`assigned_host` that does not match the local host. Cancel that local row and
recreate it through `calyx monitor create --assigned-host <host>` or by running
the create command on the owning host.

Daemon routes used by `--host` proxying:

- `GET /v1/admin/monitors`
- `POST /v1/admin/monitors`
- `GET /v1/admin/monitors/{id}`
- `GET /v1/admin/monitors/wakes`
- `POST /v1/admin/monitors/wakes/{wakeId}/ack`
- `POST /v1/admin/monitors/{id}/cancel`

Related SSE subscription:

```bash
calyx run subscribe --event-type monitor.wake.created --format jsonl --after <cursor>
```

## Exec Commands

Low-level exec-store lifecycle management: launch, status, logs, receipt, and validation for JSON command stores.

The exec domain provides a durable JSON run-store contract for tracking simple command execution through lifecycle states (`queued` → `running` → `succeeded`/`failed`/`cancelled`).

### `calyx exec launch`

Launch a new execution run. Without `--apply`, plans the launch. With `--apply`, creates a run record.

```bash
calyx exec launch --store <path> --command <command> [--apply] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--command <command>` (required) — Command string to launch
- `--apply` — Create a real run record (default: plan-only)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (plan or launch applied)
- `1` — Store read/parse/validation error

### `calyx exec status`

Get the current status of an execution run.

```bash
calyx exec status --store <path> --run-id <id> [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Store error or run not found

### `calyx exec logs`

View logs for an execution run, with optional filtering.

```bash
calyx exec logs --store <path> --run-id <id> [--level <level>] [--tail <n>] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--level <level>` — Filter by log level: `info`, `warn`, `error`
- `--tail <n>` — Show only the last N log entries
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success (including zero log entries)
- `1` — Store error or run not found
- `2` — Invalid `--level` value

### `calyx exec receipt`

Generate a receipt for an execution run, including duration, log summary, and human-readable summary.

```bash
calyx exec receipt --store <path> --run-id <id> [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--run-id <id>` (required) — Run ID to query
- `--json` — Print full machine-readable JSON receipt

**Exit codes:**
- `0` — Success
- `1` — Store error or run not found

### `calyx exec notify`

Emit a structured notification event to stdout, ntfy, or agent-mail.

This command is a low-level notification primitive. It does not launch, supervise, or persist a durable long-running process. For durable local process orchestration, use `calyx run launch --kernel host_process ...` and then inspect the run with `calyx run status|receipt|logs|stop`.

```bash
calyx exec notify --message <message> [--level <level>] [--channel <channel>] [--title <title>] [--json]
```

**Options:**
- `--message <message>` (required) — Notification message text
- `--level <level>` — Severity level: `info`, `warn`, or `error` (default: `info`)
- `--channel <channel>` — Delivery channel: `stdout`, `ntfy`, or `agent-mail` (default: `stdout`)
- `--title <title>` — Optional notification title
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Notification delivered
- `2` — Invalid `--level` or `--channel` value

**Example:**
```bash
calyx run launch --kernel host_process --host local --cwd "$PWD" --argv bash --argv -lc --argv 'pnpm test --watch'
calyx exec notify --message "Build complete" --level info
calyx exec notify --message "Tests failed" --level error --channel ntfy --title "CI Alert"
```

### `calyx exec validate`

Validate exec run store structure and lifecycle constraints.

```bash
calyx exec validate --store <path> [--strict] [--json]
```

**Options:**
- `--store <path>` (required) — Path to exec run store JSON
- `--strict` — Escalate warnings to errors
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Validation passed
- `1` — Store read/parse error
- `3` — Validation failed (errors found)

---

## Retired Wrappers

The following retired wrapper names produce a clear error (exit code 6)
pointing to the canonical command. Git retains their migration history.

| Retired wrapper | Use instead | Retired |
|---|---|---|
| `calyx skills-sync` | `calyx skills sync` | P9 (2026-03-02) |
| `calyx skills-sync-claude` | `calyx skills sync --backend claude` | P9 (2026-03-02) |
| `calyx skills-sync-codex` | `calyx skills sync --backend codex` | P9 (2026-03-02) |
| `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` | P9 (2026-03-02) |
| `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` | P9 (2026-03-02) |
| `calyx agents-render` | `calyx instructions render` | P9 (2026-03-02) |
| `calyx exec-launch` | `calyx run launch` | P9 (2026-03-02) |

Invoking a retired wrapper produces:
```
[calyx][error] "skills-sync-claude" was removed in P9 (2026-03-02). Use "calyx skills sync --backend claude" instead.
```

---

## Extensions Commands

Extension discovery, loading, and validation.

### `calyx extensions list`

Discover and list installed extensions from search paths.

```bash
calyx extensions list --search-path <paths...> [options]
```

**Options:**
- `--search-path <paths...>` — Directories to search for extensions (or set `CALYX_EXTENSIONS_PATH`)
- `--json` — Print machine-readable summary

### `calyx extensions validate`

Validate all discoverable extensions (manifests, compatibility, conflicts).

```bash
calyx extensions validate --search-path <paths...> [options]
```

**Options:**
- `--search-path <paths...>` — Directories to search for extensions (or set `CALYX_EXTENSIONS_PATH`)
- `--strict` — Treat warnings as errors
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — All extensions valid
- `3` — Validation failures or conflicts detected

### `calyx extensions check`

Check a single extension package for manifest validity and SDK compatibility.

```bash
calyx extensions check --path <path> [options]
```

**Options:**
- `--path <path>` (required) — Path to the extension package directory
- `--json` — Print machine-readable summary

**Exit codes:**
- `0` — Extension is valid
- `3` — Extension check failed

### `calyx extensions agent-mail-status`

Check agent-mail service status via the agent-mail CLI adapter.

```bash
calyx extensions agent-mail-status [--project-key <key>] [--json]
```

### `calyx extensions agent-mail-send`

Send a message via agent-mail.

```bash
calyx extensions agent-mail-send --message <message> [--project-key <key>] [--thread-id <id>] [--json]
```

### `calyx extensions agent-mail-inbox`

List inbox messages from agent-mail.

```bash
calyx extensions agent-mail-inbox [--project-key <key>] [--json]
```

### `calyx extensions agent-mail-read`

Read a specific agent-mail thread.

```bash
calyx extensions agent-mail-read --thread-id <id> [--project-key <key>] [--json]
```

**Common options (all agent-mail commands):**
- `--project-key <key>` — Agent-mail project key
- `--thread-id <id>` — Thread ID (for send, read)
- `--message <message>` — Message body (for send)
- `--json` — Print machine-readable JSON summary

**Exit codes:**
- `0` — Success
- `1` — Agent-mail CLI delegation error

---

## State Commands

The `calyx state` group manages the local SQLite state store introduced by
the v2 wave-1 program (POL-1338). Wave 1 shipped the foundation: path
resolution, baseline pragmas, the `schema_migrations` ledger, and a
minimal `state_meta` table. Wave 2.1 (POL-1342) adds the orchestration
ledger: `event_log`, `event_cursors`, `locks`, and `source_freshness`.
Domain projections for activity messages and skill proposals are still
out of scope and land in waves 2.3 / 2.4.

**Driver:** `node:sqlite` (Node `>=22.13.0`). The runtime guard fails
closed with a clear operator message if the daemon or CLI launches under
an older Node, or if the built-in module is unavailable.

**Default location:**

```
${CALYX_STATE_HOME:-~/.calyx/state}/calyx.db
```

Override the directory with `CALYX_STATE_HOME=<dir>` or pin the file with
`CALYX_STATE_DB=<file>`. The state directory is created at mode `0700`
and the database file at `0600` where the platform supports POSIX modes.

### `calyx state path`

Print the resolved state directory and database path with provenance.

```bash
calyx state path [--json]
```

`--json` emits `{ stateDir, dbPath, source, dirSource, envVars }`.

### `calyx state migrate --plan`

Read-only plan that lists pending and applied migrations.

```bash
calyx state migrate --plan [--json]
```

### `calyx state migrate --apply`

Apply pending migrations inside a single transaction. Idempotent — a
re-run reports `applied: []` and leaves the ledger untouched.

```bash
calyx state migrate --apply [--json]
```

### `calyx state health`

Structured health snapshot: driver, schema version, WAL status, busy
timeout, foreign-keys flag, last applied migration, directory mode,
database file mode, and migration consistency.

```bash
calyx state health [--json]
```

Exits `4` when the report's `ok` field is false (pending migrations,
ledger drift, or mode drift).

### `calyx state doctor`

Operator-readable diagnostics. Re-runs the health probe and adds a list
of `findings`. Exit code `4` when any finding has `severity: "error"`.

```bash
calyx state doctor [--json]
```

In addition to the wave-1 findings (pending migrations, mode drift,
ledger consistency), wave 2.1 adds:

- `orchestration-ledger-schema` — `error` when migration `0002` is
  applied but expected tables/columns/indexes are missing.
- `orchestration-ledger-absent` — `info` when the orchestration ledger
  migration has not yet been applied. Run `calyx state migrate --apply`.
- `orchestration-lock-expired` — `warn` for any `locks` row whose
  `expires_at` has elapsed; surfaced for operator inspection rather than
  silently stolen.
- `orchestration-source-stale` — `warn` for `source_freshness` rows
  marked `stale` / `error`, or rows whose `stale_after_ms` deadline has
  elapsed.
- `orchestration-lock-expired-truncated` / `orchestration-source-stale-truncated`
  — `info` when the doctor sample was capped. Doctor output is bounded;
  `orchestrationLedger.expiredLocks` / `staleSources` are samples of up to
  20 rows by default. The accompanying `orchestrationLedger.expiredLocksTotal`
  / `staleSourcesTotal` and `expiredLocksTruncated` / `staleSourcesTruncated`
  fields expose the full count and whether the sample was truncated.

Wave 2.2 adds the SQLite-backed run-index projection (migration `0003`,
replaces the deleted `runs/index.jsonl` upsert) and its doctor surface:

- `run-index-schema` — `error` when migration `0003` is applied but the
  `run_index` table or its expected columns/indexes are missing. The
  `runIndex.schemaFindings` array enumerates each missing piece.
- `run-index-absent` — `info` when the run-index migration has not yet
  been applied. Run `calyx state migrate --apply`.

The doctor JSON also gains a `runIndex` block with `migrationApplied`,
`schemaParity`, `schemaFindings`, and `rowCount`. Operators no longer
hand-edit or rebuild a JSONL run index — `calyx run reconcile` rebuilds
the SQLite `run_index` from authoritative `run_record.json` files.

POL-1838 adds an `activityIndex` block (migration `0013`) with
`migrationApplied`, `schemaParity`, `schemaFindings`, `messageCount`,
`malformed`, and a `freshness` snapshot (`message_count`, `source_count`,
`pending_sources`, `indexed_through`, `last_run`). These rows are the
normalized transcript recall store filled by the resident transcript-tailer
inside `calyx run serve`; the store is derived and rebuildable from the
harness-native transcripts, never a system of record.

Wave 2.4 adds the skill-proposals domain (migration `0004`,
`skill_proposals` + `skill_proposal_events`) and its doctor surface:

- `skill-proposals-schema` — `error` when migration `0004` is applied but
  the expected tables/columns/indexes are missing. The
  `skillProposals.schemaFindings` array enumerates each missing piece.
- `skill-proposals-absent` — `info` when migration `0004` has not yet been
  applied. Run `calyx state migrate --apply`.
- `skill-proposals-unknown-status` / `-unknown-kind` / `-unknown-target` —
  `error` for rows whose status, kind, or target is outside the closed
  vocabulary. Doctor reports these as blocking findings.
- `skill-proposals-materialized-to-mirror` — `error` when a materialized
  proposal's recorded artifact path looks like an installed harness mirror
  (`~/.agents/skills/**`, `~/.claude/skills/**`, `~/.codex/skills/**`).
  Source-of-truth boundary violations are visible at doctor time, not just
  at create/materialize time.

POL-1754 adds the fleet-convergence domain (migration `0005`,
`fleet_convergence`) and its doctor surface:

- `fleet-convergence-schema` — `error` when migration `0005` is applied but
  the expected table/columns/indexes are missing. The
  `fleetConvergence.schemaFindings` array enumerates each missing piece.
- `fleet-convergence-absent` — `info` when migration `0005` has not yet been
  applied. Run `calyx state migrate --apply`.

POL-1732 adds the monitors domain (migration `0007`, `monitors`,
`monitor_cursors`, `monitor_history`, and `monitor_wakes`; migration `0009`,
`monitor_deliveries`) and its doctor surface:

- `monitors-schema` — `error` when migration `0007` is applied but expected
  monitor tables/columns/indexes are missing. The `monitors.schemaFindings`
  array enumerates each missing piece.
- `monitors-absent` — `info` when migration `0007` has not yet been applied.
  Run `calyx state migrate --apply`.

`monitors.deliveryCount` and `monitors.deliveryCounts` expose attempted,
delivered, and failed delivery rows.

POL-1777 adds the runner-live-bindings domain (migration `0010`,
`runner_live_bindings`) for experimental Codex app-server steer delivery:

- `runner-live-bindings-schema` — `error` when migration `0010` is applied but
  the expected table, columns, or indexes are missing. The
  `runnerLiveBindings.schemaFindings` array enumerates each missing piece.
- `runner-live-bindings-absent` — `info` when migration `0010` has not yet been
  applied. Run `calyx state migrate --apply`.

`runnerLiveBindings.counts` exposes active and closed live binding rows. Auth
columns carry descriptors only; no app-server tokens are stored in the state
store.

POL-1789 adds the messages domain (migration `0011`, `messages`,
`message_deliveries`, and sender `outbox`) for Calyx correspondence:

- `messages-schema` — `error` when migration `0011` is applied but the
  expected message tables, columns, or indexes are missing. The
  `messages.schemaFindings` array enumerates each missing piece.
- `messages-absent` — `info` when migration `0011` has not yet been applied.
  Run `calyx state migrate --apply`.

`messages.pendingCounts` exposes directed pending, directed claimed, scope
pending, dead-letter, delivery-failed, and outbox-pending counts. Message
delivery rows are separate from monitor delivery rows even though both use the
shared `delivery/v1` HTTP adapter layer.
POL-1790 adds the leases domain (migration `0012`, intentionally sequenced
after the concurrent POL-1789 messages migration slot) for named-resource
conflict records:

- `leases-schema` — `error` when migration `0012` is applied but the expected
  table, columns, or indexes are missing. The `leases.schemaFindings` array
  enumerates each missing piece.
- `leases-absent` — `info` when migration `0012` has not yet been applied. Run
  `calyx state migrate --apply`.
- `leases-expired` — `warn` when expired lease rows remain in the state store.
  Expired rows are conflict evidence for operator inspection; they are not
  silently stolen.

`leases.rowCount` and `leases.expiredCount` expose total lease rows and expired
rows.

`--domain <name>` (repeatable) restricts the doctor to one or more named
domains and computes `ok` against the selected subset only. Known domains:
`state`, `orchestration`, `run_index`, `activity`, `skill_proposals`,
`skill_content`, `memory_content`, `fleet_convergence`, `monitors`,
`runner_live_bindings`, `messages`, `leases`, `tasks`. The `skill_content`
domain (POL-1729 Slice 1, migration `0016`; Slice 3 migration `0017` adds the
`pinned` column + `idx_skill_content_pinned`) reports `skill_content` +
`skill_write_log` schema parity (including `pinned`) plus blocking
`skill-content-schema` / `skill-content-<malformed-code>` findings; counts
surface live/tombstoned/pinned. The `memory_content` domain (POL-1729 Slice 4,
migration `0018`) reports `memory_content` + `memory_write_log` schema parity
plus blocking `memory-content-schema` / `memory-content-<malformed-code>`
findings; counts surface live/tombstoned by review_status and category.
The `activity` domain (POL-1838, migration `0013`) reports recall-index
schema parity plus freshness: blocking `activity-index-schema` /
`activity-index-<malformed-code>` findings, and an informational
`activity-index-pending-sources` note when a transcript source has an
un-ingested tail. Unknown domains surface as `unknown-domain` errors with the
full known list.

```bash
calyx state doctor --domain skill_proposals --json
calyx state doctor --domain fleet_convergence --json
calyx state doctor --domain monitors --json
calyx state doctor --domain runner_live_bindings --json
calyx state doctor --domain messages --json
calyx state doctor --domain leases --json
calyx state doctor --domain activity --domain skill_proposals --json
```

The doctor JSON also gains a `skillProposals` block with
`migrationApplied`, `schemaParity`, `schemaFindings`, `counts` (by status),
`total`, and `malformed` (bounded sample of blocking findings).

POL-1729 Slice 1 adds a `skillContent` block (migration `0016`) with
`migrationApplied`, `schemaParity`, `schemaFindings`, `counts`
(`live` / `tombstoned` / per-regime distribution), `writeLogCount`, and
`malformed` (bounded sample of blocking findings).

### `calyx state event-log`

`event_log` is a **projection**, not a system of record — the same status
`run_index` has. Run, control, and monitor events are journaled to
`<runs-root>/events.index.jsonl` (the durable receipt of
`<runs-root>/events.authority.sqlite3`) *before* `OrchestrationLedgerSink`
mirrors them into SQLite. This group makes that projection rebuildable and its
refusals inspectable, so a single bad row is a repair rather than a
permanently blocked `calyx self upgrade` (POL-2090).

**The rebuild boundary is explicit and enforced in code**
(`packages/core/src/state/event-log-recovery.ts`):

| Class | Domains | Rebuildable? |
| --- | --- | --- |
| journal-derived | `run`, `control`, `monitor` | Yes — re-projected from the journal |
| ledger-native | `calyx.symphony` | **No.** `DaemonLedger` writes straight to `event_log`; the row is the only durable copy |
| unclassified | anything else | Refused — an undeclared writer means no rebuild knows its own boundary |

Two further classes of row are visible but not rebuildable: **orphaned** rows
(a journal-derived domain with no matching journal line — a rotated journal, a
different runs root, or events predating journal receipts) and, on any host,
`event_cursors` / `locks` / `source_freshness`, which are live state rather
than projections. Every `rebuild` result carries a `not_restorable` array
stating these in words, so a green rebuild is never mistaken for a complete
one.

```bash
calyx state event-log rebuild [--plan|--apply] [--runs-root <dir>] [--json]
calyx state event-log quarantine [--limit <n>] [--json]
```

`rebuild` defaults to `--plan` (read-only). `--apply` **merges, never
replaces**: it inserts journaled events the ledger lacks and leaves
ledger-native, orphaned, and unclassified rows untouched. Restored rows are
stamped `source = "event-log-rebuild"` — they were materialized by the repair,
not observed live — and `recorded_at` is necessarily re-stamped. Comparison is
semantic, not byte-wise: `payload_json` was only canonicalized from
2026-07-15, so every earlier row is stored in insertion order and a byte
compare would call the whole pre-cutover ledger divergent.

`rebuild` **refuses** (exit `4`, `refused_reason` set) when an undeclared
domain is present, when the scan was truncated, or when there is no journal.
A partial scan cannot tell a rebuildable gap from an unrecoverable orphan.

**Quarantine.** When an append genuinely diverges — same `event_id`,
materially different event — the row is set aside and ingest **continues**.
Both versions are written whole to `~/.calyx/state/quarantine/event-log/*.json`
(mode `0600`), with a field-by-field diff, the origin (`ingest` or `rebuild`),
each side's `source` stamp, and which version `event_log` now holds. It is a
JSON sidecar rather than a table on purpose: the ledger is the thing being
repaired, so the record must not depend on the ledger being writable or on a
migration the host may not have. There is **no acknowledgement gate** — no
field to acknowledge and no finding that blocks. Visibility is
`calyx state doctor` and `calyx state event-log quarantine`.

`calyx state doctor` gains an `eventLogProjection` block
(`calyx.event-log-projection/v1`: `matched`, `missing`, `divergent`,
`ledger_native_rows`, `orphaned_rows`, `unclassified_rows`, bounded samples)
and an `eventLogQuarantine` inventory. The scan runs on doctor only — it reads
the whole journal, so ordinary `state health` stays cheap — and it must run on
the host holding the data, which is the point: replay divergence has to be
found there rather than by an upgrade that already depends on it. Findings:

- `orchestration-event-log-divergent` — `warn`. The ledger and journal
  genuinely disagree; repair with `rebuild --apply`.
- `orchestration-event-log-gap` — `info`. Journaled events absent from the
  ledger; `rebuild` fills them.
- `orchestration-event-log-quarantined` — `warn`. Rows set aside so ingest
  could continue, with both versions preserved on disk.
- `orchestration-event-log-journal-unparsable` / `-quarantine-unreadable` /
  `-journal-absent` — `warn`. Evidence that exists but cannot be used.
- `orchestration-event-log-unclassified-domain` — **`error`**. A ledger writer
  was added without declaring whether its rows have a journal behind them.
- `orchestration-event-log-scan-truncated` — **`error`**. A partial scan is
  never proof of projection health.

Only the last two block, and neither is an operator acknowledgement: they mean
the rebuild boundary itself is untrustworthy. Divergence and quarantine never
gate, because the whole point is that ledger damage is recoverable rather than
terminal.

**Workflow:** plan → apply → doctor.

```bash
calyx state migrate --plan --json
calyx state migrate --apply --json
calyx state doctor --json
calyx state event-log rebuild --plan --json   # projection vs journal
```

**State-specific exit codes:**
- `4` — Health/doctor reported a blocking finding, or `event-log rebuild` refused
- `7` — Driver guard failed (Node too old or `node:sqlite` unavailable)

---

## Exit Code Convention

All calyx commands follow a consistent exit code convention:

| Code | Meaning |
|------|---------|
| `0`  | Success |
| `1`  | Unhandled runtime error (file not found, parse failure, etc.) |
| `2`  | Invalid CLI arguments (bad flag values, missing required options) |
| `3`  | Domain validation failure or not found (`not_found` in context primitives) |
| `4`  | Capability unavailable |
| `5`  | Adapter error, deprecated wrapper, or deferred wrapper invoked |
| `6`  | Retired wrapper invoked (removed, use canonical command) |
| `10` | Internal failure |
