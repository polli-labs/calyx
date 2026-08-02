# Skills-curator agent definition + task — DRAFT TEMPLATES (operator-installed)

POL-1729 Slice 3 ships the calyx-dev **apply mechanics** for agent-owned skills
(migration `0017` + pinning, the `consolidateSkillContent` CAS primitive,
`applyCuratorReport`, and the `calyx skills curator run --apply | pin | unpin |
consolidate | rollback` CLI surface).

The two artifacts below — a `skills-curator` agent definition and a `calyx task`
manifest that schedules it — are **draft templates only**. They are NOT wired
live by this PR.

- They are authored in **agents-infra** (`instructions/agents/AGENTS.json` +
  `instructions/agents/skills-curator/agent.yaml`, and a task manifest under the
  tasks tree) and installed by the **operator**.
- Installation is **gated on a Claude-primary usage signal**. POL-1834 shipped an
  *interim WARN-mining fallback panel*, NOT a clean Codex skill-injection signal;
  the curator therefore gates on Claude-primary `Skill`-tool usage only. Do not
  install the scheduled task until Claude is the primary harness whose usage the
  curator reads, otherwise the blind-sensor gate will (correctly) block every
  apply pass.
- This calyx-dev PR ships only the mechanics + these templates. Copy them into
  agents-infra, review, and install with the normal calyx propagation flow.

## Why the backend is Claude-only

The curator's apply path mutates skills based on usage telemetry. Usage is
Claude-`Skill`-tool loads from Loki; Codex injection telemetry is the POL-1834
blind spot. A blind sensor must never drive an auto-mutating actuator, so:

- `execution.backend.allowed` is **`[claude]`** — no codex.
- `posture.workspace_mutation` is **forbidden** (the agent mutates skills via the
  `calyx skills curator` CLI, never the workspace).
- The agent proposes consolidations and calls `curator consolidate` /
  `curator run --apply --confirm`; the deterministic archive is recoverable via
  `curator rollback`.

## (a) Agent definition template

`instructions/agents/AGENTS.json` entry:

```json
{
  "id": "skills-curator",
  "path": "skills-curator/agent.yaml",
  "status": "draft",
  "description": "Agent-owned skills curator: reads curator recommendations, proposes + applies recoverable archives and consolidations on Claude-primary usage signal."
}
```

`instructions/agents/skills-curator/agent.yaml`:

```yaml
version: 1
kind: agent
id: skills-curator
status: draft
owner: polli-labs
contract_version: 1
description: >-
  Agent-owned skills curator. Reads the phase-1 curator recommendations
  (`calyx skills curator run`) plus `calyx skills show`, proposes consolidations
  for near-duplicate db-regime skills, and applies the deterministic archive.
  Gates on Claude-primary usage (POL-1834 is an interim WARN-mining fallback,
  not a clean signal). Claude-only; never mutates the workspace.

persona:
  template: prompt.md
  skills:
    - calyx-dev
  # The persona prompt should instruct the agent to:
  #   1. `calyx skills curator run --json` (read-only) — read recommendations,
  #      especially `consolidate-candidate` pairs and `archive-candidate`s.
  #   2. `calyx skills show <id> --json` for any candidate before acting.
  #   3. Propose consolidations; for accepted merges, author the survivor
  #      SKILL.md and call `calyx skills curator consolidate <sources...>
  #      --into <target> --content-file <survivor.md> --json`.
  #   4. Apply the deterministic archive with
  #      `calyx skills curator run --apply --confirm --json`.
  #   5. Record the returned pass id + rollback cursor; a bad pass is reverted
  #      with `calyx skills curator rollback --last` (or `--pass/--cursor`).
  #   6. Pin anything that must never be auto-archived:
  #      `calyx skills curator pin <id>`.

inputs:
  since:    {type: text, default: "30d"}        # Loki usage window
  endpoint: {type: text, required: false}        # Loki override
  apply:    {type: enum, values: [report, apply], default: report}

execution:
  kernel: agent_runner
  backend:
    # Claude-ONLY: the curator gates on Claude-primary usage; no codex.
    allowed: [claude]
    fallback_order: [claude]
  model: {claude: opus}
  reasoning_effort: high
  safety: {timeout_minutes: 60}

posture:
  # The curator mutates SKILLS via the CLI, never the workspace tree.
  workspace_mutation: forbidden
  artifact_writes:
    - {path: curator-pass.json, location: run-artifact}

context:
  type: none
  target_pinning: required

delivery:
  handback: {flow: handback, ack_required: true}
  thread: resumable

surfaces:
  substrate: {enabled: true, load_phase: dispatch}
  harness:
    claude: {enabled: true}
    codex:  {enabled: false}
```

## (b) `calyx task` manifest template

Schedules the curator with an inactivity-checked cadence. The inactivity check is
a guardrail the curator honors (do not auto-apply during an active edit storm);
the trigger itself is a standard weekly schedule.

```yaml
version: 1
kind: task
id: skills-curator-pass
name: Skills Curator Pass
status: draft
description: >-
  Scheduled, inactivity-checked skills curator pass. Reads Claude-primary usage,
  proposes consolidations, and applies the recoverable deterministic archive.
  DRAFT: install only once Claude is the primary usage signal (POL-1834 caveat).
triggers:
  - type: schedule
    rrule: "RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0"
    timezone: America/New_York
runtime:
  backend: calyx
  agent: skills-curator
  model: claude-opus
  reasoning_effort: high
  # Inactivity guardrail: the curator agent must confirm no recent skills-write
  # storm before applying (a blind sensor never drives an actuator, and an
  # in-flight edit storm is a noisy sensor).
  workspace:
    mode: existing
    cwd: /Users/carbon/dev/agents-infra/dev
prompt:
  body: |
    Run a skills curator pass. Read `calyx skills curator run --json`, propose
    consolidations for near-duplicate db-regime skills, then apply the
    deterministic archive with `--apply --confirm`. Record the pass id +
    rollback cursor. Refuse to apply if the usage backend is not ok (blind
    sensor) or if there has been a recent skills-write storm (noisy sensor).
install:
  targets:
    - host: carbon
      backend: calyx
      status: draft
```

## Install checklist (operator)

1. Confirm Claude is the primary harness whose `Skill`-tool usage Loki records.
2. Copy the agent def + task manifest into agents-infra; review.
3. Flip `status: draft` → `active` only after the Claude-primary signal is real.
4. Install via the normal calyx propagation flow (`calyx-systems`).
5. First runs should be `apply: report` (dry-run) to validate recommendations
   before enabling `--apply`.
