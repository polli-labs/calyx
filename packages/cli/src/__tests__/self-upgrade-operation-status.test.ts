import { describe, expect, test, vi } from "vitest";
import {
  applySelfUpgradeOperationTransition,
  createSelfUpgradeOperation,
  type SelfUpgradeOperationObservation,
  type SelfUpgradeOperationTransition,
} from "@polli-labs/calyx-core";
import {
  formatSelfUpgradeOperationStatusText,
  projectSelfUpgradeOperationStatus,
  runSelfUpgradeOperationStatus,
  serializeSelfUpgradeOperationStatusJson,
  SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES,
} from "../self-upgrade-operation-status.js";

function observation(args: {
  hosts?: string[];
  runningState?: SelfUpgradeOperationObservation["running_state"];
  ownerLiveness?: SelfUpgradeOperationObservation["owner_liveness"];
  terminal?: boolean;
  revision?: number;
  topology?: boolean;
} = {}): SelfUpgradeOperationObservation {
  const hosts = args.hosts ?? ["blade"];
  let operation = createSelfUpgradeOperation({
    operationId: "self-upgrade-status-test",
    writerId: "writer-status-test",
    conductorHost: "blade",
    targetRef: "origin/main",
    ...(args.topology
      ? {
          topologySnapshot: {
            schema_version: "fleet-topology-snapshot/v1" as const,
            source: { commit: "a".repeat(40) },
            projection_sha256: "b".repeat(64),
          },
        }
      : {}),
    hosts,
    dryRun: false,
    parallel: hosts.length > 1,
    failFast: false,
    startedAt: "2026-07-22T10:00:00.000Z",
  });
  if (args.terminal) {
    for (const host of hosts) {
      const result: SelfUpgradeOperationTransition = {
        schema_version: "self-upgrade-operation/v1",
        record: "transition",
        kind: "host_result",
        transition_id: `result-${host}`,
        operation_id: operation.operation_id,
        emitted_at: "2026-07-22T10:02:00.000Z",
        observed_at: "2026-07-22T10:02:00.000Z",
        host,
        status: "succeeded",
        elapsed_ms: 120_000,
        relay_mode: hosts.length > 1 ? "stream" : "local",
        before_head: "a".repeat(40),
        after_head: "b".repeat(40),
      };
      operation = applySelfUpgradeOperationTransition(operation, result).record;
    }
    operation = applySelfUpgradeOperationTransition(operation, {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "status-final",
      operation_id: operation.operation_id,
      emitted_at: "2026-07-22T10:02:01.000Z",
      observed_at: "2026-07-22T10:02:01.000Z",
      status: "succeeded",
      receipt_path: "/home/caleb/.calyx/self-upgrade-receipts/status-test.json",
      rows: hosts.map((host) => ({
        host,
        status: "succeeded" as const,
        elapsed_ms: 120_000,
        before_head: "a".repeat(40),
        after_head: "b".repeat(40),
      })),
    }).record;
  }
  return {
    operation: {
      ...operation,
      revision: args.revision ?? operation.revision,
    },
    observed_at: "2026-07-22T10:03:00.000Z",
    projection_status: "available",
    running_state: args.runningState ?? (args.terminal ? "terminal" : "active"),
    owner_liveness: args.ownerLiveness ?? (args.terminal ? "released" : "live"),
    ...(args.terminal ? {} : {
      owner_pid: 4242,
      owner_claimed_at: "2026-07-22T10:00:00.000Z",
    }),
  };
}

describe("self upgrade operation status", () => {
  test.each([
    ["single-host", ["blade"]],
    ["fleet", ["blade", "worm"]],
  ] as const)("projects bounded typed %s output without transition history", (_label, hosts) => {
    const result = projectSelfUpgradeOperationStatus(
      observation({ hosts: [...hosts], terminal: true, topology: hosts.length > 1 }),
      "explicit",
    );

    expect(result).toMatchObject({
      schema_version: "self-upgrade-operation-status/v1",
      projection: {
        running_state: "terminal",
        owner_liveness: "released",
      },
      authority: {
        operation_record: "observation_projection",
        mutation_truth: "host_local_durable_state",
        terminal_truth: "verified_final_receipts",
      },
      bounded: {
        omitted_transition_count: hosts.length + 1,
      },
    });
    expect(result.hosts).toHaveLength(hosts.length);
    if (hosts.length > 1) {
      expect(result.operation.topology_snapshot).toEqual({
        schema_version: "fleet-topology-snapshot/v1",
        source: { commit: "a".repeat(40) },
        projection_sha256: "b".repeat(64),
      });
      expect(formatSelfUpgradeOperationStatusText(result))
        .toContain(`topology: commit=${"a".repeat(40)} digest=${"b".repeat(64)}`);
    }
    expect(JSON.stringify(result)).not.toContain("\"transitions\"");
    expect(Buffer.byteLength(`${serializeSelfUpgradeOperationStatusJson(result)}\n`, "utf8"))
      .toBeLessThanOrEqual(SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES);
    expect(formatSelfUpgradeOperationStatusText(result))
      .toContain("observation projection");
  });

  test("enforces the byte ceiling against the exact compact JSON record emitted by the CLI", () => {
    const result = projectSelfUpgradeOperationStatus(
      observation({ terminal: true }),
      "explicit",
    );
    const initialBytes = Buffer.byteLength(
      `${serializeSelfUpgradeOperationStatusJson(result)}\n`,
      "utf8",
    );
    result.operation.conductor_host += "x".repeat(
      SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES - initialBytes,
    );

    const encoded = serializeSelfUpgradeOperationStatusJson(result);
    expect(encoded).not.toContain("\n");
    expect(Buffer.byteLength(`${encoded}\n`, "utf8"))
      .toBe(SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES);

    result.operation.conductor_host += "x";
    expect(() => serializeSelfUpgradeOperationStatusJson(result))
      .toThrow(/exceeds the 524288-byte output contract/u);
  });

  test("watch emits changed live state and exits on terminal state", async () => {
    const active = observation({ revision: 1 });
    const terminal = observation({ terminal: true, revision: 2 });
    const observeOperation = vi.fn()
      .mockResolvedValueOnce(terminal);
    const emitted: string[] = [];

    const result = await runSelfUpgradeOperationStatus(
      {
        operationId: active.operation.operation_id,
        watch: true,
      },
      {
        now: () => "2026-07-22T10:03:00.000Z",
        observeOperation: vi.fn().mockResolvedValueOnce(active)
          .mockImplementation(observeOperation),
        waitForChange: async () => {},
      },
      (status) => {
        emitted.push(status.projection.running_state);
      },
    );

    expect(emitted).toEqual(["active", "terminal"]);
    expect(result.projection.running_state).toBe("terminal");
  });

  test("watch follows a transient indeterminate observation until live evidence recovers", async () => {
    const active = observation({ revision: 1 });
    const indeterminate = observation({
      runningState: "indeterminate",
      ownerLiveness: "unknown",
      revision: 1,
    });
    const recovered = observation({ revision: 1 });
    const terminal = observation({ terminal: true, revision: 2 });
    const emitted: string[] = [];
    const waitForChange = vi.fn(async () => {});

    const result = await runSelfUpgradeOperationStatus(
      {
        operationId: active.operation.operation_id,
        watch: true,
      },
      {
        observeOperation: vi.fn()
          .mockResolvedValueOnce(active)
          .mockResolvedValueOnce(indeterminate)
          .mockResolvedValueOnce(recovered)
          .mockResolvedValueOnce(terminal),
        waitForChange,
      },
      (status) => emitted.push(status.projection.running_state),
    );

    expect(result.projection.running_state).toBe("terminal");
    expect(emitted).toEqual(["active", "indeterminate", "active", "terminal"]);
    expect(waitForChange).toHaveBeenCalledTimes(3);
  });

  test("watch fails nonzero after bounded indeterminate observations", async () => {
    const indeterminate = observation({
      runningState: "indeterminate",
      ownerLiveness: "unknown",
    });
    const waitForChange = vi.fn(async () => {});

    await expect(runSelfUpgradeOperationStatus(
      {
        operationId: indeterminate.operation.operation_id,
        watch: true,
      },
      {
        observeOperation: vi.fn(async () => indeterminate),
        waitForChange,
      },
      () => {},
    )).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining("remained indeterminate"),
    });
    expect(waitForChange).toHaveBeenCalledTimes(2);
  });

  test("watch returns immediately for orphaned ownership", async () => {
    const runningState = "orphaned";
    const ownerLiveness = "dead";
    const current = observation({ runningState, ownerLiveness });
    const waitForChange = vi.fn();

    const result = await runSelfUpgradeOperationStatus(
      {
        operationId: current.operation.operation_id,
        watch: true,
      },
      {
        observeOperation: vi.fn(async () => current),
        waitForChange,
      },
      () => {},
    );

    expect(result.projection.running_state).toBe(runningState);
    expect(waitForChange).not.toHaveBeenCalled();
  });
});
