import { describe, expect, test } from "vitest";
import {
  buildSkillUsageLogQL,
  fetchSkillUsage,
  resolveLokiEndpoint,
  SKILL_USAGE_CLAUDE_ONLY_NOTE,
} from "../skills-usage";

const FIXED_NOW = () => new Date("2026-06-21T00:00:00.000Z");

// Loki returns the per-series count as a STRING in vector results (the second
// element of `value`); the fixture mirrors that and the parser Number()-coerces it.
function vectorResponse(samples: Array<{ skill: string; count: string }>): Response {
  const body = {
    status: "success",
    data: {
      resultType: "vector",
      result: samples.map((sample) => ({
        metric: { skill_name: sample.skill },
        value: [1718000000, sample.count],
      })),
    },
  };
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("resolveLokiEndpoint", () => {
  test("explicit endpoint wins over env and default", () => {
    expect(
      resolveLokiEndpoint({ endpoint: "http://explicit:3100", env: { CALYX_LOKI_ENDPOINT: "http://env:3100" } }),
    ).toBe("http://explicit:3100");
  });

  test("env wins over default when no explicit override", () => {
    expect(resolveLokiEndpoint({ env: { CALYX_LOKI_ENDPOINT: "http://env-loki:3100" } })).toBe("http://env-loki:3100");
  });

  test("falls back to the blade default", () => {
    expect(resolveLokiEndpoint({ env: {} })).toBe("http://blade:3100");
  });
});

describe("buildSkillUsageLogQL", () => {
  test("substitutes limit and window and targets the Skill tool", () => {
    const logql = buildSkillUsageLogQL("7d", 20);
    expect(logql).toContain("topk(20,");
    expect(logql).toContain("[7d]");
    expect(logql).toContain('service_name="claude-code"');
    expect(logql).toContain("tool_name=`Skill`");
    expect(logql).toContain("count_over_time");
  });

  test("OMITS topk when no limit is given (the curator needs the complete usage vector)", () => {
    // Regression guard for the top-N truncation bug: an unbounded query must not
    // cap the returned series, or skills ranked below the cut-off look unused.
    const logql = buildSkillUsageLogQL("7d");
    expect(logql).not.toContain("topk");
    expect(logql).toContain("sum by (skill_name)");
    expect(logql).toContain("[7d]");
    expect(logql).toContain("count_over_time");
  });

  test("the inner aggregation is byte-identical aside from the topk wrapper", () => {
    const unbounded = buildSkillUsageLogQL("7d");
    const bounded = buildSkillUsageLogQL("7d", 20);
    expect(bounded).toBe(`topk(20, ${unbounded})`);
  });
});

describe("fetchSkillUsage", () => {
  test("(a) healthy vector response -> parsed rows sorted desc by use_count", async () => {
    const fetchImpl = (async () =>
      vectorResponse([
        { skill: "low-skill", count: "3" },
        { skill: "high-skill", count: "9" },
        { skill: "mid-skill", count: "5" },
      ])) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("loki");
    expect(result.signal_scope).toBe("claude-only");
    expect(result.schema_version).toBe("skills.usage/v1");
    expect(result.skills.map((row) => row.skill_name)).toEqual(["high-skill", "mid-skill", "low-skill"]);
    expect(result.skills.map((row) => row.use_count)).toEqual([9, 5, 3]);
    expect(result.notes).toContain(SKILL_USAGE_CLAUDE_ONLY_NOTE);
    expect(result.unavailable_reason).toBeUndefined();
  });

  test("(b) empty vector result -> status ok with no skills", async () => {
    const fetchImpl = (async () => vectorResponse([])) as unknown as typeof fetch;
    const result = await fetchSkillUsage({ since: "24h", limit: 5, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("ok");
    expect(result.skills).toEqual([]);
    expect(result.since).toBe("24h");
    expect(result.limit).toBe(5);
    expect(result.notes).toContain(SKILL_USAGE_CLAUDE_ONLY_NOTE);
  });

  test("(b2) no limit -> result.limit is undefined and the issued query carries no topk", async () => {
    // The curator path passes no limit; assert both the result shape (no `limit`
    // key) and that the URL actually sent to Loki is the UNBOUNDED query. This
    // would fail under the old behavior that always wrapped the series in topk.
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return vectorResponse([{ skill: "any-skill", count: "1" }]);
    }) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("ok");
    expect(result.limit).toBeUndefined();
    expect(decodeURIComponent(capturedUrl)).not.toContain("topk");
    expect(decodeURIComponent(capturedUrl)).toContain("sum by (skill_name)");
  });

  test("(c) fetch throws (ECONNREFUSED) -> unavailable with endpoint + cause", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
    }) as unknown as typeof fetch;

    const result = await fetchSkillUsage({
      since: "7d",
      limit: 20,
      endpoint: "http://blade:3100",
      fetchImpl,
      now: FIXED_NOW,
    });

    expect(result.status).toBe("unavailable");
    expect(result.skills).toEqual([]);
    expect(result.unavailable_reason).toContain("http://blade:3100");
    expect(result.unavailable_reason).toContain("ECONNREFUSED");
    expect(result.notes).toContain(SKILL_USAGE_CLAUDE_ONLY_NOTE);
  });

  test("(d) HTTP 500 -> unavailable with status code", async () => {
    const fetchImpl = (async () =>
      new Response("upstream boom", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("unavailable");
    expect(result.skills).toEqual([]);
    expect(result.unavailable_reason).toContain("500");
  });

  test("(e1) malformed JSON body -> degraded", async () => {
    const fetchImpl = (async () => new Response("{not-json", { status: 200 })) as unknown as typeof fetch;
    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("degraded");
    expect(result.skills).toEqual([]);
    expect(result.notes).toContain(SKILL_USAGE_CLAUDE_ONLY_NOTE);
  });

  test("(e2) status:error body -> degraded", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: "error", error: "parse error" }), { status: 200 })) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("degraded");
    expect(result.skills).toEqual([]);
  });

  test("(f1) data.result is a non-array scalar -> degraded, not thrown", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ status: "success", data: { resultType: "vector", result: 42 } }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("degraded");
    expect(result.skills).toEqual([]);
  });

  test("(f2) a sample missing metric.skill_name is skipped, not thrown", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              { metric: {}, value: [1718000000, "7"] },
              { metric: { skill_name: "kept-skill" }, value: [1718000000, "3"] },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("ok");
    expect(result.skills.map((row) => row.skill_name)).toEqual(["kept-skill"]);
  });

  test("(f3) a sample whose count is missing or non-numeric is filtered out, not thrown", async () => {
    // Missing `value` (no count at all) and a non-numeric string both coerce to a
    // non-finite number and are dropped; the well-formed row survives.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [
              { metric: { skill_name: "no-value" } },
              { metric: { skill_name: "junk-count" }, value: [1718000000, "not-a-number"] },
              { metric: { skill_name: "good-count" }, value: [1718000000, "8"] },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await fetchSkillUsage({ since: "7d", limit: 20, fetchImpl, now: FIXED_NOW });

    expect(result.status).toBe("ok");
    expect(result.skills.map((row) => row.skill_name)).toEqual(["good-count"]);
    expect(result.skills.map((row) => row.use_count)).toEqual([8]);
  });
});
