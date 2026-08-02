import { open, readdir, rm, rmdir } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import { join } from "node:path";
import {
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS,
  CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE,
  CALYX_DAEMON_FEATURES,
  getDaemonCompatibilityRefusal,
  readHostsTruth,
  resolveAgentsInfraRoot,
  resolveConsumerApiClientToken,
  type CalyxAdminHealth as CalyxDaemonHealth,
  type HostsTruthFile,
} from "@polli-labs/calyx-core";
import {
  createCalyxAdminClient,
  type CalyxAdminClient,
  type CalyxBinaryResponse,
  type CalyxResult,
} from "@polli-labs/calyx-client/admin";
import {
  ACTIVITY_ATTACHMENT_MAX_BYTES,
  ActivityAttachmentError,
  createAttachmentCacheTempPath,
  defaultAttachmentCacheDir,
  inspectActivityAttachments as inspectActivityAttachmentsFromSource,
  isLocalRunTarget,
  publishVerifiedAttachmentCacheFile,
  recordVerifiedAttachmentCacheHit,
  type ActivityAttachmentCacheWriteResult,
  type ActivityAttachmentRecord,
  type ActivityAttachmentRecordResult,
  type ActivityAttachmentsResult,
} from "@polli-labs/calyx-run-service";
export const DEFAULT_RUN_SERVER_URL_TEMPLATE_ENV = "CALYX_RUN_SERVER_URL_TEMPLATE";
const DEFAULT_AGENT_SESSION_ARCHIVE_RAW_ROOT_ENV = "CALYX_AGENT_SESSION_ARCHIVE_RAW_ROOT";

export interface ActivityAttachmentClientDependencies {
  createAdminClient?: typeof createCalyxAdminClient;
  agentsInfraRoot?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  hostnameImpl?: () => string;
  tokenForHost?: (host: string) => Promise<string | undefined> | string | undefined;
  readHostsTruth?: (agentsInfraRoot: string) => Promise<HostsTruthFile> | HostsTruthFile;
}

export interface RunServerAccessOptions {
  host?: string | undefined;
  serverUrl?: string | undefined;
  authToken?: string | undefined;
  clientId?: string | undefined;
  resolveCredential?: boolean | undefined;
}

export interface ResolvedRunServerAccess {
  host?: string;
  serverUrl: string;
  token?: string;
}

export class ActivityAttachmentClientError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, exitCode = 6, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "ActivityAttachmentClientError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function envValue(deps: ActivityAttachmentClientDependencies | undefined, key: string): string | undefined {
  return deps?.env?.[key]?.trim() || process.env[key]?.trim() || undefined;
}

function currentHost(deps: ActivityAttachmentClientDependencies = {}): string {
  const raw = deps.hostnameImpl ? deps.hostnameImpl() : systemHostname();
  return raw.split(".")[0]?.toLowerCase() ?? raw.toLowerCase();
}

function defaultRunServerUrl(host: string, deps: ActivityAttachmentClientDependencies = {}): string {
  const template = envValue(deps, DEFAULT_RUN_SERVER_URL_TEMPLATE_ENV);
  if (template) {
    return template.replaceAll("{host}", host);
  }
  return `http://${host}:8740`;
}

export function buildRunServerUrl(host: string, explicitServerUrl?: string, deps: ActivityAttachmentClientDependencies = {}): string {
  if (explicitServerUrl?.trim()) {
    return explicitServerUrl.trim();
  }
  return defaultRunServerUrl(host, deps);
}

export function resolveRunServerUrlTemplate(rawValue?: string, deps: ActivityAttachmentClientDependencies = {}): string | undefined {
  const candidate = rawValue?.trim() || envValue(deps, DEFAULT_RUN_SERVER_URL_TEMPLATE_ENV);
  return candidate && candidate.length > 0 ? candidate : undefined;
}

export function resolveRunServerToken(rawValue?: string, _deps: ActivityAttachmentClientDependencies = {}): string | undefined {
  const candidate = rawValue?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

async function readRunServeHostsTruth(deps: ActivityAttachmentClientDependencies = {}): Promise<HostsTruthFile> {
  const agentsInfraRoot = deps.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    return {};
  }
  return deps.readHostsTruth
    ? deps.readHostsTruth(agentsInfraRoot)
    : readHostsTruth(agentsInfraRoot);
}

function parseConfiguredRunServerUrl(host: string, rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ActivityAttachmentClientError(
      "run_server_url_invalid",
      `Host ${host} has an invalid run_serve_url.`,
      2,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !parsed.hostname
  ) {
    throw new ActivityAttachmentClientError(
      "run_server_url_invalid",
      `Host ${host} run_serve_url must be an HTTP(S) URL without userinfo, query, or fragment data.`,
      2,
    );
  }
  return parsed;
}

function configuredRunServerTarget(
  hostsTruth: HostsTruthFile,
  host: string,
): { host: string; serverUrl: string; endpointBinding: string } | undefined {
  const aliases = new Map<string, string>();
  const addAlias = (identity: string, canonicalHost: string): void => {
    const normalizedIdentity = identity.trim().toLowerCase();
    const normalizedCanonicalHost = canonicalHost.trim().toLowerCase();
    const existing = aliases.get(normalizedIdentity);
    if (existing && existing !== normalizedCanonicalHost) {
      throw new ActivityAttachmentClientError(
        "run_server_host_ambiguous",
        `Run-server host identity ${normalizedIdentity} is ambiguous between ${existing} and ${normalizedCanonicalHost}.`,
        2,
      );
    }
    aliases.set(normalizedIdentity, normalizedCanonicalHost);
  };

  for (const [canonicalHost, entry] of Object.entries(hostsTruth.hosts ?? {})) {
    const serverUrl = entry.run_serve_url?.trim();
    if (!serverUrl) continue;
    const parsed = parseConfiguredRunServerUrl(canonicalHost, serverUrl);
    addAlias(canonicalHost, canonicalHost);
    addAlias(parsed.hostname, canonicalHost);
  }

  const canonicalHost = aliases.get(host.trim().toLowerCase());
  if (!canonicalHost) return undefined;
  const serverUrl = hostsTruth.hosts?.[canonicalHost]?.run_serve_url?.trim();
  if (!serverUrl) return undefined;
  return {
    host: canonicalHost,
    serverUrl,
    endpointBinding: normalizeRunServerEndpointBinding(parseConfiguredRunServerUrl(canonicalHost, serverUrl)),
  };
}

function normalizeRunServerEndpointBinding(value: URL): string {
  // Match the generated client's baseUrl law exactly: the URL parser
  // preserves repeated trailing slashes and transport removes one delimiter
  // before appending a generated operation path. Collapsing all slashes here
  // would bind ambient credentials to a different dispatched base path.
  const pathname = value.pathname === "/" ? "" : value.pathname.replace(/\/$/u, "");
  return `${value.origin}${pathname}`;
}

/**
 * Resolves a run-server endpoint and bearer as one authority tuple.
 *
 * Explicit bearer tokens are caller-owned and may accompany any explicit URL.
 * Ambient named-host credentials are narrower: they are only resolved when the
 * selected endpoint has the exact normalized scheme/host/port/base-path binding
 * configured for that host (or one of its configured URL-host aliases). This
 * ordering is security-significant: tokenForHost is never called for an
 * unconfigured, origin-rebound, or base-path-rebound endpoint.
 */
export async function resolveRunServerAccess(
  options: RunServerAccessOptions,
  deps: ActivityAttachmentClientDependencies = {},
): Promise<ResolvedRunServerAccess> {
  const requestedHost = options.host?.trim();
  const explicitServerUrl = options.serverUrl?.trim();
  const explicitToken = options.authToken?.trim();

  if (explicitServerUrl && explicitToken) {
    return {
      ...(requestedHost ? { host: requestedHost } : {}),
      serverUrl: explicitServerUrl,
      token: explicitToken,
    };
  }

  const hostsTruth = requestedHost ? await readRunServeHostsTruth(deps) : {};
  const configuredTarget = requestedHost
    ? configuredRunServerTarget(hostsTruth, requestedHost)
    : undefined;
  const canonicalHost = configuredTarget?.host ?? requestedHost;
  const serverUrl = explicitServerUrl
    ?? configuredTarget?.serverUrl
    ?? buildRunServerUrl(requestedHost ?? "127.0.0.1", undefined, deps);

  if (explicitToken) {
    return {
      ...(canonicalHost ? { host: canonicalHost } : {}),
      serverUrl,
      token: explicitToken,
    };
  }

  if (options.resolveCredential === false || !canonicalHost || !configuredTarget) {
    return {
      ...(canonicalHost ? { host: canonicalHost } : {}),
      serverUrl,
    };
  }

  let selectedUrl: URL;
  try {
    selectedUrl = new URL(serverUrl);
  } catch {
    return { host: canonicalHost, serverUrl };
  }
  if (
    (selectedUrl.protocol !== "http:" && selectedUrl.protocol !== "https:")
    || selectedUrl.username !== ""
    || selectedUrl.password !== ""
    || selectedUrl.search !== ""
    || selectedUrl.hash !== ""
    || !selectedUrl.hostname
    || normalizeRunServerEndpointBinding(selectedUrl) !== configuredTarget.endpointBinding
  ) {
    return { host: canonicalHost, serverUrl };
  }

  const clientId = options.clientId?.trim() || "operator_cli";
  if (clientId === "operator_cli" && deps.tokenForHost) {
    const injected = await deps.tokenForHost(canonicalHost);
    if (injected?.trim()) {
      return { host: canonicalHost, serverUrl, token: injected.trim() };
    }
  }
  const token = resolveConsumerApiClientToken(
    canonicalHost,
    hostsTruth.hosts?.[canonicalHost],
    clientId,
    deps.env ?? process.env,
  );
  return {
    host: canonicalHost,
    serverUrl,
    ...(token ? { token } : {}),
  };
}

export function usesRemoteActivityAttachmentTarget(
  host: string | undefined,
  explicitServerUrl: string | undefined,
  deps: ActivityAttachmentClientDependencies = {},
): boolean {
  if (explicitServerUrl?.trim()) {
    return true;
  }
  return Boolean(host && !isLocalRunTarget(host, { hostname: () => currentHost(deps) }));
}

function createRemoteAdminClient(options: {
  serverUrl: string;
  token: string;
  deps?: ActivityAttachmentClientDependencies;
}): CalyxAdminClient {
  const factory = options.deps?.createAdminClient ?? createCalyxAdminClient;
  return factory({
    baseUrl: options.serverUrl,
    bearerToken: options.token,
  });
}

function throwRemoteClientFailure<T, Code extends string>(
  result: Exclude<CalyxResult<T, Code>, { ok: true }>,
  options: {
    context: string;
    protocolCode?: string;
    fallbackApiCode?: string;
  },
): never {
  if (result.kind === "api") {
    const providerCode = String(result.error.error.code);
    const code = result.status === 401
      ? "auth_failure"
      : providerCode || options.fallbackApiCode || "run_server_request_failed";
    throw new ActivityAttachmentClientError(
      code,
      `${options.context} failed (${result.status}): ${result.error.error.message}`,
      result.status === 401 ? 8 : result.status === 404 ? 3 : 6,
    );
  }
  if (result.kind === "transport") {
    throw new ActivityAttachmentClientError(
      "activity_owner_unreachable",
      `${options.context} failed: daemon is unreachable (${result.message})`,
      6,
    );
  }
  if (result.kind === "protocol") {
    throw new ActivityAttachmentClientError(
      options.protocolCode ?? "run_server_invalid_success",
      `${options.context} failed: daemon returned an invalid response (${result.message})`,
      6,
    );
  }
  throw new ActivityAttachmentClientError(
    options.protocolCode ?? "run_server_invalid_success",
    `${options.context} returned an impossible indeterminate result for a read operation.`,
    6,
  );
}

function expectedAttachmentDigestHeader(sha256: string): string {
  return `sha-256=${Buffer.from(sha256, "hex").toString("base64")}`;
}

function assertAttachmentRecordWithinLimit(
  attachment: ActivityAttachmentRecord,
  expected?: { ref: string; activityId: string },
): void {
  if (!/^[0-9a-f]{64}$/u.test(attachment.sha256)) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment ${attachment.ref} record has a noncanonical sha256 digest.`,
      6,
    );
  }
  const contentAddressedRef = `att:sha256:${attachment.sha256}`;
  if (
    attachment.ref !== contentAddressedRef
    || (expected && attachment.ref !== expected.ref)
    || (expected && attachment.activity_id !== expected.activityId)
  ) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment record identity does not match request ${expected?.ref ?? attachment.ref}.`,
      6,
    );
  }
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(attachment.mime_type)) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment ${attachment.ref} record has a noncanonical MIME type.`,
      6,
    );
  }
  if (
    !attachment.source_tier
    || attachment.source_tier.length > CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_MAX_CHARS
    || !new RegExp(CALYX_ACTIVITY_ATTACHMENT_SOURCE_TIER_PATTERN_SOURCE, "u").test(attachment.source_tier)
  ) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment ${attachment.ref} record has a noncanonical source-tier custody binding.`,
      6,
    );
  }
  if (
    !Number.isSafeInteger(attachment.byte_size)
    || attachment.byte_size < 0
    || attachment.byte_size > ACTIVITY_ATTACHMENT_MAX_BYTES
  ) {
    throw new ActivityAttachmentClientError(
      "attachment_size_limit_exceeded",
      `Attachment ${attachment.ref} record declares ${attachment.byte_size} bytes; the hard maximum is ${ACTIVITY_ATTACHMENT_MAX_BYTES}.`,
      6,
    );
  }
}

function assertRemoteAttachmentMetadata(
  response: CalyxBinaryResponse,
  attachment: ActivityAttachmentRecord,
): number {
  const sourceTier = attachment.source_tier;
  if (!sourceTier) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment ${attachment.ref} record is missing its source-tier custody binding.`,
      6,
    );
  }
  const contentLength = response.contentLength;
  if (!Number.isSafeInteger(contentLength) || contentLength > ACTIVITY_ATTACHMENT_MAX_BYTES) {
    throw new ActivityAttachmentClientError(
      "attachment_size_limit_exceeded",
      `Attachment ${attachment.ref} declares ${contentLength} response bytes; the hard maximum is ${ACTIVITY_ATTACHMENT_MAX_BYTES}.`,
      6,
    );
  }
  if (contentLength !== attachment.byte_size) {
    throw new ActivityAttachmentClientError(
      "attachment_size_mismatch",
      `Attachment ${attachment.ref} Content-Length mismatch: record declares ${attachment.byte_size}, response declares ${contentLength}.`,
      6,
    );
  }

  const expectedMetadata = new Map<string, [actual: string | undefined, expected: string]>([
    ["content-type", [response.contentType.split(";", 1)[0]?.trim().toLowerCase(), attachment.mime_type.toLowerCase()]],
    ["digest", [response.digest, expectedAttachmentDigestHeader(attachment.sha256)]],
    ["etag", [response.etag, `"sha256:${attachment.sha256}"`]],
    ["attachment-ref", [response.attachmentRef, attachment.ref]],
    ["source-tier", [response.sourceTier, sourceTier]],
  ]);
  for (const [name, [actual, expected]] of expectedMetadata) {
    if (actual !== expected) {
      throw new ActivityAttachmentClientError(
        "attachment_response_invalid",
        `Attachment ${attachment.ref} ${name} custody mismatch: expected ${expected}, got ${actual ?? "missing"}.`,
        6,
      );
    }
  }
  for (const [name, expected, actual] of [
    ["origin-host", attachment.origin_host, response.originHost],
    ["served-by-host", attachment.served_by_host, response.servedByHost],
  ] as const) {
    if (actual !== expected) {
      throw new ActivityAttachmentClientError(
        "attachment_response_invalid",
        `Attachment ${attachment.ref} ${name} header mismatch: expected ${expected ?? "absent"}, got ${actual ?? "missing"}.`,
        6,
      );
    }
  }
  return contentLength;
}

function attachmentCustodyFailure(error: unknown, ref: string): ActivityAttachmentClientError {
  if (error instanceof ActivityAttachmentClientError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /digest/iu.test(message)
    ? "attachment_digest_mismatch"
    : "attachment_size_mismatch";
  return new ActivityAttachmentClientError(
    code,
    `Attachment ${ref} failed generated-client custody verification: ${message}`,
    6,
  );
}

export async function requestRemoteAttachmentToCache(options: {
  serverUrl: string;
  token: string;
  activityId: string;
  ref: string;
  outDir: string;
  remoteLabel: string;
  attachment: ActivityAttachmentRecordResult;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentCacheWriteResult> {
  assertAttachmentRecordWithinLimit(options.attachment, {
    ref: options.ref,
    activityId: options.activityId,
  });
  const client = createRemoteAdminClient(options);
  const result = await client.admin.activity.attachmentBytes({
    path: { activityId: options.activityId, ref: options.ref },
  });
  if (!result.ok) {
    throwRemoteClientFailure(result, {
      context: `${options.remoteLabel} attachment bytes ${options.ref}`,
      protocolCode: "attachment_response_invalid",
      fallbackApiCode: "attachment_byte_fetch_failed",
    });
  }
  const response = result.data;

  let contentLength: number;
  let tempPath: string;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    contentLength = assertRemoteAttachmentMetadata(response, options.attachment);
    tempPath = await createAttachmentCacheTempPath(options.outDir, options.attachment);
    reader = response.body.getReader();
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  let byteSize = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      if (byteSize + chunk.length > contentLength || byteSize + chunk.length > ACTIVITY_ATTACHMENT_MAX_BYTES) {
        throw new ActivityAttachmentClientError(
          "attachment_size_mismatch",
          `Attachment ${options.ref} response exceeded its declared ${contentLength} bytes.`,
          6,
        );
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = await handle.write(chunk, offset, chunk.length - offset, null);
        offset += written.bytesWritten;
      }
      byteSize += chunk.length;
    }
    if (byteSize !== contentLength) {
      throw new ActivityAttachmentClientError(
        "attachment_size_mismatch",
        `Attachment ${options.ref} response ended at ${byteSize} bytes; expected ${contentLength}.`,
        6,
      );
    }
    await response.verified;
    await handle.sync();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    await rmdir(join(options.outDir, "_tmp")).catch(() => undefined);
    throw attachmentCustodyFailure(error, options.ref);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  return publishVerifiedAttachmentCacheFile({
    outDir: options.outDir,
    attachment: options.attachment,
    tempPath,
    sourceTier: options.attachment.source_tier,
    classifierVersion: options.attachment.classifier_version,
    ...(options.attachment.origin_host ? { originHost: options.attachment.origin_host } : {}),
    ...(options.attachment.served_by_host ? { servedByHost: options.attachment.served_by_host } : {}),
  });
}

export async function fetchRemoteActivityAttachmentRecord(options: {
  serverUrl: string;
  token: string;
  activityId: string;
  ref: string;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentRecordResult> {
  const result = await createRemoteAdminClient(options).admin.activity.attachmentRecord({
    path: { activityId: options.activityId, ref: options.ref },
  });
  if (!result.ok) {
    throwRemoteClientFailure(result, {
      context: "activity attachment record",
      protocolCode: "attachment_response_invalid",
    });
  }
  const record = result.data as ActivityAttachmentRecordResult;
  assertAttachmentRecordWithinLimit(record, {
    ref: options.ref,
    activityId: options.activityId,
  });
  return record;
}

export async function fetchRemoteActivityAttachmentsInventory(options: {
  serverUrl: string;
  token: string;
  activityId: string;
  ref?: string;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentsResult> {
  const result = await createRemoteAdminClient(options).admin.activity.attachments({
    path: { activityId: options.activityId },
    ...(options.ref ? { query: { ref: options.ref } } : {}),
  });
  if (!result.ok) {
    throwRemoteClientFailure(result, {
      context: "activity attachment inventory",
      protocolCode: "attachment_response_invalid",
    });
  }
  // The generated schema intentionally keeps extension points open; the
  // run-service model supplies the stricter local projection used below.
  const inventory = result.data as unknown as ActivityAttachmentsResult;
  if (inventory.activity_id !== options.activityId) {
    throw new ActivityAttachmentClientError(
      "attachment_response_invalid",
      `Attachment inventory identity ${inventory.activity_id} does not match request ${options.activityId}.`,
      6,
    );
  }
  for (const attachment of inventory.attachments) {
    assertAttachmentRecordWithinLimit(attachment, {
      ref: options.ref ?? attachment.ref,
      activityId: options.activityId,
    });
  }
  return inventory;
}

export async function assertRemoteActivityAttachmentSupport(options: {
  serverUrl: string;
  token: string;
  hostLabel: string;
  requiresBytes: boolean;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<CalyxDaemonHealth> {
  const result = await createRemoteAdminClient(options).admin.health();
  if (!result.ok) {
    throwRemoteClientFailure(result, { context: "run server health" });
  }
  const health = result.data as CalyxDaemonHealth;
  const refusal = getDaemonCompatibilityRefusal(
    options.hostLabel,
    health,
    options.requiresBytes
      ? [CALYX_DAEMON_FEATURES.activityAttachmentsV1, CALYX_DAEMON_FEATURES.activityAttachmentBytesV1]
      : [CALYX_DAEMON_FEATURES.activityAttachmentsV1],
  );
  if (refusal) {
    throw new ActivityAttachmentClientError("activity_owner_unreachable", refusal.message, 6);
  }
  return health;
}

export async function materializeRemoteActivityAttachment(options: {
  serverUrl: string;
  token: string;
  activityId: string;
  ref: string;
  outDir: string;
  remoteLabel: string;
  record?: ActivityAttachmentRecordResult;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentRecord> {
  const record = options.record ?? await fetchRemoteActivityAttachmentRecord(options);
  assertAttachmentRecordWithinLimit(record, {
    ref: options.ref,
    activityId: options.activityId,
  });
  if (!record.exact_bytes_available) {
    return record;
  }
  const cached = await recordVerifiedAttachmentCacheHit({
    outDir: options.outDir,
    attachment: record,
    sourceTier: record.source_tier,
    classifierVersion: record.classifier_version,
    ...(record.origin_host ? { originHost: record.origin_host } : {}),
    ...(record.served_by_host ? { servedByHost: record.served_by_host } : {}),
  });
  if (cached) {
    return {
      ...record,
      extracted_path: cached.path,
      provenance_path: cached.provenance_path,
      cache_status: cached.cache_status,
    };
  }
  const cacheResult = await requestRemoteAttachmentToCache({
    ...options,
    attachment: record,
  });
  return {
    ...record,
    extracted_path: cacheResult.path,
    provenance_path: cacheResult.provenance_path,
    cache_status: cacheResult.cache_status,
  };
}

function defaultAgentSessionArchiveRawRoot(deps: ActivityAttachmentClientDependencies = {}): string {
  return envValue(deps, DEFAULT_AGENT_SESSION_ARCHIVE_RAW_ROOT_ENV)
    || join(homedir(), "archive", "agent-session-archive", "raw");
}

function normalizeAttachmentArchiveHostAlias(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/\..*$/, "") ?? "";
}

function attachmentArchiveHostAliases(host: string): Set<string> {
  const normalized = normalizeAttachmentArchiveHostAlias(host);
  const aliases = new Set<string>();
  if (normalized) {
    aliases.add(normalized);
    aliases.add(normalized.replace(/^r5-/, ""));
  }
  if (normalized === "worm") {
    aliases.add("r5-worm");
  }
  if (normalized === "mba" || normalized === "macbook") {
    aliases.add("calebs-macbook-air-2");
  }
  return aliases;
}

async function resolveAttachmentArchiveHostRoot(
  originHost: string,
  deps: ActivityAttachmentClientDependencies = {},
): Promise<string | undefined> {
  const archiveRoot = defaultAgentSessionArchiveRawRoot(deps);
  const aliases = attachmentArchiveHostAliases(originHost);
  if (aliases.size === 0) {
    return undefined;
  }
  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    const normalized = normalizeAttachmentArchiveHostAlias(entry.name);
    if (aliases.has(name) || aliases.has(normalized)) {
      return join(archiveRoot, entry.name);
    }
  }
  return undefined;
}

export function isActivityOwnerUnreachableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("activity_owner_unreachable");
}

export async function inspectArchiveActivityAttachmentRecord(options: {
  activityId: string;
  ref: string;
  originHost: string;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentRecordResult> {
  const archiveHostRoot = await resolveAttachmentArchiveHostRoot(options.originHost, options.deps);
  if (!archiveHostRoot) {
    throw new ActivityAttachmentClientError(
      "attachment_archive_unavailable",
      `POL-1041 archive fallback has no raw-session mirror for origin host ${options.originHost}.`,
      6,
    );
  }
  try {
    const result = await inspectActivityAttachmentsFromSource({
      activityId: options.activityId,
      host: options.originHost,
      codexSessionsRoot: join(archiveHostRoot, "codex", "sessions"),
      codexArchivedSessionsRoot: join(archiveHostRoot, "codex", "archived_sessions"),
      claudeProjectsRoot: join(archiveHostRoot, "claude", "projects"),
      selector: { ref: options.ref },
      sourceTier: "blade-archive",
      servedByHost: currentHost(options.deps),
      ...(options.deps?.now ? { now: options.deps.now } : {}),
    });
    const attachment = result.attachments.find((candidate) => candidate.ref === options.ref);
    if (!attachment) {
      throw new ActivityAttachmentClientError(
        "attachment_ref_unknown",
        `POL-1041 archive mirror for ${options.originHost} did not observe ${options.ref} in ${options.activityId}.`,
        3,
      );
    }
    return {
      schema_version: "activity.attachment-record/v1",
      classifier_version: result.classifier_version,
      ...attachment,
      source_tier: "blade-archive",
      origin_host: options.originHost,
      served_by_host: currentHost(options.deps),
      source_receipt: result.source_receipt,
    };
  } catch (error) {
    if (error instanceof ActivityAttachmentClientError) {
      throw error;
    }
    if (error instanceof ActivityAttachmentError) {
      throw error;
    }
    throw new ActivityAttachmentClientError(
      "attachment_archive_unavailable",
      `POL-1041 archive mirror for ${options.originHost} cannot resolve ${options.activityId}.`,
      6,
    );
  }
}

export async function pullThroughArchiveActivityAttachmentResult(options: {
  activityId: string;
  ref: string;
  outDir?: string;
  originHost: string;
  deps?: ActivityAttachmentClientDependencies;
}): Promise<ActivityAttachmentsResult> {
  const archiveHostRoot = await resolveAttachmentArchiveHostRoot(options.originHost, options.deps);
  if (!archiveHostRoot) {
    throw new ActivityAttachmentClientError(
      "attachment_archive_unavailable",
      `POL-1041 archive fallback has no raw-session mirror for origin host ${options.originHost}.`,
      6,
    );
  }
  try {
    const result = await inspectActivityAttachmentsFromSource({
      activityId: options.activityId,
      host: options.originHost,
      codexSessionsRoot: join(archiveHostRoot, "codex", "sessions"),
      codexArchivedSessionsRoot: join(archiveHostRoot, "codex", "archived_sessions"),
      claudeProjectsRoot: join(archiveHostRoot, "claude", "projects"),
      selector: {
        ref: options.ref,
        extract: true,
        out_dir: options.outDir?.trim() || defaultAttachmentCacheDir(),
      },
      sourceTier: "blade-archive",
      servedByHost: currentHost(options.deps),
      ...(options.deps?.now ? { now: options.deps.now } : {}),
    });
    if (result.attachments.length === 0) {
      throw new ActivityAttachmentClientError(
        "attachment_ref_unknown",
        `POL-1041 archive mirror for ${options.originHost} did not observe ${options.ref} in ${options.activityId}.`,
        3,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ActivityAttachmentClientError) {
      throw error;
    }
    if (error instanceof ActivityAttachmentError && error.code !== "attachment_ref_unknown") {
      throw error;
    }
    if (error instanceof ActivityAttachmentError) {
      throw new ActivityAttachmentClientError(error.code, error.message, 3, { ...error.details });
    }
    throw new ActivityAttachmentClientError(
      "attachment_archive_unavailable",
      `POL-1041 archive fallback failed to materialize ${options.ref} for ${options.originHost}.`,
      6,
    );
  }
}
