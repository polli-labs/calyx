# Operator Runbook: Calyx-First Daily Operations

This runbook is the canonical reference for internal Polli operators using the Calyx CLI. All commands use the canonical `calyx <domain> <verb>` form. Legacy compatibility wrappers were otherwise removed in P9 (2026-03-02). For first-time setup, see the [Onboarding Guide](onboarding.md).

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- `calyx` CLI installed
- Verify installation: `calyx --help`
- (Optional) Configure production source paths — see [Production Wiring](production-wiring.md)

For first-time source bootstrap on blade, build the checkout and install the
local wrapper:

```bash
pnpm build
node packages/cli/dist/bin.js install bootstrap --apply
~/.agents/run/calyx run --help
```

Before the first promoted install, this can point `~/.agents/run/calyx` at the
built checkout executable. After `calyx self upgrade --host <host>` has created
`~/.calyx/installs/current`, the upgrade transaction reruns bootstrap so the
wrapper points through the `current` symlink instead of pinning the resolved
install dir; later promotes and automatic rollbacks are visible without another
manual bootstrap. In both cases it deletes any `~/.agents/run/calyx.legacy` left
by earlier versions: the wrapper passes argv straight to the current CLI and
routes nothing itself, so a second `calyx` on disk is a shadow the CLI cannot
see. Earlier wrappers *did* route `doctor`, `promote`, `staged-drift`,
`fleet smoke`, and `exec run` to that file, which is how `calyx doctor` on blade
and mba kept running a Python script from the retired `polli` monorepo, silently,
for four months.

The source wrapper does not trust the operator's default `node` blindly. If
`CALYX_NODE` is set, it must satisfy Calyx's Node floor (`>=22.13.0`).
Otherwise the wrapper selects a suitable runtime from the visible PATH, common
Homebrew/system locations, or local nvm installs before executing the promoted
install bin, or the checkout `packages/cli/dist/bin.js` during first bootstrap.

When no promoted install exists, bootstrap hard-fails if
`packages/cli/dist/bin.js` is stale relative to workspace source inputs. That
is intentional: operators should rebuild first, then rerun
`install bootstrap --apply`, instead of silently rewiring the PATH wrapper to
old code.

## Source resolution

Registry and store paths are resolved using: CLI flag > environment variable > config file. With production wiring configured, most commands work without explicit `--registry` / `--store` flags. Run `calyx config show` to see resolved paths.

For adapter-backed production mode (no fixture paths), set:

```bash
export CALYX_SOURCE_MODE=adapter
export CALYX_POLLI_ROOT=/home/caleb/repo/polli
export CALYX_DOCSTORE_ROOT=$HOME/.agents/docstore
```

## Command pattern

All Calyx commands follow a consistent pattern:

```
calyx [global-flags] <domain> <verb> [options]
```

Extension domains: `config`, `instructions`, `skills`, `tools`, `prompts`, `agents`, `knowledge`, `exec`

Canonical operator run surface: `run`

Canonical reviewer dispatch surface: `review`

Canonical local runtime convergence surface: `runtime-config`

Canonical fieldwork artifact surface: `vault`

Canonical agent-facing command inventory: `agent-context`

Data-bearing commands expose `--json` where their help documents it.

Agents and conductors can use `calyx agent-context --json` for the current
machine-readable inventory and recipes for runner supervision, activity recall,
vault context reads, context capture, Symphony daemon ticks, and state
doctoring. This projection is still separately authored and can be verbose;
use domain help for narrow command discovery.
Use `calyx review` rather than a handwritten reviewer prompt when commissioning
the standard or adversarial reviewer definitions for a PR or branch; it records
the run-spec handback binding and returns a conduct receipt. Run-service emits
the bound `calyx msg` when the run reaches terminal success or failure; the
reviewer prompt still includes the voluntary send command with the same
idempotency key so a compliant agent does not double-deliver. If the target
daemon lacks `message.correspondence/v1`, the binding degrades to a receipt-only
artifact; pull the run artifact plus the PR/Linear review comment for manual
relay. For PR reviews immediately after a force-push, pass `--sha <full-sha>`
when you know the pushed head; that is the guaranteed way to pin the post-push
commit. Without `--sha`, PR target pinning refreshes the remote-tracking base,
resolves the PR head from `origin`, waits for matching consecutive reads as a
best-effort guard, then falls back to local pull refs only if the remote head is
unavailable. Target-resolution warnings are surfaced in the review conduct
receipt and reviewer prompt when the pin is best-effort or an explicit `--sha`
is not observed on the PR ref within the poll budget.
For activity image refs, use `calyx activity attachments <activity-id> --host
<host> --ref <att:sha256:digest> --extract --json` to materialize bytes into
the current host's sha256-verified attachment cache with provenance. Activity
messages, turns, and text remain metadata-only and never inline attachment
bytes.
When an MCP client needs to view a selected activity image ref, use a scratch
local server with `calyx mcp serve --surface activity-attachments`; metadata
tools still return records only, and the image tool serves one MCP image
content block from the same verified cache path.
Legacy wrapper and tombstone names are intentionally absent from `calyx --help`;
direct legacy invocations still emit the existing actionable diagnostics.

## Daily operator workflows

### 1. Config compilation

Compile fleet/host YAML to Codex TOML with parity checking.

```bash
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

**Success signal:** Exit code 0, output reports parity match.
**Failure signal:** Exit code 1, stderr describes mismatch or missing file.

### 1A. Runtime config convergence

Use the local runtime-config backend when you need to reconcile the live host's
Codex config, Claude settings, and Claude MCP root config against managed truth.

```bash
calyx runtime-config plan \
  --host carbon \
  --json

calyx runtime-config apply \
  --host carbon

calyx runtime-config verify \
  --host carbon
```

The canonical target-local managed truth root is
`~/dev/agents-infra/dev/fleet/configs`. Pass `--managed-configs-root` only when
the target host intentionally uses a different checkout location.

**Success signal:** `verify` exits `0` and the receipt summary shows zero drift.
**Failure signal:** `verify` exits `3` and the receipt items identify the drifted component and target path.

### 2. Instruction rendering and verification

Inspect named instruction surfaces, then render or verify them against their
declared source refs.

```bash
# Inspect available surfaces
calyx instructions list \
  --surfaces-dir fixtures/instructions/surfaces

# Show one surface
calyx instructions show sample-global \
  --surfaces-dir fixtures/instructions/surfaces

# Render for a single host via named surface
calyx instructions render \
  --surfaces-dir fixtures/instructions/surfaces \
  --surface sample-global \
  --host blade

# Verify all hosts via named surface
calyx instructions verify \
  --surfaces-dir fixtures/instructions/surfaces \
  --surface sample-global \
  --all

# Reconcile local target files for one host without mutating them
calyx instructions reconcile \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade

# Worktree-local repo_root targets can override the manifest path explicitly.
calyx instructions reconcile \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade \
  --surface sample-global \
  --repo-root "$PWD"

# Apply writes missing declared files or updates already-managed ones.
calyx instructions apply \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade

# Review the exact replacement plan before taking over divergent unmanaged
# files. The plan includes live/expected hashes and does not write targets.
calyx instructions apply \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade \
  --surface sample-global \
  --dry-run \
  --reviewed-overwrite

# After review, replace divergent unmanaged files explicitly. For repo_root
# targets, Calyx writes backups outside the Git checkout by default.
calyx instructions apply \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade \
  --surface sample-global \
  --reviewed-overwrite

# Adopt existing unmanaged-but-matching files explicitly.
calyx instructions adopt \
  --surfaces-dir fixtures/instructions/surfaces \
  --host blade \
  --dry-run

# Surface manifests currently live in one flat directory; nested subdirectories
# are rejected so operators get an explicit failure instead of a silent skip.

# Reconcile is intentionally no-bridge: unmanaged files that already match the
# declared render output are still reported so operators can migrate them
# explicitly instead of silently inheriting legacy state.

# Apply and adopt are intentionally separate:
# - apply will not silently take ownership of unmanaged files
# - adopt only succeeds for unmanaged_match targets
# - unmanaged drift stays blocked unless reviewed with --dry-run and then
#   explicitly replaced with apply --reviewed-overwrite
# - repo_root reviewed-overwrite backups default under
#   ${CALYX_INSTRUCTION_BACKUP_DIR:-~/.calyx/instruction-backups}; pass
#   --backup-dir when an operator-reviewed lane needs a specific receipt root

# Engine-level raw mode remains available for fixture parity work
calyx instructions render \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --host blade

# Verify all hosts against expected outputs
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected
```

**Success signal:** Exit 0, no drift reported or requested writes/adoptions complete.
**Failure signal:** Exit 3, reconcile findings or blocked apply/adopt targets reported.

### 3. Registry management (skills, tools, prompts, agents, knowledge)

Skills, tools, prompts, and knowledge keep their existing registry verbs. The
agents domain is definition-first after POL-1799 and exposes
`calyx agents list|show|validate`.

```bash
# Index — list entries
calyx skills index --registry fixtures/domains/skills/registry.valid.json

# Sync — deploy to backends (plan-only by default)
calyx skills sync --registry fixtures/domains/skills/registry.valid.json --backend agents

# Sync with apply — actually deploy
calyx skills sync --registry fixtures/domains/skills/registry.valid.json --backend claude --apply

# Validate — check registry structure
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict
```

For skills, current Codex builds discover Polli skills from the `agents`
install tree. Use `--native-codex-skills` only for an explicit repair of the
independent `~/.codex/skills/polli` namespace.

Replace `skills` with `tools`, `prompts`, or `knowledge` for the same
index/sync/validate pattern. Use `calyx agents list --registry
fixtures/domains/agents/AGENTS.json` and `calyx agents show <id>` for agent
definition discovery.

### 3-regime. First-party → db-regime cutover (POL-1729 Slice 2)

`calyx skills migrate` moves a first-party (`source.type=internal`) skill from
its git source into the agent-owned **db regime** (`skill_content`,
`regime=db`), then re-materializes the harness mirrors. After cutover the DB is
the source of truth and `calyx skills sync` **skips** the entry (it emits
`plan-skip`/`skip` with details `db-regime (re-materializer-owned)`).

**This is operator-gated, NOT automatic.** `migrate` never edits agents-infra
`instructions/skills/SOURCES.json`; that edit is a reviewed commit you make by
hand. There is no fleet-wide auto-cutover. Run the staged procedure:

```bash
# 1. Dry-run the whole set first — preview hashes + payload files, write nothing.
calyx skills migrate --all-internal --dry-run --json

# 2. Pilot 3-5 skills, one at a time (apply: seed db-regime + re-materialize).
calyx skills migrate <skill-id> --json
calyx skills show <skill-id>            # confirm regime=db and the mirror matches

# 3. Observe. Confirm the pilot skills load correctly in Claude/Codex sessions
#    and that `calyx state doctor --domain skill_content` is clean.

# 4. For each migrated skill, edit agents-infra SOURCES.json by hand:
#    set "regime": "db" on the entry, then commit (reviewed change).
#    From then on `calyx skills sync` skips it (the re-materializer owns it).

# 5. Expand to the rest only after the pilot has soaked. Re-running migrate on an
#    already-db skill with identical content is a no-op, so the procedure is safe
#    to repeat / resume.
```

Notes:
- Until you make the SOURCES.json edit in step 4, sync still treats the registry
  entry as git-regime and will re-sync the git source over your db content. Do
  not skip step 4.
- Only `internal` skills migrate. Vendored / repo-maintained skills stay git
  (`migrate` refuses them with `not_first_party`).
- `--all-internal` apply requires `--confirm`; `--dry-run` does not. Prefer
  per-skill applies during the pilot so you can observe each one.

### 3A. Production no-fixture smoke (blade)

Use this sequence to verify adapter-backed production wiring without fixture arguments:

```bash
export CALYX_SOURCE_MODE=adapter
export CALYX_POLLI_ROOT=/home/caleb/repo/polli
export CALYX_DOCSTORE_ROOT=$HOME/.agents/docstore

calyx skills validate --strict
calyx tools validate --strict
calyx prompts validate --strict
calyx prompts render --prompt execute-execplan --var execplan_path=/tmp/EXECPLAN.md
calyx agents validate --strict
calyx knowledge validate --strict
calyx verify fleet --strict
```

Success criteria:
- All commands exit `0`.
- Stderr telemetry contains `\"event\":\"calyx.source.resolved\"`.
- At least one domain reports `\"fallback\":true` when no explicit path is configured.

### 4. Run orchestration

Launch, monitor, and reconcile orchestrated AI runs through the `run` surface.
Before multi-host dispatch, prefer one fleet readiness snapshot:

```bash
calyx self freshness --fleet --json
```

Use the `actions` field to drill into stale daemons (`calyx self upgrade`),
active-run occupancy (`calyx run ps`), or reachability failures
(`calyx self health`).

For a stale remote daemon, `calyx self upgrade --host <host> --dry-run`
dispatches the same one-host SSH upgrade path used by the fleet upgrader. Use
`--fleet --hosts <csv>` when you want the subset form spelled out explicitly.

Versioned daemon install model:
- Daemons should execute `~/.agents/run/calyx`; the wrapper should point at
  `~/.calyx/installs/current/node_modules/@polli-labs/calyx/dist/bin.js` once a
  promoted install exists. The live clone under `~/dev/calyx/dev` is a build
  work surface, not the daemon serving path.
- Startup-contract preflight (POL-2045): the plan compares the target binary's
  canonical startup-environment contract (`packages/core/startup-contract.json`,
  imported by the boot path). The fleet conductor reads and validates it once
  at the pinned SHA, then passes digest-bound evidence to every host. For
  `--to <ref>`, the conductor performs a targeted fetch and resolves
  `FETCH_HEAD^{commit}`. Typed target evidence retains the original spelling,
  pinned SHA, normalized remote, and normalized source fetch ref for conductor
  planning, host fetch/reachability, apply, postflight, and receipts; a stale
  local branch or remote-tracking spelling never regains target authority.
  Resolving that evidence and validating its payload are mandatory fleet-planning preconditions;
  either failure writes a typed non-verdict receipt and dispatches zero hosts. A
  `--dry-run` compares that contract with a recognized
  `with-scoped-polli-secrets/v2` supervisor projection and prints a per-host
  `startup_contract` verdict (`compatible`/`incompatible`/`unknown`) plus an
  independent `mutation_disposition` (`allow`/`block`). A real run refuses
  before mutation and again at the adopted-worktree/live-supervisor recheck on
  any blocking disposition, naming the missing required
  or host-scoped consumer secret env, foreign consumer secret, or proven projector mismatch and
  pointing at the source-managed agents-infra projection (or the staged unit at
  `~/.calyx/staged/run-service/…` when present). Recognition requires the actual
  generated command grammar, canonical wrapper/child paths, matching `--host`
  and fixed `CALYX_HOST_ALIAS`, and the generated fixed-env baseline. Those
  shape checks are necessary but do not attest the semantics of the external
  script installed at that path. A definitive verdict also requires fixed
  `CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT=with-scoped-polli-secrets/v2` in the
  supervisor command and the exact same value in the target's boot-enforced
  `required_env_values`. The boot gate and preflight share that canonical value.
  Unmarked generated units remain `unknown + block`; POL-2053 owns the
  agents-infra generator rollout and later units-first, operator-gated
  activation. Token env names must be required plus `--opaque-env`; verifier
  env names must be required plus `--sha256-env`. Consumer-secret names in
  `--fixed-env`, `--preserve-env`, or foreign projections are rejected. A broad
  `with-polli-secrets` wrapper or any other unmodeled supervisor is likewise
  `unknown`, not fabricated as identity-incompatible. Only absence on a target
  proven to predate the startup contract is `unknown + allow`; every
  post-contract unknown blocks. If authoritative `systemctl --user cat` is
  unavailable, a bare unit file cannot hide/drop-in-proof effective composition
  and therefore remains `unknown + block`. Post-contract missing, malformed, or
  unsupported-newer schemas are `unknown + block` with typed
  `target_contract_invalid` kinds. Missing/corrupt content is repaired in the
  target; only an unsupported-newer schema requires a newer trusted upgrader.
  Fleet JSON and text
  receipts keep blocked and nonblocking unknown counts and host lists distinct.
- Where a blocked verdict stops the run (POL-2072): a staged source-managed
  supervisor cutover can repair the *live supervisor definition*, so
  `startup_contract_incompatible` and
  `post_contract_supervisor_semantics_unproved` are waived until the
  authoritative post-install re-check. A `target_contract_invalid` verdict —
  a missing, malformed, or unsupported-newer target manifest — is repairable by
  no supervisor definition and refuses **before the first mutation**: before the
  build, the daemon stop, the state snapshot, and the supervisor write. `--force`
  does not override either class; the typed mutation disposition is not
  overridable.
- `--dry-run` refuses while an interrupted cutover journal is pending under
  `~/.calyx/self-upgrade-cutovers/` (POL-2072). Journal recovery ordinarily
  stops daemons, restores the SQLite image, re-promotes the previous install
  and rewrites the previous supervisor definition. If a prior rollback already
  consumed both the pre-created rollback candidate and its reserve, and the
  retained backup now aliases the live database, recovery cannot pretend the
  old image still exists. It instead finishes forward only after re-proving the
  accepted target, observing zero active work, re-cordoning dispatch, observing
  zero active work again, converged state schema, canonical staged supervisor
  bytes, loaded supervisor identity, wrapper/current identity and target daemon
  health (POL-2095). Any failed proof leaves the journal in place.
  Both recovery paths mutate state, which a dry run must never do. Invoke
  `calyx self upgrade --host <host>`, which recovers at invocation start, then
  re-run the dry run. This mirrors the existing pending-target-handoff refusal.
- `calyx self upgrade --host <host>` promotes after a green build: it creates
  `~/.calyx/installs/<git-head>/`, verifies the installed CLI version and
  `.build-info.json`, and atomically flips `~/.calyx/installs/current`.
  Drain/restart and authenticated `/v1/admin/health` verification happen before
  pruning. Post-restart verification remains bounded, but permits up to ten
  minutes for a large state store to complete a real cold start before
  classifying the restart as failed and entering rollback.
  The prune pass excludes `current`, live daemon descriptor argv targets, and
  wrapper-pinned executable targets, then sweeps only stale `.staging-*` and
  `.current-*` residue older than 24 hours.
- The promote → restart sequence uses **transparent update by default**
  (POL-2048). The post-U1 classifier decides per run: proven restart-safe
  Calyx-managed detached workers survive the daemon restart and are re-adopted;
  healthy unproven runs drain and wait; blocked or unhealthy runs refuse with a
  named blocker. Preservation requires both daemon feature proofs,
  `run.readopt_on_boot/v1` and `run.detached_worker_isolation/v1`. If either is
  absent, the plan truthfully reports preservation unavailable and drains all
  active work. `--drain-all` is the explicit full-drain override;
  `--continuous` is a deprecated warn-once no-op alias scheduled for removal in
  `0.4.0`; `--force --abort-runs` remains the explicit interrupt for genuinely
  unsafe classes. POL-1900's supervisor-survival proof landed on 2026-06-27 and
  is represented by the fleet-wide detached-worker-isolation feature receipt;
  there is no remaining POL-1900 activation hedge.
- **A restart-safe classification requires positive supervisor-isolation proof
  from the run's launch evidence** (POL-2044). A live detached worker preserves
  only when its `launch_dispatched` event recorded `worker_supervisor=systemd`
  — Linux systemd cgroup isolation is the sole supervisor proven to survive a
  `run serve` restart (POL-1900). Everything else fails closed with a
  machine-readable reason so the plan/receipt explains why a healthy run drains:
  a `direct` worker (including a silent systemd→direct fallback, now recorded as
  `worker_supervisor_fallback` on the launch event) →
  `unproven_supervisor_isolation:direct`; a legacy launch event with no recorded
  supervisor → `unproven_supervisor_isolation:unrecorded`; a macOS launchd host
  → `unproven_supervisor_isolation:launchd`. `self upgrade` plan rows and the
  `active_run_classification` receipt carry both the `supervisor=<kind>` and the
  `blocking(<reason>)`.
- Versioned install staging uses packed workspace tarballs plus generated
  lockfile-pinned third-party `pnpm.overrides`, writes
  `minimum-release-age=10080`, and keeps `--ignore-scripts`.
- `calyx self health --json` reports three version facts: running build from
  `/v1/admin/health`, promoted build from `installs/current`, and clone HEAD from
  `git rev-parse HEAD`. `calyx self freshness --json` classifies
  `clone_not_promoted` and `promoted_not_restarted` distinctly.
- **State-schema drift is the default fleet state and must be read, not
  assumed.** A host's migration ledger only advances when something runs there,
  so quiet hosts fall behind silently; on 2026-07-27 the fleet was running four
  schema versions across four hosts with nothing reporting it. `calyx self
  health` carries `state_schema` per host and prints a convergence line when
  probing more than one; `calyx self drift` adds a `schema` column measured
  against the migration source of the build running the command. A `-` or
  `unknown` cell means the daemon predates the field or could not read its
  ledger — it is not evidence of parity.
- Schema drift is **reported, not gated**. It does not change `self drift`
  severity or exit codes, and no fleet operation refuses a host for it.
  `calyx self upgrade` is what converges a schema: it applies the target's
  pending migrations inside the cutover, while daemons are stopped and the
  rollback snapshot is pinned, before the supervisor unit or the `current`
  symlink moves. Gating fleet work on schema drift would refuse the repair path
  precisely on the hosts that need it.
- An **older daemon keeps running against a forward-migrated store**, and this
  is by construction, not luck: the migrator computes pending as
  source-minus-ledger, so ledger ids beyond the running build's source classify
  as nothing to do rather than as an error. `calyx state doctor` still names
  them (`migration-drift`, `unknownIds`). The tolerance is not unconditional —
  migrations `0006`, `0027`, and `0029` rebuild tables and tighten CHECK
  constraints, and a constraint an older writer can violate breaks it at the
  first offending write, not at boot. That is why the upgrade runs migrations
  inside its own quiesced window instead of leaving them to whichever process
  opens the store next; ad-hoc `calyx state migrate --apply` against a live
  daemon has no such window.
- `calyx self drift` and `calyx self freshness` resolve the conductor compare
  checkout from host truth (`repos.calyx.path`) or `~/dev/calyx/dev`, and only
  emit `git -C ... fetch` repairs after validating a real git worktree. If no
  compare checkout is available, the diagnostic is
  `compare_repo_unavailable` rather than a bogus package-install fetch command.
- A non-dry-run `calyx self upgrade --fleet` receipt includes a postflight block
  sourced from `calyx self freshness` (`self-upgrade-fleet-postflight/v1`) for
  successfully upgraded hosts. Dry-runs omit it entirely; no durable
  `pending_s1` placeholder is valid.
- A fleet host row with `exit_code=78` and a `bootstrap_failure` block means
  the remote bootstrap stopped **before any Calyx code ran**: nothing on that
  host moved — no ref adopted, no build, no install, no daemon touched — so the
  next move is to fix the host and retry, not to inspect a half-upgraded
  install. The `code` names what to fix: `node_unavailable` (no node
  `>=22.13.0`), `git_unavailable`, `clone_root_invalid` (the path in
  `fleet/truths/hosts.yaml` `repos.calyx.path` is not a checkout),
  `fetch_failed`, `target_unreachable` (the pinned SHA is not an ancestor of the
  fetched ref), `agent_missing` (the target commit predates
  `scripts/calyx-upgrade-agent.mjs`), `agent_pnpm_unavailable`,
  `agent_build_failed`, `agent_plan_unknown_field` (a forward conductor is
  driving an older target and the target cannot interpret the plan — dispatch
  the rollback from a conductor no newer than the target). The host's full
  transcript is still in the aggregate's `stdout_path` / `stderr_path`.
- A fleet host row with `status=unverified` means the host command exited 0,
  but the conductor could not bind a canonical receipt to the current fleet
  invocation. The fleet exits 1 and writes a pending convergence row, but this
  status alone does not prove the mutation failed and is not a rollback signal.
  Triage `verification=<code>` and
  `verification_receipt=<host>:<route>`, then inspect the host-local receipt and
  `calyx self freshness --host <host> --json`. A pre-dispatch
  `upgrade_receipt_auth_unavailable` warning predicts
  `verification=conductor_auth_unavailable` for the named host, but it does not
  authorize or suppress mutation; the host still dispatches and settles as
  `unverified` if no authoritative verification path succeeds. `--fail-fast`
  stops only after `status=failed`, never after `status=unverified`. On the
  first upgrade to a build
  that records fleet-invocation bindings, a pre-binding remote binary ignores
  that private context, so a successful remote mutation can be `unverified`;
  subsequent invocations running the current binary can produce bound receipts.
- That postflight always makes a first probe, then re-probes only typed
  restart-transient evidence: a request-stage unreachable health plane
  (connection/request failure or timeout), or the exact pinned target already
  promoted and materialized while the old daemon still serves.
  Health, install, capability, and daemon-drift facts come from one health
  observation; drift or feature gaps on that old serving build do not veto the
  typed restart retry. Those hosts use a bounded 5s/15s/25s ramp, 45s per-host
  sleep budget, and 8-probe backstop.
- Once the promoted target serves, any remaining structural drift or
  required-feature gap stops immediately as `not_retryable`, as do
  authentication/legacy-daemon errors, clone-not-promoted state, and unproven
  promotion evidence; do not wait for them.
- A daemon HTTP response or a rejected JSON/protocol response proves the health
  route answered, so it is `http_error` / `invalid_response`, stops immediately
  as `not_retryable`, and remains typed by status/response phase in
  `settle.probes[].health_error`.
- Read `postflight.per_host[].settle.outcome` together with
  `settle.stop_reason` before reacting. `settled_after_retries` means the rollout
  converged. `unsettled_after_retries` means the last `blocked`/`stale`
  observation stands, while `window_budget` or `attempt_backstop` identifies
  the exhausted bound; the completed mutation remains recorded, but its
  authoritative nonzero `freshness_exit_code` fails the enclosing receipt and
  command. An
  `unsettled_no_retries` result distinguishes structural `not_retryable`, an
  explicit zero window (`retries_disabled`), and a positive window too short
  for the first delay (`no_delay_fits`). `probe_error` preserves any earlier
  observed verdict, records typed terminal error evidence without fabricating
  freshness, fails the enclosing receipt/event/command with exit 1, and does
  not suppress rows or probes for later upgraded hosts.
- Use monotonic `elapsed_ms` and ordered `probes[]` to audit duration. Each
  observed probe also carries the source `observed_at`; an error carries the
  conductor `occurred_at`. Those wall-clock anchors preserve cross-host serial
  order, while fleet `postflight.checked_at` marks completion rather than a
  simultaneous snapshot. Chase a final blocker with
  `calyx self health --host <host> --json`. The same outcome fields are
  projected on the text `postflight_settle:` / `postflight_host:` lines.
- The conductor attempts to create a bounded observation record at
  `~/.calyx/self-upgrade-operations/<operation-id>.json`
  (`self-upgrade-operation/v1`) before first dispatch. Its claimed writer and
  revision checks protect the projection from concurrent corruption; they do
  not authorize or fence host mutation. Every observation write has a bounded
  settle time, and claim/write/release failure disables that sink without
  stopping host dispatch or final-receipt persistence. Treat host-local durable
  operation state and verified final receipts as execution authority. The
  conductor record, live SSH phase frames, event-log rows, terminal lines,
  heartbeats, and final host table are projections; replay, loss, delay, or
  reordering cannot decide the rollout result.
- Remote progress uses typed NDJSON on stderr. Remote stdout remains one whole
  final JSON object, preserving old conductors and every existing JSON parser.
  Relay negotiation is private process context, not a public flag or consumer
  API. A remote may ignore it and complete through strict final JSON and
  receipt validation. The absence of canonical frames is recorded as `missing`,
  not as evidence of a pre-relay binary; a current binary can also emit only
  final JSON.
  Do not scrape arbitrary stdout/stderr to reconstruct phases. Diagnostic
  capture is bounded and may truncate without terminating the SSH mutation.
- The first rollout of this contract must be conducted by the U4/current
  binary. A predecessor conductor cannot be retrofitted to accept fields it
  parses strictly. Once the U4 conductor is running, additive fields in a
  remote terminal envelope are ignored, and any partial retry must use that
  same conductor generation or a newer one. This is an ordering requirement,
  not permission to start the fleet activation wave.
- A quiet in-flight host emits a heartbeat after 15 seconds even while another
  host is chatty. The compact final table (host, execution status, separate
  freshness verdict, before-to-after head, monotonic elapsed, host-qualified
  receipt locator) is emitted only after the bounded postflight settle decision
  is authoritative and the aggregate receipt is durable. Absence of
  `fleet_final` therefore means “not yet finalized,” not failure.
  If optional nested host diagnostics would push `summary.json` past its hard
  byte ceiling, the conductor writes a `bounded.reason=size_limit` receipt
  instead of abandoning final authority. That form retains every host, status,
  exit code, elapsed time, before/after head, receipt locator, verification
  disposition, and bounded error; it explicitly lists omitted detail.
- Host migration after this PR is conductor-owned: capture the dry-run's
  `plan.target_head`, then replay that assessment explicitly:
  `calyx self upgrade --host <host> --dry-run --json`, followed by
  `calyx self upgrade --host <host> --target-sha <plan.target_head> --json`.
  A later invocation without `--target-sha` truthfully replans the ref and is
  not the same assessed plan. Then, on that host, run
  `calyx install bootstrap --apply` so `~/.agents/run/calyx` targets
  `current`. Verify with `calyx doctor --host <host> --json` and
  `calyx self freshness --host <host> --json`.
- Rollback is a symlink flip back to a prior install dirname, followed by the
  same restart discipline: `ln -sfn <previous-install-dirname> ~/.calyx/installs/current`,
  then rerun the host upgrade/restart verification.

#### Self-upgrade second-shell recovery

Use the operation id announced at launch, or omit it to select the newest live
operation first:

```bash
calyx self upgrade status [<operation-id>] --watch
calyx self upgrade status <operation-id> --json
```

`active` means the owner record names the exact operation and writer recorded
by the projection, and that exact process generation is still live. A
mismatched owner is degraded, non-active evidence; a live unrelated PID cannot
make an operation current.
`orphaned` means the projection still says `running` but its writer is dead or
released. `indeterminate` means process-generation evidence is unavailable.
`terminal` means the projection carries a terminal reduction. The command is
read-only and never claims, resumes, or re-drives an interrupted upgrade.
Watch mode exits successfully on terminal or conclusively orphaned ownership.
It re-observes transient `indeterminate` evidence finitely and exits `6` if
liveness remains unavailable rather than presenting uncertainty as success.

Treat the status record as a bounded observation only. Host-local durable state
and verified final receipts remain mutation/result truth. When
`receipt_evidence.aggregate_path` or a host receipt locator is present, inspect
that canonical evidence before acting on a projection disagreement.

```bash
RUN_ID="$(calyx run launch --host local --prompt "Implement with receipts" --foreground --json | jq -r '.run_id')"
calyx run status "$RUN_ID"
calyx run await "$RUN_ID" --timeout 1h --json
calyx run receipt "$RUN_ID"
calyx run doctor "$RUN_ID" --json
calyx run logs "$RUN_ID" --tail 20
calyx run reconcile --json
```

**Success signal:** `calyx run receipt` shows a `RunRecord` with `state: succeeded` and `recovery.mode = normal`.

Agent backend sessions receive a small metadata environment for receipt writing
and self-location: `CALYX_RUN_ID`, `CALYX_RUN_DIR`, `CALYX_RUN_HOST`,
`CALYX_RUN_ISSUE`, and `CALYX_RUN_WORKTREE` when those values exist. Calyx owns
those identity keys, so computed metadata wins if backend `--env` tries to set
the same `CALYX_RUN_*` value; unrelated backend env overrides are preserved.

For `calyx run resume`, omit `--worktree-path` only when the session already
has a prior Calyx-managed run. Resume now reuses that stored worktree path and
errors if the prior worktree cannot be found, instead of auto-resolving to the
shared default `calyx-run` worktree.

For `agent_runner` launches, `--system-prompt` / `--system-prompt-file` replace
the backend system prompt, while `--append-system-prompt` /
`--append-system-prompt-file` add extra instructions to the default. File forms
are read by the local CLI before remote dispatch and require daemon feature
`run.system_prompt/v1`; if a remote daemon refuses, run
`calyx self upgrade --host <host>` from any healthy conductor and relaunch.

For direct `agent_runner` work, `--prompt`, `--prompt-file`, and `--template`
are first-class launch sources and do not require an ExecPlan by default. Omit a
direct prompt source when you want the run prompt to come from an issue-linked or
explicit `--execplan-ref` ExecPlan. Use `--require-execplan` to force strict
ExecPlan resolution for a direct prompt launch, or `--no-require-execplan` to
keep older direct-prompt commands explicit.

For active `agent_runner` runs, Calyx records sparse backend freshness. Claude
runs use the CLI's documented JSONL stream mode (`--print --output-format
stream-json --verbose`) and project completed assistant/tool/turn/result records
into semantic progress facts. The projection never persists thinking, partial
deltas, tool arguments, tool results, or unknown record payloads. Codex
app-server turn events and the typed `adapter_activity` fallback cover other
adapters. See Anthropic's [headless mode](https://code.claude.com/docs/en/headless)
and [CLI reference](https://code.claude.com/docs/en/cli-reference) for the
upstream stream contract.

`calyx run ps`, `calyx run status`, and receipts show `health`,
`last_progress`, and the configured stale window. Detailed status and receipt
output also shows `progress_source`, `progress_signal`, and its typed reason.
When Claude reports an API retry, the safe progress projection includes
`expected_silence_until`; status, receipt, list JSON, and detailed text expose
that deadline while it extends freshness. The opaque upstream error text is
discarded, and the declared retry delay is capped at five minutes before the
normal stale window is added.
An established Claude stream with recent semantic progress is `healthy`; an
established stream silent beyond policy is `stale`; an unavailable or failed
semantic channel is `unknown`, never inferred stale. Detection is not a kill
switch: a quiet backend is never stopped by silence unless launch config sets
`--agent-inactivity-timeout-ms` or the equivalent
`backend_options.agent_activity.hard_timeout_ms`. When that configured stop
fires for a spawn-backed backend, the terminal state is `infra_error` with
reason/detail `stalled_inactivity`. Codex app-server hard inactivity stop is
not part of this slice; its turn events still refresh health.

Claude's final structured `result` is stored separately as
`terminal_evidence`: source/status, normalized terminal reason, backend
subtype/reason, session id, bounded numeric usage, and diagnostic counts. The
bounded list/activity projection contains only that structured evidence. The
full final assistant message remains on the canonical receipt/status and
terminal lifecycle event; it is not duplicated into list/activity rows. Post-exit
transcript discovery is a visible fallback; it is not allowed to replace an
authoritative structured result.

Codex app-server runner spawn resolves the command before launch with an
operator override and a macOS Homebrew preference. The adapter checks
`CALYX_CODEX_BIN` (canonical override), `CODEX_BIN` (alias), macOS Homebrew
defaults (`/opt/homebrew/bin/codex`, then `/usr/local/bin/codex`), then the
first executable `codex` on PATH, with a final bare `codex` fallback only when
PATH is unavailable to inspect. Linux remains PATH-compatible by default. On
any host with a stale or broken PATH launcher, set
`CALYX_CODEX_BIN=/path/to/codex` to pin the known-good binary. An invalid
explicit override, or a searchable PATH with no executable, fails before spawn
and tells the operator to install codex or set `CALYX_CODEX_BIN`.

For timing-insensitive runner supervision, create the monitor on the host whose
`run serve` evaluator owns the run. From another host, `--assigned-host`
proxies the create through the target daemon so the row is born in that host's
state store:

For one finite foreground observation, use `calyx run await <run-id> --json`.
It owns terminality and success classification, closes the subscription race,
reconciles after disconnects, and does not mutate the run on timeout or Ctrl-C.
Do not replace it with a shell polling loop or a copied terminal-state union.
Use the monitor below when the conductor must be durably reinvoked rather than
remain attached.

```bash
calyx monitor create --preset runner-supervision --run <blade-run-id> --assigned-host blade --json
calyx monitor show <monitor-id> --host blade --json
calyx monitor history <monitor-id> --json
calyx monitor inbox --host blade --json
calyx monitor ack <wake-id> --host blade --json
```

`calyx run serve` evaluates monitors in-process and emits
`monitor.wake.created` through the existing SSE stream. The durable pull
surface is `calyx monitor inbox --host <owner>` for cross-host drains;
acknowledgement never deletes wake history.
Terminal `--rearm once` runner-supervision monitors leave the active evaluator
set after their terminal wake is recorded; the monitor row is marked
`cancelled`, while the wake remains visible in `monitor inbox`.
Durable delivery is unconditional: SQLite state, JSONL receipt, and SSE.
Optional bindings can additionally write ntfy notifications, Linear comments,
and vault receipts. Agent acceleration uses the same exact, generation-bound
session-ingress route as `calyx msg send --wake`; there is no parallel
backend-specific receiver or continuation path. Each notification binding has
its own materiality filter and delivery-state row. Failed notification writes
leave the wake pullable through `monitor inbox`. Use
`calyx monitor show|history|doctor --json` to inspect attempted, delivered, and
failed delivery evidence. For dogfood, use scratch ntfy topics, Linear dry-run
or scratch issues, and `/tmp` vault fixtures. `agent-mail` is retired and is not
a monitor delivery adapter.

### Artifact, Log, Process, And Resource Liveness

Use `calyx run doctor <run-id> --host <host> --json` when the conductor question
is broader than lifecycle state. The doctor surface emits `run-observation/v1`:
run status and health, stdout/stderr source liveness, required/discovered
artifact status, recorded worker pid liveness, run-attributed process/GPU
evidence, and a best-effort host resource snapshot. Resource attribution uses
the recorded worker pid to walk the visible process tree and map NVIDIA compute
process rows back to that tree. If the host is busy but the rows do not belong
to the run, doctor reports that as host-only evidence instead of inventing run
progress. The first GPU provider is `nvidia-smi`; hosts without it report GPU
telemetry as unavailable instead of inventing values.
Hosts that include the richer attribution payload advertise daemon feature
`run.resource_attribution/v1`.

For artifact-producing runners, declare expected output roots at launch:

```bash
calyx run launch ... \
  --artifact-root packets \
  --artifact-root reports
```

Relative roots resolve from the run worktree. `run doctor` summarizes declared
roots with existence, file count, directory count, total size, newest
modification time, and bounded-scan truncation. Use `--required-artifact` for
specific file gates; use `--artifact-root` for liveness of a packet/output
directory while the run is still active.

This is intentionally a reconciliation view, not a replacement for the deeper
surfaces. Use `calyx run logs` for log bodies, `calyx activity turns run:<id>`
for semantic assistant progress, and `calyx run receipt` for the authoritative
persisted record.

Backend-session availability differs by adapter. Codex app-server runs may
publish a recovery checkpoint while active. Spawn-backed Claude runs assign an
exact Claude session id at launch. A matching structured init/result record can
publish that id-only recovery checkpoint while the run is active; mismatched
stream identities are quarantined. Post-exit discovery then validates the exact
transcript identity, working directory, and execution window before adding its
path. Calyx does not poll Claude's session directory while the run is active.
When the semantic stream is unavailable, active discovery therefore remains
pending, while a missing terminal transcript reports that fallback discovery
failed.

For handoffs, `calyx activity self --json` resolves the current harness session
when Codex/Claude exposes a session id. Use `calyx context capture plan|apply`
to turn selected `calyx activity turns` slices into a vault note plus sidecar
receipt instead of overloading oracle-bundle workflows for ordinary session
context capture. `--from-activity latest:codex|latest:claude` is the quick
selector for adjacent interactive sessions, while `--around-text ... --context`
adds a bounded message window around an important phrase. Use
`--max-text-chars <n>` when a selected scratch note or synthesis is expected to
exceed the 4000-character default; capture results, notes, and receipts surface
any selected message ids that still truncate at the effective cap.

For ChatGPT web or MCP-style read-only context packs, use the Calyx-owned
planner before building connector glue:

```bash
calyx context plan \
  --goal "Prepare context for <task>" \
  --seed vault://fieldwork/<relative-note>.md \
  --profile chatgpt-web \
  --budget-bytes 120000 \
  --json

calyx context pack \
  --goal "Prepare context for <task>" \
  --seed vault://fieldwork/<relative-note>.md \
  --profile chatgpt-web \
  --budget-bytes 120000 \
  --plan-hash <plan-hash> \
  --out-dir <dir> \
  --apply \
  --json
```

Repeat the same goal/seed/profile/budget inputs during pack apply. The packer
recomputes the vault source graph, compares the plan hash, and refuses stale or
mismatched inputs before writing bounded source files and `bundle.docs.md`.
Vault markdown is packaged as evidence with provenance and hashes; it is not
treated as trusted instruction text.

### ChatGPT MCP Context Connector

Use the MCP connector when ChatGPT web or another MCP client needs late-bound,
read-only access to vault/context retrieval rather than a pre-selected static
bundle. The connector is a packaging layer over Calyx contracts: it exposes
`vault_search`, `vault_fetch`, `vault_related`, `context_plan`,
`context_fetch_pack`, and `agent_context`, while `calyx vault` and
`calyx context` remain the source of truth for retrieval, planning, bounds, and
provenance.

Inspect the tool manifest before serving:

```bash
calyx mcp manifest --surface vault-context --json
```

Start the local Streamable HTTP endpoint:

```bash
CALYX_CONTEXT_MCP_TOKEN="<token>" \
  calyx mcp serve \
    --surface vault-context \
    --host 127.0.0.1 \
    --port 8787 \
    --auth-token-env CALYX_CONTEXT_MCP_TOKEN \
    --json
```

The MCP endpoint is `/mcp`. Keep the default host at `127.0.0.1` unless you
are deliberately placing a reviewed tunnel in front of it. Non-local binds
require the named token environment variable to be set; clients then send
`Authorization: Bearer <token>`. The v0 connector does not implement OAuth or a
shared workspace auth flow, so production or team-wide ChatGPT workspace use
needs a separate auth review before exposure beyond localhost/tunnel testing.
Browser-readable CORS is not enabled in v0, including localhost mode, and local
binds reject non-local Host headers to reduce DNS-rebinding exposure.

Operational posture:

- Treat all vault note bodies as untrusted source evidence. Tool descriptions
  and returned payloads preserve that instruction boundary for ChatGPT.
- Use `context_plan` before `context_fetch_pack`; the pack tool recomputes the
  source graph and rejects stale or mismatched plan hashes.
- The MCP boundary rejects arbitrary filesystem path seeds for context tools.
  Use `vault://fieldwork/...` URIs or query seeds.
- Vault root selection is controlled by the server process (`--vault-path` for
  development fixtures, otherwise the default Fieldwork vault); MCP clients
  cannot override it per call.
- The connector is read-only. It does not write vault notes, materialize bundle
  files, edit Linear/GitHub bodies, or mutate tracker state.
- Server logs should be useful for operations without leaking note content:
  tool names, source ids, bytes, warnings, and error codes are expected; raw
  vault bodies are not.

### Activity Attachment MCP Adapter

Use the activity attachment MCP surface when an MCP client needs to discover
activity attachment refs or render one selected image ref. This surface is
Calyx-native: it packages the `calyx activity attachments` record/byte/cache
contract rather than adding an executor-owned attachment service.

Inspect the manifest:

```bash
calyx mcp manifest --surface activity-attachments --json
```

Start a scratch/local server:

```bash
CALYX_CONTEXT_MCP_TOKEN="<token>" \
  calyx mcp serve \
    --surface activity-attachments \
    --host 127.0.0.1 \
    --port 8788 \
    --auth-token-env CALYX_CONTEXT_MCP_TOKEN \
    --attachment-cache-dir /tmp/calyx-mcp-attachments \
    --json
```

Tools:

- `activity_attachments_list({ activity_id, host? })` lists refs and metadata
  without bytes.
- `activity_attachment_record({ activity_id, ref, host? })` returns one record
  and typed diagnostics without bytes.
- `activity_attachment_image({ activity_id, ref, host? })` resolves through the
  POL-1771 pull-through cache, verifies sha256, and returns one MCP image
  content block for supported image MIME types.

Operational posture:

- Keep `host` explicit for remote locality. The first slice does not do blind
  fleet fan-out or no-host owner discovery.
- Keep the server local/scratch unless a reviewed connector auth path is in
  place. Executor catalogue/proxy integration is a later conductor-owned layer,
  not part of this server startup recipe.
- Metadata-only records (`exact_bytes_available=false`) remain records and are
  not byte attempts.
- Projected activity messages, turns, text, list output, and record output never
  inline attachment bytes. The only sanctioned byte paths are cache files, the
  authenticated daemon byte endpoint, and the explicit MCP image content block.

For long-running `host_process` workloads, lifecycle state and workload health are intentionally separate. If you configure host-process health monitoring, `calyx run status` and `calyx run receipt` will surface:

- lifecycle state such as `running` or `succeeded`
- `health` status (`healthy`, `stale`, `unknown`)
- `last_progress` timestamp when Calyx last saw an explicit progress signal
- the configured `stale_after` window

On Unix hosts, `host_process` launches a run in a dedicated workload process group. `calyx run stop` durably admits a cancellation request. The worker observes that marker, sends `SIGTERM` to the group, waits through `--stop-grace-ms`, and escalates with `SIGKILL` if descendants such as `torchrun` worker ranks are still alive. Command success proves request admission, not terminal cancellation; observe `calyx run status` for the later terminal state.

Health signals are generic and opt-in:

- `--health-source stdout`
- `--health-source stderr`
- `--health-path <path>`

Example:

```bash
calyx run launch \
  --kernel host_process \
  --host blade \
  --cwd "$PWD" \
  --argv bash \
  --argv -lc \
  --argv 'python train.py --config configs/train.yaml' \
  --health-source stdout \
  --health-path work/metrics/train.jsonl \
  --health-stale-after-ms 600000 \
  --health-poll-interval-ms 30000
```

This tells Calyx to keep the run `running` while the process is alive, but to mark health `stale` if neither stdout nor the watched metrics file advances inside the configured window.

### 4A. Exec store utilities

The lower-level `exec` domain remains available for JSON store lifecycle checks and fixture-backed command tracking.

```bash
calyx exec launch --store fixtures/domains/exec/store.valid.json \
  --command "calyx config compile --host blade" --apply
calyx exec status --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec logs --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec receipt --store fixtures/domains/exec/store.valid.json --run-id run-001-succeeded
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

### 4B. Symphony daemon manual tick

For Symphony dogfood, the root [`WORKFLOW.md`](../WORKFLOW.md) defines the active fleet project and include-label guard. Operators can drive a single deterministic tick from the project's repo root without standing up a long-running daemon:

```bash
calyx run daemon plan --project calyx --json
calyx run daemon tick --project calyx --json
```

This resolves `WORKFLOW.md` via `hosts.yaml`. Run `plan` first: it is the no-launch selection preview and returns selected/skipped issues, active lane state, available slots, warnings, reconciliation flags, and the preflight verdict without claiming issues or launching work. `tick` then uses the same verdict before claiming one eligible issue (currently labeled `symphony-dogfood`) and printing the resulting receipt as JSON. Use `--workflow <path>` instead of `--project` to point at an ad-hoc workflow file.

Use `selection.max_selected_issues: 1` when a Symphony lane must select exactly one issue before launch. Keep daemon handoff at `In Review`; direct `Done` handoff requires an explicit `workflow_policy.allow_done_handoff: true` escape hatch.

When a tick is used to prove restart recovery (for example, restarting `calyx-run-serve` while a daemon-launched run is still active), the proof receipt should cite: the originating issue, the run id, the activity selector that classified the run (or an explicit missing-activity reason), the active backend turn or process observed before restart, the terminal assistant turn after completion, the ledger cursor state captured before and after restart, and the restart evidence itself (process identity, log line, or supervisor event). These citations let a reviewer confirm the post-restart tick neither double-claimed the issue nor reclassified the live run as `daemon_crash`.

### 5. Knowledge search and linking

Search artifacts and link them to Linear issues.

```bash
# Search
calyx knowledge search --registry fixtures/domains/knowledge/registry.valid.json --query "exec"
calyx knowledge search --registry fixtures/domains/knowledge/registry.valid.json --query "doc_type:runbook scope:operations"
calyx knowledge search --registry fixtures/domains/knowledge/registry.valid.json --query "meta.docstore_id:ep-2026-0225"

# Link artifact to issue
calyx knowledge link --registry fixtures/domains/knowledge/registry.valid.json \
  --artifact execplan-unified-agents --issue POL-605 --apply

# Validate
calyx knowledge validate --registry fixtures/domains/knowledge/registry.valid.json --strict
```

`calyx knowledge search` accepts fielded selectors (`field:value`) with AND semantics:
- Core fields: `id:`, `title:`, `kind:`, `path:`/`source_path:`, `tags:`, `linked_issues:`
- Metadata selectors: `meta.<key>:` / `metadata.<key>:`
- Frontmatter selectors: `fm.<key>:` / `frontmatter.<key>:` and top-level keys like `doc_type:`, `scope:`, `owner:`

### 6. Operator web surface (knowledge browse + search)

Run the minimal web surface from `@polli-labs/calyx-web`:

```bash
node --input-type=module <<'EOF'
import { startKnowledgeSurfaceServer } from "@polli-labs/calyx-web";

const server = await startKnowledgeSurfaceServer({
  registryPath: "fixtures/domains/knowledge/registry.valid.json",
  host: "127.0.0.1",
  port: 4088
});

console.log(server.url);
EOF
```

Open:
- `http://127.0.0.1:4088/knowledge` for browse + search UI
- `http://127.0.0.1:4088/knowledge.json?q=doc_type:runbook` for machine-readable results

## Operator verification checklist

Run this sequence to verify a clean Calyx installation and fixture corpus:

```bash
# 1. Config domain
calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml

# 2. Instructions domain
calyx instructions verify \
  --fleet fixtures/instructions/inputs/fleet.v1.yaml \
  --hosts-dir fixtures/instructions/inputs/hosts \
  --template fixtures/instructions/templates/AGENTS.sample.md.mustache \
  --partials-dir fixtures/instructions/templates/partials \
  --all \
  --expected-dir fixtures/instructions/expected

# 3. Skills domain
calyx skills validate --registry fixtures/domains/skills/registry.valid.json --strict

# 4. Tools domain
calyx tools validate --registry fixtures/domains/tools/registry.valid.json --strict

# 5. Prompts domain
calyx prompts validate --registry fixtures/domains/prompts/registry.valid.json --strict

# 6. Agents domain
calyx agents validate --registry fixtures/domains/agents/AGENTS.json --strict

# 7. Knowledge domain
calyx knowledge validate --registry fixtures/domains/knowledge/registry.valid.json --strict

# 8. Run surface
calyx run launch --host local --prompt "verification smoke" --foreground --json
calyx run status <run-id-or-prefix>
calyx run receipt <run-id-or-prefix>

# 9. Exec domain
calyx exec validate --store fixtures/domains/exec/store.valid.json --strict
```

All 8 commands must exit 0. Any non-zero exit indicates a product or fixture issue.

## Failure classification

When a command fails, classify the failure:

```
Command failed (exit != 0)
|
+-- Exit 1: Runtime error
|   +-- File not found? -> Check path, fixture corpus may be incomplete.
|   +-- Parse failure? -> Corrupt input file. Validate upstream.
|   +-- Parity mismatch? -> Config drift. Re-baseline or fix compiler.
|
+-- Exit 2: Invalid arguments
|   +-- Check --help for the command. Likely a typo or missing required flag.
|
+-- Exit 3: Domain validation failure
    +-- Registry or store has structural errors.
    +-- Run without --strict to see advisory-only warnings.
```

### Escalation path

1. **Product bug:** Command fails on valid input. File a Linear issue on **Calyx** project with reproduction steps and the command receipt.
2. **Infra outage:** CI/CD unavailable. Follow the [CI Reliability Runbook](ci-reliability-runbook.md) outage override protocol.
3. **External dependency:** npm registry, GitHub Actions, etc. Wait for resolution; document in PR if merge is needed.

## Retired wrappers

The following retired wrapper names are rejected with exit code 6 and a
canonical replacement:

| Removed wrapper | Canonical replacement |
|---|---|
| `calyx skills-sync` | `calyx skills sync` |
| `calyx skills-sync-claude` | `calyx skills sync --backend claude` |
| `calyx skills-sync-codex` | `calyx skills sync --backend codex` |
| `calyx prompts-sync-claude` | `calyx prompts sync --backend claude` |
| `calyx prompts-sync-codex` | `calyx prompts sync --backend codex` |
| `calyx agents-render` | `calyx instructions render` |
| `calyx exec-launch` | `calyx run launch` |

If a script still uses one of these names, update it to the canonical form.
Git retains the migration history.

## Extension management

Extensions extend Calyx's domain command lifecycle with custom hooks. Three extensions ship in the monorepo:

| Extension | Type | Domains | Purpose |
|-----------|------|---------|---------|
| `calyx-ext-polli` | First-party | skills, tools, agents | Registry pre-flight checks, fleet diagnostics |
| `calyx-ext-linear` | First-party | agents, exec | Linear issue context hints, exec failure diagnostics |
| `calyx-ext-cursor` | Harness-target | config, instructions, skills | Cursor environment hints, rules-format awareness |

Use these commands to manage extensions:

```bash
# Set search paths (colon-separated)
export CALYX_EXTENSIONS_PATH="/path/to/extensions:/another/path"

# List installed extensions
calyx extensions list

# Validate all extensions (recommended before sync/deploy)
calyx extensions validate --strict

# Check a single extension
calyx extensions check --path ./packages/calyx-ext-polli
calyx extensions check --path ./packages/calyx-ext-linear
calyx extensions check --path ./packages/calyx-ext-cursor
```

### Conflict resolution

When multiple extensions claim the same domain, Calyx reports a **domain conflict**:

- **Advisory mode** (default): conflicts are warnings. All extensions load and hooks run in alphabetical order. Appropriate for development.
- **Strict mode** (`--strict`): conflicts are errors. Resolve before production use.

To resolve conflicts:

1. **Remove** the unwanted extension from `CALYX_EXTENSIONS_PATH`.
2. **Narrow** an extension's domain list (edit its `package.json` `calyx.domains`).
3. **Shadow** via search path ordering — place the preferred extension in a later search path.

### Compatibility

Extensions target an `apiVersion` (currently `"1"`). An extension will fail to load if its `apiVersion` doesn't match the installed SDK. When upgrading Calyx:

1. Run `calyx extensions validate --strict` to check all extensions.
2. Watch for `API_VERSION_MISMATCH` diagnostics.
3. Update extension packages to target the new apiVersion.

See [Extension SDK — Compatibility Policy](extension-sdk.md#compatibility-policy) for the full version matrix and migration path.

### Harness-target extensions

Harness-target extensions (e.g., `calyx-ext-cursor`) provide harness-specific environment detection and advisory diagnostics. They are non-destructive (never block commands). To smoke-test a harness-target extension:

```bash
# Discover and validate
CALYX_EXTENSIONS_PATH=packages calyx extensions list
CALYX_EXTENSIONS_PATH=packages calyx extensions validate --strict

# Verify hook invocation (config compile as example)
CALYX_EXTENSIONS_PATH=packages calyx config compile \
  --fleet fixtures/config-compiler/inputs/fleet.v2.yaml \
  --hosts-dir fixtures/config-compiler/inputs/hosts \
  --host blade \
  --parity fixtures/config-compiler/expected/blade.config.toml
```

Extension hooks will emit advisory messages (e.g., "Cursor hint: ...") during command execution.

Daily operator flows should not depend on extensions for core semantics. If an extension is absent, Calyx's canonical domain and `run` commands still define the product contract; extensions only add optional diagnostics or small environment-aware helpers.

**Troubleshooting:**
- If `extensions list` shows no extensions, verify `CALYX_EXTENSIONS_PATH` or `--search-path` is set.
- If an extension fails to load, run `calyx extensions check --path <dir> --json` for diagnostics.
- Domain conflicts (multiple extensions claiming the same domain) are warnings by default; use `--strict` to treat as errors.

For extension authoring, see [Extension SDK](extension-sdk.md). A starter template is available at `examples/extensions/starter/`.

## Related documents

- [CLI Reference](cli-reference.md) — hand-authored detailed command reference
- [Architecture](architecture/README.md) — current substrate and placement laws
- [CI Reliability Runbook](ci-reliability-runbook.md) — CI failure classification and override policy
- [Production Wiring](production-wiring.md) — source resolution and environment/config precedence
- [Extension SDK](extension-sdk.md) — extension contracts and compatibility
