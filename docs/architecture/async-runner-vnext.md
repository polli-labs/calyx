# Async Runner vNext Architecture

Status: Draft
Date: 2026-03-03
Issue: POL-699
Milestone: M6 Async Runner vNext (P11)
Depends-on: POL-644 (legacy runner remediation, caveat only)

## 1. Purpose

Define an implementation-ready vNext async execution runtime that composes
Calyx primitives rather than extending the legacy `async-runner` script model.

The vNext runner replaces a 2,870-line monolithic Python script with a
contract-first TypeScript application layer over the Calyx domain system.
It inherits the proven operational model (worktree isolation, multi-host
dispatch, docstore integration, quarterback coordination) while eliminating
the legacy pain points: brittle failure classification, implicit state,
undocumented exit-code semantics, and single-file coupling.

## 2. Design Principles

1. **Calyx-native composition** — build on existing domain primitives
   (`exec`, `config`, `skills`, `tools`, `prompts`, `agents`, `knowledge`)
   rather than reimplementing them.
2. **Contract-first** — every boundary (run spec, lifecycle event, receipt,
   artifact manifest) is a typed schema validated at runtime via Zod.
3. **Plan/apply discipline** — all mutating operations support `--apply`;
   dry-run is the default. Matches existing Calyx convention.
4. **Observable by default** — structured lifecycle events, OTel spans,
   deterministic exit codes, and machine-readable receipts.
5. **Backend-agnostic** — the runner orchestrates; the backend (Claude,
   Codex, future) is an adapter behind a stable interface.
6. **Incremental adoption** — shadow mode enables dual-run comparison
   before cutover. Legacy and vNext coexist during migration.

## 3. Component Model

```
┌─────────────────────────────────────────────────────────┐
│                    Operator / Quarterback                │
│  (interactive agent or long-lived coordinator)           │
└──────────────┬──────────────────────────────┬───────────┘
               │ RunSpec                      │ Status query
               ▼                              ▼
┌──────────────────────────────────────────────────────────┐
│                  calyx exec (app layer)                   │
│                                                           │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐ │
│  │Dispatch │→ │ Lifecycle  │→ │ Backend  │→ │ Receipt  │ │
│  │ Gate    │  │ Controller │  │ Adapter  │  │ Emitter  │ │
│  └─────────┘  └───────────┘  └──────────┘  └──────────┘ │
│       │            │              │              │        │
│       ▼            ▼              ▼              ▼        │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐ │
│  │Docstore │  │ Run Store │  │ Worktree │  │ Artifact │ │
│  │Resolver │  │ (exec.ts) │  │ Manager  │  │ Manifest │ │
│  └─────────┘  └───────────┘  └──────────┘  └──────────┘ │
└──────────────────────────────────────────────────────────┘
       │              │              │              │
       ▼              ▼              ▼              ▼
┌──────────────────────────────────────────────────────────┐
│              Calyx Domain Primitives                      │
│  config │ instructions │ skills │ tools │ prompts │ ...   │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Component Responsibilities

| Component | Responsibility | Calyx Primitive |
|---|---|---|
| **Dispatch Gate** | Validate RunSpec, resolve ExecPlan from docstore, select lane, emit dispatch receipt | `exec` store + docstore resolver |
| **Lifecycle Controller** | Drive state machine (`queued→running→terminal`), emit lifecycle events, enforce transition invariants | `exec` domain (state machine, validation) |
| **Backend Adapter** | Launch and monitor the AI backend process (Claude, Codex); translate backend events into lifecycle events | New adapter interface (pluggable) |
| **Receipt Emitter** | Generate structured receipt on terminal state; compute duration, log summary, failure classification | `exec` receipt + new failure classifier |
| **Docstore Resolver** | Resolve `docstore://` URIs, validate ExecPlan presence, pull artifacts on remote hosts | External: `docstore` CLI |
| **Run Store** | Persist run records as validated JSON; enforce schema invariants | `exec.ts` (existing) |
| **Worktree Manager** | Create/lock/release git worktrees for run isolation | New; wraps `git worktree` |
| **Artifact Manifest** | Track expected vs produced artifacts; gate terminal status on artifact presence | New schema |

### 3.2 Package Placement

All vNext runner code lives in the **app layer**, not in `calyx-core`:

```
packages/
  core/          # Domain primitives (exec types, state machine, validation)
                 # ← NO changes needed for vNext; already sufficient
  cli/           # CLI surface (calyx exec launch, status, logs, receipt)
                 # ← Thin wiring only; delegates to core + app layer
  runner/        # NEW: @polli-labs/calyx-runner (app layer package)
    src/
      dispatch.ts        # Dispatch gate + lane selection
      lifecycle.ts       # Lifecycle controller
      adapters/
        types.ts         # Backend adapter interface
        claude.ts        # Claude backend adapter
        codex.ts         # Codex backend adapter
      worktree.ts        # Worktree isolation manager
      artifacts.ts       # Artifact manifest + gating
      receipt.ts         # Receipt generation + failure classification
      classifier.ts      # Failure classification engine
      notify.ts          # ntfy + agent-mail notification hooks
      remote.ts          # Multi-host SSH dispatch
      config.ts          # Runner configuration (fleet policy, profiles)
      types.ts           # Runner-layer type definitions
    test/
      ...
```

**Rationale:** The runner is an *application* over Calyx domain primitives.
It depends on `calyx-core` but is not part of the core contract surface.
Third-party extensions should not need to import runner internals.
This keeps `calyx-core` stable and the runner independently versionable.

## 4. State Machine

The vNext runner extends the existing `exec` domain state machine with
refined failure classification states that replace the legacy ad-hoc
pattern matching.

### 4.1 States

| State | Terminal? | Description |
|---|---|---|
| `queued` | No | Run record created; not yet dispatched to backend |
| `dispatching` | No | Dispatch gate validating inputs and resolving ExecPlan |
| `running` | No | Backend process launched and executing |
| `succeeded` | Yes | Backend exited cleanly; all artifact gates passed |
| `failed` | Yes | Backend exited with error or artifact gate failed |
| `cancelled` | Yes | Operator or system requested cancellation |
| `auth_error` | Yes | Backend failed due to authentication/authorization |
| `infra_error` | Yes | Infrastructure failure (SSH, process spawn, disk) |
| `completed_dirty` | Yes | Backend produced substantial output but crashed during cleanup |

### 4.2 Transition Diagram

```
                    ┌──────────┐
                    │  queued   │
                    └────┬─────┘
                         │
              ┌──────────▼──────────┐
              │    dispatching      │
              └──┬──────┬───────┬──┘
                 │      │       │
    ┌────────────▼┐     │    ┌──▼──────────┐
    │ auth_error  │     │    │ infra_error  │
    └─────────────┘     │    └─────────────┘
                        │
                   ┌────▼────┐
                   │ running  │
                   └──┬──┬──┬┘
                      │  │  │
            ┌─────────┘  │  └──────────┐
            ▼            ▼             ▼
    ┌───────────┐  ┌──────────┐  ┌───────────────┐
    │ succeeded │  │  failed   │  │completed_dirty│
    └───────────┘  └──────────┘  └───────────────┘

    (cancelled is reachable from queued, dispatching, or running)
```

### 4.3 Transition Rules

| From | To | Trigger |
|---|---|---|
| `queued` | `dispatching` | Dispatch gate begins validation |
| `queued` | `cancelled` | Operator cancellation before dispatch |
| `dispatching` | `running` | Dispatch passes; backend process spawned |
| `dispatching` | `auth_error` | Credential validation fails during dispatch |
| `dispatching` | `infra_error` | Host unreachable, worktree creation fails, etc. |
| `dispatching` | `cancelled` | Operator cancellation during dispatch |
| `running` | `succeeded` | Backend exits 0 and artifact gates pass |
| `running` | `failed` | Backend exits non-zero, or artifact gates fail |
| `running` | `completed_dirty` | Backend produced ≥N events + `last.md` but crashed during cleanup |
| `running` | `auth_error` | Backend reports auth failure mid-run |
| `running` | `infra_error` | Process crash, SSH drop, OOM kill |
| `running` | `cancelled` | Operator sends SIGTERM/cancellation request |

### 4.4 Compatibility with `calyx-core` exec domain

The core `ExecRunState` type currently defines 5 states:
`queued | running | succeeded | failed | cancelled`.

The vNext runner adds `dispatching`, `auth_error`, `infra_error`, and
`completed_dirty`. These are **runner-layer refinements** and do NOT
require changes to `calyx-core`. Implementation options:

1. **Preferred (P11B):** Add the 4 new states to `ExecRunState` in core.
   This is a non-breaking additive change (union widening).
2. **Alternative:** Keep core states as-is; runner maps refined states
   to core states for storage (`auth_error`→`failed`, etc.) and tracks
   refinement in `metadata.failure_class`.

Decision deferred to P11B implementation; both paths are viable.

## 5. Persistence Model

### 5.1 Run Store (existing)

The existing `ExecRunStore` JSON file remains the canonical persistence
layer. Each run is an `ExecRunRecord` with typed fields and Zod validation.

### 5.2 Run Directory (new)

Each run also produces a directory of operational artifacts:

```
~/.agents/logs/calyx-runner/<run_id>/
  run.json          # RunSpec snapshot (immutable after dispatch)
  state.json        # Current lifecycle state + timestamps
  events.jsonl      # Append-only lifecycle event stream
  stderr.log        # Backend stderr capture
  receipt.json      # Terminal receipt (written once on completion)
  artifacts/        # Symlinks or copies of produced artifacts
  dispatch.json     # Dispatch gate decision record
```

### 5.3 Run Index

An append-only JSONL index at `~/.agents/logs/calyx-runner/index.jsonl`
enables fast enumeration without scanning directories:

```jsonc
{"run_id": "...", "state": "succeeded", "created_at": "...", "issue": "POL-123", "host": "blade"}
```

## 6. Transport and Adapter Boundaries

### 6.1 Backend Adapter Interface

```typescript
interface BackendAdapter {
  readonly name: string;

  /** Validate that the backend is available and configured. */
  preflight(config: RunnerConfig): Promise<PreflightResult>;

  /** Spawn the backend process and return a handle. */
  spawn(spec: RunSpec, worktree: WorktreeHandle): Promise<BackendHandle>;

  /** Stream lifecycle events from the running backend. */
  events(handle: BackendHandle): AsyncIterable<BackendEvent>;

  /** Request graceful shutdown. */
  stop(handle: BackendHandle, signal?: NodeJS.Signals): Promise<void>;
}
```

### 6.2 Adapter Implementations

| Adapter | Backend | Notes |
|---|---|---|
| `CodexAdapter` | Codex CLI | Profile-based reasoning tiers, `ANTHROPIC_API_KEY` stripping, native `agents.max_threads` concurrency |
| `ClaudeAdapter` | Claude Code CLI | OAuth auth, allowed-tool and permission-mode passthrough, native model/effort selection, and explicit `max_turns` truncation; rejects Codex concurrency controls |

Future adapters (e.g., Aider, Continue) follow the same interface.

### 6.3 Remote Dispatch

The final v5 cut uses one orchestration model (`RunService`) with multiple execution kernels, not separate workflow trees. The current concrete kernels are:

1. `agent_runner` for async agent sessions.
2. `host_process` for durable local process launches via `calyx run launch --kernel host_process --cwd <path> --argv <token> ...`.

The `host_process` surface is intentionally narrow: it is the first non-agent adapter and the direct replacement path for long-running `agent-notify`-style wrappers, not a generic workflow engine.

The authenticated run server replaces SSH-invoked `calyx exec` commands. The remote dispatch flow is:

1. Local: validate run intent, freeze the stored run intent, and let the selected kernel resolve its spec.
2. Call the target host's `calyx run serve` control plane via `calyx run launch --host <target>`.
3. Target host: execute the run lifecycle and persist `kernel_receipt.json` plus `run_record.json`.
4. Local: poll via `calyx run status --server-url <target-url> --run-id <id>` (or `receipt` / `logs`).

Agent-mail dispatch (async handoff without SSH polling) is a planned
extension but not required for P11B MVP.

## 7. Observability

### 7.1 Structured Events

Every state transition emits a `LifecycleEvent` to `events.jsonl`:

```jsonc
{
  "timestamp": "2026-03-03T12:00:00Z",
  "run_id": "abc-123",
  "event": "state_transition",
  "from": "dispatching",
  "to": "running",
  "metadata": { "backend": "claude", "host": "blade" }
}
```

### 7.2 OTel Integration

The runner emits OTel spans for:
- `calyx.exec.dispatch` — dispatch gate evaluation
- `calyx.exec.run` — full run lifecycle (root span)
- `calyx.exec.backend.spawn` — backend process creation
- `calyx.exec.receipt` — receipt generation

Fail-silent: OTel is best-effort and never blocks the run.

### 7.3 Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Runtime error (backend failure) |
| 2 | Usage / argument error |
| 3 | Docstore / ExecPlan validation failure |
| 4 | Host unreachable |
| 5 | Lock conflict |
| 6 | Runner crash (internal error) |
| 7 | Backend unavailable |
| 8 | Auth error |
| 9 | Dispatch rejected |

### 7.4 Notification Hooks

- **ntfy:** Push notification on terminal state transitions.
- **agent-mail:** Post status messages keyed by Linear issue ID.

Both are opt-in via runner configuration.

## 8. Failure Classification

### 8.1 Source-of-Truth Precedence

The legacy runner uses ad-hoc regex matching on stderr for classification,
leading to false positives (POL-459). The vNext runner uses a deterministic
precedence chain:

1. **Backend exit code** — if the backend reports a structured exit
   (auth error, usage error), trust it.
2. **Structured backend events** — if the backend emits typed error events
   (e.g., via `events.jsonl`), prefer them over stderr parsing.
3. **Stderr pattern matching** — last resort; bounded pattern set with
   explicit false-positive guards.
4. **Heuristic classifiers** — `completed_dirty` detection (event count +
   artifact presence despite non-zero exit).

### 8.2 Classification Categories

| Category | Exit Code | Retriable? | Description |
|---|---|---|---|
| `success` | 0 | — | Clean completion |
| `task_failure` | 1 | No | Backend completed but task failed |
| `auth_error` | 8 | No (needs credential fix) | Authentication/authorization failure |
| `infra_error` | 4-7 | Yes (after fix) | Infrastructure issue |
| `completed_dirty` | 0* | No (treat as success) | Substantial output despite crash |
| `dispatch_rejected` | 9 | No (needs spec fix) | Dispatch gate rejected RunSpec |

*`completed_dirty` maps to exit 0 when the heuristic confidence is high
(≥N events + final artifact present).

## 9. Shadow Mode and Migration

### 9.1 Shadow Mode

During migration, operators can enable shadow mode where both legacy and
vNext runners execute the same RunSpec:

1. Legacy runner executes as primary (operator sees its output).
2. vNext runner executes in parallel as shadow.
3. A comparison report highlights divergences in:
   - terminal state classification,
   - exit code,
   - receipt content,
   - artifact manifest.

Shadow mode is opt-in via `--shadow` flag or fleet policy.

### 9.2 Rollout Stages

| Stage | Criteria | Rollback |
|---|---|---|
| **Canary** | Single operator, single host, non-critical lanes | Revert to legacy runner |
| **Guarded** | All operators on one host; shadow mode on remaining hosts | Disable vNext on affected host |
| **Expansion** | All hosts, shadow mode off on canary host | Re-enable shadow mode |
| **Cutover** | Legacy runner deprecated; vNext is default | Re-enable legacy via fleet policy |
| **Sunset** | Legacy runner removed from fleet | Restore from `agents-bootstrap` archive |

### 9.3 Migration Checklist

- [ ] All 10 legacy subcommands have vNext equivalents
- [ ] Dispatch gate covers all legacy lane selection logic
- [ ] Failure classification matches legacy on golden-path runs
- [ ] `completed_dirty` heuristic validated against historical runs
- [ ] Receipt schema is superset of legacy receipt fields
- [ ] Fleet policy migration path documented
- [ ] Quarterback patterns updated for vNext API

## 10. Dependency Ledger

| Dependency | Status | Impact |
|---|---|---|
| POL-644 (legacy runner remediation) | Open | Caveat only; vNext replaces rather than remediates |
| POL-605 (Calyx umbrella) | Active | vNext is a milestone under the umbrella |
| `calyx-core` exec domain | Stable | vNext consumes existing types; may propose additive changes |
| `docstore` CLI | Stable | Used for ExecPlan resolution and artifact storage |
| `agent-mail` MCP | Stable | Used for notification hooks and async dispatch |
| `agents-bootstrap` | Stable | Deploys runner to fleet hosts |

## 11. Open Questions

1. **State widening vs metadata:** Should refined states (`auth_error`,
   `completed_dirty`) be added to `calyx-core` `ExecRunState` or kept
   as runner-layer metadata? Recommendation: add to core (non-breaking).
2. **Prompt template registry:** Should vNext consume the existing
   Mustache-like template registry (`REGISTRY.json`) or migrate to
   Calyx instructions domain? Recommendation: use `calyx instructions
   render` for prompt assembly.
3. **Agent-mail dispatch:** Scope for P11B MVP or defer to P11C?
   Recommendation: defer; SSH dispatch is sufficient for MVP.
