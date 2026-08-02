import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeCuratorReport, DUPLICATE_DETECTION_SKIPPED_NOTE, summarizeCuratorStatus } from "../skills-curator";
import type { CuratorRegistryInput } from "../skills-curator";
import type { SkillUsageBackendStatus, SkillUsageResult } from "../types";

const FIXED_NOW = () => new Date("2026-06-21T00:00:00.000Z");

function fixtureRegistry(): CuratorRegistryInput {
  return {
    path: "/tmp/fixture/SOURCES.json",
    version: "test-2026",
    skills: [
      { id: "alpha-internal", source: { type: "internal", repo: "polli-labs/agents-infra", path: "a/SKILL.md" } },
      { id: "beta-external", source: { type: "external", repo: "https://github.com/x/y", path: "b/SKILL.md", ref: "abc" } },
      { id: "gamma-repo", source: { type: "repo-maintained", repo: "polli-labs/calyx-dev", path: "g/SKILL.md" } },
      {
        id: "delta-deprecated",
        status: "deprecated",
        deprecated_by: "alpha-internal",
        source: { type: "internal", repo: "polli-labs/agents-infra", path: "d/SKILL.md" },
      },
      { id: "epsilon-weird", source: { type: "mystery", path: "e/SKILL.md" } },
      {
        // Deprecated but STILL being loaded: must not be flagged archive-candidate
        // (proves the `&& useCount === 0` half of the archive rule).
        id: "zeta-deprecated-active",
        status: "deprecated",
        deprecated_by: "alpha-internal",
        source: { type: "internal", repo: "polli-labs/agents-infra", path: "z/SKILL.md" },
      },
    ],
  };
}

function usageResult(
  status: SkillUsageBackendStatus,
  rows: Array<{ skill_name: string; use_count: number }>,
  extra: Partial<SkillUsageResult> = {},
): SkillUsageResult {
  return {
    schema_version: "skills.usage/v1",
    status,
    source: "loki",
    endpoint: "http://blade:3100",
    since: "7d",
    limit: 20,
    observed_at: "2026-06-21T00:00:00.000Z",
    signal_scope: "claude-only",
    skills: rows,
    notes: ["Counts reflect Claude 'Skill'-tool loads only; Codex injection telemetry is the POL-1834 gap and is not represented."],
    ...extra,
  };
}

describe("computeCuratorReport", () => {
  test("fires low-signal and archive-candidate rules with a working sensor", () => {
    const usage = usageResult("ok", [
      { skill_name: "alpha-internal", use_count: 5 },
      { skill_name: "gamma-repo", use_count: 2 },
      { skill_name: "zeta-deprecated-active", use_count: 4 },
    ]);

    const report = computeCuratorReport({ registry: fixtureRegistry(), usage, now: FIXED_NOW });

    expect(report.schema_version).toBe("skills.curator-report/v1");
    expect(report.mode).toBe("dry-run");
    expect(report.total_skills).toBe(6);

    const byId = new Map(report.recommendations.map((r) => [r.skill_id, r]));
    // alpha (5) + gamma (2) have signal -> no rec.
    expect(byId.has("alpha-internal")).toBe(false);
    expect(byId.has("gamma-repo")).toBe(false);
    // beta active + 0 loads -> low-signal.
    expect(byId.get("beta-external")?.action).toBe("low-signal");
    expect(byId.get("beta-external")?.provenance_class).toBe("vendored");
    expect(byId.get("beta-external")?.signal_basis).toBe("claude-only");
    // delta deprecated + 0 loads -> archive-candidate, and NOT low-signal
    // (the deprecated rule takes priority over the zero-load low-signal rule).
    expect(byId.get("delta-deprecated")?.action).toBe("archive-candidate");
    expect(byId.get("delta-deprecated")?.action).not.toBe("low-signal");
    expect(byId.get("delta-deprecated")?.current_status).toBe("deprecated");
    // zeta deprecated but STILL loaded (4) -> no rec at all (proves `&& useCount === 0`).
    expect(byId.has("zeta-deprecated-active")).toBe(false);
    // epsilon unknown source type -> low-signal, no provenance_class.
    expect(byId.get("epsilon-weird")?.action).toBe("low-signal");
    expect(byId.get("epsilon-weird")?.provenance_class).toBeUndefined();

    expect(report.summary["low-signal"]).toBe(2);
    expect(report.summary["archive-candidate"]).toBe(1);
    expect(report.summary["duplicate-candidate"]).toBe(0);
  });

  test("a used skill present in the full vector is NOT flagged low-signal (top-N truncation regression)", () => {
    // Models the post-fix world where the curator joins against the COMPLETE
    // usage vector. `gamma-repo` carries a nonzero count, so it must earn no
    // recommendation. Under the old bug the curator queried `topk(20, ...)`; a
    // skill ranked 21st+ would be absent from `usage.skills`, default to
    // use_count 0, and be wrongly flagged low-signal. Here gamma is present with
    // use_count > 0, which is exactly what a complete (un-truncated) vector
    // guarantees — so a regression to bounded querying would drop it and flip
    // this assertion to a false low-signal.
    const usage = usageResult("ok", [{ skill_name: "gamma-repo", use_count: 1 }]);
    const report = computeCuratorReport({ registry: fixtureRegistry(), usage, now: FIXED_NOW });

    const byId = new Map(report.recommendations.map((r) => [r.skill_id, r]));
    expect(byId.has("gamma-repo")).toBe(false);
    // Sanity: a genuinely 0-load active skill (beta) is still flagged, so the
    // absence above is the count, not a disabled rule.
    expect(byId.get("beta-external")?.action).toBe("low-signal");
  });

  test("provenance_breakdown is correct", () => {
    const report = computeCuratorReport({
      registry: fixtureRegistry(),
      usage: usageResult("ok", []),
      now: FIXED_NOW,
    });
    expect(report.provenance_breakdown).toEqual({
      "repo-managed": 3,
      vendored: 1,
      "repo-maintained": 1,
      unclassified: 1,
    });
  });

  test("unavailable usage backend suppresses usage-grounded recs and adds the note", () => {
    const usage = usageResult("unavailable", [], { unavailable_reason: "Loki endpoint http://blade:3100 is unreachable" });
    const report = computeCuratorReport({ registry: fixtureRegistry(), usage, now: FIXED_NOW });

    expect(report.recommendations).toEqual([]);
    expect(report.usage_backend.status).toBe("unavailable");
    expect(report.notes[0]).toBe(
      "Usage backend unavailable; usage-grounded recommendations suppressed. Provenance + lifecycle breakdown only.",
    );
    // Provenance breakdown is still produced even when blind.
    expect(report.provenance_breakdown["repo-managed"]).toBe(3);
    expect(report.usage_backend.codex_gap).toContain("POL-1834");
  });

  test("degraded usage backend also suppresses recs (blind sensor never drives an actuator)", () => {
    const usage = usageResult("degraded", []);
    const report = computeCuratorReport({ registry: fixtureRegistry(), usage, now: FIXED_NOW });
    expect(report.recommendations).toEqual([]);
    expect(report.notes[0]).toContain("usage-grounded recommendations suppressed");
  });

  test("notes the skipped duplicate detection with the exact constant text", () => {
    const report = computeCuratorReport({ registry: fixtureRegistry(), usage: usageResult("ok", []), now: FIXED_NOW });
    expect(report.notes).toContain(DUPLICATE_DETECTION_SKIPPED_NOTE);
  });

  test("computeCuratorReport stays pure: returns data with no store/path handle in its input", () => {
    // Slice 3 adds the APPLY mechanics (`applyCuratorReport`) to this module,
    // which DO touch the state store — but only through an injected `db` handle.
    // The report/status functions remain pure: they take only the registry +
    // usage and return data. Assert that behaviorally here.
    const report = computeCuratorReport({ registry: fixtureRegistry(), usage: usageResult("ok", []), now: FIXED_NOW });
    expect(report).toMatchObject({ mode: "dry-run", schema_version: "skills.curator-report/v1" });
  });

  test("the curator module never OPENS the state store itself (db is always injected)", async () => {
    // Safety invariant that survives Slice 3: the apply path receives the store
    // via dependency injection (the caller opens + closes it). The module must
    // never call openStateStore / mkdir / writeFile on its own.
    const source = await readFile(path.join(__dirname, "..", "skills-curator.ts"), "utf8");
    expect(source).not.toMatch(/openStateStore\(/);
    expect(source).not.toMatch(/\bmkdir\b|\bwriteFile\b/);
  });
});

describe("summarizeCuratorStatus", () => {
  test("reports registry size, provenance + lifecycle breakdown, and backend status", () => {
    const status = summarizeCuratorStatus({
      registry: fixtureRegistry(),
      usage: usageResult("ok", []),
      endpoint: "http://blade:3100",
      now: FIXED_NOW,
    });

    expect(status.schema_version).toBe("skills.curator-status/v1");
    expect(status.total_skills).toBe(6);
    expect(status.provenance_breakdown).toEqual({
      "repo-managed": 3,
      vendored: 1,
      "repo-maintained": 1,
      unclassified: 1,
    });
    expect(status.lifecycle_breakdown).toEqual({ active: 4, deprecated: 2 });
    expect(status.usage_backend.status).toBe("ok");
    expect(status.usage_backend.endpoint).toBe("http://blade:3100");
    expect(status.usage_backend.signal_scope).toBe("claude-only");
  });

  test("surfaces the unavailable reason in notes when the backend is down", () => {
    const status = summarizeCuratorStatus({
      registry: fixtureRegistry(),
      usage: usageResult("unavailable", [], { unavailable_reason: "Loki endpoint http://blade:3100 is unreachable" }),
      endpoint: "http://blade:3100",
      now: FIXED_NOW,
    });
    expect(status.notes.some((n) => n.includes("unreachable"))).toBe(true);
  });
});
