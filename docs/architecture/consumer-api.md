# Calyx consumer API — capability spine

> **Status: ratified v1 capability specification.** Slice 0 (the law + profile
> model) merged at `f05dafb`; this revision ratifies **consumer_v1 membership**
> and the trust boundary, and pins each capability with the full template.
> It is the standing contract the OpenAPI/client work implements. Wire-level
> conventions shared by every capability live in
> [`wire-contracts.md`](wire-contracts.md). Implementation sequencing, slice
> acceptance, store DDL, and decision lineage live in **POL-1901** and the
> vault (`30-reports/calyx-consumer-v1-capability-spec-2026-07-11`) — not
> here. Worked evidence: **POL-1907**.

## The law (recap)

**CLI command groups, daemon HTTP routes, SDK helper namespaces, and GUIs are
sibling projections of named capabilities. None of them defines the capability
boundary by itself.** The typed surfaces model **capabilities**, not CLI nouns;
the interface manifest is drift-control + operation-metadata, **not** the
resource model. Corollaries:

- **A profile is *designed*, not inherited.** `interface-manifest`
  `wave4_disposition = cover_now` grades the agent-facing CLI; it is **not** a
  consumer profile. A capability earns a typed surface by being specified below.
- **No single consumer defines the boundary.** The CLI recall plane, agents, and
  GUI renderers (Switchboard is one) are all consumers; do not design to one
  renderer's current needs.

## How a capability is specified

Every capability is pinned by this template *before* it gets a route:

| Field | What it pins |
| --- | --- |
| **Capability** | the app-facing verb ("mark a turn high-signal"), not a CLI noun |
| **Owning daemon / store** | which durable store is the system of record |
| **Regime** | where the bytes of record live: `db` (calyx state store) · `git` (agents-infra / repo) · `file` (vault / host fs / run dirs) — orthogonal to profile |
| **Mutation class** | read · idempotent-write · stateful/long-running · destructive |
| **Receipt / error contract** | the typed result + the `calyx.error/v1` envelope |
| **Idempotency** | explicit request-body, operation, or request-target retry authority (for any write) |
| **Provenance** | `calyx.provenance/v1` actor recorded on every mutation |
| **Absorbs** | the CLI/shell caller this retires (absorption discipline) |
| **Profile** | which profile it belongs to (below) |

**Profile and regime are orthogonal axes.** Profile = *who may operate a
pipeline stage*; regime = *where the bytes of record live and what the cutover
handshake is*. Collapsing them is what produced the skills silent-delete
foot-gun (POL-1883/1884). On the interface manifest, **profile is a typed
per-record field** (`profile: InterfaceProfile`) — per record, not per domain,
because domains like `skills` and `memory` straddle a consumer read surface
and an admin write surface. **Regime defaults per domain**
(`regime: StoreRegime` on the domain classification) with a per-record
override reserved for the straddling domains (skills, memory, mcp-config).

Mutation class drives placement (see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
→ "Daemon-owned state machines"): reads and idempotent writes can be direct;
any long-running or cross-host mutation is *submitted and observed* per
[`wire-contracts.md`](wire-contracts.md) §5.

## Topology

**Daemon placement follows authority, not device form factor.** A CLI, GUI,
agent skill, or generated-client installation is a thin consumer by default. It
connects to one explicitly selected enrolled host; it does not auto-start a
daemon, assume `localhost`, or opportunistically switch between local and
remote authorities. Endpoint identity, base path, and credential binding remain
exact.

An endpoint that owns Calyx state, local execution, transcript ingestion,
host-local artifacts, or `internal_runtime` effects is an enrolled fleet host
and runs the ordinary daemon with the ordinary health, upgrade, credential,
backup, and recovery contracts. This rule permits laptops as first-class hosts;
it does not create a second "device daemon" architecture. Consumer-only devices
hold presentation and cache state only. Offline ownership requires explicit
enrollment, never a hidden fallback authority.

## Profiles

Capabilities are grouped into **profiles** so the OpenAPI/manifest spine grows
one coherent surface at a time without collapsing distinct audiences. **All
profiles ride the same code-first OpenAPI + manifest spine**; they differ in
audience, trust, and what is *promised*.

- **`consumer_v1`** — app/operator **read + filing** surfaces: recall
  (bounded, non-raw), curated surfacing, clean export, attention-surface
  filing, work observation, correspondence. **Switchboard, the workflow
  viewer, a recall viewer, etc. are *consumers* of this profile — not its
  definition.**
- **`control_plane_admin_v1`** — privileged typed surfaces over **Calyx-owned
  mutable state and execution**: dispatch (until constrained dispatch exists —
  see the trust model), agent-owned skills curation, memory
  approval/deletion, radar consolidation/priority, raw recall modes, and —
  observation plus any future submit-and-observe *trigger* legs only —
  instruction/config convergence and self-upgrade (their materialization legs
  are `internal_runtime` file-convergence, never admin routes). Same spine,
  higher trust; promised to privileged operators/agents, **not** the general
  app SDK.
- **`internal_runtime`** — daemon/fleet/service machinery: every on-host
  byte-materializer, and **daemon-to-daemon transport legs** (message
  ingress/replication among them). Typed internally, **not promised** to app
  SDK consumers (no stability contract; can change without an SDK major).
  The profile classifies operations; it does not by itself prove the caller is
  a daemon.
- **`decay / do_not_promote`** — legacy CLI nouns that must **not** become SDK
  namespaces merely because they exist (e.g. `context`, `knowledge`). A noun's
  existence is not a reason to project it.

**The activation gate is the consumer↔admin boundary.** A non-privileged
writer may *file* — a mark, a radar delta, a pending memory (`memory.file`,
declared below), a message submission — a `consumer_v1` action landing inert,
append-only, or into a mediated store. *Activating* durable shared state
(approving a memory, consolidating radar state, cutting over a skill regime)
is `control_plane_admin_v1`. **So is executing work**: a `RunIntent` reaches
arbitrary agent execution and (via `host_process`) arbitrary process
execution with daemon privileges — dispatch is not a filing, and no amount of
submit-and-observe hygiene makes it one. Domains that let a free write
activate shared state directly (skills' current free-write path) are
coherence defects to close, not precedents.

**Git-regime capabilities get no consumer/admin HTTP routes for their
materialization legs.** Instruction render/apply, harness-config convergence,
and secrets distribution are file-convergence pipelines: authored in git,
gated by PR review, converged by `internal_runtime` writers with drift checks.
The **role-composition trio (agents/roles · prompts · tools)** classifies the
same way: git-regime, authored via agents-infra PR, materialized by
`internal_runtime`, no consumer routes. Secrets additionally have no
store-of-record today and get **no route of any kind** until one exists.

## Trust model

Day-0 enforcement is deliberately boring — but it authenticates a *subject*,
not just a tier: **static per-client credentials**, declared in the hosts
truth store and loaded via secrets. Each credential is
`(client_id, credential_tier, verifier_env, token_env, outbound,
address_grants)`; the day-0 client set is small and named (`switchboard`,
`operator_cli`, and each host's daemon). The old shared
`CALYX_RUN_SERVER_TOKEN` / `run_serve_token(_env)` source is hard-deleted:
the server reads only `verifier_env`, a client reads only its selected
outbound row's `token_env`, and a rotation has identical tier/grants with
exactly one outbound row.

| Credential carries | Meaning |
| --- | --- |
| `client_id` (**subject**) | the authenticated principal. Authority, provenance, marker/filer/owner identity, and idempotency namespaces derive from it — never from the payload. A message's persisted routable `sender` is the resolved request `reply_address`, accepted only when this subject's exact `send_as` grant authorizes it |
| `credential_tier` | one of three disjoint capabilities: `consumer` reaches `consumer_v1` only; `control_plane` reaches `consumer_v1` + `control_plane_admin_v1`; `internal_runtime` reaches `internal_runtime` only. Host-daemon subjects (`daemon:<host>`) must use `internal_runtime`; an operator credential can never call `/v1/internal/*`, and a daemon credential can never call consumer/admin operations |
| `verifier_env` / `token_env` / `outbound` | asymmetric runtime projection: daemon startup resolves `sha256:<64 lowercase hex>` verifiers without projecting token env names or plaintext bearer material; callers resolve the selected client's sole outbound token for new operations. During the one-step drain window, a durable-recovery client may additionally resolve only the immediately preceding rotation row's token through `previousBearerToken`. Every verifier/token env name is globally disjoint across both columns. Rotation rows may coexist only with identical tier/grants and exactly one `outbound: true` |
| `asserted_actor` (per request, optional) | the caller-claimed fine-grained actor (an operator handle behind a GUI, an agent's activity id behind a host daemon) — **recorded for audit and provenance, never used for authorization and never part of any uniqueness/identity key** |
| `address_grants` (per credential) | the correspondence namespaces this client may act in: `send_as` (routable sender/reply addresses it may claim, resolved and validated per request) and `read` (recipient-address patterns whose inboxes/threads it may peek). Grants use only canonical persisted addresses: an authorship shorthand such as `codex:blade:<session>` resolves before authorization to `interactive:codex:<session>`, so the grant is `interactive:*` or that exact canonical address; there is no parallel `authorship_alias:*` namespace. A stable app inbox is `client:<client_id>@<host>`: explicit-host, directed, inert, and never execution-capable. Day-0 rows are exact per host — e.g. `client:switchboard@blade`, `client:operator_cli@blade` — not a broad `client:*` grant |

What this buys — stated precisely:

- **Rotation is a one-step drain protocol, not an identity exception.** New
  operations switch to the sole outbound token. Durable recovery may retain
  only the immediately preceding token through the generated client's
  recovery-only `previousBearerToken` provider while both verifier rows remain
  accepted. Every receipt bound to the preceding token must drain before that
  row is retired or another rotation begins. Replay still proves the exact
  bearer binding; shared `client_id`, tier, or grants never substitute for it.

- **The consumer tier cannot execute — through any door.** Run launch/stop
  accept a raw `RunIntent` today — including `host_process` with
  caller-controlled `argv`/`cwd`/`env` — arbitrary execution with daemon
  privileges; that authority is `control_plane` until **constrained
  dispatch** exists (declared below). The same rule closes the side doors:
  monitor creation (delivery bindings execute commands), lease ownership
  overrides, and message delivery that resumes a run are all
  `control_plane`. Submit-and-observe, idempotency, and receipts make
  actions *observable*; they are not authorization.
- **Identity-sensitive semantics are real, not claimed.** The daemon binds
  authority/provenance, marker/filer/owner keys, and idempotency namespaces to
  the authenticated subject. A message may persist the request's routable
  `reply_address` as `sender` only after exact `send_as` authorization.
  Impersonation across clients is impossible;
  within a single client credential (e.g. several agents behind one host
  daemon), fine-grained identity is the recorded `asserted_actor` — an
  audit fact, honest about its trust level, until per-actor credentials
  land.
- **Raw data stays privileged.** Hidden/tool visibility modes, raw event
  reads, attachment byte-serving, full run records/logs, and monitor
  delivery configuration are `control_plane`; the consumer profile gets
  bounded, classified projections (the consumer DTOs pinned per
  capability).
- **Profile enforcement is mechanical because operations are
  single-profile by construction — and the paths say so.** Privileged
  projections get **distinct method+path operations under a ratified
  prefix law**: `control_plane`-only operations live under `/v1/admin/…`;
  `internal_runtime` operations under `/v1/internal/…`; everything else
  under `/v1/…` is consumer. The named splits: raw/hidden activity reads →
  `/v1/admin/activity/{id}/events|messages`; attachment bytes →
  `/v1/admin/activity/{id}/attachments/{ref}/bytes`; full run record /
  logs / raw events → `/v1/admin/runs/{id}[…]`; the SSE split →
  `GET /v1/events/observe` (run-observation event types only) vs
  `GET /v1/admin/events/stream` (all types, incl. daemon/control);
  monitor/lease mutations → `/v1/admin/monitors|leases/…`; runtime-config →
  `/v1/internal/runtime-config/…`. Prefix → profile is enforced at
  dispatch (`403 profile_forbidden`, [`wire-contracts.md`](wire-contracts.md)
  §9). Because no mixed-profile operation exists, **no post-parse
  profile-selection exists** — but operation-local **resource**
  authorization (address-grant validation on `msg.send`, row-level
  grant filtering on inbox/thread reads) still applies after dispatch;
  the prefix law decides which profile governs, never whether a resource
  check may be skipped.

Per-human/per-agent credentials (many subjects, scoped, expiring) remain the
named upgrade path, **not built now** — static per-client rows in the hosts
truth are sufficient for the day-0 client set.

The workflow-coordination admission contract is stricter than this day-0
matrix: remote effect execution, cross-host output, reconciliation mutation,
and state repair do not ship until a daemon-only credential tier and
per-operation authorization of the authenticated daemon subject both exist.
Until then those effects remain in-process. The `/v1/internal/…` prefix selects
an operation profile; it is not a daemon-principal boundary.

Run-server startup additionally fails closed on its ambient environment: it
permits every catalogued verifier env, requires only the local
`daemon:<host>` outbound token for daemon-to-daemon outbox delivery, and
rejects the *presence by name* of every foreign catalog token env without
reading or logging its value. It also rejects undeclared conventionally named
`CALYX_CONSUMER_API_*_{TOKEN,VERIFIER,VERIFIER_SHA256}` secrets, so an obsolete
or misspelled credential cannot survive outside the catalog. Detached workers
receive neither catalog token envs nor conventionally named consumer secrets.

**`dispatch.constrained` [declared].** The capability that will
earn consumer-profile dispatch: launch restricted to **approved agent
definitions/templates over allowed repos** — a closed request model the
daemon can validate, not a raw `RunIntent`. Until it exists, GUIs requesting
work do so by *filing* (correspondence to a conductor) or the operator uses
an operator control-plane credential.

## Ratified `consumer_v1` capabilities

The v1 membership, pinned. Route sketches carry a status flag —
**[live]** the ratified operation itself is live and conformant ·
**[live-legacy]** a legacy route exists today but the ratified consumer
operation (projection/path/profile) is only specified · **[specified]**
contract pinned here, not yet live (**no sequencing promise** — slice
ownership lives on POL-1901 only) · **[declared]** name reserved with
intent stated, contract not yet pinned. All reads are
bounded (wire-contracts §6); all writes carry provenance (§3) and an
idempotency mechanism (§4).

### Recall & attention (the POL-1907 cluster)

| Pin | recall | attention.mark | attention.curated | recall.export |
| --- | --- | --- | --- | --- |
| Verb | read sessions/turns/messages across the swarm (bounded, classified; raw/hidden modes are control_plane) | flag a turn/message/session high-signal (operator) or foundational (agent) | query "what mattered" — marked ∩ ranked | selected/marked turns → stamped markdown |
| Store / regime | activity index · db (derived) | **`activity_marks` · db (authoritative, NEW)** | marks × activity index | activity index + marks |
| Mutation | read | idempotent-write | read (curated) | read (formatted) |
| Idempotency | — | caller `idempotency_key` for create replay; bodyless DELETE request-target identity for revoke; active tuple is convergence only — `asserted_actor` is provenance, never key material | — | — |
| Receipt | `activity.*/v1` payloads | mark record | curated list w/ rank + why | export doc w/ provenance frontmatter |
| Absorbs | `calyx activity overview/turns/messages` scraping over SSH | nothing — establishes `calyx activity mark`, `unmark`, and `marks` as the first canonical CLI projection | hand-grep over `--json` dumps | the manual `--json` → hand-markdown loop (CLI `activity export` is the sibling projection) |
| Routes | `/v1/activity*` bounded DTOs **[live]**; full/hidden/tool variants live under `/v1/admin/activity*` | `POST /v1/marks` · `DELETE /v1/marks/{id}` · `GET /v1/marks` **[live]** | `marked=`/`rank=` params on activity reads **[specified]**; the digest is a parameterization of `GET /v1/marks` (`since=`, `group_by=`), not a route of its own | `GET /v1/activity/{id}/export?turns=…&marked=1&format=markdown` **[specified]** — the sketch carries turn selection because the verb does |

Consumer recall is positive by construction: messages classified
`visibility=default` are the input dataset, and turn grouping, counts, order,
cursors, limits, and attachment-metadata selection are derived only after that
classification boundary. Hidden/tool-only turns and attachments carried only
by non-default messages therefore do not exist in the consumer projection;
they remain available through the admin profile. Portable `summary` fields are
closed templates over classified role/state facts, never sanitized transcript
text. Bounded authorized transcript text crosses only in the explicit `text`
field (and its bounded text continuation capability). A returned turn embeds at
most 100 visible messages. The embedded turn inherits the envelope's
`activity_id`, and its messages inherit both that activity and the enclosing
`turn_id`; those redundant identity fields are absent from the nested wire
objects. The turn's `messages_truncated` discriminator is the wire truth. Its
complete branch needs no recovery metadata; its truncated branch requires a
positive `omitted_message_count` plus the constant descriptor
`messages_recovery: { operation_id: "activity.messages" }`. A client projects
that operation with the envelope's `activity_id` onto the existing bounded
`/v1/activity/{encodedActivityId}/messages` collection and retains only rows
with the enclosing `turn_id`. The outer turn cursor remains whole-turn-only and
is independent of nested message truncation. Both activity page envelopes use
the same exact discriminator law: `truncated: true` requires `next_cursor`,
while `truncated: false` forbids it. Redundant `returned_turns` and
`returned_messages` integers are absent because their relationship to the page
arrays cannot be expressed or checked by generated OpenAPI clients.

Activity message and turn pages accept one closed ordering dimension:
`order=oldest_first|newest_first`. Omission is `oldest_first`.
`newest_first` returns the newest authorized rows first and its opaque
`next_cursor` continues toward older rows. The cursor binds the normalized
filter set and order, so it cannot be replayed under the opposite direction.
This is seek pagination, not an admin `first`/`last` selector: authorization
and visibility classification still happen before counts, ordering, limits,
and cursor construction, and the consumer surface exposes no `tail`, `latest`,
raw, hidden, or tool-bearing variant.

Interactive activity-list observations add only the presentation facts earned
by current consumer recall callers. `attention_state` is the closed
`working|awaiting|idle|unknown` projection: the latest consumer-visible turn's
`in_flight` state maps to `working`, its `complete` state maps to `awaiting`,
and an empty successfully-inspected visible transcript maps to `idle`. Any
unavailable or unclassifiable projection is `unknown`, with no fabricated zero
count or excerpt. Managed runs do not carry `attention_state`; the Switchboard
runs lane uses their existing `status` and `health` facts.

Interactive rows may also carry `repo_ref`, a maximum-128-character project
slug, and `worktree_ref`, a maximum-128-character worktree slug captured from
the `wt/<branch>` layout. Both derive from a path-shape heuristic over the
canonical `~/dev` workspace convention: `<project>/dev`,
`<project>/wt/<branch>`, `<project>/public/<name>`, or the bare `<project>`
root. The heuristic is not validated against a clone registry or configured
workspace root. Raw `cwd` never crosses; only the bounded slug fields do.
Interactive rows may also carry
`latest_visible_message_excerpt`, a whitespace-normalized maximum-320-character
excerpt from the latest default-visible human or assistant message; and
`visible_message_count`, the non-negative count of default-visible messages in
that latest consumer-visible turn.
There is deliberately no tool-call or hidden-message count. Aggregate attention
counts remain a client derivation over the returned consumer-visible rows, so
the server does not imply coverage beyond the bounded page.

The **marks store** was chosen as the keystone before it had a CLI noun, proving
the API was designed from capabilities rather than wrapped from commands. Its
standing semantic pins (DDL lives with the implementation issue): one row per mark;
caller-keyed create replay through the shared API idempotency ledger; bodyless
DELETE retry by immutable request-target identity; natural-key convergence on
the **authenticated subject** `(subject, target_kind, target_id, kind)` —
enforced **over active rows only**, but never treated as POST replay authority;
same-key replay after revocation returns the original create receipt, while a
fresh re-mark requires a fresh key. `asserted_actor` is provenance, never key
material (day-0
consequence, stated: agents behind one host-daemon credential share a mark
namespace until per-actor credentials land); unmark = revocation (row kept, audit preserved);
re-marking an active mark is a no-op, re-marking a revoked one inserts fresh —
the full history survives. Targets are portable activity locators
(wire-contracts §8); timestamps and indexes follow the state store's
conventions. Marking policy is content, not schema: operators mark
`high_signal` freely; agents mark `foundational` selectively. Curated
surfacing ranks marked rows first and says why (`marked_by`, `reason`,
recency); the weekly high-signal digest (POL-1907) is a consumer of the marks
read, not a bespoke pipeline.

Fresh creation validates the exact target against the receiving daemon's
consumer-visible activity surface. That admission check may read the canonical
local transcript when the derived SQLite projection is absent or stale; it
never writes or repairs the source. Hidden/tool-only, malformed alias, foreign,
and absent targets share one non-leaking `mark_target_unknown` response. Only
multiple local sources claiming the same exact canonical activity identity are
`mark_target_ambiguous`, with no candidate disclosure; genuine local source
unavailability is `mark_target_unavailable`. A committed idempotency replay is
returned before any fresh target admission.

**Cross-host honesty:** marks land on the host that owns the activity row;
cross-host curated reads fan in per-host exactly like activity reads until the
aggregate index (POL-1875) flips — the capability contract does not change
when it does.

**[declared] — names reserved so nothing squats on them:**

- **`recall.search`** — find-by-meaning over activity + marks + vault (the
  vision's #1 owed capability). Deferred behind the recall-plane
  embedding/aggregate work (POL-1738 / POL-1875).
- **`capture`** — the curated-spine composition: from a single mark/turn,
  file the attention delta *and* footnote the source into the owning vault
  doc in one motion (absorbs the hand-composed `context capture` + `vault
  footnotes add` sequence when it lands).
- **`memory.file`** — file a pending (inert) memory: the consumer filing the
  activation gate cites; store `memory_content` (db). Activation (`approve`)
  stays admin.

*Signal-routing* (the vision's seventh capability) is deliberately **not** a
spine capability: it is a role composed from recall + marks + radar.file, and
lives in the agent-definition lane.

### Attention-surface state (the radar)

The FILING/STATE split. Any consumer may **file** (append, byproduct of
close-out/receipt flows — never a separate ritual); one owner
**consolidates**; the operator sets **priority**.

| Pin | radar.file | radar.consolidate | radar.read | radar.priority |
| --- | --- | --- | --- | --- |
| Profile | consumer_v1 (filing) | **control_plane_admin_v1** (owner) | consumer_v1 | control_plane_admin_v1 (operator) |
| Mutation | append-write | state-write (CAS) | read | idempotent-write |
| Idempotency | natural key `(subject, zone, source_ref)` when `source_ref` present; caller `idempotency_key` otherwise — `asserted_actor` is provenance, never key material | CAS on `version` | — | natural (zone) |
| Routes | `POST /v1/radar/filings` **[specified]** | `PUT /v1/radar/state/{zone}` **[specified]** | `GET /v1/radar` **[specified]** | **[specified]** |
| Absorbs | the hand-edited weekly-radar markdown *as system of record* (the vault page becomes a rendering) | same | same | same |

Standing semantic pins (DDL with the implementation issue): filings are
append-only rows `(zone, body, subject, asserted_actor?, source_ref?,
filed_at)` deduped on the natural key above (`subject` authenticated,
`asserted_actor` provenance-only); state is one owner-stamped cell per zone with a CAS
`version`; `priority` is operator-advisory, set day-0 via the control-plane
CLI (the pane renders it read-only until per-actor credentials land).

**Locality pin — the radar is a fleet singleton.** Unlike marks (which follow
their activity rows), radar state has one system of record: the owning host's
daemon, designated in the hosts truth store (day-0: the fleet hub that already
serves Switchboard). Filings from any host `POST` to the owning daemon;
`radar.read` resolves there. No per-host radar replicas, no merge story.

Two adoption facts are binding contract, not commentary: filing must be a
**byproduct** of flows agents already run (the capability accepts `source_ref`
so close-out and receipt paths file in the same motion — no new agent
ritual), and the radar implementation does not count as delivered without a
live byproduct caller.

### Fleet — work observation, correspondence

| Pin | work.observe | msg.read | msg.send |
| --- | --- | --- | --- |
| Verb | run listing/status/health/progress (incl. interactive sessions) + observation event stream — as **`calyx.run-observation/v1`**, a positively-constructed DTO (see below). Full `RunRecord` (it embeds the `RunIntent` — prompts, metadata, `host_process` env), raw logs, and raw events are `control_plane` (`/v1/admin/runs/…`) | inbox (peek + scope modes), thread, bounded message text, cross-host operation receipt, doctor | submit a directed message / scope bulletin |
| Store / regime | run store · **file (per-run dirs) + db projections** (`run_index`, `event_log`); interactive listing joins the activity index | messages · db | messages · db (sender outbox + recipient store) |
| Mutation | read | read | bounded idempotent-write (**submission**) |
| Idempotency | — | — | idempotency key required, scoped `(subject, operation)` with dual wire-recovery + versioned semantic-effect binding (`calyx.msg-send-semantic/v1`; wire-contracts §4); the subject owns authority/provenance while persisted `sender` is the grant-authorized routable `reply_address` |
| Receipt | run/observation payloads | msg rows | send receipt w/ outbox evidence |
| Absorbs | SSH + `calyx run status/ps/logs` scraping for GUIs | Switchboard's CLI shell-outs across all five read routes | the `msg send` CLI shell-out |
| Routes | `GET /v1/runs*` DTO reads + `GET /v1/events/observe` **[live]**; raw reads are `/v1/admin/…`; unversioned predecessors are deleted | `GET /v1/messages/inbox` · `GET /v1/messages/threads/{key}` · `GET /v1/message-text/{messageId}` · `GET /v1/message-operations/{outboxId}` · `GET /v1/messages/doctor` **[live]** | `POST /v1/messages/send` **[live]** — a submission operation |

**Consumer observation DTOs are positively constructed — the allowlist is
the contract.** They are built field-by-field (never spread-from-source);
any field not named here does not cross, including future source fields:

- **`calyx.run-observation/v1`** — `schema_version`, `run_id`, `short_id`,
  `kind` (run|interactive), `issue?`, `host`, `backend`, `status`, `health`,
  `created_at`, `updated_at`, `last_progress_at?`, `branch?`, `pr_url?`,
  `summary?` (classified, bounded text). Interactive rows may additionally
  carry `attention_state?` (closed; current interactive producers emit it,
  optional for additive same-major rolling compatibility), `repo_ref?`,
  `worktree_ref?`,
  `latest_visible_message_excerpt?`, and `visible_message_count?` under the
  positive activity-list law above. Managed rows keep `status` plus `health`,
  which are the facts rendered by the Switchboard runs lane. No field projects
  `run_dir`, `session_path`, or `cwd`; consumer-visible message text remains
  bounded transcript content under the same visibility rule as the turns
  endpoint. Intent/spec/prompts, env, receipts, logs, raw errors,
  hidden/tool-only text, and tool/hidden coverage counts remain absent.
- **`calyx.run-observation-event/v1`** — the consumer SSE response family is
  an explicit union. A representable row carries `schema_version`, a bounded
  opaque `cursor`, an open run `event_type`, bounded `emitted_at`, and the
  positive `run` DTO above. An admitted legacy row that cannot satisfy that
  shape instead carries **`calyx.run-observation-gap/v1`**: only the same
  original safe `cursor`, `event_type: run.projection_gap`, and a `gap` object
  with closed `reason: source_event_unrepresentable` plus the closed source
  run-event type. The gap deliberately has no timestamp, run identity, source
  payload, pointer, error, or internal field; its cursor is the ordering and
  replay authority.
- **`calyx.monitor-observation/v1`** — `schema_version`, `monitor_id`,
  `status`, `preset`, `run_locator?`, `created_at`, `updated_at`,
  `delivery_summary` (positive object: `state` — closed enum
  `none|pending|delivered|partial|failed` — plus non-negative integers
  `attempted` ≥ `delivered` + `failed`, and `last_delivery_at?`;
  `state` must be consistent with the counts), `wake_count`.
  Excluded: predicates, delivery bindings/commands/tokens, error strings,
  suggested commands.
- **`calyx.wake-observation/v1`** — `schema_version`, `wake_id`,
  `monitor_id`, `status`, `created_at`, `run_locator?`, `reason_summary`
  (bounded), `receipt_locator` (host+route, per wire-contracts §8).
  Excluded: evaluation detail, delivery detail, `receipt_path`,
  suggested commands.

Field convention: every listed field is **required** unless marked `?`
(optional, omitted when absent — never `null`). Implementation asserts the
boundary with **negative fixtures**: source rows containing
intent/env/paths/bindings must round-trip to DTOs without them.

Every consumer collection and activity slice is seek-paginated with bounded
`limit` plus an opaque, filter-bound `cursor`. The cursor advances on immutable
identity/order fields (`created_at` + id, transcript source line, turn index,
or attachment source line + ref), never mutable `updated_at`; `next_cursor` is
present exactly when `truncated=true`. Activity recall's positional
`first`/`last`/`around` selectors remain admin-only because they do not define
a portable continuation contract.

Run and activity cursors also bind an exact membership fence established by
page one. Managed-run pages bind the SQLite database generation, membership
revision, a per-revision random lineage token, and the exact filter digest
inside the same read snapshot as the selected seek page. Every membership
mutation atomically records OLD/NEW identity plus its parent and successor
lineage tokens. A continuation is valid only when the retained, consecutive
delta window chains from the cursor token to the current head and folds to no
net change in the filter-eligible identity set. A restored database that reuses
the same generation but follows an alternate mutation history therefore fails
closed even if its numeric revision catches up to or overtakes the cursor.
Compaction beyond the cursor likewise makes the continuation stale rather than
guessing from a partial journal.

The filter and frozen `created_before` snapshot are bound into the fence, while
seek `after` and page `limit` are excluded so every page in one traversal can
advance the same checkpoint. Mutable `updated_at` is never identity material:
progress on the same side of `updated_since` (or with no such internal filter)
advances lineage but folds to unchanged membership, while crossing that
eligibility threshold fails closed. An in-window admission, removal, or
immutable/filter identity change between pages likewise makes the continuation
stale; an admission after the frozen snapshot does not. Paginated managed-run
reads require this SQLite projection; projection absence or corruption returns
typed retryable `activity_projection_not_ready` instead of scanning filesystem
records without equivalent cursor authority. Interactive pages use a digest of
their complete bounded identity projection. A stale continuation restarts a
bounded traversal instead of silently mixing snapshots or dropping an original
member. The cursor's `snapshot_at` anchors relative-time filters;
caller-supplied historical `created_at` is never treated as proof that a row
belonged to that snapshot.
The merged run/activity order is total over `(created_at DESC, run_id ASC,
entry_kind)` with `calyx_run` before `interactive_session`, so a managed run
whose caller-chosen id and time equal an interactive session cannot hide that
session at a page boundary. Two interactive sources that resolve to the same
public tuple fail typed and retryably before paging; private source paths never
become cursor material or collision evidence.

Interactive list joins do not pay the rich transcript-prefix cost across the
estate. They enumerate at most 4,096 source identities, derive immutable
`created_at` + session id from the source filename or a compact 64 KiB identity
prefix (with filesystem birth time only as the stable fallback), sort/filter
that compact set, and load the 256 KiB rich metadata prefix only for the
selected `limit + 1` rows. If the source-count bound or identity prefix cannot
prove a complete ordering, both `work.list` and `activity.list` fail closed with
retryable `503 activity_projection_not_ready`; they never return an apparently
complete short page from a partial scan. Error details expose only the reason
and numeric bounds, never transcript paths. Codex compatibility is explicit:
`session_meta.payload.id` remains the canonical returned session/activity id,
the rollout filename UUID remains a resolvable alias, and the immutable
filename timestamp supplies list ordering. A pasted filename deeplink therefore
does not invalidate an already-durable meta-id reference.

**The internal `POST /v1/internal/messages/receive` is not `msg.send`.** The manifest names it
`internal.msg.receive`: the daemon-to-daemon **receive/ingress leg**, which
validates source-daemon assertions and persists correspondence. It is
execution-inert by construction: even a `run:<id>` recipient returns
`pointer_only / execution_requires_control_plane_authority` and creates no run,
delivery attempt, steer, or acknowledgment. An internal-runtime bearer proves
transport peer identity; it does not confer control-plane execution authority. It
also cannot assert receiver-owned transport evidence: incoming payloads that
contain `remote_sender_receipt_path` or `remote_sender_spooled_at` are rejected
before persistence, and the receiver derives those fields only from the
validated outer message record. It
classifies `internal_runtime` — and therefore, per the prefix law, its
ratified operation is **`POST /v1/internal/messages/receive`**; its legacy
path is deleted. It is never projected to the client. The
consumer `msg.send` is a distinct **submission** operation. Authorization
and the idempotency namespace bind to the **authenticated subject**; the
message's routable sender/`reply_address` is a `MessageAddress` the subject
is **granted** (`address_grants.send_as`, validated per request) — so
replies route to a real activity/alias address, never to a bare
`client_id`. `asserted_actor` is recorded for audit. The daemon validates
address + bulletin policy, writes sender outbox evidence, and forwards to
the internal receive leg itself. For a cross-host recipient, the consumer
submits to its **explicitly selected enrolled source daemon** with an
endpoint-bound credential and an authorized `reply_address`; the recipient
host selects only the outbox destination and never the consumer endpoint or
credential. `msg.read` is
scoped the same way — with a **row-level thread
rule**, because a thread key groups rows across recipient namespaces: a
thread read returns exactly the rows whose `recipient_address` matches
`address_grants.read` **or** whose sender matches `address_grants.send_as`;
non-matching rows in the same thread are silently omitted, never an error —
a two-way conversation is readable by both parties without overbroad
grants. Grant filtering applies **before** pagination, counts, and
truncation metadata, so unauthorized rows can neither leak through
metadata nor produce pathological empty pages. Acceptance carries a
negative fixture: one authorized and one unauthorized recipient in the
same thread. **Recipient policy (contract):** consumer-profile
submissions land as inert correspondence only — recipient addresses whose
delivery could be paired with live acceleration (`run:<id>` resolution or any
exact-session wake leg) are rejected on the consumer profile with
`execution_recipient_forbidden`; run-targeted delivery is the `control_plane`
session-ingress lane and must be explicitly requested. Bare correspondence has
no resume, steer, claim, or ack side effect. Host-bearing addresses resolve only through exact
pinned local identities or exact fleet identities backed by `hosts.yaml` `run_serve_url`
truth. Accepted aliases and configured FQDNs canonicalize to the fleet host
alias before authorization, **semantic-effect** hashing, persistence, and
outbox delivery; unknown hosts and suffix collisions fail before any row or
network effect. Independently, the pre-resolution validated wire identity is
persisted solely so an identical retained replay can recover its already
admitted result without consulting changed topology (wire-contracts §4). A
consumer message must never execute another agent's turn.

`GET /v1/messages/inbox` is **peek-only — it never claims**. Claiming rows
and acking consumption are the agent drain flow (`msg.claim` / `msg.ack`),
**declared** and deferred until an HTTP caller exists — a GUI must never
claim on an operator's behalf by accident.

**Dispatch** (launch / stop / agent-definition runs such as `review`) is
`control_plane_admin_v1` — see the trust model. Its consumer-profile future
is `dispatch.constrained` **[declared]**. **`activity.deliver-turn`**
("send one more turn to this run/session/activity", POL-1390) is likewise
declared + deferred. Its eventual typed route must carry explicit control-plane
authority and reuse the dispatch admission contract; correspondence ingress is
not a hidden implementation of it.

### Workflow view (declared; engine is a separate lane)

A **read-projection** over the run/orchestration ledger: topology, per-node
status, intermediate outputs, gate states, dereferenceable lineage — streamed
over the SSE contract. POL-1983 owns the not-yet-implemented coordination lane
and its [caller-first admission contract](workflow-engine.md); POL-1792 is
agent-definition/early-discussion lineage. This spine reserves only the read
capability so viewers bind to the ledger, never to coordinator internals.
Reading or projecting attention marks, messages, wakes, or UI gestures does not
admit coordinator work. Consumer-profile filings remain inert with respect to
workflow coordination; existing separately authorized internal/control-plane
delivery effects retain their declared behavior.

## Every live route family, classified

Profile enforcement needs a disposition for everything the daemon serves
today — not only the ratified table:

| Route family | Profile | Note |
| --- | --- | --- |
| `/v1/activity*`, `/v1/activity-text/*` | consumer_v1 | bounded/classified recall reads. Privileged variants (hidden/tool visibility, raw events, `…/attachments/…/bytes`) are distinct live `/v1/admin/*` operations — no consumer operation carries a privileged parameter |
| `/v1/runs*` reads | consumer_v1 via the live **work.observe consumer DTO**; full `RunRecord`/logs/events reads are distinct `/v1/admin/*` operations | unversioned predecessors deleted |
| **`GET /v1/events/observe`** (consumer; positive run-observation or bounded projection-gap envelopes only) · **`GET /v1/admin/events/stream`** (all types incl. daemon/control, e.g. `daemon.upgrade`) | consumer_v1 · control_plane_admin_v1 | shared SQLite-authoritative replay transport with receiver-side local-state reads and profile-specific payload contracts; the JSON data envelope's `event_type` is authoritative (no separate SSE `event:` line); unversioned predecessor deleted |
| **`POST /v1/admin/runs`**, **`POST /v1/admin/runs/{id}/stop`** | **control_plane_admin_v1** | dispatch — see trust model; consumer dispatch arrives only as `dispatch.constrained` |
| **`POST /v1/internal/messages/receive`** | **internal_runtime** | `internal.msg.receive`, daemon-to-daemon correspondence transport; execution-inert and never client-projected |
| `POST /v1/messages/send` + five msg reads (`inbox`, `thread`, bounded `message-text`, cross-host `message-operation`, and `doctor`) | consumer_v1 | correspondence (submission + peek/receipt reads) |
| `/v1/monitors*` reads (list, show, wakes inbox) | consumer_v1 via **live observation DTOs** — identity, status, timing, owner/host locators, summarized delivery state; **no delivery bindings, commands, tokens, or host-local paths** (`receipt_path` becomes a host+route locator per wire-contracts §8); full diagnostics are control_plane | observation of the coordination organ |
| `/v1/admin/monitors` mutations (create, cancel, wake ack) | **control_plane_admin_v1** | **not filing**: historical monitor rows may contain process-launch delivery bindings that execute commands with the daemon's environment; ack/cancel authority is also stronger than a generic observation credential. A constrained inert filing operation may earn a consumer classification later |
| `/v1/leases/*` reads | consumer_v1 | observation |
| `/v1/admin/leases/*` mutations (acquire/renew/release/steal) | **control_plane_admin_v1** | force-release and steal override ownership across subjects; a lease's owner is a fine-grained actor the day-0 credential cannot authenticate. Advisory *claiming scoped to the authenticated subject* may earn a constrained consumer operation later |
| `GET /v1/admin/health`, `POST /v1/admin/runs/reconcile-preserving/v1` | control_plane_admin_v1 | positively constructed operator projections: no pid/env/paths/raw errors/run ids; the versioned mutation route is naturally convergent and carries fixed-operation retry authority because repeating reconciliation cannot reverse a repair or delete noncanonical material. The whole pass is serialized across processes, so an overlapping retry cannot treat the first pass's held per-run locks as convergence. A successful retry reports the latest converged pass rather than reconstructing a lost response. Health capability advertising is diagnostic only. Reconciliation returns authoritative counts, a capped/truncation-explicit set of noncanonical-directory examples, and bounded projection-repair and unresolved-disposition outcomes. The current writer emits exactly `min(total, 64)` bounded examples; the rolling reader also accepts the exact predecessor's full array and longer strings, then normalizes the receipt without hiding truncation. `skipped` means benign/no-op only; missing canonical records or unresolved legacy publisher/resource authority are grouped by stable reason without run ids and always report `incomplete` |
| `GET /v1/internal/health`, `GET /v1/internal/metrics`, `POST /v1/internal/runs/reconcile` | internal_runtime | full daemon-only observation and maintenance; raw run ids remain internal |
| `POST /v1/internal/runtime-config/*` | internal_runtime | convergence machinery, never consumer/admin |
| **`GET /livez`** | public infrastructure exception (no consumer/admin/internal profile) | intentionally unauthenticated and unversioned; the only route outside `/v1` and the only unauthenticated route |

### Run-launch media law

`POST /v1/admin/runs` has one live representation. The caller must send
`Accept: application/vnd.polli.calyx.run-launch-receipt+json;version=1`, a
persisted idempotency key, and asynchronous launch semantics; the daemon returns
the named receipt with `202` and observation locators. Missing or unsupported
negotiation is rejected with `406`, and `detached=false` is rejected instead of
silently blocking a request handler. Remote `--foreground` was removed with the
legacy transport path: callers submit and observe. Local foreground execution
remains a direct CLI-to-service operation until the CLI transport-inversion
slice makes submit-and-wait a first-class client behavior.

The generated contract publishes that required value as the normative
`x-calyx-request-accept` operation extension. OpenAPI forbids modeling
`Accept` as an ordinary header parameter, so thin transports and the generated
client must consume the extension and emit the exact value; response content
types alone do not weaken the daemon's explicit negotiation gate.

## `control_plane_admin_v1` — day-0 (name-reserved)

Same spine, higher trust. Dispatch/full-observation routes plus the bounded
health and reconciliation projections above are live. Reserved names remain
gated on a real consumer before any additional route is built:

- **Skills** — reads (`list`/`show`/`provenance`; store `skill_content` · db)
  classify *consumer_v1* per the capability canvas once the store is live
  fleet-wide; every write (write/migrate/curate) is admin and stays CLI-side
  until the cross-host propagation story lands (the POL-1883/1884
  silent-delete prereqs).
- **Memory** — `memory.file` is the declared consumer filing;
  approve/reject/delete are admin; reads classify consumer once the
  check-at-will surface ships.
- **Convergence / self-upgrade** — observation plus, at most, future
  submit-and-observe *trigger* legs; materialization is `internal_runtime`
  file-convergence, never an admin route.

## Decay — `do_not_promote`

`context`, `knowledge` (retired docstore), and other legacy nouns — do **not**
project into the SDK; existence is not a reason to expose.

## Generated client law

- **The exact generated `calyx-openapi.json` bytes are the client compiler's
  sole input.** Admitted input must be byte-for-byte either the repo generator's
  pretty JSON form or compact `JSON.stringify` output. The compiler reparses and
  re-emits before trusting the digest, so duplicate members, lossy or
  noncanonical numeric spellings, and noncanonical whitespace fail closed rather than
  acquiring authority under a digest that names different semantics. It then
  closes those bytes into a repo-owned
  `ClientContractIR`, rejects every unsupported or unconsumed standard OpenAPI
  member as well as every unsupported Calyx extension, and
  projects `x-calyx-client-surfaces` into independent transitive consumer and
  admin graphs. The declared surface list is publication authority; profile is
  only its upper capability bound. Canonical consumer operations currently
  project to both graphs, control-plane operations currently project to admin,
  and internal-runtime operations never project. The current canonical-profile
  omission registry is empty because the destructive reconcile predecessor was
  deleted, while `admin.run.reconcile-preserving` is canonical. The mechanism
  remains fail-closed: any future predecessor, decay, or staged omission must
  carry a closed reason, Linear provenance, and an unexpired date. The former
  boolean projection marker no longer exists.
- **`openapi-typescript` is a subordinate type emitter behind that IR, plus a
  repo-owned thin transport.** `@polli-labs/calyx-client` owns allowlist
  serialization, structural decoding, response and frame bounds, auth, SSE,
  retries, operation-bound indeterminate recovery, custody and cross-field
  validation, error envelopes, generated error-header schemas, SSE cursor-to-
  replay-header subset proof, and open-enum transforms. Unknown additive error
  pairs on writes remain indeterminate regardless of server-supplied
  `retryable` metadata; only an exact generated `(status, code)` pair supplies
  terminal API-failure authority. It does not depend on
  core/server/sdk or `openapi-fetch`, expose raw transport, or emit public
  deep-generated entrypoints. (`calyx-sdk` stays the *extension* SDK; the names
  do not merge.)
- **CI drift gate** — `git diff --exit-code` on the regenerated spec + client.
- **No generated CLI.** The CLI stays hand-authored for agent ergonomics; its
  cross-host transports move onto the generated client in the transport-
  inversion slice so transport law has one implementation without turning
  command UX into generated surface area.

## Codegen posture

- **Code-first OpenAPI over the existing daemon/router** — not spec-first;
  keep the working router.
- **zod schemas at the route edges**; OpenAPI metadata is emitted from the
  implementation and interface manifest. OpenAPI `operationId` equals the
  manifest record's explicit `operation_id`; the manifest record `id` retains
  its `http.*` namespace. Implementation authors add `http_api` manifest
  records on the existing monitor/msg route-record pattern, and every
  operation is tagged with its `profile`.
- Legacy privileged payload fragments that are intentionally JSON metadata
  dictionaries are not anonymous `{}` escape hatches: every one carries an
  explicit `x-calyx-dictionary-mode=explicit-json-metadata` and a stable,
  field-specific `x-calyx-dictionary-name`. CI rejects both
  `additionalProperties: true` and unnamed empty-value dictionaries. These
  named deviations are admin/internal compatibility residue; consumer DTOs
  remain positive closed objects. A non-empty schema-valued
  `additionalProperties` is not arbitrary metadata: it is a typed dictionary,
  and the client preserves each dynamic key recursively under that value
  schema (including nullable values). Unknown siblings on ordinary objects are
  still stripped.
- Request unions select a branch only through one common required single-value
  discriminator, or through an explicitly closed set of pairwise-disjoint
  top-level JSON wire types. The latter exists for compatibility residue such
  as lease-steal provenance (`string` versus explicit JSON object); numeric
  `integer`/`number`, nullable, missing-type, and same-type branches are not
  disjoint and fail generation.
- Path values are encoded as one segment, including slash, percent-looking,
  Unicode, and compound dot-bearing text. Pure `.` and `..` are rejected as a
  typed local configuration error before credential resolution: WHATWG URL
  parsing normalizes even `%2E` spellings, so claiming an exact round trip over
  `fetch` would be false. The generated grammar and runtime also reject lone
  UTF-16 surrogates and overlong path values; only well-formed Unicode scalar
  text can become a URL segment. The root OpenAPI contract additionally pins
  `x-calyx-request-target-max-bytes=8000`; every compiled operation enforces
  that exact UTF-8 byte ceiling over proxy base path + encoded route + query
  before credential resolution, and recovery replay rechecks the authenticated
  stored target. The total law, rather than any one decoded field bound, closes
  percent expansion and multi-field composition below common 8 KiB request-line
  envelopes.
- Projected integers are always emitted with explicit inclusive bounds inside
  JavaScript's safe-integer range. Compiler and runtime both require safe
  integers for request serialization, response adoption, union selection, and
  cross-field count laws. JSON and SSE response parsing retain exact number
  tokens out-of-band, so a decimal or exponent that binary64 rounds onto a safe
  integer still fails the integer contract. Closed numeric `const` and `enum`
  values also compare their exact mathematical decimal token, so a nonzero
  underflow or rounded neighbor cannot impersonate a generated literal. Wider
  numeric identity belongs in
  a separately designed canonical decimal-string contract, not an imprecise
  JSON number.
- Projected string formats are a closed executable set. `date-time` carries the
  exact calendar-valid UTC `Z` pattern produced by the source Zod schemas and
  is checked on both requests and responses; `uri` uses the same absolute
  WHATWG URL grammar as the supported Node/Zod runtime. `binary` is legal only
  as the exact media schema of a declared bytes success.
- Response-header schemas are closed to Fetch's observable representation.
  Names are HTTP field-name tokens. Strings are bounded, non-empty printable
  ASCII that are trim-stable and contain no comma (so Fetch normalization
  cannot erase whitespace or multiplicity); integers are canonical
  non-negative decimals bounded to JavaScript's safe-integer range. Codegen
  rejects a broader schema and runtime validates the same envelope on success,
  errors, SSE reconnect, and recovery responses.
- **No generated CLI.** The CLI stays hand-authored for agent ergonomics; its
  cross-host transports consume the descriptor-bound hand-authored requester
  today. POL-1989 moves those transports onto the generated client without
  changing CLI UX, closing the "app-server exists but isn't dogfooded" gap.
- Raw HTTP execution is structurally owned by transport modules. Production
  call graphs carry a descriptor-bound Calyx requester (and, independently,
  a Linear GraphQL requester), never an injectable callable `fetch`. A bounded
  AST ownership gate pins those raw seams so a new direct or aliased ambient
  fetch cannot bypass descriptor validation.

## Implementation status

Sequencing, slice acceptance, and store DDL are **not** part of this standing
contract: they live on **POL-1901** (the implementation plan and its child
issues) with rationale in the vault
(`30-reports/calyx-consumer-v1-capability-spec-2026-07-11`, which also
records the ratified decision lineage — memory check-at-will first,
instruction edits git-patch, and the adjacent fleet-plane decisions). The
capability rows above carry the durable status flags (**[live]** /
**[specified]** / **[declared]**); when an implementation lands or a name
activates, this page updates in the same PR — that is the only way it
changes.
