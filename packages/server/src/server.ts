import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, hostname as systemHostname, networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ZodError } from "zod";
import {
  MONITOR_CREATE_PROVENANCES,
  MONITOR_REARM_POLICIES,
  MONITOR_STATUSES,
  MONITOR_WAKE_STATUSES,
  MonitorWakeAckConflictError,
  HTTP_OPERATION_DESCRIPTORS,
  MessageCursorError,
  assertHttpOperationErrorDeclared,
  CALYX_DAEMON_FEATURES,
  CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
  CALYX_DAEMON_HEALTH_SCHEMA_VERSION,
  CALYX_DAEMON_METRICS_SCHEMA_VERSION,
  CALYX_ADMIN_RUN_LIST_MAX_ITEMS,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
  CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES,
  ActivityMarksStateError,
  encodeCalyxSseFrame,
  CALYX_RUN_SERVICE_DAEMON_KIND,
  OrchestrationLedgerSink,
  RunIndexProjection,
  RuntimeConfigApplyInProgressError,
  readPromotedCalyxBuild,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias,
  resolveRepo,
  ackMonitorWake,
  acquireLease,
  applyStateMigrations,
  classifyStateSchema,
  checkLeaseSchema,
  checkActivityMarksSchema,
  listLeases,
  parseLeaseKey,
  releaseLease,
  renewLease,
  stealLease,
  toCalyxDaemonBuildSummary,
  addressGranted,
  applyRuntimeConfig,
  cancelMonitor,
  claimMonitorWakes,
  checkMonitorSchema,
  checkMessageSchema,
  countAuthorizedMessages,
  countAuthorizedMessageReceiptMirrorsByStatus,
  countMonitorWakes,
  createMessage,
  createActivityMark,
  createMonitor,
  listMonitorDeliveries,
  listActivityMarksSnapshotPage,
  listMonitorWakes,
  listMonitors,
  listAuthorizedMessages,
  openStateStore,
  planRuntimeConfig,
  readMonitor,
  readMonitorWake,
  readMonitorDeliveryAggregate,
  readAuthorizedMessage,
  readMessage,
  readMessageOutbox,
  readLease,
  readApiIdempotency,
  recordApiIdempotency,
  revokeActivityMark,
  API_IDEMPOTENCY_CANONICALIZER,
  API_IDEMPOTENCY_SCHEMA_MAJOR,
  MSG_SEND_SEMANTIC_CANONICALIZER,
  canonicalizeJcs,
  hashCanonicalJcs,
  enqueueMessageOutbox,
  enqueueMessageReceiptMirror,
  drainMessageReceiptMirrors,
  executionCapableMessageAddressKind,
  resolveMessageAddress,
  sessionWakeDeliveryId,
  resolveHttpPathProfile,
  runnerSupervisionPredicate,
  toCalyxAdminReconcileResult,
  verifyRuntimeConfig,
  validateResolvedConsumerApiCredentialVerifiers,
  validateApiAssertedActor,
  validateApiProvenance,
  admitApiRequestAudit,
  apiRequestAuditDoctor,
  checkApiRequestAuditSchema,
  finalizeApiRequestAudit,
  listApiRequestAudits,
  markApiRequestAuditIndeterminate,
  normalizeAddressGrant,
  openExistingDirectoryDurable,
  planStateMigrations,
  createInterimWorkloadAdmissionReconciler,
  pruneApiRequestAudits,
  recoverAdmittedApiRequestAudits,
} from "@polli-labs/calyx-core";
import type {
  CalyxBuildInfo,
  CalyxDaemonFeature,
  CalyxDaemonCloneHeadSummary,
  CalyxDaemonHealth,
  CalyxDaemonMetrics,
  CalyxDaemonPromotedBuildSummary,
  CalyxDaemonStateSchemaSummary,
  CreateMonitorInput,
  MonitorCreateProvenance,
  MonitorDeliveryBindingV1,
  MonitorDeliveryRow,
  MonitorRearmPolicy,
  MonitorStatus,
  MonitorWakeStatus,
  LeaseResourceKind,
  RuntimeConfigComponent,
  RuntimeConfigOptions,
  RuntimeConfigResult,
  MessageRow,
  StateDriverDatabase,
  StateOpenOptions,
  InterfaceProfile,
  ResolvedConsumerApiCredentialVerifier,
  ApiProvenanceV1,
} from "@polli-labs/calyx-core";
import {
  DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS,
  EventReplayCursorError,
  RunAlreadyExistsError,
  RunIndexProjectionNotReadyError,
  RunListSnapshotChangedError,
  RunNotFoundError,
  RunService,
  WorkloadAdmissionBusyError,
  WorkloadAdmissionFencedError,
  routeSessionWake,
  defaultDaemonsRoot,
  detectSupervisor,
  initDaemonMetricsExporter,
  readDescriptor,
  readDaemonMemoryMetrics,
  readEventLoopLagMetrics,
  isTerminalState,
  pruneStaleDescriptors,
  removeDescriptorForPid,
  toCalyxStreamProjectionGapEvent,
  writeDescriptor,
} from "@polli-labs/calyx-run-service";

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
import type { DaemonMetricsExporterHandle } from "@polli-labs/calyx-run-service";
import type {
  ActivityAttachmentRecord,
  ActivityAttachmentRecordResult,
  ActivityAttachmentsSelectorInput,
  ActivityEventSelectorInput,
  ActivityMessageRole,
  ActivityMessageSelectorInput,
  ActivityTextSelectorInput,
  ActivityTurnRoleFilter,
  ActivityTurnSelectorInput,
  ActivityVisibilityTier,
  CalyxStreamEvent,
  CalyxRunEvent,
  CalyxStreamEventFilter,
  CalyxStreamEventType,
  InteractiveSessionBackend,
  InteractiveSessionEventRole,
  RunIntent,
  RunLogResult,
  RunObservationResult,
  RunRecord,
  RunActivityEntry,
  RunListEntry,
  MessageOutboxForwardResult,
  MessageOutboxObservationResult,
  SessionWakeDeliverRequestV1,
  SessionWakeRouteDependencies,
} from "@polli-labs/calyx-run-service";
import {
  ACTIVITY_MESSAGE_ROLES,
  ACTIVITY_TURN_ROLE_FILTERS,
  ACTIVITY_VISIBILITY_TIERS,
  ActivityAttachmentError,
  ActivityMarkTargetAmbiguousError,
  ActivityMarkTargetNotFoundError,
  ActivityMarkTargetUnavailableError,
  ActivityEventSelectorError,
  ActivityIdAmbiguousError,
  ActivityIdMalformedError,
  ActivityIdNotFoundError,
  InteractiveActivityProjectionNotReadyError,
  ActivityMessageNotFoundError,
  ActivityMessageSelectorError,
  ActivityRunMissingMetadataError,
  ActivityTurnSelectorError,
} from "@polli-labs/calyx-run-service";
import {
  authenticateRequest,
  authorizeRequestProfile,
} from "./auth.js";
import type { AuthenticatedRequestContext } from "./auth.js";
import { loadServerBuildInfo } from "./build-info.js";
import {
  CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
  toAdminHealth,
  toActivityMark,
  toActivityMarkList,
  toActivityMarkRevocation,
  toActivityAttachmentObservation,
  toActivityMessagesObservation,
  toActivityTextObservation,
  toActivityTurnsObservation,
  toInteractiveObservation,
  toLeaseObservation,
  toMonitorObservation,
  toMessageObservation,
  toRunObservation,
  toRunObservationEvent,
  toRunObservationGapEvent,
  toWakeObservation,
} from "./consumer-dtos.js";
import type {
  ActivityMarkCreateRequest,
  ConsumerActivityAttentionProjection,
  MsgSendRequest,
} from "./consumer-dtos.js";
import {
  resolveServerOperation,
  validateErrorEnvelope,
  validateOperationRequest,
  validateOperationSuccessResponse,
} from "./operations.js";

const execFile = promisify(execFileCallback);
const requestOperationIds = new WeakMap<IncomingMessage, string>();
const responseOperationIds = new WeakMap<ServerResponse, string>();
const validatedRequestBodies = new WeakMap<IncomingMessage, unknown>();
const requestAssertedActors = new WeakMap<IncomingMessage, string>();
const requestProvenances = new WeakMap<IncomingMessage, ApiProvenanceV1>();
const requestCorrelationIds = new WeakMap<IncomingMessage, string>();
const responseAuditResults = new WeakMap<ServerResponse, { status: number; error_code?: string | undefined }>();
const SERVER_PROCESS_INSTANCE_ID = `server_${randomUUID()}`;

export interface RunServerOptions {
  credentials: readonly ResolvedConsumerApiCredentialVerifier[];
  service?: RunService;
  host?: string;
  hostname?: () => string;
  port?: number;
  daemonId?: string;
  advertisedHost?: string;
  descriptorArgv?: string[];
  buildInfo?: CalyxBuildInfo;
  startedAt?: string;
  inheritedPath?: string;
  supportsFeatures?: CalyxDaemonFeature[];
  registryRoot?: string;
  stateStoreOptions?: StateOpenOptions;
  runtimeConfigRoots?: Readonly<Pick<RuntimeConfigOptions, "managedConfigsRoot" | "liveHome">>;
  /** Host-local authority served by admin.self-upgrade.receipt. */
  selfUpgradeReceiptRoot?: string;
  /** Deterministic receipt-root replacement seam after the first canonical proof. */
  afterSelfUpgradeReceiptRootValidatedBeforeRead?: () => Promise<void>;
  /** Exact configured fleet host identities mapped to their canonical host aliases. */
  messageHostAliases?: Readonly<Record<string, string>>;
  receiptMirrorRetryIntervalMs?: number;
  /**
   * Steady-state reconcile cadence (POL-1897). The boot reconcile re-adopts
   * what the daemon owns at startup; this interval settles workers that die
   * DURING daemon uptime (a dead detached worker otherwise orphans its run in
   * an active state until the next restart). Default 60_000 ms, floor
   * 100 ms; `false` disables the interval (boot reconcile still runs).
   */
  reconcileIntervalMs?: number | false;
  sessionWake?: Omit<SessionWakeRouteDependencies, "now">;
}

export interface RunLaunchRequest {
  schema_version: "calyx.run-launch-request/v1";
  intent: RunIntent;
  idempotency_key: string;
  topology_projection_sha256: string;
}

export const CALYX_RUN_LAUNCH_ACCEPT_V1 = "application/vnd.polli.calyx.run-launch-receipt+json;version=1";

function splitQuotedHeaderValue(value: string, separator: "," | ";"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) throw new Error("Malformed quoted Accept parameter.");
  parts.push(value.slice(start));
  return parts;
}

function isHttpControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}

function parseAcceptParameterValue(rawValue: string): string {
  const value = rawValue.trim();
  if (!value) throw new Error("Malformed empty Accept parameter value.");
  if (!value.startsWith('"')) {
    if (value.includes('"') || [...value].some(isHttpControlCharacter)) {
      throw new Error(`Malformed Accept parameter value: ${rawValue}.`);
    }
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) {
    throw new Error(`Malformed quoted Accept parameter value: ${rawValue}.`);
  }
  let parsed = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character === "\\") {
      index += 1;
      if (index >= value.length - 1) {
        throw new Error(`Malformed quoted Accept parameter value: ${rawValue}.`);
      }
      parsed += value[index]!;
      continue;
    }
    if (character === '"' || isHttpControlCharacter(character)) {
      throw new Error(`Malformed quoted Accept parameter value: ${rawValue}.`);
    }
    parsed += character;
  }
  return parsed;
}

function acceptsPortableRunLaunch(header: string | undefined): boolean {
  if (!header?.trim()) {
    throw new Error(`Run launch requires Accept: ${CALYX_RUN_LAUNCH_ACCEPT_V1}.`);
  }
  let accepted = false;
  for (const rawRange of splitQuotedHeaderValue(header, ",")) {
    if (!rawRange.trim()) throw new Error("Malformed empty Accept media range.");
    const segments = splitQuotedHeaderValue(rawRange, ";").map((segment) => segment.trim());
    const mediaType = segments.shift()?.toLowerCase();
    if (mediaType !== "application/vnd.polli.calyx.run-launch-receipt+json") continue;
    const parameters = new Set<string>();
    let version: string | undefined;
    let quality = 1;
    let afterQuality = false;
    let supportedMediaRange = true;
    for (const segment of segments) {
      const separator = segment.indexOf("=");
      if (separator < 1) throw new Error(`Malformed Accept parameter: ${segment}.`);
      const name = segment.slice(0, separator).trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/u.test(name) || parameters.has(name)) {
        throw new Error(`Malformed or duplicate Accept parameter: ${segment}.`);
      }
      parameters.add(name);
      const rawValue = segment.slice(separator + 1).trim();
      if (name === "q") {
        // RFC 9110 section 12.4.2 defines qvalue as an unquoted 0 or 1 with at
        // most three fractional digits (and only zeroes after 1). Number()
        // would incorrectly admit exponent notation, signs, leading dots, and
        // quoted values that are not part of the weight grammar.
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(rawValue)) {
          throw new Error("Accept q must be an RFC 9110 qvalue between 0 and 1 with at most three fractional digits.");
        }
        afterQuality = true;
        quality = Number(rawValue);
      } else if (!afterQuality) {
        const value = parseAcceptParameterValue(rawValue);
        if (name === "version") {
          version = value;
        } else {
          // Before q, parameters select the media representation itself. No
          // profile other than the named version is implemented.
          supportedMediaRange = false;
        }
      } else {
        parseAcceptParameterValue(rawValue);
      }
      // Parameters after q are Accept extensions. They do not claim that the
      // response carries a media-type parameter and are safe to ignore.
    }
    if (!supportedMediaRange || version !== "1") {
      continue;
    }
    if (quality > 0) accepted = true;
  }
  if (!accepted) {
    throw new Error(`Run launch requires Accept: ${CALYX_RUN_LAUNCH_ACCEPT_V1}.`);
  }
  return true;
}

export interface AdminRunLaunchReceipt {
  schema_version: "calyx.run-launch-result/v1";
  status: "accepted";
  run_id: string;
  operation: {
    route: string;
    events_route: string;
    receipt_route: string;
  };
}

export type AdminRunRecord = Omit<RunRecord, "schema_version"> & {
  schema_version: "calyx.run-record/v1";
};

function toAdminRunRecord(record: RunRecord): AdminRunRecord {
  return { ...record, schema_version: "calyx.run-record/v1" };
}

class RunLaunchProvenanceUnavailableError extends Error {}

export interface MonitorCreateRequest {
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

export interface MonitorCancelRequest {
  reason?: string;
}

export interface MonitorAckRequest {
  acked_by: string;
}

export interface MonitorClaimRequest {
  idempotency_key: string;
  claimed_by: string;
  monitor?: string;
  limit?: number;
}

export interface RuntimeConfigDispatchRequest {
  contractVersion: "host-backend/v1";
  backend: "runtime-config";
  options: Pick<RuntimeConfigOptions, "host" | "components">;
}

export interface RunServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export interface EventStreamTimingOptions {
  catchupIntervalMs?: number;
  keepaliveIntervalMs?: number;
  idleTimeoutMs?: number;
  eventPredicate?: (event: CalyxStreamEvent) => boolean;
  eventProjector?: (event: CalyxStreamEvent) => unknown;
  /** Project a safe receipt when projection, serialization, or frame sizing fails before the first write. */
  projectionFailureProjector?: (event: CalyxStreamEvent, error: unknown) => unknown;
}

export const EVENT_STREAM_CATCHUP_INTERVAL_MS = 250;
export const EVENT_STREAM_KEEPALIVE_INTERVAL_MS = 30_000;
export const EVENT_STREAM_IDLE_TIMEOUT_MS = 5 * EVENT_STREAM_KEEPALIVE_INTERVAL_MS;
const DEFAULT_DAEMON_ID = "run-serve";
const RESTART_ORDER = 10;
const FETCH_COMPATIBLE_EPHEMERAL_BIND_ATTEMPTS = 16;

// Fetch Standard section 2.9. Keep port-0 listeners compatible with the
// generated client and every other Fetch consumer. Linux may allocate from a
// host-configured ephemeral range that overlaps these ports.
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export type RunServerPortErrorCode =
  | "fetch_forbidden_port"
  | "fetch_compatible_ephemeral_port_unavailable";

export class RunServerPortError extends Error {
  readonly code: RunServerPortErrorCode;
  readonly requestedPort: number;
  readonly assignedPort: number;
  readonly attempts: number;

  constructor(options: {
    code: RunServerPortErrorCode;
    requestedPort: number;
    assignedPort: number;
    attempts: number;
  }) {
    const message = options.code === "fetch_forbidden_port"
      ? `Run server port ${options.assignedPort} is blocked by Fetch and cannot back its advertised HTTP URL.`
      : `Run server could not acquire a Fetch-compatible ephemeral port after ${options.attempts} attempts; last assigned port ${options.assignedPort}.`;
    super(message);
    this.name = "RunServerPortError";
    this.code = options.code;
    this.requestedPort = options.requestedPort;
    this.assignedPort = options.assignedPort;
    this.attempts = options.attempts;
  }
}

async function listenOnce(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    try {
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    } catch (error) {
      server.off("error", reject);
      reject(error);
    }
  });
  const address = server.address();
  return typeof address === "object" && address ? address.port : port;
}

async function closeListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function listenOnFetchCompatiblePort(
  server: Server,
  requestedPort: number,
  host: string,
): Promise<number> {
  const attempts = requestedPort === 0 ? FETCH_COMPATIBLE_EPHEMERAL_BIND_ATTEMPTS : 1;
  let assignedPort = requestedPort;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assignedPort = await listenOnce(server, requestedPort, host);
    if (!FETCH_BAD_PORTS.has(assignedPort)) return assignedPort;
    await closeListener(server);
    if (requestedPort !== 0) {
      throw new RunServerPortError({
        code: "fetch_forbidden_port",
        requestedPort,
        assignedPort,
        attempts: attempt,
      });
    }
  }
  throw new RunServerPortError({
    code: "fetch_compatible_ephemeral_port_unavailable",
    requestedPort,
    assignedPort,
    attempts,
  });
}

interface PinnedRunServerState {
  daemonId: string;
  startedAt: string;
  inheritedPath: string;
  buildInfo: CalyxBuildInfo;
  supportsFeatures: CalyxDaemonFeature[];
  registryRoot: string;
  advertisedHost: string;
  actualHost: string;
  canonicalHost: string;
  messageHostAliases: Readonly<Record<string, string>>;
}

export const SUPPORTED_FEATURES = [
  CALYX_DAEMON_FEATURES.healthV1,
  CALYX_DAEMON_FEATURES.agentRunnerV1,
  CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
  CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
  CALYX_DAEMON_FEATURES.detachedWorkerIsolationV1,
  CALYX_DAEMON_FEATURES.vaultExecplanRefV1,
  CALYX_DAEMON_FEATURES.repoRegistryV1,
  CALYX_DAEMON_FEATURES.systemPromptV1,
  CALYX_DAEMON_FEATURES.backendModelV1,
  CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
  CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
  CALYX_DAEMON_FEATURES.runObservationV1,
  CALYX_DAEMON_FEATURES.runResourceAttributionV1,
  CALYX_DAEMON_FEATURES.artifactRootsV1,
  CALYX_DAEMON_FEATURES.outputCaptureV1,
  CALYX_DAEMON_FEATURES.runHandbackV1,
  CALYX_DAEMON_FEATURES.interactiveActivitySurfaceV1,
  CALYX_DAEMON_FEATURES.interactiveActivityDetailV1,
  CALYX_DAEMON_FEATURES.activityMessagesV1,
  CALYX_DAEMON_FEATURES.activityTurnsV1,
  CALYX_DAEMON_FEATURES.activityTextV1,
  CALYX_DAEMON_FEATURES.activityAttachmentsV1,
  CALYX_DAEMON_FEATURES.activityAttachmentBytesV1,
  CALYX_DAEMON_FEATURES.monitorWakeV1,
  CALYX_DAEMON_FEATURES.monitorRemoteV1,
  CALYX_DAEMON_FEATURES.monitorClaimV1,
  CALYX_DAEMON_FEATURES.messageCorrespondenceV1,
  CALYX_DAEMON_FEATURES.sessionWakeV1,
  CALYX_DAEMON_FEATURES.leaseV1,
  CALYX_DAEMON_FEATURES.runReadoptOnBootV1,
  CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1,
  CALYX_DAEMON_FEATURES.workloadAdmissionV1,
] as const satisfies readonly CalyxDaemonFeature[];

const HEALTH_INTERACTIVE_SUMMARY_TIMEOUT_MS = 250;
const INTERNAL_ERROR_MESSAGE = "The server could not complete the request.";

function typedErrorCodeForStatus(statusCode: number): string {
  if (statusCode === 400) return "invalid_request";
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) return "profile_forbidden";
  if (statusCode === 404) return "not_found";
  if (statusCode === 405) return "method_not_allowed";
  if (statusCode === 409) return "conflict";
  if (statusCode === 501) return "not_implemented";
  if (statusCode === 503) return "service_unavailable";
  return "internal_error";
}

function normalizeErrorEnvelope(statusCode: number, payload: unknown): unknown {
  if (
    isRecord(payload)
    && isRecord(payload["error"])
    && payload["error"]["schema_version"] === "calyx.error/v1"
  ) {
    const error = payload["error"];
    return statusCode >= 400 && statusCode < 500 && error["retryable"] === undefined
      ? { ...payload, error: { ...error, retryable: false } }
      : payload;
  }
  const message = isRecord(payload) && typeof payload["error"] === "string"
    ? payload["error"]
    : `HTTP ${statusCode} request failed.`;
  return {
    error: {
      schema_version: "calyx.error/v1",
      code: typedErrorCodeForStatus(statusCode),
      message,
      ...(statusCode >= 400 && statusCode < 500 ? { retryable: false } : {}),
    },
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  rawPayload: unknown,
  options: { unboundSuccessMaxBytes?: number } = {},
): void {
  let payload = statusCode >= 400 ? normalizeErrorEnvelope(statusCode, rawPayload) : rawPayload;
  let mediaType = "application/json";
  let responseErrorCode: string | undefined;
  if (statusCode >= 400) {
    validateErrorEnvelope(payload);
    const operationId = responseOperationIds.get(response);
    const code = isRecord(payload)
      && isRecord(payload["error"])
      && typeof payload["error"]["code"] === "string"
      ? payload["error"]["code"]
      : undefined;
    responseErrorCode = code;
    if (operationId && code) {
      assertHttpOperationErrorDeclared(operationId, statusCode, code);
    }
  } else {
    const operationId = responseOperationIds.get(response);
    if (operationId) {
      const validated = validateOperationSuccessResponse(operationId, statusCode, payload);
      payload = validated.value;
      mediaType = validated.mediaType;
    }
  }
  let responseBody = `${JSON.stringify(payload, null, 2)}\n`;
  if (statusCode < 400) {
    const operationId = responseOperationIds.get(response);
    const success = operationId
      ? HTTP_OPERATION_DESCRIPTORS
          .find((candidate) => candidate.operation_id === operationId)
          ?.successes.find((candidate) => candidate.status === statusCode && candidate.representation === "json")
      : undefined;
    const responseMaxBytes = success?.max_bytes ?? options.unboundSuccessMaxBytes;
    if (!responseMaxBytes) {
      throw new Error(`HTTP operation ${operationId ?? "unknown"} has no JSON response-body ceiling.`);
    }
    if (Buffer.byteLength(responseBody) > responseMaxBytes) {
      statusCode = 500;
      responseErrorCode = "internal_error";
      payload = normalizeErrorEnvelope(statusCode, {
        error: {
          schema_version: "calyx.error/v1",
          code: responseErrorCode,
          message: `Response exceeded the ${responseMaxBytes}-byte contract for ${operationId ?? "unbound route"}.`,
        },
      });
      validateErrorEnvelope(payload);
      if (operationId) {
        assertHttpOperationErrorDeclared(operationId, statusCode, responseErrorCode);
      }
      mediaType = "application/json";
      responseBody = `${JSON.stringify(payload, null, 2)}\n`;
    }
  }
  responseAuditResults.set(response, {
    status: statusCode,
    ...(responseErrorCode ? { error_code: responseErrorCode } : {}),
  });
  response.writeHead(statusCode, {
    "content-type": `${mediaType}; charset=utf-8`,
    "content-length": String(Buffer.byteLength(responseBody)),
  });
  response.end(responseBody);
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  options: { details?: Record<string, unknown>; hint?: string; retryable?: boolean } = {},
): void {
  writeJson(response, statusCode, {
    error: {
      schema_version: "calyx.error/v1",
      code,
      message,
      ...(options.details ? { details: options.details } : {}),
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    },
  });
}

function writeTypedAttachmentError(response: ServerResponse, error: ActivityAttachmentError): void {
  writeJson(response, error.httpStatus, {
    error: {
      schema_version: "calyx.error/v1",
      code: error.code,
      message: error.message,
      ...(
        Object.keys(error.details).length > 0
          ? { details: error.details }
          : {}
      ),
    },
  });
}

function writeActivityAttachmentBytes(
  request: IncomingMessage,
  response: ServerResponse,
  record: ActivityAttachmentRecordResult,
  bytes: Buffer,
): void {
  const headers = {
    "content-type": record.mime_type,
    "content-length": String(bytes.length),
    "etag": `"sha256:${record.sha256}"`,
    "digest": `sha-256=${Buffer.from(record.sha256, "hex").toString("base64")}`,
    "x-calyx-attachment-ref": record.ref,
    ...(record.origin_host ? { "x-calyx-origin-host": record.origin_host } : {}),
    ...(record.served_by_host ? { "x-calyx-served-by-host": record.served_by_host } : {}),
    "x-calyx-source-tier": record.source_tier,
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(bytes);
}

const MAX_REQUEST_BODY_BYTES = 1_048_576;

class RequestPayloadTooLargeError extends Error {
  readonly status = 413;
  readonly code = "payload_too_large";
}
class RequestUnsupportedMediaTypeError extends Error {
  readonly status = 415;
  readonly code = "unsupported_media_type";
}
class RequestValidationError extends Error {
  readonly status = 400;
  constructor(message: string, readonly code = "invalid_request") {
    super(message);
  }
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function assertNoDuplicateJsonObjectMembers(source: string): void {
  let index = 0;
  const fail = (message: string): never => {
    throw new RequestValidationError(message);
  };
  const skipWhitespace = (): void => {
    while (isJsonWhitespace(source[index])) index += 1;
  };
  const parseString = (): string => {
    if (source[index] !== '"') fail("Request body must be valid JSON.");
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          fail("Request body must be valid JSON.");
        }
      }
    }
    return fail("Request body must be valid JSON.");
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      skipWhitespace();
      const names = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const name = parseString();
        if (names.has(name)) fail(`Request body contains duplicate JSON object member ${JSON.stringify(name)}.`);
        names.add(name);
        skipWhitespace();
        if (source[index] !== ":") fail("Request body must be valid JSON.");
        index += 1;
        parseValue();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail("Request body must be valid JSON.");
        index += 1;
      }
      fail("Request body must be valid JSON.");
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail("Request body must be valid JSON.");
        index += 1;
      }
      fail("Request body must be valid JSON.");
    }
    if (source[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (
      index < source.length
      && !isJsonWhitespace(source[index])
      && source[index] !== ","
      && source[index] !== "}"
      && source[index] !== "]"
    ) index += 1;
    if (index === start) fail("Request body must be valid JSON.");
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) fail("Request body must be valid JSON.");
}

function isRequestTransportError(error: unknown): error is RequestPayloadTooLargeError | RequestUnsupportedMediaTypeError {
  return error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError;
}

class LeaseSchemaUnavailableError extends Error {}

async function assertRequestBodyAbsent(request: IncomingMessage): Promise<void> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) !== 0)) {
    throw new RequestValidationError("This operation does not accept a request body.");
  }
  for await (const chunk of request) {
    if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))) > 0) {
      throw new RequestValidationError("This operation does not accept a request body.");
    }
  }
}

async function readRequestJson<T>(request: IncomingMessage): Promise<T> {
  if (validatedRequestBodies.has(request)) return validatedRequestBodies.get(request) as T;
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestUnsupportedMediaTypeError("JSON request bodies require Content-Type: application/json.");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    throw new RequestPayloadTooLargeError(`JSON request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new RequestPayloadTooLargeError(`JSON request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new RequestValidationError("Request body must be valid UTF-8 JSON.");
  }
  if ([...body].every((character) => isJsonWhitespace(character))) {
    throw new RequestValidationError("Expected a JSON request body.");
  }
  let parsed: unknown;
  try {
    assertNoDuplicateJsonObjectMembers(body);
    parsed = JSON.parse(body) as unknown;
  } catch (error) {
    throw error instanceof RequestValidationError
      ? error
      : new RequestValidationError("Request body must be valid JSON.");
  }
  try {
    // JSON.parse accepts lone UTF-16 surrogates, but the idempotency contract is
    // RFC 8785/I-JSON. Validate recursively before audit admission so no
    // capability hash can turn caller input into an internal error.
    canonicalizeJcs(parsed);
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : String(error));
  }
  if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "asserted_actor")) {
    throw new RequestValidationError("asserted_actor is transport metadata; use X-Calyx-Asserted-Actor, not a body field.");
  }
  const operationId = requestOperationIds.get(request);
  if (
    operationId === "admin.run.launch"
    && isRecord(parsed)
    && (typeof parsed["idempotency_key"] !== "string" || parsed["idempotency_key"].trim().length === 0)
  ) {
    throw new RequestValidationError(
      "Portable run launch requires idempotency_key.",
      "idempotency_key_required",
    );
  }
  if (
    operationId === "admin.run.launch"
    && isRecord(parsed)
    && (typeof parsed["topology_projection_sha256"] !== "string"
      || !/^[a-f0-9]{64}$/u.test(parsed["topology_projection_sha256"]))
  ) {
    throw new RequestValidationError(
      "Portable run launch requires the authoritative topology_projection_sha256 it was planned against.",
      "topology_projection_required",
    );
  }
  try {
    const validated = operationId ? validateOperationRequest(operationId, parsed) : parsed;
    validatedRequestBodies.set(request, validated);
    return validated as T;
  } catch (error) {
    throw new RequestValidationError(requestValidationMessage(error));
  }
}

function leaseStringField(payload: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = payload[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (required) {
    throw new Error(`lease request field ${field} must be a non-empty string.`);
  }
  return undefined;
}

function leaseNumberField(payload: Record<string, unknown>, field: string, required = true): number | undefined {
  const value = payload[field];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (required) {
    throw new Error(`lease request field ${field} must be a positive integer.`);
  }
  return undefined;
}

function leaseBooleanField(payload: Record<string, unknown>, field: string): boolean | undefined {
  const value = payload[field];
  return typeof value === "boolean" ? value : undefined;
}

function leaseKindField(payload: Record<string, unknown>): LeaseResourceKind | undefined {
  const value = payload["resource_kind"];
  if (value === undefined) return undefined;
  if (value === "worktree" || value === "session" || value === "vault" || value === "issue") {
    return value;
  }
  throw new Error("lease request field resource_kind must be one of: worktree, session, vault, issue.");
}

async function withLeaseState<T>(
  fn: (db: import("@polli-labs/calyx-core").StateDriverDatabase) => T | Promise<T>,
  stateStoreOptions: StateOpenOptions = {},
): Promise<T> {
  await applyStateMigrations({ storeOptions: stateStoreOptions });
  const opened = await openStateStore(stateStoreOptions);
  try {
    const schema = checkLeaseSchema(opened.db);
    if (schema.status !== "ok") {
      const detail = schema.findings.map((finding) => finding.detail).join("; ");
      throw new LeaseSchemaUnavailableError(`lease state schema is unavailable; run calyx state migrate --apply.${detail ? ` ${detail}` : ""}`);
    }
    return await fn(opened.db);
  } finally {
    opened.db.close();
  }
}

function leaseConflictPayload(code: string, message: string, details?: unknown): Record<string, unknown> {
  const raw = isRecord(details) ? details : undefined;
  const boundedDetails = raw ? Object.fromEntries([
    "owner_host",
    "actual_host",
    "advertised_host",
    "key",
    "holder_activity_id",
    "expires_at",
  ].flatMap((key) => raw[key] === undefined ? [] : [[key, raw[key]]])) : undefined;
  return {
    error: {
      schema_version: "calyx.error/v1",
      code,
      message,
      ...(boundedDetails && Object.keys(boundedDetails).length > 0 ? { details: boundedDetails } : {}),
    },
  };
}

function writeLeaseConflict(response: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  writeJson(response, status, leaseConflictPayload(code, message, details));
}

function leaseAcceptedHosts(state: PinnedRunServerState): Set<string> {
  return new Set(
    [normalizeHostAlias(state.actualHost), normalizeHostAlias(state.advertisedHost)]
      .filter((host) => host.length > 0),
  );
}

function validateLeaseOwnerHost(
  response: ServerResponse,
  state: PinnedRunServerState,
  ownerHost: string,
  key?: string,
): boolean {
  const normalizedOwner = normalizeHostAlias(ownerHost);
  if (leaseAcceptedHosts(state).has(normalizedOwner)) {
    return true;
  }
  writeLeaseConflict(
    response,
    409,
    "lease_owner_mismatch",
    `${key ? `lease ${key}` : "lease query"} is owned by ${ownerHost}, but this daemon is ${state.actualHost} (advertised as ${state.advertisedHost}).`,
    {
      owner_host: ownerHost,
      actual_host: state.actualHost,
      advertised_host: state.advertisedHost,
    },
  );
  return false;
}

function validateLeaseKeyOwner(
  response: ServerResponse,
  state: PinnedRunServerState,
  key: string,
  coordinatorHost: string | undefined,
): boolean {
  let parsed: ReturnType<typeof parseLeaseKey>;
  try {
    parsed = parseLeaseKey(key, { coordinator_host: coordinatorHost });
  } catch (error) {
    writeError(
      response,
      400,
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
  return validateLeaseOwnerHost(response, state, parsed.owner_host, key);
}

function formatListenHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function sanitizeDescriptorArgv(argv: string[]): string[] {
  const sanitized: string[] = [];
  let skipNext = false;
  for (const arg of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--token") {
      skipNext = true;
      continue;
    }
    if (arg.startsWith("--token=")) {
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}

export function detectTailscaleHost(): string {
  const interfaces = networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!name.startsWith("tailscale")) {
      continue;
    }
    for (const address of addresses ?? []) {
      if (address.internal) {
        continue;
      }
      if (address.family === "IPv4") {
        return address.address;
      }
    }
    for (const address of addresses ?? []) {
      if (!address.internal) {
        return address.address;
      }
    }
  }
  throw new Error("Unable to detect a Tailscale interface. Pass an explicit --host.");
}

function notFound(response: ServerResponse, path: string): void {
  writeError(response, 404, "not_found", `Not found: ${path}`);
}

function unauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": 'Bearer realm="calyx-run"',
  });
  response.end(`${JSON.stringify({
    error: {
      schema_version: "calyx.error/v1",
      code: "unauthorized",
      message: "A recognized bearer credential is required.",
      retryable: false,
    },
  }, null, 2)}\n`);
}

function badRequest(response: ServerResponse, message: string): void {
  writeError(response, 400, "invalid_request", message);
}

function conflict(response: ServerResponse, message: string): void {
  writeError(response, 409, "conflict", message);
}

class MonitorRouteError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    retryable = status >= 500,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function writeTypedMonitorError(response: ServerResponse, error: MonitorRouteError): void {
  writeJson(response, error.status, {
    error: {
      schema_version: "calyx.error/v1",
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      retryable: error.retryable,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMonitorCreateRequest(value: unknown): value is MonitorCreateRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schema_version"] !== "calyx.monitor-create-request/v1") {
    return false;
  }
  if (value["preset"] !== "runner-supervision") {
    return false;
  }
  if (
    typeof value["owner"] !== "string"
    || typeof value["created_by"] !== "string"
    || typeof value["assigned_host"] !== "string"
    || typeof value["source_run_id"] !== "string"
    || typeof value["idempotency_key"] !== "string"
  ) {
    return false;
  }
  if (
    value["owner"].trim() === ""
    || value["created_by"].trim() === ""
    || value["assigned_host"].trim() === ""
    || value["source_run_id"].trim() === ""
    || value["idempotency_key"].trim() === ""
  ) {
    return false;
  }
  if (
    typeof value["create_provenance"] !== "string"
    || !(MONITOR_CREATE_PROVENANCES as readonly string[]).includes(value["create_provenance"])
  ) {
    return false;
  }
  if (
    typeof value["rearm_policy"] !== "string"
    || !(MONITOR_REARM_POLICIES as readonly string[]).includes(value["rearm_policy"])
  ) {
    return false;
  }
  if (typeof value["stale_after_ms"] !== "number" || !Number.isFinite(value["stale_after_ms"]) || value["stale_after_ms"] <= 0) {
    return false;
  }
  return value["delivery"] === undefined || isRecord(value["delivery"]);
}

async function withServerMonitorState<T>(
  stateStoreOptions: StateOpenOptions,
  fn: (db: StateDriverDatabase) => T | Promise<T>,
): Promise<T> {
  const opened = await openStateStore(stateStoreOptions);
  try {
    const schema = checkMonitorSchema(opened.db);
    if (schema.status !== "ok") {
      throw new MonitorRouteError(
        503,
        "monitor_schema_unavailable",
        "Monitor schema is not available on this daemon. Run `calyx state migrate --apply` on the target host.",
        { schema_status: schema.status, findings: schema.findings },
      );
    }
    return await fn(opened.db);
  } finally {
    opened.db.close();
  }
}

function parseMonitorRouteLimit(url: URL): number | undefined {
  const value = url.searchParams.get("limit");
  return value ? Number.parseInt(value, 10) : undefined;
}

function parseMonitorRouteStatus(url: URL): MonitorStatus | "all" {
  const value = url.searchParams.get("status")?.trim() || "active";
  if (value === "all" || (MONITOR_STATUSES as readonly string[]).includes(value)) {
    return value as MonitorStatus | "all";
  }
  throw new MonitorRouteError(
    400,
    "monitor_invalid_status",
    `Invalid monitor status "${value}". Expected one of: ${[...MONITOR_STATUSES, "all"].join(", ")}.`,
    { alternatives: [...MONITOR_STATUSES, "all"] },
  );
}

function parseMonitorWakeRouteStatus(url: URL): MonitorWakeStatus | "all" {
  const value = url.searchParams.get("status")?.trim() || "pending";
  if (value === "all" || (MONITOR_WAKE_STATUSES as readonly string[]).includes(value)) {
    return value as MonitorWakeStatus | "all";
  }
  throw new MonitorRouteError(
    400,
    "monitor_invalid_wake_status",
    `Invalid monitor wake status "${value}". Expected one of: ${[...MONITOR_WAKE_STATUSES, "all"].join(", ")}.`,
    { alternatives: [...MONITOR_WAKE_STATUSES, "all"] },
  );
}

function monitorDeliveryState(deliveries: MonitorDeliveryRow[]) {
  const counts = {
    attempted: 0,
    delivered: 0,
    failed: 0,
  };
  for (const delivery of deliveries) {
    counts[delivery.status] += 1;
  }
  const failures = deliveries
    .filter((delivery) => delivery.status === "failed")
    .map((delivery) => ({
      delivery_id: delivery.delivery_id,
      wake_id: delivery.wake_id,
      binding_id: delivery.binding_id,
      adapter: delivery.adapter,
      error_code: delivery.error_code,
      error_message: delivery.error_message,
      failed_at: delivery.failed_at,
    }));
  return { count: deliveries.length, counts, deliveries, failures };
}

function requiredRemoteMessageString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`message.${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalRemoteMessageString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function remoteMessageRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message must be an object");
  }
  return value as Record<string, unknown>;
}

class MessageIngressIdentityConflictError extends Error {}

function immutableMessagePayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const payload = { ...value };
  delete payload["receipt_mirror"];
  delete payload["remote_sender_receipt_path"];
  delete payload["remote_sender_spooled_at"];
  return payload;
}

function messageIngressFingerprint(value: Pick<MessageRow,
  "message_id" | "sender" | "recipient_address" | "recipient_class" | "recipient_host"
  | "subject" | "body" | "thread_key" | "reply_to" | "idempotency_key" | "urgency"
  | "ack_required" | "expires_at" | "payload" | "created_provenance"
>, includeCreatedProvenance = true): string {
  return hashCanonicalJcs({
    message_id: value.message_id,
    sender: value.sender,
    recipient_address: value.recipient_address,
    recipient_class: value.recipient_class,
    recipient_host: value.recipient_host,
    subject: value.subject,
    body: value.body,
    thread_key: value.thread_key,
    reply_to: value.reply_to,
    idempotency_key: value.idempotency_key,
    urgency: value.urgency,
    ack_required: value.ack_required,
    expires_at: value.expires_at,
    payload: immutableMessagePayload(value.payload),
    ...(includeCreatedProvenance ? { created_provenance: value.created_provenance } : {}),
  });
}

function messageIngressIdentityMatches(existing: MessageRow, candidate: MessageRow): boolean {
  // Migration 0023 cannot reconstruct origin snapshots for rows first accepted
  // by an older receiver. During rolling upgrade, compare every other immutable
  // field when either side carries that explicit legacy absence. Never backfill
  // the row: the first receiver observation stays immutable.
  const compareCreatedProvenance = existing.created_provenance !== null
    && candidate.created_provenance !== null;
  return messageIngressFingerprint(existing, compareCreatedProvenance)
    === messageIngressFingerprint(candidate, compareCreatedProvenance);
}

function normalizeHostAlias(value: string): string {
  return value.trim().split(".")[0]?.toLowerCase() ?? "";
}

function canonicalRuntimeConfigHostSegment(value: string): string | undefined {
  if (value !== value.trim().toLowerCase() || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    return undefined;
  }
  return value;
}

function pinMessageHostAliases(
  aliases: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const pinned = Object.create(null) as Record<string, string>;
  for (const [identity, alias] of Object.entries(aliases ?? {})) {
    const canonicalIdentity = identity.trim().toLowerCase();
    const canonicalAlias = canonicalRuntimeConfigHostSegment(alias);
    if (
      identity !== canonicalIdentity
      || !/^[a-z0-9][a-z0-9.-]*$/u.test(canonicalIdentity)
      || !canonicalAlias
    ) {
      throw new Error(`Message host identity ${JSON.stringify(identity)} must map to a canonical fleet host alias.`);
    }
    pinned[canonicalIdentity] = canonicalAlias;
  }
  return Object.freeze(pinned);
}

function assertMessageHostAliasesPreservePinnedLocalIdentity(
  aliases: Readonly<Record<string, string>>,
  actualHost: string,
  advertisedHost: string,
): void {
  const canonicalLocalHost = normalizeHostAlias(advertisedHost);
  const pinnedLocalIdentities = new Set([
    actualHost,
    advertisedHost.trim().toLowerCase(),
    normalizeHostAlias(actualHost),
    canonicalLocalHost,
  ].filter((identity) => identity.length > 0));
  for (const identity of pinnedLocalIdentities) {
    const configuredHost = Object.prototype.hasOwnProperty.call(aliases, identity)
      ? aliases[identity]
      : undefined;
    if (configuredHost && configuredHost !== canonicalLocalHost) {
      throw new Error(
        `Message host identity ${JSON.stringify(identity)} is pinned local as ${canonicalLocalHost} but maps to ${configuredHost}.`,
      );
    }
  }
}

function canonicalizeOwnedMessageAddressHost(
  resolved: ReturnType<typeof resolveMessageAddress>,
  canonicalHost: string,
): ReturnType<typeof resolveMessageAddress> {
  const address = resolved.kind === "client" || resolved.kind === "role"
    ? resolved.address.replace(/@[^@]+$/u, `@${canonicalHost}`)
    : resolved.kind === "host"
      ? `host:${canonicalHost}`
      : resolved.address;
  return {
    ...resolved,
    address,
    target_host: resolved.target_host === null ? null : canonicalHost,
  };
}

function hasCanonicalMessageAddressGrammar(address: string): boolean {
  if (address.includes("*")) return false;
  try {
    return normalizeAddressGrant(address) === address;
  } catch {
    return false;
  }
}

interface LocalMessageHostIdentity {
  canonicalHost: string;
  exactAliases: ReadonlySet<string>;
  shortAliases: ReadonlySet<string>;
}

function localMessageHostIdentity(state: PinnedRunServerState): LocalMessageHostIdentity {
  const canonicalHost = normalizeHostAlias(state.advertisedHost);
  const exactAliases = new Set([
    state.advertisedHost.trim().toLowerCase(),
    state.actualHost,
    state.canonicalHost.trim().toLowerCase(),
    normalizeHostAlias(state.advertisedHost),
    normalizeHostAlias(state.actualHost),
    ...Object.entries(state.messageHostAliases)
      .filter(([, alias]) => alias === canonicalHost)
      .map(([identity]) => identity),
  ].filter((host) => host.length > 0));
  return {
    canonicalHost,
    exactAliases,
    shortAliases: new Set([...exactAliases].map((host) => normalizeHostAlias(host))),
  };
}

function configuredMessageHostIdentity(host: string, state: PinnedRunServerState): LocalMessageHostIdentity {
  const canonicalHost = normalizeHostAlias(host);
  const exactHost = host.trim().toLowerCase();
  const exactAliases = new Set([
    exactHost,
    canonicalHost,
    ...Object.entries(state.messageHostAliases)
      .filter(([, alias]) => alias === canonicalHost)
      .map(([identity]) => identity),
  ].filter((value) => value.length > 0));
  return {
    canonicalHost,
    exactAliases,
    shortAliases: new Set([...exactAliases].map((identity) => normalizeHostAlias(identity))),
  };
}

function configuredRemoteMessageHost(
  targetHost: string,
  state: PinnedRunServerState,
): string | undefined {
  const exactTarget = targetHost.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(state.messageHostAliases, exactTarget)
    ? state.messageHostAliases[exactTarget]
    : undefined;
}

function classifyMessageTargetHost(
  targetHost: string | null,
  identity: LocalMessageHostIdentity,
): "local" | "remote" | "local_alias_collision" {
  if (targetHost === null) return "local";
  const exactTarget = targetHost.trim().toLowerCase();
  if (identity.exactAliases.has(exactTarget)) return "local";
  if (identity.shortAliases.has(normalizeHostAlias(exactTarget))) return "local_alias_collision";
  return "remote";
}

function resolvedMessageAddressBelongsToHost(
  resolved: ReturnType<typeof resolveMessageAddress>,
  identity: LocalMessageHostIdentity,
): boolean {
  return classifyMessageTargetHost(resolved.target_host, identity) === "local";
}

function daemonSubjectHost(subject: string): string | undefined {
  if (!subject.startsWith("daemon:")) return undefined;
  const host = subject.slice("daemon:".length);
  return host.length > 0 && host === host.trim().toLowerCase() && /^[a-z0-9][a-z0-9.-]*$/u.test(host)
    ? host
    : undefined;
}

function authorizedInternalMessageOriginHost(
  subject: string,
  state: PinnedRunServerState,
): string | undefined {
  const subjectHost = daemonSubjectHost(subject);
  if (!subjectHost) return undefined;
  const localIdentity = localMessageHostIdentity(state);
  if (localIdentity.exactAliases.has(subjectHost)) return localIdentity.canonicalHost;
  return configuredRemoteMessageHost(subjectHost, state);
}

function authorizeInternalMessageOriginSubject(
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  state: PinnedRunServerState,
): boolean {
  if (authorizedInternalMessageOriginHost(auth.subject, state)) return true;
  writeError(
    response,
    403,
    "internal_origin_forbidden",
    "Message ingress requires the pinned receiving daemon subject or an exact configured message-host identity.",
  );
  return false;
}

function authorizeSelfInternalSubject(
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  state: PinnedRunServerState,
): boolean {
  const subjectHost = daemonSubjectHost(auth.subject);
  const localIdentity = localMessageHostIdentity(state);
  if (subjectHost && classifyMessageTargetHost(subjectHost, localIdentity) === "local") return true;
  writeError(
    response,
    403,
    "internal_subject_forbidden",
    "This internal operation is restricted to the receiving daemon's own subject.",
  );
  return false;
}

function parseOptionalQueryValue(value: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStreamEventType(value: string | undefined): CalyxStreamEventType | undefined {
  if (!value) {
    return undefined;
  }
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
  throw new Error(`Invalid event_type filter: ${value}.`);
}

function readLastEventId(request: IncomingMessage): string | undefined {
  const header = request.headers["last-event-id"];
  if (Array.isArray(header)) {
    return header.join(",");
  }
  return typeof header === "string" ? header : undefined;
}

function prepareSseEventFrame(event: CalyxStreamEvent, payload: unknown = event): string {
  const frame = encodeCalyxSseFrame(event.cursor, payload);
  const frameBytes = Buffer.byteLength(frame, "utf8");
  if (frameBytes > CALYX_HTTP_SSE_MAX_FRAME_BYTES) {
    throw new Error(
      `SSE frame is ${frameBytes} bytes; the descriptor ceiling is ${CALYX_HTTP_SSE_MAX_FRAME_BYTES}.`,
    );
  }
  return frame;
}

function isRunIntent(value: unknown): value is RunIntent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RunIntent>;
  return (
    typeof candidate.run_id === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.created_at === "string"
  );
}

function isRuntimeConfigComponent(value: unknown): value is RuntimeConfigComponent {
  return value === "codex" || value === "claude-settings" || value === "claude-mcp";
}

export function isRuntimeConfigDispatchRequest(value: unknown): value is RuntimeConfigDispatchRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RuntimeConfigDispatchRequest>;
  if (
    candidate.contractVersion !== "host-backend/v1"
    || candidate.backend !== "runtime-config"
    || !candidate.options
    || typeof candidate.options !== "object"
  ) {
    return false;
  }
  const options = candidate.options as Partial<RuntimeConfigDispatchRequest["options"]>;
  if (typeof options.host !== "string" || options.host.length === 0) {
    return false;
  }
  if (options.components !== undefined) {
    if (!Array.isArray(options.components)) {
      return false;
    }
    if (!options.components.every((component: unknown) => isRuntimeConfigComponent(component))) {
      return false;
    }
  }
  return true;
}

async function buildHealthPayload(
  service: RunService,
  state: PinnedRunServerState,
  stateStoreOptions: StateOpenOptions = {},
): Promise<CalyxDaemonHealth> {
  const activeRunEntries = (await service.listRuns()).filter((entry) => !isTerminalState(entry.state));
  const descriptor = await readDescriptor(state.daemonId, { root: state.registryRoot });
  const interactiveSessions = await readInteractiveSessionSummaryForHealth(service, state);
  const [promotedBuild, cloneHead, stateSchema] = await Promise.all([
    readPromotedBuildForHealth(),
    readCloneHeadForHealth(state.advertisedHost),
    readStateSchemaForHealth(stateStoreOptions),
  ]);
  return {
    schema_version: CALYX_DAEMON_HEALTH_SCHEMA_VERSION,
    protocol_epoch: CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
    daemon_kind: CALYX_RUN_SERVICE_DAEMON_KIND,
    daemon_id: state.daemonId,
    advertised_host: state.advertisedHost,
    pid: process.pid,
    uptime_ms: Math.max(Date.now() - new Date(state.startedAt).getTime(), 0),
    started_at: state.startedAt,
    build: toCalyxDaemonBuildSummary(state.buildInfo),
    env: {
      inherited_path: state.inheritedPath,
    },
    promoted_build: promotedBuild,
    clone_head: cloneHead,
    state_schema: stateSchema,
    active_runs: activeRunEntries.length,
    active_run_ids: activeRunEntries.map((entry) => entry.run_id).sort(),
    workload_admission: service.workloadAdmissionDecision(),
    maintenance_mode: descriptor?.maintenance_mode ?? false,
    supports_features: [...state.supportsFeatures],
    interactive_sessions: interactiveSessions,
  };
}

/**
 * Read the live migration ledger rather than the position this daemon
 * converged to at boot: another process on the same host can migrate the store
 * underneath a running daemon, and that is exactly the divergence health has
 * to be able to show. `planStateMigrations` opens read-only, so this never
 * writes pragmas, journals, or file modes.
 */
async function readStateSchemaForHealth(
  stateStoreOptions: StateOpenOptions,
): Promise<CalyxDaemonStateSchemaSummary> {
  try {
    const plan = await planStateMigrations({ storeOptions: stateStoreOptions });
    return {
      status: classifyStateSchema(plan.current, plan.target),
      driver: plan.driver,
      current: plan.current,
      target: plan.target,
      pending: plan.pending.length,
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readPromotedBuildForHealth(): Promise<CalyxDaemonPromotedBuildSummary> {
  try {
    const promoted = await readPromotedCalyxBuild();
    if (!promoted) {
      return { status: "missing" };
    }
    return {
      status: "ok",
      install_path: promoted.install_path,
      current_link: promoted.current_link,
      build_info_path: promoted.build_info_path,
      build: toCalyxDaemonBuildSummary(promoted.build),
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readCloneHeadForHealth(advertisedHost: string): Promise<CalyxDaemonCloneHeadSummary> {
  let repoRoot: string | undefined;
  try {
    const agentsInfraRoot = await resolveAgentsInfraRoot();
    if (!agentsInfraRoot) {
      return {
        status: "unavailable",
        error: "agents-infra root unavailable; cannot resolve calyx repo root",
      };
    }
    const currentHost = await resolveCurrentHostAlias(undefined, agentsInfraRoot).catch(() => advertisedHost);
    repoRoot = await resolveRepo("calyx", currentHost || advertisedHost, agentsInfraRoot);
    const result = await execFile("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      env: process.env,
      timeout: 1_000,
    });
    const gitHead = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(gitHead)) {
      return {
        status: "error",
        repo_root: repoRoot,
        error: `git rev-parse HEAD returned a non-SHA value: ${gitHead || "<empty>"}`,
      };
    }
    return {
      status: "ok",
      repo_root: repoRoot,
      git_head: gitHead,
    };
  } catch (error) {
    return {
      status: "error",
      ...(repoRoot ? { repo_root: repoRoot } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readInteractiveSessionSummaryForHealth(
  service: RunService,
  state: PinnedRunServerState,
): Promise<NonNullable<CalyxDaemonHealth["interactive_sessions"]>> {
  let timeout: NodeJS.Timeout | undefined;
  const unavailable = (reason: "timeout" | "error", error?: unknown): NonNullable<CalyxDaemonHealth["interactive_sessions"]> => ({
    window_ms: DEFAULT_INTERACTIVE_ACTIVITY_LOOKBACK_MS,
    scanned_at: new Date().toISOString(),
    codex: 0,
    claude: 0,
    total: 0,
    status: "unavailable",
    reason,
    ...(reason === "timeout" ? { timed_out_ms: HEALTH_INTERACTIVE_SUMMARY_TIMEOUT_MS } : {}),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });

  const summary = service
    .interactiveSessionSummary({ host: state.advertisedHost })
    .catch((error: unknown) => unavailable("error", error));
  const timeoutPromise = new Promise<NonNullable<CalyxDaemonHealth["interactive_sessions"]>>((resolve) => {
    timeout = setTimeout(() => resolve(unavailable("timeout")), HEALTH_INTERACTIVE_SUMMARY_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    return await Promise.race([summary, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseBooleanQueryParam(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parsePositiveQueryInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeQueryInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

interface SeekCursorPayload {
  v: 1;
  operation_id: string;
  filters_hash: string;
  snapshot_at: string;
  membership_fence?: string;
  after: Record<string, string>;
}

class ListCursorError extends Error {}

type ActivitySeekAfter = {
  created_at: string;
  run_id: string;
  entry_kind: RunActivityEntry["entry_kind"];
};

function activitySeekAfter(cursor: SeekCursorPayload | undefined): ActivitySeekAfter | undefined {
  if (!cursor) return undefined;
  const entryKind = cursor.after["entry_kind"];
  if (entryKind !== "calyx_run" && entryKind !== "interactive_session") {
    throw new ListCursorError("cursor activity entry kind is invalid");
  }
  return {
    created_at: cursor.after["created_at"]!,
    run_id: cursor.after["run_id"]!,
    entry_kind: entryKind,
  };
}

function decodeListCursor(
  url: URL,
  operationId: string,
  filters: Record<string, unknown>,
  afterKeys: readonly string[],
  requireMembershipFence = false,
): SeekCursorPayload | undefined {
  const cursor = url.searchParams.get("cursor");
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(decoded)
      || decoded["v"] !== 1
      || decoded["operation_id"] !== operationId
      || decoded["filters_hash"] !== hashCanonicalJcs(filters)
      || typeof decoded["snapshot_at"] !== "string"
      || !Number.isFinite(Date.parse(decoded["snapshot_at"]))
      || (requireMembershipFence
        && (typeof decoded["membership_fence"] !== "string" || decoded["membership_fence"].length === 0))
      || (!requireMembershipFence
        && decoded["membership_fence"] !== undefined
        && (typeof decoded["membership_fence"] !== "string" || decoded["membership_fence"].length === 0))
      || !isRecord(decoded["after"])
      || canonicalizeJcs(Object.keys(decoded["after"]).sort()) !== canonicalizeJcs([...afterKeys].sort())
      || Object.values(decoded["after"]).some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new Error("invalid shape");
    }
    return decoded as unknown as SeekCursorPayload;
  } catch {
    throw new ListCursorError(`cursor is invalid for ${operationId}`);
  }
}

function encodeListCursor(
  operationId: string,
  filters: Record<string, unknown>,
  snapshotAt: string,
  after: Record<string, string>,
  membershipFence?: string,
): string {
  return Buffer.from(canonicalizeJcs({
    v: 1,
    operation_id: operationId,
    filters_hash: hashCanonicalJcs(filters),
    snapshot_at: snapshotAt,
    ...(membershipFence ? { membership_fence: membershipFence } : {}),
    after,
  })).toString("base64url");
}

function boundedSeekPage<T>(
  values: readonly T[],
  operationId: string,
  filters: Record<string, unknown>,
  snapshotAt: string,
  after: Record<string, string> | undefined,
  limit: number,
  isAfter: (value: T, after: Record<string, string>) => boolean,
  cursorTuple: (value: T) => Record<string, string>,
  membershipFence?: string,
): { values: T[]; truncated: boolean; next_cursor?: string } {
  const eligible = after ? values.filter((value) => isAfter(value, after)) : [...values];
  const page = eligible.slice(0, limit);
  const truncated = eligible.length > limit;
  const last = page.at(-1);
  return {
    values: page,
    truncated,
    ...(truncated && last
      ? { next_cursor: encodeListCursor(operationId, filters, snapshotAt, cursorTuple(last), membershipFence) }
      : {}),
  };
}

function parseInteractiveAgentKind(value: string | null): InteractiveSessionBackend | undefined {
  if (value === "claude" || value === "codex") {
    return value;
  }
  return undefined;
}

async function buildMetricsPayload(service: RunService): Promise<CalyxDaemonMetrics> {
  const runningMetrics = await service.runningMetrics();
  return {
    schema_version: CALYX_DAEMON_METRICS_SCHEMA_VERSION,
    memory: readDaemonMemoryMetrics(),
    event_loop: readEventLoopLagMetrics(),
    connections: {
      sse_subscribers: runningMetrics.sse_subscribers,
      codex_app_server_sessions: runningMetrics.codex_app_server_sessions,
    },
    runs: {
      active: runningMetrics.active_runs,
      total_serviced_since_start: runningMetrics.total_serviced_since_start,
    },
  };
}

async function handleRunsIndex(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  auth: AuthenticatedRequestContext,
  state: PinnedRunServerState,
  stateStoreOptions: StateOpenOptions,
): Promise<void> {
  if (request.method === "GET") {
    const url = new URL(request.url ?? "/v1/admin/runs", "http://localhost");
    const includeInteractive = parseBooleanQueryParam(url.searchParams.get("include_interactive"));
    const requestedLimit = parsePositiveQueryInteger(url.searchParams.get("limit"));
    const limit = Math.min(requestedLimit ?? 50, CALYX_ADMIN_RUN_LIST_MAX_ITEMS);
    const requestedHost = url.searchParams.get("host")?.trim();
    const host = requestedHost ? normalizeHostAlias(requestedHost) : undefined;
    const agentKind = parseInteractiveAgentKind(url.searchParams.get("agent_kind"));
    const sinceMs = parseNonNegativeQueryInteger(url.searchParams.get("since_ms"));
    const filters = {
      include_interactive: includeInteractive,
      host: host ?? null,
      agent_kind: agentKind ?? null,
      since_ms: sinceMs ?? null,
    };
    const cursor = decodeListCursor(
      url,
      "admin.run.list",
      filters,
      includeInteractive
        ? ["created_at", "run_id", "entry_kind"]
        : ["created_at", "run_id"],
      true,
    );
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const createdSince = sinceMs !== undefined
      ? new Date(Date.parse(snapshotAt) - sinceMs).toISOString()
      : undefined;
    const managedAfter = cursor && !includeInteractive
      ? { created_at: cursor.after["created_at"]!, run_id: cursor.after["run_id"]! }
      : undefined;
    const activityAfter = includeInteractive ? activitySeekAfter(cursor) : undefined;
    const snapshotPage: {
      entries: Array<RunListEntry | RunActivityEntry>;
      membershipFence: string;
    } | undefined = await (includeInteractive
      ? service.listActivitySnapshotPage({
          includeInteractive: true,
          ...(host ? { host } : {}),
          observationHost: state.advertisedHost,
          ...(agentKind ? { agentKind } : {}),
          ...(createdSince ? { createdSince } : {}),
          createdBefore: snapshotAt,
          ...(activityAfter ? { after: activityAfter } : {}),
          ...(cursor?.membership_fence
            ? { expectedMembershipFence: cursor.membership_fence }
            : {}),
          limit: limit + 1,
        })
      : service.listRunsSnapshotPage({
          ...(host ? { host } : {}),
          ...(agentKind ? { backend: agentKind } : {}),
          ...(createdSince ? { created_since: createdSince } : {}),
          created_before: snapshotAt,
          ...(managedAfter ? { after: managedAfter } : {}),
          ...(cursor?.membership_fence
            ? { expected_membership_fence: cursor.membership_fence }
            : {}),
          limit: limit + 1,
        }))
      .catch((error: unknown) => {
        if (error instanceof RunListSnapshotChangedError) {
          throw new ListCursorError("cursor membership snapshot is stale; restart pagination");
        }
        if (error instanceof RunIndexProjectionNotReadyError) {
          writeError(response, 503, error.code, error.message, { retryable: true });
          return undefined;
        }
        if (!(error instanceof InteractiveActivityProjectionNotReadyError)) throw error;
        writeError(response, 503, error.code, error.message, {
          details: {
            reason: error.details.reason,
            candidate_limit: error.details.candidate_limit,
            candidates_seen: error.details.candidates_seen,
            identity_max_bytes: error.details.identity_max_bytes,
          },
          hint: "Retry after the transcript identity projection is within its bounded scan envelope.",
          retryable: true,
        });
        return undefined;
      });
    if (!snapshotPage) return;
    const page = boundedSeekPage(
      snapshotPage.entries,
      "admin.run.list",
      filters,
      snapshotAt,
      undefined,
      limit,
      () => true,
      (entry) => includeInteractive
        ? {
            created_at: entry.created_at,
            run_id: entry.run_id,
            entry_kind: "entry_kind" in entry ? entry.entry_kind : "calyx_run",
          }
        : { created_at: entry.created_at, run_id: entry.run_id },
      snapshotPage.membershipFence,
    );
    writeJson(response, 200, {
      schema_version: "calyx.run-list/v1",
      count: page.values.length,
      truncated: page.truncated,
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      runs: page.values,
    });
    return;
  }

  if (request.method === "POST") {
    const provenance = requireRequestProvenance(request);
    let payload: RunLaunchRequest;
    try {
      payload = await readRequestJson<RunLaunchRequest>(request);
    } catch (error) {
      if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
      if (error instanceof RequestValidationError) throw error;
      badRequest(response, error instanceof Error ? error.message : String(error));
      return;
    }

    if (!isRunIntent(payload.intent)) {
      badRequest(response, "POST /v1/admin/runs requires an intent with run_id, host, and created_at.");
      return;
    }

    try {
      acceptsPortableRunLaunch(request.headers.accept);
    } catch (error) {
      writeError(response, 406, "unsupported_accept", error instanceof Error ? error.message : String(error));
      return;
    }
    if (payload.schema_version !== "calyx.run-launch-request/v1") {
      writeError(response, 400, "invalid_request", "Portable run launch requires schema_version calyx.run-launch-request/v1.");
      return;
    }
    if (!payload.idempotency_key?.trim()) {
      writeError(response, 400, "idempotency_key_required", "Portable run launch requires idempotency_key.");
      return;
    }
    if (!/^[a-f0-9]{64}$/u.test(payload.topology_projection_sha256 ?? "")) {
      writeError(
        response,
        400,
        "topology_projection_required",
        "Portable run launch requires the authoritative topology_projection_sha256 it was planned against.",
      );
      return;
    }
    const requestedHost = payload.intent.host;
    const localIdentity = localMessageHostIdentity(state);
    if (
      requestedHost !== "local"
      && (
        requestedHost !== requestedHost.trim().toLowerCase()
        || !localIdentity.exactAliases.has(requestedHost)
      )
    ) {
      writeError(
        response,
        409,
        "run_host_mismatch",
        `Run launch host mismatch: requested ${requestedHost}, but this daemon receives work for ${localIdentity.canonicalHost}.`,
        {
          details: {
            requested_host: requestedHost,
            actual_host: state.actualHost,
            advertised_host: state.advertisedHost,
          },
        },
      );
      return;
    }
    try {
      await applyStateMigrations({ storeOptions: stateStoreOptions });
    } catch (error) {
      writeError(
        response,
        503,
        "idempotency_schema_unavailable",
        error instanceof Error ? error.message : String(error),
        { retryable: true },
      );
      return;
    }
    const opened = await openStateStore(stateStoreOptions);
    const presenceNormalized: Partial<RunLaunchRequest> = { ...payload };
    delete presenceNormalized.idempotency_key;
    const requestHash = hashCanonicalJcs(presenceNormalized);
    const admissionIdentity = hashCanonicalJcs({
      domain: "calyx.admin.run.launch-idempotency/v1",
      subject: auth.subject,
      operation_id: "admin.run.launch",
      idempotency_key: payload.idempotency_key,
    });
    const encodedRunId = encodeURIComponent(payload.intent.run_id);
    const receipt: AdminRunLaunchReceipt = {
      schema_version: "calyx.run-launch-result/v1",
      status: "accepted",
      run_id: payload.intent.run_id,
      operation: {
        route: `/v1/admin/runs/${encodedRunId}`,
        events_route: `/v1/admin/runs/${encodedRunId}/events`,
        receipt_route: `/v1/admin/runs/${encodedRunId}/receipt`,
      },
    };
    let replayReceipt: { status: number; response: unknown } | undefined;
    let bindingProvenance: ApiProvenanceV1 | undefined;
    try {
      opened.db.exec("BEGIN IMMEDIATE");
      const existing = readApiIdempotency(opened.db, auth.subject, "admin.run.launch", payload.idempotency_key);
      if (existing) {
        if (existing.request_hash !== requestHash || existing.canonicalizer !== "jcs-rfc8785/v1" || existing.schema_major !== 1) {
          opened.db.exec("ROLLBACK");
          writeError(response, 409, "idempotency_conflict", "The idempotency key is already bound to another run launch.", {
            hint: "Use a new idempotency_key for a different request.",
          });
          return;
        }
        opened.db.exec("COMMIT");
        replayReceipt = { status: existing.response_status, response: existing.response };
        bindingProvenance = existing.first_request_provenance ?? undefined;
      } else {
        recordApiIdempotency(opened.db, {
          subject: auth.subject,
          operation_id: "admin.run.launch",
          idempotency_key: payload.idempotency_key,
          asserted_actor: requestAssertedActors.get(request),
          first_request_provenance: provenance,
          request_hash: requestHash,
          response_status: 202,
          response: receipt,
        });
        opened.db.exec("COMMIT");
        bindingProvenance = provenance;
      }
    } catch (error) {
      try { opened.db.exec("ROLLBACK"); } catch { /* transaction was not open */ }
      throw error;
    } finally {
      opened.db.close();
    }
    if (replayReceipt && replayReceipt.status >= 400) {
      writeJson(response, replayReceipt.status, replayReceipt.response);
      return;
    }
    try {
      if (!bindingProvenance) {
        throw new RunLaunchProvenanceUnavailableError(
          "The durable launch binding predates complete first-request provenance and cannot be replayed safely.",
        );
      }
      const launched = await service.submitDetached(payload.intent, {
        provenance: bindingProvenance,
        admissionIdentity,
        requestHash,
        plannedTopologyProjectionSha256: payload.topology_projection_sha256,
      });
      if (launched.run_id !== payload.intent.run_id) {
        throw new Error(`Run launch identity drift: expected ${payload.intent.run_id}, received ${launched.run_id}.`);
      }
    } catch (error) {
      if (
        error instanceof WorkloadAdmissionFencedError
        || error instanceof WorkloadAdmissionBusyError
      ) {
        const status = error.reason === "topology_mismatch" || error.reason === "withdrawn"
          ? 409
          : 503;
        writeError(
          response,
          status,
          error.code,
          error.message,
          {
            details: {
              reason: error.reason,
              failed_surface: error.failedSurface,
              next_action: error.nextAction,
              admission: error.decision.admission,
              planned_topology_projection_sha256: payload.topology_projection_sha256,
              ...(error.decision.admission === "open"
                ? {
                    accepted_topology_projection_sha256:
                      error.decision.accepted_topology.projection_sha256,
                  }
                : {}),
            },
            hint: error.nextAction,
            retryable: status === 503,
          },
        );
        return;
      }
      if (error instanceof RunLaunchProvenanceUnavailableError) {
        const terminalError = {
          error: {
            schema_version: "calyx.error/v1",
            code: "idempotency_provenance_unavailable",
            message: error.message,
            hint: "Choose a new run_id and idempotency_key; the original creator identity cannot be reconstructed.",
          },
        };
        const cleanup = await openStateStore(stateStoreOptions);
        try {
          cleanup.db.prepare(
            `UPDATE api_idempotency
                SET response_status = 409, response_json = ?
              WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
          ).run(JSON.stringify(terminalError), auth.subject, "admin.run.launch", payload.idempotency_key);
        } finally {
          cleanup.db.close();
        }
        writeJson(response, 409, terminalError);
        return;
      }
      if (error instanceof RunAlreadyExistsError) {
        const terminalError = {
          error: {
            schema_version: "calyx.error/v1",
            code: "run_id_conflict",
            message: error.message,
          },
        };
        const cleanup = await openStateStore(stateStoreOptions);
        try {
          cleanup.db.prepare(
            `UPDATE api_idempotency
                SET response_status = 409, response_json = ?
              WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
          ).run(JSON.stringify(terminalError), auth.subject, "admin.run.launch", payload.idempotency_key);
        } finally {
          cleanup.db.close();
        }
        writeJson(response, 409, terminalError);
        return;
      }
      throw error;
    }
    writeJson(response, replayReceipt?.status ?? 202, replayReceipt?.response ?? receipt);
    return;
  }

  writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
}

async function handleConsumerRuns(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  state: PinnedRunServerState,
  parts: string[],
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  if (parts.length === 2) {
    const url = new URL(request.url ?? "/v1/runs", "http://localhost");
    const requestedLimit = parsePositiveQueryInteger(url.searchParams.get("limit"));
    const limit = Math.min(requestedLimit ?? 50, 100);
    const host = url.searchParams.get("host")?.trim() || undefined;
    const agentKind = parseInteractiveAgentKind(url.searchParams.get("agent_kind"));
    const sinceMs = parseNonNegativeQueryInteger(url.searchParams.get("since_ms"));
    const filters = {
      host: host ?? null,
      agent_kind: agentKind ?? null,
      since_ms: sinceMs ?? null,
    };
    const cursor = decodeListCursor(
      url,
      "work.list",
      filters,
      ["created_at", "run_id", "entry_kind"],
      true,
    );
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const createdSince = sinceMs !== undefined ? new Date(Date.parse(snapshotAt) - sinceMs).toISOString() : undefined;
    const snapshotPage = await service.listActivitySnapshotPage({
      includeInteractive: true,
      ...(host ? { host } : {}),
      observationHost: state.advertisedHost,
      ...(agentKind ? { agentKind } : {}),
      ...(createdSince ? { createdSince } : {}),
      createdBefore: snapshotAt,
      ...(cursor ? { after: activitySeekAfter(cursor)! } : {}),
      ...(cursor?.membership_fence
        ? { expectedMembershipFence: cursor.membership_fence }
        : {}),
      limit: limit + 1,
    }).catch((error: unknown) => {
      if (error instanceof RunListSnapshotChangedError) {
        throw new ListCursorError("cursor membership snapshot is stale; restart pagination");
      }
      if (error instanceof RunIndexProjectionNotReadyError) {
        writeError(response, 503, error.code, error.message, { retryable: true });
        return undefined;
      }
      if (!(error instanceof InteractiveActivityProjectionNotReadyError)) throw error;
      writeError(response, 503, error.code, error.message, {
        details: {
          reason: error.details.reason,
          candidate_limit: error.details.candidate_limit,
          candidates_seen: error.details.candidates_seen,
          identity_max_bytes: error.details.identity_max_bytes,
        },
        hint: "Retry after the transcript identity projection is within its bounded scan envelope.",
        retryable: true,
      });
      return undefined;
    });
    if (!snapshotPage) return;
    const page = boundedSeekPage(
      snapshotPage.entries,
      "work.list",
      filters,
      snapshotAt,
      undefined,
      limit,
      () => true,
      (entry) => ({
        created_at: entry.created_at,
        run_id: entry.run_id,
        entry_kind: entry.entry_kind,
      }),
      snapshotPage.membershipFence,
    );
    const observations = await Promise.all(page.values.map(async (entry) => entry.entry_kind === "interactive_session"
      ? toInteractiveObservation(entry)
      : toRunObservation(entry, await service.getRunRecord(entry.run_id))));
    writeJson(response, 200, {
      schema_version: "calyx.run-observation-list/v1",
      count: observations.length,
      truncated: page.truncated,
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      runs: observations,
    });
    return;
  }
  if (parts.length === 3) {
    const runId = decodeRequestPathSegment(parts[2]!);
    const record = await service.getRunRecord(runId);
    if (!record) {
      try {
        const interactive = await service.resolveInteractiveSession({ activityId: runId });
        writeJson(response, 200, toInteractiveObservation(interactive));
      } catch (error) {
        if (error instanceof InteractiveActivityProjectionNotReadyError) {
          writeError(response, 503, error.code, error.message, {
            details: {
              reason: error.details.reason,
              candidate_limit: error.details.candidate_limit,
              candidates_seen: error.details.candidates_seen,
              identity_max_bytes: error.details.identity_max_bytes,
            },
            hint: "Retry after the transcript identity projection is within its bounded scan envelope.",
            retryable: true,
          });
          return;
        }
        if (error instanceof ActivityIdMalformedError) {
          writeError(response, 400, "invalid_activity_id", error.message);
          return;
        }
        if (error instanceof ActivityIdNotFoundError) {
          writeError(response, 404, "not_found", `Work ${runId} was not found.`);
          return;
        }
        if (error instanceof ActivityIdAmbiguousError) {
          writeError(response, 409, "activity_ambiguous", error.message);
          return;
        }
        throw error;
      }
      return;
    }
    const agentReceipt = record.kernel_receipt && !("kernel" in record.kernel_receipt)
      ? record.kernel_receipt
      : undefined;
    const entry: RunListEntry = {
      run_id: record.run_id,
      state: record.state,
      summary: record.summary,
      created_at: record.created_at,
      updated_at: record.updated_at,
      ...(record.completed_at ? { completed_at: record.completed_at } : {}),
      ...(record.health?.status ? { health_status: record.health.status } : {}),
      ...(record.health?.last_progress_at ? { last_progress_at: record.health.last_progress_at } : {}),
      ...(record.health?.progress_signal ? { progress_signal: record.health.progress_signal } : {}),
      ...(agentReceipt?.terminal_evidence
        ? {
            terminal: {
              evidence: agentReceipt.terminal_evidence,
            },
          }
        : {}),
      ...(record.intent.issue ? { issue: record.intent.issue } : {}),
      host: record.intent.host,
      ...(record.intent.backend ? { backend: record.intent.backend } : {}),
      recovery_mode: record.recovery.mode,
      // Required only by the legacy internal list-entry type; DTO construction
      // never reads or emits this host-local path.
      run_dir: "",
    };
    writeJson(response, 200, toRunObservation(entry, record));
    return;
  }
  notFound(response, `/${parts.join("/")}`);
}

function parseActivityRole(value: string | null): ActivityMessageRole | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "user") {
    throw new ActivityMessageSelectorError(
      "ambiguous role `user`; use `role=human` for semantic messages or `raw_role=user` for raw events.",
    );
  }
  const normalized = trimmed.replace(/-/g, "_");
  if ((ACTIVITY_MESSAGE_ROLES as readonly string[]).includes(normalized)) {
    return normalized as ActivityMessageRole;
  }
  throw new ActivityMessageSelectorError(
    `Invalid role query value "${value}". Use one of: ${ACTIVITY_MESSAGE_ROLES.join(", ")}.`,
  );
}

function parseActivityVisibility(value: string | null): ActivityVisibilityTier | undefined {
  if (!value) {
    return undefined;
  }
  if ((ACTIVITY_VISIBILITY_TIERS as readonly string[]).includes(value)) {
    return value as ActivityVisibilityTier;
  }
  throw new ActivityMessageSelectorError(
    `Invalid visibility query value "${value}". Use one of: ${ACTIVITY_VISIBILITY_TIERS.join(", ")}.`,
  );
}

function parseActivityTurnRole(value: string | null): ActivityTurnRoleFilter | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if ((ACTIVITY_TURN_ROLE_FILTERS as readonly string[]).includes(trimmed)) {
    return trimmed as ActivityTurnRoleFilter;
  }
  throw new ActivityTurnSelectorError(
    `Invalid role query value "${value}". Use one of: ${ACTIVITY_TURN_ROLE_FILTERS.join(", ")}.`,
  );
}

function parseRawRole(value: string | null): InteractiveSessionEventRole | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "user" || value === "assistant" || value === "tool" || value === "system" || value === "unknown") {
    return value;
  }
  throw new ActivityEventSelectorError(
    `Invalid raw_role query value "${value}". Use one of: user, assistant, tool, system, unknown.`,
  );
}

function parseStrictNonNegativeQueryInteger(
  value: string | null,
  name: string,
  makeError: (message: string) => Error,
): number | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw makeError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw makeError(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function activityErrorStatus(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
  retryable?: boolean;
} {
  if (error instanceof ListCursorError) {
    return { status: 400, code: "invalid_request", message: error.message };
  }
  if (error instanceof ActivityAttachmentError) {
    return { status: error.httpStatus, code: error.code, message: error.message };
  }
  if (error instanceof InteractiveActivityProjectionNotReadyError) {
    return {
      status: 503,
      code: error.code,
      message: error.message,
      details: {
        reason: error.details.reason,
        candidate_limit: error.details.candidate_limit,
        candidates_seen: error.details.candidates_seen,
        identity_max_bytes: error.details.identity_max_bytes,
      },
      hint: "Retry after the transcript identity projection is within its bounded scan envelope.",
      retryable: error.retryable,
    };
  }
  if (error instanceof ActivityRunMissingMetadataError) {
    return { status: 422, code: "activity_metadata_unavailable", message: error.message };
  }
  if (error instanceof ActivityIdAmbiguousError) {
    return { status: 409, code: "activity_ambiguous", message: error.message };
  }
  // A malformed locator is a request defect, not an absence: 400, never 404.
  if (error instanceof ActivityIdMalformedError) {
    return { status: 400, code: "invalid_activity_id", message: error.message };
  }
  if (error instanceof ActivityIdNotFoundError) {
    return { status: 404, code: "activity_unknown", message: error.message };
  }
  if (error instanceof ActivityMessageNotFoundError) {
    return { status: 404, code: "activity_message_not_found", message: error.message };
  }
  if (
    error instanceof ActivityMessageSelectorError
    || error instanceof ActivityEventSelectorError
    || error instanceof ActivityTurnSelectorError
  ) {
    return { status: 400, code: "invalid_activity_selector", message: error.message };
  }
  return { status: 500, code: "internal_error", message: INTERNAL_ERROR_MESSAGE };
}

function writeActivityError(response: ServerResponse, error: unknown): void {
  const { status, code, message, details, hint, retryable } = activityErrorStatus(error);
  writeError(response, status, code, message, {
    ...(details ? { details } : {}),
    ...(hint ? { hint } : {}),
    ...(retryable === undefined ? {} : { retryable }),
  });
}

async function handleActivityMessagesV1(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  const selector: ActivityMessageSelectorInput = {};

  try {
    const role = parseActivityRole(url.searchParams.get("role"));
    if (role) selector.role = role;
    const visibility = parseActivityVisibility(url.searchParams.get("visibility"));
    if (visibility) selector.visibility = visibility;
    const first = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("first"),
      "first",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof first === "number") selector.first = first;
    const last = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("last"),
      "last",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof last === "number") selector.last = last;
    const aroundId = url.searchParams.get("around_id");
    if (aroundId && aroundId.trim().length > 0) selector.around_id = aroundId;
    const aroundText = url.searchParams.get("around_text");
    if (aroundText && aroundText.trim().length > 0) selector.around_text = aroundText;
    const ctx = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("context"),
      "context",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof ctx === "number") selector.context = ctx;
    const grep = url.searchParams.get("grep");
    if (grep && grep.trim().length > 0) selector.grep = grep;
    if (parseBooleanQueryParam(url.searchParams.get("summary_only"))) selector.summary_only = true;
    const maxText = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("max_text_chars"),
      "max_text_chars",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof maxText === "number") selector.max_text_chars = maxText;
    if (parseBooleanQueryParam(url.searchParams.get("explain_classification"))) {
      selector.explain_classification = true;
    }
    const latestSession = parseBooleanQueryParam(url.searchParams.get("latest_session"));
    const latestBackend = parseInteractiveAgentKind(url.searchParams.get("backend"));
    writeJson(response, 200, await service.inspectActivityMessages({
      ...(activityId ? { activityId } : {}),
      ...(latestSession ? { latestSession: true } : {}),
      ...(latestBackend ? { latestSessionBackend: latestBackend } : {}),
      selector,
    }));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleActivityEventsV1(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  const selector: ActivityEventSelectorInput = {};

  try {
    const rawRole = parseRawRole(url.searchParams.get("raw_role"));
    if (rawRole) selector.raw_role = rawRole;
    const tail = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("tail"),
      "tail",
      (message) => new ActivityEventSelectorError(message),
    );
    if (typeof tail === "number") selector.tail = tail;
    const aroundId = url.searchParams.get("around_id");
    if (aroundId && aroundId.trim().length > 0) selector.around_id = aroundId;
    const ctx = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("context"),
      "context",
      (message) => new ActivityEventSelectorError(message),
    );
    if (typeof ctx === "number") selector.context = ctx;
    if (parseBooleanQueryParam(url.searchParams.get("classify"))) {
      selector.classify = true;
    }
    if (parseBooleanQueryParam(url.searchParams.get("within_turn"))) {
      selector.within_turn = true;
    }
    const latestSession = parseBooleanQueryParam(url.searchParams.get("latest_session"));
    const latestBackend = parseInteractiveAgentKind(url.searchParams.get("backend"));
    writeJson(response, 200, await service.inspectActivityEvents({
      ...(activityId ? { activityId } : {}),
      ...(latestSession ? { latestSession: true } : {}),
      ...(latestBackend ? { latestSessionBackend: latestBackend } : {}),
      selector,
    }));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleActivityTurnsV1(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  const selector: ActivityTurnSelectorInput = {};

  try {
    const role = parseActivityTurnRole(url.searchParams.get("role"));
    if (role) selector.role = role;
    const first = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("first"),
      "first",
      (message) => new ActivityTurnSelectorError(message),
    );
    if (typeof first === "number") selector.first = first;
    const last = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("last"),
      "last",
      (message) => new ActivityTurnSelectorError(message),
    );
    if (typeof last === "number") selector.last = last;
    if (parseBooleanQueryParam(url.searchParams.get("with_tools"))) {
      selector.with_tools = true;
    }
    if (parseBooleanQueryParam(url.searchParams.get("summary_only"))) {
      selector.summary_only = true;
    }
    const maxText = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("max_text_chars"),
      "max_text_chars",
      (message) => new ActivityTurnSelectorError(message),
    );
    if (typeof maxText === "number") selector.max_text_chars = maxText;
    const latestSession = parseBooleanQueryParam(url.searchParams.get("latest_session"));
    const latestBackend = parseInteractiveAgentKind(url.searchParams.get("backend"));
    writeJson(response, 200, await service.inspectActivityTurns({
      ...(activityId ? { activityId } : {}),
      ...(latestSession ? { latestSession: true } : {}),
      ...(latestBackend ? { latestSessionBackend: latestBackend } : {}),
      selector,
    }));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleActivityTextV1(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  messageId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity-text", "http://localhost");
  const selector: ActivityTextSelectorInput = {};

  try {
    const range = url.searchParams.get("range");
    if (range && range.trim().length > 0) selector.range = range;
    const from = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("from"),
      "from",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof from === "number") selector.from = from;
    const classifierVersion = url.searchParams.get("classifier_version");
    if (classifierVersion && classifierVersion.trim().length > 0) {
      selector.classifier_version = classifierVersion;
    }
    writeJson(response, 200, await service.inspectActivityText({ messageId, selector }));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleActivityAttachmentsV1(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
  subpath: string[] = [],
  servedByHost?: string,
): Promise<void> {
  if (subpath.length === 1) {
    if (request.method !== "GET") {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
      return;
    }
    try {
      const ref = decodeRequestPathSegment(subpath[0]!);
      writeJson(response, 200, await service.inspectActivityAttachmentRecord({
        activityId,
        ref,
        ...(servedByHost ? { servedByHost } : {}),
        sourceTier: "origin-daemon",
      }));
    } catch (error) {
      if (error instanceof ActivityAttachmentError) {
        writeTypedAttachmentError(response, error);
        return;
      }
      writeActivityError(response, error);
    }
    return;
  }

  if (subpath.length === 2 && subpath[1] === "bytes") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
      return;
    }
    try {
      const ref = decodeRequestPathSegment(subpath[0]!);
      const result = await service.readActivityAttachmentBytes({
        activityId,
        ref,
        ...(servedByHost ? { servedByHost } : {}),
        sourceTier: "origin-daemon",
      });
      writeActivityAttachmentBytes(request, response, result.record, result.bytes);
    } catch (error) {
      if (error instanceof ActivityAttachmentError) {
        writeTypedAttachmentError(response, error);
        return;
      }
      writeActivityError(response, error);
    }
    return;
  }

  if (subpath.length > 0) {
    notFound(response, `/v1/activity/${activityId}/attachments/${subpath.join("/")}`);
    return;
  }

  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  const selector: ActivityAttachmentsSelectorInput = {};

  try {
    const turn = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("turn"),
      "turn",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (typeof turn === "number") selector.turn = turn;
    const messageId = url.searchParams.get("message");
    if (messageId && messageId.trim().length > 0) selector.message_id = messageId;
    if (parseBooleanQueryParam(url.searchParams.get("extract"))) {
      selector.extract = true;
    }
    const ref = url.searchParams.get("ref");
    if (ref && ref.trim().length > 0) selector.ref = ref;
    const outDir = url.searchParams.get("out");
    if (outDir && outDir.trim().length > 0) selector.out_dir = outDir;
    writeJson(response, 200, await service.inspectActivityAttachments({ activityId, selector }));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleActivityV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  state: PinnedRunServerState,
  parts: string[],
): Promise<void> {
  // parts[0] === "v1" and parts[1] === "activity" by the time we get here.
  const subpath = parts.slice(2);
  if (subpath.length === 0) {
    if (request.method !== "GET") {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
      return;
    }
    const url = new URL(request.url ?? "/v1/activity", "http://localhost");
    const limit = parsePositiveQueryInteger(url.searchParams.get("limit"));
    const host = url.searchParams.get("host") ?? undefined;
    const agentKind = parseInteractiveAgentKind(url.searchParams.get("agent_kind"));
    const sinceMs = parseNonNegativeQueryInteger(url.searchParams.get("since_ms"));
    writeJson(response, 200, await service.listActivity({
      includeInteractive: true,
      ...(host ? { host } : {}),
      observationHost: state.advertisedHost,
      ...(agentKind ? { agentKind } : {}),
      ...(typeof sinceMs === "number" ? { sinceMs } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    }));
    return;
  }

  const activityId = decodeRequestPathSegment(subpath[0]!);
  const verb = subpath[1];
  if (subpath.length === 1) {
    // /v1/activity/{id} → reuse legacy detail handler shape.
    const url = new URL(request.url ?? "/v1/activity", "http://localhost");
    const around = url.searchParams.get("around") ?? undefined;
    const tail = parseNonNegativeQueryInteger(url.searchParams.get("tail"));
    const ctx = parseNonNegativeQueryInteger(url.searchParams.get("context"));
    const includeTools = parseBooleanQueryParam(url.searchParams.get("include_tools"));
    try {
      writeJson(response, 200, await service.inspectInteractiveSession({
        activityId,
        ...(around ? { around } : {}),
        ...(typeof tail === "number" ? { tail } : {}),
        ...(typeof ctx === "number" ? { context: ctx } : {}),
        includeTools,
      }));
    } catch (error) {
      writeActivityError(response, error);
    }
    return;
  }
  if (verb === "messages") {
    await handleActivityMessagesV1(request, response, service, activityId);
    return;
  }
  if (verb === "events") {
    await handleActivityEventsV1(request, response, service, activityId);
    return;
  }
  if (verb === "turns") {
    await handleActivityTurnsV1(request, response, service, activityId);
    return;
  }
  if (verb === "attachments") {
    await handleActivityAttachmentsV1(request, response, service, activityId, subpath.slice(2), state.advertisedHost);
    return;
  }
  notFound(response, `/v1/activity/${activityId}/${verb ?? ""}`);
}

const CONSUMER_ACTIVITY_FORBIDDEN_QUERY_PARAMS = new Set([
  "around_id",
  "around_text",
  "classify",
  "classifier_version",
  "explain_classification",
  "extract",
  "first",
  "include_tools",
  "last",
  "out",
  "raw",
  "raw_role",
  "context",
  "visibility",
  "with_tools",
  "within_turn",
]);

function rejectConsumerActivityQuery(response: ServerResponse, url: URL): boolean {
  const forbidden = [...url.searchParams.keys()].find((key) => CONSUMER_ACTIVITY_FORBIDDEN_QUERY_PARAMS.has(key));
  if (!forbidden) return false;
  writeError(
    response,
    400,
    "consumer_selector_forbidden",
    `Query parameter ${forbidden} is available only through the admin activity API.`,
  );
  return true;
}

function boundedActivityCount(value: number | undefined, fallback: number): number {
  return Math.min(value ?? fallback, 100);
}

type ConsumerActivityOrder = "oldest_first" | "newest_first";

function parseConsumerActivityOrder(value: string | null): ConsumerActivityOrder {
  if (value === null || value === "oldest_first") return "oldest_first";
  if (value === "newest_first") return "newest_first";
  throw new ListCursorError("order must be oldest_first or newest_first");
}

async function handleConsumerActivityMessages(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  if (rejectConsumerActivityQuery(response, url)) return;
  try {
    const selector: ActivityMessageSelectorInput = {
      max_text_chars: Math.min(parseNonNegativeQueryInteger(url.searchParams.get("max_text_chars")) ?? 4_000, 4_000),
    };
    const role = parseActivityRole(url.searchParams.get("role"));
    if (role) selector.role = role;
    const grep = url.searchParams.get("grep");
    if (grep?.trim()) selector.grep = grep;
    if (parseBooleanQueryParam(url.searchParams.get("summary_only"))) selector.summary_only = true;
    const limit = boundedActivityCount(parsePositiveQueryInteger(url.searchParams.get("limit")), 20);
    const order = parseConsumerActivityOrder(url.searchParams.get("order"));
    const filters = {
      activity_id: activityId,
      role: role ?? null,
      grep: grep?.trim() || null,
      summary_only: selector.summary_only === true,
      max_text_chars: selector.max_text_chars,
      ...(order === "newest_first" ? { order } : {}),
    };
    const cursor = decodeListCursor(url, "activity.messages", filters, ["source_line"]);
    const afterSourceLine = cursor ? Number.parseInt(cursor.after["source_line"]!, 10) : undefined;
    if (afterSourceLine !== undefined && (!Number.isInteger(afterSourceLine) || afterSourceLine < 0)) {
      throw new ListCursorError("cursor is invalid for activity.messages");
    }
    if (afterSourceLine !== undefined) {
      if (order === "newest_first") selector.before_source_line = afterSourceLine;
      else selector.after_source_line = afterSourceLine;
    }
    if (order === "newest_first") selector.last = limit + 1;
    else selector.first = limit + 1;
    const source = await service.inspectActivityMessages({
      activityId,
      selector,
      consumerVisibleOnly: true,
    });
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const page = boundedSeekPage(
      order === "newest_first" ? [...source.messages].reverse() : source.messages,
      "activity.messages",
      filters,
      snapshotAt,
      undefined,
      limit,
      () => true,
      (message) => ({ source_line: String(message.source_lines[0] ?? 0) }),
    );
    writeJson(response, 200, toActivityMessagesObservation(
      { ...source, messages: page.values, returned_messages: page.values.length },
      page.next_cursor,
    ));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleConsumerActivityTurns(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  if (rejectConsumerActivityQuery(response, url)) return;
  try {
    const selector: ActivityTurnSelectorInput = {
      max_text_chars: Math.min(parseNonNegativeQueryInteger(url.searchParams.get("max_text_chars")) ?? 4_000, 4_000),
    };
    const role = parseActivityTurnRole(url.searchParams.get("role"));
    if (role) selector.role = role;
    if (parseBooleanQueryParam(url.searchParams.get("summary_only"))) selector.summary_only = true;
    const limit = boundedActivityCount(parsePositiveQueryInteger(url.searchParams.get("limit")), 20);
    const order = parseConsumerActivityOrder(url.searchParams.get("order"));
    const filters = {
      activity_id: activityId,
      role: role ?? null,
      summary_only: selector.summary_only === true,
      max_text_chars: selector.max_text_chars,
      ...(order === "newest_first" ? { order } : {}),
    };
    const cursor = decodeListCursor(url, "activity.turns", filters, ["turn_index"]);
    const afterTurnIndex = cursor ? Number.parseInt(cursor.after["turn_index"]!, 10) : undefined;
    if (afterTurnIndex !== undefined && (!Number.isInteger(afterTurnIndex) || afterTurnIndex < 0)) {
      throw new ListCursorError("cursor is invalid for activity.turns");
    }
    if (afterTurnIndex !== undefined) {
      if (order === "newest_first") selector.before_turn_index = afterTurnIndex;
      else selector.after_turn_index = afterTurnIndex;
    }
    if (order === "newest_first") selector.last = limit + 1;
    else selector.first = limit + 1;
    const source = await service.inspectActivityTurns({
      activityId,
      selector,
      consumerVisibleOnly: true,
    });
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const page = boundedSeekPage(
      order === "newest_first" ? [...source.turns].reverse() : source.turns,
      "activity.turns",
      filters,
      snapshotAt,
      undefined,
      limit,
      () => true,
      (turn) => ({ turn_index: String(turn.index) }),
    );
    writeJson(response, 200, toActivityTurnsObservation(
      { ...source, turns: page.values, returned_turns: page.values.length },
      page.next_cursor,
    ));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleConsumerActivityAttachments(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  activityId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity", "http://localhost");
  if (rejectConsumerActivityQuery(response, url)) return;
  try {
    const selector: ActivityAttachmentsSelectorInput = {};
    const turn = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("turn"),
      "turn",
      (message) => new ActivityMessageSelectorError(message),
    );
    if (turn !== undefined) selector.turn = turn;
    const messageId = url.searchParams.get("message");
    if (messageId?.trim()) selector.message_id = messageId;
    const source = await service.inspectActivityAttachments({
      activityId,
      selector,
      consumerVisibleOnly: true,
    });
    const attachmentSourceLine = (attachment: ActivityAttachmentRecord): number => {
      const matched = /:msg:(\d+)$/.exec(attachment.message_id);
      return matched ? Number.parseInt(matched[1]!, 10) : 0;
    };
    const ordered = [...source.attachments].sort((left, right) => (
      attachmentSourceLine(left) - attachmentSourceLine(right) || compareUtf8Bytes(left.ref, right.ref)
    ));
    const filters = {
      activity_id: activityId,
      turn: turn ?? null,
      message: messageId?.trim() || null,
    };
    const cursor = decodeListCursor(url, "activity.attachments", filters, ["source_line", "ref"]);
    if (cursor && !/^\d+$/.test(cursor.after["source_line"]!)) {
      throw new ListCursorError("cursor is invalid for activity.attachments");
    }
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const limit = boundedActivityCount(parsePositiveQueryInteger(url.searchParams.get("limit")), 20);
    const page = boundedSeekPage(
      ordered,
      "activity.attachments",
      filters,
      snapshotAt,
      cursor?.after,
      limit,
      (attachment, after) => {
        const line = attachmentSourceLine(attachment);
        const afterLine = Number.parseInt(after["source_line"]!, 10);
        return line > afterLine || (line === afterLine && attachment.ref > after["ref"]!);
      },
      (attachment) => ({ source_line: String(attachmentSourceLine(attachment)), ref: attachment.ref }),
    );
    writeJson(response, 200, {
      schema_version: "activity.attachments/v1",
      activity_id: source.activity_id,
      backend: source.backend,
      session_id: source.session_id,
      attachments: page.values.map(toActivityAttachmentObservation),
      truncated: page.truncated,
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
    });
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function handleConsumerActivityText(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  messageId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    return;
  }
  const url = new URL(request.url ?? "/v1/activity-text", "http://localhost");
  if (rejectConsumerActivityQuery(response, url)) return;
  try {
    const from = parseStrictNonNegativeQueryInteger(
      url.searchParams.get("from"),
      "from",
      (message) => new ActivityMessageSelectorError(message),
    );
    const source = await service.inspectActivityText({
      messageId,
      selector: { from: from ?? 0 },
      consumerVisibleOnly: true,
    });
    writeJson(response, 200, toActivityTextObservation(source));
  } catch (error) {
    writeActivityError(response, error);
  }
}

async function readConsumerActivityAttention(
  service: RunService,
  activityId: string,
): Promise<ConsumerActivityAttentionProjection> {
  try {
    const source = await service.inspectActivityTurns({
      activityId,
      consumerVisibleOnly: true,
      selector: {
        last: 1,
        max_text_chars: CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
      },
    });
    if (source.total_messages === 0) {
      return { attention_state: "idle", visible_message_count: 0 };
    }
    const latestTurn = source.turns.at(-1);
    const latestVisibleMessage = latestTurn?.messages
      .filter((message) => message.role === "human" || message.role === "assistant")
      .at(-1);
    const attentionState = latestTurn?.state === "in_flight"
      ? "working"
      : latestTurn?.state === "complete"
        ? "awaiting"
        : "unknown";
    return {
      attention_state: attentionState,
      ...(latestTurn
        ? { visible_message_count: latestTurn.visible_message_count }
        : {}),
      ...(latestVisibleMessage?.text
        ? { latest_visible_message_excerpt: latestVisibleMessage.text }
        : {}),
    };
  } catch {
    // The list row remains useful when its optional transcript projection
    // races source discovery or indexing. Unknown + omitted fields preserve
    // that uncertainty without fabricating idle/zero or exposing raw errors.
    return { attention_state: "unknown" };
  }
}

const CONSUMER_ACTIVITY_PAGE_PROJECTION_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const projected = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      projected[index] = await project(values[index]!, index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return projected;
}

async function handleConsumerActivityV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  state: PinnedRunServerState,
  parts: string[],
): Promise<void> {
  const subpath = parts.slice(2);
  if (subpath.length === 0) {
    if (request.method !== "GET") {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
      return;
    }
    const url = new URL(request.url ?? "/v1/activity", "http://localhost");
    if (rejectConsumerActivityQuery(response, url)) return;
    const requestedLimit = parsePositiveQueryInteger(url.searchParams.get("limit"));
    const limit = Math.min(requestedLimit ?? 50, 100);
    const host = url.searchParams.get("host") ?? undefined;
    const agentKind = parseInteractiveAgentKind(url.searchParams.get("agent_kind"));
    const sinceMs = parseNonNegativeQueryInteger(url.searchParams.get("since_ms"));
    const filters = {
      host: host ?? null,
      agent_kind: agentKind ?? null,
      since_ms: sinceMs ?? null,
    };
    const cursor = decodeListCursor(
      url,
      "activity.list",
      filters,
      ["created_at", "run_id", "entry_kind"],
      true,
    );
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const createdSince = sinceMs !== undefined ? new Date(Date.parse(snapshotAt) - sinceMs).toISOString() : undefined;
    const snapshotPage = await service.listActivitySnapshotPage({
      includeInteractive: true,
      ...(host ? { host } : {}),
      observationHost: state.advertisedHost,
      ...(agentKind ? { agentKind } : {}),
      ...(createdSince ? { createdSince } : {}),
      createdBefore: snapshotAt,
      ...(cursor ? { after: activitySeekAfter(cursor)! } : {}),
      ...(cursor?.membership_fence
        ? { expectedMembershipFence: cursor.membership_fence }
        : {}),
      limit: limit + 1,
    }).catch((error: unknown) => {
      if (error instanceof RunListSnapshotChangedError) {
        throw new ListCursorError("cursor membership snapshot is stale; restart pagination");
      }
      if (error instanceof RunIndexProjectionNotReadyError) {
        writeError(response, 503, error.code, error.message, { retryable: true });
        return undefined;
      }
      if (!(error instanceof InteractiveActivityProjectionNotReadyError)) throw error;
      writeError(response, 503, error.code, error.message, {
        details: {
          reason: error.details.reason,
          candidate_limit: error.details.candidate_limit,
          candidates_seen: error.details.candidates_seen,
          identity_max_bytes: error.details.identity_max_bytes,
        },
        hint: "Retry after the transcript identity projection is within its bounded scan envelope.",
        retryable: true,
      });
      return undefined;
    });
    if (!snapshotPage) return;
    const page = boundedSeekPage(
      snapshotPage.entries,
      "activity.list",
      filters,
      snapshotAt,
      undefined,
      limit,
      () => true,
      (entry) => ({
        created_at: entry.created_at,
        run_id: entry.run_id,
        entry_kind: entry.entry_kind,
      }),
      snapshotPage.membershipFence,
    );
    // Follow-up: derive interactive attention from the already-batched snapshot/recall store.
    const observations = await mapWithConcurrency(
      page.values,
      CONSUMER_ACTIVITY_PAGE_PROJECTION_CONCURRENCY,
      async (entry) => {
        if (entry.entry_kind === "interactive_session") {
          return toInteractiveObservation(
            entry,
            await readConsumerActivityAttention(service, entry.run_id),
          );
        }
        return toRunObservation(entry, await service.getRunRecord(entry.run_id));
      },
    );
    writeJson(response, 200, {
      schema_version: "calyx.activity-observation-list/v1",
      count: observations.length,
      truncated: page.truncated,
      ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      activities: observations,
    });
    return;
  }
  const activityId = decodeRequestPathSegment(subpath[0]!);
  if (subpath.length === 1) {
    await handleConsumerActivityTurns(request, response, service, activityId);
    return;
  }
  const verb = subpath[1];
  if (verb === "messages" && subpath.length === 2) {
    await handleConsumerActivityMessages(request, response, service, activityId);
    return;
  }
  if (verb === "turns" && subpath.length === 2) {
    await handleConsumerActivityTurns(request, response, service, activityId);
    return;
  }
  if (verb === "attachments" && subpath.length === 2) {
    await handleConsumerActivityAttachments(request, response, service, activityId);
    return;
  }
  notFound(response, `/v1/activity/${activityId}/${verb ?? ""}`);
}

type ConsumerActivityMarkCreateOutcome =
  | { kind: "created" | "replay"; status: number; response: unknown }
  | { kind: "conflict" };

function activityMarkCreateRequestHash(payload: ActivityMarkCreateRequest): string {
  const presenceNormalized: Partial<ActivityMarkCreateRequest> = { ...payload };
  delete presenceNormalized.idempotency_key;
  return hashCanonicalJcs(presenceNormalized);
}

function readConsumerActivityMarkReplay(args: {
  db: StateDriverDatabase;
  subject: string;
  idempotencyKey: string;
  requestHash: string;
}): ConsumerActivityMarkCreateOutcome | { kind: "miss" } {
  const existing = readApiIdempotency(
    args.db,
    args.subject,
    "attention.mark.create",
    args.idempotencyKey,
  );
  if (!existing) return { kind: "miss" };
  if (
    existing.request_hash !== args.requestHash
    || existing.canonicalizer !== API_IDEMPOTENCY_CANONICALIZER
    || existing.schema_major !== API_IDEMPOTENCY_SCHEMA_MAJOR
  ) {
    return { kind: "conflict" };
  }
  if (existing.response_status !== 200) {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "Activity mark replay authority carries an undeclared response status.",
    );
  }
  try {
    return {
      kind: "replay",
      status: existing.response_status,
      response: validateOperationSuccessResponse(
        "attention.mark.create",
        existing.response_status,
        existing.response,
      ).value,
    };
  } catch {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "Activity mark replay authority carries a malformed response receipt.",
    );
  }
}

function assertActivityMarksSchema(db: StateDriverDatabase): void {
  if (checkActivityMarksSchema(db).status !== "ok") {
    throw new ActivityMarksStateError(
      "activity_marks_schema_unavailable",
      "Activity marks schema is unavailable; run calyx state migrate --apply.",
    );
  }
}

async function readConsumerActivityMarkReplayPhase(args: {
  stateStoreOptions: StateOpenOptions;
  subject: string;
  idempotencyKey: string;
  requestHash: string;
}): Promise<ConsumerActivityMarkCreateOutcome | { kind: "miss" }> {
  const opened = await openStateStore(args.stateStoreOptions);
  try {
    opened.db.exec("BEGIN IMMEDIATE");
    try {
      const outcome = readConsumerActivityMarkReplay({
        db: opened.db,
        subject: args.subject,
        idempotencyKey: args.idempotencyKey,
        requestHash: args.requestHash,
      });
      if (outcome.kind === "miss") assertActivityMarksSchema(opened.db);
      opened.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      try { opened.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    opened.db.close();
  }
}

async function createConsumerActivityMarkAtomically(args: {
  auth: AuthenticatedRequestContext;
  payload: ActivityMarkCreateRequest;
  provenance: ApiProvenanceV1;
  service: RunService;
  stateStoreOptions: StateOpenOptions;
}): Promise<ConsumerActivityMarkCreateOutcome> {
  const requestHash = activityMarkCreateRequestHash(args.payload);
  const replayIdentity = {
    subject: args.auth.subject,
    idempotencyKey: args.payload.idempotency_key,
    requestHash,
  };
  const first = await readConsumerActivityMarkReplayPhase({
    stateStoreOptions: args.stateStoreOptions,
    ...replayIdentity,
  });
  if (first.kind !== "miss") return first;

  let targetResolution: { ok: true } | { ok: false; error: unknown } = { ok: true };
  try {
    await args.service.resolveMarkableActivityTarget({
      targetKind: args.payload.target_kind,
      targetId: args.payload.target_id,
    });
  } catch (error) {
    targetResolution = { ok: false, error };
  }

  const opened = await openStateStore(args.stateStoreOptions);
  let targetResolutionError: unknown;
  try {
    assertActivityMarksSchema(opened.db);
    opened.db.exec("BEGIN IMMEDIATE");
    try {
      const concurrent = readConsumerActivityMarkReplay({ db: opened.db, ...replayIdentity });
      if (concurrent.kind !== "miss") {
        opened.db.exec("COMMIT");
        return concurrent;
      }
      if (!targetResolution.ok) {
        targetResolutionError = targetResolution.error;
        opened.db.exec("COMMIT");
      } else {
        const mark = createActivityMark(opened.db, {
          target_kind: args.payload.target_kind,
          target_id: args.payload.target_id,
          kind: args.payload.kind,
          ...(args.payload.reason !== undefined ? { reason: args.payload.reason } : {}),
          provenance: args.provenance,
        });
        const response = toActivityMark(mark);
        recordApiIdempotency(opened.db, {
          subject: args.auth.subject,
          operation_id: "attention.mark.create",
          idempotency_key: args.payload.idempotency_key,
          asserted_actor: args.provenance.asserted_actor,
          first_request_id: args.provenance.request_id,
          first_request_provenance: args.provenance,
          request_hash: requestHash,
          response_status: 200,
          response,
          created_at: args.provenance.at,
        });
        opened.db.exec("COMMIT");
        return { kind: "created", status: 200, response };
      }
    } catch (error) {
      try { opened.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    }
  } finally {
    opened.db.close();
  }
  throw targetResolutionError;
}

function writeActivityMarkFailure(response: ServerResponse, error: unknown): boolean {
  if (error instanceof ActivityMarkTargetNotFoundError) {
    writeError(
      response,
      404,
      "mark_target_unknown",
      "Mark target was not found on this daemon's consumer-visible activity projection.",
      { hint: "Send the request to the daemon that owns the activity." },
    );
    return true;
  }
  if (error instanceof ActivityMarkTargetAmbiguousError) {
    writeError(
      response,
      409,
      "mark_target_ambiguous",
      "More than one local activity source claims the same canonical target identity.",
    );
    return true;
  }
  if (error instanceof ActivityMarkTargetUnavailableError) {
    writeError(
      response,
      503,
      "mark_target_unavailable",
      error.message,
      { retryable: true },
    );
    return true;
  }
  if (error instanceof ActivityMarksStateError) {
    if (error.code === "invalid_request") {
      writeError(response, 400, error.code, error.message);
      return true;
    }
    if (error.code === "mark_owner_forbidden") {
      writeError(response, 403, error.code, "Activity mark belongs to another authenticated subject.");
      return true;
    }
    if (error.code === "mark_unknown") {
      writeError(response, 404, error.code, "Activity mark was not found.");
      return true;
    }
    if (error.code === "activity_marks_schema_unavailable") {
      writeError(
        response,
        503,
        error.code,
        "Activity marks schema is unavailable; run calyx state migrate --apply.",
        { retryable: true },
      );
      return true;
    }
  }
  return false;
}

async function handleConsumerActivityMarksRequest(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  service: RunService,
  stateStoreOptions: StateOpenOptions,
  parts: string[],
): Promise<void> {
  if (request.method === "POST" && parts.length === 2) {
    const payload = await readRequestJson<ActivityMarkCreateRequest>(request);
    try {
      const outcome = await createConsumerActivityMarkAtomically({
        auth,
        payload,
        provenance: requireRequestProvenance(request),
        service,
        stateStoreOptions,
      });
      if (outcome.kind === "conflict") {
        writeError(
          response,
          409,
          "idempotency_conflict",
          "The idempotency key is already bound to a different activity mark request.",
          { hint: "Use a new idempotency_key for a different request." },
        );
        return;
      }
      writeJson(response, outcome.status, outcome.response);
    } catch (error) {
      if (!writeActivityMarkFailure(response, error)) throw error;
    }
    return;
  }

  const opened = await openStateStore(stateStoreOptions);
  try {
    if (checkActivityMarksSchema(opened.db).status !== "ok") {
      writeError(
        response,
        503,
        "activity_marks_schema_unavailable",
        "Activity marks schema is unavailable; run calyx state migrate --apply.",
        { retryable: true },
      );
      return;
    }
    if (request.method === "GET" && parts.length === 2) {
      const url = new URL(request.url ?? "/v1/marks", "http://localhost");
      try {
        const page = listActivityMarksSnapshotPage(opened.db, {
          ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind")! as "high_signal" | "foundational" } : {}),
          ...(url.searchParams.get("target_kind")
            ? { target_kind: url.searchParams.get("target_kind")! as "activity" | "turn" | "message" }
            : {}),
          ...(url.searchParams.get("target_id") ? { target_id: url.searchParams.get("target_id")! } : {}),
          ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
          ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
          ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        });
        writeJson(response, 200, toActivityMarkList(page));
      } catch (error) {
        if (error instanceof ActivityMarksStateError && error.code === "invalid_request") {
          writeError(response, 400, error.code, error.message, {
            hint: "Restart the list without a cursor after correcting the filters.",
          });
        } else if (!writeActivityMarkFailure(response, error)) {
          throw error;
        }
      }
      return;
    }
    if (request.method === "DELETE" && parts.length === 3) {
      try {
        const revoked = revokeActivityMark(opened.db, {
          mark_id: decodeRequestPathSegment(parts[2]!),
          provenance: requireRequestProvenance(request),
        });
        writeJson(response, 200, toActivityMarkRevocation(revoked));
      } catch (error) {
        if (!writeActivityMarkFailure(response, error)) throw error;
      }
      return;
    }
    notFound(response, `/${parts.join("/")}`);
  } finally {
    opened.db.close();
  }
}

async function handleMessagesV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  state: PinnedRunServerState,
  parts: string[],
  stateStoreOptions: StateOpenOptions,
): Promise<void> {
  if (parts.length !== 4) {
    notFound(response, `/${parts.join("/")}`);
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
    return;
  }

  let requestValidated = false;
  try {
    const payload = await readRequestJson<{ schema_version?: string; message?: unknown }>(request);
    if (payload.schema_version !== "calyx.msg-send/v1") {
      badRequest(response, "schema_version must be calyx.msg-send/v1.");
      return;
    }
    const incoming = remoteMessageRecord(payload.message);
    requestValidated = true;
    const incomingMessagePayload = isRecord(incoming["payload"])
      ? incoming["payload"]
      : {};
    for (const reservedKey of [
      "remote_sender_receipt_path",
      "remote_sender_spooled_at",
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(incomingMessagePayload, reservedKey)) {
        badRequest(response, `message.payload.${reservedKey} is receiver-owned and must not be supplied.`);
        return;
      }
    }
    const originSubjectHost = daemonSubjectHost(auth.subject);
    const originHost = authorizedInternalMessageOriginHost(auth.subject, state);
    if (!originHost) {
      writeError(response, 403, "internal_origin_forbidden", "Message ingress requires a canonical daemon origin subject.");
      return;
    }
    const senderAddress = requiredRemoteMessageString(incoming["sender"], "sender");
    const recipientAddress = requiredRemoteMessageString(incoming["recipient_address"], "recipient_address");
    let resolvedSender: ReturnType<typeof resolveMessageAddress>;
    let resolvedRecipient: ReturnType<typeof resolveMessageAddress>;
    try {
      resolvedSender = resolveMessageAddress(senderAddress, { currentHost: originHost });
      resolvedRecipient = resolveMessageAddress(recipientAddress, { currentHost: state.advertisedHost });
    } catch (error) {
      badRequest(response, error instanceof Error ? error.message : String(error));
      return;
    }
    const declaredRecipientHost = optionalRemoteMessageString(incoming["recipient_host"]);
    const originIdentity = configuredMessageHostIdentity(originHost, state);
    const localIdentity = localMessageHostIdentity(state);
    const localHost = localIdentity.canonicalHost;
    if (
      classifyMessageTargetHost(originSubjectHost!, originIdentity) !== "local"
      || !resolvedMessageAddressBelongsToHost(resolvedSender, originIdentity)
    ) {
      writeError(response, 403, "internal_origin_forbidden", "Message sender is not owned by the authenticated origin daemon.");
      return;
    }
    if (
      (declaredRecipientHost !== null && classifyMessageTargetHost(declaredRecipientHost, localIdentity) !== "local")
      || !resolvedMessageAddressBelongsToHost(resolvedRecipient, localIdentity)
    ) {
      writeError(response, 403, "internal_target_forbidden", "Message recipient is not owned by the receiving daemon.");
      return;
    }
    const rawCreatedProvenance = incoming["created_provenance"];
    let createdProvenance: ApiProvenanceV1 | null;
    try {
      createdProvenance = rawCreatedProvenance === null || rawCreatedProvenance === undefined
        ? null
        : validateApiProvenance(rawCreatedProvenance as ApiProvenanceV1);
    } catch (error) {
      badRequest(response, error instanceof Error ? error.message : String(error));
      return;
    }
    if (
      createdProvenance
      && classifyMessageTargetHost(createdProvenance.host, originIdentity) !== "local"
    ) {
      writeError(
        response,
        403,
        "internal_origin_forbidden",
        "Message created_provenance.host is not owned by the authenticated origin daemon.",
      );
      return;
    }
    const canonicalSender = canonicalizeOwnedMessageAddressHost(resolvedSender, originHost);
    const canonicalRecipient = canonicalizeOwnedMessageAddressHost(resolvedRecipient, localHost);
    for (const [label, resolved] of [
      ["sender", canonicalSender],
      ["recipient_address", canonicalRecipient],
    ] as const) {
      if (!hasCanonicalMessageAddressGrammar(resolved.address)) {
        badRequest(response, `message.${label} must resolve to a canonical message address.`);
        return;
      }
    }
    const recipientClass = incoming["recipient_class"];
    if (recipientClass !== "directed" && recipientClass !== "scope") {
      badRequest(response, "message.recipient_class must be directed or scope.");
      return;
    }
    if (recipientClass !== canonicalRecipient.recipient_class) {
      badRequest(
        response,
        `message.recipient_class must match the resolved recipient address (${canonicalRecipient.recipient_class}).`,
      );
      return;
    }
    const urgency = incoming["urgency"];
    const opened = await openStateStore(stateStoreOptions);
    try {
      const schema = checkMessageSchema(opened.db);
      if (schema.status !== "ok") {
        writeError(
          response,
          503,
          "message_schema_unavailable",
          "Message API schema is unavailable; run calyx state migrate --apply.",
          { retryable: true },
        );
        return;
      }
      opened.db.exec("BEGIN IMMEDIATE");
      let result: ReturnType<typeof createMessage>;
      try {
        const createInput = {
          message_id: requiredRemoteMessageString(incoming["message_id"], "message_id"),
          sender: canonicalSender.address,
          recipient_address: canonicalRecipient.address,
          recipient_class: canonicalRecipient.recipient_class,
          recipient_host: canonicalRecipient.target_host,
          subject: requiredRemoteMessageString(incoming["subject"], "subject"),
          body: typeof incoming["body"] === "string" ? incoming["body"] : "",
          thread_key: optionalRemoteMessageString(incoming["thread_key"]),
          reply_to: optionalRemoteMessageString(incoming["reply_to"]),
          idempotency_key: optionalRemoteMessageString(incoming["idempotency_key"]),
          urgency: typeof urgency === "string" ? urgency as MessageRow["urgency"] : "normal",
          ack_required: incoming["ack_required"] === true,
          expires_at: optionalRemoteMessageString(incoming["expires_at"]),
          status: "pending",
          spooled_at: new Date().toISOString(),
          created_provenance: createdProvenance,
          ingress_provenance: requireRequestProvenance(request),
          payload: {
            ...incomingMessagePayload,
            remote_sender_receipt_path: optionalRemoteMessageString(incoming["receipt_path"]),
            remote_sender_spooled_at: optionalRemoteMessageString(incoming["spooled_at"]),
          },
        } satisfies Parameters<typeof createMessage>[1];
        result = createMessage(opened.db, createInput);
        if (!result.inserted) {
          const storedRecipientHost = result.message.recipient_host ?? undefined;
          let resolvedExistingSender: ReturnType<typeof resolveMessageAddress>;
          let resolvedExistingRecipient: ReturnType<typeof resolveMessageAddress>;
          try {
            resolvedExistingSender = resolveMessageAddress(result.message.sender, { currentHost: originHost });
            resolvedExistingRecipient = resolveMessageAddress(result.message.recipient_address, {
              currentHost: state.advertisedHost,
              coordinatorHost: storedRecipientHost,
              explicitHost: storedRecipientHost,
            });
          } catch {
            throw new MessageIngressIdentityConflictError(
              `message_id ${result.message.message_id} is already bound to an unresolvable routing identity`,
            );
          }
          if (
            !resolvedMessageAddressBelongsToHost(resolvedExistingSender, originIdentity)
            || !resolvedMessageAddressBelongsToHost(resolvedExistingRecipient, localIdentity)
            || (
              result.message.recipient_host !== null
              && classifyMessageTargetHost(result.message.recipient_host, localIdentity) !== "local"
            )
            || result.message.recipient_class !== resolvedExistingRecipient.recipient_class
          ) {
            throw new MessageIngressIdentityConflictError(
              `message_id ${result.message.message_id} is already bound to inconsistent or foreign-host routing`,
            );
          }
          const existingSender = canonicalizeOwnedMessageAddressHost(resolvedExistingSender, originHost);
          const existingRecipient = canonicalizeOwnedMessageAddressHost(resolvedExistingRecipient, localHost);
          if (
            !hasCanonicalMessageAddressGrammar(existingSender.address)
            || !hasCanonicalMessageAddressGrammar(existingRecipient.address)
          ) {
            throw new MessageIngressIdentityConflictError(
              `message_id ${result.message.message_id} is already bound to a non-canonical routing identity`,
            );
          }
          const canonicalExisting = {
            ...result.message,
            sender: existingSender.address,
            recipient_address: existingRecipient.address,
            recipient_class: existingRecipient.recipient_class,
            recipient_host: existingRecipient.target_host,
          } satisfies MessageRow;
          const candidate = {
            ...result.message,
            ...createInput,
            body: createInput.body ?? "",
            thread_key: createInput.thread_key ?? null,
            reply_to: createInput.reply_to ?? null,
            idempotency_key: createInput.idempotency_key ?? null,
            recipient_host: createInput.recipient_host ?? null,
            expires_at: createInput.expires_at ?? null,
            payload: createInput.payload ?? {},
            created_provenance: createdProvenance,
          } satisfies MessageRow;
          if (!messageIngressIdentityMatches(canonicalExisting, candidate)) {
            throw new MessageIngressIdentityConflictError(
              `message_id ${result.message.message_id} is already bound to different immutable ingress content`,
            );
          }
        }
        if (opened.paths.stateDir) enqueueMessageReceiptMirror(opened.db, result.message.message_id);
        opened.db.exec("COMMIT");
      } catch (error) {
        try {
          opened.db.exec("ROLLBACK");
        } catch {
          // Preserve the transaction failure rather than a secondary rollback error.
        }
        throw error;
      }
      if (opened.paths.stateDir) {
        await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: result.message.message_id,
          force: true,
          limit: 1,
        });
      }
      const message = readMessage(opened.db, result.message.message_id) ?? result.message;
      const escalation = {
        mode: "pointer_only" as const,
        reason: "execution_requires_control_plane_authority" as const,
      };
      writeJson(response, 200, {
        schema_version: "calyx.msg-receive/v1",
        inserted: result.inserted,
        message,
        escalation,
      });
    } finally {
      opened.db.close();
    }
  } catch (error) {
    if (isRequestTransportError(error)) throw error;
    if (error instanceof MessageIngressIdentityConflictError) {
      writeError(response, 409, "message_identity_conflict", error.message);
      return;
    }
    if (requestValidated) throw error;
    badRequest(response, error instanceof Error ? error.message : String(error));
  }
}

function messageRequestHash(payload: MsgSendRequest): string {
  const presenceNormalized: Partial<MsgSendRequest> = { ...payload };
  delete presenceNormalized.idempotency_key;
  return hashCanonicalJcs(presenceNormalized);
}

type ConsumerMessageSendResult = {
  schema_version: "calyx.msg-send-result/v1";
  inserted: true;
  delivery_state: "inert" | "outbox";
  message: ReturnType<typeof toMessageObservation>;
  operation?: { status: "accepted"; locator: string; receipt_locator: string };
  outbox?: { outbox_id: string; target_host: string; status: "pending"; created_at: string; expires_at: string };
};

type AtomicConsumerMessageSendOutcome =
  | { kind: "created"; message: MessageRow; response_status: 200 | 202; response: ConsumerMessageSendResult }
  | { kind: "replay"; message_id: string; response_status: number; response: unknown }
  | { kind: "conflict"; reason: "request_mismatch" | "orphaned_message_binding" };

type ConsumerMessageWireReplayOutcome =
  | Extract<AtomicConsumerMessageSendOutcome, { kind: "replay" | "conflict" }>
  | { kind: "miss"; existing_binding: boolean };

function messageIdFromConsumerSendResponse(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const message = (response as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const messageId = (message as Record<string, unknown>)["message_id"];
  return typeof messageId === "string" && messageId.trim() ? messageId : undefined;
}

/**
 * Recover an admitted msg.send using only its validated wire identity.
 *
 * This lookup deliberately runs before address resolution and current fleet
 * policy. A first-party transport retries the retained wire request; once that
 * exact presence-normalized request has been admitted, topology drift cannot
 * turn recovery of its durable result into a new routing decision.
 */
function replayConsumerMessageByWireIdentity(args: {
  db: StateDriverDatabase;
  subject: string;
  idempotency_key: string;
  wire_request_hash: string;
  receipt_mirror_enabled: boolean;
}): ConsumerMessageWireReplayOutcome {
  args.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = readApiIdempotency(
      args.db,
      args.subject,
      "msg.send",
      args.idempotency_key,
    );
    if (!existing || existing.wire_request_hash !== args.wire_request_hash) {
      args.db.exec("COMMIT");
      return { kind: "miss", existing_binding: existing !== undefined };
    }
    if (
      existing.canonicalizer !== API_IDEMPOTENCY_CANONICALIZER
      || existing.schema_major !== API_IDEMPOTENCY_SCHEMA_MAJOR
    ) {
      args.db.exec("COMMIT");
      return { kind: "conflict", reason: "request_mismatch" };
    }
    const messageId = messageIdFromConsumerSendResponse(existing.response);
    if (!messageId || !readMessage(args.db, messageId)) {
      args.db.exec("ROLLBACK");
      return { kind: "conflict", reason: "orphaned_message_binding" };
    }
    if (args.receipt_mirror_enabled) enqueueMessageReceiptMirror(args.db, messageId);
    args.db.exec("COMMIT");
    return {
      kind: "replay",
      message_id: messageId,
      response_status: existing.response_status,
      response: existing.response,
    };
  } catch (error) {
    try {
      args.db.exec("ROLLBACK");
    } catch {
      // Preserve the transaction failure rather than a secondary rollback error.
    }
    throw error;
  }
}

function submitConsumerMessageAtomically(args: {
  db: StateDriverDatabase;
  subject: string;
  payload: MsgSendRequest;
  wire_request_hash: string;
  semantic_request_hash: string;
  reply_address: ReturnType<typeof resolveMessageAddress>;
  recipient: ReturnType<typeof resolveMessageAddress>;
  local: boolean;
  receipt_mirror_enabled: boolean;
  asserted_actor?: string | undefined;
  provenance: ApiProvenanceV1;
}): AtomicConsumerMessageSendOutcome {
  args.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = readApiIdempotency(
      args.db,
      args.subject,
      "msg.send",
      args.payload.idempotency_key,
    );
    if (existing) {
      const supportedWireIdentity = existing.canonicalizer === API_IDEMPOTENCY_CANONICALIZER
        && existing.schema_major === API_IDEMPOTENCY_SCHEMA_MAJOR;
      const wireReplay = supportedWireIdentity
        && existing.wire_request_hash === args.wire_request_hash;
      const semanticReplay = supportedWireIdentity
        && existing.semantic_canonicalizer === MSG_SEND_SEMANTIC_CANONICALIZER
        && existing.request_hash === args.semantic_request_hash;
      if (!wireReplay && !semanticReplay) {
        args.db.exec("COMMIT");
        return { kind: "conflict", reason: "request_mismatch" };
      }
      const messageId = messageIdFromConsumerSendResponse(existing.response);
      if (!messageId || !readMessage(args.db, messageId)) {
        args.db.exec("ROLLBACK");
        return { kind: "conflict", reason: "orphaned_message_binding" };
      }
      if (args.receipt_mirror_enabled) enqueueMessageReceiptMirror(args.db, messageId);
      args.db.exec("COMMIT");
      return {
        kind: "replay",
        message_id: messageId,
        response_status: existing.response_status,
        response: existing.response,
      };
    }

    const created = createMessage(args.db, {
      sender: args.reply_address.address,
      recipient_address: args.recipient.address,
      recipient_class: args.recipient.recipient_class,
      recipient_host: args.recipient.target_host,
      subject: args.payload.subject,
      ...(args.payload.body !== undefined ? { body: args.payload.body } : {}),
      ...(args.payload.thread_key !== undefined ? { thread_key: args.payload.thread_key } : {}),
      ...(args.payload.reply_to !== undefined ? { reply_to: args.payload.reply_to } : {}),
      idempotency_key: `${args.subject}:${args.payload.idempotency_key}`,
      ...(args.payload.urgency !== undefined ? { urgency: args.payload.urgency } : {}),
      ...(args.payload.ack_required !== undefined ? { ack_required: args.payload.ack_required } : {}),
      ...(args.payload.expires_at !== undefined ? { expires_at: args.payload.expires_at } : {}),
      status: args.local ? "pending" : "outbox",
      created_provenance: args.provenance,
      payload: {
        authenticated_subject: args.subject,
        address_input: args.recipient.input,
        address_kind: args.recipient.kind,
        reply_address_input: args.reply_address.input,
        reply_address_kind: args.reply_address.kind,
        ...(args.asserted_actor ? { asserted_actor: args.asserted_actor } : {}),
      },
    });
    if (!created.inserted) {
      args.db.exec("ROLLBACK");
      return { kind: "conflict", reason: "orphaned_message_binding" };
    }

    const outbox = !args.local && args.recipient.target_host
      ? enqueueMessageOutbox(args.db, {
        message_id: created.message.message_id,
        target_host: args.recipient.target_host,
        payload: { recipient_address: args.recipient.address },
      })
      : undefined;
    const response: ConsumerMessageSendResult = {
      schema_version: "calyx.msg-send-result/v1",
      inserted: true,
      delivery_state: args.local ? "inert" : "outbox",
      message: toMessageObservation(created.message),
      ...(outbox
        ? {
            operation: {
              status: "accepted" as const,
              locator: `/v1/message-operations/${encodeURIComponent(outbox.outbox_id)}`,
              receipt_locator: `/v1/message-operations/${encodeURIComponent(outbox.outbox_id)}`,
            },
            outbox: {
              outbox_id: outbox.outbox_id,
              target_host: outbox.target_host,
              status: "pending" as const,
              created_at: outbox.created_at,
              expires_at: outbox.expires_at,
            },
          }
        : {}),
    };
    const responseStatus = outbox ? 202 : 200;
    recordApiIdempotency(args.db, {
      subject: args.subject,
      operation_id: "msg.send",
      idempotency_key: args.payload.idempotency_key,
      asserted_actor: args.asserted_actor,
      first_request_id: args.provenance.request_id,
      first_request_provenance: args.provenance,
      wire_request_hash: args.wire_request_hash,
      request_hash: args.semantic_request_hash,
      semantic_canonicalizer: MSG_SEND_SEMANTIC_CANONICALIZER,
      response_status: responseStatus,
      response,
    });
    if (args.receipt_mirror_enabled) {
      enqueueMessageReceiptMirror(args.db, created.message.message_id);
    }
    args.db.exec("COMMIT");
    return { kind: "created", message: created.message, response_status: responseStatus, response };
  } catch (error) {
    try {
      args.db.exec("ROLLBACK");
    } catch {
      // Preserve the transaction failure rather than a secondary rollback error.
    }
    throw error;
  }
}

function parseMessageListLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (!raw) return 50;
  if (!/^\d+$/.test(raw)) throw new MessageQueryError("limit must be a positive integer");
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) throw new MessageQueryError("limit must be a positive integer");
  return Math.min(parsed, 100);
}

class MessageQueryError extends Error {}

function parseMessageListStatus(url: URL): MessageRow["status"] | "open" | "all" | undefined {
  const status = url.searchParams.get("status")?.trim();
  if (!status) return undefined;
  if (
    status === "open"
    || status === "all"
    || status === "outbox"
    || status === "pending"
    || status === "claimed"
    || status === "acked"
    || status === "dead_letter"
    || status === "delivery_failed"
  ) return status;
  throw new MessageQueryError("status is invalid");
}

function writeConsumerMessageIdempotencyConflict(
  response: ServerResponse,
  outcome: Extract<AtomicConsumerMessageSendOutcome, { kind: "conflict" }>,
): void {
  writeError(
    response,
    409,
    "idempotency_conflict",
    outcome.reason === "request_mismatch"
      ? "The idempotency key is already bound to a different or unsupported request representation."
      : "The idempotency key is already bound to a message without a matching API receipt.",
    {
      details: {
        operation: "msg.send",
        reason: outcome.reason,
        hint: "Use a new idempotency_key for a different request.",
      },
    },
  );
}

async function handleConsumerMessagesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  state: PinnedRunServerState,
  stateStoreOptions: StateOpenOptions,
  parts: string[],
): Promise<void> {
  const subpath = parts.slice(2);
  const operation = subpath[0];
  const opened = await openStateStore(stateStoreOptions);
  try {
    const schema = checkMessageSchema(opened.db);
    if (schema.status !== "ok") {
      writeError(
        response,
        503,
        "message_schema_unavailable",
        "Message API schema is unavailable; run calyx state migrate --apply.",
        { details: { findings: schema.findings } },
      );
      return;
    }

    if (operation === "send" && subpath.length === 1) {
      if (request.method !== "POST") {
        writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
        return;
      }
      let payload: MsgSendRequest;
      try {
        payload = validateOperationRequest("msg.send", await readRequestJson<unknown>(request)) as MsgSendRequest;
      } catch (error) {
        if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
        writeError(response, 400, "invalid_request", error instanceof Error ? error.message : String(error));
        return;
      }
      const wireRequestHash = messageRequestHash(payload);
      const wireReplay = replayConsumerMessageByWireIdentity({
        db: opened.db,
        subject: auth.subject,
        idempotency_key: payload.idempotency_key,
        wire_request_hash: wireRequestHash,
        receipt_mirror_enabled: Boolean(opened.paths.stateDir),
      });
      if (wireReplay.kind === "conflict") {
        writeConsumerMessageIdempotencyConflict(response, wireReplay);
        return;
      }
      if (wireReplay.kind === "replay") {
        if (opened.paths.stateDir) {
          await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
            message_id: wireReplay.message_id,
            force: true,
            limit: 1,
          });
        }
        writeJson(response, wireReplay.response_status, wireReplay.response);
        return;
      }
      const rejectUnprovenSemanticReplay = (): boolean => {
        if (!wireReplay.existing_binding) return false;
        writeConsumerMessageIdempotencyConflict(response, {
          kind: "conflict",
          reason: "request_mismatch",
        });
        return true;
      };
      let replyAddress: ReturnType<typeof resolveMessageAddress>;
      try {
        replyAddress = resolveMessageAddress(payload.reply_address, { currentHost: state.advertisedHost });
      } catch (error) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "invalid_reply_address", error instanceof Error ? error.message : String(error));
        return;
      }
      if (replyAddress.recipient_class !== "directed") {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "invalid_reply_address", "reply_address must resolve to a directed inbox.");
        return;
      }
      const localHostIdentity = localMessageHostIdentity(state);
      if (classifyMessageTargetHost(replyAddress.target_host, localHostIdentity) !== "local") {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "invalid_reply_address", "reply_address must belong to the receiving daemon.");
        return;
      }
      replyAddress = canonicalizeOwnedMessageAddressHost(replyAddress, localHostIdentity.canonicalHost);
      if (!hasCanonicalMessageAddressGrammar(replyAddress.address)) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "invalid_reply_address", "reply_address must resolve to a canonical message address.");
        return;
      }
      if (!addressGranted(auth.address_grants.send_as, replyAddress.address)) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(
          response,
          403,
          "address_grant_forbidden",
          `Credential ${auth.subject} is not granted send_as ${replyAddress.address}.`,
        );
        return;
      }

      let resolved: ReturnType<typeof resolveMessageAddress>;
      try {
        resolved = resolveMessageAddress(payload.recipient_address, { currentHost: state.advertisedHost });
      } catch (error) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "invalid_recipient_address", error instanceof Error ? error.message : String(error));
        return;
      }
      const configuredTargetHost = resolved.target_host === null
        ? undefined
        : configuredRemoteMessageHost(resolved.target_host, state);
      const targetClassification = configuredTargetHost
        && configuredTargetHost !== localHostIdentity.canonicalHost
        ? "remote"
        : classifyMessageTargetHost(resolved.target_host, localHostIdentity);
      if (targetClassification === "local_alias_collision") {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(
          response,
          400,
          "invalid_recipient_address",
          "recipient_address host collides with a local alias but is not an exact configured local identity.",
        );
        return;
      }
      const local = targetClassification === "local";
      if (local) {
        resolved = canonicalizeOwnedMessageAddressHost(resolved, localHostIdentity.canonicalHost);
      } else if (resolved.target_host !== null) {
        if (!configuredTargetHost) {
          if (rejectUnprovenSemanticReplay()) return;
          writeError(
            response,
            400,
            "invalid_recipient_address",
            "recipient_address must target an exact configured fleet host identity.",
          );
          return;
        }
        resolved = canonicalizeOwnedMessageAddressHost(resolved, configuredTargetHost);
      }
      if (!hasCanonicalMessageAddressGrammar(resolved.address)) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(
          response,
          400,
          "invalid_recipient_address",
          "recipient_address must resolve to a canonical message address.",
        );
        return;
      }
      const executionRecipientKind = executionCapableMessageAddressKind(resolved);
      if (executionRecipientKind) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(
          response,
          403,
          "execution_recipient_forbidden",
          "Consumer message submissions cannot target an execution-capable recipient.",
          { details: { recipient_kind: executionRecipientKind } },
        );
        return;
      }
      if (resolved.recipient_class === "scope" && !payload.expires_at) {
        if (rejectUnprovenSemanticReplay()) return;
        writeError(response, 400, "scope_expiry_required", "Scope bulletins require expires_at.");
        return;
      }

      const canonicalPayload: MsgSendRequest = {
        ...payload,
        recipient_address: resolved.address,
        reply_address: replyAddress.address,
      };
      const semanticRequestHash = messageRequestHash(canonicalPayload);
      const outcome = submitConsumerMessageAtomically({
        db: opened.db,
        subject: auth.subject,
        payload: canonicalPayload,
        wire_request_hash: wireRequestHash,
        semantic_request_hash: semanticRequestHash,
        reply_address: replyAddress,
        recipient: resolved,
        local,
        receipt_mirror_enabled: Boolean(opened.paths.stateDir),
        asserted_actor: requestAssertedActors.get(request),
        provenance: requireRequestProvenance(request),
      });
      if (outcome.kind === "conflict") {
        writeConsumerMessageIdempotencyConflict(response, outcome);
        return;
      }
      if (outcome.kind === "replay") {
        if (opened.paths.stateDir) {
          await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
            message_id: outcome.message_id,
            force: true,
            limit: 1,
          });
        }
        writeJson(response, outcome.response_status, outcome.response);
        return;
      }
      if (opened.paths.stateDir) {
        await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: outcome.message.message_id,
          force: true,
          limit: 1,
        });
      }
      writeJson(response, outcome.response_status, outcome.response);
      return;
    }

    if (request.method !== "GET") {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
      return;
    }

    if (operation === "doctor" && subpath.length === 1) {
      const counts = countAuthorizedMessages(opened.db, {
        read_grants: auth.address_grants.read,
        send_as_grants: auth.address_grants.send_as,
      });
      writeJson(response, 200, {
        schema_version: "calyx.message-doctor/v1",
        subject: auth.subject,
        schema_status: "ok",
        counts,
        receipt_mirrors: countAuthorizedMessageReceiptMirrorsByStatus(opened.db, {
          read_grants: auth.address_grants.read,
          send_as_grants: auth.address_grants.send_as,
        }),
      });
      return;
    }

    if (operation === "inbox" && subpath.length === 1) {
      const url = new URL(request.url ?? "/v1/messages/inbox", "http://localhost");
      const scope = url.searchParams.get("scope")?.trim() || undefined;
      if (scope) {
        let granted: boolean;
        try {
          granted = addressGranted(auth.address_grants.read, scope);
        } catch {
          throw new MessageQueryError("scope must be a canonical message address");
        }
        if (!granted) {
          writeError(response, 403, "address_grant_forbidden", `Credential ${auth.subject} cannot read ${scope}.`);
          return;
        }
      }
      const listed = listAuthorizedMessages(opened.db, {
        read_grants: auth.address_grants.read,
        send_as_grants: auth.address_grants.send_as,
        cursor_context: canonicalizeJcs({ operation: "msg.inbox", subject: auth.subject, scope: scope ?? null, status: parseMessageListStatus(url) ?? "open" }),
        ...(scope ? { recipient_address: scope } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        limit: parseMessageListLimit(url),
        status: parseMessageListStatus(url) ?? "open",
      });
      const maxTextChars = Math.min(parseNonNegativeQueryInteger(url.searchParams.get("max_text_chars")) ?? 4_000, 4_000);
      writeJson(response, 200, {
        schema_version: "calyx.message-inbox/v1",
        subject: auth.subject,
        count: listed.messages.length,
        truncated: listed.truncated,
        ...(listed.next_cursor ? { next_cursor: listed.next_cursor } : {}),
        messages: listed.messages.map((message) => toMessageObservation(message, maxTextChars)),
      });
      return;
    }

    if (operation === "threads" && subpath.length === 2) {
      const url = new URL(request.url ?? "/v1/messages/threads", "http://localhost");
      const threadKey = decodeRequestPathSegment(subpath[1]!);
      const listed = listAuthorizedMessages(opened.db, {
        read_grants: auth.address_grants.read,
        send_as_grants: auth.address_grants.send_as,
        cursor_context: canonicalizeJcs({ operation: "msg.thread", subject: auth.subject, thread_key: threadKey }),
        thread_key: threadKey,
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        limit: parseMessageListLimit(url),
        status: "all",
      });
      const maxTextChars = Math.min(parseNonNegativeQueryInteger(url.searchParams.get("max_text_chars")) ?? 4_000, 4_000);
      writeJson(response, 200, {
        schema_version: "calyx.message-thread/v1",
        subject: auth.subject,
        thread_key: threadKey,
        count: listed.messages.length,
        truncated: listed.truncated,
        ...(listed.next_cursor ? { next_cursor: listed.next_cursor } : {}),
        messages: listed.messages.map((message) => toMessageObservation(message, maxTextChars)),
      });
      return;
    }

    notFound(response, `/${parts.join("/")}`);
  } catch (error) {
    if (error instanceof MessageQueryError || error instanceof MessageCursorError || error instanceof ListCursorError) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }
    throw error;
  } finally {
    opened.db.close();
  }
}

async function handleConsumerMessageTextRequest(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  stateStoreOptions: StateOpenOptions,
  messageId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/v1/message-text", "http://localhost");
  const from = parseNonNegativeQueryInteger(url.searchParams.get("from")) ?? 0;
  const opened = await openStateStore(stateStoreOptions);
  try {
    if (checkMessageSchema(opened.db).status !== "ok") {
      writeError(response, 503, "message_schema_unavailable", "Message API schema is unavailable; run calyx state migrate --apply.");
      return;
    }
    const message = readAuthorizedMessage(opened.db, messageId, {
      read_grants: auth.address_grants.read,
      send_as_grants: auth.address_grants.send_as,
    });
    if (!message) {
      writeError(response, 404, "message_unknown", "Message was not found.");
      return;
    }
    const start = Math.min(from, message.body.length);
    const end = Math.min(message.body.length, start + 4_000);
    writeJson(response, 200, {
      schema_version: "calyx.message-text/v1",
      message_id: message.message_id,
      text: message.body.slice(start, end),
      text_cursor: {
        total_chars: message.body.length,
        returned: [start, end],
        ...(end < message.body.length ? { next: end } : {}),
      },
    });
  } finally {
    opened.db.close();
  }
}

async function handleConsumerMessageOperationRequest(
  response: ServerResponse,
  auth: AuthenticatedRequestContext,
  stateStoreOptions: StateOpenOptions,
  outboxId: string,
): Promise<void> {
  const opened = await openStateStore(stateStoreOptions);
  try {
    if (checkMessageSchema(opened.db).status !== "ok") {
      writeError(response, 503, "message_schema_unavailable", "Message API schema is unavailable; run calyx state migrate --apply.");
      return;
    }
    const outbox = readMessageOutbox(opened.db, outboxId);
    const message = outbox
      ? readAuthorizedMessage(opened.db, outbox.message_id, {
          read_grants: auth.address_grants.read,
          send_as_grants: auth.address_grants.send_as,
          include_expired: true,
        })
      : undefined;
    if (!outbox || !message) {
      writeError(response, 404, "message_operation_unknown", "Message operation was not found.");
      return;
    }
    writeJson(response, 200, toMessageOperationResponse(outbox, message));
  } finally {
    opened.db.close();
  }
}

function toMessageOperationResponse(
  outbox: NonNullable<ReturnType<typeof readMessageOutbox>>,
  message: MessageRow,
): object {
  const terminal = outbox.status !== "pending" && outbox.status !== "in_flight";
  const messageExpired = Boolean(message.expires_at && Date.parse(message.expires_at) <= Date.now());
  return {
    schema_version: "calyx.message-operation/v1",
    operation_id: outbox.outbox_id,
    ...(!messageExpired ? { message_locator: `/v1/message-text/${encodeURIComponent(message.message_id)}` } : {}),
    target_host: outbox.target_host,
    status: outbox.status,
    terminal,
    attempt_count: outbox.attempt_count,
    created_at: outbox.created_at,
    updated_at: outbox.updated_at,
    ...(terminal
      ? {
          receipt: {
            schema_version: "calyx.message-operation-receipt/v1",
            outcome: outbox.status,
            completed_at: outbox.forwarded_at ?? outbox.updated_at,
          },
        }
      : {}),
  };
}

async function handleAdminMessageForwardRequest(
  response: ServerResponse,
  service: RunService,
  outboxId: string,
): Promise<void> {
  const forwarded = await service.forwardMessageOutbox(outboxId);
  writeAdminMessageOperationResult(response, forwarded);
}

async function handleAdminMessageOperationRequest(
  response: ServerResponse,
  service: RunService,
  outboxId: string,
): Promise<void> {
  const observed = await service.observeMessageOutbox(outboxId);
  writeAdminMessageOperationResult(response, observed);
}

function writeAdminMessageOperationResult(
  response: ServerResponse,
  result: MessageOutboxForwardResult | MessageOutboxObservationResult | undefined,
): void {
  if (!result) {
    writeError(
      response,
      503,
      "message_outbox_forwarder_unavailable",
      "The resident source-daemon message outbox forwarder is unavailable.",
    );
    return;
  }
  if (result.status === "schema_unavailable") {
    writeError(response, 503, "message_schema_unavailable", "Message API schema is unavailable; run calyx state migrate --apply.");
    return;
  }
  if (result.status === "not_found") {
    writeError(response, 404, "message_operation_unknown", "Message operation was not found.");
    return;
  }
  writeJson(response, 200, toMessageOperationResponse(result.outbox, result.message));
}

async function handleRunRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  runId: string,
  subpath: string | undefined,
): Promise<void> {
  if (!subpath) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    const record = await service.getRunRecord(runId);
    if (!record) {
      notFound(response, `/v1/admin/runs/${runId}`);
      return;
    }
    writeJson(response, 200, toAdminRunRecord(record));
    return;
  }

  if (subpath === "events") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    writeJson(response, 200, await service.readEvents(runId));
    return;
  }

  if (subpath === "logs") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    const url = new URL(request.url ?? `/v1/admin/runs/${runId}/logs`, "http://localhost");
    const tail = parsePositiveQueryInteger(url.searchParams.get("tail"));
    const result: RunLogResult = await service.readLogs(runId, {
      ...(typeof tail === "number" ? { tail } : {}),
    });
    writeJson(response, 200, result);
    return;
  }

  if (subpath === "observation") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    const url = new URL(request.url ?? `/v1/admin/runs/${runId}/observation`, "http://localhost");
    const tail = parsePositiveQueryInteger(url.searchParams.get("tail"));
    const result: RunObservationResult = await service.observeRun(runId, {
      ...(typeof tail === "number" ? { tail } : {}),
    });
    writeJson(response, 200, result);
    return;
  }

  if (subpath === "receipt") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    const receipt = await service.getKernelReceipt(runId);
    if (!receipt) {
      notFound(response, `/v1/admin/runs/${runId}/receipt`);
      return;
    }
    writeJson(response, 200, receipt);
    return;
  }

  if (subpath === "stop") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }
    const payload = await readRequestJson<{ reason?: string }>(request);
    try {
      const result = await service.stop(runId, {
        ...payload,
        provenance: requireRequestProvenance(request),
      });
      writeJson(response, 200, result);
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        writeError(response, 404, "not_found", error.message);
        return;
      }
      throw error;
    }
    return;
  }

  notFound(response, `/v1/admin/runs/${runId}/${subpath}`);
}

async function handleMonitorsV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  state: PinnedRunServerState,
  stateStoreOptions: StateOpenOptions,
  parts: string[],
  auth: AuthenticatedRequestContext,
): Promise<void> {
  // The admin router normalizes the remaining parts to the monitor family.
  const url = new URL(request.url ?? "/v1/admin/monitors", "http://localhost");
  const subpath = parts.slice(2);

  try {
    if (subpath.length === 0) {
      if (request.method === "GET") {
        const rows = await withServerMonitorState(stateStoreOptions, (db) => listMonitors(db, {
          status: parseMonitorRouteStatus(url),
          ...(url.searchParams.get("source_run_id")?.trim()
            ? { source_run_id: url.searchParams.get("source_run_id")!.trim() }
            : {}),
          ...(url.searchParams.get("assigned_host")?.trim()
            ? { assigned_host: normalizeHostAlias(url.searchParams.get("assigned_host")!.trim()) }
            : {}),
          limit: parseMonitorRouteLimit(url),
        }));
        writeJson(response, 200, {
          schema_version: "calyx.monitor-list/v1",
          owner_host: state.advertisedHost,
          count: rows.length,
          monitors: rows,
        });
        return;
      }

      if (request.method === "POST") {
        let payload: MonitorCreateRequest;
        try {
          payload = await readRequestJson<MonitorCreateRequest>(request);
        } catch (error) {
          if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
          throw new MonitorRouteError(
            400,
            "monitor_invalid_request",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!isMonitorCreateRequest(payload)) {
          throw new MonitorRouteError(
            400,
            "monitor_invalid_request",
            "POST /v1/admin/monitors requires calyx.monitor-create-request/v1 with preset runner-supervision.",
            {
              required_schema_version: "calyx.monitor-create-request/v1",
              presets: ["runner-supervision"],
              provenances: [...MONITOR_CREATE_PROVENANCES],
              rearm_policies: [...MONITOR_REARM_POLICIES],
            },
          );
        }

        const normalizedForHash: Partial<MonitorCreateRequest> = { ...payload };
        delete normalizedForHash.idempotency_key;
        const requestHash = hashCanonicalJcs(normalizedForHash);
        const bound = await withServerMonitorState(stateStoreOptions, (db) => (
          readApiIdempotency(db, auth.subject, "admin.monitor.create", payload.idempotency_key)
        ));
        if (bound) {
          if (
            bound.request_hash !== requestHash
            || bound.canonicalizer !== "jcs-rfc8785/v1"
            || bound.schema_major !== 1
          ) {
            writeError(
              response,
              409,
              "idempotency_conflict",
              "The idempotency key is already bound to a different monitor create request.",
              { hint: "Use a new idempotency_key for a different request." },
            );
            return;
          }
          writeJson(response, bound.response_status, bound.response);
          return;
        }

        const requestedHost = normalizeHostAlias(payload.assigned_host);
        const actualHost = normalizeHostAlias(systemHostname());
        const advertisedHost = normalizeHostAlias(state.advertisedHost);
        const acceptedHosts = new Set([actualHost, advertisedHost].filter((host) => host.length > 0));
        if (!acceptedHosts.has(requestedHost)) {
          throw new MonitorRouteError(
            409,
            "monitor_assigned_host_mismatch",
            `Monitor request host mismatch: requested ${payload.assigned_host}, but daemon is ${actualHost} (advertised as ${state.advertisedHost}).`,
            { requested_host: payload.assigned_host, actual_host: actualHost, advertised_host: state.advertisedHost },
          );
        }

        const runId = payload.source_run_id.trim();
        const runRecord = await service.getRunRecord(runId);
        if (!runRecord) {
          throw new MonitorRouteError(
            404,
            "monitor_run_unknown",
            `runner-supervision run "${runId}" is not resolvable in ${requestedHost}'s run store. Run \`calyx run ps --host ${requestedHost}\` and recreate the monitor with the correct --assigned-host.`,
            { run_id: runId, host: requestedHost, hint: `calyx run ps --host ${requestedHost}` },
          );
        }

        const createInput: CreateMonitorInput = {
          owner: payload.owner.trim(),
          created_by: payload.created_by.trim(),
          create_provenance: payload.create_provenance,
          assigned_host: requestedHost,
          source_run_id: runId,
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate(runId, payload.stale_after_ms),
          rearm_policy: payload.rearm_policy,
          created_request_provenance: requireRequestProvenance(request),
          ...(payload.delivery ? { delivery: payload.delivery } : {}),
        };
        const outcome = await withServerMonitorState(stateStoreOptions, (db) => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const existing = readApiIdempotency(db, auth.subject, "admin.monitor.create", payload.idempotency_key);
            if (existing) {
              db.exec("COMMIT");
              return existing.request_hash === requestHash
                && existing.canonicalizer === "jcs-rfc8785/v1"
                && existing.schema_major === 1
                ? { kind: "replay" as const, status: existing.response_status, body: existing.response }
                : { kind: "conflict" as const };
            }
            const monitor = createMonitor(db, createInput);
            const body = {
              schema_version: "calyx.monitor-create/v1" as const,
              owner_host: requestedHost,
              storage: {
                host: requestedHost,
                inspect_command: `calyx monitor show ${monitor.monitor_id} --host ${requestedHost} --json`,
              },
              note: `monitor row lives on ${requestedHost}; inspect with --host ${requestedHost}`,
              monitor,
            };
            const provenance = requireRequestProvenance(request);
            recordApiIdempotency(db, {
              subject: auth.subject,
              operation_id: "admin.monitor.create",
              idempotency_key: payload.idempotency_key,
              asserted_actor: provenance.asserted_actor,
              first_request_id: provenance.request_id,
              first_request_provenance: provenance,
              request_hash: requestHash,
              response_status: 200,
              response: body,
            });
            db.exec("COMMIT");
            return { kind: "created" as const, status: 200, body };
          } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
            throw error;
          }
        });
        if (outcome.kind === "conflict") {
          writeError(response, 409, "idempotency_conflict", "The idempotency key is already bound to a different monitor create request.", {
            hint: "Use a new idempotency_key for a different request.",
          });
          return;
        }
        writeJson(response, outcome.status, outcome.body);
        return;
      }

      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }

    if (subpath[0] === "wakes") {
      if (subpath.length === 1) {
        if (request.method === "POST") {
          let payload: MonitorClaimRequest;
          try {
            payload = await readRequestJson<MonitorClaimRequest>(request);
          } catch (error) {
            if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
            throw new MonitorRouteError(
              400,
              "monitor_invalid_request",
              error instanceof Error ? error.message : String(error),
            );
          }
          const normalizedForHash: Partial<MonitorClaimRequest> = { ...payload };
          delete normalizedForHash.idempotency_key;
          const requestHash = hashCanonicalJcs(normalizedForHash);
          const provenance = requireRequestProvenance(request);
          const outcome = await withServerMonitorState(stateStoreOptions, (db) => {
            db.exec("BEGIN IMMEDIATE");
            try {
              const existing = readApiIdempotency(
                db,
                auth.subject,
                "admin.monitor.claim",
                payload.idempotency_key,
              );
              if (existing) {
                db.exec("COMMIT");
                return existing.request_hash === requestHash
                  && existing.canonicalizer === "jcs-rfc8785/v1"
                  && existing.schema_major === 1
                  ? { kind: "replay" as const, status: existing.response_status, body: existing.response }
                  : { kind: "conflict" as const };
              }
              const wakes = claimMonitorWakes(db, {
                claimed_by: payload.claimed_by,
                ...(payload.monitor?.trim() ? { monitor_id: payload.monitor.trim() } : {}),
                ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
                provenance,
              });
              const wakeIds = new Set(wakes.map((wake) => wake.wake_id));
              const allDeliveries = payload.monitor?.trim()
                ? listMonitorDeliveries(db, { monitor_id: payload.monitor.trim(), limit: 500 })
                : listMonitorDeliveries(db, { limit: 500 });
              const deliveries = allDeliveries.filter((delivery) => wakeIds.has(delivery.wake_id));
              const body = {
                schema_version: "calyx.monitor-inbox/v1" as const,
                owner_host: state.advertisedHost,
                count: wakes.length,
                wakes,
                delivery_state: monitorDeliveryState(deliveries),
              };
              recordApiIdempotency(db, {
                subject: auth.subject,
                operation_id: "admin.monitor.claim",
                idempotency_key: payload.idempotency_key,
                asserted_actor: provenance.asserted_actor,
                first_request_id: provenance.request_id,
                first_request_provenance: provenance,
                request_hash: requestHash,
                response_status: 200,
                response: body,
              });
              db.exec("COMMIT");
              return { kind: "claimed" as const, status: 200, body };
            } catch (error) {
              try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
              throw error;
            }
          });
          if (outcome.kind === "conflict") {
            writeError(response, 409, "idempotency_conflict", "The idempotency key is already bound to a different monitor claim request.", {
              hint: "Use a new idempotency_key for a different request.",
            });
            return;
          }
          writeJson(response, outcome.status, outcome.body);
          return;
        }
        if (request.method !== "GET") {
          writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
          return;
        }
        const exactWakeId = url.searchParams.get("wake_id")?.trim();
        if (exactWakeId) {
          const conflictingParameters = ["status", "monitor", "limit", "cursor"]
            .filter((parameter) => url.searchParams.has(parameter));
          if (conflictingParameters.length > 0) {
            throw new MonitorRouteError(
              400,
              "invalid_request",
              "Exact wake lookup cannot be combined with list filters or pagination.",
              { wake_id: exactWakeId, conflicting_parameters: conflictingParameters },
            );
          }
          const { row, deliveries } = await withServerMonitorState(stateStoreOptions, (db) => ({
            row: readMonitorWake(db, exactWakeId),
            deliveries: listMonitorDeliveries(db, { wake_id: exactWakeId, limit: 500 }),
          }));
          writeJson(response, 200, {
            schema_version: "calyx.monitor-inbox/v1",
            owner_host: state.advertisedHost,
            count: row ? 1 : 0,
            wakes: row ? [row] : [],
            delivery_state: monitorDeliveryState(row ? deliveries : []),
          });
          return;
        }
        const { rows, deliveries } = await withServerMonitorState(stateStoreOptions, (db) => {
          const wakes = listMonitorWakes(db, {
            status: parseMonitorWakeRouteStatus(url),
            ...(url.searchParams.get("monitor")?.trim() ? { monitor_id: url.searchParams.get("monitor")!.trim() } : {}),
            limit: parseMonitorRouteLimit(url),
          });
          const wakeIds = new Set(wakes.map((wake) => wake.wake_id));
          const allDeliveries = url.searchParams.get("monitor")?.trim()
            ? listMonitorDeliveries(db, { monitor_id: url.searchParams.get("monitor")!.trim(), limit: 500 })
            : listMonitorDeliveries(db, { limit: 500 });
          return {
            rows: wakes,
            deliveries: allDeliveries.filter((delivery) => wakeIds.has(delivery.wake_id)),
          };
        });
        writeJson(response, 200, {
          schema_version: "calyx.monitor-inbox/v1",
          owner_host: state.advertisedHost,
          count: rows.length,
          wakes: rows,
          delivery_state: monitorDeliveryState(deliveries),
        });
        return;
      }

      if (subpath.length === 3 && subpath[2] === "ack") {
        if (request.method !== "POST") {
          writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
          return;
        }
        const wakeId = decodeRequestPathSegment(subpath[1]!);
        let payload: MonitorAckRequest;
        try {
          payload = await readRequestJson<MonitorAckRequest>(request);
        } catch (error) {
          if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
          throw new MonitorRouteError(
            400,
            "monitor_invalid_request",
            error instanceof Error ? error.message : String(error),
          );
        }
        let result;
        try {
          result = await withServerMonitorState(stateStoreOptions, (db) => ackMonitorWake(db, wakeId, {
            acked_by: payload.acked_by,
            provenance: requireRequestProvenance(request),
          }));
        } catch (error) {
          if (error instanceof MonitorWakeAckConflictError) {
            throw new MonitorRouteError(409, error.code, error.message, {
              wake_id: error.wake_id,
            });
          }
          throw error;
        }
        if (!result.wake) {
          throw new MonitorRouteError(
            404,
            "monitor_wake_unknown",
            `monitor wake not found: ${wakeId}`,
            { wake_id: wakeId },
          );
        }
        writeJson(response, 200, {
          schema_version: "calyx.monitor-ack/v1",
          owner_host: state.advertisedHost,
          changed: result.changed,
          wake: result.wake,
        });
        return;
      }

      notFound(response, `/v1/admin/monitors/${subpath.join("/")}`);
      return;
    }

    if (subpath.length === 1) {
      const monitorId = decodeRequestPathSegment(subpath[0]!);
      if (request.method === "GET") {
        const payload = await withServerMonitorState(stateStoreOptions, (db) => {
          const row = readMonitor(db, monitorId);
          if (!row) {
            throw new MonitorRouteError(
              404,
              "monitor_unknown",
              `monitor not found: ${monitorId}`,
              { monitor_id: monitorId },
            );
          }
          const deliveries = listMonitorDeliveries(db, { monitor_id: monitorId, limit: 500 });
          return {
            schema_version: "calyx.monitor-show/v1",
            owner_host: state.advertisedHost,
            monitor: row,
            delivery_state: monitorDeliveryState(deliveries),
          };
        });
        writeJson(response, 200, payload);
        return;
      }
    }

    if (subpath.length === 2 && subpath[1] === "cancel") {
      const monitorId = decodeRequestPathSegment(subpath[0]!);
      if (request.method === "POST") {
        let payload: MonitorCancelRequest;
        try {
          payload = await readRequestJson<MonitorCancelRequest>(request);
        } catch (error) {
          if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
          throw new MonitorRouteError(
            400,
            "monitor_invalid_request",
            error instanceof Error ? error.message : String(error),
          );
        }
        const row = await withServerMonitorState(stateStoreOptions, (db) => cancelMonitor(db, monitorId, {
          detail: payload.reason?.trim() || "cancelled by remote operator",
          provenance: requireRequestProvenance(request),
        }));
        if (!row) {
          throw new MonitorRouteError(
            404,
            "monitor_unknown",
            `monitor not found: ${monitorId}`,
            { monitor_id: monitorId },
          );
        }
        writeJson(response, 200, {
          schema_version: "calyx.monitor-cancel/v1",
          owner_host: state.advertisedHost,
          monitor: row,
        });
        return;
      }
      writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
      return;
    }

    notFound(response, `/v1/admin/monitors/${subpath.join("/")}`);
  } catch (error) {
    if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
    if (error instanceof MonitorRouteError) {
      writeTypedMonitorError(response, error);
      return;
    }
    throw error;
  }
}

async function handleConsumerMonitorsV1Request(
  request: IncomingMessage,
  response: ServerResponse,
  state: PinnedRunServerState,
  stateStoreOptions: StateOpenOptions,
  parts: string[],
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", "Monitor mutations require the control-plane admin profile.");
    return;
  }
  const url = new URL(request.url ?? "/v1/monitors", "http://localhost");
  const subpath = parts.slice(2);
  try {
    if (subpath.length === 0) {
      const limit = Math.min(parseMonitorRouteLimit(url) ?? 100, 100);
      const status = parseMonitorRouteStatus(url);
      const assignedHost = url.searchParams.get("assigned_host")?.trim()
        ? normalizeHostAlias(url.searchParams.get("assigned_host")!.trim())
        : undefined;
      const sourceRunId = url.searchParams.get("source_run_id")?.trim() || undefined;
      const filters = {
        status,
        assigned_host: assignedHost ?? null,
        source_run_id: sourceRunId ?? null,
      };
      const cursor = decodeListCursor(url, "monitor.list", filters, ["created_at", "monitor_id"]);
      const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
      const rows = await withServerMonitorState(stateStoreOptions, (db) => {
        const rows = listMonitors(db, {
          status,
          ...(sourceRunId ? { source_run_id: sourceRunId } : {}),
          ...(assignedHost ? { assigned_host: assignedHost } : {}),
          ...(cursor ? { after: { created_at: cursor.after["created_at"]!, monitor_id: cursor.after["monitor_id"]! } } : {}),
          limit: limit + 1,
        });
        return rows.map((row) => ({
          row,
          deliveries: readMonitorDeliveryAggregate(db, row.monitor_id),
          wakeCount: countMonitorWakes(db, row.monitor_id),
        }));
      });
      const page = boundedSeekPage(
        rows,
        "monitor.list",
        filters,
        snapshotAt,
        undefined,
        limit,
        () => true,
        ({ row }) => ({ created_at: row.created_at, monitor_id: row.monitor_id }),
      );
      const observations = page.values.map(({ row, deliveries, wakeCount }) => (
        toMonitorObservation(row, deliveries, wakeCount)
      ));
      writeJson(response, 200, {
        schema_version: "calyx.monitor-observation-list/v1",
        count: observations.length,
        truncated: page.truncated,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        monitors: observations,
      });
      return;
    }
    if (subpath.length === 1 && subpath[0] !== "wakes") {
      const monitorId = decodeRequestPathSegment(subpath[0]!);
      const observation = await withServerMonitorState(stateStoreOptions, (db) => {
        const row = readMonitor(db, monitorId);
        if (!row) return undefined;
        return toMonitorObservation(
          row,
          readMonitorDeliveryAggregate(db, monitorId),
          countMonitorWakes(db, monitorId),
        );
      });
      if (!observation) {
        writeError(response, 404, "monitor_unknown", `Monitor not found: ${monitorId}.`);
        return;
      }
      writeJson(response, 200, observation);
      return;
    }
    if (subpath.length === 1 && subpath[0] === "wakes") {
      const limit = Math.min(parseMonitorRouteLimit(url) ?? 100, 100);
      const status = parseMonitorWakeRouteStatus(url);
      const monitorId = url.searchParams.get("monitor")?.trim() || undefined;
      const filters = { status, monitor: monitorId ?? null };
      const cursor = decodeListCursor(url, "monitor.wakes", filters, ["created_at", "wake_id"]);
      const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
      const rows = await withServerMonitorState(stateStoreOptions, (db) => listMonitorWakes(db, {
        status,
        ...(monitorId ? { monitor_id: monitorId } : {}),
        ...(cursor ? { after: { created_at: cursor.after["created_at"]!, wake_id: cursor.after["wake_id"]! } } : {}),
        limit: limit + 1,
      }).map((row) => ({ row, sourceRunId: readMonitor(db, row.monitor_id)?.source_run_id })));
      const page = boundedSeekPage(
        rows,
        "monitor.wakes",
        filters,
        snapshotAt,
        undefined,
        limit,
        () => true,
        ({ row }) => ({ created_at: row.created_at, wake_id: row.wake_id }),
      );
      writeJson(response, 200, {
        schema_version: "calyx.wake-observation-list/v1",
        count: page.values.length,
        truncated: page.truncated,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        wakes: page.values.map(({ row, sourceRunId }) => toWakeObservation(row, state.advertisedHost, sourceRunId)),
      });
      return;
    }
    notFound(response, `/${parts.join("/")}`);
  } catch (error) {
    if (error instanceof MonitorRouteError) {
      writeTypedMonitorError(response, error);
      return;
    }
    throw error;
  }
}

export async function handleEventsStream(
  request: IncomingMessage,
  response: ServerResponse,
  service: RunService,
  requestUrl: URL,
  timing: EventStreamTimingOptions = {},
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
    return;
  }

  const rawQueryAfter = requestUrl.searchParams.get("after");
  const queryAfter = rawQueryAfter !== null && rawQueryAfter.length > 0
    ? rawQueryAfter
    : undefined;
  const after = queryAfter ?? readLastEventId(request);
  const runIdFilter = parseOptionalQueryValue(requestUrl.searchParams.get("run_id"));
  let filter: CalyxStreamEventFilter;
  try {
    const eventTypeFilter = parseStreamEventType(parseOptionalQueryValue(requestUrl.searchParams.get("event_type")));
    filter = {
      ...(runIdFilter ? { run_id: runIdFilter } : {}),
      ...(eventTypeFilter ? { event_type: eventTypeFilter } : {}),
    };
  } catch (error) {
    if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) throw error;
    badRequest(response, error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    await service.assertGlobalEventReplayCursor(after);
  } catch (error) {
    if (error instanceof EventReplayCursorError) {
      writeError(
        response,
        400,
        "invalid_event_cursor",
        `Replay cursor is ${error.reason}; use an exact cursor emitted by this journal.`,
      );
      return;
    }
    throw error;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders();

  const catchupIntervalMs = timing.catchupIntervalMs ?? EVENT_STREAM_CATCHUP_INTERVAL_MS;
  const keepaliveIntervalMs = timing.keepaliveIntervalMs ?? EVENT_STREAM_KEEPALIVE_INTERVAL_MS;
  const idleTimeoutMs = timing.idleTimeoutMs ?? EVENT_STREAM_IDLE_TIMEOUT_MS;
  let closed = false;
  // The server's observed authority is distinct from the client's last
  // successfully framed id. A predicate-suppressed control row advances only
  // this drain cursor; the client advances solely from an id-bearing frame.
  let lastObservedCursor = after;
  let drainRequested = false;
  let drainPromise: Promise<void> | undefined;
  let writableDrainPromise: Promise<boolean> | undefined;
  let catchupTimer: NodeJS.Timeout | undefined;
  let idleTimeout: NodeJS.Timeout | undefined;
  let unsubscribe = (): void => {};
  let cleanup = (): void => {};
  const closedWaiters = new Set<() => void>();
  const waitForWritableDrain = (): Promise<boolean> => {
    if (closed || response.writableEnded || response.destroyed) return Promise.resolve(false);
    if (!writableDrainPromise) {
      writableDrainPromise = new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (writable: boolean): void => {
          if (settled) return;
          settled = true;
          response.off("drain", onDrain);
          response.off("close", onClosed);
          response.off("error", onClosed);
          closedWaiters.delete(onClosed);
          resolve(writable);
        };
        const onDrain = (): void => finish(!closed && !response.writableEnded && !response.destroyed);
        const onClosed = (): void => finish(false);
        response.once("drain", onDrain);
        response.once("close", onClosed);
        response.once("error", onClosed);
        closedWaiters.add(onClosed);
        if (closed || response.writableEnded || response.destroyed) onClosed();
      }).finally(() => {
        writableDrainPromise = undefined;
      });
    }
    return writableDrainPromise;
  };
  const resetIdleTimeout = (): void => {
    if (closed) {
      return;
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      cleanup();
    }, idleTimeoutMs);
    idleTimeout.unref?.();
  };
  const deliverEvent = async (event: CalyxStreamEvent): Promise<boolean> => {
    if (writableDrainPromise && !(await writableDrainPromise)) {
      return false;
    }
    if (closed) {
      return false;
    }
    if (timing.eventPredicate && !timing.eventPredicate(event)) {
      lastObservedCursor = event.cursor;
      return true;
    }
    if (response.writableEnded || response.destroyed) {
      cleanup();
      return false;
    }
    let frame: string;
    try {
      const projected = timing.eventProjector ? timing.eventProjector(event) : event;
      frame = prepareSseEventFrame(event, projected);
    } catch (error) {
      if (timing.projectionFailureProjector) {
        try {
          frame = prepareSseEventFrame(
            event,
            timing.projectionFailureProjector(event, error),
          );
        } catch {
          cleanup();
          return false;
        }
      } else {
        cleanup();
        return false;
      }
    }
    try {
      // Fallback selection is complete before this sole write. A transport
      // failure must never trigger a second frame for the same cursor.
      const writable = response.write(frame);
      if (!writable && !(await waitForWritableDrain())) {
        return false;
      }
      lastObservedCursor = event.cursor;
      resetIdleTimeout();
      return true;
    } catch {
      // A transport failure cannot advance replay authority because the client
      // did not receive the frame carrying this event id.
      cleanup();
      return false;
    }
  };
  const drainAuthorityOnce = async (): Promise<void> => {
    for await (const event of service.readEventsSince(lastObservedCursor, filter)) {
      if (closed) {
        return;
      }
      if (!(await deliverEvent(event))) {
        return;
      }
    }
  };
  const requestAuthorityDrain = (): Promise<void> => {
    if (closed) return Promise.resolve();
    drainRequested = true;
    if (!drainPromise) {
      drainPromise = (async () => {
        while (drainRequested && !closed) {
          drainRequested = false;
          await drainAuthorityOnce();
        }
      })().finally(() => {
        drainPromise = undefined;
        // A notification can arrive after the loop observes false but before
        // the promise clears. Re-arm so no wake is lost at that boundary.
        if (drainRequested && !closed) {
          void requestAuthorityDrain().catch(() => cleanup());
        }
      });
    }
    return drainPromise;
  };
  unsubscribe = service.subscribeToEvents(() => {
    // Process-local notifications are wake hints only. The shared journal is
    // the sole ordering authority, including lower cursors committed remotely.
    void requestAuthorityDrain().catch(() => cleanup());
  }, filter);
  const keepalive = setInterval(() => {
    if (closed) {
      return;
    }
    if (response.writableEnded || response.destroyed) {
      cleanup();
      return;
    }
    if (writableDrainPromise) {
      return;
    }
    try {
      if (response.write(":\n\n")) {
        resetIdleTimeout();
      } else {
        void waitForWritableDrain().then((writable) => {
          if (writable) resetIdleTimeout();
        });
      }
    } catch {
      cleanup();
    }
  }, keepaliveIntervalMs);
  keepalive.unref?.();
  cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(keepalive);
    if (catchupTimer) {
      clearInterval(catchupTimer);
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    for (const closeWaiter of closedWaiters) closeWaiter();
    closedWaiters.clear();
    unsubscribe();
    // Close the SSE response if it's still writable. The `close` / `error`
    // event paths don't need this (the socket is already gone), but the
    // idle-timeout and writable-ended-short-circuit paths reach cleanup with
    // a still-healthy response object; without `end()` the server keeps the
    // HTTP response half-open and the client never observes termination.
    if (!response.writableEnded && !response.destroyed) {
      try {
        response.end();
      } catch {
        // Best-effort; nothing to do if end() itself throws.
      }
    }
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
  request.on("error", cleanup);
  response.on("error", cleanup);
  resetIdleTimeout();

  try {
    await requestAuthorityDrain();
    catchupTimer = setInterval(() => {
      void requestAuthorityDrain().catch(() => cleanup());
    }, catchupIntervalMs);
    catchupTimer.unref?.();
  } catch {
    cleanup();
    if (!response.writableEnded) {
      response.end();
    }
  }
}

async function handleRuntimeConfigRequest(
  request: IncomingMessage,
  response: ServerResponse,
  mode: "plan" | "apply" | "verify",
  state: PinnedRunServerState,
  roots: Readonly<Pick<RuntimeConfigOptions, "managedConfigsRoot" | "liveHome">>,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
    return;
  }

  let payload: RuntimeConfigDispatchRequest;
  try {
    payload = await readRequestJson<RuntimeConfigDispatchRequest>(request);
  } catch (error) {
    if (isRequestTransportError(error)) throw error;
    badRequest(response, error instanceof Error ? error.message : String(error));
    return;
  }

  if (!isRuntimeConfigDispatchRequest(payload)) {
    badRequest(
      response,
      `POST /v1/internal/runtime-config/${mode} requires a host-backend/v1 runtime-config request body.`,
    );
    return;
  }

  const requestedHost = canonicalRuntimeConfigHostSegment(payload.options.host);
  if (!requestedHost) {
    badRequest(response, "Runtime-config request host must be a canonical host segment.");
    return;
  }
  const actualHost = normalizeHostAlias(state.actualHost);
  const advertisedHost = normalizeHostAlias(state.advertisedHost);
  const acceptedHosts = new Set([actualHost, advertisedHost].filter((host) => host.length > 0));
  if (!acceptedHosts.has(requestedHost)) {
    conflict(
      response,
      `Runtime-config request host mismatch: requested ${payload.options.host}, but server is ${actualHost} (advertised as ${state.advertisedHost}).`,
    );
    return;
  }

  const runtimeOptions: RuntimeConfigOptions = {
    host: requestedHost,
    ...(payload.options.components ? { components: payload.options.components } : {}),
    ...(roots.managedConfigsRoot ? { managedConfigsRoot: roots.managedConfigsRoot } : {}),
    ...(roots.liveHome ? { liveHome: roots.liveHome } : {}),
  };
  let result: RuntimeConfigResult;
  if (mode === "plan") {
    result = await planRuntimeConfig(runtimeOptions);
  } else if (mode === "apply") {
    try {
      result = await applyRuntimeConfig(runtimeOptions, requireRequestProvenance(request));
    } catch (error) {
      if (error instanceof RuntimeConfigApplyInProgressError) {
        writeError(response, 409, error.code, error.message, {
          retryable: true,
          hint: "Retry after the current runtime-config apply completes.",
        });
        return;
      }
      throw error;
    }
  } else {
    result = await verifyRuntimeConfig(runtimeOptions);
  }
  writeJson(response, 200, result);
}

type LeaseCommandReceipt = { status: number; body: unknown };

async function runIdempotentLeaseCommand(
  request: IncomingMessage,
  auth: AuthenticatedRequestContext,
  action: "acquire" | "renew" | "release" | "steal",
  payload: Record<string, unknown>,
  stateStoreOptions: StateOpenOptions,
  execute: (db: StateDriverDatabase, provenance: ApiProvenanceV1) => LeaseCommandReceipt,
): Promise<LeaseCommandReceipt> {
  const idempotencyKey = leaseStringField(payload, "idempotency_key")!;
  const normalized = { ...payload };
  delete normalized["idempotency_key"];
  const requestHash = hashCanonicalJcs(normalized);
  const provenance = requireRequestProvenance(request);
  return withLeaseState((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const operationId = `admin.lease.${action}`;
      const existing = readApiIdempotency(db, auth.subject, operationId, idempotencyKey);
      if (existing) {
        db.exec("COMMIT");
        if (
          existing.request_hash !== requestHash
          || existing.canonicalizer !== "jcs-rfc8785/v1"
          || existing.schema_major !== 1
        ) {
          return {
            status: 409,
            body: {
              error: {
                schema_version: "calyx.error/v1",
                code: "idempotency_conflict",
                message: "The idempotency key is already bound to a different lease command.",
                hint: "Use a new idempotency_key for a different request.",
              },
            },
          };
        }
        return { status: existing.response_status, body: existing.response };
      }
      const receipt = execute(db, provenance);
      recordApiIdempotency(db, {
        subject: auth.subject,
        operation_id: operationId,
        idempotency_key: idempotencyKey,
        asserted_actor: provenance.asserted_actor,
        first_request_id: provenance.request_id,
        first_request_provenance: provenance,
        request_hash: requestHash,
        response_status: receipt.status,
        response: receipt.body,
      });
      db.exec("COMMIT");
      return receipt;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
      throw error;
    }
  }, stateStoreOptions);
}

async function handleLeaseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: PinnedRunServerState,
  action: string | undefined,
  auth: AuthenticatedRequestContext,
  stateStoreOptions: StateOpenOptions,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: `Method ${request.method ?? "UNKNOWN"} not allowed.` });
    return;
  }

  if (action === "doctor") {
    try {
      writeJson(response, 200, await withLeaseState((db) => checkLeaseSchema(db), stateStoreOptions));
    } catch (error) {
      if (error instanceof LeaseSchemaUnavailableError) {
        writeError(response, 503, "lease_schema_unavailable", error.message, { retryable: true });
        return;
      }
      throw error;
    }
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readRequestJson<Record<string, unknown>>(request);
  } catch (error) {
    if (isRequestTransportError(error)) throw error;
    badRequest(response, error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    if (action === "acquire") {
      const key = leaseStringField(payload, "key")!;
      const coordinatorHost = leaseStringField(payload, "coordinator_host", false);
      if (!validateLeaseKeyOwner(response, state, key, coordinatorHost)) {
        return;
      }
      const receipt = await runIdempotentLeaseCommand(request, auth, "acquire", payload, stateStoreOptions, (db, provenance) => {
        const result = acquireLease(db, {
          key,
          holder_activity_id: leaseStringField(payload, "holder_activity_id")!,
          ttl_ms: leaseNumberField(payload, "ttl_ms")!,
          coordinator_host: coordinatorHost,
          request_provenance: provenance,
        });
        return result.acquired
          ? { status: 200, body: result }
          : { status: 409, body: leaseConflictPayload("lease_conflict", result.conflict?.message ?? "lease conflict", result.conflict?.lease) };
      });
      writeJson(response, receipt.status, receipt.body);
      return;
    }

    if (action === "renew") {
      const key = leaseStringField(payload, "key")!;
      const coordinatorHost = leaseStringField(payload, "coordinator_host", false);
      if (!validateLeaseKeyOwner(response, state, key, coordinatorHost)) {
        return;
      }
      const receipt = await runIdempotentLeaseCommand(request, auth, "renew", payload, stateStoreOptions, (db, provenance) => {
        const result = renewLease(db, {
          key,
          holder_activity_id: leaseStringField(payload, "holder_activity_id")!,
          ttl_ms: leaseNumberField(payload, "ttl_ms", false),
          request_provenance: provenance,
        });
        const status = result.renewed ? 200 : result.conflict?.kind === "missing" ? 404 : 409;
        return result.renewed
          ? { status, body: result }
          : { status, body: leaseConflictPayload("lease_conflict", result.conflict?.message ?? "lease conflict", result.conflict?.lease) };
      });
      writeJson(response, receipt.status, receipt.body);
      return;
    }

    if (action === "release") {
      const key = leaseStringField(payload, "key")!;
      const coordinatorHost = leaseStringField(payload, "coordinator_host", false);
      if (!validateLeaseKeyOwner(response, state, key, coordinatorHost)) {
        return;
      }
      const receipt = await runIdempotentLeaseCommand(request, auth, "release", payload, stateStoreOptions, (db, provenance) => {
        const result = releaseLease(db, {
          key,
          holder_activity_id: leaseStringField(payload, "holder_activity_id", false),
          force: leaseBooleanField(payload, "force") === true,
          request_provenance: provenance,
        });
        const status = result.released ? 200 : result.conflict?.kind === "missing" ? 404 : 409;
        return result.released
          ? { status, body: result }
          : { status, body: leaseConflictPayload("lease_conflict", result.conflict?.message ?? "lease conflict", result.conflict?.lease) };
      });
      writeJson(response, receipt.status, receipt.body);
      return;
    }

    if (action === "steal") {
      const key = leaseStringField(payload, "key")!;
      const coordinatorHost = leaseStringField(payload, "coordinator_host", false);
      if (!validateLeaseKeyOwner(response, state, key, coordinatorHost)) {
        return;
      }
      const provenance = payload["provenance"];
      if (typeof provenance !== "string" && !isRecord(provenance)) {
        throw new Error("provenance must be a non-empty string or object");
      }
      const receipt = await runIdempotentLeaseCommand(request, auth, "steal", payload, stateStoreOptions, (db, requestProvenance) => ({
        status: 200,
        body: stealLease(db, {
          key,
          holder_activity_id: leaseStringField(payload, "holder_activity_id")!,
          ttl_ms: leaseNumberField(payload, "ttl_ms")!,
          provenance,
          coordinator_host: coordinatorHost,
          request_provenance: requestProvenance,
        }),
      }));
      writeJson(response, receipt.status, receipt.body);
      return;
    }

    if (action === "list") {
      const ownerHost = leaseStringField(payload, "owner_host", false);
      if (ownerHost && !validateLeaseOwnerHost(response, state, ownerHost)) {
        return;
      }
      const rows = await withLeaseState((db) => listLeases(db, {
        holder_activity_id: leaseStringField(payload, "holder_activity_id", false),
        resource_kind: leaseKindField(payload),
        owner_host: ownerHost,
        include_expired: leaseBooleanField(payload, "include_expired") === true,
        limit: leaseNumberField(payload, "limit", false),
      }), stateStoreOptions);
      writeJson(response, 200, rows);
      return;
    }

  } catch (error) {
    if (error instanceof LeaseSchemaUnavailableError) {
      writeError(response, 503, "lease_schema_unavailable", error.message, { retryable: true });
      return;
    }
    throw error;
  }

  notFound(response, `/v1/leases/${action ?? ""}`);
}

async function handleConsumerLeaseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  stateStoreOptions: StateOpenOptions,
  parts: string[],
): Promise<void> {
  if (request.method !== "GET") {
    writeError(response, 405, "method_not_allowed", "Lease mutations require the control-plane admin profile.");
    return;
  }
  const url = new URL(request.url ?? "/v1/leases", "http://localhost");
  const subpath = parts.slice(2);
  try {
    if (subpath.length === 0) {
      const rawLimit = parsePositiveQueryInteger(url.searchParams.get("limit"));
      const limit = Math.min(rawLimit ?? 100, 100);
      const kind = (url.searchParams.get("resource_kind") ?? undefined) as LeaseResourceKind | undefined;
      const ownerHost = url.searchParams.get("owner_host")?.trim() || undefined;
      const includeExpired = parseBooleanQueryParam(url.searchParams.get("include_expired"));
      const filters = {
        resource_kind: kind ?? null,
        owner_host: ownerHost ? normalizeHostAlias(ownerHost) : null,
        include_expired: includeExpired,
      };
      const cursor = decodeListCursor(url, "lease.list", filters, ["key"]);
      const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
      const rows = await withLeaseState((db) => listLeases(db, {
        ...(kind ? { resource_kind: kind } : {}),
        ...(ownerHost ? { owner_host: ownerHost } : {}),
        include_expired: includeExpired,
        now: snapshotAt,
        ...(cursor ? { after_key: cursor.after["key"]! } : {}),
        limit: limit + 1,
      }), stateStoreOptions);
      const page = boundedSeekPage(
        rows,
        "lease.list",
        filters,
        snapshotAt,
        undefined,
        limit,
        () => true,
        (row) => ({ key: row.key }),
      );
      writeJson(response, 200, {
        schema_version: "calyx.lease-observation-list/v1",
        count: page.values.length,
        truncated: page.truncated,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        leases: page.values.map((row) => toLeaseObservation(row)),
      });
      return;
    }
    if (subpath.length === 1) {
      const key = decodeRequestPathSegment(subpath[0]!);
      const row = await withLeaseState((db) => readLease(db, key), stateStoreOptions);
      if (!row) {
        writeError(response, 404, "lease_unknown", "Lease was not found.");
        return;
      }
      writeJson(response, 200, toLeaseObservation(row));
      return;
    }
    notFound(response, `/${parts.join("/")}`);
  } catch (error) {
    if (error instanceof LeaseSchemaUnavailableError) {
      writeError(response, 503, "lease_schema_unavailable", error.message, { retryable: true });
      return;
    }
    if (error instanceof ListCursorError) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }
    throw error;
  }
}

async function handleSessionWakeDelivery(
  request: IncomingMessage,
  response: ServerResponse,
  stateStoreOptions: StateOpenOptions,
  dependencies: Omit<SessionWakeRouteDependencies, "now"> = {},
): Promise<void> {
  const payload = await readRequestJson<SessionWakeDeliverRequestV1>(request);
  const expectedDeliveryId = sessionWakeDeliveryId(
    payload.pointer.kind,
    payload.pointer.id,
    payload.recipient_activity_id,
  );
  if (payload.delivery_id !== expectedDeliveryId) {
    writeError(
      response,
      409,
      "delivery_id_mismatch",
      "Session wake delivery_id does not match the exact activity and pointer identity.",
    );
    return;
  }
  const opened = await openStateStore(stateStoreOptions);
  try {
    const result = await routeSessionWake(opened.db, {
      recipient_activity_id: payload.recipient_activity_id,
      pointer_kind: payload.pointer.kind,
      pointer_id: payload.pointer.id,
      created_at: payload.created_at,
    }, dependencies);
    writeJson(response, 200, result);
  } finally {
    opened.db.close();
  }
}

function profileForPath(pathname: string): InterfaceProfile {
  const described = resolveHttpPathProfile(pathname);
  if (described) return described;
  if (pathname === "/v1/admin" || pathname.startsWith("/v1/admin/")) return "control_plane_admin_v1";
  if (pathname === "/v1/internal" || pathname.startsWith("/v1/internal/")) return "internal_runtime";
  return "consumer_v1";
}

function requestQueryObject(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0]! : values;
  }
  return result;
}

function requestValidationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "request"} ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function parseAssertedActorHeader(request: IncomingMessage): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "x-calyx-asserted-actor") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length > 1) {
    throw new RequestValidationError("X-Calyx-Asserted-Actor may appear at most once.");
  }
  const actor = values[0];
  if (actor === undefined) return undefined;
  if (actor.includes(",")) {
    throw new RequestValidationError("X-Calyx-Asserted-Actor must not be comma-folded.");
  }
  try {
    return validateApiAssertedActor(actor);
  } catch (error) {
    throw new RequestValidationError(error instanceof Error ? error.message : String(error));
  }
}

function decodeRequestPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestValidationError("Request path contains an invalid percent-encoded segment.");
  }
}

function validateRequestPathSegments(pathname: string): void {
  pathname.split("/").filter(Boolean).forEach(decodeRequestPathSegment);
}

function operationMutates(operation: (typeof HTTP_OPERATION_DESCRIPTORS)[number]): boolean {
  return operation.successes.every((success) => success.semantics.mutation !== "read");
}

const SELF_UPGRADE_RECEIPT_OPERATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u;
const SELF_UPGRADE_RECEIPT_RETRYABLE_FILESYSTEM_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ENOENT",
  "ENOTDIR",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ESTALE",
]);
const SELF_UPGRADE_RECEIPT_PERMANENT_FILESYSTEM_CODES = new Set(["EACCES", "EPERM"]);

function writeSelfUpgradeReceiptUnavailable(
  response: ServerResponse,
  operationId: string,
  error: unknown,
): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  // A code-less durable-authority error is an availability failure, not proof
  // that the root or receipt is structurally invalid. Durable-directory tags
  // known identity/lineage/helper failures, but fail open to retryable 503 for
  // any unclassified platform error rather than falsifying host mutation truth.
  const retryable = code === undefined || SELF_UPGRADE_RECEIPT_RETRYABLE_FILESYSTEM_CODES.has(code);
  if (!retryable && !SELF_UPGRADE_RECEIPT_PERMANENT_FILESYSTEM_CODES.has(code)) {
    return false;
  }
  writeError(
    response,
    503,
    "self_upgrade_receipt_unavailable",
    `Self-upgrade receipt ${operationId} is ${retryable ? "temporarily " : ""}unavailable${code ? ` (${code})` : ""}.`,
    { retryable },
  );
  return true;
}

function writeSelfUpgradeReceiptCanonicalRace(
  response: ServerResponse,
  operationId: string,
): void {
  writeError(
    response,
    503,
    "self_upgrade_receipt_unavailable",
    `Self-upgrade receipt root changed during authoritative read for ${operationId}.`,
    { retryable: true },
  );
}

async function handleSelfUpgradeReceipt(
  response: ServerResponse,
  receiptRoot: string,
  operationId: string,
  afterRootValidatedBeforeRead?: () => Promise<void>,
): Promise<void> {
  if (!SELF_UPGRADE_RECEIPT_OPERATION_ID_PATTERN.test(operationId)) {
    writeError(response, 404, "self_upgrade_receipt_unknown", "Self-upgrade receipt does not exist.");
    return;
  }
  let rootAnchor: Awaited<ReturnType<typeof openExistingDirectoryDurable>>;
  try {
    rootAnchor = await openExistingDirectoryDurable(receiptRoot);
  } catch (error) {
    if (writeSelfUpgradeReceiptUnavailable(response, operationId, error)) {
      return;
    }
    writeError(
      response,
      422,
      "self_upgrade_receipt_invalid",
      `Self-upgrade receipt root is not a stable canonical directory for ${operationId}.`,
    );
    return;
  }

  let raw: string;
  try {
    try {
      await rootAnchor.assertCanonical();
    } catch {
      writeSelfUpgradeReceiptCanonicalRace(response, operationId);
      return;
    }
    await afterRootValidatedBeforeRead?.();

    try {
      raw = await rootAnchor.authority.readFile(
        `${operationId}.json`,
        CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        writeError(response, 404, "self_upgrade_receipt_unknown", `Self-upgrade receipt ${operationId} does not exist.`);
        return;
      }
      if (code === "ELOOP" || code === "EINVAL" || code === "EFBIG") {
        writeError(
          response,
          422,
          "self_upgrade_receipt_invalid",
          `Self-upgrade receipt ${operationId} is not a bounded regular file.`,
        );
        return;
      }
      throw error;
    }

    try {
      await rootAnchor.assertCanonical();
    } catch {
      writeSelfUpgradeReceiptCanonicalRace(response, operationId);
      return;
    }
  } catch (error) {
    if (writeSelfUpgradeReceiptUnavailable(response, operationId, error)) {
      return;
    }
    throw error;
  } finally {
    await rootAnchor.close().catch(() => undefined);
  }

  let validatedValue: unknown;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateOperationSuccessResponse(
      "admin.self-upgrade.receipt",
      200,
      parsed,
    );
    const receiptOperationId = (validated.value as { operation_id?: unknown }).operation_id;
    if (receiptOperationId !== undefined && receiptOperationId !== operationId) {
      writeError(
        response,
        422,
        "self_upgrade_receipt_invalid",
        `Self-upgrade receipt ${operationId} does not match its durable operation_id.`,
      );
      return;
    }
    validatedValue = validated.value;
  } catch {
    writeError(
      response,
      422,
      "self_upgrade_receipt_invalid",
      `Self-upgrade receipt ${operationId} is malformed or violates self-upgrade-receipt/v1.`,
    );
    return;
  }
  // Response transport failures are not receipt-validation failures and must
  // never trigger a second write after headers have been sent.
  writeJson(response, 200, validatedValue);
}

async function admitHttpMutationAudit(
  stateStoreOptions: StateOpenOptions,
  input: {
    request_id: string;
    admitted_at: string;
    operation_id: string;
    subject: string;
    asserted_actor?: string | undefined;
    served_by_host: string;
  },
): Promise<string> {
  const requestId = input.request_id;
  const opened = await openStateStore(stateStoreOptions);
  try {
    const schema = checkApiRequestAuditSchema(opened.db);
    if (schema.status !== "ok") throw new Error("request audit schema is unavailable");
    opened.db.exec("BEGIN IMMEDIATE");
    try {
      admitApiRequestAudit(opened.db, {
        request_id: requestId,
        server_instance_id: SERVER_PROCESS_INSTANCE_ID,
        operation_id: input.operation_id,
        subject: input.subject,
        ...(input.asserted_actor ? { asserted_actor: input.asserted_actor } : {}),
        served_by_host: input.served_by_host,
        admitted_at: input.admitted_at,
      });
      pruneApiRequestAudits(opened.db);
      opened.db.exec("COMMIT");
    } catch (error) {
      try { opened.db.exec("ROLLBACK"); } catch { /* transaction did not open */ }
      throw error;
    }
  } finally {
    opened.db.close();
  }
  return requestId;
}

function bindHttpMutationAuditFinalization(
  response: ServerResponse,
  stateStoreOptions: StateOpenOptions,
  requestId: string,
): void {
  let settled = false;
  const markIndeterminate = async (): Promise<void> => {
    const opened = await openStateStore(stateStoreOptions);
    try {
      markApiRequestAuditIndeterminate(opened.db, requestId);
    } finally {
      opened.db.close();
    }
  };
  response.once("finish", () => {
    settled = true;
    const result = responseAuditResults.get(response) ?? { status: response.statusCode };
    void (async () => {
      let finalError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const opened = await openStateStore(stateStoreOptions);
          try {
            finalizeApiRequestAudit(opened.db, {
              request_id: requestId,
              response_status: result.status,
              ...(result.error_code ? { error_code: result.error_code } : {}),
            });
          } finally {
            opened.db.close();
          }
          return;
        } catch (error) {
          finalError = error;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
      {
        try {
          await markIndeterminate();
        } catch {
          // A later startup recovery keeps a durable admitted row conservative.
        }
        console.warn(
          `calyx.request audit finalization failed for ${requestId}`,
          finalError instanceof Error ? finalError.message : String(finalError),
        );
      }
    })();
  });
  response.once("close", () => {
    if (settled || response.writableFinished) return;
    settled = true;
    void markIndeterminate().catch((error) => {
      console.warn(
        `calyx.request audit indeterminate mark failed for ${requestId}`,
        error instanceof Error ? error.message : String(error),
      );
    });
  });
}

function requireRequestProvenance(request: IncomingMessage): ApiProvenanceV1 {
  const provenance = requestProvenances.get(request);
  if (!provenance) throw new Error("mutation request provenance was not admitted");
  return provenance;
}

async function handleRequestAuditRead(
  response: ServerResponse,
  stateStoreOptions: StateOpenOptions,
  url: URL,
  doctor: boolean,
): Promise<void> {
  const opened = await openStateStore(stateStoreOptions);
  try {
    if (checkApiRequestAuditSchema(opened.db).status !== "ok") {
      writeError(
        response,
        503,
        "provenance_audit_unavailable",
        "Mutation request attribution schema is unavailable.",
        { retryable: true },
      );
      return;
    }
    if (doctor) {
      writeJson(response, 200, {
        schema_version: "calyx.request-audit-doctor/v1",
        ...apiRequestAuditDoctor(opened.db),
      });
      return;
    }
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const outcome = url.searchParams.get("outcome") as
      | "admitted"
      | "response_completed"
      | "response_rejected"
      | "indeterminate"
      | null;
    const operationId = url.searchParams.get("operation_id")?.trim() || null;
    const filters = { outcome, operation_id: operationId };
    const cursor = decodeListCursor(
      url,
      "admin.request-audit.list",
      filters,
      ["admitted_at", "request_id"],
    );
    const snapshotAt = cursor?.snapshot_at ?? new Date().toISOString();
    const rows = listApiRequestAudits(opened.db, {
      limit: limit + 1,
      ...(outcome ? { outcome } : {}),
      ...(operationId ? { operation_id: operationId } : {}),
      snapshot_at: snapshotAt,
      ...(cursor ? {
        after: {
          admitted_at: cursor.after["admitted_at"]!,
          request_id: cursor.after["request_id"]!,
        },
      } : {}),
    });
    const requests = rows.slice(0, limit);
    const truncated = rows.length > limit;
    const last = requests.at(-1);
    writeJson(response, 200, {
      schema_version: "calyx.request-audit-list/v1",
      count: requests.length,
      truncated,
      ...(truncated && last ? {
        next_cursor: encodeListCursor(
          "admin.request-audit.list",
          filters,
          snapshotAt,
          { admitted_at: last.admitted_at, request_id: last.request_id },
        ),
      } : {}),
      requests: requests.map((row) => ({
        request_id: row.request_id,
        operation_id: row.operation_id,
        subject: row.subject,
        asserted_actor: row.asserted_actor,
        served_by_host: row.served_by_host,
        via: row.via,
        admitted_at: row.admitted_at,
        finalized_at: row.finalized_at,
        response_status: row.response_status,
        error_code: row.error_code,
        outcome: row.outcome,
      })),
    });
  } finally {
    opened.db.close();
  }
}

function applyValidatedQuery(
  request: IncomingMessage,
  url: URL,
  validated: unknown,
): void {
  const search = new URLSearchParams();
  if (isRecord(validated)) {
    for (const [key, rawValue] of Object.entries(validated)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (typeof value === "string") search.append(key, value);
      }
    }
  }
  url.search = search.toString();
  request.url = `${url.pathname}${url.search}`;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<RunServerOptions, "credentials">> & {
    service: RunService;
    state: PinnedRunServerState;
    stateStoreOptions: StateOpenOptions;
    runtimeConfigRoots: Readonly<Pick<RuntimeConfigOptions, "managedConfigsRoot" | "liveHome">>;
    selfUpgradeReceiptRoot: string;
    afterSelfUpgradeReceiptRootValidatedBeforeRead?: () => Promise<void>;
    sessionWake: Omit<SessionWakeRouteDependencies, "now">;
  },
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/livez") {
    writeJson(response, 200, { ok: true }, { unboundSuccessMaxBytes: 1_024 });
    return;
  }

  const auth = authenticateRequest(request, options.credentials);
  if (!auth) {
    unauthorized(response);
    return;
  }

  const operation = resolveServerOperation(request.method, pathname);
  const profile = operation?.profile ?? profileForPath(pathname);
  if (!authorizeRequestProfile(auth, profile)) {
    writeError(
      response,
      403,
      "profile_forbidden",
      `Credential ${auth.subject} cannot use ${profile} operations.`,
      { details: { required_profile: profile, credential_tier: auth.credential_tier } },
    );
    return;
  }

  if (!operation) {
    if (resolveHttpPathProfile(pathname)) {
      writeError(response, 405, "method_not_allowed", `Method ${request.method ?? "UNKNOWN"} not allowed.`);
    } else {
      notFound(response, pathname);
    }
    return;
  }

  if (
    operation.profile === "internal_runtime"
    && operation.operation_id !== "internal.msg.receive"
    && !authorizeSelfInternalSubject(response, auth, options.state)
  ) {
    return;
  }

  requestOperationIds.set(request, operation.operation_id);
  responseOperationIds.set(response, operation.operation_id);
  if (
    operation.profile === "consumer_v1"
    && (pathname === "/v1/activity" || pathname.startsWith("/v1/activity/") || pathname.startsWith("/v1/activity-text/"))
    && rejectConsumerActivityQuery(response, requestUrl)
  ) {
    return;
  }
  const mutation = operationMutates(operation);
  let assertedActor: string | undefined;
  try {
    validateRequestPathSegments(pathname);
    assertedActor = mutation ? parseAssertedActorHeader(request) : undefined;
    if (assertedActor) requestAssertedActors.set(request, assertedActor);
    if (request.method === "GET" || request.method === "HEAD") {
      const validated = validateOperationRequest(operation.operation_id, requestQueryObject(requestUrl));
      applyValidatedQuery(request, requestUrl, validated);
    } else if (operation.request_transport.body === "json") {
      await readRequestJson(request);
    } else {
      await assertRequestBodyAbsent(request);
      validateOperationRequest(operation.operation_id, {});
    }
  } catch (error) {
    if (isRequestTransportError(error)) throw error;
    writeError(
      response,
      400,
      error instanceof RequestValidationError ? error.code : "invalid_request",
      requestValidationMessage(error),
    );
    return;
  }
  if (
    operation.operation_id === "internal.msg.receive"
    && !authorizeInternalMessageOriginSubject(response, auth, options.state)
  ) {
    return;
  }
  if (mutation) {
    try {
      const requestId = requestCorrelationIds.get(request);
      if (!requestId) throw new Error("request correlation id is unavailable");
      const admittedAt = new Date().toISOString();
      await admitHttpMutationAudit(options.stateStoreOptions, {
        request_id: requestId,
        admitted_at: admittedAt,
        operation_id: operation.operation_id,
        subject: auth.subject,
        ...(assertedActor ? { asserted_actor: assertedActor } : {}),
        served_by_host: options.state.advertisedHost,
      });
      const provenance: ApiProvenanceV1 = {
        schema_version: "calyx.provenance/v1",
        request_id: requestId,
        subject: auth.subject,
        ...(assertedActor ? { asserted_actor: assertedActor } : {}),
        host: options.state.advertisedHost,
        via: "http",
        at: admittedAt,
      };
      requestProvenances.set(request, provenance);
      bindHttpMutationAuditFinalization(response, options.stateStoreOptions, requestId);
    } catch {
      writeError(
        response,
        503,
        "provenance_audit_unavailable",
        "Mutation request attribution is unavailable; no operation was dispatched.",
        { retryable: true },
      );
      return;
    }
  }
  if (request.method === "GET" && pathname === "/v1/internal/health") {
    writeJson(response, 200, await buildHealthPayload(options.service, options.state, options.stateStoreOptions));
    return;
  }

  if (request.method === "GET" && pathname === "/v1/admin/health") {
    writeJson(
      response,
      200,
      toAdminHealth(await buildHealthPayload(options.service, options.state, options.stateStoreOptions)),
    );
    return;
  }

  const selfUpgradeReceiptPrefix = "/v1/admin/self-upgrade-receipts/";
  if (request.method === "GET" && pathname.startsWith(selfUpgradeReceiptPrefix)) {
    const operationId = decodeRequestPathSegment(pathname.slice(selfUpgradeReceiptPrefix.length));
    await handleSelfUpgradeReceipt(
      response,
      options.selfUpgradeReceiptRoot,
      operationId,
      options.afterSelfUpgradeReceiptRootValidatedBeforeRead,
    );
    return;
  }

  if (request.method === "POST" && pathname === "/v1/admin/session-wakes/deliver") {
    await handleSessionWakeDelivery(request, response, options.stateStoreOptions, options.sessionWake);
    return;
  }

  if (request.method === "GET" && pathname === "/v1/internal/metrics") {
    writeJson(response, 200, await buildMetricsPayload(options.service));
    return;
  }

  if (request.method === "GET" && pathname === "/v1/admin/events/stream") {
    await handleEventsStream(request, response, options.service, requestUrl, {
      projectionFailureProjector: toCalyxStreamProjectionGapEvent,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/v1/events/observe") {
    const requestedType = requestUrl.searchParams.get("event_type");
    if (requestedType && !requestedType.startsWith("run.")) {
      writeError(response, 400, "consumer_event_type_forbidden", "Consumer observation streams expose only run events.");
      return;
    }
    await handleEventsStream(request, response, options.service, requestUrl, {
      eventPredicate: (event) => event.event_type.startsWith("run."),
      eventProjector: (event) => toRunObservationEvent(event as CalyxRunEvent),
      projectionFailureProjector: (event) => toRunObservationGapEvent(event as CalyxRunEvent),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/v1/admin/request-audit") {
    await handleRequestAuditRead(response, options.stateStoreOptions, requestUrl, false);
    return;
  }

  if (request.method === "GET" && pathname === "/v1/admin/request-audit/doctor") {
    await handleRequestAuditRead(response, options.stateStoreOptions, requestUrl, true);
    return;
  }

  const parts = pathname.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    notFound(response, pathname);
    return;
  }

  if (parts[0] === "v1" && parts[1] === "internal" && parts[2] === "runtime-config") {
    if (parts.length === 4) {
      const mode = parts[3];
      if (mode === "plan" || mode === "apply" || mode === "verify") {
        await handleRuntimeConfigRequest(request, response, mode, options.state, options.runtimeConfigRoots);
        return;
      }
    }
    notFound(response, pathname);
    return;
  }

  if (
    request.method === "POST"
    && parts[0] === "v1"
    && parts[1] === "internal"
    && parts[2] === "runs"
    && parts[3] === "reconcile"
    && parts.length === 4
  ) {
    writeJson(response, 200, await options.service.reconcile({
      provenance: requireRequestProvenance(request),
    }));
    return;
  }

  if (
    request.method === "POST"
    && parts[0] === "v1"
    && parts[1] === "admin"
    && parts[2] === "runs"
    && parts[3] === "reconcile-preserving"
    && parts[4] === "v1"
    && parts.length === 5
  ) {
    writeJson(response, 200, toCalyxAdminReconcileResult(await options.service.reconcile({
      provenance: requireRequestProvenance(request),
    })));
    return;
  }

  if (
    request.method === "GET"
    && parts[0] === "v1"
    && parts[1] === "admin"
    && parts[2] === "message-operations"
    && parts.length === 4
  ) {
    await handleAdminMessageOperationRequest(
      response,
      options.service,
      decodeRequestPathSegment(parts[3]!),
    );
    return;
  }

  if (
    request.method === "POST"
    && parts[0] === "v1"
    && parts[1] === "internal"
    && parts[2] === "messages"
    && parts[3] === "receive"
  ) {
    await handleMessagesV1Request(
      request,
      response,
      auth,
      options.state,
      parts,
      options.stateStoreOptions,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "activity") {
    await handleConsumerActivityV1Request(request, response, options.service, options.state, parts);
    return;
  }

  if (parts[0] === "v1" && parts[1] === "marks") {
    await handleConsumerActivityMarksRequest(
      request,
      response,
      auth,
      options.service,
      options.stateStoreOptions,
      parts,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "messages") {
    await handleConsumerMessagesRequest(
      request,
      response,
      auth,
      options.state,
      options.stateStoreOptions,
      parts,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "message-text" && parts.length === 3) {
    await handleConsumerMessageTextRequest(
      request,
      response,
      auth,
      options.stateStoreOptions,
      decodeRequestPathSegment(parts[2]!),
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "message-operations" && parts.length === 3) {
    await handleConsumerMessageOperationRequest(
      response,
      auth,
      options.stateStoreOptions,
      decodeRequestPathSegment(parts[2]!),
    );
    return;
  }

  if (
    request.method === "POST"
    && parts[0] === "v1"
    && parts[1] === "admin"
    && parts[2] === "message-operations"
    && parts[4] === "forward"
    && parts.length === 5
  ) {
    await handleAdminMessageForwardRequest(
      response,
      options.service,
      decodeRequestPathSegment(parts[3]!),
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "activity-text" && parts.length === 3) {
    await handleConsumerActivityText(request, response, options.service, decodeRequestPathSegment(parts[2]!));
    return;
  }

  if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "activity") {
    await handleActivityV1Request(
      request,
      response,
      options.service,
      options.state,
      ["v1", "activity", ...parts.slice(3)],
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "activity-text" && parts.length === 4) {
    await handleActivityTextV1(request, response, options.service, decodeRequestPathSegment(parts[3]!));
    return;
  }

  if (parts[0] === "v1" && parts[1] === "runs") {
    await handleConsumerRuns(request, response, options.service, options.state, parts);
    return;
  }

  if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "runs") {
    const runParts = parts.slice(2);
    if (runParts.length === 1) {
      await handleRunsIndex(request, response, options.service, auth, options.state, options.stateStoreOptions);
      return;
    }
    await handleRunRequest(
      request,
      response,
      options.service,
      decodeRequestPathSegment(runParts[1] ?? ""),
      runParts.length > 2 ? runParts[2] : undefined,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "monitors") {
    await handleConsumerMonitorsV1Request(
      request,
      response,
      options.state,
      options.stateStoreOptions,
      parts,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "monitors") {
    await handleMonitorsV1Request(
      request,
      response,
      options.service,
      options.state,
      options.stateStoreOptions,
      ["v1", "monitors", ...parts.slice(3)],
      auth,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "leases") {
    await handleLeaseRequest(
      request,
      response,
      options.state,
      parts[3],
      auth,
      options.stateStoreOptions,
    );
    return;
  }

  if (parts[0] === "v1" && parts[1] === "leases") {
    await handleConsumerLeaseRequest(request, response, options.stateStoreOptions, parts);
    return;
  }

  notFound(response, pathname);
}

export async function startRunServer(options: RunServerOptions): Promise<RunServerHandle> {
  const credentials = validateResolvedConsumerApiCredentialVerifiers(options.credentials);
  const host = options.host ?? detectTailscaleHost();
  const port = options.port ?? 8740;
  if (port !== 0 && FETCH_BAD_PORTS.has(port)) {
    throw new RunServerPortError({
      code: "fetch_forbidden_port",
      requestedPort: port,
      assignedPort: port,
      attempts: 0,
    });
  }
  const stateStoreOptions = options.stateStoreOptions ?? { env: { ...process.env } };
  const daemonId = options.daemonId?.trim() || DEFAULT_DAEMON_ID;
  const hostname = options.hostname ?? systemHostname;
  const actualHost = hostname().trim().toLowerCase();
  const canonicalHost = normalizeHostAlias(actualHost);
  const advertisedHost = options.advertisedHost?.trim() || normalizeHostAlias(systemHostname()) || host;
  const buildInfo = options.buildInfo ?? loadServerBuildInfo();
  const service =
    options.service
    ?? (() => {
      const sink = new OrchestrationLedgerSink({
        host: systemHostname().split(".")[0]?.toLowerCase(),
        source: "run-server",
      });
      return new RunService({
        eventLogIngest: (event) => sink.ingestStreamEvent(event),
        hostname: advertisedHost,
        workloadAdmission: {
          reconcile: createInterimWorkloadAdmissionReconciler({
            build: buildInfo,
            reachability: "daemon_listener",
            stateStoreOptions,
          }),
        },
      });
    })();
  const registryRoot = options.registryRoot ?? defaultDaemonsRoot();
  const runtimeConfigRoots = Object.freeze({ ...(options.runtimeConfigRoots ?? {}) });
  const selfUpgradeReceiptRoot = options.selfUpgradeReceiptRoot
    ?? path.join(homedir(), ".calyx", "self-upgrade-receipts");
  const messageHostAliases = pinMessageHostAliases(options.messageHostAliases);
  assertMessageHostAliasesPreservePinnedLocalIdentity(messageHostAliases, actualHost, advertisedHost);
  const state: PinnedRunServerState = {
    daemonId,
    startedAt: options.startedAt ?? new Date().toISOString(),
    inheritedPath: options.inheritedPath ?? process.env["PATH"] ?? "",
    buildInfo,
    supportsFeatures: [...(options.supportsFeatures ?? SUPPORTED_FEATURES)],
    registryRoot,
    advertisedHost,
    actualHost,
    canonicalHost,
    messageHostAliases,
  };
  await applyStateMigrations({ storeOptions: stateStoreOptions });
  // Preparing the replay authority is an explicit mutating startup boundary.
  // Once the daemon accepts requests, event observation and cursor preflight
  // are read-only and fail closed if this prerequisite was skipped.
  await service.prepareGlobalEventAuthority();
  const auditStartup = await openStateStore(stateStoreOptions);
  try {
    recoverAdmittedApiRequestAudits(auditStartup.db, {
      current_server_instance_id: SERVER_PROCESS_INSTANCE_ID,
    });
    pruneApiRequestAudits(auditStartup.db);
  } finally {
    auditStartup.db.close();
  }
  let receiptMirrorDrainInFlight: Promise<void> | undefined;
  const drainPendingMessageReceipts = (): Promise<void> => {
    if (receiptMirrorDrainInFlight) return receiptMirrorDrainInFlight;
    receiptMirrorDrainInFlight = (async () => {
      const opened = await openStateStore(stateStoreOptions);
      try {
        if (checkMessageSchema(opened.db).status === "ok" && opened.paths.stateDir) {
          await drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, { limit: 25 });
        }
      } finally {
        opened.db.close();
      }
    })().catch((error) => {
      console.warn(
        "calyx.message receipt mirror drain raised",
        error instanceof Error ? error.message : String(error),
      );
    }).finally(() => {
      receiptMirrorDrainInFlight = undefined;
    });
    return receiptMirrorDrainInFlight;
  };
  let otelMetricsHandle: DaemonMetricsExporterHandle | undefined;
  let resolveDescriptorReady: (() => void) | undefined;
  let rejectDescriptorReady: ((error: unknown) => void) | undefined;
  const descriptorReady = new Promise<void>((resolve, reject) => {
    resolveDescriptorReady = resolve;
    rejectDescriptorReady = reject;
  });
  void descriptorReady.catch(() => undefined);

  const server = createServer((request, response) => {
    const requestId = `req_${randomUUID()}`;
    requestCorrelationIds.set(request, requestId);
    response.setHeader("x-calyx-request-id", requestId);
    void descriptorReady
      .then(() => handleRequest(request, response, {
        credentials,
        service,
        state,
        stateStoreOptions,
        runtimeConfigRoots,
        selfUpgradeReceiptRoot,
        ...(options.afterSelfUpgradeReceiptRootValidatedBeforeRead
          ? {
              afterSelfUpgradeReceiptRootValidatedBeforeRead:
                options.afterSelfUpgradeReceiptRootValidatedBeforeRead,
            }
          : {}),
        sessionWake: options.sessionWake ?? {},
      }))
      .catch((error) => {
        if (error instanceof RequestPayloadTooLargeError || error instanceof RequestUnsupportedMediaTypeError) {
          writeError(response, error.status, error.code, error.message);
          return;
        }
        if (error instanceof ListCursorError) {
          writeError(response, 400, "invalid_request", error.message);
          return;
        }
        if (error instanceof RequestValidationError) {
          writeError(response, 400, error.code, error.message);
          return;
        }
        writeError(response, 500, "internal_error", INTERNAL_ERROR_MESSAGE);
      });
  });

  const actualPort = await listenOnFetchCompatiblePort(server, port, host);
  let serverRunIndexProjection: RunIndexProjection | undefined;
  const closeServerRunIndexProjection = (): void => {
    const projection = serverRunIndexProjection;
    if (!projection) return;
    serverRunIndexProjection = undefined;
    service.store.unbindRunIndexProjection(projection);
    projection.close();
  };
  const baseUrl = `http://${formatListenHost(advertisedHost)}:${actualPort}`;

  try {
    serverRunIndexProjection = new RunIndexProjection({
      paths: stateStoreOptions.paths ?? stateStoreOptions,
      ...(stateStoreOptions.driver ? { driver: stateStoreOptions.driver } : {}),
    });
    if (!service.store.bindRunIndexProjection(serverRunIndexProjection)) {
      serverRunIndexProjection.close();
      serverRunIndexProjection = undefined;
    }
    await pruneStaleDescriptors({ root: registryRoot });
    await writeDescriptor(
      {
        schema_version: "calyx-daemon/v1",
        daemon_id: daemonId,
        daemon_kind: CALYX_RUN_SERVICE_DAEMON_KIND,
        pid: process.pid,
        argv: sanitizeDescriptorArgv(options.descriptorArgv ? [...options.descriptorArgv] : process.argv.slice(1)),
        cwd: process.cwd(),
        runs_root: service.store.root,
        health_url: baseUrl,
        livez_url: `${baseUrl}/livez`,
        supervisor: detectSupervisor(daemonId),
        started_at: state.startedAt,
        build: toCalyxDaemonBuildSummary(state.buildInfo),
        // Serving substrate; higher-level orchestrators restart after it.
        restart_order: RESTART_ORDER,
        depends_on: [],
        maintenance_mode: false,
      },
      { root: registryRoot },
    );
    // POL-1879: re-adopt live detached workers BEFORE marking the daemon ready.
    // Detached workers self-write events/health/logs to files and survive a
    // daemon bounce, but a fresh daemon would otherwise not resume supervising
    // them. Running this reconcile pass before resolveDescriptorReady() gates
    // request handling and versioned health routes (which await descriptorReady) on the
    // re-adoption attempt, so the daemon never answers or accepts work before it
    // has tried to recover what it owns. State isolation (temp CALYX_STATE_HOME /
    // runs_root in tests) keeps this from touching the live store. Tolerate a
    // reconcile failure rather than refusing to serve — the versioned admin
    // reconcile route stays available as the manual repair path, and readiness
    // still resolves.
    try {
      await service.reconcile();
    } catch (error) {
      console.warn(
        "calyx.daemon boot reconcile raised",
        error instanceof Error ? error.message : String(error),
      );
    }
    // D1 starts fenced and opens only through this receipt-validating action.
    // A failed evidence pass is published in health without taking down the
    // management plane; each later launch re-runs the same current-authority
    // reconciliation before it can create a run record.
    try {
      await service.reconcileWorkloadAdmission();
    } catch (error) {
      if (!(error instanceof WorkloadAdmissionBusyError)) throw error;
      console.warn(
        "calyx.daemon boot workload-admission reconcile busy; serving with the current fenced decision",
        error.message,
      );
    }
    resolveDescriptorReady?.();
  } catch (error) {
    rejectDescriptorReady?.(error);
    try {
      await closeListener(server);
    } catch {
      // Cleanup failure must not mask the startup failure that owns this path.
    } finally {
      try {
        closeServerRunIndexProjection();
      } catch {
        // Projection cleanup is secondary to the same startup failure.
      }
    }
    throw error;
  }

  void drainPendingMessageReceipts();
  const receiptMirrorTimer = setInterval(
    () => void drainPendingMessageReceipts(),
    Math.max(100, options.receiptMirrorRetryIntervalMs ?? 5_000),
  );
  receiptMirrorTimer.unref();

  // POL-1897: steady-state settlement. The boot reconcile above recovers what
  // the daemon owned at startup (scope "all"); this interval settles workers
  // that die during uptime (otherwise a dead detached worker orphans its run
  // in an active state until the next restart). Scope "active" bounds each
  // tick to currently non-terminal runs — full historical repair stays on
  // boot and explicit admin reconcile. Single-flight — a slow pass never
  // overlaps the next tick; failures warn and the next tick retries. The
  // in-flight promise is retained so close() can drain the current pass
  // before it closes the owned projection and relinquishes the descriptor —
  // a pass allowed to run past close could otherwise publish authoritative
  // terminal JSON whose projection/lease follow-up is lost until recovery.
  let closed = false;
  let reconcileTickInFlight: Promise<void> | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  if (options.reconcileIntervalMs !== false) {
    const reconcileEveryMs = Math.max(100, options.reconcileIntervalMs ?? 60_000);
    reconcileTimer = setInterval(() => {
      if (closed || reconcileTickInFlight) return;
      reconcileTickInFlight = service
        .reconcile({ scope: "active" })
        .then(
          () => {},
          (error) => {
            console.warn(
              "calyx.daemon steady-state reconcile raised",
              error instanceof Error ? error.message : String(error),
            );
          },
        )
        .finally(() => {
          reconcileTickInFlight = undefined;
        });
    }, reconcileEveryMs);
    reconcileTimer.unref();
  }

  // initDaemonMetricsExporter checks CALYX_DISABLE_OTEL internally and
  // returns a no-op handle without loading the OTel SDK when set, so we
  // don't need a separate guard here.
  try {
    const handle = await initDaemonMetricsExporter({
      state: {
        daemonId: state.daemonId,
        buildInfo: state.buildInfo,
        supportsFeatures: state.supportsFeatures,
      },
      service,
    });
    otelMetricsHandle = handle;
    if (handle.initialized && !state.supportsFeatures.includes(CALYX_DAEMON_FEATURES.otelMetricsV1)) {
      state.supportsFeatures = [...state.supportsFeatures, CALYX_DAEMON_FEATURES.otelMetricsV1];
    }
  } catch (error) {
    console.warn(
      "calyx.daemon otel metrics init threw",
      error instanceof Error ? error.message : String(error),
    );
  }

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      clearInterval(receiptMirrorTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      await receiptMirrorDrainInFlight;
      // Drain the in-flight steady-state reconcile before the owned projection
      // closes below; `closed` (re-checked by the tick) fences new passes.
      await reconcileTickInFlight;
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      if (otelMetricsHandle) {
        try {
          await otelMetricsHandle.shutdown();
        } catch (error) {
          console.warn(
            "calyx.daemon otel metrics shutdown raised",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            const typed = error as NodeJS.ErrnoException | undefined;
            if (typed && typed.code !== "ERR_SERVER_NOT_RUNNING") {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } finally {
        closeServerRunIndexProjection();
      }
      await removeDescriptorForPid(daemonId, process.pid, { root: registryRoot });
    })();
    return closePromise;
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = (): void => {
      void close().finally(() => {
        process.exit(0);
      });
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  return {
    server,
    url: `http://${formatListenHost(host)}:${actualPort}`,
    close,
  };
}
