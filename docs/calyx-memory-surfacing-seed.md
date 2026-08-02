# calyx-memory surfacing seed (the deferred operator decision)

**Status:** the store is built (POL-1729 Slice 4), strict, and **inert** re:
injection. **The surfacing model is the operator's call — undecided.** This note
tees up that decision; it is not itself a decision.

## What Slice 4 shipped (and deliberately did not)

`calyx memory` is the curated-facts store: `memory_content` (migration `0018`),
the always-injected sibling of skills, with `write` / `approve` / `reject` /
`get` / `list` / `search` / `delete`. A write lands `review_status = pending`
and must be approved to be "active"; the security scan **rejects** any sharp
finding (no `--gate-policy` override).

What it does **not** do: **nothing here auto-injects memory into any prompt.**
The store is inert. No hot-template line, no harness hook, no always-on context
block. Building the surfacing path was explicitly out of scope so the store
could land strict and safe first, leaving the injection model open.

## Why memory's posture ≠ skills' (the oracle veto)

Skills are loaded on demand (the agent picks a skill); a bad skill harms the
sessions that load it. **Memory, if surfaced by injection, is 100% blast
radius** — a poisoned fact would detonate in *every* future prompt. A Gemini
oracle **vetoed** letting memory ride skills' free-write `gate-sharpest` policy
for exactly this reason. That veto is why memory is strict by construction
(pending-by-default + approve gate + hard scan rejection) rather than
stage-and-warn. The same logic governs surfacing: the higher the injection
blast radius, the higher the bar the surfacing model must clear.

## The three options on the table

1. **Always-injected tiny core.** A small, hard-capped set of `approved` facts
   (e.g. a pinned/`user`-category subset under a byte budget) rendered into
   every prompt via a hot-template addendum. Maximum recall, maximum blast
   radius — only defensible *because* of the strict approve gate + scan, and
   only for a tightly bounded core.
2. **Check-at-will (`calyx memory search`).** Zero injection. Agents are
   *instructed* (via guidance) to query memory when relevant, the same way they
   query the vault or `calyx activity`. Lowest blast radius; relies on the agent
   remembering to look. `memory search` already exists for this.
3. **Tiered.** The predecessor's design: a tiny always-injected core (option 1)
   for the few facts that must always be present, plus check-at-will
   (option 2) for the long tail. The middle path; the most moving parts.

## Open question: discovery

The unsolved problem across all options is **discovery** — how does an agent
find the *relevant* memories for the task at hand? Always-injection sidesteps it
for the core but does not scale. Check-at-will needs the agent to form a good
query at the right moment. `memory search` is a literal substring match today,
**not** semantic; a semantic discovery path (or a relevance-ranked auto-surface)
is unbuilt and would be a separate slice. The surfacing decision should name how
discovery works, not just whether injection happens.

## The downstream step when a model is chosen (agents-infra)

Whatever the operator picks, the **hot-template addendum** is a downstream
`agents-infra` change, not a calyx-dev one: instruct agents to prefer
`calyx memory` over the harness's built-in memory tools (Claude's `MEMORY.md`
auto-memory, etc.), so curated facts live in the strict, reviewable, fleet-wide
store instead of a per-harness silo. For an always-injected/tiered model the
addendum also renders the core; for check-at-will it only routes the agent to
`calyx memory search`. Either way it ships through the normal calyx-systems
render/apply flow, gated on the operator's decision.

## Framing

The store is built, strict, and inert. **The surfacing model is the operator's
call.** Pick the injection posture (always-core / check-at-will / tiered) and the
discovery mechanism; the agents-infra hot-template addendum follows.
