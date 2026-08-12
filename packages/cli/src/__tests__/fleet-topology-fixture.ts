import type {
  FleetTopologyDesiredMembership,
  FleetTopologyResolutionIntent,
  FleetTopologyTarget,
  FleetTopologyTargetsV1,
} from "@polli-labs/calyx-core";

export const TEST_TOPOLOGY_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const TEST_TOPOLOGY_DIGEST =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export function makeFleetTopologyTarget(
  host: string,
  desiredMembership: FleetTopologyDesiredMembership = "active",
  runServeUrl = `http://${host}:8740`,
): FleetTopologyTarget {
  return {
    host,
    owner: "caleb",
    desired_membership: desiredMembership,
    roles: ["agent"],
    expected_surface_profile: "managed-calyx-host",
    expected_surfaces: ["topology", "reachability", "daemon"],
    run_serve_url: runServeUrl,
    catch_up_policy: "required_before_start",
  };
}

export function makeFleetTopologyTargets(options: {
  active?: FleetTopologyTarget[];
  withdrawn?: FleetTopologyTarget[];
  authoritative?: boolean;
  intent?: FleetTopologyResolutionIntent;
} = {}): FleetTopologyTargetsV1 {
  const desiredActive = options.active ?? [makeFleetTopologyTarget("blade")];
  const withdrawn = options.withdrawn ?? [];
  const authoritative = options.authoritative ?? true;
  return {
    schema_version: "fleet-topology-targets/v1",
    intent: options.intent ?? "read_only",
    snapshot: {
      schema_version: "fleet-topology-snapshot/v1",
      source: {
        repository: "polli-labs/agents-infra",
        root: "/test/agents-infra",
        path: "/test/agents-infra/fleet/truths/hosts.yaml",
        ref: "refs/remotes/origin/main",
        commit: TEST_TOPOLOGY_COMMIT,
        dirty: !authoritative,
      },
      projection_sha256: TEST_TOPOLOGY_DIGEST,
      resolved_at: "2026-08-02T12:00:00.000Z",
      resolver: "@polli-labs/calyx-core/fleet-topology-resolver@v1",
    },
    authority: authoritative
      ? {
          status: "authoritative",
          reasons: [],
          label: "authoritative fleet topology snapshot",
        }
      : {
          status: "non_authoritative",
          reasons: ["source_dirty"],
          label: "non-authoritative fleet topology snapshot: source_dirty",
        },
    can_emit_green_verdict: authoritative,
    desired_active: desiredActive,
    withdrawn,
    all_enrolled: [...desiredActive, ...withdrawn]
      .sort((left, right) => left.host.localeCompare(right.host)),
  };
}
