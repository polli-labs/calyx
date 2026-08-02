import type { StateDriverDatabase } from "./driver";
import { LEASE_TABLES } from "./migrations";
import {
  isCanonicalApiTimestamp,
  parseApiProvenanceJson,
  validateApiProvenance,
  type ApiProvenanceV1,
} from "./provenance";

export const LEASE_RESOURCE_KINDS = ["worktree", "session", "vault", "issue"] as const;
export type LeaseResourceKind = (typeof LEASE_RESOURCE_KINDS)[number];

export interface ParsedLeaseKey {
  key: string;
  resource_kind: LeaseResourceKind;
  owner_host: string;
  resource_host: string | null;
  resource_path: string;
}

export interface LeaseRow extends ParsedLeaseKey {
  holder_activity_id: string;
  acquired_at: string;
  ttl_ms: number;
  renewed_at: string | null;
  expires_at: string;
  stolen_from_holder_activity_id: string | null;
  stolen_at: string | null;
  steal_provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export const LEASE_RESOURCE_QUARANTINE_METADATA_KEY = "calyx_resource_quarantine";

export type LeaseResourceQuarantine = {
  schema_version: "calyx.lease-resource-quarantine/v1";
  status: "active";
  run_id: string;
  quarantined_at: string;
} & (
  | {
      authority: "legacy_process_group_observation";
      owner_free_authority_id: string;
      expected_resource_authority_id: string;
      legacy_process_group_id: number;
    }
  | {
      /**
       * POL-1897 minimal posture: an owner-free terminal settlement proved
       * the Calyx publisher gone, not the detached backend process group.
       * The worktree lease stays fenced until POL-1990 proves backend
       * extinction (or an operator explicitly steals it); TTL expiry alone
       * never frees a fenced run-held worktree lease.
       */
      authority: "owner_free_settlement_unproven_backend";
      reason_code: "backend_resource_extinction_unproven";
    }
);

export interface QuarantineRunWorktreeLeasesInput {
  run_id: string;
  owner_free_authority_id: string;
  expected_resource_authority_id: string;
  legacy_process_group_id: number;
  quarantined_at: string;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface QuarantineOwnerFreeRunWorktreeLeasesInput {
  run_id: string;
  quarantined_at: string;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface LeaseQuarantineResult {
  quarantined: LeaseRow[];
  already_quarantined: LeaseRow[];
}

export interface ReleaseQuarantinedRunWorktreeLeasesInput {
  run_id: string;
  owner_free_authority_id: string;
  resource_authority_id: string;
  legacy_process_group_id: number;
  now?: string | undefined;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface AcquireLeaseInput {
  key: string;
  holder_activity_id: string;
  ttl_ms: number;
  now?: string | undefined;
  coordinator_host?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface RenewLeaseInput {
  key: string;
  holder_activity_id: string;
  ttl_ms?: number | undefined;
  now?: string | undefined;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface ReleaseLeaseInput {
  key: string;
  holder_activity_id?: string | undefined;
  force?: boolean | undefined;
  request_provenance?: ApiProvenanceV1 | undefined;
  now?: string | undefined;
}

export interface StealLeaseInput {
  key: string;
  holder_activity_id: string;
  ttl_ms: number;
  provenance: string | Record<string, unknown>;
  now?: string | undefined;
  coordinator_host?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  request_provenance?: ApiProvenanceV1 | undefined;
}

export interface LeaseEventRow {
  event_id: number;
  key: string;
  event_type: "acquired" | "renewed" | "quarantined" | "released" | "stolen";
  occurred_at: string;
  reason: string | null;
  before_lease: LeaseRow | null;
  after_lease: LeaseRow | null;
  request_provenance: ApiProvenanceV1 | null;
}

export interface ListLeasesOptions {
  key?: string | undefined;
  holder_activity_id?: string | undefined;
  resource_kind?: LeaseResourceKind | undefined;
  owner_host?: string | undefined;
  include_expired?: boolean | undefined;
  now?: string | undefined;
  limit?: number | undefined;
  after_key?: string | undefined;
}

export type LeaseConflictKind = "held" | "holder-mismatch" | "holder-required" | "missing" | "expired" | "quarantined";

export interface LeaseConflict {
  kind: LeaseConflictKind;
  lease?: LeaseRow | undefined;
  message: string;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  lease?: LeaseRow | undefined;
  conflict?: LeaseConflict | undefined;
}

export interface LeaseRenewResult {
  renewed: boolean;
  lease?: LeaseRow | undefined;
  conflict?: LeaseConflict | undefined;
}

export interface LeaseReleaseResult {
  released: boolean;
  lease?: LeaseRow | undefined;
  conflict?: LeaseConflict | undefined;
}

export interface LeaseStealResult {
  stolen: boolean;
  lease: LeaseRow;
  previous_lease?: LeaseRow | undefined;
}

export interface LeaseGcResult {
  released: LeaseRow[];
  release_events: LeaseEventRow[];
}

export interface LeaseSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index" | "invalid-table-constraint";
  detail: string;
}

export interface MalformedLeaseMetadataFinding {
  key: string;
  code: "metadata-not-object" | "steal-provenance-not-object" | "resource-quarantine-malformed";
  detail: string;
}

interface RawLeaseRow {
  key: string;
  holder_activity_id: string;
  owner_host: string;
  resource_kind: string;
  resource_host: string | null;
  resource_path: string;
  acquired_at: string;
  ttl_ms: number | bigint;
  renewed_at: string | null;
  expires_at: string;
  stolen_from_holder_activity_id: string | null;
  stolen_at: string | null;
  steal_provenance_json: string;
  metadata_json: string;
}

const DEFAULT_COORDINATOR_HOST = "blade";
const LEASE_COLUMNS = `
  key, holder_activity_id, owner_host, resource_kind, resource_host,
  resource_path, acquired_at, ttl_ms, renewed_at, expires_at,
  stolen_from_holder_activity_id, stolen_at, steal_provenance_json,
  metadata_json`;
const SELECT_LEASE = `SELECT ${LEASE_COLUMNS} FROM leases`;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function normalizeHost(value: string): string {
  return normalizeRequired("host", value).toLowerCase().replace(/\..*$/, "");
}

function parseLeaseStealProvenance(value: string, key: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`lease ${key} steal_provenance_json is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`lease ${key} steal_provenance_json must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseLeaseMetadata(value: string, key: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`lease ${key} metadata_json is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`lease ${key} metadata_json must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function normalizeTtlMs(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("ttl_ms must be a positive integer");
  }
  return value;
}

function expiresAt(now: string, ttlMs: number): string {
  const baseMs = Date.parse(now);
  if (!Number.isFinite(baseMs)) {
    throw new Error(`now must be an ISO timestamp; received ${now}`);
  }
  return new Date(baseMs + ttlMs).toISOString();
}

function isExpired(row: LeaseRow, now: string): boolean {
  return Date.parse(row.expires_at) <= Date.parse(now);
}

function normalizeProvenance(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === "string") {
    const trimmed = normalizeRequired("provenance", value);
    return { text: trimmed };
  }
  return { ...value };
}

function hydrate(row: RawLeaseRow): LeaseRow {
  const resourceKind = row.resource_kind as LeaseResourceKind;
  return {
    key: row.key,
    holder_activity_id: row.holder_activity_id,
    owner_host: row.owner_host,
    resource_kind: resourceKind,
    resource_host: row.resource_host,
    resource_path: row.resource_path,
    acquired_at: row.acquired_at,
    ttl_ms: typeof row.ttl_ms === "bigint" ? Number(row.ttl_ms) : row.ttl_ms,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    stolen_from_holder_activity_id: row.stolen_from_holder_activity_id,
    stolen_at: row.stolen_at,
    steal_provenance: parseLeaseStealProvenance(row.steal_provenance_json, row.key),
    metadata: parseLeaseMetadata(row.metadata_json, row.key),
  };
}

function validateLeaseSnapshot(value: unknown): LeaseRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lease event snapshot must be an object");
  const row = value as LeaseRow;
  const parsed = parseLeaseKey(normalizeRequired("lease snapshot key", row.key), { coordinator_host: row.owner_host });
  if (
    parsed.owner_host !== row.owner_host
    || parsed.resource_kind !== row.resource_kind
    || parsed.resource_host !== row.resource_host
    || parsed.resource_path !== row.resource_path
    || typeof row.holder_activity_id !== "string"
    || !Number.isInteger(row.ttl_ms)
    || row.ttl_ms <= 0
    || !Number.isFinite(Date.parse(row.acquired_at))
    || !Number.isFinite(Date.parse(row.expires_at))
    || (row.renewed_at !== null && !Number.isFinite(Date.parse(row.renewed_at)))
    || typeof row.steal_provenance !== "object"
    || Array.isArray(row.steal_provenance)
    || typeof row.metadata !== "object"
    || Array.isArray(row.metadata)
  ) throw new Error("lease event snapshot is not a canonical LeaseRow");
  return { ...row, steal_provenance: { ...row.steal_provenance }, metadata: { ...row.metadata } };
}

function appendLeaseEvent(
  db: StateDriverDatabase,
  input: Omit<LeaseEventRow, "event_id" | "request_provenance"> & { request_provenance?: ApiProvenanceV1 | undefined },
): LeaseEventRow {
  const before = input.before_lease ? validateLeaseSnapshot(input.before_lease) : null;
  const after = input.after_lease ? validateLeaseSnapshot(input.after_lease) : null;
  const provenance = input.request_provenance ? validateApiProvenance(input.request_provenance) : null;
  const inserted = db.prepare(
    `INSERT INTO lease_events
       (key, event_type, occurred_at, reason, before_lease_json, after_lease_json,
        request_provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.key,
    input.event_type,
    input.occurred_at,
    input.reason,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    provenance ? JSON.stringify(provenance) : null,
  );
  return readLeaseEvent(db, Number(inserted.lastInsertRowid))!;
}

export function readLeaseEvent(db: StateDriverDatabase, eventId: number): LeaseEventRow | undefined {
  const row = db.prepare(
    `SELECT event_id, key, event_type, occurred_at, reason, before_lease_json,
            after_lease_json, request_provenance_json
       FROM lease_events WHERE event_id = ?`,
  ).get(eventId) as {
    event_id: number | bigint;
    key: string;
    event_type: LeaseEventRow["event_type"];
    occurred_at: string;
    reason: string | null;
    before_lease_json: string | null;
    after_lease_json: string | null;
    request_provenance_json: string | null;
  } | undefined;
  return row ? {
    event_id: Number(row.event_id),
    key: row.key,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    reason: row.reason,
    before_lease: row.before_lease_json ? validateLeaseSnapshot(JSON.parse(row.before_lease_json)) : null,
    after_lease: row.after_lease_json ? validateLeaseSnapshot(JSON.parse(row.after_lease_json)) : null,
    request_provenance: row.request_provenance_json ? parseApiProvenanceJson(row.request_provenance_json) : null,
  } : undefined;
}

export function listLeaseEvents(
  db: StateDriverDatabase,
  key: string,
  options: { limit?: number | undefined } = {},
): LeaseEventRow[] {
  const limit = normalizeLimit(options.limit);
  const rows = db.prepare(`SELECT event_id FROM lease_events WHERE key = ? ORDER BY event_id ASC LIMIT ?`)
    .all(key, limit) as Array<{ event_id: number | bigint }>;
  return rows.map((row) => readLeaseEvent(db, Number(row.event_id))!);
}

/**
 * Return the durable automatic terminal-release receipts owned by one run.
 *
 * These receipts outlive the mutable lease row and are therefore the recovery
 * authority when a process crashes after deleting a lease but before projecting
 * the release into the run journal. Voluntary and operator-forced releases are
 * deliberately excluded.
 */
export function listTerminalLeaseReleaseEventsForRun(
  db: StateDriverDatabase,
  runId: string,
  options: {
    limit?: number | undefined;
    after_event_id?: number | undefined;
  } = {},
): LeaseEventRow[] {
  const normalizedRunId = normalizeRequired("run_id", runId);
  const limit = normalizeLimit(options.limit);
  const afterEventId = options.after_event_id ?? 0;
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
    throw new Error("after_event_id must be a non-negative safe integer");
  }
  const rows = db.prepare(
    `SELECT event_id
       FROM lease_events
      WHERE event_type = 'released'
        AND (
          reason = 'terminal-run-reconcile'
          OR (
            length(reason) = 91
            AND substr(reason, 1, 27) = 'legacy-resource-settlement:'
            AND substr(reason, 28) NOT GLOB '*[^0-9a-f]*'
          )
        )
        AND json_extract(before_lease_json, '$.holder_activity_id') IN (?, ?)
        AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?`,
  ).all(
    normalizedRunId,
    `run:${normalizedRunId}`,
    afterEventId,
    limit,
  ) as Array<{ event_id: number | bigint }>;
  return rows
    .map((row) => readLeaseEvent(db, Number(row.event_id))!)
    .filter((event) => (
      event.reason === "terminal-run-reconcile"
      || /^legacy-resource-settlement:[0-9a-f]{64}$/u.test(event.reason ?? "")
    ));
}

export function parseLeaseKey(
  key: string,
  options: { coordinator_host?: string | undefined } = {},
): ParsedLeaseKey {
  const normalizedKey = normalizeRequired("key", key);
  const firstColon = normalizedKey.indexOf(":");
  if (firstColon < 0) {
    throw new Error("lease key must use kind:value syntax");
  }
  const kind = normalizedKey.slice(0, firstColon);
  const rest = normalizedKey.slice(firstColon + 1);
  const coordinatorHost = normalizeHost(options.coordinator_host ?? DEFAULT_COORDINATOR_HOST);

  if (kind === "worktree") {
    const secondColon = rest.indexOf(":");
    if (secondColon < 0) {
      throw new Error("worktree lease keys must be worktree:<host>:<path>");
    }
    const host = normalizeHost(rest.slice(0, secondColon));
    const resourcePath = normalizeRequired("worktree path", rest.slice(secondColon + 1));
    return {
      key: normalizedKey,
      resource_kind: "worktree",
      owner_host: host,
      resource_host: host,
      resource_path: resourcePath,
    };
  }

  if (kind === "session") {
    const activityId = normalizeRequired("activity id", rest);
    const parts = activityId.split(":");
    const host = parts.length >= 3 ? normalizeHost(parts[1]!) : coordinatorHost;
    return {
      key: normalizedKey,
      resource_kind: "session",
      owner_host: host,
      resource_host: host,
      resource_path: activityId,
    };
  }

  if (kind === "vault") {
    const vaultPath = normalizeRequired("vault path", rest);
    return {
      key: normalizedKey,
      resource_kind: "vault",
      owner_host: coordinatorHost,
      resource_host: null,
      resource_path: vaultPath,
    };
  }

  if (kind === "issue") {
    const issueId = normalizeRequired("issue id", rest);
    return {
      key: normalizedKey,
      resource_kind: "issue",
      owner_host: coordinatorHost,
      resource_host: null,
      resource_path: issueId,
    };
  }

  throw new Error(`unsupported lease key kind "${kind}". Expected: ${LEASE_RESOURCE_KINDS.join(", ")}`);
}

export function readLease(db: StateDriverDatabase, key: string): LeaseRow | undefined {
  const row = db.prepare(`${SELECT_LEASE} WHERE key = ?`).get(key) as RawLeaseRow | undefined;
  return row ? hydrate(row) : undefined;
}

function upsertLease(
  db: StateDriverDatabase,
  parsed: ParsedLeaseKey,
  input: {
    holder_activity_id: string;
    acquired_at: string;
    ttl_ms: number;
    renewed_at: string | null;
    expires_at: string;
    stolen_from_holder_activity_id?: string | null | undefined;
    stolen_at?: string | null | undefined;
    steal_provenance?: Record<string, unknown> | undefined;
    metadata?: Record<string, unknown> | undefined;
  },
): LeaseRow {
  db.prepare(
    `INSERT INTO leases
       (key, holder_activity_id, owner_host, resource_kind, resource_host,
        resource_path, acquired_at, ttl_ms, renewed_at, expires_at,
        stolen_from_holder_activity_id, stolen_at, steal_provenance_json,
        metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       holder_activity_id = excluded.holder_activity_id,
       owner_host = excluded.owner_host,
       resource_kind = excluded.resource_kind,
       resource_host = excluded.resource_host,
       resource_path = excluded.resource_path,
       acquired_at = excluded.acquired_at,
       ttl_ms = excluded.ttl_ms,
       renewed_at = excluded.renewed_at,
       expires_at = excluded.expires_at,
       stolen_from_holder_activity_id = excluded.stolen_from_holder_activity_id,
       stolen_at = excluded.stolen_at,
       steal_provenance_json = excluded.steal_provenance_json,
       metadata_json = excluded.metadata_json`,
  ).run(
    parsed.key,
    input.holder_activity_id,
    parsed.owner_host,
    parsed.resource_kind,
    parsed.resource_host,
    parsed.resource_path,
    input.acquired_at,
    input.ttl_ms,
    input.renewed_at,
    input.expires_at,
    input.stolen_from_holder_activity_id ?? null,
    input.stolen_at ?? null,
    JSON.stringify(input.steal_provenance ?? {}),
    JSON.stringify(input.metadata ?? {}),
  );
  return readLease(db, parsed.key)!;
}

function withLeaseMutation<T>(db: StateDriverDatabase, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* preserve original error */ }
    throw error;
  }
}

function assertUnreservedLeaseMetadata(metadata: Record<string, unknown> | undefined): void {
  if (metadata && LEASE_RESOURCE_QUARANTINE_METADATA_KEY in metadata) {
    throw new Error(`${LEASE_RESOURCE_QUARANTINE_METADATA_KEY} is reserved for typed run-service resource fencing`);
  }
}

export function readLeaseResourceQuarantine(
  lease: LeaseRow,
): LeaseResourceQuarantine | undefined {
  const value = lease.metadata[LEASE_RESOURCE_QUARANTINE_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["schema_version"] !== "calyx.lease-resource-quarantine/v1"
    || candidate["status"] !== "active"
    || lease.resource_kind !== "worktree"
    || typeof candidate["run_id"] !== "string"
    || candidate["run_id"].length === 0
    || lease.holder_activity_id !== `run:${candidate["run_id"]}`
    || typeof candidate["quarantined_at"] !== "string"
    || !isCanonicalApiTimestamp(candidate["quarantined_at"])
  ) {
    return undefined;
  }
  if (candidate["authority"] === "legacy_process_group_observation") {
    if (
      typeof candidate["owner_free_authority_id"] !== "string"
      || !/^[0-9a-f]{64}$/u.test(candidate["owner_free_authority_id"])
      || typeof candidate["expected_resource_authority_id"] !== "string"
      || !/^[0-9a-f]{64}$/u.test(candidate["expected_resource_authority_id"])
      || typeof candidate["legacy_process_group_id"] !== "number"
      || !Number.isSafeInteger(candidate["legacy_process_group_id"])
      || candidate["legacy_process_group_id"] <= 0
    ) {
      return undefined;
    }
    return candidate as unknown as LeaseResourceQuarantine;
  }
  if (candidate["authority"] === "owner_free_settlement_unproven_backend") {
    if (candidate["reason_code"] !== "backend_resource_extinction_unproven") {
      return undefined;
    }
    return candidate as unknown as LeaseResourceQuarantine;
  }
  return undefined;
}

function hasReservedLeaseResourceQuarantine(lease: LeaseRow): boolean {
  return LEASE_RESOURCE_QUARANTINE_METADATA_KEY in lease.metadata;
}

function isRunHeldWorktreeLease(lease: LeaseRow): boolean {
  return lease.resource_kind === "worktree" && lease.holder_activity_id.startsWith("run:");
}

export function quarantineRunWorktreeLeases(
  db: StateDriverDatabase,
  input: QuarantineRunWorktreeLeasesInput,
): LeaseQuarantineResult {
  return withLeaseMutation(db, "lease_resource_quarantine", () => {
    const runId = normalizeRequired("run_id", input.run_id);
    const ownerFreeAuthorityId = normalizeRequired(
      "owner_free_authority_id",
      input.owner_free_authority_id,
    );
    if (!/^[0-9a-f]{64}$/u.test(ownerFreeAuthorityId)) {
      throw new Error("owner_free_authority_id must be a lowercase SHA-256 digest");
    }
    const expectedResourceAuthorityId = normalizeRequired(
      "expected_resource_authority_id",
      input.expected_resource_authority_id,
    );
    if (!/^[0-9a-f]{64}$/u.test(expectedResourceAuthorityId)) {
      throw new Error("expected_resource_authority_id must be a lowercase SHA-256 digest");
    }
    if (!Number.isSafeInteger(input.legacy_process_group_id) || input.legacy_process_group_id <= 0) {
      throw new Error("legacy_process_group_id must be a positive safe integer");
    }
    if (!isCanonicalApiTimestamp(input.quarantined_at)) {
      throw new Error("quarantined_at must be a canonical UTC ISO timestamp");
    }
    const holder = `run:${runId}`;
    const rows = db.prepare(
      `${SELECT_LEASE} WHERE holder_activity_id = ? AND resource_kind = 'worktree' ORDER BY key ASC`,
    ).all(holder) as RawLeaseRow[];
    const quarantined: LeaseRow[] = [];
    const alreadyQuarantined: LeaseRow[] = [];
    for (const raw of rows) {
      const before = hydrate(raw);
      const existing = readLeaseResourceQuarantine(before);
      if (existing) {
        if (
          existing.authority !== "legacy_process_group_observation"
          || existing.run_id !== runId
          || existing.owner_free_authority_id !== ownerFreeAuthorityId
          || existing.expected_resource_authority_id !== expectedResourceAuthorityId
          || existing.legacy_process_group_id !== input.legacy_process_group_id
        ) {
          throw new Error(`lease ${before.key} carries a conflicting resource quarantine`);
        }
        alreadyQuarantined.push(before);
        continue;
      }
      if (LEASE_RESOURCE_QUARANTINE_METADATA_KEY in before.metadata) {
        throw new Error(`lease ${before.key} carries a malformed resource quarantine`);
      }
      const quarantine: LeaseResourceQuarantine = {
        schema_version: "calyx.lease-resource-quarantine/v1",
        status: "active",
        authority: "legacy_process_group_observation",
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        expected_resource_authority_id: expectedResourceAuthorityId,
        legacy_process_group_id: input.legacy_process_group_id,
        quarantined_at: input.quarantined_at,
      };
      db.prepare("UPDATE leases SET metadata_json = ? WHERE key = ?").run(
        JSON.stringify({
          ...before.metadata,
          [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: quarantine,
        }),
        before.key,
      );
      const after = readLease(db, before.key)!;
      appendLeaseEvent(db, {
        key: before.key,
        event_type: "quarantined",
        occurred_at: input.quarantined_at,
        reason: `legacy-process-group-observation:${input.legacy_process_group_id}`,
        before_lease: before,
        after_lease: after,
        request_provenance: input.request_provenance,
      });
      quarantined.push(after);
    }
    return { quarantined, already_quarantined: alreadyQuarantined };
  });
}

/**
 * POL-1897: fence a run's worktree leases after an owner-free terminal
 * settlement of a current-generation run. The free execution mutex proved the
 * Calyx publisher gone, not the detached backend process group, so the lease
 * must stay quarantined until backend extinction is proven (POL-1990) or an
 * operator explicitly steals it.
 */
export function quarantineOwnerFreeRunWorktreeLeases(
  db: StateDriverDatabase,
  input: QuarantineOwnerFreeRunWorktreeLeasesInput,
): LeaseQuarantineResult {
  return withLeaseMutation(db, "lease_resource_quarantine", () => {
    const runId = normalizeRequired("run_id", input.run_id);
    if (!isCanonicalApiTimestamp(input.quarantined_at)) {
      throw new Error("quarantined_at must be a canonical UTC ISO timestamp");
    }
    const holder = `run:${runId}`;
    const rows = db.prepare(
      `${SELECT_LEASE} WHERE holder_activity_id = ? AND resource_kind = 'worktree' ORDER BY key ASC`,
    ).all(holder) as RawLeaseRow[];
    const quarantined: LeaseRow[] = [];
    const alreadyQuarantined: LeaseRow[] = [];
    for (const raw of rows) {
      const before = hydrate(raw);
      const existing = readLeaseResourceQuarantine(before);
      if (existing) {
        if (
          existing.authority !== "owner_free_settlement_unproven_backend"
          || existing.run_id !== runId
        ) {
          throw new Error(`lease ${before.key} carries a conflicting resource quarantine`);
        }
        alreadyQuarantined.push(before);
        continue;
      }
      if (LEASE_RESOURCE_QUARANTINE_METADATA_KEY in before.metadata) {
        throw new Error(`lease ${before.key} carries a malformed resource quarantine`);
      }
      const quarantine: LeaseResourceQuarantine = {
        schema_version: "calyx.lease-resource-quarantine/v1",
        status: "active",
        authority: "owner_free_settlement_unproven_backend",
        reason_code: "backend_resource_extinction_unproven",
        run_id: runId,
        quarantined_at: input.quarantined_at,
      };
      db.prepare("UPDATE leases SET metadata_json = ? WHERE key = ?").run(
        JSON.stringify({
          ...before.metadata,
          [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: quarantine,
        }),
        before.key,
      );
      const after = readLease(db, before.key)!;
      appendLeaseEvent(db, {
        key: before.key,
        event_type: "quarantined",
        occurred_at: input.quarantined_at,
        reason: "owner-free-settlement:backend-resource-extinction-unproven",
        before_lease: before,
        after_lease: after,
        request_provenance: input.request_provenance,
      });
      quarantined.push(after);
    }
    return { quarantined, already_quarantined: alreadyQuarantined };
  });
}

export function acquireLease(
  db: StateDriverDatabase,
  input: AcquireLeaseInput,
): LeaseAcquireResult {
  return withLeaseMutation(db, "lease_acquire", () => {
    const parsed = parseLeaseKey(input.key, { coordinator_host: input.coordinator_host });
    const holder = normalizeRequired("holder_activity_id", input.holder_activity_id);
    const ttlMs = normalizeTtlMs(input.ttl_ms);
    const timestamp = input.now ?? nowIso();
    const existing = readLease(db, parsed.key);
    assertUnreservedLeaseMetadata(input.metadata);
    const quarantine = existing ? readLeaseResourceQuarantine(existing) : undefined;
    const reservedQuarantine = existing ? hasReservedLeaseResourceQuarantine(existing) : false;
    const expiredRunWorktreeFence = existing
      ? isRunHeldWorktreeLease(existing) && isExpired(existing, timestamp)
      : false;
    if (existing && (reservedQuarantine || expiredRunWorktreeFence)) {
      return {
        acquired: false,
        conflict: {
          kind: "quarantined" as const,
          lease: existing,
          message: quarantine
            ? `lease ${parsed.key} is resource-quarantined for ${quarantine.run_id} until explicit steal or proven resource settlement`
            : reservedQuarantine
              ? `lease ${parsed.key} carries a malformed resource quarantine and requires explicit steal or repair`
              : `expired run-held worktree lease ${parsed.key} remains fenced until terminal reconciliation or explicit steal`,
        },
      };
    }
    if (existing && !isExpired(existing, timestamp) && existing.holder_activity_id !== holder) {
      return {
        acquired: false,
        conflict: {
          kind: "held" as const,
          lease: existing,
          message: `lease ${parsed.key} is held by ${existing.holder_activity_id} until ${existing.expires_at}`,
        },
      };
    }

    const renewed = existing?.holder_activity_id === holder;
    const lease = upsertLease(db, parsed, {
      holder_activity_id: holder,
      acquired_at: renewed ? existing.acquired_at : timestamp,
      ttl_ms: ttlMs,
      renewed_at: renewed ? timestamp : null,
      expires_at: expiresAt(timestamp, ttlMs),
      metadata: input.metadata,
    });
    appendLeaseEvent(db, {
      key: parsed.key,
      event_type: renewed ? "renewed" : "acquired",
      occurred_at: timestamp,
      reason: existing && !renewed ? "expired-replacement" : null,
      before_lease: existing ?? null,
      after_lease: lease,
      request_provenance: input.request_provenance,
    });
    return { acquired: true, lease };
  });
}

export function renewLease(
  db: StateDriverDatabase,
  input: RenewLeaseInput,
): LeaseRenewResult {
  return withLeaseMutation(db, "lease_renew", () => {
  const key = normalizeRequired("key", input.key);
  const holder = normalizeRequired("holder_activity_id", input.holder_activity_id);
  const timestamp = input.now ?? nowIso();
  const existing = readLease(db, key);
  if (!existing) {
    return {
      renewed: false,
      conflict: { kind: "missing", message: `lease ${key} does not exist` },
    };
  }
  if (existing.holder_activity_id !== holder) {
    return {
      renewed: false,
      conflict: {
        kind: "holder-mismatch",
        lease: existing,
        message: `lease ${key} is held by ${existing.holder_activity_id}, not ${holder}`,
      },
    };
  }
  const quarantine = readLeaseResourceQuarantine(existing);
  if (hasReservedLeaseResourceQuarantine(existing)) {
    return {
      renewed: false,
      conflict: {
        kind: "quarantined",
        lease: existing,
        message: quarantine
          ? `lease ${key} is resource-quarantined for ${quarantine.run_id}`
          : `lease ${key} carries a malformed resource quarantine`,
      },
    };
  }
  if (isExpired(existing, timestamp)) {
    return {
      renewed: false,
      conflict: {
        kind: "expired",
        lease: existing,
        message: `lease ${key} expired at ${existing.expires_at}`,
      },
    };
  }
  const ttlMs = normalizeTtlMs(input.ttl_ms ?? existing.ttl_ms);
  db.prepare(
    `UPDATE leases
       SET ttl_ms = ?,
           renewed_at = ?,
           expires_at = ?
     WHERE key = ?`,
  ).run(ttlMs, timestamp, expiresAt(timestamp, ttlMs), key);
  const lease = readLease(db, key)!;
  appendLeaseEvent(db, {
    key,
    event_type: "renewed",
    occurred_at: timestamp,
    reason: null,
    before_lease: existing,
    after_lease: lease,
    request_provenance: input.request_provenance,
  });
  return { renewed: true, lease };
  });
}

export function releaseLease(
  db: StateDriverDatabase,
  input: ReleaseLeaseInput,
): LeaseReleaseResult {
  return withLeaseMutation(db, "lease_release", () => {
  const key = normalizeRequired("key", input.key);
  const existing = readLease(db, key);
  if (!existing) {
    return {
      released: false,
      conflict: { kind: "missing", message: `lease ${key} does not exist` },
    };
  }
  const holder = input.holder_activity_id?.trim();
  if (!input.force && !holder) {
    return {
      released: false,
      lease: existing,
      conflict: {
        kind: "holder-required",
        lease: existing,
        message: `lease ${key} release requires holder_activity_id or force=true`,
      },
    };
  }
  if (!input.force && holder && existing.holder_activity_id !== holder) {
    return {
      released: false,
      lease: existing,
      conflict: {
        kind: "holder-mismatch",
        lease: existing,
        message: `lease ${key} is held by ${existing.holder_activity_id}, not ${holder}`,
      },
    };
  }
  const quarantine = readLeaseResourceQuarantine(existing);
  const expiredRunWorktreeFence = isRunHeldWorktreeLease(existing)
    && isExpired(existing, input.now ?? nowIso());
  if ((hasReservedLeaseResourceQuarantine(existing) || expiredRunWorktreeFence) && !input.force) {
    return {
      released: false,
      lease: existing,
      conflict: {
        kind: "quarantined",
        lease: existing,
        message: quarantine
          ? `lease ${key} is resource-quarantined for ${quarantine.run_id}`
          : hasReservedLeaseResourceQuarantine(existing)
            ? `lease ${key} carries a malformed resource quarantine`
            : `expired run-held worktree lease ${key} requires terminal reconciliation or explicit force release`,
      },
    };
  }
  db.prepare(`DELETE FROM leases WHERE key = ?`).run(key);
  appendLeaseEvent(db, {
    key,
    event_type: "released",
    occurred_at: input.now ?? nowIso(),
    reason: input.force ? "forced" : null,
    before_lease: existing,
    after_lease: null,
    request_provenance: input.request_provenance,
  });
  return { released: true, lease: existing };
  });
}

export function stealLease(
  db: StateDriverDatabase,
  input: StealLeaseInput,
): LeaseStealResult {
  return withLeaseMutation(db, "lease_steal", () => {
  const parsed = parseLeaseKey(input.key, { coordinator_host: input.coordinator_host });
  const holder = normalizeRequired("holder_activity_id", input.holder_activity_id);
    const ttlMs = normalizeTtlMs(input.ttl_ms);
    const timestamp = input.now ?? nowIso();
    const previous = readLease(db, parsed.key);
    assertUnreservedLeaseMetadata(input.metadata);
  const provenance = {
    ...normalizeProvenance(input.provenance),
    stolen_by: holder,
    stolen_at: timestamp,
  };
  const lease = upsertLease(db, parsed, {
    holder_activity_id: holder,
    acquired_at: timestamp,
    ttl_ms: ttlMs,
    renewed_at: null,
    expires_at: expiresAt(timestamp, ttlMs),
    stolen_from_holder_activity_id: previous?.holder_activity_id ?? null,
    stolen_at: previous ? timestamp : null,
    steal_provenance: provenance,
    metadata: input.metadata,
  });
  appendLeaseEvent(db, {
    key: parsed.key,
    event_type: previous ? "stolen" : "acquired",
    occurred_at: timestamp,
    reason: typeof input.provenance === "string"
      ? input.provenance
      : previous ? null : "steal-without-prior",
    before_lease: previous ?? null,
    after_lease: lease,
    request_provenance: input.request_provenance,
  });
  return {
    stolen: true,
    lease,
    ...(previous ? { previous_lease: previous } : {}),
  };
  });
}

export function listLeases(
  db: StateDriverDatabase,
  options: ListLeasesOptions = {},
): LeaseRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.key) {
    clauses.push("key = ?");
    params.push(options.key);
  }
  if (options.holder_activity_id) {
    clauses.push("holder_activity_id = ?");
    params.push(options.holder_activity_id);
  }
  if (options.resource_kind) {
    clauses.push("resource_kind = ?");
    params.push(options.resource_kind);
  }
  if (options.owner_host) {
    clauses.push("owner_host = ?");
    params.push(normalizeHost(options.owner_host));
  }
  if (!options.include_expired) {
    clauses.push("expires_at > ?");
    params.push(options.now ?? nowIso());
  }
  if (options.after_key) {
    clauses.push("key > ?");
    params.push(options.after_key);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = normalizeLimit(options.limit);
  const rows = db
    .prepare(`${SELECT_LEASE}${where} ORDER BY key ASC LIMIT ?`)
    .all(...params, limit) as RawLeaseRow[];
  return rows.map(hydrate);
}

export function countLeases(db: StateDriverDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM leases`).get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function countExpiredLeases(db: StateDriverDatabase, now: string = nowIso()): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM leases WHERE expires_at <= ?`)
    .get(now) as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function releaseLeasesForTerminalRuns(
  db: StateDriverDatabase,
  runIds: readonly string[],
  options: {
    now?: string | undefined;
    request_provenance?: ApiProvenanceV1 | undefined;
  } = {},
): LeaseGcResult {
  const holders = [...new Set(runIds.flatMap((runId) => {
    const trimmed = runId.trim();
    return trimmed ? [trimmed, `run:${trimmed}`] : [];
  }))];
  if (holders.length === 0) {
    return { released: [], release_events: [] };
  }
  const placeholders = holders.map(() => "?").join(",");
  return withLeaseMutation(db, "lease_terminal_gc", () => {
    const timestamp = options.now ?? nowIso();
    const released = (db.prepare(
      `DELETE FROM leases
        WHERE holder_activity_id IN (${placeholders})
          AND CASE
            WHEN json_valid(metadata_json) THEN CASE
              WHEN json_type(metadata_json, '$') = 'object'
                THEN json_type(metadata_json, '$.${LEASE_RESOURCE_QUARANTINE_METADATA_KEY}') IS NULL
              ELSE 0
            END
            ELSE 0
          END
          AND CASE
            WHEN json_valid(steal_provenance_json)
              THEN json_type(steal_provenance_json, '$') = 'object'
            ELSE 0
          END
        RETURNING ${LEASE_COLUMNS}`,
    ).all(...holders) as RawLeaseRow[])
      .map(hydrate)
      .sort((left, right) => Buffer.compare(Buffer.from(left.key, "utf8"), Buffer.from(right.key, "utf8")));
    const releaseEvents = released.map((lease) => (
      appendLeaseEvent(db, {
        key: lease.key,
        event_type: "released",
        occurred_at: timestamp,
        reason: "terminal-run-reconcile",
        before_lease: lease,
        after_lease: null,
        request_provenance: options.request_provenance,
      })
    ));
    return { released, release_events: releaseEvents };
  });
}

export function releaseQuarantinedRunWorktreeLeases(
  db: StateDriverDatabase,
  input: ReleaseQuarantinedRunWorktreeLeasesInput,
): LeaseGcResult {
  return withLeaseMutation(db, "lease_quarantine_terminal_release", () => {
    const runId = normalizeRequired("run_id", input.run_id);
    const ownerFreeAuthorityId = normalizeRequired(
      "owner_free_authority_id",
      input.owner_free_authority_id,
    );
    const resourceAuthorityId = normalizeRequired(
      "resource_authority_id",
      input.resource_authority_id,
    );
    if (!/^[0-9a-f]{64}$/u.test(ownerFreeAuthorityId)) {
      throw new Error("owner_free_authority_id must be a lowercase SHA-256 digest");
    }
    if (!/^[0-9a-f]{64}$/u.test(resourceAuthorityId)) {
      throw new Error("resource_authority_id must be a lowercase SHA-256 digest");
    }
    if (!Number.isSafeInteger(input.legacy_process_group_id) || input.legacy_process_group_id <= 0) {
      throw new Error("legacy_process_group_id must be a positive safe integer");
    }
    const timestamp = input.now ?? nowIso();
    const rows = db.prepare(
      `${SELECT_LEASE} WHERE holder_activity_id = ? AND resource_kind = 'worktree' ORDER BY key ASC`,
    ).all(`run:${runId}`) as RawLeaseRow[];
    const released: LeaseRow[] = [];
    const releaseEvents: LeaseEventRow[] = [];
    for (const raw of rows) {
      const lease = hydrate(raw);
      if (!hasReservedLeaseResourceQuarantine(lease)) continue;
      const quarantine = readLeaseResourceQuarantine(lease);
      if (
        !quarantine
        || quarantine.authority !== "legacy_process_group_observation"
        || quarantine.run_id !== runId
        || quarantine.owner_free_authority_id !== ownerFreeAuthorityId
        || quarantine.expected_resource_authority_id !== resourceAuthorityId
        || quarantine.legacy_process_group_id !== input.legacy_process_group_id
      ) {
        throw new Error(`lease ${lease.key} does not match the proven terminal resource settlement`);
      }
      db.prepare("DELETE FROM leases WHERE key = ?").run(lease.key);
      releaseEvents.push(appendLeaseEvent(db, {
        key: lease.key,
        event_type: "released",
        occurred_at: timestamp,
        reason: `legacy-resource-settlement:${resourceAuthorityId}`,
        before_lease: lease,
        after_lease: null,
        request_provenance: input.request_provenance,
      }));
      released.push(lease);
    }
    return { released, release_events: releaseEvents };
  });
}

export function checkLeaseSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: LeaseSchemaFinding[] } {
  const findings: LeaseSchemaFinding[] = [];
  for (const expected of LEASE_TABLES) {
    const table = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(expected.table) as { name?: string; sql?: string | null } | undefined;
    if (!table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `missing table ${expected.table}`,
      });
      continue;
    }
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${expected.table})`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const column of expected.columns) {
      if (!columns.has(column)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `missing column ${expected.table}.${column}`,
        });
      }
    }
    const indexes = new Set(
      (db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const index of expected.indexes ?? []) {
      if (!indexes.has(index)) {
        findings.push({
          table: expected.table,
          code: "missing-index",
          detail: `missing index ${index}`,
        });
      }
    }
    if (expected.requiredSqlFragments?.length) {
      const liveSql = normalizeSchemaSql(table.sql ?? "");
      if (expected.requiredSqlFragments.some((fragment) => (
        !liveSql.includes(normalizeSchemaSql(fragment))
      ))) {
        findings.push({
          table: expected.table,
          code: "invalid-table-constraint",
          detail: `table ${expected.table} does not carry its canonical constraints`,
        });
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Explicit-doctor exhaustive scan for lease JSON drift. Runtime hydration
 * independently rejects non-object roots; this scan makes the corrupt key and
 * malformed reserved quarantine relation visible without serving the row.
 */
export function listMalformedLeaseMetadata(
  db: StateDriverDatabase,
  limit = 50,
): MalformedLeaseMetadataFinding[] {
  const findings: MalformedLeaseMetadataFinding[] = [];
  const pageSize = 256;
  let afterKey: string | undefined;
  while (findings.length < limit) {
    const rows = db.prepare(
      `${SELECT_LEASE}${afterKey === undefined ? "" : " WHERE key > ?"} ORDER BY key ASC LIMIT ?`,
    ).all(...(afterKey === undefined ? [pageSize] : [afterKey, pageSize])) as RawLeaseRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (findings.length >= limit) break;
      try {
        parseLeaseStealProvenance(row.steal_provenance_json, row.key);
      } catch (error) {
        findings.push({
          key: row.key,
          code: "steal-provenance-not-object",
          detail: error instanceof Error
            ? error.message
            : `lease ${row.key} steal_provenance_json is malformed`,
        });
        continue;
      }
      let metadata: Record<string, unknown>;
      try {
        metadata = parseLeaseMetadata(row.metadata_json, row.key);
      } catch (error) {
        findings.push({
          key: row.key,
          code: "metadata-not-object",
          detail: error instanceof Error ? error.message : `lease ${row.key} metadata_json is malformed`,
        });
        continue;
      }
      if (LEASE_RESOURCE_QUARANTINE_METADATA_KEY in metadata) {
        const lease = { ...hydrate(row), metadata };
        if (!readLeaseResourceQuarantine(lease)) {
          findings.push({
            key: row.key,
            code: "resource-quarantine-malformed",
            detail: `lease ${row.key} carries a malformed or relationally inconsistent ${LEASE_RESOURCE_QUARANTINE_METADATA_KEY}`,
          });
        }
      }
    }
    afterKey = rows.at(-1)!.key;
    if (rows.length < pageSize) break;
  }
  return findings;
}

function normalizeLimit(limit: number | undefined, fallback = 100, max = 1000): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}
