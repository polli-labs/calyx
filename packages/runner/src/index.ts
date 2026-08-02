/**
 * @polli-labs/calyx-runner — Async runner runtime.
 *
 * P11B-1 contracts + P11B-2 runtime: types, schemas, lifecycle state machine,
 * failure classifier, dispatch gate, worktree manager, backend adapters,
 * orchestrator, and receipt emission.
 *
 * @see docs/architecture/async-runner-vnext.md
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

// ── Types ───────────────────────────────────────────────────────────
export type {
  RunState,
  PartialReason,
  ProviderConstraint,
  ProviderConstraintKind,
  ProviderConstraintSource,
  InfraErrorClassification,
  InfraErrorFailureLayer,
  InfraErrorFailureReason,
  FailureClass,
  FailureSource,
  ClassificationResult,
  StderrPattern,
  WorktreeSpec,
  JsonPrimitive,
  JsonValue,
  RunOutputCapture,
  RunOutputCaptureObservation,
  BackendReasoningEffort,
  CodexBackendReasoningEffort,
  ClaudeBackendReasoningEffort,
  BackendOptions,
  AgentActivityConfig,
  AgentActivityProgress,
  AgentActivityProgressSource,
  AgentProgressSignal,
  AgentProgressSignalStatus,
  AgentTerminalEvidence,
  AgentTerminalReason,
  AgentTerminalUsage,
  AgentRunnerSessionCheckpoint,
  RunHealthObservation,
  RunHealthSnapshot,
  NotificationsSpec,
  RunHandbackFlow,
  RunHandbackSpec,
  RunSpec,
  LifecycleEventType,
  LifecycleEvent,
  ArtifactLocation,
  ArtifactEntry,
  ArtifactManifest,
  DispatchCheck,
  DispatchReceipt,
  ReceiptTiming,
  ReceiptExit,
  ReceiptEnvironment,
  ReceiptNotifications,
  ReceiptBackendSession,
  ReceiptLogSummary,
  RunReceipt,
  SessionStopReason,
  SessionSummary,
  SessionTurnSummary,
  BackendProfile,
  HostConfig,
  RunnerConfig,
  ClassifierInput,
  BackendEvent,
} from "./types.js";

export {
  BACKEND_REASONING_EFFORTS,
  CLAUDE_BACKEND_REASONING_EFFORTS,
  CODEX_BACKEND_REASONING_EFFORTS,
  INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION,
  INFRA_ERROR_FAILURE_LAYERS,
  INFRA_ERROR_FAILURE_REASONS,
  PROVIDER_CONSTRAINT_KINDS,
  PROVIDER_CONSTRAINT_SCHEMA_VERSION,
  PROVIDER_CONSTRAINT_SOURCES,
  isClaudeBackendReasoningEffort,
  isCodexBackendReasoningEffort,
} from "./types.js";

// ── Schemas ─────────────────────────────────────────────────────────
export {
  runStateSchema,
  partialReasonSchema,
  providerConstraintSchema,
  infraErrorClassificationSchema,
  infraErrorFailureLayerSchema,
  infraErrorFailureReasonSchema,
  failureClassSchema,
  failureSourceSchema,
  classificationResultSchema,
  worktreeSpecSchema,
  runOutputCaptureSchema,
  backendOptionsSchema,
  notificationsSpecSchema,
  runSpecSchema,
  runSpecObjectSchema,
  lifecycleEventTypeSchema,
  lifecycleEventSchema,
  artifactLocationSchema,
  artifactEntrySchema,
  artifactManifestSchema,
  dispatchCheckSchema,
  dispatchReceiptSchema,
  RECEIPT_TIMING_TOLERANCE_MS,
  receiptTimingSchema,
  receiptExitSchema,
  receiptEnvironmentSchema,
  receiptNotificationsSchema,
  receiptLogSummarySchema,
  receiptBackendSessionSchema,
  agentTerminalEvidenceSchema,
  runReceiptSchema,
} from "./schemas.js";

export {
  detectProviderConstraint,
} from "./provider-constraint.js";
export type { ProviderConstraintObservation } from "./provider-constraint.js";

export {
  INFRA_ERROR_RULES,
  classifyInfraError,
  normalizeInfraErrorClassification,
} from "./infra-error.js";
export type {
  ClassifyInfraErrorContext,
  InfraErrorClassificationSite,
  InfraErrorRule,
} from "./infra-error.js";

// ── State machine ───────────────────────────────────────────────────
export {
  TERMINAL_STATES,
  SUCCESSFUL_STATES,
  VALID_TRANSITIONS,
  ALL_STATES,
  isValidTransition,
  assertTransition,
  isTerminal,
  isSuccessful,
  InvalidTransitionError,
} from "./state-machine.js";

// ── Patterns ────────────────────────────────────────────────────────
export {
  PATTERN_VERSION,
  STDERR_PATTERNS,
  EXIT_CODE_MAP,
  matchPatterns,
} from "./patterns.js";

// ── Classifier ──────────────────────────────────────────────────────
export { classify } from "./classifier.js";

// ── Exit classifier pipeline ────────────────────────────────────────
export {
  ClassifierPipeline,
  classifyRunOutcome,
  ExitZeroClassifier,
  SpawnErrorClassifier,
  SessionEvidenceClassifier,
  StderrPatternClassifier,
  DurationHeuristicClassifier,
  DefaultClassifier,
} from "./exit-classifier.js";
export type {
  ExitEvidence,
  RunOutcome,
  RunClassifier,
} from "./exit-classifier.js";

// ── Dispatch ────────────────────────────────────────────────────────
export { evaluateDispatch } from "./dispatch.js";

// ── Worktree ────────────────────────────────────────────────────────
export {
  acquireWorktree,
  releaseWorktree,
  resolveWorktreePath,
} from "./worktree.js";
export type {
  WorktreeContentionRetry,
  WorktreeLease,
  WorktreeLeaseAcquireInput,
  WorktreeLeaseAcquireResult,
  WorktreeLeaseManager,
  WorktreeLock,
  WorktreeAcquireResult,
  WorktreeManagerOptions,
} from "./worktree.js";

// ── Adapters ────────────────────────────────────────────────────────
export type {
  BackendAdapter,
  AdapterCapabilities,
  AdapterSession,
  AdapterResult,
  AdapterSpawnOptions,
  AdapterStartOptions,
  AdapterTurnHandle,
  SessionInfo,
  TurnEvent,
  TurnInput,
  TurnResult,
} from "./adapters/types.js";
export {
  buildManagedBackendPath,
  defaultSpawn,
  resolveManagedBackendExecutable,
} from "./adapters/spawn.js";
export type { SpawnFunction, SpawnOptions, SpawnResult } from "./adapters/spawn.js";
export { ClaudeAdapter } from "./adapters/claude.js";
export type { ClaudeAdapterOptions } from "./adapters/claude.js";
export { ClaudeStreamParser } from "./adapters/claude-stream.js";
export type {
  ClaudeStreamParserOptions,
  ClaudeStreamProjection,
} from "./adapters/claude-stream.js";
export {
  createAdapter,
  createBuiltInRuntimeAdapterRegistry,
  createRuntimeAdapterRegistry,
  registerBuiltInRuntimeAdapters,
  SUPPORTED_BACKENDS,
} from "./adapters/index.js";
export type {
  AdapterFactoryOptions,
  RuntimeAdapterFactory,
  RuntimeAdapterRegistry,
  SupportedBackend,
  CodexAppServerSteerInput,
  CodexAppServerSteerResult,
} from "./adapters/index.js";
export { createSpawnCompatibilitySession, ensureAdapterSession } from "./adapters/session-compat.js";

// ── Session discovery & parsing ──────────────────────────────────────
export {
  discoverClaudeSession,
  findLatestClaudeSession,
} from "./adapters/session-discovery.js";
export type {
  ClaudeSessionDiscoveryRequest,
  SessionDiscoveryFs,
  LatestSessionInfo,
} from "./adapters/session-discovery.js";
export {
  parseClaudeTerminalMessage,
  parseClaudeAssistantMessages,
  parseClaudeProviderConstraint,
} from "./adapters/session-parser.js";
export type { AssistantMessage, SessionParserFs } from "./adapters/session-parser.js";

// ── Receipt ─────────────────────────────────────────────────────────
export {
  evaluateArtifactGate,
  buildRunReceipt,
  writeReceipt,
  writeReceiptAtomically,
} from "./receipt.js";
export type { ReceiptBuildContext } from "./receipt.js";

// ── Trusted output capture ─────────────────────────────────────────
export { materializeRunOutputCapture, RunOutputCaptureError } from "./output-capture.js";
export type { RunOutputCaptureFailureKind } from "./output-capture.js";

// ── Orchestrator ────────────────────────────────────────────────────
export { executeRun } from "./run.js";
export type { RunDeps, RunResult } from "./run.js";
