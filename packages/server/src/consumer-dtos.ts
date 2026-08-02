import { createHash } from "node:crypto";
import { z } from "zod";

import {
  GLOBAL_EVENT_CURSOR_MAX_LENGTH,
  isGlobalEventCursor,
} from "@polli-labs/calyx-run-service";
import type {
  ActivityAttachmentRecord,
  ActivityMessagesResult,
  ActivityTextResult,
  ActivityTurnsResult,
  InteractiveSessionListEntry,
  RunListEntry,
  RunRecord,
  CalyxRunEvent,
} from "@polli-labs/calyx-run-service";
import type {
  ActivityMarkListPage,
  ActivityMarkRow,
  CalyxAdminHealth,
  CalyxDaemonHealth,
  MessageRow,
  LeaseRow,
  MonitorDeliveryRow,
  MonitorRow,
  MonitorWakeRow,
} from "@polli-labs/calyx-core";
import {
  ACTIVITY_MARK_CURSOR_MAX_CHARS,
  ACTIVITY_MARK_ID_PATTERN_SOURCE,
  ACTIVITY_MARK_KINDS,
  ACTIVITY_MARK_LIST_MAX_LIMIT,
  ACTIVITY_MARK_REASON_MAX_CHARS,
  ACTIVITY_MARK_TARGET_ID_MAX_CHARS,
  ACTIVITY_MARK_TARGET_KINDS,
  ActivityMarksStateError,
  API_ASSERTED_ACTOR_PATTERN_SOURCE,
  API_PROVENANCE_HOST_PATTERN_SOURCE,
  API_PROVENANCE_SUBJECT_PATTERN_SOURCE,
  API_REQUEST_ID_PATTERN_SOURCE,
  CALYX_ADMIN_HEALTH_SCHEMA_VERSION,
  CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH,
  CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS,
  CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH,
  CALYX_ADMIN_RECONCILE_SCHEMA_VERSION,
  CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS,
  CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX,
  CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX,
  MESSAGE_STATUSES,
  MONITOR_STATUSES,
  MONITOR_WAKE_STATUSES,
  isCanonicalApiTimestamp,
  parseActivityMarkTargetId,
} from "@polli-labs/calyx-core";

function openStringEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values).describe(`calyx-open-enum:${JSON.stringify(values)}`);
}

export const adminHealthSchema = z.object({
  schema_version: z.literal(CALYX_ADMIN_HEALTH_SCHEMA_VERSION),
  protocol_epoch: z.number().int().positive(),
  daemon_kind: z.literal("run-service"),
  daemon_id: z.string().min(1),
  advertised_host: z.string().min(1).optional(),
  uptime_ms: z.number().nonnegative(),
  started_at: z.string().datetime(),
  build: z.object({
    git_head: z.string().min(1),
    built_at: z.string().datetime(),
    package_version: z.string().min(1),
  }).strict(),
  promoted_build: z.object({
    status: openStringEnum(["ok", "missing", "error"]),
    build: z.object({
      git_head: z.string().min(1),
      built_at: z.string().datetime(),
      package_version: z.string().min(1),
    }).strict().optional(),
  }).strict().optional(),
  clone_head: z.object({
    status: openStringEnum(["ok", "unavailable", "error"]),
    git_head: z.string().min(1).optional(),
  }).strict().optional(),
  state_schema: z.object({
    status: openStringEnum(["current", "behind", "ahead", "unavailable"]),
    driver: z.string().min(1).optional(),
    current: z.string().min(1).nullable().optional(),
    target: z.string().min(1).nullable().optional(),
    pending: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  active_runs: z.number().int().nonnegative(),
  maintenance_mode: z.boolean(),
  supports_features: z.array(z.string().min(1)),
  interactive_sessions: z.object({
    window_ms: z.number().int().nonnegative(),
    scanned_at: z.string().datetime(),
    codex: z.number().int().nonnegative(),
    claude: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    status: openStringEnum(["ok", "unavailable"]).optional(),
    reason: openStringEnum(["timeout", "error"]).optional(),
    timed_out_ms: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

function makeAdminReconcileResultSchema(mode: "producer" | "rolling_consumer") {
  const boundedString = (maximum: number) => mode === "producer"
    ? z.string().min(1).max(maximum)
    : z.string().min(1);
  const unresolvedSchema = z.array(z.object({
    reason: z.enum(CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS),
    count: z.number().int().positive(),
  }).strict());
  const noncanonicalDirectoriesSchema = z.array(z.object({
    directory_name: boundedString(CALYX_ADMIN_RECONCILE_DIRECTORY_NAME_MAX_LENGTH),
    status: z.enum([
      "quarantined",
      "already_absent",
      "requires_operator_migration",
      "quarantine_failed",
    ]),
    record_state: boundedString(CALYX_ADMIN_RECONCILE_RECORD_STATE_MAX_LENGTH).optional(),
  }).strict());
  return z.object({
    schema_version: z.literal(CALYX_ADMIN_RECONCILE_SCHEMA_VERSION),
    status: z.enum(["completed", "incomplete"]),
    scanned: z.number().int().nonnegative(),
    changed: z.object({
      rebuilt: z.number().int().nonnegative(),
      repair_pending: z.number().int().nonnegative(),
      classified: z.number().int().nonnegative(),
      adopted: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      unresolved: z.number().int().nonnegative(),
      noncanonical_directories: z.number().int().nonnegative(),
    }).strict(),
    unresolved: mode === "producer"
      ? unresolvedSchema.max(CALYX_ADMIN_RECONCILE_UNRESOLVED_REASONS.length)
      : unresolvedSchema,
    noncanonical_directories: mode === "producer"
      ? noncanonicalDirectoriesSchema.max(CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS)
      : noncanonicalDirectoriesSchema,
    projection: z.discriminatedUnion("status", [
      z.object({ status: z.literal("repaired"), row_count: z.number().int().nonnegative() }).strict(),
      z.object({ status: z.literal("not_configured") }).strict(),
      z.object({ status: z.literal("failed") }).strict(),
    ]),
    completed_at: z.string().datetime(),
  }).strict().superRefine((value, context) => {
  const unresolvedReasonSet = new Set(value.unresolved.map((entry) => entry.reason));
  if (unresolvedReasonSet.size !== value.unresolved.length) {
    context.addIssue({
      code: "custom",
      path: ["unresolved"],
      message: "unresolved reasons must be unique",
    });
  }
  const unresolvedCount = value.unresolved.reduce((total, entry) => total + entry.count, 0);
  if (unresolvedCount !== value.changed.unresolved) {
    context.addIssue({
      code: "custom",
      path: ["changed", "unresolved"],
      message: "changed.unresolved must equal the unresolved reason histogram sum",
    });
  }
  const expectedCurrentExamples = Math.min(
    value.changed.noncanonical_directories,
    CALYX_ADMIN_RECONCILE_NONCANONICAL_MAX_ITEMS,
  );
  const hasCurrentWriterExamples = value.noncanonical_directories.length === expectedCurrentExamples;
  const hasExactPredecessorExamples = mode === "rolling_consumer"
    && value.noncanonical_directories.length === value.changed.noncanonical_directories;
  if (!hasCurrentWriterExamples && !hasExactPredecessorExamples) {
    context.addIssue({
      code: "custom",
      path: ["noncanonical_directories"],
      message: mode === "producer"
        ? "noncanonical directory examples must correspond exactly to the authoritative changed count"
        : "noncanonical directories must be either the current bounded summary or the exact predecessor set",
    });
  }
  const hasKnownIncompleteSignal = value.changed.repair_pending > 0
    || value.changed.unresolved > 0
    || value.unresolved.length > 0
    || value.changed.noncanonical_directories > 0
    || value.projection.status === "failed";
  if (hasKnownIncompleteSignal && value.status !== "incomplete") {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "known incomplete reconciliation signals require incomplete status",
    });
  }
  });
}

/** Strict current-writer schema used before the server emits a v1 receipt. */
export const adminReconcileResultSchema = makeAdminReconcileResultSchema("producer");
/** Rolling-fleet reader schema, including the known unbounded predecessor v1 writer. */
export const adminReconcileConsumerResultSchema = makeAdminReconcileResultSchema("rolling_consumer");

export const CONSUMER_SUMMARY_MAX_CHARS = 240;
export const CONSUMER_BRANCH_MAX_CHARS = 256;
export const CONSUMER_PR_URL_MAX_CHARS = 2_048;
export const CONSUMER_PORTABLE_ID_MAX_CHARS = 1_024;
export const CONSUMER_HOST_MAX_CHARS = 255;
export const CONSUMER_BACKEND_MAX_CHARS = 64;
export const CONSUMER_TIMESTAMP_MAX_CHARS = 64;
export const CONSUMER_PRESET_MAX_CHARS = 128;
export const CONSUMER_RUN_LOCATOR_MAX_CHARS = 260;
export const CONSUMER_ROUTE_LOCATOR_MAX_CHARS = 4_096;
export const CONSUMER_CURSOR_MAX_CHARS = 4_096;
export const CONSUMER_MIME_TYPE_MAX_CHARS = 255;
export const CONSUMER_MESSAGE_SUBJECT_MAX_CHARS = 500;
export const CONSUMER_MESSAGE_REFERENCE_MAX_CHARS = 512;
export const CONSUMER_ACTIVITY_REPO_REF_MAX_CHARS = 128;
export const CONSUMER_ACTIVITY_WORKTREE_REF_MAX_CHARS = 128;
export const CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS = 320;

export const CONSUMER_ACTIVITY_ATTENTION_STATES = [
  "working",
  "awaiting",
  "idle",
  "unknown",
] as const;
export type ConsumerActivityAttentionState = (typeof CONSUMER_ACTIVITY_ATTENTION_STATES)[number];

export interface ConsumerActivityAttentionProjection {
  attention_state: ConsumerActivityAttentionState;
  latest_visible_message_excerpt?: string | undefined;
  visible_message_count?: number | undefined;
}

const boundedSummarySchema = z.string().max(CONSUMER_SUMMARY_MAX_CHARS);
const boundedTimestampSchema = z.string().max(CONSUMER_TIMESTAMP_MAX_CHARS).datetime();
const consumerPortableIdSchema = z.string().min(1).max(CONSUMER_PORTABLE_ID_MAX_CHARS);
const consumerHostSchema = z.string().min(1).max(CONSUMER_HOST_MAX_CHARS);
const consumerBackendSchema = z.string().min(1).max(CONSUMER_BACKEND_MAX_CHARS);
const consumerRunLocatorSchema = z.string()
  .min(1)
  .max(CONSUMER_RUN_LOCATOR_MAX_CHARS)
  .regex(/^run:/u);
const consumerRouteLocatorSchema = z.string()
  .min(1)
  .max(CONSUMER_ROUTE_LOCATOR_MAX_CHARS)
  .startsWith("/v1/");
const consumerCursorSchema = z.string().min(1).max(CONSUMER_CURSOR_MAX_CHARS);
const consumerMimeTypeSchema = z.string()
  .min(1)
  .max(CONSUMER_MIME_TYPE_MAX_CHARS)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u);
const closedSafetyReceiptDescription =
  `${CALYX_CLOSED_RESPONSE_OBJECT_DESCRIPTION_PREFIX}safety-redaction-receipt`;

const consumerActivityAttentionStateSchema = z.enum(CONSUMER_ACTIVITY_ATTENTION_STATES);
const consumerActivityRepoRefSchema = z.string()
  .min(1)
  .max(CONSUMER_ACTIVITY_REPO_REF_MAX_CHARS)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u);
const consumerActivityWorktreeRefSchema = z.string()
  .min(1)
  .max(CONSUMER_ACTIVITY_WORKTREE_REF_MAX_CHARS)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u);
const consumerActivityMessageExcerptSchema = z.string()
  .min(1)
  .max(CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS);

const runObservationCommonShape = {
  schema_version: z.literal("calyx.run-observation/v1"),
  run_id: z.string().min(1).max(256),
  short_id: z.string().min(1).max(12),
  host: z.string().min(1).max(255),
  backend: z.string().min(1).max(64),
  status: z.string().min(1).max(64),
  health: z.string().min(1).max(64),
  created_at: boundedTimestampSchema,
  updated_at: boundedTimestampSchema,
  last_progress_at: boundedTimestampSchema.optional(),
  summary: boundedSummarySchema.optional(),
};

const runObservationRunSchema = z.object({
  ...runObservationCommonShape,
  kind: z.literal("run"),
  issue: z.string().min(1).max(128).optional(),
  branch: z.string().min(1).max(CONSUMER_BRANCH_MAX_CHARS).optional(),
  pr_url: z.string().max(CONSUMER_PR_URL_MAX_CHARS).url().optional(),
}).strict();

const runObservationInteractiveSchema = z.object({
  ...runObservationCommonShape,
  kind: z.literal("interactive"),
  // Optional on the rolling v1 reader so this additive projection remains
  // compatible with the exact predecessor. Current interactive producers emit it.
  attention_state: consumerActivityAttentionStateSchema.optional(),
  repo_ref: consumerActivityRepoRefSchema.optional(),
  worktree_ref: consumerActivityWorktreeRefSchema.optional(),
  latest_visible_message_excerpt: consumerActivityMessageExcerptSchema.optional(),
  visible_message_count: z.number().int().nonnegative().optional(),
}).strict();

export const runObservationSchema = z.discriminatedUnion("kind", [
  runObservationRunSchema,
  runObservationInteractiveSchema,
]);

const consumerEventCursorSchema = z.string()
  .min(1)
  .max(GLOBAL_EVENT_CURSOR_MAX_LENGTH)
  // The wire pattern intentionally rejects NUL/CR/LF framing controls.
  // eslint-disable-next-line no-control-regex
  .regex(new RegExp("^[^\\u0000\\r\\n]+$", "u"), "must not contain SSE framing characters")
  .refine(isGlobalEventCursor, "must be a safe opaque global-event cursor");

export const runObservationEventSchema = z.object({
  schema_version: z.literal("calyx.run-observation-event/v1"),
  cursor: consumerEventCursorSchema,
  event_type: openStringEnum(["run.terminal", "run.progress", "run.warning"]),
  emitted_at: boundedTimestampSchema,
  run: runObservationRunSchema,
}).strict();

export const runObservationGapEventSchema = z.object({
  schema_version: z.literal("calyx.run-observation-gap/v1"),
  cursor: consumerEventCursorSchema,
  event_type: z.literal("run.projection_gap"),
  gap: z.object({
    reason: z.literal("source_event_unrepresentable"),
    source_event_type: z.enum(["run.terminal", "run.progress", "run.warning"]),
  }).strict().describe(closedSafetyReceiptDescription),
}).strict().describe(closedSafetyReceiptDescription);

export const runObservationStreamEventSchema = z.discriminatedUnion("schema_version", [
  runObservationEventSchema,
  runObservationGapEventSchema,
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}run-observation-stream-event`);

export type RunObservation = z.infer<typeof runObservationSchema>;
export type RunObservationStreamEvent = z.infer<typeof runObservationStreamEventSchema>;

const deliveryTimestampSchema = boundedTimestampSchema;
const deliverySummarySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("none"),
    attempted: z.literal(0),
    delivered: z.literal(0),
    failed: z.literal(0),
  }).strict(),
  z.object({
    state: z.literal("pending"),
    attempted: z.number().int().positive(),
    delivered: z.literal(0),
    failed: z.number().int().nonnegative(),
    last_delivery_at: deliveryTimestampSchema,
  }).strict(),
  z.object({
    state: z.literal("delivered"),
    attempted: z.number().int().positive(),
    delivered: z.number().int().positive(),
    failed: z.literal(0),
    last_delivery_at: deliveryTimestampSchema,
  }).strict(),
  z.object({
    state: z.literal("partial"),
    attempted: z.number().int().positive(),
    delivered: z.number().int().positive(),
    failed: z.number().int().nonnegative(),
    last_delivery_at: deliveryTimestampSchema,
  }).strict(),
  z.object({
    state: z.literal("failed"),
    attempted: z.number().int().positive(),
    delivered: z.literal(0),
    failed: z.number().int().positive(),
    last_delivery_at: deliveryTimestampSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.attempted < value.delivered + value.failed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "attempted must cover delivered plus failed" });
  }
  const invalidState = value.state === "delivered"
      ? value.attempted === 0 || value.delivered !== value.attempted || value.failed !== 0
      : value.state === "failed"
        ? value.attempted === 0 || value.failed !== value.attempted || value.delivered !== 0
        : value.state === "partial"
          ? value.attempted === 0 || value.delivered === 0 || value.delivered >= value.attempted
          : value.state === "pending"
            ? value.attempted === 0 || value.delivered !== 0 || value.failed >= value.attempted
            : false;
  if (invalidState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "state must agree with attempted, delivered, and failed counts",
    });
  }
}).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}monitor-delivery-summary`);

export const monitorObservationSchema = z.object({
  schema_version: z.literal("calyx.monitor-observation/v1"),
  monitor_id: consumerPortableIdSchema,
  status: openStringEnum(MONITOR_STATUSES),
  preset: z.string().min(1).max(CONSUMER_PRESET_MAX_CHARS),
  run_locator: consumerRunLocatorSchema.optional(),
  created_at: boundedTimestampSchema,
  updated_at: boundedTimestampSchema,
  delivery_summary: deliverySummarySchema,
  wake_count: z.number().int().nonnegative(),
}).strict();

export const wakeObservationSchema = z.object({
  schema_version: z.literal("calyx.wake-observation/v1"),
  wake_id: consumerPortableIdSchema,
  monitor_id: consumerPortableIdSchema,
  status: openStringEnum(MONITOR_WAKE_STATUSES),
  created_at: boundedTimestampSchema,
  run_locator: consumerRunLocatorSchema.optional(),
  reason_summary: boundedSummarySchema,
  receipt_locator: z.object({ host: consumerHostSchema, route: consumerRouteLocatorSchema }).strict(),
}).strict();

export type MonitorObservation = z.infer<typeof monitorObservationSchema>;
export type WakeObservation = z.infer<typeof wakeObservationSchema>;

const activityMessageObservationCommonShape = {
  id: consumerPortableIdSchema,
  role: z.enum(["human", "assistant"]),
  text: z.string().max(4_000).optional(),
  summary: boundedSummarySchema,
  timestamp: boundedTimestampSchema.optional(),
  truncated: z.boolean(),
};

const activityMessageObservationSchema = z.object({
  ...activityMessageObservationCommonShape,
  activity_id: consumerPortableIdSchema,
  turn_id: consumerPortableIdSchema.optional(),
}).strict();

const activityTurnMessageObservationSchema = z.object({
  ...activityMessageObservationCommonShape,
}).strict();

const activityMessagesObservationCommonShape = {
  schema_version: z.literal("activity.messages/v1"),
  activity_id: consumerPortableIdSchema,
  backend: consumerBackendSchema,
  session_id: consumerPortableIdSchema,
  host: consumerHostSchema.optional(),
  total_messages: z.number().int().nonnegative(),
  matched_messages: z.number().int().nonnegative(),
  messages: z.array(activityMessageObservationSchema).max(100),
};

export const activityMessagesObservationSchema = z.discriminatedUnion("truncated", [
  z.object({
    ...activityMessagesObservationCommonShape,
    truncated: z.literal(false),
  }).strict(),
  z.object({
    ...activityMessagesObservationCommonShape,
    truncated: z.literal(true),
    next_cursor: consumerCursorSchema,
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}activity-messages-page`);

const activityMessagesRecoverySchema = z.object({
  operation_id: z.literal("activity.messages"),
}).strict();

const activityTurnObservationCommonShape = {
  turn_id: consumerPortableIdSchema,
  index: z.number().int().nonnegative(),
  role: z.enum(["human", "assistant"]),
  state: z.enum(["complete", "in_flight"]),
  started_at: boundedTimestampSchema.optional(),
  ended_at: boundedTimestampSchema.optional(),
  summary: boundedSummarySchema,
  messages: z.array(activityTurnMessageObservationSchema).max(100),
};

const activityTurnObservationSchema = z.discriminatedUnion("messages_truncated", [
  z.object({
    ...activityTurnObservationCommonShape,
    messages_truncated: z.literal(false),
  }).strict(),
  z.object({
    ...activityTurnObservationCommonShape,
    messages_truncated: z.literal(true),
    omitted_message_count: z.number().int().min(1),
    messages_recovery: activityMessagesRecoverySchema,
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}activity-turn-messages-page`);

const activityTurnsObservationCommonShape = {
  schema_version: z.literal("activity.turns/v1"),
  activity_id: consumerPortableIdSchema,
  backend: consumerBackendSchema,
  session_id: consumerPortableIdSchema,
  host: consumerHostSchema.optional(),
  total_turns: z.number().int().nonnegative(),
  matched_turns: z.number().int().nonnegative(),
  turns: z.array(activityTurnObservationSchema).max(100),
};

export const activityTurnsObservationSchema = z.discriminatedUnion("truncated", [
  z.object({
    ...activityTurnsObservationCommonShape,
    truncated: z.literal(false),
  }).strict(),
  z.object({
    ...activityTurnsObservationCommonShape,
    truncated: z.literal(true),
    next_cursor: consumerCursorSchema,
  }).strict(),
]).describe(`${CALYX_EXCLUSIVE_RESPONSE_UNION_DESCRIPTION_PREFIX}activity-turns-page`);

export const activityTextObservationSchema = z.object({
  schema_version: z.literal("activity.text/v1"),
  activity_id: consumerPortableIdSchema,
  backend: consumerBackendSchema,
  session_id: consumerPortableIdSchema,
  message_id: consumerPortableIdSchema,
  text: z.string().max(4_000),
  text_cursor: z.object({
    total_chars: z.number().int().nonnegative(),
    returned: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])),
    next: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

export const activityAttachmentObservationSchema = z.object({
  ref: z.string().regex(/^att:sha256:[0-9a-f]{64}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime_type: consumerMimeTypeSchema,
  byte_size: z.number().int().nonnegative(),
  exact_bytes_available: z.boolean(),
  activity_id: consumerPortableIdSchema,
  message_id: consumerPortableIdSchema,
  detail: openStringEnum(["resized", "original"]).optional(),
  origin_host: consumerHostSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.ref !== `att:sha256:${value.sha256}`) {
    context.addIssue({
      code: "custom",
      path: ["ref"],
      message: "attachment ref must encode the exact sha256 digest",
    });
  }
});

const messageAddressSchema = z.string().min(1).max(512).refine((value) => !/\s/.test(value), {
  message: "message addresses must not contain whitespace",
});

const requestNonEmptyString = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => value.trim().length > 0,
  { message: "must contain a non-whitespace character" },
);
const requestIdempotencyKey = z.string().min(1).max(256).regex(
  /^\S+$/u,
  "idempotency keys must not contain whitespace",
);

const activityMarkCanonicalString = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value.trim() === value, "must not have leading or trailing whitespace")
  .refine((value) => [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 0x1f && codePoint !== 0x7f;
  }), "must not contain control characters");
const activityMarkTimestampSchema = boundedTimestampSchema
  .refine(isCanonicalApiTimestamp, "must be a canonical UTC ISO timestamp");
const activityMarkProvenanceSchema = z.object({
  schema_version: z.literal("calyx.provenance/v1"),
  request_id: z.string().regex(new RegExp(API_REQUEST_ID_PATTERN_SOURCE, "u")),
  subject: z.string().regex(new RegExp(API_PROVENANCE_SUBJECT_PATTERN_SOURCE, "u")),
  asserted_actor: z.string()
    .max(256)
    .regex(new RegExp(API_ASSERTED_ACTOR_PATTERN_SOURCE, "u"))
    .optional(),
  host: z.string().regex(new RegExp(API_PROVENANCE_HOST_PATTERN_SOURCE, "u")),
  via: z.literal("http"),
  at: activityMarkTimestampSchema,
}).strict();

export const activityMarkCreateRequestSchema = z.object({
  schema_version: z.literal("calyx.activity-mark-create-request/v1"),
  idempotency_key: requestIdempotencyKey,
  target_kind: z.enum(ACTIVITY_MARK_TARGET_KINDS),
  // Identity grammar is resolved after replay admission so plausible invalid
  // aliases and prefixes join the non-leaking mark_target_unknown class.
  target_id: activityMarkCanonicalString(ACTIVITY_MARK_TARGET_ID_MAX_CHARS),
  kind: z.enum(ACTIVITY_MARK_KINDS),
  reason: activityMarkCanonicalString(ACTIVITY_MARK_REASON_MAX_CHARS).optional(),
}).strip();

export const activityMarkListQuerySchema = z.object({
  kind: z.enum(ACTIVITY_MARK_KINDS).optional(),
  target_kind: z.enum(ACTIVITY_MARK_TARGET_KINDS).optional(),
  target_id: activityMarkCanonicalString(ACTIVITY_MARK_TARGET_ID_MAX_CHARS).optional(),
  since: activityMarkTimestampSchema.optional(),
  limit: z.string()
    .regex(/^(?:[1-9]|[1-9]\d|100)$/u, `must be an integer from 1 through ${ACTIVITY_MARK_LIST_MAX_LIMIT}`)
    .optional(),
  cursor: z.string().min(1).max(ACTIVITY_MARK_CURSOR_MAX_CHARS).optional(),
}).strip().superRefine((value, context) => {
  if (value.target_kind && value.target_id) {
    try {
      parseActivityMarkTargetId(value.target_kind, value.target_id);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_id"],
        message: error instanceof Error ? error.message : "target_id is not canonical",
      });
    }
  }
});

const activityMarkResponseShape = {
  mark_id: z.string().regex(new RegExp(ACTIVITY_MARK_ID_PATTERN_SOURCE, "u")),
  marked_by: z.string().regex(new RegExp(API_PROVENANCE_SUBJECT_PATTERN_SOURCE, "u")),
  target_kind: z.enum(ACTIVITY_MARK_TARGET_KINDS),
  target_id: activityMarkCanonicalString(ACTIVITY_MARK_TARGET_ID_MAX_CHARS),
  kind: z.enum(ACTIVITY_MARK_KINDS),
  reason: activityMarkCanonicalString(ACTIVITY_MARK_REASON_MAX_CHARS).optional(),
  marked_at: activityMarkTimestampSchema,
  created_provenance: activityMarkProvenanceSchema,
};

interface ActivityMarkAuthorityValue {
  marked_by: string;
  target_kind: (typeof ACTIVITY_MARK_TARGET_KINDS)[number];
  target_id: string;
  marked_at: string;
  created_provenance: { subject: string; at: string };
  revoked_at?: string;
  revoked_provenance?: { at: string };
}

function refineActivityMarkAuthority(
  value: ActivityMarkAuthorityValue,
  context: z.RefinementCtx,
  includeRevocation: boolean,
): void {
  for (const [left, right, path, message] of [
    [value.marked_by, value.created_provenance.subject, ["marked_by"], "marked_by must equal created_provenance.subject"],
    [value.marked_at, value.created_provenance.at, ["marked_at"], "marked_at must equal created_provenance.at"],
  ] as const) {
    if (left !== right) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message });
  }
  if (includeRevocation && value.revoked_at !== value.revoked_provenance?.at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revoked_at"],
      message: "revoked_at must equal revoked_provenance.at",
    });
  }
  try {
    parseActivityMarkTargetId(value.target_kind, value.target_id);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_id"],
      message: error instanceof Error ? error.message : "target_kind and target_id are inconsistent",
    });
  }
}

export const activityMarkSchema = z.object({
  schema_version: z.literal("calyx.activity-mark/v1"),
  ...activityMarkResponseShape,
}).strict().superRefine((value, context) => refineActivityMarkAuthority(value, context, false));

export const activityMarkRevocationSchema = z.object({
  schema_version: z.literal("calyx.activity-mark-revocation/v1"),
  ...activityMarkResponseShape,
  revoked_at: activityMarkTimestampSchema,
  revoked_provenance: activityMarkProvenanceSchema,
}).strict().superRefine((value, context) => refineActivityMarkAuthority(value, context, true));

const activityMarkListCommonShape = {
  schema_version: z.literal("calyx.activity-mark-list/v1"),
  snapshot_at: activityMarkTimestampSchema,
  marks: z.array(activityMarkSchema).max(ACTIVITY_MARK_LIST_MAX_LIMIT),
};

export const activityMarkListSchema = z.discriminatedUnion("truncated", [
  z.object({
    ...activityMarkListCommonShape,
    truncated: z.literal(false),
  }).strict(),
  z.object({
    ...activityMarkListCommonShape,
    truncated: z.literal(true),
    next_cursor: z.string().min(1).max(ACTIVITY_MARK_CURSOR_MAX_CHARS),
  }).strict(),
]).describe("calyx-bounded-page:marks:no-count");

export type ActivityMarkCreateRequest = z.infer<typeof activityMarkCreateRequestSchema>;
export type ActivityMark = z.infer<typeof activityMarkSchema>;
export type ActivityMarkRevocation = z.infer<typeof activityMarkRevocationSchema>;
export type ActivityMarkList = z.infer<typeof activityMarkListSchema>;

function activityMarkResponseFields(source: ActivityMarkRow) {
  return {
    mark_id: source.mark_id,
    marked_by: source.subject,
    target_kind: source.target_kind,
    target_id: source.target_id,
    kind: source.kind,
    ...(source.reason === null ? {} : { reason: source.reason }),
    marked_at: source.marked_at,
    created_provenance: source.created_provenance,
  };
}

function activityMarksProjectionError(error: unknown): never {
  if (error instanceof ActivityMarksStateError) throw error;
  throw new ActivityMarksStateError(
    "activity_marks_schema_unavailable",
    `Activity marks state cannot be projected through the consumer contract: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function toActivityMark(source: ActivityMarkRow): ActivityMark {
  try {
    return activityMarkSchema.parse({
      schema_version: "calyx.activity-mark/v1",
      ...activityMarkResponseFields(source),
    });
  } catch (error) {
    return activityMarksProjectionError(error);
  }
}

export function toActivityMarkRevocation(source: ActivityMarkRow): ActivityMarkRevocation {
  if (source.revoked_at === null || source.revoked_provenance === null) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      `Activity mark ${source.mark_id} has not been revoked or carries incomplete revocation authority.`,
    );
  }
  try {
    return activityMarkRevocationSchema.parse({
      schema_version: "calyx.activity-mark-revocation/v1",
      ...activityMarkResponseFields(source),
      revoked_at: source.revoked_at,
      revoked_provenance: source.revoked_provenance,
    });
  } catch (error) {
    return activityMarksProjectionError(error);
  }
}

export function toActivityMarkList(source: ActivityMarkListPage): ActivityMarkList {
  try {
    return activityMarkListSchema.parse({
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: source.snapshot_at,
      truncated: source.truncated,
      ...(source.truncated ? { next_cursor: source.next_cursor } : {}),
      marks: source.marks.map(toActivityMark),
    });
  } catch (error) {
    return activityMarksProjectionError(error);
  }
}

export const msgSendRequestSchema = z.object({
  schema_version: z.literal("calyx.msg-send/v1"),
  idempotency_key: requestIdempotencyKey,
  recipient_address: messageAddressSchema,
  reply_address: messageAddressSchema,
  subject: requestNonEmptyString(500),
  body: z.string().max(100_000).optional(),
  thread_key: requestNonEmptyString(512).optional(),
  reply_to: requestNonEmptyString(512).optional(),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  ack_required: z.boolean().optional(),
  expires_at: z.string().datetime().optional(),
}).strip();

export type MsgSendRequest = z.infer<typeof msgSendRequestSchema>;

export const messageObservationSchema = z.object({
  schema_version: z.literal("calyx.message-observation/v1"),
  message_id: consumerPortableIdSchema,
  sender: messageAddressSchema,
  recipient_address: messageAddressSchema,
  recipient_class: openStringEnum(["directed", "scope"]),
  subject: z.string().max(CONSUMER_MESSAGE_SUBJECT_MAX_CHARS),
  body: z.string().max(4_000),
  body_truncated: z.boolean(),
  body_total_chars: z.number().int().nonnegative(),
  body_locator: consumerRouteLocatorSchema.regex(/^\/v1\/message-text\//),
  thread_key: z.string().min(1).max(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS).optional(),
  reply_to: z.string().min(1).max(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS).optional(),
  urgency: openStringEnum(["low", "normal", "high"]),
  ack_required: z.boolean(),
  expires_at: boundedTimestampSchema.optional(),
  status: openStringEnum(MESSAGE_STATUSES),
  created_at: boundedTimestampSchema,
  updated_at: boundedTimestampSchema,
}).strict();

export type MessageObservation = z.infer<typeof messageObservationSchema>;

export const leaseObservationSchema = z.object({
  schema_version: z.literal("calyx.lease-observation/v1"),
  lease_id: z.string().regex(/^[a-f0-9]{64}$/),
  resource_kind: openStringEnum(["worktree", "session", "vault", "issue"]),
  owner_host: consumerHostSchema,
  holder_locator: consumerPortableIdSchema,
  acquired_at: boundedTimestampSchema,
  renewed_at: boundedTimestampSchema.optional(),
  expires_at: boundedTimestampSchema,
  status: openStringEnum(["active", "expired"]),
}).strict();

export function toAdminHealth(source: CalyxDaemonHealth): CalyxAdminHealth {
  return adminHealthSchema.parse({
    schema_version: CALYX_ADMIN_HEALTH_SCHEMA_VERSION,
    protocol_epoch: source.protocol_epoch,
    daemon_kind: source.daemon_kind,
    daemon_id: source.daemon_id,
    ...(source.advertised_host ? { advertised_host: source.advertised_host } : {}),
    uptime_ms: source.uptime_ms,
    started_at: source.started_at,
    build: source.build,
    ...(source.promoted_build
      ? {
          promoted_build: {
            status: source.promoted_build.status,
            ...(source.promoted_build.build ? { build: source.promoted_build.build } : {}),
          },
        }
      : {}),
    ...(source.clone_head
      ? {
          clone_head: {
            status: source.clone_head.status,
            ...(source.clone_head.git_head ? { git_head: source.clone_head.git_head } : {}),
          },
        }
      : {}),
    // The internal summary's `error` stays off the consumer wire, matching
    // `promoted_build`: operators get the status, the daemon log gets the cause.
    ...(source.state_schema
      ? {
          state_schema: {
            status: source.state_schema.status,
            ...(source.state_schema.driver ? { driver: source.state_schema.driver } : {}),
            ...(source.state_schema.current !== undefined
              ? { current: source.state_schema.current }
              : {}),
            ...(source.state_schema.target !== undefined
              ? { target: source.state_schema.target }
              : {}),
            ...(source.state_schema.pending !== undefined
              ? { pending: source.state_schema.pending }
              : {}),
          },
        }
      : {}),
    active_runs: source.active_runs,
    maintenance_mode: source.maintenance_mode,
    supports_features: [...source.supports_features],
    ...(source.interactive_sessions
      ? {
          interactive_sessions: {
            window_ms: source.interactive_sessions.window_ms,
            scanned_at: source.interactive_sessions.scanned_at,
            codex: source.interactive_sessions.codex,
            claude: source.interactive_sessions.claude,
            total: source.interactive_sessions.total,
            ...(source.interactive_sessions.status ? { status: source.interactive_sessions.status } : {}),
            ...(source.interactive_sessions.reason ? { reason: source.interactive_sessions.reason } : {}),
            ...(source.interactive_sessions.timed_out_ms !== undefined
              ? { timed_out_ms: source.interactive_sessions.timed_out_ms }
              : {}),
          },
        }
      : {}),
  }) as CalyxAdminHealth;
}

function shortId(id: string): string {
  const finalSegment = id.split(":").at(-1) ?? id;
  return finalSegment.slice(0, 12);
}

function projectHttpUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.trim().length > CONSUMER_PR_URL_MAX_CHARS
  ) return undefined;
  try {
    const parsed = new URL(value.trim());
    const projected = `${parsed.origin}${parsed.pathname}`;
    return projected.length <= CONSUMER_PR_URL_MAX_CHARS
      && (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0
      ? projected
      : undefined;
  } catch {
    return undefined;
  }
}

function projectOptionalBoundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars
    ? value
    : undefined;
}

function projectActivityWorkspaceRefs(cwd: unknown): {
  repoRef: string;
  worktreeRef?: string;
} | undefined {
  if (typeof cwd !== "string") return undefined;
  const match = /(?:^|\/)dev\/([^/]+)(?:(?:\/dev)(?:\/|$)|(?:\/wt\/([^/]+))(?:\/|$)|(?:\/public\/[^/]+)(?:\/|$)|$)/u.exec(cwd);
  const repoRef = match?.[1];
  if (!repoRef || !consumerActivityRepoRefSchema.safeParse(repoRef).success) return undefined;
  const worktreeCandidate = match?.[2];
  const worktreeRef = worktreeCandidate
    && consumerActivityWorktreeRefSchema.safeParse(worktreeCandidate).success
    ? worktreeCandidate
    : undefined;
  return {
    repoRef,
    ...(worktreeRef ? { worktreeRef } : {}),
  };
}

function projectActivityMessageExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

export function toRunObservation(
  entry: RunListEntry,
  record?: RunRecord,
): RunObservation {
  const prUrl = projectHttpUrl(record?.intent.metadata?.["pr_url"]);
  const issue = projectOptionalBoundedString(entry.issue, 128);
  const branch = projectOptionalBoundedString(record?.intent.branch, CONSUMER_BRANCH_MAX_CHARS);
  const host = projectOptionalBoundedString(entry.host ?? record?.intent.host, 255) ?? "unknown";
  return runObservationSchema.parse({
    schema_version: "calyx.run-observation/v1",
    run_id: entry.run_id,
    short_id: shortId(entry.run_id),
    kind: "run",
    ...(issue ? { issue } : {}),
    host,
    backend: entry.backend ?? record?.intent.backend ?? "unknown",
    status: entry.state,
    health: entry.health_status ?? record?.health?.status ?? "unknown",
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    ...(entry.last_progress_at ? { last_progress_at: entry.last_progress_at } : {}),
    ...(branch ? { branch } : {}),
    ...(prUrl ? { pr_url: prUrl } : {}),
    summary: `Run ${shortId(entry.run_id)} is ${entry.state}.`,
  });
}

export function toInteractiveObservation(
  entry: InteractiveSessionListEntry,
  attention: ConsumerActivityAttentionProjection = { attention_state: "unknown" },
): RunObservation {
  const host = projectOptionalBoundedString(entry.host, 255) ?? "unknown";
  const workspaceRefs = projectActivityWorkspaceRefs(entry.cwd);
  const latestVisibleMessageExcerpt = projectActivityMessageExcerpt(
    attention.latest_visible_message_excerpt,
  );
  const candidateVisibleMessageCount = attention.visible_message_count;
  const visibleMessageCount = typeof candidateVisibleMessageCount === "number"
    && Number.isSafeInteger(candidateVisibleMessageCount)
    && candidateVisibleMessageCount >= 0
    ? candidateVisibleMessageCount
    : undefined;
  return runObservationSchema.parse({
    schema_version: "calyx.run-observation/v1",
    run_id: entry.run_id,
    short_id: shortId(entry.run_id),
    kind: "interactive",
    host,
    backend: entry.backend,
    status: entry.state,
    health: "unknown",
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    summary: `Interactive ${entry.backend} session ${shortId(entry.run_id)} is ${entry.state}.`,
    attention_state: attention.attention_state,
    ...(workspaceRefs
      ? {
          repo_ref: workspaceRefs.repoRef,
          ...(workspaceRefs.worktreeRef ? { worktree_ref: workspaceRefs.worktreeRef } : {}),
        }
      : {}),
    ...(latestVisibleMessageExcerpt
      ? { latest_visible_message_excerpt: latestVisibleMessageExcerpt }
      : {}),
    ...(visibleMessageCount !== undefined ? { visible_message_count: visibleMessageCount } : {}),
  });
}

export function toRunObservationEvent(event: CalyxRunEvent) {
  const issue = projectOptionalBoundedString(event.run.issue, 128);
  const branch = projectOptionalBoundedString(event.enrichment?.branch, CONSUMER_BRANCH_MAX_CHARS);
  const host = projectOptionalBoundedString(event.run.host, 255) ?? "unknown";
  return runObservationEventSchema.parse({
    schema_version: "calyx.run-observation-event/v1",
    cursor: event.cursor,
    event_type: event.event_type,
    emitted_at: event.emitted_at,
    run: {
      schema_version: "calyx.run-observation/v1",
      run_id: event.run.run_id,
      short_id: shortId(event.run.run_id),
      kind: "run",
      ...(issue ? { issue } : {}),
      host,
      backend: event.run.backend ?? "unknown",
      status: event.run.state,
      health: event.event_type === "run.warning" ? "warning" : event.run.state,
      created_at: event.run.created_at,
      updated_at: event.run.completed_at ?? event.run.started_at ?? event.emitted_at,
      ...(event.run.started_at ? { last_progress_at: event.run.started_at } : {}),
      ...(branch ? { branch } : {}),
      summary: `Run ${shortId(event.run.run_id)} emitted ${event.event_type}.`,
    },
  });
}

export function toRunObservationGapEvent(event: CalyxRunEvent) {
  return runObservationGapEventSchema.parse({
    schema_version: "calyx.run-observation-gap/v1",
    cursor: event.cursor,
    event_type: "run.projection_gap",
    gap: {
      reason: "source_event_unrepresentable",
      source_event_type: event.event_type,
    },
  });
}

type DeliveryAggregate = { attempted: number; delivered: number; failed: number; last_delivery_at: string | null };

function toDeliverySummary(deliveries: readonly MonitorDeliveryRow[] | DeliveryAggregate) {
  const aggregate = Array.isArray(deliveries) ? undefined : deliveries as DeliveryAggregate;
  const rows = Array.isArray(deliveries) ? deliveries : [];
  const delivered = aggregate?.delivered ?? rows.filter((delivery) => delivery.status === "delivered").length;
  const failed = aggregate?.failed ?? rows.filter((delivery) => delivery.status === "failed").length;
  const attempted = aggregate?.attempted ?? rows.length;
  const lastDeliveryAt = aggregate?.last_delivery_at ?? rows
    .map((delivery) => delivery.updated_at)
    .sort()
    .at(-1);
  const state = attempted === 0
    ? "none"
    : failed === attempted
      ? "failed"
      : delivered === attempted
        ? "delivered"
        : delivered > 0
          ? "partial"
          : "pending";
  return deliverySummarySchema.parse({
    state,
    attempted,
    delivered,
    failed,
    ...(lastDeliveryAt ? { last_delivery_at: lastDeliveryAt } : {}),
  });
}

export function toMonitorObservation(
  monitor: MonitorRow,
  deliveries: readonly MonitorDeliveryRow[] | DeliveryAggregate,
  wakeCount: number,
): MonitorObservation {
  return monitorObservationSchema.parse({
    schema_version: "calyx.monitor-observation/v1",
    monitor_id: monitor.monitor_id,
    status: monitor.status,
    preset: monitor.preset ?? "custom",
    ...(monitor.source_run_id ? { run_locator: `run:${monitor.source_run_id}` } : {}),
    created_at: monitor.created_at,
    updated_at: monitor.updated_at,
    delivery_summary: toDeliverySummary(deliveries),
    wake_count: wakeCount,
  });
}

export function toWakeObservation(
  wake: MonitorWakeRow,
  host: string,
  sourceRunId?: string | null,
): WakeObservation {
  const matched = wake.evaluation.matched ? "matched" : "did not match";
  return wakeObservationSchema.parse({
    schema_version: "calyx.wake-observation/v1",
    wake_id: wake.wake_id,
    monitor_id: wake.monitor_id,
    status: wake.status,
    created_at: wake.created_at,
    ...(sourceRunId ? { run_locator: `run:${sourceRunId}` } : {}),
    reason_summary: `Monitor predicate ${matched}.`,
    receipt_locator: {
      host,
      route: `/v1/monitors/wakes?monitor=${encodeURIComponent(wake.monitor_id)}`,
    },
  });
}

function activityMessagePortableSummary(role: string): string {
  switch (role) {
    case "human":
      return "Human message.";
    case "assistant":
      return "Assistant message.";
    default:
      return "Classified activity message.";
  }
}

function activityTurnPortableSummary(role: string, state: string): string {
  const roleLabel = role === "human"
    ? "Human"
    : role === "assistant"
      ? "Assistant"
      : "Classified activity";
  const stateLabel = state === "complete"
    ? "complete"
    : state === "in_flight"
      ? "in flight"
      : "in an unknown state";
  return `${roleLabel} turn is ${stateLabel}.`;
}

function toActivityMessageObservation(message: ActivityMessagesResult["messages"][number]) {
  const text = message.text?.slice(0, 4_000);
  return activityMessageObservationSchema.parse({
    id: message.id,
    activity_id: message.activity_id,
    ...(message.turn_id ? { turn_id: message.turn_id } : {}),
    role: message.role,
    ...(text ? { text } : {}),
    summary: activityMessagePortableSummary(message.role),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    truncated: message.truncated === true || Boolean(message.text && message.text.length > 4_000),
  });
}

function toActivityTurnMessageObservation(message: ActivityMessagesResult["messages"][number]) {
  const text = message.text?.slice(0, 4_000);
  return activityTurnMessageObservationSchema.parse({
    id: message.id,
    role: message.role,
    ...(text ? { text } : {}),
    summary: activityMessagePortableSummary(message.role),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    truncated: message.truncated === true || Boolean(message.text && message.text.length > 4_000),
  });
}

export function toActivityMessagesObservation(source: ActivityMessagesResult, nextCursor?: string) {
  const messages = source.messages.slice(0, 100).map(toActivityMessageObservation);
  return activityMessagesObservationSchema.parse({
    schema_version: "activity.messages/v1",
    activity_id: source.activity_id,
    backend: source.backend,
    session_id: source.session_id,
    ...(source.host ? { host: source.host } : {}),
    total_messages: source.total_messages,
    matched_messages: source.matched_messages,
    truncated: nextCursor !== undefined,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    messages,
  });
}

export function toActivityTurnsObservation(source: ActivityTurnsResult, nextCursor?: string) {
  const turns = source.turns.slice(0, 100).map((turn) => {
    const totalMessages = turn.messages.length;
    const messages = turn.messages.slice(0, 100).map(toActivityTurnMessageObservation);
    const messagesTruncated = totalMessages > messages.length;
    return activityTurnObservationSchema.parse({
      turn_id: turn.turn_id,
      index: turn.index,
      role: turn.role,
      state: turn.state,
      ...(turn.started_at ? { started_at: turn.started_at } : {}),
      ...(turn.ended_at ? { ended_at: turn.ended_at } : {}),
      summary: activityTurnPortableSummary(turn.role, turn.state),
      messages_truncated: messagesTruncated,
      ...(messagesTruncated
        ? {
            omitted_message_count: totalMessages - messages.length,
            messages_recovery: { operation_id: "activity.messages" as const },
          }
        : {}),
      messages,
    });
  });
  return activityTurnsObservationSchema.parse({
    schema_version: "activity.turns/v1",
    activity_id: source.activity_id,
    backend: source.backend,
    session_id: source.session_id,
    ...(source.host ? { host: source.host } : {}),
    total_turns: source.total_turns,
    matched_turns: source.matched_turns,
    truncated: nextCursor !== undefined,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    turns,
  });
}

export function toActivityTextObservation(source: ActivityTextResult) {
  const text = source.text.slice(0, 4_000);
  const returnedStart = source.text_cursor.returned[0]?.[0] ?? 0;
  const returnedEnd = Math.min(returnedStart + text.length, source.text_cursor.total_chars);
  return activityTextObservationSchema.parse({
    schema_version: "activity.text/v1",
    activity_id: source.activity_id,
    backend: source.backend,
    session_id: source.session_id,
    message_id: source.message_id,
    text,
    text_cursor: {
      total_chars: source.text_cursor.total_chars,
      returned: [[returnedStart, returnedEnd]],
      ...(source.text_cursor.next !== undefined || source.text.length > text.length
        ? { next: Math.min(source.text_cursor.next ?? returnedEnd, source.text_cursor.total_chars) }
        : {}),
    },
  });
}

export function toActivityAttachmentObservation(source: ActivityAttachmentRecord) {
  return activityAttachmentObservationSchema.parse({
    ref: source.ref,
    sha256: source.sha256,
    mime_type: source.mime_type,
    byte_size: source.byte_size,
    exact_bytes_available: source.exact_bytes_available,
    activity_id: source.activity_id,
    message_id: source.message_id,
    ...(source.detail ? { detail: source.detail } : {}),
    ...(source.origin_host ? { origin_host: source.origin_host } : {}),
  });
}

export function toMessageObservation(source: MessageRow, maxTextChars = 4_000): MessageObservation {
  const boundedChars = Math.max(0, Math.min(maxTextChars, 4_000));
  return messageObservationSchema.parse({
    schema_version: "calyx.message-observation/v1",
    message_id: source.message_id,
    sender: source.sender,
    recipient_address: source.recipient_address,
    recipient_class: source.recipient_class,
    subject: source.subject,
    body: source.body.slice(0, boundedChars),
    body_truncated: source.body.length > boundedChars,
    body_total_chars: source.body.length,
    body_locator: `/v1/message-text/${encodeURIComponent(source.message_id)}`,
    ...(source.thread_key ? { thread_key: source.thread_key } : {}),
    ...(source.reply_to ? { reply_to: source.reply_to } : {}),
    urgency: source.urgency,
    ack_required: source.ack_required,
    ...(source.expires_at ? { expires_at: source.expires_at } : {}),
    status: source.status,
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
}

export function toLeaseObservation(source: LeaseRow, now = new Date()): z.infer<typeof leaseObservationSchema> {
  return leaseObservationSchema.parse({
    schema_version: "calyx.lease-observation/v1",
    lease_id: createHash("sha256").update(source.key).digest("hex"),
    resource_kind: source.resource_kind,
    owner_host: source.owner_host,
    holder_locator: source.holder_activity_id,
    acquired_at: source.acquired_at,
    ...(source.renewed_at ? { renewed_at: source.renewed_at } : {}),
    expires_at: source.expires_at,
    status: Date.parse(source.expires_at) > now.getTime() ? "active" : "expired",
  });
}
