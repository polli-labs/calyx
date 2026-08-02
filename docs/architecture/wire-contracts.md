# Calyx wire contracts

> **Status: ratified v1.** The cross-cutting contracts every typed Calyx
> surface shares — all profiles, all projections. A capability spec
> ([`consumer-api.md`](consumer-api.md)) pins *what* a capability does; this
> page pins *how* every capability speaks on the wire. New HTTP routes, client
> namespaces, and daemon payloads conform to these contracts or state a
> deviation in the PR. Tracking: **POL-1901**.

## 1. Envelopes and schema versioning

**Newly authored or materially reshaped** payload schemas name themselves
**in the payload** (`schema_version` field), not only in the route path.
Live payloads are cataloged — including the ones that predate the rule; the
catalog describes reality, it does not retrofit it:

| Family | Examples | Status |
| --- | --- | --- |
| `calyx.<noun>/v<major>` | `calyx.error/v1`, `calyx.msg-send/v1`, `calyx.provenance/v1` | the grammar for **new** schemas |
| established named schemas (domain-dot and root-hyphen forms) | `activity.turns/v1`, `activity.messages/v1`, `run-logs/v1` | kept as-is |
| `calyx.host-process-receipt/v1` | bound `HostProcessReceipt` | current host-process receipt; effect-admission chronology and binding are part of the named family |
| bare `"1.0"` | `RunRecord`, predecessor unbound `HostProcessReceipt`, `CalyxStreamEvent` | legacy; migrates to a named family when its payload is next reshaped — not before, and not silently |
| schema-less | lease acquire/release/list results, other raw objects/arrays | legacy; gain `schema_version` when their route is zod'd at the edge; until then the OpenAPI spec documents their concrete shapes directly |

Rules:

- Routes are versioned `/v1/...` from day one; payload versions can advance
  without a route bump when the change is additive. Pre-existing unversioned
  routes (`/runs*`, `/events/stream`, legacy `/activity`) are pinned to
  migrate under `/v1` with the unversioned paths deleted in the same change
  (POL-1901 owns when).
- **Compatibility is direction-specific.** In *responses*: adding optional
  fields stays within a major; removing fields, removing enum variants, or
  re-typing/reinterpreting a field requires a new major. **Response enums
  are open by default** — generated clients must carry an unknown-variant
  fallback; adding a variant to a declared-**closed** enum is breaking.
  Schema-major literals and union/status discriminants that select a
  different response shape are closed: an older client cannot interpret an
  unknown shape safely. OpenAPI marks those with
  `x-calyx-enum-mode: closed` plus an explicit closure classification; fields
  authored through the open-enum helper are marked open even when their
  current known-value set contains only one member.
  In *requests*: adding an **optional** parameter stays within a major;
  adding a **required** field, tightening constraints, or removing accepted
  variants is breaking and requires a new major or a new operation.
- **Deployment skew is normal** (host-routed fleet), so both directions are
  pinned: request readers (daemons) **ignore unknown optional fields**
  within a major — an old daemon must not reject a newer client's optional
  additions; and a new optional request parameter must be **omit-safe**
  (server behavior without it is exactly the old behavior), so newer
  clients degrade cleanly against older daemons. Readers tolerate unknown
  optional fields; writers never emit fields outside the declared schema.
- Within a **named family**, a consumer that receives an unknown major must
  treat the payload as unreadable, not best-effort parse it. Legacy
  bare-`"1.0"` and schema-less shapes are outside that rule until they
  migrate.
- Schema-less per-run lifecycle and run-service journal rows are deliberately
  closed at the top level: `run_id`, `event`, and `source` (when present) are
  authority discriminants, not a rolling extension surface. `payload` is the
  sole additive extension channel for those local rows. An unknown top-level
  field makes the active local projection unreadable; repair preserves the
  exact original journal generation in quarantine before rebuilding without
  that invalid row. This is distinct from the legacy bare-`"1.0"` global
  `CalyxStreamEvent` replay contract, whose same-major schemas remain
  passthrough.

## 2. Error contract — `calyx.error/v1`

One error envelope for every non-2xx response and every failed operation
inside a 2xx composite — the shape the daemon's typed paths (monitor, lease,
attachment) already emit and the CLI already parses, now the contract:

```jsonc
{
  "error": {
    "schema_version": "calyx.error/v1",
    "code": "lease_owner_mismatch",     // stable, snake_case, enumerable
    "message": "human/agent-readable, one sentence",
    "details": { },                      // optional, code-specific shape
    "hint": "the next command or fix",   // optional self-correction hint
    "retryable": false                   // optional rolling field; see below
  }
}
```

- **Codes are contract**, messages are not. Clients branch on `code`; agents
  read `hint`. Codes enumerate in the OpenAPI spec per operation.
- **Bare `{error: "<string>"}` shapes (no envelope) are legacy** and are
  deleted as routes are touched (absorption discipline applies to error
  shapes too). No route ships both forms.
- HTTP status carries the class (400 caller / 401 authn / 403 profile /
  404 missing / 409 conflict / 422 semantic / 5xx daemon); `code` carries the
  case.
- Current writers emit `retryable: false` for definitive 4xx failures. During
  a rolling upgrade, an exact known predecessor 4xx code remains definitive
  when that predecessor omitted the field. For a mutation, only an exact
  generated `(status, code)` pair grants authoritative API-failure semantics:
  an additive pair unknown to the client remains indeterminate even when its
  envelope says `retryable: false`. That rolling field is diagnostic, not a
  server-controlled authority upgrade. Reads may surface a structurally valid
  same-major unknown envelope, but clients claim descriptor membership only
  for the status/code pairs they know.

## 3. Identity, provenance, and actors

Every mutation records who did it, from where, mechanically dereferenceable:

```jsonc
{
  "schema_version": "calyx.provenance/v1",
  "request_id": "req_4b6f2c20-20d8-4e18-8989-a2591b5b4778", // server-issued UUIDv4
  "subject": "switchboard",                   // AUTHENTICATED client_id (credential)
  "asserted_actor": "operator:caleb",         // claimed fine-grained actor — audit only
  "host": "carbon",
  "via": "http",
  "at": "2026-07-11T22:40:00.000Z"
}
```

- **The subject is authenticated; the asserted actor is claimed.** The
  daemon derives the `subject` from the presented credential
  (`client_id` — see §9) and binds every identity-sensitive semantic to it:
  sender, marker, filer, owner, idempotency namespaces. The
  `asserted_actor` (an activity locator or `operator:<handle>`, never free
  prose) is recorded for audit and lineage — it is **never used for
  authorization**. Impersonation across clients is impossible; within one
  client credential it is audit-visible.
- Any credential's requests **may** carry `operator:` or agent-activity
  asserted actors — GUIs are operator-driven, host daemons front many
  agents. Enforcement is per-*operation* profile (§9), never per actor
  kind. Per-human/per-agent credentials are the named upgrade path that
  makes fine-grained identity authenticated.
- The daemon issues a fresh `request_id` for every HTTP response and admits the
  full envelope only after credential, profile, path, query/body, and asserted
  actor validation. Every admitted mutation gets a bounded common request-audit
  row, including rejected effects and indeterminate transport completion; reads
  and pre-admission rejections do not.
- Operation-level `x-calyx-effects` is the conservative receiver-side envelope
  for invoking an operation. Successful responses refine that envelope to the
  realized branch. An error response without `x-calyx-effects` is unspecified
  and inherits the operation envelope for safe planning; absence must never be
  interpreted as proof of `none`.
- Capability-owned durable evidence stores the complete validated snapshot
  (typically as JSON) at the mutation boundary. Resource-creation provenance is
  immutable across replay; a later replay's actor appears only in the common
  request audit. Column projections may index subject or actor, but they never
  substitute for the full `request_id`/host/`via: http`/timestamp snapshot.
- Receiver-owned cross-host enrichments are not caller payload. Internal message
  ingress rejects payload keys `remote_sender_receipt_path` and
  `remote_sender_spooled_at` before persistence, then derives them from the
  validated outer message record. Trusted transport observation is written
  after portable sender payload even when validation already makes overwrite
  impossible.

## 4. Idempotency

Writes that advertise retry authority are safe to retry only through the
exact mechanism declared by the operation:

- **Idempotency key** — keyed JSON writes (including create mark, launch a run,
  and send a message)
  carry a caller-supplied `idempotency_key`, scoped **per authenticated
  subject per operation**. The baseline identity is SHA-256 over RFC 8785
  (JCS) canonicalization of the **presence-normalized admitted request** —
  schema-declared body fields after validation but **without materializing
  defaults** — excluding transport metadata, `idempotency_key` itself, and
  `asserted_actor`. Omitted optional fields therefore remain omitted across a
  same-major schema upgrade that adds an omit-safe field (§1's skew rule).
  The row stores the JCS canonicalizer, operation schema major, and any
  operation-specific semantic canonicalizer. A replay whose stored identity
  versions are no longer supported is `409 idempotency_conflict`, never a
  silent recompute.

  Admission transforms require two explicitly different identities rather
  than pretending the wire spelling and admitted effect are the same thing.
  `msg.send` is the standing example:

  1. **Wire recovery identity** — `wire_request_hash` is JCS over the validated,
     presence-normalized body *as sent*, before address or fleet-topology
     resolution. An identical retained request under the same subject,
     operation, key, and schema returns the original durable result **before**
     consulting current topology. Removing or remapping an alias cannot turn
     recovery into a new routing decision.
  2. **Semantic effect identity** — `request_hash` is JCS over the admitted
     request after both message addresses have been resolved to their canonical
     fleet identities. Its stored semantic canonicalizer is
     `calyx.msg-send-semantic/v1`. A different wire spelling (for example an
     alias versus its canonical host) may replay only when the currently
     supported semantic canonicalizer proves the same admitted effect. A
     changed wire request that now resolves to a different target therefore
     conflicts; it never inherits the old key for that new effect.

  Operations without admission transforms need only the baseline identity;
  their admitted and wire representations are the same. Replay with a proven
  identity returns the original result. Same key without either the exact wire
  recovery identity or a supported equivalent semantic identity is
  `409 idempotency_conflict` — never a silent false-success. Keys expire with
  the operation record, not before. Fixtures cover key-reorder equivalence,
  body-mutation conflict, omitted-optional-field same-major skew, alias versus
  canonical semantic equivalence, and exact retained-wire recovery after
  topology drift.
- **Operation identity** — a fixed bodyless POST whose operation itself is
  convergent may repeat its exact prepared request.
- **Request-target identity** — a bodyless DELETE with a validated immutable
  path target may repeat its exact prepared request. This authority is narrow;
  it never applies to a JSON POST merely because the domain has a natural key.

A domain natural key may still converge distinct requests, but it is not by
itself transport-replay authority. Attention marks make the distinction
concrete: `(subject, target_kind, target_id, kind)` is unique **over active
rows**, so create A -> response loss -> concurrent revoke A -> replay would
otherwise create B. Mark creation therefore uses a caller idempotency key;
same-key replay returns A even after revocation, while a fresh re-mark requires
a fresh key. Asserted actors remain provenance, never key material.

First-party transports serialize an idempotent request once, retain those
exact bytes for a bounded in-process recovery loop, resolve one exact bearer
credential for the complete logical operation, and reuse that credential and
the same key for every attempt. Ordinary retry, keyed recovery, and SSE
reconnect never silently cross authenticated subjects within one operation. A
connection failure, interrupted response body, empty success body, or malformed
success body is an **indeterminate result**, not permission to mint a new key.
If bounded recovery still cannot establish the result, the
transport fails loudly with a projection-specific typed receipt. The generated
package uses `calyx.client-indeterminate-result/v1`, binding the source contract
digest, operation, method, canonical origin/base path, generated path, generated
headers, exact serialized body bytes, exact `idempotency_key`, attempt count,
failure stage, optional last HTTP status/request ID, and an opaque HMAC binding
to the exact bearer credential. The credential itself is excluded. A one-step
static-token rotation may expose the immediately preceding token to the client
through its recovery-only `previousBearerToken` provider while the daemon still
accepts both rotation rows. Replay selects only the exact current or retained
token whose binding matches. Operators must drain every receipt bound to the
preceding token before retiring it or advancing another rotation; a different
or unavailable bearer fails locally before any network request. Request
bodies are arbitrary application payloads and may themselves contain prompts,
environment values, tokens, or other secrets. Every receipt is therefore typed
as `sensitive_request_payload`.
Automatic persistence is allowed only through a recovery store that explicitly
declares `encrypted_access_controlled` custody. The receipt replays only through
the named generated operation; there is no raw URL/header escape. Every recovery
store implements `reserve`, `save`, and `release`: the generated client encrypts
and durably reserves an exact replay receipt **before** the first keyed-write dispatch. A
reservation failure returns `transport/recovery_store` with zero dispatch
attempts. A later indeterminate result atomically upgrades the same stable
replay-identity slot with attempt and response-authority diagnostics; if that
upgrade fails, the pre-dispatch receipt remains sufficient for exact replay.
Schema-valid success and declared definitive API failure release the
reservation best-effort; a stale reservation is safe because its operation and
idempotency key remain immutable. Changing request bytes, key, operation,
contract, or origin yields the ordinary conflict or a local binding rejection.
Recovery receipts are authenticated with HMAC-SHA-256 under client-held key
material. Without an explicit key a process-local key restricts replay to the
issuing client instance; a durable recovery store requires a separate protected
32-byte key so restart replay can verify the exact originally issued bytes and
generated headers. The key never enters the receipt or transport request. The
CLI encrypts these sensitive receipts at rest with AES-256-GCM and replays any
managed generated receipt through `calyx client replay <path>`; run launch and
message send retain their narrower command-specific replay projections.

A write advertised as retry-safe without either retry mechanism does not ship.
An **unkeyed stateful write** may ship without retry authority only when its
public contract says that transport loss remains epistemically indeterminate,
the client performs exactly one dispatch and never retries or replays it, and a
named read projection is the caller’s reconciliation path. Every post-dispatch
transport or protocol failure retains its complete bounded cause under
`unkeyed_indeterminate`; only a schema-valid success or declared API error is
authoritative. Missing or unchanged read state never proves non-admission. The
current admin operations use these paths:

- `admin.msg.forward` reconciles through `admin.msg.operation` for the exact
  outbox identifier in the resident source-daemon forwarder's store; no
  address grant is required, and absence remains inconclusive;
- `admin.monitor.ack` reconciles through `admin.monitor.wakes` with its exact
  `wake_id` selector; the selector bypasses list pagination, while absence
  remains inconclusive;
- `admin.monitor.cancel` reconciles through `admin.monitor.get`;
- `admin.run.stop` reconciles through `admin.run.get`.

`admin.session-wake.deliver` is not unkeyed. Its deterministic `delivery_id`
is generated from the exact pointer and activity binding and is its retry
authority. A replay that finds the persisted crash-window state `attempted`
returns `delivery_indeterminate`; it never sends a second daemon-local session-ingress wake and
never converts possible delivery into a false failure.

`admin.run.reconcile-preserving` is different: reconciliation is a naturally
convergent, bodyless operation. Repeating the same fixed operation cannot
reverse a completed repair, delete noncanonical material, or create a second
logical identity, so its generated contract declares operation-identity retry
authority and `idempotent_write` semantics. After a lost response the client
may repeat it; the successful response describes the latest converged pass,
not a reconstruction of an earlier response. This is the only current
operation-identity retry authority and is not a precedent for arbitrary
unkeyed writes. The daemon serializes the complete reconciliation pass under a
cross-process mutex. A retry therefore cannot enter while the first attempt is
still holding per-run execution mutexes and mistake those adopted locks for a
completed pass. Once response headers exist, every unproven outcome—undeclared
status, missing or invalid required headers, wrong media type, interrupted,
empty, malformed, or schema-invalid JSON—consumes the same bounded
operation-identity retry authority rather than returning an unvalidated result.

Absence from an observation is not generic proof of non-admission. Callers must
apply the named resource law and may deliberately issue a new write only when
that law establishes it is safe.

## 5. Submit-and-observe

Long-running or cross-host mutations are **submitted and observed** — the
daemon owns the state machine, evidence, receipts, and any explicitly declared
compensation the capability defines. Arbitrary external effects have no
implicit rollback (see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) "Daemon-owned state machines"):

- Submit returns `202` with an **operation locator** (`run_id` or
  operation id) — never blocks on completion.
- Observation is uniform: `GET` the record, `GET .../events`, `GET .../logs`,
  and the SSE stream (§7) with replay. No polling contract is bespoke per
  capability.
- Terminal state is proven by a **typed receipt**, not by absence of activity.
  Every submit-class capability names its receipt schema in its spec row.
- A current `host_process` receipt is
  `calyx.host-process-receipt/v1` and carries
  `calyx.host-process-execution-binding/v1`: the execution id, a fresh 32-byte
  salt, and a SHA-256 commitment to the exact frozen spawn effect (`argv`,
  `cwd`, final redacted-plus-overridden environment, and stop grace). The
  binding is persisted before spawn and copied to the receipt; environment
  values are never copied into the binding. Recovery compares the receipt to
  that persisted admission fact and never recomputes authority from the
  daemon's current environment. Its `timing.created_at` is captured at bound
  effect execution, after durable admission, so delayed queues still satisfy
  the receipt-authority chronology.
- A schema-1.0 `host_process` receipt without that binding is an explicit
  predecessor observation. Its historical `created_at` remains intent-era
  and may precede admission by an arbitrary queue delay. It may preserve an already-published, fully
  coherent terminal record during rolling upgrade, but cannot authorize a new
  effect, receipt-only reconstruction, or projection repair.

## 6. Bounds and pagination

Agents are the primary consumers; context budgets are real. Every surface is
bounded by default:

- List reads take `limit` and return `next_cursor` when truncated. Cursors are
  opaque. Unbounded reads do not exist on the consumer profile.
- Positive consumer DTOs bound responses at every layer. Their variable
  identity/transport strings carry explicit schema ceilings: portable ids
  1,024 characters, hosts and MIME types 255, backends and timestamps 64,
  monitor presets 128, run locators 260, message subjects 500, message
  addresses/thread references 512, and route locators and opaque cursors
  4,096; exact digests and closed values are grammar/enum bounded, while
  operation-specific summaries, text, and URLs retain their own named caps.
  Producers fail closed when an identity or locator cannot be represented;
  they never truncate it into a different identity.
- Run/activity continuation cursors bind both their immutable seek tuple and a
  server-established membership fence. Managed-run fences carry a database
  generation, monotonic revision, per-revision lineage token, and filter digest;
  retained OLD/NEW deltas must form an unbroken token chain and fold to no net
  eligible membership change. Compaction, rollback onto an alternate history,
  post-page admissions, removals, or identity drift stale the cursor. Bounded
  interactive-identity fingerprints provide the corresponding non-SQLite law;
  logical `created_at` alone is never a membership fence because portable
  launch callers may supply a historical timestamp.
- Merged managed + interactive lists seek by `(created_at DESC, run_id ASC,
  entry_kind)` with managed runs first at an otherwise equal key. The private
  cursor discriminator prevents an equal-id/equal-time interactive session
  from disappearing after its managed-run peer. Duplicate interactive sources
  with the same public tuple fail typed before paging instead of exposing a
  private path as a tie-breaker.
- Text-bearing reads take `max_text_chars` (the activity-read convention,
  generalized); truncation is marked in-payload, and full text is reachable by
  reference (`/v1/activity-text/{message_id}`-style paging), not by inlining.
- Nested bounded collections state their own truncation independently of their
  parent page. Consumer turns keep whole-turn outer cursors. Embedded turns
  inherit the envelope `activity_id`, and their messages inherit both activity
  and turn identity. A complete embedded message list needs no recovery fields;
  a truncated list adds a positive `omitted_message_count` and the constant
  operation descriptor `messages_recovery: { operation_id:
  "activity.messages" }`. Clients combine that operation with the envelope
  activity identity and retain paged rows carrying the enclosing `turn_id`.
  Page envelopes use an exact union: `truncated: true` requires `next_cursor`,
  while `truncated: false` forbids it. This shape makes recovery mechanically
  visible in OpenAPI. Where a predecessor page still publishes a redundant
  `count`, generated OpenAPI also carries the machine-readable
  `x-calyx-pagination-contract` equality binding; client contract compilers
  validate it against the returned array rather than trusting the number.
- Large bodies (attachments, exports, transcripts) are **file-backed or
  byte-served** (`.../bytes` with etag/digest), never inlined into JSON.
- Every finite-body success representation declares a byte ceiling in the
  canonical operation descriptor. OpenAPI publishes the same value as
  `x-calyx-max-bytes`; the server refuses to emit a serialized body above it,
  and first-party transports enforce both declared `Content-Length` and a
  streaming `limit + 1` read before parsing. The JSON default is 16 MiB;
  `admin.run.list` and attachment bytes are explicitly 64 MiB. SSE instead
  declares `max_frame_bytes` (published as `x-calyx-max-frame-bytes`) because
  the connection itself is intentionally unbounded. A larger operation or
  frame must raise its descriptor bound deliberately.
- Responses state their own truncation: a bounded read that dropped rows or
  chars says so (`truncated: true`, counts) — silent truncation is a bug.

## 7. Streaming

One SSE replay transport, shared by `GET /v1/events/observe` and
`GET /v1/admin/events/stream` (the deleted unversioned stream's behavior,
codified):

- `Last-Event-ID` / `after` replay; keepalive comments; idle timeout.
- Server-side filters (`run_id`, `event_type`) — consumers subscribe narrow.
- The versioned SQLite event authority under the physical runs root owns the
  global sequence, exact event identity, cursor membership, and indexed replay.
  Both stream operation descriptors therefore declare
  `store_regime: sqlite_authoritative` and a receiver-side `local_state: read`
  effect; filesystem receipts do not define the stream's authority regime.
  New rows receive a fixed-width `z1-<20 decimal digits>` ordinal in a short
  cross-process transaction; producer clocks, lexical path aliases, and
  process-local counters never order replay. `events.index.jsonl`, per-run
  JSONL, and the state `event_log` are receipts/projections, not competing
  authorities. Receipt publication is exact-idempotent and restart reconciliation
  backfills committed authority rows before declaring the projection healthy.
  The state `event_log` keys idempotency on what an event *is* — `event_id`,
  `domain`, aggregate type/id, `event_type`, `cursor`, `occurred_at`, and the
  canonical payload value. Its `host`, `agent_id`, and `source` columns are
  recorded provenance, never key material: the first writer's stamp is kept and
  the row is never updated in place, so the same authority event re-ingested by
  a second component — a `calyx self upgrade` replay of a journal first ingested
  by `run-service` — is an idempotent no-op rather than a permanent conflict.
  Per-writer progress lives in `event_cursors` (`source`, `domain`) and
  `source_freshness`, which is where "has this writer seen this stream" is
  asked. Divergent reuse of one `event_id` still fails closed and names the
  identity fields that differ.
  A corrupt per-run receipt is preserved and left pending for RunService's
  execution-authority-aware quarantine path; global replay neither trusts it nor
  lets it replace or block the SQLite sequence.
  A pre-`z1` JSONL authority is imported exactly once only when it is a bounded,
  canonical, strictly increasing ISO-cursor prefix; malformed order, ordinals,
  ids, or rows fail closed without rewriting bytes. Replay validates cursor
  shape and exact authority membership by index before sending HTTP success;
  malformed, unknown, and future cursors are rejected. Authority preparation,
  legacy import, and projection repair are an explicit server-start prerequisite;
  prepared replay reads never create or migrate durable state.
- The SSE protocol frame uses `id: <cursor>` plus one JSON `data:` envelope.
  It intentionally omits the optional protocol-level `event:` line; clients
  discriminate on the envelope's required `event_type`. Each frame, including
  its wire framing, is capped at 1 MiB. Servers refuse an oversized frame
  before writing it; clients count undecoded wire bytes since the last `\n\n`
  boundary and cancel an oversized or unterminated frame before allocation can
  grow without bound.
- Admin delivery uses the `calyx.stream-event/v1` response family: either the
  durable `CalyxStreamEvent` source row (today a bare-`"1.0"` legacy shape — §1
  catalog) or a delivery-only `calyx.stream-projection-gap/v1`. New source
  events that cannot fit the admin frame ceiling are rejected before authority
  insertion; the gap exists so an already-admitted historical row cannot poison
  replay forever. It is never stored as event authority or accepted as an event
  filter type.
- The admin gap carries exactly the original bounded, SSE-safe `cursor`,
  `event_type: stream.projection_gap`, and a closed `gap` object with
  `reason: source_event_exceeds_frame_limit` plus the durable row's closed
  `source_event_type`. It has no source event id, time, run identity, raw row,
  error, path, pointer, or copied oversized/internal field. The corresponding
  TypeScript delivery union is `CalyxDeliveredStreamEvent`; durable storage
  remains `CalyxStreamEvent` only.
- Admin `run_id` and `event_type` filters select durable source rows before
  delivery projection. A matching oversized source row therefore yields its
  explicit gap (whose `gap.source_event_type` records the selected source type),
  while a nonmatching source row yields neither data nor a gap. Clients do not
  request `stream.projection_gap` directly.
- Consumer events remain the distinct named
  `calyx.run-observation-event/v1` response family: either the positive run
  observation envelope or `calyx.run-observation-gap/v1`. Its observable gap
  carries only the same safe cursor, `event_type: run.projection_gap`, and the
  closed `source_event_unrepresentable` reason/source-run-type object. It never
  inherits the admin gap discriminator or reason, and likewise copies no time,
  raw row, error, path, id, or oversized/internal field.
- The server advances a connection's replay cursor only after the complete
  SSE frame write returns. A transport failure closes and cleans up without
  claiming delivery; reconnecting without a delivered admin or consumer gap
  cursor replays that source row, while `Last-Event-ID: <gap cursor>` resumes at
  the next matching durable row.

### 7.1 Fleet self-upgrade dispatch

`calyx self upgrade --fleet` uses a separate bounded child-process stream, not
the HTTP SSE contract. Its framing law is nevertheless strict.

**The dispatch is a frozen preamble, never an argv.** A fleet upgrade is by
construction an operation between two versions of Calyx: the conductor runs the
version it has, the remote runs the one it is about to replace. Anything the
conductor states in the remote's vocabulary — a flag, an option name, a path to
an installed binary — is derived from code the conductor cannot read, and the
mismatch is invisible until dispatch. So the conductor states nothing in that
vocabulary:

- The conductor pipes a **fixed shell preamble** to
  `ssh <host> bash -c <preamble> calyx-upgrade-preamble $1 $2 $3 $4`. The four
  positional arguments are permanent and irreducible: `$1` the host's calyx
  checkout, `$2` the fetch remote, `$3` the fetch ref, `$4` the 40-hex target
  SHA. There are no flags, ever.
- Everything variable is one UTF-8 versioned `calyx-upgrade-plan/*` JSON object on
  **stdin**, newline-terminated, at most 256 KiB, `schema_version` first. The
  preamble never parses it; it forwards the open pipe verbatim. The current
  conductor emits v2, whose request carries the honest `drain_all` policy. The
  target agent also accepts legacy v1 solely for first-hop rollout from an
  installed pre-POL-2048 conductor, translating its old `continuous=false`
  default to `drain_all=true` and `continuous=true` opt-in to
  `drain_all=false`. Forward conductors targeting older agents still fail
  closed on an unsupported schema.
- The preamble's entire job, in order: discover node `>=22.13.0`; fetch `$2`/`$3`
  into `$1`; verify `$4` is an ancestor of `FETCH_HEAD`; materialise `$4` into a
  scratch clone (`git clone --shared`, so the host's checkout, index, and build
  output are untouched); claim that scratch with a `.calyx-upgrade-scratch`
  marker; `exec` `<scratch>/scripts/calyx-upgrade-agent.mjs`.
- The agent is read out of the **fetched commit**, never the installed build.
  That asymmetry is the whole contract: the program that composes the planner's
  argv and the program that parses it are always the same commit, so
  `self-upgrade-conductor-preamble.test.ts` can check one against the other in a
  single CI process. The agent builds and runs the *target's* planner for the
  same reason — invoking the host's installed CLI would reintroduce the defect
  one hop down.
- The preamble is freezable because it holds no upgrade semantics, its stdin is
  opaque to it, it `exec`s rather than supervises, and it is emitted fresh on
  every dispatch — so it is never installed and can never be stale.

Exit codes carry three meanings, permanently: **78** the bootstrap could not
reach the target agent and *no host state was touched* (the conductor records
`bootstrap_failure` and must not treat it as an upgrade attempt); **0** the
target ran and wrote its envelope, which carries the verdict; anything else is
the target's own code. On its own failure the bootstrap writes exactly one
`calyx-upgrade-preamble/v1` object to stdout, with a fixed message per code —
no host output and none of the four arguments is ever spliced into it.

- Remote stdout is otherwise exactly the pre-existing whole final JSON result.
  It never carries progress, banners, or a terminal record mixed with NDJSON.
  Conductors parse the status-discriminated envelope open to additive fields.
- Relay capability travels as private process context inside the one SSH
  invocation; it creates no help-visible CLI flag or consumer API. Supporting
  remotes write typed `self-upgrade-operation/v1` phase projections to stderr,
  one JSON object per line. Every other stderr line remains an opaque
  diagnostic artifact; the conductor does not infer protocol from its position
  or text.
- The source host's durable operation state and verified final receipt are
  execution authority. The conductor attempts a crash-durable, revisioned
  `self-upgrade-operation/v1` observation before dispatch and reduces
  projections by a content-addressed `transition_id` over the complete phase
  observation. The writer claim protects only that observation sink: claim,
  write, or release failure is bounded and cannot authorize, stop, or revise a
  host mutation. Exact replay is a no-op; a changed observation cannot reuse an
  identity; reduction orders phases by source monotonic elapsed/time/id rather
  than arrival. The live persistence queue and canonical retained set are each
  capped at 32 phases per host (128 KiB live-frame budget); after child close a
  bounded reconciliation publishes the final canonical top set. Missing,
  duplicated, reordered, conflicting, or flooded progress therefore cannot
  change the host result or create an unbounded observation queue.
- The conductor resolves the remote's checkout path from
  `fleet/truths/hosts.yaml`, never from its own `homedir()` — `mba` and
  `carbon` do not share blade's home prefix — and then checks the returned
  plan's `repo_root` against the path it fetched into. A restatement across a
  machine boundary is only safe when one process reads both the literal and the
  source and errors on disagreement. A host with no registered checkout fails
  that host with a fixable message instead of dispatching a guess.
- Absent canonical frames are recorded as `missing`; they do not prove a
  pre-relay generation, and the conductor does not synthesize a phase from
  final JSON.
- Heartbeats and `calyx.self-upgrade-fleet-progress/v1` terminal records are
  renderings of the in-memory bounded reduction, optionally mirrored to the
  conductor observation record. `operation_started` carries both the record
  path and its typed projection availability. Heartbeat quietness is measured
  per host. `fleet_final` is forbidden until bounded postflight settling has
  decided, its rows semantically match the reduced host results, and the
  aggregate receipt is durable. Event-log/stderr projection failures and
  bounded diagnostic stderr capture are explicit diagnostics, never a reason
  to kill a child, change an upgrade result, or consume/withhold the separately
  bounded sole final stdout JSON. Each process gives an event-log append at
  most one second to settle; the first rejection or timeout opens that
  process's projection circuit, and late settlement remains non-authoritative.
  Operation-writer release uses its own dependency budget with the same
  fail-open default; timeout evidence records that a late release may still
  complete. A stale owner is recoverable cleanup evidence and cannot suppress
  terminal stdout after the final receipt is authoritative; the optional operation
  observation may remain stale or absent. Durable directories always retain a
  directory identity and revalidate their physical lineage before and after
  child I/O. Descriptor traversal is accepted only after a positive lookup of
  an observed existing child; an empty or raced directory fails closed to the
  held-cwd helper. Authority methods accept one relative path segment only;
  nested reads first open a held child-directory capability. An exclusive
  create that fails after `O_EXCL` rolls its exact new file back and syncs the
  parent, so a partial owner claim cannot wedge recovery. Linux performs
  relative authoritative I/O through `/proc/self/fd`. Darwin's
  `/dev/fd` cannot traverse directory children, so a private long-lived helper
  retains the captured directory as its kernel-held cwd and performs bounded
  relative authoritative I/O there. When bounded close abandons an in-flight
  helper operation, the helper and its pipes are unreferenced so cleanup cannot
  retain the CLI process; the kernel-held authority remains until settlement.
  A lexical ancestor replacement therefore cannot
  redirect publication, receipt reads, cleanup, or retention on either platform; the
  canonical path remains only the verified operator-facing locator.
- Receipt dereference treats a canonical-root replacement as retryable
  unavailability, not structural invalidity. Explicit `retryable: false` on
  permission failures prevents retries; only a proven bounded-file/schema or
  binding rejection is a permanent structural failure. An `unverified` fleet
  emits the failed terminal event family because observation loss is not
  success, while the host-local mutation receipt remains authoritative.
- Aggregate receipt size is a degradation boundary: when optional nested
  detail would exceed the ceiling, `bounded.reason=size_limit` names the
  original and maximum byte counts plus omitted fields. The reduced receipt
  retains every host verdict, exit code, elapsed/head evidence, canonical
  locator, verification disposition, and bounded error, then permits the
  durable `fleet_final` transition. A true write/fsync failure still leaves the
  optional operation projection running and never invents final authority.

## 8. Locality and portability

Cross-host payloads carry **portable locators, never host-local paths**
(POL-1731):

- Activity, runs, turns, messages: canonical ids (`run:<id>`,
  `interactive:<backend>:<id>`, message ids) that any authorized consumer can
  dereference through its explicitly selected enrolled daemon.
- Backend-native sources: stable URI forms (`codex://threads/…`), not
  filesystem paths.
- A payload that must reference an on-host artifact does so via a byte-serving
  route on the owning host's daemon, named by host + route — not by absolute
  path.
- Self-upgrade host receipts use the control-plane-admin locator
  `{ host, route: "/v1/admin/self-upgrade-receipts/<operation-id>" }`. The
  host-local filesystem path remains an implementation detail used only by the
  owning daemon and the SSH compatibility check.

## 9. Authentication and profile enforcement

- Exactly one Bearer credential per request: a case-insensitive `Bearer`
  scheme, one ASCII space, and one non-empty token containing no whitespace or
  comma, capped at 4,096 characters before verification. Leading/trailing
  whitespace, extra fields, and comma-folded or
  repeated credentials are rejected. Credential verification uses a
  timing-safe compare, with `WWW-Authenticate: Bearer
  realm="calyx-run"` on 401. `GET /livez` is the only unauthenticated route.
- **Credentials are per-client and carry a subject** (see `consumer-api.md`
  → "Trust model"): a static `(client_id, credential_tier, verifier_env,
  token_env, outbound, address_grants)` row per client. The daemon resolves the credential to
  its `client_id` (the authenticated subject, §3) and its
  `credential_tier`, then checks the tier's allowed operation-profile set
  (`consumer` → consumer_v1 only; `control_plane` → consumer_v1 plus
  control_plane_admin_v1; `internal_runtime` → internal_runtime only). Violations are
  `403` with `code: "profile_forbidden"` naming the required profile.
  `profile` is an *operation* attribute, never a credential field.
- **Operations are single-profile by construction, and paths carry the
  profile**: `/v1/admin/…` = `control_plane_admin_v1`, `/v1/internal/…` =
  `internal_runtime`, all other `/v1/…` = `consumer_v1` (the prefix law in
  `consumer-api.md` → Trust model). The tier→profile matrix is ratified
  there (the three disjoint mappings above). Because each
  operation has exactly one profile, **no post-parse profile-selection
  exists** — the prefix/tier check at dispatch fully decides *which
  profile* governs. **Operation-local resource authorization still applies
  after dispatch**: `msg.send` validates the routable sender/`reply_address`
  against `address_grants.send_as`, and inbox/thread reads filter rows
  against `address_grants.read`/`send_as` — resource checks, not profile
  selection. Every OpenAPI operation is tagged with its profile; the
  generated client groups namespaces by profile so a consumer app cannot
  silently link against admin surfaces.
- **An internal path is not a daemon principal.** An operation that requires a
  daemon caller must additionally require a daemon-only credential tier and
  authorize the authenticated daemon subject for that operation. A
  control-plane tier shared with operator clients cannot satisfy that law.

## 10. Conformance

- The interface manifest records each operation's contracts
  (output/error/async) and the OpenAPI generator emits from the implementation
  anchored to manifest operationIds — drift between manifest, spec, and router
  fails CI (`git diff --exit-code` on regenerated artifacts).
- When success branches differ, `operation_successes` is canonical. Flat
  receipt/async facts use the literal `mixed` instead of collapsing a local
  `200` and asynchronous `202` into a contradictory boolean; receipt schema
  references remain branch-specific when there is no single shared schema.
- New routes conform to §§1–9 by default. A deviation is stated in the PR body
  with the reason, and the manifest records it — undocumented deviations are
  review rejects.
