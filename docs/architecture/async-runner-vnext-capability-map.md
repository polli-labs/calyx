# Async Runner vNext: Capability Map

Status: Draft
Date: 2026-03-03
Issue: POL-699
Companion: [async-runner-vnext.md](./async-runner-vnext.md)

## Purpose

Explicit mapping of every legacy `async-runner` capability to its Calyx
primitive target, identifying gaps that must be filled before cutover.

## Legend

- **Calyx Primitive**: Existing domain function or type in `calyx-core` or
  the Calyx CLI that covers the capability.
- **Gap**: Capability that has no Calyx primitive and requires new code in
  the `calyx-runner` app layer or a core extension.
- **Coverage**: `full` = Calyx primitive covers the capability completely;
  `partial` = some adaptation needed; `gap` = no coverage, new code required.

---

## 1. Input Model

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| `--prompt` / `--prompt-file` | Inline or file-based prompt text | `calyx instructions render` | partial | Runner must compose prompt from ExecPlan + context; instructions domain handles template rendering |
| `--prompt-template <id>` | Resolve prompt from `REGISTRY.json` | `calyx instructions render --template` | partial | Template registry integration exists but not formally in exec domain |
| `--prompt-file docstore://` | Resolve prompt from docstore URI | External: `docstore` CLI | gap | Runner needs a docstore URI resolver that auto-pulls on remote hosts |
| `--issue <POL-NNN>` | Linear issue context injection | None (external Linear MCP) | gap | Runner must query Linear for issue context; not a Calyx domain concern |
| `--backend claude\|codex` | Backend selection | `agent_runner` backend adapters | full | Implemented by the runner adapter contract |
| `--model <model>` | Explicit backend model selection | `backend_options.model` + daemon feature gate | partial | Forwarded to Claude CLI as of POL-1494; Codex/app-server model contract remains deferred |
| `--profile runner\|runner-medium\|...` | Backend profile/receipt label | RunSpec `profile` | partial | Retained for receipts/policy labels; it must not be treated as model selection without an explicit profile resolver |
| `--host blade\|carbon\|...` | Target host selection | `calyx config compile` (host registry) | partial | Config domain has host definitions; runner needs SSH dispatch logic |
| `--worktree <path>` | Explicit worktree path | None | gap | New: `WorktreeManager` in `calyx-runner` |
| `--branch <ref>` | Git ref for worktree creation | None | gap | Part of `WorktreeManager` |
| `--no-require-execplan` | Skip ExecPlan validation | None | gap | Dispatch gate policy flag |
| `--pull-execplan` | Force B2 pull before prompt assembly | External: `docstore` CLI | gap | Docstore resolver with `--force-pull` |
| `--require-artifacts` | Gate terminal status on artifact presence | None | gap | New: `ArtifactManifest` in `calyx-runner` |
| `--dangerously-skip-permissions` | Pass through to Claude backend | None | gap | Adapter-specific passthrough option |
| `--allowedTools` | Tool allowlist for Claude | None | gap | Adapter-specific passthrough option |
| `--steal-lock` | Override stale worktree lock | None | gap | Part of `WorktreeManager` lock protocol |
| `--override-dispatch-reject` | Force dispatch despite rejection | None | gap | Dispatch gate override flag |

## 2. Orchestration / Lifecycle

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| Run state tracking (`running`, `succeeded`, `failed`, ...) | Core lifecycle | `ExecRunState` + `ExecRunStore` | full | Existing 5-state machine; vNext adds 4 refined states |
| State transitions with validation | Enforce valid transitions | `VALID_TRANSITIONS` map in `exec.ts` | full | Transition map exists; extend for new states |
| Run record persistence (JSON) | Store run records | `ExecRunStore` + `loadRunStore`/`saveRunStore` | full | Direct reuse |
| Duplicate run ID detection | Prevent collisions | `evaluateRunStore` validation | full | Already validated |
| Timestamp ordering invariants | `created_at ≤ started_at ≤ completed_at` | `evaluateRunStore` validation | full | Already validated |
| Worktree creation + lockfile | Isolate each run in its own worktree | None | gap | New: `WorktreeManager` with lock protocol |
| Process spawn + monitoring | Launch backend process, capture stdio | None | gap | New: `BackendAdapter.spawn()` + `events()` |
| Graceful stop (SIGTERM/SIGKILL) | Stop a running backend | None | gap | New: `BackendAdapter.stop()` |
| Dispatch preflight validation | Validate inputs before launch | None (partially `exec validate`) | gap | New: `DispatchGate` with lane selection |
| Lane selection (`prompt_only` / `execplan_required`) | Route dispatch by input shape | None | gap | Dispatch gate policy |
| Environment sanitization | Strip API keys for OAuth fallthrough | None | gap | Adapter-specific env manipulation |

## 3. Receipt / Reporting

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| Structured receipt generation | Terminal state summary | `getExecReceipt()` in `exec.ts` | full | Existing implementation covers core fields |
| Duration computation | `completed_at - started_at` | `computeDurationMs()` in `exec.ts` | full | Already implemented |
| Log summary (info/warn/error counts) | Aggregate log levels | `getExecReceipt()` log_summary | full | Already implemented |
| Summary text generation | Human-readable status line | `buildSummaryText()` in `exec.ts` | full | Already implemented |
| `dispatch.json` emission | Dispatch decision record | None | gap | New: dispatch receipt schema |
| `DISPATCH_ADDENDUM.md` | Human-readable dispatch rationale | None | gap | New: dispatch addendum generator |
| `events.jsonl` streaming | Append-only lifecycle events | None | gap | New: event emitter writing to run dir |
| `stderr.log` capture | Raw stderr from backend | None | gap | New: backend adapter stdio capture |
| `last.md` capture (Codex) | Best-effort final output snapshot | None | gap | Codex adapter specific |
| `run.json` + `summary.json` | Run metadata files | Partially `ExecRunRecord` | partial | Run record covers most fields; run dir layout is new |
| Run index (`index.jsonl`) | Append-only run enumeration | None | gap | New: index writer |

## 4. Failure Classification

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| Terminal status evaluation | Determine final run state | `ExecRunState` (basic) | partial | Core has `succeeded/failed/cancelled`; vNext adds `auth_error`, `infra_error`, `completed_dirty` |
| Auth error detection (regex on stderr) | Classify 401/403/token patterns | None | gap | New: `FailureClassifier` with deterministic precedence |
| Infra error detection (regex on stderr) | Classify connection/spawn failures | None | gap | Part of `FailureClassifier` |
| `completed_dirty` heuristic | ≥N events + `last.md` despite crash | None | gap | New: heuristic classifier in `calyx-runner` |
| Exit code mapping | Exit code → failure category | Partially (exit code conventions) | partial | CLI has exit code conventions; runner needs full mapping table |
| Pattern-bounded false-positive guards | Prevent misclassification (POL-459) | None | gap | Explicit pattern set with version-pinned regexes |

## 5. Multi-Host Dispatch

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| Host registry (`HOSTS` dict) | Known hosts with SSH configs | `calyx config compile` (host YAML) | partial | Config domain has host definitions; needs SSH connection info extraction |
| SSH remote invocation | `ssh <host> async-runner launch --host local` | None | gap | New: `RemoteDispatch` in `calyx-runner` |
| Remote ExecPlan pull | `--pull-execplan` on target host | External: `docstore` CLI | gap | Docstore resolver with remote pull |
| Agent-mail async dispatch | `--dispatch agent-mail` | External: `agent-mail` MCP | gap | Deferred to P11C; not MVP |
| Remote status polling | `async-runner status --host <target>` | `calyx run status --server-url <url>` | partial | Requires authenticated run server; no SSH polling shim |

## 6. Configuration and Policy

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| Fleet policy (`policy.json`) | Default backend, profiles per host | `calyx config compile` | partial | Config domain handles fleet YAML; runner needs policy extraction |
| Backend auto-detection | Prefer Codex if available | None | gap | Adapter preflight checks |
| Explicit model forwarding | `--model opus` → Claude CLI `--model opus` | `backend_options.model` | partial | Claude path implemented by POL-1494; Codex/app-server needs a separate contract before accepting model forwarding |
| Profile → model mapping | `runner` → model/reasoning bundle | None | gap | Still requires a profile registry/resolver; do not overload `--profile` at launch time |
| Backend execution limits | Codex `agents.max_threads` concurrency; Claude `--max-turns` truncation | Typed `max_threads` / `max_turns`, backend-specific rejection | closed | Intent, spec, adapter argv, and receipt preserve the native meaning |
| Environment variable overrides | `ASYNC_RUNNER_BACKEND`, etc. | None | gap | Runner config precedence chain |

## 7. Notification and Coordination

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| ntfy push notifications | Terminal state notifications | None | gap | New: `NotifyHook` in `calyx-runner` |
| Agent-mail status posts | Status keyed by Linear issue | None | gap | New: `AgentMailHook` in `calyx-runner` |
| Quarterback coordination | Long-lived coordinator dispatching runners | None | gap | Orchestration pattern; not a primitive |
| Awaiter sub-agents | Lightweight pollers for completion | None | gap | Pattern documentation; not a primitive |

## 8. Observability

| Legacy Capability | Description | Calyx Primitive | Coverage | Gap / Notes |
|---|---|---|---|---|
| OTel spans (dispatch, launch, lifecycle) | Structured tracing | None | gap | New: OTel instrumentation in `calyx-runner` |
| Run index for fleet enumeration | `~/.agents/logs/async-runner/index.jsonl` | None | gap | New: run index writer |
| Historical exit code semantics (0-9) | Deterministic exit codes | CLI exit code conventions | partial | Runner must align with existing Calyx CLI exit codes |
| `doctor` environment validation | Validate SSH, backends, docstore | None | gap | New: `calyx exec doctor` subcommand |
| `capabilities` self-discovery | Report hosts, patterns, env | None | gap | New: `calyx exec capabilities` subcommand |

## 9. Coverage Summary

| Section | Total Capabilities | Full | Partial | Gap |
|---|---|---|---|---|
| Input Model | 16 | 0 | 4 | 12 |
| Orchestration / Lifecycle | 11 | 5 | 0 | 6 |
| Receipt / Reporting | 11 | 5 | 1 | 5 |
| Failure Classification | 6 | 0 | 2 | 4 |
| Multi-Host Dispatch | 5 | 0 | 1 | 4 |
| Configuration and Policy | 5 | 0 | 1 | 4 |
| Notification / Coordination | 4 | 0 | 0 | 4 |
| Observability | 5 | 0 | 1 | 4 |
| **Total** | **63** | **10** | **10** | **43** |

### Interpretation

- **10 capabilities (16%)** are fully covered by existing Calyx primitives
  (primarily in the `exec` domain: state machine, validation, receipts).
- **10 capabilities (16%)** are partially covered — existing primitives
  provide the foundation but need adapter wiring or extension.
- **43 capabilities (68%)** are gaps requiring new code in the
  `calyx-runner` app layer package.

This is expected: the existing `exec` domain provides record-keeping and
state tracking, but the actual runner (process orchestration, dispatch,
multi-host, failure classification) is entirely new application-layer
functionality that *composes* the domain primitives.

## 10. Gap Priority for P11B Implementation

### Must-have (P11B MVP)

1. `BackendAdapter` interface + Claude adapter
2. `LifecycleController` (state machine driver)
3. `DispatchGate` (RunSpec validation, ExecPlan resolution)
4. `WorktreeManager` (create, lock, release)
5. `FailureClassifier` (deterministic precedence chain)
6. `ReceiptEmitter` (structured receipt + run directory)
7. Run index writer
8. Exit code mapping

### Should-have (P11B full)

9. Codex adapter
10. `ArtifactManifest` (artifact gating)
11. ntfy + agent-mail notification hooks
12. `events.jsonl` streaming
13. Remote SSH dispatch
14. Docstore URI resolver

### Deferred (P11C+)

15. Agent-mail async dispatch
16. Shadow mode dual-run comparison
17. `calyx exec doctor` / `calyx exec capabilities`
18. OTel instrumentation
19. Quarterback pattern documentation
