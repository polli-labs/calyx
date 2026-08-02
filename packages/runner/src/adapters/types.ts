/**
 * @polli-labs/calyx-runner — Backend adapter interface.
 *
 * Defines the contract that all backend adapters (Claude, Codex, etc.)
 * must implement. The runner orchestrator interacts with backends
 * exclusively through this interface.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type {
  AgentActivityProgress,
  AgentTerminalEvidence,
  BackendEvent,
  BackendOptions,
  LifecycleEvent,
  RunOutputCapture,
  RunOutputCaptureObservation,
  ProviderConstraint,
} from "../types.js";

/** Session locator returned by session discovery after adapter execution. */
export interface SessionInfo {
  /** Backend-specific session identifier. */
  id: string;
  /** Absolute path to the session JSONL file. */
  path?: string;
  /** Which backend produced this session. */
  backend: "claude" | "codex";
}

/** Result returned by an adapter after execution completes. */
export interface AdapterResult {
  /** Process exit code, or undefined if the process was killed/crashed. */
  exit_code?: number;
  /** Captured stderr output for classifier consumption. */
  stderr: string;
  /** Structured backend events emitted during execution. */
  events: BackendEvent[];
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Session locator discovered after execution, if available. */
  session?: SessionInfo;
  /** The agent's final assistant message from the session, if available. No truncation. */
  agent_terminal_message?: string;
  /** Bounded byte/hash facts for a typed terminal capture. Never contains raw output. */
  output_capture_observation?: RunOutputCaptureObservation;
  /** Set when the backend process was killed by a signal. */
  signal?: string;
  /** Set when the spawn itself failed (buffer overflow, ENOENT, etc.). */
  spawn_error?: string;
  /** Sparse authoritative terminal result projected from a structured backend stream. */
  terminal_evidence?: AgentTerminalEvidence;
  /** Bounded provider-capacity fact; raw provider payloads are never retained. */
  provider_constraint?: ProviderConstraint;
}

/**
 * Capability envelope shared by adapters and live sessions.
 *
 * On `BackendAdapter`, this is the maximum feature set the adapter can expose
 * across all runs. On `AdapterSession`, it is the effective feature set for the
 * concrete live session after startup/resume choices have been applied.
 */
export interface AdapterCapabilities {
  streaming: boolean;
  turnControl: boolean;
  resumeSession: boolean;
  forkSession: boolean;
  approvals: "none" | "client-mediated" | "auto";
}

/** Options used to open an adapter session for a run. */
export interface AdapterStartOptions {
  /** The run identifier. */
  run_id: string;
  /** Working directory (worktree path). */
  cwd: string;
  /** Run artifact directory for spill files and other diagnostics. */
  run_dir?: string;
  /** Typed terminal output contract; forces a tool-isolated backend path. */
  output_capture?: RunOutputCapture;
  /** Backend-specific options. */
  backend_options?: BackendOptions;
  /** Runner-owned environment keys that must be absent from the provider child. */
  environment_redactions?: readonly string[];
  /** Replacement system prompt for backends that support it. */
  system_prompt?: string;
  /** Additional instructions to append to the backend's default system prompt. */
  append_system_prompt?: string;
  /** Callback for lifecycle events emitted during execution. */
  onEvent?: (event: LifecycleEvent) => void;
  /** Callback for sparse backend progress facts. */
  onActivity?: (activity: AgentActivityProgress) => void;
  /** Called when the backend publishes a run-bound session identity. */
  onSession?: (session: SessionInfo) => void;
  /** When set, resume an existing session instead of starting a new one. */
  resume_session_id?: string;
}

/** Input for a single turn within an adapter session. */
export interface TurnInput {
  prompt: string;
}

/** Streaming turn event surface. */
export interface TurnEvent {
  kind: "item" | "turn" | "token_usage" | "approval" | "warning" | "error";
  payload: Record<string, unknown>;
}

/** Result returned after a single turn completes. */
export interface TurnResult extends AdapterResult {
  /** Backend-specific turn identifier, if the adapter exposes one. */
  backend_turn_id?: string;
}

/** Live handle for a started turn. */
export interface AdapterTurnHandle {
  readonly id: string;
  readonly events: AsyncIterable<TurnEvent>;
  wait(): Promise<TurnResult>;
  interrupt(): Promise<void>;
}

/** Run-scoped adapter session. */
export interface AdapterSession {
  readonly id: string;
  /** Effective capabilities for this concrete live session. */
  readonly capabilities: AdapterCapabilities;
  readonly backend_session: SessionInfo | undefined;
  startTurn(input: TurnInput): Promise<AdapterTurnHandle>;
  close(): Promise<void>;
}

/** Spawn options passed to the adapter. */
export interface AdapterSpawnOptions {
  /** The run identifier. */
  run_id: string;
  /** Working directory (worktree path). */
  cwd: string;
  /** The prompt to send to the backend. */
  prompt: string;
  /** Typed terminal output contract; forces a tool-isolated backend path. */
  output_capture?: RunOutputCapture;
  /** Backend-specific options. */
  backend_options?: BackendOptions;
  /** Runner-owned environment keys that must be absent from the provider child. */
  environment_redactions?: readonly string[];
  /** Replacement system prompt for backends that support it. */
  system_prompt?: string;
  /** Additional instructions to append to the backend's default system prompt. */
  append_system_prompt?: string;
  /** Callback for lifecycle events emitted during execution. */
  onEvent?: (event: LifecycleEvent) => void;
  /** Callback for sparse backend progress facts. */
  onActivity?: (activity: AgentActivityProgress) => void;
  /** Called when the backend publishes a run-bound session identity. */
  onSession?: (session: SessionInfo) => void;
  /** When set, resume an existing session instead of starting a new one. */
  resume_session_id?: string;
}

/**
 * Backend adapter contract.
 *
 * Each backend (Claude, Codex, future adapters) implements this interface.
 * The orchestrator calls `spawn()` to start execution and receives an
 * `AdapterResult` when it completes.
 */
export interface BackendAdapter {
  /** Human-readable adapter name (e.g., "claude", "codex"). */
  readonly name: string;
  /** Maximum capability envelope this adapter can offer. */
  readonly capabilities: AdapterCapabilities;

  /**
   * Start a run-scoped adapter session.
   *
   * During migration, adapters may still rely on `spawn()` and let the runner
   * wrap them in a compatibility session when this method is absent.
   */
  startSession?(opts: AdapterStartOptions): Promise<AdapterSession>;

  /**
   * Spawn the backend process and wait for completion.
   * Returns the execution result including exit code and captured output.
   *
   * This remains as a compatibility bridge while the session-and-turn contract
   * is rolled out across backends.
   */
  spawn?(opts: AdapterSpawnOptions): Promise<AdapterResult>;

  /**
   * Request graceful stop of a running backend process.
   * Called on cancellation or timeout. No-op if not running.
   */
  stop(sessionOrRunId: string): Promise<void>;
}
