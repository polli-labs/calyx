# Agent-First Introspection CLI

Status: Draft
Date: 2026-04-13
Issue: POL-1063

## Purpose

POL-1063 adds the first two commands in a read-only introspection surface for
agent-maintained source-of-truth workflows:

- `calyx skills show <id>`
- `calyx instructions trace <target>`

The goal is not just to add two lookups. The goal is to make Calyx able to
teach agents where a thing comes from, how it is rendered or installed, and
what local state currently exists, without requiring `jq`, grep rituals, or
out-of-band lore.

## Design Principles

The issue listed eight principles. This implementation keeps those principles,
with two refinements needed by the current system shape.

1. JSON is the contract.
   Both commands support `--json`. Success and lookup failures both serialize a
   stable object shape so callers do not need to scrape stderr.
2. Human output renders the same model.
   The text view is a deterministic rendering of the JSON result, not a second
   implementation.
3. Introspection lives inside existing namespaces.
   `skills show` extends `calyx skills`; `instructions trace` extends
   `calyx instructions`.
4. One call should answer the operational question.
   Source path, install targets, target ownership, partials, variables, and
   drift state are all returned together.
5. Lookup failures are semantic failures, not silent misses.
   Unknown skill IDs, unmanaged instruction targets, and ambiguous matches exit
   non-zero with suggestions or candidate matches.
6. Reverse mapping is first-class.
   `instructions trace` is designed as an inverse query over existing manifests,
   template registries, and staged/install conventions.
7. Local state and fleet expectations are separate.
   Results distinguish:
   - source-of-truth location
   - expected install/render locations
   - current local filesystem state
8. Existing data models remain authoritative.
   No new registry or metadata file is introduced.

### Refinement A: Two instruction trace kinds

The issue proposal assumed every traced instruction target would map back to a
surface manifest. That is not true today.

There are currently two instruction-source planes:

- manifest-backed surfaces in `instructions/surfaces/*.yaml`
- legacy global template registry and fanout rules implemented in
  `scripts/agents-render.mjs`

`calyx instructions trace` therefore needs two trace kinds:

- `surface_binding`
- `template_fanout`

This is a design correction, not a scope expansion. It is required to make the
smoke case `calyx instructions trace ~/.claude/CLAUDE.md` work against the
actual source of truth that exists today.

### Refinement B: Structured JSON on lookup failure

Most existing Calyx commands throw on lookup misses and only produce structured
JSON on success. For the introspection surface, that would make the JSON mode
less useful than the issue requires. These commands therefore emit JSON on both
success and semantic lookup failure, then set a non-zero exit code.

## Updated During Review Fixup

Review pass 2 exposed two places where the initial implementation forked the
source-of-truth semantics too aggressively.

1. `instructions trace` now uses a shared instruction-template render helper for
   partial expansion and token replacement instead of maintaining a second
   ad-hoc renderer inside trace.
2. Global template fanout path resolution now derives the target host's home
   directory from `fleet/truths/hosts.yaml`, so `--host blade` traces
   `/home/caleb/.claude/CLAUDE.md` rather than the reviewer's local
   `homedir()`.

This is an implementation correction, not a design expansion. The original
intent was always to make reverse-mapping follow the same source-of-truth
contracts as the real render/apply flow.

## Final Command Shapes

### `calyx skills show <id>`

```bash
calyx skills show <id> \
  [--registry <path>] \
  [--agents-infra-root <path>] \
  [--check] \
  [--show-install-hashes] \
  [--json]
```

Notes:

- No `--all` mode is added. `calyx skills index` already owns enumeration.
- `--registry` stays aligned with the existing `skills sync` and
  `skills validate` surface.
- `--agents-infra-root` exists because the registry alone is not enough to
  resolve internal and repo-maintained source paths robustly.
- `--check` validates the resolved source and expected backend render state for
  the selected skill. It is not a whole-registry replacement for
  `calyx skills validate`.

### `calyx instructions trace <target>`

```bash
calyx instructions trace <target> \
  [--surfaces-dir <path>] \
  [--agents-infra-root <path>] \
  [--host <host>] \
  [--include-archived] \
  [--include-variables] \
  [--include-partial-contents] \
  [--json]
```

Notes:

- `--host` defaults to the current host alias.
- `--surfaces-dir` mirrors the existing instructions namespace.
- `--agents-infra-root` is required for default discovery of:
  - `instructions/surfaces/`
  - `instructions/templates/REGISTRY.json`
  - `instructions/templates/partials/`
  - `fleet/truths/*.yaml`
- `--include-variables` includes resolved values; default output includes only
  variable names plus their source.
- `--include-partial-contents` is a debugging aid and only affects the JSON
  payload.

## Resolution Rules

### Agents-infra root

`skills show` and `instructions trace` need an agents-infra root even when the
caller only passes an ID or a target path. Resolution order:

1. explicit CLI flag (`--agents-infra-root`)
2. environment (`CALYX_AGENTS_INFRA_ROOT`)
3. derive from an explicit `--registry` or `--surfaces-dir` path when possible
4. discover canonical local clones:
   - `~/dev/agents-infra/dev`
   - `~/projects/agents-infra`
   - `~/repo/agents-infra`

This is a new resolver because the current instructions surface has no shared
root discovery helper. The feature needs one.

### Skills registry

For `skills show`, registry resolution order is:

1. explicit `--registry`
2. existing Calyx registry resolution (`resolve("skills", ...)`)
3. `<agents-infra-root>/instructions/skills/SOURCES.json`

### Instruction surfaces

For `instructions trace`, surface resolution order is:

1. explicit `--surfaces-dir`
2. `<agents-infra-root>/instructions/surfaces`

### Current host alias

If `--host` is omitted, the trace command resolves the local host alias using:

1. `~/.config/polli/agents.local.json` `hostAlias`
2. `os.hostname()`
3. host-home match against `fleet/truths/hosts.yaml`

## JSON Schemas

### `skills show`

Success payload:

```json
{
  "ok": true,
  "command": "skills.show",
  "result": {
    "id": "fieldwork-conventions",
    "status": "active",
    "registry": {
      "path": "/Users/carbon/dev/agents-infra/dev/instructions/skills/SOURCES.json",
      "version": "2026-04-03"
    },
    "source": {
      "type": "internal",
      "repo": "polli-labs/agents-infra",
      "path": "instructions/skills/fieldwork-conventions/SKILL.md",
      "ref": null,
      "license": null,
      "resolvedSkillPath": "/Users/carbon/dev/agents-infra/dev/instructions/skills/fieldwork-conventions/SKILL.md",
      "resolvedSkillDir": "/Users/carbon/dev/agents-infra/dev/instructions/skills/fieldwork-conventions",
      "available": true
    },
    "localInstallations": [
      {
        "backend": "agents",
        "entryName": "fieldwork-conventions",
        "expectedPath": "/Users/carbon/.agents/skills/fieldwork-conventions",
        "present": true,
        "state": "matches_expected",
        "liveSkillPath": "/Users/carbon/.agents/skills/fieldwork-conventions/SKILL.md",
        "expectedSkillSha256": "abc123",
        "liveSkillSha256": "abc123",
        "expectedTreeSha256": "def456",
        "liveTreeSha256": "def456"
      }
    ],
    "fleetInstallations": [
      {
        "host": "carbon",
        "backend": "claude",
        "entryName": "fieldwork-conventions",
        "expectedPath": "/Users/carbon/.claude/skills/fieldwork-conventions"
      }
    ],
    "validation": {
      "ok": true,
      "checks": [
        {
          "id": "source_exists",
          "status": "ok",
          "detail": "Resolved source SKILL.md exists."
        }
      ]
    },
    "notes": []
  }
}
```

Failure payload:

```json
{
  "ok": false,
  "command": "skills.show",
  "error": {
    "code": "skill_not_found",
    "message": "Skill \"fieldwork\" was not found in the registry.",
    "suggestions": ["fieldwork-conventions"]
  }
}
```

### `instructions trace`

Success payload:

```json
{
  "ok": true,
  "command": "instructions.trace",
  "result": {
    "target": {
      "input": "~/.claude/CLAUDE.md",
      "resolvedPath": "/Users/carbon/.claude/CLAUDE.md",
      "host": "carbon",
      "exists": true
    },
    "matches": [
      {
        "kind": "template_fanout",
        "matchId": "template:global.hot:fanout:claude",
        "status": "matches_current_render",
        "template": {
          "templateId": "global.hot",
          "templateRegistryPath": "/Users/carbon/dev/agents-infra/dev/instructions/templates/REGISTRY.json",
          "templatePath": "/Users/carbon/dev/agents-infra/dev/instructions/templates/global/AGENTS.global.hot.md.mustache",
          "partialsDir": "/Users/carbon/dev/agents-infra/dev/instructions/templates/partials",
          "channel": "claude",
          "fanoutTargetPath": "/Users/carbon/.claude/CLAUDE.md",
          "stagedTargetPath": "/Users/carbon/dev/agents-infra/dev/generated/staged/carbon/CLAUDE.global.hot.staged.md"
        },
        "partials": [
          {
            "name": "org.conventions",
            "path": "/Users/carbon/dev/agents-infra/dev/instructions/templates/partials/org.conventions.md.mustache",
            "order": 1
          }
        ],
        "variables": [
          {
            "name": "HOST_CONTEXT",
            "sourceKind": "fleet_truth",
            "sourcePath": "/Users/carbon/dev/agents-infra/dev/fleet/truths/hosts.yaml",
            "value": "## This Host: `carbon`..."
          }
        ],
        "renderState": {
          "renderedSha256": "abc123",
          "liveSha256": "abc123",
          "managedByMarker": null
        }
      }
    ]
  }
}
```

Failure payload:

```json
{
  "ok": false,
  "command": "instructions.trace",
  "error": {
    "code": "unmanaged_target",
    "message": "Target is not managed by any known instruction surface or template fanout.",
    "suggestions": [
      "/Users/carbon/dev/AGENTS.md",
      "/Users/carbon/.claude/CLAUDE.md"
    ]
  }
}
```

Ambiguous success candidates are treated as semantic failure:

```json
{
  "ok": false,
  "command": "instructions.trace",
  "error": {
    "code": "ambiguous_target",
    "message": "Target matched more than one instruction source.",
    "matches": ["surface:dev-root:dev-root-carbon:CLAUDE.md", "template:global.hot:fanout:claude"]
  }
}
```

## Data Flow

### `calyx skills show`

```text
skill id
  -> resolve registry path
  -> load SOURCES.json
  -> select exact skill entry
  -> resolve source path
       - internal -> agents-infra root
       - repo-maintained -> local clone lookup
       - external -> optional local clone lookup, otherwise metadata only
  -> render expected backend payloads
       - agents raw tree
       - claude transformed SKILL.md + extras
       - codex transformed SKILL.md + extras
  -> inspect local install roots
  -> compare expected vs live
  -> project expected fleet install paths from host truth
  -> emit one model
```

Inputs read:

- `instructions/skills/SOURCES.json`
- `instructions/skills/<id>/...` or repo-maintained local clones
- local install surfaces under `~/.agents/skills`, `~/.claude/skills`,
  `$CODEX_HOME/skills/<namespace>`
- `fleet/truths/hosts.yaml` for fleet path projection

### `calyx instructions trace`

```text
target path
  -> resolve host alias + agents-infra root
  -> try manifest-backed inverse match
       - surfaces yaml
       - target bindings
       - reconcile current target state
       - expand template + partials
       - derive variables from fleet/host context
  -> try legacy template-fanout inverse match
       - templates/REGISTRY.json
       - agents-render conventions
       - render candidate outputs for host/channel
       - compare live target content or staged path
  -> classify:
       - one match -> success
       - zero matches -> unmanaged_target
       - many matches -> ambiguous_target
```

Inputs read:

- `instructions/surfaces/*.yaml`
- `instructions/templates/REGISTRY.json`
- `instructions/templates/global/*.mustache`
- `instructions/templates/partials/*.mustache`
- `fleet/manifests/fleet.yaml`
- `fleet/manifests/hosts/*.yaml`
- `fleet/truths/{hosts,routing,sprint}.yaml`
- `generated/staged/<host>/*.staged.md`
- live local target file

## Error Handling Strategy

### Exit codes

- `0` — exact successful lookup
- `1` — runtime error (read/parse failure, missing agents-infra root)
- `2` — CLI usage error
- `3` — semantic lookup failure or `--check` validation failure

### Unknown skill IDs

Resolution:

1. exact case-insensitive match
2. if not found, compute suggestions using:
   - prefix match
   - substring match
   - edit-distance fallback
3. emit `skill_not_found`

We do not add a new dependency for fuzzy matching. A small in-repo scorer is
good enough for this namespace.

### Unmanaged instruction targets

The trace command distinguishes:

- `unmanaged_target`
  - target path is not a declared surface target and is not a known template
    fanout/staged path
- `managed_target_no_current_match`
  - target path is a known template fanout location such as `~/.claude/CLAUDE.md`
    but current content does not match any currently registered render output
- `ambiguous_target`
  - more than one source currently explains the path

### Not-managed-file detection

Surface-backed targets are discovered structurally from `target_bindings`.
Legacy global template targets are discovered by:

- exact path conventions (`generated/staged/<host>/...`, `~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`)
- content comparison against rendered candidate templates when the path alone is
  insufficient to identify a single template

## Multi-Surface Handling

`instructions trace` lists every matching source internally, but the command
only exits successfully when exactly one source explains the target.

Why:

- choosing "first match wins" would hide real ownership conflicts
- returning success on multiple matches would make automation unsafe

Behavior:

- `1` match: exit `0`
- `0` matches: exit `3`
- `>1` matches: exit `3` and include all candidates in JSON

## Reuse vs New Code

### Reused

- `packages/core/src/skills.ts`
  - registry loading and lifecycle semantics
- `packages/core/src/resolve.ts`
  - existing registry flag/env/config resolution for `skills`
- `packages/core/src/instructions-surfaces.ts`
  - surface manifest parsing
  - source-ref resolution
  - reconcile/apply/adopt state classification for current files
- `packages/core/src/instructions.ts`
  - lightweight template token/partial semantics used by surface rendering

### New

- agents-infra root resolution helper
- skill source resolution helper for `internal`, `external`, and
  `repo-maintained`
- expected install-tree renderer for skills backends
- template-registry + legacy fanout trace logic for instruction targets that do
  not have surface manifests
- partial-trace collector that records expansion order and optional contents
- structured error payloads for the new introspection commands

## Test Strategy

### Unit tests

- host alias and agents-infra root resolution
- skill suggestion scoring
- skill install path projection per backend
- skill expected-tree render state comparison
- template-registry trace classification
- variable-source extraction
- partial expansion order capture

### Integration tests

- fixture-backed `skills show`:
  - internal skill
  - repo-maintained skill
  - unknown skill suggestion
  - `--check` failure
- fixture-backed `instructions trace`:
  - manifest-backed target
  - staged template-registry target
  - fanout target with exact content match
  - known fanout path with no current render match
  - ambiguous target

### End-to-end / smoke

- real agents-infra root
- `calyx skills show fieldwork-conventions`
- `calyx instructions trace ~/.claude/CLAUDE.md`

## Open Questions

1. Repo-root worktree tracing:
   Today the manifest-backed repo-root surfaces describe canonical repo roots,
   not arbitrary worktree roots. This design does not invent a new worktree
   ownership model. If worktree-local repo-root inference becomes important, it
   should be an explicit follow-up slice.
2. `skills show --check` depth:
   v1 check covers source resolution, readable source files, expected rendered
   backend payloads, and local drift. It does not attempt semantic validation of
   every reference mentioned in freeform markdown prose.
3. Global template fanout provenance:
   `agents-render.mjs` does not stamp `~/.claude/CLAUDE.md` or
   `~/.codex/AGENTS.md` with a source marker. v1 trace infers provenance by
   comparing current content to registered renders. If operators want exact
   "last applied" provenance later, the fanout pipeline will need to stamp it.
