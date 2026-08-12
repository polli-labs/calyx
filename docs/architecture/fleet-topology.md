# Fleet topology authority

`@polli-labs/calyx-core` exposes the read-only source loader and target resolver
for the enrolled Calyx fleet. The source remains
`polli-labs/agents-infra:fleet/truths/hosts.yaml`; Calyx does not own a second
host catalog.

The public core entry points are:

- `loadFleetTopologySnapshot()` — resolves the existing agents-infra root,
  validates and expands the B1 enrollment projection, and returns a
  `fleet-topology-snapshot/v1`;
- `resolveFleetTopologyTargets(snapshot, intent)` — derives all three target
  sets from that snapshot for either `read_only` or `mutating` use.

The B3 command consumers are `self health --fleet`, `self drift --fleet`,
`self freshness --fleet`, `self upgrade --fleet`, and `fleet status`. They all
resolve membership from this contract. Read surfaces use `read_only`; the
upgrader uses `mutating` and therefore refuses non-authoritative topology.
Command implementations may still read credentials, daemon observations, and
convergence rows after target resolution, but those facts cannot enumerate or
change the target set.

## Snapshot identity

A valid snapshot contains:

| Field | Contract |
| --- | --- |
| `source.repository` | Exactly `polli-labs/agents-infra`, verified from the checked branch's upstream remote. |
| `source.ref` | The full upstream remote ref, such as `refs/remotes/origin/main`. A detached head or branch without one exact upstream is ambiguous. |
| `source.commit` | The checked-out commit. It must equal the commit named by `source.ref` for mutation authority. |
| `projection_sha256` | SHA-256 of the JCS-canonical normalized enrolled-host projection. |
| `hosts` | Validated host records with named surface profiles expanded to explicit surfaces. |
| `resolved_at` | Resolution timestamp. |
| `resolver` | `@polli-labs/calyx-core/fleet-topology-resolver@v1`. |

The digest projection is keyed by host identity and contains only `owner`,
`desired_membership`, sorted `roles`, sorted expanded `expected_surfaces`,
`catch_up_policy`, and `run_serve_url`. The profile name remains in the
inspectable host record but is not a second semantic input once expanded.
Credential rows, secret values, daemon records, services, notes, and other host
facts are outside the digest.

The commit and digest serve different purposes. The commit identifies the
source revision; the digest identifies the semantic enrolled-host projection.
Changing an unrelated agents-infra fact changes the commit without changing the
projection digest.

## Membership and targets

Membership comes only from
`hosts.<host>.enrollment.desired_membership`. The resolver returns:

- `desired_active` — records whose value is `active`;
- `withdrawn` — records whose value is `withdrawn`;
- `all_enrolled` — both sets in stable host order.

A `run_serve_url`, a key in `hosts.yaml`, an activation row, or a daemon record
cannot promote a host to `desired_active`. Active hosts require usable routing
as a validation invariant, but that implication is one-way: routing is not
membership.

## Authority boundary

The loader preserves inspectability without laundering weak source state. A
snapshot is labeled `non_authoritative` when the source root or Git identity is
unavailable, the repository or ref is ambiguous, the source changes during
resolution, the checkout is dirty, or B1 validation fails.

`resolveFleetTopologyTargets(snapshot, "read_only")` returns those records with
the authority label and `can_emit_green_verdict: false`. This allows diagnosis
without treating the result as fleet health. The same snapshot passed with
`"mutating"` throws `FleetTopologyAuthorityError`; there is no force flag or
fallback target enumeration.

Runtime observations remain projections. Daemon descriptors, the local
`fleet_convergence` table, reachability, readiness, activation, and admission
state may describe an enrolled host, but none can create or change enrollment.

### C1 bootstrap toolchain observation

`calyx self upgrade` records a narrow `fleet-convergence-check/v1` whose closed
C1 surface is `toolchain`. It is a runtime observation, never topology or
membership authority. The check records the package-manager and Node contract,
the Calyx process Node, the child-resolved Node and pnpm, a bounded redacted
PATH-resolution trace, the bootstrap cwd, target SHA, and the spawn-contract
identity.

The probes and the real `pnpm install`/workspace build use the same
`@polli-labs/calyx/self-upgrade-child-spawn@v1` helper, environment snapshot,
cwd, and executable lookup. An interactive-shell version probe is not an
equivalent check. A mismatch is `blocked/toolchain`; it cannot be reduced to
minor source drift, and a non-dry-run refusal persists both the host receipt
and the operation observation before build starts. `self drift` and `self
freshness` expose this named check alongside source/daemon state.

C1 deliberately does not define the RFC's full convergence suite or aggregate
admission policy. C2 owns the remaining closed surfaces and their complete
aggregate verdict; extending this C1 schema ad hoc would create a second suite
authority.

## Command consumption

Every B3 fleet envelope and receipt includes the complete snapshot identity,
including `source.commit` and `projection_sha256`, plus the authority label.
The durable self-upgrade plan/operation record retains the exact commit and
digest as `topology_snapshot`. Desired-active hosts form the only active verdict or mutation
denominator. An unreachable desired-active host is `unavailable`; it is not
silently dropped and the aggregate cannot be green. Withdrawn hosts remain
visible under `excluded_withdrawn`, but they are never probed, targeted, or
counted in the active denominator.

This removes three predecessor enumeration authorities: URL-bearing host rows
for health/upgrade, every `hosts.yaml` key for drift/freshness, and locally
persisted convergence rows for `fleet status`. Routing remains data on a
resolved target, not a membership test.

The topology projection digest is also the caller's current-authority binding
for managed run starts. See [`workload-admission.md`](workload-admission.md) for
the universal no-start fence and its D1 interim evidence profile.
