# Workload admission

`RunService` has one no-start boundary ahead of every managed workload launch.
The boundary owns reconciliation, exact-evidence validation, caller-authority
binding, and a one-shot run-creation capability. HTTP, CLI, task, resume, and
workflow callers may shape an intent, but neither `RunService` nor `RunStore`
exposes a package-root path that can initialize a record without that
capability. First execution of a stored queued run crosses the same boundary
again; readoption or observation of work that already started does not.

The daemon boots fenced. Its listener, health, status, and repair surfaces stay
available while workload admission is closed. Boot applies state migrations,
reconciles existing runs, and then evaluates admission; a failed evaluation
leaves management available with a typed reason and next action. Existing work
is never terminated merely because the no-start fence closes.

## D1 interim opening rule

The currently implemented gate is intentionally reduced and is named
`d1-interim-topology-reachability-build-schema` in every gate receipt. It opens
only when these exact surfaces pass, in this order:

1. `topology` — a fresh, authoritative `fleet-topology-snapshot/v1` resolves
   committed hosts truth from the checkout's configured upstream ref and
   resolves the local host from the desired-active target set;
2. `reachability` — the launch-serving process is reachable through its active
   listener, or through the in-process boundary for local execution;
3. `running` — the running build identity is stamped and the build is clean;
4. `state_schema` — the read-only migration plan reports the current schema at
   the declared target with no pending migrations.

Each accepted receipt records that exact evaluated set and separately records
the deferred full-gate surfaces: `toolchain`, `clone`, `promoted`, `daemon`,
`config`, `skills`, and `hot_instruction`. The reduced set is explicit rather
than implied; adding a check requires a new named profile and receipt contract.
This lets today's fleet open the fence without misrepresenting the not-yet-built
desired-build and full convergence authorities.

Admission deliberately resolves committed upstream-ref content instead of
requiring a pristine working checkout. A fetch that advances the configured ref
ahead of checkout or unrelated dirty files do not fence the host: neither
changes the committed topology authority evaluated by the gate.
B2 mutating fleet planning retains its stricter clean-checkout rule. Missing,
unresolvable, wrong-repository, changing, or invalid committed authority still
fails closed.

The D1 refusal names the concrete action that owns each repair. Build drift uses
`calyx self upgrade --host <host> --yes --json`; pending state migrations use
`calyx state migrate --apply --json`; state corruption is first diagnosed with
`calyx state doctor --json`. Two authority repairs intentionally remain outside
D1: restoring missing or invalid agents-infra authority belongs to D2 catch-up,
and changing a host from `withdrawn` back to desired-active belongs to D3 fleet
lifecycle policy. D1 cannot honestly offer a local force-open for either case;
until those owning operations exist, it names the authority change required and
keeps the host fenced.

## Current-authority binding

Every remote launch request carries the `projection_sha256` of the authoritative
topology snapshot against which the caller planned the target. Before issuing
the one-shot creation capability, `RunService` obtains fresh admission evidence
and requires the caller digest to equal the accepted topology projection digest. A
stale caller receives `workload_admission_fenced` with reason
`topology_mismatch`; a withdrawn target receives the same typed error with
reason `withdrawn`; missing or invalid evidence remains fenced. A refusal
creates no run record.

The accepted target bundle, exact gate receipt, decision timestamp, typed
reason, failed surface, and next action are published under
`workload_admission` in daemon health and admin status. Rolling readers may see
that field absent only when talking to a pre-D1 daemon. New daemons always
publish it. If fresh evidence later fails, the fenced arm retains historical
authority only under `last_accepted_topology`, `last_accepted_target_bundle`,
and `last_gate_receipt`; fenced evidence never appears under current
`accepted_*` names.

Admission is reconciled afresh for each new start and serialized across local
processes sharing the run store, so an authority change cannot race two
independent launch call paths. Lock acquisition is bounded; contention returns
the typed `workload_admission_busy` refusal and does not alter the last published
decision. Resume-default resolution, record persistence, and event I/O happen
outside the global admission lock. Evaluation itself never publishes
`repair_in_progress`; that reason is reserved for an actual repair operation. A
replay of an already-accepted idempotent HTTP request returns its original
receipt and does not constitute a new workload start.

## Separate controls

`maintenance_mode` remains an operator drain control. It is neither evidence
for this fence nor a way to override it. There is no force-open flag: the only
opening action is successful reconciliation against a configured provider and
an exact, runtime-validated receipt.
