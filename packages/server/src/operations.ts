import { z } from "zod";
import {
  API_ASSERTED_ACTOR_PATTERN_SOURCE,
  API_PROVENANCE_HOST_PATTERN_SOURCE,
  API_PROVENANCE_SUBJECT_PATTERN_SOURCE,
  API_REQUEST_ID_PATTERN_SOURCE,
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_KNOWN_VALUES,
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS,
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE,
  CALYX_ADMIN_RUN_LIST_MAX_ITEMS,
  CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS,
  CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX,
  CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX,
  CALYX_HTTP_SSE_CURSOR_MAX_CHARS,
  HTTP_OPERATION_DESCRIPTORS,
  isCanonicalApiTimestamp,
  normalizeCalyxAdminReconcileResultForConsumer,
  resolveHttpOperation,
  type CalyxAdminReconcileResult,
  type HttpOperationDescriptor,
} from "@polli-labs/calyx-core";
import {
  ACTIVITY_ATTACHMENT_MAX_BYTES,
  HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
  RUN_ID_PATTERN_SOURCE,
  calyxStreamProjectionGapEventSchema,
} from "@polli-labs/calyx-run-service";
import {
  ALL_STATES,
  TERMINAL_STATES,
  runReceiptSchema as canonicalRunReceiptSchema,
  runOutputCaptureSchema,
  runSpecObjectSchema as canonicalRunSpecSchema,
} from "@polli-labs/calyx-runner";
import {
  adminHealthSchema,
  adminReconcileConsumerResultSchema,
  adminReconcileResultSchema,
  activityMarkCreateRequestSchema,
  activityMarkListQuerySchema,
  activityMarkListSchema,
  activityMarkRevocationSchema,
  activityMarkSchema,
  activityAttachmentObservationSchema,
  CONSUMER_BACKEND_MAX_CHARS,
  CONSUMER_CURSOR_MAX_CHARS,
  CONSUMER_HOST_MAX_CHARS,
  CONSUMER_MESSAGE_REFERENCE_MAX_CHARS,
  CONSUMER_MESSAGE_SUBJECT_MAX_CHARS,
  CONSUMER_PORTABLE_ID_MAX_CHARS,
  CONSUMER_ROUTE_LOCATOR_MAX_CHARS,
  CONSUMER_TIMESTAMP_MAX_CHARS,
  activityMessagesObservationSchema,
  activityTextObservationSchema,
  activityTurnsObservationSchema,
  leaseObservationSchema,
  messageObservationSchema,
  monitorObservationSchema,
  msgSendRequestSchema,
  runObservationSchema,
  runObservationStreamEventSchema,
  wakeObservationSchema,
} from "./consumer-dtos.js";

export interface ServerOperationSchemas {
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
}

const CLOSED_RESPONSE_ENUM_PATHS = new Set<string>([
  "calyx.admin-reconcile-result/v1#/status",
  "calyx.activity-observation-list/v1#/activities/*/attention_state",
  "calyx.run-observation-list/v1#/runs/*/attention_state",
  "calyx.run-observation/v1#/attention_state",
  "calyx.run-observation-event/v1#/gap/source_event_type",
  "calyx.stream-event/v1#/gap/source_event_type",
]);

export function isClosedResponseEnumPath(
  schemaId: string,
  path: readonly (string | number)[],
): boolean {
  const normalized = path.map((segment) => typeof segment === "number" ? "*" : segment);
  return CLOSED_RESPONSE_ENUM_PATHS.has(`${schemaId}#/${normalized.join("/")}`);
}

const nonEmptyString = z.string().min(1);
const consumerPortableIdSchema = z.string().min(1).max(CONSUMER_PORTABLE_ID_MAX_CHARS);
const consumerHostSchema = z.string().min(1).max(CONSUMER_HOST_MAX_CHARS);
const consumerTimestampSchema = z.string().max(CONSUMER_TIMESTAMP_MAX_CHARS).datetime();
const consumerRouteLocatorSchema = z.string().min(1).max(CONSUMER_ROUTE_LOCATOR_MAX_CHARS);
const consumerMessageSubjectSchema = z.string().min(1).max(CONSUMER_MESSAGE_SUBJECT_MAX_CHARS);
const consumerMessageReferenceSchema = z.string().min(1).max(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS);
const activityAttachmentSourceTierSchema = z.string()
  .min(1)
  .max(CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS)
  .regex(new RegExp(CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE, "u"))
  .describe(`calyx-open-enum:${JSON.stringify(CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_KNOWN_VALUES)}`);
const runIdString = z.string().regex(new RegExp(RUN_ID_PATTERN_SOURCE));
const requestNonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "must contain a non-whitespace character",
});
const boundedRequestNonEmptyString = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => value.trim().length > 0,
  { message: "must contain a non-whitespace character" },
);
const requestIdempotencyKey = z.string().min(1).max(256).regex(
  /^\S+$/u,
  "idempotency keys must not contain whitespace",
);
const requestMessageAddress = boundedRequestNonEmptyString(512).refine((value) => !/\s/.test(value), {
  message: "message addresses must not contain whitespace",
});
const positiveIntegerString = z.string().regex(/^[1-9]\d*$/, "must be a positive integer");
const adminRunListLimitString = z.string().regex(
  /^(?:[1-9]|[1-9]\d|100)$/u,
  `must be an integer from 1 through ${CALYX_ADMIN_RUN_LIST_MAX_ITEMS}`,
);
const nonNegativeIntegerString = z.string().regex(/^\d+$/, "must be a non-negative integer");
const booleanQueryString = z.enum(["1", "0", "true", "false", "yes", "no"]);
const apiProvenanceSchema = z.object({
  schema_version: z.literal("calyx.provenance/v1"),
  request_id: z.string().regex(new RegExp(API_REQUEST_ID_PATTERN_SOURCE)),
  subject: z.string().regex(new RegExp(API_PROVENANCE_SUBJECT_PATTERN_SOURCE)),
  asserted_actor: z.string().max(256).regex(new RegExp(API_ASSERTED_ACTOR_PATTERN_SOURCE)).optional(),
  host: z.string().regex(new RegExp(API_PROVENANCE_HOST_PATTERN_SOURCE)),
  via: z.literal("http"),
  at: z.string().refine(isCanonicalApiTimestamp, "must be a canonical UTC ISO timestamp"),
}).strip();

function openStringEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values).describe(`calyx-open-enum:${JSON.stringify(values)}`);
}

const emptySchema = z.object({}).strip();
const emptyQuerySchema = z.object({}).strip();
export const EXPLICIT_OPEN_JSON_DICTIONARY_NAMES = [
  "activity-attachments.rollup",
  "activity-detail.event",
  "activity-events.event",
  "activity-events.selector",
  "activity-message.activity-ref",
  "activity-message.classification",
  "activity-message.text-cursor",
  "activity-messages.attachment-rollup",
  "activity-messages.recall-freshness",
  "activity-messages.selector",
  "activity-result.activity-resolution",
  "activity-text.cursor",
  "activity-turns.recall-freshness",
  "activity-turns.selector",
  "activity-turns.turn",
  "execution-receipt.metadata",
  "execution-receipt.run-spec.backend-options",
  "execution-receipt.run-spec.metadata",
  "lease-steal.provenance",
  "lease.metadata",
  "lease.steal-provenance",
  "lifecycle-event.infra-error-classification",
  "lifecycle-event.payload",
  "message.payload",
  "monitor-delivery-state.delivery",
  "monitor-delivery-state.failure",
  "monitor-delivery.claude-channel",
  "monitor-delivery.claude-reinvoke",
  "monitor-delivery.codex-app-server-steer",
  "monitor-delivery.codex-automation",
  "monitor-delivery.digest",
  "monitor-delivery.linear-comment",
  "monitor-delivery.ntfy",
  "monitor-delivery.vault-receipt",
  "predicate-evaluation.cursor",
  "predicate-evaluation.evidence",
  "predicate.baseline",
  "run-intent.backend-options",
  "run-intent.handback",
  "run-intent.metadata",
  "run-intent.notifications",
  "run-observation.artifact",
  "run-observation.artifact-root",
  "run-observation.host-resources",
  "run-observation.resource-attribution",
  "run-output-capture.schema",
  "run-record.infra-error-classification",
  "run-record.integration-details",
  "run-record.kernel-receipt",
  "run-record.spec",
  "run-service-event.payload",
  "self-upgrade-receipt.active-run",
  "self-upgrade-receipt.build",
  "self-upgrade-receipt.daemon-restart",
  "self-upgrade-receipt.explicit-target-adoption",
  "self-upgrade-receipt.install",
  "self-upgrade-receipt.rollback",
  "self-upgrade-receipt.target-evidence",
  "stream-event.control",
  "stream-event.enrichment",
  "stream-event.evaluation",
  "stream-event.monitor",
  "stream-event.origin",
  "stream-event.pointers",
  "stream-event.predicate",
  "stream-event.run",
] as const;
type ExplicitOpenJsonDictionaryName = (typeof EXPLICIT_OPEN_JSON_DICTIONARY_NAMES)[number];
const openJsonDictionary = (name: ExplicitOpenJsonDictionaryName) => (
  z.record(z.unknown()).describe(`calyx-open-dictionary:${name}`)
);
const apiRunOutputCaptureSchema = runOutputCaptureSchema.extend({
  schema: openJsonDictionary("run-output-capture.schema"),
}).strict();
const nullableString = z.string().nullable();
const isoTimestamp = z.string().datetime();
const selfUpgradeGitHeadSchema = z.string().regex(/^[0-9a-f]{40}$/iu);
const selfUpgradeSha256Schema = z.string().regex(/^[0-9a-f]{64}$/iu);
const selfUpgradeMigrationIdSchema = z.string().regex(/^\d{4}$/u);
const selfUpgradeNonNegativeIntegerSchema = z.number().int().nonnegative();
const selfUpgradeFilesystemIdentitySchema = z.object({
  path: nonEmptyString,
  real_path: nonEmptyString,
  kind: z.enum(["file", "directory"]),
  device: selfUpgradeNonNegativeIntegerSchema,
  inode: selfUpgradeNonNegativeIntegerSchema,
}).strict();
const selfUpgradeSupervisorEffectiveStateSchema = z.object({
  schema_version: z.literal("self-upgrade-supervisor-effective-state/v1"),
  supervisor_kind: z.enum(["systemd", "launchd"]),
  service_identity: nonEmptyString,
  loaded: z.boolean(),
  running: z.boolean(),
  effective_config_sha256: selfUpgradeSha256Schema,
  exit_timeout_seconds: z.number().nonnegative().optional(),
}).strict();
const selfUpgradeTargetAcceptanceSchema = z.object({
  schema_version: z.literal("self-upgrade-target-acceptance/v1"),
  status: z.literal("accepted"),
  operation_id: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u),
  executor_realpath: nonEmptyString,
  node_realpath: nonEmptyString,
  node_version: nonEmptyString,
  target_git_head: selfUpgradeGitHeadSchema,
  target_build_info_sha256: selfUpgradeSha256Schema,
  target_artifact_manifest_sha256: selfUpgradeSha256Schema,
  target_artifact_manifest_packages: z.array(nonEmptyString).min(1).max(1_000),
  handoff_interface: z.literal("self-upgrade-target-handoff/v1"),
  planning_interface: z.literal("self-upgrade-target-planning/v1"),
  startup_contract_interface: z.literal("calyx-startup-contract/v1"),
  accepted_at: isoTimestamp,
}).strict();
const selfUpgradeTargetStateReadinessSchema = z.object({
  schema_version: z.literal("self-upgrade-target-state-readiness/v1"),
  status: z.literal("ready"),
  target_git_head: selfUpgradeGitHeadSchema,
  driver: nonEmptyString,
  current: selfUpgradeMigrationIdSchema.nullable(),
  target: selfUpgradeMigrationIdSchema.nullable(),
  ledger_exists: z.boolean(),
  applied_migrations: z.array(selfUpgradeMigrationIdSchema).max(10_000),
  pending_migrations: z.array(selfUpgradeMigrationIdSchema).max(10_000),
  pending_migration_growth_bounds: z.array(z.object({
    migration_id: selfUpgradeMigrationIdSchema,
    database_size_multiplier: selfUpgradeNonNegativeIntegerSchema.max(64),
    fixed_bytes: selfUpgradeNonNegativeIntegerSchema,
  }).strict()).max(10_000),
}).strict();
const selfUpgradeTargetStateMigratedSchema = z.object({
  schema_version: z.literal("self-upgrade-target-state-migrated/v1"),
  status: z.literal("migrated"),
  target_git_head: selfUpgradeGitHeadSchema,
  driver: nonEmptyString,
  current: selfUpgradeMigrationIdSchema,
  target: selfUpgradeMigrationIdSchema,
  applied_migrations: z.array(selfUpgradeMigrationIdSchema).max(10_000),
  migration_growth_bound_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
  observed_state_growth_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
}).strict();
const selfUpgradeTargetStateAppliedSchema = z.object({
  schema_version: z.literal("self-upgrade-target-state-applied/v1"),
  status: z.literal("applied"),
  target_git_head: selfUpgradeGitHeadSchema,
  driver: nonEmptyString,
  current: selfUpgradeMigrationIdSchema,
  target: selfUpgradeMigrationIdSchema,
  applied_migrations: z.array(selfUpgradeMigrationIdSchema).max(10_000),
  pending_migrations: z.array(selfUpgradeMigrationIdSchema).length(0),
}).strict();
const selfUpgradeStateSnapshotSchema = z.object({
  schema_version: z.literal("self-upgrade-state-snapshot/v1"),
  status: z.literal("snapshotted"),
  database_path: nonEmptyString,
  backup_path: nonEmptyString,
  database_sha256: selfUpgradeSha256Schema,
  size_bytes: selfUpgradeNonNegativeIntegerSchema,
  wal_checkpoint: z.literal("truncate"),
  quick_check: z.literal("ok"),
  restore_strategy: z.literal("precreated-same-filesystem-hardlink-rename").optional(),
  database_parent_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  backup_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  backup_parent_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  rollback_candidate_path: nonEmptyString.optional(),
  rollback_candidate_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  rollback_reserve_path: nonEmptyString.optional(),
  rollback_reserve_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  rollback_reserve_allocated_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
  capacity_preflight: z.object({
    available_bytes: selfUpgradeNonNegativeIntegerSchema,
    required_bytes: selfUpgradeNonNegativeIntegerSchema,
    same_device: z.boolean(),
    snapshot_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
    migration_growth_reserve_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
    target_declared_migration_growth_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
    rollback_allocation_bytes: selfUpgradeNonNegativeIntegerSchema.optional(),
  }).strict().optional(),
}).strict();
const selfUpgradeSupervisorReadinessSchema = z.object({
  schema_version: z.literal("self-upgrade-supervisor-readiness/v1"),
  status: z.enum(["unchanged", "ready"]),
  target_git_head: selfUpgradeGitHeadSchema,
  source: z.enum(["live-supervisor", "agents-infra"]),
  source_sha256: selfUpgradeSha256Schema.optional(),
  supervisor_kinds: z.array(z.enum(["systemd", "launchd"])).min(1).max(2),
  live_service_path: nonEmptyString.optional(),
  staged_service_path: nonEmptyString.optional(),
  previous_service_sha256: selfUpgradeSha256Schema.optional(),
  previous_service_present: z.boolean().optional(),
  previous_service_backup_path: nonEmptyString.optional(),
  previous_service_mode: selfUpgradeNonNegativeIntegerSchema.optional(),
  previous_service_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  previous_service_parent_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  previous_service_backup_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  previous_service_backup_parent_identity: selfUpgradeFilesystemIdentitySchema.optional(),
  previous_loaded: z.boolean().optional(),
  previous_running: z.boolean().optional(),
  previous_effective_state: selfUpgradeSupervisorEffectiveStateSchema.optional(),
  target_effective_config_sha256: selfUpgradeSha256Schema.optional(),
  restored_effective_config_sha256: selfUpgradeSha256Schema.optional(),
  restored_exit_timeout_seconds: z.number().nonnegative().optional(),
}).strict();
const selfUpgradeSupervisorInstallSchema = z.object({
  schema_version: z.literal("self-upgrade-supervisor-install/v1"),
  status: z.enum(["unchanged", "installed"]),
  installed_sha256: selfUpgradeSha256Schema.optional(),
  live_service_path: nonEmptyString.optional(),
  reload: z.enum(["none", "systemd-daemon-reload", "launchd-on-restart"]).optional(),
  effective_state: selfUpgradeSupervisorEffectiveStateSchema.optional(),
}).strict();
const selfUpgradeMaintenanceDispositionSchema = z.object({
  status: z.enum(["released", "engaged"]),
  reason: nonEmptyString,
}).strict();
const selfUpgradeArtifactCleanupSchema = z.object({
  state_backup: z.enum(["cleaned", "retained", "not_created"]),
  supervisor_backup: z.enum(["cleaned", "retained", "not_created"]),
  retained_paths: z.array(nonEmptyString).max(10_000),
  errors: z.array(z.string()).max(10_000),
}).strict();

export type SelfUpgradeFilesystemIdentity = z.infer<typeof selfUpgradeFilesystemIdentitySchema>;
export type SelfUpgradeSupervisorEffectiveStateReceipt = z.infer<typeof selfUpgradeSupervisorEffectiveStateSchema>;
export type SelfUpgradeTargetAcceptanceReceipt = z.infer<typeof selfUpgradeTargetAcceptanceSchema>;
export type SelfUpgradeTargetStateReadinessReceipt = z.infer<typeof selfUpgradeTargetStateReadinessSchema>;
export type SelfUpgradeTargetStateMigratedReceipt = z.infer<typeof selfUpgradeTargetStateMigratedSchema>;
export type SelfUpgradeTargetStateAppliedReceipt = z.infer<typeof selfUpgradeTargetStateAppliedSchema>;
export type SelfUpgradeStateSnapshotReceipt = z.infer<typeof selfUpgradeStateSnapshotSchema>;
export type SelfUpgradeSupervisorReadinessReceipt = z.infer<typeof selfUpgradeSupervisorReadinessSchema>;
export type SelfUpgradeSupervisorInstallReceipt = z.infer<typeof selfUpgradeSupervisorInstallSchema>;
export type SelfUpgradeMaintenanceDispositionReceipt = z.infer<typeof selfUpgradeMaintenanceDispositionSchema>;
export type SelfUpgradeArtifactCleanupReceipt = z.infer<typeof selfUpgradeArtifactCleanupSchema>;

const selfUpgradeReceiptSchema = z.object({
  schema_version: z.literal("self-upgrade-receipt/v1"),
  operation_id: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u).optional(),
  fleet_operation_id: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u).optional(),
  host: nonEmptyString,
  target_ref: nonEmptyString,
  target_evidence: openJsonDictionary("self-upgrade-receipt.target-evidence"),
  status: z.enum(["succeeded", "failed"]),
  started_at: isoTimestamp,
  completed_at: isoTimestamp,
  repo_root: nonEmptyString,
  before_head: selfUpgradeGitHeadSchema,
  after_head: selfUpgradeGitHeadSchema.optional(),
  commit_list: z.array(z.string()).max(10_000),
  before_builds: z.array(openJsonDictionary("self-upgrade-receipt.build")).max(1_000),
  after_builds: z.array(openJsonDictionary("self-upgrade-receipt.build")).max(1_000),
  active_run_classification: z.array(openJsonDictionary("self-upgrade-receipt.active-run")).max(10_000),
  drain_mode: z.enum(["continuous", "drain"]).describe(
    "\"continuous\" when at least one classifier-proven restart-safe run was preserved and re-adopted across the restart; unproven runs may still have drained for the full deadline first, so this does not mean zero drain wait occurred. \"drain\" when no run was preserved: every active run completed, drained, or was explicitly interrupted before restart. Use readopted_run_ids for the exact preserved set.",
  ),
  readopted_run_ids: z.array(nonEmptyString).max(10_000),
  drain_duration_ms: z.number().int().nonnegative().describe(
    "Total monotonic drain-phase cost in milliseconds, from phase entry through active-run classification, preservation attestation, and any drain wait; this is not only wait time. Restart, health verification, install pruning, and receipt publication are excluded. On a failure receipt, 0 can also mean the drain phase was never entered; drain_mode does not disambiguate that case.",
  ),
  daemons_restarted: z.array(openJsonDictionary("self-upgrade-receipt.daemon-restart")).max(1_000),
  explicit_target_adoption: openJsonDictionary("self-upgrade-receipt.explicit-target-adoption").optional(),
  install: openJsonDictionary("self-upgrade-receipt.install").optional(),
  target_acceptance: selfUpgradeTargetAcceptanceSchema.optional(),
  target_state_readiness: selfUpgradeTargetStateReadinessSchema.optional(),
  target_state_migrated: selfUpgradeTargetStateMigratedSchema.optional(),
  target_state_applied: selfUpgradeTargetStateAppliedSchema.optional(),
  state_snapshot: selfUpgradeStateSnapshotSchema.optional(),
  supervisor_readiness: selfUpgradeSupervisorReadinessSchema.optional(),
  supervisor_install: selfUpgradeSupervisorInstallSchema.optional(),
  rollback: openJsonDictionary("self-upgrade-receipt.rollback").optional(),
  maintenance_disposition: selfUpgradeMaintenanceDispositionSchema.optional(),
  artifact_cleanup: selfUpgradeArtifactCleanupSchema.optional(),
  warnings: z.array(z.string()).max(10_000),
  durability_issues: z.array(z.object({
    scope: z.literal("final_receipt"),
    code: z.literal("receipt_persist_failed"),
    observed_at: isoTimestamp,
    message: nonEmptyString,
  }).strict()).max(256).optional(),
  error: z.string().optional(),
}).strict();

function boundedList<T extends z.ZodTypeAny>(
  schemaVersion: string,
  field: string,
  item: T,
  options: {
    count?: boolean;
    shape?: z.ZodRawShape;
  } = {},
): z.ZodTypeAny {
  const includesCount = options.count ?? true;
  const commonShape = {
    schema_version: z.literal(schemaVersion),
    ...(options.shape ?? {}),
    ...(includesCount ? { count: z.number().int().nonnegative() } : {}),
    [field]: z.array(item).max(100),
  };
  return z.discriminatedUnion("truncated", [
    z.object({
      ...commonShape,
      truncated: z.literal(false),
    }).strict(),
    z.object({
      ...commonShape,
      truncated: z.literal(true),
      next_cursor: z.string().min(1).max(CONSUMER_CURSOR_MAX_CHARS),
    }).strict(),
  ]).superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    const rows = record[field];
    if (includesCount && Array.isArray(rows) && record["count"] !== rows.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: `count must equal ${field}.length`,
      });
    }
  }).describe(`calyx-bounded-page:${field}:${includesCount ? "count" : "no-count"}`);
}

const paginationQuerySchema = z.object({
  limit: positiveIntegerString.optional(),
  cursor: boundedRequestNonEmptyString(CONSUMER_CURSOR_MAX_CHARS).optional(),
}).strip();

const runListQuerySchema = paginationQuerySchema.extend({
  host: nonEmptyString.optional(),
  agent_kind: z.enum(["codex", "claude"]).optional(),
  since_ms: nonNegativeIntegerString.optional(),
}).strip();

const adminRunListQuerySchema = z.object({
  limit: adminRunListLimitString.optional(),
  cursor: boundedRequestNonEmptyString(4096).optional(),
  include_interactive: booleanQueryString.optional(),
  host: z.string().min(1).max(255).regex(new RegExp(API_PROVENANCE_HOST_PATTERN_SOURCE)).optional(),
  agent_kind: z.enum(["codex", "claude"]).optional(),
  since_ms: nonNegativeIntegerString.optional(),
}).strip();

const eventQuerySchema = z.object({
  after: nonEmptyString.max(512).optional(),
  run_id: nonEmptyString.optional(),
  event_type: nonEmptyString.optional(),
}).strip();
const consumerEventQuerySchema = z.object({
  after: nonEmptyString.max(512).optional(),
  run_id: nonEmptyString.optional(),
  event_type: nonEmptyString.optional(),
}).strip();

const activityListQuerySchema = paginationQuerySchema.extend({
  host: nonEmptyString.optional(),
  agent_kind: z.enum(["codex", "claude"]).optional(),
  since_ms: nonNegativeIntegerString.optional(),
}).strip();

const activityMessagesQuerySchema = z.object({
  role: nonEmptyString.optional(),
  grep: nonEmptyString.optional(),
  summary_only: booleanQueryString.optional(),
  max_text_chars: nonNegativeIntegerString.optional(),
  limit: positiveIntegerString.optional(),
  cursor: boundedRequestNonEmptyString(CONSUMER_CURSOR_MAX_CHARS).optional(),
}).strip();

const activityTurnsQuerySchema = z.object({
  role: nonEmptyString.optional(),
  summary_only: booleanQueryString.optional(),
  max_text_chars: nonNegativeIntegerString.optional(),
  limit: positiveIntegerString.optional(),
  cursor: boundedRequestNonEmptyString(CONSUMER_CURSOR_MAX_CHARS).optional(),
}).strip();

const activityAttachmentsQuerySchema = z.object({
  turn: nonNegativeIntegerString.optional(),
  message: nonEmptyString.optional(),
  limit: positiveIntegerString.optional(),
  cursor: boundedRequestNonEmptyString(CONSUMER_CURSOR_MAX_CHARS).optional(),
}).strip();

const activityTextQuerySchema = z.object({
  from: nonNegativeIntegerString.optional(),
}).strip();

const adminActivityListQuerySchema = z.object({
  limit: positiveIntegerString.optional(),
  host: nonEmptyString.optional(),
  agent_kind: z.enum(["codex", "claude"]).optional(),
  since_ms: nonNegativeIntegerString.optional(),
}).strip();

const adminActivityGetQuerySchema = z.object({
  around: nonEmptyString.optional(),
  tail: nonNegativeIntegerString.optional(),
  context: nonNegativeIntegerString.optional(),
  include_tools: booleanQueryString.optional(),
}).strip();

const adminActivityMessagesQuerySchema = z.object({
  role: nonEmptyString.optional(),
  visibility: nonEmptyString.optional(),
  first: nonNegativeIntegerString.optional(),
  last: nonNegativeIntegerString.optional(),
  around_id: nonEmptyString.optional(),
  around_text: nonEmptyString.optional(),
  context: nonNegativeIntegerString.optional(),
  grep: nonEmptyString.optional(),
  summary_only: booleanQueryString.optional(),
  max_text_chars: nonNegativeIntegerString.optional(),
  explain_classification: booleanQueryString.optional(),
  latest_session: booleanQueryString.optional(),
  backend: z.enum(["codex", "claude"]).optional(),
}).strip();

const adminActivityEventsQuerySchema = z.object({
  raw_role: nonEmptyString.optional(),
  tail: nonNegativeIntegerString.optional(),
  around_id: nonEmptyString.optional(),
  context: nonNegativeIntegerString.optional(),
  classify: booleanQueryString.optional(),
  within_turn: booleanQueryString.optional(),
  latest_session: booleanQueryString.optional(),
  backend: z.enum(["codex", "claude"]).optional(),
}).strip();

const adminActivityTurnsQuerySchema = z.object({
  role: nonEmptyString.optional(),
  first: nonNegativeIntegerString.optional(),
  last: nonNegativeIntegerString.optional(),
  with_tools: booleanQueryString.optional(),
  summary_only: booleanQueryString.optional(),
  max_text_chars: nonNegativeIntegerString.optional(),
  latest_session: booleanQueryString.optional(),
  backend: z.enum(["codex", "claude"]).optional(),
}).strip();

const adminActivityAttachmentsQuerySchema = z.object({
  turn: nonNegativeIntegerString.optional(),
  message: nonEmptyString.optional(),
  extract: booleanQueryString.optional(),
  ref: nonEmptyString.optional(),
  out: nonEmptyString.optional(),
}).strip();

const adminActivityTextQuerySchema = z.object({
  range: nonEmptyString.optional(),
  from: nonNegativeIntegerString.optional(),
  classifier_version: nonEmptyString.optional(),
}).strip();

const messageInboxQuerySchema = paginationQuerySchema.extend({
  scope: nonEmptyString.optional(),
  status: nonEmptyString.optional(),
  max_text_chars: nonNegativeIntegerString.optional(),
}).strip();

const messageThreadQuerySchema = paginationQuerySchema.extend({
  max_text_chars: nonNegativeIntegerString.optional(),
}).strip();

const messageTextQuerySchema = z.object({
  from: nonNegativeIntegerString.optional(),
}).strip();

const messageTextSchema = z.object({
  schema_version: z.literal("calyx.message-text/v1"),
  message_id: consumerPortableIdSchema,
  text: z.string().max(4_000),
  text_cursor: z.object({
    total_chars: z.number().int().nonnegative(),
    returned: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    next: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const [start, end] = value.text_cursor.returned;
  if (start > end || end > value.text_cursor.total_chars) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text_cursor", "returned"],
      message: "returned span must satisfy start <= end <= total_chars",
    });
  }
  if (value.text.length !== end - start) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "text length must match the returned span",
    });
  }
});

const monitorListQuerySchema = paginationQuerySchema.extend({
  status: nonEmptyString.optional(),
  assigned_host: nonEmptyString.optional(),
  source_run_id: nonEmptyString.optional(),
}).strip();

const monitorWakeQuerySchema = paginationQuerySchema.extend({
  monitor: nonEmptyString.optional(),
  status: nonEmptyString.optional(),
}).strip();

const adminMonitorWakeQuerySchema = monitorWakeQuerySchema.extend({
  wake_id: nonEmptyString.optional(),
}).strip();

const leaseListQuerySchema = paginationQuerySchema.extend({
  resource_kind: z.enum(["worktree", "session", "vault", "issue"]).optional(),
  owner_host: nonEmptyString.optional(),
  include_expired: booleanQueryString.optional(),
}).strip();
const requestAuditQuerySchema = z.object({
  limit: positiveIntegerString.optional(),
  cursor: z.string().min(1).max(4_096).optional(),
  outcome: z.enum(["admitted", "response_completed", "response_rejected", "indeterminate"]).optional(),
  operation_id: nonEmptyString.optional(),
}).strip();

const errorDetailsSchema = z.object({
  findings: z.array(z.object({ table: nonEmptyString, code: nonEmptyString, detail: nonEmptyString }).strict()).optional(),
  recipient_kind: nonEmptyString.optional(),
  operation: nonEmptyString.optional(),
  reason: nonEmptyString.optional(),
  candidate_limit: z.number().int().nonnegative().optional(),
  candidates_seen: z.number().int().nonnegative().optional(),
  identity_max_bytes: z.number().int().positive().optional(),
  hint: nonEmptyString.optional(),
  required_profile: nonEmptyString.optional(),
  credential_tier: nonEmptyString.optional(),
  ref: nonEmptyString.optional(),
  activity_id: nonEmptyString.optional(),
  expected_sha256: nonEmptyString.optional(),
  actual_sha256: nonEmptyString.optional(),
  searched_sources: z.array(nonEmptyString).optional(),
  schema_status: nonEmptyString.optional(),
  expected: nonEmptyString.optional(),
  alternatives: z.array(nonEmptyString).optional(),
  required_schema_version: nonEmptyString.optional(),
  presets: z.array(nonEmptyString).optional(),
  provenances: z.array(nonEmptyString).optional(),
  rearm_policies: z.array(nonEmptyString).optional(),
  requested_host: nonEmptyString.optional(),
  actual_host: nonEmptyString.optional(),
  advertised_host: nonEmptyString.optional(),
  owner_host: nonEmptyString.optional(),
  key: nonEmptyString.optional(),
  holder_activity_id: nonEmptyString.optional(),
  expires_at: isoTimestamp.optional(),
  run_id: nonEmptyString.optional(),
  host: nonEmptyString.optional(),
  wake_id: nonEmptyString.optional(),
  monitor_id: nonEmptyString.optional(),
  conflicting_parameters: z.array(boundedRequestNonEmptyString(128)).max(16).optional(),
}).strict();

const errorEnvelopeSchema = z.object({
  error: z.object({
    schema_version: z.literal("calyx.error/v1"),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    message: nonEmptyString,
    details: errorDetailsSchema.optional(),
    hint: nonEmptyString.optional(),
    retryable: z.boolean().optional(),
  }).strict(),
}).strict();

const runObservationListSchema = boundedList(
  "calyx.run-observation-list/v1",
  "runs",
  runObservationSchema,
);

const activityObservationListSchema = boundedList(
  "calyx.activity-observation-list/v1",
  "activities",
  runObservationSchema,
);

const activityAttachmentsSchema = boundedList(
  "activity.attachments/v1",
  "attachments",
  activityAttachmentObservationSchema,
  {
    count: false,
    shape: {
      activity_id: z.string().min(1).max(CONSUMER_PORTABLE_ID_MAX_CHARS),
      backend: z.string().min(1).max(CONSUMER_BACKEND_MAX_CHARS),
      session_id: z.string().min(1).max(CONSUMER_PORTABLE_ID_MAX_CHARS),
      host: z.string().min(1).max(CONSUMER_HOST_MAX_CHARS).optional(),
    },
  },
);

const messageSendResultCommon = {
  schema_version: z.literal("calyx.msg-send-result/v1"),
  inserted: z.boolean(),
  message: messageObservationSchema,
};
const messageSendResultSchema = z.discriminatedUnion("delivery_state", [
  z.object({ ...messageSendResultCommon, delivery_state: z.literal("inert") }).strict(),
  z.object({
    ...messageSendResultCommon,
    delivery_state: z.literal("outbox"),
    operation: z.object({
      status: z.literal("accepted"),
      locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-operations\//),
      receipt_locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-operations\//),
    }).strict(),
    outbox: z.object({
      outbox_id: consumerPortableIdSchema,
      target_host: consumerHostSchema,
      status: z.literal("pending"),
      created_at: consumerTimestampSchema,
      expires_at: consumerTimestampSchema,
    }).strict(),
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}message-send-result`);
const messageSendLocalResultSchema = z.object({
  ...messageSendResultCommon,
  delivery_state: z.literal("inert"),
}).strict();
const messageSendOutboxResultSchema = z.object({
  ...messageSendResultCommon,
  delivery_state: z.literal("outbox"),
  operation: z.object({
    status: z.literal("accepted"),
    locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-operations\//),
    receipt_locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-operations\//),
  }).strict(),
  outbox: z.object({
    outbox_id: consumerPortableIdSchema,
    target_host: consumerHostSchema,
    status: z.literal("pending"),
    created_at: consumerTimestampSchema,
    expires_at: consumerTimestampSchema,
  }).strict(),
}).strict();

const messageOperationReceiptSchema = z.object({
  schema_version: z.literal("calyx.message-operation-receipt/v1"),
  outcome: openStringEnum(["forwarded", "indeterminate", "delivery_failed"]),
  completed_at: consumerTimestampSchema,
}).strict();

const messageOperationCommonShape = {
  schema_version: z.literal("calyx.message-operation/v1"),
  operation_id: consumerPortableIdSchema,
  message_locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-text\//).optional(),
  target_host: consumerHostSchema,
  attempt_count: z.number().int().nonnegative(),
  created_at: consumerTimestampSchema,
  updated_at: consumerTimestampSchema,
};
const messageOperationSchema = z.discriminatedUnion("terminal", [
  z.object({
    ...messageOperationCommonShape,
    status: openStringEnum(["pending", "in_flight"]),
    terminal: z.literal(false),
  }).strict(),
  z.object({
    ...messageOperationCommonShape,
    status: openStringEnum(["forwarded", "indeterminate", "delivery_failed"]),
    terminal: z.literal(true),
    receipt: messageOperationReceiptSchema,
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}message-operation`);

const messageInboxSchema = boundedList(
  "calyx.message-inbox/v1",
  "messages",
  messageObservationSchema,
  { shape: { subject: consumerMessageSubjectSchema } },
);
const messageThreadSchema = boundedList(
  "calyx.message-thread/v1",
  "messages",
  messageObservationSchema,
  { shape: {
    thread_key: consumerMessageReferenceSchema,
    subject: consumerMessageSubjectSchema,
  } },
);

const messageDoctorSchema = z.object({
  schema_version: z.literal("calyx.message-doctor/v1"),
  subject: consumerMessageSubjectSchema,
  schema_status: z.literal("ok"),
  counts: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    acked: z.number().int().nonnegative(),
    dead_letter: z.number().int().nonnegative(),
    delivery_failed: z.number().int().nonnegative(),
  }).strict(),
  receipt_mirrors: z.object({
    pending: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const monitorObservationListSchema = boundedList(
  "calyx.monitor-observation-list/v1",
  "monitors",
  monitorObservationSchema,
);
const wakeObservationListSchema = boundedList(
  "calyx.wake-observation-list/v1",
  "wakes",
  wakeObservationSchema,
);
const leaseObservationListSchema = boundedList(
  "calyx.lease-observation-list/v1",
  "leases",
  leaseObservationSchema,
);

interface BackendExecutionLimitCarrier {
  backend?: "codex" | "claude" | undefined;
  backend_options?: Record<string, unknown> | undefined;
}

function refineBackendExecutionLimits(
  value: BackendExecutionLimitCarrier,
  ctx: z.RefinementCtx,
): void {
  const maxThreads = value.backend_options?.["max_threads"];
  const maxTurns = value.backend_options?.["max_turns"];
  if (maxThreads !== undefined && (typeof maxThreads !== "number" || !Number.isInteger(maxThreads) || maxThreads <= 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_threads"],
      message: "backend_options.max_threads must be a positive integer.",
    });
  }
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_turns"],
      message: "backend_options.max_turns must be a positive integer.",
    });
  }
  if ((maxThreads !== undefined || maxTurns !== undefined) && value.backend === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend"],
      message: "backend is required when a backend execution limit is provided.",
    });
  }
  if (value.backend === "claude" && maxThreads !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_threads"],
      message: "Claude does not support backend_options.max_threads; use max_turns only when an explicit Claude turn cap is intended.",
    });
  }
  if (value.backend === "codex" && maxTurns !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["backend_options", "max_turns"],
      message: "Codex does not support backend_options.max_turns; use max_threads for Codex sub-agent concurrency.",
    });
  }
}

const runIntentObjectSchema = z.object({
  run_id: runIdString,
  kernel: z.enum(["agent_runner", "host_process"]).optional(),
  issue: nonEmptyString.optional(),
  template: nonEmptyString.optional(),
  template_vars: z.record(z.string()).optional(),
  prompt: z.string().optional(),
  prompt_file: nonEmptyString.optional(),
  system_prompt: z.string().optional(),
  append_system_prompt: z.string().optional(),
  execplan_ref: nonEmptyString.optional(),
  required_features: z.array(nonEmptyString).optional(),
  host: nonEmptyString,
  backend: z.enum(["codex", "claude"]).optional(),
  profile: nonEmptyString.optional(),
  repo: nonEmptyString.optional(),
  worktree_mode: z.enum(["existing", "managed", "create"]).optional(),
  worktree_base: nonEmptyString.optional(),
  worktree_path: nonEmptyString.optional(),
  worktree_source: z.enum(["run_spec", "explicit_flag", "activity_inventory_cwd"]).optional(),
  worktree_ref: nonEmptyString.optional(),
  worktree_reset_on_reuse: z.boolean().optional(),
  branch: nonEmptyString.optional(),
  steal_lock: z.boolean().optional(),
  lock_timeout_ms: z.number().int().nonnegative().optional(),
  require_execplan: z.boolean().optional(),
  pull_execplan: z.boolean().optional(),
  required_artifacts: z.array(nonEmptyString).optional(),
  artifact_roots: z.array(nonEmptyString).optional(),
  output_capture: apiRunOutputCaptureSchema.optional(),
  max_turns_per_run: z.number().int().positive().optional(),
  backend_options: openJsonDictionary("run-intent.backend-options").optional(),
  host_process: z.object({
    argv: z.array(z.string()).min(1),
    cwd: nonEmptyString.optional(),
    env: z.record(z.string().nullable()).optional(),
    stop_grace_ms: z.number().int().nonnegative().optional(),
    health: z.object({
      stale_after_ms: z.number().int().positive(),
      poll_interval_ms: z.number().int().positive().optional(),
      sources: z.array(z.object({
        kind: z.enum(["stdout", "stderr", "file"]),
        label: nonEmptyString.optional(),
        path: nonEmptyString.optional(),
      }).strict()),
    }).strict().optional(),
  }).strict().optional(),
  notifications: openJsonDictionary("run-intent.notifications").optional(),
  handback: openJsonDictionary("run-intent.handback").optional(),
  metadata: openJsonDictionary("run-intent.metadata").optional(),
  resume_session_id: nonEmptyString.optional(),
  created_at: isoTimestamp,
}).strip();
const runIntentSchema = runIntentObjectSchema.superRefine(refineBackendExecutionLimits);
const runIntentRequestSchema = runIntentObjectSchema.extend({
  host_process: z.object({
    argv: z.array(z.string()).min(1),
    cwd: nonEmptyString.optional(),
    env: z.record(z.string().nullable()).optional(),
    stop_grace_ms: z.number().int().nonnegative().optional(),
    health: z.object({
      stale_after_ms: z.number().int().positive(),
      poll_interval_ms: z.number().int().positive().optional(),
      sources: z.array(z.object({
        kind: z.enum(["stdout", "stderr", "file"]),
        label: nonEmptyString.optional(),
        path: nonEmptyString.optional(),
      }).strip()),
    }).strip().optional(),
  }).strip().optional(),
}).strip().superRefine(refineBackendExecutionLimits);

const agentProgressSignalSchema = z.object({
  source: z.enum(["claude_stream", "adapter_activity"]),
  status: z.enum(["available", "unavailable", "failed"]),
  reason: z.enum([
    "awaiting_first_signal",
    "stream_initialized",
    "semantic_event",
    "no_structured_events",
    "malformed_stream",
    "spawn_failed",
    "adapter_activity",
  ]),
  expected_silence_until: isoTimestamp.optional(),
}).strict();

const providerConstraintSchema = z.object({
  schema_version: z.literal("calyx.provider-constraint/v1"),
  cause: z.literal("provider_capacity_exhausted"),
  backend: z.string().min(1).max(64),
  kind: z.enum(["session_window", "weekly_limit", "credits", "usage_limit"]),
  source: z.enum(["backend_stream", "session_transcript", "backend_stderr", "terminal_message"]),
  observed_at: isoTimestamp,
  confidence: z.literal("definitive"),
  provider_code: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/u).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  reset_hint: z.string().min(1).max(256).optional(),
}).strict();

const agentTerminalEvidenceSchema = z.object({
  schema_version: z.literal("calyx.agent-terminal-evidence/v1"),
  source: z.enum(["claude_stream", "session_fallback", "process_exit"]),
  status: z.enum(["authoritative", "fallback", "missing", "malformed"]),
  reason: z.enum([
    "completed", "max_turns", "budget_exhaustion", "provider_capacity_exhausted", "operator_stop",
    "backend_failure", "abnormal_exit", "malformed_result", "missing_result",
    "deferred", "unknown",
  ]),
  backend_subtype: z.string().optional(),
  backend_terminal_reason: z.string().optional(),
  backend_stop_reason: z.string().optional(),
  session_id: z.string().optional(),
  exit_code: z.number().int().optional(),
  signal: z.string().optional(),
  duration_ms: z.number().nonnegative().optional(),
  duration_api_ms: z.number().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  total_cost_usd: z.number().nonnegative().optional(),
  permission_denial_count: z.number().int().nonnegative().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  provider_constraint: providerConstraintSchema.optional(),
  malformed_line_count: z.number().int().nonnegative().optional(),
  unknown_record_count: z.number().int().nonnegative().optional(),
}).strict();

const runTerminalProjectionSchema = z.object({
  evidence: agentTerminalEvidenceSchema,
}).strict();

const runHealthSchema = z.object({
  source: z.enum(["host_process", "agent_runner"]),
  status: openStringEnum(["healthy", "stale", "unknown"]),
  checked_at: isoTimestamp,
  stale_after_ms: z.number().int().nonnegative(),
  last_activity_at: isoTimestamp.optional(),
  last_progress_at: isoTimestamp.optional(),
  observations: z.array(z.object({
    kind: nonEmptyString,
    label: nonEmptyString,
    path: nonEmptyString.optional(),
    exists: z.boolean(),
    last_modified_at: isoTimestamp.optional(),
  }).strict()),
  progress_signal: agentProgressSignalSchema.optional(),
  summary: z.string(),
}).strict();

const recoverySchema = z.object({
  mode: openStringEnum(["normal", "orchestrator_crash", "daemon_crash", "orphaned_process"]),
  resumable: z.boolean(),
  checkpoint: z.object({
    adapter_session_id: nonEmptyString.optional(),
    backend_session_id: nonEmptyString.optional(),
    backend_session_path: nonEmptyString.optional(),
    backend_thread_id: nonEmptyString.optional(),
    current_turn_id: nonEmptyString.optional(),
    last_event_at: isoTimestamp.optional(),
    strategy: z.enum(["none", "native_session"]),
  }).strict().optional(),
  note: z.string().optional(),
  owner_free_settlement: z.object({
    schema_version: z.literal("calyx.owner-free-settlement/v1"),
    authority: z.literal("legacy_pid_dead"),
    authority_id: z.string().regex(/^[0-9a-f]{64}$/u),
    settled_at: isoTimestamp,
    reason_code: z.literal("legacy_detached_worker_observed_dead"),
    legacy_pid: z.number().int().positive(),
  }).strict().optional(),
  resource_settlement: z.discriminatedUnion("status", [
    z.object({
      schema_version: z.literal("calyx.resource-settlement/v1"),
      status: z.literal("pending"),
      authority: z.literal("legacy_process_group_observation"),
      observed_at: isoTimestamp,
      reason_code: z.enum([
        "legacy_detached_process_group_possibly_live",
        "legacy_detached_process_group_untrusted",
      ]),
      legacy_process_group_id: z.number().int().positive(),
    }).strict(),
    z.object({
      schema_version: z.literal("calyx.resource-settlement/v1"),
      status: z.literal("settled"),
      authority: z.literal("legacy_process_group_extinct"),
      authority_id: z.string().regex(/^[0-9a-f]{64}$/u),
      settled_at: isoTimestamp,
      reason_code: z.literal("legacy_detached_process_group_observed_extinct"),
      legacy_process_group_id: z.number().int().positive(),
    }).strict(),
  ]).optional(),
}).strict();

const runRecordSchema = z.object({
  schema_version: z.literal("calyx.run-record/v1"),
  run_id: nonEmptyString,
  state: openStringEnum(ALL_STATES),
  infra_error_classification: openJsonDictionary("run-record.infra-error-classification").optional(),
  intent: runIntentSchema,
  creation_provenance: apiProvenanceSchema.optional(),
  launch: z.object({
    mode: z.enum(["inline", "detached"]),
    stage: openStringEnum(["accepted", "dispatching", "executing"]),
    incarnation_id: z.string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
      .optional(),
    admission_identity: z.string().regex(/^[0-9a-f]{64}$/u),
    request_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    accepted_at: isoTimestamp,
    dispatch_attempts: z.number().int().nonnegative(),
    last_dispatch_at: isoTimestamp.optional(),
    execution_id: nonEmptyString.optional(),
    execution_started_at: isoTimestamp.optional(),
    host_process_execution_binding: z.object({
      schema_version: z.literal("calyx.host-process-execution-binding/v1"),
      execution_id: nonEmptyString,
      salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      commitment_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }).strict().optional(),
  }).strict(),
  spec: openJsonDictionary("run-record.spec").optional(),
  kernel_receipt: openJsonDictionary("run-record.kernel-receipt").optional(),
  health: runHealthSchema.optional(),
  integrations: z.object({
    results: z.array(z.object({
      name: nonEmptyString,
      critical: z.boolean(),
      status: openStringEnum(["success", "failed", "skipped"]),
      error: z.string().optional(),
      duration_ms: z.number().nonnegative().optional(),
      details: openJsonDictionary("run-record.integration-details").optional(),
    }).strict()),
    all_critical_ok: z.boolean(),
  }).strict(),
  recovery: recoverySchema,
  summary: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  completed_at: isoTimestamp.optional(),
}).strip();

const runListEntrySchema = z.object({
  run_id: nonEmptyString,
  state: nonEmptyString,
  summary: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  completed_at: isoTimestamp.optional(),
  health_status: nonEmptyString.optional(),
  last_progress_at: isoTimestamp.optional(),
  progress_signal: agentProgressSignalSchema.optional(),
  terminal: runTerminalProjectionSchema.optional(),
  issue: nonEmptyString.optional(),
  host: nonEmptyString.optional(),
  backend: z.enum(["codex", "claude"]).optional(),
  recovery_mode: nonEmptyString,
  run_dir: nonEmptyString,
  entry_kind: z.literal("calyx_run").optional(),
}).strict();

const interactiveActivityEntrySchema = z.object({
  entry_kind: z.literal("interactive_session"),
  run_id: nonEmptyString,
  state: z.literal("interactive"),
  summary: z.string(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  host: nonEmptyString.optional(),
  backend: z.enum(["codex", "claude"]),
  session_id: nonEmptyString,
  session_path: nonEmptyString,
  cwd: nonEmptyString.optional(),
  source: z.enum(["claude_projects", "codex_sessions", "calyx_runs"]),
  bytes: z.number().int().nonnegative().optional(),
}).strict();

const runActivityEntrySchema = z.union([runListEntrySchema, interactiveActivityEntrySchema]);
const adminRunListSchema = boundedList(
  "calyx.run-list/v1",
  "runs",
  runActivityEntrySchema,
);

const buildSummarySchema = z.object({
  git_head: nonEmptyString,
  built_at: isoTimestamp,
  package_version: nonEmptyString,
}).strict();

const daemonHealthSchema = z.object({
  schema_version: z.literal("daemon-health/v1"),
  protocol_epoch: z.literal(1),
  daemon_kind: z.literal("run-service"),
  daemon_id: nonEmptyString,
  advertised_host: nonEmptyString.optional(),
  pid: z.number().int().positive(),
  uptime_ms: z.number().nonnegative(),
  started_at: isoTimestamp,
  build: buildSummarySchema,
  env: z.object({ inherited_path: z.string() }).strict(),
  promoted_build: z.object({
    status: openStringEnum(["ok", "missing", "error"]),
    install_path: nonEmptyString.optional(),
    current_link: nonEmptyString.optional(),
    build_info_path: nonEmptyString.optional(),
    build: buildSummarySchema.optional(),
    error: z.string().optional(),
  }).strict().optional(),
  clone_head: z.object({
    status: openStringEnum(["ok", "unavailable", "error"]),
    repo_root: nonEmptyString.optional(),
    git_head: nonEmptyString.optional(),
    error: z.string().optional(),
  }).strict().optional(),
  state_schema: z.object({
    status: openStringEnum(["current", "behind", "ahead", "unavailable"]),
    driver: nonEmptyString.optional(),
    current: nonEmptyString.nullable().optional(),
    target: nonEmptyString.nullable().optional(),
    pending: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }).strict().optional(),
  active_runs: z.number().int().nonnegative(),
  active_run_ids: z.array(nonEmptyString).optional(),
  maintenance_mode: z.boolean(),
  supports_features: z.array(nonEmptyString),
  interactive_sessions: z.object({
    window_ms: z.number().int().nonnegative(),
    scanned_at: isoTimestamp,
    codex: z.number().int().nonnegative(),
    claude: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    status: openStringEnum(["ok", "unavailable"]).optional(),
    reason: openStringEnum(["timeout", "error"]).optional(),
    timed_out_ms: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }).strict().optional(),
}).strict();

const sessionWakePointerSchema = z.object({
  kind: z.enum(["message", "monitor_wake"]),
  id: boundedRequestNonEmptyString(512),
});
const sessionWakeDeliveryIdSchema = z.string().min(77).max(77).regex(/^session_wake_[0-9a-f]{64}$/u);
const sessionWakeActivityIdSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^interactive:(?:codex|claude):\S+$/u);
const sessionWakeDeliverRequestSchema = z.object({
  schema_version: z.literal("calyx.session-wake-deliver-request/v1"),
  delivery_id: sessionWakeDeliveryIdSchema,
  recipient_activity_id: sessionWakeActivityIdSchema,
  pointer: sessionWakePointerSchema,
  created_at: isoTimestamp,
});
const sessionWakeDeliveryObservationSchema = z.object({
  delivery_id: sessionWakeDeliveryIdSchema,
  status: z.enum(["attempted", "delivered", "failed"]),
  attempted_at: isoTimestamp,
  delivered_at: isoTimestamp.nullable(),
  failed_at: isoTimestamp.nullable(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().nullable(),
}).strict();
const sessionWakeResultSchema = z.object({
  schema_version: z.literal("calyx.session-wake-result/v1"),
  delivery_state: z.literal("spooled"),
  wake_state: z.enum([
    "wake_delivered",
    "pointer_unavailable",
    "binding_unavailable",
    "binding_expired",
    "binding_replaced",
    "unsupported_pointer",
    "unsupported_adapter",
    "delivery_indeterminate",
    "adapter_failure",
  ]),
  recipient_activity_id: sessionWakeActivityIdSchema,
  pointer: sessionWakePointerSchema,
  delivery: sessionWakeDeliveryObservationSchema,
  first_command: z.string().min(1).max(1024),
}).strict();

const daemonMetricsSchema = z.object({
  schema_version: z.literal("daemon-metrics/v1"),
  memory: z.object({ rss: z.number(), heap_total: z.number(), heap_used: z.number(), external: z.number(), array_buffers: z.number() }).strict(),
  event_loop: z.object({ lag_ms_p50: z.number(), lag_ms_p99: z.number() }).strict(),
  connections: z.object({ sse_subscribers: z.number().int().nonnegative(), codex_app_server_sessions: z.number().int().nonnegative() }).strict(),
  runs: z.object({ active: z.number().int().nonnegative(), total_serviced_since_start: z.number().int().nonnegative() }).strict(),
}).strict();

const durableStreamEventSchema = z.object({
  schema_version: z.literal("1.0"),
  event_id: nonEmptyString,
  cursor: z.string().min(1).max(CALYX_HTTP_SSE_CURSOR_MAX_CHARS),
  emitted_at: isoTimestamp,
  event_type: nonEmptyString,
  emitted_by: nonEmptyString,
  run: openJsonDictionary("stream-event.run").optional(),
  origin: openJsonDictionary("stream-event.origin").optional(),
  pointers: openJsonDictionary("stream-event.pointers").optional(),
  control: openJsonDictionary("stream-event.control").optional(),
  monitor: openJsonDictionary("stream-event.monitor").optional(),
  predicate: openJsonDictionary("stream-event.predicate").optional(),
  evaluation: openJsonDictionary("stream-event.evaluation").optional(),
  summary: z.object({
    one_line: z.string(),
    agent_terminal_message: z.string().optional(),
    terminal_evidence: agentTerminalEvidenceSchema.optional(),
  }).strip().optional(),
  enrichment: openJsonDictionary("stream-event.enrichment").optional(),
}).strip();
const streamEventSchema = z.union([
  durableStreamEventSchema,
  calyxStreamProjectionGapEventSchema,
]);
const runServiceEventSchema = z.object({
  timestamp: isoTimestamp,
  run_id: nonEmptyString,
  source: z.literal("run-service"),
  event: z.enum([
    "intent_persisted", "launch_intent", "launch_result", "spec_persisted", "launch_dispatched",
    "launch_started", "launch_completed", "integration_started", "integration_finished",
    "handback_emitted", "handback_withheld", "stop_intent", "stop_result", "reconcile_intent", "reconcile_result",
    "reconciled", "warning",
  ]),
  message: z.string(),
  provenance: apiProvenanceSchema.optional(),
  payload: openJsonDictionary("run-service-event.payload").optional(),
}).strict().describe(`${CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX}run-service-event`);
const lifecycleEventSchema = z.object({
  timestamp: isoTimestamp,
  run_id: nonEmptyString,
  event: z.enum([
    "state_transition", "dispatch_started", "dispatch_passed", "dispatch_rejected", "backend_spawned",
    "backend_event", "artifact_detected", "artifact_gate_passed", "artifact_gate_failed", "notification_sent", "error", "warning",
  ]),
  from: nonEmptyString.optional(),
  to: nonEmptyString.optional(),
  message: z.string().optional(),
  infra_error_classification: openJsonDictionary("lifecycle-event.infra-error-classification").optional(),
  payload: openJsonDictionary("lifecycle-event.payload").optional(),
}).strict().describe(`${CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX}lifecycle-event`);
const recordedRunEventSchema = z.union([
  runServiceEventSchema,
  lifecycleEventSchema,
  streamEventSchema,
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}recorded-run-event`);

const runLogEntrySchema = z.object({
  kind: z.enum(["event", "stream_line", "agent_message"]),
  source: z.enum(["lifecycle", "host_process", "run_worker", "agent"]),
  text: z.string(),
  timestamp: isoTimestamp.optional(),
  timestamp_source: z.enum(["event", "file_mtime", "message"]).optional(),
  event: nonEmptyString.optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  line: z.number().int().nonnegative().optional(),
  path: nonEmptyString.optional(),
  truncated_head_bytes: z.number().int().nonnegative().optional(),
}).strict();
const runLogSourceSchema = z.object({
  source: z.enum(["lifecycle", "host_process", "run_worker", "agent"]),
  stream: z.enum(["stdout", "stderr"]).optional(),
  path: nonEmptyString.optional(),
  exists: z.boolean(),
  file_size_bytes: z.number().int().nonnegative().optional(),
  read_from_byte: z.number().int().nonnegative().optional(),
  truncated_head_bytes: z.number().int().nonnegative().optional(),
  selected_lines: z.number().int().nonnegative(),
  line_count: z.number().int().nonnegative().optional(),
  latest_modified_at: isoTimestamp.optional(),
}).strict();
const runLogsSchema = z.object({
  schema_version: z.literal("run-logs/v1"),
  run_id: nonEmptyString,
  entries: z.array(runLogEntrySchema),
  sources: z.array(runLogSourceSchema),
  options: z.object({
    tail: z.number().int().positive().optional(),
    stream_tail: z.number().int().nonnegative(),
    max_stream_bytes: z.number().int().positive(),
    stream_tail_defaulted: z.boolean(),
  }).strict(),
  warnings: z.array(z.string()),
}).strict();

const runObservationResultSchema = z.object({
  schema_version: z.literal("run-observation/v1"),
  run_id: nonEmptyString,
  checked_at: isoTimestamp,
  run: z.object({
    state: nonEmptyString.optional(),
    summary: z.string().optional(),
    host: nonEmptyString.optional(),
    issue: nonEmptyString.optional(),
    backend: z.enum(["codex", "claude"]).optional(),
    kernel: z.enum(["agent_runner", "host_process"]).optional(),
    updated_at: isoTimestamp.optional(),
    health: runHealthSchema.optional(),
  }).strict(),
  paths: z.object({ run_dir: nonEmptyString, worktree_path: nonEmptyString.optional() }).strict(),
  process: z.object({ status: nonEmptyString, checked_at: isoTimestamp, pid: z.number().int().positive().optional() }).strict(),
  resource_attribution: openJsonDictionary("run-observation.resource-attribution").optional(),
  logs: z.object({ sources: z.array(runLogSourceSchema), warnings: z.array(z.string()) }).strict(),
  artifacts: z.array(openJsonDictionary("run-observation.artifact")),
  artifact_roots: z.array(openJsonDictionary("run-observation.artifact-root")).optional(),
  host_resources: openJsonDictionary("run-observation.host-resources"),
  warnings: z.array(z.string()),
}).strip();

const executionReceiptRunSpecSchema = canonicalRunSpecSchema.extend({
  backend_options: openJsonDictionary("execution-receipt.run-spec.backend-options").optional(),
  metadata: openJsonDictionary("execution-receipt.run-spec.metadata").optional(),
  output_capture: apiRunOutputCaptureSchema.optional(),
}).strict().superRefine(refineBackendExecutionLimits);

const agentRunnerReceiptSchema = canonicalRunReceiptSchema.extend({
  run_spec: executionReceiptRunSpecSchema,
  metadata: openJsonDictionary("execution-receipt.metadata").optional(),
}).strict();

const hostProcessExecutionBindingSchema = z.object({
  schema_version: z.literal("calyx.host-process-execution-binding/v1"),
  execution_id: nonEmptyString,
  salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  commitment_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const hostProcessReceiptBaseSchema = z.object({
  kernel: z.literal("host_process"),
  run_id: nonEmptyString,
  state: openStringEnum(ALL_STATES),
  infra_error_classification: canonicalRunReceiptSchema.shape.infra_error_classification,
  timing: canonicalRunReceiptSchema.shape.timing,
  exit: canonicalRunReceiptSchema.shape.exit,
  log_summary: canonicalRunReceiptSchema.shape.log_summary,
  process: z.object({
    argv: z.array(nonEmptyString).min(1),
    cwd: nonEmptyString,
    env_keys: z.array(z.string()),
    pid: z.number().int().positive().optional(),
    process_group_id: z.number().int().positive().optional(),
    stdout_path: nonEmptyString.optional(),
    stderr_path: nonEmptyString.optional(),
    stop_grace_ms: z.number().int().nonnegative(),
    stop_requested: z.boolean(),
    stop_signal: nonEmptyString.optional(),
  }).strict(),
  health: canonicalRunReceiptSchema.shape.health,
  summary: nonEmptyString,
  metadata: openJsonDictionary("execution-receipt.metadata").optional(),
}).strict();

const hostProcessReceiptSchema = z.union([
  hostProcessReceiptBaseSchema.extend({
    schema_version: z.literal(HOST_PROCESS_RECEIPT_SCHEMA_VERSION),
    execution_binding: hostProcessExecutionBindingSchema,
  }).strict(),
  hostProcessReceiptBaseSchema.extend({
    schema_version: z.literal("1.0"),
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}host-process-receipt`);

const executionReceiptSchema = z.union([
  agentRunnerReceiptSchema,
  hostProcessReceiptSchema,
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}execution-receipt`);

const reconcileResultSchema = z.object({
  scanned: z.number().int().nonnegative(),
  rebuilt: z.array(nonEmptyString),
  repair_pending: z.array(nonEmptyString),
  classified: z.array(nonEmptyString),
  adopted: z.array(nonEmptyString),
  unresolved: z.array(z.object({
    run_id: nonEmptyString,
    reason: z.enum(CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS),
  }).strict()),
  skipped: z.array(nonEmptyString),
  noncanonical_directories: z.array(z.object({
    directory_name: nonEmptyString,
    status: z.enum([
      "quarantined",
      "already_absent",
      "requires_operator_migration",
      "quarantine_failed",
    ]),
    reason: nonEmptyString,
    record_state: nonEmptyString.optional(),
    detail: nonEmptyString.optional(),
  }).strict()),
  projection: z.discriminatedUnion("status", [
    z.object({ status: z.literal("repaired"), rowCount: z.number().int().nonnegative() }).strict(),
    z.object({ status: z.literal("not_configured") }).strict(),
    z.object({ status: z.literal("failed"), reason: nonEmptyString }).strict(),
  ]),
}).strict();

const runtimeConfigResultSchema = z.object({
  contractVersion: z.literal("local-backend/v1"),
  backend: z.literal("runtime-config"),
  mode: openStringEnum(["plan", "apply", "verify"]),
  host: nonEmptyString,
  ok: z.boolean(),
  generatedAt: isoTimestamp,
  summary: z.object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    drift: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
  }).strict(),
  items: z.array(z.object({
    component: openStringEnum(["codex", "claude-settings", "claude-mcp"]),
    status: openStringEnum(["ok", "drift", "applied"]),
    targetPath: nonEmptyString,
    stagedPath: nonEmptyString,
    liveExists: z.boolean(),
    desiredSha256: nonEmptyString,
    liveSha256: nonEmptyString.optional(),
    outputSha256: nonEmptyString.optional(),
    backupPath: nonEmptyString.optional(),
    changes: z.array(z.string()),
  }).strict()),
  requestedHost: nonEmptyString,
  managedConfigsRoot: nonEmptyString,
  liveHome: nonEmptyString,
}).strict();

const activitySourceReceiptSchema = z.object({
  mode: z.enum(["streaming", "full_load"]),
  bytes_scanned: z.number().int().nonnegative(),
  records_scanned: z.number().int().nonnegative(),
  records_decoded: z.number().int().nonnegative(),
  oversized_records_skipped: z.number().int().nonnegative(),
  max_record_bytes: z.number().int().positive(),
  source_bytes: z.number().int().nonnegative().optional(),
  guard_hits: z.array(z.string()),
}).strict();
const activityWarningSchema = z.object({
  code: z.enum(["partial_final_line", "unparseable_line", "live_session", "empty_session", "source_too_large"]),
  message: z.string(),
  source_line: z.number().int().positive().optional(),
}).strict();
const attachmentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const attachmentRefSchema = z.string().regex(/^att:sha256:[0-9a-f]{64}$/u);
const attachmentMimeTypeSchema = z.string()
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u);
const activityAttachmentRecordShape = {
  ref: attachmentRefSchema,
  sha256: attachmentSha256Schema,
  mime_type: attachmentMimeTypeSchema,
  byte_size: z.number().int().nonnegative().max(ACTIVITY_ATTACHMENT_MAX_BYTES),
  source_shape: nonEmptyString,
  exact_bytes_available: z.boolean(),
  activity_id: nonEmptyString,
  message_id: nonEmptyString,
  source_line: z.number().int().nonnegative(),
  event_index: z.number().int().nonnegative(),
  detail: z.enum(["resized", "original"]).optional(),
  original_locator: nonEmptyString.optional(),
  extracted_path: nonEmptyString.optional(),
  provenance_path: nonEmptyString.optional(),
  cache_status: z.enum(["hit", "written", "rewritten"]).optional(),
  origin_host: nonEmptyString.optional(),
  served_by_host: nonEmptyString.optional(),
  source_tier: activityAttachmentSourceTierSchema.optional(),
} satisfies z.ZodRawShape;
function requireAttachmentRecordCorrelation(
  value: { ref: string; sha256: string },
  context: z.RefinementCtx,
): void {
  if (value.ref !== `att:sha256:${value.sha256}`) {
    context.addIssue({
      code: "custom",
      path: ["ref"],
      message: "attachment ref must encode the exact sha256 digest",
    });
  }
}
const activityAttachmentRecordSchema = z.object(activityAttachmentRecordShape)
  .strict()
  .superRefine(requireAttachmentRecordCorrelation);
const activityAttachmentResultSchema = z.object({
  ...activityAttachmentRecordShape,
  schema_version: z.literal("activity.attachment-record/v1"),
  classifier_version: nonEmptyString,
  source_tier: activityAttachmentSourceTierSchema,
  source_locator: nonEmptyString.optional(),
  source_receipt: activitySourceReceiptSchema,
}).strict().superRefine(requireAttachmentRecordCorrelation);
const activityAttachmentHeadersSchema = z.object({
  content_length: z.number().int().nonnegative().max(ACTIVITY_ATTACHMENT_MAX_BYTES),
  etag: nonEmptyString,
  digest: nonEmptyString,
  attachment_ref: nonEmptyString,
  origin_host: nonEmptyString.optional(),
  served_by_host: nonEmptyString.optional(),
  source_tier: activityAttachmentSourceTierSchema,
}).strict();
const activityMessageRawSchema = z.object({
  id: nonEmptyString,
  activity_id: nonEmptyString,
  activity: openJsonDictionary("activity-message.activity-ref"),
  turn_id: nonEmptyString.optional(),
  role: nonEmptyString,
  visibility: nonEmptyString,
  text: z.string().optional(),
  text_cursor: openJsonDictionary("activity-message.text-cursor").optional(),
  summary: z.string(),
  timestamp: isoTimestamp.optional(),
  truncated: z.boolean().optional(),
  attachments: z.array(activityAttachmentRecordSchema).optional(),
  event_refs: z.array(z.number().int().nonnegative()),
  source_lines: z.array(z.number().int().nonnegative()),
  classification: openJsonDictionary("activity-message.classification"),
}).strip();
const activityResultBase = {
  classifier_version: nonEmptyString,
  activity_id: nonEmptyString,
  run_id: nonEmptyString.optional(),
  activity_resolution: openJsonDictionary("activity-result.activity-resolution").optional(),
  backend: z.enum(["codex", "claude"]),
  session_id: nonEmptyString,
  session_path: nonEmptyString,
  source: z.enum(["claude_projects", "codex_sessions", "calyx_runs"]),
  cwd: nonEmptyString.optional(),
  host: nonEmptyString.optional(),
  source_state: openStringEnum(["complete", "live", "partial"]),
  warnings: z.array(activityWarningSchema),
  source_receipt: activitySourceReceiptSchema,
};
const adminActivityMessagesSchema = z.object({
  schema_version: z.literal("activity.messages/v1"), ...activityResultBase,
  total_events: z.number().int().nonnegative(), total_messages: z.number().int().nonnegative(),
  matched_messages: z.number().int().nonnegative(), returned_messages: z.number().int().nonnegative(), truncated: z.boolean(),
  attachments: openJsonDictionary("activity-messages.attachment-rollup"), selector: openJsonDictionary("activity-messages.selector"), messages: z.array(activityMessageRawSchema), recall_freshness: openJsonDictionary("activity-messages.recall-freshness").optional(),
}).strip();
const adminActivityTurnsSchema = z.object({
  schema_version: z.literal("activity.turns/v1"), ...activityResultBase,
  total_events: z.number().int().nonnegative(), total_messages: z.number().int().nonnegative(), total_turns: z.number().int().nonnegative(),
  matched_turns: z.number().int().nonnegative(), returned_turns: z.number().int().nonnegative(), truncated: z.boolean(),
  selector: openJsonDictionary("activity-turns.selector"), turns: z.array(openJsonDictionary("activity-turns.turn")), recall_freshness: openJsonDictionary("activity-turns.recall-freshness").optional(),
}).strip();
const adminActivityEventsSchema = z.object({
  schema_version: z.literal("activity.events/v1"), ...activityResultBase,
  total_events: z.number().int().nonnegative(), matched_events: z.number().int().nonnegative(), returned_events: z.number().int().nonnegative(),
  truncated: z.boolean(), selector: openJsonDictionary("activity-events.selector"), events: z.array(openJsonDictionary("activity-events.event")),
}).strip();
const adminActivityTextSchema = z.object({
  schema_version: z.literal("activity.text/v1"), classifier_version: nonEmptyString, activity_id: nonEmptyString,
  backend: z.enum(["codex", "claude"]), session_id: nonEmptyString, session_path: nonEmptyString,
  message_id: nonEmptyString, source_line: z.number().int().nonnegative(), text: z.string(), text_cursor: openJsonDictionary("activity-text.cursor"),
  source_receipt: activitySourceReceiptSchema,
}).strip();
const adminActivityAttachmentsSchema = z.object({
  schema_version: z.literal("activity.attachments/v1"), classifier_version: nonEmptyString, activity_id: nonEmptyString,
  backend: z.enum(["codex", "claude"]), session_id: nonEmptyString, session_path: nonEmptyString,
  source_receipt: activitySourceReceiptSchema, attachments: z.array(activityAttachmentRecordSchema), rollup: openJsonDictionary("activity-attachments.rollup"),
}).strip();

const adminActivityGetSchema = z.object({
  activity_id: nonEmptyString,
  backend: z.enum(["codex", "claude"]),
  session_id: nonEmptyString,
  session_path: nonEmptyString,
  source: z.enum(["claude_projects", "codex_sessions", "calyx_runs"]),
  cwd: nonEmptyString.optional(),
  bytes: z.number().int().nonnegative().optional(),
  total_events: z.number().int().nonnegative(),
  returned_events: z.number().int().nonnegative(),
  truncated: z.boolean(),
  around: nonEmptyString.optional(),
  tail: z.number().int().nonnegative().optional(),
  context: z.number().int().nonnegative().optional(),
  include_tools: z.boolean(),
  events: z.array(openJsonDictionary("activity-detail.event")),
}).strip();

const predicateAtomSchema = z.object({
  schema_version: z.literal("predicate/v1"),
  kind: z.enum([
    "run.terminal", "run.failed", "run.health_stale", "artifact.exists", "artifact.changed", "receipt.appeared",
    "tracker.state_changed", "tracker.label_changed", "vault.path_changed", "time.cron", "time.after", "all_of", "any_of",
    "debounce", "for_duration",
  ]),
  run_id: nonEmptyString.optional(),
  threshold_ms: z.number().int().positive().optional(),
  path: nonEmptyString.optional(),
  baseline: openJsonDictionary("predicate.baseline").optional(),
  tracker_id: nonEmptyString.optional(),
  to_state: nonEmptyString.optional(),
  label: nonEmptyString.optional(),
  expr: nonEmptyString.optional(),
  timezone: nonEmptyString.optional(),
  at: isoTimestamp.optional(),
  window_ms: z.number().int().positive().optional(),
  duration_ms: z.number().int().positive().optional(),
}).strip();
const predicateSchema = predicateAtomSchema.extend({
  predicates: z.array(predicateAtomSchema).optional(),
  predicate: predicateAtomSchema.optional(),
  window_ms: z.number().int().positive().optional(),
  duration_ms: z.number().int().positive().optional(),
}).strip();
const monitorDeliverySchema = z.object({
  schema_version: z.literal("calyx.monitor-delivery/v1"),
  tier0: z.object({
    schema_version: z.literal("calyx.monitor-delivery/v1"), tier: z.literal("tier0"),
    adapters: z.tuple([z.literal("state-row"), z.literal("jsonl-receipt"), z.literal("sse")]), retention: z.literal("indefinite"),
  }).strict(),
  bindings: z.array(z.object({
    schema_version: z.literal("calyx.monitor-delivery/v1"), binding_id: nonEmptyString,
    adapter: z.enum(["ntfy", "linear_comment", "vault_receipt", "codex_automation", "codex_app_server_steer", "claude_reinvoke", "claude_channel"]),
    materiality: z.object({
      schema_version: z.literal("calyx.monitor-materiality/v1"),
      kind: z.enum(["always", "run_failed_or_stalled", "run_success", "artifact_churn"]),
    }).strict(),
    enabled: z.boolean().optional(), digest: openJsonDictionary("monitor-delivery.digest").optional(), ntfy: openJsonDictionary("monitor-delivery.ntfy").optional(),
    linear_comment: openJsonDictionary("monitor-delivery.linear-comment").optional(), vault_receipt: openJsonDictionary("monitor-delivery.vault-receipt").optional(), codex_automation: openJsonDictionary("monitor-delivery.codex-automation").optional(),
    codex_app_server_steer: openJsonDictionary("monitor-delivery.codex-app-server-steer").optional(), claude_reinvoke: openJsonDictionary("monitor-delivery.claude-reinvoke").optional(), claude_channel: openJsonDictionary("monitor-delivery.claude-channel").optional(),
  }).strip()),
  ntfy_topic_policy: z.literal("fleet_default_with_per_lane_override"),
  tier2_bridge: z.literal("codex_app_automations_first"),
  agent_mail_thread: z.literal("legacy_provenance_only"),
}).strip();
const monitorDeliveryRequestSchema = z.object({
  schema_version: z.literal("calyx.monitor-delivery/v1"),
  tier0: z.object({
    schema_version: z.literal("calyx.monitor-delivery/v1"), tier: z.literal("tier0"),
    adapters: z.tuple([z.literal("state-row"), z.literal("jsonl-receipt"), z.literal("sse")]), retention: z.literal("indefinite"),
  }).strip(),
  bindings: z.array(z.object({
    schema_version: z.literal("calyx.monitor-delivery/v1"), binding_id: nonEmptyString,
    adapter: z.enum(["ntfy", "linear_comment", "vault_receipt", "codex_automation", "codex_app_server_steer", "claude_reinvoke", "claude_channel"]),
    materiality: z.object({
      schema_version: z.literal("calyx.monitor-materiality/v1"),
      kind: z.enum(["always", "run_failed_or_stalled", "run_success", "artifact_churn"]),
    }).strip(),
    enabled: z.boolean().optional(), digest: openJsonDictionary("monitor-delivery.digest").optional(), ntfy: openJsonDictionary("monitor-delivery.ntfy").optional(),
    linear_comment: openJsonDictionary("monitor-delivery.linear-comment").optional(), vault_receipt: openJsonDictionary("monitor-delivery.vault-receipt").optional(), codex_automation: openJsonDictionary("monitor-delivery.codex-automation").optional(),
    codex_app_server_steer: openJsonDictionary("monitor-delivery.codex-app-server-steer").optional(), claude_reinvoke: openJsonDictionary("monitor-delivery.claude-reinvoke").optional(), claude_channel: openJsonDictionary("monitor-delivery.claude-channel").optional(),
  }).strip()),
  ntfy_topic_policy: z.literal("fleet_default_with_per_lane_override"),
  tier2_bridge: z.literal("codex_app_automations_first"),
  agent_mail_thread: z.literal("legacy_provenance_only"),
}).strip();
const monitorRowSchema = z.object({
  monitor_id: nonEmptyString, schema_version: z.literal("calyx.monitor/v1"), status: nonEmptyString,
  created_at: isoTimestamp, updated_at: isoTimestamp, owner: nonEmptyString, created_by: nonEmptyString,
  create_provenance: nonEmptyString, assigned_host: nullableString, source_run_id: nullableString, preset: nullableString,
  created_request_provenance: apiProvenanceSchema.nullable(),
  predicate: predicateSchema, rearm_policy: nonEmptyString, delivery: monitorDeliverySchema,
  last_evaluated_at: isoTimestamp.nullable(), last_match: z.boolean().nullable(), last_transition_hash: nullableString,
  last_wake_id: nullableString, last_error: nullableString,
}).strip();
const evaluationSchema = z.object({
  schema_version: z.literal("predicate-evaluation/v1"), evaluated_at: isoTimestamp, matched: z.boolean(),
  predicate_hash: nonEmptyString, transition_hash: nonEmptyString, fingerprint: nonEmptyString,
  cursor: openJsonDictionary("predicate-evaluation.cursor"), evidence: z.array(openJsonDictionary("predicate-evaluation.evidence")), warnings: z.array(z.string()),
}).strip();
const monitorWakeRowSchema = z.object({
  wake_id: nonEmptyString, schema_version: z.literal("calyx.monitor-wake/v1"), monitor_id: nonEmptyString,
  transition_hash: nonEmptyString, status: nonEmptyString, created_at: isoTimestamp,
  claimed_until: isoTimestamp.nullable(), claimed_by: nullableString, acked_at: isoTimestamp.nullable(),
  acked_by: nullableString, rearm_policy: nonEmptyString, predicate: predicateSchema, evaluation: evaluationSchema,
  delivery: monitorDeliverySchema, suggested_commands: z.array(z.string()), receipt_path: nullableString,
}).strip();
const monitorDeliveryStateSchema = z.object({
  count: z.number().int().nonnegative(),
  counts: z.object({ attempted: z.number().int().nonnegative(), delivered: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
  deliveries: z.array(openJsonDictionary("monitor-delivery-state.delivery")),
  failures: z.array(openJsonDictionary("monitor-delivery-state.failure")),
}).strict();
const monitorListResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-list/v1"), owner_host: nonEmptyString, count: z.number().int().nonnegative(), monitors: z.array(monitorRowSchema),
}).strict();
const monitorCreateResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-create/v1"), owner_host: nonEmptyString,
  storage: z.object({ host: nonEmptyString, inspect_command: nonEmptyString }).strict(), note: z.string(), monitor: monitorRowSchema,
}).strict();
const monitorGetResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-show/v1"), owner_host: nonEmptyString, monitor: monitorRowSchema, delivery_state: monitorDeliveryStateSchema,
}).strict();
const monitorWakesResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-inbox/v1"), owner_host: nonEmptyString, count: z.number().int().nonnegative(),
  wakes: z.array(monitorWakeRowSchema), delivery_state: monitorDeliveryStateSchema,
}).strict();
const monitorAckResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-ack/v1"), owner_host: nonEmptyString, changed: z.boolean(), wake: monitorWakeRowSchema,
}).strict();
const monitorCancelResultSchema = z.object({
  schema_version: z.literal("calyx.monitor-cancel/v1"), owner_host: nonEmptyString, monitor: monitorRowSchema,
}).strict();

const leaseRowSchema = z.object({
  key: nonEmptyString, resource_kind: z.enum(["worktree", "session", "vault", "issue"]), owner_host: nonEmptyString,
  resource_host: nullableString, resource_path: nonEmptyString, holder_activity_id: nonEmptyString, acquired_at: isoTimestamp,
  ttl_ms: z.number().int().positive(), renewed_at: isoTimestamp.nullable(), expires_at: isoTimestamp,
  stolen_from_holder_activity_id: nullableString, stolen_at: isoTimestamp.nullable(),
  steal_provenance: openJsonDictionary("lease.steal-provenance"), metadata: openJsonDictionary("lease.metadata"),
}).strict();
const leaseConflictSchema = z.object({
  kind: z.enum(["held", "holder-mismatch", "holder-required", "missing", "expired", "quarantined"]),
  lease: leaseRowSchema.optional(), message: z.string(),
}).strict();
const leaseAcquireResultSchema = z.object({ acquired: z.boolean(), lease: leaseRowSchema.optional(), conflict: leaseConflictSchema.optional() }).strict();
const leaseRenewResultSchema = z.object({ renewed: z.boolean(), lease: leaseRowSchema.optional(), conflict: leaseConflictSchema.optional() }).strict();
const leaseReleaseResultSchema = z.object({ released: z.boolean(), lease: leaseRowSchema.optional(), conflict: leaseConflictSchema.optional() }).strict();
const leaseStealResultSchema = z.object({ stolen: z.boolean(), lease: leaseRowSchema, previous_lease: leaseRowSchema.optional() }).strict();

const messageRowSchema = z.object({
  message_id: nonEmptyString, schema_version: z.literal("calyx.message/v1"), sender: nonEmptyString, recipient_address: nonEmptyString,
  recipient_class: z.enum(["directed", "scope"]), recipient_host: nullableString, subject: nonEmptyString, body: z.string(), thread_key: nullableString,
  reply_to: nullableString, idempotency_key: nullableString, urgency: z.enum(["low", "normal", "high"]), ack_required: z.boolean(), expires_at: isoTimestamp.nullable(),
  status: z.enum(["outbox", "pending", "claimed", "acked", "dead_letter", "delivery_failed"]), claimed_until: isoTimestamp.nullable(), claimed_by: nullableString, expired_claim_cycles: z.number().int().nonnegative(),
  dead_letter: z.boolean(), dead_letter_reason: nullableString, created_at: isoTimestamp, updated_at: isoTimestamp, spooled_at: isoTimestamp,
  delivered_at: isoTimestamp.nullable(), acked_at: isoTimestamp.nullable(), acked_by: nullableString, receipt_path: nullableString,
  payload: openJsonDictionary("message.payload"),
  created_provenance: apiProvenanceSchema.nullable(),
  ingress_provenance: apiProvenanceSchema.nullable(),
}).strip();
const messageEscalationSchema = z.object({
  mode: z.literal("pointer_only"),
  reason: z.literal("execution_requires_control_plane_authority"),
}).strict();
const forwardedMessageSchema = messageRowSchema.extend({
  message_id: requestNonEmptyString,
  sender: requestMessageAddress,
  recipient_address: requestMessageAddress,
  subject: boundedRequestNonEmptyString(500),
  // Rows created before migration 0023 legitimately have no origin snapshot.
  // Preserve that absence across rolling forwards; new HTTP-created rows are
  // still required by the runtime path to carry their admitted provenance.
  created_provenance: apiProvenanceSchema.nullable().optional(),
  ingress_provenance: z.null().optional(),
}).superRefine((message, context) => {
  if (message.recipient_class === "scope" && message.expires_at === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "scope messages require expires_at",
    });
  }
});

const msgForwardSchema = z.object({
  schema_version: z.literal("calyx.msg-send/v1"),
  message: forwardedMessageSchema,
}).strip();
const msgReceiveSchema = z.object({
  schema_version: z.literal("calyx.msg-receive/v1"), inserted: z.boolean(), message: messageRowSchema, escalation: messageEscalationSchema,
}).strict();

const runLaunchPortableRequestSchema = z.object({
  schema_version: z.literal("calyx.run-launch-request/v1"),
  intent: runIntentRequestSchema,
  idempotency_key: requestIdempotencyKey,
}).strip();

const runLaunchResultSchema = z.object({
  schema_version: z.literal("calyx.run-launch-result/v1"),
  status: z.literal("accepted"),
  run_id: nonEmptyString,
  operation: z.object({
    route: z.string().startsWith("/v1/admin/runs/"),
    events_route: z.string().startsWith("/v1/admin/runs/"),
    receipt_route: z.string().startsWith("/v1/admin/runs/"),
  }).strict(),
}).strict();

const runStopRequestSchema = z.object({ reason: z.string().max(1_000).optional() }).strip();
// POL-1897: terminal-state contract for owner-free stop settlement, derived
// from the canonical state machine rather than a hand-maintained list.
const terminalRunStates = ALL_STATES.filter(
  (state) => TERMINAL_STATES.has(state),
) as [typeof ALL_STATES[number], ...typeof ALL_STATES[number][]];
const cancellationRequestedResultShape = {
  schema_version: z.literal("calyx.run-cancellation-result/v1"),
  status: z.literal("cancellation_requested"),
  run_id: runIdString,
  requested_at: isoTimestamp,
};
const runStopResultSchema = z.union([
  z.object({
    ...cancellationRequestedResultShape,
    // Present together, and only when the targeted reconcile produced an
    // owner-free TERMINAL settlement during this stop (POL-1897). This paired
    // variant is additive within calyx.run-cancellation-result/v1, but neither
    // field is independently optional.
    worker_ownership: openStringEnum(["owner_free"]),
    settled_state: openStringEnum(terminalRunStates),
  }).strict(),
  z.object(cancellationRequestedResultShape).strict(),
  z.object({
    schema_version: z.literal("calyx.run-cancellation-result/v1"),
    status: z.literal("already_terminal"),
    run_id: runIdString,
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}run-stop-result`);

const runtimeConfigRequestSchema = z.object({
  contractVersion: z.literal("host-backend/v1"),
  backend: z.literal("runtime-config"),
  options: z.object({
    host: requestNonEmptyString,
    components: z.array(z.enum(["codex", "claude-settings", "claude-mcp"])).max(3).optional(),
  }).strip(),
}).strip();

const monitorCreateRequestSchema = z.object({
  schema_version: z.literal("calyx.monitor-create-request/v1"),
  idempotency_key: requestIdempotencyKey,
  owner: requestNonEmptyString,
  created_by: requestNonEmptyString,
  create_provenance: z.enum(["conductor", "operator"]),
  assigned_host: requestNonEmptyString,
  source_run_id: requestNonEmptyString,
  preset: z.literal("runner-supervision"),
  stale_after_ms: z.number().int().positive(),
  rearm_policy: z.enum(["once", "rearm_on_reset", "every_change"]),
  delivery: monitorDeliveryRequestSchema.optional(),
}).strip();

const monitorCancelRequestSchema = z.object({ reason: z.string().max(1_000).optional() }).strip();
const monitorAckRequestSchema = z.object({ acked_by: requestNonEmptyString }).strip();
const monitorClaimRequestSchema = z.object({
  idempotency_key: requestIdempotencyKey,
  claimed_by: requestNonEmptyString,
  monitor: requestNonEmptyString.optional(),
  limit: z.number().int().positive().max(500).optional(),
}).strip();

const leaseBaseRequestSchema = z.object({
  key: requestNonEmptyString,
  idempotency_key: requestIdempotencyKey,
  coordinator_host: requestNonEmptyString.optional(),
}).strip();
const leaseAcquireRequestSchema = leaseBaseRequestSchema.extend({
  holder_activity_id: requestNonEmptyString,
  ttl_ms: z.number().int().positive(),
}).strip();
const leaseRenewRequestSchema = leaseBaseRequestSchema.extend({
  holder_activity_id: requestNonEmptyString,
  ttl_ms: z.number().int().positive().optional(),
}).strip();
const leaseReleaseRequestSchema = leaseBaseRequestSchema.extend({
  holder_activity_id: requestNonEmptyString.optional(),
  force: z.boolean().optional(),
}).strip();
const leaseStealRequestSchema = leaseBaseRequestSchema.extend({
  holder_activity_id: requestNonEmptyString,
  ttl_ms: z.number().int().positive(),
  provenance: z.union([requestNonEmptyString, openJsonDictionary("lease-steal.provenance")]),
}).strip();
const leaseListRequestSchema = z.object({
  holder_activity_id: requestNonEmptyString.optional(),
  resource_kind: z.enum(["worktree", "session", "vault", "issue"]).optional(),
  owner_host: requestNonEmptyString.optional(),
  include_expired: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strip();
const leaseDoctorSchema = z.object({
  status: openStringEnum(["ok", "drift"]),
  findings: z.array(z.object({
    table: nonEmptyString,
    code: nonEmptyString,
    detail: nonEmptyString,
  }).strict()),
}).strict();
const requestAuditRowSchema = z.object({
  request_id: nonEmptyString,
  operation_id: nonEmptyString,
  subject: nonEmptyString,
  asserted_actor: nullableString,
  served_by_host: nonEmptyString,
  via: z.literal("http"),
  admitted_at: isoTimestamp,
  finalized_at: isoTimestamp.nullable(),
  response_status: z.number().int().min(100).max(599).nullable(),
  error_code: nullableString,
  outcome: z.enum(["admitted", "response_completed", "response_rejected", "indeterminate"]),
}).strict();
const requestAuditListSchema = boundedList(
  "calyx.request-audit-list/v1",
  "requests",
  requestAuditRowSchema,
);
const requestAuditDoctorSchema = z.object({
  schema_version: z.literal("calyx.request-audit-doctor/v1"),
  schema_status: z.enum(["ok", "drift"]),
  findings: z.array(z.object({
    table: nonEmptyString,
    code: z.enum(["missing-table", "missing-column", "missing-index", "missing-check"]),
    detail: nonEmptyString,
  }).strict()),
  retained: z.number().int().nonnegative(),
  counts: z.object({
    admitted: z.number().int().nonnegative(),
    response_completed: z.number().int().nonnegative(),
    response_rejected: z.number().int().nonnegative(),
    indeterminate: z.number().int().nonnegative(),
  }).strict(),
  retention_ms: z.number().int().positive(),
}).strict();

/**
 * The single runtime and OpenAPI schema registry. Every descriptor identifier
 * is deliberately listed here. Legacy admin/internal payloads retain their
 * existing permissive object contracts until they are materially reshaped,
 * but they never fall through to an implicit unknown schema.
 */
export const CALYX_SCHEMA_REGISTRY: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  "calyx.error/v1": errorEnvelopeSchema,
  "calyx.empty/v1": emptySchema,
  "calyx.empty-query/v1": emptyQuerySchema,

  "calyx.run-list-query/v1": runListQuerySchema,
  "calyx.admin-run-list-query/v1": adminRunListQuerySchema,
  "calyx.run-detail-query/v1": z.object({ tail: positiveIntegerString.optional() }).strip(),
  "calyx.event-observe-query/v1": consumerEventQuerySchema,
  "calyx.event-stream-query/v1": eventQuerySchema,
  "calyx.activity-list-query/v1": activityListQuerySchema,
  "calyx.activity-message-query/v1": activityMessagesQuerySchema,
  "calyx.activity-turn-query/v1": activityTurnsQuerySchema,
  "calyx.activity-attachment-query/v1": activityAttachmentsQuerySchema,
  "calyx.activity-text-query/v1": activityTextQuerySchema,
  "calyx.activity-mark-create-request/v1": activityMarkCreateRequestSchema,
  "calyx.activity-mark-list-query/v1": activityMarkListQuerySchema,
  "calyx.message-inbox-query/v1": messageInboxQuerySchema,
  "calyx.message-thread-query/v1": messageThreadQuerySchema,
  "calyx.message-text-query/v1": messageTextQuerySchema,
  "calyx.monitor-list-query/v1": monitorListQuerySchema,
  "calyx.monitor-wake-query/v1": monitorWakeQuerySchema,
  "calyx.lease-list-query/v1": leaseListQuerySchema,
  "calyx.request-audit-query/v1": requestAuditQuerySchema,
  "calyx.admin-activity-list-query/v1": adminActivityListQuerySchema,
  "calyx.admin-activity-get-query/v1": adminActivityGetQuerySchema,
  "calyx.admin-activity-messages-query/v1": adminActivityMessagesQuerySchema,
  "calyx.admin-activity-events-query/v1": adminActivityEventsQuerySchema,
  "calyx.admin-activity-turns-query/v1": adminActivityTurnsQuerySchema,
  "calyx.admin-activity-attachments-query/v1": adminActivityAttachmentsQuerySchema,
  "calyx.admin-activity-text-query/v1": adminActivityTextQuerySchema,

  "calyx.msg-send/v1": msgSendRequestSchema,
  "calyx.run-launch-portable-request/v1": runLaunchPortableRequestSchema,
  "calyx.run-stop-request/v1": runStopRequestSchema,
  "calyx.runtime-config-request/v1": runtimeConfigRequestSchema,
  "calyx.monitor-list-request/v1": monitorListQuerySchema,
  "calyx.monitor-create-request/v1": monitorCreateRequestSchema,
  "calyx.monitor-get-request/v1": emptySchema,
  "calyx.monitor-wakes-request/v1": adminMonitorWakeQuerySchema,
  "calyx.monitor-claim-request/v1": monitorClaimRequestSchema,
  "calyx.monitor-ack-request/v1": monitorAckRequestSchema,
  "calyx.monitor-cancel-request/v1": monitorCancelRequestSchema,
  "calyx.lease-acquire-request/v1": leaseAcquireRequestSchema,
  "calyx.lease-renew-request/v1": leaseRenewRequestSchema,
  "calyx.lease-release-request/v1": leaseReleaseRequestSchema,
  "calyx.lease-steal-request/v1": leaseStealRequestSchema,
  "calyx.lease-list-request/v1": leaseListRequestSchema,
  "calyx.lease-doctor-request/v1": emptySchema,
  "calyx.msg-forward/v1": msgForwardSchema,
  "calyx.session-wake-deliver-request/v1": sessionWakeDeliverRequestSchema,

  "calyx.admin-health/v1": adminHealthSchema,
  "self-upgrade-receipt/v1": selfUpgradeReceiptSchema,
  "calyx.admin-reconcile-result/v1": adminReconcileResultSchema,
  "calyx.session-wake-result/v1": sessionWakeResultSchema,
  "calyx.run-observation/v1": runObservationSchema,
  "calyx.run-observation-list/v1": runObservationListSchema,
  "calyx.run-observation-event/v1": runObservationStreamEventSchema,
  "calyx.activity-observation-list/v1": activityObservationListSchema,
  "activity.messages/v1": activityMessagesObservationSchema,
  "activity.turns/v1": activityTurnsObservationSchema,
  "activity.text/v1": activityTextObservationSchema,
  "activity.attachments/v1": activityAttachmentsSchema,
  "calyx.activity-mark/v1": activityMarkSchema,
  "calyx.activity-mark-revocation/v1": activityMarkRevocationSchema,
  "calyx.activity-mark-list/v1": activityMarkListSchema,
  "calyx.msg-send-result/v1": messageSendResultSchema,
  "calyx.msg-send-local-result/v1": messageSendLocalResultSchema,
  "calyx.msg-send-outbox-result/v1": messageSendOutboxResultSchema,
  "calyx.message-observation/v1": messageObservationSchema,
  "calyx.message-inbox/v1": messageInboxSchema,
  "calyx.message-thread/v1": messageThreadSchema,
  "calyx.message-text/v1": messageTextSchema,
  "calyx.message-operation/v1": messageOperationSchema,
  "calyx.message-operation-receipt/v1": messageOperationReceiptSchema,
  "calyx.message-doctor/v1": messageDoctorSchema,
  "calyx.monitor-observation/v1": monitorObservationSchema,
  "calyx.monitor-observation-list/v1": monitorObservationListSchema,
  "calyx.wake-observation-list/v1": wakeObservationListSchema,
  "calyx.wake-observation/v1": wakeObservationSchema,
  "calyx.lease-observation/v1": leaseObservationSchema,
  "calyx.lease-observation-list/v1": leaseObservationListSchema,

  "daemon-health/v1": daemonHealthSchema,
  "daemon-metrics/v1": daemonMetricsSchema,
  "calyx.stream-event/v1": streamEventSchema,
  "calyx.run-list/v1": adminRunListSchema,
  "calyx.run-launch-result/v1": runLaunchResultSchema,
  "calyx.run-record/v1": runRecordSchema,
  "calyx.run-logs/v1": runLogsSchema,
  "calyx.run-events/v1": z.array(recordedRunEventSchema),
  "calyx.admin-run-observation/v1": runObservationResultSchema,
  "calyx.run-receipt/v1": executionReceiptSchema,
  "calyx.run-cancellation-result/v1": runStopResultSchema,
  "calyx.run-reconcile/v1": reconcileResultSchema,
  "calyx.runtime-config-result/v1": runtimeConfigResultSchema,
  "calyx.msg-receive/v1": msgReceiveSchema,

  "calyx.admin-activity-list/v1": z.array(runActivityEntrySchema),
  "calyx.admin-activity-get/v1": adminActivityGetSchema,
  "calyx.admin-activity-messages/v1": adminActivityMessagesSchema,
  "calyx.admin-activity-events/v1": adminActivityEventsSchema,
  "calyx.admin-activity-turns/v1": adminActivityTurnsSchema,
  "calyx.admin-activity-attachments/v1": adminActivityAttachmentsSchema,
  "calyx.admin-activity-attachment-record/v1": activityAttachmentResultSchema,
  "calyx.admin-activity-attachment-bytes/v1": activityAttachmentHeadersSchema,
  "calyx.admin-activity-text/v1": adminActivityTextSchema,

  "calyx.monitor-list/v1": monitorListResultSchema,
  "calyx.monitor-create/v1": monitorCreateResultSchema,
  "calyx.monitor-get/v1": monitorGetResultSchema,
  "calyx.monitor-wakes/v1": monitorWakesResultSchema,
  "calyx.monitor-ack/v1": monitorAckResultSchema,
  "calyx.monitor-cancel/v1": monitorCancelResultSchema,

  "calyx.lease-acquire/v1": leaseAcquireResultSchema,
  "calyx.lease-renew/v1": leaseRenewResultSchema,
  "calyx.lease-release/v1": leaseReleaseResultSchema,
  "calyx.lease-steal/v1": leaseStealResultSchema,
  "calyx.lease-list/v1": z.array(leaseRowSchema),
  "calyx.lease-doctor/v1": leaseDoctorSchema,
  "calyx.request-audit-list/v1": requestAuditListSchema,
  "calyx.request-audit-doctor/v1": requestAuditDoctorSchema,
});

const descriptorSchemaIds = new Set(
  HTTP_OPERATION_DESCRIPTORS.flatMap((descriptor) => [
    descriptor.request_schema,
    descriptor.response_schema,
    ...descriptor.successes.flatMap((success) => [
      success.schema,
      ...(success.request_schema ? [success.request_schema] : []),
      ...(success.semantics.submission ? [success.semantics.submission.receipt_schema] : []),
    ]),
  ]),
);
const missingSchemaIds = [...descriptorSchemaIds]
  .filter((schemaId) => !CALYX_SCHEMA_REGISTRY[schemaId])
  .sort();
if (missingSchemaIds.length > 0) {
  throw new Error(`HTTP operation schema registry is incomplete: ${missingSchemaIds.join(", ")}`);
}

export const SERVER_OPERATION_SCHEMAS: ReadonlyMap<string, ServerOperationSchemas> = new Map(
  HTTP_OPERATION_DESCRIPTORS.map((descriptor) => [descriptor.operation_id, {
    request: CALYX_SCHEMA_REGISTRY[descriptor.request_schema]!,
    response: CALYX_SCHEMA_REGISTRY[descriptor.response_schema]!,
  }]),
);

export function resolveServerOperation(
  method: string | undefined,
  pathname: string,
): (HttpOperationDescriptor & ServerOperationSchemas) | undefined {
  const descriptor = resolveHttpOperation(method, pathname);
  if (!descriptor) return undefined;
  const schemas = SERVER_OPERATION_SCHEMAS.get(descriptor.operation_id);
  if (!schemas) throw new Error(`Operation ${descriptor.operation_id} has no Zod schema binding.`);
  return { ...descriptor, ...schemas };
}

export function validateSchema(schemaId: string, value: unknown): unknown {
  const schema = CALYX_SCHEMA_REGISTRY[schemaId];
  if (!schema) throw new Error(`Unknown Calyx schema ${schemaId}.`);
  return schema.parse(value);
}

export function validateOperationRequest(operationId: string, value: unknown): unknown {
  const schemas = SERVER_OPERATION_SCHEMAS.get(operationId);
  if (!schemas) throw new Error(`Unknown HTTP operation ${operationId}.`);
  if (
    operationId === "admin.run.launch"
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "detached")
  ) {
    throw new Error(
      "detached is retired from the portable launch contract; remote launches are always detached.",
    );
  }
  return schemas.request.parse(value);
}

export function validateOperationResponse(operationId: string, value: unknown): unknown {
  const schemas = SERVER_OPERATION_SCHEMAS.get(operationId);
  if (!schemas) throw new Error(`Unknown HTTP operation ${operationId}.`);
  return schemas.response.parse(value);
}

export function validateOperationSuccessResponse(
  operationId: string,
  status: number,
  value: unknown,
): { value: unknown; mediaType: string } {
  return validateOperationSuccessResponseWith(
    operationId,
    status,
    value,
    (schema, candidate) => schema.parse(candidate),
  );
}

/**
 * Validate a response at a consumer boundary without making server writers
 * permissive. Same-major responses may add optional object members and values
 * to response enums that are open by default; the original wire value is
 * returned so a caller can preserve additions it does not yet understand.
 *
 * Closed discriminants and schema-version literals remain closed because they
 * are not marked with `calyx-open-enum:`. This is intentionally separate from
 * `validateOperationSuccessResponse`, which is the producer-side writer gate.
 */
export function validateOperationSuccessResponseForConsumer(
  operationId: string,
  status: number,
  value: unknown,
): { value: unknown; mediaType: string } {
  return validateOperationSuccessResponseWith(
    operationId,
    status,
    value,
    (schema, candidate, schemaId) => {
      const choices: ConsumerOpenEnumChoice[] = [];
      const consumerSchema = responseSchemaForConsumer(schemaId, schema);
      const projected = consumerCompatibilityProjection(consumerSchema, candidate, choices, schemaId);
      consumerSchema.parse(projected);
      if (schemaId === "calyx.admin-reconcile-result/v1") {
        // `parsed` is only the compatibility shadow. Normalize bounds on the
        // original same-major wire object so accepted additions and open enum
        // values survive the consumer projection.
        return normalizeCalyxAdminReconcileResultForConsumer(
          candidate as CalyxAdminReconcileResult,
        );
      }
      return candidate;
    },
  );
}

export function responseSchemaForConsumer(schemaId: string, schema: z.ZodTypeAny): z.ZodTypeAny {
  return schemaId === "calyx.admin-reconcile-result/v1"
    ? adminReconcileConsumerResultSchema
    : schema;
}

function validateOperationSuccessResponseWith(
  operationId: string,
  status: number,
  value: unknown,
  validate: (schema: z.ZodTypeAny, value: unknown, schemaId: string) => unknown,
): { value: unknown; mediaType: string } {
  const descriptor = HTTP_OPERATION_DESCRIPTORS.find((candidate) => candidate.operation_id === operationId);
  if (!descriptor) throw new Error(`Unknown HTTP operation ${operationId}.`);
  const successes = descriptor.successes.filter((candidate) => (
    candidate.status === status
    && (candidate.representation === "json" || candidate.representation === "sse")
  ));
  if (successes.length === 0) {
    throw new Error(`Operation ${operationId} has no structured success representation for status ${status}.`);
  }
  const failures: unknown[] = [];
  for (const success of successes) {
    if (!success.media_type || success.media_type === "dynamic") continue;
    try {
      const schema = CALYX_SCHEMA_REGISTRY[success.schema];
      if (!schema) throw new Error(`Unknown Calyx schema ${success.schema}.`);
      return { value: validate(schema, value, success.schema), mediaType: success.media_type };
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, `Operation ${operationId} response did not match any success representation for status ${status}.`);
}

interface ConsumerOpenEnumChoice {
  path: Array<string | number>;
  knownValues: readonly string[];
}
const CONSUMER_INCOMPATIBLE_EXCLUSIVE_UNION = Symbol("consumer-incompatible-exclusive-union");

function consumerCompatibilityProjection(
  schema: z.ZodTypeAny,
  value: unknown,
  choices: ConsumerOpenEnumChoice[],
  schemaId: string,
  path: Array<string | number> = [],
  knownForbiddenFields: ReadonlySet<string> = new Set(),
): unknown {
  if (schema instanceof z.ZodEffects) {
    const effectChoices: ConsumerOpenEnumChoice[] = [];
    const projected = isExclusiveResponseUnionDescription(schema.description)
      ? consumerExclusiveUnionProjection(schema.innerType(), value, effectChoices, schemaId, path)
      : consumerCompatibilityProjection(
        schema.innerType(),
        value,
        effectChoices,
        schemaId,
        path,
        knownForbiddenFields,
      );
    const compatible = findConsumerCompatibleProjection(schema, projected, effectChoices);
    choices.push(...effectChoices);
    return compatible ?? projected;
  }
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodReadonly
  ) {
    return consumerCompatibilityProjection(
      schema._def.innerType,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
  }
  if (schema instanceof z.ZodCatch) {
    return consumerCompatibilityProjection(
      schema._def.innerType,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
  }
  if (schema instanceof z.ZodBranded) {
    return consumerCompatibilityProjection(
      schema._def.type,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
  }
  if (schema instanceof z.ZodPipeline) {
    return consumerCompatibilityProjection(
      schema._def.in,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
  }
  if (schema instanceof z.ZodLazy) {
    return consumerCompatibilityProjection(
      schema._def.getter(),
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
  }
  if (
    schema instanceof z.ZodEnum
    && (
      schema.description?.startsWith("calyx-open-enum:")
      || (schema.options.length > 1 && !isClosedResponseEnumPath(schemaId, path))
    )
  ) {
    if (typeof value === "string" && !schema.options.includes(value)) {
      choices.push({ path, knownValues: schema.options });
      return schema.options[0];
    }
    return value;
  }
  if (schema instanceof z.ZodObject) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const source = value as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const [key, childSchema] of Object.entries(schema.shape) as Array<[string, z.ZodTypeAny]>) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        projected[key] = consumerCompatibilityProjection(childSchema, source[key], choices, schemaId, [...path, key]);
      }
    }
    const catchall = schema._def.catchall;
    const preserveUnknown = schema._def.unknownKeys === "passthrough";
    const rejectUnknown = schema.description?.startsWith(
      CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX,
    ) ?? false;
    for (const [key, child] of Object.entries(source)) {
      if (Object.prototype.hasOwnProperty.call(schema.shape, key)) continue;
      // `undefined` is absent on the JSON wire and must not become a synthetic
      // known-conditional member merely because a JavaScript object was spread.
      if (child === undefined) continue;
      if (!(catchall instanceof z.ZodNever)) {
        projected[key] = consumerCompatibilityProjection(catchall, child, choices, schemaId, [...path, key]);
      } else if (preserveUnknown || rejectUnknown || knownForbiddenFields.has(key)) {
        projected[key] = child;
      }
    }
    return projected;
  }
  if (schema instanceof z.ZodArray) {
    return Array.isArray(value)
      ? value.map((item, index) => consumerCompatibilityProjection(schema.element, item, choices, schemaId, [...path, index]))
      : value;
  }
  if (schema instanceof z.ZodTuple) {
    if (!Array.isArray(value)) return value;
    return value.map((item, index) => {
      const itemSchema = schema.items[index] ?? schema._def.rest;
      return itemSchema ? consumerCompatibilityProjection(itemSchema, item, choices, schemaId, [...path, index]) : item;
    });
  }
  if (schema instanceof z.ZodRecord) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      consumerCompatibilityProjection(schema.valueSchema, item, choices, schemaId, [...path, key]),
    ]));
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    if (isExclusiveResponseUnionDescription(schema.description)) {
      return consumerExclusiveUnionProjection(schema, value, choices, schemaId, path);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const discriminator = (value as Record<string, unknown>)[schema.discriminator];
    const option = schema.optionsMap.get(discriminator as never);
    return option
      ? consumerCompatibilityProjection(
        option,
        value,
        choices,
        schemaId,
        path,
        knownForbiddenFields,
      )
      : value;
  }
  if (schema instanceof z.ZodUnion) {
    if (isExclusiveResponseUnionDescription(schema.description)) {
      return consumerExclusiveUnionProjection(schema, value, choices, schemaId, path);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const literalFields = closedUnionLiteralFields(schema.options);
      for (const [key, declaredValues] of literalFields) {
        const actual = (value as Record<string, unknown>)[key];
        if (
          Object.prototype.hasOwnProperty.call(value, key)
          && !declaredValues.some((declared) => Object.is(declared, actual))
        ) {
          return value;
        }
      }
    }
    for (const option of schema.options) {
      const optionChoices: ConsumerOpenEnumChoice[] = [];
      const projected = consumerCompatibilityProjection(
        option,
        value,
        optionChoices,
        schemaId,
        path,
        knownForbiddenFields,
      );
      if (option.safeParse(projected).success) {
        choices.push(...optionChoices);
        return projected;
      }
    }
    return value;
  }
  if (schema instanceof z.ZodIntersection) {
    const left = consumerCompatibilityProjection(
      schema._def.left,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
    const right = consumerCompatibilityProjection(
      schema._def.right,
      value,
      choices,
      schemaId,
      path,
      knownForbiddenFields,
    );
    if (
      left && right
      && typeof left === "object" && typeof right === "object"
      && !Array.isArray(left) && !Array.isArray(right)
    ) {
      return { ...left, ...right };
    }
    return left;
  }
  return value;
}

function isExclusiveResponseUnionDescription(description: string | undefined): boolean {
  return description?.startsWith(CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX) === true
    || description?.startsWith("calyx-bounded-page:") === true;
}

function directUnionOptions(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | undefined {
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options;
  }
  if (schema instanceof z.ZodEffects) return directUnionOptions(schema.innerType());
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodReadonly
    || schema instanceof z.ZodCatch
  ) return directUnionOptions(schema._def.innerType);
  if (schema instanceof z.ZodBranded) return directUnionOptions(schema._def.type);
  return undefined;
}

function unionLeafOptions(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] {
  const options = directUnionOptions(schema);
  return options ? options.flatMap((option) => unionLeafOptions(option)) : [schema];
}

function consumerExclusiveUnionProjection(
  schema: z.ZodTypeAny,
  value: unknown,
  choices: ConsumerOpenEnumChoice[],
  schemaId: string,
  path: Array<string | number>,
): unknown {
  const options = unionLeafOptions(schema);
  if (options.length < 2) {
    return consumerCompatibilityProjection(schema, value, choices, schemaId, path);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const literalFields = closedUnionLiteralFields(options);
    for (const [key, declaredValues] of literalFields) {
      const actual = (value as Record<string, unknown>)[key];
      if (
        Object.prototype.hasOwnProperty.call(value, key)
        && !declaredValues.some((declared) => Object.is(declared, actual))
      ) return CONSUMER_INCOMPATIBLE_EXCLUSIVE_UNION;
    }
  }
  for (const option of options) {
    const forbiddenFields = knownUnionFieldsExcludedFromOption(options, option);
    if (
      value && typeof value === "object" && !Array.isArray(value)
      && [...forbiddenFields].some((field) => (
        Object.prototype.hasOwnProperty.call(value, field)
        && (value as Record<string, unknown>)[field] !== undefined
      ))
    ) continue;
    const optionChoices: ConsumerOpenEnumChoice[] = [];
    const projected = consumerCompatibilityProjection(
      option,
      value,
      optionChoices,
      schemaId,
      path,
      forbiddenFields,
    );
    if (option.safeParse(projected).success) {
      choices.push(...optionChoices);
      return projected;
    }
  }
  return CONSUMER_INCOMPATIBLE_EXCLUSIVE_UNION;
}

function knownUnionFieldsExcludedFromOption(
  options: readonly z.ZodTypeAny[],
  selected: z.ZodTypeAny,
): ReadonlySet<string> {
  const selectedShape = topLevelObjectShape(selected);
  if (!selectedShape) return new Set();
  const excluded = new Set<string>();
  for (const option of options) {
    const shape = topLevelObjectShape(option);
    if (!shape) continue;
    for (const key of Object.keys(shape)) {
      if (!Object.prototype.hasOwnProperty.call(selectedShape, key)) excluded.add(key);
    }
  }
  return excluded;
}

function closedUnionLiteralFields(
  options: readonly z.ZodTypeAny[],
): ReadonlyMap<string, readonly unknown[]> {
  const fields = new Map<string, { values: unknown[]; hasNonLiteralDeclaration: boolean }>();
  for (const option of options) {
    const shape = topLevelObjectShape(option);
    if (!shape) continue;
    for (const [key, childSchema] of Object.entries(shape) as Array<[string, z.ZodTypeAny]>) {
      const values = closedLiteralValues(childSchema);
      const field = fields.get(key) ?? { values: [], hasNonLiteralDeclaration: false };
      if (values.length === 0) {
        field.hasNonLiteralDeclaration = true;
      } else {
        field.values.push(...values);
      }
      fields.set(key, field);
    }
  }
  return new Map([...fields]
    .filter(([, field]) => field.values.length > 0 && !field.hasNonLiteralDeclaration)
    .map(([key, field]) => [key, field.values]));
}

function topLevelObjectShape(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  if (schema instanceof z.ZodObject) return schema.shape;
  if (schema instanceof z.ZodEffects) return topLevelObjectShape(schema.innerType());
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodReadonly
    || schema instanceof z.ZodCatch
  ) return topLevelObjectShape(schema._def.innerType);
  if (schema instanceof z.ZodBranded) return topLevelObjectShape(schema._def.type);
  return undefined;
}

function closedLiteralValues(schema: z.ZodTypeAny): readonly unknown[] {
  if (schema instanceof z.ZodLiteral) return [schema.value];
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodReadonly
    || schema instanceof z.ZodCatch
  ) return closedLiteralValues(schema._def.innerType);
  if (schema instanceof z.ZodBranded) return closedLiteralValues(schema._def.type);
  if (schema instanceof z.ZodEffects) return closedLiteralValues(schema.innerType());
  return [];
}

function findConsumerCompatibleProjection(
  schema: z.ZodTypeAny,
  projected: unknown,
  choices: readonly ConsumerOpenEnumChoice[],
): unknown | undefined {
  const maximumAttempts = 4_096;
  let attempts = 0;
  const search = (index: number, candidate: unknown): unknown | undefined => {
    if (index === choices.length) {
      attempts += 1;
      if (attempts > maximumAttempts) return undefined;
      return schema.safeParse(candidate).success ? candidate : undefined;
    }
    const choice = choices[index]!;
    for (const knownValue of choice.knownValues) {
      const result = search(index + 1, replaceAtJsonPath(candidate, choice.path, knownValue));
      if (result !== undefined) return result;
      if (attempts > maximumAttempts) return undefined;
    }
    return undefined;
  };
  return search(0, projected);
}

function replaceAtJsonPath(
  value: unknown,
  path: readonly (string | number)[],
  replacement: string,
): unknown {
  if (path.length === 0) return replacement;
  const clone = structuredClone(value);
  let cursor: unknown = clone;
  for (const segment of path.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return clone;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  if (!cursor || typeof cursor !== "object") return clone;
  (cursor as Record<string | number, unknown>)[path.at(-1)!] = replacement;
  return clone;
}

export function validateErrorEnvelope(value: unknown): unknown {
  return errorEnvelopeSchema.parse(value);
}

export function allRegisteredSchemaIds(): readonly string[] {
  return Object.keys(CALYX_SCHEMA_REGISTRY).sort();
}
