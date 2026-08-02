# Async Runner vNext: Contract Specifications

Status: Draft
Date: 2026-03-03
Issue: POL-699
Companion: [async-runner-vnext.md](./async-runner-vnext.md)

## Purpose

Machine-testable contract definitions for the vNext async runner runtime.
All schemas are specified as TypeScript interfaces with Zod validation.
JSON Schema equivalents can be derived mechanically from the Zod schemas.

---

## 1. Lifecycle State Machine

### 1.1 State Enum

```typescript
type RunState =
  | "queued"
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "auth_error"
  | "infra_error"
  | "completed_dirty";
```

### 1.2 State Properties

| State | Terminal | Retriable | Requires `started_at` | Requires `completed_at` | Requires cause |
|---|---|---|---|---|---|
| `queued` | No | — | No | No | No |
| `dispatching` | No | — | Yes | No | No |
| `running` | No | — | Yes | No | No |
| `succeeded` | Yes | — | Yes | Yes | No |
| `failed` | Yes | No | Yes | Yes | Yes (`exit_code` or `error`) |
| `cancelled` | Yes | — | No* | Yes | No |
| `auth_error` | Yes | No | No* | Yes | Yes (`error`) |
| `infra_error` | Yes | Yes | No* | Yes | Yes (`error`) |
| `completed_dirty` | Yes | No | Yes | Yes | Yes (`error` + `dirty_evidence`) |

*`cancelled`, `auth_error`, and `infra_error` may or may not have `started_at`
depending on when they occur (pre- or post-dispatch).

### 1.3 Transition Table

```typescript
const VALID_TRANSITIONS: Record<RunState, ReadonlySet<RunState>> = {
  queued:          new Set(["dispatching", "cancelled"]),
  dispatching:     new Set(["running", "cancelled", "auth_error", "infra_error"]),
  running:         new Set(["succeeded", "failed", "cancelled", "auth_error", "infra_error", "completed_dirty"]),
  succeeded:       new Set(),
  failed:          new Set(),
  cancelled:       new Set(),
  auth_error:      new Set(),
  infra_error:     new Set(),
  completed_dirty: new Set(),
};
```

### 1.4 Invariants

1. **No orphan transitions:** Every non-terminal state has at least one
   outgoing transition. Every terminal state has zero outgoing transitions.
2. **Monotonic timestamps:** `created_at ≤ started_at ≤ completed_at`.
3. **Terminal completeness:** Terminal states always have `completed_at`.
4. **Failure cause:** `failed`, `auth_error`, `infra_error`, and
   `completed_dirty` must have at least one of `exit_code` or `error`.
5. **Success clean:** `succeeded` must have `exit_code === 0` (or undefined
   if backend does not report exit codes).
6. **Unique run IDs:** No two records in a store share the same `run_id`.

### 1.5 Validation Implementation

```typescript
const runStateSchema = z.enum([
  "queued", "dispatching", "running",
  "succeeded", "failed", "cancelled",
  "auth_error", "infra_error", "completed_dirty",
]);

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "succeeded", "failed", "cancelled",
  "auth_error", "infra_error", "completed_dirty",
]);
```

---

## 2. Run Spec

The RunSpec is the immutable input contract for launching a run. Once
dispatch begins, the RunSpec is frozen and stored in `run.json`.

### 2.1 Schema

```typescript
interface RunSpec {
  /** Unique run identifier (UUID v4). Auto-generated if omitted. */
  run_id?: string;

  /** Linear issue ID for context and coordination. */
  issue?: string;

  /** Target host. "local" for current host. */
  host: string;

  /** Backend to use. */
  backend: "claude" | "codex";

  /** Backend-specific profile (e.g., "runner", "runner-medium"). */
  profile?: string;

  /** Prompt text or path to prompt file. */
  prompt?: string;

  /** Path to prompt file. Supports `docstore://` URIs. */
  prompt_file?: string;

  /** Prompt template ID from registry. */
  prompt_template?: string;

  /** Docstore ExecPlan reference (e.g., "execplan/POL-123/inputs/plan.md"). */
  execplan_ref?: string;

  /**
   * Whether to require an ExecPlan. The CLI defaults this to false for direct
   * prompt/template launches and true when no direct prompt source is supplied.
   * Non-CLI callers must set false explicitly for prompt-only intents.
   */
  require_execplan: boolean;

  /** Force pull ExecPlan from B2 before prompt assembly. */
  pull_execplan: boolean;

  /** Git worktree configuration. */
  worktree: {
    /** Explicit worktree path. Auto-created if omitted. */
    path?: string;
    /** Git ref to base worktree on. Default: "origin/main". */
    ref?: string;
    /** Branch name for the worktree. Auto-generated if omitted. */
    branch?: string;
    /** Override stale lock. */
    steal_lock?: boolean;
  };

  /** Artifacts that must be present for success. */
  required_artifacts?: string[];

  /**
   * Runner-owned materialization of the terminal assistant message. This is
   * distinct from legacy files discovered in the checkout.
   */
  output_capture?: {
    /** Safe basename beneath the Calyx run directory. */
    name: string;
    source: "agent_terminal_message";
    media_type: "application/json";
    schema: JsonValue;
    max_bytes: number;
    required: true;
  };

  /** Backend-specific options (passthrough). */
  backend_options?: {
    /** Claude: allowed tools list. */
    allowed_tools?: string[];
    /** Claude: skip permission prompts. */
    dangerously_skip_permissions?: boolean;
    /** Codex: max concurrent sub-agent threads. */
    max_threads?: number;
    /** Claude: native agentic turn cap. */
    max_turns?: number;
    /** Additional env vars to set/unset. */
    env?: Record<string, string | null>;
  };

  /** Notification configuration. */
  notifications?: {
    ntfy_topic?: string;
    agent_mail_thread?: string;
  };

  /** Operator-supplied metadata (opaque, stored in receipt). */
  metadata?: Record<string, unknown>;
}
```

### 2.2 Zod Schema

```typescript
const worktreeSpecSchema = z.object({
  path: z.string().min(1).optional(),
  ref: z.string().min(1).default("origin/main"),
  branch: z.string().min(1).optional(),
  steal_lock: z.boolean().default(false),
});

const backendOptionsSchema = z.object({
  allowed_tools: z.array(z.string()).optional(),
  dangerously_skip_permissions: z.boolean().optional(),
  max_threads: z.number().int().positive().optional(),
  max_turns: z.number().int().positive().optional(),
  env: z.record(z.string().nullable()).optional(),
}).passthrough();

const notificationsSchema = z.object({
  ntfy_topic: z.string().min(1).optional(),
  agent_mail_thread: z.string().min(1).optional(),
});

const runSpecSchema = z.object({
  run_id: z.string().uuid().optional(),
  issue: z.string().regex(/^[A-Z]+-\d+$/).optional(),
  host: z.string().min(1),
  backend: z.enum(["claude", "codex"]),
  profile: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  prompt_file: z.string().min(1).optional(),
  prompt_template: z.string().min(1).optional(),
  execplan_ref: z.string().min(1).optional(),
  require_execplan: z.boolean().default(true),
  pull_execplan: z.boolean().default(false),
  worktree: worktreeSpecSchema,
  required_artifacts: z.array(z.string().min(1)).optional(),
  backend_options: backendOptionsSchema.optional(),
  notifications: notificationsSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((spec, ctx) => {
  if (spec.backend === "claude" && spec.backend_options?.max_threads !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_threads"],
      message: "Claude does not support max_threads",
    });
  }
  if (spec.backend === "codex" && spec.backend_options?.max_turns !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_turns"],
      message: "Codex does not support max_turns",
    });
  }
});
```

### 2.3 Validation Rules

1. At most one direct prompt source, `prompt`, `prompt_file`, or
   `prompt_template`, may be provided.
2. Direct prompt/template launches may run without an ExecPlan by default.
   If `require_execplan` is true, `execplan_ref` or `issue` must resolve to an
   ExecPlan before dispatch.
3. The CLI applies the prompt-source-aware default before calling the resolver.
   Programmatic callers that bypass the CLI must set `require_execplan: false`
   explicitly for prompt-only or template-only intents; omitted values fail
   closed and require an ExecPlan.
4. If no direct prompt source is provided, the resolver builds the prompt from a
   resolved ExecPlan. With no prompt source and no ExecPlan content, the run
   fails before dispatch.
5. `backend_options.max_threads` is Codex-only sub-agent concurrency;
   `backend_options.max_turns` is Claude-only truncation. Invalid pairings are
   rejected at request, spec, receipt, and adapter boundaries.
5. `host` must be a known host in the fleet registry or `"local"`.
6. `profile` is only meaningful for the `codex` backend; ignored for `claude`.

---

## 3. Lifecycle Events

### 3.1 Event Schema

```typescript
interface LifecycleEvent {
  /** ISO 8601 timestamp. */
  timestamp: string;

  /** Run ID this event belongs to. */
  run_id: string;

  /** Event type. */
  event: LifecycleEventType;

  /** Previous state (for transitions). */
  from?: RunState;

  /** New state (for transitions). */
  to?: RunState;

  /** Human-readable message. */
  message?: string;

  /** Structured event payload. */
  payload?: Record<string, unknown>;
}

type LifecycleEventType =
  | "state_transition"
  | "dispatch_started"
  | "dispatch_passed"
  | "dispatch_rejected"
  | "backend_spawned"
  | "backend_event"
  | "artifact_detected"
  | "artifact_gate_passed"
  | "artifact_gate_failed"
  | "notification_sent"
  | "error"
  | "warning";
```

### 3.2 Zod Schema

```typescript
const lifecycleEventTypeSchema = z.enum([
  "state_transition",
  "dispatch_started", "dispatch_passed", "dispatch_rejected",
  "backend_spawned", "backend_event",
  "artifact_detected", "artifact_gate_passed", "artifact_gate_failed",
  "notification_sent",
  "error", "warning",
]);

const lifecycleEventSchema = z.object({
  timestamp: z.string().datetime(),
  run_id: z.string().min(1),
  event: lifecycleEventTypeSchema,
  from: runStateSchema.optional(),
  to: runStateSchema.optional(),
  message: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
```

### 3.3 Event Stream Contract

- Events are written to `events.jsonl` in the run directory as
  newline-delimited JSON.
- Events are append-only; no event is ever modified or deleted.
- Events are ordered by `timestamp` (monotonically increasing within a run).
- The lifecycle controller is the sole writer; concurrent writes are not
  permitted.

---

## 4. Artifact Manifest

### 4.1 Schema

```typescript
interface ArtifactManifest {
  /** Run ID this manifest belongs to. */
  run_id: string;

  /** ISO 8601 timestamp when manifest was finalized. */
  finalized_at: string;

  /** Required artifacts declared in RunSpec. */
  required: ArtifactEntry[];

  /** Additional artifacts discovered during the run. */
  discovered: ArtifactEntry[];

  /** Whether all required artifacts are present. */
  gate_passed: boolean;

  /** Missing required artifacts (empty if gate passed). */
  missing: string[];
}

interface ArtifactEntry {
  /** Artifact name or path pattern. */
  name: string;

  /** Where the artifact was found. */
  location: "worktree" | "docstore" | "run_dir";

  /** Absolute path to the artifact. */
  path: string;

  /** File size in bytes. */
  size_bytes?: number;

  /** SHA-256 hash. */
  sha256?: string;

  /** Whether this artifact was required by RunSpec. */
  required: boolean;

  /** ISO 8601 timestamp when the artifact was detected. */
  detected_at: string;
}
```

### 4.2 Zod Schema

```typescript
const artifactLocationSchema = z.enum(["worktree", "docstore", "run_dir"]);

const artifactEntrySchema = z.object({
  name: z.string().min(1),
  location: artifactLocationSchema,
  path: z.string().min(1),
  size_bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  required: z.boolean(),
  detected_at: z.string().datetime(),
});

const artifactManifestSchema = z.object({
  run_id: z.string().min(1),
  finalized_at: z.string().datetime(),
  required: z.array(artifactEntrySchema),
  discovered: z.array(artifactEntrySchema),
  gate_passed: z.boolean(),
  missing: z.array(z.string().min(1)),
});
```

### 4.3 Gating Rules

1. Artifact gating occurs after the backend process exits.
2. The gate checks each `required_artifacts` entry from the RunSpec
   against files in the worktree, docstore, and run directory.
3. If any required artifact is missing, the run transitions to `failed`
   with `error: "artifact gate failed: missing <names>"`.
4. If the backend exited with a non-zero code but all artifacts are
   present, the run transitions to `completed_dirty` (not `succeeded`).

### 4.4 Typed terminal JSON capture

`output_capture` is the trusted boundary for read-only detector agents. Agent
definitions declare it as an `artifact_writes` entry with
`location: run-artifact`, `source: agent_terminal_message`,
`media_type: application/json`, a JSON Schema, `max_bytes`, and
`required: true`. Calyx preserves that declaration as a typed field instead of
turning it into a model-written file requirement.

Capture-bearing runs currently require Codex, one ephemeral turn, and
`sandbox: read-only`. They use config-isolated `codex exec` with the runner's
output schema, `--ignore-user-config`, `--ignore-rules`, and
`-c project_doc_max_bytes=0`; they do not add the run directory or inherit user
MCP/app tools. They reject caller-supplied `backend_options.env`, resolve the
provider executable against the runner-managed path before assembling the
child environment, and enforce `max_bytes` incrementally while reading stdout.
The zero project-doc budget disables repository and project
`AGENTS.md` discovery so audited guidance cannot silently become detector
instructions. The backend can therefore read the checkout but cannot write
either the checkout or the run root.

This is a supported partial isolation boundary, not a claim of fully unbiased
guidance archaeology: Codex can still load the global `$CODEX_HOME/AGENTS.md`.
Full suppression or auditable neutralization of that global guidance remains a
POL-2058 dependency.

After a successful backend exit, the trusted runner bounds and parses the
terminal message as strict JSON (including duplicate-key rejection), validates
the schema, canonicalizes it, and publishes it atomically as a mode-0600 file
beneath the real run directory. The artifact manifest records the canonical
file's exact byte count and SHA-256. The raw terminal message is never copied
into a capture-bearing receipt or terminal-event payload: success is represented
by the canonical artifact, while rejection records only bounded status, observed
byte count, SHA-256, and error metadata. The observed-byte digest covers every
stdout chunk received by the runner, including the chunk that first crosses the
limit; it does not claim bytes the terminated provider never delivered. Unsafe
names, missing or invalid output,
symlink/existing-target conflicts, and durable-write failures are terminal
failures. A same-named file discovered in the worktree is deliberately
ineligible to satisfy this capture gate.

`required_artifacts` remains the explicitly legacy file-discovery mechanism;
it does not grant a read-only agent write authority.

---

## 5. Receipt Schema

### 5.1 Schema

```typescript
interface RunReceipt {
  /** Schema version for forward compatibility. */
  schema_version: "1.0";

  /** Unique run identifier. */
  run_id: string;

  /** Terminal state. */
  state: RunState;

  /** Original RunSpec (frozen at dispatch time). */
  run_spec: RunSpec;

  /** Timing information. */
  timing: {
    created_at: string;
    dispatched_at?: string;
    started_at?: string;
    completed_at: string;
    duration_ms?: number;
    dispatch_duration_ms?: number;
    backend_duration_ms?: number;
  };

  /** Exit information. */
  exit: {
    exit_code?: number;
    error?: string;
    failure_class?: FailureClass;
    failure_source?: FailureSource;
  };

  /** Artifact manifest snapshot. */
  artifacts: ArtifactManifest;

  /** Log summary (counts by level). */
  log_summary: {
    total: number;
    info: number;
    warn: number;
    error: number;
  };

  /** Host and environment context. */
  environment: {
    host: string;
    backend: string;
    profile?: string;
    worktree_path?: string;
    branch?: string;
    node_version?: string;
    calyx_version?: string;
  };

  /** Notification delivery status. */
  notifications?: {
    ntfy_sent?: boolean;
    agent_mail_sent?: boolean;
  };

  /** Human-readable summary line. */
  summary: string;

  /** Operator-supplied metadata (passthrough from RunSpec). */
  metadata?: Record<string, unknown>;
}
```

### 5.2 Zod Schema

```typescript
const failureClassSchema = z.enum([
  "success",
  "task_failure",
  "auth_error",
  "infra_error",
  "completed_dirty",
  "dispatch_rejected",
]);

const failureSourceSchema = z.enum([
  "exit_code",
  "backend_event",
  "stderr_pattern",
  "heuristic",
  "dispatch_gate",
]);

const receiptTimingSchema = z.object({
  created_at: z.string().datetime(),
  dispatched_at: z.string().datetime().optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative().optional(),
  dispatch_duration_ms: z.number().int().nonnegative().optional(),
  backend_duration_ms: z.number().int().nonnegative().optional(),
});

const receiptExitSchema = z.object({
  exit_code: z.number().int().optional(),
  error: z.string().optional(),
  failure_class: failureClassSchema.optional(),
  failure_source: failureSourceSchema.optional(),
});

const receiptEnvironmentSchema = z.object({
  host: z.string().min(1),
  backend: z.string().min(1),
  profile: z.string().optional(),
  worktree_path: z.string().optional(),
  branch: z.string().optional(),
  node_version: z.string().optional(),
  calyx_version: z.string().optional(),
});

const receiptNotificationsSchema = z.object({
  ntfy_sent: z.boolean().optional(),
  agent_mail_sent: z.boolean().optional(),
});

const runReceiptSchema = z.object({
  schema_version: z.literal("1.0"),
  run_id: z.string().min(1),
  state: runStateSchema,
  run_spec: runSpecSchema,
  timing: receiptTimingSchema,
  exit: receiptExitSchema,
  artifacts: artifactManifestSchema,
  log_summary: z.object({
    total: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
  }),
  environment: receiptEnvironmentSchema,
  notifications: receiptNotificationsSchema.optional(),
  summary: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});
```

Receipt timing is an authority boundary, not descriptive metadata. Present
timestamps must form `created <= dispatched <= started <= completed` (omitted
optional stages are skipped). `duration_ms` and `dispatch_duration_ms` must
correspond to their timestamp deltas within 1,000 ms; `backend_duration_ms`
must fit inside the `started_at`/`completed_at` envelope plus the same explicit
serialization/scheduler tolerance. Before a receipt may rebuild a service
record or index row, its chronology must also admit the durable
`accepted_at`, `last_dispatch_at`, and `execution_started_at` boundaries. For
agent-runner and current bound host-process receipts, `created_at` is an
execution-creation timestamp after admission. The unbound host-process
predecessor used intent creation instead; that shape is preserved only as a
coherent terminal observation and never establishes rebuild authority.

### 5.3 Receipt Invariants

1. Receipt is written exactly once, on terminal state.
2. `state` in the receipt matches the terminal state in the run store.
3. `timing.duration_ms` equals `completed_at - created_at` (if both valid).
4. `exit.failure_class` is set for all non-success terminal states.
5. `exit.failure_source` records which stage of the precedence chain
   determined the classification.
6. `artifacts.gate_passed` is consistent with the terminal state
   (must be true for `succeeded`).

### 5.4 Spawn-backed cancellation boundary

Spawn-backed `agent_runner` adapters receive a run-scoped abort signal from
their active-run state. On Unix, the shared spawn implementation makes the
backend CLI the leader of an isolated process group. A stop sends `SIGTERM` to
that group, waits for the configured `stop_grace_ms`, then sends `SIGKILL` if
any group member remains. The spawn promise and adapter `stop()` resolve only
after the group is gone; cancellation is a `cancelled` lifecycle outcome, not a
spawn infrastructure error. Windows uses direct-child signalling as the safe
platform fallback. Inactivity stops use the same teardown path while retaining
their distinct `stalled_inactivity` classification.

---

## 6. Failure-Classification Precedence

### 6.1 Precedence Chain

The failure classifier evaluates sources in strict priority order.
The first source that produces a definitive classification wins.
Later sources are not consulted.

```
Priority 1: Backend exit code (structured)
    │
    │  If backend reports a typed exit code → use it.
    │  Codes: 0=success, 8=auth_error, 2=usage_error, etc.
    │
    ▼
Priority 2: Structured backend events
    │
    │  If backend emitted typed error events → classify from event type.
    │  Example: { event: "auth_failure", provider: "anthropic" }
    │
    ▼
Priority 3: Heuristic classifiers
    │
    │  completed_dirty: event_count ≥ 10 AND final_artifact_present
    │                   AND exit_code ≠ 0
    │
    ▼
Priority 4: Stderr pattern matching (bounded)
    │
    │  Pattern set is version-pinned and enumerated.
    │  Each pattern has an explicit false-positive guard.
    │
    ▼
Priority 5: Default
    │
    │  exit_code 0 → success
    │  exit_code ≠ 0 → task_failure
    │  no exit_code → infra_error
```

### 6.2 Pattern Registry (Priority 4)

Stderr patterns are version-pinned in a registry. Each entry has:

```typescript
interface StderrPattern {
  /** Unique pattern ID. */
  id: string;

  /** Regex pattern to match against stderr. */
  pattern: RegExp;

  /** Classification if matched. */
  class: FailureClass;

  /** False-positive guard: patterns that, if also present, negate this match. */
  negated_by?: RegExp[];

  /** Version when this pattern was added. */
  since: string;

  /** Optional: version when this pattern was retired. */
  retired?: string;
}
```

Initial pattern set:

| ID | Pattern | Class | Negated By |
|---|---|---|---|
| `auth-401` | `/\b(401\|Unauthorized)\b/i` | `auth_error` | `/mock\|test\|fixture/i` |
| `auth-403` | `/\b(403\|Forbidden)\b/i` | `auth_error` | `/mock\|test\|fixture/i` |
| `auth-token` | `/token.*(expired\|invalid\|revoked)/i` | `auth_error` | — |
| `infra-ssh` | `/Connection refused\|Connection reset/i` | `infra_error` | — |
| `infra-spawn` | `/command not found\|ENOENT/i` | `infra_error` | `/mock\|test/i` |
| `infra-oom` | `/Out of memory\|OOM\|SIGKILL/i` | `infra_error` | — |
| `infra-panic` | `/panic\|SIGSEGV\|core dumped/i` | `infra_error` | — |

### 6.3 `completed_dirty` Decision Logic

```
IF event_count >= DIRTY_THRESHOLD (default: 10)
   AND (final_artifact_exists OR last_md_exists)
   AND exit_code != 0
   AND no auth_error or infra_error signals
THEN
   classify as completed_dirty
   set exit_code_override = 0  (treat as soft success)
ELSE
   fall through to default classification
```

The `DIRTY_THRESHOLD` is configurable via runner config. The default of 10
matches the legacy runner's heuristic (POL-459).

### 6.4 Classification Output

```typescript
interface ClassificationResult {
  /** Determined failure class. */
  class: FailureClass;

  /** Which precedence level determined the classification. */
  source: FailureSource;

  /** Confidence: "definitive" or "heuristic". */
  confidence: "definitive" | "heuristic";

  /** The specific signal that triggered classification. */
  signal: string;

  /** Original exit code from backend. */
  raw_exit_code?: number;

  /** Overridden exit code (for completed_dirty). */
  effective_exit_code: number;
}
```

---

## 7. Dispatch Gate Contract

### 7.1 Dispatch Receipt

```typescript
interface DispatchReceipt {
  /** Unique dispatch ID. */
  dispatch_id: string;

  /** Associated run ID (set after launch). */
  run_id?: string;

  /** ISO 8601 timestamp. */
  timestamp: string;

  /** Dispatch decision. */
  decision: "accepted" | "rejected";

  /** Selected lane. */
  lane?: "execplan" | "prompt_only" | "prompt_template";

  /** Rejection reason (if rejected). */
  rejection_reason?: string;

  /** Whether dispatch was force-overridden. */
  overridden: boolean;

  /** Override reason (if overridden). */
  override_reason?: string;

  /** Validation checks performed. */
  checks: DispatchCheck[];

  /** Warnings (non-blocking issues). */
  warnings: string[];
}

interface DispatchCheck {
  /** Check name. */
  name: string;

  /** Pass/fail. */
  passed: boolean;

  /** Detail message. */
  message: string;
}
```

### 7.2 Dispatch Checks

| Check | Blocking | Description |
|---|---|---|
| `execplan_present` | Conditional | ExecPlan exists in docstore (skipped if `require_execplan=false`) |
| `host_reachable` | Yes | Target host responds to SSH (skipped for `host=local`) |
| `backend_available` | Yes | Backend CLI exists and responds to `--version` |
| `worktree_available` | Yes | Worktree path is free or lock can be stolen |
| `prompt_resolved` | Yes | Prompt text, file, or template resolves to non-empty content |
| `credentials_valid` | Yes | Backend credentials pass preflight check |

---

## 8. Run Directory Layout

```
~/.agents/logs/calyx-runner/<run_id>/
├── run.json              # Frozen RunSpec
├── state.json            # Current state + timestamps (updated on transitions)
├── dispatch.json         # Dispatch receipt
├── events.jsonl          # Append-only lifecycle events
├── stderr.log            # Backend stderr capture
├── receipt.json          # Terminal receipt (written once)
├── artifacts.json        # Artifact manifest
└── artifacts/            # Symlinks to produced artifacts
    ├── plan.md -> /path/to/worktree/docs/plan.md
    └── ...
```

### 8.1 File Lifecycle

| File | Created | Updated | Finalized |
|---|---|---|---|
| `run.json` | On dispatch | Never (immutable) | — |
| `state.json` | On dispatch | On every state transition | On terminal state |
| `dispatch.json` | On dispatch | Never (immutable) | — |
| `events.jsonl` | On first event | Append on every event | On terminal state |
| `stderr.log` | On backend spawn | Append during run | On backend exit |
| `receipt.json` | — | — | On terminal state (write-once) |
| `artifacts.json` | — | — | After artifact gating (write-once) |

---

## 9. Configuration Schema

### 9.1 Runner Config

```typescript
interface RunnerConfig {
  /** Default backend when not specified in RunSpec. */
  default_backend: "claude" | "codex";

  /** Backend profiles. */
  profiles: Record<string, BackendProfile>;

  /** Failure classification settings. */
  classification: {
    dirty_threshold: number;
    pattern_version: string;
  };

  /** Notification defaults. */
  notifications: {
    ntfy_topic?: string;
    agent_mail_enabled: boolean;
  };

  /** Worktree settings. */
  worktree: {
    base_path: string;  // e.g., "~/projects" for runtime-managed target-repo worktrees when kernel=agent_runner
    default_ref: string; // e.g., "origin/main"
    lock_timeout_ms: number;
  };

  /** Host registry (if not using calyx config). */
  hosts?: Record<string, HostConfig>;
}

interface BackendProfile {
  backend: "claude" | "codex";
  model?: string;
  reasoning_level?: "low" | "medium" | "high" | "xhigh";
  max_threads?: number;
  max_turns?: number;
  description: string;
}

interface HostConfig {
  ssh: string;  // e.g., "caleb@blade"
  roles: string[];
  gpu?: string;
}
```

### 9.2 Config Precedence

1. Explicit RunSpec fields (highest priority)
2. Environment variables (`CALYX_RUNNER_BACKEND`, etc.)
3. Fleet policy file (`~/.config/polli/calyx-runner/policy.json`)
4. Runner config defaults (lowest priority)

---

## 10. Exit Code Contract

| Code | Name | Description | Maps to `FailureClass` |
|---|---|---|---|
| 0 | `SUCCESS` | Run completed successfully | `success` |
| 1 | `TASK_FAILURE` | Backend completed but task failed | `task_failure` |
| 2 | `USAGE_ERROR` | Invalid arguments or RunSpec | — |
| 3 | `VALIDATION_ERROR` | Docstore/ExecPlan validation failed | `dispatch_rejected` |
| 4 | `HOST_UNREACHABLE` | Target host not reachable | `infra_error` |
| 5 | `LOCK_CONFLICT` | Worktree is locked by another run | `infra_error` |
| 6 | `RUNNER_CRASH` | Internal runner error | `infra_error` |
| 7 | `BACKEND_UNAVAILABLE` | Backend CLI not found or not responding | `infra_error` |
| 8 | `AUTH_ERROR` | Authentication/authorization failure | `auth_error` |
| 9 | `DISPATCH_REJECTED` | Dispatch gate rejected the RunSpec | `dispatch_rejected` |

These codes align with the legacy `async-runner` exit codes for operational
continuity. Quarterback scripts that switch on exit codes will not break.

---

## 11. Backward Compatibility

### 11.1 Legacy Field Mapping

| Legacy Field | vNext Equivalent | Notes |
|---|---|---|
| `run.json` (flat) | `RunSpec` | Superset; all legacy fields preserved |
| `summary.json` | `receipt.json` | Richer schema; legacy fields extractable |
| `events.jsonl` | `events.jsonl` | Compatible format; new event types added |
| `stderr.log` | `stderr.log` | Identical |
| `last.md` | `artifacts/last.md` | Moved to artifacts dir |
| `index.jsonl` | `index.jsonl` | Compatible; new fields added |

### 11.2 API Compatibility

The final v5 cut does **not** preserve the proposed exec-based compatibility layer from this earlier design. The canonical operator-facing replacements are:

| Legacy Command | Current Equivalent |
|---|---|
| `async-runner launch` | `calyx run launch` |
| `async-runner status` | `calyx run status` |
| `async-runner logs` | `calyx run logs` |
| `async-runner stop` | `calyx run stop` |
| `async-runner ps` | `calyx run ps` |

Commands proposed here but not carried forward (`resume`, `dispatch`, `capabilities`, `policy`, `doctor`) were intentionally dropped rather than shimmed, consistent with the hard-cut product policy.

Retired wrapper names such as `calyx exec-launch` now fail with an actionable
canonical replacement; Git retains the migration history.
