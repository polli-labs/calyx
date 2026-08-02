import { describe, expect, test } from "vitest";

import type { CalyxAdminHealth } from "@polli-labs/calyx-core";

import {
  appliedStateSchemaId,
  formatStateSchemaConvergence,
  renderSelfHealthText,
  type SelfHealthResult,
} from "../self-health.js";

const NOW = new Date("2026-07-27T00:00:00.000Z");

function health(overrides: Partial<CalyxAdminHealth> = {}): CalyxAdminHealth {
  return {
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: 1,
    daemon_kind: "run-service",
    daemon_id: "run-serve",
    uptime_ms: 3_600_000,
    started_at: "2026-07-26T23:00:00.000Z",
    build: {
      git_head: "75eaa70338ea9e2245788df4fa0648748c8e8794",
      built_at: "2026-07-26T23:00:00.000Z",
      package_version: "0.2.0",
    },
    active_runs: 0,
    maintenance_mode: false,
    supports_features: [],
    ...overrides,
  } as CalyxAdminHealth;
}

function hostResult(
  host: string,
  stateSchema: NonNullable<CalyxAdminHealth["state_schema"]>,
): SelfHealthResult {
  return { host, ok: true, health: health({ state_schema: stateSchema }) };
}

describe("self health state-schema surfacing", () => {
  test("the measured fleet spread is one readable line", () => {
    // The 2026-07-27 fleet: four hosts, four versions, nothing reporting it.
    const text = renderSelfHealthText(
      [
        hostResult("blade", { status: "current", current: "0024", target: "0024", pending: 0 }),
        hostResult("carbon", { status: "current", current: "0030", target: "0030", pending: 0 }),
        hostResult("mba", { status: "current", current: "0019", target: "0019", pending: 0 }),
        hostResult("worm", { status: "ahead", current: "0034", target: "0018", pending: 0 }),
      ],
      NOW,
      true,
    );

    expect(text).toContain(
      "state schema: 4 versions across 4 hosts - 0019 (mba), 0024 (blade), 0030 (carbon), 0034 (worm)",
    );
    // Per-host cells carry the same fact at row granularity.
    expect(text).toMatch(/^blade \|.*\| 0024 \|/m);
    expect(text).toMatch(/^worm \|.*\| 0034 ahead 0018 \|/m);
    expect(text.split("\n")[0]).toContain("state_schema");
  });

  test("a converged fleet says so instead of listing four identical cells", () => {
    const text = renderSelfHealthText(
      [
        hostResult("blade", { status: "current", current: "0034", target: "0034", pending: 0 }),
        hostResult("worm", { status: "current", current: "0034", target: "0034", pending: 0 }),
      ],
      NOW,
      true,
    );
    expect(text).toContain("state schema: converged at 0034 across 2 hosts.");
  });

  test("a daemon predating the field is unknown, never assumed converged", () => {
    const text = renderSelfHealthText(
      [
        hostResult("blade", { status: "current", current: "0034", target: "0034", pending: 0 }),
        // No state_schema at all: a pre-POL-2090 daemon.
        { host: "mba", ok: true, health: health() },
        { host: "worm", ok: false, error: { kind: "unreachable", message: "ECONNREFUSED" } },
      ],
      NOW,
      true,
    );
    expect(text).toContain("state schema: 2 versions across 3 hosts - 0034 (blade), unknown (mba, worm)");
    expect(text).toMatch(/^mba \|.*\| unknown \|/m);
  });

  test("a single host prints no convergence line", () => {
    const text = renderSelfHealthText(
      [hostResult("blade", { status: "current", current: "0034", target: "0034", pending: 0 })],
      NOW,
      false,
    );
    expect(text).not.toContain("state schema:");
  });

  test("appliedStateSchemaId refuses to report a ledger the daemon could not read", () => {
    expect(appliedStateSchemaId(
      hostResult("blade", { status: "unavailable" }),
    )).toBeNull();
    expect(appliedStateSchemaId(
      hostResult("blade", { status: "behind", current: "0019", target: "0034", pending: 15 }),
    )).toBe("0019");
    expect(appliedStateSchemaId(
      { host: "worm", ok: false, error: { kind: "unreachable", message: "down" } },
    )).toBeNull();
  });

  test("formatStateSchemaConvergence sorts by migration order with unknown last", () => {
    expect(formatStateSchemaConvergence([
      { host: "worm", schema: null },
      { host: "carbon", schema: "0030" },
      { host: "mba", schema: "0019" },
    ])).toBe("state schema: 3 versions across 3 hosts - 0019 (mba), 0030 (carbon), unknown (worm)");
    expect(formatStateSchemaConvergence([])).toBe("state schema: no hosts reported.");
    expect(formatStateSchemaConvergence([
      { host: "blade", schema: null },
      { host: "mba", schema: null },
    ])).toBe(
      "state schema: unknown across 2 hosts (no daemon reported a migration ledger).",
    );
  });
});
