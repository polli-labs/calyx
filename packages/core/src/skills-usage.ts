import type { SkillUsageBackendStatus, SkillUsageResult, SkillUsageRow } from "./types";

export const CALYX_LOKI_ENDPOINT_ENV = "CALYX_LOKI_ENDPOINT";
const DEFAULT_LOKI_ENDPOINT = "http://blade:3100";

export const SKILL_USAGE_CLAUDE_ONLY_NOTE =
  "Counts reflect Claude 'Skill'-tool loads only; Codex injection telemetry is the POL-1834 gap and is not represented.";

/**
 * Operator guidance attached to every non-ok usage result so JSON consumers get
 * the same recovery hints the CLI prints to stderr in text mode. Absent on the
 * `ok` path.
 */
export const SKILL_USAGE_UNAVAILABLE_SUGGESTIONS: readonly string[] = [
  "Loki binds 127.0.0.1:3100 on blade (localhost-only behind Grafana); run on a Loki-reachable host or set CALYX_LOKI_ENDPOINT",
  "verify tailnet/host reachability",
  "pass --endpoint <url> to override",
];

export interface SkillUsageDependencies {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface FetchSkillUsageOptions {
  since: string;
  /**
   * Optional display bound. When omitted the query is UNBOUNDED (no `topk`
   * wrapper) so callers that join against the full usage vector — e.g. the
   * curator — never mistake an un-returned 21st-ranked skill for `use_count: 0`.
   * Only the bounded `skills usage` display command passes a limit.
   */
  limit?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

function envValue(deps: SkillUsageDependencies | undefined, key: string): string | undefined {
  return deps?.env?.[key]?.trim() || process.env[key]?.trim() || undefined;
}

/**
 * Resolve the Loki query endpoint. Precedence: explicit override (opts.endpoint)
 * wins, then CALYX_LOKI_ENDPOINT env, then the default blade endpoint.
 */
export function resolveLokiEndpoint(deps: SkillUsageDependencies & { endpoint?: string } = {}): string {
  const explicit = deps.endpoint?.trim();
  if (explicit) {
    return explicit;
  }
  return envValue(deps, CALYX_LOKI_ENDPOINT_ENV) ?? DEFAULT_LOKI_ENDPOINT;
}

/**
 * Build the LogQL that totals Claude `Skill`-tool loads by skill_name over the
 * requested window. `since` is a Loki range literal (e.g. `7d`, `24h`). When
 * `limit` is a number the series are wrapped in `topk(<limit>, ...)` for a
 * bounded display; when `limit` is `undefined` the query is UNBOUNDED so the
 * caller receives every skill's count (the curator needs the complete vector,
 * otherwise skills ranked below the cut-off look like `use_count: 0`). The inner
 * aggregation is byte-identical in both forms aside from the `topk` wrapper.
 */
export function buildSkillUsageLogQL(since: string, limit?: number): string {
  const inner = [
    "sum by (skill_name) (count_over_time(",
    "{service_name=\"claude-code\"} | json | event_name=`tool_result` | tool_name=`Skill` ",
    "| drop __error__, __error_details__ | line_format `{{.tool_parameters}}` | json ",
    `[${since}]))`,
  ].join("");
  return limit === undefined ? inner : `topk(${limit}, ${inner})`;
}

interface LokiVectorSample {
  metric?: { skill_name?: unknown };
  value?: [unknown, unknown];
}

function parseVectorRows(payload: unknown): SkillUsageRow[] | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { status?: unknown; data?: unknown };
  if (record.status !== "success") {
    return undefined;
  }
  const data = record.data;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const dataRecord = data as { resultType?: unknown; result?: unknown };
  if (dataRecord.resultType !== "vector" || !Array.isArray(dataRecord.result)) {
    return undefined;
  }

  const rows: SkillUsageRow[] = [];
  for (const sample of dataRecord.result as LokiVectorSample[]) {
    const skillName = sample?.metric?.skill_name;
    const rawCount = sample?.value?.[1];
    if (typeof skillName !== "string" || skillName.length === 0) {
      continue;
    }
    const useCount = Number(rawCount);
    if (!Number.isFinite(useCount)) {
      continue;
    }
    rows.push({ skill_name: skillName, use_count: useCount });
  }

  rows.sort((left, right) => right.use_count - left.use_count || left.skill_name.localeCompare(right.skill_name));
  return rows;
}

/**
 * Fetch per-skill load counts from fleet Loki. Read-only and graceful-degrading:
 * it never throws for an unreachable backend, an HTTP error, or a malformed body.
 * On network error -> status "unavailable" with the endpoint + cause; on non-200
 * -> "unavailable" with the status code; on malformed/unsuccessful body ->
 * "degraded". The Claude-only caveat is always present in notes.
 */
export async function fetchSkillUsage(options: FetchSkillUsageOptions): Promise<SkillUsageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = resolveLokiEndpoint({
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  const observedAt = now().toISOString();
  const notes: string[] = [SKILL_USAGE_CLAUDE_ONLY_NOTE];

  const base = (status: SkillUsageBackendStatus, extra: Partial<SkillUsageResult> = {}): SkillUsageResult => ({
    schema_version: "skills.usage/v1",
    status,
    source: "loki",
    endpoint,
    since: options.since,
    // Only present when the query was bounded; absent on the unbounded (curator) path.
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    observed_at: observedAt,
    signal_scope: "claude-only",
    skills: [],
    notes,
    // Non-ok backends carry recovery guidance in-band so JSON consumers see it too.
    ...(status === "ok" ? {} : { suggestions: [...SKILL_USAGE_UNAVAILABLE_SUGGESTIONS] }),
    ...extra,
  });

  const logql = buildSkillUsageLogQL(options.since, options.limit);
  const url = `${endpoint.replace(/\/$/, "")}/loki/api/v1/query?query=${encodeURIComponent(logql)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET" });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return base("unavailable", {
      unavailable_reason: `Loki endpoint ${endpoint} is unreachable: ${cause}`,
    });
  }

  if (!response.ok) {
    return base("unavailable", {
      unavailable_reason: `Loki endpoint ${endpoint} returned HTTP ${response.status} ${response.statusText}`.trim(),
    });
  }

  let payload: unknown;
  try {
    const text = await response.text();
    payload = JSON.parse(text);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return base("degraded", {
      unavailable_reason: `Loki endpoint ${endpoint} returned a non-JSON body: ${cause}`,
      notes: [...notes, "Loki response body was not valid JSON; treating telemetry as degraded."],
    });
  }

  const rows = parseVectorRows(payload);
  if (!rows) {
    return base("degraded", {
      unavailable_reason: `Loki endpoint ${endpoint} returned an unsuccessful or non-vector response`,
      notes: [...notes, "Loki response was not a successful vector result; treating telemetry as degraded."],
    });
  }

  return base("ok", { skills: rows });
}
