# Calyx workflow coordination

> **Status: admission contract; no generic workflow engine is implemented.**
> POL-1983 is canonical; detailed design and review lineage live in vault plan
> `20-plans/calyx-workflow-engine-durable-reducer-spec-2026-07-13.md`.
> POL-1792 is agent-definition and early-discussion lineage only.

Calyx needs machine-enforced coordination for typed handoff, evidence gates,
bounded repair, and restart recovery. The accepted shape is a small durable
reducer over RunService, earned from real callers rather than designed as a
callerless platform.

## Core law

A Calyx coordinator reduces an immutable, typed request into durable
caller-state and attempt records owned by one daemon.

RunService remains the only leaf executor and the authority for leaf run
state. Coordination owns only dependency readiness, bounded iteration, typed
handoff, deterministic evidence evaluation, effect adoption, recovery, and
its own ordered ledger.

Correctness cannot depend on a resident script, harness process, model context,
SSE connection, monitor delivery, or wake. Periodic reconciliation is the
floor; delivery mechanisms only reduce latency.

The coordination layer does not:

- spawn harness CLIs directly;
- introduce a second leaf-execution state machine or RunService receipt
  authority;
- accept arbitrary TypeScript, JavaScript, shell, environment, or raw
  `RunIntent`;
- claim implicit rollback for external effects;
- absorb Tasks, Symphony, monitors, or human judgment;
- expose execution truth from a UI or client-side controller.

Once earned, shared semantics stay closed to `run`, pure `gate`, and
non-resident `wait`; sequence and bounded collection/iteration are authoring
shapes, roles are data, and evidence labels are never lifecycle states.

## Caller-first abstraction law

The generic nouns are earned only after two independently useful,
caller-specific state machines have run in production:

1. an independent review gate:
   published target, independent reviewer run, intrinsic evidence, daemon
   publication receipts, then a terminal decision;
2. a bounded repair loop:
   implementation, verification/review, explicit repair, then re-evaluation
   under hard limits.

The review coordinator lands and soaks without a public workflow DSL, generic
node schema, or generic workflow API. The repair coordinator then lands and
soaks independently. Only afterward may an extraction introduce the shared
subset both implementations actually duplicate, deleting both caller-specific
copies in the same change.

There is no speculative two-caller landing bloc. A diagram, fixture, or planned
program is not a caller. Each caller must name the production entry point and
manual/controller seam it replaces and carry a production receipt.

Unused wait, compensation, fan-out, or generic expression surfaces do not land
because a grammar reserves them. Each requires a current caller.

## Trigger and cascade boundary

A schedule, monitor wake, message, attention mark, provider event, or parent
output is an observation, not an instruction to execute. It cannot launch,
resume, cancel, repair, reprioritize, or otherwise mutate a coordinator merely
because the reducer can see it.

Making an observation actionable requires a real caller-specific admission
boundary. That boundary authenticates the requester and authorizes the named
operation and resource. Separately, it validates the observation's identity,
digest, provenance, and currentness at its owning authority and retains the
observation only as evidence or typed input. A valid observation never grants
execution authority.

Admission freezes a capability-specific trigger-input envelope and its
non-secret policy material, applies hard scope and attempt bounds, and commits a
natural key or subject-scoped idempotency key with the canonical request hash.
Re-observing the same key and hash adopts the existing admission; the same key
with different bytes conflicts.

Trigger input and replay material are bounded, schema-versioned, and positively
constructed from fields explicitly safe for coordinator storage, never copied
from an arbitrary source body. Source-owned bytes that are not safe to retain
stay at their owning authority; admission stores only the typed identity,
digest, provenance, and currentness evidence the caller actually needs.
Credentials, secret references, environment, prompts, transcripts,
attachments, undeclassified model output, bearers, and host-local paths are
excluded by default. A digest binds identity but does not declassify or
authorize copying source bytes.

No generic scanner schema, cursor/checkpoint protocol, replay registry, or
event acknowledgement contract lands in advance. A real trigger caller must
earn and prove the source-specific replay and progress law it needs without
turning mutable delivery state into authority.

Once implemented, authoritative `activity_marks` rows remain inert
`consumer_v1` filings associated with activity locators; the activity index
remains a derived store. A mark may be frozen as typed input to a future caller,
but mark creation, revocation, ranking, or query never becomes a hidden workflow
control. Any policy that makes a mark or other filing actionable is a separately
specified trigger capability with its own authority, replay law, bounds, and
real caller.

A cascade is likewise a new caller submission, not an implicit reducer edge or
subworkflow stack. It references an accepted parent output by stable identity
and digest, records parent/child lineage, and passes through the child's ordinary
authenticated admission, stable idempotency, and recovery law. Parent and child
dispositions remain independent unless the caller explicitly names the child's
typed evidence as a parent gate.

A future cascade caller enforces chain-global hard bounds: immutable chain
identity and ancestry, maximum depth, total effect and attempt budgets, and one
absolute deadline. Every descendant and sibling consumes those same bounds;
children cannot reset a counter, receive a fresh relative timeout, extend the
root deadline, or re-enter a caller/resource cycle. Copied per-child balances
are not chain-global enforcement. The caller must prove race-safe accounting
under its owning authority, but this contract does not preselect a record
layout, transaction protocol, or cross-authority design before that caller
exists. The first two callers forbid cascade-originated admissions entirely.

The first two callers admit only through their named production entry points.
No generic trigger grammar, cascade API, recursive traversal, or event-to-run
binding lands before a real caller earns it.

## Caller A: independent-review reducer

The first bounded caller-specific reducer is the independent-review coordinator
in `@polli-labs/calyx-run-service`. Its caller-owned store uses seven tables:
`review_instances`, `review_attempts`, `review_effects`,
`review_effect_observations`, `review_evidence`, `review_obligations`, and
`review_events`. Admission atomically commits one immutable pinned-target
request, its first attempt, a stable reviewer-launch effect, current state, and
the matching event.

The reducer consumes only RunService-resolved leaf observations and a
RunService-minted evidence receipt; it does not mint leaf truth. It evaluates
attempt-bound `review-findings/v2` and creates one immutable fenced effect plus
one obligation for each closed provider, currently `github_review` and
`linear_comment`. Provider observations are typed, bounded, append-only rows
ordered within their provider effect. A later delivered observation may resolve
its provider obligation but never erases an earlier indeterminate observation.
Intrinsic evaluation, publication status, and final caller disposition remain
independent axes.

Effect adoption must repeat the persisted request hash and claim fence; a later
claim generation cannot adopt an earlier effect. RunService snapshots may skip
intermediate active states, but cannot regress an attempt or replace one
terminal observation with another.

The package exports a bounded admin-only read model and RunService resolver
boundary. It does not expose this reducer through a CLI, HTTP route, consumer
DTO, UI resource, or generic workflow API. The read model omits raw launch
material, provider envelopes, model output, paths, environment, and credentials.
It reports bounded identifiers, timestamps, portable artifact locators, request
and receipt digests, invalid-reason summaries, and at most two provider
summaries.

Caller-controlled identifiers and integers are bounded at admission, not merely
truncated during projection. Identifiers, subjects, actors, policy versions,
repositories, provider identities, and observation identities have explicit
UTF-8 byte ceilings; positive integers must be JavaScript-safe integers.
Canonical launch material is capped at 256 KiB. Each provider envelope carries
the exact execution body under a 128 KiB ceiling plus the corresponding SHA-256
digest; adapters do not depend on ambient rendering or a later body lookup.

Caller A's launch capsule is a closed positive contract: schema version,
reviewer agent reference, target host, exact target SHA, and the literal required
`findings.json` artifact. Unknown fields are rejected before admission, including
environment, prompt, path, tool, secret-reference, and credential-slot material.
Agent and host values use positive identifier grammars and name daemon catalogs;
an eventual effect driver must resolve those identities rather than execute them
as free-form launch material.
The authenticated admission also freezes the Linear publication target. At
evidence time RunService cross-checks that target against the authoritative
reviewer run intent, while the reducer derives both exact publication bodies,
content marker, content digest, body digests, and configured publisher identities
from immutable admission plus evaluated evidence. The evidence caller supplies
only the review instance identity and cannot select an adapter, provider resource,
body, digest, or publisher.

No production entry point invokes Caller A yet, so this source-only reducer
contributes no production-soak evidence and cannot count toward shared
extraction. A lost first launch receipt remains `launch_indeterminate` with an
open reconciliation obligation; blind re-execution is forbidden until
RunService provides create-or-adopt by stable launch identity plus a retained
supervisor tombstone.

## Immutable submission

Submission stores canonical request bytes and digest, authenticated provenance,
hard bounds, policy versions, and the complete static launch material reachable
from the request.

Static launch material is transitively closed: agent definitions, templates,
procedures, tool contracts, schemas, and policies are stored by bytes and
digest. Effect-time lookup by mutable installed name is forbidden.

Inherited `caller_activity` context is frozen at submission, including:

- activity ID;
- exact terminal cursor or message boundary;
- normalized message-set digest;
- exact materialized context bytes;
- context schema and canonicalizer versions.

Waiting, scheduling, or restart cannot change those bytes. Later conversation
enters only through a declared typed input with its own evidence.

Attempt materialization may add only facts unavailable at submission: bounded
iteration coordinates, validated upstream values, an eligible target and its
observation, backend/model selection under policy, and compiled launch bytes.
The resulting launch capsule is persisted before an effect intent.

## Capability negotiation

Required execution capabilities are derived mechanically from the immutable
request and launch material. The stored record includes the derived set and the
derivation algorithm version.

Author declarations are additional minima only for opaque definition, template,
tool, or policy requirements that structural derivation cannot infer. Effective
requirements are the union; authors do not duplicate mechanically inferred
requirements.

Target selection treats attempt requirements as eligibility. An unpinned
attempt considers only compatible targets. An explicitly pinned incompatible
target fails before an effect intent. Schema recognition alone never implies
execution support.

Stored requests must have old/new-daemon golden fixtures so a compatible newer
daemon does not reject unchanged bytes merely because its internal feature
taxonomy became more precise.

## Reducer and effect protocol

One daemon owns a coordinator instance. A short database ownership epoch and
monotonic fencing token serialize reduction; this is not a public advisory
lease.

Acquisition and renewal are different operations. Acquisition is permitted
only when no unexpired claim exists, including one held by the same owner, and
increments the fence. Renewal requires the exact current owner and fence,
cannot shorten the deadline, and preserves the fence so already-claimed
effects remain adoptable. Claim TTL is capped at 60 seconds. Exact owner-and-
fence release clears only that coordinator claim, retains the fence, and never
makes an already claimed effect replayable. A daemon never renews by reacquiring.

A tick:

1. claims the current epoch;
2. loads immutable request state and normalized RunService observations;
3. reduces terminal facts and validates invariants;
4. chooses ready caller states in deterministic order;
5. commits attempts, effect intents, stable identities, request hashes, and
   matching ordered events;
6. closes the transaction;
7. performs only effects still owned by its fence;
8. adopts results by stable identity and hash, then reduces again.

No database transaction spans process, network, filesystem, model, or
supervisor work. A stale claimant may observe or adopt; it may not originate a
new effect.

Every Calyx-owned API or coordinator write has either a natural domain key or a
subject-scoped idempotency key plus canonical request hash. Same key and hash
returns the stable coordinator record; same key with different bytes conflicts
without mutating the resource. A downstream provider mutation is an internal
effect of that record, not another Calyx public write. Caller A persists one
effect per provider identity; the effect request contains only that provider's
closed, self-sufficient envelope. Append-only typed observations carry
provider-backed identity and canonical receipt digest. Their identity is the
pair of immutable effect and bounded observation ID: exact replay is a no-op,
conflicting bytes under that pair fail, and the per-provider history is bounded.

## Atomic launch and durable adoption

A database intent row alone is not a crash-safe spawn guarantee. RunService
must provide atomic create-or-adopt by stable launch identity and intent hash
before a caller claims crash-safe coordination.

The launch supervisor persists a tombstone containing launch identity, intent
hash, unit/process identity, creation result, terminal result when known, and
retention deadline.

That tombstone outlives transient unit collection, process exit, daemon
restart, RunService compaction, and coordinator garbage collection through the
longest relevant workflow and idempotency retention horizon. An absent live
unit with a matching tombstone adopts the recorded result and never respawns.
The same identity with a different intent hash conflicts.

Crash tests kill the owner after intent commit, spawn claim, process creation,
supervisor receipt, locator adoption, child terminalization, and caller-state
reduction. Every permutation must prove one child and one terminal receipt.

## Typed output law

Typed final output is a compare-and-set scoped to one attempt and output name:

- schema-invalid requests do not occupy the key;
- the first schema-valid canonical value or portable artifact locator wins;
- same-hash replay returns the original receipt;
- every later different hash is rejected and audit-only;
- later conflicts never fail the node, replace accepted output, or change
  disposition, regardless of reducer or consumption timing.

Resource authorization happens before schema validation or CAS admission. A
submission grant binds the authenticated daemon subject to the exact attempt,
output name, stable launch identity and intent hash, and current producer
generation or fence. A wrong host, attempt, output name, launch, generation, or
fence cannot occupy the key. Daemon-tier authorization for the operation is
necessary but never sufficient for the resource write.

The storage/CAS order decides which schema-valid value is first. With that order
fixed, reducer ticks and later response/consumption timing preserve the accepted
value and disposition; simultaneous requests record an explicit serialized CAS
order. Harness final text, transcript parsing, exit status, and ambient files
are not typed handoff channels.

The first review caller reuses existing required-artifact storage and RunService
receipts. RunService resolves the durable terminal receipt, requires exactly
one successful required `findings.json`, reads the source as an unchanged
regular file under a one-MiB bound, verifies source size and SHA-256 against the
kernel receipt, parses strict UTF-8 JSON, and mints correspondence evidence with
both source and canonical-JSON sizes and SHA-256 digests. Caller A can reduce
that evidence but cannot mint it. The issuance timestamp comes from the
validated immutable terminal receipt, while the database `recorded_at` remains
the transition clock, so a later retry preserves the same receipt identity.
The evidence row ID is coordinator-derived from instance and attempt; a worker
field must match it and never owns the global SQLite key. A general output or
artifact service requires a second caller.

## Evidence evaluation

The first acceptance proof is a versioned, pure, reviewer-specific evaluator,
not a generic expression AST. It consumes immutable request, target, attempt,
round, producer-fence, artifact-digest, and intrinsic findings evidence. Delivery
is never worker-authored evidence. A same-named artifact from an earlier attempt
cannot satisfy the current obligation.

Authoritative review admission binds immutable input. Local inspection of an
existing worktree may produce a complete byte-set digest and audit evidence,
but it cannot originate caller-level decision evidence or a provider
effect. A direct leaf launch likewise cannot mint caller-level truth.

A caller decision is durable evidence, not a portable authorization token,
signature, branch-protection result, or permission to mutate another resource.
The first review caller exposes no decision-validation endpoint. A future
automated action that depends on review evidence must enter as its own real
caller and validate currentness at the authority that owns that action, then
consume one-time authorization within the action boundary. A provider-native
required check may be such an authority; cached coordinator state, a local
activation row, or a status authored by the coordinator is not. Without an
action-local authority, the decision remains observational and fails closed for
automation.

Owner-state restore or owner-identity compromise has an explicit fail-closed
boundary: fence new provider effects, retain adoption and cleanup obligations,
replace compromised publisher authority before reactivation, and rerun affected
work. Already published receipts remain evidence rather than authorization. The
contract cannot claim to distinguish a restored stack that retains its
credentials, trust same-generation quarantine authored by that stack, or
recover actions already taken before detection.

Provider delivery is a separate daemon-owned effect. An adapter may establish
delivery only from provider-observable identity and state under its declared
exact or at-least-once semantics; unobservable provenance is never an adoption
predicate. Ambiguous, inaccessible, stale, or incompletely enumerated provider
state remains indeterminate. A multi-resource adoption brackets subsidiary
enumeration with a final parent-envelope re-read and records a point-in-time
observation rather than an atomic provider/SQLite snapshot. Provider failure
never reruns the reviewer or rewrites its artifact.

GitHub delivery requires an exact pinned-commit `COMMENTED` review by the
configured publisher identity, exact body/marker/digests, exhaustive review and
review-comment pagination, zero inline comments, and equal canonical
pull-request envelope snapshots before and after child enumeration. Linear
delivery requires the exact issue, stable comment identity, configured publisher
actor, exact body/marker/digests, and a current non-archived comment. The resolver
computes the canonical receipt digest; a caller-supplied digest is not part of
the observation contract. Until those provider resolvers exist, source-only
Caller A can preserve indeterminate observations but cannot claim delivery or
reach `ready`.

Review evidence, provider delivery, and final decision are caller-specific
coordinator records in the authoritative coordinator store. They derive from,
and never compete with, RunService leaf receipts. The pass policy is fail-closed:
intrinsically complete full-coverage review, the exact mergeable verdict, zero
findings, and delivered receipts for every required canonical surface. A valid
nonzero review is preserved as not passed.

Activation and production-soak evidence remain owned by POL-1983 and its
Fieldwork plan. A generic gate language remains forbidden until two independently
soaked evaluators expose the same operations.

## Leaf-state mapping

The coordinator records the exact RunService state and derives its disposition
without erasing source truth:

- queued, dispatching, and running remain active;
- succeeded is success only after required typed evidence validates;
- an explicitly allowed partial reason may continue under persisted policy;
- every other partial fails;
- an eligible infrastructure error may retry under a persisted bounded budget;
- exhausted infrastructure error, failed, authentication error, and dirty
  completion fail without automatic retry;
- cancelled is never success;
- unknown effect acceptance is indeterminate and must reconcile.

Continuation, infrastructure retry, repair iteration, and operator retry are
distinct immutable attempts with explicit lineage.

## Cancellation and cleanup

User-visible disposition and effect cleanup are separate durable records.

Cancellation stops new forward planning and output consumption, fences live
attempts, and requests child cancellation where a target is known. A caller may
reach visible failed or cancelled disposition while a cleanup obligation
continues adopting late receipts, observing or stopping children, and running
declared compensation.

Cleanup cannot reactivate dependents or rewrite the original disposition. It
ends only when effects are resolved or an explicit risk-acceptance receipt
closes the obligation.

An indeterminate effect cannot receive a new attempt identity unless the caller
declares and the engine enforces an external business-idempotency key shared by
both attempts. Idempotency of the operator retry request is insufficient.

Compensation is explicit topology with its own identity, bounds, effect, and
receipt. It records best-effort repair beside the original failure and never
claims to undo arbitrary git, tracker, message, process, or model effects.

## Security and authority

Adapter spawn is scrub-by-default before workflow callers launch. The harness
receives an explicit allowlist of non-secret environment variables; it never
inherits ambient `process.env`.

Secrets and secret references are not workflow data. Launch material may name
daemon-owned credential slots, but stores only slot IDs and policy digests.
Authenticated external actions use daemon-owned credential and tool brokers
that do not expose bearer values to the harness or model.

Review workers receive pinned material and emit admin-only structured findings.
A daemon-owned publisher accepts an intrinsic evaluator receipt, validates the
artifact and content digests, performs GitHub/Linear delivery, and persists
provider-backed delivery receipts. Workers do not receive publisher credentials
and their artifacts are never authoritative for delivery status.

All model-produced values, findings, artifacts, transcripts, and prompts are
admin-only by default. Consumer exposure requires a separately specified
positive declassification capability and audit receipt.

A control-plane tier shared with operator clients is not a daemon principal.
Remote effect execution, cross-host output submission, reconciliation mutation,
and state repair require a daemon-only credential tier plus per-operation
authorization of the authenticated daemon subject. Until both are present,
those effects remain in-process; a path prefix is not a principal boundary.

## Persistence and projection

A coordinator has one authoritative SQLite state store. RunService remains
separately authoritative for leaf state. Every current-state transition and its
matching event commit atomically.

Event sequence is monotonic per instance. Same event identity and payload hash
replays; same identity with a different payload conflicts. Periodic
reconciliation converges after restart without a live harness wake.

Observation is bounded and positively constructed. It may expose identity,
immutable request/program digest, caller state, gate decisions, safe summary
metadata, provenance, timestamps, portable locators, and event cursors. It
never exposes absolute paths, raw launch intents, environment, credentials,
unbounded text, or arbitrary model output.

The UI and consumer API are read projections. They never own execution state or
perform client-side reduction.

## Admission proof

Before shared extraction, both callers need production soak receipts. The
extraction deletes actual duplication and is smaller than the replaced code.

The proof suite covers attempt-bound reviewer-artifact and publisher-receipt
fixtures, restart and
simultaneous-tick permutations, retained supervisor tombstones,
scheduling-independent output conflicts, wrong-host and stale-generation output
rejection, exact leaf-state disposition, bounded repair exhaustion, finding
conservation in the repair caller, durable cleanup, indeterminate-effect
refusal, actual child environment scrubbing, broker/publisher separation,
admin-only model output, daemon-only internal authorization, capability skew,
ordered event replay, the green repository gate, and a zero-finding adversarial
review.

Non-goals are a callerless platform, arbitrary code, resident controller, second executor,
mutable registry, GUI builder, plugin framework, unbounded recursion, distributed
scheduler, implicit rollback, autonomous merge, or undeclassified model bytes.

## Lineage

POL-1983 is canonical; POL-1792 is agent-definition/early-discussion lineage;
POL-1843 covers posture propagation; POL-1901/POL-1980 own the consumer seam.
