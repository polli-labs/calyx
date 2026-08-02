import type {
  SelfUpgradeOperationFinalRow,
  SelfUpgradeOperationHostState,
  SelfUpgradeOperationRecord,
  SelfUpgradeOperationTransition,
} from "@polli-labs/calyx-core";

/** Typed stderr projection of `self-upgrade-operation/v1`. */
export const SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION = "calyx.self-upgrade-fleet-progress/v1";
export const DEFAULT_FLEET_PROGRESS_HEARTBEAT_MS = 15_000;

interface FleetProgressHostSnapshot {
  host: string;
  state: string;
  elapsed_ms: number;
  execution_status: SelfUpgradeOperationHostState["execution_status"];
  relay_mode: SelfUpgradeOperationHostState["relay_mode"];
  phase?: SelfUpgradeOperationHostState["latest_phase"];
}

export type FleetProgressRecord =
  | {
      schema_version: typeof SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION;
      record: "operation_started";
      operation_id: string;
      emitted_at: string;
      operation_path: string;
      operation_projection: "available" | "degraded" | "unavailable";
      hosts: string[];
    }
  | {
      schema_version: typeof SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION;
      record: "host_state";
      operation_id: string;
      emitted_at: string;
      cause_transition_id: string;
      host: FleetProgressHostSnapshot;
    }
  | {
      schema_version: typeof SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION;
      record: "heartbeat";
      operation_id: string;
      emitted_at: string;
      hosts: FleetProgressHostSnapshot[];
    }
  | {
      schema_version: typeof SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION;
      record: "warning";
      operation_id: string;
      emitted_at: string;
      code: string;
      message: string;
      operation_projection: "available" | "degraded" | "unavailable";
    }
  | {
      schema_version: typeof SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION;
      record: "fleet_final";
      operation_id: string;
      emitted_at: string;
      status: Exclude<SelfUpgradeOperationRecord["status"], "running">;
      operation_projection: "available" | "degraded" | "unavailable";
      receipt_path: string;
      rows: SelfUpgradeOperationFinalRow[];
    };

export interface SelfUpgradeFleetProgressOptions {
  json: boolean;
  operationPath: string;
  write: (chunk: string) => void;
  now: () => string;
  monotonicNowMs: () => number;
  heartbeatIntervalMs: number;
  getRecord: () => SelfUpgradeOperationRecord;
  getProjectionStatus: () => "available" | "degraded" | "unavailable";
}

export function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  if (totalSeconds < 120) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function stateLabel(record: SelfUpgradeOperationRecord, host: SelfUpgradeOperationHostState): string {
  if (record.status !== "running") {
    return host.execution_status;
  }
  if (host.execution_status === "succeeded") {
    return "postflight";
  }
  if (host.execution_status !== "pending") {
    return host.execution_status;
  }
  if (host.latest_phase) {
    return host.latest_phase;
  }
  if (host.relay_mode === "legacy") {
    return "awaiting-receipt";
  }
  return host.dispatch ? "awaiting-phase-or-receipt" : "pending";
}

/**
 * Renders only reduced operation state. Replayed transitions are silent and a
 * delayed older phase that does not change the reduced host row is silent too.
 */
export class SelfUpgradeFleetProgressReporter {
  private readonly options: SelfUpgradeFleetProgressOptions;
  private readonly dispatchedAtMs = new Map<string, number>();
  private readonly lastActivityByHostMs = new Map<string, number>();
  private operationStartedMs: number;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(options: SelfUpgradeFleetProgressOptions) {
    this.options = options;
    this.operationStartedMs = options.monotonicNowMs();
  }

  start(record: SelfUpgradeOperationRecord): void {
    this.operationStartedMs = this.options.monotonicNowMs();
    this.dispatchedAtMs.clear();
    this.lastActivityByHostMs.clear();
    if (this.options.json) {
      this.writeRecord({
        schema_version: SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION,
        record: "operation_started",
        operation_id: record.operation_id,
        emitted_at: this.options.now(),
        operation_path: this.options.operationPath,
        operation_projection: this.options.getProjectionStatus(),
        hosts: Object.keys(record.hosts).sort(),
      });
    } else {
      this.options.write(
        `calyx self upgrade --fleet operation_id=${record.operation_id} operation_record=${this.options.operationPath} operation_projection=${this.options.getProjectionStatus()} hosts=${Object.keys(record.hosts).length}\n`,
      );
    }
    if (!this.ticker && this.options.heartbeatIntervalMs > 0) {
      this.ticker = setInterval(() => this.heartbeat(), this.options.heartbeatIntervalMs);
      this.ticker.unref?.();
    }
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  observe(
    record: SelfUpgradeOperationRecord,
    transition: SelfUpgradeOperationTransition,
    changedHost: string | undefined,
  ): void {
    if (!changedHost) {
      return;
    }
    if (transition.kind === "host_dispatched") {
      this.dispatchedAtMs.set(changedHost, this.options.monotonicNowMs());
    }
    const host = record.hosts[changedHost];
    if (!host) {
      return;
    }
    this.lastActivityByHostMs.set(changedHost, this.options.monotonicNowMs());
    const snapshot = this.snapshot(record, host);
    if (this.options.json) {
      this.writeRecord({
        schema_version: SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION,
        record: "host_state",
        operation_id: record.operation_id,
        emitted_at: this.options.now(),
        cause_transition_id: transition.transition_id,
        host: snapshot,
      });
      return;
    }
    this.options.write(`${this.humanLine(transition, snapshot)}\n`);
  }

  warning(code: string, message: string): void {
    const record = this.options.getRecord();
    if (this.options.json) {
      this.writeRecord({
        schema_version: SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION,
        record: "warning",
        operation_id: record.operation_id,
        emitted_at: this.options.now(),
        code,
        message,
        operation_projection: this.options.getProjectionStatus(),
      });
    } else {
      this.options.write(
        `warning: ${code}: ${message} operation_projection=${this.options.getProjectionStatus()}\n`,
      );
    }
  }

  heartbeat(): void {
    const record = this.options.getRecord();
    if (record.status !== "running") {
      return;
    }
    const nowMs = this.options.monotonicNowMs();
    const hosts = Object.values(record.hosts)
      .sort((left, right) => left.host.localeCompare(right.host))
      .filter((host) => this.dispatchedAtMs.has(host.host))
      .filter((host) => nowMs - (this.lastActivityByHostMs.get(host.host) ?? this.operationStartedMs)
        >= this.options.heartbeatIntervalMs)
      .map((host) => this.snapshot(record, host));
    if (hosts.length === 0) {
      return;
    }
    for (const host of hosts) {
      this.lastActivityByHostMs.set(host.host, nowMs);
    }
    if (this.options.json) {
      this.writeRecord({
        schema_version: SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION,
        record: "heartbeat",
        operation_id: record.operation_id,
        emitted_at: this.options.now(),
        hosts,
      });
      return;
    }
    this.options.write(
      `heartbeat: ${hosts.map((host) => `${host.host} ${host.state} ${formatCompactDuration(host.elapsed_ms)}`).join(" · ")}\n`,
    );
  }

  final(record: SelfUpgradeOperationRecord): void {
    if (record.status === "running" || !record.final_receipt_path || !record.final_rows) {
      throw new Error("Cannot render a fleet final projection before the durable operation is terminal.");
    }
    this.stop();
    if (!this.options.json) {
      return;
    }
    this.writeRecord({
      schema_version: SELF_UPGRADE_FLEET_PROGRESS_SCHEMA_VERSION,
      record: "fleet_final",
      operation_id: record.operation_id,
      emitted_at: this.options.now(),
      status: record.status,
      operation_projection: this.options.getProjectionStatus(),
      receipt_path: record.final_receipt_path,
      rows: record.final_rows,
    });
  }

  private snapshot(
    record: SelfUpgradeOperationRecord,
    host: SelfUpgradeOperationHostState,
  ): FleetProgressHostSnapshot {
    const startedAtMs = this.dispatchedAtMs.get(host.host) ?? this.operationStartedMs;
    const observedElapsedMs = Math.max(0, this.options.monotonicNowMs() - startedAtMs);
    const elapsedMs = record.status === "running" && host.execution_status === "succeeded"
      ? Math.max(host.elapsed_ms ?? 0, observedElapsedMs)
      : host.elapsed_ms ?? observedElapsedMs;
    return {
      host: host.host,
      state: stateLabel(record, host),
      elapsed_ms: elapsedMs,
      execution_status: host.execution_status,
      relay_mode: host.relay_mode,
      ...(host.latest_phase ? { phase: host.latest_phase } : {}),
    };
  }

  private humanLine(
    transition: SelfUpgradeOperationTransition,
    host: FleetProgressHostSnapshot,
  ): string {
    switch (transition.kind) {
      case "host_dispatched":
        return `${host.host}: dispatched (${transition.dispatch})`;
      case "host_phase":
        return `${host.host}: ${host.phase ?? transition.phase} (${formatCompactDuration(host.elapsed_ms)})`;
      case "host_relay_degraded":
        return transition.reason === "frame_budget_exceeded"
          ? `${host.host}: phase relay truncated at the bounded frame budget, waiting on final receipt`
          : `${host.host}: no phase frames observed, waiting on final receipt`;
      case "host_result":
        return `${host.host}: receipt received status=${transition.status} (${formatCompactDuration(host.elapsed_ms)})`;
      case "fleet_final":
        return `fleet: ${transition.status}`;
    }
  }

  private writeRecord(record: FleetProgressRecord): void {
    this.options.write(`${JSON.stringify(record)}\n`);
  }
}

export type FleetFinalTableRow = SelfUpgradeOperationFinalRow;

function shortHead(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "—";
  }
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
}

/** Compact authoritative final projection, rendered only after receipt write. */
export function formatFleetFinalTable(rows: readonly FleetFinalTableRow[]): string {
  const header = ["host", "status", "freshness", "head", "elapsed", "receipt"] as const;
  const body = rows.map((row) => [
    row.host,
    row.status,
    row.freshness_verdict ?? "—",
    `${shortHead(row.before_head)}→${shortHead(row.after_head)}`,
    row.elapsed_ms === undefined ? "—" : formatCompactDuration(row.elapsed_ms),
    row.receipt_locator ? `${row.receipt_locator.host}:${row.receipt_locator.route}` : "—",
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...body.map((cells) => cells[column]!.length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  ").trimEnd();
  return [render(header), ...body.map((cells) => render(cells))].join("\n");
}
