import type { StateDriverDatabase } from "./driver";
import { API_REQUEST_AUDIT_TABLES } from "./migrations";
import { validateApiProvenance } from "./provenance";

export const API_REQUEST_AUDIT_OUTCOMES = [
  "admitted",
  "response_completed",
  "response_rejected",
  "indeterminate",
] as const;
export type ApiRequestAuditOutcome = (typeof API_REQUEST_AUDIT_OUTCOMES)[number];

export const API_REQUEST_AUDIT_LIST_MAX_LIMIT = 100;
export const API_REQUEST_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const API_REQUEST_AUDIT_PRUNE_BATCH_SIZE = 500;

export interface ApiRequestAuditRow {
  request_id: string;
  server_instance_id: string;
  operation_id: string;
  subject: string;
  asserted_actor: string | null;
  served_by_host: string;
  via: "http";
  admitted_at: string;
  finalized_at: string | null;
  response_status: number | null;
  error_code: string | null;
  outcome: ApiRequestAuditOutcome;
}

export interface ApiRequestAuditSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index" | "missing-check";
  detail: string;
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function hydrate(row: Record<string, unknown>): ApiRequestAuditRow {
  return {
    request_id: String(row["request_id"]),
    server_instance_id: String(row["server_instance_id"]),
    operation_id: String(row["operation_id"]),
    subject: String(row["subject"]),
    asserted_actor: typeof row["asserted_actor"] === "string" ? row["asserted_actor"] : null,
    served_by_host: String(row["served_by_host"]),
    via: "http",
    admitted_at: String(row["admitted_at"]),
    finalized_at: typeof row["finalized_at"] === "string" ? row["finalized_at"] : null,
    response_status: row["response_status"] === null || row["response_status"] === undefined
      ? null
      : Number(row["response_status"]),
    error_code: typeof row["error_code"] === "string" ? row["error_code"] : null,
    outcome: row["outcome"] as ApiRequestAuditOutcome,
  };
}

export function admitApiRequestAudit(
  db: StateDriverDatabase,
  input: {
    request_id: string;
    server_instance_id: string;
    operation_id: string;
    subject: string;
    asserted_actor?: string | undefined;
    served_by_host: string;
    admitted_at?: string | undefined;
  },
): ApiRequestAuditRow {
  const admittedAt = input.admitted_at ?? new Date().toISOString();
  const provenance = validateApiProvenance({
    schema_version: "calyx.provenance/v1",
    request_id: input.request_id,
    subject: input.subject,
    ...(input.asserted_actor ? { asserted_actor: input.asserted_actor } : {}),
    host: input.served_by_host,
    via: "http",
    at: admittedAt,
  });
  db.prepare(
    `INSERT INTO api_request_audit
       (request_id, server_instance_id, operation_id, subject, asserted_actor, served_by_host, via,
        admitted_at, finalized_at, response_status, error_code, outcome)
     VALUES (?, ?, ?, ?, ?, ?, 'http', ?, NULL, NULL, NULL, 'admitted')`,
  ).run(
    provenance.request_id,
    required("server_instance_id", input.server_instance_id),
    required("operation_id", input.operation_id),
    provenance.subject,
    provenance.asserted_actor ?? null,
    provenance.host,
    provenance.at,
  );
  return readApiRequestAudit(db, provenance.request_id)!;
}

export function readApiRequestAudit(
  db: StateDriverDatabase,
  requestId: string,
): ApiRequestAuditRow | undefined {
  const row = db.prepare(
    `SELECT request_id, server_instance_id, operation_id, subject, asserted_actor, served_by_host,
            via, admitted_at, finalized_at, response_status, error_code, outcome
       FROM api_request_audit
      WHERE request_id = ?`,
  ).get(requestId) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : undefined;
}

export function finalizeApiRequestAudit(
  db: StateDriverDatabase,
  input: {
    request_id: string;
    response_status: number;
    error_code?: string | undefined;
    finalized_at?: string | undefined;
  },
): ApiRequestAuditRow {
  if (!Number.isInteger(input.response_status) || input.response_status < 200 || input.response_status > 599) {
    throw new Error("response_status must be a terminal HTTP status");
  }
  const outcome = input.response_status < 300 ? "response_completed" : "response_rejected";
  const changed = db.prepare(
    `UPDATE api_request_audit
        SET finalized_at = ?, response_status = ?, error_code = ?, outcome = ?
      WHERE request_id = ? AND outcome = 'admitted'`,
  ).run(
    input.finalized_at ?? new Date().toISOString(),
    input.response_status,
    input.error_code?.trim() || null,
    outcome,
    input.request_id,
  ).changes;
  if (Number(changed) !== 1) {
    throw new Error(`request audit ${input.request_id} is missing or already finalized`);
  }
  return readApiRequestAudit(db, input.request_id)!;
}

export function markApiRequestAuditIndeterminate(
  db: StateDriverDatabase,
  requestId: string,
  finalizedAt = new Date().toISOString(),
): boolean {
  const changed = db.prepare(
    `UPDATE api_request_audit
        SET finalized_at = ?, response_status = NULL, error_code = NULL,
            outcome = 'indeterminate'
      WHERE request_id = ? AND outcome = 'admitted'`,
  ).run(finalizedAt, requestId).changes;
  return Number(changed) === 1;
}

export function recoverAdmittedApiRequestAudits(
  db: StateDriverDatabase,
  options: { current_server_instance_id: string; recovered_at?: string | undefined },
): number {
  return Number(db.prepare(
    `UPDATE api_request_audit
        SET finalized_at = ?, outcome = 'indeterminate'
      WHERE outcome = 'admitted' AND server_instance_id <> ?`,
  ).run(options.recovered_at ?? new Date().toISOString(), required("current_server_instance_id", options.current_server_instance_id)).changes);
}

export function pruneApiRequestAudits(
  db: StateDriverDatabase,
  options: { now?: string | undefined; retention_ms?: number | undefined } = {},
): number {
  const now = Date.parse(options.now ?? new Date().toISOString());
  const retentionMs = options.retention_ms ?? API_REQUEST_AUDIT_RETENTION_MS;
  if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error("audit retention requires a valid time and non-negative duration");
  }
  const cutoff = new Date(now - retentionMs).toISOString();
  return Number(db.prepare(
    `DELETE FROM api_request_audit WHERE request_id IN (
       SELECT request_id FROM api_request_audit
        WHERE outcome <> 'admitted'
          AND COALESCE(finalized_at, admitted_at) < ?
        ORDER BY COALESCE(finalized_at, admitted_at) ASC, request_id ASC
        LIMIT ?
     )`,
  ).run(cutoff, API_REQUEST_AUDIT_PRUNE_BATCH_SIZE).changes);
}

export function listApiRequestAudits(
  db: StateDriverDatabase,
  options: {
    limit?: number | undefined;
    outcome?: ApiRequestAuditOutcome | undefined;
    operation_id?: string | undefined;
    snapshot_at?: string | undefined;
    after?: { admitted_at: string; request_id: string } | undefined;
  } = {},
): ApiRequestAuditRow[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), API_REQUEST_AUDIT_LIST_MAX_LIMIT + 1);
  return (db.prepare(
    `SELECT request_id, server_instance_id, operation_id, subject, asserted_actor, served_by_host,
            via, admitted_at, finalized_at, response_status, error_code, outcome
       FROM api_request_audit
      WHERE (? IS NULL OR outcome = ?)
        AND (? IS NULL OR operation_id = ?)
        AND admitted_at <= ?
        AND (
          ? IS NULL
          OR admitted_at < ?
          OR (admitted_at = ? AND request_id > ?)
        )
      ORDER BY admitted_at DESC, request_id ASC
      LIMIT ?`,
  ).all(
    options.outcome ?? null,
    options.outcome ?? null,
    options.operation_id?.trim() || null,
    options.operation_id?.trim() || null,
    options.snapshot_at ?? new Date().toISOString(),
    options.after?.admitted_at ?? null,
    options.after?.admitted_at ?? null,
    options.after?.admitted_at ?? null,
    options.after?.request_id ?? null,
    limit,
  ) as Record<string, unknown>[]).map(hydrate);
}

export function checkApiRequestAuditSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: ApiRequestAuditSchemaFinding[] } {
  const findings: ApiRequestAuditSchemaFinding[] = [];
  for (const expected of API_REQUEST_AUDIT_TABLES) {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(expected.table) as { name?: string } | undefined;
    if (table?.name !== expected.table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columns = (db.prepare(`PRAGMA table_info(${expected.table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    for (const column of expected.columns) {
      if (!columns.includes(column)) findings.push({
        table: expected.table,
        code: "missing-column",
        detail: `expected column "${column}" not present on "${expected.table}"`,
      });
    }
    const indexes = (db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    for (const index of expected.indexes ?? []) {
      if (!indexes.includes(index)) findings.push({
        table: expected.table,
        code: "missing-index",
        detail: `expected index "${index}" not present on "${expected.table}"`,
      });
    }
  }
  if (!findings.some((finding) => finding.table === "api_request_audit" && finding.code !== "missing-index")) {
    const invalidRows = [
      { label: "via", via: "tcp", outcome: "admitted", finalized: null, status: null },
      { label: "admitted-shape", via: "http", outcome: "admitted", finalized: "2026-01-01T00:00:00.000Z", status: null },
      { label: "completed-status", via: "http", outcome: "response_completed", finalized: "2026-01-01T00:00:00.000Z", status: 302 },
      { label: "rejected-status", via: "http", outcome: "response_rejected", finalized: "2026-01-01T00:00:00.000Z", status: 200 },
      { label: "indeterminate-shape", via: "http", outcome: "indeterminate", finalized: null, status: null },
    ] as const;
    db.exec("SAVEPOINT api_request_audit_check");
    try {
      for (const invalid of invalidRows) {
        let rejected = false;
        try {
          db.prepare(
            `INSERT INTO api_request_audit
               (request_id, server_instance_id, operation_id, subject, asserted_actor,
                served_by_host, via, admitted_at, finalized_at, response_status,
                error_code, outcome)
             VALUES (?, 'doctor', 'doctor.check', 'doctor', NULL, 'doctor', ?,
                     '2026-01-01T00:00:00.000Z', ?, ?, NULL, ?)`,
          ).run(`doctor-invalid-${invalid.label}`, invalid.via, invalid.finalized, invalid.status, invalid.outcome);
        } catch {
          rejected = true;
        }
        if (!rejected) findings.push({
          table: "api_request_audit",
          code: "missing-check",
          detail: `api_request_audit accepted invalid ${invalid.label} row`,
        });
      }
    } finally {
      db.exec("ROLLBACK TO api_request_audit_check; RELEASE api_request_audit_check");
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}

export function apiRequestAuditDoctor(db: StateDriverDatabase): {
  schema_status: "ok" | "drift";
  findings: ApiRequestAuditSchemaFinding[];
  retained: number;
  counts: Record<ApiRequestAuditOutcome, number>;
  retention_ms: number;
} {
  const schema = checkApiRequestAuditSchema(db);
  const counts = Object.fromEntries(API_REQUEST_AUDIT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ApiRequestAuditOutcome, number>;
  if (schema.status === "drift") {
    return { schema_status: schema.status, findings: schema.findings, retained: 0, counts, retention_ms: API_REQUEST_AUDIT_RETENTION_MS };
  }
  let retained = 0;
  for (const row of db.prepare(
    `SELECT outcome, COUNT(*) AS count FROM api_request_audit GROUP BY outcome`,
  ).all() as Array<{ outcome: ApiRequestAuditOutcome; count: number | bigint }>) {
    if ((API_REQUEST_AUDIT_OUTCOMES as readonly string[]).includes(row.outcome)) {
      counts[row.outcome] = Number(row.count);
      retained += Number(row.count);
    }
  }
  return {
    schema_status: schema.status,
    findings: schema.findings,
    retained,
    counts,
    retention_ms: API_REQUEST_AUDIT_RETENTION_MS,
  };
}
