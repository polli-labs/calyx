export { AgentRunnerKernel, HostProcessKernel } from "./kernel.js";
export type {
  AgentRunnerKernelDependencies,
  ExecutionKernel,
  ExecutionKernelContext,
  ExecutionResult,
} from "./kernel.js";

export { resolveRunIntent } from "./resolve.js";
export type { ResolveRunIntentOptions } from "./resolve.js";
export {
  DEFAULT_INTERACTIVE_ACTIVITY_LIMIT,
  DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS,
  DEFAULT_INTERACTIVE_PAGE_CANDIDATE_LIMIT,
  InteractiveActivityProjectionNotReadyError,
  InteractiveActivityRootConfigurationError,
  inspectInteractiveSession,
  listInteractiveSessions,
  listInteractiveSessionIdentities,
  listInteractiveSessionsPage,
  listInteractiveSessionsSnapshotPage,
  summarizeInteractiveSessions,
} from "./interactive-activity.js";
export type {
  InteractiveActivityOptions,
  InteractiveSessionInspectOptions,
  InteractiveSessionSnapshotPage,
} from "./interactive-activity.js";
export {
  describeMalformedActivityLocator,
  formatMalformedActivityLocator,
} from "./activity-id-resolution.js";
export type {
  MalformedActivityLocator,
  MalformedActivityLocatorReason,
} from "./activity-id-resolution.js";
export {
  ACTIVITY_MESSAGE_CLASSIFIER_VERSION,
  ACTIVITY_ATTACHMENT_CACHE_OBSERVATION_MAX_ITEMS,
  ACTIVITY_ATTACHMENT_CACHE_PROVENANCE_MAX_BYTES,
  ACTIVITY_ATTACHMENT_MAX_BYTES,
  ACTIVITY_MESSAGE_ROLES,
  ACTIVITY_TURN_ROLE_FILTERS,
  ACTIVITY_TURN_ROLES,
  ACTIVITY_VISIBILITY_TIERS,
  ActivityEventSelectorError,
  ActivityIdAmbiguousError,
  ActivityIdMalformedError,
  ActivityIdNotFoundError,
  ActivityAttachmentError,
  ActivityMessageNotFoundError,
  ActivityMessageSelectorError,
  ActivityRunMissingMetadataError,
  ActivityTurnSelectorError,
  attachmentDigestFromRef,
  createAttachmentCacheTempPath,
  defaultAttachmentCacheDir,
  extensionForMimeType,
  classifyEventForTesting,
  inspectActivityEvents,
  inspectActivityAttachments,
  inspectActivityAttachmentRecord,
  inspectActivityMessages,
  inspectActivityText,
  inspectActivityTurns,
  projectInteractiveSessionToMessages,
  parseActivityMessageId,
  parseActivityTurnId,
  readActivityAttachmentBytes,
  readVerifiedAttachmentCache,
  recordVerifiedAttachmentCacheHit,
  publishVerifiedAttachmentCacheFile,
  resolveInteractiveActivity,
  writeVerifiedAttachmentCache,
} from "./activity-messages.js";
export type {
  ActivityEventEntry,
  ActivityEventSelectorInput,
  ActivityEventsResult,
  ActivityEventsSelector,
  ActivityAttachmentBytesResult,
  ActivityAttachmentCacheEntry,
  ActivityAttachmentCacheObservation,
  ActivityAttachmentCacheStatus,
  ActivityAttachmentCacheWriteResult,
  VerifiedActivityAttachmentCacheFile,
  ActivityAttachmentErrorCode,
  ActivityAttachmentErrorDetails,
  ActivityAttachmentRecord,
  ActivityAttachmentRecordResult,
  ActivityAttachmentRollup,
  ActivityAttachmentsResult,
  ActivityAttachmentsSelectorInput,
  ActivityAttachmentSourceShape,
  ActivityAttachmentSourceTier,
  ActivityMessage,
  ActivityMessageActivityRef,
  ActivityMessageClassification,
  ActivityMessageRole,
  ActivityMessageSelectorInput,
  ActivityMessageVisibility,
  ActivityMessagesResult,
  ActivityMessagesSelector,
  ActivitySourceState,
  ActivitySourceReadReceipt,
  ActivitySourceWarning,
  ActivityTextCursor,
  ActivityTextResult,
  ActivityTextSelectorInput,
  ActivityTurn,
  ActivityTurnRole,
  ActivityTurnRoleFilter,
  ActivityTurnSelectorInput,
  ActivityTurnState,
  ActivityTurnsResult,
  ActivityTurnsSelector,
  ActivityVisibilityTier,
  InspectActivityAttachmentRecordOptions,
  InspectActivityEventsOptions,
  InspectActivityAttachmentsOptions,
  InspectActivityMessagesOptions,
  InspectActivityTextOptions,
  InspectActivityTurnsOptions,
  ParsedActivitySourceId,
  ResolveInteractiveActivityOptions,
  RunActivityRecordResolver,
  RunActivityResolution,
} from "./activity-messages.js";
export { readDaemonMemoryMetrics, readEventLoopLagMetrics } from "./daemon-metrics.js";
export {
  DAEMON_METRICS_INSTRUMENTS,
  OTEL_DAEMON_DEFAULT_ENDPOINT,
  OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS,
  OTEL_DAEMON_EXPORT_TIMEOUT_MS,
  OTEL_DAEMON_METER_NAME,
  OTEL_DAEMON_SCHEMA_VERSION,
  OTEL_DAEMON_SERVICE_NAME,
  buildResourceAttributes,
  initDaemonMetricsExporter,
  resolveExportIntervalMs,
  resolveOtelEndpoint,
} from "./otel-metrics.js";
export type {
  DaemonMetricsExporterHandle,
  DaemonMetricsInstrumentDescriptor,
  DaemonMetricsSnapshot,
  InitDaemonMetricsExporterOptions,
  OtelExporterConfig,
  OtelMetricsLogger,
  OtelMetricsRunService,
  OtelMetricsServerState,
  OtelPushMetricExporterLike,
} from "./otel-metrics.js";

export {
  InfraErrorCensusAuthorityError,
  auditInfraErrorCensusAuthority,
  projectInfraErrorCensusAuthority,
} from "./infra-error-census.js";
export type {
  InfraErrorCensusAuthorityAmbiguity,
  InfraErrorCensusAuthorityAmbiguityCode,
  InfraErrorCensusAuthorityAudit,
  InfraErrorCensusAuthorityProjection,
  InfraErrorCensusLegacyRootAudit,
  InfraErrorCensusProjectionLeaf,
} from "./infra-error-census.js";

export {
  ActivityMarkTargetAmbiguousError,
  ActivityMarkTargetNotFoundError,
  ActivityMarkTargetUnavailableError,
  RunAlreadyExistsError,
  RunExecutionSettlementPendingError,
  RunNotFoundError,
  RunService,
  isLocalRunTarget,
  openDetachedLogFiles,
} from "./service.js";
export type { DetachedWorkerSupervisor } from "./worker-supervisor.js";
export type {
  ExecuteStoredRunOptions,
  LaunchRunOptions,
  ResolveMarkableActivityTargetOptions,
  ResolvedMarkableActivityTarget,
  ReconcileRunOptions,
  ReconcileRunScope,
  RunCancellationResult,
  RunServiceRunningMetrics,
  RunServiceDependencies,
  RunServiceOptions,
  RecordIndependentReviewEvidenceOptions,
  ObserveIndependentReviewRunOptions,
  RunResourceTerminalAuthority,
  StopRunOptions,
} from "./service.js";
export { MonitorEvaluator } from "./monitor-evaluator.js";
export type {
  MonitorEvaluatorDependencies,
  MonitorEvaluatorOptions,
  MonitorEvaluatorTickResult,
} from "./monitor-evaluator.js";
export { ActivityTailer } from "./activity-tailer.js";
export type {
  ActivityTailerDependencies,
  ActivityTailerOptions,
  ActivityTailerTickResult,
} from "./activity-tailer.js";
export { MessageOutboxForwarder } from "./message-outbox-forwarder.js";
export type {
  MessageOutboxDrainResult,
  MessageOutboxForwardResult,
  MessageOutboxForwarderOptions,
  MessageOutboxObservationResult,
} from "./message-outbox-forwarder.js";
export {
  deliverMonitorWakeBindings,
  deliveryMaterialityMatches,
} from "./monitor-delivery.js";
export type {
  MonitorDeliveryDependencies,
  MonitorDeliveryExecFile,
  MonitorDeliveryFetch,
  MonitorDeliverySummary,
} from "./monitor-delivery.js";
export {
  DEFAULT_SESSION_INGRESS_RUNTIME_DIR,
  SESSION_WAKE_DELIVER_REQUEST_SCHEMA_VERSION,
  SESSION_WAKE_RECEIPT_SCHEMA_VERSION,
  SESSION_WAKE_RESULT_SCHEMA_VERSION,
  deliverSessionWakeViaPrivateIpc,
  routeSessionWake,
  startSessionIngressReceiver,
} from "./session-ingress.js";
export type {
  SessionIngressReceiverHandle,
  SessionWakeDeliverRequestV1,
  SessionWakeDeliveryObservation,
  SessionWakeRouteDependencies,
  SessionWakeRouteResult,
  SessionWakeState,
  SessionWakeTransportReceipt,
  SessionWakeTransportResult,
} from "./session-ingress.js";
export { readRunLogs } from "./run-logs.js";
export type { ReadRunLogsOptions } from "./run-logs.js";
export type { IndependentReviewAdminProjection } from "./review-coordinator.js";
export { collectHostResources, parseNvidiaSmiCsv } from "./host-resources.js";
export {
  collectResourceAttribution,
  parseNvidiaSmiComputeAppsCsv,
  parsePsProcessRows,
} from "./resource-attribution.js";
export type { ExecFileAsync } from "./host-resources.js";
export { observeRun } from "./run-observation.js";
export type { ObserveRunOptions } from "./run-observation.js";

export { createTrackerRegistry } from "./tracker.js";
export { loadWorkflowFile, renderWorkflowPrompt } from "./workflow.js";
export { DaemonStore, defaultDaemonsRoot } from "./daemon-store.js";
export type { DaemonPaths } from "./daemon-store.js";
export {
  detectSupervisor,
  detectSupervisorKind,
  listDescriptors,
  readDescriptor,
  pruneStaleDescriptors,
  removeDescriptor,
  removeDescriptorForPid,
  writeDescriptor,
} from "./daemon-registry.js";
export type { DaemonRegistryOptions } from "./daemon-registry.js";
export { DaemonService, renderHandoffComment } from "./daemon.js";
export type { DaemonServiceDependencies, DaemonServiceOptions } from "./daemon.js";
export {
  DAEMON_LEDGER_AGGREGATE_TYPE,
  DAEMON_LEDGER_DOMAIN,
  DaemonLedger,
  daemonAggregateId,
  daemonLockKey,
  daemonSourceId,
} from "./daemon-ledger.js";
export type {
  DaemonIssueEventType,
  DaemonLedgerEvent,
  DaemonLedgerEventInput,
} from "./daemon-ledger.js";

export {
  RUN_ID_PATTERN_SOURCE,
  EventAuthorityNotPreparedError,
  EventReplayCursorError,
  EventJournalCorruptionError,
  EventJournalEventIdentityConflictError,
  EventSseFrameTooLargeError,
  RunCreationConflictError,
  RunIndexProjectionNotReadyError,
  RunListSnapshotChangedError,
  RunStore,
  EVENTS_INDEX_FILENAME,
  assertCanonicalRunId,
  defaultRunsRoot,
  isRunResourceTerminal,
  isTerminalState,
} from "./store.js";
export type {
  EventReplayCursorErrorReason,
  RunListSnapshotPage,
  RunPaths,
} from "./store.js";
export {
  GLOBAL_EVENT_CURSOR_MAX_LENGTH,
  GLOBAL_EVENT_CURSOR_ORDINAL_WIDTH,
  calyxStreamProjectionGapEventSchema,
  isAllocatedGlobalEventCursor,
  isCalyxControlEvent,
  isCalyxDeliveredStreamEvent,
  isCalyxMonitorEvent,
  isCalyxRunEvent,
  isCalyxStreamProjectionGapEvent,
  isCalyxStreamEvent,
  isGlobalEventCursor,
  isLegacyGlobalEventCursor,
  isRunServiceEvent,
  isRunTerminalEvent,
  toCalyxStreamProjectionGapEvent,
} from "./types.js";
export {
  createDirectSupervisorAdapter,
  createLaunchdSupervisorAdapter,
  createSupervisorAdapter,
  createSystemdSupervisorAdapter,
} from "./supervisors/index.js";
export type {
  DirectSupervisorDependencies,
  SupervisorAdapterDependencies,
  SystemdSupervisorDependencies,
} from "./supervisors/index.js";

export type {
  DaemonActivityResolver,
  DaemonDescriptor,
  DaemonEvent,
  DaemonHandoffReceipt,
  DaemonPlanActiveRun,
  DaemonPlanIssueSummary,
  DaemonPlanResult,
  DaemonPlanVerdict,
  DaemonPlanWarning,
  DaemonPlanWarningSeverity,
  DaemonRecord,
  DaemonReconciliationFlag,
  DaemonStartResult,
  DaemonStateSnapshot,
  DaemonTickOptions,
  DaemonTickResult,
  CalyxControlEvent,
  CalyxControlEventType,
  CalyxRunEvent,
  CalyxUpgradePhase,
  CalyxMonitorEvent,
  CalyxMonitorEventType,
  ExecutionKernelId,
  ExecutionReceipt,
  BoundHostProcessReceipt,
  HostProcessExecutionBinding,
  HostProcessIntent,
  HostProcessHealthConfig,
  HostProcessHealthSource,
  HostProcessHealthSourceKind,
  HostProcessReceipt,
  LegacyHostProcessReceipt,
  InteractiveSessionBackend,
  InteractiveSessionEvent,
  InteractiveSessionEventRole,
  InteractiveSessionInspectResult,
  InteractiveSessionListEntry,
  InteractiveSessionSummary,
  IssueDispatchStatus,
  IssueRuntimeRecord,
  IntegrationResult,
  IntegrationStatus,
  CalyxDeliveredStreamEvent,
  CalyxStreamEvent,
  CalyxStreamEventFilter,
  CalyxStreamProjectionGapEvent,
  CalyxStreamEventType,
  RecordedRunEvent,
  ReconcileResult,
  RecoveryStatus,
  ResolvedHostProcessHealthConfig,
  ResolvedHostProcessHealthSource,
  ResolutionStep,
  ResolvedExecutionSpec,
  ResolvedHostProcessSpec,
  RunActivityEntry,
  RunHealthObservation,
  RunHealthSnapshot,
  RunArtifactObservation,
  RunGpuDeviceObservation,
  RunGpuResourceObservation,
  RunHostResourceObservation,
  RunLogEntry,
  RunLogEntryKind,
  RunLogEntrySource,
  RunLogResult,
  RunLogSourceSummary,
  RunLogStream,
  RunLogTimestampSource,
  RunGpuProcessAttributionObservation,
  RunObservationResult,
  RunObservationStatus,
  RunObservedGpuProcess,
  RunObservedProcess,
  RunProcessObservation,
  RunProcessObservationStatus,
  RunProcessTreeAttributionObservation,
  RunProcessTreeAttributionStatus,
  RunResourceAttributionObservation,
  RunResourceAttributionStatus,
  RunRestartReadoptAssessment,
  RunRestartReadoptReason,
  ResolvedRunSpec,
  RunIntent,
  RunLaunchResult,
  RunListEntry,
  RunNextTurnInput,
  RunRecord,
  RunServiceEvent,
  RunSubscriber,
  RunSubscriberContext,
  TemplateResolution,
  TrackerClaimRequest,
  TrackerClaimResult,
  TrackerClient,
  TrackerClientFactory,
  TrackerHandoffRequest,
  TrackerHandoffResult,
  TrackerIssue,
  TrackerPollRequest,
  TrackerPollResult,
  TrackerRegistry,
  WorkflowAgentConfig,
  WorkflowConfig,
  WorkflowFile,
  WorkflowLoggingConfig,
  WorkflowPollingConfig,
  WorkflowTrackerConfig,
  WorkflowWorkspaceConfig,
} from "./types.js";

export { HOST_PROCESS_RECEIPT_SCHEMA_VERSION } from "./types.js";
