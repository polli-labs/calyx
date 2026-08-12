import { readFileSync, watch as watchFs } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import { basename, dirname, extname, join, relative as relativePathFrom, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import YAML from "yaml";
import {
  CalyxSseProtocolError,
  createCalyxAdminClient,
  type CalyxAdminClient,
  type CalyxClientOptions,
  type CalyxIndeterminateReceipt,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
import {
  createCalyxClient,
  type CalyxClient,
} from "@polli-labs/calyx-client";
import {
  openClientRecoveryCustody,
  type ClientRecoveryCustody,
} from "./client-recovery-custody.js";
import { runSelfHealthCommand } from "./self-health";
import {
  startCalyxMcpActivityAttachmentsHttpServerV1,
  startCalyxMcpVaultContextHttpServerV1,
} from "./mcp-server";
import {
  ActivityAttachmentClientError,
  isActivityOwnerUnreachableError,
  materializeRemoteActivityAttachment,
  pullThroughArchiveActivityAttachmentResult,
  resolveRunServerAccess,
} from "./activity-attachment-client";
import {
  collectSelfDriftReports,
  formatSelfDriftTable,
  runSelfDriftFleetCommand,
  toSelfDriftJsonResults,
  type ExecFileAsync,
  type SelfDriftDependencies,
} from "./self-drift.js";
import {
  formatSelfFreshnessText,
  runSelfFreshnessCommand,
} from "./self-freshness.js";
import {
  formatSelfUpgradeOperationStatusText,
  runSelfUpgradeOperationStatus,
  serializeSelfUpgradeOperationStatusJson,
} from "./self-upgrade-operation-status.js";
import type { LinearGraphqlRequester } from "./linear-graphql-requester.js";
import {
  fleetTopologyOutput,
  formatFleetTopologyIdentity,
  resolveFleetTopologyForCommand,
  summarizeFleetRead,
  type FleetEffectiveState,
  type FleetReadSummary,
  type FleetTopologyOutput,
  type ResolveFleetTopology,
} from "./fleet-topology.js";

const __cliDir = dirname(fileURLToPath(import.meta.url));
const cliPkg = JSON.parse(readFileSync(join(__cliDir, "..", "package.json"), "utf-8")) as { version: string };
import {
  adoptInstructionSurfaces,
  agentMailAdapter,
  applyInstructionSurfaces,
  buildCalyxMcpActivityAttachmentsManifestV1,
  buildCalyxMcpVaultContextManifestV1,
  buildBundle,
  bumpToolVersion,
  compileFromFiles,
  CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE,
  CALYX_MCP_VAULT_CONTEXT_SURFACE,
  CTXPACK_ERROR_EXIT_CODES_V1,
  CTXPACK_PRIMITIVES_V1,
  compareTomlSemantics,
  compileAgentLaunch,
  createExecPlan,
  promoteExecPlan,
  discoverExtensions,
  docstoreAdapter,
  doctorPlugins,
  emitWrapperTelemetry,
  checkWrapperGuardrail,
  CALYX_ADMIN_RUN_LIST_MAX_ITEMS,
  CALYX_DAEMON_FEATURES,
  execNotify,
  ExtensionRunner,
  installBootstrap,
  loadExtension,
  getExecLogs,
  getExecReceipt,
  getExecStatus,
  fetchVaultArtifact,
  indexAgentsRegistry,
  indexKnowledgeRegistry,
  indexPromptsRegistry,
  indexSkillsRegistry,
  indexToolsRegistry,
  importCodexAutomationTasks,
  inspectInstructionStack,
  observeCodexAutomations,
  applyOracleBundleV1,
  DEFAULT_ORACLE_GEMINI_MODEL_V1,
  initOracleBundleV1,
  InstructionTraceLookupError,
  INTERFACE_MANIFEST_RECORDS,
  isTaskStatus,
  launchExecRun,
  linkKnowledgeArtifact,
  listPlugins,
  listInstructionSurfaces,
  listInstructionTargets,
  listTasks,
  PLUGIN_COMPONENT_KINDS,
  readHostsTruth,
  reconcileInstructionSurfaces,
  renderCodexAutomationTask,
  resolveStatePaths,
  renderInstructionSurface,
  renderInstructionsFromFiles,
  resolveSourcePath,
  requireSourcePath,
  showAgentDefinition,
  putVaultArtifact,
  planRuntimeConfig,
  planOracleBundleV1,
  planOracleRunV1,
  renderPromptTemplate,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias,
  resolveConsumerApiCredentialVerifiers,
  resolveConsumerApiClientToken,
  resolveConsumerApiServerHostAlias,
  assertStartupContractConsumerApiAmbientIsolation,
  assertStartupContractEnvPresent,
  resolveRepoForRun,
  addVaultFootnote,
  appendVaultJournalEntry,
  gcVaultFootnotes,
  getVaultJournalEntry,
  getVaultFootnotes,
  getVaultFrontmatter,
  getVaultSection,
  getVaultTableOfContents,
  lintVaultFootnotes,
  listVaultJournalEntries,
  listVaultFootnotes,
  relatedVaultArtifacts,
  searchVault,
  getVaultStatus,
  queryVaultFrontmatter,
  stampVaultArtifact,
  doctorOracleBundleV1,
  synthesizeOracleResponsesV1,
  runContextFixtureCorpusFromFileV1,
  runCtxpackContractV1,
  runDoctor,
  applyRuntimeConfig,
  ACTIVITY_MARK_KINDS,
  ACTIVITY_MARK_CURSOR_MAX_CHARS,
  ACTIVITY_MARK_LIST_MAX_LIMIT,
  ACTIVITY_MARK_TARGET_ID_MAX_CHARS,
  ACTIVITY_MARK_TARGET_KINDS,
  RuntimeConfigApplyInProgressError,
  applyStateMigrations,
  createInterimWorkloadAdmissionReconciler,
  ackMonitorWake,
  ackMessage,
  cancelMonitor,
  claimMonitorWakes,
  checkMessageSchema,
  checkMonitorSchema,
  checkTaskSchema,
  claimDirectedMessages,
  countPendingMessages,
  createMessage,
  drainMessageReceiptMirrors,
  enqueueMessageOutbox,
  enqueueMessageReceiptMirror,
  listMessageDeliveries,
  listThreadMessages,
  createMonitor,
  createMonitorDeliveryPolicy,
  createTaskRun,
  defaultMonitorDeliveryBinding,
  defaultRunnerSupervisionDeliveryBinding,
  MESSAGE_CLAIM_TTL_MS,
  MESSAGE_OUTBOX_STATUSES,
  MESSAGE_URGENCIES,
  MONITOR_DELIVERY_SCHEMA_VERSION,
  peekScopeMessages,
  projectMessageOutboxAt,
  findTaskInstall,
  installTask,
  launchPolicyFromTaskManifest,
  listFleetConvergenceRows,
  listMonitorDeliveries,
  listMonitorHistory,
  listMonitorWakes,
  listMonitors,
  listTaskHistory,
  listTaskInstalls,
  listTaskRuns,
  openStateStore,
  readMessage,
  readMessageOutbox,
  readMessageReceiptMirror,
  executionCapableMessageAddressKind,
  readMonitor,
  readMonitorWake,
  resolveMessageAddress,
  SESSION_INGRESS_BACKENDS,
  sessionWakeDeliveryId,
  reconcileTaskInstall,
  recordTaskInstallManualRun,
  runnerSupervisionPredicate,
  setTaskInstallStatus,
  setTaskRunReceiptPath,
  checkSkillContentSchema,
  createSkillProposalApi,
  describeStatePaths,
  listSkillProposalsApi,
  materializeSkillProposal,
  normalizeName,
  migrateSkill,
  migrateAllInternalSkills,
  MigrateError,
  rematerializeSkill,
  scanSkillContent,
  scanSkillPayload,
  setPinned,
  consolidateSkillContent,
  ConsolidationAborted,
  tombstoneSkillContent,
  upsertSkillContent,
  readSkillContent,
  MEMORY_CATEGORIES,
  MemoryReviewAborted,
  checkMemoryContentSchema,
  listMemoryContent,
  readMemoryContent,
  searchMemoryContent,
  setMemoryReviewStatus,
  tombstoneMemoryContent,
  upsertMemoryContent,
  planStateMigrations,
  reportStateHealth,
  reviewSkillProposal,
  runStateDoctor,
  listEventLogQuarantineRecords,
  rebuildEventLogProjection,
  resolveEventJournalPath,
  showSkillProposal,
  SkillProposalError,
  STATE_DOCTOR_DOMAINS,
  STATE_DOCTOR_NOT_APPLICABLE_DOMAINS,
  StateDriverError,
  validateSkillProposal,
  SKILL_PROPOSAL_STATUSES,
  SKILL_PROPOSAL_TARGETS,
  searchKnowledgeRegistry,
  showConfig,
  showPlugin,
  showSkill,
  SkillShowLookupError,
  fetchSkillUsage,
  resolveLokiEndpoint,
  loadSkillsRegistryLoose,
  computeCuratorReport,
  summarizeCuratorStatus,
  applyCuratorReport,
  rollbackCuratorPass,
  deriveLatestCuratorPass,
  gatherCuratorDbSkills,
  SKILL_USAGE_CLAUDE_ONLY_NOTE,
  showInstructionSurface,
  showTask,
  appendTaskRunJsonlReceipt,
  syncPromptsRegistry,
  syncSkillsRegistry,
  OrchestrationLedgerSink,
  RunIndexProjection,
  syncToolsRegistry,
  TaskLookupError,
  TaskRenderError,
  tracePluginComponent,
  traceInstructionTarget,
  validateAgentsRegistry,
  validateExecStore,
  validateKnowledgeRegistry,
  validatePromptsRegistry,
  validateSkillsRegistry,
  validateTasks,
  validateToolsRegistry,
  verifyFleet,
  verifyInstructionSurface,
  verifyInstructionsFromFiles,
  verifyRuntimeConfig,
  WRAPPER_REGISTRY,
  getDeferredWrapperMessage,
  getDeprecatedWrapperMessage,
  getRetiredWrapperMessage,
  getDaemonCompatibilityRefusal,
  requiredFeaturesForIntent,
  toCalyxAdminReconcileResult,
  writeOracleRunResultV1,
  LEASE_RESOURCE_KINDS,
  checkLeaseSchema,
  acquireLease,
  listLeases,
  parseLeaseKey,
  parseActivityMarkTargetId,
  releaseLease,
  renewLease,
  stealLease,
  validateApiAssertedActor,
  validateActivityMarkId,
  validateActivityMarkReason,
  isCanonicalApiTimestamp,
} from "@polli-labs/calyx-core";
import type {
  AgentLaunchBackend,
  AgentMailVerb,
  CalyxAdminHealth as CalyxDaemonHealth,
  CalyxAdminReconcileResult,
  CalyxDaemonFeature,
  DocstoreAdapterVerb,
  DomainSyncAction,
  DomainValidationIssue,
  ExecNotifyChannel,
  ExtensionDiagnostic,
  InstructionMutationChange,
  InstructionMutationPlannedChange,
  InstructionReconcileFinding,
  InstructionStackHarness,
  InstructionStackResult,
  InstructionSurfaceTraceSource,
  InstructionTemplateTraceSource,
  InstructionTraceResult,
  InstructionsSurfaceMutationResult,
  InstructionsShowResult,
  InstructionsSurfaceReconcileResult,
  InterfaceMutationClass,
  KnowledgeArtifactKind,
  KnowledgeExecPlanKind,
  KnowledgeExecPlanRunnerHarness,
  KnowledgeExecPlanRunnerMode,
  KnowledgeExecPlanState,
  HostsTruthFile,
  FileModeReport,
  MigrationApplyResult,
  MigrationPlan,
  MonitorCreateProvenance,
  MonitorDeliveryAdapterBindingV1,
  MonitorDeliveryAdapterV1,
  MonitorDeliveryBindingV1,
  MonitorDeliveryMaterialityKindV1,
  MonitorDeliveryRow,
  MonitorRearmPolicy,
  MonitorRow,
  MonitorWakeRow,
  MonitorWakeStatus,
  MemoryCategory,
  MemoryContentRow,
  MemoryReviewStatus,
  MessageDeliveryRow,
  MessageRow,
  MessageUrgency,
  ResolvedMessageAddress,
  TaskFinding,
  TaskInstallStatus,
  TaskLaunchMode,
  TaskLaunchPolicyV1,
  MigrateResult,
  MigrateAllInternalResult,
  RematerializeResult,
  SkillProposalCreateInput,
  SkillProposalKind,
  SkillProposalListInput,
  SkillProposalStatus,
  SkillProposalTarget,
  SkillScanFinding,
  StateDoctorReport,
  StateHealthReport,
  FleetConvergenceRow,
  FleetConvergenceVerdict,
  OracleRunPlanV1,
  OracleRunUsageV1,
  PluginComponentKind,
  PluginHarnessSelector,
  PluginObservation,
  PluginsInventoryOptions,
  PromptBackend,
  RuntimeConfigComponent,
  RuntimeConfigOptions,
  RuntimeConfigResult,
  TaskStatus,
  SkillsShowResult,
  SkillUsageResult,
  CuratorApplyReceipt,
  CuratorReport,
  CuratorStatusReport,
  SourceDomain,
  SyncBackend,
  ToolsSyncOptions,
  VaultFetchFootnotesMode,
  VaultJournalEntryKind,
  VaultJournalAppendResult,
  VaultJournalSuggestedContract,
  VaultPutInputType,
  VaultPutResult,
  VaultRelatedRelation,
  VaultSearchMode,
  VaultStampResult,
  LeaseAcquireResult,
  LeaseReleaseResult,
  LeaseRenewResult,
  LeaseResourceKind,
  LeaseRow,
  LeaseStealResult,
  ActivityMarkKind,
  ActivityMarkTargetKind,
} from "@polli-labs/calyx-core";
import {
  type CalyxDeliveredStreamEvent,
  type CalyxStreamEventType,
  createTrackerRegistry,
  DaemonService,
  defaultDaemonsRoot,
  isCalyxControlEvent,
  isCalyxDeliveredStreamEvent,
  isCalyxMonitorEvent,
  isCalyxStreamProjectionGapEvent,
  openDetachedLogFiles,
  RUN_ID_PATTERN_SOURCE,
  RunService,
  routeSessionWake,
  isLocalRunTarget,
  ActivityAttachmentError,
  defaultAttachmentCacheDir,
} from "@polli-labs/calyx-run-service";
import type {
  ActivityAttachmentRecord,
  ActivityAttachmentBytesResult,
  ActivityAttachmentRecordResult,
  ActivityAttachmentsResult,
  ActivityAttachmentsSelectorInput,
  ActivityEventSelectorInput,
  ActivityEventsResult,
  ActivityMessageRole,
  ActivityMessageSelectorInput,
  ActivityMessagesResult,
  ActivityTextResult,
  ActivityTextSelectorInput,
  ActivityTurnRoleFilter,
  ActivityTurnSelectorInput,
  ActivityTurnsResult,
  ActivityVisibilityTier,
  DaemonActivityResolver,
  DaemonEvent,
  DaemonPlanResult,
  DaemonRecord,
  DaemonStartResult,
  DaemonTickResult,
  ExecutionKernelId,
  InteractiveSessionBackend,
  InteractiveSessionEventRole,
  InteractiveSessionInspectResult,
  RunActivityEntry,
  RunIntent,
  RunLaunchResult,
  RunCancellationResult,
  InfraErrorCensusAuthorityAudit,
  RunListEntry,
  RunLogEntry,
  RunLogResult,
  RunObservationResult,
  RunRecord,
  RunServiceOptions,
  TrackerRegistry,
  SessionWakeRouteDependencies,
  SessionWakeRouteResult,
  SessionWakeDeliverRequestV1,
} from "@polli-labs/calyx-run-service";
import {
  ACTIVITY_MESSAGE_ROLES,
  ACTIVITY_TURN_ROLE_FILTERS,
  ACTIVITY_VISIBILITY_TIERS,
  ActivityIdAmbiguousError,
  ActivityIdMalformedError,
  ActivityIdNotFoundError,
  ActivityMessageSelectorError,
  ActivityRunMissingMetadataError,
  ActivityTurnSelectorError,
  describeMalformedActivityLocator,
  formatMalformedActivityLocator,
} from "@polli-labs/calyx-run-service";
import {
  detectTailscaleHost,
  loadServerBuildInfo,
  startRunServer,
  validateOperationRequest,
} from "@polli-labs/calyx-server";
import type {
  AdminRunLaunchReceipt,
  AdminRunRecord,
  RunLaunchRequest,
} from "@polli-labs/calyx-server";
import {
  ClassifierPipeline,
  CLAUDE_BACKEND_REASONING_EFFORTS,
  CODEX_BACKEND_REASONING_EFFORTS,
  createRuntimeAdapterRegistry,
  DefaultClassifier,
  DurationHeuristicClassifier,
  ExitZeroClassifier,
  findLatestClaudeSession,
  INFRA_ERROR_FAILURE_LAYERS,
  INFRA_ERROR_FAILURE_REASONS,
  isSuccessful,
  isTerminal,
  parseClaudeAssistantMessages,
  registerBuiltInRuntimeAdapters,
  SessionEvidenceClassifier,
  SpawnErrorClassifier,
  StderrPatternClassifier,
} from "@polli-labs/calyx-runner";
import type {
  AgentTerminalEvidence,
  AssistantMessage,
  BackendReasoningEffort,
  InfraErrorClassification,
  InfraErrorFailureLayer,
  InfraErrorFailureReason,
  LatestSessionInfo,
  PartialReason,
  ProviderConstraint,
  RuntimeAdapterRegistry,
  RunState,
  SupportedBackend,
} from "@polli-labs/calyx-runner";
import {
  createCodexRuntimeAdapterFactory,
  findLatestCodexSession,
  parseCodexAssistantMessages,
} from "calyx-ext-codex";
import { createLinearTrackerFactory } from "calyx-ext-linear";
import { formatSelfNudgeResult, runSelfNudge } from "./commands/self-nudge";
import {
  formatSelfUpgradePlan,
  runSelfUpgrade,
  runSelfUpgradeTargetEntry,
  toSelfUpgradeFailureOutput,
  type SelfUpgradeProjectionIssue,
} from "./commands/self-upgrade";
import { runSelfUpgradeFleet } from "./commands/self-upgrade-fleet.js";
import {
  encodeSelfUpgradeProgressTransition,
  toSelfUpgradeProgressTransition,
} from "./self-upgrade-progress.js";
import { createFailOpenProjectionWriter } from "./self-upgrade-stream-io.js";
import { createProductionToolchainCheckForHost } from "./self-upgrade-toolchain.js";

interface CompileCommandOptions {
  fleet: string;
  hostsDir: string;
  host: string;
  out?: string;
  mode: "strict" | "advisory";
  write?: boolean;
  parity?: string;
  json?: boolean;
}

interface InstructionsBaseCommandOptions {
  surfacesDir?: string;
  surface?: string;
  fleet?: string;
  hostsDir?: string;
  host?: string;
  all?: boolean;
  template?: string;
  partialsDir?: string;
  outDir?: string;
  json?: boolean;
}

interface SelfDriftCommandOptions {
  host?: string;
  fleet?: boolean;
  against?: string;
  json?: boolean;
}

interface SelfFreshnessCommandOptions {
  host?: string;
  fleet?: boolean;
  against?: string;
  json?: boolean;
}

interface SelfNudgeCommandOptions {
  fleet?: boolean;
  project?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface InstructionsVerifyCommandOptions extends InstructionsBaseCommandOptions {
  expectedDir?: string;
}

interface InstructionsListCommandOptions {
  surfacesDir: string;
  includeArchived?: boolean;
  json?: boolean;
}

interface InstructionsShowCommandOptions {
  surfacesDir: string;
  json?: boolean;
}

interface InstructionsTraceCommandOptions {
  surfacesDir?: string;
  agentsInfraRoot?: string;
  host?: string;
  includeArchived?: boolean;
  includeVariables?: boolean;
  includePartialContents?: boolean;
  json?: boolean;
}

interface InstructionsStackCommandOptions {
  cwd: string;
  harness: InstructionStackHarness;
  host: string;
  agentsInfraRoot?: string;
  json?: boolean;
}

interface InstructionsTargetsCommandOptions extends InstructionsListCommandOptions {
  surface?: string;
}

interface InstructionsReconcileCommandOptions extends InstructionsTargetsCommandOptions {
  host: string;
  repoRoot?: string;
}

interface InstructionsMutateCommandOptions extends InstructionsTargetsCommandOptions {
  host: string;
  repoRoot?: string;
  dryRun?: boolean;
  reviewedOverwrite?: boolean;
  backupDir?: string;
}

interface SkillsIndexCommandOptions {
  registry?: string;
  includeArchived?: boolean;
  includeRetired?: boolean;
  excludeDeprecated?: boolean;
  json?: boolean;
}

interface SkillsShowCommandOptions {
  registry?: string;
  agentsInfraRoot?: string;
  check?: boolean;
  showInstallHashes?: boolean;
  json?: boolean;
}

interface SkillsSyncCommandOptions extends SkillsIndexCommandOptions {
  backend: string;
  apply?: boolean;
  pruneDeprecated?: boolean;
  nativeCodexSkills?: boolean;
}

interface SkillsValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface SkillsUsageCommandOptions {
  since?: string;
  limit?: number;
  endpoint?: string;
  json?: boolean;
}

interface SkillsCuratorStatusCommandOptions {
  registry?: string;
  since?: string;
  endpoint?: string;
  json?: boolean;
}

interface SkillsCuratorRunCommandOptions {
  registry?: string;
  since?: string;
  endpoint?: string;
  limit?: number;
  dryRun?: boolean;
  apply?: boolean;
  confirm?: boolean;
  json?: boolean;
}

interface PluginsBaseCommandOptions {
  harness?: string;
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  includeCatalog?: boolean;
  json?: boolean;
}

interface PluginsTraceCommandOptions extends PluginsBaseCommandOptions {
  kind?: string;
}

interface PluginsDoctorCommandOptions extends PluginsBaseCommandOptions {
  check?: boolean;
}

interface ToolsIndexCommandOptions {
  registry?: string;
  json?: boolean;
}

interface ToolsSyncCommandOptions extends ToolsIndexCommandOptions {
  host?: string;
  all?: boolean;
  apply?: boolean;
}

interface ToolsValidateCommandOptions extends ToolsIndexCommandOptions {
  strict?: boolean;
}

interface PromptsIndexCommandOptions {
  registry?: string;
  json?: boolean;
}

interface PromptsSyncCommandOptions extends PromptsIndexCommandOptions {
  backend: string;
  apply?: boolean;
}

interface PromptsValidateCommandOptions extends PromptsIndexCommandOptions {
  strict?: boolean;
}

interface PromptsRenderCommandOptions extends PromptsIndexCommandOptions {
  prompt: string;
  var?: string[];
  varsFile?: string;
}

interface TasksBaseCommandOptions {
  tasksDir?: string;
  json?: boolean;
}

interface TasksValidateCommandOptions extends TasksBaseCommandOptions {
  strict?: boolean;
}

interface TasksListCommandOptions extends TasksBaseCommandOptions {
  includePaused?: boolean;
  includeRetired?: boolean;
  status?: string[];
}

type TasksShowCommandOptions = TasksBaseCommandOptions;

interface TasksInstallCommandOptions extends TasksBaseCommandOptions {
  host?: string;
  status?: string;
  mode?: string;
  installedBy?: string;
}

interface TasksRunCommandOptions extends TasksBaseCommandOptions {
  host?: string;
  runId?: string;
  runsRoot?: string;
  worktreePath?: string;
  dryRun?: boolean;
  foreground?: boolean;
}

interface TasksPauseResumeCommandOptions {
  host?: string;
  actor?: string;
  json?: boolean;
}

interface TasksReconcileCommandOptions extends TasksBaseCommandOptions {
  host?: string;
  limit?: string;
  apply?: boolean;
}

interface TasksHistoryCommandOptions {
  limit?: string;
  json?: boolean;
}

interface TasksDoctorCommandOptions {
  codexHome?: string;
  codexDb?: string;
  tasksDir?: string;
  governance?: string;
  calyxStateDb?: string;
  json?: boolean;
}

type TasksCodexObserveCommandOptions = TasksDoctorCommandOptions;

interface TasksCodexImportCommandOptions {
  codexHome: string;
  outDir: string;
  id?: string;
  json?: boolean;
}

interface TasksCodexRenderCommandOptions extends TasksBaseCommandOptions {
  outDir: string;
  host?: string;
}

interface AgentsListCommandOptions {
  registry?: string;
  includeBlocked?: boolean;
  includeArchived?: boolean;
  includeRetired?: boolean;
  excludeDeprecated?: boolean;
  json?: boolean;
}

interface AgentsShowCommandOptions {
  registry?: string;
  json?: boolean;
}

interface AgentsValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface KnowledgeIndexCommandOptions {
  registry?: string;
  kind?: string;
  json?: boolean;
}

interface KnowledgeSearchCommandOptions {
  registry?: string;
  query: string;
  kind?: string;
  tags?: string;
  json?: boolean;
}

interface KnowledgeLinkCommandOptions {
  registry?: string;
  artifact: string;
  issue: string;
  apply?: boolean;
  json?: boolean;
}

interface KnowledgeValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface ExecLaunchCommandOptions {
  store?: string;
  command: string;
  apply?: boolean;
  json?: boolean;
}

interface ExecStatusCommandOptions {
  store?: string;
  runId: string;
  json?: boolean;
}

interface ExecLogsCommandOptions {
  store?: string;
  runId: string;
  level?: string;
  tail?: string;
  json?: boolean;
}

interface ExecReceiptCommandOptions {
  store?: string;
  runId: string;
  json?: boolean;
}

interface ExecValidateCommandOptions {
  store?: string;
  strict?: boolean;
  json?: boolean;
}

interface ReviewRequesterIdentity {
  activity_id: string;
  backend: AgentLaunchBackend;
  session_id: string;
  resolution_source: string;
  indexed: boolean;
  host?: string;
  warnings: Array<{ code: string; message: string }>;
}

type ReviewBackendSelectionStrategy = "prefer_different_from_requester" | "first_available";

interface ReviewHandbackBinding {
  status: "bound" | "disabled" | "unavailable";
  handback_status: "bound" | "disabled" | "unavailable";
  flow: "calyx.msg/v1" | "receipt-only/v1";
  ack_required: true;
  thread_key: string;
  body_contract: string;
  idempotency_key?: string;
  address?: string;
  recipient_host?: string;
  reviewer_reply_address?: string;
  manual_relay_required?: boolean;
  unavailable_reason?: string;
  unavailable_detail?: string;
}

interface ReviewConductMetadata {
  command: "review";
  agent_id: string;
  target: ReviewTargetSpec;
  requester?: ReviewRequesterIdentity;
  backend_selection: {
    strategy: ReviewBackendSelectionStrategy;
    requester_backend?: AgentLaunchBackend;
    override: boolean;
  };
  handback: ReviewHandbackBinding;
  source: "calyx review";
}

interface RunLaunchCommandOptions {
  replayRequest?: string;
  runId?: string;
  idempotencyKey?: string;
  kernel?: string;
  issue?: string;
  host: string;
  backend?: string;
  requesterBackend?: AgentLaunchBackend;
  agent?: string;
  agentRegistry?: string;
  var?: string[];
  profile?: string;
  repo?: string;
  prompt?: string;
  promptFile?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  template?: string;
  templateVar?: string[];
  execplanRef?: string;
  requireExecplan?: boolean;
  pullExecplan?: boolean;
  worktreeBase?: string;
  worktreeMode?: string;
  worktreePath?: string;
  worktreeRef?: string;
  worktreeResetOnReuse?: boolean;
  worktreeBranch?: string;
  stealLock?: boolean;
  lockTimeoutMs?: string;
  requiredArtifact?: string[];
  artifactRoot?: string[];
  argv?: string[];
  cwd?: string;
  stopGraceMs?: string;
  healthSource?: string[];
  healthPath?: string[];
  healthStaleAfterMs?: string;
  healthPollIntervalMs?: string;
  agentActivityStaleAfterMs?: string;
  agentActivityPollIntervalMs?: string;
  agentInactivityTimeoutMs?: string;
  agentInactivityStopGraceMs?: string;
  allowedTool?: string[];
  dangerouslySkipPermissions?: boolean;
  model?: string;
  reasoningEffort?: string;
  maxThreads?: string;
  maxTurns?: string;
  env?: string[];
  ntfyTopic?: string;
  agentMailThread?: string;
  handback?: RunIntent["handback"];
  foreground?: boolean;
  runsRoot?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
  reviewConduct?: ReviewConductMetadata;
  expectedTargetHeadSha?: string;
}

interface ReviewCommandOptions {
  adversarial?: boolean;
  scope?: string;
  base?: string;
  focus?: string[];
  backend?: string;
  host: string;
  handback?: boolean;
  repo?: string;
  worktreePath?: string;
  pr?: string;
  branch?: string;
  sha?: string;
  issue?: string;
  dryRun?: boolean;
  agentRegistry?: string;
  runsRoot?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface ReviewHandbackAvailability {
  available: boolean;
  reason?: string;
  detail?: string;
}

type ReviewScope = "pr" | "branch";

type ReviewTargetSpec =
  | {
      scope: "pr";
      repo: string;
      worktreePath?: string;
      pr: number;
      expectedHeadSha?: string;
      base?: string;
      issue?: string;
      focus: string[];
    }
  | {
      scope: "branch";
      repo: string;
      worktreePath?: string;
      branch: string;
      base?: string;
      issue?: string;
      focus: string[];
    };

interface PlannedRunLaunch {
  intent: RunIntent;
  service: RunServiceLike;
}

interface RemoteAcceptedRunLaunchResult {
  schema_version: "calyx.remote-run-launch/v1";
  status: "accepted";
  run_id: string;
  mode: "remote";
  server_url: string;
  operation: {
    route: string;
    events_route: string;
    receipt_route: string;
  };
  observation:
    | { status: "available"; state: RunRecord["state"]; record: RunRecord }
    | { status: "unavailable"; error: string };
}

type CliRunLaunchResult = RunLaunchResult | RemoteAcceptedRunLaunchResult;

function isRemoteAcceptedRunLaunchResult(result: CliRunLaunchResult): result is RemoteAcceptedRunLaunchResult {
  return "status" in result && result.status === "accepted";
}

interface LaunchedRunWithIntent {
  intent: RunIntent;
  result: CliRunLaunchResult;
}

interface RunResumeCommandOptions {
  sessionId?: string;
  prompt: string;
  last?: boolean;
  runId?: string;
  idempotencyKey?: string;
  host: string;
  backend?: string;
  profile?: string;
  worktreePath?: string;
  dangerouslySkipPermissions?: boolean;
  foreground?: boolean;
  runsRoot?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface RunReadCommandOptions {
  runId?: string;
  host?: string;
  runsRoot?: string;
  serverUrl?: string;
  authToken?: string;
  details?: boolean;
  json?: boolean;
  signal?: AbortSignal;
}

interface RunPsCommandOptions {
  runsRoot?: string;
  host?: string;
  includeInteractive?: boolean;
  agentKind?: string;
  sinceHours?: string;
  limit?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface RunLogsCommandOptions extends RunReadCommandOptions {
  tail?: string;
  full?: boolean;
}

interface RunActivityCommandOptions {
  host?: string;
  activityId: string;
  around?: string;
  tail?: string;
  context?: string;
  includeTools?: boolean;
  format?: string;
  runsRoot?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface RunReconcileCommandOptions {
  runsRoot?: string;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface RunTerminalAuthorityAuditCommandOptions {
  runsRoot?: string;
  json?: boolean;
}

interface RunSubscribeCommandOptions {
  after?: string;
  runId?: string;
  eventType?: string;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  format?: string;
  signal?: AbortSignal;
}

interface RunAwaitCommandOptions extends RunReadCommandOptions {
  timeout?: string;
  requireSuccess?: boolean;
}

interface RunServeCommandOptions {
  host?: string;
  port?: string;
  runsRoot?: string;
  worktreeBase?: string;
  monitorIntervalMs?: string;
  messageOutboxIntervalMs?: string;
  activityTailerIntervalMs?: string;
  activityTailer?: boolean;
  json?: boolean;
}

interface RunExecuteStoredCommandOptions {
  runId: string;
  runsRoot?: string;
}

interface MonitorCreateCommandOptions {
  preset?: string;
  run?: string;
  owner?: string;
  createdBy?: string;
  provenance?: string;
  assignedHost?: string;
  rearm?: string;
  staleAfterMs?: string;
  deliver?: string[];
  defaultDeliveries?: boolean;
  idempotencyKey?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorListCommandOptions {
  status?: string;
  run?: string;
  assignedHost?: string;
  limit?: string;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorShowCommandOptions {
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorCancelCommandOptions {
  reason?: string;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorHistoryCommandOptions {
  limit?: string;
  json?: boolean;
}

interface MonitorInboxCommandOptions {
  status?: string;
  monitor?: string;
  wakeId?: string;
  limit?: string;
  claimedBy?: string;
  peek?: boolean;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorAckCommandOptions {
  ackedBy?: string;
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MonitorRemoteCreateRequest {
  schema_version: "calyx.monitor-create-request/v1";
  idempotency_key: string;
  owner: string;
  created_by: string;
  create_provenance: MonitorCreateProvenance;
  assigned_host: string;
  source_run_id: string;
  preset: "runner-supervision";
  stale_after_ms: number;
  rearm_policy: MonitorRearmPolicy;
  delivery?: MonitorDeliveryBindingV1 | Record<string, unknown>;
}

interface MonitorCreatePayload {
  schema_version: "calyx.monitor-create/v1";
  owner_host?: string;
  storage?: { host: string; inspect_command: string };
  note?: string;
  monitor: MonitorRow;
}

interface MonitorListPayload {
  schema_version: "calyx.monitor-list/v1";
  owner_host?: string;
  count: number;
  monitors: MonitorRow[];
}

interface MonitorShowPayload {
  schema_version: "calyx.monitor-show/v1";
  owner_host?: string;
  monitor: MonitorRow;
  delivery_state: ReturnType<typeof monitorDeliveryState>;
}

interface MonitorCancelPayload {
  schema_version: "calyx.monitor-cancel/v1";
  owner_host?: string;
  monitor: MonitorRow;
}

interface MonitorInboxPayload {
  schema_version: "calyx.monitor-inbox/v1";
  owner_host?: string;
  count: number;
  wakes: MonitorWakeRow[];
  delivery_state: ReturnType<typeof monitorDeliveryState>;
}

interface MonitorAckPayload {
  schema_version: "calyx.monitor-ack/v1";
  owner_host?: string;
  changed: boolean;
  wake: MonitorWakeRow;
}

interface MonitorDoctorCommandOptions {
  json?: boolean;
}

interface MsgSendCommandOptions {
  replayRequest?: string;
  to?: string;
  toActive?: string;
  subject?: string;
  body?: string;
  bodyFile?: string;
  sender?: string;
  thread?: string;
  replyTo?: string;
  idempotencyKey?: string;
  urgency?: string;
  ackRequired?: boolean;
  expiresAt?: string;
  ttlMs?: string;
  host?: string;
  coordinatorHost?: string;
  serverUrl?: string;
  authToken?: string;
  spoolOnly?: boolean;
  wake?: boolean;
  json?: boolean;
}

interface MsgReplyCommandOptions {
  to?: string;
  subject?: string;
  body?: string;
  bodyFile?: string;
  sender?: string;
  thread?: string;
  idempotencyKey?: string;
  urgency?: string;
  ackRequired?: boolean;
  expiresAt?: string;
  ttlMs?: string;
  host?: string;
  coordinatorHost?: string;
  serverUrl?: string;
  authToken?: string;
  spoolOnly?: boolean;
  json?: boolean;
}

interface MsgInboxCommandOptions {
  for?: string;
  scope?: string;
  peek?: boolean;
  claimedBy?: string;
  claimTtlMs?: string;
  limit?: string;
  host?: string;
  coordinatorHost?: string;
  json?: boolean;
}

interface MsgAckCommandOptions {
  ackedBy?: string;
  json?: boolean;
}

interface MsgThreadCommandOptions {
  limit?: string;
  json?: boolean;
}

interface MsgOperationCommandOptions {
  host?: string;
  serverUrl?: string;
  authToken?: string;
  json?: boolean;
}

interface MsgDoctorCommandOptions {
  json?: boolean;
}

interface RunDaemonBaseCommandOptions {
  daemonId?: string;
  workflow?: string;
  project?: string;
  host?: string;
  agentsInfraRoot?: string;
  runsRoot?: string;
  daemonsRoot?: string;
  json?: boolean;
}

interface RunDaemonStartCommandOptions extends RunDaemonBaseCommandOptions {
  workflow?: string;
  foreground?: boolean;
}

interface RunDaemonStatusCommandOptions extends RunDaemonBaseCommandOptions {
  daemonId: string;
}

interface RunDaemonLogsCommandOptions extends RunDaemonBaseCommandOptions {
  daemonId: string;
  tail?: string;
}

interface RunDaemonStopCommandOptions extends RunDaemonBaseCommandOptions {
  daemonId: string;
}

interface RunDaemonTickCommandOptions extends RunDaemonBaseCommandOptions {
  workflow?: string;
}

interface RunDaemonPlanCommandOptions extends RunDaemonBaseCommandOptions {
  workflow?: string;
}

interface ConfigShowCommandOptions {
  json?: boolean;
}

interface VaultPutCommandOptions {
  type?: VaultPutInputType;
  title?: string;
  daily?: boolean;
  issue?: string;
  project?: string;
  workstream?: string;
  author?: string;
  assignee?: string;
  updated?: string;
  updatedBy?: string;
  status?: string;
  stdin?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface VaultSearchCommandOptions {
  type?: VaultPutInputType;
  mode?: VaultSearchMode;
  limit?: string;
  issue?: boolean;
  files?: boolean;
  json?: boolean;
}

interface VaultFetchCommandOptions {
  maxBytes?: string;
  withFrontmatter?: boolean;
  withLinks?: boolean;
  footnotes?: string;
  json?: boolean;
}

interface VaultRelatedCommandOptions {
  relation?: VaultRelatedRelation;
  depth?: string;
  limit?: string;
  withFrontmatter?: boolean;
  json?: boolean;
}

interface VaultTocCommandOptions {
  vaultPath?: string;
  json?: boolean;
}

interface VaultSectionGetCommandOptions {
  heading?: string;
  maxChars?: string;
  vaultPath?: string;
  json?: boolean;
}

interface VaultFrontmatterGetCommandOptions {
  vaultPath?: string;
  json?: boolean;
}

interface VaultFrontmatterQueryCommandOptions {
  type?: string;
  where?: string;
  limit?: string;
  vaultPath?: string;
  json?: boolean;
}

interface VaultStatusCommandOptions {
  json?: boolean;
}

interface VaultJournalEntriesCommandOptions {
  section?: string;
  kind?: string;
  last?: string;
  vaultPath?: string;
  json?: boolean;
}

interface VaultJournalGetCommandOptions {
  section?: string;
  range?: string;
  maxChars?: string;
  vaultPath?: string;
  json?: boolean;
}

interface VaultJournalAppendCommandOptions {
  title?: string;
  date?: string;
  body?: string;
  bodyStdin?: boolean;
  field?: string[];
  section?: string;
  dryRun?: boolean;
  vaultPath?: string;
  json?: boolean;
}

interface VaultFootnotesListCommandOptions {
  vaultPath?: string;
  json?: boolean;
}

interface VaultFootnotesGetCommandOptions {
  keys?: string;
  range?: string;
  maxChars?: string;
  vaultPath?: string;
  json?: boolean;
}

interface VaultFootnotesAddCommandOptions {
  key?: string;
  anchor?: string;
  body?: string;
  bodyStdin?: boolean;
  renumber?: boolean;
  dryRun?: boolean;
  vaultPath?: string;
  json?: boolean;
}

interface VaultFootnotesLintCommandOptions {
  vaultPath?: string;
  json?: boolean;
}

interface VaultFootnotesGcCommandOptions {
  dropOrphans?: boolean;
  renumber?: boolean;
  dryRun?: boolean;
  vaultPath?: string;
  json?: boolean;
}

interface VaultStampCommandOptions {
  updated?: string;
  updatedBy?: string;
  lastProbed?: string | boolean;
  field?: string[];
  dryRun?: boolean;
  vaultPath?: string;
  json?: boolean;
}

interface ExtensionsListCommandOptions {
  searchPath?: string[];
  json?: boolean;
}

interface ExtensionsValidateCommandOptions extends ExtensionsListCommandOptions {
  strict?: boolean;
}

interface ExtensionsCheckCommandOptions {
  path: string;
  json?: boolean;
}

// ── POL-679: new canonical command option interfaces ────────────────

interface DoctorCommandOptions {
  json?: boolean;
  host?: string;
}

interface VerifyFleetCommandOptions {
  strict?: boolean;
  json?: boolean;
}

interface ToolsVersionsBumpCommandOptions {
  registry?: string;
  tool: string;
  to: string;
  apply?: boolean;
  json?: boolean;
}

interface ExecNotifyCommandOptions {
  message: string;
  level?: string;
  channel?: string;
  title?: string;
  json?: boolean;
}

interface KnowledgeExecPlanNewCommandOptions {
  title: string;
  issueId?: string;
  kind?: string;
  state?: string;
  owner?: string;
  scope?: string;
  targetRepo?: string;
  targetBranch?: string;
  targetWorkdir?: string;
  targetHost?: string[];
  runnerHarness?: string;
  runnerMode?: string;
  outPath?: string;
  apply?: boolean;
  json?: boolean;
}

interface KnowledgeExecPlanPromoteCommandOptions {
  title?: string;
  issueId?: string;
  project?: string;
  workstream?: string;
  author?: string;
  assignee?: string;
  updated?: string;
  updatedBy?: string;
  status?: string;
  vaultPath?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface KnowledgeDocstoreCommandOptions {
  query?: string;
  id?: string;
  json?: boolean;
}

interface BundleBuildCommandOptions {
  path: string;
  outDir?: string;
  apply?: boolean;
  json?: boolean;
}

interface InstallBootstrapCommandOptions {
  target?: string;
  apply?: boolean;
  json?: boolean;
}

interface RuntimeConfigCommandOptions {
  managedConfigsRoot?: string;
  host: string;
  home?: string;
  component?: string[];
  json?: boolean;
}

interface SelfUpgradeCommandOptions {
  host?: string;
  fleet?: boolean;
  to?: string;
  targetSha?: string;
  targetFetchRemote?: string;
  targetFetchRef?: string;
  startupContractPayload?: string;
  dryRun?: boolean;
  parallel?: boolean;
  hosts?: string;
  failFast?: boolean;
  yes?: boolean;
  json?: boolean;
  force?: boolean;
  abortRuns?: boolean;
  drainAll?: boolean;
  authToken?: string;
  drainDeadline?: string;
  continuous?: boolean;
}

interface SelfUpgradeStatusCommandOptions {
  watch?: boolean;
  json?: boolean;
}

interface FleetStatusCommandOptions {
  host?: string;
  json?: boolean;
}

type FleetStatusVerdict = FleetConvergenceVerdict | "missing";

interface FleetStatusLeg {
  leg: FleetConvergenceRow["leg"];
  verdict: FleetConvergenceVerdict;
  policy: FleetConvergenceRow["policy"];
  target_rev: string | null;
  observed_rev: string | null;
  converged_from: string;
  last_checked_at: string;
  receipt_path?: string | null;
  receipt_id?: string | null;
  detail?: string | null;
}

interface FleetStatusHost {
  host: string;
  verdict: FleetStatusVerdict;
  owner: string;
  roles: readonly string[];
  desired_membership: "active";
  effective_state: Exclude<FleetEffectiveState, "withdrawn">;
  legs: FleetStatusLeg[];
}

interface FleetStatusSummary extends FleetReadSummary {
  fresh: number;
  pending: number;
  structural: number;
  missing: number;
}

interface FleetStatusResult {
  schema_version: "fleet-convergence-status/v2";
  checked_at: string;
  topology_snapshot: FleetTopologyOutput["topology_snapshot"];
  topology_authority: FleetTopologyOutput["topology_authority"];
  can_emit_green_verdict: boolean;
  desired_active_total: number;
  withdrawn_total: number;
  hosts: FleetStatusHost[];
  excluded_withdrawn: Array<{
    host: string;
    owner: string;
    roles: readonly string[];
    desired_membership: "withdrawn";
    effective_state: "withdrawn";
    verdict: FleetStatusVerdict;
    legs: FleetStatusLeg[];
  }>;
  summary: FleetStatusSummary;
}

interface SelfHealthCommandOptions {
  host?: string;
  fleet?: boolean;
  json?: boolean;
}

interface AgentMailCommandOptions {
  projectKey?: string;
  threadId?: string;
  message?: string;
  json?: boolean;
}

interface ContextPrimitiveCommandOptions {
  json?: boolean;
  includeUndetected?: boolean;
  providers?: string;
  goal?: string;
  profile?: "default" | "chatgpt-web";
  seed?: string[];
  vaultPath?: string;
  roots?: string;
  include?: string;
  exclude?: string;
  includeSessions?: boolean;
  includeGitMeta?: boolean;
  budgetBytes?: string;
  budgetTokens?: string;
  planHash?: string;
  outDir?: string;
  apply?: boolean;
  redactionMode?: "strict" | "advisory";
  bundlePath?: string;
  format?: "markdown" | "json";
  topic?: string;
  target?: string;
  enableExperimental?: boolean;
}

interface ContextFixtureRunCommandOptions {
  catalog: string;
  receipt: string;
  failFast?: boolean;
  json?: boolean;
}

interface OracleInitCommandOptions {
  issue?: string;
  project?: string;
  daily?: boolean;
  outDir?: string;
  vaultPath?: string;
  variants?: string;
  author?: string;
  force?: boolean;
  json?: boolean;
}

interface OracleBundleCommandOptions {
  recipe?: string;
  plan?: boolean;
  apply?: boolean;
  vaultPath?: string;
  ctxCommand?: string;
  calyxCommand?: string;
  json?: boolean;
}

interface OracleRunCommandOptions {
  recipe?: string;
  manifest?: string;
  provider?: string;
  model?: string;
  variant?: string;
  writeResponse?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface OracleSynthesizeCommandOptions {
  write?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

interface OracleDoctorCommandOptions {
  recipe?: string;
  json?: boolean;
}

interface CliError extends Error {
  exitCode?: number;
  retryable?: boolean;
  clientResultKind?: "indeterminate" | "unkeyed_indeterminate";
  reconciliationCommand?: string;
}

interface AgentContextCommandOptions {
  json?: boolean;
}

interface McpManifestCommandOptions {
  surface?: string;
  json?: boolean;
}

interface McpServeCommandOptions {
  surface?: string;
  host?: string;
  port?: string;
  authTokenEnv?: string;
  vaultPath?: string;
  runsRoot?: string;
  attachmentCacheDir?: string;
  json?: boolean;
}

interface AgentContextCommandEntry {
  path: string;
  description?: string;
  subcommands: string[];
  mutation_class?: InterfaceMutationClass;
}

interface AgentContextRecipe {
  id: string;
  intent: string;
  commands: string[];
  notes: string[];
}

interface AgentContextPayload {
  schema_version: "calyx.agent-context/v1";
  cli_version: string;
  generated_from: "commander-introspection";
  commands: AgentContextCommandEntry[];
  recipes: AgentContextRecipe[];
  messages?: {
    schema_version: "calyx.agent-context-messages/v1";
    local: {
      status: "ok" | "unavailable";
      counts?: ReturnType<typeof countPendingMessages> | undefined;
      error?: string | undefined;
    };
    coordinator: {
      status: "best_effort_not_queried";
      blocking: false;
    };
  } | undefined;
  legacy_wrappers: {
    visible_in_help: false;
    invocation_policy: "preparse-diagnostics";
    implemented_count: number;
    retired_count: number;
    deprecated_count: number;
  };
  agent_definitions: {
    source: string | null;
    status: "available" | "unconfigured" | "unreadable";
    items: Array<{
      id: string;
      description?: string;
      status?: string;
    }>;
    error?: string;
  };
}

function createCliError(message: string, exitCode: number, retryable = false): CliError {
  const error = new Error(message) as CliError;
  error.exitCode = exitCode;
  error.retryable = retryable;
  return error;
}

function createClientResultCliError(
  message: string,
  kind: NonNullable<CliError["clientResultKind"]>,
  reconciliationCommand?: string,
): CliError {
  const error = createCliError(message, 6);
  error.clientResultKind = kind;
  if (reconciliationCommand !== undefined) {
    error.reconciliationCommand = reconciliationCommand;
  }
  return error;
}

function getGeminiApiKey(): string {
  const apiKey = process.env["GEMINI_API_KEY"] || process.env["GOOGLE_API_KEY"];
  if (!apiKey?.trim()) {
    throw createCliError(
      "calyx oracle run requires GEMINI_API_KEY or GOOGLE_API_KEY. Load Polli secrets with with-polli-secrets, or run --dry-run to inspect the plan without sending.",
      2,
    );
  }
  return apiKey.trim();
}

function normalizeOracleUsage(raw: unknown): OracleRunUsageV1 | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const promptTokenCount = typeof record["promptTokenCount"] === "number" ? record["promptTokenCount"] : undefined;
  const responseTokenCount = typeof record["responseTokenCount"] === "number" ? record["responseTokenCount"] : undefined;
  const totalTokenCount = typeof record["totalTokenCount"] === "number" ? record["totalTokenCount"] : undefined;
  return {
    ...(promptTokenCount !== undefined ? { prompt_tokens: promptTokenCount } : {}),
    ...(responseTokenCount !== undefined ? { response_tokens: responseTokenCount } : {}),
    ...(totalTokenCount !== undefined ? { total_tokens: totalTokenCount } : {}),
    raw,
  };
}

async function executeGeminiOracleRun(plan: OracleRunPlanV1): Promise<{
  responseText: string;
  usage?: OracleRunUsageV1 | undefined;
  providerResponseId?: string | undefined;
}> {
  const apiKey = getGeminiApiKey();
  const promptText = await readFile(plan.prompt.absolute_path, "utf8");
  const genai = await import("@google/genai");
  const ai = new genai.GoogleGenAI({ apiKey });
  const parts: Array<string | ReturnType<typeof genai.createPartFromUri>> = [promptText];

  for (const attachment of plan.attachments) {
    const uploaded = await ai.files.upload({
      file: attachment.absolute_path,
      config: { mimeType: attachment.mime_type },
    });
    if (!uploaded.uri || !uploaded.mimeType) {
      throw createCliError(`Gemini upload for ${attachment.path} did not return both uri and mimeType.`, 2);
    }
    parts.push(genai.createPartFromUri(uploaded.uri, uploaded.mimeType));
  }

  const response = await ai.models.generateContent({
    model: plan.model,
    contents: genai.createUserContent(parts),
  });
  const responseRecord = response as unknown as Record<string, unknown>;
  const responseText = typeof response.text === "string" ? response.text.trim() : "";
  if (!responseText) {
    throw createCliError("Gemini returned an empty oracle response.", 2);
  }
  return {
    responseText,
    usage: normalizeOracleUsage(responseRecord["usageMetadata"]),
    ...(typeof responseRecord["responseId"] === "string" ? { providerResponseId: responseRecord["responseId"] } : {}),
  };
}

const RUN_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024;

export interface RunCliDependencies {
  createRunService?: (options: {
    runsRoot?: string;
    workerEntrypoint?: string;
    defaultWorktreeBase?: string;
    runtimeAdapterRegistry: RuntimeAdapterRegistry;
    trackerRegistry: TrackerRegistry;
    exitClassifierPipeline: ClassifierPipeline;
  }) => RunServiceLike;
  createAdminClient?: typeof createCalyxAdminClient;
  createConsumerClient?: typeof createCalyxClient;
  linearGraphql?: LinearGraphqlRequester;
  execFileAsync?: ExecFileAsync;
  agentsInfraRoot?: string;
  resolveFleetTopology?: ResolveFleetTopology;
  repoRoot?: string;
  currentHostAlias?: string;
  toolchainCheckForHost?: SelfDriftDependencies["toolchainCheckForHost"];
  resolveCurrentHostAlias?: typeof resolveCurrentHostAlias;
  hostname?: () => string;
  now?: () => Date;
  /** Exact command seams for deterministic self-upgrade CLI framing tests. */
  runSelfUpgrade?: typeof runSelfUpgrade;
  runSelfUpgradeTargetEntry?: typeof runSelfUpgradeTargetEntry;
  runSelfUpgradeFleet?: typeof runSelfUpgradeFleet;
  /** Private relay sink seam; never exposed as a command or consumer API. */
  selfUpgradeProgressStream?: Writable;
  tokenForHost?: (host: string) => Promise<string | undefined> | string | undefined;
  openRecoveryCustody?: typeof openClientRecoveryCustody;
  watchRunChanges?: (
    runDir: string,
    onChange: () => void,
    onError: (error: Error) => void,
  ) => () => void;
  sessionWake?: Omit<SessionWakeRouteDependencies, "now">;
}

export interface BuildProgramOptions {
  runCli?: RunCliDependencies;
}

function remoteAdminClient(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  options: Omit<CalyxClientOptions, "baseUrl" | "bearerToken"> = {},
): CalyxAdminClient {
  const factory = deps.createAdminClient ?? createCalyxAdminClient;
  return factory({
    ...options,
    baseUrl: access.serverUrl,
    bearerToken: access.token,
  });
}

function remoteConsumerClient(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  options: Omit<CalyxClientOptions, "baseUrl" | "bearerToken"> = {},
): CalyxClient {
  const factory = deps.createConsumerClient ?? createCalyxClient;
  return factory({
    ...options,
    baseUrl: access.serverUrl,
    bearerToken: access.token,
  });
}

function requireClientResult<T, Code extends string>(
  result: CalyxResult<T, Code>,
  context: string,
  reconciliationCommand?: string,
): T {
  if (result.ok) return result.data;
  if (result.kind === "api") {
    const code = String(result.error.error.code);
    throw createCliError(
      `${context} failed (${result.status}): ${code ? `${code}: ` : ""}${result.error.error.message}`,
      result.status === 401 ? 8 : result.status === 404 ? 3 : 6,
      result.error.error.retryable === true,
    );
  }
  if (result.kind === "transport") {
    if (result.stage === "recovery_store") {
      throw createCliError(
        `${context} was not dispatched: encrypted recovery custody could not reserve exact replay authority (${result.message})`,
        6,
      );
    }
    throw createCliError(
      `${context} failed: activity_owner_unreachable: daemon is unreachable (${result.message})`,
      6,
      true,
    );
  }
  if (result.kind === "protocol") {
    throw createCliError(
      `${context} failed: daemon returned an invalid success representation: ${result.message}`,
      6,
    );
  }
  if (result.kind === "unkeyed_indeterminate") {
    const reconciliation = reconciliationCommand
      ? `Reconcile with \`${reconciliationCommand}\``
      : `Reconcile through ${result.reconciliation.operationIds.join(" or ")}`;
    throw createClientResultCliError(
      `${context} is indeterminate: ${result.operationId} may have committed after dispatch. `
      + `Do not repeat this mutation from this result. ${reconciliation}. `
      + "An absent or unchanged observation is inconclusive and does not prove non-admission. "
      + `Generated read authority: ${result.reconciliation.operationIds.join(" or ")}. `
      + "Re-supply credential authority through --auth-token or the configured operator credential; bearer material is intentionally omitted from reconciliation copy.",
      "unkeyed_indeterminate",
      reconciliationCommand,
    );
  }
  throw createCliError(
    `${context} is indeterminate: the daemon may have committed the mutation. `
    + "The sensitive generated recovery receipt was not routed through encrypted CLI custody and will not be printed.",
    6,
  );
}

function requireActivityMarkClientResult<T, Code extends string>(
  result: CalyxResult<T, Code>,
  context: string,
  reconciliationCommand?: string,
): T {
  if (!result.ok && result.kind === "api") {
    const code = String(result.error.error.code);
    let exitCode = 6;
    if (result.status === 401 || result.status === 403) {
      exitCode = 8;
    } else if (result.status === 404) {
      exitCode = 3;
    } else if (code === "internal_error") {
      exitCode = 10;
    } else if (result.status >= 400 && result.status < 500) {
      exitCode = 2;
    }
    throw createCliError(
      `${context} failed (${result.status}): ${code ? `${code}: ` : ""}${result.error.error.message}`,
      exitCode,
      result.error.error.retryable === true,
    );
  }
  return requireClientResult(result, context, reconciliationCommand);
}

async function remoteAdminHealth(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  context = "run server health",
  signal?: AbortSignal,
): Promise<CalyxDaemonHealth> {
  const result = await remoteAdminClient(deps, access).admin.health(signal ? { signal } : undefined);
  return requireClientResult(result, context) as CalyxDaemonHealth;
}

async function openRecoveryCustody(deps: RunCliDependencies): Promise<ClientRecoveryCustody> {
  return (deps.openRecoveryCustody ?? openClientRecoveryCustody)();
}

async function executeRecoverableClientMutation<T, Code extends string, Client>(
  deps: RunCliDependencies,
  options: {
    context: string;
    replayCommand: string;
    createClient: (options: Omit<CalyxClientOptions, "baseUrl" | "bearerToken">) => Client;
    operation: (client: Client) => Promise<CalyxResult<T, Code>>;
    resultMap?: "activity_marks";
  },
): Promise<T> {
  const custody = await openRecoveryCustody(deps);
  const client = options.createClient({
    retry: { recoveryAttempts: 3 },
    recoveryStore: custody.recoveryStore,
    recoveryReceiptIntegrityKey: custody.recoveryReceiptIntegrityKey,
  });
  const result = await options.operation(client);
  if (!result.ok && result.kind === "indeterminate") {
    const candidatePath = custody.receiptPath(result.receipt);
    let artifactPath: string | undefined;
    if (result.persistenceFailure === undefined) {
      artifactPath = candidatePath;
    } else {
      // A reservation was encrypted before dispatch. Its stable replay-identity
      // path deliberately survives a failed post-dispatch metadata upgrade.
      try {
        await custody.readReceipt(candidatePath);
        artifactPath = candidatePath;
      } catch {
        artifactPath = undefined;
      }
    }
    const replayArgument = artifactPath
      ? `${options.replayCommand} ${shellQuote(artifactPath)}`
      : undefined;
    throw createClientResultCliError(
      `${options.context} is indeterminate (indeterminate_result): the daemon may have committed the mutation. `
      + (replayArgument
        ? `The generated calyx.client-indeterminate-result/v1 receipt is encrypted at ${artifactPath}. `
          + (result.persistenceFailure
            ? "The pre-dispatch reservation remains exact even though its final diagnostic update failed. "
            : "")
          + `Replay with ${replayArgument}.`
        : `Generated receipt persistence failed: ${result.persistenceFailure?.message ?? "unknown custody failure"}.`),
      "indeterminate",
      replayArgument,
    );
  }
  return options.resultMap === "activity_marks"
    ? requireActivityMarkClientResult(result, options.context)
    : requireClientResult(result, options.context);
}

async function executeRecoverableMutation<T, Code extends string>(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  options: {
    context: string;
    replayCommand: string;
    operation: (client: CalyxAdminClient) => Promise<CalyxResult<T, Code>>;
  },
): Promise<T> {
  return executeRecoverableClientMutation(deps, {
    ...options,
    createClient: (clientOptions) => remoteAdminClient(deps, access, clientOptions),
  });
}

function normalizedReceiptEndpoint(receipt: CalyxIndeterminateReceipt): string {
  const endpoint = new URL(receipt.base_path || "/", receipt.origin);
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || endpoint.origin !== receipt.origin
  ) {
    throw createCliError("Generated recovery receipt has an invalid endpoint authority binding.", 2);
  }
  const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/u, "");
  if (basePath !== receipt.base_path) {
    throw createCliError("Generated recovery receipt has a noncanonical base-path authority binding.", 2);
  }
  return `${endpoint.origin}${basePath}`;
}

function normalizedRunServerEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw createCliError("Run-server endpoint must be a valid URL.", 2);
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    throw createCliError("Run-server endpoint must be HTTP(S) without userinfo, query, or fragment data.", 2);
  }
  const basePath = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/u, "");
  return `${endpoint.origin}${basePath}`;
}

function exactEndpointReconciliationCommand(
  command: readonly string[],
  serverUrl: string,
): string {
  return [
    ...command,
    "--server-url",
    normalizedRunServerEndpoint(serverUrl),
    "--json",
  ].map(shellQuote).join(" ");
}

function generatedServerRoute(serverUrl: string, route: string): string {
  if (!route.startsWith("/v1/") || route.includes("?") || route.includes("#")) {
    throw createCliError(`Run server returned an invalid operation route ${route}.`, 6);
  }
  return `${normalizedRunServerEndpoint(serverUrl)}${route}`;
}

async function resolveRecoveryReceiptAccess(
  receipt: CalyxIndeterminateReceipt,
  authToken: string | undefined,
  deps: RunCliDependencies,
): Promise<{ serverUrl: string; token: string }> {
  const serverUrl = normalizedReceiptEndpoint(receipt);
  const explicitToken = authToken?.trim();
  if (explicitToken) return { serverUrl, token: explicitToken };

  const hostsTruth = await readRunServeHostsTruth(deps);
  const matchingHosts = Object.entries(hostsTruth.hosts ?? {}).flatMap(([host, entry]) => {
    const configured = entry.run_serve_url?.trim();
    if (!configured) return [];
    try {
      const parsed = new URL(configured);
      const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "");
      return `${parsed.origin}${basePath}` === serverUrl ? [host] : [];
    } catch {
      return [];
    }
  });
  if (matchingHosts.length !== 1) {
    throw createCliError(
      matchingHosts.length === 0
        ? `No configured named host owns recovery endpoint ${serverUrl}; pass --auth-token explicitly.`
        : `Recovery endpoint ${serverUrl} is ambiguous across named hosts; pass --auth-token explicitly.`,
      2,
    );
  }
  const access = await resolveRunServerAccess({ host: matchingHosts[0], serverUrl }, deps);
  if (!access.token) {
    throw createCliError(`Recovery replay requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`, 2);
  }
  return { serverUrl: access.serverUrl, token: access.token };
}

async function replayGeneratedMutation(
  deps: RunCliDependencies,
  artifactPath: string,
  expectedOperationId: string | undefined,
  replayCommand: string,
  authToken?: string,
): Promise<unknown> {
  const custody = await openRecoveryCustody(deps);
  const receipt = await custody.readReceipt(artifactPath);
  if (expectedOperationId && receipt.operation_id !== expectedOperationId) {
    throw createCliError(
      `Generated recovery receipt ${artifactPath} targets ${receipt.operation_id}, not ${expectedOperationId}.`,
      2,
    );
  }
  const operationId = receipt.operation_id;
  const access = await resolveRecoveryReceiptAccess(receipt, authToken, deps);
  const client = remoteAdminClient(deps, access, {
    retry: { recoveryAttempts: 3 },
    recoveryStore: custody.recoveryStore,
    recoveryReceiptIntegrityKey: custody.recoveryReceiptIntegrityKey,
  });
  const result = await client.replayIndeterminate(receipt);
  if (!result.ok && result.kind === "indeterminate") {
    const nextPath = result.persistenceFailure === undefined
      ? custody.receiptPath(result.receipt)
      : undefined;
    throw createCliError(
      `${operationId} replay remains indeterminate. `
      + (nextPath
        ? `Retained the original encrypted receipt and persisted the successor at ${nextPath}. Replay with ${replayCommand} ${shellQuote(nextPath)}.`
        : `Retained the original receipt; successor persistence failed: ${result.persistenceFailure?.message ?? "unknown custody failure"}.`),
      6,
    );
  }
  if (!result.ok) {
    // A transport/protocol/API failure during replay does not close the
    // original ambiguity. Keep its durable authority until replay proves a
    // schema-valid success.
    return requireClientResult(result, `${operationId} replay`);
  }
  try {
    await custody.removeReceipt(artifactPath);
  } catch (error) {
    console.warn(
      `The definitive replay result is authoritative, but encrypted recovery receipt cleanup failed for ${artifactPath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result.data;
}

async function remoteAdminRunRecord(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  runId: string,
  context = `run ${runId}`,
  signal?: AbortSignal,
): Promise<AdminRunRecord> {
  const result = await remoteAdminClient(deps, access).admin.run.get({
    path: { runId },
    ...(signal ? { signal } : {}),
  });
  return requireClientResult(result, context) as unknown as AdminRunRecord;
}

type RunServiceLike = Pick<
  RunService,
  | "createIntent"
  | "launch"
  | "getRunRecord"
  | "getKernelReceipt"
  | "listRuns"
  | "readEvents"
  | "resolveResumeWorktreePath"
  | "stop"
  | "reconcile"
  | "executeStoredRun"
> & {
  submitDetached?: RunService["submitDetached"];
  auditTerminalAuthority?: RunService["auditTerminalAuthority"];
  observeRun?: RunService["observeRun"];
  readLogs?: RunService["readLogs"];
  listActivity?: (options?: {
    includeInteractive?: boolean;
    host?: string;
    agentKind?: InteractiveSessionBackend;
    sinceMs?: number;
    limit?: number;
  }) => Promise<RunActivityEntry[]>;
  inspectInteractiveSession?: (options: {
    activityId: string;
    host?: string;
    around?: string;
    tail?: number;
    context?: number;
    includeTools?: boolean;
  }) => Promise<InteractiveSessionInspectResult>;
  inspectActivityMessages?: (options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityMessageSelectorInput;
  }) => Promise<ActivityMessagesResult>;
  inspectActivityEvents?: (options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityEventSelectorInput;
  }) => Promise<ActivityEventsResult>;
  inspectActivityTurns?: (options: {
    activityId?: string;
    host?: string;
    latestSession?: boolean;
    latestSessionBackend?: InteractiveSessionBackend;
    selector?: ActivityTurnSelectorInput;
  }) => Promise<ActivityTurnsResult>;
  inspectActivityText?: (options: {
    messageId: string;
    host?: string;
    selector?: ActivityTextSelectorInput;
  }) => Promise<ActivityTextResult>;
  inspectActivityAttachments?: (options: {
    activityId: string;
    host?: string;
    selector?: ActivityAttachmentsSelectorInput;
  }) => Promise<ActivityAttachmentsResult>;
  inspectActivityAttachmentRecord?: (options: {
    activityId: string;
    ref: string;
    host?: string;
  }) => Promise<ActivityAttachmentRecordResult>;
  readActivityAttachmentBytes?: (options: {
    activityId: string;
    ref: string;
    host?: string;
  }) => Promise<ActivityAttachmentBytesResult>;
};

type StreamedRunEvent = CalyxDeliveredStreamEvent;

type RunOutcomeTerminalEvidence = Pick<
  AgentTerminalEvidence,
  "source" | "status" | "reason"
> & Partial<Pick<AgentTerminalEvidence, "exit_code">> & {
  backend_subtype?: string;
  backend_terminal_reason?: string;
  backend_stop_reason?: string;
  session_id?: string;
  signal?: string;
};

type RunOutcomeProviderConstraint = Omit<
  ProviderConstraint,
  "backend" | "observed_at" | "provider_code" | "reset_hint"
> & {
  backend: string;
  observed_at: string;
  provider_code?: string;
  reset_hint?: string;
  reset_hint_truncated?: true;
};

type RunOutcomeProgressSignal = Omit<
  NonNullable<NonNullable<RunRecord["health"]>["progress_signal"]>,
  "expected_silence_until"
> & {
  expected_silence_until?: string;
};

interface RunOutcomeDiagnostics {
  terminal_evidence?: RunOutcomeTerminalEvidence;
  provider_constraint?: RunOutcomeProviderConstraint;
  infra_error?: Pick<InfraErrorClassification, "failure_layer" | "failure_reason" | "message"> & {
    message_truncated?: true;
  };
  failure?: {
    summary: string;
    summary_truncated?: true;
    exit_code?: number;
    spawn_error?: string;
    spawn_error_truncated?: true;
  };
}

type RunOutcomeCause =
  | {
      category: "active";
      reason: "run_active";
    }
  | {
      category: "provider_constraint";
      reason: "provider_capacity_exhausted";
      backend: string;
      constraint_kind: ProviderConstraint["kind"];
    }
  | {
      category: "infra_error";
      reason: InfraErrorFailureReason;
      failure_layer: InfraErrorFailureLayer;
    }
  | {
      category: "partial";
      reason: PartialReason;
    }
  | {
      category: "terminal";
      reason: AgentTerminalEvidence["reason"] | RunState;
    };

type RunOutcomeOperationId =
  | "run.status"
  | "run.await"
  | "run.logs"
  | "run.receipt"
  | "run.kernel-receipt"
  | "run.subscribe";

interface RunOutcomeOperationRef {
  operation: RunOutcomeOperationId;
  format: "text" | "json" | "jsonl";
  details?: true;
  tail?: number;
  event_type?: "run.terminal";
}

interface RunOutcomeOverflowFact {
  field: string;
  disposition: "truncated" | "omitted";
  original_bytes: number;
  emitted_bytes: number;
}

interface RunOutcomeContinuation {
  selector: {
    kind: "run_id";
    run_id: string;
  };
  scope: {
    host?: string;
    runs_root?: string;
    server_url?: string;
    authentication: "ambient" | "required_not_embedded";
  };
  operations: RunOutcomeOperationRef[];
}

interface RunOutcomeProjection {
  run_id: string;
  state: RunState;
  terminal: boolean;
  successful: boolean;
  cause: RunOutcomeCause;
  partial_reason: PartialReason | null;
  next_action: {
    operation: "run.await" | "run.receipt";
    reason: "run_active" | "run_terminal";
  };
  continuation: RunOutcomeContinuation;
  short_id: string;
  host: string | null;
  backend: SupportedBackend | null;
  issue: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  diagnostics: RunOutcomeDiagnostics;
  health: {
    status: NonNullable<RunRecord["health"]>["status"];
    checked_at: string;
    last_progress_at: string | null;
    progress_signal: RunOutcomeProgressSignal | null;
  } | null;
  artifacts: {
    discovered: number;
    required: number;
    missing: number;
  };
  last_event?: {
    cursor: string;
    event_id: string;
  };
  response_economics: {
    tier: "default";
    formats: {
      text: {
        target_bytes: 1024;
        hard_bytes: 4096;
      };
      json: {
        target_bytes: 4096;
        hard_bytes: 16384;
      };
    };
    overflow: RunOutcomeOverflowFact[];
    omitted_classes: Array<
      | "prompt"
      | "resolved_spec"
      | "run_record"
      | "kernel_receipt"
      | "health_observations"
      | "artifact_names"
      | "filesystem_paths"
    >;
    default_class_exceptions: Array<{
      content_class: "filesystem_paths";
      field: "continuation.scope.runs_root";
      reason: "accepted_nonsecret_address";
    }>;
    detail_operations: RunOutcomeOperationRef[];
  };
}

type RunStatusResult = RunOutcomeProjection & {
  schema_version: "calyx.run-status/v2";
};

interface RunAwaitResult extends RunOutcomeProjection {
  schema_version: "calyx.run-await/v2";
  timed_out: boolean;
}

interface RunEventStreamHooks {
  onConnected?: () => Promise<boolean>;
  onEvent: (event: StreamedRunEvent) => Promise<boolean> | boolean;
  onDisconnected?: (error?: unknown) => Promise<boolean>;
  onStopRequested?: (requestStop: () => void) => () => void;
}

const DEFAULT_RUNNER_WORKTREE_BASE_ENV = "CALYX_RUNNER_WORKTREE_BASE";
const DEFAULT_RUNS_ROOT_ENV = "CALYX_RUNS_ROOT";
const RUN_HANDLE_RESOLUTION_SCAN_MAX_ITEMS = CALYX_ADMIN_RUN_LIST_MAX_ITEMS * 100;
const DEFAULT_DAEMONS_ROOT_ENV = "CALYX_DAEMONS_ROOT";
const RUN_SERVER_CREDENTIAL_HINT = "the target host's operator_cli outbound credential";
/** Shared `[activity-id]` help across the activity read commands. */
const ACTIVITY_ID_ARGUMENT_HELP = [
  "Activity id: `interactive:<backend>:<session-id>`, authorship alias `<backend>:<host>:<session-id>`,",
  "Codex `codex://threads/<uuid>`, `run:<run-id>` (full id or unique prefix), a short session-id prefix,",
  "or omit with --latest-session. The host is `--host <host>`, never a segment of the id.",
].join(" ");
const DEFAULT_RUN_AWAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_TASKS_DIR_ENV = "CALYX_TASKS_DIR";
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
type ContextPrimitive = (typeof CTXPACK_PRIMITIVES_V1)[number];

function remoteActivityAuthHint(): string {
  return [
    `Remote activity queries require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
    "Try: with-polli-secrets calyx activity ...",
    "Managed wrapper path: ${XDG_CONFIG_HOME:-$HOME/.config}/polli/bin/with-polli-secrets calyx activity ...",
  ].join("\n");
}

function parseActivityMarkKind(rawValue: string | undefined): ActivityMarkKind {
  const value = rawValue;
  if (value !== undefined && (ACTIVITY_MARK_KINDS as readonly string[]).includes(value)) {
    return value as ActivityMarkKind;
  }
  throw createCliError(
    `Invalid --kind value: ${rawValue ?? ""}. Expected one of: ${ACTIVITY_MARK_KINDS.join(", ")}.`,
    2,
  );
}

function parseActivityMarkTargetKind(rawValue: string): ActivityMarkTargetKind {
  const value = rawValue;
  if ((ACTIVITY_MARK_TARGET_KINDS as readonly string[]).includes(value)) {
    return value as ActivityMarkTargetKind;
  }
  throw createCliError(
    `Invalid --target-kind value: ${rawValue}. Expected one of: ${ACTIVITY_MARK_TARGET_KINDS.join(", ")}.`,
    2,
  );
}

function inferActivityMarkTargetKind(targetId: string): ActivityMarkTargetKind {
  if (/:msg:[1-9]\d*$/u.test(targetId)) return "message";
  if (/:turn:[1-9]\d*$/u.test(targetId)) return "turn";
  return "activity";
}

function parseActivityMarkTarget(
  targetId: string,
  explicitTargetKind?: string,
): {
  targetKind: ActivityMarkTargetKind;
  targetId: string;
} {
  const canonicalTargetId = targetId;
  const inferredTargetKind = inferActivityMarkTargetKind(canonicalTargetId);
  const targetKind = explicitTargetKind === undefined
    ? inferredTargetKind
    : parseActivityMarkTargetKind(explicitTargetKind);
  if (explicitTargetKind !== undefined && targetKind !== inferredTargetKind) {
    throw createCliError(
      `Explicit --target-kind ${targetKind} does not match the target id's exact ${inferredTargetKind} grammar.`,
      2,
    );
  }
  try {
    parseActivityMarkTargetId(targetKind, canonicalTargetId);
  } catch (error) {
    throw createCliError(
      `Invalid activity mark target: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  return { targetKind, targetId: canonicalTargetId };
}

function parseActivityMarkReasonOption(rawValue: string | undefined): string | undefined {
  try {
    return validateActivityMarkReason(rawValue);
  } catch (error) {
    throw createCliError(
      `Invalid --reason value: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function parseActivityMarkAssertedActor(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  try {
    return validateApiAssertedActor(rawValue);
  } catch (error) {
    throw createCliError(
      `Invalid --asserted-actor value: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function parseActivityMarkIdOption(rawValue: string): string {
  const value = rawValue;
  try {
    return validateActivityMarkId(value);
  } catch (error) {
    throw createCliError(
      `Invalid mark id: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function parseActivityMarkIdempotencyKey(rawValue: string | undefined): string {
  const value = rawValue ?? `activity-mark:${randomUUID()}`;
  if (value.length === 0 || value.length > 256 || /\s/u.test(value)) {
    throw createCliError("--idempotency-key must be 1..256 characters without whitespace.", 2);
  }
  return value;
}

function parseActivityMarkListLimit(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(rawValue)) {
    throw createCliError(`Invalid --limit value: ${rawValue}. Must be an integer from 1 through ${ACTIVITY_MARK_LIST_MAX_LIMIT}.`, 2);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > ACTIVITY_MARK_LIST_MAX_LIMIT) {
    throw createCliError(`Invalid --limit value: ${rawValue}. Must be an integer from 1 through ${ACTIVITY_MARK_LIST_MAX_LIMIT}.`, 2);
  }
  return String(value);
}

function parseActivityMarkSince(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  if (!isCanonicalApiTimestamp(rawValue)) {
    throw createCliError("--since must be a canonical UTC ISO timestamp, for example 2026-07-21T00:00:00.000Z.", 2);
  }
  return rawValue;
}

function parseActivityMarkListTargetId(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  if (
    rawValue.length === 0
    || rawValue.length > ACTIVITY_MARK_TARGET_ID_MAX_CHARS
    || rawValue.trim() !== rawValue
    || [...rawValue].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw createCliError(
      `--target-id must be a canonical string of 1..${ACTIVITY_MARK_TARGET_ID_MAX_CHARS} characters.`,
      2,
    );
  }
  return rawValue;
}

function parseActivityMarkCursor(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue.length === 0 || rawValue.length > ACTIVITY_MARK_CURSOR_MAX_CHARS) {
    throw createCliError(`--cursor must be 1..${ACTIVITY_MARK_CURSOR_MAX_CHARS} characters.`, 2);
  }
  return rawValue;
}

async function resolveActivityMarkAccess(
  options: ActivityCommonOptions,
  deps: RunCliDependencies,
): Promise<{ host?: string; serverUrl: string; token: string }> {
  const access = await resolveRunServerAccess({
    host: options.host,
    serverUrl: options.serverUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `Activity marks require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}. Try: with-polli-secrets calyx activity ...`,
      2,
    );
  }
  return {
    ...(access.host ? { host: access.host } : {}),
    serverUrl: access.serverUrl,
    token: access.token,
  };
}

async function readStdinText(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

function mapStateError(err: unknown): Error {
  if (err instanceof StateDriverError) {
    return createCliError(err.message, 7);
  }
  if (err instanceof Error && (err as CliError).exitCode !== undefined) {
    return err;
  }
  return err instanceof Error ? err : new Error(String(err));
}

function fleetStatusHostVerdict(rows: readonly FleetConvergenceRow[]): FleetStatusVerdict {
  if (rows.length === 0) return "missing";
  if (rows.some((row) => row.verdict === "structural")) return "structural";
  if (rows.some((row) => row.verdict === "pending")) return "pending";
  return "fresh";
}

async function readFleetStatus(options: FleetStatusCommandOptions, deps: RunCliDependencies): Promise<FleetStatusResult> {
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const topologyTargets = await (deps.resolveFleetTopology
    ?? ((intent) => resolveFleetTopologyForCommand(intent, deps.agentsInfraRoot)))("read_only");
  const topology = fleetTopologyOutput(topologyTargets);
  const requestedHost = options.host?.trim().toLowerCase().split(".")[0];
  const enrolledTargets = requestedHost
    ? topologyTargets.all_enrolled.filter((target) => target.host === requestedHost)
    : topologyTargets.all_enrolled;
  if (requestedHost && enrolledTargets.length === 0) {
    throw new Error(`Host ${requestedHost} is not enrolled in topology snapshot ${topology.topology_snapshot.projection_sha256 ?? "unavailable"}.`);
  }
  const opened = await openStateStore();
  try {
    const rows = listFleetConvergenceRows(opened.db, {
      ...(requestedHost ? { host: requestedHost } : {}),
    });
    const byHost = new Map<string, FleetConvergenceRow[]>();
    for (const row of rows) {
      const existing = byHost.get(row.host) ?? [];
      existing.push(row);
      byHost.set(row.host, existing);
    }
    const toLegs = (hostRows: FleetConvergenceRow[]): FleetStatusLeg[] => hostRows
      .sort((a, b) => a.leg.localeCompare(b.leg))
      .map((row) => ({
            leg: row.leg,
            verdict: row.verdict,
            policy: row.policy,
            target_rev: row.target_rev,
            observed_rev: row.observed_rev,
            converged_from: row.converged_from,
            last_checked_at: row.last_checked_at,
            ...(row.receipt_path !== null ? { receipt_path: row.receipt_path } : {}),
            ...(row.receipt_id !== null ? { receipt_id: row.receipt_id } : {}),
            ...(row.detail !== null ? { detail: row.detail } : {}),
          }));
    const hosts: FleetStatusHost[] = enrolledTargets
      .filter((target) => target.desired_membership === "active")
      .map((target) => {
        const hostRows = byHost.get(target.host) ?? [];
        const verdict = fleetStatusHostVerdict(hostRows);
        return {
          host: target.host,
          owner: target.owner,
          roles: target.roles,
          desired_membership: "active" as const,
          effective_state: verdict === "fresh"
            ? "active" as const
            : verdict === "missing"
              ? "unavailable" as const
              : "repair" as const,
          verdict,
          legs: toLegs(hostRows),
        };
      });
    const excludedWithdrawn = enrolledTargets
      .filter((target) => target.desired_membership === "withdrawn")
      .map((target) => {
        const hostRows = byHost.get(target.host) ?? [];
        return {
          host: target.host,
          owner: target.owner,
          roles: target.roles,
          desired_membership: "withdrawn" as const,
          effective_state: "withdrawn" as const,
          verdict: fleetStatusHostVerdict(hostRows),
          legs: toLegs(hostRows),
        };
      });
    const effectiveSummary = summarizeFleetRead(
      {
        ...topology,
        desired_active_total: hosts.length,
        withdrawn_total: excludedWithdrawn.length,
      },
      hosts.map((host) => host.effective_state),
    );
    const convergenceCounts = hosts.reduce<Record<FleetStatusVerdict, number>>(
      (counts, host) => {
        counts[host.verdict] += 1;
        return counts;
      },
      { fresh: 0, pending: 0, structural: 0, missing: 0 },
    );
    const summary: FleetStatusSummary = { ...effectiveSummary, ...convergenceCounts };
    return {
      schema_version: "fleet-convergence-status/v2",
      checked_at: checkedAt,
      ...topology,
      desired_active_total: hosts.length,
      withdrawn_total: excludedWithdrawn.length,
      hosts,
      excluded_withdrawn: excludedWithdrawn,
      summary,
    };
  } finally {
    opened.db.close();
  }
}

function formatFleetStatusText(result: FleetStatusResult): string {
  const lines = [
    formatFleetTopologyIdentity(result),
    "host | desired | effective | convergence | legs | last_checked",
  ];
  for (const host of result.hosts) {
    const lastChecked = host.legs
      .map((leg) => leg.last_checked_at)
      .sort()
      .at(-1) ?? "-";
    const legs = host.legs.length === 0
      ? "-"
      : host.legs.map((leg) => `${leg.leg}:${leg.verdict}`).join(",");
    lines.push([
      host.host,
      host.desired_membership,
      host.effective_state,
      host.verdict,
      legs,
      lastChecked,
    ].join(" | "));
  }
  lines.push("excluded_withdrawn:");
  for (const host of result.excluded_withdrawn) {
    const lastChecked = host.legs.map((leg) => leg.last_checked_at).sort().at(-1) ?? "-";
    const legs = host.legs.length === 0
      ? "-"
      : host.legs.map((leg) => `${leg.leg}:${leg.verdict}`).join(",");
    lines.push(`  ${host.host} | withdrawn | withdrawn | ${host.verdict} | ${legs} | ${lastChecked}`);
  }
  if (result.excluded_withdrawn.length === 0) lines.push("  none");
  lines.push(
    `summary fresh=${result.summary.fresh} pending=${result.summary.pending} structural=${result.summary.structural} missing=${result.summary.missing} active=${result.summary.active} repair=${result.summary.repair} unavailable=${result.summary.unavailable} desired_active_total=${result.summary.desired_active_total} withdrawn_total=${result.summary.withdrawn_total} green=${String(result.summary.green)}`,
  );
  return lines.join("\n");
}

function mapSkillProposalError(err: unknown): Error {
  if (err instanceof SkillProposalError) {
    const detail = [err.message, ...err.suggestions.map((s) => `  - ${s}`)].join("\n");
    return createCliError(detail, err.exitCode);
  }
  if (err instanceof StateDriverError) {
    return createCliError(err.message, 7);
  }
  if (err instanceof Error && (err as CliError).exitCode !== undefined) {
    return err;
  }
  return err instanceof Error ? err : new Error(String(err));
}

function emitProposalCreatedJson(
  result: Awaited<ReturnType<typeof createSkillProposalApi>>,
): void {
  emitCommandJsonResult("skills.propose", result);
}

function printProposalCreatedHuman(
  result: Awaited<ReturnType<typeof createSkillProposalApi>>,
): void {
  const p = result.proposal;
  console.log(p.proposal_id);
  console.error(`proposed:    ${p.proposal_id}\tkind=${p.kind}\ttarget=${p.target}`);
  console.error(`skill-id:    ${p.skill_id}`);
  if (p.target_source_path) {
    console.error(`source-path: ${p.target_source_path}  [source-root via ${result.source_root_source}]`);
  }
  if (p.summary) console.error(`summary:     ${p.summary}`);
  console.error(`status:      ${p.status}  (calyx skills proposals validate ${p.proposal_id})`);
}

function printProposalShowHuman(
  result: Awaited<ReturnType<typeof showSkillProposal>>,
): void {
  const p = result.proposal;
  console.log(p.proposal_id);
  console.error(`proposal:    ${p.proposal_id}`);
  console.error(`skill-id:    ${p.skill_id}`);
  console.error(`status:      ${p.status}`);
  console.error(`kind:        ${p.kind}`);
  console.error(`target:      ${p.target}`);
  if (p.source_root) console.error(`source-root: ${p.source_root}`);
  if (p.target_source_path) console.error(`source-path: ${p.target_source_path}`);
  if (p.relative_source_file) console.error(`rel-file:    ${p.relative_source_file}`);
  if (p.summary) console.error(`summary:     ${p.summary}`);
  if (p.author) console.error(`author:      ${p.author}`);
  if (p.origin_activity_id) console.error(`origin-act:  ${p.origin_activity_id}`);
  if (p.origin_message_id) console.error(`origin-msg:  ${p.origin_message_id}`);
  console.error(`created-at:  ${p.created_at}`);
  console.error(`updated-at:  ${p.updated_at}`);
  console.error("");
  console.error(`events (${result.events.length}):`);
  for (const ev of result.events) {
    console.error(
      `  #${ev.event_seq}\t${ev.occurred_at}\t${ev.event_type}\t${ev.status_before ?? "-"} -> ${ev.status_after}${ev.actor ? `\tactor=${ev.actor}` : ""}${ev.note ? `\t${ev.note}` : ""}`,
    );
  }
}

function printHealthHuman(report: StateHealthReport): void {
  console.error(`driver:        ${report.driver} (node>=${report.driverMinNode}; running ${report.nodeVersion})`);
  console.error(`state-dir:     ${report.paths.stateDir}  [source: ${report.paths.dirSource}]`);
  console.error(`db-path:       ${report.paths.dbPath}  [source: ${report.paths.source}]`);
  console.error(`journal-mode:  ${report.journalMode}`);
  console.error(`foreign-keys:  ${report.foreignKeysEnabled ? "ON" : "OFF"}`);
  console.error(`busy-timeout:  ${report.busyTimeoutMs}ms`);
  console.error(`schema:        current=${report.schemaVersion ?? "(none)"} target=${report.targetSchemaVersion ?? "(none)"} pending=${report.pendingMigrations}`);
  if (report.lastMigration) {
    console.error(`last-migration: ${report.lastMigration.id} ${report.lastMigration.description} @ ${report.lastMigration.appliedAt}`);
  } else {
    console.error("last-migration: (none)");
  }
  console.error(`dir-mode:      ${formatModeReport(report.directoryMode)}`);
  console.error(`db-mode:       ${formatModeReport(report.databaseMode)}`);
  console.error(`migration-consistency: ${report.migrationConsistency.status}${report.migrationConsistency.reason ? " — " + report.migrationConsistency.reason : ""}`);
}

function formatModeReport(report: FileModeReport): string {
  const mode = report.modeOctal ?? "????";
  const expected = report.expectedOctal;
  const status = report.status;
  const trailer = report.message ? ` (${report.message})` : "";
  return `${status} ${mode}/${expected}${trailer}`;
}

function printVaultStatusHuman(result: Awaited<ReturnType<typeof getVaultStatus>>): void {
  console.log(`Vault: ${result.vaultPath}`);
  console.log(`Total files: ${result.totalFiles}`);
  console.log("");

  for (const [label, count] of Object.entries(result.counts)) {
    if (count > 0) {
      console.log(`  ${label}: ${count}`);
    }
  }

  console.log("");
  console.log(`Sync provider: ${result.syncStatus.provider} (${result.syncStatus.health})`);
  if (result.syncStatus.available) {
    if (result.syncStatus.stdout?.trim()) {
      console.log(result.syncStatus.stdout.trim());
    }
    if (result.syncStatus.exitCode && result.syncStatus.stderr?.trim()) {
      console.error(result.syncStatus.stderr.trim());
    }
  }
  for (const warning of result.syncStatus.warnings) {
    console.log(`Sync warning: ${warning.message}`);
  }

  if (result.syncHygiene.attempted) {
    console.log("");
    if (result.syncHygiene.available) {
      const missing = result.syncHygiene.missingExcludedFolders;
      if (missing.length > 0) {
        console.log(`Sync hygiene: missing local-only exclusions: ${missing.join(", ")}`);
      } else {
        console.log("Sync hygiene: required local-only exclusions configured");
      }
      const trackedRows = result.syncHygiene.trackedPrefixes.filter(
        (row) => row.localFiles > 0 || row.serverFiles > 0 || row.pendingFiles > 0,
      );
      for (const row of trackedRows) {
        console.log(
          `  ${row.prefix}: local=${row.localFiles} server=${row.serverFiles} pending=${row.pendingFiles}`,
        );
      }
    } else {
      console.log(`Sync hygiene: unavailable (${result.syncHygiene.warnings[0]?.message ?? "no headless sync config"})`);
    }
  }
}

function printVaultFetchHuman(result: Awaited<ReturnType<typeof fetchVaultArtifact>>): void {
  console.error(`vault-uri: ${result.vaultUri}`);
  console.error(`relative-path: ${result.relativePath}`);
  console.error(`bytes: ${result.bytes.returnedBytes}/${result.bytes.totalBytes}${result.bytes.truncated ? " truncated" : ""}`);
  if (result.footnotes && result.footnotes.mode === "collapsed") {
    console.error(
      `footnotes: collapsed ${result.footnotes.collapsed_keys.length} keys, ${result.footnotes.elided_chars} chars elided (${result.footnotes.original_chars} -> ${result.footnotes.projected_chars} chars); recall_confidence=${result.footnotes.receipt.recall_confidence}`,
    );
  }
  console.log(result.text);
}

function printVaultRelatedHuman(result: Awaited<ReturnType<typeof relatedVaultArtifacts>>): void {
  console.log(`source: ${result.source.vaultUri}`);
  console.log(`relation: ${result.relation}`);
  console.log(`results: ${result.results.length}`);
  for (const match of result.results) {
    const title = match.title ? `\t${match.title}` : "";
    const evidence = match.evidence.length > 0 ? `\t${match.evidence.join("; ")}` : "";
    console.log(`${match.depth}\t${match.vaultUri}${title}${evidence}`);
  }
  if (result.bounds.omitted > 0) {
    console.error(`[calyx vault related] omitted ${result.bounds.omitted} result(s); raise --limit to inspect more.`);
  }
  for (const warning of result.warnings) {
    console.error(`[calyx vault related] warning: ${warning.code}: ${warning.message}`);
  }
}

function printRuntimeConfigHuman(result: RuntimeConfigResult): void {
  console.error(
    `[runtime-config] ${result.mode} host=${result.host} managed_configs_root=${result.managedConfigsRoot} live_home=${result.liveHome}`,
  );
  for (const item of result.items) {
    const icon = item.status === "ok" ? "OK" : item.status === "applied" ? "APPLIED" : "DRIFT";
    console.error(`[runtime-config] ${icon} ${item.component} -> ${item.targetPath}`);
    console.error(`[runtime-config]   staged=${item.stagedPath}`);
    if (!item.liveExists) {
      console.error("[runtime-config]   live target missing");
    }
    for (const change of item.changes) {
      console.error(`[runtime-config]   - ${change}`);
    }
    if (item.backupPath) {
      console.error(`[runtime-config]   backup=${item.backupPath}`);
    }
  }
  console.error(
    `[runtime-config] summary total=${result.summary.total} ok=${result.summary.ok} drift=${result.summary.drift} changed=${result.summary.changed} applied=${result.summary.applied}`,
  );
}

function collectOptionValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRuntimeConfigComponent(rawValue: string): RuntimeConfigComponent {
  const value = rawValue.trim().toLowerCase();
  if (value === "codex" || value === "claude-settings" || value === "claude-mcp") {
    return value;
  }
  throw createCliError(
    `Invalid --component value for runtime-config: ${String(rawValue)}. Must be one of: codex, claude-settings, claude-mcp.`,
    2,
  );
}

function parseExecPlanKind(rawValue?: string): KnowledgeExecPlanKind | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim().toLowerCase();
  if (value === "implementation" || value === "planning" || value === "research") {
    return value;
  }
  throw createCliError(
    `Invalid --kind value for knowledge execplan new: ${String(rawValue)}. Must be one of: implementation, planning, research.`,
    2,
  );
}

function parseExecPlanState(rawValue?: string): KnowledgeExecPlanState | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim().toLowerCase();
  if (
    value === "draft"
    || value === "ready"
    || value === "in_progress"
    || value === "done"
    || value === "blocked"
    || value === "superseded"
  ) {
    return value;
  }
  throw createCliError(
    `Invalid --state value for knowledge execplan new: ${String(rawValue)}. Must be one of: draft, ready, in_progress, done, blocked, superseded.`,
    2,
  );
}

function parseExecPlanRunnerHarness(rawValue?: string): KnowledgeExecPlanRunnerHarness | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim().toLowerCase();
  if (value === "codex-cli" || value === "claude-code" || value === "human") {
    return value;
  }
  throw createCliError(
    `Invalid --runner-harness value for knowledge execplan new: ${String(rawValue)}. Must be one of: codex-cli, claude-code, human.`,
    2,
  );
}

function parseExecPlanRunnerMode(rawValue?: string): KnowledgeExecPlanRunnerMode | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim().toLowerCase();
  if (value === "interactive" || value === "exec") {
    return value;
  }
  throw createCliError(
    `Invalid --runner-mode value for knowledge execplan new: ${String(rawValue)}. Must be one of: interactive, exec.`,
    2,
  );
}

function parseExecutionKernel(rawValue?: string): ExecutionKernelId {
  const value = (rawValue ?? "agent_runner").trim().toLowerCase();
  if (value === "agent_runner" || value === "host_process") {
    return value;
  }
  throw createCliError(
    `Invalid --kernel value for run launch: ${String(rawValue)}. Must be one of: agent_runner, host_process.`,
    2,
  );
}

function parseRunnerBackend(rawValue?: string): SupportedBackend {
  const value = (rawValue ?? "claude").trim().toLowerCase();
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw createCliError(`Invalid --backend value for run launch: ${rawValue}. Must be one of: claude, codex.`, 2);
}

function formatReasoningEffortValues(values: readonly string[]): string {
  return values.join(", ");
}

function parseReasoningEffort(rawValue: string | undefined, backend: SupportedBackend): BackendReasoningEffort | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const value = rawValue.trim().toLowerCase();
  const allowedValues = backend === "codex" ? CODEX_BACKEND_REASONING_EFFORTS : CLAUDE_BACKEND_REASONING_EFFORTS;
  if ((allowedValues as readonly string[]).includes(value)) {
    return value as BackendReasoningEffort;
  }
  throw createCliError(
    [
      `Invalid --reasoning-effort value for run launch with backend ${backend}: ${String(rawValue)}.`,
      `${backend === "codex" ? "Codex" : "Claude"} accepts: ${formatReasoningEffortValues(allowedValues)}.`,
      `Select --backend ${backend === "codex" ? "claude" : "codex"} to use that backend's effort vocabulary.`,
    ].join(" "),
    2,
  );
}

function looksLikeBackendModelProfile(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (normalized.startsWith("claude-") && /(opus|sonnet|haiku)/.test(normalized))
    || /(^|[-_.])(opus|sonnet|haiku)([-_.0-9]|$)/.test(normalized)
    || /^(opus|sonnet|haiku)([-_.0-9]|$)/.test(normalized);
}

function parseBackendModel(
  rawValue: string | undefined,
  backend: SupportedBackend,
  profile: string | undefined,
): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    const profileValue = profile?.trim();
    if (profileValue && looksLikeBackendModelProfile(profileValue)) {
      throw createCliError(
        [
          `--profile ${JSON.stringify(profileValue)} looks like a backend model selector, but --profile is not applied to the spawned CLI.`,
          "Use --model <model> to select a Claude model explicitly.",
        ].join(" "),
        2,
      );
    }
    return undefined;
  }
  if (backend !== "claude") {
    throw createCliError(
      `--model is currently supported for --backend claude only; got --backend ${backend}.`,
      2,
    );
  }
  return value;
}

function parsePositiveInteger(rawValue: string, flagName: string): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createCliError(`Invalid ${flagName} value: ${rawValue}. Must be a positive integer.`, 2);
  }
  return parsed;
}

function parseMonitorLimit(rawValue: string | undefined, flagName = "--limit"): number | undefined {
  return rawValue ? parsePositiveInteger(rawValue, flagName) : undefined;
}

function parseMonitorProvenance(rawValue: string | undefined): MonitorCreateProvenance {
  const value = (rawValue ?? "operator").trim();
  if (value === "operator" || value === "conductor") {
    return value;
  }
  throw createCliError(
    "monitor create is restricted to conductor/operator provenance in v1.",
    2,
  );
}

function parseMonitorRearmPolicy(rawValue: string | undefined): MonitorRearmPolicy {
  const value = (rawValue ?? "every_change").trim();
  if (value === "once" || value === "rearm_on_reset" || value === "every_change") {
    return value;
  }
  throw createCliError(
    `Invalid --rearm value: ${value}. Expected once, rearm_on_reset, or every_change.`,
    2,
  );
}

function parseMonitorWakeStatus(rawValue: string | undefined): MonitorWakeStatus | "all" {
  const value = (rawValue ?? "pending").trim();
  if (value === "pending" || value === "claimed" || value === "acked" || value === "all") {
    return value;
  }
  throw createCliError(
    `Invalid --status value: ${value}. Expected pending, claimed, acked, or all.`,
    2,
  );
}

function parseMonitorStatus(rawValue: string | undefined): "active" | "cancelled" | "all" {
  const value = (rawValue ?? "active").trim();
  if (value === "active" || value === "cancelled" || value === "all") {
    return value;
  }
  throw createCliError(
    `Invalid --status value: ${value}. Expected active, cancelled, or all.`,
    2,
  );
}

function collectMonitorDeliveryOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function buildMonitorDeliveryPolicyFromOptions(
  options: MonitorCreateCommandOptions,
) {
  const rawBindings = options.deliver ?? [];
  if (rawBindings.length > 0) {
    return createMonitorDeliveryPolicy(
      rawBindings.map((raw, index) => parseMonitorDeliveryBinding(raw, index)),
    );
  }
  if (options.defaultDeliveries === false) {
    return defaultMonitorDeliveryBinding();
  }
  return defaultRunnerSupervisionDeliveryBinding();
}

function parseMonitorDeliveryBinding(
  rawValue: string,
  index: number,
): MonitorDeliveryAdapterBindingV1 {
  const raw = rawValue.trim();
  if (!raw) {
    throw createCliError("--deliver value must be non-empty.", 2);
  }
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const first = parts.shift();
  if (!first) {
    throw createCliError("--deliver value must start with an adapter.", 2);
  }
  const { adapter, shorthand } = parseMonitorDeliveryAdapterToken(first);
  const fields = parseKeyValueFields(parts, "--deliver");
  const materiality = parseMonitorDeliveryMateriality(fields["materiality"]);
  const bindingId = fields["id"] ?? fields["binding_id"] ?? `${adapter}-${materiality}-${index + 1}`;
  const binding: MonitorDeliveryAdapterBindingV1 = {
    schema_version: MONITOR_DELIVERY_SCHEMA_VERSION,
    binding_id: bindingId,
    adapter,
    materiality: {
      schema_version: "calyx.monitor-materiality/v1",
      kind: materiality,
    },
  };
  const dryRun = parseOptionalBoolean(fields["dry_run"]);

  if (adapter === "ntfy") {
    binding.ntfy = {
      ...(fields["topic"] ?? shorthand ? { topic: fields["topic"] ?? shorthand } : {}),
      ...(fields["url"] ? { url: fields["url"] } : {}),
      ...(fields["priority"] ? { priority: parseNtfyPriority(fields["priority"]) } : {}),
    };
  } else if (adapter === "linear_comment") {
    binding.linear_comment = {
      ...(fields["issue"] ?? fields["issue_id"] ?? shorthand ? { issue_id: fields["issue"] ?? fields["issue_id"] ?? shorthand } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
    };
  } else if (adapter === "vault_receipt") {
    binding.vault_receipt = {
      ...(fields["root"] ?? fields["vault_root"] ?? shorthand ? { vault_root: fields["root"] ?? fields["vault_root"] ?? shorthand } : {}),
      ...(fields["directory"] ?? fields["dir"] ? { directory: fields["directory"] ?? fields["dir"] } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
    };
  } else if (adapter === "codex_automation") {
    binding.codex_automation = {
      ...(fields["home"] ?? fields["codex_home"] ? { codex_home: fields["home"] ?? fields["codex_home"] } : {}),
      ...(fields["automation"] ?? fields["automation_id"] ? { automation_id: fields["automation"] ?? fields["automation_id"] } : {}),
      ...(fields["thread"] ?? fields["thread_id"] ?? shorthand ? { thread_id: fields["thread"] ?? fields["thread_id"] ?? shorthand } : {}),
      ...(fields["cwd"] ? { cwd: fields["cwd"] } : {}),
      ...(fields["name"] ? { name: fields["name"] } : {}),
      ...(fields["rrule"] ? { rrule: fields["rrule"] } : {}),
      ...(fields["status"] ? { status: parseCodexAutomationStatus(fields["status"]) } : {}),
      ...(fields["model"] ? { model: fields["model"] } : {}),
      ...(fields["effort"] ?? fields["reasoning_effort"] ? { reasoning_effort: parseCodexReasoningEffort(fields["effort"] ?? fields["reasoning_effort"]!) } : {}),
      ...(fields["execution_environment"] ?? fields["environment"] ? { execution_environment: parseCodexExecutionEnvironment(fields["execution_environment"] ?? fields["environment"]!) } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
      ...(fields["allow_update"] !== undefined ? { allow_update: parseOptionalBoolean(fields["allow_update"]) } : {}),
    };
  } else if (adapter === "codex_app_server_steer") {
    binding.codex_app_server_steer = {
      ...(fields["run"] ?? fields["run_id"] ?? shorthand ? { run_id: fields["run"] ?? fields["run_id"] ?? shorthand } : {}),
      ...(fields["live_binding"] ?? fields["live_binding_id"] ? { live_binding_id: fields["live_binding"] ?? fields["live_binding_id"] } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
      ...(fields["timeout_ms"] ? { timeout_ms: parsePositiveInteger(fields["timeout_ms"], "--deliver timeout_ms") } : {}),
    };
  } else if (adapter === "claude_reinvoke") {
    binding.claude_reinvoke = {
      ...(fields["command"] ?? shorthand ? { command: fields["command"] ?? shorthand } : {}),
      ...(fields["cwd"] ? { cwd: fields["cwd"] } : {}),
      ...(fields["session"] ?? fields["session_id"] ? { session_id: fields["session"] ?? fields["session_id"] } : {}),
      ...(fields["continue"] !== undefined ? { continue_latest: parseOptionalBoolean(fields["continue"]) } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
      ...(fields["timeout_ms"] ? { timeout_ms: parsePositiveInteger(fields["timeout_ms"], "--deliver timeout_ms") } : {}),
      ...(fields["model"] ? { model: fields["model"] } : {}),
      ...(fields["permission_mode"] ? { permission_mode: parseClaudePermissionMode(fields["permission_mode"]) } : {}),
      ...(fields["allowed_tools"] ? { allowed_tools: parseDelimitedList(fields["allowed_tools"]) } : {}),
    };
  } else {
    const channel = fields["channel"] ?? fields["target"] ?? fields["channel_target"] ?? shorthand;
    binding.claude_channel = {
      ...(fields["url"] ?? fields["receiver_url"] ?? fields["endpoint"] ? { receiver_url: fields["url"] ?? fields["receiver_url"] ?? fields["endpoint"] } : {}),
      ...(channel ? { channel: parseClaudeChannelTarget(channel) } : {}),
      ...(fields["token_env"] ? { token_env: fields["token_env"] } : {}),
      ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
      ...(fields["timeout_ms"] ? { timeout_ms: parsePositiveInteger(fields["timeout_ms"], "--deliver timeout_ms") } : {}),
    };
  }

  if (fields["window_ms"]) {
    binding.digest = {
      mode: "debounced",
      window_ms: parsePositiveInteger(fields["window_ms"], "--deliver window_ms"),
    };
  }
  if (fields["enabled"] !== undefined) {
    binding.enabled = parseOptionalBoolean(fields["enabled"]);
  }
  return binding;
}

function parseMonitorDeliveryAdapterToken(rawValue: string): {
  adapter: MonitorDeliveryAdapterV1;
  shorthand?: string | undefined;
} {
  const separatorIndex = rawValue.indexOf(":");
  const adapterRaw = separatorIndex === -1 ? rawValue : rawValue.slice(0, separatorIndex);
  const shorthand = separatorIndex === -1 ? undefined : rawValue.slice(separatorIndex + 1).trim();
  const adapter = adapterRaw.trim();
  if (
    adapter === "ntfy"
    || adapter === "linear_comment"
    || adapter === "vault_receipt"
    || adapter === "codex_automation"
    || adapter === "codex_app_server_steer"
    || adapter === "claude_reinvoke"
    || adapter === "claude_channel"
  ) {
    return { adapter, ...(shorthand ? { shorthand } : {}) };
  }
  throw createCliError(
    `Invalid --deliver adapter: ${adapter}. Expected ntfy, linear_comment, vault_receipt, codex_automation, codex_app_server_steer, claude_reinvoke, or claude_channel.`,
    2,
  );
}

function parseMonitorDeliveryMateriality(
  rawValue: string | undefined,
): MonitorDeliveryMaterialityKindV1 {
  const value = rawValue?.trim() || "always";
  if (
    value === "always"
    || value === "run_failed_or_stalled"
    || value === "run_success"
    || value === "artifact_churn"
  ) {
    return value;
  }
  throw createCliError(
    `Invalid --deliver materiality: ${value}. Expected always, run_failed_or_stalled, run_success, or artifact_churn.`,
    2,
  );
}

function parseNtfyPriority(
  rawValue: string,
): "min" | "low" | "default" | "high" | "urgent" {
  const value = rawValue.trim();
  if (value === "min" || value === "low" || value === "default" || value === "high" || value === "urgent") {
    return value;
  }
  throw createCliError(
    `Invalid ntfy priority: ${value}. Expected min, low, default, high, or urgent.`,
    2,
  );
}

function parseCodexAutomationStatus(rawValue: string): "ACTIVE" | "PAUSED" {
  const value = rawValue.trim().toUpperCase();
  if (value === "ACTIVE" || value === "PAUSED") return value;
  throw createCliError(`Invalid Codex automation status: ${rawValue}. Expected ACTIVE or PAUSED.`, 2);
}

function parseCodexReasoningEffort(
  rawValue: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const value = rawValue.trim();
  if (
    value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
  ) {
    return value;
  }
  throw createCliError(`Invalid Codex reasoning effort: ${rawValue}. Expected none, minimal, low, medium, high, or xhigh.`, 2);
}

function parseCodexExecutionEnvironment(rawValue: string): "local" | "sandbox" {
  const value = rawValue.trim();
  if (value === "local" || value === "sandbox") return value;
  throw createCliError(`Invalid Codex execution environment: ${rawValue}. Expected local or sandbox.`, 2);
}

function parseClaudePermissionMode(
  rawValue: string,
): "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan" {
  const value = rawValue.trim();
  if (
    value === "acceptEdits"
    || value === "auto"
    || value === "bypassPermissions"
    || value === "default"
    || value === "dontAsk"
    || value === "plan"
  ) {
    return value;
  }
  throw createCliError(
    `Invalid Claude permission mode: ${rawValue}. Expected acceptEdits, auto, bypassPermissions, default, dontAsk, or plan.`,
    2,
  );
}

function parseClaudeChannelTarget(rawValue: string): string {
  const value = rawValue.trim();
  if (value.startsWith("server:") || value.startsWith("plugin:")) return value;
  throw createCliError(
    `Invalid Claude channel target: ${rawValue}. Expected server:<name> or plugin:<name>.`,
    2,
  );
}

function parseDelimitedList(rawValue: string): string[] {
  return rawValue.split("|").map((part) => part.trim()).filter(Boolean);
}

function parseOptionalBoolean(rawValue: string | undefined): boolean | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw createCliError(`Invalid boolean value: ${rawValue}. Expected true or false.`, 2);
}

function parseKeyValueFields(
  parts: string[],
  flagName: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals <= 0) {
      throw createCliError(`${flagName} fields must use key=value: ${part}`, 2);
    }
    const key = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (!key || !value) {
      throw createCliError(`${flagName} fields must use non-empty key=value pairs: ${part}`, 2);
    }
    fields[key] = value;
  }
  return fields;
}

function defaultMonitorActor(): string {
  const user = process.env["USER"]?.trim() || process.env["LOGNAME"]?.trim() || "operator";
  return `${user}@${systemHostname().split(".")[0] ?? "localhost"}`;
}

function defaultMonitorHost(): string {
  return systemHostname().split(".")[0]?.toLowerCase() ?? systemHostname().toLowerCase();
}

function normalizeMonitorHost(value: string | undefined): string {
  const normalized = value?.trim().split(".")[0]?.toLowerCase() ?? "";
  // `local` is a run-target alias, not a hostname. Storing the literal would
  // produce a row no evaluator ever matches (the POL-1788 silent-no-op class),
  // so map it to the actual local hostname at the boundary.
  return normalized === "local" ? defaultMonitorHost() : normalized;
}

async function withMonitorState<T>(
  fn: (opened: Awaited<ReturnType<typeof openStateStore>>) => T | Promise<T>,
): Promise<T> {
  const opened = await openStateStore();
  try {
    const schema = checkMonitorSchema(opened.db);
    if (schema.status !== "ok") {
      const detail = schema.findings.map((finding) => finding.detail).join("; ");
      throw createCliError(
        `monitor state schema is unavailable; run \`calyx state migrate --apply\`.${detail ? ` ${detail}` : ""}`,
        4,
      );
    }
    return await fn(opened);
  } finally {
    opened.db.close();
  }
}

async function assertKnownRemoteMonitorHost(host: string, deps: RunCliDependencies): Promise<void> {
  if (!host || isLocalRunTarget(host, { hostname: () => systemHostname() })) {
    return;
  }
  const hostsTruth = await readRunServeHostsTruth(deps);
  const knownHosts = Object.keys(hostsTruth.hosts ?? {}).sort();
  if (knownHosts.length === 0 || knownHosts.includes(host)) {
    return;
  }
  throw createCliError(
    `monitor_unknown_host: unknown host "${host}". Known hosts: ${knownHosts.join(", ")}.`,
    2,
  );
}

function formatMonitorSshFallback(host: string, monitorArgs: string[]): string {
  const remoteCommand = ["~/.agents/run/calyx", "monitor", ...monitorArgs]
    .map((part, index) => index === 0 ? part : quoteCommandArg(part))
    .join(" ");
  return `ssh ${quoteCommandArg(host)} ${quoteCommandArg(remoteCommand)}`;
}

async function resolveRemoteMonitorAccess(
  options: {
    host: string | undefined;
    serverUrl?: string | undefined;
    authToken?: string | undefined;
    action: string;
    fallbackArgs: string[];
    requiredFeatures?: readonly CalyxDaemonFeature[];
  },
  deps: RunCliDependencies,
): Promise<{ host: string; serverUrl: string; token: string; fallback: string } | undefined> {
  const host = normalizeMonitorHost(options.host);
  const explicitServerUrl = options.serverUrl?.trim();
  const useRemote = Boolean(explicitServerUrl) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));
  if (!useRemote) {
    return undefined;
  }

  if (host) {
    await assertKnownRemoteMonitorHost(host, deps);
  }
  const target = host || "127.0.0.1";
  const fallback = formatMonitorSshFallback(target, options.fallbackArgs);
  const access = await resolveRunServerAccess({
    ...(host ? { host } : {}),
    serverUrl: explicitServerUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `monitor_remote_auth_missing: remote monitor ${options.action} for ${target} requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}. Fallback: ${fallback}`,
      2,
    );
  }
  const { serverUrl, token } = access;

  let health: CalyxDaemonHealth;
  try {
    health = await remoteAdminHealth(deps, { serverUrl, token }, `monitor remote ${options.action} health`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("auth_failure")) {
      throw createCliError(
        `monitor_remote_auth_failed: daemon for ${target} rejected the bearer token. Fallback: ${fallback}`,
        2,
      );
    }
    throw createCliError(
      `monitor_remote_unreachable: daemon for ${target} is unreachable. Fallback: ${fallback}`,
      6,
    );
  }
  const refusal = getDaemonCompatibilityRefusal(
    target,
    health,
    [
      CALYX_DAEMON_FEATURES.monitorRemoteV1,
      ...(options.requiredFeatures ?? []),
    ],
  );
  if (refusal) {
    throw createCliError(
      `monitor_remote_unsupported: ${refusal.message} Fallback: ${fallback}`,
      6,
    );
  }
  return { host: target, serverUrl, token, fallback };
}

async function assertLocalRunnerSupervisionRunKnown(
  runId: string,
  host: string,
  deps: RunCliDependencies,
): Promise<void> {
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  const record = await service.getRunRecord(runId);
  if (!record) {
    throw createCliError(
      `monitor_run_unknown: runner-supervision run "${runId}" is not resolvable in ${host}'s run store. Run \`calyx run ps --host ${host}\` and recreate the monitor with the correct --assigned-host.`,
      4,
    );
  }
}

async function requestRemoteMonitor<T, Code extends string>(
  deps: RunCliDependencies,
  remote: { host: string; serverUrl: string; token: string; fallback: string },
  options: {
    action: string;
    recoverable?: boolean;
    reconciliationCommand?: string;
    operation: (client: CalyxAdminClient) => Promise<CalyxResult<T, Code>>;
  },
): Promise<T> {
  try {
    if (options.recoverable) {
      return await executeRecoverableMutation(deps, remote, {
        context: `monitor remote ${options.action}`,
        replayCommand: "calyx client replay",
        operation: options.operation,
      });
    }
    return requireClientResult(
      await options.operation(remoteAdminClient(deps, remote)),
      `monitor remote ${options.action}`,
      options.reconciliationCommand,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("activity_owner_unreachable")) {
      throw createCliError(
        `monitor_remote_unreachable: daemon for ${remote.host} is unreachable. Fallback: ${remote.fallback}`,
        6,
      );
    }
    throw error;
  }
}

interface LeaseCommonCommandOptions {
  coordinatorHost?: string;
  serverUrl?: string;
  authToken?: string;
  idempotencyKey?: string;
  json?: boolean;
}

interface LeaseAcquireCommandOptions extends LeaseCommonCommandOptions {
  holder?: string;
  ttlMs?: string;
}

interface LeaseRenewCommandOptions extends LeaseCommonCommandOptions {
  holder?: string;
  ttlMs?: string;
}

interface LeaseReleaseCommandOptions extends LeaseCommonCommandOptions {
  holder?: string;
  force?: boolean;
}

interface LeaseStealCommandOptions extends LeaseCommonCommandOptions {
  holder?: string;
  ttlMs?: string;
  provenance?: string;
}

interface LeaseListCommandOptions extends LeaseCommonCommandOptions {
  holder?: string;
  kind?: string;
  ownerHost?: string;
  includeExpired?: boolean;
  limit?: string;
}

function defaultLeaseCoordinatorHost(): string {
  return process.env["CALYX_COORDINATOR_HOST"]?.trim() || "blade";
}

function normalizeLeaseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\..*$/, "");
}

function parseLeaseTtlMs(rawValue: string | undefined, fallback = 30 * 60 * 1000): number {
  return rawValue ? parsePositiveInteger(rawValue, "--ttl-ms") : fallback;
}

function parseLeaseLimit(rawValue: string | undefined): number | undefined {
  return rawValue ? parsePositiveInteger(rawValue, "--limit") : undefined;
}

function parseLeaseKind(rawValue: string | undefined): LeaseResourceKind | undefined {
  if (!rawValue) return undefined;
  const value = rawValue.trim();
  if ((LEASE_RESOURCE_KINDS as readonly string[]).includes(value)) {
    return value as LeaseResourceKind;
  }
  throw createCliError(`Invalid --kind value: ${rawValue}. Expected one of: ${LEASE_RESOURCE_KINDS.join(", ")}.`, 2);
}

function requireLeaseHolder(rawValue: string | undefined): string {
  const value = rawValue?.trim();
  if (!value) {
    throw createCliError("lease mutation requires --holder <activity-id>.", 2);
  }
  return value;
}

async function withLeaseState<T>(
  fn: (opened: Awaited<ReturnType<typeof openStateStore>>) => T | Promise<T>,
): Promise<T> {
  await applyStateMigrations();
  const opened = await openStateStore();
  try {
    const schema = checkLeaseSchema(opened.db);
    if (schema.status !== "ok") {
      const detail = schema.findings.map((finding) => finding.detail).join("; ");
      throw createCliError(
        `lease state schema is unavailable; run \`calyx state migrate --apply\`.${detail ? ` ${detail}` : ""}`,
        4,
      );
    }
    return await fn(opened);
  } finally {
    opened.db.close();
  }
}

async function resolveLeaseCurrentHost(deps: RunCliDependencies): Promise<string> {
  if (deps.currentHostAlias?.trim()) {
    return normalizeLeaseHost(deps.currentHostAlias);
  }
  try {
    return normalizeLeaseHost(await resolveCurrentHostAlias(undefined, deps.agentsInfraRoot));
  } catch {
    return normalizeLeaseHost(systemHostname());
  }
}

async function resolveLeaseOwnerRouting(
  key: string,
  options: LeaseCommonCommandOptions,
  deps: RunCliDependencies,
): Promise<{ ownerHost: string; local: boolean; serverUrl?: string; token?: string }> {
  const ownerHost = parseLeaseKey(key, {
    coordinator_host: options.coordinatorHost?.trim() || defaultLeaseCoordinatorHost(),
  }).owner_host;
  const currentHost = await resolveLeaseCurrentHost(deps);
  const explicitServerUrl = options.serverUrl?.trim();
  const local = !explicitServerUrl && normalizeLeaseHost(ownerHost) === currentHost;
  if (local) {
    return { ownerHost, local: true };
  }
  const access = await resolveRunServerAccess({
    host: ownerHost,
    serverUrl: explicitServerUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `lease ${key} is owned by ${ownerHost}; set --auth-token or ${RUN_SERVER_CREDENTIAL_HINT} so the owning host daemon can accept the write.`,
      2,
    );
  }
  return { ownerHost, local: false, serverUrl: access.serverUrl, token: access.token };
}

function formatLeaseConflict(result: { conflict?: { message: string; lease?: LeaseRow | undefined } | undefined }): string {
  const conflict = result.conflict;
  if (!conflict) return "lease mutation failed";
  const lease = conflict.lease;
  if (!lease) return conflict.message;
  return [
    conflict.message,
    `key=${lease.key}`,
    `holder=${lease.holder_activity_id}`,
    `owner_host=${lease.owner_host}`,
    `acquired_at=${lease.acquired_at}`,
    `expires_at=${lease.expires_at}`,
  ].join("\n");
}

function printLeaseRows(rows: readonly LeaseRow[]): void {
  if (rows.length === 0) {
    console.log("no leases");
    return;
  }
  for (const row of rows) {
    console.log(`${row.key}  holder=${row.holder_activity_id}  owner=${row.owner_host}  expires=${row.expires_at}`);
  }
}

function printLeaseMutation(label: string, payload: unknown, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const lease = payload && typeof payload === "object" && "lease" in payload
    ? (payload as { lease?: LeaseRow }).lease
    : undefined;
  if (!lease) {
    console.log(label);
    return;
  }
  console.log(`${label}: ${lease.key}`);
  console.log(`  holder: ${lease.holder_activity_id}`);
  console.log(`  owner_host: ${lease.owner_host}`);
  console.log(`  expires_at: ${lease.expires_at}`);
}

function leaseStealNotificationPayload(result: LeaseStealResult): {
  status: "not_needed" | "receipt_only";
  detail: string;
  previous_holder_activity_id?: string;
} {
  if (!result.previous_lease) {
    return {
      status: "not_needed",
      detail: "no previous holder was present",
    };
  }
  return {
    status: "receipt_only",
    detail: "`calyx msg` is not present in this build; steal notification is recorded in the lease result only.",
    previous_holder_activity_id: result.previous_lease.holder_activity_id,
  };
}

function printMonitorObject(label: string, value: unknown, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "object" && value !== null && "monitor" in value) {
    const monitor = (value as { monitor: { monitor_id: string; status: string; preset?: string | null; source_run_id?: string | null } }).monitor;
    console.log(`${label}: ${monitor.monitor_id}`);
    console.log(`  status: ${monitor.status}`);
    if (monitor.preset) console.log(`  preset: ${monitor.preset}`);
    if (monitor.source_run_id) console.log(`  run: ${monitor.source_run_id}`);
    if ("owner_host" in value && typeof (value as { owner_host?: unknown }).owner_host === "string") {
      console.log(`  host: ${(value as { owner_host: string }).owner_host}`);
    }
    if ("note" in value && typeof (value as { note?: unknown }).note === "string") {
      console.log(`  note: ${(value as { note: string }).note}`);
    }
    printMonitorDeliverySummary((value as { delivery_state?: unknown }).delivery_state, "  ");
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function monitorDeliveryState(deliveries: MonitorDeliveryRow[]): {
  count: number;
  counts: { attempted: number; delivered: number; failed: number };
  deliveries: MonitorDeliveryRow[];
} {
  const counts = { attempted: 0, delivered: 0, failed: 0 };
  for (const delivery of deliveries) {
    counts[delivery.status] += 1;
  }
  return { count: deliveries.length, counts, deliveries };
}

function printMonitorDeliverySummary(value: unknown, indent = ""): void {
  if (!isMonitorDeliveryStateSummary(value)) return;
  console.log(
    `${indent}deliveries: ${value.count} (attempted=${value.counts.attempted}, delivered=${value.counts.delivered}, failed=${value.counts.failed})`,
  );
}

function isMonitorDeliveryStateSummary(value: unknown): value is {
  count: number;
  counts: { attempted: number; delivered: number; failed: number };
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { count?: unknown; counts?: unknown };
  if (typeof candidate.count !== "number") return false;
  if (typeof candidate.counts !== "object" || candidate.counts === null) return false;
  const counts = candidate.counts as Record<string, unknown>;
  return (
    typeof counts["attempted"] === "number"
    && typeof counts["delivered"] === "number"
    && typeof counts["failed"] === "number"
  );
}

function printMonitorRows(
  rows: Array<{ monitor_id: string; status: string; preset: string | null; source_run_id: string | null; last_wake_id: string | null }>,
): void {
  if (rows.length === 0) {
    console.log("no monitors");
    return;
  }
  for (const row of rows) {
    console.log(`${row.monitor_id}  ${row.status}  ${row.preset ?? "-"}  ${row.source_run_id ?? "-"}  last_wake=${row.last_wake_id ?? "-"}`);
  }
}

function printMonitorWakeRows(
  rows: Array<{ wake_id: string; monitor_id: string; status: string; created_at: string; transition_hash: string }>,
): void {
  if (rows.length === 0) {
    console.log("no wake records");
    return;
  }
  for (const row of rows) {
    console.log(`${row.wake_id}  ${row.status}  ${row.monitor_id}  ${row.created_at}  ${row.transition_hash.slice(0, 12)}`);
  }
}

async function withMessageState<T>(
  fn: (opened: Awaited<ReturnType<typeof openStateStore>>) => T | Promise<T>,
): Promise<T> {
  const opened = await openStateStore();
  try {
    const schema = checkMessageSchema(opened.db);
    if (schema.status !== "ok") {
      const detail = schema.findings.map((finding) => finding.detail).join("; ");
      throw createCliError(
        `message state schema is unavailable; run \`calyx state migrate --apply\`.${detail ? ` ${detail}` : ""}`,
        4,
      );
    }
    return await fn(opened);
  } finally {
    opened.db.close();
  }
}

function parseMessageUrgency(rawValue: string | undefined): MessageUrgency {
  const value = rawValue?.trim() || "normal";
  if ((MESSAGE_URGENCIES as readonly string[]).includes(value)) {
    return value as MessageUrgency;
  }
  throw createCliError(`--urgency must be one of: ${MESSAGE_URGENCIES.join(", ")}.`, 2);
}

function normalizeHostForMsg(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\..*$/, "") ?? "";
}

function cliHostname(deps: RunCliDependencies): string {
  return deps.hostname ? deps.hostname() : systemHostname();
}

async function currentMessageHost(deps: RunCliDependencies): Promise<string> {
  if (deps.currentHostAlias?.trim()) {
    return deps.currentHostAlias.trim();
  }
  try {
    const agentsInfraRoot = await resolveAgentsInfraRoot();
    const host = await resolveCurrentHostAlias(undefined, agentsInfraRoot);
    if (host.trim()) return host.trim();
  } catch {
    // Fall back to the same local hostname helper monitors use.
  }
  const hostname = cliHostname(deps);
  return hostname.split(".")[0]?.toLowerCase() ?? hostname.toLowerCase();
}

function isLocalMessageHost(
  targetHost: string | null | undefined,
  currentHost: string,
  deps: RunCliDependencies,
): boolean {
  const target = normalizeHostForMsg(targetHost);
  if (!target) return true;
  const current = normalizeHostForMsg(currentHost);
  const osHost = deps.currentHostAlias?.trim()
    ? ""
    : normalizeHostForMsg(cliHostname(deps));
  return target === current || target === osHost || target === "localhost" || target === "127.0.0.1";
}

function defaultActivityActor(explicitActor?: string | undefined): string {
  const explicit = explicitActor?.trim();
  if (explicit) return explicit;
  const activityId = process.env["CALYX_ACTIVITY_ID"]?.trim();
  if (activityId) return activityId;
  const identity = resolveActivitySelfIdentity();
  if (identity) {
    return fallbackInteractiveActivityId(identity.backend, identity.sessionId);
  }
  return defaultMonitorActor();
}

async function readMsgBody(options: MsgSendCommandOptions): Promise<string> {
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw createCliError("Pass only one of --body or --body-file.", 2);
  }
  if (options.bodyFile) {
    return readFile(resolvePath(options.bodyFile), "utf8");
  }
  return options.body ?? "";
}

function resolveMsgExpiry(
  options: MsgSendCommandOptions,
  resolved: ResolvedMessageAddress,
): string | null {
  if (options.ttlMs && options.expiresAt) {
    throw createCliError("Pass only one of --ttl-ms or --expires-at.", 2);
  }
  if (options.ttlMs) {
    const ttlMs = parsePositiveInteger(options.ttlMs, "--ttl-ms");
    return new Date(Date.now() + ttlMs).toISOString();
  }
  const expiresAt = options.expiresAt?.trim() || null;
  if (resolved.recipient_class === "scope" && !expiresAt) {
    throw createCliError("scope messages require --ttl-ms or --expires-at.", 2);
  }
  return expiresAt;
}

function messageThreadKey(options: MsgSendCommandOptions, subject: string): string {
  const explicit = options.thread?.trim();
  if (explicit) return explicit;
  const replyTo = options.replyTo?.trim();
  if (replyTo) return replyTo;
  return subject.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
}

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function inferReplyRecipient(message: MessageRow, sender: string, explicit?: string | undefined): {
  address: string;
  inferred: boolean;
  reason: string;
} {
  const requested = explicit?.trim();
  if (requested) {
    return { address: requested, inferred: false, reason: "--to" };
  }
  if (sender === message.sender) {
    return {
      address: message.recipient_address,
      inferred: true,
      reason: "sender_matches_original_sender",
    };
  }
  return {
    address: message.sender,
    inferred: true,
    reason: "default_to_original_sender",
  };
}

async function createMessageWithReceipt(
  input: Parameters<typeof createMessage>[1],
  options: {
    outbox?: {
      target_host: string;
      payload?: Record<string, unknown> | undefined;
    } | undefined;
  } = {},
): Promise<{
  message: MessageRow;
  inserted: boolean;
  receipt_path: string | null;
  outbox?: ReturnType<typeof enqueueMessageOutbox>;
}> {
  return await withMessageState(async (opened) => {
    let result: ReturnType<typeof createMessage>;
    let outbox: ReturnType<typeof enqueueMessageOutbox> | undefined;
    opened.db.exec("BEGIN IMMEDIATE");
    try {
      result = createMessage(opened.db, input);
      if (options.outbox) {
        outbox = enqueueMessageOutbox(opened.db, {
          message_id: result.message.message_id,
          target_host: options.outbox.target_host,
          now: result.message.created_at,
          payload: options.outbox.payload,
        });
      }
      if (opened.paths.stateDir) {
        if (result.inserted) {
          enqueueMessageReceiptMirror(
            opened.db,
            result.message.message_id,
            result.message.created_at,
          );
        } else if (
          !result.message.receipt_path
          && !readMessageReceiptMirror(opened.db, result.message.message_id)
        ) {
          throw new Error(
            `message ${result.message.message_id} has no authentic receipt admission snapshot`,
          );
        }
      }
      opened.db.exec("COMMIT");
    } catch (error) {
      try {
        opened.db.exec("ROLLBACK");
      } catch {
        // Preserve the admission failure rather than a secondary rollback error.
      }
      throw error;
    }

    if (opened.paths.stateDir && readMessageReceiptMirror(opened.db, result.message.message_id)) {
      await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: result.message.message_id,
        force: true,
        limit: 1,
      });
    }
    const message = readMessage(opened.db, result.message.message_id) ?? result.message;
    return {
      message,
      inserted: result.inserted,
      receipt_path: message.receipt_path,
      ...(outbox ? { outbox } : {}),
    };
  });
}

async function forwardMessageOutboxForWake(
  outboxId: string,
  sourceHost: string,
  deps: RunCliDependencies,
): Promise<Awaited<ReturnType<CalyxAdminClient["admin"]["msg"]["forward"]>> extends CalyxResult<infer T, string> ? T : never> {
  const access = await resolveRunServerAccess({ host: sourceHost }, deps);
  if (!access.token) {
    throw createCliError(
      `Cross-host --wake requires source-daemon admin credentials for ${sourceHost} or ${RUN_SERVER_CREDENTIAL_HINT}.`,
      2,
    );
  }
  const result = await remoteAdminClient(deps, {
    serverUrl: access.serverUrl,
    token: access.token,
  }).admin.msg.forward({ path: { outboxId } });
  return requireClientResult(
    result,
    "source-daemon message forward",
    exactEndpointReconciliationCommand(
      ["calyx", "msg", "operation", outboxId],
      access.serverUrl,
    ),
  );
}

interface RemoteMessageSubmissionResult {
  schema_version: "calyx.msg-send-result/v1";
  inserted: boolean;
  delivery_state: "outbox";
  message: MessageResultView;
  operation: {
    status: "accepted";
    locator: string;
    receipt_locator: string;
  };
  outbox: {
    outbox_id: string;
    target_host: string;
    status: "pending";
    created_at: string;
    expires_at: string;
  };
}

async function submitMessageToSourceDaemon(
  deps: RunCliDependencies,
  options: {
    resolved: ResolvedMessageAddress;
    sourceHost: string;
    sender: string;
    subject: string;
    body: string;
    threadKey: string;
    replyTo?: string | undefined;
    idempotencyKey: string;
    urgency: MessageUrgency;
    ackRequired: boolean;
    expiresAt: string | null;
    serverUrl?: string | undefined;
    authToken?: string | undefined;
    replyAddress: string;
  },
): Promise<RemoteMessageSubmissionResult> {
  const targetHost = options.resolved.target_host;
  if (!targetHost) {
    throw createCliError("remote message submission requires a target host.", 2);
  }
  // The recipient host is an outbox destination, not the consumer authority.
  // Submit through the current/source daemon so its local credential, send_as
  // grant, idempotency namespace, receipt, and forwarding state stay coherent.
  // An explicit bearer is still source-scoped: it may select a different URL
  // spelling for the configured source daemon, but it cannot rebind msg.send
  // to the recipient (or any other daemon) while retaining the source actor.
  const trustedSourceAccess = await resolveRunServerAccess({
    host: options.sourceHost,
    resolveCredential: false,
  }, deps);
  if (options.serverUrl?.trim()) {
    const explicitEndpoint = normalizedRunServerEndpoint(options.serverUrl);
    const trustedEndpoint = normalizedRunServerEndpoint(trustedSourceAccess.serverUrl);
    if (explicitEndpoint !== trustedEndpoint) {
      throw createCliError(
        `Remote msg send --server-url must match the configured source daemon endpoint ${trustedEndpoint}.`,
        2,
      );
    }
  }
  const access = await resolveRunServerAccess({
    host: options.sourceHost,
    serverUrl: options.serverUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `Remote msg send requires --auth-token for the source daemon or ${RUN_SERVER_CREDENTIAL_HINT}.`,
      2,
    );
  }
  const { serverUrl, token } = access;
  let assertedActor: string | undefined;
  try {
    assertedActor = validateApiAssertedActor(options.sender);
  } catch {
    // A routable client reply address is not an asserted operator/run/session
    // identity. Explicit bearer flows intentionally omit the optional header.
  }
  const body = {
      schema_version: "calyx.msg-send/v1",
      idempotency_key: options.idempotencyKey,
      recipient_address: options.resolved.address,
      reply_address: options.replyAddress,
      subject: options.subject,
      body: options.body,
      thread_key: options.threadKey,
      ...(options.replyTo ? { reply_to: options.replyTo } : {}),
      urgency: options.urgency,
      ack_required: options.ackRequired,
      ...(options.expiresAt ? { expires_at: options.expiresAt } : {}),
  };
  return executeRecoverableMutation(deps, { serverUrl, token }, {
    context: "msg send",
    replayCommand: "calyx msg send --replay-request",
    operation: (client) => client.consumer.msg.send({
      body: body as unknown as Parameters<CalyxAdminClient["consumer"]["msg"]["send"]>[0]["body"],
      ...(assertedActor ? { assertedActor } : {}),
    }),
  }) as unknown as RemoteMessageSubmissionResult;
}

async function replayRemoteMessageRequest(
  deps: RunCliDependencies,
  artifactPath: string,
  authToken?: string,
): Promise<unknown> {
  return replayGeneratedMutation(
    deps,
    artifactPath,
    "msg.send",
    "calyx msg send --replay-request",
    authToken,
  );
}

type MessageResultView = Pick<
  MessageRow,
  "message_id" | "recipient_address" | "recipient_class" | "subject" | "status"
> & { receipt_path?: string | null };

interface MessageOperationView {
  schema_version: "calyx.message-operation/v1";
  operation_id: string;
  message_locator?: string;
  target_host: string;
  status: (typeof MESSAGE_OUTBOX_STATUSES)[number];
  terminal: boolean;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  receipt?: {
    schema_version: "calyx.message-operation-receipt/v1";
    outcome: (typeof MESSAGE_OUTBOX_STATUSES)[number];
    completed_at: string;
  };
}

async function readLocalMessageOperation(
  outboxId: string,
  deps: RunCliDependencies,
): Promise<MessageOperationView> {
  return withMessageState(({ db }) => {
    const outbox = readMessageOutbox(db, outboxId);
    const message = outbox ? readMessage(db, outbox.message_id) : undefined;
    if (!outbox || !message) {
      throw createCliError(`message operation not found: ${outboxId}`, 4);
    }
    const now = deps.now ? deps.now() : new Date();
    const observedOutbox = projectMessageOutboxAt(outbox, { now: now.toISOString() });
    const terminal = observedOutbox.status !== "pending" && observedOutbox.status !== "in_flight";
    const messageExpired = Boolean(message.expires_at && Date.parse(message.expires_at) <= now.getTime());
    return {
      schema_version: "calyx.message-operation/v1",
      operation_id: observedOutbox.outbox_id,
      ...(!messageExpired
        ? { message_locator: `/v1/message-text/${encodeURIComponent(message.message_id)}` }
        : {}),
      target_host: observedOutbox.target_host,
      status: observedOutbox.status,
      terminal,
      attempt_count: observedOutbox.attempt_count,
      created_at: observedOutbox.created_at,
      updated_at: observedOutbox.updated_at,
      ...(terminal
        ? {
            receipt: {
              schema_version: "calyx.message-operation-receipt/v1" as const,
              outcome: observedOutbox.status,
              completed_at: observedOutbox.forwarded_at ?? observedOutbox.updated_at,
            },
          }
        : {}),
    };
  });
}

function remoteMessageReplyAddress(
  options: MsgSendCommandOptions,
  currentHost: string,
  sender: string,
): string {
  if (!options.authToken?.trim()) {
    return `client:operator_cli@${normalizeHostForMsg(currentHost)}`;
  }
  const explicit = resolveMessageAddress(sender, { currentHost });
  if (
    explicit.kind !== "client"
    || explicit.recipient_class !== "directed"
    || normalizeHostForMsg(explicit.target_host ?? "") !== normalizeHostForMsg(currentHost)
  ) {
    throw createCliError(
      "Remote msg send with --auth-token also requires --sender client:<client-id>@<source-host> matching that credential's send_as grant.",
      2,
    );
  }
  return explicit.address;
}

function printMsgSendResult(value: unknown, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  const result = value as {
    message?: MessageRow;
    messages?: MessageRow[];
    outbox?: unknown;
    delivery_notice?: MsgDeliveryNotice;
    delivery_state?: ReturnType<typeof messageDeliveryState>;
  };
  if (result.messages) {
    console.log(`sent ${result.messages.length} messages`);
    for (const message of result.messages) {
      console.log(`${message.message_id}  ${message.recipient_address}  ${message.status}  ${message.subject}`);
    }
    return;
  }
  if (result.message) {
    console.log(`message: ${result.message.message_id}`);
    console.log(`  to: ${result.message.recipient_address}`);
    console.log(`  status: ${result.message.status}`);
    console.log(`  subject: ${result.message.subject}`);
    if (result.message.receipt_path) console.log(`  receipt: ${result.message.receipt_path}`);
    if (result.outbox) console.log("  outbox: queued");
    if (result.delivery_notice) {
      console.log(`  delivery: ${result.delivery_notice.code} (${result.delivery_notice.delivery_state}; wake=${result.delivery_notice.wake})`);
      console.log(`  note: ${result.delivery_notice.message}`);
      if (result.delivery_notice.next_command) console.log(`  next: ${result.delivery_notice.next_command}`);
    }
    if (result.delivery_state) {
      console.log(
        `  deliveries: ${result.delivery_state.count} (attempted=${result.delivery_state.counts.attempted}, delivered=${result.delivery_state.counts.delivered}, failed=${result.delivery_state.counts.failed})`,
      );
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printMessageRows(rows: readonly MessageRow[]): void {
  if (rows.length === 0) {
    console.log("no messages");
    return;
  }
  for (const row of rows) {
    const host = row.recipient_host ? `@${row.recipient_host}` : "";
    console.log(`${row.message_id}  ${row.status}  ${row.recipient_address}${host}  ${row.created_at}  ${row.subject}`);
  }
}

function activeSessionAddress(entry: RunListEntry | RunActivityEntry): string | undefined {
  if (!("entry_kind" in entry) || entry.entry_kind !== "interactive_session") return undefined;
  return `interactive:${entry.backend}:${entry.session_id}`;
}

function runRecipientFromResolvedMessage(resolved: ResolvedMessageAddress): string | undefined {
  if (resolved.recipient_class !== "directed" || resolved.kind !== "run") {
    return undefined;
  }
  const runId = resolved.address.slice("run:".length).trim();
  return runId.length > 0 ? runId : undefined;
}

function resumableMessageBackend(record: RunRecord): "claude" | "codex" | undefined {
  const backend = record.intent.backend ?? (
    record.spec && "backend" in record.spec ? record.spec.backend : undefined
  );
  return backend === "claude" || backend === "codex" ? backend : undefined;
}

function resumableMessageSessionId(record: RunRecord): string | undefined {
  const checkpointSession = record.recovery.checkpoint?.backend_session_id?.trim();
  if (checkpointSession) {
    return checkpointSession;
  }
  if (record.kernel_receipt && "backend_session" in record.kernel_receipt) {
    const receiptSession = record.kernel_receipt.backend_session?.id?.trim();
    if (receiptSession) {
      return receiptSession;
    }
  }
  return record.intent.resume_session_id?.trim() || undefined;
}

function messageDeliveryState(deliveries: MessageDeliveryRow[]): {
  count: number;
  counts: { attempted: number; delivered: number; failed: number };
  deliveries: MessageDeliveryRow[];
} {
  const counts = { attempted: 0, delivered: 0, failed: 0 };
  for (const delivery of deliveries) {
    counts[delivery.status] += 1;
  }
  return { count: deliveries.length, counts, deliveries };
}

async function readMessageDeliveryState(messageId: string): Promise<ReturnType<typeof messageDeliveryState>> {
  const deliveries = await withMessageState(async ({ db }) => listMessageDeliveries(db, {
    message_id: messageId,
    status: "all",
  }));
  return messageDeliveryState(deliveries);
}

interface MsgDeliveryNotice {
  code:
    | "spooled_to_durable_inbox"
    | "scope_bulletin_spooled"
    | "sender_outbox_queued"
    | "wake_delivered"
    | "wake_delivery_indeterminate"
    | "message_forward_indeterminate"
    | "wake_not_delivered"
    | "duplicate_message";
  delivery_state: "spooled" | "outbox";
  wake: "delivered" | "unknown" | "not_delivered" | "not_attempted" | "not_applicable";
  message: string;
  next_command?: string;
}

interface MsgWakeTargetUnresolved {
  schema_version: "calyx.session-wake-result/v1";
  delivery_state: "spooled";
  wake_state: "target_unresolved";
  pointer: { kind: "message"; id: string };
  recipient: string;
  error_code: "run_activity_unresolved";
  error_message: string;
  first_command: string;
}

interface MsgWakeRemotePartial {
  schema_version: "calyx.session-wake-result/v1";
  delivery_state: "spooled" | "outbox";
  wake_state:
    | "destination_unavailable"
    | "destination_unsupported"
    | "transport_failure"
    | "delivery_indeterminate"
    | "message_forward_indeterminate";
  pointer: { kind: "message"; id: string };
  recipient: string;
  destination_host: string;
  error_code: string;
  error_message: string;
  first_command: string;
}

type MsgWakeResult = SessionWakeRouteResult | MsgWakeTargetUnresolved | MsgWakeRemotePartial;

function msgDeliveryNotice(result: {
  message: MessageResultView;
  inserted: boolean;
  resolved: ResolvedMessageAddress;
  outbox?: unknown;
  wake_result?: MsgWakeResult;
}): MsgDeliveryNotice {
  if (result.wake_result?.wake_state === "message_forward_indeterminate") {
    return {
      code: "message_forward_indeterminate",
      delivery_state: "outbox",
      wake: "not_attempted",
      message: "MESSAGE FORWARDING IS INDETERMINATE. Destination durable admission may already have committed; live wake was not attempted. Do not repeat the forward blindly. Reconcile the exact source-daemon operation first.",
      next_command: result.wake_result.first_command,
    };
  }
  if (result.wake_result?.wake_state === "wake_delivered") {
    return {
      code: "wake_delivered",
      delivery_state: "spooled",
      wake: "delivered",
      message: "MESSAGE SPOOLED; WAKE DELIVERED. Receiver acceptance is transport evidence, not claim or acknowledgement.",
      next_command: result.wake_result.first_command,
    };
  }
  if (result.wake_result?.wake_state === "delivery_indeterminate") {
    return {
      code: "wake_delivery_indeterminate",
      delivery_state: "spooled",
      wake: "unknown",
      message: "MESSAGE SPOOLED; LIVE WAKE DELIVERY UNKNOWN. The exact wake may already have been delivered. "
        + "The durable inbox remains authoritative. Replay only an encrypted generated receipt; "
        + "do not resend the message or reconstruct a wake request.",
      next_command: result.wake_result.first_command,
    };
  }
  if (result.wake_result) {
    return {
      code: "wake_not_delivered",
      delivery_state: "spooled",
      wake: "not_delivered",
      message: `MESSAGE SPOOLED; WAKE NOT DELIVERED (${result.wake_result.wake_state}). The durable inbox remains authoritative; do not retry the whole send.`,
      next_command: result.wake_result.first_command,
    };
  }
  if (!result.inserted) {
    return {
      code: "duplicate_message",
      delivery_state: result.message.status === "outbox" ? "outbox" : "spooled",
      wake: "not_attempted",
      message: "Duplicate idempotency key matched an existing durable message row; no new wake or delivery attempt was made.",
    };
  }
  if (result.outbox) {
    return {
      code: "sender_outbox_queued",
      delivery_state: "outbox",
      wake: "not_applicable",
      message: "Message is queued in the sender outbox for a recipient host daemon; it has not reached the recipient inbox yet.",
    };
  }
  if (result.message.recipient_class === "scope") {
    return {
      code: "scope_bulletin_spooled",
      delivery_state: "spooled",
      wake: "not_applicable",
      message: "Scope bulletin is spooled in the durable bulletin inbox; scope messages are peek-only and are not actively woken.",
      next_command: `calyx msg inbox --scope ${result.message.recipient_address} --json`,
    };
  }
  if (result.resolved.kind === "interactive" || result.resolved.kind === "authorship_alias") {
    return {
      code: "spooled_to_durable_inbox",
      delivery_state: "spooled",
      wake: "not_attempted",
      message: "Interactive recipient was durably spooled. Bare send never attempts live ingress; use --wake explicitly for a best-effort exact-session pointer.",
      next_command: `calyx msg inbox --for ${result.message.recipient_address} --json`,
    };
  }
  return {
    code: "spooled_to_durable_inbox",
    delivery_state: "spooled",
    wake: "not_attempted",
    message: "Directed message is spooled in the durable inbox; recipients claim it with calyx msg inbox and ack it after handling.",
    next_command: `calyx msg inbox --for ${result.message.recipient_address} --json`,
  };
}

function wakeEligibleMessageTarget(resolved: ResolvedMessageAddress): boolean {
  return resolved.kind === "interactive"
    || resolved.kind === "authorship_alias"
    || resolved.kind === "run";
}

async function resolveMessageWakeActivity(
  resolved: ResolvedMessageAddress,
  deps: RunCliDependencies,
): Promise<string | undefined> {
  if (resolved.kind === "interactive" || resolved.kind === "authorship_alias") {
    return resolved.address;
  }
  const sourceRunId = runRecipientFromResolvedMessage(resolved);
  if (!sourceRunId) return undefined;
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  const record = await service.getRunRecord(sourceRunId);
  if (!record || record.intent.kernel === "host_process") return undefined;
  const backend = resumableMessageBackend(record);
  const sessionId = resumableMessageSessionId(record);
  return backend && sessionId ? `interactive:${backend}:${sessionId}` : undefined;
}

async function resolveRemoteRunMessageWakeActivity(
  resolved: ResolvedMessageAddress,
  deps: RunCliDependencies,
): Promise<string | undefined> {
  const destinationHost = resolved.target_host;
  const runId = runRecipientFromResolvedMessage(resolved);
  if (!destinationHost || !runId) return undefined;
  try {
    const access = await resolveRunServerAccess({ host: destinationHost }, deps);
    if (!access.token) return undefined;
    const record = fromAdminRunRecord(await remoteAdminRunRecord(
      deps,
      { serverUrl: access.serverUrl, token: access.token },
      runId,
      `session wake run resolution for ${destinationHost}`,
    ));
    if (record.intent.kernel === "host_process") return undefined;
    const backend = resumableMessageBackend(record);
    const sessionId = resumableMessageSessionId(record);
    return backend && sessionId ? `interactive:${backend}:${sessionId}` : undefined;
  } catch {
    return undefined;
  }
}

async function attemptMessageWake(
  message: MessageRow,
  activityId: string,
  deps: RunCliDependencies,
): Promise<MsgWakeResult> {
  return withMessageState(async ({ db }) => routeSessionWake(db, {
    recipient_activity_id: activityId,
    pointer_kind: "message",
    pointer_id: message.message_id,
  }, {
    ...(deps.sessionWake ?? {}),
    ...(deps.now ? { now: () => deps.now!().toISOString() } : {}),
  }));
}

function unresolvedMessageWake(
  message: MessageRow,
  resolved: ResolvedMessageAddress,
): MsgWakeTargetUnresolved {
  return {
    schema_version: "calyx.session-wake-result/v1",
    delivery_state: "spooled",
    wake_state: "target_unresolved",
    pointer: { kind: "message", id: message.message_id },
    recipient: resolved.address,
    error_code: "run_activity_unresolved",
    error_message: "The run has no exact bound interactive activity; the durable message remains pending.",
    first_command: `calyx msg inbox --for ${message.recipient_address} --json`,
  };
}

function remoteWakePartial(
  message: MessageRow,
  resolved: ResolvedMessageAddress,
  destinationHost: string,
  wakeState: MsgWakeRemotePartial["wake_state"],
  errorCode: string,
  errorMessage: string,
  firstCommand?: string,
): MsgWakeRemotePartial {
  return {
    schema_version: "calyx.session-wake-result/v1",
    delivery_state: "spooled",
    wake_state: wakeState,
    pointer: { kind: "message", id: message.message_id },
    recipient: resolved.address,
    destination_host: destinationHost,
    error_code: errorCode,
    error_message: errorMessage,
    first_command: firstCommand ?? `calyx msg inbox --for ${resolved.address} --json`,
  };
}

function messageForwardIndeterminate(
  message: MessageRow,
  resolved: ResolvedMessageAddress,
  destinationHost: string,
  reconciliationCommand: string,
): MsgWakeRemotePartial {
  return {
    schema_version: "calyx.session-wake-result/v1",
    delivery_state: "outbox",
    wake_state: "message_forward_indeterminate",
    pointer: { kind: "message", id: message.message_id },
    recipient: resolved.address,
    destination_host: destinationHost,
    error_code: "destination_admission_indeterminate",
    error_message: "The source daemon lost the response after dispatching the forward. Destination durable admission may already have committed; live wake was not attempted and the forward must not be repeated blindly.",
    first_command: reconciliationCommand,
  };
}

async function attemptRemoteMessageWake(
  message: MessageRow,
  resolved: ResolvedMessageAddress,
  deps: RunCliDependencies,
): Promise<MsgWakeResult> {
  const destinationHost = resolved.target_host;
  if (!destinationHost) {
    return remoteWakePartial(
      message,
      resolved,
      "unknown",
      "destination_unavailable",
      "destination_host_unresolved",
      "The exact activity destination host could not be resolved; the durable message remains pending.",
    );
  }

  let access: Awaited<ReturnType<typeof resolveRunServerAccess>>;
  try {
    access = await resolveRunServerAccess({ host: destinationHost }, deps);
  } catch {
    return remoteWakePartial(
      message,
      resolved,
      destinationHost,
      "destination_unavailable",
      "destination_access_unavailable",
      "The named destination daemon could not be resolved; the durable message remains available.",
    );
  }
  if (!access.token) {
    return remoteWakePartial(
      message,
      resolved,
      destinationHost,
      "destination_unavailable",
      "destination_credential_unavailable",
      `No named-host control-plane credential is available for ${destinationHost}.`,
    );
  }

  let health: CalyxDaemonHealth;
  try {
    health = await remoteAdminHealth(
      deps,
      { serverUrl: access.serverUrl, token: access.token },
      `session wake capability preflight for ${destinationHost}`,
    );
  } catch {
    return remoteWakePartial(
      message,
      resolved,
      destinationHost,
      "destination_unavailable",
      "destination_daemon_unavailable",
      "The destination daemon health preflight failed; the durable message remains available.",
    );
  }
  const refusal = getDaemonCompatibilityRefusal(
    destinationHost,
    health,
    [CALYX_DAEMON_FEATURES.sessionWakeV1],
  );
  if (refusal) {
    return remoteWakePartial(
      message,
      resolved,
      destinationHost,
      "destination_unsupported",
      refusal.reason,
      refusal.message,
    );
  }

  const activityId = resolved.kind === "interactive" || resolved.kind === "authorship_alias"
    ? resolved.address
    : undefined;
  if (!activityId) {
    return unresolvedMessageWake(message, resolved);
  }

  const request: SessionWakeDeliverRequestV1 = {
    schema_version: "calyx.session-wake-deliver-request/v1",
    delivery_id: sessionWakeDeliveryId("message", message.message_id, activityId),
    recipient_activity_id: activityId,
    pointer: { kind: "message", id: message.message_id },
    created_at: message.created_at,
  };
  try {
    return await executeRecoverableMutation(deps, {
      serverUrl: access.serverUrl,
      token: access.token,
    }, {
      context: `session wake delivery for ${destinationHost}`,
      replayCommand: "calyx client replay",
      operation: (client) => client.admin.sessionWake.deliver({ body: request }),
    }) as SessionWakeRouteResult;
  } catch (error) {
    const cliError = error as CliError;
    const indeterminate = cliError.clientResultKind === "indeterminate";
    return remoteWakePartial(
      message,
      resolved,
      destinationHost,
      indeterminate ? "delivery_indeterminate" : "transport_failure",
      indeterminate
        ? cliError.reconciliationCommand
          ? "destination_transport_indeterminate"
          : "destination_transport_indeterminate_without_recovery_authority"
        : "destination_transport_failure",
      indeterminate
        ? cliError.reconciliationCommand
          ? "The exact live wake may already have been delivered. The durable message remains authoritative; replay only its encrypted generated recovery receipt and do not reconstruct or blindly repeat the wake request."
          : "The exact live wake may already have been delivered, but encrypted replay authority is unavailable. The durable message remains authoritative; do not reconstruct or repeat the wake request."
        : "The destination session wake transport failed; the durable message remains available.",
      indeterminate ? cliError.reconciliationCommand : undefined,
    );
  }
}

async function sendOneMsg(
  rawAddress: string,
  options: MsgSendCommandOptions,
  deps: RunCliDependencies,
  shared: {
    sender: string;
    subject: string;
    body: string;
    currentHost: string;
    explicitHost?: string | undefined;
    payload?: Record<string, unknown> | undefined;
  },
): Promise<{
  message: MessageResultView;
  inserted: boolean;
  receipt_path: string | null;
  resolved: ResolvedMessageAddress;
  outbox?: unknown;
  operation?: unknown;
  wake_result?: MsgWakeResult;
  delivery_state: ReturnType<typeof messageDeliveryState>;
  delivery_notice: MsgDeliveryNotice;
}> {
  const resolved = resolveMessageAddress(rawAddress, {
    currentHost: shared.currentHost,
    coordinatorHost: options.coordinatorHost,
    explicitHost: shared.explicitHost ?? options.host,
  });
  const expiresAt = resolveMsgExpiry(options, resolved);
  const local = isLocalMessageHost(resolved.target_host, shared.currentHost, deps);
  const threadKey = messageThreadKey(options, shared.subject);
  const urgency = parseMessageUrgency(options.urgency);
  const ackRequired = Boolean(options.ackRequired);

  if (options.wake && !wakeEligibleMessageTarget(resolved)) {
    throw createCliError(
      "--wake requires one exact interactive activity or a run that resolves to one; role, client, host, fleet, and other ambiguous targets are durable-only.",
      2,
    );
  }
  if (options.wake && (resolved.kind === "interactive" || resolved.kind === "authorship_alias")) {
    const backend = resolved.address.split(":", 3)[1] ?? "";
    if (!(SESSION_INGRESS_BACKENDS as readonly string[]).includes(backend)) {
      throw createCliError(
        `--wake does not support interactive backend ${backend || "unknown"}; expected one of ${SESSION_INGRESS_BACKENDS.join(", ")} and no message was written.`,
        2,
      );
    }
  }
  if (!local && options.wake && (options.serverUrl?.trim() || options.authToken?.trim())) {
    throw createCliError(
      "Cross-host --wake resolves its authenticated destination daemon only from named-host truth; --server-url and --auth-token are not accepted and no message was written.",
      2,
    );
  }

  const wakeActivityId = options.wake
    ? resolved.kind === "run"
      ? local
        ? await resolveMessageWakeActivity(resolved, deps)
        : await resolveRemoteRunMessageWakeActivity(resolved, deps)
      : resolved.address
    : undefined;
  const durableResolved = wakeActivityId && resolved.kind === "run"
    ? resolveMessageAddress(wakeActivityId, {
        currentHost: shared.currentHost,
        explicitHost: resolved.target_host ?? undefined,
      })
    : resolved;

  if (!local) {
    const executionRecipient = executionCapableMessageAddressKind(durableResolved);
    if (executionRecipient) {
      const { message, inserted, receipt_path, outbox } = await createMessageWithReceipt({
        sender: shared.sender,
        recipient_address: durableResolved.address,
        recipient_class: durableResolved.recipient_class,
        recipient_host: durableResolved.target_host,
        subject: shared.subject,
        body: shared.body,
        thread_key: threadKey,
        reply_to: options.replyTo,
        idempotency_key: options.idempotencyKey,
        urgency,
        ack_required: ackRequired,
        expires_at: expiresAt,
        status: "outbox",
        payload: {
          address_input: resolved.input,
          address_kind: resolved.kind,
          durable_authority_host: shared.currentHost,
          ...(shared.payload ?? {}),
        },
      }, {
        outbox: {
          target_host: durableResolved.target_host!,
          payload: {
            recipient_address: durableResolved.address,
            source: "operator-cli-session-wake",
          },
        },
      });
      let wake_result: MsgWakeResult | undefined;
      let finalOutbox = outbox;
      if (options.wake && outbox) {
        try {
          const admission = await forwardMessageOutboxForWake(outbox.outbox_id, shared.currentHost, deps);
          if (
            typeof admission.status !== "string"
            || !MESSAGE_OUTBOX_STATUSES.includes(admission.status as (typeof MESSAGE_OUTBOX_STATUSES)[number])
          ) {
            throw createCliError(
              "source-daemon message forward returned an unsupported operation status; reconcile through msg.operation before waking",
              6,
            );
          }
          const status = admission.status as (typeof MESSAGE_OUTBOX_STATUSES)[number];
          const persistedOutbox = await withMessageState(({ db }) => (
            readMessageOutbox(db, outbox.outbox_id)
          )) ?? outbox;
          finalOutbox = {
            ...persistedOutbox,
            status,
            attempt_count: admission.attempt_count,
            updated_at: admission.updated_at,
            ...(status === "forwarded" && admission.terminal
              ? { forwarded_at: admission.receipt.completed_at }
              : {}),
          };
          wake_result = status === "forwarded"
            ? wakeActivityId
              ? await attemptRemoteMessageWake(message, durableResolved, deps)
              : unresolvedMessageWake(message, resolved)
            : remoteWakePartial(
                message,
                durableResolved,
                durableResolved.target_host!,
                "transport_failure",
                "destination_admission_unproven",
                "The destination did not acknowledge durable message admission; no wake was attempted.",
              );
        } catch (error) {
          const cliError = error as CliError;
          wake_result = cliError.clientResultKind === "unkeyed_indeterminate" && cliError.reconciliationCommand
            ? messageForwardIndeterminate(
                message,
                durableResolved,
                durableResolved.target_host!,
                cliError.reconciliationCommand,
              )
            : remoteWakePartial(
                message,
                durableResolved,
                durableResolved.target_host!,
                "transport_failure",
                "destination_admission_unproven",
                "The destination did not acknowledge durable message admission; no wake was attempted.",
              );
        }
      }
      const finalMessage = await withMessageState(async ({ db }) => readMessage(db, message.message_id)) ?? message;
      const delivery_state = await readMessageDeliveryState(message.message_id);
      const result = {
        message: finalMessage,
        inserted,
        receipt_path,
        resolved: durableResolved,
        ...(finalOutbox ? { outbox: finalOutbox } : {}),
        ...(wake_result ? { wake_result } : {}),
        delivery_state,
      };
      return { ...result, delivery_notice: msgDeliveryNotice(result) };
    }
    if (options.spoolOnly) {
      throw createCliError(
        "--spool-only is not available for remote consumer submissions because daemon ingress would bypass consumer authorization.",
        2,
      );
    }
    const submission = await submitMessageToSourceDaemon(deps, {
      resolved,
      sourceHost: shared.currentHost,
      sender: shared.sender,
      subject: shared.subject,
      body: shared.body,
      threadKey,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      idempotencyKey: options.idempotencyKey?.trim() || `cli-msg:${randomUUID()}`,
      urgency,
      ackRequired,
      expiresAt,
      serverUrl: options.serverUrl,
      authToken: options.authToken,
      replyAddress: remoteMessageReplyAddress(options, shared.currentHost, shared.sender),
    });
    const message = submission.message;
    const delivery_state = messageDeliveryState([]);
    const result = {
      message,
      inserted: submission.inserted,
      receipt_path: null,
      resolved,
      operation: submission.operation,
      outbox: submission.outbox,
      delivery_state,
    };
    return { ...result, delivery_notice: msgDeliveryNotice(result) };
  }

  const { message, inserted, receipt_path } = await createMessageWithReceipt({
    sender: shared.sender,
    recipient_address: durableResolved.address,
    recipient_class: durableResolved.recipient_class,
    recipient_host: durableResolved.target_host,
    subject: shared.subject,
    body: shared.body,
    thread_key: threadKey,
    reply_to: options.replyTo,
    idempotency_key: options.idempotencyKey,
    urgency,
    ack_required: ackRequired,
    expires_at: expiresAt,
    status: "pending",
    payload: {
      address_input: resolved.input,
      address_kind: resolved.kind,
      ...(shared.payload ?? {}),
    },
  });

  const wake_result = options.wake
    ? wakeActivityId
      ? await attemptMessageWake(message, wakeActivityId, deps)
      : unresolvedMessageWake(message, resolved)
    : undefined;
  const finalMessage = await withMessageState(async ({ db }) => readMessage(db, message.message_id)) ?? message;
  const delivery_state = await readMessageDeliveryState(message.message_id);
  const result = {
    message: finalMessage,
    inserted,
    receipt_path,
    resolved: durableResolved,
    ...(wake_result ? { wake_result } : {}),
    delivery_state,
  };
  return { ...result, delivery_notice: msgDeliveryNotice(result) };
}

function normalizeSelfUpgradeHostAlias(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/\..*$/, "") ?? "";
}

function parseEnvAssignments(assignments: string[]): Record<string, string | null> {
  const env: Record<string, string | null> = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf("=");
    if (idx <= 0) {
      throw createCliError(
        `Invalid --env value: ${assignment}. Expected KEY=VALUE or KEY=null.`,
        2
      );
    }
    const key = assignment.slice(0, idx).trim();
    const rawValue = assignment.slice(idx + 1);
    if (key.length === 0) {
      throw createCliError(
        `Invalid --env value: ${assignment}. Environment key cannot be empty.`,
        2
      );
    }
    env[key] = rawValue === "null" ? null : rawValue;
  }
  return env;
}

function parseTemplateVariables(assignments: string[], flagName = "--template-var"): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf("=");
    if (idx <= 0) {
      throw createCliError(
        `Invalid ${flagName} value: ${assignment}. Expected NAME=VALUE.`,
        2
      );
    }
    const key = assignment.slice(0, idx).trim();
    const value = assignment.slice(idx + 1);
    if (!key) {
      throw createCliError(
        `Invalid ${flagName} value: ${assignment}. Variable name cannot be empty.`,
        2
      );
    }
    variables[key] = value;
  }
  return variables;
}

function isProvidedOption(value: string | undefined): value is string {
  return value !== undefined;
}

function validateSystemPromptBytes(text: string, flagName: string): string {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (text.trim().length === 0) {
    throw createCliError(`${flagName} resolved to an empty prompt.`, 2);
  }
  if (byteLength > RUN_SYSTEM_PROMPT_MAX_BYTES) {
    throw createCliError(
      `${flagName} resolved to ${byteLength} bytes, above the ${RUN_SYSTEM_PROMPT_MAX_BYTES} byte limit.`,
      2,
    );
  }
  return text;
}

function readSystemPromptFile(filePath: string, flagName: string): string {
  const resolvedPath = resolvePath(filePath);
  try {
    return validateSystemPromptBytes(readFileSync(resolvedPath, "utf8"), flagName);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(`${flagName} file not found: ${filePath} (${resolvedPath})`, 2);
    }
    if (nodeError.code === "EISDIR") {
      throw createCliError(`${flagName} points to a directory, not a file: ${filePath} (${resolvedPath})`, 2);
    }
    if (error instanceof Error && error.message.startsWith(`${flagName} resolved to`)) {
      throw error;
    }
    throw createCliError(
      `Failed to read ${flagName} file ${filePath} (${resolvedPath}): ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function readRunPromptFile(filePath: string): string {
  const resolvedPath = resolvePath(filePath);
  try {
    const text = readFileSync(resolvedPath, "utf8");
    if (text.trim().length === 0) {
      throw createCliError(`--prompt-file resolved to an empty prompt: ${filePath} (${resolvedPath})`, 2);
    }
    return text;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw createCliError(`--prompt-file file not found on launcher host: ${filePath} (${resolvedPath})`, 2);
    }
    if (nodeError.code === "EISDIR") {
      throw createCliError(`--prompt-file points to a directory, not a file: ${filePath} (${resolvedPath})`, 2);
    }
    if (error instanceof Error && error.message.startsWith("--prompt-file resolved to")) {
      throw error;
    }
    throw createCliError(
      `Failed to read --prompt-file on launcher host ${filePath} (${resolvedPath}): ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function resolveSystemPromptOption(args: {
  inlineValue: string | undefined;
  fileValue: string | undefined;
  inlineFlag: string;
  fileFlag: string;
}): string | undefined {
  const inlineValue = args.inlineValue;
  const fileValue = args.fileValue;
  const inlineProvided = isProvidedOption(inlineValue);
  const fileProvided = isProvidedOption(fileValue);
  if (inlineProvided && fileProvided) {
    throw createCliError(
      `run launch accepts either ${args.inlineFlag} or ${args.fileFlag}, not both.`,
      2,
    );
  }
  if (inlineProvided) {
    return validateSystemPromptBytes(inlineValue, args.inlineFlag);
  }
  if (fileProvided) {
    return readSystemPromptFile(fileValue, args.fileFlag);
  }
  return undefined;
}

function resolveTasksDir(cliValue?: string): string {
  const candidate = cliValue?.trim() || process.env[DEFAULT_TASKS_DIR_ENV]?.trim();
  if (!candidate) {
    throw createCliError(`tasks commands require --tasks-dir <path> or ${DEFAULT_TASKS_DIR_ENV}.`, 2);
  }
  return candidate;
}

function parseTaskStatusFilters(values: string[] = []): TaskStatus[] | undefined {
  const statuses: TaskStatus[] = [];
  for (const rawValue of values) {
    for (const part of rawValue.split(",")) {
      const value = part.trim();
      if (!value) {
        continue;
      }
      if (!isTaskStatus(value)) {
        throw createCliError(
          `Invalid task status "${value}". Must be one of: draft, active, paused, retired, failed_needs_attention.`,
          2,
        );
      }
      statuses.push(value);
    }
  }
  return statuses.length > 0 ? [...new Set(statuses)] : undefined;
}

function parseTaskInstallStatus(rawValue: string | undefined): TaskInstallStatus {
  const value = (rawValue ?? "paused").trim();
  if (value === "active" || value === "paused" || value === "retired" || value === "failed_needs_attention") {
    return value;
  }
  throw createCliError(
    `Invalid task install status "${value}". Must be one of: active, paused, retired, failed_needs_attention.`,
    2,
  );
}

function parseTaskLaunchMode(rawValue: string | undefined): TaskLaunchMode {
  const value = (rawValue ?? "advisory").trim();
  if (value === "advisory" || value === "mutating") {
    return value;
  }
  throw createCliError(`Invalid task mode "${value}". Must be one of: advisory, mutating.`, 2);
}

async function withTaskState<T>(
  fn: (opened: Awaited<ReturnType<typeof openStateStore>>) => T | Promise<T>,
): Promise<T> {
  const opened = await openStateStore();
  try {
    const schema = checkTaskSchema(opened.db);
    if (schema.status !== "ok") {
      const detail = schema.findings.map((finding) => finding.detail).join("; ");
      throw createCliError(
        `task lifecycle state schema is unavailable; run \`calyx state migrate --apply\`.${detail ? ` ${detail}` : ""}`,
        4,
      );
    }
    return await fn(opened);
  } finally {
    opened.db.close();
  }
}

async function withTaskRenderErrorReceipt<T>(
  json: boolean | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (json && error instanceof TaskRenderError) {
      console.log(JSON.stringify(error.receipt, null, 2));
    }
    throw error;
  }
}

function printTaskFindings(findings: readonly TaskFinding[]): void {
  for (const finding of findings) {
    console.log(`${finding.severity}\t${finding.code}\t${finding.task_id ?? "-"}\t${finding.message}`);
  }
}

function resolveCodexObservationOptions(options: TasksCodexObserveCommandOptions) {
  const codexHome = resolvePath(
    options.codexHome?.trim()
      || process.env["CODEX_HOME"]?.trim()
      || join(homedir(), ".codex"),
  );
  const tasksDir = options.tasksDir?.trim() || process.env[DEFAULT_TASKS_DIR_ENV]?.trim();
  const governancePath = options.governance?.trim()
    || (tasksDir ? join(resolvePath(tasksDir), "codex-desktop-automation-exemptions.yaml") : undefined);
  return {
    codexHome,
    codexDatabasePath: resolvePath(options.codexDb?.trim() || join(codexHome, "sqlite", "codex-dev.db")),
    ...(tasksDir ? { tasksDir: resolvePath(tasksDir) } : {}),
    ...(governancePath ? { governancePath: resolvePath(governancePath) } : {}),
    calyxStateDatabasePath: resolvePath(options.calyxStateDb?.trim() || resolveStatePaths().dbPath),
    mutationAuthority: "unavailable" as const,
  };
}

function printCodexAutomationObservation(
  result: Awaited<ReturnType<typeof observeCodexAutomations>>,
): void {
  for (const item of result.items) {
    console.log([
      item.id,
      item.status ?? "-",
      `projection=${item.projection}`,
      `governance=${item.governance.kind}/${item.governance.status}`,
      `classification=${item.classifications.join(",")}`,
    ].join("\t"));
  }
  for (const item of result.findings) {
    console.log(`${item.severity}\t${item.code}\t${item.automation_id ?? "-"}\t${item.message}`);
  }
  console.error(
    `Codex automation observation ${result.ok ? "OK" : "FOUND DRIFT"}: definitions=${result.counts.definitions} active=${result.counts.active} paused=${result.counts.paused} errors=${result.counts.errors}.`,
  );
}

function printTaskInstallRows(
  rows: Array<{ install_id: string; task_id: string; status: string; host: string; last_task_run_id: string | null; last_run_id: string | null }>,
): void {
  if (rows.length === 0) {
    console.log("no task installs");
    return;
  }
  for (const row of rows) {
    console.log(`${row.install_id}  ${row.status}  ${row.host}  ${row.task_id}  last_task_run=${row.last_task_run_id ?? "-"}  run=${row.last_run_id ?? "-"}`);
  }
}

function printTaskRunRows(
  rows: Array<{ task_run_id: string; task_id: string; status: string; trigger_kind: string; run_id: string | null; created_at: string }>,
): void {
  if (rows.length === 0) {
    console.log("no task runs");
    return;
  }
  for (const row of rows) {
    console.log(`${row.task_run_id}  ${row.status}  ${row.trigger_kind}  ${row.task_id}  run=${row.run_id ?? "-"}  ${row.created_at}`);
  }
}

function taskBackendToRunBackend(backend: string): SupportedBackend {
  if (backend === "codex_app") return "codex";
  if (backend === "claude_desktop" || backend === "claude_routine") return "claude";
  throw createCliError(
    `tasks run supports codex_app, claude_desktop, or claude_routine runtimes in v1; got ${backend}.`,
    2,
  );
}

function buildTaskRunPrompt(taskId: string, prompt: string): string {
  return [
    `You are running Calyx task ${taskId} manually in advisory-first POL-1730 mode.`,
    "Do not mutate external apps or durable operator state unless the task prompt explicitly requires it and the operator supplied the command manually.",
    "",
    prompt.trimEnd(),
  ].join("\n");
}

function buildTaskRunIntent(
  service: RunServiceLike,
  task: Awaited<ReturnType<typeof showTask>>["task"],
  options: TasksRunCommandOptions,
  launchPolicy: TaskLaunchPolicyV1,
): RunIntent {
  const host = options.host?.trim() || launchPolicy.host || "local";
  const workspace = task.runtime.workspace;
  const worktreePath = options.worktreePath?.trim() || workspace?.cwd?.trim();
  if (task.runtime.backend === "calyx") {
    const runtimeRecord = task.runtime as Record<string, unknown>;
    const argv = Array.isArray(runtimeRecord["argv"])
      ? runtimeRecord["argv"].map((value) => String(value)).filter((value) => value.trim().length > 0)
      : [];
    if (argv.length === 0) {
      throw createCliError("tasks run for runtime.backend=calyx requires runtime.argv tokens.", 2);
    }
    return service.createIntent({
      kernel: "host_process",
      ...(options.runId?.trim() ? { run_id: options.runId.trim() } : {}),
      host,
      host_process: {
        argv,
        cwd: worktreePath || process.cwd(),
      },
      metadata: {
        launcher_kind: "cli",
        launcher_id: "calyx.tasks.run",
        task_id: task.id,
        task_mode: launchPolicy.mode,
        task_runtime_backend: task.runtime.backend,
      },
    });
  }

  const backend = taskBackendToRunBackend(task.runtime.backend);
  const backendOptions: NonNullable<RunIntent["backend_options"]> = {};
  if (task.runtime.model) {
    backendOptions.model = task.runtime.model;
  }
  if (task.runtime.reasoning_effort) {
    backendOptions.reasoning_effort = task.runtime.reasoning_effort;
  }
  return service.createIntent({
    kernel: "agent_runner",
    ...(options.runId?.trim() ? { run_id: options.runId.trim() } : {}),
    host,
    backend,
    prompt: buildTaskRunPrompt(task.id, task.prompt.body),
    require_execplan: false,
    ...(worktreePath ? { worktree_mode: "existing", worktree_path: worktreePath } : {}),
    ...(Object.keys(backendOptions).length > 0 ? { backend_options: backendOptions } : {}),
    metadata: {
      launcher_kind: "cli",
      launcher_id: "calyx.tasks.run",
      task_id: task.id,
      task_mode: launchPolicy.mode,
      task_runtime_backend: task.runtime.backend,
    },
  });
}

async function loadPromptVariablesFile(filePath: string): Promise<Record<string, string>> {
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createCliError(`Failed to read --vars-file ${filePath}: ${message}`, 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createCliError(`Failed to parse JSON in --vars-file ${filePath}: ${message}`, 1);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw createCliError(`Invalid --vars-file ${filePath}: expected a JSON object of prompt variables.`, 2);
  }

  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      variables[key] = String(value);
      continue;
    }
    throw createCliError(
      `Invalid --vars-file ${filePath}: variable "${key}" must be a string, number, or boolean.`,
      2,
    );
  }
  return variables;
}

function defaultRunWorktreeBase(): string {
  const fromEnv = process.env[DEFAULT_RUNNER_WORKTREE_BASE_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return join(homedir(), "projects");
}

function defaultRunsRoot(): string {
  const fromEnv = process.env[DEFAULT_RUNS_ROOT_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return join(homedir(), ".calyx", "runs");
}

async function readRunServeHostsTruth(deps: RunCliDependencies): Promise<HostsTruthFile> {
  const agentsInfraRoot = deps.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    return {};
  }
  return readHostsTruth(agentsInfraRoot);
}

function configuredMessageHostAliases(hostsTruth: HostsTruthFile): Readonly<Record<string, string>> {
  const aliases = Object.create(null) as Record<string, string>;
  const addAlias = (identity: string, canonicalHost: string): void => {
    const exactIdentity = identity.trim().toLowerCase();
    const exactCanonicalHost = canonicalHost.trim().toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9.-]*$/u.test(exactIdentity)
      || !/^[a-z0-9][a-z0-9-]*$/u.test(exactCanonicalHost)
    ) {
      throw createCliError(`Invalid run-serve host identity ${JSON.stringify(identity)} in hosts truth.`, 2);
    }
    const existing = aliases[exactIdentity];
    if (existing && existing !== exactCanonicalHost) {
      throw createCliError(
        `Run-serve host identity ${exactIdentity} is ambiguous between ${existing} and ${exactCanonicalHost}.`,
        2,
      );
    }
    aliases[exactIdentity] = exactCanonicalHost;
  };

  for (const [host, entry] of Object.entries(hostsTruth.hosts ?? {})) {
    const runServeUrl = entry.run_serve_url?.trim();
    if (!runServeUrl) continue;
    let parsed: URL;
    try {
      parsed = new URL(runServeUrl);
    } catch {
      throw createCliError(`Host ${host} has an invalid run_serve_url.`, 2);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== ""
      || parsed.password !== ""
      || !parsed.hostname
    ) {
      throw createCliError(`Host ${host} run_serve_url must be an HTTP(S) URL without embedded credentials.`, 2);
    }
    addAlias(host, host);
    addAlias(parsed.hostname, host);
  }
  return Object.freeze(aliases);
}

function configuredMessageRunServeTarget(
  hostsTruth: HostsTruthFile,
  aliases: Readonly<Record<string, string>>,
  host: string,
): { host: string; serverUrl: string } | undefined {
  const exactHost = host.trim().toLowerCase();
  const canonicalHost = Object.prototype.hasOwnProperty.call(aliases, exactHost)
    ? aliases[exactHost]
    : undefined;
  if (!canonicalHost) return undefined;
  const serverUrl = hostsTruth.hosts?.[canonicalHost]?.run_serve_url?.trim();
  return serverUrl ? { host: canonicalHost, serverUrl } : undefined;
}

function parseRunPsAgentKind(rawValue?: string): InteractiveSessionBackend | undefined {
  const value = rawValue?.trim().toLowerCase();
  if (!value || value === "all") {
    return undefined;
  }
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw createCliError("--agent-kind must be one of: all, claude, codex.", 2);
}

function parseSinceHoursMs(rawValue?: string): number | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createCliError("--since-hours must be a positive number.", 2);
  }
  return Math.round(parsed * 60 * 60 * 1000);
}

function parseNonNegativeIntegerOption(rawValue: string | undefined, label: string): number | undefined {
  if (!rawValue?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createCliError(`${label} must be a non-negative integer.`, 2);
  }
  return parsed;
}

function parsePositiveIntegerOption(rawValue: string | undefined, label: string): number | undefined {
  if (!rawValue?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw createCliError(`${label} must be a positive integer.`, 2);
  }
  return parsed;
}

const LOKI_SINCE_PATTERN = /^\d+(ms|s|m|h|d|w|y)$/;

function parseLokiSince(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!LOKI_SINCE_PATTERN.test(trimmed)) {
    throw createCliError(
      `Invalid ${flag} value: ${value}. Expected a Loki duration like 7d, 24h, 30m; got ${value}.`,
      2,
    );
  }
  return trimmed;
}

function parseVaultFootnotesMode(rawValue: string | undefined): VaultFetchFootnotesMode | undefined {
  if (!rawValue?.trim()) {
    return undefined;
  }
  const mode = rawValue.trim();
  if (mode !== "collapsed" && mode !== "expanded") {
    throw createCliError(`[calyx vault fetch] --footnotes must be collapsed or expanded (got: ${rawValue}).`, 2);
  }
  return mode;
}

function parseVaultJournalKind(rawValue: string | undefined): "auto" | VaultJournalEntryKind | "table-row" | undefined {
  if (!rawValue?.trim()) {
    return undefined;
  }
  const kind = rawValue.trim();
  if (kind === "auto" || kind === "heading" || kind === "bullet" || kind === "table-row") {
    return kind;
  }
  throw createCliError(`[calyx vault journal entries] --kind must be one of: auto, heading, bullet, table-row (got: ${rawValue}).`, 2);
}

function parseVaultJournalFields(entries: string[] | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw createCliError(`[calyx vault journal append] --field expects k=v (got: ${entry})`, 2);
    }
    fields[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
  }
  return fields;
}

function quoteYamlString(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _:./@+-]*$/.test(value)
    && !value.includes(": ")
    && !value.includes(" #")
    && !/\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

function formatJournalSuggestedContract(contract: VaultJournalSuggestedContract): string {
  const lines = ["journal:", `  order: ${contract.journal.order}`];
  if (contract.journal.entry) {
    lines.push("  entry:", `    kind: ${contract.journal.entry.kind}`);
    if (contract.journal.entry.heading) {
      lines.push(`    heading: ${quoteYamlString(contract.journal.entry.heading)}`);
    }
    if (contract.journal.entry.bullet) {
      lines.push(`    bullet: ${quoteYamlString(contract.journal.entry.bullet)}`);
    }
    if (contract.journal.entry.continuation_indent) {
      lines.push(`    continuation_indent: ${quoteYamlString(contract.journal.entry.continuation_indent)}`);
    }
    if (contract.journal.entry.fields && contract.journal.entry.fields.length > 0) {
      lines.push("    fields:");
      for (const field of contract.journal.entry.fields) {
        lines.push(`      - ${quoteYamlString(field)}`);
      }
    }
  }
  if (contract.journal.sections && Object.keys(contract.journal.sections).length > 0) {
    lines.push("  sections:");
    for (const [name, section] of Object.entries(contract.journal.sections)) {
      lines.push(`    ${quoteYamlString(name)}:`, `      kind: ${section.kind}`);
      if (section.order) {
        lines.push(`      order: ${section.order}`);
      }
      if (section.mode) {
        lines.push(`      mode: ${section.mode}`);
      }
      if (section.heading) {
        lines.push(`      heading: ${quoteYamlString(section.heading)}`);
      }
      if (section.bullet) {
        lines.push(`      bullet: ${quoteYamlString(section.bullet)}`);
      }
      if (section.continuation_indent) {
        lines.push(`      continuation_indent: ${quoteYamlString(section.continuation_indent)}`);
      }
      if (section.fields && section.fields.length > 0) {
        lines.push("      fields:");
        for (const field of section.fields) {
          lines.push(`        - ${quoteYamlString(field)}`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function currentCliEntrypoint(): string | undefined {
  const entrypoint = process.argv[1]?.trim();
  return entrypoint && entrypoint.length > 0 ? entrypoint : undefined;
}

async function findLatestRuntimeSession(
  backend?: SupportedBackend,
): Promise<LatestSessionInfo | undefined> {
  if (backend === "claude") {
    return findLatestClaudeSession();
  }
  if (backend === "codex") {
    return findLatestCodexSession();
  }

  const [claude, codex] = await Promise.all([
    findLatestClaudeSession(),
    findLatestCodexSession(),
  ]);

  if (!claude && !codex) return undefined;
  if (!claude) return codex;
  if (!codex) return claude;
  return claude.startedAt >= codex.startedAt ? claude : codex;
}

async function parseBackendAssistantMessages(
  backend: string,
  sessionPath: string,
): Promise<AssistantMessage[]> {
  if (backend === "claude") {
    return parseClaudeAssistantMessages(sessionPath);
  }
  if (backend === "codex") {
    return parseCodexAssistantMessages(sessionPath);
  }
  return [];
}

function createRuntimeCompositionRoot(): {
  runtimeAdapterRegistry: RuntimeAdapterRegistry;
  trackerRegistry: TrackerRegistry;
  exitClassifierPipeline: ClassifierPipeline;
} {
  const runtimeAdapterRegistry = registerBuiltInRuntimeAdapters(createRuntimeAdapterRegistry());
  runtimeAdapterRegistry.register("codex", createCodexRuntimeAdapterFactory({
    liveBindings: { enabled: true },
  }));
  const trackerRegistry = createTrackerRegistry();
  trackerRegistry.register("linear", createLinearTrackerFactory());

  return {
    runtimeAdapterRegistry,
    trackerRegistry,
    exitClassifierPipeline: new ClassifierPipeline([
      new ExitZeroClassifier(),
      new SpawnErrorClassifier(),
      new SessionEvidenceClassifier({
        parsers: {
          codex: parseCodexAssistantMessages,
        },
      }),
      new StderrPatternClassifier(),
      new DurationHeuristicClassifier(),
      new DefaultClassifier(),
    ]),
  };
}

function buildLocalRunServiceOptions(args: {
  runsRoot?: string;
  defaultWorktreeBase?: string;
}): {
  runsRoot?: string;
  workerEntrypoint?: string;
  defaultWorktreeBase?: string;
  runtimeAdapterRegistry: RuntimeAdapterRegistry;
  trackerRegistry: TrackerRegistry;
  exitClassifierPipeline: ClassifierPipeline;
} {
  const workerEntrypoint = currentCliEntrypoint();
  return {
    ...(args.runsRoot ? { runsRoot: args.runsRoot } : {}),
    ...(workerEntrypoint ? { workerEntrypoint } : {}),
    ...(args.defaultWorktreeBase ? { defaultWorktreeBase: args.defaultWorktreeBase } : {}),
    ...createRuntimeCompositionRoot(),
  };
}

function usesRemoteRunServer(host: string, explicitServerUrl?: string): boolean {
  if (explicitServerUrl?.trim()) {
    return true;
  }
  return !isLocalRunTarget(host, { hostname: () => systemHostname() });
}

async function planRemoteRunTopology(
  requestedHost: string,
  deps: RunCliDependencies,
): Promise<string> {
  const targets = await (deps.resolveFleetTopology
    ?? ((intent) => resolveFleetTopologyForCommand(intent, deps.agentsInfraRoot)))("mutating");
  const host = requestedHost.trim().toLowerCase() === "local"
    ? deps.currentHostAlias
      ?? await (deps.resolveCurrentHostAlias ?? resolveCurrentHostAlias)(undefined, deps.agentsInfraRoot)
    : requestedHost.trim().toLowerCase().split(".")[0]!;
  const target = targets.desired_active.find((candidate) => candidate.host === host);
  if (!target) {
    const withdrawn = targets.withdrawn.some((candidate) => candidate.host === host);
    throw createCliError(
      withdrawn
        ? `Remote run launch refused: ${host} is withdrawn in the current topology. Re-plan for a desired-active host.`
        : `Remote run launch refused: ${host} is not desired-active in the current topology. Refresh topology and re-plan.`,
      6,
    );
  }
  const digest = targets.snapshot.projection_sha256;
  if (!digest) {
    throw createCliError(
      "Remote run launch refused: authoritative topology has no projection digest. Repair topology authority and re-plan.",
      6,
    );
  }
  return digest;
}

function buildOrchestrationLedgerIngest(): RunServiceOptions["eventLogIngest"] {
  // The sink lazy-initializes on first event and disables itself when
  // migration 0002 is not yet applied. JSON/JSONL receipts remain
  // authoritative; this is a projection only.
  const sink = new OrchestrationLedgerSink({
    host: systemHostname().split(".")[0]?.toLowerCase(),
    source: "run-service",
  });
  return (event) => sink.ingestStreamEvent(event);
}

function buildRunIndexProjection(): RunIndexProjection {
  // Lazy-init: opens the state DB on first call and disables itself if
  // migration 0003 is absent. Wave 2.2 contract: SQLite is the source of
  // truth for the run list; there is no fallback to `runs/index.jsonl`.
  return new RunIndexProjection();
}

function createLocalRunService(
  deps: RunCliDependencies,
  options: {
    runsRoot?: string;
    workerEntrypoint?: string;
    defaultWorktreeBase?: string;
    runtimeAdapterRegistry: RuntimeAdapterRegistry;
    trackerRegistry: TrackerRegistry;
    exitClassifierPipeline: ClassifierPipeline;
  },
): RunServiceLike {
  if (deps.createRunService) {
    return deps.createRunService(options);
  }
  return new RunService({
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
    ...(options.workerEntrypoint ? { workerEntrypoint: options.workerEntrypoint } : {}),
    ...(options.defaultWorktreeBase ? { defaultWorktreeBase: options.defaultWorktreeBase } : {}),
    runtimeAdapterRegistry: options.runtimeAdapterRegistry,
    exitClassifierPipeline: options.exitClassifierPipeline,
    eventLogIngest: buildOrchestrationLedgerIngest(),
    runIndex: buildRunIndexProjection(),
    workloadAdmission: {
      reconcile: createInterimWorkloadAdmissionReconciler({
        build: loadServerBuildInfo(),
        reachability: "in_process_composition",
        ...(deps.agentsInfraRoot ? { agentsInfraRoot: deps.agentsInfraRoot } : {}),
      }),
    },
  });
}

function createConcreteRunService(options: {
  runsRoot?: string;
  workerEntrypoint?: string;
  defaultWorktreeBase?: string;
  runtimeAdapterRegistry: RuntimeAdapterRegistry;
  trackerRegistry: TrackerRegistry;
  exitClassifierPipeline: ClassifierPipeline;
  monitorEvaluator?: RunServiceOptions["monitorEvaluator"];
  activityTailer?: RunServiceOptions["activityTailer"];
  messageOutbox?: RunServiceOptions["messageOutbox"];
  detachedWorkerRedactedEnvNames?: readonly string[];
  workloadAdmissionReachability?: "daemon_listener" | "in_process_composition";
  hostname?: string;
  agentsInfraRoot?: string;
}): RunService {
  return new RunService({
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
    ...(options.workerEntrypoint ? { workerEntrypoint: options.workerEntrypoint } : {}),
    ...(options.defaultWorktreeBase ? { defaultWorktreeBase: options.defaultWorktreeBase } : {}),
    runtimeAdapterRegistry: options.runtimeAdapterRegistry,
    exitClassifierPipeline: options.exitClassifierPipeline,
    eventLogIngest: buildOrchestrationLedgerIngest(),
    runIndex: buildRunIndexProjection(),
    ...(options.hostname ? { hostname: options.hostname } : {}),
    workloadAdmission: {
      reconcile: createInterimWorkloadAdmissionReconciler({
        build: loadServerBuildInfo(),
        reachability: options.workloadAdmissionReachability ?? "in_process_composition",
        ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
      }),
    },
    ...(options.monitorEvaluator ? { monitorEvaluator: options.monitorEvaluator } : {}),
    ...(options.activityTailer ? { activityTailer: options.activityTailer } : {}),
    ...(options.messageOutbox ? { messageOutbox: options.messageOutbox } : {}),
    ...(options.detachedWorkerRedactedEnvNames
      ? { detachedWorkerRedactedEnvNames: options.detachedWorkerRedactedEnvNames }
      : {}),
  });
}

function defaultDaemonId(workflowPath: string): string {
  const parent = dirname(workflowPath).split("/").filter(Boolean).pop() ?? "workflow";
  const base = workflowPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "workflow";
  return `${parent}-${base}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Resolve a WORKFLOW.md path from `--workflow` (operator override) OR
 * `--project <slug>` (fleet-managed canonical resolution). Wave 3 makes
 * these mutually exclusive and requires one; cwd fallback is removed so
 * fleet-managed projects always resolve through hosts.yaml truth.
 */
async function resolveDaemonWorkflowPath(options: {
  workflow?: string | undefined;
  project?: string | undefined;
  host?: string | undefined;
  agentsInfraRoot?: string | undefined;
}): Promise<{ workflowPath: string; project?: string }> {
  const workflow = options.workflow?.trim();
  const project = options.project?.trim();
  if (workflow && project) {
    throw createCliError(
      "--workflow and --project are mutually exclusive. Use --workflow for ad-hoc overrides; use --project for fleet-managed resolution.",
      2,
    );
  }
  if (workflow) {
    return { workflowPath: resolvePath(workflow) };
  }
  if (!project) {
    throw createCliError(
      "One of --workflow <path> or --project <slug> is required for daemon start/tick.",
      2,
    );
  }
  const agentsInfraRoot = await resolveAgentsInfraRoot({
    ...(options.agentsInfraRoot ? { explicitRoot: options.agentsInfraRoot } : {}),
  });
  if (!agentsInfraRoot) {
    throw createCliError(
      "Unable to resolve agents-infra root for --project. Set CALYX_AGENTS_INFRA_ROOT or pass --agents-infra-root.",
      2,
    );
  }
  const host = (options.host ?? "local").trim() || "local";
  const repoRoot = await resolveRepoForRun(project, host, agentsInfraRoot);
  const workflowPath = join(repoRoot, "WORKFLOW.md");
  return { workflowPath, project };
}

function projectDerivedDaemonId(project: string): string {
  return `calyx-symphony-${project.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function createLocalDaemonService(options: {
  runsRoot?: string;
  daemonsRoot?: string;
  defaultWorktreeBase?: string;
  stateDb?: import("@polli-labs/calyx-core").StateDriverDatabase;
  host?: string;
}): DaemonService {
  const compositionRoot = buildLocalRunServiceOptions({
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
    ...(options.defaultWorktreeBase ? { defaultWorktreeBase: options.defaultWorktreeBase } : {}),
  });
  const runService = createConcreteRunService(compositionRoot);
  return new DaemonService({
    runService,
    trackerRegistry: compositionRoot.trackerRegistry,
    ...(options.daemonsRoot ? { daemonsRoot: options.daemonsRoot } : {}),
    ...(options.stateDb ? { stateDb: options.stateDb } : {}),
    ...(options.host ? { host: options.host } : {}),
    activityResolver: createRunActivityResolver(runService),
  });
}

function createRunActivityResolver(runService: RunService): DaemonActivityResolver {
  return {
    async resolve(input) {
      const turns = await runService.inspectActivityTurns({
        activityId: `run:${input.run_id}`,
        selector: {
          role: "assistant",
          last: 1,
          summary_only: true,
          max_text_chars: 0,
        },
      });
      const latestAssistantTurn = turns.turns.at(-1);
      return {
        activity_id: turns.activity_id,
        ...(latestAssistantTurn?.turn_id ? { latest_assistant_turn_id: latestAssistantTurn.turn_id } : {}),
      };
    },
  };
}

/**
 * Open the SQLite orchestration ledger handle used by daemon tick/start.
 * Applies pending migrations idempotently so a fresh state home can run
 * immediately. Daemon claim/handoff truth is ledger-backed, so the CLI
 * fails closed if the state store cannot be opened.
 */
async function openLocalDaemonStateDb(): Promise<import("@polli-labs/calyx-core").StateDriverDatabase> {
  try {
    await applyStateMigrations();
    const opened = await openStateStore();
    return opened.db;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createCliError(`Unable to open Calyx state store for daemon ledger: ${message}`, 7);
  }
}

async function startDaemonCommand(options: RunDaemonStartCommandOptions): Promise<DaemonStartResult> {
  const resolved = await resolveDaemonWorkflowPath({
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
  });
  const workflowPath = resolved.workflowPath;
  const daemonId = options.daemonId?.trim()
    || (resolved.project ? projectDerivedDaemonId(resolved.project) : defaultDaemonId(workflowPath));
  const runsRoot = options.runsRoot?.trim() || defaultRunsRoot();
  const daemonsRoot = options.daemonsRoot?.trim() || defaultDaemonsRoot();

  if (options.foreground) {
    const stateDb = await openLocalDaemonStateDb();
    const daemonService = createLocalDaemonService({
      runsRoot,
      daemonsRoot,
      defaultWorktreeBase: defaultRunWorktreeBase(),
      stateDb,
      ...(options.host ? { host: options.host } : {}),
    });
    try {
      return await daemonService.startForeground(workflowPath, daemonId);
    } finally {
      stateDb.close();
    }
  }

  const entrypoint = currentCliEntrypoint();
  if (!entrypoint) {
    throw createCliError("Unable to determine the current CLI entrypoint for daemon start.", 6);
  }

  const { spawn } = await import("node:child_process");
  const daemonDir = join(daemonsRoot, daemonId);
  const timestampStem = `daemon-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const logHandles = openDetachedLogFiles(daemonDir, {
    stdoutName: `${timestampStem}.stdout.log`,
    stderrName: `${timestampStem}.stderr.log`,
  });
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        entrypoint,
        "run",
        "daemon",
        "start",
        "--workflow",
        workflowPath,
        "--daemon-id",
        daemonId,
        "--foreground",
        "--runs-root",
        runsRoot,
        "--daemons-root",
        daemonsRoot,
        ...(options.host ? ["--host", options.host] : []),
      ],
      {
        detached: true,
        stdio: logHandles.stdio,
        env: {
          ...process.env,
          [DEFAULT_RUNS_ROOT_ENV]: runsRoot,
          [DEFAULT_DAEMONS_ROOT_ENV]: daemonsRoot,
        },
      },
    );
  } finally {
    logHandles.closeParentFds();
  }
  child.unref();
  if (!child.pid) {
    throw createCliError("Detached daemon process did not expose a PID.", 6);
  }

  const daemonService = createLocalDaemonService({
    runsRoot,
    daemonsRoot,
    defaultWorktreeBase: defaultRunWorktreeBase(),
  });
  await daemonService.store.ensureDaemonRoot(daemonId);
  await daemonService.store.writePid(daemonId, child.pid);
  const record = await daemonService.getStatus(daemonId) ?? {
    schema_version: "1.0",
    daemon_id: daemonId,
    workflow_path: workflowPath,
    status: "running" as const,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    pid: child.pid,
    claimed_issues: 0,
    active_runs: 0,
  };

  return {
    daemon_id: daemonId,
    state_root: daemonService.store.paths(daemonId).daemonDir,
    record,
    pid: child.pid,
  };
}

async function daemonStatusCommand(options: RunDaemonStatusCommandOptions): Promise<DaemonRecord | undefined> {
  const daemonService = createLocalDaemonService({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    daemonsRoot: options.daemonsRoot?.trim() || defaultDaemonsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  });
  return daemonService.getStatus(options.daemonId.trim());
}

async function daemonLogsCommand(options: RunDaemonLogsCommandOptions): Promise<DaemonEvent[]> {
  const daemonService = createLocalDaemonService({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    daemonsRoot: options.daemonsRoot?.trim() || defaultDaemonsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  });
  const tail = options.tail ? parsePositiveInteger(options.tail, "--tail") : undefined;
  return daemonService.readLogs(options.daemonId.trim(), tail);
}

async function daemonStopCommand(options: RunDaemonStopCommandOptions): Promise<{ stopped: boolean; pid?: number | undefined }> {
  const daemonService = createLocalDaemonService({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    daemonsRoot: options.daemonsRoot?.trim() || defaultDaemonsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  });
  return daemonService.stop(options.daemonId.trim());
}

async function daemonTickCommand(options: RunDaemonTickCommandOptions): Promise<DaemonTickResult> {
  const resolved = await resolveDaemonWorkflowPath({
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
  });
  const workflowPath = resolved.workflowPath;
  const daemonId = options.daemonId?.trim()
    || (resolved.project ? projectDerivedDaemonId(resolved.project) : defaultDaemonId(workflowPath));
  const stateDb = await openLocalDaemonStateDb();
  const daemonService = createLocalDaemonService({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    daemonsRoot: options.daemonsRoot?.trim() || defaultDaemonsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
    stateDb,
    ...(options.host ? { host: options.host } : {}),
  });
  try {
    return await daemonService.tick(workflowPath, daemonId, { awaitLaunchedRuns: true });
  } finally {
    stateDb.close();
  }
}

async function daemonPlanCommand(options: RunDaemonPlanCommandOptions): Promise<DaemonPlanResult> {
  const resolved = await resolveDaemonWorkflowPath({
    ...(options.workflow ? { workflow: options.workflow } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
  });
  const workflowPath = resolved.workflowPath;
  const daemonId = options.daemonId?.trim()
    || (resolved.project ? projectDerivedDaemonId(resolved.project) : defaultDaemonId(workflowPath));
  const daemonService = createLocalDaemonService({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    daemonsRoot: options.daemonsRoot?.trim() || defaultDaemonsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
    ...(options.host ? { host: options.host } : {}),
  });
  return daemonService.plan(workflowPath, daemonId);
}

function printDaemonPlanHuman(result: DaemonPlanResult): void {
  console.log(`daemon_id: ${result.daemon_id}`);
  console.log(`  verdict: ${result.verdict.verdict}`);
  console.log(`  selected_issues: ${result.selected_issues.map((issue) => issue.issue_identifier).join(", ") || "(none)"}`);
  console.log(`  eligible_issues: ${result.eligible_issues.length}`);
  console.log(`  skipped_issues: ${result.skipped_issues.length}`);
  console.log(`  active_runs: ${result.active_runs.length}`);
  console.log(`  available_launch_slots: ${result.available_launch_slots}`);
  if (result.verdict.blocking_reasons.length > 0) {
    console.log(`  blocking_reasons: ${result.verdict.blocking_reasons.join(", ")}`);
  }
  if (result.warnings.length > 0) {
    console.log(`  warnings: ${result.warnings.map((warning) => warning.code).join(", ")}`);
  }
}

function fromAdminRunRecord(record: AdminRunRecord): RunRecord {
  return { ...record, schema_version: "1.0" };
}

async function submitRemoteRun(
  deps: RunCliDependencies,
  options: {
    serverUrl: string;
    token: string;
    request: RunLaunchRequest;
  },
): Promise<RemoteAcceptedRunLaunchResult> {
  const submitted = await executeRecoverableMutation(deps, options, {
    context: "run launch",
    replayCommand: "calyx run launch --replay-request",
    operation: (client) => client.admin.run.launch({
      body: options.request as unknown as Parameters<CalyxAdminClient["admin"]["run"]["launch"]>[0]["body"],
    }),
  });
  return acceptedRemoteRunResult(deps, options, submitted);
}

async function acceptedRemoteRunResult(
  deps: RunCliDependencies,
  access: { serverUrl: string; token: string },
  submitted: unknown,
): Promise<RemoteAcceptedRunLaunchResult> {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    throw createCliError("run server returned an invalid launch result.", 6);
  }
  const wire = submitted as Record<string, unknown>;
  if (wire["schema_version"] !== "calyx.run-launch-result/v1") {
    throw createCliError(
      `run server returned unsupported launch schema ${String(wire["schema_version"])}.`,
      6,
    );
  }
  const receipt = submitted as AdminRunLaunchReceipt;
  let observation: RemoteAcceptedRunLaunchResult["observation"];
  try {
    const wireRecord = await remoteAdminRunRecord(
      deps,
      access,
      receipt.run_id,
      `accepted run ${receipt.run_id}`,
    );
    const record = fromAdminRunRecord(wireRecord);
    observation = { status: "available", state: record.state, record };
  } catch (error) {
    observation = {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    schema_version: "calyx.remote-run-launch/v1",
    status: "accepted",
    run_id: receipt.run_id,
    mode: "remote",
    server_url: access.serverUrl,
    operation: {
      route: generatedServerRoute(access.serverUrl, receipt.operation.route),
      events_route: generatedServerRoute(access.serverUrl, receipt.operation.events_route),
      receipt_route: generatedServerRoute(access.serverUrl, receipt.operation.receipt_route),
    },
    observation,
  };
}

async function replayRemoteRunLaunch(
  deps: RunCliDependencies,
  artifactPath: string,
  authToken?: string,
): Promise<LaunchedRunWithIntent> {
  const custody = await openRecoveryCustody(deps);
  const receipt = await custody.readReceipt(artifactPath);
  if (receipt.operation_id !== "admin.run.launch") {
    throw createCliError(`Generated recovery receipt ${artifactPath} does not target admin.run.launch.`, 2);
  }
  let request: RunLaunchRequest;
  try {
    const bodyText = Buffer.from(receipt.body_bytes, "base64").toString("utf8");
    request = validateOperationRequest("admin.run.launch", JSON.parse(bodyText)) as RunLaunchRequest;
  } catch {
    throw createCliError(`Generated recovery receipt ${artifactPath} does not contain a valid portable run launch.`, 2);
  }
  if (
    request.schema_version !== "calyx.run-launch-request/v1"
    || !request.intent
    || typeof request.intent.run_id !== "string"
    || typeof request.idempotency_key !== "string"
    || request.idempotency_key !== receipt.idempotency_key
  ) {
    throw createCliError(`Generated recovery receipt ${artifactPath} does not contain a valid portable run launch.`, 2);
  }
  const access = await resolveRecoveryReceiptAccess(receipt, authToken, deps);
  const submitted = await replayGeneratedMutation(
    deps,
    artifactPath,
    "admin.run.launch",
    "calyx run launch --replay-request",
    authToken,
  );
  const result = await acceptedRemoteRunResult(deps, access, submitted);
  return { intent: request.intent, result };
}

function parseRunSubscribeFormat(rawValue?: string): "jsonl" | "pretty" {
  const value = rawValue?.trim().toLowerCase() ?? "jsonl";
  if (value === "jsonl" || value === "pretty") {
    return value;
  }
  throw createCliError(`Invalid --format value for run subscribe: ${String(rawValue)}. Must be one of: jsonl, pretty.`, 2);
}

function parseRunEventType(rawValue?: string): CalyxStreamEventType | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim();
  if (
    value === "run.terminal"
    || value === "run.progress"
    || value === "run.warning"
    || value === "daemon.health.checked"
    || value === "daemon.drift.detected"
    || value === "daemon.upgrade.started"
    || value === "daemon.upgrade.progress"
    || value === "daemon.upgrade.completed"
    || value === "daemon.upgrade.failed"
    || value === "daemon.upgrade.fleet.started"
    || value === "daemon.upgrade.fleet.completed"
    || value === "daemon.upgrade.fleet.failed"
    || value === "monitor.wake.created"
  ) {
    return value;
  }
  throw createCliError(
    `Invalid --event-type value for run subscribe: ${String(rawValue)}.`,
    2,
  );
}

function parseRunAwaitTimeoutMs(rawValue?: string): number {
  if (!rawValue) return DEFAULT_RUN_AWAIT_TIMEOUT_MS;
  const match = /^(\d+)(ms|s|m|h)$/u.exec(rawValue.trim().toLowerCase());
  if (!match) {
    throw createCliError(
      `Invalid --timeout value for run await: ${JSON.stringify(rawValue)}. Use a positive duration such as 500ms, 30s, 5m, or 1h.`,
      2,
    );
  }
  const amount = Number.parseInt(match[1]!, 10);
  const multiplier = match[2] === "ms"
    ? 1
    : match[2] === "s"
      ? 1_000
      : match[2] === "m"
        ? 60_000
        : 3_600_000;
  const timeoutMs = amount * multiplier;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw createCliError("run await --timeout must be a positive safe duration.", 2);
  }
  return timeoutMs;
}

type RunAwaitStopReason = "timeout" | "sigint" | "sigterm";

interface RunAwaitControl {
  signal: AbortSignal;
  stopReason: () => RunAwaitStopReason | undefined;
  dispose: () => void;
}

function createRunAwaitControl(timeoutMs: number): RunAwaitControl {
  const controller = new AbortController();
  let reason: RunAwaitStopReason | undefined;
  const stop = (nextReason: RunAwaitStopReason): void => {
    if (reason) return;
    reason = nextReason;
    controller.abort(new DOMException(`run await stopped: ${nextReason}`, "AbortError"));
  };
  const timeout = setTimeout(() => stop("timeout"), timeoutMs);
  const onSigint = (): void => stop("sigint");
  const onSigterm = (): void => stop("sigterm");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    stopReason: () => reason,
    dispose: () => {
      clearTimeout(timeout);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

function toRunStatusResult(
  record: RunRecord,
  handle: ResolvedRunHandle,
  options: RunReadCommandOptions,
): RunStatusResult {
  const outcome = buildRunOutcomeProjection(record, handle, options);
  return {
    schema_version: "calyx.run-status/v2",
    ...outcome,
  };
}

function renderSubscribedEvent(event: StreamedRunEvent, format: "jsonl" | "pretty"): void {
  if (format === "jsonl") {
    console.log(JSON.stringify(event));
    return;
  }
  if (isCalyxStreamProjectionGapEvent(event)) {
    console.log(
      `[${event.cursor}] ${event.event_type} source=${event.gap.source_event_type} reason=${event.gap.reason}`,
    );
    return;
  }
  if (isCalyxControlEvent(event)) {
    const daemonId = event.control.daemon_id ? ` daemon=${event.control.daemon_id}` : "";
    const operation = event.control.operation_id ? ` op=${event.control.operation_id}` : "";
    const phase = event.control.phase ? ` phase=${event.control.phase}` : "";
    const build = event.control.build ? ` build=${event.control.build.git_head}` : "";
    const error = event.control.error ? ` error=${event.control.error}` : "";
    console.log(`[${event.emitted_at}] ${event.control.host} ${event.event_type} ${event.emitted_by}${operation}${phase}${daemonId}${build}${error}`);
    return;
  }
  if (isCalyxMonitorEvent(event)) {
    console.log(`[${event.emitted_at}] ${event.monitor.monitor_id} wake=${event.monitor.wake_id} ${event.summary.one_line}`);
    return;
  }
  console.log(`[${event.emitted_at}] ${event.run.run_id} ${event.run.state} ${event.emitted_by} ${event.summary.one_line}`);
}

async function waitForRunEventReconnect(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, 1_000);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function streamRunEvents(
  options: RunSubscribeCommandOptions,
  deps: RunCliDependencies,
  hooks: RunEventStreamHooks,
): Promise<{ lastCursor?: string }> {
  const after = options.after?.trim();
  const runId = options.runId?.trim();
  if (!after && !runId) {
    throw createCliError("run subscribe requires --after on cold starts unless --run-id is provided.", 2);
  }

  const host = options.host?.trim()
    || deps.currentHostAlias?.trim()
    || deps.hostname?.().split(".")[0]?.toLowerCase()
    || systemHostname().split(".")[0]?.toLowerCase()
    || "localhost";
  const access = await resolveRunServerAccess({
    host,
    serverUrl: options.serverUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `run subscribe requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
      2,
    );
  }

  const { serverUrl, token } = access;
  const eventType = parseRunEventType(options.eventType);
  let lastCursor = after && after.length > 0 ? after : undefined;
  let stopRequested = false;
  let activeAbort: AbortController | undefined;
  const stopController = new AbortController();
  const requestStop = (): void => {
    stopRequested = true;
    activeAbort?.abort();
    stopController.abort();
  };
  const onExternalAbort = (): void => requestStop();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) requestStop();
  const removeStopListener = hooks.onStopRequested?.(requestStop);

  try {
    while (!stopRequested) {
      let disconnectError: unknown;
      try {
        activeAbort = new AbortController();
        const result = await remoteAdminClient(deps, { serverUrl, token }, {
          retry: { sseReconnectAttempts: 0 },
        }).admin.events({
          query: {
            ...(lastCursor ? { after: lastCursor } : {}),
            ...(runId ? { run_id: runId } : {}),
            ...(eventType ? { event_type: eventType } : {}),
          },
          ...(lastCursor ? { lastEventId: lastCursor } : {}),
          signal: activeAbort.signal,
        });
        if (!result.ok) {
          if (result.kind === "transport" && result.stage === "network") {
            disconnectError = new Error(result.message);
          } else {
            requireClientResult(result, "run subscribe");
          }
        } else {
          const stream = result.data;
          if (hooks.onConnected && await hooks.onConnected()) {
            requestStop();
            stream.cancel();
            break;
          }
          for await (const generatedEvent of stream) {
            if (stopRequested) break;
            if (!isCalyxDeliveredStreamEvent(generatedEvent)) {
              throw new CalyxSseProtocolError(
                "Generated SSE event does not match the Calyx delivered-stream-event union.",
              );
            }
            const event = generatedEvent;
            // Advance only to the event whose hook is about to run. The
            // generated parser may already have queued a later event and moved
            // latestEventId while an async hook is still processing this one.
            lastCursor = event.cursor;
            if (await hooks.onEvent(event)) {
              requestStop();
              stream.cancel();
              break;
            }
          }
        }
      } catch (error) {
        if (stopRequested) {
          break;
        }
        if ((error as Error).name === "AbortError") {
          break;
        }
        if (error instanceof CalyxSseProtocolError) {
          throw createCliError(
            "run subscribe received an invalid calyx.stream-event/v1 frame before cursor advancement.",
            6,
          );
        }
        if ((error as CliError).exitCode) {
          throw error;
        }
        disconnectError = error;
      } finally {
        activeAbort = undefined;
      }

      if (!stopRequested && hooks.onDisconnected && await hooks.onDisconnected(disconnectError)) {
        break;
      }
      if (!stopRequested) {
        await waitForRunEventReconnect(stopController.signal);
      }
    }
  } finally {
    removeStopListener?.();
    options.signal?.removeEventListener("abort", onExternalAbort);
    activeAbort?.abort();
    stopController.abort();
  }
  return lastCursor ? { lastCursor } : {};
}

async function subscribeRunEvents(
  options: RunSubscribeCommandOptions,
  deps: RunCliDependencies,
): Promise<void> {
  const format = parseRunSubscribeFormat(options.format);
  await streamRunEvents(options, deps, {
    onEvent: (event) => {
      renderSubscribedEvent(event, format);
      return false;
    },
    onStopRequested: (requestStop) => {
      process.once("SIGINT", requestStop);
      process.once("SIGTERM", requestStop);
      return () => {
        process.removeListener("SIGINT", requestStop);
        process.removeListener("SIGTERM", requestStop);
      };
    },
  });
}

async function dispatchRuntimeConfig(
  mode: "plan" | "apply" | "verify",
  options: RuntimeConfigOptions,
): Promise<RuntimeConfigResult> {
  if (mode === "plan") {
    return planRuntimeConfig(options);
  }
  if (mode === "apply") {
    try {
      return await applyRuntimeConfig(options);
    } catch (error) {
      if (error instanceof RuntimeConfigApplyInProgressError) {
        throw createCliError(error.message, 3);
      }
      throw error;
    }
  }
  return verifyRuntimeConfig(options);
}

function validateRunLaunchPromptOptions(options: RunLaunchCommandOptions): void {
  const count = [
    options.agent,
    options.prompt,
    options.promptFile,
    options.template,
  ].filter((value) => value !== undefined && value.length > 0).length;

  if (count > 1) {
    throw createCliError(
      "run launch accepts at most one prompt source: --agent, --prompt, --prompt-file, or --template.",
      2
    );
  }
  if (!options.agent?.trim() && (options.var ?? []).length > 0) {
    throw createCliError("run launch --var is only valid with --agent.", 2);
  }
  if (!options.agent?.trim() && options.agentRegistry?.trim()) {
    throw createCliError("run launch --agent-registry is only valid with --agent.", 2);
  }
  if (options.agent?.trim() && (options.templateVar ?? []).length > 0) {
    throw createCliError("run launch --agent uses --var, not --template-var.", 2);
  }
}

function hasDirectRunLaunchPromptSource(options: RunLaunchCommandOptions): boolean {
  return Boolean(
    options.agent?.trim()
    || options.prompt?.trim()
    || options.promptFile?.trim()
    || options.template?.trim(),
  );
}

function resolveRunLaunchExecplanRequirement(options: RunLaunchCommandOptions): boolean {
  if (options.requireExecplan !== undefined) {
    return options.requireExecplan;
  }
  return !hasDirectRunLaunchPromptSource(options);
}

function requesterActivityFromEnvironment(): ReviewRequesterIdentity | undefined {
  const identity = resolveActivitySelfIdentity();
  if (!identity) {
    return undefined;
  }
  if (identity.backend !== "codex" && identity.backend !== "claude") {
    return undefined;
  }
  return {
    activity_id: fallbackInteractiveActivityId(identity.backend, identity.sessionId),
    backend: identity.backend,
    session_id: identity.sessionId,
    resolution_source: identity.resolutionSource,
    indexed: false,
    ...(process.env["CALYX_RUN_HOST"]?.trim() ? { host: process.env["CALYX_RUN_HOST"]!.trim() } : {}),
    warnings: [{
      code: "activity_env_only",
      message: "Requester activity id was derived from the harness environment and was not reconciled against the local activity index.",
    }],
  };
}

function requesterBackendFromEnvironment(): AgentLaunchBackend | undefined {
  return requesterActivityFromEnvironment()?.backend;
}

async function resolveReviewRequesterIdentity(
  options: ReviewCommandOptions,
  deps: RunCliDependencies,
): Promise<ReviewRequesterIdentity | undefined> {
  const envIdentity = requesterActivityFromEnvironment();
  if (!envIdentity) {
    return undefined;
  }
  try {
    const selfOptions: ActivitySelfCommandOptions = {
      json: true,
      ...(options.runsRoot?.trim() ? { runsRoot: options.runsRoot.trim() } : {}),
    };
    const self = await resolveActivitySelfCommand(selfOptions, deps);
    return {
      activity_id: self.activity_id,
      backend: self.backend,
      session_id: self.session_id,
      resolution_source: self.resolution_source,
      indexed: self.indexed,
      ...(self.host ? { host: self.host } : envIdentity.host ? { host: envIdentity.host } : {}),
      warnings: self.warnings,
    };
  } catch (error) {
    return {
      ...envIdentity,
      warnings: [{
        code: "activity_index_reconcile_failed",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function parseAgentVariables(rawAssignments: string[] | undefined): Record<string, string[]> {
  const assignments: Record<string, string[]> = {};
  for (const assignment of rawAssignments ?? []) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      throw createCliError(`Invalid --var assignment ${JSON.stringify(assignment)}. Expected key=value.`, 2);
    }
    const key = assignment.slice(0, separatorIndex).trim();
    const value = assignment.slice(separatorIndex + 1);
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw createCliError(`Invalid --var key ${JSON.stringify(key)}. Keys must use letters, numbers, and underscores.`, 2);
    }
    assignments[key] ??= [];
    assignments[key].push(value);
  }
  return assignments;
}

function mergeBackendOptions(
  compiled: Record<string, unknown>,
  explicit: NonNullable<RunIntent["backend_options"]>,
): NonNullable<RunIntent["backend_options"]> {
  const merged: NonNullable<RunIntent["backend_options"]> = { ...compiled, ...explicit };
  const compiledEnv = compiled["env"];
  const explicitEnv = explicit.env;
  if ((compiledEnv && typeof compiledEnv === "object") || explicitEnv) {
    merged.env = {
      ...((compiledEnv && typeof compiledEnv === "object") ? compiledEnv as Record<string, string | null> : {}),
      ...(explicitEnv ?? {}),
    };
  }
  const compiledActivity = compiled["agent_activity"];
  if ((compiledActivity && typeof compiledActivity === "object") || explicit.agent_activity) {
    merged.agent_activity = {
      ...((compiledActivity && typeof compiledActivity === "object") ? compiledActivity as NonNullable<RunIntent["backend_options"]>["agent_activity"] : {}),
      ...(explicit.agent_activity ?? {}),
    };
  }
  if (Array.isArray(compiled["allowed_tools"]) || explicit.allowed_tools) {
    merged.allowed_tools = [
      ...new Set([
        ...((Array.isArray(compiled["allowed_tools"]) ? compiled["allowed_tools"] : []) as string[]),
        ...(explicit.allowed_tools ?? []),
      ]),
    ];
  }
  return merged;
}

function parseAgentBackendSelectionStrategy(value: unknown): ReviewBackendSelectionStrategy | undefined {
  return value === "prefer_different_from_requester" || value === "first_available" ? value : undefined;
}

function parseAgentLaunchBackendValue(value: unknown): AgentLaunchBackend | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function reconcileReviewConductWithCompiledMetadata(
  conduct: ReviewConductMetadata,
  compiled: RunIntent["metadata"] | undefined,
): ReviewConductMetadata {
  const agentDefinition = asPlainRecord(compiled?.["agent_definition"]);
  const compiledTarget = asPlainRecord(agentDefinition?.["target"]);
  const compiledRepo = typeof compiledTarget?.["repo"] === "string"
    ? compiledTarget["repo"]
    : undefined;
  const target = compiledRepo
    ? { ...conduct.target, repo: compiledRepo }
    : conduct.target;
  const handback = compiledRepo
    ? rebindReviewHandback(conduct.handback, target, conduct.agent_id === "reviewer-adversarial")
    : conduct.handback;
  const compiledSelection = asPlainRecord(agentDefinition?.["backend_selection"]);
  const strategy = parseAgentBackendSelectionStrategy(compiledSelection?.["strategy"])
    ?? conduct.backend_selection.strategy;
  const requesterBackend = parseAgentLaunchBackendValue(compiledSelection?.["requester_backend"])
    ?? conduct.backend_selection.requester_backend;
  const override = typeof compiledSelection?.["override"] === "boolean"
    ? compiledSelection["override"]
    : conduct.backend_selection.override;
  return {
    ...conduct,
    target,
    handback,
    backend_selection: {
      strategy,
      ...(requesterBackend ? { requester_backend: requesterBackend } : {}),
      override,
    },
  };
}

function mergeRunIntentMetadata(
  compiled: RunIntent["metadata"] | undefined,
  reviewConduct: ReviewConductMetadata | undefined,
): RunIntent["metadata"] | undefined {
  if (!compiled && !reviewConduct) {
    return undefined;
  }
  const resolvedReviewConduct = reviewConduct
    ? reviewConduct
    : undefined;
  return {
    ...(compiled ?? {}),
    ...(resolvedReviewConduct ? { review_conduct: resolvedReviewConduct } : {}),
  };
}

async function buildAgentRunnerIntent(
  service: RunServiceLike,
  options: RunLaunchCommandOptions,
  deps: RunCliDependencies,
): Promise<RunIntent> {
  validateRunLaunchPromptOptions(options);
  const host = options.host.trim();
  if (!host) {
    throw createCliError("Invalid --host value: host must be non-empty.", 2);
  }
  const repo = options.repo?.trim();
  const worktreePath = options.worktreePath?.trim();
  const worktreeBase = options.worktreeBase?.trim();
  const worktreeMode = parseWorktreeMode(options.worktreeMode);
  if (repo && worktreeBase) {
    throw createCliError(
      "run launch does not accept --repo together with --worktree-base. Pick one worktree base directive.",
      2,
    );
  }
  if (worktreeMode === "managed" && worktreePath) {
    throw createCliError("run launch does not accept --worktree-mode managed together with --worktree-path. Omit --worktree-path and pass --repo <slug-or-alias> --worktree-branch <branch>.", 2);
  }
  if (worktreeMode === "existing" && !worktreePath) {
    throw createCliError([
      "run launch --worktree-mode existing requires --worktree-path <path>.",
      "Managed flow: omit --worktree-path and pass --repo <slug-or-alias> --worktree-branch <branch>.",
      "Exact create flow: pass --worktree-mode create --repo <slug-or-alias> --worktree-path <path> --worktree-branch <branch>.",
    ].join("\n"), 2);
  }
  if (worktreeMode === "create") {
    if (!worktreePath) {
      throw createCliError("run launch --worktree-mode create requires --worktree-path <path>.", 2);
    }
    if (!repo) {
      throw createCliError("run launch --worktree-mode create requires --repo <slug-or-alias>.", 2);
    }
    if (!options.worktreeBranch?.trim()) {
      throw createCliError("run launch --worktree-mode create requires --worktree-branch <branch>.", 2);
    }
  }
  const requesterBackend = options.requesterBackend ?? requesterBackendFromEnvironment();
  const agentId = options.agent?.trim();
  const agentsInfraRoot = agentId
    ? deps.agentsInfraRoot ?? await resolveAgentsInfraRoot()
    : undefined;
  const currentHostAlias = agentId
    ? deps.currentHostAlias ?? await resolveCurrentHostAlias(undefined, agentsInfraRoot)
    : undefined;
  const compiledAgent = agentId
    ? await compileAgentLaunch(await resolve("agents", options.agentRegistry), agentId, {
        variables: parseAgentVariables(options.var),
        ...(options.backend ? { backend: parseRunnerBackend(options.backend) as AgentLaunchBackend } : {}),
        ...(requesterBackend ? { requesterBackend } : {}),
        cwd: process.cwd(),
        ...(agentsInfraRoot ? { agentsInfraRoot } : {}),
        ...(currentHostAlias ? { localHostAlias: currentHostAlias } : {}),
        ...(options.expectedTargetHeadSha ? { expectedTargetHeadSha: options.expectedTargetHeadSha } : {}),
      })
    : undefined;
  const resolvedReviewConduct = options.reviewConduct
    ? reconcileReviewConductWithCompiledMetadata(options.reviewConduct, compiledAgent?.metadata)
    : undefined;
  const backend = compiledAgent?.backend ?? parseRunnerBackend(options.backend);
  const requiredArtifacts = (options.requiredArtifact ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const artifactRoots = (options.artifactRoot ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const allowedTools = (options.allowedTool ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const requestedEnvAssignments = (options.env ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const envAssignments = resolvedReviewConduct
    ? [
        ...requestedEnvAssignments.filter((value) => !value.startsWith("CALYX_REVIEW")),
        ...buildReviewHandbackEnv(resolvedReviewConduct.handback),
      ]
    : requestedEnvAssignments;
  const templateVars = parseTemplateVariables((options.templateVar ?? []).map((value) => value.trim()).filter((value) => value.length > 0));
  const reasoningEffort = options.reasoningEffort
    ? parseReasoningEffort(options.reasoningEffort, backend)
    : compiledAgent?.reasoning_effort as BackendReasoningEffort | undefined;
  const explicitBackendModel = parseBackendModel(options.model, backend, options.profile);
  const backendModel = explicitBackendModel ?? compiledAgent?.model;
  const systemPrompt = resolveSystemPromptOption({
    inlineValue: options.systemPrompt,
    fileValue: options.systemPromptFile,
    inlineFlag: "--system-prompt",
    fileFlag: "--system-prompt-file",
  });
  const requestedAppendSystemPrompt = resolveSystemPromptOption({
    inlineValue: options.appendSystemPrompt,
    fileValue: options.appendSystemPromptFile,
    inlineFlag: "--append-system-prompt",
    fileFlag: "--append-system-prompt-file",
  });
  const appendSystemPrompt = resolvedReviewConduct
    ? buildReviewHandbackPrompt(resolvedReviewConduct.handback)
    : requestedAppendSystemPrompt;
  const promptText = compiledAgent?.prompt ?? (options.prompt?.trim()
    ? options.prompt.trim()
    : (options.promptFile?.trim() ? readRunPromptFile(options.promptFile.trim()) : undefined));

  const backendOptions: NonNullable<RunIntent["backend_options"]> = {};
  if (allowedTools.length > 0) {
    backendOptions.allowed_tools = allowedTools;
  }
  if (options.dangerouslySkipPermissions) {
    backendOptions.dangerously_skip_permissions = true;
  }
  if (backendModel) {
    backendOptions.model = backendModel;
  }
  if (reasoningEffort) {
    backendOptions.reasoning_effort = reasoningEffort;
  }
  if (options.maxThreads) {
    if (backend !== "codex") {
      throw createCliError(
        "run launch --max-threads is Codex-only concurrency control. Claude has no equivalent; use --max-turns only when an explicit Claude turn cap is intended.",
        2,
      );
    }
    backendOptions.max_threads = parsePositiveInteger(options.maxThreads, "--max-threads");
  }
  if (options.maxTurns) {
    if (backend !== "claude") {
      throw createCliError(
        "run launch --max-turns is Claude-only turn-budget control. Codex has no equivalent; use --max-threads for Codex sub-agent concurrency.",
        2,
      );
    }
    backendOptions.max_turns = parsePositiveInteger(options.maxTurns, "--max-turns");
  }
  const agentActivityRequested = Boolean(options.agentActivityStaleAfterMs?.trim())
    || Boolean(options.agentActivityPollIntervalMs?.trim())
    || Boolean(options.agentInactivityTimeoutMs?.trim())
    || Boolean(options.agentInactivityStopGraceMs?.trim());
  if (agentActivityRequested) {
    backendOptions.agent_activity = {
      stale_after_ms: options.agentActivityStaleAfterMs?.trim()
        ? parsePositiveInteger(options.agentActivityStaleAfterMs, "--agent-activity-stale-after-ms")
        : 15 * 60 * 1000,
      ...(options.agentActivityPollIntervalMs?.trim()
        ? { poll_interval_ms: parsePositiveInteger(options.agentActivityPollIntervalMs, "--agent-activity-poll-interval-ms") }
        : {}),
      ...(options.agentInactivityTimeoutMs?.trim()
        ? { hard_timeout_ms: parsePositiveInteger(options.agentInactivityTimeoutMs, "--agent-inactivity-timeout-ms") }
        : {}),
      ...(options.agentInactivityStopGraceMs?.trim()
        ? { stop_grace_ms: parsePositiveInteger(options.agentInactivityStopGraceMs, "--agent-inactivity-stop-grace-ms") }
        : {}),
    };
  }
  if (envAssignments.length > 0) {
    backendOptions.env = parseEnvAssignments(envAssignments);
  }
  const mergedBackendOptions = compiledAgent
    ? mergeBackendOptions(compiledAgent.backend_options, backendOptions)
    : backendOptions;
  const mergedRequiredArtifacts = [...new Set([...(compiledAgent?.required_artifacts ?? []), ...requiredArtifacts])];
  const metadata = mergeRunIntentMetadata(compiledAgent?.metadata, resolvedReviewConduct);
  const intentHandback = resolvedReviewConduct
    ? buildReviewRunHandback(resolvedReviewConduct.handback)
    : options.handback;
  // Precedence (POL-1807): an explicit --worktree-mode wins; an explicit
  // --worktree-path then implies "existing", overriding an agent definition's
  // default worktree mode (e.g. the reviewer agents force managed). An agent's
  // "create" default is preserved (create also consumes --worktree-path). A
  // genuine contradiction (--worktree-mode managed + --worktree-path) is already
  // rejected by the raw-option guard above.
  const intentWorktreeMode = worktreeMode
    ?? (worktreePath && compiledAgent?.worktree_mode !== "create" ? "existing" : undefined)
    ?? compiledAgent?.worktree_mode;
  // Existing mode is worktree-path-authoritative, so it never carries a repo
  // identity; otherwise the daemon would registry-resolve it and a local path is
  // not a registered slug (POL-1807).
  const intentRepo = intentWorktreeMode === "existing"
    ? undefined
    : (compiledAgent?.repo ?? (repo && (!worktreePath || worktreeMode === "create") ? repo : undefined));
  const intentWorktreeRef = compiledAgent?.worktree_ref ?? options.worktreeRef?.trim();
  const intentBranch = options.worktreeBranch?.trim() || compiledAgent?.branch;
  if (intentWorktreeMode === "existing" && !worktreePath) {
    throw createCliError([
      "run launch --worktree-mode existing requires --worktree-path <path>.",
      "Managed flow: omit --worktree-path and pass --repo <slug-or-alias> --worktree-branch <branch>.",
      "Exact create flow: pass --worktree-mode create --repo <slug-or-alias> --worktree-path <path> --worktree-branch <branch>.",
    ].join("\n"), 2);
  }
  if (intentWorktreeMode === "create") {
    if (!worktreePath) {
      throw createCliError("run launch --worktree-mode create requires --worktree-path <path>.", 2);
    }
    if (!intentRepo) {
      throw createCliError("run launch --worktree-mode create requires --repo <slug-or-alias>.", 2);
    }
    if (!intentBranch) {
      throw createCliError("run launch --worktree-mode create requires --worktree-branch <branch>.", 2);
    }
  }

  return service.createIntent({
    kernel: "agent_runner",
    ...(options.runId?.trim() ? { run_id: options.runId.trim() } : {}),
    host,
    backend,
    ...(options.issue?.trim() ? { issue: options.issue.trim() } : {}),
    ...(options.profile?.trim() ? { profile: options.profile.trim() } : {}),
    ...(promptText ? { prompt: promptText } : {}),
    ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
    ...(appendSystemPrompt ? { append_system_prompt: appendSystemPrompt } : {}),
    ...(options.template?.trim() ? { template: options.template.trim() } : {}),
    ...(Object.keys(templateVars).length > 0 ? { template_vars: templateVars } : {}),
    ...(options.execplanRef?.trim() ? { execplan_ref: options.execplanRef.trim() } : {}),
    ...(intentRepo ? { repo: intentRepo } : {}),
    ...(worktreeBase ? { worktree_base: worktreeBase } : {}),
    ...(intentWorktreeMode ? { worktree_mode: intentWorktreeMode } : {}),
    ...(worktreePath ? { worktree_path: worktreePath } : {}),
    ...(intentWorktreeRef ? { worktree_ref: intentWorktreeRef } : {}),
    ...(options.worktreeResetOnReuse ? { worktree_reset_on_reuse: true } : {}),
    ...(intentBranch ? { branch: intentBranch } : {}),
    ...(options.stealLock ? { steal_lock: true } : {}),
    ...(options.lockTimeoutMs
      ? { lock_timeout_ms: parsePositiveInteger(options.lockTimeoutMs, "--lock-timeout-ms") }
      : {}),
    require_execplan: resolveRunLaunchExecplanRequirement(options),
    pull_execplan: Boolean(options.pullExecplan),
    ...(mergedRequiredArtifacts.length > 0 ? { required_artifacts: mergedRequiredArtifacts } : {}),
    ...(artifactRoots.length > 0 ? { artifact_roots: artifactRoots } : {}),
    ...(compiledAgent?.output_capture ? { output_capture: compiledAgent.output_capture } : {}),
    ...(Object.keys(mergedBackendOptions).length > 0 ? { backend_options: mergedBackendOptions } : {}),
    ...(metadata ? { metadata } : {}),
    ...(intentHandback ? { handback: intentHandback } : {}),
    ...((options.ntfyTopic?.trim() || options.agentMailThread?.trim())
      ? {
          notifications: {
            ...(options.ntfyTopic?.trim() ? { ntfy_topic: options.ntfyTopic.trim() } : {}),
            ...(options.agentMailThread?.trim() ? { agent_mail_thread: options.agentMailThread.trim() } : {}),
          },
        }
      : {}),
  });
}

function parseWorktreeMode(rawValue: string | undefined): RunIntent["worktree_mode"] | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  if (value === "existing" || value === "managed" || value === "create") {
    return value;
  }
  throw createCliError(`Invalid --worktree-mode value: ${value}. Must be one of: existing, managed, create.`, 2);
}

function buildHostProcessIntent(service: RunServiceLike, options: RunLaunchCommandOptions): RunIntent {
  const host = options.host.trim();
  if (!host) {
    throw createCliError("Invalid --host value: host must be non-empty.", 2);
  }

  const agentOnlyFlags = [
    ["--backend", options.backend?.trim()],
    ["--agent", options.agent?.trim()],
    ["--agent-registry", options.agentRegistry?.trim()],
    ["--var", (options.var ?? []).length > 0 ? "set" : undefined],
    ["--profile", options.profile?.trim()],
    ["--prompt", options.prompt?.trim()],
    ["--prompt-file", options.promptFile?.trim()],
    ["--system-prompt", options.systemPrompt],
    ["--system-prompt-file", options.systemPromptFile?.trim()],
    ["--append-system-prompt", options.appendSystemPrompt],
    ["--append-system-prompt-file", options.appendSystemPromptFile?.trim()],
    ["--template", options.template?.trim()],
    ["--template-var", (options.templateVar ?? []).length > 0 ? "set" : undefined],
    ["--execplan-ref", options.execplanRef?.trim()],
    ["--require-execplan", options.requireExecplan === true ? "set" : undefined],
    ["--repo", options.repo?.trim()],
    ["--pull-execplan", options.pullExecplan ? "set" : undefined],
    ["--worktree-base", options.worktreeBase?.trim()],
    ["--worktree-mode", options.worktreeMode?.trim()],
    ["--worktree-path", options.worktreePath?.trim()],
    ["--worktree-ref", options.worktreeRef?.trim()],
    ["--worktree-branch", options.worktreeBranch?.trim()],
    ["--steal-lock", options.stealLock ? "set" : undefined],
    ["--lock-timeout-ms", options.lockTimeoutMs?.trim()],
    ["--required-artifact", (options.requiredArtifact ?? []).length > 0 ? "set" : undefined],
    ["--artifact-root", (options.artifactRoot ?? []).length > 0 ? "set" : undefined],
    ["--allowed-tool", (options.allowedTool ?? []).length > 0 ? "set" : undefined],
    ["--dangerously-skip-permissions", options.dangerouslySkipPermissions ? "set" : undefined],
    ["--model", options.model?.trim()],
    ["--reasoning-effort", options.reasoningEffort?.trim()],
    ["--max-threads", options.maxThreads?.trim()],
    ["--max-turns", options.maxTurns?.trim()],
    ["--agent-activity-stale-after-ms", options.agentActivityStaleAfterMs?.trim()],
    ["--agent-activity-poll-interval-ms", options.agentActivityPollIntervalMs?.trim()],
    ["--agent-inactivity-timeout-ms", options.agentInactivityTimeoutMs?.trim()],
    ["--agent-inactivity-stop-grace-ms", options.agentInactivityStopGraceMs?.trim()],
  ].filter(([, value]) => value !== undefined && value !== "");
  if (agentOnlyFlags.length > 0) {
    throw createCliError(
      `run launch --kernel host_process does not accept agent-runner flags: ${agentOnlyFlags.map(([flag]) => flag).join(", ")}.`,
      2,
    );
  }
  if (options.requireExecplan === false) {
    throw createCliError("run launch --kernel host_process does not use --no-require-execplan.", 2);
  }

  const argv = (options.argv ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (argv.length === 0) {
    throw createCliError(
      "run launch --kernel host_process requires at least one --argv token.",
      2,
    );
  }
  const cwd = options.cwd?.trim();
  if (!cwd) {
    throw createCliError("run launch --kernel host_process requires --cwd.", 2);
  }

  const envAssignments = (options.env ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  const healthSources = (options.healthSource ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .map((value) => {
      if (value === "stdout" || value === "stderr") {
        return { kind: value } as const;
      }
      throw createCliError(
        `Invalid --health-source value for run launch --kernel host_process: ${value}. Must be one of: stdout, stderr.`,
        2,
      );
    });
  const healthPaths = (options.healthPath ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => ({ kind: "file" as const, path: value }));
  const healthRequested = healthSources.length > 0
    || healthPaths.length > 0
    || Boolean(options.healthStaleAfterMs?.trim())
    || Boolean(options.healthPollIntervalMs?.trim());
  if (healthRequested && healthSources.length + healthPaths.length === 0) {
    throw createCliError(
      "run launch --kernel host_process requires at least one --health-source or --health-path when health monitoring is configured.",
      2,
    );
  }
  if (healthRequested && !options.healthStaleAfterMs?.trim()) {
    throw createCliError(
      "run launch --kernel host_process requires --health-stale-after-ms when health monitoring is configured.",
      2,
    );
  }

  return service.createIntent({
    kernel: "host_process",
    ...(options.runId?.trim() ? { run_id: options.runId.trim() } : {}),
    host,
    ...(options.issue?.trim() ? { issue: options.issue.trim() } : {}),
    host_process: {
      argv,
      cwd,
      ...(envAssignments.length > 0 ? { env: parseEnvAssignments(envAssignments) } : {}),
      ...(options.stopGraceMs
        ? { stop_grace_ms: parsePositiveInteger(options.stopGraceMs, "--stop-grace-ms") }
        : {}),
      ...(healthRequested
        ? {
            health: {
              stale_after_ms: parsePositiveInteger(options.healthStaleAfterMs!, "--health-stale-after-ms"),
              ...(options.healthPollIntervalMs
                ? { poll_interval_ms: parsePositiveInteger(options.healthPollIntervalMs, "--health-poll-interval-ms") }
                : {}),
              sources: [...healthSources, ...healthPaths],
            },
          }
        : {}),
    },
    ...((options.ntfyTopic?.trim() || options.agentMailThread?.trim())
      ? {
          notifications: {
            ...(options.ntfyTopic?.trim() ? { ntfy_topic: options.ntfyTopic.trim() } : {}),
            ...(options.agentMailThread?.trim() ? { agent_mail_thread: options.agentMailThread.trim() } : {}),
          },
        }
      : {}),
  });
}

async function buildRunIntent(service: RunServiceLike, options: RunLaunchCommandOptions, deps: RunCliDependencies): Promise<RunIntent> {
  const kernel = parseExecutionKernel(options.kernel);
  const intent = kernel === "host_process"
    ? buildHostProcessIntent(service, options)
    : await buildAgentRunnerIntent(service, options, deps);
  return {
    ...intent,
    required_features: requiredFeaturesForIntent(intent),
  };
}

async function planRunLaunchCommand(
  options: RunLaunchCommandOptions,
  deps: RunCliDependencies,
): Promise<PlannedRunLaunch> {
  const runsRoot = options.runsRoot?.trim() || defaultRunsRoot();
  const worktreeBase = options.worktreeBase?.trim() || defaultRunWorktreeBase();
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot,
    defaultWorktreeBase: worktreeBase,
  }));
  const intent = await buildRunIntent(service, options, deps);
  return { intent, service };
}

async function launchRunCommandWithIntent(
  options: RunLaunchCommandOptions,
  deps: RunCliDependencies,
): Promise<LaunchedRunWithIntent> {
  if (options.replayRequest?.trim()) {
    if (options.foreground) throw createCliError("Request replay is always remote submit-and-observe; omit --foreground.", 2);
    return replayRemoteRunLaunch(deps, options.replayRequest.trim(), options.authToken);
  }
  const { intent, service } = await planRunLaunchCommand(options, deps);
  if (usesRemoteRunServer(intent.host, options.serverUrl)) {
    if (options.foreground) {
      throw createCliError(
        "Remote --foreground launch is not supported: submit in the background, then observe the returned operation locator.",
        2,
      );
    }
    const access = await resolveRunServerAccess({
      host: intent.host,
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(
        `Remote run launch requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
        2
      );
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const refusal = getDaemonCompatibilityRefusal(
      intent.host,
      health,
      intent.required_features ?? requiredFeaturesForIntent(intent),
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    const topologyProjectionSha256 = await planRemoteRunTopology(intent.host, deps);
    const result = await submitRemoteRun(deps, {
      serverUrl,
      token,
      request: {
        schema_version: "calyx.run-launch-request/v1",
        intent,
        idempotency_key: options.idempotencyKey?.trim() || `run-launch:${intent.run_id}`,
        topology_projection_sha256: topologyProjectionSha256,
      } satisfies RunLaunchRequest,
    });
    return { intent, result };
  }

  const result = await service.launch(intent, { detached: !options.foreground });
  return { intent, result };
}

async function launchRunCommand(
  options: RunLaunchCommandOptions,
  deps: RunCliDependencies,
): Promise<CliRunLaunchResult> {
  return (await launchRunCommandWithIntent(options, deps)).result;
}

function normalizeReviewScope(options: ReviewCommandOptions): ReviewScope {
  const rawScope = options.scope?.trim().toLowerCase();
  if (rawScope && rawScope !== "pr" && rawScope !== "branch") {
    throw createCliError(`Invalid --scope value for calyx review: ${options.scope}. Must be one of: pr, branch.`, 2);
  }
  const hasPr = Boolean(options.pr?.trim());
  const hasBranch = Boolean(options.branch?.trim());
  if (hasPr && hasBranch) {
    throw createCliError("calyx review accepts exactly one target: pass --pr <n> or --branch <ref>, not both.", 2);
  }
  const scope = rawScope as ReviewScope | undefined;
  if (scope === "pr" && hasBranch) {
    throw createCliError("calyx review --scope pr requires --pr <n>, not --branch <ref>.", 2);
  }
  if (scope === "branch" && hasPr) {
    throw createCliError("calyx review --scope branch requires --branch <ref>, not --pr <n>.", 2);
  }
  if (scope) {
    return scope;
  }
  if (hasPr) {
    return "pr";
  }
  if (hasBranch) {
    return "branch";
  }
  throw createCliError("calyx review requires a target: pass --pr <n> or --branch <ref>.", 2);
}

function parseReviewPr(rawValue: string | undefined): number {
  const value = rawValue?.trim();
  if (!value) {
    throw createCliError("calyx review --scope pr requires --pr <n>.", 2);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createCliError(`Invalid --pr value for calyx review: ${rawValue}. Expected a positive integer.`, 2);
  }
  return parsed;
}

function normalizeReviewSha(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw createCliError(`Invalid --sha value for calyx review: ${rawValue}. Expected a full 40- or 64-character commit SHA.`, 2);
  }
  return value.toLowerCase();
}

function normalizeReviewFocus(options: ReviewCommandOptions): string[] {
  return (options.focus ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * Resolve the review subject into a git-context `repo` plus an optional explicit
 * `worktreePath` (POL-1807). `--repo` (registered slug -> managed worktree) and
 * `--worktree-path` (local checkout -> existing worktree) are mutually exclusive
 * ways to name the subject; exactly one is required. For the explicit-path flow
 * the path doubles as the git context so target resolution (PR head / branch)
 * runs against its own `origin`, reusing `resolveRepoWorktree`'s path handling.
 */
function resolveReviewSubject(options: ReviewCommandOptions): { repo: string; worktreePath?: string } {
  const repoOpt = options.repo?.trim();
  const worktreePathOpt = options.worktreePath?.trim();
  if (repoOpt && worktreePathOpt) {
    throw createCliError("calyx review accepts either --repo <slug> or --worktree-path <path>, not both.", 2);
  }
  if (worktreePathOpt) {
    if (usesRemoteRunServer(options.host?.trim() || "local", options.serverUrl)) {
      throw createCliError(
        "calyx review --worktree-path is launcher-local and cannot target a remote --host/--server-url. Run the review on the host that holds the worktree (--host local), or pass --repo <slug> for a registry-resolved managed worktree.",
        2,
      );
    }
    const resolved = resolvePath(process.cwd(), worktreePathOpt);
    return { repo: resolved, worktreePath: resolved };
  }
  if (repoOpt) {
    return { repo: repoOpt };
  }
  throw createCliError("calyx review requires --repo <slug> or --worktree-path <path>.", 2);
}

function buildReviewTargetSpec(options: ReviewCommandOptions): ReviewTargetSpec {
  const { repo, worktreePath } = resolveReviewSubject(options);
  const base = options.base?.trim();
  const issue = options.issue?.trim();
  const expectedHeadSha = normalizeReviewSha(options.sha);
  const focus = normalizeReviewFocus(options);
  const scope = normalizeReviewScope(options);
  if (scope === "pr") {
    return {
      scope,
      repo,
      ...(worktreePath ? { worktreePath } : {}),
      pr: parseReviewPr(options.pr),
      ...(expectedHeadSha ? { expectedHeadSha } : {}),
      ...(base ? { base } : {}),
      ...(issue ? { issue } : {}),
      focus,
    };
  }
  if (expectedHeadSha) {
    throw createCliError("calyx review --sha is only valid with --pr targets; pass --branch <sha> to review an explicit branch/commit target.", 2);
  }
  const branch = options.branch?.trim();
  if (!branch) {
    throw createCliError("calyx review --scope branch requires --branch <ref>.", 2);
  }
  return {
    scope,
    repo,
    ...(worktreePath ? { worktreePath } : {}),
    branch,
    ...(base ? { base } : {}),
    ...(issue ? { issue } : {}),
    focus,
  };
}

function buildReviewThreadKey(target: ReviewTargetSpec, adversarial: boolean): string {
  const targetRef = target.scope === "pr" ? `pr-${target.pr}` : `branch-${target.branch}`;
  return [
    "review",
    adversarial ? "adversarial" : "standard",
    target.repo.replace(/[^A-Za-z0-9_.-]+/g, "-"),
    targetRef.replace(/[^A-Za-z0-9_.-]+/g, "-"),
  ].join(":");
}

function rebindReviewHandback(
  handback: ReviewHandbackBinding,
  target: ReviewTargetSpec,
  adversarial: boolean,
): ReviewHandbackBinding {
  const threadKey = buildReviewThreadKey(target, adversarial);
  const targetLabel = target.scope === "pr" ? `PR #${target.pr}` : `branch ${target.branch}`;
  const runId = handback.reviewer_reply_address?.startsWith("run:")
    ? handback.reviewer_reply_address.slice("run:".length)
    : undefined;
  const bodyContract = handback.status === "unavailable"
    ? `Manual relay for ${target.repo} ${targetLabel}: status axes, verdict, counts, and locators only; never include the findings corpus.`
    : handback.status === "bound"
      ? `Hand back ${target.repo} ${targetLabel} status axes, verdict, counts, and locators only; never include the findings corpus.`
      : handback.body_contract;
  return {
    ...handback,
    thread_key: threadKey,
    ...(handback.idempotency_key && runId
      ? { idempotency_key: `handback:${runId}:${threadKey}` }
      : {}),
    body_contract: bodyContract,
  };
}

function reviewFlavor(adversarial: boolean): "standard" | "adversarial" {
  return adversarial ? "adversarial" : "standard";
}

function reviewPrWorktreeBranch(pr: number, adversarial: boolean): string {
  return `calyx-review/pr-${pr}-${reviewFlavor(adversarial)}`;
}

async function detectReviewHandbackAvailability(
  options: ReviewCommandOptions,
  deps: RunCliDependencies,
): Promise<ReviewHandbackAvailability> {
  if (options.handback === false || options.dryRun) {
    return { available: true };
  }
  const host = options.host.trim() || "local";
  if (!usesRemoteRunServer(host, options.serverUrl)) {
    return { available: true };
  }
  const access = await resolveRunServerAccess({
    host,
    serverUrl: options.serverUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    return { available: true };
  }
  const { serverUrl, token } = access;
  const health = await remoteAdminHealth(deps, { serverUrl, token }, "review handback feature detection");
  if ((health.supports_features ?? []).includes(CALYX_DAEMON_FEATURES.messageCorrespondenceV1)) {
    return { available: true };
  }
  return {
    available: false,
    reason: "message_correspondence_unavailable",
    detail: `${host} daemon does not advertise ${CALYX_DAEMON_FEATURES.messageCorrespondenceV1}; review handback is receipt-only and requires manual relay from the run artifact plus PR/Linear review comment.`,
  };
}

function buildReviewHandbackBinding(
  enabled: boolean,
  target: ReviewTargetSpec,
  requester: ReviewRequesterIdentity | undefined,
  threadKey: string,
  availability: ReviewHandbackAvailability,
  reviewerReplyAddress: string,
): ReviewHandbackBinding {
  if (!enabled) {
    return {
      status: "disabled",
      handback_status: "disabled",
      flow: "calyx.msg/v1",
      ack_required: true,
      thread_key: threadKey,
      reviewer_reply_address: reviewerReplyAddress,
      body_contract: "status axes + verdict + counts + locators only; never include the findings corpus",
    };
  }
  if (!requester) {
    throw createCliError([
      "calyx review could not resolve the caller activity id for default msg handback.",
      "Run from a Calyx-indexed interactive session or pass --no-handback as an explicit opt-out.",
    ].join("\n"), 2);
  }
  const targetLabel = target.scope === "pr" ? `PR #${target.pr}` : `branch ${target.branch}`;
  const idempotencyKey = `handback:${reviewerReplyAddress.slice("run:".length)}:${threadKey}`;
  if (!availability.available) {
    return {
      status: "unavailable",
      handback_status: "unavailable",
      flow: "receipt-only/v1",
      ack_required: true,
      thread_key: threadKey,
      address: requester.activity_id,
      ...(requester.host ? { recipient_host: requester.host } : {}),
      idempotency_key: idempotencyKey,
      reviewer_reply_address: reviewerReplyAddress,
      manual_relay_required: true,
      unavailable_reason: availability.reason ?? "message_correspondence_unavailable",
      unavailable_detail: availability.detail ?? "`calyx msg` handback is unavailable; pull the run artifact plus PR/Linear review comment manually.",
      body_contract: `Manual relay for ${target.repo} ${targetLabel}: status axes, verdict, counts, and locators only; never include the findings corpus.`,
    };
  }
  return {
    status: "bound",
    handback_status: "bound",
    flow: "calyx.msg/v1",
    ack_required: true,
    thread_key: threadKey,
    address: requester.activity_id,
    ...(requester.host ? { recipient_host: requester.host } : {}),
    idempotency_key: idempotencyKey,
    reviewer_reply_address: reviewerReplyAddress,
    body_contract: `Hand back ${target.repo} ${targetLabel} status axes, verdict, counts, and locators only; never include the findings corpus.`,
  };
}

function buildReviewHandbackEnv(handback: ReviewHandbackBinding): string[] {
  if (handback.status !== "bound" || !handback.address) {
    return [];
  }
  return [
    `CALYX_REVIEW_HANDBACK_ADDRESS=${handback.address}`,
    ...(handback.recipient_host ? [`CALYX_REVIEW_HANDBACK_HOST=${handback.recipient_host}`] : []),
    `CALYX_REVIEW_HANDBACK_THREAD=${handback.thread_key}`,
    `CALYX_REVIEWER_REPLY_ADDRESS=${handback.reviewer_reply_address ?? "run:<id>"}`,
    `CALYX_REVIEW_HANDBACK_IDEMPOTENCY_KEY=${handback.idempotency_key ?? `handback:<run-id>:${handback.thread_key}`}`,
    "CALYX_REVIEW_HANDBACK_ACK_REQUIRED=true",
    "CALYX_REVIEW_HANDBACK_BODY_CONTRACT=status_axes_verdict_counts_locators_only",
  ];
}

function buildReviewRunHandback(handback: ReviewHandbackBinding): RunIntent["handback"] | undefined {
  if ((handback.status !== "bound" && handback.status !== "unavailable") || !handback.address) {
    return undefined;
  }
  return {
    key: handback.thread_key,
    recipient_address: handback.address,
    ...(handback.recipient_host ? { recipient_host: handback.recipient_host } : {}),
    thread_key: handback.thread_key,
    ack_required: handback.ack_required,
    body_contract: handback.body_contract,
    subject: "review handback",
    flow: handback.flow,
    ...(handback.idempotency_key ? { idempotency_key: handback.idempotency_key } : {}),
  };
}

function buildReviewHandbackPrompt(handback: ReviewHandbackBinding): string | undefined {
  if (handback.status !== "bound" || !handback.address) {
    return undefined;
  }
  const hostOption = handback.recipient_host ? ` --host ${handback.recipient_host}` : "";
  return [
    "Calyx review handback binding:",
    `- Send the completion handback to ${handback.address} with calyx msg.`,
    ...(handback.recipient_host ? [`- Target requester host ${handback.recipient_host}; include --host ${handback.recipient_host} on the send.`] : []),
    `- Use thread ${handback.thread_key} and --ack-required.`,
    `- Use --sender ${handback.reviewer_reply_address ?? "run:<id>"} and --idempotency-key ${handback.idempotency_key ?? "handback:<run-id>:<thread>"} so the system terminal handback can dedupe your voluntary send.`,
    `- For multi-round follow-up, tell the requester to reply to ${handback.reviewer_reply_address ?? "the run:<id> reviewer address in the conduct receipt"} on the same thread.`,
    "- Body contract: status axes, verdict, counts, and locators only.",
    "- Do not include the review findings corpus in the handback body; place findings on the canonical PR/Linear/artifact surfaces.",
    `- Command shape: calyx msg send --to ${handback.address}${hostOption} --sender ${handback.reviewer_reply_address ?? "run:<id>"} --subject "review handback" --thread ${handback.thread_key} --idempotency-key ${handback.idempotency_key ?? "handback:<run-id>:<thread>"} --ack-required --body-file <path> --json`,
  ].join("\n");
}

function buildReviewAgentVariables(target: ReviewTargetSpec): string[] {
  const variables = [
    `repo=${target.repo}`,
    `scope=${target.scope}`,
    ...(target.base ? [`base=${target.base}`] : []),
    ...(target.issue ? [`issue=${target.issue}`] : []),
    ...target.focus.map((value) => `focus=${value}`),
  ];
  if (target.scope === "pr") {
    variables.push(`pr=${String(target.pr)}`);
  } else {
    variables.push(`branch=${target.branch}`);
  }
  return variables;
}

async function buildReviewLaunchOptions(
  options: ReviewCommandOptions,
  deps: RunCliDependencies,
): Promise<RunLaunchCommandOptions> {
  const target = buildReviewTargetSpec(options);
  const requester = await resolveReviewRequesterIdentity(options, deps);
  const adversarial = Boolean(options.adversarial);
  const agentId = adversarial ? "reviewer-adversarial" : "reviewer";
  const threadKey = buildReviewThreadKey(target, adversarial);
  const runId = `review-${randomUUID()}`;
  const handbackAvailability = await detectReviewHandbackAvailability(options, deps);
  const handback = buildReviewHandbackBinding(options.handback !== false, target, requester, threadKey, handbackAvailability, `run:${runId}`);
  const appendSystemPrompt = buildReviewHandbackPrompt(handback);
  const handbackEnv = buildReviewHandbackEnv(handback);
  return {
    runId,
    kernel: "agent_runner",
    ...(target.issue ? { issue: target.issue } : {}),
    host: options.host.trim() || "local",
    ...(options.backend?.trim() ? { backend: options.backend.trim() } : {}),
    agent: agentId,
    ...(options.agentRegistry?.trim() ? { agentRegistry: options.agentRegistry.trim() } : {}),
    var: buildReviewAgentVariables(target),
    repo: target.repo,
    ...(target.worktreePath ? { worktreePath: target.worktreePath } : {}),
    ...(target.scope === "pr" && !target.worktreePath ? { worktreeBranch: reviewPrWorktreeBranch(target.pr, adversarial) } : {}),
    ...(target.scope === "pr" && !target.worktreePath ? { worktreeResetOnReuse: true } : {}),
    ...(target.scope === "pr" && target.expectedHeadSha ? { expectedTargetHeadSha: target.expectedHeadSha } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    ...(handbackEnv.length > 0 ? { env: handbackEnv } : {}),
    ...(options.runsRoot?.trim() ? { runsRoot: options.runsRoot.trim() } : {}),
    ...(requester ? { requesterBackend: requester.backend } : {}),
    ...(options.serverUrl?.trim() ? { serverUrl: options.serverUrl.trim() } : {}),
    ...(options.authToken?.trim() ? { authToken: options.authToken.trim() } : {}),
    foreground: false,
    ...(options.json !== undefined ? { json: options.json } : {}),
    reviewConduct: {
      command: "review",
      agent_id: agentId,
      target,
      ...(requester ? { requester } : {}),
      backend_selection: {
        strategy: "first_available",
        ...(requester ? { requester_backend: requester.backend } : {}),
        override: Boolean(options.backend?.trim()),
      },
      handback,
      source: "calyx review",
    },
    ...(buildReviewRunHandback(handback) ? { handback: buildReviewRunHandback(handback) } : {}),
  };
}

function reviewAgentDefinitionMetadata(intent: RunIntent): Record<string, unknown> {
  return asPlainRecord(asPlainRecord(intent.metadata)?.["agent_definition"]) ?? {};
}

function formatReviewBackendSelectionReason(
  intent: RunIntent,
  conduct: ReviewConductMetadata,
): string {
  if (conduct.backend_selection.override) {
    return `explicit --backend override selected ${intent.backend}`;
  }
  if (conduct.backend_selection.strategy === "first_available") {
    const requesterBackend = conduct.backend_selection.requester_backend;
    return requesterBackend
      ? `first_available selected ${intent.backend}; requester backend is ${requesterBackend}`
      : `first_available selected ${intent.backend}; requester backend was unavailable`;
  }
  const requesterBackend = conduct.backend_selection.requester_backend;
  if (requesterBackend && requesterBackend !== intent.backend) {
    return `prefer_different_from_requester selected ${intent.backend} because requester backend is ${requesterBackend}`;
  }
  if (requesterBackend) {
    return `prefer_different_from_requester selected fallback ${intent.backend}; requester backend is also ${requesterBackend}`;
  }
  return `prefer_different_from_requester selected ${intent.backend}; requester backend was unavailable`;
}

function buildReviewConductReceipt(args: {
  intent: RunIntent;
  mode: "dry-run" | "launched";
  result?: CliRunLaunchResult;
}): Record<string, unknown> {
  const conduct = asPlainRecord(args.intent.metadata)?.["review_conduct"] as ReviewConductMetadata | undefined;
  if (!conduct) {
    throw createCliError("calyx review internal error: missing review conduct metadata on planned run intent.", 1);
  }
  const agentDefinition = reviewAgentDefinitionMetadata(args.intent);
  const resolvedAgentTarget = asPlainRecord(agentDefinition["target"]);
  const resolvedRepo = typeof resolvedAgentTarget?.["repo"] === "string"
    ? resolvedAgentTarget["repo"]
    : conduct.target.repo;
  const executableTarget = {
    ...conduct.target,
    repo: resolvedRepo,
  };
  const handback = {
    ...conduct.handback,
    reviewer_reply_address: `run:${args.intent.run_id}`,
  };
  return {
    schema_version: "calyx.review.conduct/v1",
    mode: args.mode,
    dry_run: args.mode === "dry-run",
    run_id: args.intent.run_id,
    ...(args.result
      ? isRemoteAcceptedRunLaunchResult(args.result)
        ? {
            status: args.result.status,
            launch_mode: args.result.mode,
            operation: args.result.operation,
            ...(args.result.observation.status === "available"
              ? { state: args.result.observation.state }
              : { observation_status: args.result.observation.status }),
          }
        : {
            state: args.result.state,
            launch_mode: args.result.mode,
            run_dir: args.result.run_dir,
          }
      : {}),
    agent_id: conduct.agent_id,
    agent_ref: agentDefinition["agent_ref"] ?? `${conduct.agent_id}@unknown`,
    target: resolvedAgentTarget ?? conduct.target,
    requester: conduct.requester ?? null,
    handback_status: conduct.handback.status,
    backend: {
      selected: args.intent.backend,
      strategy: conduct.backend_selection.strategy,
      requester_backend: conduct.backend_selection.requester_backend ?? null,
      override: conduct.backend_selection.override,
      reason: formatReviewBackendSelectionReason(args.intent, conduct),
    },
    handback,
    launch: {
      command: "calyx run launch",
      agent: conduct.agent_id,
      variables: buildReviewAgentVariables(executableTarget),
      host: args.intent.host,
      ...(args.intent.repo ? { repo: args.intent.repo } : {}),
      ...(args.intent.branch ? { branch: args.intent.branch } : {}),
    },
  };
}

async function runReviewCommand(
  options: ReviewCommandOptions,
  deps: RunCliDependencies,
): Promise<Record<string, unknown>> {
  const launchOptions = await buildReviewLaunchOptions(options, deps);
  if (options.dryRun) {
    const plan = await planRunLaunchCommand(launchOptions, deps);
    return buildReviewConductReceipt({ intent: plan.intent, mode: "dry-run" });
  }
  const launched = await launchRunCommandWithIntent(launchOptions, deps);
  return buildReviewConductReceipt({ intent: launched.intent, mode: "launched", result: launched.result });
}

async function resumeRunCommand(
  options: RunResumeCommandOptions,
  deps: RunCliDependencies,
): Promise<CliRunLaunchResult> {
  const hasSessionId = Boolean(options.sessionId?.trim());
  const hasLast = Boolean(options.last);

  if (hasSessionId && hasLast) {
    throw createCliError("Provide either a session-id argument or --last, not both.", 2);
  }
  if (!hasSessionId && !hasLast) {
    throw createCliError("Provide a session-id argument or --last to discover the most recent session.", 2);
  }

  let sessionId: string;
  let resolvedBackend: SupportedBackend | undefined = options.backend
    ? parseRunnerBackend(options.backend)
    : undefined;

  if (hasLast) {
    const latest = await findLatestRuntimeSession(resolvedBackend);
    if (!latest) {
      throw createCliError(
        resolvedBackend
          ? `No ${resolvedBackend} sessions found.`
          : "No sessions found for any backend.",
        3,
      );
    }
    sessionId = latest.id;
    // Use the discovered backend when the user didn't specify one
    if (!resolvedBackend) {
      resolvedBackend = latest.backend;
    }
  } else {
    sessionId = options.sessionId!.trim();
  }

  // Default to claude for explicit session-id without --backend.
  // Future: could sniff session ID format (Claude=UUID, Codex=UUID in filename)
  // to auto-detect. For now, CLI help text documents this default.
  if (!resolvedBackend) {
    resolvedBackend = "claude";
  }

  const runsRoot = options.runsRoot?.trim() || defaultRunsRoot();
  const worktreeBase = defaultRunWorktreeBase();
  const host = options.host.trim();
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot,
    defaultWorktreeBase: worktreeBase,
  }));
  const explicitWorktreePath = options.worktreePath?.trim();
  let resolvedWorktreePath = explicitWorktreePath;
  let resolvedWorktreeSource: RunIntent["worktree_source"] | undefined = explicitWorktreePath ? "explicit_flag" : undefined;
  if (!resolvedWorktreePath && !usesRemoteRunServer(host, options.serverUrl)) {
    const resolution = await service.resolveResumeWorktreePath(sessionId);
    resolvedWorktreePath = resolution.path;
    resolvedWorktreeSource = resolution.source;
  }

  const backendOptions: NonNullable<RunIntent["backend_options"]> = {};
  if (options.dangerouslySkipPermissions) {
    backendOptions.dangerously_skip_permissions = true;
  }

  const intent = service.createIntent({
    kernel: "agent_runner",
    ...(options.runId?.trim() ? { run_id: options.runId.trim() } : {}),
    host,
    backend: resolvedBackend,
    prompt: options.prompt.trim(),
    resume_session_id: sessionId,
    require_execplan: false,
    pull_execplan: false,
    ...(options.profile?.trim() ? { profile: options.profile.trim() } : {}),
    ...(resolvedWorktreePath ? { worktree_path: resolvedWorktreePath } : {}),
    ...(resolvedWorktreeSource ? { worktree_source: resolvedWorktreeSource } : {}),
    ...(Object.keys(backendOptions).length > 0 ? { backend_options: backendOptions } : {}),
  });

  if (usesRemoteRunServer(intent.host, options.serverUrl)) {
    if (options.foreground) {
      throw createCliError(
        "Remote --foreground resume is not supported: submit in the background, then observe the returned operation locator.",
        2,
      );
    }
    const access = await resolveRunServerAccess({
      host: intent.host,
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(
        `Remote run resume requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
        2,
      );
    }
    return submitRemoteRun(deps, {
      serverUrl: access.serverUrl,
      token: access.token,
      request: {
        schema_version: "calyx.run-launch-request/v1",
        intent,
        idempotency_key: options.idempotencyKey?.trim() || `run-launch:${intent.run_id}`,
        topology_projection_sha256: await planRemoteRunTopology(intent.host, deps),
      } satisfies RunLaunchRequest,
    });
  }

  return service.launch(intent, { detached: !options.foreground });
}

async function resolveRemoteRunServerAccess(
  options: { host?: string; serverUrl?: string; authToken?: string },
  deps: RunCliDependencies,
  actionKind: "commands" | "queries",
): Promise<{ serverUrl: string; token: string } | undefined> {
  const host = options.host?.trim();
  const explicitServerUrl = options.serverUrl?.trim();
  const useRemote = usesExplicitRunReadServer(host, explicitServerUrl);
  if (!useRemote) {
    return undefined;
  }

  const access = await resolveRunServerAccess({
    ...(host ? { host } : {}),
    serverUrl: explicitServerUrl,
    authToken: options.authToken,
  }, deps);
  if (!access.token) {
    throw createCliError(
      `Remote run ${actionKind} require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
      2
    );
  }
  return { serverUrl: access.serverUrl, token: access.token };
}

async function getRunRecord(
  options: {
    runId: string;
    host?: string;
    runsRoot?: string;
    serverUrl?: string;
    authToken?: string;
    signal?: AbortSignal;
  },
  deps: RunCliDependencies,
): Promise<RunRecord | undefined> {
  const remote = await resolveRemoteRunServerAccess(options, deps, "queries");
  if (remote) {
    const wireRecord = await remoteAdminRunRecord(
      deps,
      remote,
      options.runId,
      `run ${options.runId}`,
      options.signal,
    );
    return fromAdminRunRecord(wireRecord);
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  return service.getRunRecord(options.runId);
}

async function listRuns(
  options: {
    runsRoot?: string;
    host?: string;
    includeInteractive?: boolean;
    agentKind?: string;
    sinceHours?: string;
    limit?: string;
    serverUrl?: string;
    authToken?: string;
    requireComplete?: boolean;
    signal?: AbortSignal;
  },
  deps: RunCliDependencies,
): Promise<Array<RunListEntry | RunActivityEntry>> {
  const host = options.host?.trim();
  const agentKind = parseRunPsAgentKind(options.agentKind);
  const sinceMs = parseSinceHoursMs(options.sinceHours);
  const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : undefined;
  const useRemote = usesExplicitRunReadServer(host, options.serverUrl);

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(
        `Remote run queries require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
        2
      );
    }
    const { serverUrl, token } = access;
    if (options.includeInteractive) {
      const health = await remoteAdminHealth(deps, { serverUrl, token }, "run server health", options.signal);
      const refusal = getDaemonCompatibilityRefusal(
        host ?? serverUrl,
        health,
        [CALYX_DAEMON_FEATURES.interactiveActivitySurfaceV1],
      );
      if (refusal) {
        throw createCliError(refusal.message, 6);
      }
    }
    const rows: Array<RunListEntry | RunActivityEntry> = [];
    let cursor: string | undefined;
    let remaining = limit ?? 50;
    do {
      const pageLimit = Math.min(remaining, CALYX_ADMIN_RUN_LIST_MAX_ITEMS);
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.run.list({
        query: {
          ...(typeof options.includeInteractive === "boolean"
            ? { include_interactive: options.includeInteractive ? "1" as const : "0" as const }
            : {}),
          ...(host ? { host } : {}),
          ...(agentKind ? { agent_kind: agentKind } : {}),
          ...(typeof sinceMs === "number" ? { since_ms: String(sinceMs) } : {}),
          limit: String(pageLimit),
          ...(cursor ? { cursor } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const page = requireClientResult(result, "admin.run.list") as unknown as {
        schema_version: "calyx.run-list/v1";
        count: number;
        truncated: boolean;
        next_cursor?: string;
        runs: Array<RunListEntry | RunActivityEntry>;
      };
      rows.push(...page.runs);
      remaining -= page.runs.length;
      if (!page.truncated) break;
      if (remaining <= 0) {
        if (options.requireComplete) {
          throw createCliError(
            `admin.run.list still had more rows after the bounded ${limit ?? 50}-row scan; use a full run id.`,
            3,
          );
        }
        break;
      }
      if (!page.next_cursor) {
        throw new Error("admin.run.list returned a truncated page without next_cursor");
      }
      if (page.runs.length === 0) {
        throw new Error("admin.run.list returned an empty truncated page");
      }
      cursor = page.next_cursor;
    } while (remaining > 0);
    return rows;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (options.includeInteractive && service.listActivity) {
    return service.listActivity({
      includeInteractive: true,
      ...(host ? { host } : {}),
      ...(agentKind ? { agentKind } : {}),
      ...(typeof sinceMs === "number" ? { sinceMs } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
  }
  return service.listRuns({
    ...(typeof limit === "number" ? { limit } : {}),
  });
}

interface ResolvedRunHandle {
  input: string;
  runId: string;
  shortId: string;
  listEntry?: RunListEntry;
}

interface RunPickupFields {
  issue?: string;
  host?: string;
  backend?: string;
  worktreePath?: string;
  worktreeSource?: string;
  branch?: string;
  runDir?: string;
  runRecordPath?: string;
  kernelReceiptPath?: string;
  eventsPath?: string;
  artifactNames: string[];
  requiredArtifactNames: string[];
  missingArtifactNames: string[];
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(source: unknown, key: string): string | undefined {
  const record = asPlainRecord(source);
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function isRunListEntry(entry: RunListEntry | RunActivityEntry): entry is RunListEntry {
  return !("entry_kind" in entry) || entry.entry_kind === "calyx_run";
}

function parseRunIdInput(
  commandName: string,
  positionalRunId: string | undefined,
  optionRunId: string | undefined,
): string {
  const positional = positionalRunId?.trim();
  const option = optionRunId?.trim();
  if (positional && option && positional !== option) {
    throw createCliError(
      `${commandName} accepts either a positional run id or --run-id <id>, not both.`,
      2,
    );
  }
  const runId = positional || option;
  if (!runId) {
    throw createCliError(`${commandName} requires a run id. Pass <run-id> or --run-id <id>.`, 2);
  }
  return runId;
}

const FULL_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_RUN_ID_PATTERN = new RegExp(RUN_ID_PATTERN_SOURCE);

function formatRunHandleMatch(entry: RunListEntry): string {
  const details = [
    entry.state,
    `host=${entry.host ?? "-"}`,
    `issue=${entry.issue ?? "-"}`,
    `backend=${entry.backend ?? "-"}`,
    `updated=${entry.updated_at}`,
  ];
  return `  ${shortRunId(entry.run_id)}  ${entry.run_id}  ${details.join(" ")}`;
}

async function resolveRunHandle(
  commandName: string,
  positionalRunId: string | undefined,
  options: RunReadCommandOptions | RunLogsCommandOptions,
  deps: RunCliDependencies,
): Promise<ResolvedRunHandle> {
  const input = parseRunIdInput(commandName, positionalRunId, options.runId);
  if (FULL_RUN_ID_PATTERN.test(input)) {
    return { input, runId: input, shortId: shortRunId(input) };
  }

  const remoteResolution = isRemoteRunReadTarget(options);
  if (remoteResolution && CANONICAL_RUN_ID_PATTERN.test(input)) {
    try {
      const exact = await getRunRecord({
        runId: input,
        ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
        ...(options.authToken ? { authToken: options.authToken } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }, deps);
      if (exact) {
        if (exact.run_id !== input) {
          throw createCliError(
            `admin.run.get returned run ${exact.run_id} for exact handle ${input}.`,
            6,
          );
        }
        return { input, runId: exact.run_id, shortId: shortRunId(exact.run_id) };
      }
    } catch (error) {
      if ((error as CliError).exitCode !== 3) throw error;
    }
  }
  const entries = (await listRuns({
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(remoteResolution
      ? {
          limit: String(RUN_HANDLE_RESOLUTION_SCAN_MAX_ITEMS),
          requireComplete: true,
        }
      : {}),
  }, deps)).filter(isRunListEntry);

  const exact = entries.find((entry) => entry.run_id === input);
  if (exact) {
    return { input, runId: exact.run_id, shortId: shortRunId(exact.run_id), listEntry: exact };
  }

  const matches = entries.filter((entry) => entry.run_id.startsWith(input));
  if (matches.length === 1) {
    const match = matches[0]!;
    return { input, runId: match.run_id, shortId: shortRunId(match.run_id), listEntry: match };
  }
  if (matches.length > 1) {
    throw createCliError(
      [
        `Run handle "${input}" is ambiguous; ${matches.length} runs match.`,
        ...matches.slice(0, 10).map(formatRunHandleMatch),
        matches.length > 10 ? `  ... ${matches.length - 10} more match(es)` : undefined,
        "Use a longer prefix or the full run id.",
      ].filter((line): line is string => Boolean(line)).join("\n"),
      3,
    );
  }
  if (entries.length > 0) {
    throw createCliError(`Run handle "${input}" not found among ${entries.length} known run(s).`, 3);
  }
  return { input, runId: input, shortId: shortRunId(input) };
}

function isRemoteRunReadTarget(options: { host?: string; serverUrl?: string }): boolean {
  return usesExplicitRunReadServer(options.host, options.serverUrl);
}

function collectArtifactNames(source: unknown, key: "discovered" | "required"): string[] {
  const artifacts = asPlainRecord(source);
  const values = artifacts?.[key];
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((entry) => stringField(entry, "name"))
    .filter((name): name is string => Boolean(name));
}

function collectMissingArtifactNames(source: unknown): string[] {
  const values = asPlainRecord(source)?.["missing"];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function collectRunPickupFields(
  record: RunRecord,
  options: RunReadCommandOptions | RunLogsCommandOptions,
  handle: ResolvedRunHandle,
): RunPickupFields {
  const intent = asPlainRecord(record.intent);
  const spec = asPlainRecord(record.spec);
  const kernelReceipt = asPlainRecord(record.kernel_receipt);
  const environment = asPlainRecord(kernelReceipt?.["environment"]);
  const artifacts = asPlainRecord(kernelReceipt?.["artifacts"]);
  const worktree = asPlainRecord(spec?.["worktree"]);
  const runDir = handle.listEntry?.run_dir
    ?? (!isRemoteRunReadTarget(options) ? join(options.runsRoot?.trim() || defaultRunsRoot(), record.run_id) : undefined);
  const issue = stringField(intent, "issue");
  const host = handle.listEntry?.host ?? stringField(intent, "host") ?? stringField(environment, "host");
  const backend = handle.listEntry?.backend ?? stringField(intent, "backend") ?? stringField(spec, "backend") ?? stringField(environment, "backend");
  const worktreePath = stringField(environment, "worktree_path") ?? stringField(intent, "worktree_path") ?? stringField(worktree, "path");
  const worktreeSource = stringField(intent, "worktree_source") ?? stringField(spec, "worktree_source");
  const branch = stringField(environment, "branch") ?? stringField(intent, "branch") ?? stringField(worktree, "branch");
  const fields: RunPickupFields = {
    artifactNames: collectArtifactNames(artifacts, "discovered"),
    requiredArtifactNames: collectArtifactNames(artifacts, "required"),
    missingArtifactNames: collectMissingArtifactNames(artifacts),
  };
  if (issue) fields.issue = issue;
  if (host) fields.host = host;
  if (backend) fields.backend = backend;
  if (worktreePath) fields.worktreePath = worktreePath;
  if (worktreeSource) fields.worktreeSource = worktreeSource;
  if (branch) fields.branch = branch;
  if (runDir) {
    fields.runDir = runDir;
    fields.runRecordPath = join(runDir, "run_record.json");
    fields.kernelReceiptPath = join(runDir, "kernel_receipt.json");
    fields.eventsPath = join(runDir, "events.jsonl");
  }
  return fields;
}

function quoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function followupScopeArgs(
  options: RunReadCommandOptions | RunLogsCommandOptions,
  pickup: RunPickupFields,
): string[] {
  const args: string[] = [];
  const explicitHost = options.host?.trim();
  const inferredHost = pickup.host && pickup.host.trim().toLowerCase() !== "local"
    ? pickup.host
    : undefined;
  const host = explicitHost || inferredHost;
  if (host) {
    args.push("--host", host);
  }
  const serverUrl = options.serverUrl?.trim();
  if (serverUrl) {
    args.push("--server-url", serverUrl);
  }
  const runsRoot = options.runsRoot?.trim();
  if (runsRoot) {
    args.push("--runs-root", runsRoot);
  }
  return args;
}

function usesExplicitRunReadServer(host: string | undefined, explicitServerUrl: string | undefined): boolean {
  if (explicitServerUrl?.trim()) {
    return true;
  }
  const target = host?.trim().toLowerCase();
  return Boolean(target && target !== "local");
}

function formatFollowupCommand(
  verb: "status" | "logs" | "receipt" | "kernel-receipt",
  handle: ResolvedRunHandle,
  options: RunReadCommandOptions | RunLogsCommandOptions,
  pickup: RunPickupFields,
  extraArgs: string[] = [],
): string {
  const followupRunId = handle.listEntry ? handle.shortId : handle.runId;
  const args = ["calyx", "run", verb, followupRunId, ...followupScopeArgs(options, pickup), ...extraArgs];
  return args.map(quoteCommandArg).join(" ");
}

function appendPickupLines(
  lines: string[],
  record: RunRecord,
  options: RunReadCommandOptions | RunLogsCommandOptions,
  handle: ResolvedRunHandle,
): void {
  const pickup = collectRunPickupFields(record, options, handle);
  lines.push(`  full_id: ${record.run_id}`);
  lines.push(`  short_id: ${handle.shortId}`);
  if (pickup.issue) lines.push(`  issue: ${pickup.issue}`);
  if (pickup.host) lines.push(`  host: ${pickup.host}`);
  if (pickup.backend) lines.push(`  backend: ${pickup.backend}`);
  if (pickup.worktreePath) lines.push(`  worktree: ${pickup.worktreePath}`);
  if (pickup.worktreeSource) lines.push(`  worktree_source: ${pickup.worktreeSource}`);
  if (pickup.branch) lines.push(`  branch: ${pickup.branch}`);
  if (pickup.runRecordPath) lines.push(`  run_record: ${pickup.runRecordPath}`);
  if (pickup.kernelReceiptPath) lines.push(`  kernel_receipt: ${pickup.kernelReceiptPath}`);
  if (pickup.eventsPath) lines.push(`  events: ${pickup.eventsPath}`);
  if (pickup.artifactNames.length > 0 || pickup.requiredArtifactNames.length > 0 || pickup.missingArtifactNames.length > 0) {
    const names = pickup.artifactNames.length > 0 ? ` (${pickup.artifactNames.join(", ")})` : "";
    lines.push(
      `  artifacts: discovered=${pickup.artifactNames.length}${names} required=${pickup.requiredArtifactNames.length} missing=${pickup.missingArtifactNames.length}`,
    );
    if (pickup.missingArtifactNames.length > 0) {
      lines.push(`  missing_artifacts: ${pickup.missingArtifactNames.join(", ")}`);
    }
  }
  lines.push(`  next_status: ${formatFollowupCommand("status", handle, options, pickup, ["--details"])}`);
  lines.push(`  next_logs: ${formatFollowupCommand("logs", handle, options, pickup, ["--tail", "40"])}`);
  lines.push(`  next_receipt: ${formatFollowupCommand("receipt", handle, options, pickup)}`);
}

function stripRunSummaryTautology(summary: string, runId: string, state: RunRecord["state"]): string {
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statePattern = state === "partial" ? "partial" : state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return summary
    .replace(new RegExp(`^Run ${escapedRunId} ${statePattern}\\.?\\s*$`), "")
    .replace(new RegExp(`^Run ${escapedRunId} ${statePattern};\\s*`), "")
    .trim();
}

function appendInfraErrorClassificationLines(lines: string[], record: RunRecord): void {
  if (record.state !== "infra_error") {
    return;
  }
  const direct = record.infra_error_classification;
  const receiptClassification = asPlainRecord(
    asPlainRecord(record.kernel_receipt)?.["infra_error_classification"],
  );
  const failureLayer = direct?.failure_layer ?? stringField(receiptClassification, "failure_layer");
  const failureReason = direct?.failure_reason ?? stringField(receiptClassification, "failure_reason");
  const message = direct?.message ?? stringField(receiptClassification, "message");
  if (failureLayer && failureReason) {
    lines.push(`  infra_error: ${failureLayer}/${failureReason}`);
  }
  if (message) {
    lines.push(`  infra_message: ${message}`);
  }
}

function appendAgentTerminalProjectionLines(
  lines: string[],
  evidence: Record<string, unknown> | undefined,
  terminalMessage: string | undefined,
): void {
  if (evidence) {
    const scalarFields = [
      ["source", "terminal_source"],
      ["status", "terminal_status"],
      ["reason", "terminal_reason"],
      ["backend_subtype", "terminal_subtype"],
      ["backend_terminal_reason", "terminal_backend_reason"],
      ["backend_stop_reason", "terminal_backend_stop_reason"],
      ["session_id", "terminal_session_id"],
      ["exit_code", "terminal_exit_code"],
      ["signal", "terminal_signal"],
      ["duration_ms", "terminal_duration_ms"],
      ["duration_api_ms", "terminal_api_duration_ms"],
      ["num_turns", "terminal_num_turns"],
      ["total_cost_usd", "terminal_total_cost_usd"],
      ["permission_denial_count", "terminal_permission_denials"],
      ["malformed_line_count", "terminal_malformed_lines"],
      ["unknown_record_count", "terminal_unknown_records"],
    ] as const;
    for (const [field, label] of scalarFields) {
      const value = evidence[field];
      if (typeof value === "string" || typeof value === "number") {
        lines.push(`  ${label}: ${value}`);
      }
    }
    const usage = asPlainRecord(evidence["usage"]);
    if (usage) {
      const usageParts = [
        ["input_tokens", "input"],
        ["output_tokens", "output"],
        ["cache_creation_input_tokens", "cache_creation_input"],
        ["cache_read_input_tokens", "cache_read_input"],
      ] as const;
      const formattedUsageParts = usageParts.flatMap(([field, label]) => typeof usage[field] === "number"
        ? [`${label}=${usage[field]}`]
        : []);
      if (formattedUsageParts.length > 0) {
        lines.push(`  terminal_usage: ${formattedUsageParts.join(" ")}`);
      }
    }
    const providerConstraint = asPlainRecord(evidence["provider_constraint"]);
    if (providerConstraint) {
      const cause = stringField(providerConstraint, "cause");
      const backend = stringField(providerConstraint, "backend");
      const kind = stringField(providerConstraint, "kind");
      const source = stringField(providerConstraint, "source");
      const confidence = stringField(providerConstraint, "confidence");
      const summaryParts = [
        cause ? `cause=${cause}` : undefined,
        backend ? `backend=${backend}` : undefined,
        kind ? `kind=${kind}` : undefined,
        source ? `source=${source}` : undefined,
        confidence ? `confidence=${confidence}` : undefined,
      ].filter((part): part is string => Boolean(part));
      if (summaryParts.length > 0) {
        lines.push(`  provider_constraint: ${summaryParts.join(" ")}`);
      }
      const observedAt = stringField(providerConstraint, "observed_at");
      const resetHint = stringField(providerConstraint, "reset_hint");
      const providerCode = stringField(providerConstraint, "provider_code");
      const httpStatus = providerConstraint["http_status"];
      if (observedAt) lines.push(`  provider_observed: ${observedAt}`);
      if (resetHint) lines.push(`  provider_reset: ${resetHint}`);
      if (providerCode) lines.push(`  provider_code: ${providerCode}`);
      if (typeof httpStatus === "number") lines.push(`  provider_http_status: ${httpStatus}`);
    }
  }
  if (terminalMessage) {
    lines.push("  ---");
    lines.push("  agent_terminal_message:");
    for (const line of terminalMessage.split("\n")) lines.push(`    ${line}`);
  }
}

function formatRunStatusDetailsText(
  record: RunRecord,
  options: RunReadCommandOptions,
  handle: ResolvedRunHandle,
): string {
  const stateDisplay = formatRunStateDisplay(record.state, record.kernel_receipt);
  const pickup = collectRunPickupFields(record, options, handle);
  const headline = [
    handle.shortId,
    stateDisplay,
    record.health?.status ? `health=${record.health.status}` : undefined,
    pickup.host ? `host=${pickup.host}` : undefined,
    pickup.issue ? `issue=${pickup.issue}` : undefined,
    pickup.backend ? `backend=${pickup.backend}` : undefined,
    `updated=${record.updated_at}`,
  ].filter((part): part is string => Boolean(part)).join(" ");
  const lines = [headline];
  const summary = stripRunSummaryTautology(record.summary, record.run_id, record.state);
  if (summary) {
    lines.push(`  summary: ${summary}`);
  }
  appendInfraErrorClassificationLines(lines, record);
  if (record.health) {
    lines.push(`  health: ${record.health.status}`);
    if (record.health.progress_signal) {
      lines.push(`  progress_source: ${record.health.progress_signal.source}`);
      lines.push(`  progress_signal: ${record.health.progress_signal.status}`);
      lines.push(`  progress_signal_reason: ${record.health.progress_signal.reason}`);
      if (record.health.progress_signal.expected_silence_until) {
        lines.push(`  progress_expected_silence_until: ${record.health.progress_signal.expected_silence_until}`);
      }
    }
    if (options.details) {
      lines.push(`  health_checked: ${record.health.checked_at}`);
      lines.push(`  health_summary: ${record.health.summary}`);
      lines.push(`  stale_after: ${formatDurationMs(record.health.stale_after_ms)}`);
    }
    if (record.health.last_progress_at) {
      lines.push(`  last_progress: ${record.health.last_progress_at}`);
      const ageMs = computeHealthAgeMs(record.health.last_progress_at);
      if (typeof ageMs === "number" && options.details) {
        lines.push(`  progress_age: ${formatDurationMs(ageMs)}`);
      }
    }
  }
  const statusKernelReceipt = asPlainRecord(record.kernel_receipt);
  appendAgentTerminalProjectionLines(
    lines,
    asPlainRecord(statusKernelReceipt?.["terminal_evidence"]),
    stringField(statusKernelReceipt, "agent_terminal_message"),
  );
  if (options.details) {
    lines.push(`  recovery: ${record.recovery.mode}`);
    lines.push(`  created: ${record.created_at}`);
    lines.push(`  updated: ${record.updated_at}`);
  }
  if (record.completed_at) {
    lines.push(`  completed: ${record.completed_at}`);
  }
  const partialMsg = formatPartialMessage(record.state, record.kernel_receipt);
  if (partialMsg) {
    lines.push(`  note: ${partialMsg}`);
  }
  appendPickupLines(lines, record, options, handle);
  return lines.join("\n");
}

function formatRunStatusText(
  record: RunRecord,
  options: RunReadCommandOptions,
  handle: ResolvedRunHandle,
): string {
  if (options.details) {
    return formatRunStatusDetailsText(record, options, handle);
  }
  return formatRunOutcomeText(toRunStatusResult(record, handle, options));
}

function formatRunReceiptText(
  record: RunRecord,
  options: RunReadCommandOptions,
  handle: ResolvedRunHandle,
): string {
  const lines = [
    record.summary,
    `  run_id: ${record.run_id}`,
    `  state: ${record.state}`,
    `  created: ${record.created_at}`,
    `  updated: ${record.updated_at}`,
  ];
  if (record.completed_at) {
    lines.push(`  completed: ${record.completed_at}`);
  }
  appendInfraErrorClassificationLines(lines, record);
  lines.push(`  recovery: ${record.recovery.mode}`);
  lines.push(`  integrations: ${record.integrations.results.length}`);
  if (record.health) {
    lines.push(`  health: ${record.health.status}`);
    if (record.health.progress_signal) {
      lines.push(`  progress_source: ${record.health.progress_signal.source}`);
      lines.push(`  progress_signal: ${record.health.progress_signal.status}`);
      lines.push(`  progress_signal_reason: ${record.health.progress_signal.reason}`);
      if (record.health.progress_signal.expected_silence_until) {
        lines.push(`  progress_expected_silence_until: ${record.health.progress_signal.expected_silence_until}`);
      }
    }
    lines.push(`  health_checked: ${record.health.checked_at}`);
    lines.push(`  health_summary: ${record.health.summary}`);
    lines.push(`  stale_after: ${formatDurationMs(record.health.stale_after_ms)}`);
    if (record.health.last_progress_at) {
      lines.push(`  last_progress: ${record.health.last_progress_at}`);
    }
  }

  const partialReason = extractPartialReason(record.kernel_receipt);
  if (partialReason) {
    lines.push(`  partial_reason: ${partialReason}`);
  }
  const partialMsg = formatPartialMessage(record.state, record.kernel_receipt);
  if (partialMsg) {
    lines.push(`  note: ${partialMsg}`);
  }
  const kr = asPlainRecord(record.kernel_receipt);
  const backendSession = asPlainRecord(kr?.["backend_session"]);
  if (backendSession) {
    const sessionId = stringField(backendSession, "id");
    const sessionPath = stringField(backendSession, "path");
    const sessionBackend = stringField(backendSession, "backend");
    if (sessionId) lines.push(`  session_id: ${sessionId}`);
    if (sessionPath) lines.push(`  session_path: ${sessionPath}`);
    if (sessionBackend) lines.push(`  session_backend: ${sessionBackend}`);
  }
  appendAgentTerminalProjectionLines(
    lines,
    asPlainRecord(kr?.["terminal_evidence"]),
    stringField(kr, "agent_terminal_message"),
  );
  appendPickupLines(lines, record, options, handle);
  return lines.join("\n");
}

function parseInfraErrorFailureLayer(value: string | undefined): InfraErrorFailureLayer {
  return INFRA_ERROR_FAILURE_LAYERS.find((candidate) => candidate === value) ?? "unknown";
}

function parseInfraErrorFailureReason(value: string | undefined): InfraErrorFailureReason {
  return INFRA_ERROR_FAILURE_REASONS.find((candidate) => candidate === value) ?? "unknown";
}

const RUN_OUTCOME_TEXT_TARGET_BYTES = 1_024;
const RUN_OUTCOME_TEXT_HARD_BYTES = 4_096;
const RUN_OUTCOME_JSON_TARGET_BYTES = 4_096;
const RUN_OUTCOME_JSON_HARD_BYTES = 16_384;
const RUN_OUTCOME_MESSAGE_MAX_BYTES = 256;
const RUN_OUTCOME_METADATA_MAX_BYTES = 256;
const RUN_OUTCOME_TIMESTAMP_MAX_BYTES = 64;
const RUN_OUTCOME_ADDRESS_MAX_BYTES = 4_096;
const RUN_OUTCOME_EVENT_REF_MAX_BYTES = 512;
const RUN_OUTCOME_OMITTED_CLASSES = [
  "prompt",
  "resolved_spec",
  "run_record",
  "kernel_receipt",
  "health_observations",
  "artifact_names",
  "filesystem_paths",
] as const;
const RUN_OUTCOME_DEFAULT_CLASS_EXCEPTIONS = [
  {
    content_class: "filesystem_paths",
    field: "continuation.scope.runs_root",
    reason: "accepted_nonsecret_address",
  },
] as const;
const RUN_OUTCOME_DETAIL_OPERATIONS = [
  { operation: "run.status", format: "text", details: true },
  { operation: "run.receipt", format: "json" },
  { operation: "run.kernel-receipt", format: "json" },
  { operation: "run.logs", format: "text", tail: 40 },
  { operation: "run.subscribe", format: "jsonl", event_type: "run.terminal" },
] as const;

function serializedJsonStringPayloadBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function boundedRunOutcomeField(
  value: string,
  maximumBytes: number,
  field: string,
  overflow: RunOutcomeOverflowFact[],
): { value: string; truncated: boolean } {
  const originalBytes = serializedJsonStringPayloadBytes(value);
  if (originalBytes <= maximumBytes) {
    return { value, truncated: false };
  }
  let bounded = "";
  let emittedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = serializedJsonStringPayloadBytes(codePoint);
    if (emittedBytes + codePointBytes > maximumBytes) break;
    bounded += codePoint;
    emittedBytes += codePointBytes;
  }
  overflow.push({
    field,
    disposition: "truncated",
    original_bytes: originalBytes,
    emitted_bytes: emittedBytes,
  });
  return {
    value: bounded,
    truncated: true,
  };
}

function exactRunOutcomeField(
  value: string | undefined,
  maximumBytes: number,
  field: string,
  overflow: RunOutcomeOverflowFact[],
): string | undefined {
  if (!value) {
    return undefined;
  }
  const originalBytes = serializedJsonStringPayloadBytes(value);
  if (originalBytes <= maximumBytes) {
    return value;
  }
  overflow.push({
    field,
    disposition: "omitted",
    original_bytes: originalBytes,
    emitted_bytes: 0,
  });
  return undefined;
}

function exactRunOutcomeAddress(
  value: string | undefined,
  option: "--server-url" | "--runs-root",
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const bytes = serializedJsonStringPayloadBytes(normalized);
  if (bytes > RUN_OUTCOME_ADDRESS_MAX_BYTES) {
    throw createCliError(
      `${option} exceeds the ${RUN_OUTCOME_ADDRESS_MAX_BYTES}-byte exact continuation limit (${bytes} bytes).`,
      6,
    );
  }
  return normalized;
}

function exactRunOutcomeHost(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const bytes = serializedJsonStringPayloadBytes(normalized);
  if (bytes > RUN_OUTCOME_METADATA_MAX_BYTES) {
    throw createCliError(
      `--host exceeds the ${RUN_OUTCOME_METADATA_MAX_BYTES}-byte exact continuation limit (${bytes} bytes).`,
      6,
    );
  }
  return normalized;
}

function validateRunOutcomeAddressing(options: RunReadCommandOptions): void {
  exactRunOutcomeHost(options.host);
  exactRunOutcomeAddress(options.serverUrl, "--server-url");
  exactRunOutcomeAddress(options.runsRoot, "--runs-root");
}

function canonicalRunOutcomeTimestamp(
  value: string,
  field: string,
  overflow: RunOutcomeOverflowFact[],
): string {
  const timestamp = new Date(value);
  if (!Number.isNaN(timestamp.getTime())) {
    return timestamp.toISOString();
  }
  return boundedRunOutcomeField(
    value,
    RUN_OUTCOME_TIMESTAMP_MAX_BYTES,
    field,
    overflow,
  ).value;
}

function buildRunOutcomeDiagnostics(
  record: RunRecord,
  overflow: RunOutcomeOverflowFact[],
): RunOutcomeDiagnostics {
  const agentReceipt = record.kernel_receipt && !("kernel" in record.kernel_receipt)
    ? record.kernel_receipt
    : undefined;
  const terminalEvidence = agentReceipt?.terminal_evidence;
  const rawProviderConstraint = terminalEvidence?.provider_constraint;
  const providerConstraint = rawProviderConstraint
    ? (() => {
        const backend = boundedRunOutcomeField(
          rawProviderConstraint.backend,
          RUN_OUTCOME_METADATA_MAX_BYTES,
          "diagnostics.provider_constraint.backend",
          overflow,
        );
        const providerCode = rawProviderConstraint.provider_code
          ? boundedRunOutcomeField(
              rawProviderConstraint.provider_code,
              RUN_OUTCOME_METADATA_MAX_BYTES,
              "diagnostics.provider_constraint.provider_code",
              overflow,
            )
          : undefined;
        const resetHint = rawProviderConstraint.reset_hint
          ? boundedRunOutcomeField(
              rawProviderConstraint.reset_hint,
              RUN_OUTCOME_MESSAGE_MAX_BYTES,
              "diagnostics.provider_constraint.reset_hint",
              overflow,
            )
          : undefined;
        return {
          schema_version: rawProviderConstraint.schema_version,
          cause: rawProviderConstraint.cause,
          backend: backend.value,
          kind: rawProviderConstraint.kind,
          source: rawProviderConstraint.source,
          observed_at: canonicalRunOutcomeTimestamp(
            rawProviderConstraint.observed_at,
            "diagnostics.provider_constraint.observed_at",
            overflow,
          ),
          confidence: rawProviderConstraint.confidence,
          ...(providerCode ? { provider_code: providerCode.value } : {}),
          ...(typeof rawProviderConstraint.http_status === "number"
            ? { http_status: rawProviderConstraint.http_status }
            : {}),
          ...(resetHint
            ? {
                reset_hint: resetHint.value,
                ...(resetHint.truncated ? { reset_hint_truncated: true as const } : {}),
              }
            : {}),
        } satisfies RunOutcomeProviderConstraint;
      })()
    : undefined;
  const directInfra = record.state === "infra_error" ? record.infra_error_classification : undefined;
  const receiptInfra = record.state === "infra_error"
    ? asPlainRecord(asPlainRecord(record.kernel_receipt)?.["infra_error_classification"])
    : undefined;
  const failureLayer = directInfra?.failure_layer
    ?? parseInfraErrorFailureLayer(stringField(receiptInfra, "failure_layer"));
  const failureReason = directInfra?.failure_reason
    ?? parseInfraErrorFailureReason(stringField(receiptInfra, "failure_reason"));
  const infraMessage = directInfra?.message ?? stringField(receiptInfra, "message");
  const infraDiagnostic = record.state === "infra_error"
    ? (() => {
        const boundedMessage = boundedRunOutcomeField(
          infraMessage ?? record.summary,
          RUN_OUTCOME_MESSAGE_MAX_BYTES,
          "diagnostics.infra_error.message",
          overflow,
        );
        return {
          failure_layer: failureLayer,
          failure_reason: failureReason,
          message: boundedMessage.value,
          ...(boundedMessage.truncated ? { message_truncated: true as const } : {}),
        };
      })()
    : undefined;
  const includeFailure = isTerminal(record.state)
    && !isSuccessful(record.state)
    && record.state !== "partial"
    && record.state !== "infra_error";
  const boundedSummary = includeFailure
    ? boundedRunOutcomeField(
        record.summary,
        RUN_OUTCOME_MESSAGE_MAX_BYTES,
        "diagnostics.failure.summary",
        overflow,
      )
    : undefined;
  const spawnError = includeFailure ? readSpawnError(record.kernel_receipt) : undefined;
  const boundedSpawnError = spawnError
    ? boundedRunOutcomeField(
        spawnError,
        RUN_OUTCOME_MESSAGE_MAX_BYTES,
        "diagnostics.failure.spawn_error",
        overflow,
      )
    : undefined;

  return {
    ...(terminalEvidence
      ? {
          terminal_evidence: {
            source: terminalEvidence.source,
            status: terminalEvidence.status,
            reason: terminalEvidence.reason,
            ...(terminalEvidence.backend_subtype
              ? {
                  backend_subtype: boundedRunOutcomeField(
                    terminalEvidence.backend_subtype,
                    RUN_OUTCOME_MESSAGE_MAX_BYTES,
                    "diagnostics.terminal_evidence.backend_subtype",
                    overflow,
                  ).value,
                }
              : {}),
            ...(terminalEvidence.backend_terminal_reason
              ? {
                  backend_terminal_reason: boundedRunOutcomeField(
                    terminalEvidence.backend_terminal_reason,
                    RUN_OUTCOME_MESSAGE_MAX_BYTES,
                    "diagnostics.terminal_evidence.backend_terminal_reason",
                    overflow,
                  ).value,
                }
              : {}),
            ...(terminalEvidence.backend_stop_reason
              ? {
                  backend_stop_reason: boundedRunOutcomeField(
                    terminalEvidence.backend_stop_reason,
                    RUN_OUTCOME_MESSAGE_MAX_BYTES,
                    "diagnostics.terminal_evidence.backend_stop_reason",
                    overflow,
                  ).value,
                }
              : {}),
            ...(terminalEvidence.session_id
              ? {
                  session_id: boundedRunOutcomeField(
                    terminalEvidence.session_id,
                    RUN_OUTCOME_MESSAGE_MAX_BYTES,
                    "diagnostics.terminal_evidence.session_id",
                    overflow,
                  ).value,
                }
              : {}),
            ...(typeof terminalEvidence.exit_code === "number" ? { exit_code: terminalEvidence.exit_code } : {}),
            ...(terminalEvidence.signal
              ? {
                  signal: boundedRunOutcomeField(
                    terminalEvidence.signal,
                    RUN_OUTCOME_MESSAGE_MAX_BYTES,
                    "diagnostics.terminal_evidence.signal",
                    overflow,
                  ).value,
                }
              : {}),
          },
        }
      : {}),
    ...(providerConstraint ? { provider_constraint: providerConstraint } : {}),
    ...(infraDiagnostic ? { infra_error: infraDiagnostic } : {}),
    ...(boundedSummary
      ? {
          failure: {
            summary: boundedSummary.value,
            ...(boundedSummary.truncated ? { summary_truncated: true as const } : {}),
            exit_code: deriveRunRecordExitCode(record),
            ...(boundedSpawnError
              ? {
                  spawn_error: boundedSpawnError.value,
                  ...(boundedSpawnError.truncated ? { spawn_error_truncated: true as const } : {}),
                }
              : {}),
          },
        }
      : {}),
  };
}

function buildRunOutcomeCause(
  record: RunRecord,
  diagnostics: RunOutcomeDiagnostics,
  partialReason: PartialReason | undefined,
): RunOutcomeCause {
  const providerConstraint = diagnostics.provider_constraint;
  if (providerConstraint) {
    return {
      category: "provider_constraint",
      reason: "provider_capacity_exhausted",
      backend: providerConstraint.backend,
      constraint_kind: providerConstraint.kind,
    };
  }
  if (diagnostics.infra_error) {
    return {
      category: "infra_error",
      reason: diagnostics.infra_error.failure_reason,
      failure_layer: diagnostics.infra_error.failure_layer,
    };
  }
  if (partialReason) {
    return {
      category: "partial",
      reason: partialReason,
    };
  }
  if (!isTerminal(record.state)) {
    return {
      category: "active",
      reason: "run_active",
    };
  }
  return {
    category: "terminal",
    reason: diagnostics.terminal_evidence?.reason
      ?? (isSuccessful(record.state) ? "completed" : record.state),
  };
}

function buildRunOutcomeContinuation(
  runId: string,
  pickup: RunPickupFields,
  options: RunReadCommandOptions,
  overflow: RunOutcomeOverflowFact[],
): RunOutcomeContinuation {
  const explicitHost = options.host?.trim();
  const inferredHost = pickup.host && pickup.host.trim().toLowerCase() !== "local"
    ? pickup.host
    : undefined;
  const host = explicitHost
    ? exactRunOutcomeHost(explicitHost)
    : exactRunOutcomeField(
        inferredHost,
        RUN_OUTCOME_METADATA_MAX_BYTES,
        "continuation.scope.host",
        overflow,
      );
  const runsRoot = exactRunOutcomeAddress(options.runsRoot, "--runs-root");
  const serverUrl = exactRunOutcomeAddress(options.serverUrl, "--server-url");
  return {
    selector: {
      kind: "run_id",
      run_id: runId,
    },
    scope: {
      ...(host ? { host } : {}),
      ...(runsRoot ? { runs_root: runsRoot } : {}),
      ...(serverUrl ? { server_url: serverUrl } : {}),
      authentication: options.authToken ? "required_not_embedded" : "ambient",
    },
    operations: [
      { operation: "run.status", format: "json" },
      { operation: "run.status", format: "text", details: true },
      { operation: "run.await", format: "json" },
      { operation: "run.logs", format: "text", tail: 40 },
      { operation: "run.receipt", format: "json" },
      { operation: "run.kernel-receipt", format: "json" },
      { operation: "run.subscribe", format: "jsonl", event_type: "run.terminal" },
    ],
  };
}

function buildRunOutcomeProjection(
  record: RunRecord,
  handle: ResolvedRunHandle,
  options: RunReadCommandOptions,
  lastEvent?: { cursor: string; event_id: string },
): RunOutcomeProjection {
  const overflow: RunOutcomeOverflowFact[] = [];
  const pickup = collectRunPickupFields(record, options, handle);
  const backend = pickup.backend === "claude" || pickup.backend === "codex" ? pickup.backend : null;
  if (!CANONICAL_RUN_ID_PATTERN.test(record.run_id)) {
    throw createCliError(
      `Run outcome cannot emit an invalid canonical run_id: ${record.run_id.length} characters.`,
      6,
    );
  }
  const runId = record.run_id;
  const host = pickup.host
    ? boundedRunOutcomeField(pickup.host, RUN_OUTCOME_METADATA_MAX_BYTES, "host", overflow).value
    : null;
  const issue = pickup.issue
    ? boundedRunOutcomeField(pickup.issue, RUN_OUTCOME_METADATA_MAX_BYTES, "issue", overflow).value
    : null;
  const partialReason = record.state === "partial" ? extractPartialReason(record.kernel_receipt) : undefined;
  const diagnostics = buildRunOutcomeDiagnostics(record, overflow);
  const cause = buildRunOutcomeCause(record, diagnostics, partialReason);
  const continuation = buildRunOutcomeContinuation(runId, pickup, options, overflow);
  const terminal = isTerminal(record.state);

  return {
    run_id: runId,
    state: record.state,
    terminal,
    successful: isSuccessful(record.state),
    cause,
    partial_reason: partialReason ?? null,
    next_action: {
      operation: terminal ? "run.receipt" : "run.await",
      reason: terminal ? "run_terminal" : "run_active",
    },
    continuation,
    short_id: handle.shortId,
    host,
    backend,
    issue,
    created_at: canonicalRunOutcomeTimestamp(record.created_at, "created_at", overflow),
    updated_at: canonicalRunOutcomeTimestamp(record.updated_at, "updated_at", overflow),
    completed_at: record.completed_at
      ? canonicalRunOutcomeTimestamp(record.completed_at, "completed_at", overflow)
      : null,
    diagnostics,
    health: record.health
      ? {
          status: record.health.status,
          checked_at: canonicalRunOutcomeTimestamp(
            record.health.checked_at,
            "health.checked_at",
            overflow,
          ),
          last_progress_at: record.health.last_progress_at
            ? canonicalRunOutcomeTimestamp(
                record.health.last_progress_at,
                "health.last_progress_at",
                overflow,
              )
            : null,
          progress_signal: record.health.progress_signal
            ? {
                source: record.health.progress_signal.source,
                status: record.health.progress_signal.status,
                reason: record.health.progress_signal.reason,
                ...(record.health.progress_signal.expected_silence_until
                  ? {
                      expected_silence_until: canonicalRunOutcomeTimestamp(
                        record.health.progress_signal.expected_silence_until,
                        "health.progress_signal.expected_silence_until",
                        overflow,
                      ),
                    }
                  : {}),
              }
            : null,
        }
      : null,
    artifacts: {
      discovered: pickup.artifactNames.length,
      required: pickup.requiredArtifactNames.length,
      missing: pickup.missingArtifactNames.length,
    },
    ...(lastEvent
      ? {
          last_event: {
            cursor: boundedRunOutcomeField(
              lastEvent.cursor,
              RUN_OUTCOME_EVENT_REF_MAX_BYTES,
              "last_event.cursor",
              overflow,
            ).value,
            event_id: boundedRunOutcomeField(
              lastEvent.event_id,
              RUN_OUTCOME_EVENT_REF_MAX_BYTES,
              "last_event.event_id",
              overflow,
            ).value,
          },
        }
      : {}),
    response_economics: {
      tier: "default",
      formats: {
        text: {
          target_bytes: RUN_OUTCOME_TEXT_TARGET_BYTES,
          hard_bytes: RUN_OUTCOME_TEXT_HARD_BYTES,
        },
        json: {
          target_bytes: RUN_OUTCOME_JSON_TARGET_BYTES,
          hard_bytes: RUN_OUTCOME_JSON_HARD_BYTES,
        },
      },
      overflow,
      omitted_classes: [...RUN_OUTCOME_OMITTED_CLASSES],
      default_class_exceptions: RUN_OUTCOME_DEFAULT_CLASS_EXCEPTIONS.map((exception) => ({ ...exception })),
      detail_operations: RUN_OUTCOME_DETAIL_OPERATIONS.map((operation) => ({ ...operation })),
    },
  };
}

function buildRunAwaitResult(
  record: RunRecord,
  handle: ResolvedRunHandle,
  options: RunReadCommandOptions,
  timedOut: boolean,
  lastEvent?: { cursor: string; event_id: string },
): RunAwaitResult {
  const outcome = buildRunOutcomeProjection(record, handle, options, lastEvent);
  const {
    run_id,
    state,
    terminal,
    successful,
    cause,
    partial_reason,
    next_action,
    continuation,
    ...context
  } = outcome;
  return {
    schema_version: "calyx.run-await/v2",
    run_id,
    state,
    terminal,
    successful,
    timed_out: timedOut,
    cause,
    partial_reason,
    next_action,
    continuation,
    ...context,
  };
}

function assertRunOutcomeBudget(
  rendered: string,
  maximumBytes: number,
  format: "text" | "json",
): string {
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes > maximumBytes) {
    throw createCliError(
      `calyx run ${format} outcome exceeded its ${maximumBytes}-byte hard contract (${bytes} bytes).`,
      6,
    );
  }
  return rendered;
}

function serializeRunOutcome(result: RunStatusResult | RunAwaitResult): string {
  return assertRunOutcomeBudget(JSON.stringify(result), RUN_OUTCOME_JSON_HARD_BYTES, "json");
}

function renderRunOutcomeTextValue(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function formatRunOutcomeText(result: RunStatusResult | RunAwaitResult): string {
  const timedOut = "timed_out" in result && result.timed_out;
  const outcome = timedOut ? "timed_out" : result.state;
  const lines = [
    `${result.short_id} ${outcome} terminal=${result.terminal} successful=${result.successful}`,
    `  run_id: ${result.run_id}`,
    `  cause: ${result.cause.category}/${result.cause.reason}`,
  ];
  if (result.partial_reason) {
    lines.push(`  partial_reason: ${result.partial_reason}`);
  }
  lines.push(`  next_action: ${result.next_action.operation} reason=${result.next_action.reason}`);
  const identity = [
    result.host ? `host=${renderRunOutcomeTextValue(result.host)}` : undefined,
    result.issue ? `issue=${renderRunOutcomeTextValue(result.issue)}` : undefined,
    result.backend ? `backend=${result.backend}` : undefined,
  ].filter((part): part is string => Boolean(part));
  if (identity.length > 0) {
    lines.push(`  ${identity.join(" ")}`);
  }
  if (result.diagnostics.provider_constraint) {
    const constraint = result.diagnostics.provider_constraint;
    lines.push(
      `  provider_constraint: cause=${constraint.cause} backend=${renderRunOutcomeTextValue(constraint.backend)} kind=${constraint.kind} source=${constraint.source}`,
    );
    if (constraint.reset_hint) {
      lines.push(`  provider_reset: ${renderRunOutcomeTextValue(constraint.reset_hint)}`);
    }
  }
  if (result.diagnostics.infra_error) {
    lines.push(
      `  infra_error: ${result.diagnostics.infra_error.failure_layer}/${result.diagnostics.infra_error.failure_reason}`,
    );
    lines.push(`  infra_message: ${renderRunOutcomeTextValue(result.diagnostics.infra_error.message)}`);
  }
  if (result.diagnostics.failure) {
    lines.push(`  failure: ${renderRunOutcomeTextValue(result.diagnostics.failure.summary)}`);
  }
  if (result.health) {
    lines.push(
      `  health: ${result.health.status} checked=${result.health.checked_at}`
      + (result.health.last_progress_at ? ` last_progress=${result.health.last_progress_at}` : ""),
    );
  }
  lines.push(
    `  artifacts: discovered=${result.artifacts.discovered}`
    + ` required=${result.artifacts.required} missing=${result.artifacts.missing}`,
  );
  lines.push("  continuation: use --json for typed selector and exact non-secret scope");
  lines.push("  detail: run.status(details), run.receipt, run.kernel-receipt, run.logs, run.subscribe");
  if (result.response_economics.overflow.length > 0) {
    lines.push(`  overflow: ${result.response_economics.overflow.length} bounded field(s); inspect --json`);
  }
  return assertRunOutcomeBudget(lines.join("\n"), RUN_OUTCOME_TEXT_HARD_BYTES, "text");
}

function formatRunAwaitText(result: RunAwaitResult): string {
  return formatRunOutcomeText(result);
}

function requiredSuccessExitCode(state: RunState): number {
  switch (state) {
    case "succeeded":
    case "completed_dirty":
      return 0;
    case "failed":
    case "cancelled":
      return 1;
    case "partial":
      return 2;
    case "infra_error":
      return 6;
    case "auth_error":
      return 8;
    default:
      return 0;
  }
}

function isRetryableRunAwaitObservationError(error: unknown): boolean {
  return error instanceof Error && (error as CliError).retryable === true;
}

async function readAwaitRunRecord(
  handle: ResolvedRunHandle,
  options: RunReadCommandOptions,
  deps: RunCliDependencies,
): Promise<RunRecord> {
  const record = await getRunRecord({ ...options, runId: handle.runId }, deps);
  if (!record) {
    throw createCliError(`Run "${handle.input}" not found.`, 3);
  }
  if (record.run_id !== handle.runId) {
    throw createCliError(
      `Run observation returned ${record.run_id} for canonical handle ${handle.runId}.`,
      6,
    );
  }
  return record;
}

async function readLocalTerminalEventEvidence(
  runId: string,
  options: RunReadCommandOptions,
  deps: RunCliDependencies,
): Promise<{ cursor: string; event_id: string } | undefined> {
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  try {
    const events = await service.readEvents(runId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (stringField(event, "event_type") !== "run.terminal") continue;
      const cursor = stringField(event, "cursor");
      const eventId = stringField(event, "event_id");
      if (cursor && eventId) return { cursor, event_id: eventId };
    }
  } catch {
    // Event evidence is optional; the canonical run record remains authority.
  }
  return undefined;
}

function watchRunDirectory(
  runDir: string,
  onChange: () => void,
  onError: (error: Error) => void,
  deps: RunCliDependencies,
): () => void {
  if (deps.watchRunChanges) return deps.watchRunChanges(runDir, onChange, onError);
  const watcher = watchFs(runDir, { persistent: true }, onChange);
  watcher.on("error", onError);
  return () => watcher.close();
}

async function awaitLocalRunCommand(
  handle: ResolvedRunHandle,
  options: RunAwaitCommandOptions,
  deps: RunCliDependencies,
  initialRecord: RunRecord,
  control: RunAwaitControl,
): Promise<{ result?: RunAwaitResult; interruptExitCode?: 130 | 143; record?: RunRecord }> {
  const pickup = collectRunPickupFields(initialRecord, options, handle);
  if (!pickup.runDir) {
    throw createCliError(`Unable to resolve the local run directory for ${handle.runId}.`, 6);
  }

  return await new Promise((resolve, reject) => {
    let record = initialRecord;
    let closeWatcher: (() => void) | undefined;
    let rearmTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let observation = Promise.resolve();
    const cleanup = (): void => {
      if (rearmTimer) clearTimeout(rearmTimer);
      closeWatcher?.();
      control.signal.removeEventListener("abort", onControlAbort);
    };
    const finish = (outcome: { result?: RunAwaitResult; interruptExitCode?: 130 | 143; record?: RunRecord }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onControlAbort = (): void => {
      closeWatcher?.();
      if (rearmTimer) clearTimeout(rearmTimer);
      const reason = control.stopReason();
      if (reason === "sigint" || reason === "sigterm") {
        finish({ interruptExitCode: reason === "sigint" ? 130 : 143 });
        return;
      }
      observation = observation.then(async () => {
        if (settled) return;
        record = await readAwaitRunRecord(handle, options, deps);
        finish({
          result: buildRunAwaitResult(record, handle, options, !isTerminal(record.state)),
          record,
        });
      }).catch(fail);
    };
    const observe = (eventParticipated: boolean): void => {
      observation = observation.then(async () => {
        if (settled) return;
        record = await readAwaitRunRecord(handle, options, deps);
        if (!isTerminal(record.state)) return;
        const eventEvidence = eventParticipated
          ? await readLocalTerminalEventEvidence(handle.runId, options, deps)
          : undefined;
        finish({
          result: buildRunAwaitResult(record, handle, options, false, eventEvidence),
          record,
        });
      }).catch(fail);
    };
    const armWatcher = (): void => {
      if (settled) return;
      try {
        closeWatcher = watchRunDirectory(
          pickup.runDir!,
          () => observe(true),
          (error) => {
            closeWatcher?.();
            closeWatcher = undefined;
            console.error(`run await local watcher reconnecting: ${error.message}`);
            observe(false);
            rearmTimer = setTimeout(armWatcher, 1_000);
          },
          deps,
        );
      } catch (error) {
        console.error(
          `run await local watcher reconnecting: ${error instanceof Error ? error.message : String(error)}`,
        );
        observe(false);
        rearmTimer = setTimeout(armWatcher, 1_000);
        return;
      }
      // This reread closes the status-to-watcher establishment race.
      observe(false);
    };

    control.signal.addEventListener("abort", onControlAbort, { once: true });
    if (control.signal.aborted) onControlAbort();
    else armWatcher();
  });
}

async function awaitRunCommand(
  handle: ResolvedRunHandle,
  options: RunAwaitCommandOptions,
  deps: RunCliDependencies,
  control: RunAwaitControl,
): Promise<{ result?: RunAwaitResult; interruptExitCode?: 130 | 143; record?: RunRecord }> {
  let record = await readAwaitRunRecord(handle, options, deps);
  if (isTerminal(record.state)) {
    return { result: buildRunAwaitResult(record, handle, options, false), record };
  }
  if (!isRemoteRunReadTarget(options)) {
    return await awaitLocalRunCommand(handle, options, deps, record, control);
  }

  let lastEvent: { cursor: string; event_id: string } | undefined;
  const reconcileStatus = async (
    phase: "connected" | "event" | "disconnected",
  ): Promise<"terminal" | "active" | "unavailable"> => {
    try {
      record = await readAwaitRunRecord(handle, options, deps);
      return isTerminal(record.state) ? "terminal" : "active";
    } catch (error) {
      if (control.signal.aborted) throw error;
      if (!isRetryableRunAwaitObservationError(error)) throw error;
      console.error(
        `run await canonical status temporarily unavailable after ${phase}; retaining the durable cursor and retrying`,
      );
      return "unavailable";
    }
  };

  await streamRunEvents({
    runId: handle.runId,
    eventType: "run.terminal",
    ...(options.host ? { host: options.host } : {}),
    ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
    ...(options.authToken ? { authToken: options.authToken } : {}),
    signal: control.signal,
  }, deps, {
    onConnected: async () => await reconcileStatus("connected") === "terminal",
    onEvent: async (event) => {
      if (
        event.event_type !== "run.terminal"
        || !("run" in event)
        || event.run.run_id !== handle.runId
      ) {
        return false;
      }
      const eventId = stringField(event, "event_id");
      if (eventId) {
        lastEvent = { cursor: event.cursor, event_id: eventId };
      }
      return await reconcileStatus("event") === "terminal";
    },
    onDisconnected: async (error) => {
      if (await reconcileStatus("disconnected") === "terminal") return true;
      const reason = error instanceof Error ? `: ${error.message}` : "";
      console.error(
        `run await reconnecting from ${lastEvent?.cursor ?? "the durable replay boundary"}${reason}`,
      );
      return false;
    },
  });

  const stopReason = control.stopReason();
  if (stopReason === "sigint" || stopReason === "sigterm") {
    return { interruptExitCode: stopReason === "sigint" ? 130 : 143 };
  }
  const result = buildRunAwaitResult(
    record,
    handle,
    options,
    stopReason === "timeout" && !isTerminal(record.state),
    lastEvent,
  );
  return { result, record };
}

function formatRunPsShortId(entry: RunListEntry | RunActivityEntry): string {
  if ("entry_kind" in entry && entry.entry_kind === "interactive_session") {
    const sessionShort = shortRunId(entry.session_id);
    return `interactive:${entry.backend}:${sessionShort}`;
  }
  return shortRunId(entry.run_id);
}

function formatRunPsSummary(entry: RunListEntry | RunActivityEntry): string {
  if ("entry_kind" in entry && entry.entry_kind === "interactive_session") {
    return entry.summary || "-";
  }
  const parts = [stripRunSummaryTautology(entry.summary, entry.run_id, entry.state)];
  if (entry.progress_signal) {
    parts.push(
      `progress=${entry.progress_signal.source}/${entry.progress_signal.status}/${entry.progress_signal.reason}`,
    );
  }
  if (entry.terminal) {
    const evidence = entry.terminal.evidence;
    parts.push(`terminal=${evidence.source}/${evidence.status}/${evidence.reason}`);
  }
  return parts.filter(Boolean).join("; ") || "-";
}

function formatRunPsLine(entry: RunListEntry | RunActivityEntry): string {
  if ("entry_kind" in entry && entry.entry_kind === "interactive_session") {
    return [
      formatRunPsShortId(entry),
      "interactive",
      "-",
      entry.host ?? "-",
      "-",
      entry.backend,
      "-",
      entry.updated_at,
      formatRunPsSummary(entry),
    ].join("\t");
  }
  return [
    formatRunPsShortId(entry),
    entry.state === "partial" ? "partial" : entry.state,
    entry.health_status ?? "-",
    entry.host ?? "-",
    entry.issue ?? "-",
    entry.backend ?? "-",
    stringField(entry, "branch") ?? "-",
    entry.updated_at,
    formatRunPsSummary(entry),
  ].join("\t");
}

async function inspectInteractiveActivity(
  options: RunActivityCommandOptions,
  deps: RunCliDependencies,
): Promise<InteractiveSessionInspectResult> {
  requireActivityLocatorGrammar(options.activityId);
  const host = options.host?.trim();
  const tail = parsePositiveIntegerOption(options.tail, "--tail");
  const context = parseNonNegativeIntegerOption(options.context, "--context");
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(
        `Remote run activity queries require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
        2
      );
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const refusal = getDaemonCompatibilityRefusal(
      host ?? serverUrl,
      health,
      [CALYX_DAEMON_FEATURES.interactiveActivityDetailV1],
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.get({
      path: { activityId: options.activityId },
      query: {
        ...(options.around ? { around: options.around } : {}),
        ...(typeof tail === "number" ? { tail: String(tail) } : {}),
        ...(typeof context === "number" ? { context: String(context) } : {}),
        ...(options.includeTools ? { include_tools: "1" as const } : {}),
      },
    });
    return requireClientResult(result, "activity detail") as unknown as InteractiveSessionInspectResult;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectInteractiveSession) {
    throw createCliError("Local RunService does not support interactive activity detail inspection.", 6);
  }
  return service.inspectInteractiveSession({
    activityId: options.activityId,
    ...(host ? { host } : {}),
    ...(options.around ? { around: options.around } : {}),
    ...(typeof tail === "number" ? { tail } : {}),
    ...(typeof context === "number" ? { context } : {}),
    ...(typeof options.includeTools === "boolean" ? { includeTools: options.includeTools } : {}),
  });
}

function formatInteractiveActivityText(result: InteractiveSessionInspectResult): string {
  const lines = [
    `${result.activity_id}\t${result.backend}\t${result.cwd ?? "-"}\t${result.session_path}`,
  ];
  for (const event of result.events) {
    const timestamp = event.timestamp ?? "-";
    lines.push(`${event.line}\t${timestamp}\t${event.role}\t${event.kind}\t${event.summary}`);
  }
  return lines.join("\n");
}

function formatInteractiveActivityMarkdown(result: InteractiveSessionInspectResult): string {
  const lines = [
    `# ${result.activity_id}`,
    "",
    `- Backend: ${result.backend}`,
    `- Session: ${result.session_id}`,
    `- Path: ${result.session_path}`,
    result.cwd ? `- CWD: ${result.cwd}` : undefined,
    "",
  ].filter((line): line is string => typeof line === "string");
  for (const event of result.events) {
    lines.push(`## ${event.line}. ${event.role} / ${event.kind}`);
    if (event.timestamp) {
      lines.push(`_Time: ${event.timestamp}_`);
    }
    lines.push("");
    lines.push(event.text ?? event.summary);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Activity facade helpers (POL-1352) ────────────────────────────────

interface ActivityCommonOptions {
  host?: string;
  serverUrl?: string;
  authToken?: string;
  runsRoot?: string;
  json?: boolean;
}

type ActivitySelfCommandOptions = ActivityCommonOptions;

interface ActivitySelfWarning {
  code: "activity_not_indexed";
  message: string;
}

interface ActivitySelfResult {
  schema_version: "activity.self/v1";
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  resolution_source: string;
  indexed: boolean;
  session_path?: string;
  source?: Extract<RunActivityEntry, { entry_kind: "interactive_session" }>["source"];
  cwd?: string;
  host?: string;
  created_at?: string;
  updated_at?: string;
  warnings: ActivitySelfWarning[];
}

interface ActivityOverviewCommandOptions extends ActivityCommonOptions {
  agentKind?: string;
  sinceHours?: string;
  limit?: string;
  turnRole?: string;
  maxTextChars?: string;
  maxMessages?: string;
}

interface ActivityOverviewWarning {
  code: "turn_unavailable" | "turn_outside_window";
  message: string;
  activity_id?: string;
}

interface ActivityOverviewMessage {
  id: string;
  role: ActivityMessageRole;
  timestamp?: string;
  age_seconds?: number;
  text: string;
  truncated?: boolean;
}

interface ActivityOverviewTurn {
  turn_id: string;
  index: number;
  role: ActivityTurnRoleFilter;
  state: "complete" | "in_flight";
  started_at?: string;
  ended_at?: string;
  age_seconds?: number;
  total_message_count: number;
  visible_message_count: number;
  returned_message_count: number;
  omitted_message_count: number;
  tool_call_count: number;
  tool_result_count: number;
  summary: string;
  messages: ActivityOverviewMessage[];
}

interface ActivityOverviewRow {
  activity_id: string;
  backend: InteractiveSessionBackend;
  session_id: string;
  host?: string;
  cwd?: string;
  source?: Extract<RunActivityEntry, { entry_kind: "interactive_session" }>["source"];
  session_path?: string;
  updated_at?: string;
  updated_age_seconds?: number;
  turn?: ActivityOverviewTurn;
}

interface ActivityOverviewResult {
  schema_version: "activity.overview/v1";
  generated_at: string;
  host?: string;
  filters: {
    agent_kind: InteractiveSessionBackend | "all";
    since_hours: number;
    limit: number;
    turn_role: ActivityTurnRoleFilter | "all";
    max_text_chars: number;
    max_messages: number;
  };
  scanned_activities: number;
  returned_activities: number;
  skipped_activities: number;
  warnings: ActivityOverviewWarning[];
  rows: ActivityOverviewRow[];
}

interface ActivityMessagesCommandOptions extends ActivityCommonOptions {
  role?: string;
  visibility?: string;
  first?: string;
  last?: string;
  latestSession?: boolean;
  backend?: string;
  aroundId?: string;
  aroundText?: string;
  context?: string;
  grep?: string;
  summaryOnly?: boolean;
  maxTextChars?: string;
  explainClassification?: boolean;
}

interface ActivityEventsCommandOptions extends ActivityCommonOptions {
  classify?: boolean;
  rawRole?: string;
  tail?: string;
  aroundId?: string;
  context?: string;
  latestSession?: boolean;
  backend?: string;
  withinTurn?: boolean;
}

interface ActivityTurnsCommandOptions extends ActivityCommonOptions {
  role?: string;
  first?: string;
  last?: string;
  latestSession?: boolean;
  backend?: string;
  withTools?: boolean;
  summaryOnly?: boolean;
  maxTextChars?: string;
}

interface ActivityTextCommandOptions extends ActivityCommonOptions {
  range?: string;
  from?: string;
  classifierVersion?: string;
}

interface ActivityAttachmentsCommandOptions extends ActivityCommonOptions {
  turn?: string;
  message?: string;
  extract?: boolean;
  ref?: string;
  out?: string;
}

interface ActivityMarkCommandOptions extends ActivityCommonOptions {
  kind?: string;
  targetKind?: string;
  reason?: string;
  idempotencyKey?: string;
  assertedActor?: string;
}

interface ActivityUnmarkCommandOptions extends ActivityCommonOptions {
  assertedActor?: string;
}

interface ActivityMarksCommandOptions extends ActivityCommonOptions {
  kind?: string;
  targetKind?: string;
  targetId?: string;
  since?: string;
  limit?: string;
  cursor?: string;
}

interface ContextCaptureCommandOptions extends ActivityCommonOptions {
  fromActivity?: string;
  turn?: string[];
  aroundId?: string;
  aroundText?: string;
  context?: string;
  type?: VaultPutInputType;
  title?: string;
  daily?: boolean;
  issue?: string;
  project?: string;
  workstream?: string;
  author?: string;
  status?: string;
  notes?: string;
  notesFile?: string;
  vaultPath?: string;
  maxTextChars?: string;
}

type ContextCaptureMode = "plan" | "apply";

interface ContextCaptureWarning {
  code: string;
  message: string;
  message_id?: string;
}

interface ContextCaptureResult {
  schema_version: "context.capture/v1";
  mode: ContextCaptureMode;
  dry_run: boolean;
  source_activity_id: string;
  selected_turn_ids: string[];
  selected_message_ids: string[];
  requested_max_text_chars: number;
  effective_max_text_chars: number;
  truncated_message_ids: string[];
  estimated_bytes: number;
  apply_command: string;
  vault: {
    output_path: string;
    relative_path: string;
    type: string;
    backlink: VaultPutResult["backlink"];
  };
  receipt_path?: string;
  warnings: ContextCaptureWarning[];
}

interface ContextCaptureReceipt {
  schema_version: "context.capture.receipt/v1";
  generated_at: string;
  source_activity_id: string;
  mode: "apply";
  output_path: string;
  relative_path: string;
  receipt_path: string;
  selected_turn_ids: string[];
  selected_message_ids: string[];
  requested_max_text_chars: number;
  effective_max_text_chars: number;
  truncated_message_ids: string[];
  estimated_bytes: number;
  apply_command: string;
  warnings: ContextCaptureWarning[];
}

interface ContextCaptureActivitySource {
  raw: string;
  activityId?: string;
  latestSession?: boolean;
  latestSessionBackend?: InteractiveSessionBackend;
  self?: ActivitySelfResult;
}

function parseActivityRoleOption(value: string | undefined): ActivityMessageRole | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "user") {
    throw createCliError(
      "ambiguous role `user`; use `--role human` for human turns or `calyx activity events --raw-role user` for raw events.",
      2,
    );
  }
  const normalized = trimmed.replace(/-/g, "_") as ActivityMessageRole;
  if (!ACTIVITY_MESSAGE_ROLES.includes(normalized)) {
    throw createCliError(
      `Invalid --role "${value}". Use one of: ${ACTIVITY_MESSAGE_ROLES.join(", ")}.`,
      2,
    );
  }
  return normalized;
}

function parseActivityVisibilityOption(value: string | undefined): ActivityVisibilityTier | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  if (!ACTIVITY_VISIBILITY_TIERS.includes(value as ActivityVisibilityTier)) {
    throw createCliError(
      `Invalid --visibility "${value}". Use one of: ${ACTIVITY_VISIBILITY_TIERS.join(", ")}.`,
      2,
    );
  }
  return value as ActivityVisibilityTier;
}

function parseActivityRawRoleOption(value: string | undefined): InteractiveSessionEventRole | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "user" || trimmed === "assistant" || trimmed === "tool" || trimmed === "system" || trimmed === "unknown") {
    return trimmed;
  }
  throw createCliError(
    `Invalid --raw-role "${value}". Use one of: user, assistant, tool, system, unknown.`,
    2,
  );
}

function parseActivityTurnRoleOption(value: string | undefined): ActivityTurnRoleFilter | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "user") {
    throw createCliError(
      "ambiguous role `user`; use `--role human` for human turns or `--role all` for every turn.",
      2,
    );
  }
  if ((ACTIVITY_TURN_ROLE_FILTERS as readonly string[]).includes(trimmed)) {
    return trimmed as ActivityTurnRoleFilter;
  }
  throw createCliError(
    `Invalid --role "${value}". Use one of: ${ACTIVITY_TURN_ROLE_FILTERS.join(", ")}.`,
    2,
  );
}

function parseActivityBackendOption(value: string | undefined): InteractiveSessionBackend | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed !== "codex" && trimmed !== "claude") {
    throw createCliError(`--backend must be one of: codex, claude.`, 2);
  }
  return trimmed;
}

function emitRunActivityDeprecationWarning(): void {
  console.error(
    "warning: `calyx run activity` is deprecated; use `calyx activity ...` (see `calyx activity --help`).",
  );
}

function buildMessagesSelectorFromCli(options: ActivityMessagesCommandOptions): ActivityMessageSelectorInput {
  const role = parseActivityRoleOption(options.role);
  const visibility = parseActivityVisibilityOption(options.visibility);
  const first = parseNonNegativeIntegerOption(options.first, "--first");
  const last = parseNonNegativeIntegerOption(options.last, "--last");
  const context = parseNonNegativeIntegerOption(options.context, "--context");
  const maxTextChars = parseNonNegativeIntegerOption(options.maxTextChars, "--max-text-chars");
  if (typeof first === "number" && typeof last === "number") {
    throw createCliError("--first and --last are mutually exclusive.", 2);
  }
  if (options.aroundId && options.aroundText) {
    throw createCliError("--around-id and --around-text are mutually exclusive.", 2);
  }
  if (typeof context === "number" && !options.aroundId && !options.aroundText) {
    throw createCliError("--context requires --around-id or --around-text.", 2);
  }
  return {
    ...(role ? { role } : {}),
    ...(visibility ? { visibility } : {}),
    ...(typeof first === "number" ? { first } : {}),
    ...(typeof last === "number" ? { last } : {}),
    ...(options.aroundId ? { around_id: options.aroundId } : {}),
    ...(options.aroundText ? { around_text: options.aroundText } : {}),
    ...(typeof context === "number" ? { context } : {}),
    ...(options.grep ? { grep: options.grep } : {}),
    ...(options.summaryOnly ? { summary_only: true } : {}),
    ...(typeof maxTextChars === "number" ? { max_text_chars: maxTextChars } : {}),
    ...(options.explainClassification ? { explain_classification: true } : {}),
  };
}

function buildEventsSelectorFromCli(options: ActivityEventsCommandOptions): ActivityEventSelectorInput {
  const rawRole = parseActivityRawRoleOption(options.rawRole);
  const tail = parseNonNegativeIntegerOption(options.tail, "--tail");
  const context = parseNonNegativeIntegerOption(options.context, "--context");
  if (typeof context === "number" && !options.aroundId) {
    throw createCliError("--context requires --around-id.", 2);
  }
  if (options.withinTurn && !options.aroundId) {
    throw createCliError("--within-turn requires --around-id <message-id>.", 2);
  }
  if (options.withinTurn && typeof context === "number") {
    throw createCliError("--within-turn is mutually exclusive with --context.", 2);
  }
  if (options.withinTurn && typeof tail === "number") {
    throw createCliError("--within-turn is mutually exclusive with --tail.", 2);
  }
  if (options.withinTurn && rawRole) {
    throw createCliError(
      "--within-turn returns the raw events for the containing turn; remove --raw-role.",
      2,
    );
  }
  return {
    ...(rawRole ? { raw_role: rawRole } : {}),
    ...(typeof tail === "number" ? { tail } : {}),
    ...(options.aroundId ? { around_id: options.aroundId } : {}),
    ...(typeof context === "number" ? { context } : {}),
    ...(options.classify ? { classify: true } : {}),
    ...(options.withinTurn ? { within_turn: true } : {}),
  };
}

function buildTurnsSelectorFromCli(options: ActivityTurnsCommandOptions): ActivityTurnSelectorInput {
  const role = parseActivityTurnRoleOption(options.role);
  const first = parseNonNegativeIntegerOption(options.first, "--first");
  const last = parseNonNegativeIntegerOption(options.last, "--last");
  const maxTextChars = parseNonNegativeIntegerOption(options.maxTextChars, "--max-text-chars");
  if (typeof first === "number" && typeof last === "number") {
    throw createCliError("--first and --last are mutually exclusive.", 2);
  }
  return {
    ...(role ? { role } : {}),
    ...(typeof first === "number" ? { first } : {}),
    ...(typeof last === "number" ? { last } : {}),
    ...(options.withTools ? { with_tools: true } : {}),
    ...(options.summaryOnly ? { summary_only: true } : {}),
    ...(typeof maxTextChars === "number" ? { max_text_chars: maxTextChars } : {}),
  };
}

function buildTextSelectorFromCli(options: ActivityTextCommandOptions): ActivityTextSelectorInput {
  const from = parseNonNegativeIntegerOption(options.from, "--from");
  if (options.range && typeof from === "number") {
    throw createCliError("--range and --from are mutually exclusive.", 2);
  }
  return {
    ...(options.range ? { range: options.range } : {}),
    ...(typeof from === "number" ? { from } : {}),
    ...(options.classifierVersion ? { classifier_version: options.classifierVersion } : {}),
  };
}

function buildAttachmentsSelectorFromCli(options: ActivityAttachmentsCommandOptions): ActivityAttachmentsSelectorInput {
  const turn = parseNonNegativeIntegerOption(options.turn, "--turn");
  return {
    ...(typeof turn === "number" ? { turn } : {}),
    ...(options.message ? { message_id: options.message } : {}),
    ...(options.extract ? { extract: true } : {}),
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.out ? { out_dir: options.out } : {}),
  };
}

function resolveActivitySelfIdentity(env: NodeJS.ProcessEnv = process.env): {
  backend: InteractiveSessionBackend;
  sessionId: string;
  resolutionSource: string;
} | undefined {
  const codexThread = env["CODEX_THREAD_ID"]?.trim();
  if (codexThread) {
    return { backend: "codex", sessionId: codexThread, resolutionSource: "env:CODEX_THREAD_ID" };
  }
  const codexSession = env["CODEX_SESSION_ID"]?.trim();
  if (codexSession) {
    return { backend: "codex", sessionId: codexSession, resolutionSource: "env:CODEX_SESSION_ID" };
  }
  const claudeSession = env["CLAUDE_CODE_SESSION_ID"]?.trim();
  if (claudeSession) {
    return { backend: "claude", sessionId: claudeSession, resolutionSource: "env:CLAUDE_CODE_SESSION_ID" };
  }
  return undefined;
}

function isInteractiveActivityEntry(
  entry: RunListEntry | RunActivityEntry,
): entry is Extract<RunActivityEntry, { entry_kind: "interactive_session" }> {
  return "entry_kind" in entry && entry.entry_kind === "interactive_session";
}

function fallbackInteractiveActivityId(backend: InteractiveSessionBackend, sessionId: string): string {
  if (sessionId.startsWith("interactive:")) {
    return sessionId;
  }
  return `interactive:${backend}:${sessionId}`;
}

async function resolveActivitySelfCommand(
  options: ActivitySelfCommandOptions,
  deps: RunCliDependencies,
): Promise<ActivitySelfResult> {
  const identity = resolveActivitySelfIdentity();
  if (!identity) {
    throw createCliError(
      [
        "Could not identify this agent session.",
        "Expected CODEX_THREAD_ID, CODEX_SESSION_ID, or CLAUDE_CODE_SESSION_ID in the harness environment.",
        "Use `calyx activity list --include-runs --json` and pass an explicit activity id if the harness does not expose self identity.",
      ].join("\n"),
      3,
    );
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.listActivity) {
    throw createCliError("Local RunService does not support activity self resolution.", 6);
  }

  const host = options.host?.trim();
  const entries = await service.listActivity({
    includeInteractive: true,
    agentKind: identity.backend,
    sinceMs: 30 * 24 * 60 * 60 * 1000,
    limit: 250,
    ...(host ? { host } : {}),
  });
  const fallbackActivityId = fallbackInteractiveActivityId(identity.backend, identity.sessionId);
  const indexed = entries.filter(isInteractiveActivityEntry).find((entry) => {
    return entry.backend === identity.backend
      && (entry.session_id === identity.sessionId || entry.run_id === fallbackActivityId);
  });

  if (indexed) {
    return {
      schema_version: "activity.self/v1",
      activity_id: indexed.run_id,
      backend: indexed.backend,
      session_id: indexed.session_id,
      resolution_source: identity.resolutionSource,
      indexed: true,
      session_path: indexed.session_path,
      source: indexed.source,
      ...(indexed.cwd ? { cwd: indexed.cwd } : {}),
      ...(indexed.host ? { host: indexed.host } : {}),
      created_at: indexed.created_at,
      updated_at: indexed.updated_at,
      warnings: [],
    };
  }

  return {
    schema_version: "activity.self/v1",
    activity_id: fallbackActivityId,
    backend: identity.backend,
    session_id: identity.sessionId,
    resolution_source: identity.resolutionSource,
    indexed: false,
    ...(host ? { host } : {}),
    warnings: [{
      code: "activity_not_indexed",
      message: "The harness session id was found, but no matching activity row was present in the local activity inventory.",
    }],
  };
}

function formatActivitySelfText(result: ActivitySelfResult): string {
  const lines = [
    `${result.activity_id}\t${result.backend}\t${result.session_id}\tindexed=${result.indexed}`,
    `resolution_source=${result.resolution_source}`,
    result.session_path ? `session_path=${result.session_path}` : undefined,
    result.cwd ? `cwd=${result.cwd}` : undefined,
    result.host ? `host=${result.host}` : undefined,
    result.created_at ? `created_at=${result.created_at}` : undefined,
    ...result.warnings.map((warning) => `warning: ${warning.code}: ${warning.message}`),
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

// ── Vault provenance helpers (POL-1847) ─────────────────────────────

interface VaultCloseOutCommandOptions extends ActivityCommonOptions {
  parent?: string;
  spawnedBy?: string;
  slug?: string;
  title?: string;
  dryRun?: boolean;
  vaultPath?: string;
}

interface VaultRadarReceiptCommandOptions extends ActivityCommonOptions {
  week?: string;
  dryRun?: boolean;
  vaultPath?: string;
}

interface VaultLineageCheckCommandOptions extends ActivityCommonOptions {
  session?: boolean;
  vaultPath?: string;
}

interface VaultCloseOutWarning {
  code: string;
  message: string;
}

interface VaultCloseOutResult {
  schema_version: "calyx.vault.close-out/v1";
  dry_run: boolean;
  changed: boolean;
  vault_path: string;
  absolute_path: string;
  relative_path: string;
  uri: string;
  wikilink: string;
  anchor_date: string;
  slug: string;
  title: string;
  activity: {
    activity_id: string;
    backend: InteractiveSessionBackend;
    session_id: string;
    author: string;
    created: string;
    host?: string;
    cwd?: string;
  };
  lineage: {
    parent_session?: string;
    spawned_by?: string;
  };
  stamp?: Pick<VaultStampResult, "schema_version" | "changed" | "fields" | "frontmatter_created" | "body_unchanged">;
  content?: string;
  warnings: VaultCloseOutWarning[];
}

interface VaultCloseOutReference {
  absolute_path: string;
  relative_path: string;
  uri: string;
  wikilink: string;
  title: string;
}

interface VaultRadarReceiptResult {
  schema_version: "calyx.vault.radar-receipt/v1";
  dry_run: boolean;
  changed: boolean;
  week: string;
  radar: {
    absolute_path: string;
    relative_path: string;
    uri: string;
  };
  activity: {
    activity_id: string;
    backend: InteractiveSessionBackend;
    session_id: string;
    author: string;
  };
  close_out: VaultCloseOutReference;
  append: VaultJournalAppendResult;
}

type VaultLineageFindingSeverity = "error" | "warning";

interface VaultLineageFinding {
  code: string;
  severity: VaultLineageFindingSeverity;
  field: string;
  message: string;
  value?: string;
}

interface VaultLineageCheckResult {
  schema_version: "calyx.vault.lineage-check/v1";
  ok: boolean;
  checked: {
    absolute_path: string;
    relative_path: string;
    uri: string;
    mode: "file" | "session";
  };
  lineage: {
    session?: string;
    parent_session?: string;
    spawned_by?: string;
  };
  findings: VaultLineageFinding[];
}

function expandTildePathForCli(rawPath: string): string {
  return rawPath.replace(/^~(?=\/|$)/, homedir());
}

function resolveVaultPathForCli(rawPath?: string): string {
  const candidate = rawPath?.trim() || process.env["VAULT_PATH"]?.trim() || join(homedir(), "vault", "fieldwork");
  return resolvePath(expandTildePathForCli(candidate));
}

function toVaultRelativePath(vaultPath: string, absolutePath: string): string {
  return relativePathFrom(vaultPath, absolutePath).split(/[\\/]+/).join("/");
}

function vaultUriFromRelativePath(relativePath: string): string {
  return `vault://fieldwork/${relativePath}`;
}

function slugifyVaultSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "session";
}

function closeOutSlugFromActivity(self: ActivitySelfResult): string {
  if (self.cwd?.trim()) {
    return slugifyVaultSegment(basename(self.cwd.trim()));
  }
  return slugifyVaultSegment(self.activity_id.replace(/^interactive:[^:]+:/, ""));
}

function validIsoDatePart(value: string | undefined): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  const leadingDate = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/u)?.[1];
  return leadingDate ?? new Date(value).toISOString().slice(0, 10);
}

function commandNow(deps: RunCliDependencies): Date {
  return deps.now ? deps.now() : new Date();
}

function activityCreatedTimestamp(self: ActivitySelfResult, deps: RunCliDependencies): string {
  return self.created_at ?? self.updated_at ?? commandNow(deps).toISOString();
}

function closeOutAnchorDate(self: ActivitySelfResult, deps: RunCliDependencies): string {
  return validIsoDatePart(self.created_at)
    ?? validIsoDatePart(self.updated_at)
    ?? commandNow(deps).toISOString().slice(0, 10);
}

function activityAuthorHandle(self: ActivitySelfResult, deps: RunCliDependencies): string {
  const host = self.host ?? deps.currentHostAlias ?? deps.hostname?.() ?? systemHostname();
  return `${self.backend}:${host}:${self.session_id}`;
}

function closeOutTitleFromSlug(slug: string): string {
  return `Session close-out: ${slug}`;
}

function normalizeCloseOutTitleOption(value: string | undefined): string | undefined {
  const title = normalizeOptionalCliValue(value);
  if (!title) {
    return undefined;
  }
  if (/[\r\n]/u.test(title)) {
    throw createCliError("[calyx vault close-out] --title must be a single line.", 2);
  }
  return /^Session close-out:/iu.test(title) ? title : `Session close-out: ${title}`;
}

function closeOutSlugFromOptions(options: VaultCloseOutCommandOptions, self: ActivitySelfResult): string {
  const explicitSlug = normalizeOptionalCliValue(options.slug);
  if (explicitSlug) {
    return slugifyVaultSegment(explicitSlug);
  }
  const explicitTitle = normalizeCloseOutTitleOption(options.title);
  if (explicitTitle) {
    return slugifyVaultSegment(explicitTitle.replace(/^Session close-out:\s*/iu, ""));
  }
  return closeOutSlugFromActivity(self);
}

function vaultWikilink(relativePath: string, alias?: string): string {
  const target = relativePath.replace(/\.md$/u, "");
  return `[[${target}${alias ? `|${alias}` : ""}]]`;
}

async function vaultPathExists(absolutePath: string): Promise<boolean> {
  try {
    await readFile(absolutePath, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function uniqueCloseOutPath(vaultPath: string, anchorDate: string, slug: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const directory = join(vaultPath, "10-daily", anchorDate);
  const baseName = `session-closeout-${slug}.md`;
  for (let index = 0; index < 100; index += 1) {
    const fileName = index === 0
      ? baseName
      : `session-closeout-${slug}-${index + 1}.md`;
    const absolutePath = join(directory, fileName);
    if (!(await vaultPathExists(absolutePath))) {
      return {
        absolutePath,
        relativePath: toVaultRelativePath(vaultPath, absolutePath),
      };
    }
  }
  throw createCliError(`[calyx vault close-out] could not allocate a unique close-out path for ${slug}.`, 3);
}

function normalizeOptionalCliValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isWikilinkOrIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (/^\[\[[^\]\n]+\]\]$/u.test(trimmed)) {
    return true;
  }
  if (/\s/u.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9:_./#-]*$/u.test(trimmed);
}

function isActivityIdLike(value: string): boolean {
  return /^interactive:[a-z][a-z0-9_-]*:.+/u.test(value)
    || /^run:[A-Za-z0-9._:-]+$/u.test(value);
}

function renderCloseOutMarkdown(input: {
  title: string;
  created: string;
  author: string;
  session: string;
  parentSession?: string;
  spawnedBy?: string;
}): string {
  const frontmatter: Record<string, unknown> = {
    type: "report",
    subtype: "session-closeout",
    created: input.created,
    author: input.author,
    session: input.session,
    ...(input.parentSession ? { parent_session: input.parentSession } : {}),
    ...(input.spawnedBy ? { spawned_by: input.spawnedBy } : {}),
    handoffs: [],
    status: "final",
    tags: ["closeout"],
    related: [],
    related_issues: [],
  };
  return [
    "---",
    YAML.stringify(frontmatter).trimEnd(),
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Outcome",
    "",
    "- ",
    "",
    "## Changed Surfaces",
    "",
    "- ",
    "",
    "## Verification",
    "",
    "- ",
    "",
    "## Handoff",
    "",
    "- ",
    "",
  ].join("\n");
}

async function scaffoldVaultCloseOut(
  options: VaultCloseOutCommandOptions,
  deps: RunCliDependencies,
): Promise<VaultCloseOutResult> {
  const self = await resolveActivitySelfCommand(options, deps);
  const vaultPath = resolveVaultPathForCli(options.vaultPath);
  const parentSession = normalizeOptionalCliValue(options.parent);
  const spawnedBy = normalizeOptionalCliValue(options.spawnedBy);
  if (parentSession && !isActivityIdLike(parentSession)) {
    throw createCliError("[calyx vault close-out] --parent must be an activity id such as interactive:claude:<session> or run:<id>.", 2);
  }
  if (spawnedBy && !isWikilinkOrIdentifier(spawnedBy)) {
    throw createCliError("[calyx vault close-out] --spawned-by must be a wikilink or compact id, not prose.", 2);
  }

  const anchorDate = closeOutAnchorDate(self, deps);
  const slug = closeOutSlugFromOptions(options, self);
  const title = normalizeCloseOutTitleOption(options.title) ?? closeOutTitleFromSlug(slug);
  const created = activityCreatedTimestamp(self, deps);
  const author = activityAuthorHandle(self, deps);
  const target = await uniqueCloseOutPath(vaultPath, anchorDate, slug);
  const content = renderCloseOutMarkdown({
    title,
    created,
    author,
    session: self.activity_id,
    ...(parentSession ? { parentSession } : {}),
    ...(spawnedBy ? { spawnedBy } : {}),
  });
  const dryRun = Boolean(options.dryRun);

  let stamp: VaultCloseOutResult["stamp"];
  if (!dryRun) {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await writeFile(target.absolutePath, content, "utf8");
    const stamped = await stampVaultArtifact(target.relativePath, {
      updatedBy: author,
      vaultPath,
    }, {
      now: commandNow(deps),
      ...(deps.hostname ? { hostnameImpl: deps.hostname } : {}),
    });
    stamp = {
      schema_version: stamped.schema_version,
      changed: stamped.changed,
      fields: stamped.fields,
      frontmatter_created: stamped.frontmatter_created,
      body_unchanged: stamped.body_unchanged,
    };
  }

  return {
    schema_version: "calyx.vault.close-out/v1",
    dry_run: dryRun,
    changed: !dryRun,
    vault_path: vaultPath,
    absolute_path: target.absolutePath,
    relative_path: target.relativePath,
    uri: vaultUriFromRelativePath(target.relativePath),
    wikilink: vaultWikilink(target.relativePath),
    anchor_date: anchorDate,
    slug,
    title,
    activity: {
      activity_id: self.activity_id,
      backend: self.backend,
      session_id: self.session_id,
      author,
      created,
      ...(self.host ? { host: self.host } : {}),
      ...(self.cwd ? { cwd: self.cwd } : {}),
    },
    lineage: {
      ...(parentSession ? { parent_session: parentSession } : {}),
      ...(spawnedBy ? { spawned_by: spawnedBy } : {}),
    },
    ...(stamp ? { stamp } : {}),
    ...(dryRun ? { content } : {}),
    warnings: self.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
  };
}

function formatVaultCloseOutText(result: VaultCloseOutResult): string {
  const prefix = result.dry_run ? "[dry-run] would scaffold" : "scaffolded";
  return [
    `[calyx vault close-out] ${prefix} ${result.relative_path}`,
    `session=${result.activity.activity_id}`,
    result.lineage.parent_session ? `parent_session=${result.lineage.parent_session}` : undefined,
    result.lineage.spawned_by ? `spawned_by=${result.lineage.spawned_by}` : undefined,
    `wikilink=${result.wikilink}`,
    result.dry_run && result.content ? ["---", result.content].join("\n") : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n");
}

function isoWeekNumber(date: Date): { year: number; week: number } {
  const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((current.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: current.getUTCFullYear(), week };
}

function normalizeRadarWeek(rawWeek: string | undefined, deps: RunCliDependencies): string {
  const requested = rawWeek?.trim() || "current";
  if (requested === "current") {
    const { year, week } = isoWeekNumber(commandNow(deps));
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  if (/^\d{4}-W\d{2}$/u.test(requested)) {
    return requested;
  }
  throw createCliError("[calyx vault radar-receipt] --week must be current or YYYY-Www, e.g. 2026-W25.", 2);
}

async function readFirstMarkdownTitle(absolutePath: string, fallback: string): Promise<string> {
  const raw = await readFile(absolutePath, "utf8");
  const heading = raw.split(/\r?\n/u).find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/u, "").trim() : fallback;
}

async function collectCloseOutRelativePaths(vaultPath: string, relativeDirectory = "10-daily"): Promise<string[]> {
  const absoluteDirectory = join(vaultPath, ...relativeDirectory.split("/"));
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name === "_weekly") {
      continue;
    }
    const childRelative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...await collectCloseOutRelativePaths(vaultPath, childRelative));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("session-closeout-") && entry.name.endsWith(".md")) {
      results.push(childRelative);
    }
  }
  return results;
}

async function findCloseOutForSession(vaultPath: string, session: string): Promise<VaultCloseOutReference | undefined> {
  const candidates = (await collectCloseOutRelativePaths(vaultPath)).sort().reverse();
  for (const relativePath of candidates) {
    const frontmatter = await getVaultFrontmatter(relativePath, { vaultPath });
    if (frontmatter.frontmatter["session"] !== session) {
      continue;
    }
    const title = await readFirstMarkdownTitle(frontmatter.absolute_path, basename(relativePath, extname(relativePath)));
    return {
      absolute_path: frontmatter.absolute_path,
      relative_path: frontmatter.relative_path,
      uri: frontmatter.uri,
      wikilink: vaultWikilink(frontmatter.relative_path, "close-out"),
      title,
    };
  }
  return undefined;
}

function radarReceiptTitle(closeOut: VaultCloseOutReference): string {
  return closeOut.title.replace(/^Session close-out:\s*/u, "Session Receipt: ");
}

async function appendVaultRadarReceipt(
  options: VaultRadarReceiptCommandOptions,
  deps: RunCliDependencies,
): Promise<VaultRadarReceiptResult> {
  const self = await resolveActivitySelfCommand(options, deps);
  const vaultPath = resolveVaultPathForCli(options.vaultPath);
  const week = normalizeRadarWeek(options.week, deps);
  const radarRelativePath = `10-daily/_weekly/${week}/README.md`;
  const closeOut = await findCloseOutForSession(vaultPath, self.activity_id);
  if (!closeOut) {
    throw createCliError(
      `[calyx vault radar-receipt] no session close-out found for ${self.activity_id}; run calyx vault close-out first.`,
      3,
    );
  }
  const author = activityAuthorHandle(self, deps);
  const receiptDate = commandNow(deps).toISOString().slice(0, 10);
  const body = [
    `activity \`${self.activity_id}\``,
    `author \`${author}\``,
    `close-out ${closeOut.wikilink}`,
  ].join("; ");
  const append = await appendVaultJournalEntry(radarRelativePath, {
    title: radarReceiptTitle(closeOut),
    date: receiptDate,
    body,
    section: "Session Receipts",
    dryRun: Boolean(options.dryRun),
    vaultPath,
  }, {
    now: commandNow(deps),
    ...(deps.hostname ? { hostnameImpl: deps.hostname } : {}),
  });

  return {
    schema_version: "calyx.vault.radar-receipt/v1",
    dry_run: Boolean(options.dryRun),
    changed: append.changed,
    week,
    radar: {
      absolute_path: append.absolute_path,
      relative_path: append.relative_path,
      uri: append.uri,
    },
    activity: {
      activity_id: self.activity_id,
      backend: self.backend,
      session_id: self.session_id,
      author,
    },
    close_out: closeOut,
    append,
  };
}

function formatVaultRadarReceiptText(result: VaultRadarReceiptResult): string {
  const prefix = result.dry_run ? "[dry-run] would append" : "appended";
  return [
    `[calyx vault radar-receipt] ${prefix} Session Receipt to ${result.radar.relative_path}`,
    `activity=${result.activity.activity_id}`,
    `close_out=${result.close_out.wikilink}`,
  ].join("\n");
}

async function resolveLineageCheckTarget(
  file: string | undefined,
  options: VaultLineageCheckCommandOptions,
  deps: RunCliDependencies,
): Promise<{
  mode: "file" | "session";
  frontmatter: Awaited<ReturnType<typeof getVaultFrontmatter>>;
}> {
  const vaultPath = resolveVaultPathForCli(options.vaultPath);
  if (options.session && file) {
    throw createCliError("[calyx vault lineage-check] pass either <file> or --session, not both.", 2);
  }
  if (options.session) {
    const self = await resolveActivitySelfCommand(options, deps);
    const closeOut = await findCloseOutForSession(vaultPath, self.activity_id);
    if (!closeOut) {
      throw createCliError(
        `[calyx vault lineage-check] no session close-out found for ${self.activity_id}; pass a file or run calyx vault close-out first.`,
        3,
      );
    }
    return {
      mode: "session",
      frontmatter: await getVaultFrontmatter(closeOut.relative_path, { vaultPath }),
    };
  }
  if (!file?.trim()) {
    throw createCliError("[calyx vault lineage-check] pass <file> or --session.", 2);
  }
  return {
    mode: "file",
    frontmatter: await getVaultFrontmatter(file, { vaultPath }),
  };
}

async function dereferenceParentActivity(
  parentSession: string,
  options: VaultLineageCheckCommandOptions,
  deps: RunCliDependencies,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  try {
    if (parentSession.startsWith("run:")) {
      const run = await service.getRunRecord(parentSession.slice("run:".length));
      return run ? { ok: true } : { ok: false, message: "parent run id was not found in the local run store" };
    }
    if (!service.inspectInteractiveSession) {
      return { ok: false, message: "local RunService does not support interactive activity detail inspection" };
    }
    await service.inspectInteractiveSession({
      activityId: parentSession,
      ...(options.host ? { host: options.host } : {}),
      tail: 1,
      context: 0,
      includeTools: false,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function frontmatterStringValue(frontmatter: Record<string, unknown>, field: string): string | undefined {
  const value = frontmatter[field];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function frontmatterRawValue(frontmatter: Record<string, unknown>, field: string): unknown {
  return frontmatter[field];
}

async function runVaultLineageCheck(
  file: string | undefined,
  options: VaultLineageCheckCommandOptions,
  deps: RunCliDependencies,
): Promise<VaultLineageCheckResult> {
  const target = await resolveLineageCheckTarget(file, options, deps);
  const frontmatter = target.frontmatter.frontmatter;
  const findings: VaultLineageFinding[] = [];
  const type = frontmatterStringValue(frontmatter, "type");
  const subtype = frontmatterStringValue(frontmatter, "subtype");
  const session = frontmatterStringValue(frontmatter, "session");
  const parentSession = frontmatterStringValue(frontmatter, "parent_session");
  const spawnedBy = frontmatterStringValue(frontmatter, "spawned_by");

  if (type !== "report") {
    findings.push({
      code: type ? "type_invalid" : "type_missing",
      severity: "error",
      field: "type",
      ...(type ? { value: type } : {}),
      message: "close-out type must be report.",
    });
  }

  if (subtype !== "session-closeout") {
    findings.push({
      code: subtype ? "subtype_invalid" : "subtype_missing",
      severity: "error",
      field: "subtype",
      ...(subtype ? { value: subtype } : {}),
      message: "close-out subtype must be session-closeout.",
    });
  }

  const rawSession = frontmatterRawValue(frontmatter, "session");
  if (rawSession === undefined) {
    findings.push({
      code: "session_missing",
      severity: "error",
      field: "session",
      message: "session is required and must be an activity id string.",
    });
  } else if (!session) {
    findings.push({
      code: "session_invalid_type",
      severity: "error",
      field: "session",
      message: "session must be a non-empty activity id string.",
    });
  } else if (!isActivityIdLike(session)) {
    findings.push({
      code: "session_invalid_id",
      severity: "error",
      field: "session",
      value: session,
      message: "session must be an activity id such as interactive:codex:<session> or run:<id>.",
    });
  }

  if (frontmatterRawValue(frontmatter, "parent_session") !== undefined && !parentSession) {
    findings.push({
      code: "parent_session_invalid_type",
      severity: "error",
      field: "parent_session",
      message: "parent_session must be a non-empty activity id string.",
    });
  } else if (parentSession) {
    if (!isActivityIdLike(parentSession)) {
      findings.push({
        code: "parent_session_invalid_id",
        severity: "error",
        field: "parent_session",
        value: parentSession,
        message: "parent_session must be an activity id such as interactive:claude:<session> or run:<id>.",
      });
    } else {
      const resolved = await dereferenceParentActivity(parentSession, options, deps);
      if (!resolved.ok) {
        findings.push({
          code: "parent_session_unresolved",
          severity: "error",
          field: "parent_session",
          value: parentSession,
          message: `parent_session did not dereference via calyx activity: ${resolved.message}`,
        });
      }
    }
  }

  if (frontmatterRawValue(frontmatter, "spawned_by") !== undefined && !spawnedBy) {
    findings.push({
      code: "spawned_by_invalid_type",
      severity: "error",
      field: "spawned_by",
      message: "spawned_by must be a non-empty wikilink or compact id string.",
    });
  } else if (spawnedBy && !isWikilinkOrIdentifier(spawnedBy)) {
    findings.push({
      code: "spawned_by_prose",
      severity: "error",
      field: "spawned_by",
      value: spawnedBy,
      message: "spawned_by must be a wikilink or compact id, not prose.",
    });
  }

  return {
    schema_version: "calyx.vault.lineage-check/v1",
    ok: findings.every((finding) => finding.severity !== "error"),
    checked: {
      absolute_path: target.frontmatter.absolute_path,
      relative_path: target.frontmatter.relative_path,
      uri: target.frontmatter.uri,
      mode: target.mode,
    },
    lineage: {
      ...(session ? { session } : {}),
      ...(parentSession ? { parent_session: parentSession } : {}),
      ...(spawnedBy ? { spawned_by: spawnedBy } : {}),
    },
    findings,
  };
}

function formatVaultLineageCheckText(result: VaultLineageCheckResult): string {
  if (result.ok) {
    return `[calyx vault lineage-check] ok ${result.checked.relative_path}`;
  }
  return [
    `[calyx vault lineage-check] failed ${result.checked.relative_path}`,
    ...result.findings.map((finding) => `${finding.severity}: ${finding.code}: ${finding.message}`),
  ].join("\n");
}

async function resolveContextCaptureActivitySource(
  rawActivityId: string,
  options: ContextCaptureCommandOptions,
  deps: RunCliDependencies,
): Promise<ContextCaptureActivitySource> {
  if (rawActivityId === "self") {
    const self = await resolveActivitySelfCommand(options, deps);
    return { raw: rawActivityId, activityId: self.activity_id, self };
  }
  if (rawActivityId.startsWith("latest:")) {
    const backend = parseActivityBackendOption(rawActivityId.slice("latest:".length));
    if (!backend) {
      throw createCliError("--from-activity latest:<backend> requires codex or claude.", 2);
    }
    return { raw: rawActivityId, latestSession: true, latestSessionBackend: backend };
  }
  return { raw: rawActivityId, activityId: rawActivityId };
}

function parseContextCaptureTurnSelector(
  rawValue: string,
  maxTextChars: number,
): ActivityTurnSelectorInput {
  const parts = rawValue.split(":").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 3) {
    throw createCliError(
      `Invalid --turn "${rawValue}". Expected <role>:<first|last>:<count>, e.g. assistant:last:1.`,
      2,
    );
  }
  const [rawRole, direction, rawCount] = parts as [string, string, string];
  const role = parseActivityTurnRoleOption(rawRole);
  const count = parsePositiveInteger(rawCount, "--turn count");
  if (direction !== "first" && direction !== "last") {
    throw createCliError(
      `Invalid --turn "${rawValue}". Direction must be first or last.`,
      2,
    );
  }
  return {
    ...(role ? { role } : {}),
    ...(direction === "first" ? { first: count } : { last: count }),
    max_text_chars: maxTextChars,
  };
}

function defaultContextCaptureTurnSelectors(maxTextChars: number): ActivityTurnSelectorInput[] {
  return [
    { role: "human", last: 1, max_text_chars: maxTextChars },
    { role: "assistant", last: 1, max_text_chars: maxTextChars },
  ];
}

function contextCaptureSourceOptions(
  source: ContextCaptureActivitySource,
): Pick<ActivityTurnsCommandOptions, "latestSession" | "backend"> {
  return {
    ...(source.latestSession ? { latestSession: true } : {}),
    ...(source.latestSessionBackend ? { backend: source.latestSessionBackend } : {}),
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function pushShellOption(parts: string[], flag: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  parts.push(flag, shellQuote(trimmed));
}

function buildContextCaptureApplyCommand(options: ContextCaptureCommandOptions): string {
  const parts = ["calyx", "context", "capture", "apply"];
  pushShellOption(parts, "--from-activity", options.fromActivity);
  for (const turn of options.turn ?? []) {
    pushShellOption(parts, "--turn", turn);
  }
  pushShellOption(parts, "--around-id", options.aroundId);
  pushShellOption(parts, "--around-text", options.aroundText);
  pushShellOption(parts, "--context", options.context);
  pushShellOption(parts, "--max-text-chars", options.maxTextChars);
  if (options.daily) {
    parts.push("--daily");
  } else if (options.type) {
    pushShellOption(parts, "--type", options.type);
  }
  pushShellOption(parts, "--title", options.title);
  pushShellOption(parts, "--issue", options.issue);
  pushShellOption(parts, "--project", options.project);
  pushShellOption(parts, "--workstream", options.workstream);
  pushShellOption(parts, "--author", options.author);
  pushShellOption(parts, "--status", options.status);
  if (options.notesFile) {
    pushShellOption(parts, "--notes-file", options.notesFile);
  } else {
    pushShellOption(parts, "--notes", options.notes);
  }
  pushShellOption(parts, "--vault-path", options.vaultPath);
  pushShellOption(parts, "--runs-root", options.runsRoot);
  pushShellOption(parts, "--host", options.host);
  pushShellOption(parts, "--server-url", options.serverUrl);
  if (options.authToken) {
    parts.push("--auth-token", "<redacted>");
  }
  parts.push("--json");
  return parts.join(" ");
}

function markdownFenceForText(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return fence;
}

type CapturedActivityMessage =
  | ActivityTurnsResult["turns"][number]["messages"][number]
  | ActivityMessagesResult["messages"][number];

function renderCapturedMessage(message: CapturedActivityMessage): string[] {
  const text = message.text ?? message.summary;
  const fence = markdownFenceForText(text);
  return [
    `#### ${message.role} message`,
    "",
    `- message_id: \`${message.id}\``,
    ...(message.timestamp ? [`- timestamp: \`${message.timestamp}\``] : []),
    ...(message.truncated ? ["- truncated: `true`"] : []),
    "",
    fence,
    text,
    fence,
    "",
  ];
}

function renderContextCaptureMarkdown(args: {
  title: string;
  sourceActivityId: string;
  notes?: string;
  turns: ActivityTurnsResult["turns"];
  messages: ActivityMessagesResult["messages"];
  warnings: ContextCaptureWarning[];
  requestedMaxTextChars: number;
  effectiveMaxTextChars: number;
  truncatedMessageIds: string[];
}): string {
  const lines: string[] = [
    `# ${args.title}`,
    "",
    "## Capture Summary",
    "",
    `- source_activity_id: \`${args.sourceActivityId}\``,
    `- selected_turns: ${args.turns.length}`,
    `- selected_messages: ${args.messages.length}`,
    `- requested_max_text_chars: ${args.requestedMaxTextChars}`,
    `- effective_max_text_chars: ${args.effectiveMaxTextChars}`,
    `- truncated_messages: ${args.truncatedMessageIds.length}`,
    `- warnings: ${args.warnings.length}`,
    "",
  ];
  if (args.warnings.length > 0) {
    lines.push("## Capture Warnings", "");
    for (const warning of args.warnings) {
      const messageId = warning.message_id ? ` \`${warning.message_id}\`` : "";
      lines.push(`- ${warning.code}${messageId}: ${warning.message}`);
    }
    lines.push("");
  }
  if (args.notes?.trim()) {
    lines.push("## Operator Notes", "", args.notes.trim(), "");
  }
  lines.push("## Selected Turns", "");
  for (const turn of args.turns) {
    lines.push(
      `### ${turn.role} turn ${turn.index}`,
      "",
      `- turn_id: \`${turn.turn_id}\``,
      `- state: \`${turn.state}\``,
      ...(turn.started_at ? [`- started_at: \`${turn.started_at}\``] : []),
      ...(turn.ended_at ? [`- ended_at: \`${turn.ended_at}\``] : []),
      `- source_lines: \`${turn.source_lines.join("-")}\``,
      "",
    );
    if (turn.summary.trim()) {
      lines.push(turn.summary.trim(), "");
    }
    for (const message of turn.messages) {
      lines.push(...renderCapturedMessage(message));
    }
  }
  if (args.messages.length > 0) {
    lines.push("## Selected Messages", "");
    for (const message of args.messages) {
      lines.push(...renderCapturedMessage(message));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function receiptPathForVaultOutput(outputPath: string): string {
  return outputPath.endsWith(".md")
    ? outputPath.slice(0, -".md".length) + ".receipt.json"
    : `${outputPath}.receipt.json`;
}

async function contextCaptureCommand(
  mode: ContextCaptureMode,
  options: ContextCaptureCommandOptions,
  deps: RunCliDependencies,
): Promise<ContextCaptureResult> {
  const maxTextChars = parsePositiveIntegerOption(options.maxTextChars, "--max-text-chars") ?? 4000;
  const title = options.title?.trim();
  if (!title) {
    throw createCliError("calyx context capture requires --title <title>.", 2);
  }
  if (!options.daily && !options.type) {
    throw createCliError("calyx context capture requires --type <type> or --daily.", 2);
  }
  if (options.daily && options.type) {
    throw createCliError("--daily and --type are mutually exclusive for calyx context capture.", 2);
  }
  const rawActivityId = options.fromActivity?.trim();
  if (!rawActivityId) {
    throw createCliError("calyx context capture requires --from-activity <activity-id|self|latest:<backend>>.", 2);
  }

  const source = await resolveContextCaptureActivitySource(rawActivityId, options, deps);
  const self = source.self;
  const selectors = options.turn && options.turn.length > 0
    ? options.turn.map((value) => parseContextCaptureTurnSelector(value, maxTextChars))
    : defaultContextCaptureTurnSelectors(maxTextChars);

  const turnResults: ActivityTurnsResult[] = [];
  for (const selector of selectors) {
    turnResults.push(await inspectActivityTurnsCommand({
      ...options,
      ...(selector.role ? { role: selector.role } : {}),
      ...(typeof selector.first === "number" ? { first: String(selector.first) } : {}),
      ...(typeof selector.last === "number" ? { last: String(selector.last) } : {}),
      ...(selector.with_tools ? { withTools: true } : {}),
      ...(selector.summary_only ? { summaryOnly: true } : {}),
      ...(typeof selector.max_text_chars === "number" ? { maxTextChars: String(selector.max_text_chars) } : {}),
      ...contextCaptureSourceOptions(source),
    }, deps, source.activityId));
  }

  const contextMessageResults: ActivityMessagesResult[] = [];
  if (options.aroundId || options.aroundText || options.context) {
    contextMessageResults.push(await inspectActivityMessagesCommand({
      ...options,
      ...(options.aroundId ? { aroundId: options.aroundId } : {}),
      ...(options.aroundText ? { aroundText: options.aroundText } : {}),
      ...(options.context ? { context: options.context } : {}),
      maxTextChars: String(maxTextChars),
      ...contextCaptureSourceOptions(source),
    }, deps, source.activityId));
  }

  const seenTurnIds = new Set<string>();
  const selectedTurns: ActivityTurnsResult["turns"] = [];
  const seenContextMessageIds = new Set<string>();
  const selectedContextMessages: ActivityMessagesResult["messages"] = [];
  const warnings: ContextCaptureWarning[] = [];
  const seenWarnings = new Set<string>();
  const addWarning = (warning: ContextCaptureWarning) => {
    const key = `${warning.code}\0${warning.message_id ?? ""}\0${warning.message}`;
    if (seenWarnings.has(key)) {
      return;
    }
    seenWarnings.add(key);
    warnings.push(warning);
  };
  for (const warning of self?.warnings ?? []) {
    addWarning({ code: warning.code, message: warning.message });
  }
  for (const result of turnResults) {
    for (const warning of result.warnings) {
      addWarning({ code: warning.code, message: warning.message });
    }
    for (const turn of result.turns) {
      if (seenTurnIds.has(turn.turn_id)) {
        continue;
      }
      seenTurnIds.add(turn.turn_id);
      selectedTurns.push(turn);
    }
  }
  const turnMessageIds = new Set(selectedTurns.flatMap((turn) => turn.messages.map((message) => message.id)));
  for (const result of contextMessageResults) {
    for (const warning of result.warnings) {
      addWarning({ code: warning.code, message: warning.message });
    }
    for (const message of result.messages) {
      if (turnMessageIds.has(message.id) || seenContextMessageIds.has(message.id)) {
        continue;
      }
      seenContextMessageIds.add(message.id);
      selectedContextMessages.push(message);
    }
  }
  const allSelectedMessages = [
    ...selectedTurns.flatMap((turn) => turn.messages),
    ...selectedContextMessages,
  ];
  const truncatedMessageIds = Array.from(new Set(
    allSelectedMessages
      .filter((message) => message.truncated)
      .map((message) => message.id),
  ));
  for (const messageId of truncatedMessageIds) {
    addWarning({
      code: "message_text_truncated",
      message_id: messageId,
      message: `Selected message was truncated at ${maxTextChars} characters; re-run with a higher --max-text-chars if the full body is required.`,
    });
  }
  const sourceActivityId = source.activityId ?? turnResults[0]?.activity_id ?? contextMessageResults[0]?.activity_id ?? rawActivityId;
  const selectedTurnIds = selectedTurns.map((turn) => turn.turn_id);
  const selectedMessageIds = Array.from(new Set([
    ...selectedTurns.flatMap((turn) => turn.messages.map((message) => message.id)),
    ...selectedContextMessages.map((message) => message.id),
  ]));

  const notes = options.notesFile
    ? await readFile(resolvePath(options.notesFile), "utf8")
    : options.notes;
  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const body = renderContextCaptureMarkdown({
    title,
    sourceActivityId,
    ...(notes ? { notes } : {}),
    turns: selectedTurns,
    messages: selectedContextMessages,
    warnings,
    requestedMaxTextChars: maxTextChars,
    effectiveMaxTextChars: maxTextChars,
    truncatedMessageIds,
  });
  const estimatedBytes = Buffer.byteLength(body, "utf8");
  const applyCommand = buildContextCaptureApplyCommand(options);
  const author = options.author
    ?? (self ? `${self.backend}:${systemHostname().split(".")[0] || "unknown"}:${self.session_id.slice(0, 8)}` : undefined);
  const vaultResult = await putVaultArtifact({
    ...(options.type ? { type: options.type } : {}),
    daily: Boolean(options.daily),
    title,
    ...(options.issue ? { issue: options.issue } : {}),
    ...(options.project ? { project: options.project } : {}),
    ...(options.workstream ? { workstream: options.workstream } : {}),
    ...(author ? { author } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
    stdinText: body,
    inputFrontmatterOverride: {
      capture_version: "context.capture/v1",
      source_activity_id: sourceActivityId,
      ...(self ? {
        source_backend: self.backend,
        source_session_id: self.session_id,
        source_resolution: self.resolution_source,
      } : {}),
      source_turn_ids: selectedTurnIds,
      source_message_ids: selectedMessageIds,
      ...(selectedContextMessages.length > 0 ? { source_context_message_ids: selectedContextMessages.map((message) => message.id) } : {}),
      captured_at: generatedAt,
      selector_count: selectors.length,
      source_activity_selector: source.raw,
    },
    mergeInputFrontmatter: true,
    dryRun: mode === "plan",
  }, {
    ...(deps.createAdminClient ? { createAdminClient: deps.createAdminClient } : {}),
    ...(deps.now ? { now: deps.now() } : {}),
    hostnameImpl: () => systemHostname(),
  });

  const receiptPath = receiptPathForVaultOutput(vaultResult.outputPath);
  if (mode === "apply") {
    const receipt: ContextCaptureReceipt = {
      schema_version: "context.capture.receipt/v1",
      generated_at: generatedAt,
      source_activity_id: sourceActivityId,
      mode: "apply",
      output_path: vaultResult.outputPath,
      relative_path: vaultResult.relativePath,
      receipt_path: receiptPath,
      selected_turn_ids: selectedTurnIds,
      selected_message_ids: selectedMessageIds,
      requested_max_text_chars: maxTextChars,
      effective_max_text_chars: maxTextChars,
      truncated_message_ids: truncatedMessageIds,
      estimated_bytes: estimatedBytes,
      apply_command: applyCommand,
      warnings,
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  return {
    schema_version: "context.capture/v1",
    mode,
    dry_run: mode === "plan",
    source_activity_id: sourceActivityId,
    selected_turn_ids: selectedTurnIds,
    selected_message_ids: selectedMessageIds,
    requested_max_text_chars: maxTextChars,
    effective_max_text_chars: maxTextChars,
    truncated_message_ids: truncatedMessageIds,
    estimated_bytes: estimatedBytes,
    apply_command: applyCommand,
    vault: {
      output_path: vaultResult.outputPath,
      relative_path: vaultResult.relativePath,
      type: vaultResult.type,
      backlink: vaultResult.backlink,
    },
    ...(mode === "apply" ? { receipt_path: receiptPath } : {}),
    warnings,
  };
}

/**
 * Reject an unparseable activity locator at intake (POL-1825). Grammar is a
 * purely syntactic property, so an operator learns the id is malformed without
 * a daemon round trip, credentials, or a host guess — and gets exit 2 (invalid
 * argument) rather than exit 3 (not found) on every host.
 */
function requireActivityLocatorGrammar<T extends string | undefined>(activityId: T): T {
  if (!activityId) return activityId;
  const malformed = describeMalformedActivityLocator(activityId);
  if (malformed) {
    throw createCliError(formatMalformedActivityLocator(activityId, malformed), 2);
  }
  return activityId;
}

function mapActivityErrorToCli(error: unknown): never {
  if (error instanceof ActivityAttachmentClientError) {
    throw createCliError(error.message, error.exitCode);
  }
  if (error instanceof ActivityAttachmentError) {
    throw createCliError(`${error.code}: ${error.message}`, error.code === "attachment_ref_unknown" ? 3 : 6);
  }
  if (error instanceof ActivityRunMissingMetadataError) {
    throw createCliError(error.message, 6);
  }
  if (error instanceof ActivityIdAmbiguousError) {
    throw createCliError(error.message, 4);
  }
  if (error instanceof ActivityIdMalformedError) {
    throw createCliError(error.message, 2);
  }
  if (error instanceof ActivityIdNotFoundError) {
    throw createCliError(error.message, 3);
  }
  if (error instanceof ActivityMessageSelectorError) {
    throw createCliError(error.message, 2);
  }
  if (error instanceof ActivityTurnSelectorError) {
    throw createCliError(error.message, 2);
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(String(error));
}

async function inspectActivityMessagesCommand(
  options: ActivityMessagesCommandOptions,
  deps: RunCliDependencies,
  positionalActivityId?: string,
): Promise<ActivityMessagesResult> {
  // Validate the selector first so --role user fails loudly with the
  // corrective message regardless of which other args are missing.
  const selector = buildMessagesSelectorFromCli(options);
  const activityId = requireActivityLocatorGrammar(positionalActivityId?.trim() || undefined);
  if (!activityId && !options.latestSession) {
    throw createCliError(
      "Pass an activity id, Codex deeplink, short prefix, or --latest-session --backend <codex|claude>. See `calyx activity messages --help`.",
      2,
    );
  }
  const backend = parseActivityBackendOption(options.backend);
  if (options.latestSession && !backend) {
    throw createCliError("--latest-session requires --backend <codex|claude>.", 2);
  }

  const host = options.host?.trim();
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(remoteActivityAuthHint(), 2);
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const refusal = getDaemonCompatibilityRefusal(
      host ?? serverUrl,
      health,
      [CALYX_DAEMON_FEATURES.activityMessagesV1],
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    try {
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.messages({
        path: { activityId: activityId ?? "-" },
        query: {
          ...(options.latestSession ? { latest_session: "1" as const } : {}),
          ...(backend ? { backend } : {}),
          ...(selector.role ? { role: selector.role } : {}),
          ...(selector.visibility ? { visibility: selector.visibility } : {}),
          ...(typeof selector.first === "number" ? { first: String(selector.first) } : {}),
          ...(typeof selector.last === "number" ? { last: String(selector.last) } : {}),
          ...(selector.around_id ? { around_id: selector.around_id } : {}),
          ...(selector.around_text ? { around_text: selector.around_text } : {}),
          ...(typeof selector.context === "number" ? { context: String(selector.context) } : {}),
          ...(selector.grep ? { grep: selector.grep } : {}),
          ...(selector.summary_only ? { summary_only: "1" as const } : {}),
          ...(typeof selector.max_text_chars === "number" ? { max_text_chars: String(selector.max_text_chars) } : {}),
          ...(selector.explain_classification ? { explain_classification: "1" as const } : {}),
        },
      });
      return requireClientResult(result, "activity messages") as unknown as ActivityMessagesResult;
    } catch (error) {
      throw mapActivityErrorToCli(error);
    }
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectActivityMessages) {
    throw createCliError("Local RunService does not support `calyx activity messages`.", 6);
  }
  try {
    return await service.inspectActivityMessages({
      ...(activityId ? { activityId } : {}),
      ...(host ? { host } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(backend ? { latestSessionBackend: backend } : {}),
      selector,
    });
  } catch (error) {
    return mapActivityErrorToCli(error);
  }
}

async function inspectActivityEventsCommand(
  options: ActivityEventsCommandOptions,
  deps: RunCliDependencies,
  positionalActivityId?: string,
): Promise<ActivityEventsResult> {
  const selector = buildEventsSelectorFromCli(options);
  const activityId = requireActivityLocatorGrammar(positionalActivityId?.trim() || undefined);
  if (!activityId && !options.latestSession) {
    throw createCliError(
      "Pass an activity id, Codex deeplink, short prefix, or --latest-session --backend <codex|claude>. See `calyx activity events --help`.",
      2,
    );
  }
  const backend = parseActivityBackendOption(options.backend);
  if (options.latestSession && !backend) {
    throw createCliError("--latest-session requires --backend <codex|claude>.", 2);
  }

  const host = options.host?.trim();
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(remoteActivityAuthHint(), 2);
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const requiredFeatures = selector.within_turn
      ? [CALYX_DAEMON_FEATURES.activityMessagesV1, CALYX_DAEMON_FEATURES.activityTurnsV1]
      : [CALYX_DAEMON_FEATURES.activityMessagesV1];
    const refusal = getDaemonCompatibilityRefusal(host ?? serverUrl, health, requiredFeatures);
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    try {
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.events({
        path: { activityId: activityId ?? "-" },
        query: {
          ...(options.latestSession ? { latest_session: "1" as const } : {}),
          ...(backend ? { backend } : {}),
          ...(selector.raw_role ? { raw_role: selector.raw_role } : {}),
          ...(typeof selector.tail === "number" ? { tail: String(selector.tail) } : {}),
          ...(selector.around_id ? { around_id: selector.around_id } : {}),
          ...(typeof selector.context === "number" ? { context: String(selector.context) } : {}),
          ...(selector.classify ? { classify: "1" as const } : {}),
          ...(selector.within_turn ? { within_turn: "1" as const } : {}),
        },
      });
      return requireClientResult(result, "activity events") as unknown as ActivityEventsResult;
    } catch (error) {
      throw mapActivityErrorToCli(error);
    }
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectActivityEvents) {
    throw createCliError("Local RunService does not support `calyx activity events`.", 6);
  }
  try {
    return await service.inspectActivityEvents({
      ...(activityId ? { activityId } : {}),
      ...(host ? { host } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(backend ? { latestSessionBackend: backend } : {}),
      selector,
    });
  } catch (error) {
    return mapActivityErrorToCli(error);
  }
}

async function inspectActivityTurnsCommand(
  options: ActivityTurnsCommandOptions,
  deps: RunCliDependencies,
  positionalActivityId?: string,
): Promise<ActivityTurnsResult> {
  const selector = buildTurnsSelectorFromCli(options);
  const activityId = requireActivityLocatorGrammar(positionalActivityId?.trim() || undefined);
  if (!activityId && !options.latestSession) {
    throw createCliError(
      "Pass an activity id, Codex deeplink, short prefix, or --latest-session --backend <codex|claude>. See `calyx activity turns --help`.",
      2,
    );
  }
  const backend = parseActivityBackendOption(options.backend);
  if (options.latestSession && !backend) {
    throw createCliError("--latest-session requires --backend <codex|claude>.", 2);
  }

  const host = options.host?.trim();
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(remoteActivityAuthHint(), 2);
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const refusal = getDaemonCompatibilityRefusal(
      host ?? serverUrl,
      health,
      [CALYX_DAEMON_FEATURES.activityTurnsV1],
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    try {
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.turns({
        path: { activityId: activityId ?? "-" },
        query: {
          ...(options.latestSession ? { latest_session: "1" as const } : {}),
          ...(backend ? { backend } : {}),
          ...(selector.role ? { role: selector.role } : {}),
          ...(typeof selector.first === "number" ? { first: String(selector.first) } : {}),
          ...(typeof selector.last === "number" ? { last: String(selector.last) } : {}),
          ...(selector.with_tools ? { with_tools: "1" as const } : {}),
          ...(selector.summary_only ? { summary_only: "1" as const } : {}),
          ...(typeof selector.max_text_chars === "number" ? { max_text_chars: String(selector.max_text_chars) } : {}),
        },
      });
      return requireClientResult(result, "activity turns") as unknown as ActivityTurnsResult;
    } catch (error) {
      throw mapActivityErrorToCli(error);
    }
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectActivityTurns) {
    throw createCliError("Local RunService does not support `calyx activity turns`.", 6);
  }
  try {
    return await service.inspectActivityTurns({
      ...(activityId ? { activityId } : {}),
      ...(host ? { host } : {}),
      ...(options.latestSession ? { latestSession: true } : {}),
      ...(backend ? { latestSessionBackend: backend } : {}),
      selector,
    });
  } catch (error) {
    return mapActivityErrorToCli(error);
  }
}

const DEFAULT_ACTIVITY_OVERVIEW_SINCE_HOURS = 12;
const DEFAULT_ACTIVITY_OVERVIEW_LIMIT = 20;
const DEFAULT_ACTIVITY_OVERVIEW_MAX_TEXT_CHARS = 240;
const DEFAULT_ACTIVITY_OVERVIEW_MAX_MESSAGES = 4;

function ageSecondsFromIso(timestamp: string | undefined, now: Date): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(0, Math.round((now.getTime() - parsed) / 1000));
}

function truncateOverviewText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactActivityOverviewMessage(
  message: ActivityTurnsResult["turns"][number]["messages"][number],
  now: Date,
  maxTextChars: number,
): ActivityOverviewMessage {
  const sourceText = message.text ?? message.summary;
  const text = truncateOverviewText(sourceText, maxTextChars);
  const ageSeconds = ageSecondsFromIso(message.timestamp, now);
  return {
    id: message.id,
    role: message.role,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    ...(typeof ageSeconds === "number" ? { age_seconds: ageSeconds } : {}),
    text,
    ...(message.truncated || text.length < sourceText.replace(/\s+/g, " ").trim().length ? { truncated: true } : {}),
  };
}

function compactActivityOverviewTurn(
  turn: ActivityTurnsResult["turns"][number],
  now: Date,
  maxTextChars: number,
  maxMessages: number,
): ActivityOverviewTurn {
  const ageTimestamp = turn.ended_at ?? turn.started_at;
  const ageSeconds = ageSecondsFromIso(ageTimestamp, now);
  const messages = turn.messages.slice(Math.max(0, turn.messages.length - maxMessages));
  return {
    turn_id: turn.turn_id,
    index: turn.index,
    role: turn.role,
    state: turn.state,
    ...(turn.started_at ? { started_at: turn.started_at } : {}),
    ...(turn.ended_at ? { ended_at: turn.ended_at } : {}),
    ...(typeof ageSeconds === "number" ? { age_seconds: ageSeconds } : {}),
    total_message_count: turn.total_message_count,
    visible_message_count: turn.visible_message_count,
    returned_message_count: messages.length,
    omitted_message_count: Math.max(0, turn.messages.length - messages.length),
    tool_call_count: turn.tool_call_count,
    tool_result_count: turn.tool_result_count,
    summary: truncateOverviewText(turn.summary, maxTextChars),
    messages: messages.map((message) => compactActivityOverviewMessage(message, now, maxTextChars)),
  };
}

function formatAge(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "-";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

async function activityOverviewCommand(
  options: ActivityOverviewCommandOptions,
  deps: RunCliDependencies,
): Promise<ActivityOverviewResult> {
  const now = deps.now?.() ?? new Date();
  const agentKind = parseRunPsAgentKind(options.agentKind ?? "claude") ?? "all";
  const sinceMs = parseSinceHoursMs(options.sinceHours)
    ?? DEFAULT_ACTIVITY_OVERVIEW_SINCE_HOURS * 60 * 60 * 1000;
  const sinceHours = sinceMs / (60 * 60 * 1000);
  const limit = parsePositiveIntegerOption(options.limit, "--limit") ?? DEFAULT_ACTIVITY_OVERVIEW_LIMIT;
  const maxTextChars = parsePositiveIntegerOption(options.maxTextChars, "--max-text-chars")
    ?? DEFAULT_ACTIVITY_OVERVIEW_MAX_TEXT_CHARS;
  const maxMessages = parsePositiveIntegerOption(options.maxMessages, "--max-messages")
    ?? DEFAULT_ACTIVITY_OVERVIEW_MAX_MESSAGES;
  const turnRole = parseActivityTurnRoleOption(options.turnRole ?? "all") ?? "all";
  const entries = (await listRuns({
    ...options,
    includeInteractive: true,
    agentKind,
    sinceHours: String(sinceHours),
    limit: String(limit),
  }, deps)).filter(isInteractiveActivityEntry);

  const rows: ActivityOverviewRow[] = [];
  const warnings: ActivityOverviewWarning[] = [];
  const cutoff = now.getTime() - sinceMs;

  for (const entry of entries) {
    const updatedAgeSeconds = ageSecondsFromIso(entry.updated_at, now);
    const baseRow: ActivityOverviewRow = {
      activity_id: entry.run_id,
      backend: entry.backend,
      session_id: entry.session_id,
      ...(entry.host ? { host: entry.host } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.session_path ? { session_path: entry.session_path } : {}),
      updated_at: entry.updated_at,
      ...(typeof updatedAgeSeconds === "number" ? { updated_age_seconds: updatedAgeSeconds } : {}),
    };
    try {
      const turnResult = await inspectActivityTurnsCommand({
        ...options,
        role: turnRole,
        last: "1",
        maxTextChars: String(maxTextChars),
      }, deps, entry.run_id);
      const turn = turnResult.turns[0];
      if (!turn) {
        warnings.push({
          code: "turn_unavailable",
          activity_id: entry.run_id,
          message: "No projected turns matched this activity.",
        });
        rows.push(baseRow);
        continue;
      }
      const turnTime = Date.parse(turn.ended_at ?? turn.started_at ?? entry.updated_at);
      if (Number.isFinite(turnTime) && turnTime < cutoff) {
        warnings.push({
          code: "turn_outside_window",
          activity_id: entry.run_id,
          message: `Latest matching turn is older than --since-hours ${sinceHours}; showing the session without a turn preview.`,
        });
        rows.push(baseRow);
        continue;
      }
      rows.push({
        ...baseRow,
        turn: compactActivityOverviewTurn(turn, now, maxTextChars, maxMessages),
      });
    } catch (error) {
      warnings.push({
        code: "turn_unavailable",
        activity_id: entry.run_id,
        message: error instanceof Error ? error.message : String(error),
      });
      rows.push(baseRow);
    }
  }

  return {
    schema_version: "activity.overview/v1",
    generated_at: now.toISOString(),
    ...(options.host?.trim() ? { host: options.host.trim() } : {}),
    filters: {
      agent_kind: agentKind,
      since_hours: sinceHours,
      limit,
      turn_role: turnRole,
      max_text_chars: maxTextChars,
      max_messages: maxMessages,
    },
    scanned_activities: entries.length,
    returned_activities: rows.length,
    skipped_activities: rows.filter((row) => !row.turn).length,
    warnings,
    rows,
  };
}

function formatActivityOverviewText(result: ActivityOverviewResult): string {
  const lines = [
    `# activity_overview generated=${result.generated_at} agent_kind=${result.filters.agent_kind} since_hours=${result.filters.since_hours} returned=${result.returned_activities}/${result.scanned_activities}`,
  ];
  for (const warning of result.warnings) {
    lines.push(`# warning: ${warning.activity_id ?? "-"} ${warning.code}: ${warning.message}`);
  }
  for (const row of result.rows) {
    const turn = row.turn;
    lines.push([
      row.activity_id,
      row.backend,
      row.host ?? "-",
      `updated=${formatAge(row.updated_age_seconds)}`,
      turn ? `turn=${turn.role}/${turn.state}` : "turn=-",
      turn ? `turn_age=${formatAge(turn.age_seconds)}` : "turn_age=-",
      turn ? `messages=${turn.returned_message_count}/${turn.visible_message_count}` : "messages=-",
      row.cwd ?? "-",
    ].join("\t"));
    if (!turn) {
      continue;
    }
    for (const message of turn.messages) {
      lines.push(`  ${message.role}\t${formatAge(message.age_seconds)}\t${message.text}`);
    }
  }
  return lines.join("\n");
}

async function inspectActivityTextCommand(
  options: ActivityTextCommandOptions,
  deps: RunCliDependencies,
  positionalMessageId?: string,
): Promise<ActivityTextResult> {
  const selector = buildTextSelectorFromCli(options);
  const messageId = positionalMessageId?.trim();
  if (!messageId) {
    throw createCliError("Pass a message id returned by `calyx activity messages`.", 2);
  }

  const host = options.host?.trim();
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(remoteActivityAuthHint(), 2);
    }
    const { serverUrl, token } = access;
    const health = await remoteAdminHealth(deps, { serverUrl, token });
    const refusal = getDaemonCompatibilityRefusal(
      host ?? serverUrl,
      health,
      [CALYX_DAEMON_FEATURES.activityTextV1],
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    try {
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.text({
        path: { messageId },
        query: {
          ...(selector.range ? { range: selector.range } : {}),
          ...(typeof selector.from === "number" ? { from: String(selector.from) } : {}),
          ...(selector.classifier_version ? { classifier_version: selector.classifier_version } : {}),
        },
      });
      return requireClientResult(result, "activity text") as unknown as ActivityTextResult;
    } catch (error) {
      throw mapActivityErrorToCli(error);
    }
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectActivityText) {
    throw createCliError("Local RunService does not support `calyx activity text`.", 6);
  }
  try {
    return await service.inspectActivityText({
      messageId,
      ...(host ? { host } : {}),
      selector,
    });
  } catch (error) {
    return mapActivityErrorToCli(error);
  }
}

async function inspectActivityAttachmentsCommand(
  options: ActivityAttachmentsCommandOptions,
  deps: RunCliDependencies,
  positionalActivityId?: string,
): Promise<ActivityAttachmentsResult> {
  const selector = buildAttachmentsSelectorFromCli(options);
  const activityId = requireActivityLocatorGrammar(positionalActivityId?.trim());
  if (!activityId) {
    throw createCliError("Pass an activity id returned by `calyx activity list` or `calyx activity messages`.", 2);
  }

  const host = options.host?.trim();
  const useRemote = Boolean(options.serverUrl?.trim()) || Boolean(host && !isLocalRunTarget(host, { hostname: () => systemHostname() }));

  if (useRemote) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(remoteActivityAuthHint(), 2);
    }
    const { serverUrl, token } = access;
    let health: CalyxDaemonHealth;
    try {
      health = await remoteAdminHealth(deps, { serverUrl, token });
    } catch (error) {
      if (selector.extract && selector.ref && host && isActivityOwnerUnreachableError(error)) {
        try {
          return await pullThroughArchiveActivityAttachmentResult({
            activityId,
            ref: selector.ref,
            outDir: selector.out_dir?.trim() || defaultAttachmentCacheDir(),
            originHost: host,
            deps,
          });
        } catch (archiveError) {
          if (archiveError instanceof Error && archiveError.message.includes("attachment_archive_unavailable")) {
            throw createCliError(`${(error as Error).message}; ${archiveError.message}`, 6);
          }
          throw archiveError;
        }
      }
      if (selector.extract && isActivityOwnerUnreachableError(error)) {
        throw createCliError(
          `${(error as Error).message}; attachment_archive_unavailable: POL-1041 archive fallback requires an explicit --host and --ref in this first slice.`,
          6,
        );
      }
      throw error;
    }
    const refusal = getDaemonCompatibilityRefusal(
      host ?? serverUrl,
      health,
      selector.extract
        ? [CALYX_DAEMON_FEATURES.activityAttachmentsV1, CALYX_DAEMON_FEATURES.activityAttachmentBytesV1]
        : [CALYX_DAEMON_FEATURES.activityAttachmentsV1],
    );
    if (refusal) {
      throw createCliError(refusal.message, 6);
    }
    try {
      const listSelector: ActivityAttachmentsSelectorInput = {
        ...(typeof selector.turn === "number" ? { turn: selector.turn } : {}),
        ...(selector.message_id ? { message_id: selector.message_id } : {}),
        ...(selector.ref ? { ref: selector.ref } : {}),
      };
      const inventorySelector = selector.extract ? listSelector : selector;
      const result = await remoteAdminClient(deps, { serverUrl, token }).admin.activity.attachments({
        path: { activityId },
        query: {
          ...(typeof inventorySelector.turn === "number" ? { turn: String(inventorySelector.turn) } : {}),
          ...(inventorySelector.message_id ? { message: inventorySelector.message_id } : {}),
          ...(inventorySelector.extract ? { extract: "1" as const } : {}),
          ...(inventorySelector.ref ? { ref: inventorySelector.ref } : {}),
          ...(inventorySelector.out_dir ? { out: inventorySelector.out_dir } : {}),
        },
      });
      const remoteInventory = requireClientResult(result, "activity attachments") as unknown as ActivityAttachmentsResult;
      if (!selector.extract) {
        return remoteInventory;
      }
      const outDir = selector.out_dir?.trim() || defaultAttachmentCacheDir();
      const refs = new Set(remoteInventory.attachments.map((attachment) => attachment.ref));
      if (selector.ref && refs.size === 0) {
        refs.add(selector.ref);
      }
      const pulledByRef = new Map<string, ActivityAttachmentRecord>();
      for (const ref of refs) {
        try {
          pulledByRef.set(ref, await materializeRemoteActivityAttachment({
            serverUrl,
            token,
            activityId,
            ref,
            outDir,
            remoteLabel: host ?? serverUrl,
            deps,
          }));
        } catch (error) {
          if (host && selector.ref && isActivityOwnerUnreachableError(error)) {
            let archiveResult: ActivityAttachmentsResult;
            try {
              archiveResult = await pullThroughArchiveActivityAttachmentResult({
                activityId,
                ref,
                outDir,
                originHost: host,
                deps,
              });
            } catch (archiveError) {
              if (archiveError instanceof Error && archiveError.message.includes("attachment_archive_unavailable")) {
                throw createCliError(`${(error as Error).message}; ${archiveError.message}`, 6);
              }
              throw archiveError;
            }
            const archiveRecord = archiveResult.attachments.find((attachment) => attachment.ref === ref);
            if (archiveRecord) {
              pulledByRef.set(ref, archiveRecord);
              continue;
            }
          }
          throw error;
        }
      }
      return {
        ...remoteInventory,
        attachments: remoteInventory.attachments.map((attachment) => {
          const pulled = pulledByRef.get(attachment.ref);
          return pulled
	            ? {
	              ...attachment,
	              ...(pulled.extracted_path ? { extracted_path: pulled.extracted_path } : {}),
	              ...(pulled.provenance_path ? { provenance_path: pulled.provenance_path } : {}),
	              ...(pulled.cache_status ? { cache_status: pulled.cache_status } : {}),
	              ...(pulled.origin_host ? { origin_host: pulled.origin_host } : {}),
	              ...(pulled.served_by_host ? { served_by_host: pulled.served_by_host } : {}),
	              ...(pulled.source_tier ? { source_tier: pulled.source_tier } : {}),
	            }
            : attachment;
        }),
      };
    } catch (error) {
      if (selector.extract && isActivityOwnerUnreachableError(error)) {
        throw createCliError(
          `${(error as Error).message}; attachment_archive_unavailable: POL-1041 archive fallback requires an explicit --host and --ref in this first slice.`,
          6,
        );
      }
      throw mapActivityErrorToCli(error);
    }
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.inspectActivityAttachments) {
    throw createCliError("Local RunService does not support `calyx activity attachments`.", 6);
  }
  try {
    return await service.inspectActivityAttachments({
      activityId,
      ...(host ? { host } : {}),
      selector,
    });
  } catch (error) {
    return mapActivityErrorToCli(error);
  }
}

function formatRecallFreshnessLine(
  freshness: ActivityMessagesResult["recall_freshness"],
): string | undefined {
  if (!freshness) return undefined;
  const parts = [
    `store=${freshness.store_state}`,
    `pending_bytes=${freshness.pending_bytes}`,
    `stored_messages=${freshness.store_message_count}`,
  ];
  if (freshness.indexed_through) parts.push(`indexed_through=${freshness.indexed_through}`);
  if (!freshness.classifier_current) parts.push(`classifier=${freshness.classifier_version}(stale)`);
  return `# recall_freshness: ${parts.join(" ")}`;
}

function formatActivityMessagesText(result: ActivityMessagesResult): string {
  const lines: string[] = [
    `${result.activity_id}\t${result.backend}\t${result.cwd ?? "-"}\t${result.session_path}`,
    `# total_messages=${result.total_messages} matched=${result.matched_messages} returned=${result.returned_messages} truncated=${result.truncated} source_state=${result.source_state}`,
  ];
  const freshnessLine = formatRecallFreshnessLine(result.recall_freshness);
  if (freshnessLine) lines.push(freshnessLine);
  for (const warning of result.warnings) {
    lines.push(`# warning: ${warning.code}: ${warning.message}`);
  }
  for (const message of result.messages) {
    const ts = message.timestamp ?? "-";
    lines.push(`${message.id}\t${ts}\t${message.role}\t${message.visibility}\t${message.summary}`);
  }
  return lines.join("\n");
}

function formatActivityEventsText(result: ActivityEventsResult): string {
  const lines: string[] = [
    `${result.activity_id}\t${result.backend}\t${result.cwd ?? "-"}\t${result.session_path}`,
    `# total_events=${result.total_events} matched=${result.matched_events} returned=${result.returned_events} truncated=${result.truncated} source_state=${result.source_state}`,
  ];
  for (const warning of result.warnings) {
    lines.push(`# warning: ${warning.code}: ${warning.message}`);
  }
  for (const event of result.events) {
    const ts = event.timestamp ?? "-";
    const proj = event.classification ? `\t${event.classification.projected_role}` : "";
    lines.push(`${event.line}\t${ts}\t${event.role}\t${event.kind}${proj}\t${event.summary}`);
  }
  return lines.join("\n");
}

function formatActivityTurnsText(result: ActivityTurnsResult): string {
  const lines: string[] = [
    `${result.activity_id}\t${result.backend}\t${result.cwd ?? "-"}\t${result.session_path}`,
    `# total_turns=${result.total_turns} matched=${result.matched_turns} returned=${result.returned_turns} truncated=${result.truncated} source_state=${result.source_state}`,
  ];
  const freshnessLine = formatRecallFreshnessLine(result.recall_freshness);
  if (freshnessLine) lines.push(freshnessLine);
  for (const warning of result.warnings) {
    lines.push(`# warning: ${warning.code}: ${warning.message}`);
  }
  for (const turn of result.turns) {
    const startedAt = turn.started_at ?? "-";
    const tools = `tools=${turn.tool_call_count}/${turn.tool_result_count}`;
    lines.push(`${turn.turn_id}\t${startedAt}\t${turn.role}\t${turn.state}\t${tools}\t${turn.summary}`);
    for (const message of turn.messages) {
      const ts = message.timestamp ?? "-";
      lines.push(`  ${message.id}\t${ts}\t${message.role}\t${message.visibility}\t${message.summary}`);
    }
  }
  return lines.join("\n");
}

function formatActivityTextText(result: ActivityTextResult): string {
  const ranges = result.text_cursor.returned.map(([start, end]) => `${start}:${end}`).join(",");
  return [
    `${result.message_id}\t${result.backend}\tline=${result.source_line}\trange=${ranges}\ttotal_chars=${result.text_cursor.total_chars}`,
    result.text,
  ].join("\n");
}

function formatActivityAttachmentsText(result: ActivityAttachmentsResult): string {
  const lines = [
    `${result.activity_id}\t${result.backend}\t${result.session_path}`,
    `# images=${result.rollup.images} bytes=${result.rollup.bytes} refs=${result.rollup.refs.length}`,
  ];
  for (const attachment of result.attachments) {
    lines.push([
      attachment.ref,
      attachment.mime_type,
      `${attachment.byte_size}B`,
      attachment.source_shape,
      `line=${attachment.source_line}`,
      `message=${attachment.message_id}`,
      attachment.extracted_path ? `path=${attachment.extracted_path}` : undefined,
    ].filter((part): part is string => typeof part === "string").join("\t"));
  }
  return lines.join("\n");
}

void formatActivityMessagesText;
void formatActivityEventsText;
void formatActivityTurnsText;
void formatActivityTextText;
void formatActivityAttachmentsText;
void ACTIVITY_MESSAGE_ROLES;
void ACTIVITY_VISIBILITY_TIERS;
void ACTIVITY_TURN_ROLE_FILTERS;

async function readRunLogs(
  options: { runId: string; host?: string; runsRoot?: string; serverUrl?: string; authToken?: string; tail?: string },
  deps: RunCliDependencies,
): Promise<RunLogResult> {
  const remote = await resolveRemoteRunServerAccess(options, deps, "queries");
  const tail = options.tail ? parsePositiveInteger(options.tail, "--tail") : undefined;
  if (remote) {
    const result = await remoteAdminClient(deps, remote).admin.run.logs({
      path: { runId: options.runId },
      ...(typeof tail === "number" ? { query: { tail: String(tail) } } : {}),
    });
    return requireClientResult(result, `run ${options.runId} logs`) as unknown as RunLogResult;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.readLogs) {
    throw createCliError("calyx run logs requires a RunService with readLogs support.", 6);
  }
  return service.readLogs(options.runId, {
    ...(typeof tail === "number" ? { tail } : {}),
  });
}

async function readRunObservation(
  options: { runId: string; host?: string; runsRoot?: string; serverUrl?: string; authToken?: string; tail?: string },
  deps: RunCliDependencies,
): Promise<RunObservationResult> {
  const remote = await resolveRemoteRunServerAccess(options, deps, "queries");
  const tail = options.tail ? parsePositiveInteger(options.tail, "--tail") : undefined;
  if (remote) {
    const result = await remoteAdminClient(deps, remote).admin.run.observation({
      path: { runId: options.runId },
      ...(typeof tail === "number" ? { query: { tail: String(tail) } } : {}),
    });
    return requireClientResult(result, `run ${options.runId} observation`) as unknown as RunObservationResult;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.observeRun) {
    throw createCliError("calyx run doctor requires a RunService with observeRun support.", 6);
  }
  return service.observeRun(options.runId, {
    ...(typeof tail === "number" ? { tail } : {}),
  });
}

function sortRunLogEntries(entries: RunLogEntry[]): RunLogEntry[] {
  return entries.slice().sort((left, right) => {
    const byTimestamp = (left.timestamp ?? "").localeCompare(right.timestamp ?? "");
    if (byTimestamp !== 0) return byTimestamp;
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    if (left.source !== right.source) return left.source.localeCompare(right.source);
    if ((left.stream ?? "") !== (right.stream ?? "")) return (left.stream ?? "").localeCompare(right.stream ?? "");
    return (left.line ?? 0) - (right.line ?? 0);
  });
}

function formatRunLogEntryText(entry: RunLogEntry): string {
  const timestamp = entry.timestamp ?? "-";
  if (entry.kind === "stream_line") {
    const line = typeof entry.line === "number" ? `:${entry.line}` : "";
    const stream = entry.stream ?? "stdout";
    return `[${timestamp}] [${entry.source}:${stream}${line}] ${entry.text}`;
  }
  const prefix = entry.kind === "agent_message" ? "agent" : "lifecycle";
  return `[${timestamp}] [${prefix}] ${entry.text}`;
}

function formatByteCount(bytes: number | undefined): string {
  if (typeof bytes !== "number") return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

function formatRunObservationText(result: RunObservationResult, handle: ResolvedRunHandle): string {
  const headline = [
    handle.shortId,
    result.run.state ?? "unknown",
    result.run.health?.status ? `health=${result.run.health.status}` : undefined,
    `process=${result.process.status}${typeof result.process.pid === "number" ? `:${result.process.pid}` : ""}`,
    result.run.host ? `host=${result.run.host}` : undefined,
    result.run.issue ? `issue=${result.run.issue}` : undefined,
    result.run.updated_at ? `updated=${result.run.updated_at}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" ");
  const lines = [headline];
  lines.push(`  run_dir: ${result.paths.run_dir}`);
  if (result.paths.worktree_path) {
    lines.push(`  worktree: ${result.paths.worktree_path}`);
  }

  if (result.logs.sources.length > 0) {
    lines.push("  logs:");
    for (const source of result.logs.sources) {
      const stream = source.stream ? `:${source.stream}` : "";
      const status = source.exists ? "present" : "missing";
      const size = source.exists ? ` size=${formatByteCount(source.file_size_bytes)}` : "";
      const modified = source.latest_modified_at ? ` mtime=${source.latest_modified_at}` : "";
      lines.push(`    ${source.source}${stream} ${status}${size}${modified}`);
    }
  } else {
    lines.push("  logs: no source summaries available");
  }

  const artifactCounts = result.artifacts.reduce(
    (counts, artifact) => {
      counts[artifact.status] += 1;
      return counts;
    },
    { present: 0, missing: 0, unknown: 0 } satisfies Record<"present" | "missing" | "unknown", number>,
  );
  lines.push(`  artifacts: present=${artifactCounts.present} missing=${artifactCounts.missing} unknown=${artifactCounts.unknown}`);
  for (const artifact of result.artifacts.filter((item) => item.required || item.status !== "present")) {
    const requirement = artifact.required ? "required" : "optional";
    const artifactPath = artifact.path ? ` ${artifact.path}` : "";
    lines.push(`    ${artifact.status}\t${requirement}\t${artifact.name}${artifactPath}`);
  }
  const artifactRoots = result.artifact_roots ?? [];
  if (artifactRoots.length > 0) {
    lines.push("  artifact_roots:");
    for (const root of artifactRoots) {
      const rootPath = root.path ? ` ${root.path}` : "";
      const counts = root.status === "present"
        ? ` files=${root.file_count ?? 0} dirs=${root.directory_count ?? 0} size=${formatByteCount(root.total_size_bytes)}`
        : "";
      const modified = root.latest_modified_at ? ` mtime=${root.latest_modified_at}` : "";
      const truncated = root.truncated ? ` truncated=${root.max_entries ?? "yes"}` : "";
      lines.push(`    ${root.status}\t${root.name}${rootPath}${counts}${modified}${truncated}`);
    }
  }

  const attribution = result.resource_attribution;
  if (attribution) {
    const processTree = attribution.process_tree;
    const gpuProcesses = attribution.gpu_processes;
    const processCount = processTree.process_count ?? processTree.processes.length;
    const cpu = typeof processTree.total_cpu_percent === "number"
      ? ` cpu=${processTree.total_cpu_percent}%`
      : "";
    const rss = typeof processTree.total_rss_kib === "number"
      ? ` rss=${formatByteCount(processTree.total_rss_kib * 1024)}`
      : "";
    const attributedGpuCount = gpuProcesses.attributed_process_count ?? gpuProcesses.processes.length;
    const hostGpuCount = gpuProcesses.host_process_count ?? attributedGpuCount;
    const gpuMemory = typeof gpuProcesses.attributed_memory_used_mib === "number"
      ? ` gpu_mem=${formatByteCount(gpuProcesses.attributed_memory_used_mib * 1024 * 1024)}`
      : "";
    lines.push(
      `  resources: ${attribution.status} processes=${processCount}${cpu}${rss} `
      + `gpu_processes=${attributedGpuCount}/${hostGpuCount}${gpuMemory}`,
    );
    if (processTree.message) {
      lines.push(`    process_tree: ${processTree.status} (${processTree.message})`);
    }
    if (gpuProcesses.status !== "attributed" && gpuProcesses.status !== "none") {
      const message = gpuProcesses.message ? ` (${gpuProcesses.message})` : "";
      lines.push(`    gpu_processes: ${gpuProcesses.status}${message}`);
    }
  } else {
    lines.push("  resources: unavailable (daemon omitted run.resource_attribution/v1 payload)");
  }

  const gpu = result.host_resources.gpu;
  if (gpu.status === "available") {
    const devices = gpu.gpus.map((device) => {
      const utilization = typeof device.utilization_gpu_percent === "number"
        ? `${device.utilization_gpu_percent}%`
        : "util=?";
      const memory = typeof device.memory_used_mib === "number" && typeof device.memory_total_mib === "number"
        ? `${device.memory_used_mib}/${device.memory_total_mib}MiB`
        : "mem=?";
      return `gpu${device.index} ${device.name} ${utilization} ${memory}`;
    });
    lines.push(`  gpu: ${devices.join("; ")}`);
  } else {
    lines.push(`  gpu: ${gpu.status} (${gpu.message ?? gpu.provider})`);
  }

  for (const warning of result.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

async function readKernelReceipt(
  options: { runId: string; host?: string; runsRoot?: string; serverUrl?: string; authToken?: string },
  deps: RunCliDependencies,
): Promise<RunRecord["kernel_receipt"]> {
  const remote = await resolveRemoteRunServerAccess(options, deps, "queries");
  if (remote) {
    const result = await remoteAdminClient(deps, remote).admin.run.receipt({
      path: { runId: options.runId },
    });
    return requireClientResult(result, `run ${options.runId} receipt`) as unknown as RunRecord["kernel_receipt"];
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  return service.getKernelReceipt(options.runId);
}

async function stopRun(
  options: { runId: string; host?: string; runsRoot?: string; serverUrl?: string; authToken?: string },
  deps: RunCliDependencies,
): Promise<RunCancellationResult> {
  const remote = await resolveRemoteRunServerAccess(options, deps, "commands");
  if (remote) {
    const result = await remoteAdminClient(deps, remote).admin.run.stop({
      path: { runId: options.runId },
      body: {},
    });
    return requireClientResult(
      result,
      `stop run ${options.runId}`,
      exactEndpointReconciliationCommand(
        ["calyx", "run", "status", options.runId],
        remote.serverUrl,
      ),
    ) as unknown as RunCancellationResult;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  return service.stop(options.runId);
}

async function auditRunTerminalAuthority(
  options: RunTerminalAuthorityAuditCommandOptions,
  deps: RunCliDependencies,
): Promise<InfraErrorCensusAuthorityAudit> {
  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  if (!service.auditTerminalAuthority) {
    throw createCliError(
      "calyx run audit-terminal-authority requires a RunService with read-only authority audit support.",
      6,
    );
  }
  try {
    return await service.auditTerminalAuthority();
  } catch (error) {
    throw createCliError(
      `calyx run audit-terminal-authority could not inspect the existing authority: ${error instanceof Error ? error.message : String(error)}`,
      6,
    );
  }
}

function formatRunTerminalAuthorityAudit(result: InfraErrorCensusAuthorityAudit): string {
  const lines = [
    `source=${result.authority_source}`
      + ` authoritative=${String(result.authoritative)}`
      + ` terminal_events=${result.terminal_event_count}`
      + ` legacy_events=${result.legacy_event_count}`
      + ` legacy_roots=${result.legacy_root_count}`
      + ` uuid_incarnations=${result.uuid_incarnation_count}`
      + ` ambiguities=${result.ambiguity_count}`
      + ` truncated=${String(result.truncated)}`,
  ];
  for (const root of result.legacy_roots) {
    lines.push(
      `legacy_root=${root.root_event_id}`
      + ` leaves=${root.leaf_event_ids.join(",")}`
      + ` events=${root.event_count}`,
    );
  }
  for (const ambiguity of result.ambiguities) {
    lines.push(`ambiguity=${ambiguity.code} events=${ambiguity.event_ids.join(",")}`);
  }
  return lines.join("\n");
}

async function reconcileRuns(
  options: { runsRoot?: string; host?: string; serverUrl?: string; authToken?: string },
  deps: RunCliDependencies,
): Promise<CalyxAdminReconcileResult> {
  const host = options.host?.trim();
  if (options.serverUrl?.trim() || host) {
    const access = await resolveRunServerAccess({
      ...(host ? { host } : {}),
      serverUrl: options.serverUrl,
      authToken: options.authToken,
    }, deps);
    if (!access.token) {
      throw createCliError(
        host
          ? `Remote run commands require --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`
          : "Remote run reconcile with --server-url requires --host for named credential resolution, or an explicit --auth-token.",
        2
      );
    }
    const target = host || "remote";
    const health = await remoteAdminHealth(
      deps,
      { serverUrl: access.serverUrl, token: access.token },
      "run reconcile preservation capability preflight",
    );
    const refusal = getDaemonCompatibilityRefusal(
      target,
      health,
      [CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1],
    );
    if (refusal) {
      throw createCliError(
        `Remote run reconcile refused before mutation: ${refusal.message}`,
        6,
      );
    }
    const result = await remoteAdminClient(deps, {
      serverUrl: access.serverUrl,
      token: access.token,
    }).admin.run.reconcilePreserving();
    return requireClientResult(result, "run reconcile preserving") as unknown as CalyxAdminReconcileResult;
  }

  const service = createLocalRunService(deps, buildLocalRunServiceOptions({
    runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
    defaultWorktreeBase: defaultRunWorktreeBase(),
  }));
  return toCalyxAdminReconcileResult(await service.reconcile());
}

export function isRunReconciliationIncomplete(
  result: CalyxAdminReconcileResult,
): boolean {
  return result.status !== "completed"
    || result.projection.status === "failed"
    || result.changed.repair_pending > 0
    || result.changed.unresolved > 0
    || result.unresolved.length > 0
    || result.changed.noncanonical_directories > 0;
}

function deriveRunRecordExitCode(record: RunRecord): number {
  const receiptExitCode = record.kernel_receipt?.exit.exit_code;
  if (typeof receiptExitCode === "number") {
    return receiptExitCode;
  }

  switch (record.state) {
    case "succeeded":
    case "completed_dirty":
      return 0;
    case "partial":
      return 2; // Distinct exit code for partial — not 0 (success) or 1 (failure)
    case "failed":
    case "cancelled":
      return 1;
    case "auth_error":
      return 8;
    case "infra_error":
      return 6;
    default:
      return 0;
  }
}

function readSpawnError(receipt: RunRecord["kernel_receipt"] | undefined): string | undefined {
  if (!receipt || !("spawn_error" in receipt)) {
    return undefined;
  }
  return typeof receipt.spawn_error === "string" && receipt.spawn_error.length > 0
    ? receipt.spawn_error
    : undefined;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

/** Extract partial_reason from a kernel receipt, if present. */
function extractPartialReason(
  kernelReceipt: RunRecord["kernel_receipt"] | undefined,
): PartialReason | undefined {
  if (!kernelReceipt) return undefined;
  const exit = kernelReceipt.exit as { partial_reason?: string } | undefined;
  switch (exit?.partial_reason) {
    case "budget_exhaustion":
    case "context_limit":
    case "max_turns":
    case "graceful_stop":
    case "operator_stop":
    case "unknown":
      return exit.partial_reason;
    default:
      return undefined;
  }
}

/** Format a human-friendly state display string. */
function formatRunStateDisplay(
  state: RunRecord["state"],
  kernelReceipt: RunRecord["kernel_receipt"] | undefined,
): string {
  if (state !== "partial") return state;
  const reason = extractPartialReason(kernelReceipt);
  return reason ? `partial (${reason})` : "partial";
}

/** Return a human-friendly message for partial runs, or undefined for other states. */
function formatPartialMessage(
  state: RunRecord["state"],
  kernelReceipt: RunRecord["kernel_receipt"] | undefined,
): string | undefined {
  if (state !== "partial") return undefined;
  const reason = extractPartialReason(kernelReceipt);

  switch (reason) {
    case "budget_exhaustion":
      return "Run completed partially (budget exhaustion). Review the terminal message.";
    case "context_limit":
      return "Run completed partially (context limit). Review the terminal message.";
    case "max_turns":
      return "Run completed partially (max turns reached). Review the terminal message.";
    case "graceful_stop":
      return "Run stopped gracefully with partial results.";
    case "operator_stop":
      return "Run stopped by operator. Partial results may be available.";
    case "unknown":
    default:
      return "Run exited with partial results. Reason unknown.";
  }
}

function computeHealthAgeMs(lastProgressAt: string | undefined): number | undefined {
  if (!lastProgressAt) {
    return undefined;
  }
  const parsed = new Date(lastProgressAt).getTime();
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(0, Date.now() - parsed);
}

function parseSkillsBackend(rawValue: string): SyncBackend {
  const value = rawValue.trim().toLowerCase();
  if (value === "claude" || value === "codex" || value === "agents" || value === "all") {
    return value;
  }

  throw createCliError(`Invalid --backend value for skills sync: ${rawValue}`, 2);
}

function parseSkillProposalTarget(rawValue: string): SkillProposalTarget {
  const value = rawValue.trim().toLowerCase();
  if (SKILL_PROPOSAL_TARGETS.includes(value as SkillProposalTarget)) {
    return value as SkillProposalTarget;
  }
  throw createCliError(
    `Invalid --target "${rawValue}". Valid: ${SKILL_PROPOSAL_TARGETS.join(", ")}.`,
    2,
  );
}

function parseSkillProposalStatus(rawValue: string): SkillProposalStatus {
  const value = rawValue.trim().toLowerCase();
  if (SKILL_PROPOSAL_STATUSES.includes(value as SkillProposalStatus)) {
    return value as SkillProposalStatus;
  }
  throw createCliError(
    `Invalid --status "${rawValue}". Valid: ${SKILL_PROPOSAL_STATUSES.join(", ")}.`,
    2,
  );
}

function parseReviewDecision(rawValue: string): "accepted" | "rejected" | "superseded" {
  const value = rawValue.trim().toLowerCase();
  if (value === "accepted" || value === "rejected" || value === "superseded") {
    return value;
  }
  throw createCliError(
    `Invalid --status "${rawValue}" for review. Valid: accepted, rejected, superseded.`,
    2,
  );
}

async function readStdinAllowOptional(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf8");
}

interface SkillsProposeBodyOptions {
  bodyFile?: string;
  contentFile?: string;
  diffFile?: string;
  content?: string;
  diff?: string;
  stdin?: boolean;
}

async function readSkillsProposeBody(
  field: "content" | "diff",
  options: SkillsProposeBodyOptions,
): Promise<string | undefined> {
  // Priority: explicit --content/--diff string > --*-file > --body-file > --stdin.
  if (field === "content" && options.content !== undefined) return options.content;
  if (field === "diff" && options.diff !== undefined) return options.diff;
  const file =
    field === "content"
      ? (options.contentFile ?? options.bodyFile)
      : (options.diffFile ?? options.bodyFile);
  if (file) {
    return await readFile(file, "utf8");
  }
  if (options.stdin) {
    const raw = await readStdinAllowOptional();
    if (raw === null) {
      throw createCliError(
        `--stdin was requested but no stdin payload was supplied for ${field}.`,
        2,
      );
    }
    return raw;
  }
  return undefined;
}

function parsePromptsBackend(rawValue: string): PromptBackend {
  const value = rawValue.trim().toLowerCase();
  if (value === "claude" || value === "codex" || value === "all") {
    return value;
  }

  throw createCliError(`Invalid --backend value for prompts sync: ${rawValue}`, 2);
}

/**
 * Host id for agent-owned skill_content rows: the local host alias
 * (hostname with the domain suffix stripped, lowercased). Matches the
 * convention used by monitor/lease host columns.
 */
function skillContentHostId(): string {
  return systemHostname().split(".")[0]?.toLowerCase() ?? systemHostname().toLowerCase();
}

interface SkillsWriteOptions {
  content?: string;
  contentFile?: string;
  payloadFile?: string;
  summary?: string;
  author?: string;
  fromActivity?: string;
  fromMessage?: string;
  gatePolicy?: string;
  json?: boolean;
}

/**
 * Assemble the full-document payload map for `calyx skills write`. Exactly one
 * of --content / --content-file / --payload-file must be supplied. The
 * single-file forms produce `{ "SKILL.md": <text> }`; --payload-file reads a
 * JSON object of relpath -> string content (which must include SKILL.md).
 */
async function assembleSkillWritePayload(options: SkillsWriteOptions): Promise<Record<string, string>> {
  const sources = [
    options.content !== undefined ? "--content" : null,
    options.contentFile ? "--content-file" : null,
    options.payloadFile ? "--payload-file" : null,
  ].filter(Boolean);
  if (sources.length === 0) {
    throw createCliError(
      "calyx skills write requires one of --content, --content-file, or --payload-file.",
      2,
    );
  }
  if (sources.length > 1) {
    throw createCliError(
      `calyx skills write accepts only one content source; got ${sources.join(", ")}.`,
      2,
    );
  }

  if (options.payloadFile) {
    const raw = await readFile(options.payloadFile, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw createCliError(`--payload-file is not valid JSON: ${message}`, 2);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw createCliError("--payload-file must be a JSON object mapping relpath -> content.", 2);
    }
    const payload: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw createCliError(`--payload-file value for "${key}" must be a string.`, 2);
      }
      if (key.startsWith("/") || key.split("/").includes("..")) {
        throw createCliError(`--payload-file key "${key}" must be a relative path with no '..' segments.`, 2);
      }
      payload[key] = value;
    }
    if (typeof payload["SKILL.md"] !== "string" || payload["SKILL.md"].length === 0) {
      throw createCliError("--payload-file must include a non-empty SKILL.md entry.", 2);
    }
    return payload;
  }

  const skillMd = options.content !== undefined ? options.content : await readFile(options.contentFile!, "utf8");
  return { "SKILL.md": skillMd };
}

function formatSkillScanFinding(finding: SkillScanFinding): string {
  return `${finding.severity === "sharp" ? "SHARP" : "soft "} [${finding.category}] ${finding.detail}`;
}

function parseSkillGatePolicy(rawValue: string | undefined): "gate-sharpest" | "free" {
  const value = (rawValue ?? "gate-sharpest").trim().toLowerCase();
  if (value === "gate-sharpest" || value === "free") {
    return value;
  }
  throw createCliError(`Invalid --gate-policy "${rawValue}". Must be one of: gate-sharpest, free.`, 2);
}

/**
 * Emit the migration-0016-absent refusal. In JSON mode this emits a structured
 * error to stdout, sets exit 3, and returns (the caller must stop). In text mode
 * it throws a CliError (exit 3) which the top-level handler prints once.
 */
function emitSkillContentMigrationRefusal(commandJsonName: string, json: boolean | undefined): void {
  const message =
    "skill content migration 0016 is not applied. Run `calyx state migrate --apply` first.";
  if (json) {
    emitCommandJsonError(commandJsonName, {
      code: "skill_content_migration_absent",
      message,
      suggestions: ["calyx state migrate --apply"],
    });
    process.exitCode = 3;
    return;
  }
  throw createCliError(message, 3);
}

// ── calyx memory (POL-1729 Slice 4: curated-facts store) ───────────────
//
// calyx-memory is the curated-facts sibling of skill_content. It is the
// always-injected / 100%-blast-radius surface, so its posture is STRICT BY
// CONSTRUCTION, DIFFERENT from skills:
//   - A `memory write` lands review_status='pending' (NOT active/free).
//   - The security scan is STRICT: ANY sharp finding REJECTS the write here at
//     the CLI boundary (no row is written) — it does NOT stage-and-warn like
//     `skills write --gate-policy free`. Memory's blast radius does not tolerate
//     the long-tail, so there is no `--gate-policy` escape hatch.
//   - Surfacing/injection is OUT OF SCOPE: this store is INERT re: injection.

/**
 * Host id for curated-facts `memory_content` rows: the local host alias
 * (hostname with the domain suffix stripped, lowercased). Mirrors
 * {@link skillContentHostId} so memory and skills share host conventions.
 */
function memoryContentHostId(): string {
  return systemHostname().split(".")[0]?.toLowerCase() ?? systemHostname().toLowerCase();
}

interface MemoryWriteOptions {
  value?: string;
  contentFile?: string;
  category?: string;
  summary?: string;
  author?: string;
  fromActivity?: string;
  fromMessage?: string;
  json?: boolean;
}

/**
 * Resolve the fact value for `calyx memory write`. Exactly one of --value /
 * --content-file must be supplied.
 */
async function assembleMemoryValue(options: MemoryWriteOptions): Promise<string> {
  const sources = [
    options.value !== undefined ? "--value" : null,
    options.contentFile ? "--content-file" : null,
  ].filter(Boolean);
  if (sources.length === 0) {
    throw createCliError("calyx memory write requires one of --value or --content-file.", 2);
  }
  if (sources.length > 1) {
    throw createCliError(
      `calyx memory write accepts only one value source; got ${sources.join(", ")}.`,
      2,
    );
  }
  const value = options.value !== undefined ? options.value : await readFile(options.contentFile!, "utf8");
  if (value.length === 0) {
    throw createCliError("calyx memory write value must be non-empty.", 2);
  }
  return value;
}

function parseMemoryCategory(rawValue: string | undefined): MemoryCategory {
  const value = (rawValue ?? "").trim().toLowerCase();
  if ((MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as MemoryCategory;
  }
  throw createCliError(
    `Invalid --category "${rawValue ?? ""}". Must be one of: ${MEMORY_CATEGORIES.join(", ")}.`,
    2,
  );
}

/**
 * Recall-status resolver for the READ verbs (`get`/`list`/`search`). These
 * default to `approved` only — the strict, 100%-blast-radius posture means an
 * agent recalling memory must NOT see unapproved (pending/rejected) facts unless
 * it explicitly opts in for triage. `--status all` returns every review status;
 * an explicit `pending|approved|rejected` narrows to that one.
 *
 * Returns `undefined` to mean "no review_status filter" (i.e. `all`); otherwise
 * the concrete status to filter on (default `approved`).
 */
function parseMemoryRecallStatus(rawValue: string | undefined): MemoryReviewStatus | undefined {
  if (rawValue === undefined) return "approved";
  const value = rawValue.trim().toLowerCase();
  if (value === "all") return undefined;
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  throw createCliError(
    `Invalid --status "${rawValue}". Must be one of: approved, pending, rejected, all.`,
    2,
  );
}

/** Stable JSON view of a memory row (the same shape across write/get/list/search). */
function memoryRowView(row: MemoryContentRow): Record<string, unknown> {
  return {
    memory_key: row.memory_key,
    host_id: row.host_id,
    value: row.value,
    content_hash: row.content_hash,
    category: row.category,
    review_status: row.review_status,
    pinned: row.pinned,
    deleted_at: row.deleted_at,
    origin_activity_id: row.origin_activity_id,
    origin_message_id: row.origin_message_id,
    author: row.author,
    summary: row.summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
  };
}

const MEMORY_CONTENT_SCHEMA_VERSION = "calyx.memory-content/v1" as const;

/**
 * Emit the migration-0018-absent refusal. JSON mode -> structured error to
 * stdout, exit 3, return. Text mode -> throw a CliError (exit 3).
 */
function emitMemoryContentMigrationRefusal(commandJsonName: string, json: boolean | undefined): void {
  const message =
    "memory content migration 0018 is not applied. Run `calyx state migrate --apply` first.";
  if (json) {
    emitCommandJsonError(commandJsonName, {
      code: "memory_content_migration_absent",
      message,
      suggestions: ["calyx state migrate --apply"],
    });
    process.exitCode = 3;
    return;
  }
  throw createCliError(message, 3);
}

/**
 * Build the `calyx memory` command group (POL-1729 Slice 4). A top-level group
 * (not an SDK hook domain) wired into `buildProgram` alongside the other
 * top-level groups; registered with `program.addCommand(memory)`.
 */
function buildMemoryCommand(): Command {
  const memory = new Command("memory").description(
    "Curated-facts memory store (POL-1729): write lands PENDING, approve to activate; STRICT scan (sharp findings rejected); surfacing/injection is deferred and out of scope",
  );

  memory
    .command("write")
    .description("Write a curated fact (lands review_status=pending; STRICT scan rejects any sharp finding)")
    .argument("<key>", "Memory key (e.g. caleb-prefers-organic)")
    .option("--value <text>", "Inline fact value (single-line common case)")
    .option("--content-file <path>", "Read the fact value from a file")
    .requiredOption("--category <category>", `Fact category: ${MEMORY_CATEGORIES.join(" | ")}`)
    .option("--summary <text>", "Short summary recorded with the write")
    .option("--author <id>", "Author identifier (e.g. claude:carbon)")
    .option("--from-activity <activity-id>", "Origin activity id for provenance")
    .option("--from-message <message-id>", "Origin message id for provenance")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory write caleb-prefers-organic --value 'Caleb prefers organic shapes over glassmorphism.' --category user --json",
        "  $ calyx memory write polli-ein --content-file ein.txt --category reference --summary 'tax id' --json",
        "",
        "Memory is the always-injected / 100%-blast-radius sibling of skills, so its posture is STRICT:",
        "a write does NOT land active — it lands as review_status=pending and must be approved with",
        "`calyx memory approve <key> --expected-content-hash <hash>` (read the hash from",
        "`calyx memory get <key> --status pending`) before it is considered active. The security scan is strict: ANY sharp",
        "finding (shell-destructive / exfil / credential / invisible-unicode) REJECTS the write (no row written).",
        "Surfacing/injection is deferred and out of scope: this store is inert — nothing here auto-injects memory.",
        "",
        "Agent-question: is this a durable, operator-relevant fact (not a transient task detail)? Memory is forever; prefer a Linear/vault receipt for ephemeral state.",
      ].join("\n"),
    )
    .action(async (rawKey: string, options: MemoryWriteOptions) => {
      const key = normalizeName(rawKey);
      const keyNote = key !== rawKey ? `memory key normalized to ${key}` : undefined;
      const category = parseMemoryCategory(options.category);
      const value = await assembleMemoryValue(options);

      // STRICT scan: reuse the skills content scanner; ANY sharp finding rejects
      // (no stage-and-warn). Memory's blast radius does not tolerate the long-tail.
      const scan = scanSkillContent(value);
      const sharpFindings = scan.findings.filter((finding) => finding.severity === "sharp");
      if (sharpFindings.length > 0) {
        const suggestions = ["revise the fact to remove the flagged content; memory has no override path"];
        if (options.json) {
          emitCommandJsonError("memory.write", {
            code: "rejected_sharp_content",
            message: `rejected: ${sharpFindings.length} sharp security finding(s); memory is strict (no row written)`,
            suggestions,
            matches: sharpFindings.map(formatSkillScanFinding),
          });
          process.exitCode = 3;
          return;
        }
        console.error(`rejected: ${sharpFindings.length} sharp security finding(s); memory is strict (no row written)`);
        for (const finding of sharpFindings) {
          console.error(`  ${formatSkillScanFinding(finding)}`);
        }
        console.error(`Suggestions: ${suggestions.join("; ")}`);
        throw createCliError("calyx memory write rejected on sharp security findings", 3);
      }

      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let row: MemoryContentRow;
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal("memory.write", options.json);
          return;
        }
        row = upsertMemoryContent(opened.db, {
          host_id: hostId,
          memory_key: key,
          value,
          category,
          ...(options.author ? { author: options.author } : {}),
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.fromActivity ? { origin_activity_id: options.fromActivity } : {}),
          ...(options.fromMessage ? { origin_message_id: options.fromMessage } : {}),
        });
      } finally {
        opened.db.close();
      }

      if (options.json) {
        emitCommandJsonResult("memory.write", {
          schema_version: MEMORY_CONTENT_SCHEMA_VERSION,
          ...memoryRowView(row),
          scan: { ok: scan.ok, findings: scan.findings },
          ...(keyNote ? { note: keyNote } : {}),
        });
        return;
      }
      console.log(`wrote\t${key}\thost=${hostId}\tcategory=${row.category}\tstatus=${row.review_status}\thash=${row.content_hash.slice(0, 12)}`);
      if (keyNote) {
        console.error(`note: ${keyNote}`);
      }
      if (scan.findings.length > 0) {
        console.error(`scan: ${scan.findings.length} advisory (soft) finding(s) recorded:`);
        for (const finding of scan.findings) {
          console.error(`  ${formatSkillScanFinding(finding)}`);
        }
      }
      console.error(
        "saved as PENDING (not active). Read the full content_hash with `calyx memory get " +
          key +
          " --status pending --json`, then approve with `calyx memory approve " +
          key +
          " --expected-content-hash <hash>`.",
      );
    });

  const reviewAction = (
    target: "approved" | "rejected",
    commandJsonName: string,
    requireExpectedHash: boolean,
  ) =>
    async (
      rawKey: string,
      options: { author?: string; note?: string; expectedContentHash?: string; json?: boolean },
    ) => {
      const key = normalizeName(rawKey);
      // CAS gate (P1-2): approve is the operator-facing safe path for this
      // 100%-blast-radius surface, so it REQUIRES the reviewed content hash — an
      // approve without it could rubber-stamp a value rewritten since the read.
      const expectedContentHash = options.expectedContentHash?.trim();
      if (requireExpectedHash && !expectedContentHash) {
        const message =
          `calyx memory ${target === "approved" ? "approve" : "reject"} requires --expected-content-hash <hash>. ` +
          `Run \`calyx memory get ${key} --status pending --json\` to read the current content_hash, then re-run ` +
          `\`calyx memory ${target === "approved" ? "approve" : "reject"} ${key} --expected-content-hash <hash>\` ` +
          `so you can only approve the value you actually reviewed.`;
        if (options.json) {
          emitCommandJsonError(commandJsonName, {
            code: "expected_content_hash_required",
            message,
            suggestions: [`calyx memory get ${key} --status pending --json`, "pass the content_hash via --expected-content-hash"],
          });
          process.exitCode = 2;
          return;
        }
        throw createCliError(message, 2);
      }
      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let row: MemoryContentRow;
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal(commandJsonName, options.json);
          return;
        }
        try {
          row = setMemoryReviewStatus(opened.db, {
            host_id: hostId,
            memory_key: key,
            status: target,
            ...(expectedContentHash ? { expected_content_hash: expectedContentHash } : {}),
            ...(options.author ? { actor: options.author } : {}),
            ...(options.note ? { note: options.note } : {}),
          });
        } catch (err) {
          if (err instanceof MemoryReviewAborted) {
            // not_found -> 4; concurrent_write (the row was rewritten since the
            // read) is a review-conflict -> 3; any other abort -> 6.
            const exitCode = err.code === "not_found" ? 4 : err.code === "concurrent_write" ? 3 : 6;
            if (options.json) {
              const suggestions =
                err.code === "concurrent_write"
                  ? [`calyx memory get ${key} --status pending --json`, "re-read the current value + content_hash, then re-approve"]
                  : undefined;
              emitCommandJsonError(commandJsonName, {
                code: err.code,
                message: err.message,
                ...(suggestions ? { suggestions } : {}),
              });
              process.exitCode = exitCode;
              return;
            }
            throw createCliError(err.message, exitCode);
          }
          throw err;
        }
      } finally {
        opened.db.close();
      }
      if (options.json) {
        emitCommandJsonResult(commandJsonName, { schema_version: MEMORY_CONTENT_SCHEMA_VERSION, ...memoryRowView(row) });
        return;
      }
      const verb = target === "approved" ? "approved" : "rejected";
      console.log(`${verb}\t${key}\thost=${hostId}\tstatus=${row.review_status}`);
    };

  memory
    .command("approve")
    .description("Approve a pending fact (the operator/review gate that activates it)")
    .argument("<key>", "Memory key to approve")
    .option(
      "--expected-content-hash <hash>",
      "REQUIRED. The content_hash the reviewer read (from `calyx memory get <key> --status pending`). A CAS guard refusing if the value was rewritten since you read it",
    )
    .option("--author <id>", "Reviewer identifier recorded in the write log")
    .option("--note <text>", "Review note recorded in the write log")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory get caleb-prefers-organic --status pending --json   # read the current content_hash",
        "  $ calyx memory approve caleb-prefers-organic --expected-content-hash <hash> --author caleb --json",
        "",
        "Approve is the human/operator review step. An agent can `memory write` (lands pending); approval is the",
        "explicit gate that marks the fact active. --expected-content-hash is REQUIRED (the safe path for this",
        "100%-blast-radius surface): it binds approval to the value you actually read, so a concurrent rewrite cannot",
        "be approved unseen. If the value changed since your read, approve exits 3 (review conflict); re-read + re-approve.",
        "",
        "Agent-question: are you the right reviewer for this fact, or should the operator approve it?",
      ].join("\n"),
    )
    .action(reviewAction("approved", "memory.approve", true));

  memory
    .command("reject")
    .description("Reject a fact (records a rejected review; the fact is not active)")
    .argument("<key>", "Memory key to reject")
    .option(
      "--expected-content-hash <hash>",
      "Optional CAS guard: the content_hash the reviewer read; refuses (exit 3) if the value was rewritten since",
    )
    .option("--author <id>", "Reviewer identifier recorded in the write log")
    .option("--note <text>", "Review note recorded in the write log")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory reject stale-fact --note 'superseded' --json",
        "",
        "Records a rejected review (clearing any prior approval). The row is retained for audit; use",
        "`calyx memory delete <key>` to tombstone it entirely. --expected-content-hash is optional here (reject",
        "discards the value, so a stale read is less dangerous); pass it to refuse on a concurrent rewrite.",
        "",
        "Agent-question: should this be rejected (keep for audit) or deleted (tombstone)?",
      ].join("\n"),
    )
    .action(reviewAction("rejected", "memory.reject", false));

  memory
    .command("get")
    .description("Read a single APPROVED fact by key (use --status/--include-unapproved to inspect unapproved rows)")
    .argument("<key>", "Memory key to read")
    .option(
      "--status <status>",
      "Recall filter: approved (default) | pending | rejected | all. The default returns the row ONLY if approved",
    )
    .option("--include-unapproved", "Alias for --status all: return the live row whatever its review_status")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory get caleb-prefers-organic --json",
        "  $ calyx memory get polli-ein",
        "  $ calyx memory get pending-fact --status pending --json   # inspect an unapproved row",
        "",
        "Recall defaults to APPROVED-only (the strict 100%-blast-radius posture): an unapproved row is treated as",
        "not-active and exits 3 (memory_not_approved) naming its actual status. Pass --status <status> (or",
        "--include-unapproved) to inspect a pending/rejected row. A missing or deleted key exits 4.",
        "",
        "Agent-question: do you need the current value, or to search for the right key first (`calyx memory search`)?",
      ].join("\n"),
    )
    .action(async (rawKey: string, options: { status?: string; includeUnapproved?: boolean; json?: boolean }) => {
      const key = normalizeName(rawKey);
      // Recall defaults to approved-only. --include-unapproved is sugar for the
      // `all` filter (no review_status constraint).
      const recallStatus = options.includeUnapproved
        ? undefined
        : parseMemoryRecallStatus(options.status);
      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let row: MemoryContentRow | undefined;
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal("memory.get", options.json);
          return;
        }
        row = readMemoryContent(opened.db, hostId, key);
      } finally {
        opened.db.close();
      }
      if (!row || row.deleted_at !== null) {
        const message = `memory key "${key}" not found on host ${hostId}.`;
        if (options.json) {
          emitCommandJsonError("memory.get", { code: "not_found", message });
          process.exitCode = 4;
          return;
        }
        throw createCliError(message, 4);
      }
      // The row is live but its review_status does not match the recall filter
      // (by default: not approved). Treat as not-active and name the real status.
      if (recallStatus !== undefined && row.review_status !== recallStatus) {
        const message =
          `memory key "${key}" is ${row.review_status}, not ${recallStatus}, on host ${hostId}. ` +
          `By default recall returns approved facts only; pass --status ${row.review_status} ` +
          `(or --include-unapproved) to inspect it.`;
        if (options.json) {
          emitCommandJsonError("memory.get", {
            code: "memory_not_approved",
            message,
            suggestions: [`calyx memory get ${key} --status ${row.review_status} --json`],
            // Surface the live status + content_hash so triage / approve flows can proceed.
            status: row.review_status,
            content_hash: row.content_hash,
          });
          process.exitCode = 3;
          return;
        }
        throw createCliError(message, 3);
      }
      if (options.json) {
        emitCommandJsonResult("memory.get", { schema_version: MEMORY_CONTENT_SCHEMA_VERSION, ...memoryRowView(row) });
        return;
      }
      console.log(`${row.memory_key}\tcategory=${row.category}\tstatus=${row.review_status}\thash=${row.content_hash}`);
      console.log(row.value);
    });

  memory
    .command("list")
    .description("List APPROVED curated facts by default (--status pending = the approval queue; --status all = everything)")
    .option("--category <category>", `Filter by category: ${MEMORY_CATEGORIES.join(" | ")}`)
    .option("--status <status>", "Filter by review status: approved (default) | pending | rejected | all")
    .option("--include-tombstoned", "Include tombstoned (deleted) rows")
    .option("--limit <n>", "Maximum rows to return")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory list --json                 # approved facts only (the default recall)",
        "  $ calyx memory list --status pending --json   # the approval queue",
        "  $ calyx memory list --status all --json       # every review status (triage)",
        "  $ calyx memory list --category user --json",
        "",
        "Defaults to APPROVED-only (the strict recall posture). Use --status pending for the approval queue, or",
        "--status all to see everything. The status column stays in text output so the queue is legible.",
        "",
        "Agent-question: are you triaging the pending queue, or recalling approved facts for a task?",
      ].join("\n"),
    )
    .action(async (options: { category?: string; status?: string; includeTombstoned?: boolean; limit?: string; json?: boolean }) => {
      const category = options.category ? parseMemoryCategory(options.category) : undefined;
      const reviewStatus = parseMemoryRecallStatus(options.status);
      const limit = options.limit !== undefined ? Number.parseInt(options.limit, 10) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw createCliError(`Invalid --limit "${options.limit}". Must be a positive integer.`, 2);
      }
      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let rows: MemoryContentRow[];
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal("memory.list", options.json);
          return;
        }
        rows = listMemoryContent(opened.db, {
          host_id: hostId,
          ...(category ? { category } : {}),
          ...(reviewStatus ? { review_status: reviewStatus } : {}),
          ...(options.includeTombstoned ? { includeTombstoned: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      } finally {
        opened.db.close();
      }
      if (options.json) {
        emitCommandJsonResult("memory.list", {
          schema_version: MEMORY_CONTENT_SCHEMA_VERSION,
          count: rows.length,
          memories: rows.map(memoryRowView),
        });
        return;
      }
      if (rows.length === 0) {
        console.error("(no memories match)");
        return;
      }
      for (const row of rows) {
        console.log(`${row.memory_key}\t${row.category}\t${row.review_status}\t${row.value.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    });

  memory
    .command("search")
    .description("Substring search over key + value + summary, APPROVED-only by default (check-at-will; NOT semantic)")
    .argument("<query>", "Substring to search for")
    .option("--category <category>", `Filter by category: ${MEMORY_CATEGORIES.join(" | ")}`)
    .option("--status <status>", "Filter by review status: approved (default) | pending | rejected | all")
    .option("--limit <n>", "Maximum rows to return")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory search 'glassmorphism' --json        # approved facts only (the default recall)",
        "  $ calyx memory search ein --status all --json        # search every review status (triage)",
        "",
        "A literal substring match over key, value, and summary, ranked by recency. This is the check-at-will read",
        "(the deferred surfacing model may make this the discovery path); it is NOT a semantic engine. Defaults to",
        "APPROVED-only (the strict recall posture) — pass --status pending/rejected/all to widen for triage.",
        "",
        "Agent-question: is a literal substring enough, or do you need semantic recall (out of scope here)?",
      ].join("\n"),
    )
    .action(async (query: string, options: { category?: string; status?: string; limit?: string; json?: boolean }) => {
      const category = options.category ? parseMemoryCategory(options.category) : undefined;
      const reviewStatus = parseMemoryRecallStatus(options.status);
      const limit = options.limit !== undefined ? Number.parseInt(options.limit, 10) : undefined;
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw createCliError(`Invalid --limit "${options.limit}". Must be a positive integer.`, 2);
      }
      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let rows: MemoryContentRow[];
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal("memory.search", options.json);
          return;
        }
        rows = searchMemoryContent(opened.db, hostId, query, {
          ...(category ? { category } : {}),
          ...(reviewStatus ? { review_status: reviewStatus } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      } finally {
        opened.db.close();
      }
      if (options.json) {
        emitCommandJsonResult("memory.search", {
          schema_version: MEMORY_CONTENT_SCHEMA_VERSION,
          query,
          count: rows.length,
          memories: rows.map(memoryRowView),
        });
        return;
      }
      if (rows.length === 0) {
        console.error(`(no memories match "${query}")`);
        return;
      }
      for (const row of rows) {
        console.log(`${row.memory_key}\t${row.category}\t${row.review_status}\t${row.value.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    });

  memory
    .command("delete")
    .description("Tombstone a curated fact (the row is retained; a later write recreates it)")
    .argument("<key>", "Memory key to delete")
    .option("--summary <text>", "Short summary recorded with the delete")
    .option("--author <id>", "Author identifier (e.g. claude:carbon)")
    .option("--from-activity <activity-id>", "Origin activity id for provenance")
    .option("--from-message <message-id>", "Origin message id for provenance")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx memory delete stale-fact --summary 'no longer true' --json",
        "",
        "Records a tombstone (the row is retained, not hard-deleted). A later `calyx memory write <key>`",
        "recreates the fact (back to pending, requiring re-approval).",
        "",
        "Agent-question: is this fact wrong (delete) or just unapproved (leave pending / reject)?",
      ].join("\n"),
    )
    .action(async (rawKey: string, options: { summary?: string; author?: string; fromActivity?: string; fromMessage?: string; json?: boolean }) => {
      const key = normalizeName(rawKey);
      const keyNote = key !== rawKey ? `memory key normalized to ${key}` : undefined;
      const hostId = memoryContentHostId();
      const opened = await openStateStore();
      let row: MemoryContentRow;
      try {
        const schema = checkMemoryContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitMemoryContentMigrationRefusal("memory.delete", options.json);
          return;
        }
        row = tombstoneMemoryContent(opened.db, {
          host_id: hostId,
          memory_key: key,
          ...(options.author ? { author: options.author } : {}),
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.fromActivity ? { origin_activity_id: options.fromActivity } : {}),
          ...(options.fromMessage ? { origin_message_id: options.fromMessage } : {}),
        });
      } finally {
        opened.db.close();
      }
      if (options.json) {
        emitCommandJsonResult("memory.delete", {
          schema_version: MEMORY_CONTENT_SCHEMA_VERSION,
          ...memoryRowView(row),
          ...(keyNote ? { note: keyNote } : {}),
        });
        return;
      }
      console.log(`deleted\t${key}\thost=${hostId}\tdeleted_at=${row.deleted_at ?? ""}`);
      if (keyNote) {
        console.error(`note: ${keyNote}`);
      }
    });

  return memory;
}

/**
 * Register the curator MUTATION subcommands (POL-1729 Slice 3): pin/unpin,
 * consolidate, rollback. These operate on the agent-owned db-regime
 * `skill_content` rows on the local host. Kept in a helper so the giant
 * `buildProgram` body stays manageable; the read-only `status`/`run` verbs stay
 * inline next to the other curator wiring.
 */
function registerSkillsCuratorMutationCommands(skillsCurator: Command): void {
  const setPinnedAction = async (
    rawId: string,
    options: { json?: boolean },
    pinned: boolean,
  ): Promise<void> => {
    const name = normalizeName(rawId);
    const commandJson = pinned ? "skills.curator.pin" : "skills.curator.unpin";
    const hostId = skillContentHostId();
    const opened = await openStateStore();
    let row: ReturnType<typeof readSkillContent>;
    try {
      const schema = checkSkillContentSchema(opened.db);
      if (schema.status !== "ok") {
        emitSkillContentMigrationRefusal(commandJson, options.json);
        return;
      }
      row = setPinned(opened.db, hostId, name, pinned);
    } finally {
      opened.db.close();
    }
    if (!row) {
      const message = `no skill_content row for "${name}" on host ${hostId} (pin/unpin only affects agent-owned db skills)`;
      if (options.json) {
        emitCommandJsonError(commandJson, {
          code: "skill_not_found",
          message,
          suggestions: ["`calyx skills write <name>` to create it first", "check the name with `calyx skills show <name>`"],
        });
        process.exitCode = 3;
        return;
      }
      throw createCliError(message, 3);
    }
    if (options.json) {
      emitCommandJsonResult(commandJson, { skill_name: row.skill_name, host_id: row.host_id, pinned: row.pinned });
      return;
    }
    console.log(`${pinned ? "pinned" : "unpinned"}\t${row.skill_name}\thost=${row.host_id}\tpinned=${row.pinned}`);
  };

  skillsCurator
    .command("pin")
    .description("Pin an agent-owned skill so the curator apply never auto-archives or auto-consolidates it")
    .argument("<id>", "Skill id to pin")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator pin my-skill --json",
        "",
        "Pinning is the curator-apply protection fence (migration 0017). It does NOT affect manual",
        "`calyx skills write` / `delete`.",
      ].join("\n"),
    )
    .action(async (rawId: string, options: { json?: boolean }) => {
      await setPinnedAction(rawId, options, true);
    });

  skillsCurator
    .command("unpin")
    .description("Remove the curator-apply protection fence from an agent-owned skill")
    .argument("<id>", "Skill id to unpin")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      ["", "Examples:", "  calyx skills curator unpin my-skill --json"].join("\n"),
    )
    .action(async (rawId: string, options: { json?: boolean }) => {
      await setPinnedAction(rawId, options, false);
    });

  skillsCurator
    .command("consolidate")
    .description("Fold one or more agent-owned skills INTO a target survivor (multi-row CAS) and re-materialize")
    .argument("<source...>", "Source skill ids to consolidate and tombstone")
    .requiredOption("--into <targetId>", "Target survivor skill id (created/updated as the merged skill)")
    .requiredOption("--content-file <path>", "Path to the merged target SKILL.md (the survivor's content)")
    .option("--summary <text>", "Short summary recorded with the consolidation")
    .option("--author <id>", "Author identifier (e.g. claude:carbon)")
    .option("--from-activity <activity-id>", "Origin activity id for provenance")
    .option("--from-message <message-id>", "Origin message id for provenance")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator consolidate old-a old-b --into merged --content-file SKILL.md --json",
        "",
        "The judged-consolidation primitive for the agent/operator. ALL-OR-NOTHING: a concurrent write to",
        "any source aborts the whole consolidation (multi-row compare-and-set). Refuses if any source is",
        "pinned or not regime=db. After the CAS commit it re-materializes the target and prunes the source",
        "mirrors.",
        "",
        "Agent-question: have you confirmed the merged SKILL.md preserves what mattered from every source?",
      ].join("\n"),
    )
    .action(
      async (
        sources: string[],
        options: {
          into: string;
          contentFile: string;
          summary?: string;
          author?: string;
          fromActivity?: string;
          fromMessage?: string;
          json?: boolean;
        },
      ) => {
        const targetId = normalizeName(options.into);
        let skillMd: string;
        try {
          skillMd = await readFile(options.contentFile, "utf8");
        } catch (error) {
          const message = `could not read --content-file ${options.contentFile}: ${error instanceof Error ? error.message : String(error)}`;
          if (options.json) {
            emitCommandJsonError("skills.curator.consolidate", { code: "content_file_unreadable", message });
            process.exitCode = 2;
            return;
          }
          throw createCliError(message, 2);
        }
        if (skillMd.trim().length === 0) {
          throw createCliError("--content-file must contain a non-empty SKILL.md document.", 2);
        }
        const targetPayload = { "SKILL.md": skillMd };

        const hostId = skillContentHostId();
        const opened = await openStateStore();
        let consolidated: string[] = [];
        try {
          const schema = checkSkillContentSchema(opened.db);
          if (schema.status !== "ok") {
            emitSkillContentMigrationRefusal("skills.curator.consolidate", options.json);
            return;
          }
          let result;
          try {
            result = consolidateSkillContent(opened.db, {
              hostId,
              sourceIds: sources,
              targetId,
              targetPayload,
              ...(options.summary ? { summary: options.summary } : {}),
              ...(options.author ? { author: options.author } : {}),
              ...(options.fromActivity ? { originActivityId: options.fromActivity } : {}),
              ...(options.fromMessage ? { originMessageId: options.fromMessage } : {}),
            });
          } catch (error) {
            if (error instanceof ConsolidationAborted) {
              const suggestions =
                error.code === "pinned_source"
                  ? ["unpin the source with `calyx skills curator unpin <id>` first"]
                  : error.code === "concurrent_write"
                    ? ["a concurrent write changed a source; re-run after re-reading the sources"]
                    : ["check the source ids and that they are agent-owned (regime=db) live skills"];
              if (options.json) {
                emitCommandJsonError("skills.curator.consolidate", { code: error.code, message: error.message, suggestions });
                process.exitCode = 3;
                return;
              }
              console.error(`Suggestions: ${suggestions.join("; ")}`);
              throw createCliError(error.message, 3);
            }
            throw error;
          }
          consolidated = result.consolidated;
          // Caller re-materializes the target survivor + prunes the source mirrors.
          await rematerializeSkill({ db: opened.db, hostId, skillName: targetId });
          for (const sourceId of result.consolidated) {
            await rematerializeSkill({ db: opened.db, hostId, skillName: sourceId });
          }
        } finally {
          opened.db.close();
        }

        if (options.json) {
          emitCommandJsonResult("skills.curator.consolidate", {
            target: targetId,
            host_id: hostId,
            consolidated,
            action: "consolidated",
          });
          return;
        }
        console.log(`consolidated\ttarget=${targetId}\thost=${hostId}\tsources=${consolidated.join(",")}`);
      },
    );

  skillsCurator
    .command("rollback")
    .description("Roll back a curator apply pass: replay the write-log window in reverse to un-archive skills")
    .option("--pass <id>", "The curator pass id from a prior `curator run --apply` receipt")
    .option("--cursor <n>", "The rollback cursor (write-log event_seq) from the receipt", (v: string) => parsePositiveIntegerOption(v, "--cursor"))
    .option("--last", "Roll back the most recent curator apply pass on this host")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator rollback --pass curator-carbon-2026-06-22T... --cursor 42 --json",
        "  calyx skills curator rollback --last --json",
        "",
        "Guarantees: rollback only UN-ARCHIVES (it never re-deletes a skill (re)created after the pass) and",
        "is idempotent. Curator archives are recoverable (payload retained); a manual `skills delete` hard",
        "tombstone is reported unrestorable. Provide --cursor with --pass; --last derives the cursor from",
        "the most recent curator delete window on this host.",
      ].join("\n"),
    )
    .action(async (options: { pass?: string; cursor?: number; last?: boolean; json?: boolean }) => {
      const hostId = skillContentHostId();
      if (!options.last && options.cursor === undefined) {
        const message = "rollback requires --cursor <n> (from the apply receipt), or --last to derive it";
        if (options.json) {
          emitCommandJsonError("skills.curator.rollback", {
            code: "cursor_required",
            message,
            suggestions: ["pass --cursor <n> with --pass <id>", "or use --last"],
          });
          process.exitCode = 2;
          return;
        }
        throw createCliError(message, 2);
      }

      const opened = await openStateStore();
      let result;
      try {
        const schema = checkSkillContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitSkillContentMigrationRefusal("skills.curator.rollback", options.json);
          return;
        }
        let cursor = options.cursor;
        let derivedPassId: string | undefined;
        if (cursor === undefined && options.last) {
          // Derive the most recent curator pass for --last: replaying
          // event_seq > cursor un-archives exactly that latest archive window.
          const latest = deriveLatestCuratorPass(opened.db, hostId);
          if (!latest) {
            const message = `no curator apply pass found on host ${hostId} to roll back`;
            if (options.json) {
              emitCommandJsonError("skills.curator.rollback", {
                code: "no_pass_found",
                message,
                suggestions: ["run `calyx skills curator run --apply --confirm` first", "or pass an explicit --cursor"],
              });
              process.exitCode = 3;
              return;
            }
            throw createCliError(message, 3);
          }
          cursor = latest.cursor;
          derivedPassId = latest.passId;
        }
        result = await rollbackCuratorPass({
          db: opened.db,
          hostId,
          cursor: cursor ?? 0,
          ...(options.pass ? { passId: options.pass } : derivedPassId ? { passId: derivedPassId } : {}),
        });
      } finally {
        opened.db.close();
      }

      if (options.json) {
        emitCommandJsonResult("skills.curator.rollback", result);
        return;
      }
      console.log(`rollback\thost=${result.host_id}\tfrom_cursor=${result.from_cursor}`);
      console.log(`restored\t${result.restored.length}`);
      for (const id of result.restored) console.log(`  restored\t${id}`);
      if (result.unrestorable.length > 0) {
        console.log(`unrestorable\t${result.unrestorable.length}`);
        for (const id of result.unrestorable) console.log(`  unrestorable\t${id}`);
      }
      for (const note of result.notes) console.error(note);
    });
}

function parsePluginHarness(rawValue?: string): PluginHarnessSelector {
  const value = (rawValue ?? "all").trim().toLowerCase();
  if (value === "codex" || value === "claude" || value === "all") {
    return value;
  }
  throw createCliError(`Invalid --harness value for plugins: ${rawValue}. Must be one of: codex, claude, all.`, 2);
}

function parsePluginComponentKind(rawValue?: string): PluginComponentKind | undefined {
  if (!rawValue) {
    return undefined;
  }
  const value = rawValue.trim();
  if ((PLUGIN_COMPONENT_KINDS as readonly string[]).includes(value)) {
    return value as PluginComponentKind;
  }
  throw createCliError(
    `Invalid --kind value for plugins trace: ${rawValue}. Must be one of: ${PLUGIN_COMPONENT_KINDS.join(", ")}.`,
    2,
  );
}

function normalizePluginsOptions(options: PluginsBaseCommandOptions): PluginsInventoryOptions {
  return {
    harness: parsePluginHarness(options.harness),
    ...(options.home ? { home: options.home } : {}),
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
    includeCatalog: Boolean(options.includeCatalog),
  };
}

function parseKnowledgeKind(rawValue: string): KnowledgeArtifactKind {
  const value = rawValue.trim().toLowerCase();
  if (value === "execplan" || value === "transcript" || value === "report" || value === "runbook" || value === "reference") {
    return value;
  }

  throw createCliError(`Invalid --kind value: ${rawValue}. Must be one of: execplan, transcript, report, runbook, reference.`, 2);
}

function parseLogLevel(rawValue: string): "info" | "warn" | "error" {
  const value = rawValue.trim().toLowerCase();
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }

  throw createCliError(`Invalid --level value: ${rawValue}. Must be one of: info, warn, error.`, 2);
}

function parseNotifyChannel(rawValue: string): ExecNotifyChannel {
  const value = rawValue.trim().toLowerCase();
  if (value === "stdout" || value === "ntfy" || value === "agent-mail") {
    return value;
  }
  throw createCliError(`Invalid --channel value: ${rawValue}. Must be one of: stdout, ntfy, agent-mail.`, 2);
}

function parseDocstoreVerb(rawValue: string): DocstoreAdapterVerb {
  const value = rawValue.trim().toLowerCase();
  if (value === "search" || value === "get" || value === "list") {
    return value;
  }
  throw createCliError(`Invalid docstore verb: ${rawValue}. Must be one of: search, get, list.`, 2);
}

function parseAgentMailVerb(rawValue: string): AgentMailVerb {
  const value = rawValue.trim().toLowerCase();
  if (value === "status" || value === "send" || value === "inbox" || value === "read") {
    return value;
  }
  throw createCliError(`Invalid agent-mail verb: ${rawValue}. Must be one of: status, send, inbox, read.`, 2);
}

function parseCsvOption(rawValue?: string): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }

  const values = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return values.length > 0 ? values : undefined;
}

function formatContextExitSemantics(): string {
  return [
    "0=success",
    `${CTXPACK_ERROR_EXIT_CODES_V1.validation_error}=validation_error`,
    `${CTXPACK_ERROR_EXIT_CODES_V1.not_found}=not_found`,
    `${CTXPACK_ERROR_EXIT_CODES_V1.capability_unavailable}=capability_unavailable`,
    `${CTXPACK_ERROR_EXIT_CODES_V1.adapter_error}=adapter_error`,
    `${CTXPACK_ERROR_EXIT_CODES_V1.internal_error}=internal_error`
  ].join(", ");
}

async function runContextPrimitiveCommand(
  primitive: ContextPrimitive,
  options: ContextPrimitiveCommandOptions
): Promise<void> {
  const request: Record<string, unknown> = {};
  const roots = parseCsvOption(options.roots);
  const include = parseCsvOption(options.include);
  const exclude = parseCsvOption(options.exclude);
  if (roots) request.roots = roots;
  if (include) request.include = include;
  if (exclude) request.exclude = exclude;
  if (options.goal?.trim()) request.goal = options.goal.trim();
  if (options.profile) request.profile = options.profile;
  if (options.seed && options.seed.length > 0) {
    request.seeds = options.seed.map((seed) => seed.trim()).filter((seed) => seed.length > 0);
  }
  if (options.vaultPath?.trim()) request.vault_path = options.vaultPath.trim();
  if (options.includeSessions !== undefined) request.include_sessions = Boolean(options.includeSessions);
  if (options.includeGitMeta !== undefined) request.include_git_meta = Boolean(options.includeGitMeta);
  if (options.planHash?.trim()) request.plan_hash = options.planHash.trim();
  if (options.outDir?.trim()) request.out_dir = options.outDir.trim();
  if (options.apply !== undefined) request.apply = Boolean(options.apply);
  if (options.redactionMode) request.redaction_mode = options.redactionMode;
  if (options.bundlePath?.trim()) request.bundle_path = options.bundlePath.trim();
  if (options.format) request.format = options.format;
  if (options.topic?.trim()) request.topic = options.topic.trim();
  if (options.target?.trim()) request.target = options.target.trim();
  if (options.enableExperimental !== undefined) {
    request.enable_experimental = Boolean(options.enableExperimental);
  }
  if (options.budgetBytes || options.budgetTokens) {
    request.budget = {};
    if (options.budgetBytes) {
      request.budget = {
        ...(request.budget as Record<string, unknown>),
        max_bytes: parsePositiveInteger(options.budgetBytes, "--budget-bytes")
      };
    }
    if (options.budgetTokens) {
      request.budget = {
        ...(request.budget as Record<string, unknown>),
        max_tokens: parsePositiveInteger(options.budgetTokens, "--budget-tokens")
      };
    }
  }
  if (options.includeUndetected !== undefined) {
    request.include_undetected = Boolean(options.includeUndetected);
  }
  const providers = parseCsvOption(options.providers);
  if (providers) {
    request.providers = providers;
  }

  const result = await runCtxpackContractV1(primitive, request);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`context ${primitive} contract ${result.version}`);
    console.log(`  determinism: ${result.determinism.normalization_version}`);
    if (result.determinism.plan_hash) {
      console.log(`  plan_hash: ${result.determinism.plan_hash}`);
    }
    console.log(JSON.stringify(result.data, null, 2));
    console.error(`[context] exit semantics: ${formatContextExitSemantics()}`);
  } else {
    console.error(`[context] ${result.error.code}: ${result.error.message}`);
    console.error(JSON.stringify(result, null, 2));
    console.error(`[context] exit semantics: ${formatContextExitSemantics()}`);
  }

  if (!result.ok) {
    throw createCliError(result.error.message, result.error.exit_code);
  }
}

async function runContextFixtureCorpusCommand(
  options: ContextFixtureRunCommandOptions
): Promise<void> {
  const receipt = await runContextFixtureCorpusFromFileV1(options.catalog, {
    failFast: Boolean(options.failFast)
  });

  const receiptPath = options.receipt.trim();
  if (!receiptPath) {
    throw createCliError("context fixtures run requires a non-empty --receipt path.", 2);
  }

  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          receipt_path: receiptPath,
          ok: receipt.ok,
          summary: receipt.summary
        },
        null,
        2
      )
    );
  } else {
    console.log("context fixtures run");
    console.log(`  catalog: ${options.catalog}`);
    console.log(`  receipt: ${receiptPath}`);
    console.log(`  total_fixtures: ${receipt.summary.total_fixtures}`);
    console.log(`  passed: ${receipt.summary.passed}`);
    console.log(`  failed: ${receipt.summary.failed}`);
    console.log(`  deterministic_replay_failures: ${receipt.summary.deterministic_replay_failures}`);
  }

  if (!receipt.ok) {
    throw createCliError(
      `context fixture corpus failed (${receipt.summary.failed} fixtures). See receipt: ${receiptPath}`,
      1
    );
  }
}

function issueText(issue: DomainValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function printValidationIssues(domain: string, issues: DomainValidationIssue[], level: "error" | "warning"): void {
  if (issues.length === 0) {
    return;
  }

  const label = level === "error" ? "errors" : "warnings";
  console.error(`[${domain}] ${label}:`);
  for (const issue of issues) {
    console.error(`- (${issue.code}) ${issueText(issue)}`);
  }
}

function printSyncActions(domain: string, actions: DomainSyncAction[]): void {
  for (const action of actions) {
    console.error(`[${domain}] ${action.action} ${action.id} (${action.details})`);
  }
}

function countActionsByVerb(actions: DomainSyncAction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const action of actions) {
    const verb = action.action.startsWith("plan-") ? action.action.slice("plan-".length) : action.action;
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return counts;
}

function normalizeToolsSyncTarget(options: ToolsSyncCommandOptions): ToolsSyncOptions {
  if (options.host && options.all) {
    throw createCliError("tools sync accepts either --host <alias> or --all, not both.", 2);
  }

  return {
    ...(options.host ? { host: options.host } : {}),
    all: Boolean(options.all),
    apply: Boolean(options.apply)
  };
}

/**
 * Resolve a source path for a domain using production wiring precedence:
 * CLI flag > env var > config file.
 */
async function resolve(domain: SourceDomain, cliValue?: string): Promise<string> {
  const resolveOptions = cliValue ? { cliValue } : {};
  const explicitResolution = await resolveSourcePath(domain, resolveOptions);
  const resolvedPath = await requireSourcePath(domain, resolveOptions);
  const telemetry = {
    event: "calyx.source.resolved",
    domain,
    source: explicitResolution.path ? explicitResolution.source : "adapter",
    fallback: !explicitResolution.path,
    path: resolvedPath,
    timestamp: new Date().toISOString()
  };
  console.error(`[calyx][telemetry] ${JSON.stringify(telemetry)}`);
  return resolvedPath;
}

function usingInstructionSurfaceMode(options: InstructionsBaseCommandOptions): boolean {
  return Boolean(options.surface || options.surfacesDir);
}

function hasRawInstructionInputs(options: InstructionsBaseCommandOptions): boolean {
  return Boolean(options.fleet || options.hostsDir || options.template || options.partialsDir);
}

function assertInstructionMode(options: InstructionsBaseCommandOptions, commandName: string): "surface" | "raw" {
  const surfaceMode = usingInstructionSurfaceMode(options);
  const rawMode = hasRawInstructionInputs(options);

  if (surfaceMode && rawMode) {
    throw createCliError(
      `${commandName} accepts either --surface/--surfaces-dir or the raw --fleet/--hosts-dir/--template/--partials-dir quartet, not both.`,
      2,
    );
  }

  return surfaceMode ? "surface" : "raw";
}

function requireInstructionSurfaceRef(options: InstructionsBaseCommandOptions): { surfacesDir: string; surfaceId: string } {
  const surfacesDir = options.surfacesDir?.trim();
  const surfaceId = options.surface?.trim();
  if (!surfacesDir || !surfaceId) {
    throw createCliError("Instruction surface mode requires both --surfaces-dir <path> and --surface <surface-id>.", 2);
  }
  return { surfacesDir, surfaceId };
}

function requireInstructionInputFiles(options: InstructionsBaseCommandOptions): {
  fleetPath: string;
  hostsDir: string;
  templatePath: string;
  partialsDir: string;
} {
  if (!options.fleet || !options.hostsDir || !options.template || !options.partialsDir) {
    throw createCliError(
      "Instruction raw mode requires --fleet <path> --hosts-dir <path> --template <path> --partials-dir <path>.",
      2,
    );
  }
  return {
    fleetPath: options.fleet,
    hostsDir: options.hostsDir,
    templatePath: options.template,
    partialsDir: options.partialsDir,
  };
}

function normalizeInstructionRenderOptions(options: InstructionsBaseCommandOptions) {
  return {
    all: Boolean(options.all),
    ...(options.host ? { host: options.host } : {}),
    ...(options.outDir ? { outputDir: options.outDir } : {}),
  };
}

function printInstructionRenderWarnings(
  results: Array<{ host: string; missingPartials: string[]; unresolvedTokens: string[] }>,
): void {
  for (const hostResult of results) {
    if (hostResult.missingPartials.length > 0) {
      console.error(`[${hostResult.host}] Missing partials: ${hostResult.missingPartials.join(", ")}`);
    }
    if (hostResult.unresolvedTokens.length > 0) {
      console.error(`[${hostResult.host}] Unresolved tokens: ${hostResult.unresolvedTokens.join(", ")}`);
    }
  }
}

function printInstructionSurfaceShow(result: InstructionsShowResult): void {
  console.log(`surface_id\t${result.surfaceId}`);
  console.log(`status\t${result.status}`);
  console.log(`manifest\t${result.manifestPath}`);
  if (result.owner) {
    console.log(`owner\t${result.owner}`);
  }
  if (result.description) {
    console.log(`description\t${result.description}`);
  }
  console.log(`fleet\t${result.sourceRef.fleetPath}`);
  console.log(`hosts_dir\t${result.sourceRef.hostsDir}`);
  console.log(`template\t${result.sourceRef.templatePath}`);
  console.log(`partials_dir\t${result.sourceRef.partialsDir}`);
  if (result.sourceRef.expectedDir) {
    console.log(`expected_dir\t${result.sourceRef.expectedDir}`);
  }
  if (result.targetBindings.length === 0) {
    console.log("targets\t(none)");
    return;
  }
  console.log("targets");
  for (const binding of result.targetBindings) {
    console.log(`${binding.bindingId}\t${binding.class}\t${binding.path}`);
  }
}

function printInstructionReconcileFindings(findings: InstructionReconcileFinding[]): void {
  for (const finding of findings) {
    console.error(
      `${finding.surfaceId}\t${finding.bindingId}\t${finding.managedFile}\t${finding.status}\t${finding.reason}\t${finding.targetPath}`,
    );
  }
}

function printInstructionReconcileSummary(result: InstructionsSurfaceReconcileResult): void {
  console.error(
    `Instruction reconcile ${result.summary.findings === 0 ? "OK" : "found issues"} (${result.host}, ${result.summary.totalTargets} target(s), ${result.summary.findings} finding(s)).`,
  );
}

function printInstructionMutationSummary(result: InstructionsSurfaceMutationResult): void {
  console.error(
    `Instruction ${result.mode} ${
      result.summary.blockedTargets === 0 ? "OK" : "blocked"
    } (${result.host}, ${result.summary.totalTargets} target(s), ${result.summary.changedTargets} changed, ${result.summary.blockedTargets} blocked).`,
  );
}

function printInstructionMutationChanges(changes: Array<InstructionMutationChange | InstructionMutationPlannedChange>): void {
  for (const change of changes) {
    console.error(
      `${change.surfaceId}\t${change.bindingId}\t${change.managedFile}\t${change.action}\t${change.targetPath}`,
    );
  }
}

function emitCommandJsonResult(command: string, result: unknown): void {
  console.log(
    JSON.stringify(
      {
        ok: true,
        command,
        result,
      },
      null,
      2,
    ),
  );
}

function emitCommandJsonError(
  command: string,
  error: {
    code: string;
    message: string;
    suggestions?: string[];
    matches?: string[];
    /** Additional structured context (e.g. `status`/`content_hash` on memory.get). */
    [key: string]: unknown;
  },
): void {
  console.log(
    JSON.stringify(
      {
        ok: false,
        command,
        error,
      },
      null,
      2,
    ),
  );
}

/**
 * Resolve + loosely-load the skills registry for the curator commands. On
 * success returns the resolved path and parsed registry; on failure emits the
 * structured `skills_registry_unresolved` error (JSON mode -> stdout + exit 3 +
 * returns null; text mode -> throws a CliError with exit 3). Shared verbatim by
 * `curator status` and `curator run` so the resolve/load/error contract lives in
 * one place.
 */
async function resolveAndLoadCuratorRegistry(
  options: { registry?: string; json?: boolean },
  commandJsonName: string,
): Promise<{ registryPath: string; registry: Awaited<ReturnType<typeof loadSkillsRegistryLoose>> } | null> {
  try {
    const registryPath = await resolve("skills", options.registry);
    const registry = await loadSkillsRegistryLoose(registryPath);
    return { registryPath, registry };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const suggestions = [
      "pass --registry <path>",
      "set CALYX_SKILLS_REGISTRY",
      "the canonical registry is instructions/skills/SOURCES.json in your agents-infra clone",
    ];
    if (options.json) {
      emitCommandJsonError(commandJsonName, { code: "skills_registry_unresolved", message, suggestions });
      process.exitCode = 3;
      return null;
    }
    throw createCliError(`${message}\nSuggestions: ${suggestions.join("; ")}`, 3);
  }
}

function printSkillsShowResult(result: SkillsShowResult): void {
  console.log(`skill\t${result.id}`);
  console.log(`status\t${result.status}`);
  console.log(`registry\t${result.registry.path}`);
  console.log(`registry_version\t${result.registry.version}`);
  console.log(`source_type\t${result.source.type}`);
  if (result.source.provenance_class) {
    console.log(`provenance_class\t${result.source.provenance_class}`);
  }
  console.log(`regime\t${result.source.regime}`);
  if (result.source.repo) {
    console.log(`source_repo\t${result.source.repo}`);
  }
  console.log(`source_path\t${result.source.path}`);
  if (result.source.resolvedSkillPath) {
    console.log(`source_resolved\t${result.source.resolvedSkillPath}`);
  }
  console.log(`source_available\t${result.source.available}`);

  console.log("local_installations");
  for (const installation of result.localInstallations) {
    console.log(
      `${installation.backend}\t${installation.state}\t${installation.present ? "present" : "missing"}\t${installation.expectedPath}`,
    );
    if (installation.liveSkillPath) {
      console.log(`  live\t${installation.liveSkillPath}`);
    }
    if (installation.expectedSkillSha256) {
      console.log(`  expected_skill_sha256\t${installation.expectedSkillSha256}`);
    }
    if (installation.liveSkillSha256) {
      console.log(`  live_skill_sha256\t${installation.liveSkillSha256}`);
    }
    if (installation.expectedTreeSha256) {
      console.log(`  expected_tree_sha256\t${installation.expectedTreeSha256}`);
    }
    if (installation.liveTreeSha256) {
      console.log(`  live_tree_sha256\t${installation.liveTreeSha256}`);
    }
  }

  if (result.fleetInstallations.length > 0) {
    console.log("fleet_installations");
    for (const installation of result.fleetInstallations) {
      console.log(`${installation.host}\t${installation.backend}\t${installation.expectedPath}`);
    }
  }

  console.log(`validation_ok\t${result.validation.ok}`);
  if (result.validation.checks.length > 0) {
    console.log("validation_checks");
    for (const check of result.validation.checks) {
      console.log(`${check.status}\t${check.id}\t${check.detail}`);
    }
  }

  if (result.notes.length > 0) {
    console.log("notes");
    for (const note of result.notes) {
      console.log(note);
    }
  }
}

function printSkillsMigrateResult(result: MigrateResult): void {
  console.log(
    `migrate\t${result.skillId}\thost=${result.hostId}\taction=${result.action}\thash=${result.contentHash.slice(0, 12)}\t${result.dryRun ? "dry-run" : "applied"}`,
  );
  console.error(`source\t${result.sourcePath}`);
  console.error(`payload_files\t${result.payloadFiles.join(", ")}`);
  if (result.rematerialize) {
    for (const backend of result.rematerialize.backends) {
      console.error(`  ${backend.backend}\t${backend.action}\t${backend.installDir}`);
    }
    if (!result.rematerialize.stamped) {
      console.error("note: a newer write landed mid-flight; materialized stamp skipped (it will re-materialize on its own pass).");
    }
  }
  console.error(`next_step: ${result.next_step}`);
}

function printSkillsMigrateAllResult(result: MigrateAllInternalResult): void {
  console.log(
    `migrate-all\thost=${result.hostId}\tplanned=${result.results.filter((r) => r.action === "planned").length}\tinstalled=${result.results.filter((r) => r.action === "installed").length}\tnoop=${result.results.filter((r) => r.action === "noop").length}\tfailed=${result.failures.length}\t${result.dryRun ? "dry-run" : "applied"}`,
  );
  for (const r of result.results) {
    console.error(`  ${r.skillId}\t${r.action}\t${r.contentHash.slice(0, 12)}`);
  }
  for (const f of result.failures) {
    console.error(`  ${f.skillId}\tFAILED(${f.code})\t${f.message}`);
  }
  if (result.note) {
    console.error(`note: ${result.note}`);
  }
  console.error(`next_step: ${result.next_step}`);
}

function pluginRef(plugin: PluginObservation): string {
  return plugin.marketplace ? `${plugin.plugin}@${plugin.marketplace}` : plugin.plugin;
}

function pluginComponentSummary(plugin: PluginObservation): string {
  const parts: string[] = [];
  for (const [kind, values] of Object.entries(plugin.components)) {
    if (Array.isArray(values) && values.length > 0) {
      parts.push(`${kind}:${values.length}`);
    }
  }
  return parts.length > 0 ? parts.join(",") : "-";
}

function printPluginList(plugins: PluginObservation[]): void {
  for (const plugin of plugins) {
    console.log(
      [
        plugin.harness,
        plugin.marketplace ?? "-",
        plugin.plugin,
        plugin.version ?? "-",
        plugin.state.join(","),
        pluginComponentSummary(plugin),
        plugin.paths.root ?? plugin.paths.manifest ?? plugin.paths.marketplace ?? "-",
      ].join("\t"),
    );
  }
}

function printPluginDetail(plugin: PluginObservation): void {
  console.log(`plugin\t${plugin.plugin}`);
  console.log(`harness\t${plugin.harness}`);
  if (plugin.marketplace) {
    console.log(`marketplace\t${plugin.marketplace}`);
  }
  if (plugin.version) {
    console.log(`version\t${plugin.version}`);
  }
  if (plugin.description) {
    console.log(`description\t${plugin.description}`);
  }
  console.log(`state\t${plugin.state.join(",")}`);
  console.log(`managed_by\t${plugin.managedBy}`);
  if (plugin.source) {
    console.log(`source\t${plugin.source.kind}\t${plugin.source.value}`);
  }
  if (plugin.paths.root) {
    console.log(`root\t${plugin.paths.root}`);
  }
  if (plugin.paths.manifest) {
    console.log(`manifest\t${plugin.paths.manifest}`);
  }
  if (plugin.paths.marketplace) {
    console.log(`marketplace_path\t${plugin.paths.marketplace}`);
  }
  console.log("components");
  for (const [kind, values] of Object.entries(plugin.components)) {
    if (Array.isArray(values) && values.length > 0) {
      console.log(`${kind}\t${values.join(",")}`);
    }
  }
}

function printInstructionTraceResult(result: InstructionTraceResult): void {
  console.log(`target\t${result.target.resolvedPath}`);
  console.log(`host\t${result.target.host}`);
  console.log(`exists\t${result.target.exists}`);

  for (const match of result.matches) {
    console.log("");
    console.log(`match\t${match.matchId}`);
    console.log(`kind\t${match.kind}`);
    console.log(`status\t${match.status}`);
    console.log(`rendered_sha256\t${match.renderState.renderedSha256}`);
    if (match.renderState.liveSha256) {
      console.log(`live_sha256\t${match.renderState.liveSha256}`);
    }
    if (match.renderState.liveModifiedAt) {
      console.log(`live_modified_at\t${match.renderState.liveModifiedAt}`);
    }
    if (match.renderState.marker) {
      console.log(
        `marker\t${match.renderState.marker.surfaceId ?? "unknown"}:${match.renderState.marker.bindingId ?? "unknown"}`,
      );
    }

    if (match.kind === "surface_binding") {
      const source = match.source as InstructionSurfaceTraceSource;
      console.log(`surface_id\t${source.surfaceId}`);
      console.log(`binding_id\t${source.bindingId}`);
      console.log(`binding_class\t${source.bindingClass}`);
      console.log(`manifest\t${source.manifestPath}`);
      console.log(`template\t${source.sourceRef.templatePath}`);
      if (source.reconcileStatus) {
        console.log(`reconcile_status\t${source.reconcileStatus}`);
      }
      if (source.reconcileReason) {
        console.log(`reconcile_reason\t${source.reconcileReason}`);
      }
    } else {
      const source = match.source as InstructionTemplateTraceSource;
      console.log(`template_id\t${source.templateId}`);
      console.log(`template\t${source.templatePath}`);
      console.log(`channel\t${source.channel}`);
      console.log(`template_registry\t${source.templateRegistryPath}`);
      if (source.fanoutTargetPath) {
        console.log(`fanout_target\t${source.fanoutTargetPath}`);
      }
      if (source.stagedTargetPath) {
        console.log(`staged_target\t${source.stagedTargetPath}`);
      }
    }

    if (match.partials.length > 0) {
      console.log("partials");
      for (const partial of match.partials) {
        console.log(
          `${partial.order}\t${partial.name}\t${partial.missing ? "missing" : partial.path ?? "(inline)"}`,
        );
      }
    }

    if (match.variables.length > 0) {
      console.log("variables");
      for (const variable of match.variables) {
        console.log(
          `${variable.name}\t${variable.sourceKind}\t${variable.sourcePath ?? ""}\t${variable.value ?? variable.valuePreview ?? ""}`,
        );
      }
    }
  }
}

function printInstructionStackResult(result: InstructionStackResult): void {
  const verdict = result.structural.ok ? "OK" : "FAIL";
  console.log(
    `Instruction stack ${verdict} (${result.harness}, ${result.host}, ${result.cwd})`,
  );
  console.log(
    `${result.totals.sourceCount} source(s), ${result.totals.rawLines} lines, ${result.totals.rawBytes} bytes, ~${result.totals.estimatedTokens} tokens`,
  );
  for (const source of result.sources) {
    const metrics = source.metrics;
    const metricText = metrics
      ? `${metrics.rawLines}L ${metrics.rawBytes}B ~${metrics.estimatedTokens}t${metrics.truncated ? ` included=${metrics.includedBytes}B` : ""}`
      : "not-read";
    console.log(
      `${source.order}. ${source.kind} ${source.status} ${metricText} sha256=${source.contentSha256?.slice(0, 12) ?? "-"} ${source.targetPath}`,
    );
    console.log(
      `   owner=${source.owner.value ?? "unknown"} lifecycle=${source.lifecycle.value ?? "unknown"} scope=${source.scope.value ?? "unknown"}`,
    );
    if (source.mirrorTargets.length > 0) {
      console.log(`   mirrors=${source.mirrorTargets.join(",")}`);
    }
  }
  if (result.structural.findings.length > 0) {
    console.log(`Structural findings (${result.structural.findings.length}):`);
    for (const finding of result.structural.findings) {
      const locators = finding.locators
        .map((locator) => `${locator.path}${locator.line ? `:${locator.line}` : ""}`)
        .join(", ");
      console.log(`- ${finding.code}: ${finding.message} [${locators}]`);
      if (finding.candidateOwners.length > 0) {
        console.log(`  candidate_owners=${finding.candidateOwners.join(",")}`);
      }
    }
  }
  console.log(`Advisories (${result.advisories.length}, non-blocking):`);
  for (const advisory of result.advisories) {
    const locators = advisory.locators
      .map((locator) => `${locator.path}${locator.line ? `:${locator.line}` : ""}`)
      .join(", ");
    console.log(`- ${advisory.kind} ${advisory.confidence}: ${advisory.reason} [${locators}]`);
  }
}

// ── Agent context surface ───────────────────────────────────────────

function collectAgentContextCommands(command: Command, parentPath: string[] = []): AgentContextCommandEntry[] {
  const entries: AgentContextCommandEntry[] = [];
  for (const child of command.commands) {
    const pathParts = [...parentPath, child.name()];
    const commandPath = pathParts.join(" ");
    const visibleSubcommands = child.commands.map((subcommand) => subcommand.name());
    const manifestRecord = INTERFACE_MANIFEST_RECORDS.find((record) => (
      record.invocation_kind === "commander" && record.agent_context.command_path === commandPath
    ));
    entries.push({
      path: commandPath,
      ...(child.description() ? { description: child.description() } : {}),
      subcommands: visibleSubcommands,
      ...(manifestRecord ? { mutation_class: manifestRecord.mutation_class } : {}),
    });
    entries.push(...collectAgentContextCommands(child, pathParts));
  }
  return entries;
}

const AGENT_CONTEXT_RECIPES: AgentContextRecipe[] = [
  {
    id: "runner-supervision",
    intent: "Stay on top of a Calyx-managed runner without backend-specific spelunking.",
    commands: [
      "calyx run ps --host <host> --json",
      "calyx run status --host <host> <run-id>",
      "calyx run await --host <host> <run-id> --json",
      "calyx run doctor --host <host> <run-id> --json",
      "calyx activity turns run:<run-id> --role assistant --last 1 --with-tools --json",
      "calyx activity events run:<run-id> --around-id <message-id> --within-turn --json",
    ],
    notes: [
      "Declare --artifact-root at launch for output directories whose liveness should appear in run doctor.",
      "Use run status for a one-shot lifecycle and health snapshot; use run await for finite terminal observation.",
      "run await owns terminality and success classification; do not author a polling loop or copy the run-state union.",
      "Use run doctor when artifact, log, worker pid, or GPU/resource liveness matters.",
      "Use activity turns for the latest semantic unit of agent work.",
      "Use raw events only when debugging classifier or harness payloads.",
    ],
  },
  {
    id: "review-dispatch",
    intent: "Commission a reviewer definition for a PR or branch with terminal handback binding.",
    commands: [
      "calyx review --repo <slug> --pr <n> --issue <POL> --json",
      "calyx review --adversarial --repo <slug> --pr <n> --issue <POL> --json",
      "calyx review --repo <slug> --branch <ref> --base <ref> --focus <text> --dry-run --json",
      "calyx msg thread review:<kind>:<repo>:<target> --json",
    ],
    notes: [
      "calyx review is sugar over run launch --agent reviewer or reviewer-adversarial.",
      "Dry-run returns the same resolved conduct receipt without creating a run.",
      "Default handback persists a run-spec binding; run-service sends calyx msg to the caller activity with ack_required and a locator-only body contract on terminal success or failure.",
      "The reviewer is still instructed to send the same calyx msg with the shared idempotency key, so voluntary and system terminal sends dedupe.",
      "If msg is unavailable, the run degrades to a receipt-only handback artifact and the requester can manually relay from the run artifact plus PR/Linear review comment.",
      "--no-handback is an explicit opt-out; it is not the default posture.",
    ],
  },
  {
    id: "memory-curated-facts",
    intent: "Record and recall durable curated facts (operator preferences, project state, reference data, feedback) through the strict memory store.",
    commands: [
      "calyx memory write <key> --value '<fact>' --category user|project|reference|feedback --author <id> --json",
      "calyx memory list --status pending --json",
      "calyx memory get <key> --status pending --json",
      "calyx memory approve <key> --expected-content-hash <content_hash> --author <id> --json",
      "calyx memory search <query> --json",
      "calyx memory get <key> --json",
      "calyx memory delete <key> --json",
    ],
    notes: [
      "Memory is the always-injected / 100%-blast-radius sibling of skills, so the posture is STRICT by construction (a Gemini oracle vetoed letting memory ride skills' free-write policy).",
      "memory write lands review_status=pending (NOT active); inspect the pending row with list/get --status pending, read its content_hash, then approve --expected-content-hash <content_hash> — a rewrite between read and approve is refused (exit 3), so you only ever approve the bytes you saw.",
      "The security scan is strict: ANY sharp finding (shell-destructive / exfil / credential / invisible-unicode) REJECTS the write (no row written) — there is no --gate-policy override like skills write.",
      "Default recall is approved-only: get/search/list return approved rows unless you widen with --status pending|rejected|all (get also accepts --include-unapproved) for the triage/approval-queue view.",
      "memory search is a literal case-insensitive substring over key+value+summary, NOT a semantic engine.",
      "Surfacing/injection is DEFERRED and out of scope: this store is inert — nothing here auto-injects memory into any prompt. The surfacing model (always-injected core vs check-at-will vs tiered) is the operator's open call; see docs/calyx-memory-surfacing-seed.md.",
      "Prefer memory for durable operator-relevant facts; use a Linear issue or vault note for transient task state.",
    ],
  },
  {
    id: "timing-insensitive-runner-supervision",
    intent: "Create a durable wake record for a runner instead of polling for the exact terminal moment.",
    commands: [
      "calyx run await --host <host> <run-id> --timeout 1h --json",
      "calyx monitor create --preset runner-supervision --run <run-id> --assigned-host <host> --owner interactive:<backend>:<session-id> --provenance conductor --json",
      "calyx monitor inbox --host <host> --json",
      "calyx monitor show <monitor-id> --host <host> --json",
      "calyx monitor history <monitor-id> --json",
      "calyx monitor doctor --json",
      "calyx monitor ack <wake-id> --host <host> --json",
    ],
    notes: [
      "Use this when a conductor or operator owns the wakeup; monitor create is not runner-provenance in v1.",
      "--assigned-host declares the evaluator host and remote create writes through that host's daemon; --host scopes later reads and ack/cancel mutations.",
      "runner-supervision create refuses monitor_run_unknown when the run is not resolvable in the target host store; check calyx run ps --host <host> first.",
      "The monitor wake is durable local state first. An exact interactive owner uses the same generation-bound session-ingress router, pointer-only envelope, and delivery-attempt authority as msg --wake.",
      "The portable finite observation is calyx run await. Do not add a backend-specific continuation, channel, receiver, socket, or port workflow around it.",
      "A transport-accepted wake is not proof of handling. The conductor pulls calyx monitor inbox --host <host>, handles the referenced wake, and only then runs monitor ack.",
      "Missing, expired, or failed exact-session ingress leaves the wake pullable; use show, history, and doctor to inspect the durable delivery record.",
      "Human-facing notification bindings are a separate operator notification class, not an agent wake path.",
      "A runner-supervision monitor retires itself after the terminal wake; ack consumes the pending inbox row without reactivating or deleting wake history.",
    ],
  },
  {
    id: "message-correspondence",
    intent: "Pass operational correspondence between activities, roles, hosts, and the fleet without reviving agent-mail.",
    commands: [
      "calyx msg send --to run:<run-id> --subject <subject> --body <body> --ack-required --json",
      "calyx msg send --to interactive:<backend>:<session-id> --subject <subject> --body <body> --wake --json",
      "calyx msg send --to role:<name> --host <host> --subject <subject> --body <body> --json",
      "calyx msg send --to host:<host> --subject <subject> --body <body> --ttl-ms 3600000 --json",
      "calyx msg send --to-active host:<host> --subject <subject> --body <body> --json",
      "calyx msg reply <message-id> --body <body> --json",
      "calyx msg inbox --json",
      "calyx msg inbox --peek --json",
      "calyx msg inbox --scope host:<host> --json",
      "calyx msg ack <message-id> --json",
      "calyx msg thread <thread-key> --json",
      "calyx msg doctor --json",
    ],
    notes: [
      "Sender identity is an activity id when the harness exposes one; the POL-1774 authorship alias is accepted for addressing.",
      "Directed inbox reads claim rows unless --peek is passed; ack consumes the claim without deleting the message history.",
      "Use reply as the discoverable sugar for send --reply-to; pass --to only when the inferred counterpart is wrong.",
      "spooled_at means durable-store arrival; delivered_at is only set after confirmed delivery evidence, so never treat status=pending plus spooled_at as seen.",
      "Scope addresses host:<host> and fleet are bulletin-style, peek-only, and require --ttl-ms or --expires-at.",
      "Cross-host directed correspondence writes a sender outbox row and forwards the immutable message through authenticated daemon ingress. Execution-capable recipients remain outside the Consumer API.",
      "Bare msg send is always durable-only: it may forward the message to its destination inbox, but it never launches or resumes a turn, claims a message, or acknowledges it.",
      "--wake is an explicit spool-first accelerator for one exact activity binding. Missing, expired, unsupported, or failed ingress returns delivery_state=spooled with a non-success wake_state and exit 0; do not retry the whole send.",
      "Cross-host --wake resolves only named-host admin access, preflights session.wake/v1, and sends one body-free pointer to the destination daemon; --server-url and --auth-token are rejected for this path.",
      "Transport acceptance is wake_delivered, not claimed or acked. The recipient pulls with msg inbox, which claims the directed row, handles it, and explicitly acks only afterward.",
      "Only an explicitly selected conductor lifecycle exchanges a one-use launch nonce for a generation-bound ingress lease; heartbeat renews it and matching SessionEnd retires it.",
      "Use --to-active for the current observable interactive listeners from run ps --include-interactive.",
    ],
  },
  {
    id: "task-lifecycle",
    intent: "Install, manually run, and inspect Calyx-native tasks without enabling unattended scheduling.",
    commands: [
      "calyx tasks validate --tasks-dir <dir> --json",
      "calyx tasks install <task-id> --tasks-dir <dir> --status paused --json",
      "calyx tasks run <task-id> --tasks-dir <dir> --dry-run --json",
      "calyx tasks run <task-id> --tasks-dir <dir> --json",
      "calyx tasks reconcile --tasks-dir <dir> --json",
      "calyx tasks observe codex --codex-home <dir> --codex-db <path> --tasks-dir <dir> --governance <path> --json",
      "calyx tasks doctor --json",
      "calyx tasks history <task-id-or-install-id> --json",
    ],
    notes: [
      "Install defaults to paused; resume records active trigger evaluation but unattended launch remains disabled in POL-1730 v1.",
      "Manual tasks run launches through normal Calyx run/activity surfaces unless --dry-run records a launch intent only.",
      "Predicate triggers reuse predicate/v1; RRULE manifests are translated at install time for supported daily/weekly schedules.",
      "App mutation stays off by default; lifecycle state lives in SQLite and task-run receipts export to JSONL.",
      "Codex observation is read-only: automation.toml is definition authority, SQLite is an optional runtime projection, and CLI mutation authority is unavailable.",
    ],
  },
  {
    id: "symphony-tick",
    intent: "Drive one deterministic Symphony daemon tick for a project workflow.",
    commands: [
      "calyx run daemon plan --project <project> --json",
      "calyx run daemon tick --project <project> --json",
      "calyx run daemon status --daemon-id <daemon-id> --json",
      "calyx run status --host <host> <run-id>",
    ],
    notes: [
      "Run plan first: it is the no-launch selection preview and safety verdict.",
      "Prefer --project so the daemon resolves the project-root WORKFLOW.md through fleet truth.",
      "Use --workflow <path> only for explicit operator or test overrides.",
    ],
  },
  {
    id: "state-substrate-doctor",
    intent: "Check the local v2 substrate before trusting daemon or workflow behavior.",
    commands: [
      "calyx state doctor --domain orchestration --domain run_index --json",
      "calyx self freshness --fleet --json",
      "calyx self health --fleet --json",
      "calyx self drift --fleet --against origin/main --json",
    ],
    notes: [
      "State doctor is local substrate health; self freshness is the compact fleet readiness snapshot.",
      "Use self health for running/promoted/clone version facts; use self drift for target-ref comparison.",
      "Run the fleet preflight before multi-host dispatch.",
    ],
  },
  {
    id: "lease-conflict-organ",
    intent: "Coordinate named-resource conflicts without falling back to local-only writes.",
    commands: [
      "calyx lease acquire worktree:<host>:<absolute-path> --holder <activity-id> --ttl-ms 1800000 --json",
      "calyx lease list --owner-host <host> --kind worktree --json",
      "calyx lease renew <key> --holder <activity-id> --json",
      "calyx lease steal <key> --holder <activity-id> --provenance '<why takeover is authorized>' --json",
      "calyx lease release <key> --holder <activity-id> --json",
      "calyx lease doctor --json",
    ],
    notes: [
      "Use worktree:<host>:<path>, session:<activity-id>, vault:<path>, and issue:<id> keys exactly.",
      "worktree and session leases are owned by that host; vault and issue leases are owned by the coordinator host.",
      "Unreachable owning host is a hard failure, not permission to write a local fallback row.",
      "Steal requires provenance and records previous-holder evidence; POL-1789 msg notification degrades to receipt-only when msg is not present.",
      "Calyx run dispatch refuses a worktree lease held by another holder; other consumers treat leases as advisory conflict evidence.",
    ],
  },
  {
    id: "fleet-convergence-status",
    intent: "Read persisted fleet convergence state after freshness or a partial fleet upgrade.",
    commands: [
      "calyx fleet status --json",
      "calyx fleet status --host <host> --json",
      "calyx self freshness --fleet --json",
      "calyx state doctor --domain fleet_convergence --json",
    ],
    notes: [
      "Fleet status reads local state only; it does not probe hosts.",
      "Use self freshness to refresh running/promoted/clone daemon observations before reading status.",
      "Pending rows are normal for offline or skipped hosts and should not create Linear issues.",
    ],
  },
  {
    id: "activity-recall",
    intent: "Recover recent adjacent Codex or Claude activity for grounding.",
    commands: [
      "calyx activity self --json",
      "calyx activity overview --agent-kind claude --since-hours 12 --json",
      "calyx activity list --since-hours 24 --json",
      "calyx activity messages --latest-session --backend <codex|claude> --last 10 --json",
      "calyx activity turns --latest-session --backend <codex|claude> --role assistant --last 1 --json",
      "with-polli-secrets calyx activity messages --host <host> <activity-id> --last 1 --json",
      "with-polli-secrets calyx activity attachments <activity-id> --host <host> --ref <att:sha256:digest> --extract --json",
    ],
    notes: [
      "Use activity self first when you need to name your current session for handoff or capture; local activity reads can work bare.",
      "Use activity overview for a compact birds-eye scan across recent sessions before progressively disclosing one activity.",
      "Prefer activity messages or turns over raw session files.",
      `Remote activity --host reads go through the authenticated host daemon; pass --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
      "The normal Polli path for remote host reads is with-polli-secrets calyx activity ...",
      "Use run:<id> when supervising a Calyx-managed runner and interactive:<backend>:<id> for standalone sessions.",
      "Use activity attachments to materialize image refs into the current host cache; bytes stay out of activity messages.",
    ],
  },
  {
    id: "context-capture",
    intent: "Write selected activity context into a durable vault note without building an oracle bundle.",
    commands: [
      "calyx activity self --json",
      "calyx context capture plan --from-activity self --daily --title <title> --json",
      "calyx context capture plan --from-activity latest:codex --daily --title <title> --around-text <phrase> --context 2 --json",
      "calyx context capture apply --from-activity run:<run-id> --daily --issue <issue> --title <title> --notes-file <path> --json",
    ],
    notes: [
      "Plan before apply when the note destination or selected turns are not obvious.",
      "Default capture selects human:last:1 plus assistant:last:1; pass repeatable --turn selectors for a wider handoff.",
      "Use latest:codex or latest:claude for adjacent standalone sessions; use --around-text/--around-id plus --context for a bounded message window.",
      "Use this for session handoffs and evidence notes; use ctxpack/oracle bundle only when a model-consultation packet is the actual goal.",
    ],
  },
  {
    id: "vault-context-read",
    intent: "Discover and fetch bounded vault context with stable vault URIs before assembling a context packet or MCP tool response.",
    commands: [
      "calyx vault search <query> --mode literal --limit 10 --json",
      "calyx vault fetch vault://fieldwork/<relative-path>.md --max-bytes 24000 --with-frontmatter --with-links --json",
      "calyx vault related vault://fieldwork/<relative-path>.md --relation wikilink --depth 1 --limit 10 --json",
      "calyx vault related vault://fieldwork/<relative-path>.md --relation same-issue --limit 10 --json",
    ],
    notes: [
      "Search returns canonical vault://fieldwork/... URIs; feed those URIs into fetch or related.",
      "Fetch is bounded and labels vault markdown as untrusted source content.",
      "Semantic and hybrid search modes currently return capability_unavailable diagnostics until a provider lands.",
      "Use related after fetch when the note itself points at the next context decision.",
    ],
  },
  {
    id: "vault-markdown-frontmatter-read",
    intent: "Read exact Fieldwork markdown sections and frontmatter before any vault mutation or semantic expansion.",
    commands: [
      "calyx vault toc vault://fieldwork/<path>.md --json",
      "calyx vault section get vault://fieldwork/<path>.md --heading <heading-id-or-text> --max-chars 4000 --json",
      "calyx vault frontmatter get vault://fieldwork/<path>.md --json",
      "calyx vault frontmatter query --type <type> --where '<field> == \"<value>\"' --limit 25 --json",
    ],
    notes: [
      "Use vault toc before section get so heading ids and section hashes are explicit.",
      "Use frontmatter get/query for exact local metadata predicates; keep semantic recall and cross-source provider routing under calyx knowledge.",
      "These commands are read-only and do not emit action-ledger rows.",
    ],
  },
  {
    id: "vault-footnotes-disclosure",
    intent: "Read a context note's current-state spine without paying for footnote bodies, page lineage in on demand, and attach new footnotes without hunting for edit points.",
    commands: [
      "calyx vault fetch vault://fieldwork/<path>.md --footnotes collapsed --json",
      "calyx vault footnotes list vault://fieldwork/<path>.md --json",
      "calyx vault footnotes get vault://fieldwork/<path>.md <key> --json",
      "calyx vault footnotes add vault://fieldwork/<path>.md --key <key> --anchor '<unique spine text>' --body '<demoted lineage>' --json",
      "calyx vault footnotes lint vault://fieldwork/<path>.md --json",
    ],
    notes: [
      "Collapsed fetch renders each footnote as an in-band elision marker carrying its copyable footnotes get command (POL-1737 grammar); named keys are the stable cursors.",
      "The insert verb is add, not attach: POL-1737 owns attachment for att:sha256: content refs.",
      "footnotes gc normalizes loss-lessly (relocates stray definitions, dedupes exact duplicates); orphan removal needs the explicit --drop-orphans flag.",
      "Pair with the context-note-demotion procedure (60-prompts/evergreen/curation/) when rewriting a note to spine + footnotes, and finish with calyx vault stamp.",
    ],
  },
  {
    id: "vault-journal-entries",
    intent: "Inspect and append chronological vault log entries without hand-rolled markdown splices.",
    commands: [
      "calyx vault journal entries vault://fieldwork/<path>.md --json",
      "calyx vault journal entries vault://fieldwork/<path>.md --section <heading-id-or-text> --json",
      "calyx vault journal get vault://fieldwork/<path>.md <entry-key> --json",
      "calyx vault journal append vault://fieldwork/<path>.md --title <title> --body '<markdown>' --dry-run --json",
      "calyx vault journal append vault://fieldwork/<path>.md --title <title> --body-stdin --json",
    ],
    notes: [
      "Use entries before get or append; table sections are read-only in v1.",
      "Append requires a high-confidence journal contract or declared prose/header shape; low-confidence dry-runs emit a pasteable journal: contract instead of writing.",
      "Append inserts at the log's write position, not by date sorting; backdated entries set date_out_of_order in the receipt.",
      "Applied appends stamp updated/updated_by in the same file write; there is no MCP write tool.",
    ],
  },
  {
    id: "vault-session-provenance",
    intent: "Create and verify session close-out lineage, then append the weekly radar receipt through the journal contract.",
    commands: [
      "calyx activity self --json",
      "calyx vault close-out --title '<reader-meaningful close-out>' --parent <activity-id> --spawned-by '[[handoff-note]]' --json",
      "calyx vault lineage-check --session --json",
      "calyx vault radar-receipt --week current --json",
    ],
    notes: [
      "close-out scaffolds 10-daily/<anchor>/session-closeout-<slug>.md from activity self and stamps freshness in the same workflow; pass --title/--slug when cwd would produce a generic filename.",
      "lineage-check exits non-zero when close-out discriminators are non-canonical, session is missing/invalid, parent_session does not dereference through activity, or spawned_by is prose.",
      "radar-receipt finds the current session close-out and appends a Session Receipt bullet via the weekly radar's journal contract.",
    ],
  },
  {
    id: "vault-freshness-stamp",
    intent: "Refresh a note's staleness frontmatter (updated/updated_by, last_probed) after an in-place edit without rewriting the body.",
    commands: [
      "calyx vault stamp vault://fieldwork/<path>.md --json",
      "calyx vault stamp vault://fieldwork/<path>.md --last-probed --json",
      "calyx vault stamp vault://fieldwork/<path>.md --field <field>=<value> --dry-run --json",
    ],
    notes: [
      "Direct Edit/Write/Obsidian edits do not auto-stamp updated; run stamp after any in-place body edit so downstream lanes that gate on updated see the truth.",
      "The body is byte-identical by contract; the receipt carries the body sha256 hash for verification.",
      "Identity fields (type/created/author) are refused; stamp covers staleness/provenance fields only.",
    ],
  },
  {
    id: "chatgpt-web-context-pack",
    intent: "Plan and materialize a bounded, citation-friendly context pack for ChatGPT web or MCP-style retrieval.",
    commands: [
      "calyx context plan --goal <goal> --seed vault://fieldwork/<relative-path>.md --profile chatgpt-web --budget-bytes 120000 --json",
      "calyx context plan --goal <goal> --seed '<vault search query>' --profile chatgpt-web --json",
      "calyx context pack --goal <goal> --seed vault://fieldwork/<relative-path>.md --profile chatgpt-web --plan-hash <plan-hash> --out-dir <dir> --apply --json",
      "calyx context docs --bundle-path <dir> --format markdown --json",
    ],
    notes: [
      "Use the plan command's determinism.plan_hash or data.plan_hash as the pack --plan-hash.",
      "Repeat every goal/seed/profile/budget input from plan when applying; pack recomputes the source graph and rejects mismatches.",
      "Vault source text remains untrusted evidence and is materialized as bounded files with manifest hashes.",
      "Query seeds use literal vault search in this slice; activity and capture seeds are recognized but reported as unsupported until adapters land.",
    ],
  },
  {
    id: "mcp-vault-context",
    intent: "Expose Calyx-owned read-only vault/context tools to ChatGPT or another MCP client without bypassing Calyx provenance and bounds.",
    commands: [
      "calyx mcp manifest --surface vault-context --json",
      "CALYX_CONTEXT_MCP_TOKEN=<token> calyx mcp serve --surface vault-context --host 127.0.0.1 --port 8787 --auth-token-env CALYX_CONTEXT_MCP_TOKEN --json",
      "calyx context plan --goal <goal> --seed vault://fieldwork/<relative-path>.md --profile chatgpt-web --json",
      "calyx vault fetch vault://fieldwork/<relative-path>.md --max-bytes 24000 --with-frontmatter --json",
    ],
    notes: [
      "The MCP surface is generated/validated from Calyx descriptor metadata and backing Commander paths.",
      "The server defaults to localhost and exposes no write-capable tools.",
      "Non-local/tunnel use needs token-gated serving for v0; production workspace use still needs reviewed OAuth or equivalent auth.",
      "Tool logs include tool names, source ids, byte counts, and warnings, not raw note bodies.",
    ],
  },
  {
    id: "mcp-activity-attachments",
    intent: "Expose Calyx-owned activity attachment refs and selected image refs to an MCP client without changing activity projections.",
    commands: [
      "calyx mcp manifest --surface activity-attachments --json",
      "CALYX_CONTEXT_MCP_TOKEN=<token> calyx mcp serve --surface activity-attachments --host 127.0.0.1 --port 8787 --auth-token-env CALYX_CONTEXT_MCP_TOKEN --json",
      "calyx activity attachments <activity-id> --ref <att:sha256:digest> --extract --json",
      "with-polli-secrets calyx activity attachments <activity-id> --host <host> --ref <att:sha256:digest> --extract --json",
    ],
    notes: [
      "Use activity_attachments_list or activity_attachment_record to discover refs and diagnostics without bytes.",
      "Use activity_attachment_image only for a selected image ref; successful MCP output is one image content block with no structuredContent.",
      "Remote host scope is explicit and single-host; this surface does not perform blind fleet fan-out or no-host owner discovery.",
      "Projected activity messages, turns, text, and metadata tools never inline attachment bytes.",
    ],
  },
];

function resolveAgentDefinitionInventoryPath(): string | undefined {
  const envRegistry = process.env["CALYX_AGENTS_REGISTRY"]?.trim();
  if (envRegistry) {
    return resolvePath(envRegistry.replace(/^~(?=\/|$)/, homedir()));
  }
  const envRoot = process.env["CALYX_AGENTS_INFRA_ROOT"]?.trim();
  if (envRoot) {
    return resolvePath(envRoot.replace(/^~(?=\/|$)/, homedir()), "instructions", "agents", "AGENTS.json");
  }
  return resolvePath(homedir(), "dev", "agents-infra", "dev", "instructions", "agents", "AGENTS.json");
}

function readAgentDefinitionInventory(): AgentContextPayload["agent_definitions"] {
  const source = resolveAgentDefinitionInventoryPath();
  if (!source) {
    return { source: null, status: "unconfigured", items: [] };
  }
  let registryText: string;
  try {
    registryText = readFileSync(source, "utf8");
  } catch (error) {
    return {
      source,
      status: "unreadable",
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const registry = JSON.parse(registryText) as {
      agents?: Array<{
        id?: string;
        path?: string;
        status?: string;
        lifecycle?: { status?: string };
        description?: string;
      }>;
    };
    const items = (registry.agents ?? [])
      .filter((entry) => typeof entry.id === "string" && entry.id.length > 0)
      .flatMap((entry) => {
        const definitionPath = entry.path
          ? resolvePath(dirname(source), entry.path)
          : undefined;
        let description = entry.description;
        let definitionStatus: string | undefined;
        if (definitionPath) {
          try {
            const definitionText = readFileSync(definitionPath, "utf8");
            definitionStatus = definitionText.match(/^status:\s*([^\n#]+)/m)?.[1]?.trim();
            description ??= definitionText.match(/^description:\s*["']?([^\n"']+)/m)?.[1]?.trim();
          } catch {
            // Inventory is best-effort; validation and launch own hard failures.
          }
        }
        const declaredStatuses = [entry.lifecycle?.status, entry.status, definitionStatus]
          .filter((status): status is string => Boolean(status));
        if (declaredStatuses.some((status) => status === "blocked" || status === "archived" || status === "retired")) {
          return [];
        }
        const status = entry.lifecycle?.status ?? entry.status ?? definitionStatus ?? "active";
        return [{
          id: entry.id!,
          ...(description ? { description } : {}),
          ...(status ? { status } : {}),
        }];
      });
    return { source, status: "available", items };
  } catch (error) {
    return {
      source,
      status: "unreadable",
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildAgentContextPayload(program: Command): AgentContextPayload {
  const statusCounts = {
    implemented: WRAPPER_REGISTRY.filter((def) => def.status === "implemented").length,
    retired: WRAPPER_REGISTRY.filter((def) => def.status === "retired").length,
    deprecated: WRAPPER_REGISTRY.filter((def) => def.status === "deprecated").length,
  };
  return {
    schema_version: "calyx.agent-context/v1",
    cli_version: cliPkg.version,
    generated_from: "commander-introspection",
    commands: collectAgentContextCommands(program),
    recipes: AGENT_CONTEXT_RECIPES,
    legacy_wrappers: {
      visible_in_help: false,
      invocation_policy: "preparse-diagnostics",
      implemented_count: statusCounts.implemented,
      retired_count: statusCounts.retired,
      deprecated_count: statusCounts.deprecated,
    },
    agent_definitions: readAgentDefinitionInventory(),
  };
}

async function buildAgentContextPayloadWithState(program: Command): Promise<AgentContextPayload> {
  return {
    ...buildAgentContextPayload(program),
    messages: await readAgentContextMessageSummary(),
  };
}

async function readAgentContextMessageSummary(): Promise<NonNullable<AgentContextPayload["messages"]>> {
  try {
    const opened = await openStateStore();
    try {
      const schema = checkMessageSchema(opened.db);
      if (schema.status !== "ok") {
        return {
          schema_version: "calyx.agent-context-messages/v1",
          local: {
            status: "unavailable",
            error: `message schema drift: ${schema.findings.map((finding) => finding.detail).join("; ")}`,
          },
          coordinator: { status: "best_effort_not_queried", blocking: false },
        };
      }
      return {
        schema_version: "calyx.agent-context-messages/v1",
        local: {
          status: "ok",
          counts: countPendingMessages(opened.db),
        },
        coordinator: { status: "best_effort_not_queried", blocking: false },
      };
    } finally {
      opened.db.close();
    }
  } catch (error) {
    return {
      schema_version: "calyx.agent-context-messages/v1",
      local: {
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
      coordinator: { status: "best_effort_not_queried", blocking: false },
    };
  }
}

function printAgentContextHuman(payload: AgentContextPayload): void {
  console.log(`Calyx agent context (${payload.schema_version})`);
  console.log(`cli_version: ${payload.cli_version}`);
  console.log(`commands: ${payload.commands.length}`);
  if (payload.messages) {
    if (payload.messages.local.status === "ok" && payload.messages.local.counts) {
      const counts = payload.messages.local.counts;
      console.log(
        `messages: directed_pending=${counts.directed_pending} directed_claimed=${counts.directed_claimed} scope_pending=${counts.scope_pending} outbox_pending=${counts.outbox_pending}`,
      );
    } else {
      console.log(`messages: unavailable${payload.messages.local.error ? ` (${payload.messages.local.error})` : ""}`);
    }
  }
  console.log("recipes:");
  for (const recipe of payload.recipes) {
    console.log(`- ${recipe.id}: ${recipe.intent}`);
    console.log(`  first_command: ${recipe.commands[0]}`);
  }
  const agentLine = payload.agent_definitions.items
    .map((item) => `${item.id}${item.description ? ` - ${item.description}` : ""}`)
    .join("; ");
  console.log(`agent_definitions: ${payload.agent_definitions.status}${agentLine ? ` (${agentLine})` : ""}`);
  console.log("Use --json for the complete command inventory and recipe commands.");
}

async function runAgentContextCommand(program: Command, options: AgentContextCommandOptions): Promise<void> {
  const payload = await buildAgentContextPayloadWithState(program);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printAgentContextHuman(payload);
}

// ── Extension runtime wiring ──────────────────────────────────────

/**
 * Resolve extension search paths from CLI args or CALYX_EXTENSIONS_PATH.
 */
function resolveExtensionSearchPaths(rawPaths?: string[]): string[] {
  if (rawPaths && rawPaths.length > 0) {
    return rawPaths;
  }
  const envPaths = process.env["CALYX_EXTENSIONS_PATH"];
  if (envPaths) {
    return envPaths.split(":").filter((p) => p.length > 0);
  }
  return [];
}

/** Lazy singleton: undefined = not initialized, null = no extensions. */
let _extensionRunner: ExtensionRunner | null | undefined;

/**
 * Lazily discover, load, and activate extensions. Returns null if no
 * extension search paths are configured or no extensions are found.
 */
async function getExtensionRunner(): Promise<ExtensionRunner | null> {
  if (_extensionRunner !== undefined) return _extensionRunner;

  const searchPaths = resolveExtensionSearchPaths();
  if (searchPaths.length === 0) {
    _extensionRunner = null;
    return null;
  }

  const discovery = await discoverExtensions({ searchPaths });
  const extensions = discovery.loaded
    .filter((r) => r.ok && r.extension)
    .map((r) => r.extension!);

  if (extensions.length === 0) {
    _extensionRunner = null;
    return null;
  }

  const runner = new ExtensionRunner(extensions, {
    workspaceRoot: process.cwd(),
    calyxVersion: cliPkg.version,
  });

  const activateResult = await runner.activate();
  for (const m of activateResult.messages) {
    console.error(m);
  }

  _extensionRunner = runner;
  return runner;
}

/**
 * Wire extension lifecycle hooks into a domain parent command.
 *
 * Adds commander preAction/postAction hooks so that all subcommands
 * under this domain automatically invoke beforeCommand/afterCommand
 * on any loaded extensions targeting that domain.
 */
type HookDomain = Parameters<ExtensionRunner["beforeCommand"]>[0];

function hookDomainCommand(cmd: Command, domain: HookDomain): void {
  cmd.hook("preAction", async (_thisCommand, actionCommand) => {
    const runner = await getExtensionRunner();
    if (!runner) return;

    const before = await runner.beforeCommand(domain, actionCommand.name());
    for (const m of before.messages) {
      console.error(m);
    }
    if (!before.ok) {
      throw createCliError(
        `Extension "${before.blockedBy}" blocked ${domain} ${actionCommand.name()}.`,
        7
      );
    }
  });

  cmd.hook("postAction", async (_thisCommand, actionCommand) => {
    const runner = await getExtensionRunner();
    if (!runner) return;

    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    const after = await runner.afterCommand(domain, actionCommand.name(), exitCode);
    for (const m of after.messages) {
      console.error(m);
    }
  });
}

/**
 * Build the Commander program with all canonical domain commands.
 * Legacy wrapper invocations are handled before Commander parsing so they do
 * not pollute the active help surface.
 */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  const runCliDeps = options.runCli ?? {};
  const toolchainCheckForHost = runCliDeps.toolchainCheckForHost
    ?? createProductionToolchainCheckForHost({
      currentHostAlias: runCliDeps.currentHostAlias
        ?? runCliDeps.hostname?.()
        ?? systemHostname(),
    });

  const program = new Command();
  program.name("calyx").description("Calyx control plane CLI").version(cliPkg.version);

  const config = new Command("config").description("Config compiler commands");

  config
    .command("compile")
    .description("Compile fleet/host YAML inputs to Codex TOML")
    .requiredOption("--fleet <path>", "Path to fleet.v2.yaml")
    .requiredOption("--hosts-dir <path>", "Path to hosts directory")
    .requiredOption("--host <host>", "Host key to compile")
    .option("--out <path>", "Write output TOML path")
    .option("--mode <mode>", "Validation mode (strict|advisory)", "strict")
    .option("--write", "Write TOML to --out path")
    .option("--parity <path>", "Expected TOML fixture path for semantic parity check")
    .option("--json", "Print machine-readable summary")
    .action(async (options: CompileCommandOptions) => {
      const hostPath = `${options.hostsDir}/${options.host}.yaml`;
      const compileOptions = {
        mode: options.mode,
        write: Boolean(options.write),
        ...(options.out ? { outputPath: options.out } : {})
      };
      const result = await compileFromFiles(
        {
          fleetPath: options.fleet,
          hostPath
        },
        compileOptions
      );

      let parity: { equal: boolean; reason?: string } | undefined;
      if (options.parity) {
        const expectedToml = await readFile(options.parity, "utf8");
        parity = compareTomlSemantics(result.tomlText, expectedToml);
        if (parity && !parity.equal) {
          throw new Error(`Semantic parity failed: ${parity.reason}`);
        }
      }

      if (options.json) {
        const payload = {
          host: options.host,
          warnings: result.warnings,
          wrote: Boolean(options.write && options.out),
          outputPath: options.out ?? null,
          parity
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!options.write) {
        process.stdout.write(result.tomlText);
      }

      if (result.warnings.length > 0) {
        console.error(`Validation warnings (${options.mode}):\n- ${result.warnings.join("\n- ")}`);
      }

      if (parity?.equal) {
        console.error(`Semantic parity OK for ${options.host}.`);
      }
    });

  config
    .command("show")
    .description("Show resolved source paths for all domains (config/env/defaults)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ConfigShowCommandOptions) => {
      const result = await showConfig();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.configPath) {
        console.error(`Config file: ${result.configPath} (source: ${result.configSource})`);
      } else {
        console.error("Config file: not found");
      }

      console.error("");
      for (const [domain, info] of Object.entries(result.resolved)) {
        const pathStr = info.path ?? "(not configured)";
        console.log(`${domain}\t${pathStr}\t[${info.source}]`);
      }
    });

  const instructions = new Command("instructions").description("Instructions lifecycle and render commands");

  instructions
    .command("list")
    .description("List named instruction surfaces")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--include-archived", "Include archived surfaces")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsListCommandOptions) => {
      const result = await listInstructionSurfaces(options.surfacesDir, {
        includeArchived: Boolean(options.includeArchived),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const item of result.items) {
        console.log(`${item.surfaceId}\t${item.status}\t${item.manifestPath}`);
      }
    });

  instructions
    .command("show")
    .description("Show a named instruction surface")
    .argument("<surface-id>", "Surface identifier")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--json", "Print machine-readable summary")
    .action(async (surfaceId: string, options: InstructionsShowCommandOptions) => {
      const result = await showInstructionSurface(options.surfacesDir, surfaceId);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printInstructionSurfaceShow(result);
    });

  instructions
    .command("stack")
    .description("Inspect the effective read-only instruction source stack for a working directory")
    .requiredOption("--cwd <path>", "Working directory whose inherited instruction stack should be inspected")
    .requiredOption("--harness <harness>", "Instruction resolver to model: codex or claude")
    .requiredOption("--host <host>", "Host alias selecting local installed-source provenance (not remote inspection)")
    .option("--agents-infra-root <path>", "Agents-infra source root for rendered target provenance")
    .option("--json", "Print the stable machine-readable receipt")
    .addHelpText(
      "after",
      [
        "",
        "Read-only: inspects metadata and hashes; never executes, installs, syncs, or prints instruction bodies.",
        "--host selects provenance bindings from local agents-infra truth; it does not inspect a remote host filesystem.",
        "Resolution rules are dated harness observations; re-probe after harness changes.",
        "Structural provenance findings exit 3. Prose advisories never change the exit code.",
        "",
        "Examples:",
        "  calyx instructions stack --cwd /Users/carbon/dev/polli/dev/apps/explorer/src/features/wfc4 --harness codex --host carbon --json",
        "  calyx instructions stack --cwd /Users/carbon/dev/polli/dev/apps/explorer/src/features/wfc4 --harness claude --host carbon --json",
      ].join("\n"),
    )
    .action(async (options: InstructionsStackCommandOptions) => {
      if (options.harness !== "codex" && options.harness !== "claude") {
        throw createCliError("--harness must be one of: codex, claude.", 2);
      }
      const result = await inspectInstructionStack({
        cwd: options.cwd,
        harness: options.harness,
        host: options.host,
        ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify({
          ok: result.structural.ok,
          command: "instructions.stack",
          result,
        }, null, 2));
      } else {
        printInstructionStackResult(result);
      }
      if (!result.structural.ok) process.exitCode = 3;
    });

  instructions
    .command("trace")
    .description("Trace a rendered or installed instruction file back to its source")
    .argument("<target>", "Instruction target path to trace")
    .option("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--agents-infra-root <path>", "Path to the agents-infra source tree")
    .option("--host <host>", "Host alias to use for host-scoped trace resolution")
    .option("--include-archived", "Include archived surfaces when tracing manifest-backed targets")
    .option("--include-variables", "Include resolved variable values in the trace result")
    .option("--include-partial-contents", "Include partial template contents in the JSON trace result")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx instructions trace ~/.claude/CLAUDE.md",
        "  calyx instructions trace /Users/carbon/dev/AGENTS.md --host carbon --json",
      ].join("\n"),
    )
    .action(async (target: string, options: InstructionsTraceCommandOptions) => {
      try {
        const result = await traceInstructionTarget(target, {
          ...(options.surfacesDir ? { surfacesDir: options.surfacesDir } : {}),
          ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
          ...(options.host ? { host: options.host } : {}),
          includeArchived: Boolean(options.includeArchived),
          includeVariables: Boolean(options.includeVariables),
          includePartialContents: Boolean(options.includePartialContents),
        });

        if (options.json) {
          emitCommandJsonResult("instructions.trace", result);
        } else {
          printInstructionTraceResult(result);
        }
      } catch (error) {
        if (error instanceof InstructionTraceLookupError) {
          if (options.json) {
            emitCommandJsonError("instructions.trace", {
              code: error.code,
              message: error.message,
              ...(error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
              ...(error.matches.length > 0 ? { matches: error.matches } : {}),
            });
            process.exitCode = 3;
            return;
          }

          const detailLines = [
            error.message,
            ...(error.suggestions.length > 0
              ? [`Suggestions: ${error.suggestions.join(", ")}`]
              : []),
            ...(error.matches.length > 0
              ? [`Matches: ${error.matches.join(", ")}`]
              : []),
          ];
          throw createCliError(detailLines.join("\n"), 3);
        }
        throw error;
      }
    });

  instructions
    .command("targets")
    .description("List target bindings across named instruction surfaces")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--surface <surface-id>", "Filter to a single instruction surface")
    .option("--include-archived", "Include archived surfaces")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsTargetsCommandOptions) => {
      const result = await listInstructionTargets(options.surfacesDir, {
        ...(options.surface ? { surfaceId: options.surface } : {}),
        includeArchived: Boolean(options.includeArchived),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const item of result.items) {
        console.log(`${item.surfaceId}\t${item.bindingId}\t${item.class}\t${item.path}`);
      }
    });

  instructions
    .command("reconcile")
    .description("Reconcile declared local instruction targets for a host without mutating them")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .requiredOption("--host <host>", "Host alias to reconcile")
    .option("--repo-root <path>", "Override repo_root target bindings with this checkout path")
    .option("--surface <surface-id>", "Filter to a single instruction surface")
    .option("--include-archived", "Include archived surfaces")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsReconcileCommandOptions) => {
      const result = await reconcileInstructionSurfaces(options.surfacesDir, {
        host: options.host,
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        ...(options.surface ? { surfaceId: options.surface } : {}),
        includeArchived: Boolean(options.includeArchived),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printInstructionReconcileSummary(result);
        if (result.summary.findings > 0) {
          printInstructionReconcileFindings(
            result.findings.filter((finding: InstructionReconcileFinding) => finding.status !== "managed_ok"),
          );
        }
      }

      if (result.summary.findings > 0) {
        throw createCliError(`Instruction reconcile found ${result.summary.findings} non-OK target(s).`, 3);
      }
    });

  instructions
    .command("apply")
    .description("Apply declared local instruction targets for a host, writing missing or already-managed targets")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .requiredOption("--host <host>", "Host alias to apply")
    .option("--repo-root <path>", "Override repo_root target bindings with this checkout path")
    .option("--surface <surface-id>", "Filter to a single instruction surface")
    .option("--dry-run", "Plan changes without writing")
    .option(
      "--reviewed-overwrite",
      "Allow reviewed overwrite of unmanaged divergent targets; use --dry-run first to inspect planned targets",
    )
    .option("--backup-dir <path>", "Directory for reviewed-overwrite backup files")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsMutateCommandOptions) => {
      const result = await applyInstructionSurfaces(options.surfacesDir, {
        host: options.host,
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        ...(options.surface ? { surfaceId: options.surface } : {}),
        dryRun: Boolean(options.dryRun),
        reviewedOverwrite: Boolean(options.reviewedOverwrite),
        ...(options.backupDir ? { reviewedOverwriteBackupDir: options.backupDir } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printInstructionMutationSummary(result);
        const visibleChanges = result.dryRun ? result.plannedChanges : result.changes;
        if (visibleChanges.length > 0) {
          printInstructionMutationChanges(visibleChanges);
        }
        if (result.blockedFindings.length > 0) {
          printInstructionReconcileFindings(result.blockedFindings);
        }
      }

      if (result.summary.blockedTargets > 0) {
        throw createCliError(`Instruction apply blocked on ${result.summary.blockedTargets} target(s).`, 3);
      }
    });

  instructions
    .command("adopt")
    .description("Adopt unmanaged matching local instruction targets into Calyx-managed ownership")
    .requiredOption("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .requiredOption("--host <host>", "Host alias to adopt")
    .option("--repo-root <path>", "Override repo_root target bindings with this checkout path")
    .option("--surface <surface-id>", "Filter to a single instruction surface")
    .option("--dry-run", "Plan changes without writing")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsMutateCommandOptions) => {
      const result = await adoptInstructionSurfaces(options.surfacesDir, {
        host: options.host,
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        ...(options.surface ? { surfaceId: options.surface } : {}),
        dryRun: Boolean(options.dryRun),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printInstructionMutationSummary(result);
        const visibleChanges = result.dryRun ? result.plannedChanges : result.changes;
        if (visibleChanges.length > 0) {
          printInstructionMutationChanges(visibleChanges);
        }
        if (result.blockedFindings.length > 0) {
          printInstructionReconcileFindings(result.blockedFindings);
        }
      }

      if (result.summary.blockedTargets > 0) {
        throw createCliError(`Instruction adopt blocked on ${result.summary.blockedTargets} target(s).`, 3);
      }
    });

  instructions
    .command("render")
    .description("Render named instruction surfaces or raw instruction templates")
    .option("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--surface <surface-id>", "Named surface to render")
    .option("--fleet <path>", "Path to fleet instructions YAML")
    .option("--hosts-dir <path>", "Path to host instructions directory")
    .option("--template <path>", "Path to instruction template (*.md.mustache)")
    .option("--partials-dir <path>", "Path to partial templates directory")
    .option("--host <host>", "Host alias to render")
    .option("--all", "Render all hosts under --hosts-dir")
    .option("--out-dir <path>", "Write rendered output files to this directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsBaseCommandOptions) => {
      const mode = assertInstructionMode(options, "calyx instructions render");
      const renderOptions = normalizeInstructionRenderOptions(options);
      const surfaceRef = mode === "surface" ? requireInstructionSurfaceRef(options) : undefined;
      const renderResult =
        mode === "surface"
          ? await renderInstructionSurface(
              surfaceRef!.surfacesDir,
              surfaceRef!.surfaceId,
              renderOptions,
            )
          : await renderInstructionsFromFiles(requireInstructionInputFiles(options), renderOptions);

      if (options.json) {
        console.log(JSON.stringify(renderResult, null, 2));
        return;
      }

      if ("surfaceId" in renderResult) {
        console.error(`Instruction surface render OK (${renderResult.surfaceId}, ${renderResult.results.length} host(s)).`);
      }

      const firstResult = renderResult.results[0];
      if (!options.outDir && renderResult.results.length === 1 && firstResult) {
        process.stdout.write(firstResult.output);
      }

      if (options.outDir) {
        for (const hostResult of renderResult.results) {
          if (hostResult.outputPath) {
            console.error(`Rendered ${hostResult.host} -> ${hostResult.outputPath}`);
          }
        }
      }

      printInstructionRenderWarnings(renderResult.results);
    });

  instructions
    .command("verify")
    .description("Verify named instruction surfaces or raw instruction fixtures")
    .option("--surfaces-dir <path>", "Path to instruction surface manifests directory")
    .option("--surface <surface-id>", "Named surface to verify")
    .option("--fleet <path>", "Path to fleet instructions YAML")
    .option("--hosts-dir <path>", "Path to host instructions directory")
    .option("--template <path>", "Path to instruction template (*.md.mustache)")
    .option("--partials-dir <path>", "Path to partial templates directory")
    .option("--expected-dir <path>", "Path to expected rendered outputs")
    .option("--host <host>", "Host alias to verify")
    .option("--all", "Verify all hosts under --hosts-dir")
    .option("--out-dir <path>", "Write rendered output files to this directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsVerifyCommandOptions) => {
      const mode = assertInstructionMode(options, "calyx instructions verify");
      if (mode === "raw" && !options.expectedDir) {
        throw createCliError("Instruction raw mode requires --expected-dir <path> for verify.", 2);
      }
      const renderOptions = normalizeInstructionRenderOptions(options);
      const surfaceRef = mode === "surface" ? requireInstructionSurfaceRef(options) : undefined;
      const verifyResult =
        mode === "surface"
          ? await verifyInstructionSurface(
              surfaceRef!.surfacesDir,
              surfaceRef!.surfaceId,
              {
                ...renderOptions,
                ...(options.expectedDir ? { expectedDir: options.expectedDir } : {}),
              },
            )
          : await verifyInstructionsFromFiles(requireInstructionInputFiles(options), {
              ...renderOptions,
              expectedDir: options.expectedDir!,
            });

      if (options.json) {
        console.log(JSON.stringify(verifyResult, null, 2));
      } else if (verifyResult.ok) {
        if ("surfaceId" in verifyResult) {
          console.error(`Instruction verify OK (${verifyResult.surfaceId}, ${verifyResult.results.length} host(s)).`);
        } else {
          console.error(`Instruction verify OK (${verifyResult.results.length} host(s)).`);
        }
      } else {
        for (const drift of verifyResult.drifts) {
          console.error(`[${drift.host}] drift: ${drift.reason} (${drift.expectedPath})`);
        }
      }

      if (!verifyResult.ok) {
        throw createCliError(`Instruction verify failed for ${verifyResult.drifts.length} drift(s).`, 3);
      }
    });

  const skills = new Command("skills").description("Skills registry index/sync/validate commands");

  skills
    .command("index")
    .description("Index skills from a registry")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--include-archived", "Include archived skills in index output")
    .option("--include-retired", "Include retired skills in index output")
    .option("--exclude-deprecated", "Exclude deprecated skills from index output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsIndexCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const result = await indexSkillsRegistry(registryPath, {
        includeArchived: Boolean(options.includeArchived),
        includeRetired: Boolean(options.includeRetired),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const skill of result.items) {
        const status = skill.status ?? "active";
        console.log(`${skill.id}\t${status}`);
      }
      console.error(`Indexed ${result.items.length}/${result.total} skills from ${registryPath}.`);
    });

  skills
    .command("show")
    .description("Show source, install targets, and local state for a single skill")
    .argument("<skill-id>", "Skill identifier")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--agents-infra-root <path>", "Path to the agents-infra source tree")
    .option("--check", "Exit non-zero when resolved source or local install state is not fully healthy")
    .option("--show-install-hashes", "Include expected/live skill and tree hashes")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills show fieldwork-conventions",
        "  calyx skills show fieldwork-conventions --check --json",
      ].join("\n"),
    )
    .action(async (skillId: string, options: SkillsShowCommandOptions) => {
      try {
        const result = await showSkill(skillId, {
          ...(options.registry ? { registryPath: options.registry } : {}),
          ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
          showInstallHashes: Boolean(options.showInstallHashes),
        });

        if (options.json) {
          emitCommandJsonResult("skills.show", result);
        } else {
          printSkillsShowResult(result);
        }

        if (options.check) {
          const nonOkChecks = result.validation.checks.filter((check: SkillsShowResult["validation"]["checks"][number]) =>
            check.status !== "ok",
          );
          if (nonOkChecks.length > 0) {
            if (options.json) {
              process.exitCode = 3;
              return;
            }
            throw createCliError(`skills show check failed with ${nonOkChecks.length} non-OK check(s).`, 3);
          }
        }
      } catch (error) {
        if (error instanceof SkillShowLookupError) {
          if (options.json) {
            emitCommandJsonError("skills.show", {
              code: error.code,
              message: error.message,
              ...(error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
            });
            process.exitCode = 3;
            return;
          }

          const detailLines = [
            error.message,
            ...(error.suggestions.length > 0
              ? [`Suggestions: ${error.suggestions.join(", ")}`]
              : []),
          ];
          throw createCliError(detailLines.join("\n"), 3);
        }
        throw error;
      }
    });

  skills
    .command("sync")
    .description("Sync skills from a registry into target backend(s)")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--backend <backend>", "Sync backend (claude|codex|agents|all)", "all")
    .option("--include-archived", "Include archived skills")
    .option("--include-retired", "Include retired skills")
    .option("--exclude-deprecated", "Exclude deprecated skills")
    .option("--prune-deprecated", "Plan or apply prune actions for deprecated or retired skills")
    .option(
      "--native-codex-skills",
      "Write independent ~/.codex/skills/polli entries instead of aliasing Codex skill sync to ~/.agents/skills"
    )
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsSyncCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const backend = parseSkillsBackend(options.backend);
      const result = await syncSkillsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply),
        includeArchived: Boolean(options.includeArchived),
        includeRetired: Boolean(options.includeRetired),
        includeDeprecated: !options.excludeDeprecated,
        pruneDeprecated: Boolean(options.pruneDeprecated),
        codexMode: options.nativeCodexSkills ? "native" : "alias-agents"
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("skills", result.actions);
      const actionCounts = countActionsByVerb(result.actions);
      console.error(
        `Skills sync ${result.apply ? "apply executed" : "plan generated"}: synced ${actionCounts.get("sync") ?? 0}, pruned ${actionCounts.get("prune") ?? 0}, skipped ${actionCounts.get("skip") ?? 0} for backend=${result.backend}.`
      );
    });

  skills
    .command("validate")
    .description("Validate skills registry structure and lifecycle constraints")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsValidateCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const result = await validateSkillsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Skills validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, active=${result.active}, deprecated=${result.deprecated}, archived=${result.archived}, retired=${result.retired}.`
        );
        printValidationIssues("skills", result.warnings, "warning");
        printValidationIssues("skills", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`skills validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  // ── Skill proposal lifecycle (POL-1363, wave 2.4) ──────────────────
  const skillsPropose = new Command("propose")
    .description("Create a skill proposal (create/patch/file) and record it locally")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx skills propose create fieldwork-conventions --target agents-infra --content-file SKILL.md --summary 'workflow learned in POL-1318' --json",
        "  $ calyx skills propose patch calyx-dev --target repo-local --source-root ~/dev/calyx/wt/caleb/example --diff-file change.patch --json",
        "  $ calyx skills propose file fieldwork-conventions references/example.md --target agents-infra --content-file example.md --json",
        "",
        "Proposal state is local. `propose` never edits installed harness mirrors and never runs `calyx skills sync`.",
        "Next command: calyx skills proposals show <proposal-id>.",
      ].join("\n"),
    );

  function attachProposeCommonOptions(cmd: Command): Command {
    cmd
      .option("--target <target>", `Source target (${SKILL_PROPOSAL_TARGETS.join("|")})`, "agents-infra")
      .option("--source-root <path>", "Override the resolved source-root (must not be an installed mirror)")
      .option("--summary <text>", "Short summary recorded with the proposal")
      .option("--author <id>", "Author identifier (e.g. claude:worm)")
      .option("--from-activity <activity-id>", "Origin activity id for provenance")
      .option("--from-message <message-id>", "Origin message id for provenance")
      .option("--body-file <path>", "Read content/diff body from this file (alias for --content-file/--diff-file)")
      .option("--stdin", "Read content/diff body from stdin")
      .option("--proposal-id <id>", "Override the auto-generated proposal id (tests/idempotency)")
      .option("--json", "Print machine-readable summary");
    return cmd;
  }

  function buildCreateInputFor(
    kind: SkillProposalKind,
    skillId: string,
    relativeSourceFile: string | undefined,
    options: SkillsProposeBodyOptions & {
      target?: string;
      sourceRoot?: string;
      summary?: string;
      author?: string;
      fromActivity?: string;
      fromMessage?: string;
      proposalId?: string;
    },
  ): SkillProposalCreateInput {
    const target = parseSkillProposalTarget(options.target ?? "agents-infra");
    const input: SkillProposalCreateInput = {
      skill_id: skillId,
      kind,
      target,
    };
    if (options.sourceRoot) input.source_root = options.sourceRoot;
    if (relativeSourceFile) input.relative_source_file = relativeSourceFile;
    if (options.summary) input.summary = options.summary;
    if (options.author) input.author = options.author;
    if (options.fromActivity) input.origin_activity_id = options.fromActivity;
    if (options.fromMessage) input.origin_message_id = options.fromMessage;
    if (options.proposalId) input.proposal_id = options.proposalId;
    return input;
  }

  attachProposeCommonOptions(
    skillsPropose
      .command("create")
      .description("Propose a brand-new skill source draft")
      .argument("<skill-id>", "Skill identifier (e.g. fieldwork-conventions)")
      .option("--content <text>", "Inline SKILL.md content")
      .option("--content-file <path>", "Read SKILL.md content from a file"),
  ).action(async (skillId: string, options: SkillsProposeBodyOptions & {
    target?: string;
    sourceRoot?: string;
    summary?: string;
    author?: string;
    fromActivity?: string;
    fromMessage?: string;
    proposalId?: string;
    json?: boolean;
  }) => {
    try {
      const content = await readSkillsProposeBody("content", options);
      const input = buildCreateInputFor("create", skillId, undefined, options);
      if (content !== undefined) input.content = content;
      const result = await createSkillProposalApi(input);
      if (options.json) {
        emitProposalCreatedJson(result);
      } else {
        printProposalCreatedHuman(result);
      }
    } catch (err) {
      throw mapSkillProposalError(err);
    }
  });

  attachProposeCommonOptions(
    skillsPropose
      .command("patch")
      .description("Propose a unified-diff patch against an existing skill")
      .argument("<skill-id>", "Skill identifier")
      .option("--diff <text>", "Inline unified-diff body")
      .option("--diff-file <path>", "Read unified-diff body from a file"),
  ).action(async (skillId: string, options: SkillsProposeBodyOptions & {
    target?: string;
    sourceRoot?: string;
    summary?: string;
    author?: string;
    fromActivity?: string;
    fromMessage?: string;
    proposalId?: string;
    json?: boolean;
  }) => {
    try {
      const diff = await readSkillsProposeBody("diff", options);
      const input = buildCreateInputFor("patch", skillId, undefined, options);
      if (diff !== undefined) input.diff = diff;
      const result = await createSkillProposalApi(input);
      if (options.json) {
        emitProposalCreatedJson(result);
      } else {
        printProposalCreatedHuman(result);
      }
    } catch (err) {
      throw mapSkillProposalError(err);
    }
  });

  attachProposeCommonOptions(
    skillsPropose
      .command("file")
      .description("Propose whole-file content for a relative path inside a skill")
      .argument("<skill-id>", "Skill identifier")
      .argument("<relative-source-file>", "Relative path inside the skill directory (no leading slash, no '..')")
      .option("--content <text>", "Inline file content")
      .option("--content-file <path>", "Read file content from a path"),
  ).action(async (
    skillId: string,
    relativeSourceFile: string,
    options: SkillsProposeBodyOptions & {
      target?: string;
      sourceRoot?: string;
      summary?: string;
      author?: string;
      fromActivity?: string;
      fromMessage?: string;
      proposalId?: string;
      json?: boolean;
    },
  ) => {
    try {
      const content = await readSkillsProposeBody("content", options);
      const input = buildCreateInputFor("file", skillId, relativeSourceFile, options);
      if (content !== undefined) input.content = content;
      const result = await createSkillProposalApi(input);
      if (options.json) {
        emitProposalCreatedJson(result);
      } else {
        printProposalCreatedHuman(result);
      }
    } catch (err) {
      throw mapSkillProposalError(err);
    }
  });

  skills.addCommand(skillsPropose);

  const skillsProposals = new Command("proposals")
    .description("Inspect, validate, review, and materialize local skill proposals")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx skills proposals list --status proposed --limit 10 --json",
        "  $ calyx skills proposals show <proposal-id> --json",
        "  $ calyx skills proposals validate <proposal-id> --json",
        "  $ calyx skills proposals materialize <proposal-id> --output ~/dev/agents-infra/wt/example/patches/<proposal-id>.patch --json",
        "  $ calyx skills proposals review <proposal-id> --status accepted --note 'ready to merge'",
        "",
        "Materialization writes a reviewable patch artifact and never calls `calyx skills sync`.",
      ].join("\n"),
    );

  skillsProposals
    .command("list")
    .description("List local skill proposals, bounded by --limit (default 50, max 500)")
    .option("--status <status>", `Filter by status (${SKILL_PROPOSAL_STATUSES.join("|")})`)
    .option("--skill-id <id>", "Filter by skill identifier")
    .option("--limit <n>", "Bound returned proposals (default 50, max 500)", (v: string) => parsePositiveIntegerOption(v, "--limit"))
    .option("--json", "Print machine-readable summary")
    .action(async (options: { status?: string; skillId?: string; limit?: number; json?: boolean }) => {
      try {
        const input: SkillProposalListInput = {};
        if (options.status) input.status = parseSkillProposalStatus(options.status);
        if (options.skillId) input.skill_id = options.skillId;
        if (typeof options.limit === "number") input.limit = options.limit;
        const result = await listSkillProposalsApi(input);
        if (options.json) {
          emitCommandJsonResult("skills.proposals.list", result);
          return;
        }
        if (result.proposals.length === 0) {
          console.error("no proposals match the filter");
          return;
        }
        for (const proposal of result.proposals) {
          console.log(
            `${proposal.proposal_id}\t${proposal.status}\t${proposal.kind}\t${proposal.skill_id}\t${proposal.created_at}`,
          );
        }
        console.error(`listed ${result.proposals.length} proposal(s).`);
      } catch (err) {
        throw mapSkillProposalError(err);
      }
    });

  skillsProposals
    .command("show")
    .description("Show a single proposal, its status, provenance, and event history")
    .argument("<proposal-id>", "Proposal identifier")
    .option("--json", "Print machine-readable summary")
    .action(async (proposalId: string, options: { json?: boolean }) => {
      try {
        const result = await showSkillProposal(proposalId);
        if (options.json) {
          emitCommandJsonResult("skills.proposals.show", result);
          return;
        }
        printProposalShowHuman(result);
      } catch (err) {
        throw mapSkillProposalError(err);
      }
    });

  skillsProposals
    .command("validate")
    .description("Validate a proposal's target source path, vocabulary, and payload")
    .argument("<proposal-id>", "Proposal identifier")
    .option("--actor <id>", "Actor identifier (e.g. claude:worm)")
    .option("--json", "Print machine-readable summary")
    .action(async (proposalId: string, options: { actor?: string; json?: boolean }) => {
      try {
        const result = await validateSkillProposal(proposalId, options.actor ? { actor: options.actor } : {});
        if (options.json) {
          emitCommandJsonResult("skills.proposals.validate", result);
          return;
        }
        console.error(`proposal ${result.proposal.proposal_id} validated -> status=${result.proposal.status}`);
        for (const check of result.checks) {
          console.error(`  ${check.status.toUpperCase().padEnd(5)} ${check.code}\t${check.detail}`);
        }
      } catch (err) {
        throw mapSkillProposalError(err);
      }
    });

  skillsProposals
    .command("materialize")
    .description("Write a reviewable patch artifact and transition to materialized; never invokes skills sync")
    .argument("<proposal-id>", "Proposal identifier")
    .option("--output <path>", "Explicit artifact output path")
    .option("--worktree <dir>", "Write under <worktree>/calyx-skill-proposals/")
    .option("--actor <id>", "Actor identifier")
    .option("--json", "Print machine-readable summary")
    .action(async (
      proposalId: string,
      options: { output?: string; worktree?: string; actor?: string; json?: boolean },
    ) => {
      try {
        const input: Parameters<typeof materializeSkillProposal>[1] = {};
        if (options.output) input.output_path = options.output;
        if (options.worktree) input.worktree = options.worktree;
        if (options.actor) input.actor = options.actor;
        const result = await materializeSkillProposal(proposalId, input);
        if (options.json) {
          emitCommandJsonResult("skills.proposals.materialize", result);
          return;
        }
        console.error(`proposal ${result.proposal.proposal_id} materialized -> status=${result.proposal.status}`);
        console.error(`  artifact: ${result.artifact_path}`);
        console.error(`  manifest: ${result.manifest_path}`);
        console.error("Materialization is a patch artifact only; it does not invoke `calyx skills sync`.");
      } catch (err) {
        throw mapSkillProposalError(err);
      }
    });

  skillsProposals
    .command("review")
    .description("Record a review decision (accepted/rejected/superseded); does not merge or sync")
    .argument("<proposal-id>", "Proposal identifier")
    .requiredOption(
      "--status <decision>",
      "Review decision: accepted|rejected|superseded",
    )
    .option("--actor <id>", "Reviewer identifier")
    .option("--note <text>", "Review note recorded in the event history")
    .option("--json", "Print machine-readable summary")
    .action(async (
      proposalId: string,
      options: { status: string; actor?: string; note?: string; json?: boolean },
    ) => {
      try {
        const decision = parseReviewDecision(options.status);
        const input: Parameters<typeof reviewSkillProposal>[1] = { status: decision };
        if (options.actor) input.actor = options.actor;
        if (options.note) input.note = options.note;
        const result = await reviewSkillProposal(proposalId, input);
        if (options.json) {
          emitCommandJsonResult("skills.proposals.review", result);
          return;
        }
        console.error(
          `proposal ${result.proposal.proposal_id} -> status=${result.proposal.status} (review:${decision})`,
        );
      } catch (err) {
        throw mapSkillProposalError(err);
      }
    });

  skills.addCommand(skillsProposals);

  const SKILLS_USAGE_MAX_LIMIT = 100;
  const SKILLS_USAGE_DEFAULT_LIMIT = 20;
  const SKILLS_CURATOR_RUN_DEFAULT_LIMIT = 20;
  const SKILLS_CURATOR_RUN_MAX_LIMIT = 100;

  function clampLimit(raw: number | undefined, def: number, max: number): number {
    if (typeof raw !== "number") {
      return def;
    }
    return Math.min(raw, max);
  }

  skills
    .command("usage")
    .description("Report per-skill load counts from fleet Loki telemetry (Claude 'Skill'-tool loads only)")
    .option("--since <dur>", "Loki lookback window (e.g. 7d, 24h)", (v: string) => parseLokiSince(v, "--since"), "7d")
    .option("--limit <n>", `Bound returned skills (default ${SKILLS_USAGE_DEFAULT_LIMIT}, max ${SKILLS_USAGE_MAX_LIMIT})`, (v: string) =>
      parsePositiveIntegerOption(v, "--limit"),
    )
    .option("--endpoint <url>", "Loki base URL override (default: $CALYX_LOKI_ENDPOINT or http://blade:3100)")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills usage --since 30d --json",
        "  calyx skills usage --limit 10",
        "",
        "Agent question: \"which skills are actually being loaded, and how often?\"",
      ].join("\n"),
    )
    .action(async (options: SkillsUsageCommandOptions) => {
      const limit = clampLimit(options.limit, SKILLS_USAGE_DEFAULT_LIMIT, SKILLS_USAGE_MAX_LIMIT);
      const result: SkillUsageResult = await fetchSkillUsage({
        since: options.since?.trim() || "7d",
        limit,
        ...(options.endpoint?.trim() ? { endpoint: options.endpoint.trim() } : {}),
      });

      if (options.json) {
        // JSON mode is pure: suggestions ride in result.suggestions, stderr stays silent.
        emitCommandJsonResult("skills.usage", result);
      } else {
        for (const row of result.skills) {
          console.log(`${row.skill_name}\t${row.use_count}`);
        }
        console.error(
          `usage status=${result.status} endpoint=${result.endpoint} since=${result.since} (${SKILL_USAGE_CLAUDE_ONLY_NOTE})`,
        );
        if (result.status !== "ok") {
          if (result.unavailable_reason) {
            console.error(result.unavailable_reason);
          }
          for (const suggestion of result.suggestions ?? []) {
            console.error(`  suggestion: ${suggestion}`);
          }
        }
      }
      // Degraded telemetry is not a CLI failure; exit 0 in both modes.
    });

  const skillsCurator = new Command("curator")
    .description("Stateless skill curation report: stale/unused/archival candidates on Claude-only signal (read-only)")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator status",
        "  calyx skills curator run --dry-run --json",
        "",
        "Agent question: \"which skills are stale / unused / archival candidates, and on what signal?\"",
        "Slice 0 is read-only: curator run always dry-runs and never mutates.",
      ].join("\n"),
    );

  skillsCurator
    .command("status")
    .description("Summarize registry size, provenance + lifecycle breakdown, and usage backend status")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--since <dur>", "Loki lookback window for the usage backend probe (e.g. 7d, 24h)", (v: string) => parseLokiSince(v, "--since"), "7d")
    .option("--endpoint <url>", "Loki base URL override (default: $CALYX_LOKI_ENDPOINT or http://blade:3100)")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator status",
        "  calyx skills curator status --json",
        "",
        "Agent question: \"which skills are stale / unused / archival candidates, and on what signal?\"",
      ].join("\n"),
    )
    .action(async (options: SkillsCuratorStatusCommandOptions) => {
      const resolved = await resolveAndLoadCuratorRegistry(options, "skills.curator.status");
      if (!resolved) {
        return;
      }
      const { registryPath, registry } = resolved;
      const endpoint = resolveLokiEndpoint(options.endpoint?.trim() ? { endpoint: options.endpoint.trim() } : {});
      // No limit: the curator joins against the FULL usage vector so a skill
      // ranked below a display cut-off is never misread as use_count 0.
      const usage = await fetchSkillUsage({
        since: options.since?.trim() || "7d",
        ...(options.endpoint?.trim() ? { endpoint: options.endpoint.trim() } : {}),
      });
      const report: CuratorStatusReport = summarizeCuratorStatus({
        registry: { path: registryPath, version: registry.version, skills: registry.skills },
        usage,
        endpoint,
      });

      if (options.json) {
        emitCommandJsonResult("skills.curator.status", report);
        return;
      }
      console.log(`registry\t${report.registry.path}`);
      console.log(`registry_version\t${report.registry.version}`);
      console.log(`total_skills\t${report.total_skills}`);
      console.log("provenance_breakdown");
      for (const [klass, count] of Object.entries(report.provenance_breakdown).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${klass}\t${count}`);
      }
      console.log("lifecycle_breakdown");
      for (const [status, count] of Object.entries(report.lifecycle_breakdown).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${status}\t${count}`);
      }
      console.error(`usage_backend status=${report.usage_backend.status} endpoint=${report.usage_backend.endpoint}`);
      for (const note of report.notes) {
        console.error(note);
      }
    });

  skillsCurator
    .command("run")
    .description("Compute (and with --apply, apply) curation recommendations on Claude-only signal")
    .option("--dry-run", "Compute recommendations without applying (the default)")
    .option("--apply", "Apply the deterministic archive recommendations (mutating; requires --confirm)")
    .option("--confirm", "Confirm a mutating --apply (no effect on dry-run)")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--since <dur>", "Loki lookback window for usage signal (e.g. 7d, 24h)", (v: string) => parseLokiSince(v, "--since"), "7d")
    .option("--endpoint <url>", "Loki base URL override (default: $CALYX_LOKI_ENDPOINT or http://blade:3100)")
    .option(
      "--limit <n>",
      `Bound recommendations shown (default ${SKILLS_CURATOR_RUN_DEFAULT_LIMIT}, max ${SKILLS_CURATOR_RUN_MAX_LIMIT})`,
      (v: string) => parsePositiveIntegerOption(v, "--limit"),
    )
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx skills curator run --dry-run --json",
        "  calyx skills curator run --since 30d --limit 25",
        "  calyx skills curator run --apply --confirm --json   # apply the deterministic archive",
        "",
        "Agent question: \"which skills are stale / unused / archival candidates, and on what signal?\"",
        "Default is dry-run. --apply ARCHIVES deprecated+unused db-regime skills (recoverable via",
        "`curator rollback`); it never auto-consolidates and never archives pinned skills. A non-ok",
        "usage backend BLOCKS all mutations (blind-sensor: a blind sensor never drives an actuator).",
        "POL-1834 shipped an interim WARN-mining fallback panel, NOT a clean Codex signal; the curator",
        "gates on Claude-primary usage only.",
      ].join("\n"),
    )
    .action(async (options: SkillsCuratorRunCommandOptions) => {
      const resolved = await resolveAndLoadCuratorRegistry(options, "skills.curator.run");
      if (!resolved) {
        return;
      }
      const { registryPath, registry } = resolved;
      // No limit: the curator joins against the FULL usage vector so a skill
      // ranked below a display cut-off is never misread as use_count 0.
      const usage = await fetchSkillUsage({
        since: options.since?.trim() || "7d",
        ...(options.endpoint?.trim() ? { endpoint: options.endpoint.trim() } : {}),
      });

      // APPLY path (mutating). Requires --confirm. Honors the blind-sensor gate
      // inside applyCuratorReport (refuses with a blocked receipt when usage is
      // not ok). Default (no --apply) stays the read-only dry-run report below.
      if (options.apply) {
        if (!options.confirm) {
          const message = "--apply is mutating and requires --confirm";
          if (options.json) {
            emitCommandJsonError("skills.curator.run", {
              code: "confirm_required",
              message,
              suggestions: ["re-run with --apply --confirm", "or drop --apply to see the dry-run report"],
            });
            process.exitCode = 2;
            return;
          }
          throw createCliError(message, 2);
        }
        const hostId = skillContentHostId();
        const opened = await openStateStore();
        let receipt: CuratorApplyReceipt;
        try {
          const schema = checkSkillContentSchema(opened.db);
          if (schema.status !== "ok") {
            emitSkillContentMigrationRefusal("skills.curator.run", options.json);
            return;
          }
          receipt = await applyCuratorReport({
            db: opened.db,
            registry: { path: registryPath, version: registry.version, skills: registry.skills },
            usage,
            hostId,
            dryRun: false,
          });
        } finally {
          opened.db.close();
        }

        // Blind-sensor refusal is a non-zero exit so automation notices.
        if (receipt.blocked) {
          if (options.json) {
            emitCommandJsonError("skills.curator.run", {
              code: "usage_backend_blocked",
              message: receipt.blocked.reason,
              suggestions: [
                "run on a Loki-reachable host or set CALYX_LOKI_ENDPOINT",
                "the curator never drives an auto-mutating actuator on a blind sensor",
              ],
            });
            process.exitCode = 3;
            return;
          }
          console.error(`blocked: ${receipt.blocked.reason}`);
          throw createCliError("curator apply blocked: usage backend not ok (blind-sensor contract)", 3);
        }

        if (options.json) {
          emitCommandJsonResult("skills.curator.run", receipt);
          return;
        }
        console.log(`pass_id\t${receipt.pass_id}`);
        console.log(`host\t${receipt.host_id}`);
        console.log(`rollback_cursor\t${receipt.rollback_cursor ?? "-"}`);
        console.log(`archived\t${receipt.archived.length}`);
        for (const id of receipt.archived) console.log(`  archived\t${id}`);
        console.log(`pinned_skipped\t${receipt.pinned_skipped.length}`);
        for (const id of receipt.pinned_skipped) console.log(`  pinned\t${id}`);
        console.log(`consolidate_candidates\t${receipt.consolidate_candidates.length}`);
        for (const rec of receipt.consolidate_candidates) {
          console.log(`  consolidate-candidate\t${rec.skill_id}\t<->\t${rec.consolidate_with}\tsimilarity=${rec.similarity}`);
        }
        for (const note of receipt.notes) console.error(note);
        return;
      }

      // DRY-RUN report path (read-only). Enrich with db-regime consolidation
      // candidates when the store is available so the report matches what apply
      // would surface; degrade silently to the registry-only report otherwise.
      let dbSkills: ReturnType<typeof gatherCuratorDbSkills> | undefined;
      try {
        const hostId = skillContentHostId();
        const opened = await openStateStore();
        try {
          if (checkSkillContentSchema(opened.db).status === "ok") {
            dbSkills = gatherCuratorDbSkills(opened.db, hostId);
          }
        } finally {
          opened.db.close();
        }
      } catch {
        // Store unavailable (e.g. migration not applied): fall back to the
        // registry-only report (git-regime duplicate detection is skipped).
        dbSkills = undefined;
      }

      const report: CuratorReport = computeCuratorReport({
        registry: { path: registryPath, version: registry.version, skills: registry.skills },
        usage,
        ...(dbSkills ? { dbSkills } : {}),
      });

      // Summary counts stay FULL totals; only the listed recommendations array is bounded.
      const recommendationLimit = clampLimit(
        options.limit,
        SKILLS_CURATOR_RUN_DEFAULT_LIMIT,
        SKILLS_CURATOR_RUN_MAX_LIMIT,
      );
      const limited = { ...report, recommendations: report.recommendations.slice(0, recommendationLimit) };

      if (options.json) {
        emitCommandJsonResult("skills.curator.run", limited);
        return;
      }
      console.log(`mode\t${limited.mode}`);
      console.log(`registry\t${limited.registry.path}`);
      console.log(`total_skills\t${limited.total_skills}`);
      console.log(`usage_backend\t${limited.usage_backend.status}`);
      console.log("recommendations");
      for (const recommendation of limited.recommendations) {
        const peer = recommendation.consolidate_with ? `\t<->\t${recommendation.consolidate_with}` : "";
        console.log(
          `  ${recommendation.action}\t${recommendation.skill_id}\t${recommendation.current_status}\tuse_count=${recommendation.use_count}\tsignal=${recommendation.signal_basis}${peer}`,
        );
      }
      console.error(
        `summary low-signal=${limited.summary["low-signal"]} archive-candidate=${limited.summary["archive-candidate"]} duplicate-candidate=${limited.summary["duplicate-candidate"]} consolidate-candidate=${limited.summary["consolidate-candidate"]}`,
      );
      for (const note of limited.notes) {
        console.error(note);
      }
    });

  registerSkillsCuratorMutationCommands(skillsCurator);

  skills.addCommand(skillsCurator);

  skills
    .command("write")
    .description("Write agent-owned skill content (full-document UPSERT) and re-materialize the harness mirrors")
    .argument("<name>", "Skill name (e.g. my-agent-skill)")
    .option("--content <text>", "Inline SKILL.md content (single-file common case)")
    .option("--content-file <path>", "Read SKILL.md content from a file")
    .option("--payload-file <path>", "Read a JSON map of relpath -> content (multi-file documents)")
    .option("--summary <text>", "Short summary recorded with the write")
    .option("--author <id>", "Author identifier (e.g. claude:carbon)")
    .option("--from-activity <activity-id>", "Origin activity id for provenance")
    .option("--from-message <message-id>", "Origin message id for provenance")
    .option(
      "--gate-policy <policy>",
      "Security gate policy: gate-sharpest (refuse on sharp findings) | free (record findings, do not block)",
      "gate-sharpest",
    )
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx skills write my-skill --content-file SKILL.md --summary 'first draft' --author claude:carbon --json",
        "  $ calyx skills write my-skill --payload-file payload.json --json   # multi-file: {\"SKILL.md\":\"...\",\"references/x.md\":\"...\"}",
        "",
        "The DB is the source of truth for agent-owned (regime=db) skills; this verb writes the row and",
        "immediately re-materializes every harness mirror. Codex re-reads it next prompt (live-after-rematerialize);",
        "Claude picks it up next session. Sharp scan findings are refused under gate-sharpest (use `calyx skills",
        "propose` for the reviewed path, or `--gate-policy free` to override).",
        "",
        "Agent-question: have you confirmed this content is safe to run on every fleet host? The scan is advisory, not a sandbox.",
      ].join("\n"),
    )
    .action(async (rawName: string, options: SkillsWriteOptions) => {
      // Normalize the name ONCE at the entry so the DB row and every backend
      // mirror agree (the claude mirror normalizes its dir name; agents/codex use
      // it verbatim — without this an unnormalized name split-brains the row from
      // the mirrors). The canonical name is used everywhere below.
      const name = normalizeName(rawName);
      const nameNote = name !== rawName ? `skill name normalized to ${name}` : undefined;
      const gatePolicy = parseSkillGatePolicy(options.gatePolicy);
      const payload = await assembleSkillWritePayload(options);

      // Security scan (Posture A). Under gate-sharpest, sharp findings refuse.
      const scan = scanSkillPayload(payload);
      const sharpFindings = scan.findings.filter((finding) => finding.severity === "sharp");
      if (gatePolicy === "gate-sharpest" && sharpFindings.length > 0) {
        const suggestions = [
          "use `calyx skills propose` for the reviewed path",
          "or re-run with `--gate-policy free` to override",
        ];
        if (options.json) {
          emitCommandJsonError("skills.write", {
            code: "gated_sharp_content",
            message: `refused: ${sharpFindings.length} sharp security finding(s) under gate-sharpest`,
            suggestions,
            matches: sharpFindings.map(formatSkillScanFinding),
          });
          process.exitCode = 3;
          return;
        }
        console.error(`refused: ${sharpFindings.length} sharp security finding(s) under gate-sharpest`);
        for (const finding of sharpFindings) {
          console.error(`  ${formatSkillScanFinding(finding)}`);
        }
        console.error(`Suggestions: ${suggestions.join("; ")}`);
        throw createCliError("calyx skills write gated on sharp security findings", 3);
      }

      const hostId = skillContentHostId();
      const opened = await openStateStore();
      let result: RematerializeResult;
      try {
        const schema = checkSkillContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitSkillContentMigrationRefusal("skills.write", options.json);
          return;
        }
        upsertSkillContent(opened.db, {
          host_id: hostId,
          skill_name: name,
          payload,
          ...(options.author ? { author: options.author } : {}),
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.fromActivity ? { origin_activity_id: options.fromActivity } : {}),
          ...(options.fromMessage ? { origin_message_id: options.fromMessage } : {}),
        });
        result = await rematerializeSkill({ db: opened.db, hostId, skillName: name });
      } finally {
        opened.db.close();
      }

      const visibility = { codex: "live-after-rematerialize", claude: "next-session" } as const;
      if (options.json) {
        emitCommandJsonResult("skills.write", {
          ...result,
          visibility,
          scan: { ok: scan.ok, findings: scan.findings },
          gate_policy: gatePolicy,
          ...(nameNote ? { note: nameNote } : {}),
        });
        return;
      }
      console.log(`wrote\t${name}\thost=${hostId}\thash=${result.contentHash.slice(0, 12)}\taction=${result.action}`);
      if (nameNote) {
        console.error(`note: ${nameNote}`);
      }
      for (const backend of result.backends) {
        console.error(`  ${backend.backend}\t${backend.action}\t${backend.installDir}`);
      }
      if (scan.findings.length > 0) {
        console.error(`scan: ${scan.findings.length} advisory finding(s) recorded:`);
        for (const finding of scan.findings) {
          console.error(`  ${formatSkillScanFinding(finding)}`);
        }
      }
      console.error(`visibility: codex=${visibility.codex} claude=${visibility.claude}`);
      if (!result.stamped) {
        console.error("note: a newer write landed mid-flight; materialized stamp skipped (it will re-materialize on its own pass).");
      }
    });

  skills
    .command("delete")
    .description("Tombstone agent-owned skill content and prune the harness mirrors")
    .argument("<name>", "Skill name to delete")
    .option("--summary <text>", "Short summary recorded with the delete")
    .option("--author <id>", "Author identifier (e.g. claude:carbon)")
    .option("--from-activity <activity-id>", "Origin activity id for provenance")
    .option("--from-message <message-id>", "Origin message id for provenance")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx skills delete my-skill --summary 'retired' --json",
        "",
        "Records a tombstone in the DB (the row is retained, not hard-deleted) and prunes every harness mirror.",
        "A later `calyx skills write <name>` over the tombstone recreates the skill.",
      ].join("\n"),
    )
    .action(async (rawName: string, options: { summary?: string; author?: string; fromActivity?: string; fromMessage?: string; json?: boolean }) => {
      // Normalize the name ONCE at the entry so the tombstone targets the same
      // canonical row a live write created and prunes the right mirrors.
      const name = normalizeName(rawName);
      const nameNote = name !== rawName ? `skill name normalized to ${name}` : undefined;
      const hostId = skillContentHostId();
      const opened = await openStateStore();
      let result: RematerializeResult;
      try {
        const schema = checkSkillContentSchema(opened.db);
        if (schema.status !== "ok") {
          emitSkillContentMigrationRefusal("skills.delete", options.json);
          return;
        }
        tombstoneSkillContent(opened.db, {
          host_id: hostId,
          skill_name: name,
          ...(options.author ? { author: options.author } : {}),
          ...(options.summary ? { summary: options.summary } : {}),
          ...(options.fromActivity ? { origin_activity_id: options.fromActivity } : {}),
          ...(options.fromMessage ? { origin_message_id: options.fromMessage } : {}),
        });
        result = await rematerializeSkill({ db: opened.db, hostId, skillName: name });
      } finally {
        opened.db.close();
      }

      if (options.json) {
        emitCommandJsonResult("skills.delete", {
          ...result,
          ...(nameNote ? { note: nameNote } : {}),
        });
        return;
      }
      console.log(`deleted\t${name}\thost=${hostId}\taction=${result.action}`);
      if (nameNote) {
        console.error(`note: ${nameNote}`);
      }
      for (const backend of result.backends) {
        console.error(`  ${backend.backend}\t${backend.action}\t${backend.installDir}`);
      }
    });

  skills
    .command("migrate")
    .description("Migrate a first-party (internal) skill from its git source to the agent-owned db regime")
    .argument("[skill-id]", "Skill id to migrate (omit with --all-internal)")
    .option("--all-internal", "Migrate every source.type=internal skill (requires --confirm to apply)")
    .option("--confirm", "Confirm an --all-internal apply (no effect on --dry-run)")
    .option("--dry-run", "Plan only: report the would-be content hash + payload files, write nothing")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--agents-infra-root <path>", "Path to the agents-infra source tree")
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx skills migrate calyx-dev --dry-run --json",
        "  $ calyx skills migrate calyx-dev --json   # apply: seed db-regime + re-materialize the mirrors",
        "",
        "Moves a first-party skill to the agent-owned db regime: it reads the skill's current git source,",
        "seeds skill_content (regime=db), and re-materializes every harness mirror through the SAME atomic",
        "re-materializer as `calyx skills write`. After migration the DB is the source of truth.",
        "",
        "This verb does NOT edit SOURCES.json (it lives in agents-infra, a separate repo). The result carries a",
        "next_step: set \"regime\": \"db\" on the entry in agents-infra SOURCES.json + commit, and then",
        "`calyx skills sync` will skip it (the re-materializer owns the mirror).",
        "",
        "Agent-question: are you intentionally moving a first-party skill to the agent-owned db regime? Vendored",
        "and repo-maintained skills stay git; only internal (first-party) skills migrate in Slice 2.",
      ].join("\n"),
    )
    .action(
      async (
        rawSkillId: string | undefined,
        options: {
          allInternal?: boolean;
          confirm?: boolean;
          dryRun?: boolean;
          registry?: string;
          agentsInfraRoot?: string;
          json?: boolean;
        },
      ) => {
        const dryRun = Boolean(options.dryRun);
        const allInternal = Boolean(options.allInternal);

        if (!allInternal && (!rawSkillId || rawSkillId.trim().length === 0)) {
          throw createCliError(
            "calyx skills migrate requires a <skill-id>, or --all-internal to migrate every internal skill.",
            2,
          );
        }
        if (allInternal && rawSkillId) {
          throw createCliError(
            "calyx skills migrate accepts either a <skill-id> OR --all-internal, not both.",
            2,
          );
        }
        // --all-internal apply requires explicit --confirm (dry-run is always allowed).
        if (allInternal && !dryRun && !options.confirm) {
          const message =
            "calyx skills migrate --all-internal applies to EVERY internal skill; pass --confirm to apply, or --dry-run to preview.";
          if (options.json) {
            emitCommandJsonError("skills.migrate", {
              code: "confirm_required",
              message,
              suggestions: ["re-run with --confirm to apply", "or --dry-run to preview"],
            });
            process.exitCode = 3;
            return;
          }
          throw createCliError(message, 3);
        }

        const registryPath = await resolve("skills", options.registry);
        const agentsInfraRoot = await resolveAgentsInfraRoot({
          ...(options.agentsInfraRoot ? { explicitRoot: options.agentsInfraRoot } : {}),
          registryPath,
        });
        const hostId = skillContentHostId();

        const opened = await openStateStore();
        try {
          const schema = checkSkillContentSchema(opened.db);
          if (schema.status !== "ok") {
            emitSkillContentMigrationRefusal("skills.migrate", options.json);
            return;
          }

          if (allInternal) {
            const result = await migrateAllInternalSkills({
              db: opened.db,
              hostId,
              agentsInfraRoot,
              registryPath,
              dryRun,
            });
            if (options.json) {
              emitCommandJsonResult("skills.migrate", result);
              return;
            }
            printSkillsMigrateAllResult(result);
            return;
          }

          const result = await migrateSkill({
            db: opened.db,
            skillId: rawSkillId!.trim(),
            hostId,
            agentsInfraRoot,
            registryPath,
            dryRun,
          });
          if (options.json) {
            emitCommandJsonResult("skills.migrate", result);
            return;
          }
          printSkillsMigrateResult(result);
        } catch (error) {
          if (error instanceof MigrateError) {
            if (options.json) {
              emitCommandJsonError("skills.migrate", {
                code: error.code,
                message: error.message,
                ...(error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
              });
              process.exitCode = 3;
              return;
            }
            const detailLines = [
              error.message,
              ...(error.suggestions.length > 0 ? [`Suggestions: ${error.suggestions.join("; ")}`] : []),
            ];
            throw createCliError(detailLines.join("\n"), 3);
          }
          // Map an underlying state-driver error to exit 7 (the documented
          // contract, consistent with `skills write`/`delete` and the state
          // commands); other errors keep their own exit code or default to 1.
          throw mapStateError(error);
        } finally {
          opened.db.close();
        }
      },
    );

  const plugins = new Command("plugins").description("Read-only harness plugin inventory and provenance commands");
  const pluginComponentKindsHelp = PLUGIN_COMPONENT_KINDS.join("|");

  plugins
    .command("list")
    .description("List local Codex/Claude plugin observations")
    .option("--harness <harness>", "Harness selector (codex|claude|all)", "all")
    .option("--home <path>", "Home directory to inspect (default: current user home)")
    .option("--codex-home <path>", "Codex home override (default: $CODEX_HOME or <home>/.codex)")
    .option("--claude-home <path>", "Claude home override (default: <home>/.claude)")
    .option("--include-catalog", "Include catalog-only marketplace entries")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PluginsBaseCommandOptions) => {
      const result = await listPlugins(normalizePluginsOptions(options));

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printPluginList(result.plugins);
      console.error(
        `Plugins inventory: total=${result.summary.total}, codex=${result.summary.byHarness.codex}, claude=${result.summary.byHarness.claude}.`,
      );
      if (!result.includeCatalog) {
        console.error("Catalog-only entries hidden; re-run with --include-catalog to include marketplace-only plugins.");
      }
      for (const diagnostic of result.diagnostics) {
        console.error(`[plugins] ${diagnostic.severity}: (${diagnostic.code}) ${diagnostic.message}`);
      }
    });

  plugins
    .command("show")
    .description("Show one local plugin observation by plugin or plugin@marketplace")
    .argument("<plugin-ref>", "Plugin name or plugin@marketplace")
    .option("--harness <harness>", "Harness selector (codex|claude|all)", "all")
    .option("--home <path>", "Home directory to inspect (default: current user home)")
    .option("--codex-home <path>", "Codex home override (default: $CODEX_HOME or <home>/.codex)")
    .option("--claude-home <path>", "Claude home override (default: <home>/.claude)")
    .option("--include-catalog", "Include catalog-only marketplace entries")
    .option("--json", "Print machine-readable summary")
    .action(async (pluginRefValue: string, options: PluginsBaseCommandOptions) => {
      const result = await showPlugin(pluginRefValue, normalizePluginsOptions(options));

      if (options.json) {
        if (result.matches.length === 0) {
          emitCommandJsonError("plugins.show", {
            code: "plugin_not_found",
            message: `No plugin observations matched ${pluginRefValue}.`,
          });
          process.exitCode = 3;
          return;
        }
        if (result.matches.length > 1) {
          emitCommandJsonError("plugins.show", {
            code: "plugin_ref_ambiguous",
            message: `Plugin reference ${pluginRefValue} is ambiguous; use plugin@marketplace or --harness.`,
            matches: result.matches.map(pluginRef),
          });
          process.exitCode = 3;
          return;
        }
        emitCommandJsonResult("plugins.show", result);
        return;
      }

      if (result.matches.length === 0) {
        throw createCliError(`No plugin observations matched ${pluginRefValue}.`, 3);
      }
      if (result.matches.length > 1) {
        console.error(`Matched ${result.matches.length} plugin observations for ${pluginRefValue}:`);
        printPluginList(result.matches);
        throw createCliError(`Plugin reference ${pluginRefValue} is ambiguous; use plugin@marketplace or --harness.`, 3);
      }
      printPluginDetail(result.matches[0]!);
    });

  plugins
    .command("trace")
    .description("Trace a plugin-provided component such as a skill, MCP server, app, hook, agent, or command")
    .argument("<component>", "Component identifier to trace")
    .option("--kind <kind>", `Component kind filter (${pluginComponentKindsHelp})`)
    .option("--harness <harness>", "Harness selector (codex|claude|all)", "all")
    .option("--home <path>", "Home directory to inspect (default: current user home)")
    .option("--codex-home <path>", "Codex home override (default: $CODEX_HOME or <home>/.codex)")
    .option("--claude-home <path>", "Claude home override (default: <home>/.claude)")
    .option("--include-catalog", "Include catalog-only marketplace entries")
    .option("--json", "Print machine-readable summary")
    .action(async (component: string, options: PluginsTraceCommandOptions) => {
      const kind = parsePluginComponentKind(options.kind);
      const result = await tracePluginComponent(component, {
        ...normalizePluginsOptions(options),
        ...(kind ? { kind } : {}),
      });

      if (options.json) {
        if (result.matches.length === 0) {
          emitCommandJsonError("plugins.trace", {
            code: "plugin_component_not_found",
            message: `No plugin component matched ${component}.`,
          });
          process.exitCode = 3;
          return;
        }
        emitCommandJsonResult("plugins.trace", result);
        return;
      }

      for (const match of result.matches) {
        console.log(`${match.kind}\t${match.component}\t${match.plugin.harness}\t${pluginRef(match.plugin)}`);
      }
      if (result.matches.length === 0) {
        throw createCliError(`No plugin component matched ${component}.`, 3);
      }
    });

  plugins
    .command("doctor")
    .description("Report suspicious local plugin inventory states without mutating anything")
    .option("--harness <harness>", "Harness selector (codex|claude|all)", "all")
    .option("--home <path>", "Home directory to inspect (default: current user home)")
    .option("--codex-home <path>", "Codex home override (default: $CODEX_HOME or <home>/.codex)")
    .option("--claude-home <path>", "Claude home override (default: <home>/.claude)")
    .option("--include-catalog", "Accepted for symmetry; doctor always includes catalog-only entries")
    .option("--check", "Exit non-zero when doctor reports an error")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PluginsDoctorCommandOptions) => {
      const result = await doctorPlugins(normalizePluginsOptions({ ...options, includeCatalog: true }));

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const issue of result.issues) {
          console.error(`[plugins] ${issue.severity}: (${issue.code}) ${issue.message}`);
        }
        console.error(
          `Plugins doctor ${result.ok ? "OK" : "FAILED"}: total=${result.summary.total}, info=${result.summary.info}, warnings=${result.summary.warning}, errors=${result.summary.error}.`,
        );
      }

      if (options.check && !result.ok) {
        throw createCliError("Plugins doctor found error-level issue(s).", 3);
      }
    });

  const tools = new Command("tools").description("Tools registry index/sync/validate commands");

  tools
    .command("index")
    .description("Index tools from a registry")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsIndexCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const result = await indexToolsRegistry(registryPath);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const tool of result.items) {
        console.log(`${tool.name}\t${tool.version}`);
      }
      console.error(`Indexed ${result.items.length} tools from ${registryPath}.`);
    });

  tools
    .command("sync")
    .description("Sync tools from a registry into host targets")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--host <alias>", "Single host alias to target")
    .option("--all", "Sync all known hosts")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsSyncCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const syncOptions = normalizeToolsSyncTarget(options);
      const result = await syncToolsRegistry(registryPath, syncOptions);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("tools", result.actions);
      console.error(`Tools sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for ${result.target}.`);
    });

  tools
    .command("validate")
    .description("Validate tools registry structure and version metadata")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsValidateCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const result = await validateToolsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Tools validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("tools", result.warnings, "warning");
        printValidationIssues("tools", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`tools validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  // ── Tools versions subgroup (POL-679) ────────────────────────────
  const toolsVersions = new Command("versions").description("Tool version management");

  toolsVersions
    .command("bump")
    .description("Bump the version of a named tool in the registry (plan/apply)")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .requiredOption("--tool <name>", "Tool name to bump")
    .requiredOption("--to <version>", "Target version string")
    .option("--apply", "Apply the bump (write to registry)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsVersionsBumpCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const result = await bumpToolVersion(registryPath, {
        tool: options.tool,
        to: options.to,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.action === "not-found") {
        throw createCliError(`Tool "${options.tool}" not found in registry at ${registryPath}.`, 1);
      }

      console.error(
        `[tools] ${result.action} ${result.tool}: ${result.from ?? "(new)"} -> ${result.to}`
      );
    });

  tools.addCommand(toolsVersions);

  const prompts = new Command("prompts").description("Prompts registry index/render/sync/validate commands");

  prompts
    .command("index")
    .description("Index prompts from a registry")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsIndexCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const result = await indexPromptsRegistry(registryPath);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const prompt of result.items) {
        console.log(`${prompt.id}\t${prompt.template_path}`);
      }
      console.error(`Indexed ${result.items.length} prompts from ${registryPath}.`);
    });

  prompts
    .command("sync")
    .description("Sync prompts from a registry into backend targets")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--backend <backend>", "Sync backend (claude|codex|all)", "all")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsSyncCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const backend = parsePromptsBackend(options.backend);
      const result = await syncPromptsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("prompts", result.actions);
      console.error(
        `Prompts sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for backend=${result.backend}.`
      );
    });

  prompts
    .command("render")
    .description("Render a prompt template from the registry with explicit variables")
    .requiredOption("--prompt <id>", "Prompt id to render")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--var <assignment>", "Prompt variable NAME=VALUE (repeatable)", collectOptionValues, [])
    .option("--vars-file <path>", "JSON file containing prompt variables")
    .option("--json", "Print machine-readable JSON summary")
    .action(async (options: PromptsRenderCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const fileVariables = options.varsFile ? await loadPromptVariablesFile(options.varsFile) : {};
      const cliVariables = parseTemplateVariables(
        (options.var ?? [])
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        "--var",
      );
      const result = await renderPromptTemplate({
        registryPath,
        promptId: options.prompt,
        variables: {
          ...fileVariables,
          ...cliVariables,
        },
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      process.stdout.write(result.renderedPrompt);
    });

  prompts
    .command("validate")
    .description("Validate prompts registry structure and variable contracts")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsValidateCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const result = await validatePromptsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Prompts validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("prompts", result.warnings, "warning");
        printValidationIssues("prompts", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`prompts validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const tasks = new Command("tasks").description("Task manifest and automation bridge commands");

  tasks
    .command("validate")
    .description("Validate task manifests from a directory")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--strict", "Escalate task warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: TasksValidateCommandOptions) => {
      const tasksDir = resolveTasksDir(options.tasksDir);
      const result = await validateTasks(tasksDir, {
        strict: Boolean(options.strict),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Tasks validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, active=${result.active}, draft=${result.draft}, paused=${result.paused}, retired=${result.retired}, failed_needs_attention=${result.failed_needs_attention}.`,
        );
        printValidationIssues("tasks", result.warnings, "warning");
        printValidationIssues("tasks", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`tasks validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  tasks
    .command("list")
    .description("List task manifests")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--include-paused", "Include paused tasks")
    .option("--include-retired", "Include retired tasks")
    .option("--status <status>", "Filter by task status; repeatable or comma-separated", collectOptionValues, [])
    .option("--json", "Print machine-readable summary")
    .action(async (options: TasksListCommandOptions) => {
      const statuses = parseTaskStatusFilters(options.status);
      const result = await listTasks(resolveTasksDir(options.tasksDir), {
        includePaused: Boolean(options.includePaused),
        includeRetired: Boolean(options.includeRetired),
        ...(statuses ? { statuses } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const task of result.items) {
        const installTargets = task.installTargets
          .map((target) => `${target.host}:${target.backend}${target.status ? `:${target.status}` : ""}`)
          .join(",");
        console.log(`${task.id}\t${task.status}\t${task.runtimeBackend}\t${task.name}\t${installTargets}`);
      }
      console.error(`Listed ${result.items.length}/${result.total} tasks from ${result.tasksDir}.`);
    });

  tasks
    .command("show")
    .description("Show one task manifest")
    .argument("<task-id>", "Task identifier")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--json", "Print machine-readable summary")
    .action(async (taskId: string, options: TasksShowCommandOptions) => {
      try {
        const result = await showTask(resolveTasksDir(options.tasksDir), taskId);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`id\t${result.task.id}`);
        console.log(`name\t${result.task.name}`);
        console.log(`status\t${result.task.status}`);
        console.log(`runtime_backend\t${result.task.runtime.backend}`);
        if (result.task.runtime.agent) {
          console.log(`agent\t${result.task.runtime.agent}`);
        }
        if (result.task.runtime.model) {
          console.log(`model\t${result.task.runtime.model}`);
        }
        console.log(`manifest\t${result.manifestPath}`);
      } catch (error) {
        if (error instanceof TaskLookupError) {
          const detailLines = [
            error.message,
            ...(error.suggestions.length > 0 ? [`Known tasks: ${error.suggestions.join(", ")}`] : []),
          ];
          throw createCliError(detailLines.join("\n"), 3);
        }
        throw error;
      }
    });

  tasks
    .command("install")
    .description("Install one task into local Calyx task lifecycle state")
    .argument("<task-id>", "Task identifier")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--host <host>", "Install host binding", defaultMonitorHost())
    .option("--status <status>", "Initial install status: active, paused, retired, failed_needs_attention", "paused")
    .option("--mode <mode>", "Task safety mode metadata: advisory or mutating", "advisory")
    .option("--installed-by <actor>", "Actor recorded as installer")
    .option("--json", "Print machine-readable install")
    .action(async (taskId: string, options: TasksInstallCommandOptions) => {
      const shown = await showTask(resolveTasksDir(options.tasksDir), taskId);
      const result = await withTaskRenderErrorReceipt(options.json, () =>
        withTaskState(async ({ db }) => installTask(db, {
          task: shown.task,
          manifest_path: shown.manifestPath,
          host: options.host?.trim() || defaultMonitorHost(),
          installed_by: options.installedBy?.trim() || defaultMonitorActor(),
          status: parseTaskInstallStatus(options.status),
          mode: parseTaskLaunchMode(options.mode),
          unattended_enabled: false,
          app_mutation_enabled: false,
        }))
      );
      const payload = {
        schema_version: "calyx.tasks-install/v1",
        created: result.created,
        install: result.install,
        findings: result.findings,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`${result.created ? "installed" : "updated"} task: ${result.install.install_id}`);
        console.log(`  status: ${result.install.status}`);
        console.log(`  host: ${result.install.host}`);
        console.log(`  unattended_enabled: ${result.install.unattended_enabled}`);
        console.log(`  app_mutation_enabled: ${result.install.app_mutation_enabled}`);
        printTaskFindings(result.findings);
      }
    });

  tasks
    .command("run")
    .description("Run one task manually through Calyx run lifecycle state")
    .argument("<task-id>", "Task identifier")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--host <host>", "Run host binding", "local")
    .option("--run-id <id>", "Optional Calyx run id")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--worktree-path <path>", "Override manifest workspace.cwd for this manual run")
    .option("--dry-run", "Record a task-run launch intent without launching a Calyx run", false)
    .option("--foreground", "Run the Calyx run in the foreground", false)
    .option("--json", "Print machine-readable task run")
    .action(async (taskId: string, options: TasksRunCommandOptions) => {
      const shown = await showTask(resolveTasksDir(options.tasksDir), taskId);
      const install = await withTaskState(async ({ db }) =>
        findTaskInstall(db, shown.task.id, options.host?.trim() || undefined)
      );
      const launchPolicy = install?.launch_policy
        ?? launchPolicyFromTaskManifest(shown.task, options.host?.trim() || "local", "advisory");

      if (options.dryRun) {
        const taskRun = await withTaskState(async ({ db, paths }) => {
          const row = createTaskRun(db, {
            task_id: shown.task.id,
            install_id: install?.install_id ?? null,
            trigger_kind: "manual",
            status: "launch_intent_recorded",
            mode: launchPolicy.mode,
            dry_run: true,
            launch_policy: launchPolicy,
            summary: `Manual task run dry-run recorded for ${shown.task.id}.`,
          });
          const receiptPath = await appendTaskRunJsonlReceipt(paths.stateDir, row);
          return setTaskRunReceiptPath(db, row.task_run_id, receiptPath) ?? row;
        });
        const payload = { schema_version: "calyx.tasks-run/v1", task_run: taskRun, run: null };
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`task run dry-run: ${taskRun.task_run_id}`);
        }
        return;
      }

      const service = createLocalRunService(runCliDeps, buildLocalRunServiceOptions({
        runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
        defaultWorktreeBase: defaultRunWorktreeBase(),
      }));
      const intent = buildTaskRunIntent(service, shown.task, options, launchPolicy);
      const runResult = await service.launch(intent, { detached: !options.foreground });
      const taskRun = await withTaskState(async ({ db, paths }) => {
        const row = createTaskRun(db, {
          task_id: shown.task.id,
          install_id: install?.install_id ?? null,
          trigger_kind: "manual",
          status: "launched",
          run_id: runResult.run_id,
          mode: launchPolicy.mode,
          dry_run: false,
          launch_policy: launchPolicy,
          summary: `Manual task run launched Calyx run ${runResult.run_id}.`,
        });
        const receiptPath = await appendTaskRunJsonlReceipt(paths.stateDir, row);
        const withReceipt = setTaskRunReceiptPath(db, row.task_run_id, receiptPath) ?? row;
        if (install) {
          recordTaskInstallManualRun(db, {
            install_id: install.install_id,
            task_run_id: row.task_run_id,
            run_id: runResult.run_id,
          });
        }
        return withReceipt;
      });
      const payload = { schema_version: "calyx.tasks-run/v1", task_run: taskRun, run: runResult };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`task run: ${taskRun.task_run_id}`);
        console.log(`  run_id: ${runResult.run_id}`);
        console.log(`  state: ${runResult.state}`);
        console.log(`  run_dir: ${runResult.run_dir}`);
      }
      if (options.foreground) {
        const exitCode = deriveRunRecordExitCode(runResult.record);
        if (exitCode !== 0) {
          process.exitCode = exitCode;
        }
      }
    });

  tasks
    .command("pause")
    .description("Pause an installed task")
    .argument("<task-id-or-install-id>", "Task id or install id")
    .option("--host <host>", "Disambiguate by install host")
    .option("--actor <actor>", "Actor recorded in task history")
    .option("--json", "Print machine-readable install")
    .action(async (id: string, options: TasksPauseResumeCommandOptions) => {
      const install = await withTaskState(async ({ db }) => setTaskInstallStatus(db, id, "paused", {
        host: options.host?.trim() || undefined,
        actor: options.actor?.trim() || defaultMonitorActor(),
      }));
      if (!install) throw createCliError(`task install not found: ${id}`, 4);
      const payload = { schema_version: "calyx.tasks-pause/v1", install };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else console.log(`paused task: ${install.install_id}`);
    });

  tasks
    .command("resume")
    .description("Resume an installed task without enabling unattended launch")
    .argument("<task-id-or-install-id>", "Task id or install id")
    .option("--host <host>", "Disambiguate by install host")
    .option("--actor <actor>", "Actor recorded in task history")
    .option("--json", "Print machine-readable install")
    .action(async (id: string, options: TasksPauseResumeCommandOptions) => {
      const install = await withTaskRenderErrorReceipt(options.json, () =>
        withTaskState(async ({ db }) => setTaskInstallStatus(db, id, "active", {
          host: options.host?.trim() || undefined,
          actor: options.actor?.trim() || defaultMonitorActor(),
          detail: "resumed by operator; unattended launch remains disabled",
        }))
      );
      if (!install) throw createCliError(`task install not found: ${id}`, 4);
      const payload = { schema_version: "calyx.tasks-resume/v1", install };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`resumed task: ${install.install_id}`);
        console.log(`  unattended_enabled: ${install.unattended_enabled}`);
      }
    });

  tasks
    .command("reconcile")
    .description("Compare task installs against current manifests")
    .argument("[task-id-or-install-id]", "Optional task id or install id")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--host <host>", "Filter/disambiguate by install host")
    .option("--limit <n>", "Maximum installs to inspect")
    .option("--apply", "Refresh drifted install metadata from the manifest; does not mutate apps or enable unattended launch", false)
    .option("--json", "Print machine-readable reconcile report")
    .action(async (id: string | undefined, options: TasksReconcileCommandOptions) => {
      const tasksDir = resolveTasksDir(options.tasksDir);
      const installs = await withTaskState(async ({ db }) => {
        if (id) {
          const install = findTaskInstall(db, id, options.host?.trim() || undefined);
          return install ? [install] : [];
        }
        return listTaskInstalls(db, {
            status: "all",
            ...(options.host?.trim() ? { host: options.host.trim() } : {}),
            limit: parseMonitorLimit(options.limit),
          });
      });
      const findings: TaskFinding[] = [];
      const applied: string[] = [];
      for (const install of installs) {
        let shown: Awaited<ReturnType<typeof showTask>> | undefined;
        try {
          shown = await showTask(tasksDir, install.task_id);
        } catch (error) {
          if (!(error instanceof TaskLookupError)) throw error;
        }
        findings.push(...await withTaskState(async ({ db }) =>
          reconcileTaskInstall(db, install, shown?.task, shown?.manifestPath)
        ));
        if (options.apply && shown) {
          const hasDrift = findings.some((finding) =>
            finding.install_id === install.install_id && finding.code.endsWith("-drift")
          );
          const hasBlockingFinding = findings.some((finding) =>
            finding.install_id === install.install_id && finding.severity === "error"
          );
          if (hasDrift && !hasBlockingFinding) {
            await withTaskState(async ({ db }) => installTask(db, {
              task: shown!.task,
              manifest_path: shown!.manifestPath,
              host: install.host,
              installed_by: defaultMonitorActor(),
              status: install.status,
              mode: install.mode,
              unattended_enabled: install.unattended_enabled,
              app_mutation_enabled: install.app_mutation_enabled,
            }));
            applied.push(install.install_id);
          }
        }
      }
      const payload = {
        schema_version: "calyx.tasks-reconcile/v1",
        ok: !findings.some((finding) => finding.severity === "error"),
        inspected: installs.length,
        applied,
        findings,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`task reconcile ${payload.ok ? "OK" : "found errors"}: inspected=${payload.inspected} applied=${applied.length}`);
        printTaskFindings(findings);
      }
      if (!payload.ok) {
        process.exitCode = 3;
      }
    });

  tasks
    .command("history")
    .description("Show task install and task-run history")
    .argument("[task-id-or-install-id]", "Optional task id or install id")
    .option("--limit <n>", "Maximum rows to return")
    .option("--json", "Print machine-readable history")
    .action(async (id: string | undefined, options: TasksHistoryCommandOptions) => {
      const limit = parseMonitorLimit(options.limit);
      const { history, runs } = await withTaskState(async ({ db }) => {
        const install = id ? findTaskInstall(db, id, undefined) : undefined;
        return {
          history: listTaskHistory(db, id, { limit }),
          runs: id
            ? listTaskRuns(db, {
                ...(install ? { install_id: install.install_id } : { task_id: id }),
                limit,
                status: "all",
              })
            : listTaskRuns(db, { limit, status: "all" }),
        };
      });
      const payload = {
        schema_version: "calyx.tasks-history/v1",
        count: history.length,
        history,
        task_runs: runs,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        for (const row of history) {
          console.log(`${row.history_id}  ${row.occurred_at}  ${row.event_type}  ${row.task_id}  ${row.detail ?? ""}`.trimEnd());
        }
        printTaskRunRows(runs);
      }
    });

  tasks
    .command("doctor")
    .description("Inspect task lifecycle schema and read-only Codex automation definition/projection drift")
    .option("--codex-home <path>", "Codex home containing automations/<id>/automation.toml")
    .option("--codex-db <path>", "Codex SQLite runtime projection database (opened read-only)")
    .option("--tasks-dir <path>", `Optional governing task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--governance <path>", "Optional Codex automation exemption registry YAML")
    .option("--calyx-state-db <path>", "Optional Calyx task-install database (opened read-only)")
    .option("--json", "Print machine-readable doctor report")
    .action(async (options: TasksDoctorCommandOptions) => {
      const report = await runStateDoctor({ domains: ["tasks"] });
      const installs = report.tasks.schemaParity === "ok"
        ? await withTaskState(async ({ db }) => listTaskInstalls(db, { status: "all", limit: 50 }))
        : [];
      const observationRequested = Boolean(
        options.codexHome || options.codexDb || options.tasksDir || options.governance || options.calyxStateDb,
      );
      const codexAutomations = observationRequested
        ? await observeCodexAutomations(resolveCodexObservationOptions(options))
        : null;
      const payload = {
        schema_version: "calyx.tasks-doctor/v1",
        ok: report.ok && (codexAutomations?.ok ?? true),
        tasks: report.tasks,
        domains: report.domains ?? [],
        findings: report.findings.filter((finding) => finding.code.startsWith("tasks-")),
        installs,
        codex_automations: codexAutomations,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`tasks: ${report.tasks.schemaParity}`);
        console.log(`  installs: ${report.tasks.installCount}`);
        console.log(`  task_runs: ${report.tasks.taskRunCount}`);
        printTaskInstallRows(installs);
        for (const finding of payload.findings) {
          console.log(`  ${finding.severity}: ${finding.message}`);
        }
        if (codexAutomations) {
          printCodexAutomationObservation(codexAutomations);
        }
      }
      if (!payload.ok) {
        process.exitCode = 3;
      }
    });

  const tasksObserve = new Command("observe").description("Read-only task backend observation commands");

  tasksObserve
    .command("codex")
    .description("Observe Codex automation TOML authority, governance, and optional SQLite projection drift")
    .option("--codex-home <path>", "Codex home containing automations/<id>/automation.toml")
    .option("--codex-db <path>", "Codex SQLite runtime projection database (opened read-only)")
    .option("--tasks-dir <path>", `Optional governing task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .option("--governance <path>", "Optional Codex automation exemption registry YAML")
    .option("--calyx-state-db <path>", "Optional Calyx task-install database (opened read-only)")
    .option("--json", "Print machine-readable observation")
    .action(async (options: TasksCodexObserveCommandOptions) => {
      const result = await observeCodexAutomations(resolveCodexObservationOptions(options));
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printCodexAutomationObservation(result);
      }
      if (!result.ok) {
        process.exitCode = 3;
      }
    });

  const tasksImport = new Command("import").description("Import backend task definitions into Calyx task manifests");

  tasksImport
    .command("codex")
    .description("Import Codex app automation TOML into task manifest draft(s)")
    .requiredOption("--codex-home <path>", "Codex home containing automations/<id>/automation.toml")
    .requiredOption("--out-dir <path>", "Output directory for imported task manifests")
    .option("--id <id>", "Import one Codex automation id; defaults to all automations")
    .option("--json", "Print machine-readable summary")
    .action(async (options: TasksCodexImportCommandOptions) => {
      const result = await importCodexAutomationTasks({
        codexHome: options.codexHome,
        outDir: options.outDir,
        ...(options.id ? { id: options.id } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const item of result.imported) {
        console.error(`[tasks] imported codex ${item.id} -> ${item.outputPath}`);
        printValidationIssues("tasks", item.warnings, "warning");
      }
    });

  const tasksRender = new Command("render").description("Render task manifests to backend install files");

  tasksRender
    .command("codex")
    .description("Render one task as a Codex app automation.toml")
    .argument("<task-id>", "Task identifier")
    .option("--tasks-dir <path>", `Path to task manifest directory (or set ${DEFAULT_TASKS_DIR_ENV})`)
    .requiredOption("--out-dir <path>", "Output directory for rendered automations")
    .option("--host <host>", "Select a Codex app install target by host")
    .option("--json", "Print machine-readable summary")
    .action(async (taskId: string, options: TasksCodexRenderCommandOptions) => {
      const result = await withTaskRenderErrorReceipt(options.json, () =>
        renderCodexAutomationTask({
          taskId,
          tasksDir: resolveTasksDir(options.tasksDir),
          outDir: options.outDir,
          ...(options.host ? { host: options.host } : {}),
        })
      );

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`[tasks] rendered codex ${result.id} (${result.host}) -> ${result.automationPath}`);
      printValidationIssues("tasks", result.warnings, "warning");
    });

  tasks.addCommand(tasksImport);
  tasks.addCommand(tasksRender);
  tasks.addCommand(tasksObserve);

  const agents = new Command("agents").description("Agent-definition registry commands");
  const retireAgentsVerb = (verb: string) => async (): Promise<void> => {
    const message = `calyx agents ${verb} is retired by POL-1799. Use calyx agents list|show|validate against instructions/agents/AGENTS.json; harness projection belongs to POL-1800.`;
    console.error(message);
    throw createCliError(message, 2);
  };

  agents
    .command("list")
    .description("List launchable agent definitions from instructions/agents/AGENTS.json")
    .option("--registry <path>", "Path to agents AGENTS.json registry (or set CALYX_AGENTS_REGISTRY)")
    .option("--include-blocked", "Include non-launchable blocked definitions in list output")
    .option("--include-archived", "Include archived definitions in list output")
    .option("--include-retired", "Include retired definitions in list output")
    .option("--exclude-deprecated", "Exclude deprecated definitions from list output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsListCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await indexAgentsRegistry(registryPath, {
        includeBlocked: Boolean(options.includeBlocked),
        includeArchived: Boolean(options.includeArchived),
        includeRetired: Boolean(options.includeRetired),
        includeDeprecated: !options.excludeDeprecated,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const agent of result.items) {
        console.log(`${agent.id}\t${agent.status}\t${agent.description ?? ""}`);
      }
      console.error(`Listed ${result.items.length}/${result.total} agent definitions from ${registryPath}.`);
    });

  agents
    .command("show")
    .description("Show one agent definition")
    .argument("<agent-id>", "Agent definition id")
    .option("--registry <path>", "Path to agents AGENTS.json registry (or set CALYX_AGENTS_REGISTRY)")
    .option("--json", "Print machine-readable summary")
    .action(async (agentId: string, options: AgentsShowCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await showAgentDefinition(registryPath, agentId);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${result.agent.id}\t${result.status}\t${result.agent.description}`);
      if (result.lifecycle?.blocked_reason) {
        console.log(`blocked_reason: ${result.lifecycle.blocked_reason}`);
      }
      if (result.lifecycle?.blocked_by?.length) {
        console.log(`blocked_by: ${result.lifecycle.blocked_by.join(", ")}`);
      }
      console.log(`definition_path: ${result.definition_path}`);
      console.log(`template: ${result.agent.persona.template}`);
      const inputNames = Object.keys(result.agent.inputs ?? {});
      console.log(`inputs: ${inputNames.length > 0 ? inputNames.join(", ") : "none"}`);
      console.log(`required_artifacts: ${(result.agent.output?.required_artifacts ?? []).join(", ") || "none"}`);
    });

  for (const retiredVerb of ["index", "render-profiles", "deploy", "sync"]) {
    agents
      .command(retiredVerb)
      .description(`Retired POL-534 agents ${retiredVerb} surface`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(retireAgentsVerb(retiredVerb));
  }

  agents
    .command("validate")
    .description("Validate agent-definition registry structure and definition contracts")
    .option("--registry <path>", "Path to agents AGENTS.json registry (or set CALYX_AGENTS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsValidateCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await validateAgentsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Agents validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, active=${result.active}, blocked=${result.blocked}, deprecated=${result.deprecated}, archived=${result.archived}, retired=${result.retired}.`
        );
        printValidationIssues("agents", result.warnings, "warning");
        printValidationIssues("agents", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`agents validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const knowledge = new Command("knowledge").description("Knowledge artifact index/search/link/validate commands");

  knowledge
    .command("index")
    .description("Index knowledge artifacts from a registry")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .option("--kind <kind>", "Filter by artifact kind")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeIndexCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await indexKnowledgeRegistry(registryPath, {
        ...(options.kind ? { kind: parseKnowledgeKind(options.kind) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const artifact of result.items) {
        console.log(`${artifact.id}\t${artifact.kind}\t${artifact.title}`);
      }
      console.error(`Indexed ${result.items.length}/${result.total} artifacts from ${registryPath}.`);
    });

  knowledge
    .command("search")
    .description("Search knowledge artifacts by query")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .requiredOption("--query <query>", "Search query string")
    .option("--kind <kind>", "Filter by artifact kind")
    .option("--tags <tags>", "Comma-separated tag filter")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeSearchCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await searchKnowledgeRegistry(registryPath, {
        query: options.query,
        ...(options.kind ? { kind: parseKnowledgeKind(options.kind) } : {}),
        ...(options.tags ? { tags: options.tags.split(",").map((t) => t.trim()) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const artifact of result.items) {
        console.log(`${artifact.id}\t${artifact.kind}\t${artifact.title}`);
      }
      console.error(`Found ${result.total} artifact(s) matching "${result.query}".`);
    });

  knowledge
    .command("link")
    .description("Link a knowledge artifact to a Linear issue")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .requiredOption("--artifact <id>", "Artifact ID to link")
    .requiredOption("--issue <id>", "Linear issue ID to link to")
    .option("--apply", "Apply the link action")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeLinkCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await linkKnowledgeArtifact(registryPath, {
        artifactId: options.artifact,
        issueId: options.issue,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`[knowledge] ${result.action} ${result.artifactId} -> ${result.issueId}`);
    });

  knowledge
    .command("validate")
    .description("Validate knowledge registry structure and artifact contracts")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeValidateCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await validateKnowledgeRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Knowledge validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("knowledge", result.warnings, "warning");
        printValidationIssues("knowledge", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`knowledge validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  // ── Knowledge execplan subgroup (POL-679) ─────────────────────────
  const knowledgeExecplan = new Command("execplan").description("ExecPlan management");

  knowledgeExecplan
    .command("new")
    .description("Create a canonical ExecPlan scaffold (plan/apply)")
    .requiredOption("--title <title>", "ExecPlan title")
    .option("--issue-id <id>", "Associated Linear issue ID")
    .option("--kind <kind>", "ExecPlan kind: implementation, planning, research")
    .option("--state <state>", "ExecPlan state: draft, ready, in_progress, done, blocked, superseded")
    .option("--owner <owner>", "Frontmatter owner (default: polli-labs)")
    .option("--scope <scope>", "Frontmatter scope (default: repo)")
    .option("--target-repo <repo>", "Target repository name")
    .option("--target-branch <branch>", "Target repository branch")
    .option("--target-workdir <path>", "Target workdir path")
    .option("--target-host <host>", "Target host (repeatable)", collectOptionValues, [])
    .option("--runner-harness <harness>", "Runner harness: codex-cli, claude-code, human")
    .option("--runner-mode <mode>", "Runner mode: interactive, exec")
    .option("--out-path <path>", "Output file path for the scaffold")
    .option("--apply", "Write scaffold to file")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeExecPlanNewCommandOptions) => {
      const kind = parseExecPlanKind(options.kind);
      const state = parseExecPlanState(options.state);
      const runnerHarness = parseExecPlanRunnerHarness(options.runnerHarness);
      const runnerMode = parseExecPlanRunnerMode(options.runnerMode);
      const result = await createExecPlan({
        title: options.title,
        ...(options.issueId ? { issueId: options.issueId } : {}),
        ...(kind ? { kind } : {}),
        ...(state ? { state } : {}),
        ...(options.owner ? { owner: options.owner } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.targetRepo ? { targetRepo: options.targetRepo } : {}),
        ...(options.targetBranch ? { targetBranch: options.targetBranch } : {}),
        ...(options.targetWorkdir ? { targetWorkdir: options.targetWorkdir } : {}),
        ...(options.targetHost && options.targetHost.length > 0 ? { targetHosts: options.targetHost } : {}),
        ...(runnerHarness ? { runnerHarness } : {}),
        ...(runnerMode ? { runnerMode } : {}),
        ...(options.outPath ? { outPath: options.outPath } : {}),
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`[knowledge] ${result.action} ${result.id}: "${result.title}"`);
      if (result.outPath) {
        console.error(`[knowledge] output: ${result.outPath}`);
      }
    });

  knowledgeExecplan
    .command("promote")
    .description("Promote a scaffold or compatible draft into fieldwork")
    .argument("<file>", "Input ExecPlan markdown file")
    .option("--title <title>", "Override inferred title")
    .option("--issue-id <id>", "Override inferred Linear issue ID")
    .option("--project <slug>", "Optional project slug for fieldwork frontmatter")
    .option("--workstream <slug>", "Optional workstream slug for fieldwork frontmatter")
    .option("--author <author>", "Override fieldwork author")
    .option("--assignee <who>", "Optional assignee frontmatter")
    .option("--updated <ts>", "Optional updated timestamp")
    .option("--updated-by <who>", "Optional updated_by frontmatter")
    .option("--status <status>", "Status field (default: active)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--dry-run", "Print what would be promoted without writing")
    .option("--json", "Print machine-readable summary")
    .action(async (inputFile: string, options: KnowledgeExecPlanPromoteCommandOptions) => {
      const result = await promoteExecPlan({
        inputPath: inputFile,
        ...(options.title ? { title: options.title } : {}),
        ...(options.issueId ? { issueId: options.issueId } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.workstream ? { workstream: options.workstream } : {}),
        ...(options.author ? { author: options.author } : {}),
        ...(options.assignee ? { assignee: options.assignee } : {}),
        ...(options.updated ? { updated: options.updated } : {}),
        ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
        dryRun: Boolean(options.dryRun),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.dryRun) {
        console.log(`[dry-run] Would promote to: ${result.outputPath}`);
        console.log(`[dry-run] Vault-relative: ${result.relativePath}`);
        console.log("---");
        console.log(result.content);
        return;
      }

      console.error(`[knowledge] promote ${result.sourcePath} -> ${result.outputPath}`);
      console.log(result.outputPath);
    });

  knowledge.addCommand(knowledgeExecplan);

  // ── Knowledge docstore subgroup (POL-679) ─────────────────────────
  const knowledgeDocstore = new Command("docstore").description("Docstore adapter for knowledge artifacts");

  for (const verb of ["search", "get", "list"] as const) {
    const cmd = knowledgeDocstore.command(verb)
      .description(`Delegate ${verb} to docstore backend`)
      .option("--json", "Print machine-readable summary");

    if (verb === "search") {
      cmd.requiredOption("--query <query>", "Search query");
    }
    if (verb === "get") {
      cmd.requiredOption("--id <id>", "Artifact ID to retrieve");
    }

    cmd.action(async (options: KnowledgeDocstoreCommandOptions) => {
      const result = await docstoreAdapter({
        verb: parseDocstoreVerb(verb),
        ...(options.query ? { query: options.query } : {}),
        ...(options.id ? { id: options.id } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.delegated) {
        console.log(result.output);
      } else {
        console.error(result.output);
        if (result.exitCode !== 0) {
          throw createCliError(result.output, result.exitCode);
        }
      }
    });
  }

  knowledge.addCommand(knowledgeDocstore);

  const context = new Command("context").description("Ctxpack v1 contract command surface");

  context
    .command("capabilities")
    .description("Emit ctxpack contract capabilities for v1")
    .option("--include-undetected", "Include undetected adapter/provider entries", false)
    .option("--providers <providers>", "Comma-separated provider ids filter (e.g. claude,codex,gemini,hermes)")
    .option("--json", "Print machine-readable JSON envelope")
    .action(async (options: ContextPrimitiveCommandOptions) => {
      await runContextPrimitiveCommand("capabilities", options);
    });

  context
    .command("plan")
    .description("Ctxpack plan contract stub (v1 frozen interface)")
    .option("--roots <paths>", "Comma-separated root paths (default: .)")
    .option("--include <paths>", "Comma-separated include path list")
    .option("--exclude <paths>", "Comma-separated exclude path list")
    .option("--goal <text>", "Planning goal for source graph context selection")
    .option("--seed <seed>", "Vault URI, query, path, activity id, or capture ref seed (repeatable)", collectOptionValues, [])
    .option("--profile <profile>", "Context profile (default|chatgpt-web)")
    .option("--vault-path <path>", "Override fieldwork vault root for vault-backed source graph planning")
    .option("--include-sessions", "Include harness sessions in plan output", false)
    .option("--include-git-meta", "Include git metadata in plan output", true)
    .option("--budget-bytes <n>", "Max bytes budget")
    .option("--budget-tokens <n>", "Max tokens budget")
    .option("--json", "Print machine-readable JSON envelope")
    .action(async (options: ContextPrimitiveCommandOptions) => {
      await runContextPrimitiveCommand("plan", options);
    });

  context
    .command("pack")
    .description("Materialize deterministic ctxpack bundle manifests with redaction + truncation receipts")
    .option("--goal <text>", "Planning goal for source graph context selection")
    .option("--seed <seed>", "Vault URI, query, path, activity id, or capture ref seed (repeatable)", collectOptionValues, [])
    .option("--profile <profile>", "Context profile (default|chatgpt-web)")
    .option("--vault-path <path>", "Override fieldwork vault root for vault-backed source graph planning")
    .option("--include <paths>", "Comma-separated include path list")
    .option("--exclude <paths>", "Comma-separated exclude path list")
    .option("--budget-bytes <n>", "Max bytes budget")
    .option("--budget-tokens <n>", "Max tokens budget")
    .option("--plan-hash <hash>", "Plan hash from normalized ctxpack plan inputs")
    .option("--out-dir <path>", "Output bundle directory")
    .option("--apply", "Write bundle artifacts to disk (default: plan-only)", false)
    .option("--redaction-mode <mode>", "Redaction mode (strict|advisory)")
    .option("--json", "Print machine-readable JSON envelope")
    .action(async (options: ContextPrimitiveCommandOptions) => {
      await runContextPrimitiveCommand("pack", options);
    });

  context
    .command("docs")
    .description("Render deterministic bundle docs from bundle manifest/summary receipts")
    .requiredOption("--bundle-path <path>", "Bundle path to render docs from")
    .option("--format <format>", "Output format (markdown|json)")
    .option("--topic <topic>", "Optional section filter (bundle|profile|sources|files|redaction|truncation)")
    .option("--json", "Print machine-readable JSON envelope")
    .action(async (options: ContextPrimitiveCommandOptions) => {
      await runContextPrimitiveCommand("docs", options);
    });

  context
    .command("introspect")
    .description("Render experimental introspection metrics from bundle receipts")
    .requiredOption("--bundle-path <path>", "Bundle path to introspect")
    .option("--enable-experimental", "Enable contract-gated introspect execution", false)
    .option("--target <target>", "Optional target filter (roots|extensions)")
    .option("--json", "Print machine-readable JSON envelope")
    .action(async (options: ContextPrimitiveCommandOptions) => {
      await runContextPrimitiveCommand("introspect", options);
    });

  const contextCapture = new Command("capture").description("Capture selected Calyx context into durable vault notes");

  for (const mode of ["plan", "apply"] as const) {
    contextCapture
      .command(mode)
      .description(mode === "plan"
        ? "Preview a session/run context capture note without writing it"
        : "Write a session/run context capture note plus a JSON receipt")
      .requiredOption("--from-activity <id>", "Activity selector: self, latest:<backend>, run:<id>, interactive:<backend>:<id>, or a resolvable prefix")
      .option("--turn <selector>", "Turn selector <role>:<first|last>:<count>; repeatable, e.g. human:last:1", collectOptionValues, [])
      .option("--around-id <message-id>", "Also include context messages around a known message id")
      .option("--around-text <text>", "Also include context messages around matching text")
      .option("--context <n>", "Messages on each side for --around-id/--around-text")
      .option("--max-text-chars <n>", "Maximum message text characters per selected turn/context message", "4000")
      .option("--type <type>", "Vault content type: execplan, report, context, project, workstream, prompt, library, meta")
      .option("--daily", "Write to 10-daily/YYYY-MM-DD/ regardless of --type")
      .requiredOption("--title <title>", "Vault note title")
      .option("--issue <POL-XXX>", "Linear issue link")
      .option("--project <slug>", "Stable project slug for project/workstream notes")
      .option("--workstream <slug>", "Stable workstream slug for workstream notes")
      .option("--author <author>", "Override capture author")
      .option("--status <status>", "Status field (default: active)")
      .option("--notes <text>", "Additional operator/agent framing notes")
      .option("--notes-file <path>", "Read additional framing notes from a file")
      .option("--vault-path <path>", "Override fieldwork vault root")
      .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
      .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
      .option("--server-url <url>", "Remote RunService base URL")
      .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
      .option("--json", "Print machine-readable capture result")
      .addHelpText(
        "after",
        [
          "",
          "Examples:",
          "  calyx context capture plan --from-activity self --daily --title \"Session Handoff\" --turn human:last:1 --turn assistant:last:1 --json",
          "  calyx context capture plan --from-activity latest:codex --daily --title \"Recent Codex Handoff\" --around-text \"next step\" --context 2 --json",
          "  calyx context capture apply --from-activity run:<run-id> --daily --issue POL-1513 --title \"Runner Handoff\" --notes-file handoff.md --json",
          "",
          "Default selector: human:last:1 plus assistant:last:1.",
          "Truncation metadata is written to the JSON result, receipt, and note summary.",
        ].join("\n"),
      )
      .action(async (options: ContextCaptureCommandOptions) => {
        const result = await contextCaptureCommand(mode, options, runCliDeps);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const label = mode === "plan" ? "[dry-run] Would write" : "Wrote";
        console.log(`${label}: ${result.vault.output_path}`);
        if (result.receipt_path) {
          console.log(`Receipt: ${result.receipt_path}`);
        }
        for (const warning of result.warnings) {
          console.error(`[calyx context capture] warning: ${warning.code}: ${warning.message}`);
        }
      });
  }

  context.addCommand(contextCapture);

  const contextFixtures = new Command("fixtures").description("Fixture corpus workflows for context primitives");

  contextFixtures
    .command("run")
    .description("Execute the deterministic context fixture corpus and emit a receipt")
    .option(
      "--catalog <path>",
      "Fixture catalog JSON path",
      "fixtures/context/v1/corpus.catalog.json"
    )
    .requiredOption("--receipt <path>", "Receipt output path")
    .option("--fail-fast", "Stop on first fixture failure", false)
    .option("--json", "Print machine-readable summary")
    .action(async (options: ContextFixtureRunCommandOptions) => {
      await runContextFixtureCorpusCommand(options);
    });

  context.addCommand(contextFixtures);

  context.addHelpText(
    "after",
    `\nContract v1 primitives: capabilities, plan, pack, docs, introspect\nContext capture: context capture plan|apply --from-activity <id|self> --daily --title <title>\nFixture corpus: context fixtures run --catalog <path> --receipt <path>\nExit semantics: ${formatContextExitSemantics()}\n`
  );

  const mcp = new Command("mcp").description("Generated read-only MCP connector surfaces over Calyx");
  const supportedMcpSurfaces = [CALYX_MCP_VAULT_CONTEXT_SURFACE, CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE] as const;
  const formatSupportedMcpSurfaces = () => supportedMcpSurfaces.join(", ");

  mcp
    .command("manifest")
    .description("Emit generated MCP descriptors for a Calyx connector surface")
    .option("--surface <surface>", "MCP surface id (default: vault-context)", CALYX_MCP_VAULT_CONTEXT_SURFACE)
    .option("--json", "Print machine-readable manifest")
    .action(async (options: McpManifestCommandOptions) => {
      const surface = options.surface ?? CALYX_MCP_VAULT_CONTEXT_SURFACE;
      if (!supportedMcpSurfaces.includes(surface as (typeof supportedMcpSurfaces)[number])) {
        throw createCliError(`unsupported MCP surface '${surface}'. Supported surfaces: ${formatSupportedMcpSurfaces()}`, 2);
      }
      const commandPaths = collectAgentContextCommands(program).map((entry) => entry.path);
      const manifest = surface === CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE
        ? buildCalyxMcpActivityAttachmentsManifestV1({ commandPaths })
        : buildCalyxMcpVaultContextManifestV1({ commandPaths });
      if (options.json) {
        console.log(JSON.stringify(manifest, null, 2));
      } else {
        console.log(`surface\t${manifest.surface}`);
        console.log(`schema\t${manifest.schema_version}`);
        console.log(`validation_ok\t${manifest.validation.ok}`);
        console.log("tools");
        for (const tool of manifest.tools) {
          console.log(`${tool.name}\t${tool.backing_command.path}\t${tool.output_schema_ref}`);
        }
        for (const check of manifest.validation.checks.filter((entry) => entry.status !== "ok")) {
          console.error(`[calyx mcp manifest] ${check.id}: ${check.detail}`);
        }
      }
      if (!manifest.validation.ok) {
        throw createCliError("calyx mcp manifest validation failed", 2);
      }
    });

  mcp
    .command("serve")
    .description("Serve a local Streamable HTTP MCP endpoint for a Calyx connector surface")
    .option("--surface <surface>", "MCP surface id (default: vault-context)", CALYX_MCP_VAULT_CONTEXT_SURFACE)
    .option("--host <host>", "Host/IP to bind (default: 127.0.0.1)")
    .option("--port <n>", "Port to bind (default: 8787)")
    .option("--auth-token-env <name>", "Bearer token env var for protected serving", "CALYX_CONTEXT_MCP_TOKEN")
    .option("--vault-path <path>", "Optional development/test vault root override")
    .option("--runs-root <path>", "Optional run root override for activity-attachments")
    .option("--attachment-cache-dir <path>", "Optional activity attachment cache override for activity-attachments")
    .option("--json", "Print machine-readable startup result")
    .action(async (options: McpServeCommandOptions) => {
      const surface = options.surface ?? CALYX_MCP_VAULT_CONTEXT_SURFACE;
      if (!supportedMcpSurfaces.includes(surface as (typeof supportedMcpSurfaces)[number])) {
        throw createCliError(`unsupported MCP surface '${surface}'. Supported surfaces: ${formatSupportedMcpSurfaces()}`, 2);
      }
      const port = parsePositiveIntegerOption(options.port, "--port");
      const commandPaths = collectAgentContextCommands(program).map((entry) => entry.path);
      let started: Awaited<ReturnType<typeof startCalyxMcpVaultContextHttpServerV1>>;
      if (surface === CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE) {
        const activityService = createLocalRunService(runCliDeps, buildLocalRunServiceOptions({
          runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
          defaultWorktreeBase: defaultRunWorktreeBase(),
        }));
        if (
          !activityService.inspectActivityAttachments
          || !activityService.inspectActivityAttachmentRecord
          || !activityService.readActivityAttachmentBytes
        ) {
          throw createCliError("Local RunService does not support MCP activity attachment tools.", 6);
        }
        started = await startCalyxMcpActivityAttachmentsHttpServerV1({
          ...(options.host ? { host: options.host } : {}),
          ...(typeof port === "number" ? { port } : {}),
          ...(options.authTokenEnv ? { authTokenEnv: options.authTokenEnv } : {}),
          ...(options.attachmentCacheDir ? { outDir: options.attachmentCacheDir } : {}),
          cliVersion: cliPkg.version,
          commandPaths,
          activityService: {
            inspectActivityAttachments: (input) => activityService.inspectActivityAttachments!(input),
            inspectActivityAttachmentRecord: (input) => activityService.inspectActivityAttachmentRecord!(input),
            readActivityAttachmentBytes: (input) => activityService.readActivityAttachmentBytes!(input),
          },
          ...(runCliDeps.createAdminClient ? { createAdminClient: runCliDeps.createAdminClient } : {}),
          ...(runCliDeps.agentsInfraRoot ? { agentsInfraRoot: runCliDeps.agentsInfraRoot } : {}),
          ...(runCliDeps.now ? { now: runCliDeps.now } : {}),
          hostnameImpl: () => systemHostname(),
        });
      } else {
        started = await startCalyxMcpVaultContextHttpServerV1({
          ...(options.host ? { host: options.host } : {}),
          ...(typeof port === "number" ? { port } : {}),
          ...(options.authTokenEnv ? { authTokenEnv: options.authTokenEnv } : {}),
          ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
          cliVersion: cliPkg.version,
          commandPaths,
          agentContextProvider: () => buildAgentContextPayload(program) as unknown as Record<string, unknown>,
        });
      }

      if (options.json) {
        console.log(JSON.stringify(started.result, null, 2));
      } else {
        console.log(`Calyx MCP ${started.result.surface} listening at ${started.result.url}`);
        console.log(`auth\t${started.result.auth.mode}`);
      }
      console.error(`[calyx mcp] ${started.result.surface} listening at ${started.result.url}`);
    });

  const oracle = new Command("oracle").description("Oracle consultation bundle workflows");

  oracle
    .command("init")
    .description("Create an oracle inquiry scaffold with recipe, prompt, README, and response skeleton")
    .argument("<inquiry-slug>", "Stable inquiry slug, e.g. pol-1087-oracle-bundle-rfc")
    .option("--issue <POL-XXX>", "Linear issue link")
    .option("--project <slug>", "Stable project slug")
    .option("--daily", "Create under 10-daily/YYYY-MM-DD/ in the fieldwork vault", false)
    .option("--out-dir <path>", "Explicit output directory")
    .option("--vault-path <path>", "Override fieldwork vault root for --daily")
    .option("--variants <list>", "Comma-separated variants (default: sandbox)")
    .option("--author <author>", "Author string for recipe metadata")
    .option("--force", "Overwrite existing scaffold files", false)
    .option("--json", "Print machine-readable summary")
    .action(async (slug: string, options: OracleInitCommandOptions) => {
      const result = await initOracleBundleV1({
        slug,
        ...(options.outDir ? { outDir: options.outDir } : {}),
        daily: Boolean(options.daily),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
        ...(options.issue ? { issue: options.issue } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.variants ? { variants: parseCsvOption(options.variants) } : {}),
        ...(options.author ? { author: options.author } : {}),
        force: Boolean(options.force),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.inquiry_dir);
      for (const file of result.files) {
        console.log(`created ${file}`);
      }
    });

  oracle
    .command("bundle")
    .description("Validate or materialize an oracle inquiry bundle")
    .argument("<inquiry-dir>", "Inquiry directory")
    .option("--recipe <path>", "Recipe path, relative to inquiry dir unless absolute", "inquiry.yaml")
    .option("--plan", "Emit a non-mutating bundle plan (default unless --apply is passed)", false)
    .option("--apply", "Materialize context/code/receipt outputs", false)
    .option("--vault-path <path>", "Override fieldwork vault root for vault sources")
    .option("--ctx-command <command>", "ctxkit command for repo ctxpack and session excerpts", "ctx")
    .option("--calyx-command <command>", "calyx command for activity.queries[] materialization", "calyx")
    .option("--json", "Print machine-readable summary")
    .action(async (inquiryDir: string, options: OracleBundleCommandOptions) => {
      if (options.apply) {
        const result = await applyOracleBundleV1(inquiryDir, {
          recipePath: options.recipe ?? "inquiry.yaml",
          ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
          ...(options.ctxCommand ? { ctxCommand: options.ctxCommand } : {}),
          ...(options.calyxCommand ? { calyxCommand: options.calyxCommand } : {}),
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`Oracle bundle materialized: ${result.inquiry_dir}`);
        console.log(`Plan hash: ${result.plan.plan_hash}`);
        console.log(`Manifest: ${result.manifest_path}`);
        for (const output of result.manifest.outputs) {
          console.log(`${output.kind}\t${output.source}\t${output.bytes}\t${output.path}`);
        }
        for (const warning of result.manifest.warnings) {
          console.error(`[calyx oracle bundle] warning: ${warning.code}: ${warning.message}`);
        }
        return;
      }
      const result = await planOracleBundleV1(inquiryDir, options.recipe ?? "inquiry.yaml");

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`Oracle bundle plan: ${result.inquiry_dir}`);
      console.log(`Recipe hash: ${result.recipe_hash}`);
      console.log(`Plan hash: ${result.plan_hash}`);
      console.log(`Estimated tokens: ${result.budget.estimated_tokens}`);
      if (result.budget.budget_tokens) {
        console.log(`Budget tokens: ${result.budget.budget_tokens}`);
      }
      for (const output of result.outputs) {
        console.log(`${output.kind}\t${output.source}\t${output.path}`);
      }
      for (const warning of result.warnings) {
        console.error(`[calyx oracle bundle] warning: ${warning}`);
      }
    });

  oracle
    .command("run")
    .description("Run a materialized oracle inquiry through the approved automated provider")
    .argument("<inquiry-dir>", "Inquiry directory")
    .option("--recipe <path>", "Recipe path, relative to inquiry dir unless absolute", "inquiry.yaml")
    .option("--manifest <path>", "Bundle manifest path, relative to inquiry dir unless absolute", "receipts/bundle.manifest.json")
    .option("--provider <provider>", "Automated oracle provider (only gemini is supported)", "gemini")
    .option("--model <model>", "Gemini model name", DEFAULT_ORACLE_GEMINI_MODEL_V1)
    .option("--variant <variant>", "Response variant id", "sandbox")
    .option("--write-response <path>", "Response markdown path relative to inquiry dir")
    .option("--dry-run", "Plan the oracle run without calling a provider", false)
    .option("--json", "Print machine-readable summary")
    .action(async (inquiryDir: string, options: OracleRunCommandOptions) => {
      const plan = await planOracleRunV1(inquiryDir, {
        recipePath: options.recipe ?? "inquiry.yaml",
        manifestPath: options.manifest ?? join("receipts", "bundle.manifest.json"),
        provider: options.provider ?? "gemini",
        model: options.model ?? DEFAULT_ORACLE_GEMINI_MODEL_V1,
        variant: options.variant ?? "sandbox",
        ...(options.writeResponse ? { responsePath: options.writeResponse } : {}),
        dryRunOnly: Boolean(options.dryRun),
      });

      if (options.dryRun) {
        if (options.json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        console.log(`Oracle run plan: ${plan.inquiry_dir}`);
        console.log(`Provider: ${plan.provider}`);
        console.log(`Model: ${plan.model}`);
        console.log(`Variant: ${plan.variant}`);
        console.log(`Ready: ${plan.ready ? "yes" : "no"}`);
        console.log(`Estimated tokens: ${plan.budget.estimated_tokens}`);
        console.log(`Attachments: ${plan.attachments.length}`);
        console.log(`Response: ${plan.response_path}`);
        console.log(`Receipt: ${plan.receipt_path}`);
        for (const warning of plan.warnings) {
          console.error(`[calyx oracle run] warning: ${warning.code}: ${warning.message}`);
        }
        return;
      }

      if (!plan.ready) {
        throw createCliError("Oracle run plan is not ready; rerun with --dry-run --json and resolve warnings first.", 3);
      }

      const startedAt = new Date();
      const execution = await executeGeminiOracleRun(plan);
      const completedAt = new Date();
      const result = await writeOracleRunResultV1({
        plan,
        responseText: execution.responseText,
        startedAt,
        completedAt,
        ...(execution.usage ? { usage: execution.usage } : {}),
        ...(execution.providerResponseId ? { providerResponseId: execution.providerResponseId } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Oracle response written: ${result.response_path}`);
      console.log(`Oracle receipt written: ${result.receipt_path}`);
    });

  oracle
    .command("synthesize")
    .description("Create a synthesis scaffold from oracle response markdown files")
    .argument("<inquiry-dir>", "Inquiry directory")
    .option("--write <path>", "Synthesis markdown path relative to inquiry dir", "oracle-synthesis.md")
    .option("--dry-run", "Inspect discovered response files without writing a synthesis scaffold", false)
    .option("--force", "Overwrite an existing synthesis scaffold", false)
    .option("--json", "Print machine-readable summary")
    .action(async (inquiryDir: string, options: OracleSynthesizeCommandOptions) => {
      const result = await synthesizeOracleResponsesV1(inquiryDir, {
        outputPath: options.write ?? "oracle-synthesis.md",
        dryRun: Boolean(options.dryRun),
        force: Boolean(options.force),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${options.dryRun ? "Oracle synthesis plan" : "Oracle synthesis scaffold"}: ${result.synthesis_path}`);
      console.log(`Responses: ${result.responses.length}`);
      for (const response of result.responses) {
        console.log(`${response.bytes}\t${response.path}`);
      }
      for (const warning of result.warnings) {
        console.error(`[calyx oracle synthesize] warning: ${warning.code}: ${warning.message}`);
      }
    });

  oracle
    .command("doctor")
    .description("Check whether an oracle inquiry scaffold is ready to plan or upload")
    .argument("<inquiry-dir>", "Inquiry directory")
    .option("--recipe <path>", "Recipe path, relative to inquiry dir unless absolute", "inquiry.yaml")
    .option("--json", "Print machine-readable summary")
    .action(async (inquiryDir: string, options: OracleDoctorCommandOptions) => {
      const result = await doctorOracleBundleV1(inquiryDir, options.recipe ?? "inquiry.yaml");

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.findings.length === 0) {
        console.log(`Oracle bundle doctor OK: ${result.inquiry_dir}`);
      } else {
        console.log(`Oracle bundle doctor ${result.ok ? "OK with warnings" : "found errors"}: ${result.inquiry_dir}`);
        for (const finding of result.findings) {
          console.log(`${finding.level}\t${finding.code}\t${finding.path ?? "-"}\t${finding.message}`);
        }
      }

      if (!result.ok) {
        process.exitCode = 3;
      }
    });

  const client = new Command("client")
    .description("Generated Calyx API client recovery commands");

  client
    .command("replay")
    .description("Replay one encrypted exact-wire generated-client recovery receipt")
    .argument("<path>", "Managed encrypted calyx.client-indeterminate-result/v1 receipt path")
    .option("--auth-token <token>", `Bearer token override (or resolve from ${RUN_SERVER_CREDENTIAL_HINT})`)
    .action(async (artifactPath: string, options: { authToken?: string }) => {
      const receipt = await (await openRecoveryCustody(runCliDeps)).readReceipt(artifactPath);
      const result = await replayGeneratedMutation(
        runCliDeps,
        artifactPath,
        undefined,
        "calyx client replay",
        options.authToken,
      );
      console.log(JSON.stringify({
        schema_version: "calyx.client-replay-result/v1",
        operation_id: receipt.operation_id,
        result,
      }, null, 2));
    });

  const review = new Command("review")
    .description("Commission a reviewer agent over a PR or branch")
    .option("--repo <slug-or-alias>", "Canonical repo slug, configured alias, or collision-free private <repo>-dev leaf derived from an explicit owner/<repo>-dev alias. Provide this or --worktree-path.")
    .option("--worktree-path <path>", "Explicit existing worktree path to review as-is, for unregistered/local repos. Provide this or --repo.")
    .option("--pr <n>", "Pull request number to review")
    .option("--sha <sha>", "Explicit full PR head commit SHA to review, for force-push races")
    .option("--branch <ref>", "Branch ref to review")
    .option("--adversarial", "Use reviewer-adversarial instead of reviewer", false)
    .option("--scope <scope>", "Target scope (pr|branch); inferred from --pr or --branch when omitted")
    .option("--base <ref>", "Base ref for target resolution", "origin/main")
    .option("--focus <text>", "Focus area for the review definition (repeatable)", collectOptionValues, [])
    .option("--backend <backend>", "Override reviewer backend (claude|codex)")
    .option("--host <host>", "Target host label", "local")
    .option("--issue <id>", "Linear issue ID for reviewer delivery context")
    .option("--no-handback", "Opt out of the default terminal calyx msg handback binding to the caller activity")
    .option("--dry-run", "Print the resolved review launch plan without launching a run", false)
    .option("--agent-registry <path>", "Path to agents AGENTS.json registry (or set CALYX_AGENTS_REGISTRY)")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Explicit remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable conduct receipt")
    .action(async (options: ReviewCommandOptions) => {
      const receipt = await runReviewCommand(options, runCliDeps);
      if (options.json) {
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }
      const backend = asPlainRecord(receipt["backend"]);
      const handback = asPlainRecord(receipt["handback"]);
      console.log(`${options.dryRun ? "Review plan" : "Review launched"}: ${String(receipt["run_id"])}`);
      console.log(`  agent: ${String(receipt["agent_ref"])}`);
      console.log(`  backend: ${String(backend?.["selected"] ?? "unknown")} (${String(backend?.["reason"] ?? "unknown reason")})`);
      console.log(`  handback: ${String(handback?.["status"] ?? "unknown")}${handback?.["address"] ? ` -> ${String(handback["address"])}` : ""}`);
    });

  const run = new Command("run").description("Canonical run orchestration commands");

  run
    .command("launch")
    .description("Launch a Calyx run via RunService")
    .option("--replay-request <path>", "Replay a retained 0600 exact-wire recovery artifact after an indeterminate remote launch")
    .option("--run-id <id>", "Optional run ID (auto-generated UUID if omitted)")
    .option("--idempotency-key <key>", "Stable request key for safe remote launch retries")
    .option("--kernel <kernel>", "Execution kernel (agent_runner|host_process)")
    .option("--issue <id>", "Issue ID (e.g., POL-703) for run context")
    .option("--host <host>", "Target host label", "local")
    .option("--backend <backend>", "Runner backend (claude|codex) for kernel=agent_runner")
    .option("--agent <id>", "Resolve an agent definition from instructions/agents/AGENTS.json before launch")
    .option("--agent-registry <path>", "Path to agents AGENTS.json registry (or set CALYX_AGENTS_REGISTRY)")
    .option("--var <assignment>", "Agent variable assignment key=value for kernel=agent_runner (repeatable)", collectOptionValues, [])
    .option("--profile <profile>", "Backend profile label for kernel=agent_runner receipts; use --model for model selection")
    .option("--prompt <text>", "Inline prompt text for kernel=agent_runner")
    .option("--prompt-file <path>", "Read prompt text from a launcher-local file before dispatch")
    .option("--system-prompt <text>", "Replace the backend system prompt for kernel=agent_runner")
    .option("--system-prompt-file <path>", "Read replacement system prompt text from a local file before dispatch")
    .option("--append-system-prompt <text>", "Append extra instructions to the default backend system prompt for kernel=agent_runner")
    .option("--append-system-prompt-file <path>", "Read appended system prompt text from a local file before dispatch")
    .option("--template <id>", "Prompt template ID for kernel=agent_runner")
    .option("--template-var <assignment>", "Template variable NAME=VALUE for kernel=agent_runner (repeatable)", collectOptionValues, [])
    .option("--execplan-ref <ref>", "ExecPlan reference path for kernel=agent_runner")
    .option("--require-execplan", "Require an ExecPlan even when --agent, --prompt, --prompt-file, or --template is supplied")
    .option("--no-require-execplan", "Allow runs without an ExecPlan even when no prompt source is supplied")
    .option("--pull-execplan", "Pull ExecPlan namespace from docstore before resolution for kernel=agent_runner")
    .option("--repo <slug-or-alias>", "Canonical repo slug, configured alias, or collision-free private <repo>-dev leaf derived from explicit owner-qualified host truth for runtime-managed worktrees")
    .option(
      "--worktree-base <path>",
      `Base path for runtime-managed target-repo worktrees when kernel=agent_runner (default: ${DEFAULT_RUNNER_WORKTREE_BASE_ENV} or ~/projects)`
    )
    .option("--worktree-mode <mode>", "Worktree mode for kernel=agent_runner (existing|managed|create)")
    .option("--worktree-path <path>", "Explicit worktree path for kernel=agent_runner")
    .option("--worktree-ref <ref>", "Worktree git ref for kernel=agent_runner (default: origin/main)")
    .option(
      "--worktree-branch <branch>",
      "Worktree branch name for kernel=agent_runner. Required for --worktree-mode create. Optional for managed mode when --issue is supplied (Calyx derives calyx-run/<lowercase issue>); required otherwise."
    )
    .option("--steal-lock", "Steal stale or active worktree lock for kernel=agent_runner")
    .option("--lock-timeout-ms <ms>", "Worktree lock timeout in milliseconds for kernel=agent_runner")
    .option("--required-artifact <name>", "Required artifact name for kernel=agent_runner (repeatable)", collectOptionValues, [])
    .option("--artifact-root <path>", "Artifact/output root to summarize in run doctor for kernel=agent_runner (repeatable; relative paths resolve from the worktree)", collectOptionValues, [])
    .option("--argv <value>", "Host-process argv token for kernel=host_process (repeatable)", collectOptionValues, [])
    .option("--cwd <path>", "Host-process working directory on the target host for kernel=host_process")
    .option("--stop-grace-ms <ms>", "Host-process stop grace period before SIGKILL for kernel=host_process")
    .option("--health-source <kind>", "Health signal source for kernel=host_process (stdout|stderr, repeatable)", collectOptionValues, [])
    .option("--health-path <path>", "Health signal file path for kernel=host_process (repeatable, resolved relative to --cwd)", collectOptionValues, [])
    .option("--health-stale-after-ms <ms>", "Mark host_process health stale when no progress signal arrives within this window")
    .option("--health-poll-interval-ms <ms>", "Polling cadence for host_process health checks")
    .option("--allowed-tool <tool>", "Allowed backend tool for kernel=agent_runner (repeatable)", collectOptionValues, [])
    .option("--dangerously-skip-permissions", "Set backend_options.dangerously_skip_permissions=true for kernel=agent_runner")
    .option("--model <model>", "Set backend model for kernel=agent_runner (currently Claude only; e.g. opus, sonnet, or claude-opus-4-7)")
    .option("--reasoning-effort <effort>", "Set backend reasoning effort for kernel=agent_runner (Claude: low|medium|high|xhigh|max; Codex: none|minimal|low|medium|high|xhigh)")
    .option("--max-threads <n>", "Set Codex agents.max_threads concurrency for kernel=agent_runner")
    .option("--max-turns <n>", "Set Claude --max-turns truncation bound for kernel=agent_runner")
    .option("--agent-activity-stale-after-ms <ms>", "Mark agent_runner health stale when no progress signal arrives within this window")
    .option("--agent-activity-poll-interval-ms <ms>", "Polling cadence for agent_runner health checks")
    .option("--agent-inactivity-timeout-ms <ms>", "Opt in to stopping spawn-backed agent_runner backends after this inactivity window")
    .option("--agent-inactivity-stop-grace-ms <ms>", "Grace period between agent inactivity SIGTERM and SIGKILL for spawn-backed backends")
    .option(
      "--env <assignment>",
      "Env override KEY=VALUE or KEY=null; backend env for agent_runner, process env for host_process (repeatable)",
      collectOptionValues,
      []
    )
    .option("--ntfy-topic <topic>", "Notification topic")
    .option("--agent-mail-thread <thread>", "Agent-mail thread identifier")
    .option("--foreground", "Run in the foreground instead of spawning a worker", false)
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Explicit remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run summary")
    .action(async (options: RunLaunchCommandOptions) => {
      const result = await launchRunCommand(options, runCliDeps);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (isRemoteAcceptedRunLaunchResult(result)) {
        console.log(`Run ${result.run_id} accepted by the remote daemon.`);
        console.log(`  status: ${result.status}`);
        console.log(`  operation: ${result.operation.route}`);
        console.log(`  events: ${result.operation.events_route}`);
        console.log(`  receipt: ${result.operation.receipt_route}`);
        console.log(`  observation: ${result.observation.status}`);
      } else {
        console.log(result.record.summary);
        console.log(`  run_id: ${result.run_id}`);
        console.log(`  state: ${result.state}`);
        console.log(`  mode: ${result.mode}`);
        console.log(`  run_dir: ${result.run_dir}`);
      }

      if (options.foreground && !isRemoteAcceptedRunLaunchResult(result)) {
        const exitCode = deriveRunRecordExitCode(result.record);
        if (exitCode !== 0) {
          process.exitCode = exitCode;
        }
      }
    });

  run
    .command("resume")
    .description("Resume an existing backend session under Calyx lifecycle management")
    .argument("[session-id]", "Session ID to resume (omit with --last)")
    .requiredOption("--prompt <text>", "Prompt for the resumed session")
    .option("--last", "Resume the most recent session")
    .option("--backend <backend>", "Backend (claude|codex) — auto-detected with --last; defaults to claude for explicit session-id")
    .option("--run-id <id>", "Optional run ID (auto-generated UUID if omitted)")
    .option("--idempotency-key <key>", "Stable request key for safe remote resume retries")
    .option("--host <host>", "Target host label", "local")
    .option("--profile <profile>", "Backend profile label; use --model at launch for model selection")
    .option("--worktree-path <path>", "Explicit worktree path")
    .option("--dangerously-skip-permissions", "Set backend_options.dangerously_skip_permissions=true")
    .option("--foreground", "Run in the foreground instead of spawning a worker", false)
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Explicit remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run summary")
    .action(async (sessionIdArg: string | undefined, options: RunResumeCommandOptions) => {
      // Merge positional arg into options
      if (sessionIdArg !== undefined) {
        options.sessionId = sessionIdArg;
      }

      const result = await resumeRunCommand(options, runCliDeps);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (isRemoteAcceptedRunLaunchResult(result)) {
        console.log(`Run ${result.run_id} accepted by the remote daemon.`);
        console.log(`  status: ${result.status}`);
        console.log(`  operation: ${result.operation.route}`);
        console.log(`  events: ${result.operation.events_route}`);
        console.log(`  receipt: ${result.operation.receipt_route}`);
        console.log(`  observation: ${result.observation.status}`);
      } else {
        console.log(result.record.summary);
        console.log(`  run_id: ${result.run_id}`);
        console.log(`  state: ${result.state}`);
        console.log(`  mode: ${result.mode}`);
        console.log(`  run_dir: ${result.run_dir}`);
      }

      if (options.foreground && !isRemoteAcceptedRunLaunchResult(result)) {
        const exitCode = deriveRunRecordExitCode(result.record);
        if (exitCode !== 0) {
          process.exitCode = exitCode;
        }
      }
    });

  run
    .command("subscribe")
    .description("Subscribe to the authenticated RunService SSE stream")
    .option("--after <cursor>", "Replay events strictly after the provided cursor")
    .option("--run-id <id>", "Filter the stream to one run_id")
    .option("--event-type <type>", "Filter the stream by event type")
    .option("--host <host>", "Target host (defaults to this host; resolves its operator_cli credential)")
    .option("--server-url <url>", "RunService base URL override")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--format <format>", "Output format (jsonl|pretty)", "jsonl")
    .action(async (options: RunSubscribeCommandOptions) => {
      await subscribeRunEvents(options, runCliDeps);
    });

  run
    .command("status")
    .description("Show the current operator-facing state for a run")
    .argument("[run-id]", "Run ID or unique prefix to query")
    .option("--run-id <id>", "Run ID or unique prefix to query (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--details", "Print detailed text status fields in addition to the compact pickup view")
    .option("--json", "Print machine-readable run status")
    .action(async (runId: string | undefined, options: RunReadCommandOptions) => {
      validateRunOutcomeAddressing(options);
      const handle = await resolveRunHandle("calyx run status", runId, options, runCliDeps);
      const record = await getRunRecord({ ...options, runId: handle.runId }, runCliDeps);
      if (!record) {
        throw createCliError(`Run "${handle.input}" not found.`, 3);
      }

      if (options.json) {
        console.log(serializeRunOutcome(toRunStatusResult(record, handle, options)));
        return;
      }

      console.log(formatRunStatusText(record, options, handle));
    });

  run
    .command("await")
    .description("Wait finitely for a run to reach a canonical terminal state")
    .argument("[run-id]", "Run ID or unique prefix to wait for")
    .option("--run-id <id>", "Run ID or unique prefix to wait for (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--timeout <duration>", "Finite wait ceiling (default: 1h; units: ms, s, m, h)", "1h")
    .option("--require-success", "After emitting the result, map the workload outcome to its foreground exit code", false)
    .option("--json", "Print one calyx.run-await/v2 result")
    .action(async (runId: string | undefined, options: RunAwaitCommandOptions) => {
      validateRunOutcomeAddressing(options);
      const timeoutMs = parseRunAwaitTimeoutMs(options.timeout);
      const control = createRunAwaitControl(timeoutMs);
      const controlledOptions: RunAwaitCommandOptions = {
        ...options,
        signal: control.signal,
      };
      try {
        const handle = await resolveRunHandle("calyx run await", runId, controlledOptions, runCliDeps);
        const outcome = await awaitRunCommand(handle, controlledOptions, runCliDeps, control);
        if (outcome.interruptExitCode) {
          process.exitCode = outcome.interruptExitCode;
          return;
        }
        const result = outcome.result!;
        console.log(options.json ? serializeRunOutcome(result) : formatRunAwaitText(result));
        if (result.timed_out) {
          process.exitCode = 124;
          return;
        }
        if (options.requireSuccess) {
          const exitCode = requiredSuccessExitCode(outcome.record!.state);
          if (exitCode !== 0) process.exitCode = exitCode;
        }
      } catch (error) {
        const stopReason = control.stopReason();
        if (stopReason === "sigint" || stopReason === "sigterm") {
          process.exitCode = stopReason === "sigint" ? 130 : 143;
          return;
        }
        if (stopReason === "timeout") {
          console.error("run await timed out before a canonical run snapshot was available");
          process.exitCode = 124;
          return;
        }
        throw error;
      } finally {
        control.dispose();
      }
    });

  run
    .command("receipt")
    .description("Print the authoritative RunRecord for a run")
    .argument("[run-id]", "Run ID or unique prefix to query")
    .option("--run-id <id>", "Run ID or unique prefix to query (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run record")
    .action(async (runId: string | undefined, options: RunReadCommandOptions) => {
      const handle = await resolveRunHandle("calyx run receipt", runId, options, runCliDeps);
      const record = await getRunRecord({ ...options, runId: handle.runId }, runCliDeps);
      if (!record) {
        throw createCliError(`Run "${handle.input}" not found.`, 3);
      }

      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }

      console.log(formatRunReceiptText(record, options, handle));
    });

  run
    .command("kernel-receipt")
    .description("Print the raw kernel receipt emitted by the selected execution kernel")
    .argument("[run-id]", "Run ID or unique prefix to query")
    .option("--run-id <id>", "Run ID or unique prefix to query (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable kernel receipt")
    .action(async (runId: string | undefined, options: RunReadCommandOptions) => {
      const handle = await resolveRunHandle("calyx run kernel-receipt", runId, options, runCliDeps);
      const receipt = await readKernelReceipt({ ...options, runId: handle.runId }, runCliDeps);
      if (!receipt) {
        throw createCliError(`Kernel receipt for "${handle.input}" not found.`, 3);
      }

      console.log(JSON.stringify(receipt, null, 2));
    });

  run
    .command("doctor")
    .description("Inspect run liveness across status, logs, artifacts, process, and host resources")
    .argument("[run-id]", "Run ID or unique prefix to inspect")
    .option("--run-id <id>", "Run ID or unique prefix to inspect (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--tail <n>", "Read at most the last N lifecycle/log entries for source summaries")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run-observation/v1 payload")
    .action(async (runId: string | undefined, options: RunLogsCommandOptions) => {
      const handle = await resolveRunHandle("calyx run doctor", runId, options, runCliDeps);
      const result = await readRunObservation({ ...options, runId: handle.runId }, runCliDeps);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatRunObservationText(result, handle));
    });

  run
    .command("ps")
    .description("List known runs, optionally including interactive Codex and Claude sessions")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--include-interactive", "Include recent interactive Codex and Claude sessions")
    .option("--agent-kind <kind>", "Filter interactive sessions by backend: all, codex, or claude")
    .option("--since-hours <hours>", "Interactive session lookback window in hours")
    .option("--limit <n>", "Maximum run or activity rows to return")
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run list")
    .action(async (options: RunPsCommandOptions) => {
      const runs = await listRuns(options, runCliDeps);

      if (options.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }

      console.log(["SHORT_ID", "STATE", "HEALTH", "HOST", "ISSUE", "BACKEND", "BRANCH", "UPDATED", "SUMMARY"].join("\t"));
      for (const entry of runs) {
        console.log(formatRunPsLine(entry));
      }
    });

  const runActivity = run
    .command("activity")
    .description("[deprecated] Use `calyx activity` instead. Kept for compatibility.");

  runActivity
    .command("show")
    .description("[deprecated] Use `calyx activity show` instead.")
    .requiredOption("--activity-id <id>", "Interactive activity ID, for example interactive:codex:<session-id>")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--around <line-or-query>", "Center output around an event line, event index, or text match")
    .option("--context <n>", "Number of events on each side of --around")
    .option("--tail <n>", "Fallback number of recent events to show")
    .option("--include-tools", "Include tool calls and tool outputs")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable session activity")
    .action(async (options: RunActivityCommandOptions) => {
      emitRunActivityDeprecationWarning();
      const detail = await inspectInteractiveActivity(options, runCliDeps);
      console.log(options.json ? JSON.stringify(detail, null, 2) : formatInteractiveActivityText(detail));
    });

  runActivity
    .command("logs")
    .description("[deprecated] Use `calyx activity show` instead.")
    .requiredOption("--activity-id <id>", "Interactive activity ID, for example interactive:codex:<session-id>")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--tail <n>", "Number of recent events to show")
    .option("--include-tools", "Include tool calls and tool outputs")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable session activity")
    .action(async (options: RunActivityCommandOptions) => {
      emitRunActivityDeprecationWarning();
      const detail = await inspectInteractiveActivity(options, runCliDeps);
      console.log(options.json ? JSON.stringify(detail, null, 2) : formatInteractiveActivityText(detail));
    });

  runActivity
    .command("export")
    .description("[deprecated] Use `calyx activity export` instead.")
    .requiredOption("--activity-id <id>", "Interactive activity ID, for example interactive:codex:<session-id>")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--around <line-or-query>", "Center output around an event line, event index, or text match")
    .option("--context <n>", "Number of events on each side of --around")
    .option("--tail <n>", "Fallback number of recent events to show")
    .option("--include-tools", "Include tool calls and tool outputs")
    .option("--format <format>", "Export format: markdown or json", "markdown")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable session activity")
    .action(async (options: RunActivityCommandOptions) => {
      emitRunActivityDeprecationWarning();
      if (options.format && options.format !== "markdown" && options.format !== "json") {
        throw createCliError("--format must be one of: markdown, json.", 2);
      }
      const detail = await inspectInteractiveActivity(options, runCliDeps);
      if (options.json || options.format === "json") {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      console.log(formatInteractiveActivityMarkdown(detail));
    });

  run
    .command("logs")
    .description("Show persisted run log entries; local runs may be enriched with local agent messages")
    .argument("[run-id]", "Run ID or unique prefix to query")
    .option("--run-id <id>", "Run ID or unique prefix to query (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--tail <n>", "Show only the last N log entries")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable run-logs/v1 payload")
    .option("--full", "Show full agent messages instead of first-line previews")
    .action(async (runId: string | undefined, options: RunLogsCommandOptions) => {
      const handle = await resolveRunHandle("calyx run logs", runId, options, runCliDeps);
      const resolvedOptions = { ...options, runId: handle.runId };
      const result = await readRunLogs(resolvedOptions, runCliDeps);

      // A backend-session path belongs to the host that produced the run
      // record. Only local runs may dereference it in this process; remote
      // results remain daemon-authoritative rather than accidentally reading
      // a same-named path on the caller host.
      let agentMessages: AssistantMessage[] = [];
      if (!isRemoteRunReadTarget(resolvedOptions)) {
        try {
          const record = await getRunRecord(resolvedOptions, runCliDeps);
          if (record?.kernel_receipt && "backend_session" in record.kernel_receipt) {
            const kr = record.kernel_receipt as { backend_session?: { backend: string; path: string } };
            if (kr.backend_session) {
              const { backend, path: sessionPath } = kr.backend_session;
              agentMessages = await parseBackendAssistantMessages(backend, sessionPath);
            }
          }
        } catch {
          // Graceful degradation: no local agent messages.
        }
      }

      const entries: RunLogEntry[] = [...result.entries];
      for (const msg of agentMessages) {
        const text = options.full
          ? msg.text
          : (() => {
              const firstLine = msg.text.split("\n")[0] ?? "";
              return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
            })();
        entries.push({
          kind: "agent_message",
          timestamp: msg.timestamp,
          timestamp_source: "message",
          source: "agent",
          text,
        });
      }

      const tail = options.tail ? parsePositiveInteger(options.tail, "--tail") : undefined;
      const rendered = sortRunLogEntries(entries);
      const selected = tail ? rendered.slice(-tail) : rendered;
      const output = {
        ...result,
        entries: selected,
      };

      if (options.json) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      for (const warning of result.warnings) {
        console.error(`# warning: ${warning}`);
      }
      for (const entry of selected) {
        console.log(formatRunLogEntryText(entry));
      }
    });

  run
    .command("stop")
    .description("Request cancellation for a detached run worker")
    .argument("[run-id]", "Run ID or unique prefix to stop")
    .option("--run-id <id>", "Run ID or unique prefix to stop (kept for scripts)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable stop result")
    .action(async (runId: string | undefined, options: RunReadCommandOptions) => {
      const handle = await resolveRunHandle("calyx run stop", runId, options, runCliDeps);
      const result = await stopRun({ ...options, runId: handle.runId }, runCliDeps);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.status === "cancellation_requested"
        ? `cancellation requested for ${result.run_id}`
        : `run ${result.run_id} is already terminal`);
    });

  run
    .command("audit-terminal-authority")
    .description("Audit the existing terminal supersession authority before infra-error metric deployment")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--json", "Print machine-readable calyx.infra-error-census-authority-audit/v1 output")
    .action(async (options: RunTerminalAuthorityAuditCommandOptions) => {
      const result = await auditRunTerminalAuthority(options, runCliDeps);
      console.log(options.json
        ? JSON.stringify(result, null, 2)
        : formatRunTerminalAuthorityAudit(result));
      if (!result.authoritative) process.exitCode = 1;
    });

  run
    .command("reconcile")
    .description("Classify incomplete runs after orchestrator loss")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--host <host>", "Target host; resolves its operator_cli credential and run server URL")
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable reconciliation summary")
    .action(async (options: RunReconcileCommandOptions) => {
      const result = await reconcileRuns(options, runCliDeps);
      const projectionFailed = result.projection.status === "failed";
      const repairPending = result.changed.repair_pending;
      const unresolvedCount = result.changed.unresolved;
      const unresolvedHistogramPresent = result.unresolved.length > 0;
      const operatorMigrationPending = result.changed.noncanonical_directories > 0;
      const reconciliationIncomplete = isRunReconciliationIncomplete(result);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        if (reconciliationIncomplete) process.exitCode = 1;
        return;
      }

      const changed = result.changed;
      console.log(`scanned=${result.scanned} rebuilt=${changed.rebuilt} repair_pending=${changed.repair_pending} classified=${changed.classified} adopted=${changed.adopted} skipped=${changed.skipped} unresolved=${changed.unresolved} projection=${result.projection.status}`);
      if (unresolvedHistogramPresent) {
        console.log(`unresolved_reasons=${result.unresolved.map(({ reason, count }) => `${reason}:${count}`).join(",")}`);
      }
      if (operatorMigrationPending) {
        console.log(
          `noncanonical_directories=${result.changed.noncanonical_directories}`
          + ` examples=${result.noncanonical_directories.length}`
          + ` truncated=${String(result.changed.noncanonical_directories > result.noncanonical_directories.length)}`,
        );
      }
      if (reconciliationIncomplete) {
        const reasons = [
          ...(repairPending > 0 ? [`${repairPending} receipt-authoritative run projection repair(s) remain pending`] : []),
          ...(unresolvedCount > 0 ? [`${unresolvedCount} run authority disposition(s) remain unresolved`] : []),
          ...(unresolvedHistogramPresent && unresolvedCount === 0
            ? ["the unresolved-reason histogram is nonempty"]
            : []),
          ...(projectionFailed ? ["the run-index projection repair failed"] : []),
          ...(operatorMigrationPending ? ["noncanonical run directories require operator action"] : []),
          ...(result.status !== "completed" ? [`the reconcile status is ${result.status}`] : []),
        ];
        console.error(`run reconciliation is incomplete${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`);
        process.exitCode = 1;
      }
    });

  const runDaemon = run.command("daemon").description("Symphony-style daemon lifecycle commands");

  runDaemon
    .command("start")
    .description("Start the Calyx orchestration daemon")
    .option("--workflow <path>", "Operator override: path to WORKFLOW.md (mutually exclusive with --project)")
    .option("--project <slug>", "Fleet-managed project slug to resolve <repo-root>/WORKFLOW.md via hosts.yaml")
    .option("--host <alias>", "Host alias for project resolution (defaults to local)")
    .option("--agents-infra-root <path>", "Override agents-infra root (env: CALYX_AGENTS_INFRA_ROOT)")
    .option("--daemon-id <id>", "Daemon identifier (defaults to project- or workflow-derived slug)")
    .option("--foreground", "Run the daemon in the foreground", false)
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable daemon status")
    .action(async (options: RunDaemonStartCommandOptions) => {
      const result = await startDaemonCommand(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`daemon_id: ${result.daemon_id}`);
      console.log(`  status: ${result.record.status}`);
      if (result.pid) {
        console.log(`  pid: ${result.pid}`);
      }
      console.log(`  state_root: ${result.state_root}`);
    });

  runDaemon
    .command("status")
    .description("Show daemon status")
    .requiredOption("--daemon-id <id>", "Daemon identifier")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable daemon status")
    .action(async (options: RunDaemonStatusCommandOptions) => {
      const record = await daemonStatusCommand(options);
      if (!record) {
        throw createCliError(`Daemon "${options.daemonId}" not found.`, 3);
      }
      if (options.json) {
        console.log(JSON.stringify(record, null, 2));
        return;
      }
      console.log(`${record.daemon_id}: ${record.status}`);
      console.log(`  workflow: ${record.workflow_path}`);
      console.log(`  claimed_issues: ${record.claimed_issues}`);
      console.log(`  active_runs: ${record.active_runs}`);
      if (record.pid) {
        console.log(`  pid: ${record.pid}`);
      }
      if (record.next_poll_at) {
        console.log(`  next_poll_at: ${record.next_poll_at}`);
      }
      if (record.last_error) {
        console.log(`  last_error: ${record.last_error}`);
      }
    });

  runDaemon
    .command("logs")
    .description("Show daemon event log")
    .requiredOption("--daemon-id <id>", "Daemon identifier")
    .option("--tail <n>", "Show only the last N daemon events")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable daemon events")
    .action(async (options: RunDaemonLogsCommandOptions) => {
      const events = await daemonLogsCommand(options);
      if (options.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }
      for (const event of events) {
        console.log(`[${event.timestamp}] [${event.level}] ${event.event}: ${event.message}`);
      }
    });

  runDaemon
    .command("stop")
    .description("Stop a running daemon")
    .requiredOption("--daemon-id <id>", "Daemon identifier")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable stop result")
    .action(async (options: RunDaemonStopCommandOptions) => {
      const result = await daemonStopCommand(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.stopped ? `stop requested${result.pid ? ` (pid=${result.pid})` : ""}` : "no active daemon pid recorded");
    });

  runDaemon
    .command("plan")
    .description("Preview the next daemon tick without claiming issues or launching runs")
    .option("--workflow <path>", "Operator override: path to WORKFLOW.md (mutually exclusive with --project)")
    .option("--project <slug>", "Fleet-managed project slug to resolve <repo-root>/WORKFLOW.md via hosts.yaml")
    .option("--host <alias>", "Host alias for project resolution (defaults to local)")
    .option("--agents-infra-root <path>", "Override agents-infra root (env: CALYX_AGENTS_INFRA_ROOT)")
    .option("--daemon-id <id>", "Daemon identifier (defaults to project- or workflow-derived slug)")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable plan summary")
    .action(async (options: RunDaemonPlanCommandOptions) => {
      const result = await daemonPlanCommand(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printDaemonPlanHuman(result);
    });

  runDaemon
    .command("tick")
    .description("Execute a deterministic daemon tick")
    .option("--workflow <path>", "Operator override: path to WORKFLOW.md (mutually exclusive with --project)")
    .option("--project <slug>", "Fleet-managed project slug to resolve <repo-root>/WORKFLOW.md via hosts.yaml")
    .option("--host <alias>", "Host alias for project resolution (defaults to local)")
    .option("--agents-infra-root <path>", "Override agents-infra root (env: CALYX_AGENTS_INFRA_ROOT)")
    .option("--daemon-id <id>", "Daemon identifier (defaults to project- or workflow-derived slug)")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--daemons-root <path>", `Daemon state root (default: ${DEFAULT_DAEMONS_ROOT_ENV} or ~/.calyx/daemons)`)
    .option("--json", "Print machine-readable tick summary")
    .action(async (options: RunDaemonTickCommandOptions) => {
      const result = await daemonTickCommand(options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`daemon_id: ${result.daemon_id}`);
      console.log(`  launches: ${result.launched_runs.length}`);
      console.log(`  active_runs: ${result.active_runs}`);
      console.log(`  eligible_issues: ${result.eligible_issues}`);
      console.log(`  next_poll_at: ${result.next_poll_at}`);
    });

  run
    .command("serve")
    .description("Start the authenticated RunService HTTP server")
    .option("--host <host>", "Listen host (defaults to the detected Tailscale address)")
    .option("--port <port>", "Listen port", "8740")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option(
      "--worktree-base <path>",
      `Base path for runtime-managed target-repo worktrees when kernel=agent_runner (default: ${DEFAULT_RUNNER_WORKTREE_BASE_ENV} or ~/projects)`
    )
    .option("--monitor-interval-ms <ms>", "Monitor evaluator polling interval in milliseconds", "5000")
    .option("--message-outbox-interval-ms <ms>", "Message outbox drain interval in milliseconds", "15000")
    .option("--activity-tailer-interval-ms <ms>", "Activity recall-index tailer backstop interval in milliseconds", "15000")
    .option("--no-activity-tailer", "Disable the resident activity transcript tailer")
    .option("--json", "Print the listening URL as JSON before serving")
    .action(async (options: RunServeCommandOptions) => {
      const host = options.host?.trim() || detectTailscaleHost();
      const port = options.port ? parsePositiveInteger(options.port, "--port") : 8740;
      const runsRoot = options.runsRoot?.trim() || defaultRunsRoot();
      const worktreeBase = options.worktreeBase?.trim() || defaultRunWorktreeBase();
      const monitorIntervalMs = options.monitorIntervalMs
        ? parsePositiveInteger(options.monitorIntervalMs, "--monitor-interval-ms")
        : 5000;
      const messageOutboxIntervalMs = options.messageOutboxIntervalMs
        ? parsePositiveInteger(options.messageOutboxIntervalMs, "--message-outbox-interval-ms")
        : 15000;
      const activityTailerIntervalMs = options.activityTailerIntervalMs
        ? parsePositiveInteger(options.activityTailerIntervalMs, "--activity-tailer-interval-ms")
        : 15000;
      const activityTailerEnabled = options.activityTailer !== false;
      // POL-2045: enforce the versioned startup-environment contract first, so
      // the fail-closed requirement the upgrade preflight reads from the target
      // ref is executable truth here, not just documentation. A supervisor that
      // does not project every required name (the 2026-07-20 CALYX_HOST_ALIAS
      // regression) fails closed here — the preflight now names it beforehand.
      assertStartupContractEnvPresent(process.env);
      const agentsInfraRoot = await resolveAgentsInfraRoot();
      if (!agentsInfraRoot) {
        throw createCliError("run serve requires a resolvable agents-infra hosts truth store.", 2);
      }
      const hostsTruth = await readHostsTruth(agentsInfraRoot);
      const advertisedHost = resolveConsumerApiServerHostAlias(hostsTruth);
      const messageHostAliases = configuredMessageHostAliases(hostsTruth);
      const hostCredentialTruth = hostsTruth.hosts?.[advertisedHost]?.consumer_api_credentials;
      if (!hostCredentialTruth) {
        throw createCliError(`Host ${advertisedHost} has no consumer_api_credentials.`, 2);
      }
      const ambientIsolation = assertStartupContractConsumerApiAmbientIsolation(
        advertisedHost,
        hostCredentialTruth,
      );
      const credentials = resolveConsumerApiCredentialVerifiers(
        advertisedHost,
        hostsTruth.hosts?.[advertisedHost],
      );
      const daemonOutboxToken = resolveConsumerApiClientToken(
        advertisedHost,
        hostsTruth.hosts?.[advertisedHost],
        ambientIsolation.daemon_client_id,
      );
      if (!daemonOutboxToken) {
        throw createCliError(`Host ${advertisedHost} cannot resolve ${ambientIsolation.daemon_client_id} outbound token.`, 2);
      }

      const service = createConcreteRunService({
        ...buildLocalRunServiceOptions({
          runsRoot,
          defaultWorktreeBase: worktreeBase,
        }),
        monitorEvaluator: {
          enabled: true,
          intervalMs: monitorIntervalMs,
          assignedHost: advertisedHost ?? systemHostname(),
        },
        hostname: advertisedHost,
        agentsInfraRoot,
        workloadAdmissionReachability: "daemon_listener",
        ...(activityTailerEnabled
          ? {
              activityTailer: {
                enabled: true,
                intervalMs: activityTailerIntervalMs,
                host: advertisedHost ?? systemHostname(),
              },
            }
          : {}),
        messageOutbox: {
          enabled: true,
          intervalMs: messageOutboxIntervalMs,
          serverUrlForHost: (targetHost) => {
            const target = configuredMessageRunServeTarget(hostsTruth, messageHostAliases, targetHost);
            if (!target) throw new Error(`No configured run-serve target for message host ${targetHost}.`);
            return target.serverUrl;
          },
          tokenForHost: (targetHost) => Promise.resolve(
            configuredMessageRunServeTarget(hostsTruth, messageHostAliases, targetHost)
              ? daemonOutboxToken
              : undefined,
          ),
          onError: (error) => {
            try {
              process.stderr.write(`[calyx-msg] outbox forwarder error: ${error.message}\n`);
            } catch {
              /* swallow */
            }
          },
        },
        detachedWorkerRedactedEnvNames: hostCredentialTruth.flatMap((row) => [
          row.token_env,
          row.verifier_env,
        ]),
      });
      const handle = await startRunServer({
        credentials,
        host,
        port,
        advertisedHost,
        messageHostAliases,
        daemonId: "run-serve",
        descriptorArgv: [
          currentCliEntrypoint() ?? "calyx",
          "run",
          "serve",
          "--host",
          host,
          "--port",
          `${port}`,
          "--runs-root",
          runsRoot,
          "--worktree-base",
          worktreeBase,
          "--monitor-interval-ms",
          `${monitorIntervalMs}`,
          "--message-outbox-interval-ms",
          `${messageOutboxIntervalMs}`,
          "--activity-tailer-interval-ms",
          `${activityTailerIntervalMs}`,
          ...(activityTailerEnabled ? [] : ["--no-activity-tailer"]),
        ],
        service,
      });
      service.startMonitorEvaluator();
      service.startMessageOutboxForwarder();
      if (activityTailerEnabled) {
        service.startActivityTailer();
      }

      if (options.json) {
        console.log(JSON.stringify({ url: handle.url }, null, 2));
      } else {
        console.log(`run server listening on ${handle.url}`);
      }
    });

  run
    .command("execute-stored")
    .description("Execute a persisted run intent by run_id")
    .requiredOption("--run-id <id>", "Run ID to execute")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .action(async (options: RunExecuteStoredCommandOptions) => {
      const service = createLocalRunService(runCliDeps, buildLocalRunServiceOptions({
        runsRoot: options.runsRoot?.trim() || defaultRunsRoot(),
        defaultWorktreeBase: defaultRunWorktreeBase(),
      }));
      const execution = { ownership: "acquired" as "acquired" | "contended" };
      const record = await service.executeStoredRun(options.runId, {
        onOwnershipResolved: (resolved) => {
          execution.ownership = resolved;
        },
      });
      // A duplicate detached worker that loses the durable execution mutex is
      // not an execution failure. The owner remains responsible for recording
      // and reporting the authoritative terminal result.
      if (execution.ownership === "contended") {
        return;
      }
      const spawnError = readSpawnError(record.kernel_receipt);
      if (spawnError) {
        console.error(spawnError);
      }
      const exitCode = deriveRunRecordExitCode(record);
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    });

  const msg = new Command("msg")
    .description("Send and inspect Calyx correspondence messages (POL-1789)");

  msg
    .command("send")
    .description("Send a directed message or scope bulletin")
    .option("--replay-request <path>", "Replay a retained 0600 exact-wire recovery artifact after an indeterminate remote send")
    .option("--to <address>", "Recipient address: run:<id>, interactive:<backend>:<session>, role:<name>[@host], host:<host>, or fleet")
    .option("--to-active <scope>", "Fan out to currently observable interactive sessions in host:<host> scope")
    .option("--subject <text>", "Message subject")
    .option("--body <text>", "Inline message body")
    .option("--body-file <path>", "Read message body from a file")
    .option("--sender <activity-id>", "Sender activity id (defaults to current activity when available)")
    .option("--thread <key>", "Thread key (defaults to a slug from the subject)")
    .option("--reply-to <message-id>", "Reply-to message locator")
    .option("--idempotency-key <key>", "Sender idempotency key")
    .option("--urgency <level>", "low, normal, or high", "normal")
    .option("--ack-required", "Mark directed message as requiring an ack")
    .option("--expires-at <iso>", "Message expiration timestamp; mandatory for scope bulletins unless --ttl-ms is used")
    .option("--ttl-ms <ms>", "Relative TTL in milliseconds; mandatory for scope bulletins unless --expires-at is used")
    .option("--host <host>", "Explicit target host for directed addresses without an embedded host")
    .option("--coordinator-host <host>", "Coordinator host for unqualified role and fleet addresses")
    .option("--server-url <url>", "Source/current RunService base URL for inert remote-recipient submission (not accepted with cross-host --wake)")
    .option("--auth-token <token>", `Source daemon bearer token for inert remote-recipient submission (not accepted with cross-host --wake; or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--spool-only", "Write sender outbox rows without attempting remote daemon delivery")
    .option("--wake", "After durable spooling, best-effort wake one exact activity binding")
    .option("--json", "Print machine-readable message result")
    .addHelpText("after", `
Examples:
  $ calyx msg send --to run:abc123 --subject "Baton" --body "Continue from the latest receipt." --ack-required --json
  $ calyx msg send --to interactive:claude:<session-id> --subject "Heads up" --body "Please pull your inbox." --wake --json
  $ calyx msg send --to-active host:blade --subject "Thread moved" --body "Use the new issue receipt." --json
`)
    .action(async (options: MsgSendCommandOptions) => {
      if (options.wake && options.toActive) {
        throw createCliError("--wake cannot be combined with --to-active; choose one exact activity and no message was written.", 2);
      }
      if (options.replayRequest?.trim()) {
        const replayed = await replayRemoteMessageRequest(
          runCliDeps,
          options.replayRequest.trim(),
          options.authToken,
        );
        printMsgSendResult(replayed, options.json);
        return;
      }
      if (options.to && options.toActive) {
        throw createCliError("Pass only one of --to or --to-active.", 2);
      }
      if (!options.to && !options.toActive) {
        throw createCliError("msg send requires --to or --to-active.", 2);
      }
      const sender = defaultActivityActor(options.sender);
      const subject = options.subject?.trim();
      if (!subject) {
        throw createCliError("msg send requires --subject <text>.", 2);
      }
      const body = await readMsgBody(options);
      const currentHost = await currentMessageHost(runCliDeps);

      if (options.toActive) {
        const scope = resolveMessageAddress(options.toActive, {
          currentHost,
          coordinatorHost: options.coordinatorHost,
          explicitHost: options.host,
        });
        if (scope.recipient_class !== "scope") {
          throw createCliError("--to-active requires a host scope address: host:<host>.", 2);
        }
        if (scope.kind === "fleet") {
          throw createCliError(
            "--to-active fleet is not supported because fleet-wide active session polling is not implemented. Use --to-active host:<host>.",
            2,
          );
        }
        const entries = await listRuns({
          includeInteractive: true,
          limit: "250",
          ...(scope.kind === "host" && scope.target_host ? { host: scope.target_host } : {}),
          ...(scope.kind !== "host" && options.host ? { host: options.host } : {}),
          ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
          ...(options.authToken ? { authToken: options.authToken } : {}),
        }, runCliDeps);
        const active = entries
          .map((entry) => ({ entry, address: activeSessionAddress(entry) }))
          .filter((item): item is { entry: Extract<RunActivityEntry, { entry_kind: "interactive_session" }>; address: string } =>
            Boolean(item.address) && "entry_kind" in item.entry && item.entry.entry_kind === "interactive_session",
          );
        const results = [];
        for (const item of active) {
          const itemOptions: MsgSendCommandOptions = {
            ...options,
            ...(options.idempotencyKey ? { idempotencyKey: `${options.idempotencyKey}:${item.address}` } : {}),
          };
          results.push(await sendOneMsg(item.address, itemOptions, runCliDeps, {
            sender,
            subject,
            body,
            currentHost,
            explicitHost: item.entry.host ?? currentHost,
            payload: {
              to_active_scope: scope.address,
              active_session_source: item.entry.source,
            },
          }));
        }
        const payload = {
          schema_version: "calyx.msg-send/v1",
          mode: "to_active",
          scope,
          count: results.length,
          messages: results.map((result) => result.message),
          results,
          delivery_notices: results.map((result) => ({
            message_id: result.message.message_id,
            notice: result.delivery_notice,
            delivery_state: result.delivery_state,
          })),
        };
        printMsgSendResult(payload, options.json);
        return;
      }

      const result = await sendOneMsg(options.to!, options, runCliDeps, {
        sender,
        subject,
        body,
        currentHost,
      });
      const payload = {
        schema_version: "calyx.msg-send/v1",
        mode: "single",
        message: result.message,
        inserted: result.inserted,
        receipt_path: result.receipt_path,
        resolved: result.resolved,
        delivery_notice: result.delivery_notice,
        delivery_state: result.delivery_state,
        ...(result.wake_result ? { wake: result.wake_result } : {}),
        ...(result.outbox ? { outbox: result.outbox } : {}),
        ...(result.operation ? { operation: result.operation } : {}),
      };
      printMsgSendResult(payload, options.json);
    });

  msg
    .command("reply")
    .argument("<message-id>", "Message id to reply to")
    .description("Reply to a message (sugar over msg send --reply-to)")
    .option("--to <address>", "Override inferred reply recipient")
    .option("--subject <text>", "Reply subject (defaults to Re: <original subject>)")
    .option("--body <text>", "Inline message body")
    .option("--body-file <path>", "Read message body from a file")
    .option("--sender <activity-id>", "Sender activity id (defaults to current activity when available)")
    .option("--thread <key>", "Thread key (defaults to the original thread or message id)")
    .option("--idempotency-key <key>", "Sender idempotency key")
    .option("--urgency <level>", "low, normal, or high", "normal")
    .option("--ack-required", "Mark directed message as requiring an ack")
    .option("--expires-at <iso>", "Message expiration timestamp")
    .option("--ttl-ms <ms>", "Relative TTL in milliseconds")
    .option("--host <host>", "Explicit target host for directed addresses without an embedded host")
    .option("--coordinator-host <host>", "Coordinator host for unqualified role addresses")
    .option("--server-url <url>", "Source/current RunService base URL for remote-recipient submission")
    .option("--auth-token <token>", `Source daemon bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--spool-only", "Write sender outbox rows without attempting remote daemon delivery")
    .option("--json", "Print machine-readable reply result")
    .addHelpText("after", `
Examples:
  $ calyx msg reply msg_123 --body "Handled; receipt is on the issue." --json
  $ calyx msg reply msg_123 --to interactive:codex:<session-id> --body-file /tmp/reply.md --json
`)
    .action(async (messageId: string, options: MsgReplyCommandOptions) => {
      const original = await withMessageState(async ({ db }) => readMessage(db, messageId));
      if (!original) {
        throw createCliError(`message not found: ${messageId}`, 4);
      }
      const sender = defaultActivityActor(options.sender);
      const subject = options.subject?.trim() || replySubject(original.subject);
      const body = await readMsgBody(options);
      const currentHost = await currentMessageHost(runCliDeps);
      const recipient = inferReplyRecipient(original, sender, options.to);
      const sendOptions: MsgSendCommandOptions = {
        ...options,
        to: recipient.address,
        subject,
        thread: options.thread?.trim() || original.thread_key || original.message_id,
        replyTo: original.message_id,
      };
      const result = await sendOneMsg(recipient.address, sendOptions, runCliDeps, {
        sender,
        subject,
        body,
        currentHost,
      });
      const payload = {
        schema_version: "calyx.msg-reply/v1",
        mode: "reply",
        reply_to: original.message_id,
        reply_recipient: recipient,
        message: result.message,
        inserted: result.inserted,
        receipt_path: result.receipt_path,
        resolved: result.resolved,
        delivery_notice: result.delivery_notice,
        delivery_state: result.delivery_state,
        ...(result.wake_result ? { wake: result.wake_result } : {}),
        ...(result.outbox ? { outbox: result.outbox } : {}),
        ...(result.operation ? { operation: result.operation } : {}),
      };
      printMsgSendResult(payload, options.json);
    });

  msg
    .command("inbox")
    .description("Read directed inbox messages or peek scope bulletins")
    .option("--for <address>", "Directed recipient address (defaults to current activity)")
    .option("--scope <address>", "Scope bulletin address: host:<host> or fleet")
    .option("--peek", "Read without claiming directed messages")
    .option("--claimed-by <activity-id>", "Claim actor (defaults to current activity)")
    .option("--claim-ttl-ms <ms>", "Claim lease duration", String(MESSAGE_CLAIM_TTL_MS))
    .option("--limit <n>", "Maximum messages to return")
    .option("--host <host>", "Explicit host for directed addresses without embedded host")
    .option("--coordinator-host <host>", "Coordinator host for unqualified role and fleet addresses")
    .option("--json", "Print machine-readable inbox")
    .action(async (options: MsgInboxCommandOptions) => {
      if (options.for && options.scope) {
        throw createCliError("Pass only one of --for or --scope.", 2);
      }
      const currentHost = await currentMessageHost(runCliDeps);
      const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : undefined;
      if (options.scope) {
        const resolved = resolveMessageAddress(options.scope, {
          currentHost,
          coordinatorHost: options.coordinatorHost,
          explicitHost: options.host,
        });
        if (resolved.recipient_class !== "scope") {
          throw createCliError("--scope must be host:<host> or fleet.", 2);
        }
        const rows = await withMessageState(async ({ db }) => peekScopeMessages(db, resolved.address, { limit }));
        const payload = {
          schema_version: "calyx.msg-inbox/v1",
          mode: "scope",
          peek: true,
          recipient: resolved,
          count: rows.length,
          messages: rows,
        };
        if (options.json) console.log(JSON.stringify(payload, null, 2));
        else printMessageRows(rows);
        return;
      }

      const recipientRaw = options.for?.trim() || defaultActivityActor();
      const recipient = resolveMessageAddress(recipientRaw, {
        currentHost,
        coordinatorHost: options.coordinatorHost,
        explicitHost: options.host,
      });
      if (recipient.recipient_class !== "directed") {
        throw createCliError("directed inbox requires a run, interactive, authorship, or role address.", 2);
      }
      const claimTtlMs = options.claimTtlMs
        ? parsePositiveInteger(options.claimTtlMs, "--claim-ttl-ms")
        : MESSAGE_CLAIM_TTL_MS;
      const rows = await withMessageState(async ({ db }) => claimDirectedMessages(db, {
        recipient_address: recipient.address,
        claimed_by: options.claimedBy?.trim() || defaultActivityActor(),
        claim_ttl_ms: claimTtlMs,
        limit,
        peek: Boolean(options.peek),
      }));
      const payload = {
        schema_version: "calyx.msg-inbox/v1",
        mode: "directed",
        peek: Boolean(options.peek),
        recipient,
        count: rows.length,
        messages: rows,
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else printMessageRows(rows);
    });

  msg
    .command("ack")
    .argument("<message-id>", "Message id")
    .description("Ack a directed message")
    .option("--acked-by <activity-id>", "Ack actor (defaults to current activity)")
    .option("--json", "Print machine-readable ack result")
    .action(async (messageId: string, options: MsgAckCommandOptions) => {
      const result = await withMessageState(async ({ db }) => ackMessage(db, messageId, {
        acked_by: options.ackedBy?.trim() || defaultActivityActor(),
      }));
      const payload = {
        schema_version: "calyx.msg-ack/v1",
        message_id: messageId,
        changed: result.changed,
        message: result.message,
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else if (result.message) console.log(`acked ${result.message.message_id} changed=${result.changed}`);
      else throw createCliError(`message not found: ${messageId}`, 4);
    });

  msg
    .command("thread")
    .argument("<thread-key>", "Thread key")
    .description("Show messages in a thread")
    .option("--limit <n>", "Maximum messages to return")
    .option("--json", "Print machine-readable thread")
    .action(async (threadKey: string, options: MsgThreadCommandOptions) => {
      const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : undefined;
      const rows = await withMessageState(async ({ db }) => listThreadMessages(db, threadKey, { limit }));
      const payload = {
        schema_version: "calyx.msg-thread/v1",
        thread_key: threadKey,
        count: rows.length,
        messages: rows,
      };
      if (options.json) console.log(JSON.stringify(payload, null, 2));
      else printMessageRows(rows);
    });

  msg
    .command("operation")
    .argument("<outbox-id>", "Source-daemon message outbox operation id")
    .description("Observe one exact cross-host message forwarding operation")
    .option("--host <host>", "Observe the operation on this source host's run serve daemon")
    .option("--server-url <url>", "Exact source-daemon RunService base URL")
    .option("--auth-token <token>", `Source-daemon bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print the machine-readable operation")
    .action(async (outboxId: string, options: MsgOperationCommandOptions) => {
      const normalizedOutboxId = outboxId.trim();
      if (!normalizedOutboxId) {
        throw createCliError("msg operation requires a non-empty outbox id.", 2);
      }
      const currentHost = await currentMessageHost(runCliDeps);
      const sourceHost = options.host?.trim() || currentHost;
      const remote = Boolean(options.host?.trim() || options.serverUrl?.trim() || options.authToken?.trim());
      const operation = remote
        ? await (async (): Promise<MessageOperationView> => {
            const access = await resolveRunServerAccess({
              host: sourceHost,
              serverUrl: options.serverUrl,
              authToken: options.authToken,
            }, runCliDeps);
            if (!access.token) {
              throw createCliError(
                `msg operation for ${sourceHost} requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
                2,
              );
            }
            return requireClientResult(
              await remoteAdminClient(runCliDeps, {
                serverUrl: access.serverUrl,
                token: access.token,
              }).admin.msg.operation({ path: { outboxId: normalizedOutboxId } }),
              `message operation ${normalizedOutboxId} on ${sourceHost}`,
            ) as MessageOperationView;
          })()
        : await readLocalMessageOperation(normalizedOutboxId, runCliDeps);
      if (options.json) {
        console.log(JSON.stringify(operation, null, 2));
      } else {
        console.log(`${operation.operation_id}  ${operation.status}  target=${operation.target_host}  attempts=${operation.attempt_count}`);
        if (operation.receipt) {
          console.log(`  receipt: ${operation.receipt.outcome} at ${operation.receipt.completed_at}`);
        }
      }
    });

  msg
    .command("doctor")
    .description("Inspect message state schema and pending counts")
    .option("--json", "Print machine-readable doctor")
    .action(async (options: MsgDoctorCommandOptions) => {
      const report = await runStateDoctor({ domains: ["messages"] });
      const payload = {
        schema_version: "calyx.msg-doctor/v1",
        ok: report.ok,
        messages: report.messages,
        findings: report.findings.filter((finding) => finding.code.startsWith("messages-")),
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`messages: ${report.messages.schemaParity}`);
        console.log(`  rows: ${report.messages.messageCount}`);
        console.log(`  pending directed: ${report.messages.pendingCounts.directed_pending}`);
        console.log(`  claimed directed: ${report.messages.pendingCounts.directed_claimed}`);
        console.log(`  pending scope: ${report.messages.pendingCounts.scope_pending}`);
        console.log(`  outbox pending: ${report.messages.pendingCounts.outbox_pending}`);
      }
    });

  const lease = new Command("lease")
    .description("Acquire and inspect named-resource leases (POL-1790)");

  lease
    .command("acquire")
    .argument("<key>", "Lease key: worktree:<host>:<path>, session:<activity-id>, vault:<path>, or issue:<id>")
    .description("Acquire a lease if no active holder owns it")
    .requiredOption("--holder <activity-id>", "Holder activity id recorded in the lease")
    .option("--ttl-ms <ms>", "Lease TTL in milliseconds", "1800000")
    .option("--coordinator-host <host>", "Owning host for vault:/issue: leases")
    .option("--server-url <url>", "Owning host run server URL override")
    .option("--auth-token <token>", `Run server bearer token (or ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--idempotency-key <key>", "Stable request key for safe remote retries")
    .option("--json", "Print machine-readable result")
    .action(async (key: string, options: LeaseAcquireCommandOptions) => {
      const ttlMs = parseLeaseTtlMs(options.ttlMs);
      const holder = requireLeaseHolder(options.holder);
      const coordinatorHost = options.coordinatorHost?.trim() || defaultLeaseCoordinatorHost();
      const idempotencyKey = options.idempotencyKey?.trim() || `lease-acquire:${randomUUID()}`;
      const body = {
        key,
        idempotency_key: idempotencyKey,
        holder_activity_id: holder,
        ttl_ms: ttlMs,
        coordinator_host: coordinatorHost,
      };
      const routing = await resolveLeaseOwnerRouting(key, options, runCliDeps);
      const result: LeaseAcquireResult = routing.local
        ? await withLeaseState(({ db }) => acquireLease(db, {
            key,
            holder_activity_id: holder,
            ttl_ms: ttlMs,
            coordinator_host: coordinatorHost,
          }))
        : await executeRecoverableMutation(runCliDeps, {
            serverUrl: routing.serverUrl!,
            token: routing.token!,
          }, {
            context: `lease owning-host ${routing.ownerHost}`,
            replayCommand: "calyx client replay",
            operation: (client) => client.admin.lease.acquire({ body }),
          }) as unknown as LeaseAcquireResult;
      if (!result.acquired || !result.lease) {
        throw createCliError(formatLeaseConflict(result), 6);
      }
      printLeaseMutation("acquired lease", { schema_version: "calyx.lease-acquire/v1", lease: result.lease }, options.json);
    });

  lease
    .command("renew")
    .argument("<key>", "Lease key")
    .description("Renew a lease held by the supplied activity id")
    .requiredOption("--holder <activity-id>", "Current holder activity id")
    .option("--ttl-ms <ms>", "Replacement TTL in milliseconds")
    .option("--coordinator-host <host>", "Owning host for vault:/issue: leases")
    .option("--server-url <url>", "Owning host run server URL override")
    .option("--auth-token <token>", `Run server bearer token (or ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--idempotency-key <key>", "Stable request key for safe remote retries")
    .option("--json", "Print machine-readable result")
    .action(async (key: string, options: LeaseRenewCommandOptions) => {
      const holder = requireLeaseHolder(options.holder);
      const coordinatorHost = options.coordinatorHost?.trim() || defaultLeaseCoordinatorHost();
      const ttlMs = options.ttlMs ? parseLeaseTtlMs(options.ttlMs) : undefined;
      const idempotencyKey = options.idempotencyKey?.trim() || `lease-renew:${randomUUID()}`;
      const body = {
        key,
        idempotency_key: idempotencyKey,
        holder_activity_id: holder,
        ...(ttlMs ? { ttl_ms: ttlMs } : {}),
        coordinator_host: coordinatorHost,
      };
      const routing = await resolveLeaseOwnerRouting(key, options, runCliDeps);
      const result: LeaseRenewResult = routing.local
        ? await withLeaseState(({ db }) => renewLease(db, {
            key,
            holder_activity_id: holder,
            ...(ttlMs ? { ttl_ms: ttlMs } : {}),
          }))
        : await executeRecoverableMutation(runCliDeps, {
            serverUrl: routing.serverUrl!,
            token: routing.token!,
          }, {
            context: `lease owning-host ${routing.ownerHost}`,
            replayCommand: "calyx client replay",
            operation: (client) => client.admin.lease.renew({ body }),
          }) as unknown as LeaseRenewResult;
      if (!result.renewed || !result.lease) {
        throw createCliError(formatLeaseConflict(result), 6);
      }
      printLeaseMutation("renewed lease", { schema_version: "calyx.lease-renew/v1", lease: result.lease }, options.json);
    });

  lease
    .command("release")
    .argument("<key>", "Lease key")
    .description("Release a lease held by the supplied activity id")
    .option("--holder <activity-id>", "Current holder activity id")
    .option("--force", "Release without holder match")
    .option("--coordinator-host <host>", "Owning host for vault:/issue: leases")
    .option("--server-url <url>", "Owning host run server URL override")
    .option("--auth-token <token>", `Run server bearer token (or ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--idempotency-key <key>", "Stable request key for safe remote retries")
    .option("--json", "Print machine-readable result")
    .action(async (key: string, options: LeaseReleaseCommandOptions) => {
      if (!options.force) {
        requireLeaseHolder(options.holder);
      }
      const holder = options.holder?.trim();
      const coordinatorHost = options.coordinatorHost?.trim() || defaultLeaseCoordinatorHost();
      const idempotencyKey = options.idempotencyKey?.trim() || `lease-release:${randomUUID()}`;
      const body = {
        key,
        idempotency_key: idempotencyKey,
        ...(holder ? { holder_activity_id: holder } : {}),
        force: options.force === true,
        coordinator_host: coordinatorHost,
      };
      const routing = await resolveLeaseOwnerRouting(key, options, runCliDeps);
      const result: LeaseReleaseResult = routing.local
        ? await withLeaseState(({ db }) => releaseLease(db, {
            key,
            ...(holder ? { holder_activity_id: holder } : {}),
            force: options.force === true,
          }))
        : await executeRecoverableMutation(runCliDeps, {
            serverUrl: routing.serverUrl!,
            token: routing.token!,
          }, {
            context: `lease owning-host ${routing.ownerHost}`,
            replayCommand: "calyx client replay",
            operation: (client) => client.admin.lease.release({ body }),
          }) as unknown as LeaseReleaseResult;
      if (!result.released) {
        throw createCliError(formatLeaseConflict(result), 6);
      }
      printLeaseMutation("released lease", { schema_version: "calyx.lease-release/v1", lease: result.lease }, options.json);
    });

  lease
    .command("steal")
    .argument("<key>", "Lease key")
    .description("Explicitly steal a lease with provenance")
    .requiredOption("--holder <activity-id>", "New holder activity id")
    .requiredOption("--provenance <text>", "Why this steal is authorized")
    .option("--ttl-ms <ms>", "Lease TTL in milliseconds", "1800000")
    .option("--coordinator-host <host>", "Owning host for vault:/issue: leases")
    .option("--server-url <url>", "Owning host run server URL override")
    .option("--auth-token <token>", `Run server bearer token (or ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--idempotency-key <key>", "Stable request key for safe remote retries")
    .option("--json", "Print machine-readable result")
    .action(async (key: string, options: LeaseStealCommandOptions) => {
      const holder = requireLeaseHolder(options.holder);
      const provenance = options.provenance?.trim();
      if (!provenance) {
        throw createCliError("lease steal requires --provenance <text>.", 2);
      }
      const ttlMs = parseLeaseTtlMs(options.ttlMs);
      const coordinatorHost = options.coordinatorHost?.trim() || defaultLeaseCoordinatorHost();
      const idempotencyKey = options.idempotencyKey?.trim() || `lease-steal:${randomUUID()}`;
      const body = {
        key,
        idempotency_key: idempotencyKey,
        holder_activity_id: holder,
        ttl_ms: ttlMs,
        provenance,
        coordinator_host: coordinatorHost,
      };
      const routing = await resolveLeaseOwnerRouting(key, options, runCliDeps);
      const result: LeaseStealResult = routing.local
        ? await withLeaseState(({ db }) => stealLease(db, {
            key,
            holder_activity_id: holder,
            ttl_ms: ttlMs,
            provenance,
            coordinator_host: coordinatorHost,
          }))
        : await executeRecoverableMutation(runCliDeps, {
            serverUrl: routing.serverUrl!,
            token: routing.token!,
          }, {
            context: `lease owning-host ${routing.ownerHost}`,
            replayCommand: "calyx client replay",
            operation: (client) => client.admin.lease.steal({ body }),
          }) as unknown as LeaseStealResult;
      const payload = {
        schema_version: "calyx.lease-steal/v1",
        ...result,
        notification: leaseStealNotificationPayload(result),
      };
      printLeaseMutation("stole lease", payload, options.json);
    });

  lease
    .command("list")
    .description("List leases on the selected owning host")
    .option("--holder <activity-id>", "Filter by holder activity id")
    .option("--kind <kind>", `Filter by kind: ${LEASE_RESOURCE_KINDS.join(", ")}`)
    .option("--owner-host <host>", "List leases from this owning host daemon")
    .option("--include-expired", "Include expired leases")
    .option("--limit <n>", "Maximum rows to return")
    .option("--coordinator-host <host>", "Owning host for vault:/issue: leases")
    .option("--server-url <url>", "Owning host run server URL override")
    .option("--auth-token <token>", `Run server bearer token (or ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable list")
    .action(async (options: LeaseListCommandOptions) => {
      const kind = parseLeaseKind(options.kind);
      const ownerHost = options.ownerHost?.trim();
      const limit = parseLeaseLimit(options.limit);
      const currentHost = await resolveLeaseCurrentHost(runCliDeps);
      const routeRemote = Boolean(options.serverUrl?.trim())
        || (ownerHost ? normalizeLeaseHost(ownerHost) !== currentHost : false);
      const query = {
        ...(options.holder?.trim() ? { holder_activity_id: options.holder.trim() } : {}),
        ...(kind ? { resource_kind: kind } : {}),
        ...(ownerHost ? { owner_host: ownerHost } : {}),
        include_expired: options.includeExpired === true,
        ...(limit ? { limit } : {}),
      };
      let rows: LeaseRow[];
      if (routeRemote) {
        const targetHost = ownerHost ?? currentHost;
        const access = await resolveRunServerAccess({
          host: targetHost,
          serverUrl: options.serverUrl,
          authToken: options.authToken,
        }, runCliDeps);
        if (!access.token) {
          throw createCliError(
            `lease list for ${targetHost} requires --auth-token or ${RUN_SERVER_CREDENTIAL_HINT}.`,
            2,
          );
        }
        rows = requireClientResult(
          await remoteAdminClient(runCliDeps, {
            serverUrl: access.serverUrl,
            token: access.token,
          }).admin.lease.list({ body: query }),
          `lease owning-host ${targetHost}`,
        ) as unknown as LeaseRow[];
      } else {
        rows = await withLeaseState(({ db }) => listLeases(db, query));
      }
      const payload = { schema_version: "calyx.lease-list/v1", count: rows.length, leases: rows };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printLeaseRows(rows);
      }
    });

  lease
    .command("doctor")
    .description("Check local lease state schema and expired rows")
    .option("--json", "Print machine-readable doctor report")
    .action(async (options: { json?: boolean }) => {
      const report = await runStateDoctor({ domains: ["leases"] });
      const payload = {
        schema_version: "calyx.lease-doctor/v1",
        ok: report.ok,
        leases: report.leases,
        findings: report.domains?.find((domain) => domain.domain === "leases")?.findings ?? [],
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`leases: ${report.leases.schemaParity}`);
        console.log(`rows: ${report.leases.rowCount}`);
        console.log(`expired: ${report.leases.expiredCount}`);
        for (const finding of payload.findings) {
          console.log(`${finding.severity.toUpperCase()} ${finding.code}\t${finding.message}`);
        }
      }
      if (!report.ok) {
        throw createCliError("calyx lease doctor reported blocking findings", 4);
      }
    });

  const monitor = new Command("monitor")
    .description("Create and inspect typed monitor wake records (POL-1732)");

  monitor
    .command("create")
    .description("Create a monitor from a bounded preset")
    .requiredOption("--preset <preset>", "Monitor preset (runner-supervision)")
    .requiredOption("--run <id>", "Run id for --preset runner-supervision")
    .option("--owner <owner>", "Monitor owner (default: current activity identity)")
    .option("--created-by <actor>", "Actor recorded as creator")
    .option("--provenance <kind>", "Create provenance: operator or conductor", "operator")
    .option("--assigned-host <host>", "Host whose run serve evaluator should own this monitor")
    .option("--rearm <policy>", "Re-arm policy: once, rearm_on_reset, every_change", "every_change")
    .option("--stale-after-ms <ms>", "runner-supervision health stale threshold", "1800000")
    .option(
      "--deliver <binding>",
      "Repeatable delivery binding: adapter[,key=value...]",
      collectMonitorDeliveryOption,
      [] as string[],
    )
    .option("--no-default-deliveries", "Use Tier-0 delivery only unless --deliver is provided")
    .option("--idempotency-key <key>", "Stable request key for safe monitor-create retries")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable monitor")
    .action(async (options: MonitorCreateCommandOptions) => {
      const preset = options.preset?.trim();
      if (preset !== "runner-supervision") {
        throw createCliError("POL-1732a supports only --preset runner-supervision.", 2);
      }
      const runId = options.run?.trim();
      if (!runId) {
        throw createCliError("monitor create --preset runner-supervision requires --run <id>.", 2);
      }
      const staleAfterMs = parsePositiveInteger(options.staleAfterMs ?? "1800000", "--stale-after-ms");
      const delivery = buildMonitorDeliveryPolicyFromOptions(options);
      const owner = options.owner?.trim() || defaultActivityActor();
      const createdBy = options.createdBy?.trim() || defaultMonitorActor();
      const provenance = parseMonitorProvenance(options.provenance);
      const assignedHost = normalizeMonitorHost(options.assignedHost) || defaultMonitorHost();
      const rearmPolicy = parseMonitorRearmPolicy(options.rearm);
      const idempotencyKey = options.idempotencyKey?.trim() || `monitor-create:${randomUUID()}`;
      const fallbackArgs = [
        "create",
        "--preset",
        preset,
        "--run",
        runId,
        "--assigned-host",
        assignedHost,
        "--owner",
        owner,
        "--created-by",
        createdBy,
        "--provenance",
        provenance,
        "--rearm",
        rearmPolicy,
        "--stale-after-ms",
        String(staleAfterMs),
        "--idempotency-key",
        idempotencyKey,
        ...(options.defaultDeliveries === false ? ["--no-default-deliveries"] : []),
        ...(options.deliver ?? []).flatMap((binding) => ["--deliver", binding]),
      ];
      const remote = await resolveRemoteMonitorAccess({
        host: assignedHost,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "create",
        fallbackArgs,
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "create",
            recoverable: true,
            operation: (client) => client.admin.monitor.create({ body: ({
              schema_version: "calyx.monitor-create-request/v1",
              idempotency_key: idempotencyKey,
              owner,
              created_by: createdBy,
              create_provenance: provenance,
              assigned_host: assignedHost,
              source_run_id: runId,
              preset,
              stale_after_ms: staleAfterMs,
              rearm_policy: rearmPolicy,
              delivery,
            } satisfies MonitorRemoteCreateRequest) as unknown as Parameters<
              CalyxAdminClient["admin"]["monitor"]["create"]
            >[0]["body"] }),
          },
        ) as unknown as MonitorCreatePayload;
        printMonitorObject("created monitor", payload, options.json);
        return;
      }

      await assertLocalRunnerSupervisionRunKnown(runId, assignedHost, runCliDeps);
      const monitorRow = await withMonitorState(async ({ db }) => createMonitor(db, {
        owner,
        created_by: createdBy,
        create_provenance: provenance,
        assigned_host: assignedHost,
        source_run_id: runId,
        preset,
        predicate: runnerSupervisionPredicate(runId, staleAfterMs),
        rearm_policy: rearmPolicy,
        delivery,
      }));
      const payload: MonitorCreatePayload = {
        schema_version: "calyx.monitor-create/v1",
        owner_host: assignedHost,
        storage: {
          host: assignedHost,
          inspect_command: `calyx monitor show ${monitorRow.monitor_id} --host ${assignedHost} --json`,
        },
        note: `monitor row lives on ${assignedHost}; inspect with --host ${assignedHost}`,
        monitor: monitorRow,
      };
      printMonitorObject("created monitor", payload, options.json);
    });

  monitor
    .command("list")
    .description("List monitors")
    .option("--status <status>", "active, cancelled, or all", "active")
    .option("--run <id>", "Filter by source run id")
    .option("--assigned-host <host>", "Filter by assigned host")
    .option("--limit <n>", "Maximum rows to return")
    .option("--host <host>", "Read monitors from this host's run serve daemon")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable list")
    .action(async (options: MonitorListCommandOptions) => {
      const status = parseMonitorStatus(options.status);
      const sourceRunId = options.run?.trim();
      const assignedHost = normalizeMonitorHost(options.assignedHost);
      const limit = parseMonitorLimit(options.limit);
      const remote = await resolveRemoteMonitorAccess({
        host: options.host,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "list",
        fallbackArgs: [
          "list",
          "--status",
          status,
          ...(sourceRunId ? ["--run", sourceRunId] : []),
          ...(assignedHost ? ["--assigned-host", assignedHost] : []),
          ...(typeof limit === "number" ? ["--limit", String(limit)] : []),
        ],
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "list",
            operation: (client) => client.admin.monitor.list({ query: {
              status,
              ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
              ...(assignedHost ? { assigned_host: assignedHost } : {}),
              ...(typeof limit === "number" ? { limit: String(limit) } : {}),
            } }),
          },
        ) as unknown as MonitorListPayload;
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printMonitorRows(payload.monitors);
        }
        return;
      }

      const rows = await withMonitorState(async ({ db }) => listMonitors(db, {
        status: parseMonitorStatus(options.status),
        ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
        ...(assignedHost ? { assigned_host: assignedHost } : {}),
        limit,
      }));
      const payload: MonitorListPayload = { schema_version: "calyx.monitor-list/v1", count: rows.length, monitors: rows };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printMonitorRows(rows);
      }
    });

  monitor
    .command("show")
    .argument("<monitor-id>", "Monitor id")
    .description("Show a monitor")
    .option("--host <host>", "Read the monitor from this host's run serve daemon")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable monitor")
    .action(async (monitorId: string, options: MonitorShowCommandOptions) => {
      const remote = await resolveRemoteMonitorAccess({
        host: options.host,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "show",
        fallbackArgs: ["show", monitorId],
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "show",
            operation: (client) => client.admin.monitor.get({ path: { monitorId } }),
          },
        ) as unknown as MonitorShowPayload;
        printMonitorObject("monitor", payload, options.json);
        return;
      }

      const payload = await withMonitorState(async ({ db }) => {
        const row = readMonitor(db, monitorId);
        if (!row) {
          throw createCliError(`monitor not found: ${monitorId}`, 4);
        }
        const deliveries = listMonitorDeliveries(db, { monitor_id: monitorId, limit: 500 });
        return {
          schema_version: "calyx.monitor-show/v1",
          monitor: row,
          delivery_state: monitorDeliveryState(deliveries),
        } satisfies MonitorShowPayload;
      });
      printMonitorObject("monitor", payload, options.json);
    });

  monitor
    .command("cancel")
    .argument("<monitor-id>", "Monitor id")
    .description("Cancel a monitor")
    .option("--reason <text>", "Cancellation reason")
    .option("--host <host>", "Cancel the monitor on this host's run serve daemon")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable monitor")
    .action(async (monitorId: string, options: MonitorCancelCommandOptions) => {
      const reason = options.reason?.trim() || "cancelled by operator";
      const remote = await resolveRemoteMonitorAccess({
        host: options.host,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "cancel",
        fallbackArgs: ["cancel", monitorId, "--reason", reason],
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "cancel",
            reconciliationCommand: exactEndpointReconciliationCommand(
              ["calyx", "monitor", "show", monitorId],
              remote.serverUrl,
            ),
            operation: (client) => client.admin.monitor.cancel({
              path: { monitorId },
              body: { reason },
            }),
          },
        ) as unknown as MonitorCancelPayload;
        printMonitorObject("cancelled monitor", payload, options.json);
        return;
      }

      const row = await withMonitorState(async ({ db }) => cancelMonitor(db, monitorId, {
        detail: reason,
      }));
      if (!row) {
        throw createCliError(`monitor not found: ${monitorId}`, 4);
      }
      const payload: MonitorCancelPayload = { schema_version: "calyx.monitor-cancel/v1", monitor: row };
      printMonitorObject("cancelled monitor", payload, options.json);
    });

  monitor
    .command("history")
    .argument("<monitor-id>", "Monitor id")
    .description("Show monitor history")
    .option("--limit <n>", "Maximum rows to return")
    .option("--json", "Print machine-readable history")
    .action(async (monitorId: string, options: MonitorHistoryCommandOptions) => {
      const { rows, deliveries } = await withMonitorState(async ({ db }) => ({
        rows: listMonitorHistory(db, monitorId, {
          limit: parseMonitorLimit(options.limit),
        }),
        deliveries: listMonitorDeliveries(db, {
          monitor_id: monitorId,
          limit: parseMonitorLimit(options.limit, "--limit") ?? 500,
        }),
      }));
      const payload = {
        schema_version: "calyx.monitor-history/v1",
        monitor_id: monitorId,
        count: rows.length,
        events: rows,
        delivery_state: monitorDeliveryState(deliveries),
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (rows.length === 0) {
        console.log("no history");
        printMonitorDeliverySummary(payload.delivery_state);
      } else {
        for (const row of rows) {
          console.log(`${row.history_id}  ${row.occurred_at}  ${row.event_type}  ${row.wake_id ?? "-"}  ${row.detail ?? ""}`.trimEnd());
        }
        printMonitorDeliverySummary(payload.delivery_state);
      }
    });

  monitor
    .command("inbox")
    .description("Claim pending wake records (or list them with --peek)")
    .option("--status <status>", "pending, claimed, acked, or all")
    .option("--monitor <id>", "Filter by monitor id")
    .option("--wake-id <id>", "Read one exact wake without pagination")
    .option("--limit <n>", "Maximum rows to return")
    .option("--claimed-by <actor>", "Actor claiming pending wakes")
    .option("--peek", "List without claiming pending wakes")
    .option("--host <host>", "Read wakes from this host's run serve daemon")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable inbox")
    .action(async (options: MonitorInboxCommandOptions) => {
      const status = parseMonitorWakeStatus(options.status);
      const monitorId = options.monitor?.trim();
      const wakeId = options.wakeId?.trim();
      const limit = parseMonitorLimit(options.limit);
      const claimedBy = options.claimedBy?.trim() || defaultActivityActor();
      if (wakeId && (options.status !== undefined || monitorId || options.limit !== undefined || options.claimedBy !== undefined)) {
        throw createCliError(
          "monitor_exact_wake_query_conflict: --wake-id cannot be combined with --status, --monitor, --limit, or --claimed-by",
          2,
        );
      }
      const shouldClaim = !wakeId && status === "pending" && !options.peek;
      const claimIdempotencyKey = `monitor-claim:${randomUUID()}`;
      const fallbackArgs = wakeId
        ? ["inbox", "--wake-id", wakeId, "--peek"]
        : [
            "inbox",
            "--status",
            status,
            ...(monitorId ? ["--monitor", monitorId] : []),
            ...(typeof limit === "number" ? ["--limit", String(limit)] : []),
            ...(shouldClaim ? ["--claimed-by", claimedBy] : ["--peek"]),
          ];
      const remote = await resolveRemoteMonitorAccess({
        host: options.host,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "inbox",
        fallbackArgs,
        ...(shouldClaim ? { requiredFeatures: [CALYX_DAEMON_FEATURES.monitorClaimV1] } : {}),
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "inbox",
            recoverable: shouldClaim,
            operation: (client) => shouldClaim
              ? client.admin.monitor.claim({ body: {
                  claimed_by: claimedBy,
                  idempotency_key: claimIdempotencyKey,
                  ...(monitorId ? { monitor: monitorId } : {}),
                  ...(typeof limit === "number" ? { limit } : {}),
                } })
              : client.admin.monitor.wakes({
                  query: wakeId
                    ? { wake_id: wakeId }
                    : {
                        status,
                        ...(monitorId ? { monitor: monitorId } : {}),
                        ...(typeof limit === "number" ? { limit: String(limit) } : {}),
                      },
                }),
          },
        ) as unknown as MonitorInboxPayload;
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          printMonitorWakeRows(payload.wakes);
          printMonitorDeliverySummary(payload.delivery_state);
        }
        return;
      }

      const { rows, deliveries } = await withMonitorState(async ({ db }) => {
        const wakes = wakeId
          ? [readMonitorWake(db, wakeId)].filter((wake): wake is MonitorWakeRow => wake !== undefined)
          : shouldClaim
          ? claimMonitorWakes(db, {
              claimed_by: claimedBy,
              ...(monitorId ? { monitor_id: monitorId } : {}),
              limit,
            })
          : listMonitorWakes(db, {
              status,
              ...(monitorId ? { monitor_id: monitorId } : {}),
              limit,
            });
        const wakeIds = new Set(wakes.map((wake) => wake.wake_id));
        const allDeliveries = wakeId
          ? listMonitorDeliveries(db, { wake_id: wakeId, limit: 500 })
          : monitorId
          ? listMonitorDeliveries(db, { monitor_id: monitorId, limit: 500 })
          : listMonitorDeliveries(db, { limit: 500 });
        return {
          rows: wakes,
          deliveries: allDeliveries.filter((delivery) => wakeIds.has(delivery.wake_id)),
        };
      });
      const payload: MonitorInboxPayload = {
        schema_version: "calyx.monitor-inbox/v1",
        count: rows.length,
        wakes: rows,
        delivery_state: monitorDeliveryState(deliveries),
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printMonitorWakeRows(rows);
        printMonitorDeliverySummary(payload.delivery_state);
      }
    });

  monitor
    .command("ack")
    .argument("<wake-id>", "Wake id")
    .description("Acknowledge a wake claimed by the same actor")
    .option("--acked-by <actor>", "Exact claimant acknowledging the wake")
    .option("--host <host>", "Acknowledge the wake on this host's run serve daemon")
    .option("--server-url <url>", "Run server URL for explicit remote daemon access")
    .option("--auth-token <token>", `Run server bearer token (default: ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable acknowledgement")
    .action(async (wakeId: string, options: MonitorAckCommandOptions) => {
      const ackedBy = options.ackedBy?.trim() || defaultActivityActor();
      const remote = await resolveRemoteMonitorAccess({
        host: options.host,
        serverUrl: options.serverUrl,
        authToken: options.authToken,
        action: "ack",
        fallbackArgs: ["ack", wakeId, "--acked-by", ackedBy],
        requiredFeatures: [CALYX_DAEMON_FEATURES.monitorClaimV1],
      }, runCliDeps);
      if (remote) {
        const payload = await requestRemoteMonitor(
          runCliDeps,
          remote,
          {
            action: "ack",
            reconciliationCommand: exactEndpointReconciliationCommand(
              ["calyx", "monitor", "inbox", "--wake-id", wakeId, "--peek"],
              remote.serverUrl,
            ),
            operation: (client) => client.admin.monitor.ack({
              path: { wakeId },
              body: { acked_by: ackedBy },
            }),
          },
        ) as unknown as MonitorAckPayload;
        if (options.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(`${payload.changed ? "acked" : "already acked"}: ${payload.wake.wake_id}`);
        }
        return;
      }

      const result = await withMonitorState(async ({ db }) => ackMonitorWake(db, wakeId, {
        acked_by: ackedBy,
      }));
      if (!result.wake) {
        throw createCliError(`wake not found: ${wakeId}`, 4);
      }
      const payload: MonitorAckPayload = {
        schema_version: "calyx.monitor-ack/v1",
        changed: result.changed,
        wake: result.wake,
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`${result.changed ? "acked" : "already acked"}: ${result.wake.wake_id}`);
      }
    });

  monitor
    .command("doctor")
    .description("Inspect monitor state schema and row counts")
    .option("--json", "Print machine-readable doctor report")
    .action(async (options: MonitorDoctorCommandOptions) => {
      const report = await runStateDoctor({ domains: ["monitors"] });
      const payload = {
        schema_version: "calyx.monitor-doctor/v1",
        ok: report.ok,
        monitors: report.monitors,
        domains: report.domains ?? [],
        findings: report.findings.filter((finding) => finding.code.startsWith("monitors-")),
      };
      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`monitors: ${report.monitors.schemaParity}`);
        console.log(`  rows: ${report.monitors.monitorCount}`);
        console.log(`  wakes: ${report.monitors.wakeCount}`);
        console.log(`  deliveries: ${report.monitors.deliveryCount}`);
        console.log(`    attempted: ${report.monitors.deliveryCounts.attempted}`);
        console.log(`    delivered: ${report.monitors.deliveryCounts.delivered}`);
        console.log(`    failed: ${report.monitors.deliveryCounts.failed}`);
        for (const finding of payload.findings) {
          console.log(`  ${finding.severity}: ${finding.message}`);
        }
      }
    });

  // ── Activity facade (POL-1352, wave 2.3A) ───────────────────────────
  const activity = new Command("activity")
    .description(
      [
        "Inspect agent activity (interactive Codex/Claude sessions today; calyx_run activities later).",
        "Top-level facade over the run-service activity inventory plus semantic message selectors.",
      ].join("\n"),
    )
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity list --since-hours 24 --json",
        "  calyx activity overview --agent-kind claude --since-hours 12 --json",
        "  calyx activity messages --latest-session --backend codex --role human --first 1 --json",
        "  with-polli-secrets calyx activity messages --host blade interactive:codex:019dcafe --role assistant --last 1 --json",
        "  calyx activity messages 'codex://threads/019dcafe' --role assistant --last 1 --json",
        "  calyx activity events 019dcafe --raw-role user --tail 5 --classify --json",
        "",
        "Agent question: \"what did I (or another agent) say in this session, and what did the assistant reply?\"",
      ].join("\n"),
    );

  activity
    .command("list")
    .description("List recent agent activity. Includes interactive Codex/Claude sessions by default.")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--include-runs", "Also include calyx_run rows from the local run store")
    .option("--agent-kind <kind>", "Filter interactive sessions by backend: all, codex, or claude")
    .option("--since-hours <hours>", "Interactive session lookback window in hours")
    .option("--limit <n>", "Maximum activity rows to return")
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable activity list")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity list --since-hours 24 --json",
        "  calyx activity list --host mba --agent-kind codex --limit 10",
        "",
        "Agent question: \"what recent agent sessions exist on this host?\"",
        "Next: calyx activity messages <activity-id> --role human --first 1 --json",
      ].join("\n"),
    )
    .action(async (options: RunPsCommandOptions & { includeRuns?: boolean }) => {
      // Activity list always includes interactive sessions; --include-runs adds runs.
      const merged = await listRuns(
        { ...options, includeInteractive: true },
        runCliDeps,
      );
      const filtered = options.includeRuns
        ? merged
        : merged.filter((entry) => "entry_kind" in entry && entry.entry_kind === "interactive_session");
      if (options.json) {
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }
      for (const entry of filtered) {
        if ("entry_kind" in entry && entry.entry_kind === "interactive_session") {
          console.log(`${entry.run_id}\tinteractive\t${entry.backend}\t-\t${entry.summary}`);
          continue;
        }
        const stateLabel = entry.state === "partial" ? "partial" : entry.state;
        console.log(`${entry.run_id}\t${stateLabel}\t${entry.recovery_mode}\t${entry.health_status ?? "-"}\t${entry.summary}`);
      }
    });

  activity
    .command("overview")
    .description("List recent interactive sessions with one compact most-recent turn preview per session.")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--agent-kind <kind>", "Filter interactive sessions by backend: all, codex, or claude (default: claude)")
    .option("--since-hours <hours>", "Interactive session / latest-turn lookback window in hours (default: 12)")
    .option("--limit <n>", "Maximum activity rows to inspect (default: 20)")
    .option("--turn-role <role>", `Most-recent turn role to preview (${ACTIVITY_TURN_ROLE_FILTERS.join("|")}; default: all)`)
    .option("--max-text-chars <n>", "Maximum text characters per preview message (default: 240)")
    .option("--max-messages <n>", "Maximum preview messages to return from the latest turn (default: 4)")
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable activity overview")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity overview --json",
        "  calyx activity overview --agent-kind claude --since-hours 12 --limit 30 --json",
        "  calyx activity overview --agent-kind all --turn-role assistant --max-messages 2 --max-text-chars 160",
        "",
        "Agent question: \"which recent Claude/Codex sessions changed, and what was their latest turn?\"",
        "Next: calyx activity turns <activity-id> --last 3 --json for progressive disclosure.",
      ].join("\n"),
    )
    .action(async (options: ActivityOverviewCommandOptions) => {
      const result = await activityOverviewCommand(options, runCliDeps);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityOverviewText(result));
    });

  activity
    .command("self")
    .description("Resolve this harness session to the canonical Calyx activity id when the harness exposes a session id.")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--host <host>", "Host alias to filter the local activity inventory")
    .option("--json", "Print machine-readable self-resolution")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity self --json",
        "  calyx activity turns $(calyx activity self --json | jq -r .activity_id) --role assistant --last 1 --json",
        "",
        "Agent question: \"what is the Calyx activity id for my current session?\"",
      ].join("\n"),
    )
    .action(async (options: ActivitySelfCommandOptions) => {
      const result = await resolveActivitySelfCommand(options, runCliDeps);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivitySelfText(result));
    });

  activity
    .command("mark")
    .argument("<target-id>", "Canonical activity, turn, or message id to preserve")
    .description("Create or converge one durable host-local activity mark through the generated consumer client.")
    .requiredOption("--kind <kind>", `Mark kind: ${ACTIVITY_MARK_KINDS.join(" or ")}`)
    .option("--target-kind <kind>", `Explicit target kind: ${ACTIVITY_MARK_TARGET_KINDS.join(", ")}`)
    .option("--reason <text>", "Optional canonical reason recorded with the mark")
    .option("--idempotency-key <key>", "Stable retry authority (generated when omitted)")
    .option("--host <host>", "Explicit enrolled host whose daemon owns the mark")
    .option("--server-url <url>", "Explicit daemon base URL")
    .option("--auth-token <token>", `Daemon bearer token (or use ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--asserted-actor <actor>", "Optional operator or activity identity recorded for audit only")
    .option("--json", "Print the generated calyx.activity-mark/v1 receipt")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  with-polli-secrets calyx activity mark --host blade interactive:codex:<session-id>:msg:42 --kind high_signal --reason \"Decision boundary\" --json",
        "  calyx activity mark --server-url https://calyx.example --auth-token <token> run:<run-id>:turn:17 --kind foundational --idempotency-key mark:POL-1996:17 --json",
        "",
        "Target kind is inferred from the canonical :msg:<line> or :turn:<line> suffix; all other valid targets are activities. An explicit --target-kind must match that exact grammar.",
      ].join("\n"),
    )
    .action(async (targetIdInput: string, options: ActivityMarkCommandOptions) => {
      const target = parseActivityMarkTarget(targetIdInput, options.targetKind);
      const kind = parseActivityMarkKind(options.kind);
      const reason = parseActivityMarkReasonOption(options.reason);
      const idempotencyKey = parseActivityMarkIdempotencyKey(options.idempotencyKey);
      const assertedActor = parseActivityMarkAssertedActor(options.assertedActor);
      const access = await resolveActivityMarkAccess(options, runCliDeps);
      const mark = await executeRecoverableClientMutation(runCliDeps, {
        context: "activity mark create",
        replayCommand: "calyx client replay",
        createClient: (clientOptions) => remoteConsumerClient(runCliDeps, access, clientOptions),
        resultMap: "activity_marks",
        operation: (client) => client.consumer.attention.mark.create({
          body: {
            schema_version: "calyx.activity-mark-create-request/v1",
            idempotency_key: idempotencyKey,
            target_kind: target.targetKind,
            target_id: target.targetId,
            kind,
            ...(reason !== undefined ? { reason } : {}),
          },
          ...(assertedActor !== undefined ? { assertedActor } : {}),
        }),
      });
      if (options.json) {
        console.log(JSON.stringify(mark, null, 2));
      } else {
        console.log(`marked ${mark.mark_id}\t${mark.kind}\t${mark.target_kind}\t${mark.target_id}`);
      }
    });

  activity
    .command("unmark")
    .argument("<mark-id>", "Canonical mark_<uuid-v4> id to revoke")
    .description("Revoke one owned mark through the generated bodyless request-target operation.")
    .option("--host <host>", "Explicit enrolled host whose daemon owns the mark")
    .option("--server-url <url>", "Explicit daemon base URL")
    .option("--auth-token <token>", `Daemon bearer token (or use ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--asserted-actor <actor>", "Optional operator or activity identity recorded for audit only")
    .option("--json", "Print the generated calyx.activity-mark-revocation/v1 receipt")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  with-polli-secrets calyx activity unmark --host blade mark_<uuid> --json",
        "  calyx activity unmark --server-url https://calyx.example --auth-token <token> mark_<uuid> --json",
      ].join("\n"),
    )
    .action(async (markIdInput: string, options: ActivityUnmarkCommandOptions) => {
      const markId = parseActivityMarkIdOption(markIdInput);
      const assertedActor = parseActivityMarkAssertedActor(options.assertedActor);
      const access = await resolveActivityMarkAccess(options, runCliDeps);
      const result = await remoteConsumerClient(runCliDeps, access).consumer.attention.mark.revoke({
        path: { markId },
        ...(assertedActor !== undefined ? { assertedActor } : {}),
      });
      const revocation = requireActivityMarkClientResult(
        result,
        "activity mark revoke",
        exactEndpointReconciliationCommand(["calyx", "activity", "marks"], access.serverUrl),
      );
      if (options.json) {
        console.log(JSON.stringify(revocation, null, 2));
      } else {
        console.log(`revoked ${revocation.mark_id}\t${revocation.revoked_at}`);
      }
    });

  activity
    .command("marks")
    .description("List active host-local marks at one mutation-stable daemon snapshot.")
    .option("--kind <kind>", `Filter by mark kind: ${ACTIVITY_MARK_KINDS.join(" or ")}`)
    .option("--target-kind <kind>", `Filter independently by target kind: ${ACTIVITY_MARK_TARGET_KINDS.join(", ")}`)
    .option("--target-id <id>", "Filter independently by exact canonical target id")
    .option("--since <timestamp>", "Filter marks at or after a canonical UTC ISO timestamp")
    .option("--limit <n>", `Maximum marks to return (1..${ACTIVITY_MARK_LIST_MAX_LIMIT})`)
    .option("--cursor <cursor>", "Opaque next_cursor from a preceding marks page")
    .option("--host <host>", "Explicit enrolled host whose daemon owns the marks")
    .option("--server-url <url>", "Explicit daemon base URL")
    .option("--auth-token <token>", `Daemon bearer token (or use ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print the generated calyx.activity-mark-list/v1 page")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  with-polli-secrets calyx activity marks --host blade --kind high_signal --limit 25 --json",
        "  with-polli-secrets calyx activity marks --host blade --target-id interactive:codex:<session-id>:msg:42 --json",
        "  with-polli-secrets calyx activity marks --host blade --cursor '<next_cursor>' --json",
      ].join("\n"),
    )
    .action(async (options: ActivityMarksCommandOptions) => {
      const kind = options.kind === undefined ? undefined : parseActivityMarkKind(options.kind);
      const targetKind = options.targetKind === undefined
        ? undefined
        : parseActivityMarkTargetKind(options.targetKind);
      const targetId = parseActivityMarkListTargetId(options.targetId);
      if (targetKind !== undefined && targetId !== undefined) {
        try {
          parseActivityMarkTargetId(targetKind, targetId);
        } catch (error) {
          throw createCliError(
            `Invalid --target-kind/--target-id pair: ${error instanceof Error ? error.message : String(error)}`,
            2,
          );
        }
      }
      const since = parseActivityMarkSince(options.since);
      const limit = parseActivityMarkListLimit(options.limit);
      const cursor = parseActivityMarkCursor(options.cursor);
      const access = await resolveActivityMarkAccess(options, runCliDeps);
      const page = requireActivityMarkClientResult(
        await remoteConsumerClient(runCliDeps, access).consumer.attention.mark.list({
          query: {
            ...(kind !== undefined ? { kind } : {}),
            ...(targetKind !== undefined ? { target_kind: targetKind } : {}),
            ...(targetId !== undefined ? { target_id: targetId } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
          },
        }),
        "activity marks list",
      );
      if (options.json) {
        console.log(JSON.stringify(page, null, 2));
        return;
      }
      if (page.marks.length === 0) {
        console.log("no marks");
      } else {
        console.log("MARK_ID\tKIND\tTARGET_KIND\tTARGET_ID\tMARKED_BY\tMARKED_AT\tREASON");
        for (const mark of page.marks) {
          console.log([
            mark.mark_id,
            mark.kind,
            mark.target_kind,
            mark.target_id,
            mark.marked_by,
            mark.marked_at,
            mark.reason ?? "-",
          ].join("\t"));
        }
      }
      if (page.truncated) {
        const continuation = ["calyx", "activity", "marks"];
        pushShellOption(continuation, "--kind", kind);
        pushShellOption(continuation, "--target-kind", targetKind);
        pushShellOption(continuation, "--target-id", targetId);
        pushShellOption(continuation, "--since", since);
        pushShellOption(continuation, "--limit", limit);
        pushShellOption(continuation, "--cursor", page.next_cursor);
        if (access.host) {
          pushShellOption(continuation, "--host", access.host);
        } else {
          pushShellOption(continuation, "--server-url", access.serverUrl);
        }
        continuation.push("--json");
        console.error(`next: ${continuation.join(" ")}`);
      }
    });

  activity
    .command("show")
    .description("Show a bounded raw-event slice for one interactive activity (alias of `run activity show`).")
    .requiredOption("--activity-id <id>", "Activity ID, e.g. interactive:codex:<session-id> or codex://threads/<uuid>")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--around <line-or-query>", "Center output around an event line, event index, or text match")
    .option("--context <n>", "Number of events on each side of --around")
    .option("--tail <n>", "Fallback number of recent events to show")
    .option("--include-tools", "Include tool calls and tool outputs")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable session activity")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity show --activity-id 'codex://threads/019dcafe' --around \"daemon health\"",
        "  calyx activity show --activity-id interactive:codex:019dcafe --around \"daemon health\"",
        "  calyx activity show --activity-id interactive:claude:a0db0b5e --tail 20 --json",
        "",
        "Agent question: \"what raw events surround a known landmark in this session?\"",
        "Next: calyx activity messages <activity-id> --around-text \"...\" for the semantic view.",
      ].join("\n"),
    )
    .action(async (options: RunActivityCommandOptions) => {
      const detail = await inspectInteractiveActivity(options, runCliDeps);
      console.log(options.json ? JSON.stringify(detail, null, 2) : formatInteractiveActivityText(detail));
    });

  activity
    .command("export")
    .description("Export a bounded interactive transcript slice (alias of `run activity export`).")
    .requiredOption("--activity-id <id>", "Activity ID, e.g. interactive:codex:<session-id> or codex://threads/<uuid>")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--around <line-or-query>", "Center output around an event line, event index, or text match")
    .option("--context <n>", "Number of events on each side of --around")
    .option("--tail <n>", "Fallback number of recent events to show")
    .option("--include-tools", "Include tool calls and tool outputs")
    .option("--format <format>", "Export format: markdown or json", "markdown")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable session activity")
    .action(async (options: RunActivityCommandOptions) => {
      if (options.format && options.format !== "markdown" && options.format !== "json") {
        throw createCliError("--format must be one of: markdown, json.", 2);
      }
      const detail = await inspectInteractiveActivity(options, runCliDeps);
      if (options.json || options.format === "json") {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      console.log(formatInteractiveActivityMarkdown(detail));
    });

  activity
    .command("messages")
    .description(
      [
        "Read semantic messages from an interactive activity.",
        "Default skips harness context, tool detail, system notices, and reasoning summaries.",
      ].join("\n"),
    )
    .argument("[activity-id]", ACTIVITY_ID_ARGUMENT_HELP)
    .option(
      "--role <role>",
      "Filter semantic role (human|assistant|harness-context|tool-call|tool-result|system-notice|reasoning-summary|unknown). `--role user` is rejected.",
    )
    .option("--first <n>", "Return the first N matching messages (mutually exclusive with --last)")
    .option("--last <n>", "Return the last N matching messages (mutually exclusive with --first)")
    .option("--latest-session", "Resolve to the most recent interactive session (requires --backend)")
    .option("--backend <backend>", "Used with --latest-session: codex or claude")
    .option("--around-id <message-id>", "Center the slice around this message id (round-trips with returned id)")
    .option("--around-text <query>", "Center the slice around the first matching summary/text")
    .option("--context <n>", "Number of messages on each side of --around-id/--around-text")
    .option("--visibility <tier>", "Visibility tier (default|+detail|+hidden|all)")
    .option("--grep <pattern>", "Filter messages whose role/summary/text matches this regex (case-insensitive)")
    .option("--summary-only", "Strip message text and return summaries only")
    .option("--max-text-chars <n>", "Maximum text body characters per message (default 4000; larger values raise the cap)")
    .option("--explain-classification", "Include classifier reason/rule_id/source_role on each message")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable activity messages")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity messages --latest-session --backend codex --role assistant --last 1 --json",
        "  calyx activity messages run:3b519ec4-d18f-4ff2-8057-75f7508d935d --role human --first 1 --json",
        "  calyx activity messages 'codex://threads/019dcafe' --role assistant --last 1 --json",
        "  calyx activity messages claude:blade:0baf9eee --role assistant --last 1 --json   # vault authorship alias",
        "  calyx activity messages 019dcafe --role human --first 1 --json",
        "  calyx activity messages interactive:codex:019dcafe --grep \"POL-1352\" --role assistant --last 3 --summary-only",
        "  with-polli-secrets calyx activity messages --host carbon interactive:codex:019dcafe --role assistant --last 1 --json",
        "",
        "Agent question: \"what did the human ask, and what did the assistant reply, in this session?\"",
        "Next: calyx activity events <activity-id> --classify --around-id <message-id> for raw event audit.",
      ].join("\n"),
    )
    .action(async (positional: string | undefined, options: ActivityMessagesCommandOptions) => {
      const result = await inspectActivityMessagesCommand(options, runCliDeps, positional);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityMessagesText(result));
    });

  activity
    .command("text")
    .description("Fetch an exact character range from one projected activity message.")
    .argument("<message-id>", "Message id returned by `calyx activity messages`, e.g. interactive:codex:<session>:msg:42")
    .option("--range <A:B>", "Return this exact character range")
    .option("--from <A>", "Return text from this character offset to the end")
    .option("--classifier-version <version>", "Validate the classifier version from the cursor that minted the range")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable activity text")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity text interactive:codex:019dcafe:msg:42 --range 4000:8000 --json",
        "  calyx activity text interactive:claude:a0db0b5e:msg:17 --from 12000",
        "",
        "Agent question: \"show me the omitted text range from this elision marker.\"",
      ].join("\n"),
    )
    .action(async (positional: string, options: ActivityTextCommandOptions) => {
      const result = await inspectActivityTextCommand(options, runCliDeps, positional);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityTextText(result));
    });

  activity
    .command("attachments")
    .description("List or extract content-addressed attachments for one activity.")
    .argument("<activity-id>", "Activity id (full `interactive:<backend>:<session-id>`, authorship alias `<backend>:<host>:<session-id>`, Codex deeplink, `run:<run-id>`, or short prefix).")
    .option("--turn <n>", "Only include attachments from this turn index")
    .option("--message <message-id>", "Only include attachments from this projected message id")
    .option("--ref <ref>", "Only include one attachment ref, e.g. att:sha256:<digest>")
    .option("--extract", "Extract matching attachments into the content-addressed cache")
    .option("--out <dir>", "Extraction directory (default: ~/.calyx/cache/attachments/sha256)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable attachment inventory")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity attachments interactive:codex:019dcafe --json",
        "  calyx activity attachments interactive:claude:a0db0b5e --message interactive:claude:a0db0b5e:msg:17 --extract --json",
        "  calyx activity attachments run:3b519ec4-d18f-4ff2-8057-75f7508d935d --ref att:sha256:<digest> --extract",
        "  with-polli-secrets calyx activity attachments interactive:codex:019dcafe --host carbon --ref att:sha256:<digest> --extract --json",
        "",
        "Agent question: \"what image attachments were referenced in this turn, and where can I inspect them locally?\"",
      ].join("\n"),
    )
    .action(async (positional: string, options: ActivityAttachmentsCommandOptions) => {
      const result = await inspectActivityAttachmentsCommand(options, runCliDeps, positional);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityAttachmentsText(result));
    });

  activity
    .command("events")
    .description("Audit raw activity events (debug classifier or inspect harness payloads).")
    .argument("[activity-id]", ACTIVITY_ID_ARGUMENT_HELP)
    .option("--classify", "Include semantic classifier reason/rule_id/projected_role on each event")
    .option("--raw-role <role>", "Filter raw events by role (user|assistant|tool|system|unknown)")
    .option("--tail <n>", "Return the last N matching events")
    .option("--around-id <message-id>", "Center the slice around an event line / message id")
    .option("--context <n>", "Number of events on each side of --around-id")
    .option("--within-turn", "Return every raw event for the turn containing --around-id (no tail/context/raw-role)")
    .option("--latest-session", "Resolve to the most recent interactive session (requires --backend)")
    .option("--backend <backend>", "Used with --latest-session: codex or claude")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable raw events")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity events 'codex://threads/019dcafe' --raw-role user --tail 10 --classify --json",
        "  calyx activity events 019dcafe --raw-role user --tail 10 --classify --json",
        "  calyx activity events 019dcafe --around-id interactive:codex:019dcafe:msg:42 --context 8 --json",
        "  calyx activity events 019dcafe --around-id interactive:codex:019dcafe:msg:42 --within-turn --json",
        "",
        "Agent question: \"why was the first user-role event classified as harness, not human?\"",
      ].join("\n"),
    )
    .action(async (positional: string | undefined, options: ActivityEventsCommandOptions) => {
      const result = await inspectActivityEventsCommand(options, runCliDeps, positional);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityEventsText(result));
    });

  activity
    .command("turns")
    .description(
      [
        "Group an interactive activity into human/assistant turns.",
        "Each turn has a stable turn_id, a complete/in_flight state, and the messages projected into it.",
      ].join("\n"),
    )
    .argument("[activity-id]", ACTIVITY_ID_ARGUMENT_HELP)
    .option(
      "--role <role>",
      `Filter turn role (${ACTIVITY_TURN_ROLE_FILTERS.join("|")}). Default: no filter (all turns).`,
    )
    .option("--first <n>", "Return the first N matching turns (mutually exclusive with --last)")
    .option("--last <n>", "Return the last N matching turns (mutually exclusive with --first)")
    .option("--latest-session", "Resolve to the most recent interactive session (requires --backend)")
    .option("--backend <backend>", "Used with --latest-session: codex or claude")
    .option("--with-tools", "Include tool calls/results attached to each returned turn")
    .option("--summary-only", "Strip text bodies; keep summaries only")
    .option("--max-text-chars <n>", "Maximum text body characters per turn message (default 4000; larger values raise the cap)")
    .option("--host <host>", "Host alias to query; remote hosts use the authenticated RunService")
    .option("--runs-root <path>", `Run store root (default: ${DEFAULT_RUNS_ROOT_ENV} or ~/.calyx/runs)`)
    .option("--server-url <url>", "Remote RunService base URL")
    .option("--auth-token <token>", `Remote server bearer token (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .option("--json", "Print machine-readable activity turns")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx activity turns --latest-session --backend codex --role assistant --last 1 --with-tools --json",
        "  calyx activity turns run:3b519ec4-d18f-4ff2-8057-75f7508d935d --role assistant --last 1 --with-tools --json",
        "  calyx activity turns 'codex://threads/019dcafe' --role assistant --last 1 --json",
        "  calyx activity turns codex:blade:019dcafe --role assistant --last 1 --json   # vault authorship alias",
        "  calyx activity turns 019dcafe --role human --first 1 --json",
        "  calyx activity turns 019dcafe --role assistant --last 3 --summary-only",
        "",
        "Agent question: \"what's the most recent assistant turn (with its tool calls) in this session?\"",
        "Next: calyx activity events <activity-id> --around-id <message-id> --within-turn --json for raw audit.",
      ].join("\n"),
    )
    .action(async (positional: string | undefined, options: ActivityTurnsCommandOptions) => {
      const result = await inspectActivityTurnsCommand(options, runCliDeps, positional);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatActivityTurnsText(result));
    });

  const agentContext = new Command("agent-context")
    .description("Print agent-facing CLI command inventory and operator recipes")
    .option("--json", "Print machine-readable agent context")
    .action(async (options: AgentContextCommandOptions) => {
      await runAgentContextCommand(program, options);
    });

  const exec = new Command("exec").description("Low-level exec store commands (launch/status/logs/receipt/validate)");

  exec
    .command("launch")
    .description("Launch a new execution run (plan/apply)")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--command <command>", "Command string to launch")
    .option("--apply", "Apply the launch (create a real run record)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecLaunchCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await launchExecRun(storePath, {
        command: options.command,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(
        `[exec] ${result.apply ? "launched" : "plan-launch"} run ${result.run_id}: command="${result.command}", state=${result.state}`
      );
    });

  exec
    .command("status")
    .description("Get status of an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecStatusCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecStatus(storePath, {
        run_id: options.runId
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const parts = [`${result.run_id}: ${result.state}`];
      if (result.exit_code !== undefined) {
        parts.push(`exit_code=${result.exit_code}`);
      }
      if (result.error) {
        parts.push(`error: ${result.error}`);
      }
      console.log(parts.join(", "));
    });

  exec
    .command("logs")
    .description("View logs of an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--level <level>", "Filter by log level (info|warn|error)")
    .option("--tail <n>", "Show only the last N log entries")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecLogsCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecLogs(storePath, {
        run_id: options.runId,
        ...(options.level ? { level: parseLogLevel(options.level) } : {}),
        ...(options.tail ? { tail: parseInt(options.tail, 10) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const entry of result.entries) {
        console.log(`[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`);
      }
      console.error(`${result.total} log entries for run ${result.run_id}.`);
    });

  exec
    .command("receipt")
    .description("Generate a receipt for an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--json", "Print machine-readable JSON receipt")
    .action(async (options: ExecReceiptCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecReceipt(storePath, {
        run_id: options.runId
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.summary);
      console.log(`  command: ${result.command}`);
      console.log(`  created: ${result.created_at}`);
      if (result.started_at) {
        console.log(`  started: ${result.started_at}`);
      }
      if (result.completed_at) {
        console.log(`  completed: ${result.completed_at}`);
      }
      if (result.duration_ms !== undefined) {
        console.log(`  duration: ${result.duration_ms}ms`);
      }
      console.log(`  logs: ${result.log_summary.total} total (${result.log_summary.info} info, ${result.log_summary.warn} warn, ${result.log_summary.error} error)`);
    });

  exec
    .command("validate")
    .description("Validate exec run store structure and lifecycle constraints")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecValidateCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await validateExecStore(storePath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Exec validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, queued=${result.queued}, running=${result.running}, succeeded=${result.succeeded}, failed=${result.failed}, cancelled=${result.cancelled}.`
        );
        printValidationIssues("exec", result.warnings, "warning");
        printValidationIssues("exec", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`exec validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  // ── Exec notify (POL-679) ──────────────────────────────────────────
  exec
    .command("notify")
    .description("Emit a structured notification event")
    .requiredOption("--message <message>", "Notification message")
    .option("--level <level>", "Notification level (info|warn|error)", "info")
    .option("--channel <channel>", "Delivery channel (stdout|ntfy|agent-mail)", "stdout")
    .option("--title <title>", "Optional notification title")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecNotifyCommandOptions) => {
      const result = await execNotify({
        message: options.message,
        level: parseLogLevel(options.level ?? "info"),
        channel: parseNotifyChannel(options.channel ?? "stdout"),
        ...(options.title ? { title: options.title } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const prefix = result.title ? `[${result.title}] ` : "";
      console.error(`[exec][notify] ${prefix}${result.level.toUpperCase()}: ${result.message} (channel=${result.channel})`);
    });

  // ── Extensions commands ────────────────────────────────────────────

  const extensions = new Command("extensions").description("Extension discovery, loading, and validation commands");

  function printExtensionDiagnostics(diagnostics: ExtensionDiagnostic[]): void {
    for (const d of diagnostics) {
      const prefix = d.extensionName ? `[${d.extensionName}]` : "[extensions]";
      console.error(`${prefix} ${d.severity}: (${d.code}) ${d.message}`);
    }
  }

  extensions
    .command("list")
    .description("Discover and list installed extensions from search paths")
    .option("--search-path <paths...>", "Directories to search for extensions (or set CALYX_EXTENSIONS_PATH)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsListCommandOptions) => {
      const searchPaths = resolveExtensionSearchPaths(options.searchPath);

      if (searchPaths.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ loaded: [], failed: [], diagnostics: [], conflicts: {} }, null, 2));
        } else {
          console.error("No extension search paths configured. Use --search-path or CALYX_EXTENSIONS_PATH.");
        }
        return;
      }

      const result = await discoverExtensions({ searchPaths });

      if (options.json) {
        console.log(JSON.stringify({
          loaded: result.loaded.map((r) => ({
            name: r.manifest?.name,
            version: r.manifest?.version,
            domains: r.manifest?.calyx.domains,
            apiVersion: r.manifest?.calyx.apiVersion,
            packageDir: r.packageDir,
          })),
          failed: result.failed.map((r) => ({
            name: r.manifest?.name,
            packageDir: r.packageDir,
            diagnostics: r.diagnostics,
          })),
          diagnostics: result.diagnostics,
          conflicts: result.conflicts,
        }, null, 2));
        return;
      }

      for (const r of result.loaded) {
        if (!r.manifest) continue;
        const domains = r.manifest.calyx.domains.join(", ");
        console.log(`${r.manifest.name}\tv${r.manifest.version}\tapi=${r.manifest.calyx.apiVersion}\tdomains=[${domains}]`);
      }

      if (result.failed.length > 0) {
        console.error(`\n${result.failed.length} extension(s) failed to load:`);
        for (const r of result.failed) {
          console.error(`  ${r.packageDir}`);
        }
      }

      printExtensionDiagnostics(result.diagnostics);
      console.error(`\nDiscovered ${result.loaded.length} extension(s) from ${searchPaths.length} search path(s).`);
    });

  extensions
    .command("validate")
    .description("Validate all discoverable extensions (manifests, compatibility, conflicts)")
    .option("--search-path <paths...>", "Directories to search for extensions (or set CALYX_EXTENSIONS_PATH)")
    .option("--strict", "Treat warnings as errors")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsValidateCommandOptions) => {
      const searchPaths = resolveExtensionSearchPaths(options.searchPath);

      if (searchPaths.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ ok: true, loaded: 0, failed: 0, conflicts: 0, diagnostics: [] }, null, 2));
        } else {
          console.error("No extension search paths configured. Use --search-path or CALYX_EXTENSIONS_PATH.");
        }
        return;
      }

      const result = await discoverExtensions({ searchPaths, strict: Boolean(options.strict) });

      const hasErrors = result.diagnostics.some((d) => d.severity === "error");
      const hasWarnings = result.diagnostics.some((d) => d.severity === "warning");
      const conflictCount = Object.keys(result.conflicts).length;
      const ok = !hasErrors && (!options.strict || !hasWarnings);

      if (options.json) {
        console.log(JSON.stringify({
          ok,
          loaded: result.loaded.length,
          failed: result.failed.length,
          conflicts: conflictCount,
          diagnostics: result.diagnostics,
        }, null, 2));
      } else {
        console.error(
          `Extensions validate ${ok ? "OK" : "FAILED"}: loaded=${result.loaded.length}, failed=${result.failed.length}, conflicts=${conflictCount}.`
        );
        printExtensionDiagnostics(result.diagnostics);
      }

      if (!ok) {
        throw createCliError(
          `Extensions validate failed with ${result.failed.length} load failure(s) and ${conflictCount} conflict(s).`,
          3
        );
      }
    });

  extensions
    .command("check")
    .description("Check a single extension package for manifest validity and SDK compatibility")
    .requiredOption("--path <path>", "Path to the extension package directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsCheckCommandOptions) => {
      const result = await loadExtension(options.path);

      if (options.json) {
        console.log(JSON.stringify({
          ok: result.ok,
          name: result.manifest?.name,
          version: result.manifest?.version,
          apiVersion: result.manifest?.calyx.apiVersion,
          domains: result.manifest?.calyx.domains,
          packageDir: result.packageDir,
          diagnostics: result.diagnostics,
        }, null, 2));
        return;
      }

      if (result.ok && result.manifest) {
        const domains = result.manifest.calyx.domains.join(", ");
        console.error(
          `Extension check OK: ${result.manifest.name} v${result.manifest.version} (api=${result.manifest.calyx.apiVersion}, domains=[${domains}])`
        );
      } else {
        console.error(`Extension check FAILED for ${options.path}:`);
        printExtensionDiagnostics(result.diagnostics);
      }

      if (!result.ok) {
        throw createCliError(`Extension check failed for ${options.path}.`, 3);
      }
    });

  // ── POL-679: new top-level canonical commands ────────────────────

  // calyx doctor — health check across all configured domains
  const doctor = new Command("doctor")
    .description("Run a health check across all configured domains")
    .option("--json", "Print machine-readable summary")
    .option("--host <host>", "Host slice for local repo-registry validation; run on that host for filesystem truth")
    .action(async (options: DoctorCommandOptions) => {
      const result = await runDoctor({
        json: Boolean(options.json),
        ...(typeof options.host === "string" ? { host: options.host } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const status of result.domains) {
        const icon = status.health === "ok" ? "OK" : status.health === "unconfigured" ? "SKIP" : "FAIL";
        const path = status.path ? ` (${status.path})` : "";
        const msg = status.message ? ` — ${status.message}` : "";
        console.error(`[doctor] ${icon} ${status.domain}${path}${msg}`);
      }
      if (result.repoRegistry) {
        if (!result.repoRegistry.ok && result.repoRegistry.roots.length === 0) {
          const detail = result.repoRegistry.message
            ? ` — ${result.repoRegistry.message}`
            : result.repoRegistry.code
              ? ` — ${result.repoRegistry.code}`
              : "";
          console.error(`[doctor] FAIL repo-registry ${result.repoRegistry.host} (${result.repoRegistry.source_path})${detail}`);
          if (result.repoRegistry.remediation) {
            console.error(`[doctor] remediation: ${result.repoRegistry.remediation}`);
          }
        }
        for (const status of result.repoRegistry.roots) {
          const icon = status.ok ? "OK" : "FAIL";
          const aliases = status.aliases && status.aliases.length > 0
            ? ` aliases=${status.aliases.join(",")}`
            : "";
          const detail = status.ok
            ? ` -> ${status.git_toplevel ?? status.configured_root}`
            : ` — ${status.message ?? status.code}`;
          console.error(
            `[doctor] ${icon} repo-registry ${status.host}:${status.repo} (${status.configured_root})${aliases}${detail}`,
          );
        }
        for (const collision of result.repoRegistry.alias_collisions ?? []) {
          console.error(
            `[doctor] FAIL repo-registry alias-collision ${collision.normalized_identity}: ${collision.repos.join(", ")} aliases=${collision.aliases.join(", ")}`,
          );
        }
      }
      for (const finding of result.findings ?? []) {
        console.error(`[doctor] FAIL ${finding.code}: ${finding.message}`);
        for (const evidence of finding.evidence) {
          console.error(`[doctor] evidence: ${evidence}`);
        }
        console.error(`[doctor] remediation: ${finding.remediation}`);
      }

      console.error(`\n[doctor] Overall: ${result.ok ? "HEALTHY" : "ISSUES DETECTED"}`);

      if (!result.ok) {
        throw createCliError("Doctor found issues. Run with --json for details.", 3);
      }
    });

  // calyx verify fleet — fleet-wide validation
  const verify = new Command("verify").description("Verification commands");

  verify
    .command("fleet")
    .description("Run fleet-wide validation across all configured domains")
    .option("--strict", "Treat warnings as errors")
    .option("--json", "Print machine-readable summary")
    .action(async (options: VerifyFleetCommandOptions) => {
      const result = await verifyFleet({ strict: Boolean(options.strict) });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const domain of result.domains) {
        const icon = domain.ok ? "OK" : "FAIL";
        const details = domain.message ? ` — ${domain.message}` : ` (errors=${domain.errors}, warnings=${domain.warnings})`;
        console.error(`[verify] ${icon} ${domain.domain}${details}`);
      }

      console.error(`\n[verify] Fleet: ${result.ok ? "ALL PASSED" : "FAILURES DETECTED"}`);

      if (!result.ok) {
        throw createCliError("Fleet verification failed.", 3);
      }
    });

  // calyx fleet status — read persisted convergence rows
  const fleet = new Command("fleet").description("Fleet convergence read surfaces");

  fleet
    .command("status")
    .description("Read topology-scoped per-host convergence rows from the local state store")
    .option("--host <host>", "Filter to one host alias")
    .option("--json", "Print machine-readable fleet-convergence-status/v2 output")
    .action(async (options: FleetStatusCommandOptions) => {
      let result: FleetStatusResult;
      try {
        result = await readFleetStatus(options, runCliDeps);
      } catch (error) {
        throw mapStateError(error);
      }
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatFleetStatusText(result));
      }
      if (!result.summary.green) {
        throw createCliError("Fleet convergence status is not green.", 6);
      }
    });

  // calyx bundle build — extension bundle build
  const bundle = new Command("bundle").description("Extension bundle commands");

  bundle
    .command("build")
    .description("Build an extension bundle from a package directory (plan/apply)")
    .requiredOption("--path <path>", "Path to the extension package directory")
    .option("--out-dir <path>", "Output directory for the bundle")
    .option("--apply", "Execute the build")
    .option("--json", "Print machine-readable summary")
    .action(async (options: BundleBuildCommandOptions) => {
      const result = await buildBundle({
        path: options.path,
        ...(options.outDir ? { outDir: options.outDir } : {}),
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`[bundle] ${result.action} ${result.name}@${result.version} -> ${result.outDir}`);
    });

  // calyx install bootstrap — agent installation bootstrap
  const install = new Command("install").description("Installation commands");

  install
    .command("bootstrap")
    .description("Bootstrap agent installation (ensure directory structure + canonical calyx wrapper, plan/apply)")
    .option("--target <path>", "Target directory for agent installation (default: ~/.agents)")
    .option("--apply", "Execute the bootstrap")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstallBootstrapCommandOptions) => {
      const result = await installBootstrap({
        ...(options.target ? { target: options.target } : {}),
        apply: Boolean(options.apply),
        ...(process.argv[1] ? { executablePath: process.argv[1] } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        if (result.action === "blocked-bootstrap") {
          throw createCliError(
            `install bootstrap blocked by stale built artifacts at ${result.staleBuild?.executablePath}. ${result.staleBuild?.remediation ?? ""}`.trim(),
            3,
          );
        }
        return;
      }

      console.error(`[install] ${result.action} target=${result.target}`);
      for (const warning of result.warnings ?? []) {
        console.error(`[install][warning] ${warning}`);
      }
      for (const step of result.steps) {
        console.error(`[install]   ${result.apply ? "✓" : "→"} ${step}`);
      }
      console.error(`[install] wrapper=${result.wrapperPath}`);
      if (result.sourceExecutablePath) {
        console.error(`[install] source=${result.sourceExecutablePath}`);
      }
      if (result.retiredLegacyWrapperPath) {
        console.error(
          `[install] ${result.apply ? "retired" : "will-retire"}-legacy-wrapper=${result.retiredLegacyWrapperPath}`,
        );
      }
      if (result.action === "blocked-bootstrap") {
        throw createCliError(
          `install bootstrap blocked by stale built artifacts at ${result.staleBuild?.executablePath}. ${result.staleBuild?.remediation ?? ""}`.trim(),
          3,
        );
      }
    });

  const self = new Command("self").description("Self-maintenance: health, drift, upgrade, and nudge commands");

  self
    .command("drift")
    .description("Compare daemon /v1/admin/health build heads against a target ref")
    .option("--host <h>", "Single host (default: local)")
    .option("--fleet", "Inspect desired-active hosts from the fleet topology snapshot")
    .option("--against <ref>", "Target ref (default: origin/main)", "origin/main")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SelfDriftCommandOptions) => {
      if (options.fleet && options.host && options.host.trim().toLowerCase() !== "local") {
        throw createCliError("calyx self drift accepts either --host <h> or --fleet, not both.", 2);
      }

      let reports;
      let fleetResult: Awaited<ReturnType<typeof runSelfDriftFleetCommand>> | undefined;
      try {
        const driftDeps = {
          ...(runCliDeps.createAdminClient ? { createAdminClient: runCliDeps.createAdminClient } : {}),
          ...(runCliDeps.execFileAsync ? { execFileAsync: runCliDeps.execFileAsync } : {}),
          ...(runCliDeps.agentsInfraRoot ? { agentsInfraRoot: runCliDeps.agentsInfraRoot } : {}),
          ...(runCliDeps.repoRoot ? { repoRoot: runCliDeps.repoRoot } : {}),
          ...(runCliDeps.currentHostAlias ? { currentHostAlias: runCliDeps.currentHostAlias } : {}),
          ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
          accessForHost: (host: string) => resolveRunServerAccess({ host }, runCliDeps),
          toolchainCheckForHost,
        };
        if (options.fleet) {
          fleetResult = await runSelfDriftFleetCommand(
            { ...(options.against ? { against: options.against } : {}) },
            driftDeps,
          );
          reports = fleetResult.reports;
        } else {
          reports = await collectSelfDriftReports(
            {
              ...(options.host ? { host: options.host } : {}),
              ...(options.against ? { against: options.against } : {}),
            },
            driftDeps,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw createCliError(message, 6);
      }

      if (options.json) {
        console.log(JSON.stringify(fleetResult?.result ?? toSelfDriftJsonResults(reports), null, 2));
      } else {
        console.log(fleetResult?.text ?? formatSelfDriftTable(reports));
      }

      if (fleetResult ? !fleetResult.result.summary.green : reports.some((report) => report.drift !== "current")) {
        throw createCliError("Self drift detected.", 1);
      }
    });

  self
    .command("nudge")
    .description("File or reconcile one standing Linear drift issue per host")
    .option("--fleet", "Inspect desired-active hosts from the fleet topology snapshot")
    .option("--project <slug>", "Linear project slug or name")
    .option("--dry-run", "Print intended Linear mutations; do not write to Linear")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SelfNudgeCommandOptions) => {
      let result;
      try {
        result = await runSelfNudge(
          {
            fleet: Boolean(options.fleet),
            ...(options.project ? { project: options.project } : {}),
            ...(options.dryRun ? { dryRun: true } : {}),
          },
          {
            ...(runCliDeps.createAdminClient ? { createAdminClient: runCliDeps.createAdminClient } : {}),
            ...(runCliDeps.linearGraphql ? { linearGraphql: runCliDeps.linearGraphql } : {}),
            ...(runCliDeps.execFileAsync ? { execFileAsync: runCliDeps.execFileAsync } : {}),
            ...(runCliDeps.agentsInfraRoot ? { agentsInfraRoot: runCliDeps.agentsInfraRoot } : {}),
            ...(runCliDeps.repoRoot ? { repoRoot: runCliDeps.repoRoot } : {}),
            ...(runCliDeps.currentHostAlias ? { currentHostAlias: runCliDeps.currentHostAlias } : {}),
            ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
            accessForHost: (host) => resolveRunServerAccess({ host }, runCliDeps),
            toolchainCheckForHost,
            ...(runCliDeps.now ? { now: runCliDeps.now } : {}),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw createCliError(message, 6);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSelfNudgeResult(result));
      }
    });

  self
    .command("freshness")
    .description("Summarize daemon freshness from health, drift, capabilities, and active-run state")
    .option("--host <h>", "Single host alias from fleet/truths/hosts.yaml")
    .option("--fleet", "Inspect desired-active hosts from the fleet topology snapshot")
    .option("--against <ref>", "Target ref for drift comparison (default: origin/main)", "origin/main")
    .option("--json", "Print machine-readable output")
    .action(async (options: SelfFreshnessCommandOptions) => {
      if (options.fleet && options.host?.trim()) {
        throw createCliError("Provide either --host or --fleet for calyx self freshness, not both.", 2);
      }

      let result;
      try {
        result = await runSelfFreshnessCommand(
          {
            ...(options.host ? { host: options.host } : {}),
            fleet: Boolean(options.fleet),
            ...(options.against ? { against: options.against } : {}),
          },
          {
            ...(runCliDeps.createAdminClient ? { createAdminClient: runCliDeps.createAdminClient } : {}),
            ...(runCliDeps.execFileAsync ? { execFileAsync: runCliDeps.execFileAsync } : {}),
            ...(runCliDeps.agentsInfraRoot ? { agentsInfraRoot: runCliDeps.agentsInfraRoot } : {}),
            ...(runCliDeps.repoRoot ? { repoRoot: runCliDeps.repoRoot } : {}),
            ...(runCliDeps.currentHostAlias ? { currentHostAlias: runCliDeps.currentHostAlias } : {}),
            ...(runCliDeps.tokenForHost ? { tokenForHost: runCliDeps.tokenForHost } : {}),
            ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
            accessForHost: (host) => resolveRunServerAccess({ host }, runCliDeps),
            ...(runCliDeps.now ? { now: runCliDeps.now } : {}),
            persistConvergence: true,
            toolchainCheckForHost,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw createCliError(message, 6);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSelfFreshnessText(result));
      }

      if (result.exit_code !== 0) {
        throw createCliError("Self freshness found non-fresh host(s).", result.exit_code);
      }
    });

  self
    .command("health")
    .description("Probe authenticated run-server /v1/admin/health for the local host, one host, or the desired-active topology set")
    .option("--host <h>", "Single host alias from fleet/truths/hosts.yaml")
    .option("--fleet", "Probe desired-active hosts from the fleet topology snapshot")
    .option("--json", "Print machine-readable output")
    .action(async (options: SelfHealthCommandOptions) => {
      if (options.fleet && options.host?.trim()) {
        throw createCliError("Provide either --host or --fleet for calyx self health, not both.", 2);
      }

      const result = await runSelfHealthCommand(options, {
        ...(runCliDeps.createAdminClient ? { createAdminClient: runCliDeps.createAdminClient } : {}),
        ...(runCliDeps.now ? { now: runCliDeps.now } : {}),
        ...(runCliDeps.agentsInfraRoot ? { agentsInfraRoot: runCliDeps.agentsInfraRoot } : {}),
        ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
        ...(runCliDeps.tokenForHost ? { tokenForHost: runCliDeps.tokenForHost } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result.fleet ?? result.results, null, 2));
      } else {
        console.log(result.text);
      }

      if (result.exitCode !== 0) {
        throw createCliError(result.failureMessage ?? "Daemon health probe failed.", result.exitCode);
      }
    });

  const selfUpgrade = self
    .command("upgrade")
    .description("Plan/apply transparent daemon updates: preserve proven-safe runs by default only with run.readopt_on_boot/v1 + run.detached_worker_isolation/v1, drain healthy unproven runs, refuse blockers; --drain-all overrides. Emits operation IDs, automatic rollback, receipts under ~/.calyx/self-upgrade-receipts, and recoverable status --watch.")
    .option("--host <host>", "Host alias to upgrade (required unless --fleet)")
    .option("--fleet", "Upgrade desired-active hosts from an authoritative fleet topology snapshot")
    .option("--to <ref>", "Git ref to pull before rebuilding", "origin/main")
    .option(
      "--target-sha <sha>",
      "Explicit target commit SHA (supersedes --to ref resolution; with --fleet this overrides the conductor's auto-fetch)",
    )
    .option(
      "--startup-contract-payload <base64url>",
      "Internal SHA-bound target startup-contract evidence supplied by a fleet conductor",
    )
    .option("--target-fetch-remote <remote>", "Internal normalized fetch remote supplied by a fleet conductor")
    .option("--target-fetch-ref <ref>", "Internal normalized source fetch ref supplied by a fleet conductor")
    .option("--dry-run", "Print the planned upgrade and exit without mutating", false)
    .option("--parallel", "Run fleet hosts in parallel instead of serial order", false)
    .option("--hosts <csv>", "Comma-separated subset of desired-active topology hosts")
    .option("--fail-fast", "Stop serial fleet execution after the first host failure", false)
    .option("--yes", "Assume yes for self-maintenance confirmation flows", false)
    .option("--json", "Print machine-readable output")
    .option("--force", "Override conservative preflight guards for dirty trees or active-run aborts", false)
    .option("--abort-runs", "Abort active runs instead of waiting for a clean drain (fallback path for non-restart-safe runs)", false)
    .option("--drain-deadline <ms>", "Maximum wait for NON-restart-safe runs to drain, in milliseconds", `${10 * 60 * 1_000}`)
    .option("--drain-all", "Drain every active run before restart instead of preserving classifier-approved restart-safe runs", false)
    .option("--continuous", "Deprecated no-op alias for the transparent-update default; scheduled for removal in 0.4.0", false)
    .option("--auth-token <token>", `Bearer token for authenticated /v1/admin/health checks (or set ${RUN_SERVER_CREDENTIAL_HINT})`)
    .action(async (options: SelfUpgradeCommandOptions) => {
      let terminalJsonEmitted = false;
      const emitTerminalJson = (value: unknown): void => {
        if (!options.json || terminalJsonEmitted) {
          return;
        }
        terminalJsonEmitted = true;
        console.log(JSON.stringify(value, null, 2));
      };
      const targetOperationId = process.env.CALYX_SELF_UPGRADE_TARGET_OPERATION_ID?.trim();
      delete process.env.CALYX_SELF_UPGRADE_TARGET_OPERATION_ID;
      if (targetOperationId) {
        try {
          const result = await (
            runCliDeps.runSelfUpgradeTargetEntry
            ?? runSelfUpgradeTargetEntry
          )(targetOperationId);
          console.log(JSON.stringify({
            schema_version: "self-upgrade-target-process-result/v1",
            operation_id: targetOperationId,
            result,
          }, null, 2));
          return;
        } catch (error) {
          const failure = toSelfUpgradeFailureOutput(error);
          console.log(JSON.stringify({
            schema_version: "self-upgrade-target-process-result/v1",
            operation_id: targetOperationId,
            failure,
          }, null, 2));
          throw createCliError(failure.error, failure.exit_code);
        }
      }
      const relayOperationId = process.env.CALYX_SELF_UPGRADE_FLEET_OPERATION_ID?.trim();
      const relayedInvocation = Boolean(relayOperationId);
      const relayEnabled = options.json === true
        && process.env.CALYX_SELF_UPGRADE_PROGRESS_SCHEMA === "self-upgrade-operation/v1"
        && relayedInvocation;
      // Private relay ownership is single-hop. Consume it before validation,
      // host resolution, or forwarding so no exceptional or alias-drift path
      // can inherit it into a nested fleet dispatcher or restarted child.
      delete process.env.CALYX_SELF_UPGRADE_PROGRESS_SCHEMA;
      delete process.env.CALYX_SELF_UPGRADE_FLEET_OPERATION_ID;
      try {
      const drainDeadlineMs = parseNonNegativeIntegerOption(options.drainDeadline, "--drain-deadline");
      if (options.continuous) {
        console.error(
          "warning: --continuous is deprecated and has no effect; restart-safe preservation is now the default. Use --drain-all to force a full drain. --continuous will be removed in 0.4.0.",
        );
      }

      // POL-1151: validate --target-sha format up front. The ref+merge path
      // would also fail downstream on a malformed value, but a clear CLI-level
      // error message beats a confusing git error trapped in a self-upgrade
      // failure receipt.
      if (options.targetSha && !/^[0-9a-f]{40}$/i.test(options.targetSha.trim())) {
        throw createCliError(
          `--target-sha must be a full 40-character hex SHA, got: ${options.targetSha}`,
          2,
        );
      }
      if (options.startupContractPayload && !options.targetSha) {
        throw createCliError("--startup-contract-payload requires --target-sha.", 2);
      }
      if (Boolean(options.targetFetchRemote) !== Boolean(options.targetFetchRef)) {
        throw createCliError("--target-fetch-remote and --target-fetch-ref must be supplied together.", 2);
      }
      if ((options.targetFetchRemote || options.targetFetchRef) && !options.targetSha) {
        throw createCliError("Normalized target fetch evidence requires --target-sha.", 2);
      }

      if (options.fleet) {
        if (options.host?.trim()) {
          throw createCliError("Provide either --host <host> or --fleet for calyx self upgrade, not both.", 2);
        }
        if (options.force || options.abortRuns || options.authToken?.trim()) {
          throw createCliError("--force, --abort-runs, and --auth-token are only supported for single-host self upgrade.", 2);
        }

        let result;
        try {
          result = await (runCliDeps.runSelfUpgradeFleet ?? runSelfUpgradeFleet)({
            ...(options.to ? { to: options.to } : {}),
            ...(options.targetSha ? { targetSha: options.targetSha } : {}),
            ...(options.dryRun ? { dryRun: true } : {}),
            ...(options.parallel ? { parallel: true } : {}),
            ...(options.hosts ? { hosts: [options.hosts] } : {}),
            ...(options.failFast ? { failFast: true } : {}),
            ...(drainDeadlineMs !== undefined ? { drainDeadlineMs } : {}),
            ...(options.drainAll ? { drainAll: true } : {}),
            ...(options.yes ? { yes: true } : {}),
            ...(options.json ? { json: true } : {}),
          }, {
            ...(runCliDeps.execFileAsync ? { execFileAsync: runCliDeps.execFileAsync } : {}),
            ...(runCliDeps.agentsInfraRoot ? { resolveAgentsInfraRoot: async () => runCliDeps.agentsInfraRoot } : {}),
            ...(runCliDeps.currentHostAlias ? { resolveCurrentHostAlias: async () => runCliDeps.currentHostAlias! } : {}),
            ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
            persistConvergence: true,
          });
        } catch (error) {
          const exitCode = error && typeof error === "object" && "exitCode" in error && typeof (error as { exitCode?: unknown }).exitCode === "number"
            ? (error as { exitCode: number }).exitCode
            : 1;
          const message = error instanceof Error ? error.message : String(error);
          emitTerminalJson(toSelfUpgradeFailureOutput(error));
          throw createCliError(message, exitCode);
        }

        if (options.json) {
          emitTerminalJson({
            operation_id: result.operation_id,
            operation_path: result.operation_path,
            operation_projection: result.operation_projection,
            operation: result.operation,
            receipt_path: result.receipt_path,
            receipt: result.receipt,
            exit_code: result.exitCode,
            ...(result.failureMessage ? { failure_message: result.failureMessage } : {}),
            ...(result.warnings ? { warnings: result.warnings } : {}),
          });
        } else {
          console.log(result.text);
        }

        if (result.exitCode !== 0) {
          throw createCliError(result.failureMessage ?? "Fleet self upgrade failed.", result.exitCode);
        }
        return;
      }

      if (!options.host?.trim()) {
        throw createCliError("calyx self upgrade requires --host <host> unless --fleet is set.", 2);
      }
      if (options.parallel || options.hosts?.trim() || options.failFast) {
        throw createCliError("--parallel, --hosts, and --fail-fast are only supported with --fleet.", 2);
      }

      const requestedHost = options.host.trim();
      let currentHostAlias: string;
      try {
        currentHostAlias = runCliDeps.currentHostAlias
          ?? await (runCliDeps.resolveCurrentHostAlias ?? resolveCurrentHostAlias)(
            undefined,
            runCliDeps.agentsInfraRoot,
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw createCliError(`Unable to resolve current host alias for self upgrade: ${message}`, 6);
      }

      const normalizedRequestedHost = normalizeSelfUpgradeHostAlias(requestedHost);
      const normalizedCurrentHost = normalizeSelfUpgradeHostAlias(currentHostAlias);
      if (normalizedRequestedHost !== normalizedCurrentHost) {
        if (relayedInvocation) {
          throw createCliError(
            `Relayed self upgrade target ${requestedHost} does not match this host (${currentHostAlias}); refusing recursive fleet dispatch.`,
            6,
          );
        }
        if (options.authToken?.trim()) {
          throw createCliError(
            "--auth-token is only supported when --host targets the current host; remote --host upgrades load target-host secrets through with-polli-secrets.",
            2,
          );
        }

        let result;
        try {
          result = await (runCliDeps.runSelfUpgradeFleet ?? runSelfUpgradeFleet)({
            ...(options.to ? { to: options.to } : {}),
            ...(options.targetSha ? { targetSha: options.targetSha } : {}),
            ...(options.dryRun ? { dryRun: true } : {}),
            hosts: [requestedHost],
            ...(options.force ? { force: true } : {}),
            ...(options.abortRuns ? { abortRuns: true } : {}),
            ...(drainDeadlineMs !== undefined ? { drainDeadlineMs } : {}),
            ...(options.drainAll ? { drainAll: true } : {}),
            ...(options.yes ? { yes: true } : {}),
            ...(options.json ? { json: true } : {}),
          }, {
            ...(runCliDeps.execFileAsync ? { execFileAsync: runCliDeps.execFileAsync } : {}),
            ...(runCliDeps.agentsInfraRoot ? { resolveAgentsInfraRoot: async () => runCliDeps.agentsInfraRoot } : {}),
            resolveCurrentHostAlias: async () => currentHostAlias,
            ...(runCliDeps.resolveFleetTopology ? { resolveFleetTopology: runCliDeps.resolveFleetTopology } : {}),
            persistConvergence: true,
          });
        } catch (error) {
          const exitCode = error && typeof error === "object" && "exitCode" in error && typeof (error as { exitCode?: unknown }).exitCode === "number"
            ? (error as { exitCode: number }).exitCode
            : 1;
          const message = error instanceof Error ? error.message : String(error);
          emitTerminalJson(toSelfUpgradeFailureOutput(error));
          throw createCliError(message, exitCode);
        }

        if (options.json) {
          emitTerminalJson({
            operation_id: result.operation_id,
            operation_path: result.operation_path,
            operation_projection: result.operation_projection,
            operation: result.operation,
            receipt_path: result.receipt_path,
            receipt: result.receipt,
            exit_code: result.exitCode,
            ...(result.failureMessage ? { failure_message: result.failureMessage } : {}),
            ...(result.warnings ? { warnings: result.warnings } : {}),
          });
        } else {
          console.log(result.text);
        }

        if (result.exitCode !== 0) {
          throw createCliError(result.failureMessage ?? "Remote self upgrade failed.", result.exitCode);
        }
        return;
      }

      const relayProjectionIssues: SelfUpgradeProjectionIssue[] = [];
      let relayTerminal: { projection_issues?: SelfUpgradeProjectionIssue[] } | undefined;
      const attachRelayProjectionIssues = (): void => {
        if (!relayTerminal || relayProjectionIssues.length === 0) return;
        const existing = relayTerminal.projection_issues ?? [];
        relayTerminal.projection_issues = [...existing, ...relayProjectionIssues].filter(
          (issue, index, values) => issue.scope === "operation_cleanup"
            || values.findIndex((candidate) =>
              candidate.scope === issue.scope
              && candidate.code === issue.code
              && candidate.message === issue.message) === index,
        );
      };
      const relayWriter = relayEnabled
        ? createFailOpenProjectionWriter(runCliDeps.selfUpgradeProgressStream ?? process.stderr, (reason) => {
            relayProjectionIssues.push({
              scope: "remote_phase_stderr",
              code: "projection_unavailable",
              observed_at: runCliDeps.now?.().toISOString() ?? new Date().toISOString(),
              message: reason,
            });
            attachRelayProjectionIssues();
          })
        : undefined;
      try {
        const result = await (runCliDeps.runSelfUpgrade ?? runSelfUpgrade)({
          host: requestedHost,
          ...(relayedInvocation && relayOperationId ? { fleetOperationId: relayOperationId } : {}),
          ...(options.to ? { to: options.to } : {}),
          ...(options.targetSha ? { targetSha: options.targetSha } : {}),
          ...(options.targetSha && options.targetFetchRemote && options.targetFetchRef
            ? {
                targetEvidence: {
                  original_ref: options.to?.trim() || "origin/main",
                  target_sha: options.targetSha.trim(),
                  fetch_remote: options.targetFetchRemote,
                  fetch_ref: options.targetFetchRef,
                },
              }
            : {}),
          ...(options.startupContractPayload ? { startupContractPayload: options.startupContractPayload } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.force ? { force: true } : {}),
          ...(options.abortRuns ? { abortRuns: true } : {}),
          ...(options.authToken ? { authToken: options.authToken } : {}),
          ...(drainDeadlineMs !== undefined ? { drainDeadlineMs } : {}),
          ...(options.drainAll ? { drainAll: true } : {}),
        }, relayEnabled && relayOperationId
          ? {
              onPhase: (event) => {
                const transition = toSelfUpgradeProgressTransition({
                  fleetOperationId: relayOperationId,
                  event,
                  source: "host_event",
                  observedAt: runCliDeps.now?.().toISOString() ?? new Date().toISOString(),
                });
                relayWriter?.write(encodeSelfUpgradeProgressTransition(transition));
              },
            }
          : {});

        relayTerminal = result;
        await relayWriter?.stop();
        attachRelayProjectionIssues();

        if (options.json) {
          emitTerminalJson(result);
          return;
        }

        if (result.status === "dry-run") {
          console.log(formatSelfUpgradePlan(result.plan));
          return;
        }

        console.log(`self upgrade succeeded for ${result.plan.host}`);
        if (result.operation_id) {
          console.log(`  operation_id: ${result.operation_id}`);
        }
        console.log(`  repo_root: ${result.plan.repo_root}`);
        console.log(`  target_ref: ${result.plan.target_ref}`);
        if (result.receipt?.install) {
          console.log(`  promoted_install: ${result.receipt.install.install_path}`);
          console.log(`  install_pruned: ${result.receipt.install.pruned.length === 0 ? "none" : result.receipt.install.pruned.join(", ")}`);
        }
        for (const warning of result.receipt?.warnings ?? []) {
          console.error(`warning: ${warning}`);
        }
        if (result.receipt_path) {
          console.log(`  receipt: ${result.receipt_path}`);
        }
      } catch (error) {
        const failure = toSelfUpgradeFailureOutput(error);
        relayTerminal = failure;
        await relayWriter?.stop();
        attachRelayProjectionIssues();
        emitTerminalJson(failure);
        const exitCode = error && typeof error === "object" && "exitCode" in error && typeof (error as { exitCode?: unknown }).exitCode === "number"
          ? (error as { exitCode: number }).exitCode
          : 1;
        const message = error instanceof Error ? error.message : String(error);
        throw createCliError(message, exitCode);
      } finally {
        await relayWriter?.stop();
      }
      } catch (error) {
        emitTerminalJson(toSelfUpgradeFailureOutput(error));
        throw error;
      }
    });

  selfUpgrade
    .command("status [operation-id]")
    .description("Read one durable self-upgrade operation observation; defaults to the latest active operation")
    .option("--watch", "Follow through transient liveness gaps until terminal/orphaned; persistent indeterminate evidence fails", false)
    .option("--json", "Print bounded self-upgrade-operation-status/v1 output")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  calyx self upgrade status",
        "  calyx self upgrade status fleet-2026-07-22T12-00-00-000Z --watch --json",
        "",
        "The operation record is an observation projection. Host-local durable state and verified final receipts remain authoritative.",
      ].join("\n"),
    )
    .action(async (
      operationId: string | undefined,
      options: SelfUpgradeStatusCommandOptions,
    ) => {
      try {
        let emitted = 0;
        await runSelfUpgradeOperationStatus(
          {
            ...(operationId?.trim() ? { operationId: operationId.trim() } : {}),
            ...(options.watch ? { watch: true } : {}),
          },
          {},
          (result) => {
            if (options.json) {
              console.log(serializeSelfUpgradeOperationStatusJson(result));
            } else {
              if (emitted > 0) {
                console.log("");
              }
              console.log(formatSelfUpgradeOperationStatusText(result));
            }
            emitted += 1;
          },
        );
      } catch (error) {
        const exitCode = error && typeof error === "object"
          && "exitCode" in error
          && typeof (error as { exitCode?: unknown }).exitCode === "number"
          ? (error as { exitCode: number }).exitCode
          : 6;
        throw createCliError(
          error instanceof Error ? error.message : String(error),
          exitCode,
        );
      }
    });

  const runtimeConfig = new Command("runtime-config").description("Managed runtime configuration convergence commands");

  for (const mode of ["plan", "apply", "verify"] as const) {
    runtimeConfig
      .command(mode)
      .description(
        mode === "plan"
          ? "Plan managed runtime configuration convergence for the selected host"
          : mode === "apply"
            ? "Apply managed runtime configuration convergence for the selected host"
            : "Verify live runtime configuration matches managed truth for the selected host",
      )
      .option(
        "--managed-configs-root <path>",
        "Path to the managed runtime configs root. Defaults to ~/dev/agents-infra/dev/fleet/configs under the selected live home.",
      )
      .requiredOption("--host <host>", "Host alias to resolve host-specific runtime config truth")
      .option("--home <path>", "Home directory whose live config targets should be inspected (default: current user home)")
      .option(
        "--component <name>",
        "Limit to a component (repeatable): codex, claude-settings, claude-mcp",
        collectOptionValues,
        [],
      )
      .option("--json", "Print machine-readable summary")
      .action(async (options: RuntimeConfigCommandOptions) => {
        const components = (options.component ?? []).map((value) => parseRuntimeConfigComponent(value));
        const baseOptions = {
          host: options.host,
          ...(options.managedConfigsRoot ? { managedConfigsRoot: options.managedConfigsRoot } : {}),
          ...(options.home ? { liveHome: options.home } : {}),
          ...(components.length > 0 ? { components } : {}),
        };

        const result = await dispatchRuntimeConfig(
          mode,
          baseOptions,
        );

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printRuntimeConfigHuman(result);
        }

        if (mode === "verify" && !result.ok) {
          throw createCliError("Runtime config verification found drift.", 3);
        }
      });
  }

  const vault = new Command("vault").description(
    "Fieldwork vault filing, search, markdown reads, session provenance, footnote disclosure, frontmatter queries, freshness stamping, and status commands",
  );

  vault
    .command("put")
    .description("Place a file into the vault with stamped frontmatter")
    .argument("[file]", "Optional input file path")
    .option("--type <type>", `Content type: execplan, report, context, project, workstream, prompt, library, meta`)
    .option("--title <title>", "Note title (required)")
    .option("--daily", "Write to 10-daily/YYYY-MM-DD/ regardless of --type")
    .option("--issue <POL-XXX>", "Linear issue link")
    .option("--project <slug>", "Stable project slug for project/workstream notes")
    .option("--workstream <slug>", "Stable workstream slug for workstream notes")
    .option("--author <author>", "Override auto-detected author")
    .option("--assignee <who>", "Optional assignee frontmatter")
    .option("--updated <ts>", "Optional updated timestamp")
    .option("--updated-by <who>", "Optional updated_by frontmatter")
    .option("--status <status>", "Status field (default: active)")
    .option("--stdin", "Read content body from stdin")
    .option("--dry-run", "Print what would be written without writing")
    .option("--json", "Print machine-readable summary")
    .action(async (inputFile: string | undefined, options: VaultPutCommandOptions) => {
      const stdinText = options.stdin || (!inputFile && !process.stdin.isTTY) ? await readStdinText() : undefined;
      const result = await putVaultArtifact({
        ...(options.type ? { type: options.type } : {}),
        title: options.title ?? "",
        daily: Boolean(options.daily),
        ...(options.issue ? { issue: options.issue } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.workstream ? { workstream: options.workstream } : {}),
        ...(options.author ? { author: options.author } : {}),
        ...(options.assignee ? { assignee: options.assignee } : {}),
        ...(options.updated ? { updated: options.updated } : {}),
        ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(inputFile ? { inputFilePath: inputFile } : {}),
        ...(typeof stdinText === "string" ? { stdinText } : {}),
        dryRun: Boolean(options.dryRun),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.dryRun) {
        console.log(`[dry-run] Would write to: ${result.outputPath}`);
        console.log(`[dry-run] Vault-relative: ${result.relativePath}`);
        console.log(`[dry-run] Author: ${result.author}`);
        if (result.backlink.status === "dry-run" && result.issue) {
          console.log(`[dry-run] Would post Linear backlink on ${result.issue}`);
        }
        console.log("---");
        console.log(result.content);
        return;
      }

      console.log(result.outputPath);
      if (result.backlink.status !== "not-requested") {
        console.error(`[calyx vault] ${result.backlink.message}`);
      }
    });

  vault
    .command("search")
    .description("Search vault content (frontmatter-aware ripgrep wrapper)")
    .argument("<query>", "Search query")
    .option("--mode <mode>", "Search mode: literal, semantic, hybrid (default: literal)")
    .option("--type <type>", "Filter to a specific content type")
    .option("--issue", "Search only issue: frontmatter fields")
    .option("--files", "Show only file paths")
    .option("--limit <n>", "Maximum structured JSON matches (default: 20)")
    .option("--json", "Print machine-readable summary")
    .action(async (query: string, options: VaultSearchCommandOptions) => {
      const limit = parsePositiveIntegerOption(options.limit, "--limit");
      const result = await searchVault(query, {
        ...(options.type ? { type: options.type } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        issueOnly: Boolean(options.issue),
        filesOnly: Boolean(options.files),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.stdout) {
        process.stdout.write(result.stdout);
      }

      if (result.status !== 0) {
        process.exitCode = result.status;
      }
    });

  vault
    .command("fetch")
    .description("Fetch a bounded vault note by vault URI, relative path, or absolute path")
    .argument("<target>", "vault://fieldwork/<path>, vault-relative path, or absolute vault path")
    .option("--max-bytes <n>", "Maximum markdown bytes to return (default: 24000)")
    .option("--with-frontmatter", "Include parsed frontmatter in JSON output")
    .option("--with-links", "Include outbound wikilink/markdown link metadata in JSON output")
    .option(
      "--footnotes <mode>",
      "Footnote projection: collapsed (spine with in-band elision markers carrying footnotes get commands) or expanded (full note, default behavior)",
    )
    .option("--json", "Print machine-readable summary")
    .action(async (target: string, options: VaultFetchCommandOptions) => {
      const maxBytes = parsePositiveIntegerOption(options.maxBytes, "--max-bytes");
      const footnotesMode = parseVaultFootnotesMode(options.footnotes);
      const result = await fetchVaultArtifact(target, {
        ...(typeof maxBytes === "number" ? { maxBytes } : {}),
        withFrontmatter: Boolean(options.withFrontmatter),
        withLinks: Boolean(options.withLinks),
        ...(footnotesMode ? { footnotes: footnotesMode } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printVaultFetchHuman(result);
    });

  vault
    .command("related")
    .description("Find bounded related vault notes from wikilinks, backlinks, issue, or project")
    .argument("<target>", "vault://fieldwork/<path>, vault-relative path, or absolute vault path")
    .option("--relation <relation>", "Relation: wikilink, backlink, same-issue, same-project (default: wikilink)")
    .option("--depth <n>", "Traversal depth, 1-3 (default: 1)")
    .option("--limit <n>", "Maximum related results (default: 20)")
    .option("--with-frontmatter", "Include parsed frontmatter on source/results in JSON output")
    .option("--json", "Print machine-readable summary")
    .action(async (target: string, options: VaultRelatedCommandOptions) => {
      const depth = parsePositiveIntegerOption(options.depth, "--depth");
      const limit = parsePositiveIntegerOption(options.limit, "--limit");
      const result = await relatedVaultArtifacts(target, {
        ...(options.relation ? { relation: options.relation } : {}),
        ...(typeof depth === "number" ? { depth } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        withFrontmatter: Boolean(options.withFrontmatter),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printVaultRelatedHuman(result);
    });

  vault
    .command("toc")
    .description("Read markdown heading table of contents for one vault note")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultTocCommandOptions) => {
      const result = await getVaultTableOfContents(note, {
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const heading of result.headings) {
        console.log(`${"  ".repeat(heading.level - 1)}- ${heading.text} (${heading.id})`);
      }
    });

  const vaultSection = new Command("section").description("Read bounded markdown note sections");
  vaultSection
    .command("get")
    .description("Read one markdown heading section by heading id or text")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .requiredOption("--heading <id-or-text>", "Heading id or exact heading text")
    .option("--max-chars <n>", "Maximum section characters to print (default 8000)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultSectionGetCommandOptions) => {
      const maxChars = parsePositiveIntegerOption(options.maxChars, "--max-chars");
      const result = await getVaultSection(note, {
        heading: options.heading ?? "",
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      process.stdout.write(result.content);
      if (result.truncation.truncated) {
        console.error(
          `[calyx vault section get] truncated at ${result.truncation.max_chars}/${result.truncation.original_chars} chars; rerun with --json for truncation metadata.`,
        );
      }
    });
  vault.addCommand(vaultSection);

  const vaultFrontmatter = new Command("frontmatter").description("Read and query markdown frontmatter");
  vaultFrontmatter
    .command("get")
    .description("Read parsed YAML frontmatter for one vault note")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultFrontmatterGetCommandOptions) => {
      const result = await getVaultFrontmatter(note, {
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(JSON.stringify(result.frontmatter, null, 2));
    });

  vaultFrontmatter
    .command("query")
    .description("Query local vault markdown files by frontmatter fields")
    .option("--type <type>", "Filter by frontmatter type")
    .option("--where <expr>", "Predicate such as: attention == \"focus\"")
    .option("--limit <n>", "Maximum rows to return (default 50)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (options: VaultFrontmatterQueryCommandOptions) => {
      const limit = parsePositiveIntegerOption(options.limit, "--limit");
      const result = await queryVaultFrontmatter({
        ...(options.type ? { type: options.type } : {}),
        ...(options.where ? { where: options.where } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const row of result.rows) {
        console.log(row.uri);
      }
      for (const warning of result.warnings) {
        console.error(`[calyx vault frontmatter query] warning ${warning.code}: ${warning.message}`);
      }
      if (result.truncated) {
        console.error(`[calyx vault frontmatter query] truncated at ${result.query.limit} rows; rerun with --limit for more.`);
      }
    });
  vault.addCommand(vaultFrontmatter);

  vault
    .command("close-out")
    .description("Scaffold a session close-out with activity lineage frontmatter")
    .option("--parent <activity-id>", "Parent activity id for parent_session")
    .option("--spawned-by <wikilink-or-id>", "Wikilink or compact id for spawned_by")
    .option("--slug <slug>", "Filename slug; defaults to activity cwd basename")
    .option("--title <title>", "Close-out title; defaults to Session close-out: <slug>")
    .option("--runs-root <path>", "Override Calyx runs root for activity self lookup")
    .option("--host <host>", "Limit activity self lookup to one host")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--dry-run", "Preview the close-out without writing")
    .option("--json", "Print machine-readable summary")
    .action(async (options: VaultCloseOutCommandOptions) => {
      const result = await scaffoldVaultCloseOut(options, runCliDeps);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatVaultCloseOutText(result));
    });

  vault
    .command("radar-receipt")
    .description("Append a Session Receipt to the weekly radar through its journal contract")
    .option("--week <current|YYYY-Www>", "Weekly radar to update (default: current)", "current")
    .option("--runs-root <path>", "Override Calyx runs root for activity self lookup")
    .option("--host <host>", "Limit activity self lookup to one host")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--dry-run", "Preview the journal append without writing")
    .option("--json", "Print machine-readable summary")
    .action(async (options: VaultRadarReceiptCommandOptions) => {
      const result = await appendVaultRadarReceipt(options, runCliDeps);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatVaultRadarReceiptText(result));
    });

  vault
    .command("lineage-check")
    .description("Lint session lineage frontmatter for resolvable parent and spawned_by values")
    .argument("[file]", "Close-out note, vault URI, vault-relative path, or absolute markdown path")
    .option("--session", "Check the close-out note for the current activity session")
    .option("--runs-root <path>", "Override Calyx runs root for parent_session activity resolution")
    .option("--host <host>", "Resolve parent_session on one host")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (file: string | undefined, options: VaultLineageCheckCommandOptions) => {
      const result = await runVaultLineageCheck(file, options, runCliDeps);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatVaultLineageCheckText(result));
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  // ── Journal recall / append plane (POL-1775): entries → get, append ──
  const vaultJournal = new Command("journal").description(
    "Chronological vault-note journals: index entries, page one entry, or append through a declared journal contract",
  );
  vaultJournal
    .command("entries")
    .description("Index journal entries in one note; table sections are read-only")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--section <heading>", "Scope to one discovered section heading id or text")
    .option("--kind <auto|heading|bullet|table-row>", "Entry grammar to parse (default: auto)", "auto")
    .option("--last <n>", "Return the most recent N entries according to resolved order (default 20)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultJournalEntriesCommandOptions) => {
      const last = parsePositiveIntegerOption(options.last, "--last");
      const kind = parseVaultJournalKind(options.kind);
      const result = await listVaultJournalEntries(note, {
        ...(options.section ? { section: options.section } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof last === "number" ? { last } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const entry of result.entries) {
        console.log(
          `${entry.key}\t${entry.kind}\tL${entry.line_start}-L${entry.line_end}\t${entry.title}${entry.preview ? ` — ${entry.preview}` : ""}`,
        );
      }
      if (result.sections.length > 0) {
        console.error(
          `[calyx vault journal entries] sections: ${result.sections.map((section) => `${section.heading_id ?? section.heading_text}:${section.kind}`).join(", ")}`,
        );
      }
      console.error(
        `[calyx vault journal entries] ${result.entries.length} entries; order=${result.receipt.order} (${result.receipt.order_source}); recall_confidence=${result.receipt.recall_confidence}${result.receipt.append_blockers.length > 0 ? `; append_blockers=${result.receipt.append_blockers.join(",")}` : ""}`,
      );
    });

  vaultJournal
    .command("get")
    .description("Read one journal entry body by the stable key returned from entries")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .argument("<entry-key>", "Entry key such as 2026-06-12/title, 2026-06-12/title:2, or 2026-06-12:2")
    .option("--section <heading>", "Scope lookup to one discovered section heading id or text")
    .option("--range <A:B>", "Character slice of the entry body")
    .option("--max-chars <n>", "Character budget before head+tail elision (default 8000)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, key: string, options: VaultJournalGetCommandOptions) => {
      const maxChars = parsePositiveIntegerOption(options.maxChars, "--max-chars");
      const result = await getVaultJournalEntry(note, {
        key,
        ...(options.section ? { section: options.section } : {}),
        ...(options.range ? { range: options.range } : {}),
        ...(typeof maxChars === "number" ? { maxChars } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.entry.body);
      if (result.entry.text_cursor) {
        const ranges = result.entry.text_cursor.returned.map(([start, end]) => `${start}:${end}`).join(",");
        console.error(
          `[calyx vault journal get] ${result.entry.key} returned range=${ranges} total_chars=${result.entry.text_cursor.total_chars}`,
        );
      }
    });

  vaultJournal
    .command("append")
    .description("Append a heading or date-leading bullet entry through a high-confidence journal contract")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .requiredOption("--title <title>", "Entry title")
    .option("--date <YYYY-MM-DD>", "Entry date (default: today)")
    .option("--body <markdown>", "Entry body markdown")
    .option("--body-stdin", "Read entry body markdown from stdin")
    .option("--field <k=v>", "Heading field value (repeatable; fills declared field skeletons)", collectOptionValues, [])
    .option("--section <heading>", "Append inside one discovered/contracted section")
    .option("--dry-run", "Preview the append or print a suggested journal contract without writing")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultJournalAppendCommandOptions) => {
      if (options.body && options.bodyStdin) {
        throw createCliError("[calyx vault journal append] pass --body or --body-stdin, not both.", 2);
      }
      const stdinBody = options.bodyStdin ? await readStdinText() : undefined;
      const fields = parseVaultJournalFields(options.field);
      try {
        const result = await appendVaultJournalEntry(note, {
          title: options.title ?? "",
          ...(options.date ? { date: options.date } : {}),
          ...(stdinBody !== undefined || options.body !== undefined ? { body: stdinBody ?? options.body ?? "" } : {}),
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          ...(options.section ? { section: options.section } : {}),
          dryRun: Boolean(options.dryRun),
          ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (!result.changed && result.suggested_contract) {
          console.log(formatJournalSuggestedContract(result.suggested_contract));
          console.error("[calyx vault journal append] dry-run only; no write performed because append needs a journal contract.");
          return;
        }

        const prefix = result.dryRun ? "[dry-run] would append" : "appended";
        console.log(
          `[calyx vault journal append] ${prefix} ${result.entry?.key ?? options.title} at L${result.insertion?.line ?? "?"}${result.date_out_of_order ? " (date_out_of_order)" : ""}`,
        );
        if (result.dryRun && result.content) {
          console.log("---");
          console.log(result.content);
        }
      } catch (error) {
        const suggested = (error as { suggestedContract?: VaultJournalSuggestedContract }).suggestedContract;
        if (suggested) {
          console.error(formatJournalSuggestedContract(suggested));
        }
        throw error;
      }
    });
  vault.addCommand(vaultJournal);

  // ── Footnotes recall plane (POL-1763): list → get ladder, add, lint, gc ──
  const vaultFootnotes = new Command("footnotes").description(
    "Footnote progressive disclosure for vault notes: list, get, add, lint, gc (named keys are stable cursors)",
  );
  vaultFootnotes
    .command("list")
    .description("Enumerate footnotes in one note: keys, ref counts, previews, body sizes, orphans")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultFootnotesListCommandOptions) => {
      const result = await listVaultFootnotes(note, {
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const footnote of result.footnotes) {
        const flags = [
          footnote.orphaned ? "orphaned" : undefined,
          footnote.dangling ? "dangling" : undefined,
          footnote.definition_count > 1 ? `defined x${footnote.definition_count}` : undefined,
          footnote.kind === "inline" ? "inline" : undefined,
        ].filter(Boolean).join(", ");
        const refSummary = footnote.ref_lines.length > 0 ? ` (L${footnote.ref_lines.join(",L")})` : "";
        console.log(
          `[^${footnote.key}] refs=${footnote.ref_count}${refSummary} body=${footnote.body_chars} chars${flags ? ` [${flags}]` : ""}${footnote.preview ? ` — ${footnote.preview}` : ""}`,
        );
      }
      console.error(
        `[calyx vault footnotes list] ${result.footnotes.length} footnotes; recall_confidence=${result.receipt.recall_confidence}${result.receipt.guard_hits.length > 0 ? `; guard_hits=${result.receipt.guard_hits.join(",")}` : ""}`,
      );
    });

  vaultFootnotes
    .command("get")
    .description("Read one or more footnote bodies on demand; keys are the stable cursors")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .argument("[key]", "Footnote key (without [^ ] markers)")
    .option("--keys <a,b,c>", "Comma-separated footnote keys")
    .option("--range <A:B>", "Character slice of a single footnote body (mirrors activity text --range)")
    .option("--max-chars <n>", "Per-body character budget before head+tail elision (default 8000)")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, key: string | undefined, options: VaultFootnotesGetCommandOptions) => {
      const maxChars = parsePositiveIntegerOption(options.maxChars, "--max-chars");
      const keys = [
        ...(key ? [key] : []),
        ...(options.keys ? options.keys.split(",") : []),
      ].map((value) => value.trim()).filter(Boolean);
      const result = await getVaultFootnotes(note, {
        keys,
        ...(options.range ? { range: options.range } : {}),
        ...(typeof maxChars === "number" ? { maxChars } : {}),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const footnote of result.footnotes) {
        console.log(`[^${footnote.key}]: ${footnote.body}`);
        if (footnote.text_cursor) {
          const ranges = footnote.text_cursor.returned.map(([start, end]) => `${start}:${end}`).join(",");
          console.error(
            `[calyx vault footnotes get] [^${footnote.key}] returned range=${ranges} total_chars=${footnote.text_cursor.total_chars}`,
          );
        }
      }
    });

  vaultFootnotes
    .command("add")
    .description("Insert a footnote reference at an anchor and append its definition to the ## Footnotes block")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .requiredOption("--key <name>", "New footnote key (alphanumeric with hyphens/underscores)")
    .requiredOption("--anchor <text|^block-id>", "Literal spine text (must be unique) or Obsidian ^block-id to attach the reference to")
    .option("--body <text>", "Footnote definition body")
    .option("--body-stdin", "Read the definition body from stdin")
    .option("--renumber", "Renormalize numeric keys to a monotonic sequence after insertion")
    .option("--dry-run", "Preview the edit without writing")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultFootnotesAddCommandOptions) => {
      const stdinBody = options.bodyStdin ? await readStdinText() : undefined;
      const result = await addVaultFootnote(note, {
        key: options.key ?? "",
        anchor: options.anchor ?? "",
        body: stdinBody ?? options.body ?? "",
        renumber: Boolean(options.renumber),
        dryRun: Boolean(options.dryRun),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const prefix = result.dryRun ? "[dry-run] would insert" : "inserted";
      console.log(
        `[calyx vault footnotes add] ${prefix} [^${result.key}] at line ${result.reference_line} (anchor ${result.anchor.kind} L${result.anchor.matched_line}); definition at line ${result.definition_line}${result.footnotes_block_created ? "; created ## Footnotes block" : ""}`,
      );
      for (const entry of result.renumbered) {
        console.log(`[calyx vault footnotes add] renumbered [^${entry.from}] -> [^${entry.to}]`);
      }
      if (result.dryRun && result.content) {
        console.log("---");
        console.log(result.content);
      }
    });

  vaultFootnotes
    .command("lint")
    .description("Advisory footnote findings (orphans, dangling refs, dupes) plus altitude metrics for the Archaeologist vault stratum")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultFootnotesLintCommandOptions) => {
      const result = await lintVaultFootnotes(note, {
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const finding of result.findings) {
        const location = [finding.key ? `[^${finding.key}]` : undefined, finding.line ? `L${finding.line}` : undefined]
          .filter(Boolean)
          .join(" ");
        console.log(`${finding.severity} ${finding.code}${location ? ` ${location}` : ""}: ${finding.message}`);
      }
      console.error(
        `[calyx vault footnotes lint] ${result.findings.length} findings; footnote_share=${result.metrics.footnote_share}; spine=${result.metrics.spine_lines} lines, footnotes=${result.metrics.footnote_block_lines} lines; recall_confidence=${result.receipt.recall_confidence}`,
      );
    });

  vaultFootnotes
    .command("gc")
    .description("Normalize footnotes loss-lessly: relocate stray definitions into the block, dedupe exact duplicates, optionally drop orphans")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--drop-orphans", "Also remove definitions that have no reference (destructive opt-in)")
    .option("--renumber", "Renormalize numeric keys to a monotonic sequence")
    .option("--dry-run", "Preview the normalization without writing")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultFootnotesGcCommandOptions) => {
      const result = await gcVaultFootnotes(note, {
        dropOrphans: Boolean(options.dropOrphans),
        renumber: Boolean(options.renumber),
        dryRun: Boolean(options.dryRun),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.changed) {
        console.log("[calyx vault footnotes gc] already normalized; no changes.");
        return;
      }
      for (const action of result.actions) {
        console.log(`${result.dryRun ? "[dry-run] " : ""}${action.code}${action.key ? ` [^${action.key}]` : ""}: ${action.detail}`);
      }
      if (result.dryRun && result.content) {
        console.log("---");
        console.log(result.content);
      }
    });
  vault.addCommand(vaultFootnotes);

  // ── Stamp (POL-1764): refresh staleness frontmatter, body byte-identical ──
  vault
    .command("stamp")
    .description("Refresh updated/updated_by (and optional staleness fields) after an in-place edit; body stays byte-identical")
    .argument("<note>", "Vault-relative markdown path or vault://fieldwork/... URI")
    .option("--updated <ts>", "Override the updated value (default: today)")
    .option("--updated-by <who>", "Override the updated_by value (default: detected agent identity)")
    .option("--last-probed [ts]", "Also refresh last_probed (default value: today)")
    .option("--field <k=v>", "Additional staleness/provenance field to set (repeatable; identity fields refused)", collectOptionValues, [])
    .option("--dry-run", "Print the frontmatter diff without writing")
    .option("--vault-path <path>", "Override fieldwork vault root")
    .option("--json", "Print machine-readable summary")
    .action(async (note: string, options: VaultStampCommandOptions) => {
      const fields: Record<string, string> = {};
      for (const entry of options.field ?? []) {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
          throw createCliError(`[calyx vault stamp] --field expects k=v (got: ${entry})`, 2);
        }
        fields[entry.slice(0, separator).trim()] = entry.slice(separator + 1);
      }
      const result = await stampVaultArtifact(note, {
        ...(options.updated ? { updated: options.updated } : {}),
        ...(options.updatedBy ? { updatedBy: options.updatedBy } : {}),
        ...(options.lastProbed !== undefined
          ? { lastProbed: typeof options.lastProbed === "string" ? options.lastProbed : "" }
          : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
        dryRun: Boolean(options.dryRun),
        ...(options.vaultPath ? { vaultPath: options.vaultPath } : {}),
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const prefix = result.dryRun ? "[dry-run] would stamp" : "stamped";
      console.log(`[calyx vault stamp] ${prefix} ${result.relative_path} (body unchanged, sha256 ${result.body_hash.slice(0, 12)}…)`);
      for (const line of result.frontmatter_diff) {
        console.log(line);
      }
      if (!result.changed) {
        console.log("[calyx vault stamp] frontmatter already current; no changes.");
      }
    });

  vault
    .command("status")
    .description("Show vault summary and sync status")
    .option("--json", "Print machine-readable summary")
    .action(async (options: VaultStatusCommandOptions) => {
      const result = await getVaultStatus();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printVaultStatusHuman(result);
    });

  // ── State store domain (POL-1338, wave 1) ─────────────────────────
  const state = new Command("state")
    .description("Local SQLite state store: path, health, migrations, doctor")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx state path                       # show resolved DB path + provenance",
        "  $ calyx state migrate --plan --json      # preview pending migrations (read-only)",
        "  $ calyx state migrate --apply --json     # apply migrations idempotently",
        "  $ calyx state health --json              # structured health snapshot",
        "  $ calyx state doctor                     # operator-readable diagnostics",
        "  $ calyx state event-log rebuild --plan   # compare event_log to the run journal",
        "  $ calyx state event-log quarantine       # rows set aside so ingest could continue",
        "",
        "Plan first with `migrate --plan`, then `migrate --apply`, then verify with `doctor`.",
        "Override the location with CALYX_STATE_HOME=<dir> or CALYX_STATE_DB=<file>.",
      ].join("\n"),
    );

  state
    .command("path")
    .description("Show the resolved Calyx state directory and database path")
    .option("--json", "Print machine-readable summary")
    .action(async (options: { json?: boolean }) => {
      const info = describeStatePaths();
      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(info.dbPath);
      console.error(`state-dir: ${info.stateDir}  [source: ${info.dirSource}]`);
      console.error(`db-path:   ${info.dbPath}  [source: ${info.source}]`);
      console.error(`override with ${info.envVars.home}=<dir> or ${info.envVars.db}=<file>`);
    });

  state
    .command("migrate")
    .description("Plan or apply Calyx state-store migrations (idempotent)")
    .option("--plan", "Print the pending migration plan without writing")
    .option("--apply", "Apply pending migrations inside a transaction")
    .option("--json", "Print machine-readable summary")
    .action(async (options: { plan?: boolean; apply?: boolean; json?: boolean }) => {
      const planMode = Boolean(options.plan);
      const applyMode = Boolean(options.apply);
      if (planMode === applyMode) {
        throw createCliError(
          "calyx state migrate: pass exactly one of --plan or --apply.",
          2,
        );
      }
      try {
        if (planMode) {
          const plan: MigrationPlan = await planStateMigrations();
          if (options.json) {
            console.log(JSON.stringify(plan, null, 2));
            return;
          }
          console.error(`driver:   ${plan.driver}`);
          console.error(`current:  ${plan.current ?? "(none)"}`);
          console.error(`target:   ${plan.target ?? "(none)"}`);
          console.error(`pending:  ${plan.pending.length}`);
          for (const entry of plan.pending) {
            console.log(`pending\t${entry.id}\t${entry.description}`);
          }
          for (const entry of plan.applied) {
            console.error(`applied\t${entry.id}\t${entry.description}\t${entry.appliedAt}`);
          }
          return;
        }
        const result: MigrationApplyResult = await applyStateMigrations();
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.error(`driver:   ${result.driver}`);
        console.error(`current:  ${result.current ?? "(none)"}`);
        console.error(`target:   ${result.target ?? "(none)"}`);
        if (result.applied.length === 0) {
          console.error("no migrations applied (already up to date)");
        }
        for (const entry of result.applied) {
          console.log(`applied\t${entry.id}\t${entry.description}\t${entry.appliedAt}`);
        }
      } catch (err) {
        throw mapStateError(err);
      }
    });

  state
    .command("health")
    .description("Print state-store health (driver, schema version, WAL, modes, migrations)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: { json?: boolean }) => {
      try {
        const report: StateHealthReport = await reportStateHealth();
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          if (!report.ok) {
            throw createCliError("calyx state health reported non-ok status", 4);
          }
          return;
        }
        printHealthHuman(report);
        if (!report.ok) {
          throw createCliError("calyx state health reported non-ok status", 4);
        }
      } catch (err) {
        throw mapStateError(err);
      }
    });

  state
    .command("doctor")
    .description("Diagnose state-store consistency and surface actionable findings")
    .option(
      "--domain <name>",
      `Restrict doctor to a domain. Repeatable. Known: ${[...STATE_DOCTOR_DOMAINS, ...STATE_DOCTOR_NOT_APPLICABLE_DOMAINS].join(", ")}.`,
      collectOptionValues,
      [] as string[],
    )
    .option("--json", "Print machine-readable summary")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ calyx state doctor --domain skill_proposals --json",
        "  $ calyx state doctor --domain activity --domain skill_proposals --json",
        "",
        "Unknown --domain values fail loudly. The activity domain reports schema",
        "parity plus recall-index freshness (indexed-through, pending tails).",
      ].join("\n"),
    )
    .action(async (options: { json?: boolean; domain?: string[] }) => {
      try {
        const domains = (options.domain ?? []).map((d) => d.trim()).filter(Boolean);
        const report: StateDoctorReport = domains.length > 0
          ? await runStateDoctor({ domains })
          : await runStateDoctor();
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          if (!report.ok) {
            throw createCliError("calyx state doctor reported blocking findings", 4);
          }
          return;
        }
        printHealthHuman(report);
        const projection = report.eventLogProjection;
        console.error(
          `event-log:     ${projection.status === "skipped"
            ? projection.skipped_reason ?? "skipped"
            : `matched=${projection.matched} missing=${projection.missing} divergent=${projection.divergent}`
              + ` ledger-native=${projection.ledger_native_rows} orphaned=${projection.orphaned_rows}`
              + ` quarantined=${report.eventLogQuarantine.total}`}`,
        );
        if (report.domains && report.domains.length > 0) {
          console.error("");
          for (const domain of report.domains) {
            console.error(`domain:        ${domain.domain}\tstatus=${domain.status}${domain.detail ? "\t" + domain.detail : ""}`);
            for (const finding of domain.findings) {
              const tag = finding.severity.toUpperCase().padEnd(5);
              console.error(`  ${tag} ${finding.code}\t${finding.message}`);
            }
          }
        } else if (report.findings.length === 0) {
          console.error("no findings");
        } else {
          console.error("");
          for (const finding of report.findings) {
            const tag = finding.severity.toUpperCase().padEnd(5);
            console.error(`${tag} ${finding.code}\t${finding.message}`);
          }
        }
        if (!report.ok) {
          throw createCliError("calyx state doctor reported blocking findings", 4);
        }
      } catch (err) {
        throw mapStateError(err);
      }
    });

  // ── event_log projection repair (POL-2090) ────────────────────────
  // `event_log` mirrors the run-root stream journal. These commands make
  // that projection rebuildable and its refusals inspectable, so one
  // divergent row is a repair rather than a permanently blocked upgrade.
  const eventLog = state
    .command("event-log")
    .description("Inspect and repair the event_log projection of the run stream journal")
    .addHelpText(
      "after",
      [
        "",
        "`event_log` is a projection, not a system of record. Run/control/monitor",
        "events are journaled at <runs-root>/events.index.jsonl before the ledger",
        "sees them, so those rows are rebuildable. Rows written straight to the",
        "ledger (Symphony daemon issue events) have no journal behind them and are",
        "never recreated — `rebuild` merges, it never replaces.",
        "",
        "Examples:",
        "  $ calyx state event-log rebuild --plan --json   # what diverges, what is missing",
        "  $ calyx state event-log rebuild --apply         # merge the journal, quarantine conflicts",
        "  $ calyx state event-log quarantine --json       # what was set aside, and both versions",
        "",
        "Override the journal with --runs-root <dir> or CALYX_RUNS_ROOT=<dir>.",
      ].join("\n"),
    );

  eventLog
    .command("rebuild")
    .description("Compare event_log to the run stream journal, and optionally merge the journal back in")
    .option("--plan", "Report divergence and gaps without writing (default)")
    .option("--apply", "Merge journaled events into event_log, quarantining genuine conflicts")
    .option("--runs-root <dir>", "Run root holding events.index.jsonl (default: CALYX_RUNS_ROOT or ~/.calyx/runs)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: { plan?: boolean; apply?: boolean; runsRoot?: string; json?: boolean }) => {
      if (options.plan && options.apply) {
        throw createCliError("calyx state event-log rebuild: pass at most one of --plan or --apply.", 2);
      }
      const mode = options.apply ? "apply" : "plan";
      try {
        const result = await rebuildEventLogProjection({
          mode,
          journalPath: resolveEventJournalPath(
            options.runsRoot ? { runsRoot: options.runsRoot } : {},
          ),
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const r = result.report;
          console.error(`mode:          ${result.mode}`);
          console.error(`journal:       ${r.journal_path}${r.journal_present ? "" : " (absent)"}`);
          console.error(`scanned:       ${r.scanned} line(s), ${r.unparsable} unparsable, ${r.non_projectable} not projectable`);
          console.error(`ledger:        ${r.ledger_rows} row(s)`);
          console.error(`matched:       ${r.matched}`);
          console.error(`missing:       ${r.missing}\t(journaled, absent from event_log — rebuildable)`);
          console.error(`divergent:     ${r.divergent}\t(journal and ledger genuinely disagree)`);
          console.error(`ledger-native: ${r.ledger_native_rows}\t(no journal behind them — never rebuildable)`);
          console.error(`orphaned:      ${r.orphaned_rows}\t(journal-derived domain, no journal line)`);
          if (result.refused_reason) {
            console.error(`refused:       ${result.refused_reason}`);
          } else if (mode === "apply") {
            console.error(`restored:      ${result.restored}`);
            console.error(`replaced:      ${result.replaced} (quarantined ${result.quarantined.length})`);
            for (const skip of result.skipped.slice(0, 10)) {
              console.error(`  skipped ${skip.event_id}\t${skip.reason}`);
            }
          }
          console.error("");
          console.error("not restorable by any rebuild:");
          for (const note of result.not_restorable) console.error(`  - ${note}`);
        }
        if (result.refused_reason) {
          throw createCliError(`calyx state event-log rebuild refused: ${result.refused_reason}`, 4);
        }
      } catch (err) {
        throw mapStateError(err);
      }
    });

  eventLog
    .command("quarantine")
    .description("List event_log rows that were set aside so ingest could continue")
    .option("--limit <n>", "Maximum records to print (default 20)", (v: string) => Number.parseInt(v, 10))
    .option("--json", "Print machine-readable summary")
    .action(async (options: { limit?: number; json?: boolean }) => {
      try {
        const paths = describeStatePaths();
        const inventory = await listEventLogQuarantineRecords(paths.stateDir, {
          ...(Number.isFinite(options.limit) ? { limit: options.limit as number } : {}),
        });
        if (options.json) {
          console.log(JSON.stringify(inventory, null, 2));
          return;
        }
        console.error(`quarantine-dir: ${inventory.dir}`);
        console.error(`records:        ${inventory.total}${inventory.truncated ? ` (showing ${inventory.entries.length})` : ""}`);
        if (inventory.unreadable > 0) {
          console.error(`unreadable:     ${inventory.unreadable}`);
        }
        for (const entry of inventory.entries) {
          const r = entry.record;
          console.log(
            `${r.quarantined_at}\t${r.event_id}\t${r.reason}\torigin=${r.origin}\tresolution=${r.resolution}\tfields=${r.divergent_fields.map((d) => d.field).join(",") || "(none)"}`,
          );
          console.error(`  committed-source: ${r.committed?.source ?? "(no committed row)"}\tincoming-source: ${r.incoming?.source ?? "(none)"}`);
          console.error(`  record: ${entry.path}`);
        }
      } catch (err) {
        throw mapStateError(err);
      }
    });

  // ── Extensions agent-mail subcommand (POL-679) ─────────────────────
  for (const verb of ["status", "send", "inbox", "read"] as const) {
    const cmd = extensions.command(`agent-mail-${verb}`)
      .description(`Agent-mail ${verb} via extension adapter`)
      .option("--json", "Print machine-readable summary");

    if (verb === "send") {
      cmd.requiredOption("--message <message>", "Message to send");
      cmd.option("--project-key <key>", "Project key");
      cmd.option("--thread-id <id>", "Thread ID");
    }
    if (verb === "inbox" || verb === "read") {
      cmd.option("--project-key <key>", "Project key");
      cmd.option("--thread-id <id>", "Thread ID");
    }

    cmd.action(async (options: AgentMailCommandOptions) => {
      const result = await agentMailAdapter({
        verb: parseAgentMailVerb(verb),
        ...(options.projectKey ? { projectKey: options.projectKey } : {}),
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.message ? { message: options.message } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.delegated) {
        console.log(result.output);
      } else {
        console.error(result.output);
        if (result.exitCode !== 0) {
          throw createCliError(result.output, result.exitCode);
        }
      }
    });
  }

  // Wire extension lifecycle hooks into domain commands
  hookDomainCommand(skills, "skills");
  hookDomainCommand(tools, "tools");
  hookDomainCommand(prompts, "prompts");
  hookDomainCommand(agents, "agents");
  hookDomainCommand(knowledge, "knowledge");
  hookDomainCommand(exec, "exec");

  program.addCommand(config);
  program.addCommand(instructions);
  program.addCommand(skills);
  program.addCommand(buildMemoryCommand());
  program.addCommand(plugins);
  program.addCommand(tools);
  program.addCommand(prompts);
  program.addCommand(tasks);
  program.addCommand(agents);
  program.addCommand(knowledge);
  program.addCommand(oracle);
  program.addCommand(context);
  program.addCommand(mcp);
  program.addCommand(client);
  program.addCommand(run);
  program.addCommand(review);
  program.addCommand(msg);
  program.addCommand(lease);
  program.addCommand(monitor);
  program.addCommand(activity);
  program.addCommand(agentContext);
  program.addCommand(exec);
  program.addCommand(extensions);
  program.addCommand(doctor);
  program.addCommand(verify);
  program.addCommand(fleet);
  program.addCommand(bundle);
  program.addCommand(install);
  program.addCommand(runtimeConfig);
  program.addCommand(self);
  program.addCommand(state);
  program.addCommand(vault);

  return program;
}

/**
 * Resolve legacy wrapper invocations before Commander parsing.
 *
 * Implemented wrappers delegate to canonical commands by argv rewriting.
 * Retired/deprecated/deferred wrappers throw their tombstone diagnostics here
 * so the active Commander help surface can remain canonical-only.
 */
export function resolveWrapperDelegation(argv: string[]): string[] | null {
  const helpDelegation = argv[2] === "help" && argv[3] ? { wrapperIndex: 3 } : null;
  const wrapperIndex = helpDelegation?.wrapperIndex ?? 2;
  const invokedCommand = argv[wrapperIndex];
  const wrapperDef = invokedCommand
    ? WRAPPER_REGISTRY.find((d) => d.wrapper === invokedCommand)
    : undefined;

  if (!wrapperDef) return null;

  if (wrapperDef.status === "retired") {
    throw createCliError(getRetiredWrapperMessage(wrapperDef.wrapper), 6);
  }
  if (wrapperDef.status === "deprecated") {
    throw createCliError(getDeprecatedWrapperMessage(wrapperDef.wrapper), 5);
  }
  if (wrapperDef.status === "deferred") {
    throw createCliError(getDeferredWrapperMessage(wrapperDef.wrapper), 5);
  }

  emitWrapperTelemetry(wrapperDef.wrapper, wrapperDef.target);
  const guardrail = checkWrapperGuardrail(wrapperDef.wrapper, wrapperDef.target);
  if (!guardrail.allowed) {
    throw createCliError(guardrail.message!, guardrail.phase === "error" ? 6 : 1);
  }
  console.error(
    `[calyx][wrapper] "${wrapperDef.wrapper}" delegates to "${wrapperDef.target}". Please update your workflow.`
  );

  // Rewrite argv: replace the wrapper name with the canonical target's
  // subcommand path, preserving all arguments that follow the wrapper name.
  const targetParts = wrapperDef.target.replace(/^calyx\s+/, "").split(/\s+/);
  const forwardedArgs = argv.slice(wrapperIndex + 1);
  if (helpDelegation) {
    return [...argv.slice(0, 2), "help", ...targetParts, ...forwardedArgs];
  }
  return [...argv.slice(0, 2), ...targetParts, ...forwardedArgs];
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = buildProgram();

  // Implemented wrappers delegate to canonical commands via argv rewriting.
  // The wrapper's action handler in buildProgram is kept for --help display;
  // the actual delegation happens here before parseAsync.
  const resolvedArgv = resolveWrapperDelegation(argv) ?? argv;

  try {
    await program.parseAsync(resolvedArgv);
  } finally {
    if (_extensionRunner) {
      const result = await _extensionRunner.deactivate();
      for (const m of result.messages) {
        console.error(m);
      }
    }
  }
}
