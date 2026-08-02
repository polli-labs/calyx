import { describe, expect, test } from "vitest";
import {
  applySelfUpgradeOperationTransition,
  createSelfUpgradeOperation,
  selfUpgradeHostPhaseTransitionId,
  type SelfUpgradeHostPhaseTransition,
  type SelfUpgradeOperationTransition,
} from "@polli-labs/calyx-core";
import {
  SelfUpgradeFleetProgressReporter,
  formatFleetFinalTable,
  type FleetProgressRecord,
} from "../self-upgrade-fleet-progress.js";

const operationId = "fleet-2026-07-21T09-00-00-000Z";

function initial() {
  return createSelfUpgradeOperation({
    operationId,
    writerId: "writer-progress-test",
    conductorHost: "blade",
    targetRef: "origin/main",
    hosts: ["blade", "worm"],
    dryRun: false,
    parallel: true,
    failFast: false,
    startedAt: "2026-07-21T09:00:00.000Z",
  });
}

function transition<T extends SelfUpgradeOperationTransition>(value: T): T {
  return value;
}

describe("SelfUpgradeFleetProgressReporter", () => {
  test("emits typed state/heartbeats from reduced operation state and gates final", () => {
    let record = initial();
    let monotonicMs = 0;
    const chunks: string[] = [];
    const reporter = new SelfUpgradeFleetProgressReporter({
      json: true,
      operationPath: "/ops/fleet.json",
      write: (chunk) => chunks.push(chunk),
      now: () => "2026-07-21T09:00:30.000Z",
      monotonicNowMs: () => monotonicMs,
      heartbeatIntervalMs: 15_000,
      getRecord: () => record,
      getProjectionStatus: () => "available",
    });
    reporter.start(record);

    const dispatched = transition({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_dispatched",
      transition_id: "dispatch-blade",
      operation_id: operationId,
      emitted_at: "2026-07-21T09:00:01.000Z",
      observed_at: "2026-07-21T09:00:01.000Z",
      host: "blade",
      dispatch: "ssh",
    });
    const applied = applySelfUpgradeOperationTransition(record, dispatched);
    record = applied.record;
    reporter.observe(record, dispatched, applied.changed_host);
    reporter.observe(record, dispatched, undefined);

    monotonicMs = 15_000;
    reporter.heartbeat();
    const records = chunks.map((chunk) => JSON.parse(chunk) as FleetProgressRecord);

    expect(records.map((entry) => entry.record)).toEqual([
      "operation_started",
      "host_state",
      "heartbeat",
    ]);
    expect(records[0]).toMatchObject({
      record: "operation_started",
      operation_path: "/ops/fleet.json",
      operation_projection: "available",
    });
    expect(records[2]).toMatchObject({
      record: "heartbeat",
      hosts: [
        { host: "blade", state: "awaiting-phase-or-receipt", elapsed_ms: 15_000 },
      ],
    });
    expect(() => reporter.final(record)).toThrow(/before the durable operation is terminal/u);

    for (const hostResult of [
      transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_result",
        transition_id: "result-blade",
        operation_id: operationId,
        emitted_at: "2026-07-21T09:00:20.000Z",
        observed_at: "2026-07-21T09:00:20.000Z",
        host: "blade",
        status: "succeeded",
        elapsed_ms: 12_000,
        relay_mode: "missing",
        receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
      }),
      transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_result",
        transition_id: "result-worm",
        operation_id: operationId,
        emitted_at: "2026-07-21T09:00:21.000Z",
        observed_at: "2026-07-21T09:00:21.000Z",
        host: "worm",
        status: "failed",
        elapsed_ms: 20_000,
        relay_mode: "missing",
        error: "upgrade failed",
      }),
    ]) {
      record = applySelfUpgradeOperationTransition(record, hostResult).record;
    }

    const final = transition({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "fleet-final",
      operation_id: operationId,
      emitted_at: "2026-07-21T09:00:30.000Z",
      observed_at: "2026-07-21T09:00:30.000Z",
      status: "failed",
      receipt_path: "/receipts/summary.json",
      rows: [
        {
          host: "blade",
          status: "succeeded",
          elapsed_ms: 12_000,
          receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
          freshness_verdict: "fresh",
        },
        { host: "worm", status: "failed", elapsed_ms: 20_000 },
      ],
    });
    record = applySelfUpgradeOperationTransition(record, final).record;
    reporter.final(record);

    expect(JSON.parse(chunks.at(-1)!)).toMatchObject({
      schema_version: "calyx.self-upgrade-fleet-progress/v1",
      record: "fleet_final",
      operation_id: operationId,
      status: "failed",
      operation_projection: "available",
      receipt_path: "/receipts/summary.json",
    });
  });

  test("annotates warnings with the projection status at emission time", () => {
    const record = initial();
    const chunks: string[] = [];
    let projectionStatus: "available" | "degraded" | "unavailable" = "available";
    const reporter = new SelfUpgradeFleetProgressReporter({
      json: true,
      operationPath: "/ops/fleet.json",
      write: (chunk) => chunks.push(chunk),
      now: () => "2026-07-21T09:00:30.000Z",
      monotonicNowMs: () => 0,
      heartbeatIntervalMs: 0,
      getRecord: () => record,
      getProjectionStatus: () => projectionStatus,
    });
    reporter.start(record);
    projectionStatus = "degraded";
    reporter.warning("upgrade_operation_projection_persist_unavailable", "writer release timed out");

    expect(JSON.parse(chunks.at(-1)!)).toMatchObject({
      record: "warning",
      operation_projection: "degraded",
      code: "upgrade_operation_projection_persist_unavailable",
    });
  });

  test("renders a compact mixed-host authoritative table", () => {
    expect(formatFleetFinalTable([
      {
        host: "blade",
        status: "succeeded",
        before_head: "a".repeat(40),
        after_head: "b".repeat(40),
        elapsed_ms: 34_000,
        receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
        freshness_verdict: "fresh",
      },
      {
        host: "worm",
        status: "failed",
        before_head: "c".repeat(40),
        elapsed_ms: 125_000,
        receipt_locator: { host: "worm", route: "/v1/admin/self-upgrade-receipts/fleet" },
      },
    ])).toBe([
      "host   status     freshness  head             elapsed  receipt",
      "blade  succeeded  fresh      aaaaaaa→bbbbbbb  34s      blade:/v1/admin/self-upgrade-receipts/blade",
      "worm   failed     —          ccccccc→—        2m05s    worm:/v1/admin/self-upgrade-receipts/fleet",
    ].join("\n"));
  });

  test("tracks heartbeat quietness per host when one peer stays chatty", () => {
    let record = initial();
    let monotonicMs = 0;
    const chunks: string[] = [];
    const reporter = new SelfUpgradeFleetProgressReporter({
      json: true,
      operationPath: "/ops/fleet.json",
      write: (chunk) => chunks.push(chunk),
      now: () => "2026-07-21T09:00:30.000Z",
      monotonicNowMs: () => monotonicMs,
      heartbeatIntervalMs: 15_000,
      getRecord: () => record,
      getProjectionStatus: () => "available",
    });
    reporter.start(record);

    for (const host of ["blade", "worm"]) {
      const dispatched = transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_dispatched",
        transition_id: `dispatch-${host}`,
        operation_id: operationId,
        emitted_at: "2026-07-21T09:00:00.000Z",
        observed_at: "2026-07-21T09:00:00.000Z",
        host,
        dispatch: "ssh" as const,
      });
      const applied = applySelfUpgradeOperationTransition(record, dispatched);
      record = applied.record;
      reporter.observe(record, dispatched, applied.changed_host);
    }

    const observeBlade = (transitionId: string, elapsedMs: number): void => {
      const observation = {
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_phase",
        operation_id: operationId,
        emitted_at: "2026-07-21T09:00:10.000Z",
        observed_at: "2026-07-21T09:00:10.000Z",
        host: "blade",
        host_operation_id: "host-op-blade",
        source_event_id: `event-${transitionId}`,
        source_cursor: `cursor-${transitionId}`,
        source: "host_event",
        phase: "build",
        elapsed_ms: elapsedMs,
        synthetic: false,
      } satisfies Omit<SelfUpgradeHostPhaseTransition, "transition_id">;
      const phase = transition({
        ...observation,
        transition_id: selfUpgradeHostPhaseTransitionId(observation),
      });
      const applied = applySelfUpgradeOperationTransition(record, phase);
      record = applied.record;
      reporter.observe(record, phase, applied.changed_host);
    };

    monotonicMs = 14_000;
    observeBlade("blade-build-1", 14_000);
    monotonicMs = 15_000;
    reporter.heartbeat();
    monotonicMs = 29_000;
    observeBlade("blade-build-2", 29_000);
    monotonicMs = 30_000;
    reporter.heartbeat();
    reporter.stop();

    const heartbeats = chunks
      .map((chunk) => JSON.parse(chunk) as FleetProgressRecord)
      .filter((entry): entry is Extract<FleetProgressRecord, { record: "heartbeat" }> => entry.record === "heartbeat");
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats.map((entry) => entry.hosts.map((host) => host.host))).toEqual([
      ["worm"],
      ["worm"],
    ]);
  });

  test("suppresses undispatched hosts and advances succeeded-host postflight elapsed", () => {
    let record = initial();
    let monotonicMs = 0;
    const chunks: string[] = [];
    const reporter = new SelfUpgradeFleetProgressReporter({
      json: true,
      operationPath: "/ops/fleet.json",
      write: (chunk) => chunks.push(chunk),
      now: () => "2026-07-21T09:00:30.000Z",
      monotonicNowMs: () => monotonicMs,
      heartbeatIntervalMs: 5_000,
      getRecord: () => record,
      getProjectionStatus: () => "available",
    });
    reporter.start(record);

    const dispatched = transition({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_dispatched",
      transition_id: "dispatch-blade-postflight",
      operation_id: operationId,
      emitted_at: "2026-07-21T09:00:00.000Z",
      observed_at: "2026-07-21T09:00:00.000Z",
      host: "blade",
      dispatch: "ssh" as const,
    });
    let applied = applySelfUpgradeOperationTransition(record, dispatched);
    record = applied.record;
    reporter.observe(record, dispatched, applied.changed_host);

    monotonicMs = 2_000;
    const succeeded = transition({
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "result-blade-postflight",
      operation_id: operationId,
      emitted_at: "2026-07-21T09:00:02.000Z",
      observed_at: "2026-07-21T09:00:02.000Z",
      host: "blade",
      status: "succeeded" as const,
      elapsed_ms: 2_000,
      relay_mode: "stream" as const,
    });
    applied = applySelfUpgradeOperationTransition(record, succeeded);
    record = applied.record;
    reporter.observe(record, succeeded, applied.changed_host);

    monotonicMs = 7_000;
    reporter.heartbeat();
    const heartbeats = chunks
      .map((chunk) => JSON.parse(chunk) as FleetProgressRecord)
      .filter((entry): entry is Extract<FleetProgressRecord, { record: "heartbeat" }> => entry.record === "heartbeat");
    const heartbeat = heartbeats.at(-1);

    expect(heartbeat?.hosts).toEqual([
      expect.objectContaining({ host: "blade", state: "postflight", elapsed_ms: 7_000 }),
    ]);
    expect(heartbeat?.hosts.some((host) => host.host === "worm")).toBe(false);
  });

  test("renders predecessor absence evidence without repeating a generation claim", () => {
    let record = initial();
    const chunks: string[] = [];
    const reporter = new SelfUpgradeFleetProgressReporter({
      json: false,
      operationPath: "/ops/fleet.json",
      write: (chunk) => chunks.push(chunk),
      now: () => "2026-07-21T09:00:30.000Z",
      monotonicNowMs: () => 0,
      heartbeatIntervalMs: 0,
      getRecord: () => record,
      getProjectionStatus: () => "degraded",
    });
    reporter.start(record);

    for (const [host, reason] of [
      ["blade", "frame_budget_exceeded"],
      ["worm", "pre_relay_binary"],
    ] as const) {
      const degraded = transition({
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_relay_degraded",
        transition_id: `degraded-${host}`,
        operation_id: operationId,
        emitted_at: "2026-07-21T09:00:10.000Z",
        observed_at: "2026-07-21T09:00:10.000Z",
        host,
        reason,
      });
      const applied = applySelfUpgradeOperationTransition(record, degraded);
      record = applied.record;
      reporter.observe(record, degraded, applied.changed_host);
    }

    expect(chunks).toEqual(expect.arrayContaining([
      expect.stringContaining("operation_projection=degraded"),
      "blade: phase relay truncated at the bounded frame budget, waiting on final receipt\n",
      "worm: no phase frames observed, waiting on final receipt\n",
    ]));
  });
});
