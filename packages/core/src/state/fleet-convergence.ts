import type { StateDriverDatabase } from "./driver";
import { FLEET_CONVERGENCE_TABLES } from "./migrations";

export const FLEET_CONVERGENCE_LEGS = [
  "daemon_build",
  "skills",
  "instructions",
] as const;
export type FleetConvergenceLeg = (typeof FLEET_CONVERGENCE_LEGS)[number];

export const FLEET_CONVERGENCE_POLICIES = [
  "auto",
  "windowed",
  "operator_gated",
] as const;
export type FleetConvergencePolicy = (typeof FLEET_CONVERGENCE_POLICIES)[number];

export const FLEET_CONVERGENCE_VERDICTS = [
  "fresh",
  "pending",
  "structural",
] as const;
export type FleetConvergenceVerdict = (typeof FLEET_CONVERGENCE_VERDICTS)[number];

export interface FleetConvergenceRow {
  host: string;
  leg: FleetConvergenceLeg;
  target_rev: string | null;
  observed_rev: string | null;
  converged_from: string;
  policy: FleetConvergencePolicy;
  last_checked_at: string;
  verdict: FleetConvergenceVerdict;
  receipt_path: string | null;
  receipt_id: string | null;
  detail: string | null;
  payload: unknown;
}

export interface UpsertFleetConvergenceRowInput {
  host: string;
  leg: FleetConvergenceLeg;
  target_rev: string | null;
  observed_rev?: string | null | undefined;
  converged_from: string;
  policy: FleetConvergencePolicy;
  last_checked_at: string;
  verdict: FleetConvergenceVerdict;
  receipt_path?: string | null | undefined;
  receipt_id?: string | null | undefined;
  detail?: string | null | undefined;
  payload?: unknown;
}

export interface ListFleetConvergenceRowsOptions {
  host?: string | undefined;
  leg?: FleetConvergenceLeg | undefined;
}

interface RawFleetConvergenceRow {
  host: string;
  leg: string;
  target_rev: string | null;
  observed_rev: string | null;
  converged_from: string;
  policy: string;
  last_checked_at: string;
  verdict: string;
  receipt_path: string | null;
  receipt_id: string | null;
  detail: string | null;
  payload_json: string;
}

export interface FleetConvergenceSchemaFinding {
  table: string;
  code: "missing-table" | "missing-column" | "missing-index";
  detail: string;
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hydrate(row: RawFleetConvergenceRow): FleetConvergenceRow {
  return {
    host: row.host,
    leg: row.leg as FleetConvergenceLeg,
    target_rev: row.target_rev,
    observed_rev: row.observed_rev,
    converged_from: row.converged_from,
    policy: row.policy as FleetConvergencePolicy,
    last_checked_at: row.last_checked_at,
    verdict: row.verdict as FleetConvergenceVerdict,
    receipt_path: row.receipt_path,
    receipt_id: row.receipt_id,
    detail: row.detail,
    payload: parsePayload(row.payload_json),
  };
}

function assertInSet<T extends string>(
  label: string,
  value: string,
  allowed: readonly T[],
): asserts value is T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeRequired(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return trimmed;
}

function normalizeGitShaOrNull(label: string, value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = normalizeRequired(label, value);
  if (!/^[0-9a-f]{40}$/i.test(trimmed)) {
    throw new Error(`${label} must be a full git SHA or null`);
  }
  return trimmed;
}

function normalizeGitSha(label: string, value: string): string {
  return normalizeGitShaOrNull(label, value) ?? "";
}

const SELECT_FLEET_CONVERGENCE = `SELECT
  host, leg, target_rev, observed_rev, converged_from, policy,
  last_checked_at, verdict, receipt_path, receipt_id, detail, payload_json
FROM fleet_convergence`;

export function upsertFleetConvergenceRow(
  db: StateDriverDatabase,
  input: UpsertFleetConvergenceRowInput,
): FleetConvergenceRow {
  const host = normalizeRequired("host", input.host);
  const leg = normalizeRequired("leg", input.leg);
  const targetRev = normalizeGitShaOrNull("target_rev", input.target_rev);
  const convergedFrom = normalizeGitSha("converged_from", input.converged_from);
  const policy = normalizeRequired("policy", input.policy);
  const verdict = normalizeRequired("verdict", input.verdict);
  assertInSet("leg", leg, FLEET_CONVERGENCE_LEGS);
  assertInSet("policy", policy, FLEET_CONVERGENCE_POLICIES);
  assertInSet("verdict", verdict, FLEET_CONVERGENCE_VERDICTS);

  db.prepare(
    `INSERT INTO fleet_convergence
       (host, leg, target_rev, observed_rev, converged_from, policy,
        last_checked_at, verdict, receipt_path, receipt_id, detail, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, leg) DO UPDATE SET
       target_rev = excluded.target_rev,
       observed_rev = excluded.observed_rev,
       converged_from = excluded.converged_from,
       policy = excluded.policy,
       last_checked_at = excluded.last_checked_at,
       verdict = excluded.verdict,
       receipt_path = COALESCE(excluded.receipt_path, fleet_convergence.receipt_path),
       receipt_id = COALESCE(excluded.receipt_id, fleet_convergence.receipt_id),
       detail = excluded.detail,
       payload_json = excluded.payload_json`,
  ).run(
    host,
    leg,
    targetRev,
    input.observed_rev ?? null,
    convergedFrom,
    policy,
    normalizeRequired("last_checked_at", input.last_checked_at),
    verdict,
    input.receipt_path ?? null,
    input.receipt_id ?? null,
    input.detail ?? null,
    JSON.stringify(input.payload ?? {}),
  );
  return readFleetConvergenceRow(db, host, leg) ?? hydrate({
    host,
    leg,
    target_rev: targetRev,
    observed_rev: input.observed_rev ?? null,
    converged_from: convergedFrom,
    policy,
    last_checked_at: input.last_checked_at,
    verdict,
    receipt_path: input.receipt_path ?? null,
    receipt_id: input.receipt_id ?? null,
    detail: input.detail ?? null,
    payload_json: JSON.stringify(input.payload ?? {}),
  });
}

export function readFleetConvergenceRow(
  db: StateDriverDatabase,
  host: string,
  leg: FleetConvergenceLeg,
): FleetConvergenceRow | undefined {
  const row = db
    .prepare(`${SELECT_FLEET_CONVERGENCE} WHERE host = ? AND leg = ?`)
    .get(host, leg) as RawFleetConvergenceRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function listFleetConvergenceRows(
  db: StateDriverDatabase,
  options: ListFleetConvergenceRowsOptions = {},
): FleetConvergenceRow[] {
  if (options.host && options.leg) {
    const row = readFleetConvergenceRow(db, options.host, options.leg);
    return row ? [row] : [];
  }
  if (options.host) {
    return (db
      .prepare(`${SELECT_FLEET_CONVERGENCE} WHERE host = ? ORDER BY host ASC, leg ASC`)
      .all(options.host) as RawFleetConvergenceRow[]).map(hydrate);
  }
  if (options.leg) {
    return (db
      .prepare(`${SELECT_FLEET_CONVERGENCE} WHERE leg = ? ORDER BY host ASC, leg ASC`)
      .all(options.leg) as RawFleetConvergenceRow[]).map(hydrate);
  }
  return (db
    .prepare(`${SELECT_FLEET_CONVERGENCE} ORDER BY host ASC, leg ASC`)
    .all() as RawFleetConvergenceRow[]).map(hydrate);
}

export function countFleetConvergenceRows(db: StateDriverDatabase): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM fleet_convergence`)
    .get() as { n: number | bigint } | undefined;
  if (!row) return 0;
  return typeof row.n === "bigint" ? Number(row.n) : row.n;
}

export function checkFleetConvergenceSchema(
  db: StateDriverDatabase,
): { status: "ok" | "drift"; findings: FleetConvergenceSchemaFinding[] } {
  const findings: FleetConvergenceSchemaFinding[] = [];
  for (const expected of FLEET_CONVERGENCE_TABLES) {
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(expected.table) as { name?: string } | undefined;
    if (!tableRow || tableRow.name !== expected.table) {
      findings.push({
        table: expected.table,
        code: "missing-table",
        detail: `expected table "${expected.table}" not present in schema`,
      });
      continue;
    }
    const columns = (db
      .prepare(`PRAGMA table_info(${expected.table})`)
      .all() as Array<{ name: string }>)
      .map((column) => column.name);
    for (const required of expected.columns) {
      if (!columns.includes(required)) {
        findings.push({
          table: expected.table,
          code: "missing-column",
          detail: `expected column "${required}" not present on "${expected.table}"`,
        });
      }
    }
    if (expected.indexes && expected.indexes.length > 0) {
      const indexes = (db
        .prepare(`PRAGMA index_list(${expected.table})`)
        .all() as Array<{ name: string }>)
        .map((index) => index.name);
      for (const index of expected.indexes) {
        if (!indexes.includes(index)) {
          findings.push({
            table: expected.table,
            code: "missing-index",
            detail: `expected index "${index}" not present on "${expected.table}"`,
          });
        }
      }
    }
  }
  return { status: findings.length === 0 ? "ok" : "drift", findings };
}
