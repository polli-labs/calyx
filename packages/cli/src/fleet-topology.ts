import {
  loadFleetTopologySnapshot,
  resolveFleetTopologyTargets,
  type FleetTopologyResolutionIntent,
  type FleetTopologyTarget,
  type FleetTopologyTargetsV1,
} from "@polli-labs/calyx-core";

export type FleetEffectiveState = "active" | "withdrawn" | "repair" | "unavailable";

export interface FleetExcludedWithdrawnHost extends FleetTopologyTarget {
  desired_membership: "withdrawn";
  effective_state: "withdrawn";
}

export interface FleetTopologyOutput {
  topology_snapshot: FleetTopologyTargetsV1["snapshot"];
  topology_authority: FleetTopologyTargetsV1["authority"];
  can_emit_green_verdict: boolean;
  desired_active_total: number;
  withdrawn_total: number;
  excluded_withdrawn: FleetExcludedWithdrawnHost[];
}

export interface FleetReadSummary {
  desired_active_total: number;
  withdrawn_total: number;
  active: number;
  repair: number;
  unavailable: number;
  green: boolean;
}

export type ResolveFleetTopology = (
  intent: FleetTopologyResolutionIntent,
) => Promise<FleetTopologyTargetsV1>;

export async function resolveFleetTopologyForCommand(
  intent: FleetTopologyResolutionIntent,
  agentsInfraRoot?: string,
): Promise<FleetTopologyTargetsV1> {
  const snapshot = await loadFleetTopologySnapshot({
    ...(agentsInfraRoot ? { agentsInfraRoot } : {}),
  });
  return resolveFleetTopologyTargets(snapshot, intent);
}

export function fleetTopologyOutput(targets: FleetTopologyTargetsV1): FleetTopologyOutput {
  return {
    topology_snapshot: targets.snapshot,
    topology_authority: targets.authority,
    can_emit_green_verdict: targets.can_emit_green_verdict,
    desired_active_total: targets.desired_active.length,
    withdrawn_total: targets.withdrawn.length,
    excluded_withdrawn: targets.withdrawn.map((target) => ({
      ...target,
      desired_membership: "withdrawn",
      effective_state: "withdrawn",
    })),
  };
}

export function summarizeFleetRead(
  topology: FleetTopologyOutput,
  states: readonly FleetEffectiveState[],
): FleetReadSummary {
  const summary: FleetReadSummary = {
    desired_active_total: topology.desired_active_total,
    withdrawn_total: topology.withdrawn_total,
    active: 0,
    repair: 0,
    unavailable: 0,
    green: false,
  };
  for (const state of states) {
    if (state !== "withdrawn") summary[state] += 1;
  }
  summary.green = topology.can_emit_green_verdict
    && summary.active === topology.desired_active_total
    && summary.repair === 0
    && summary.unavailable === 0;
  return summary;
}

export function formatFleetTopologyIdentity(
  topology: Pick<FleetTopologyOutput, "topology_snapshot" | "topology_authority">,
): string {
  return [
    `topology commit=${topology.topology_snapshot.source.commit ?? "unavailable"}`,
    `digest=${topology.topology_snapshot.projection_sha256 ?? "unavailable"}`,
    `authority=${topology.topology_authority.status}`,
  ].join(" ");
}

export function formatExcludedWithdrawn(topology: FleetTopologyOutput): string {
  if (topology.excluded_withdrawn.length === 0) {
    return "excluded_withdrawn: none";
  }
  return `excluded_withdrawn: ${topology.excluded_withdrawn
    .map((target) => `${target.host}(owner=${target.owner})`)
    .join(", ")}`;
}
