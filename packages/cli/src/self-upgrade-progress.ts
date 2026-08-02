import {
  encodeSelfUpgradeOperationTransition,
  parseSelfUpgradeOperationTransition,
  selfUpgradeHostPhaseTransitionId,
  type SelfUpgradeHostPhaseTransition,
  type SelfUpgradeOperationTransition,
} from "@polli-labs/calyx-core";
import type { CalyxControlEvent, CalyxUpgradePhase } from "@polli-labs/calyx-run-service";

/**
 * Typed phase observation produced at a host mutation boundary. Event-log and
 * SSH copies are fail-open projections of this value; the host operation
 * record and final receipt remain execution authority.
 */
export type SelfUpgradePhaseEvent = CalyxControlEvent & {
  event_type: "daemon.upgrade.progress";
  emitted_by: "self-upgrade";
  control: CalyxControlEvent["control"] & {
    operation_id: string;
    phase: CalyxUpgradePhase;
    elapsed_ms: number;
  };
};

export function isSelfUpgradePhaseEvent(
  event: CalyxControlEvent,
): event is SelfUpgradePhaseEvent {
  return event.event_type === "daemon.upgrade.progress"
    && event.emitted_by === "self-upgrade"
    && typeof event.control.operation_id === "string"
    && event.control.operation_id.trim().length > 0
    && typeof event.control.phase === "string"
    && typeof event.control.elapsed_ms === "number"
    && Number.isInteger(event.control.elapsed_ms)
    && event.control.elapsed_ms >= 0;
}

export function toSelfUpgradeProgressTransition(args: {
  fleetOperationId: string;
  event: SelfUpgradePhaseEvent;
  source: "host_event" | "local_event";
  observedAt: string;
}): SelfUpgradeHostPhaseTransition {
  const observation = {
    schema_version: "self-upgrade-operation/v1",
    record: "transition",
    kind: "host_phase",
    operation_id: args.fleetOperationId,
    emitted_at: args.event.emitted_at,
    observed_at: args.observedAt,
    host: args.event.control.host,
    host_operation_id: args.event.control.operation_id,
    source_event_id: args.event.event_id,
    source_cursor: args.event.cursor,
    source: args.source,
    phase: args.event.control.phase,
    elapsed_ms: args.event.control.elapsed_ms,
    synthetic: false,
  } satisfies Omit<SelfUpgradeHostPhaseTransition, "transition_id">;
  return {
    ...observation,
    transition_id: selfUpgradeHostPhaseTransitionId(observation),
  };
}

/** One strict transition per stderr line; stdout remains the final JSON only. */
export function encodeSelfUpgradeProgressTransition(
  transition: SelfUpgradeHostPhaseTransition,
): string {
  return encodeSelfUpgradeOperationTransition(transition);
}

/**
 * Parse one remote stderr line as an owning-schema transition. Arbitrary SSH,
 * shell, and application diagnostics are not interpreted as protocol data.
 */
export function parseSelfUpgradeProgressTransition(
  line: string,
): SelfUpgradeOperationTransition | undefined {
  return parseSelfUpgradeOperationTransition(line);
}
