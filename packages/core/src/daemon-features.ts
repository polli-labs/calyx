import { CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH } from "./daemon-health";

export const CALYX_DAEMON_FEATURES = {
  healthV1: "daemon.health/v1",
  agentRunnerV1: "run.agent_runner/v1",
  defaultPathInjectionV1: "run.default_path_injection/v1",
  detachedWorkerDiagnosticsV1: "run.detached_worker_diagnostics/v1",
  detachedWorkerIsolationV1: "run.detached_worker_isolation/v1",
  vaultExecplanRefV1: "run.vault_execplan_ref/v1",
  repoRegistryV1: "run.repo_registry/v1",
  promptRefV1: "run.prompt_ref/v1",
  systemPromptV1: "run.system_prompt/v1",
  backendModelV1: "run.backend_model/v1",
  backendReasoningEffortV1: "run.backend_reasoning_effort/v1",
  backendExecutionLimitsV1: "run.backend_execution_limits/v1",
  agentRunnerActivityV1: "run.agent_runner_activity/v1",
  runObservationV1: "run.observation/v1",
  runResourceAttributionV1: "run.resource_attribution/v1",
  artifactRootsV1: "run.artifact_roots/v1",
  outputCaptureV1: "run.output_capture/v1",
  runHandbackV1: "run.handback/v1",
  otelMetricsV1: "daemon.otel_metrics/v1",
  interactiveActivitySurfaceV1: "interactive.activity_surface/v1",
  interactiveActivityDetailV1: "interactive.activity_detail/v1",
  activityMessagesV1: "activity.messages/v1",
  activityTurnsV1: "activity.turns/v1",
  activityTextV1: "activity.text/v1",
  activityAttachmentsV1: "activity.attachments/v1",
  activityAttachmentBytesV1: "activity.attachment_bytes/v1",
  monitorWakeV1: "monitor.wake/v1",
  monitorRemoteV1: "monitor.remote/v1",
  monitorClaimV1: "monitor.claim/v1",
  messageCorrespondenceV1: "message.correspondence/v1",
  sessionWakeV1: "session.wake/v1",
  leaseV1: "lease/v1",
  runReadoptOnBootV1: "run.readopt_on_boot/v1",
  runReconcilePreservesNoncanonicalV1: "run.reconcile_preserves_noncanonical/v1",
} as const;

export type CalyxDaemonFeature =
  typeof CALYX_DAEMON_FEATURES[keyof typeof CALYX_DAEMON_FEATURES];

export const CALYX_DAEMON_FEATURE_LIST = Object.values(CALYX_DAEMON_FEATURES) as CalyxDaemonFeature[];

export const FEATURE_DESCRIPTIONS: Record<CalyxDaemonFeature, string> = {
  [CALYX_DAEMON_FEATURES.healthV1]: "daemon.health/v1 (POL-1118)",
  [CALYX_DAEMON_FEATURES.agentRunnerV1]: "run.agent_runner/v1 (agent_runner kernel baseline)",
  [CALYX_DAEMON_FEATURES.defaultPathInjectionV1]: "run.default_path_injection/v1 (POL-1100)",
  [CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1]: "run.detached_worker_diagnostics/v1 (POL-1117)",
  [CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1]: "run.detached_worker_isolation/v1 (POL-1900)",
  [CALYX_DAEMON_FEATURES.vaultExecplanRefV1]: "run.vault_execplan_ref/v1 (POL-1102)",
  [CALYX_DAEMON_FEATURES.repoRegistryV1]: "run.repo_registry/v1 (POL-1101A)",
  [CALYX_DAEMON_FEATURES.promptRefV1]: "run.prompt_ref/v1 (POL-1113)",
  [CALYX_DAEMON_FEATURES.systemPromptV1]: "run.system_prompt/v1 (POL-1140)",
  [CALYX_DAEMON_FEATURES.backendModelV1]: "run.backend_model/v1 (POL-1494)",
  [CALYX_DAEMON_FEATURES.backendReasoningEffortV1]: "run.backend_reasoning_effort/v1 (POL-1319)",
  [CALYX_DAEMON_FEATURES.backendExecutionLimitsV1]: "run.backend_execution_limits/v1 (POL-1982)",
  [CALYX_DAEMON_FEATURES.agentRunnerActivityV1]: "run.agent_runner_activity/v1 (POL-1388)",
  [CALYX_DAEMON_FEATURES.runObservationV1]: "run.observation/v1 (POL-1502)",
  [CALYX_DAEMON_FEATURES.runResourceAttributionV1]: "run.resource_attribution/v1 (POL-1503)",
  [CALYX_DAEMON_FEATURES.artifactRootsV1]: "run.artifact_roots/v1 (POL-1502)",
  [CALYX_DAEMON_FEATURES.outputCaptureV1]: "run.output_capture/v1 (POL-2057)",
  [CALYX_DAEMON_FEATURES.runHandbackV1]: "run.handback/v1 (POL-1805)",
  [CALYX_DAEMON_FEATURES.otelMetricsV1]: "daemon.otel_metrics/v1 (POL-1138)",
  [CALYX_DAEMON_FEATURES.interactiveActivitySurfaceV1]: "interactive.activity_surface/v1 (POL-1147)",
  [CALYX_DAEMON_FEATURES.interactiveActivityDetailV1]: "interactive.activity_detail/v1 (POL-1211)",
  [CALYX_DAEMON_FEATURES.activityMessagesV1]: "activity.messages/v1 (POL-1352)",
  [CALYX_DAEMON_FEATURES.activityTurnsV1]: "activity.turns/v1 (POL-1354)",
  [CALYX_DAEMON_FEATURES.activityTextV1]: "activity.text/v1 (POL-1737)",
  [CALYX_DAEMON_FEATURES.activityAttachmentsV1]: "activity.attachments/v1 (POL-1737)",
  [CALYX_DAEMON_FEATURES.activityAttachmentBytesV1]: "activity.attachment_bytes/v1 (POL-1771)",
  [CALYX_DAEMON_FEATURES.monitorWakeV1]: "monitor.wake/v1 (POL-1732a)",
  [CALYX_DAEMON_FEATURES.monitorRemoteV1]: "monitor.remote/v1 (POL-1788)",
  [CALYX_DAEMON_FEATURES.monitorClaimV1]: "monitor.claim/v1 (POL-2005)",
  [CALYX_DAEMON_FEATURES.messageCorrespondenceV1]: "message.correspondence/v1 (POL-1789)",
  [CALYX_DAEMON_FEATURES.sessionWakeV1]: "session.wake/v1 (POL-2005)",
  [CALYX_DAEMON_FEATURES.leaseV1]: "lease/v1 (POL-1790)",
  [CALYX_DAEMON_FEATURES.runReadoptOnBootV1]: "run.readopt_on_boot/v1 (POL-1879/POL-1886)",
  [CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1]: "run.reconcile_preserves_noncanonical/v1 (POL-1980)",
};

export interface DaemonFeatureIntentShape {
  kernel?: string;
  prompt?: string;
  execplan_ref?: string;
  repo?: string;
  system_prompt?: string;
  append_system_prompt?: string;
  artifact_roots?: string[];
  output_capture?: unknown;
  handback?: unknown;
  backend_options?: {
    model?: unknown;
    reasoning_effort?: unknown;
    max_threads?: unknown;
    max_turns?: unknown;
    agent_activity?: unknown;
  };
  required_features?: CalyxDaemonFeature[];
}

export interface DaemonCompatibilityHealth {
  build: {
    git_head: string;
    built_at: string;
  };
  protocol_epoch: number;
  supports_features?: readonly string[];
}

export interface DaemonCompatibilityRefusal {
  reason: "protocol_epoch_mismatch" | "missing_features";
  message: string;
  missing_features?: CalyxDaemonFeature[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasReasoningEffortOption(intent: DaemonFeatureIntentShape): boolean {
  return isNonEmptyString(intent.backend_options?.reasoning_effort);
}

function hasBackendModelOption(intent: DaemonFeatureIntentShape): boolean {
  return isNonEmptyString(intent.backend_options?.model);
}

function hasBackendExecutionLimit(intent: DaemonFeatureIntentShape): boolean {
  return intent.backend_options?.max_threads !== undefined
    || intent.backend_options?.max_turns !== undefined;
}

function formatShortBuildSha(gitHead: string): string {
  return /^[0-9a-f]{7,40}$/i.test(gitHead) ? gitHead.slice(0, 7) : gitHead;
}

function formatRelativeBuiltAt(builtAt: string, now: Date): string {
  const builtAtMs = Date.parse(builtAt);
  if (!Number.isFinite(builtAtMs)) {
    return builtAt;
  }
  const deltaMs = now.getTime() - builtAtMs;
  const deltaSeconds = Math.round(deltaMs / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) {
    return `${absSeconds} second${absSeconds === 1 ? "" : "s"} ${deltaSeconds >= 0 ? "ago" : "from now"}`;
  }

  const units: Array<{ unit: string; seconds: number }> = [
    { unit: "minute", seconds: 60 },
    { unit: "hour", seconds: 60 * 60 },
    { unit: "day", seconds: 60 * 60 * 24 },
    { unit: "week", seconds: 60 * 60 * 24 * 7 },
  ];
  let chosen = units[0]!;
  for (const candidate of units) {
    if (absSeconds >= candidate.seconds) {
      chosen = candidate;
    }
  }
  const value = Math.round(absSeconds / chosen.seconds);
  return `${value} ${chosen.unit}${value === 1 ? "" : "s"} ${deltaSeconds >= 0 ? "ago" : "from now"}`;
}

function formatDaemonBuildLine(host: string, health: DaemonCompatibilityHealth, now: Date): string {
  return `Daemon on "${host}" reports build ${formatShortBuildSha(health.build.git_head)} (built ${formatRelativeBuiltAt(health.build.built_at, now)}).`;
}

export function requiredFeaturesForIntent(intent: DaemonFeatureIntentShape): CalyxDaemonFeature[] {
  const required = new Set<CalyxDaemonFeature>(intent.required_features ?? []);
  required.add(CALYX_DAEMON_FEATURES.healthV1);

  const kernel = isNonEmptyString(intent.kernel) ? intent.kernel : undefined;
  if (kernel === undefined || kernel === "agent_runner") {
    required.add(CALYX_DAEMON_FEATURES.agentRunnerV1);
    required.add(CALYX_DAEMON_FEATURES.defaultPathInjectionV1);
    required.add(CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1);
    required.add(CALYX_DAEMON_FEATURES.agentRunnerActivityV1);
  }

  if (isNonEmptyString(intent.execplan_ref) && intent.execplan_ref.startsWith("vault://")) {
    required.add(CALYX_DAEMON_FEATURES.vaultExecplanRefV1);
  }
  if (isNonEmptyString(intent.repo)) {
    required.add(CALYX_DAEMON_FEATURES.repoRegistryV1);
  }
  const promptRef = (intent as DaemonFeatureIntentShape & { prompt_ref?: unknown }).prompt_ref;
  if (isNonEmptyString(promptRef)) {
    required.add(CALYX_DAEMON_FEATURES.promptRefV1);
  }
  if (isNonEmptyString(intent.system_prompt) || isNonEmptyString(intent.append_system_prompt)) {
    required.add(CALYX_DAEMON_FEATURES.systemPromptV1);
  }
  if (intent.artifact_roots?.some(isNonEmptyString)) {
    required.add(CALYX_DAEMON_FEATURES.artifactRootsV1);
  }
  if (intent.output_capture) {
    required.add(CALYX_DAEMON_FEATURES.outputCaptureV1);
  }
  if (intent.handback) {
    required.add(CALYX_DAEMON_FEATURES.runHandbackV1);
  }
  if (hasBackendModelOption(intent)) {
    required.add(CALYX_DAEMON_FEATURES.backendModelV1);
  }
  if (hasReasoningEffortOption(intent)) {
    required.add(CALYX_DAEMON_FEATURES.backendReasoningEffortV1);
  }
  if (hasBackendExecutionLimit(intent)) {
    required.add(CALYX_DAEMON_FEATURES.backendExecutionLimitsV1);
  }

  return CALYX_DAEMON_FEATURE_LIST.filter((feature) => required.has(feature));
}

export function getDaemonCompatibilityRefusal(
  host: string,
  health: DaemonCompatibilityHealth,
  requiredFeatures: readonly CalyxDaemonFeature[],
  options: {
    expectedProtocolEpoch?: number;
    now?: Date;
  } = {},
): DaemonCompatibilityRefusal | undefined {
  const now = options.now ?? new Date();
  const expectedProtocolEpoch = options.expectedProtocolEpoch ?? CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH;
  if (health.protocol_epoch !== expectedProtocolEpoch) {
    return {
      reason: "protocol_epoch_mismatch",
      message: [
        formatDaemonBuildLine(host, health, now),
        `This CLI expects protocol epoch ${expectedProtocolEpoch}, but that daemon reports ${health.protocol_epoch}.`,
        "The wire format is incompatible, so launch is refused before dispatch.",
        "",
        "Fix:",
        `  calyx self upgrade --host ${host}`,
        "",
        `Re-run the launch after the daemon reports protocol epoch ${expectedProtocolEpoch}.`,
      ].join("\n"),
    };
  }

  const supported = new Set(health.supports_features ?? []);
  const missingFeatures = requiredFeatures.filter((feature) => !supported.has(feature));
  if (missingFeatures.length === 0) {
    return undefined;
  }

  return {
    reason: "missing_features",
    missing_features: missingFeatures,
    message: [
      formatDaemonBuildLine(host, health, now),
      "This intent requires features not supported by that daemon:",
      ...missingFeatures.map((feature) => `  - ${FEATURE_DESCRIPTIONS[feature]}`),
      "",
      "Fix:",
      `  calyx self upgrade --host ${host}`,
      "",
      "Re-run the launch after the daemon reports the current feature set.",
    ].join("\n"),
  };
}
