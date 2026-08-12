import type { CalyxBuildInfo } from "./daemon-registry";
import {
  FLEET_TOPOLOGY_EXPECTED_SURFACES,
  FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION,
  FLEET_TOPOLOGY_SOURCE_REPOSITORY,
  loadFleetTopologySnapshot,
} from "./fleet-topology";
import type { FleetTopologyExpectedSurface } from "./fleet-topology";
import { planStateMigrations } from "./state/store";
import type { StateOpenOptions } from "./state/store";

export const WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION =
  "calyx.workload-admission-decision/v1" as const;
export const WORKLOAD_ADMISSION_GATE_RECEIPT_SCHEMA_VERSION =
  "calyx.workload-admission-gate-receipt/v1" as const;
export const WORKLOAD_ADMISSION_TARGET_BUNDLE_SCHEMA_VERSION =
  "calyx.workload-admission-target-bundle/v1" as const;
export const WORKLOAD_ADMISSION_INTERIM_PROFILE =
  "d1-interim-topology-reachability-build-schema" as const;

/**
 * D1 ships before the full C2/D2 convergence suite. This exact reduced set is
 * therefore receipt authority, not an implication that the deferred surfaces
 * passed. Replace the profile when the full gate becomes executable.
 */
export const WORKLOAD_ADMISSION_INTERIM_SURFACES = [
  "topology",
  "reachability",
  "running",
  "state_schema",
] as const satisfies readonly FleetTopologyExpectedSurface[];

export const WORKLOAD_ADMISSION_INTERIM_DEFERRED_SURFACES =
  FLEET_TOPOLOGY_EXPECTED_SURFACES.filter(
    (surface) => !(WORKLOAD_ADMISSION_INTERIM_SURFACES as readonly string[]).includes(surface),
  );

export const WORKLOAD_ADMISSION_FENCE_REASONS = [
  "withdrawn",
  "topology_mismatch",
  "convergence_drift",
  "repair_in_progress",
  "admission_evidence_missing",
] as const;

export type WorkloadAdmissionFenceReason =
  (typeof WORKLOAD_ADMISSION_FENCE_REASONS)[number];

export interface WorkloadAdmissionTopologyIdentityV1 {
  schema_version: typeof FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION;
  source_repository: typeof FLEET_TOPOLOGY_SOURCE_REPOSITORY;
  source_commit: string;
  projection_sha256: string;
}

export interface WorkloadAdmissionTargetBundleV1 {
  schema_version: typeof WORKLOAD_ADMISSION_TARGET_BUNDLE_SCHEMA_VERSION;
  calyx_build: {
    git_head: string;
    package_version: string;
  };
  state_schema_target: string;
}

export interface WorkloadAdmissionGateReceiptV1 {
  schema_version: typeof WORKLOAD_ADMISSION_GATE_RECEIPT_SCHEMA_VERSION;
  profile: typeof WORKLOAD_ADMISSION_INTERIM_PROFILE;
  evaluated_surfaces: [...typeof WORKLOAD_ADMISSION_INTERIM_SURFACES];
  deferred_surfaces: FleetTopologyExpectedSurface[];
  host: string;
  desired_membership: "active";
  topology: WorkloadAdmissionTopologyIdentityV1;
  target_bundle: WorkloadAdmissionTargetBundleV1;
  checks: {
    topology: {
      status: "pass";
      authority: "authoritative";
    };
    reachability: {
      status: "pass";
      evidence: "daemon_listener" | "in_process_composition";
    };
    running: {
      status: "pass";
      git_head: string;
      package_version: string;
      dirty: false;
    };
    state_schema: {
      status: "pass";
      current: string;
      target: string;
    };
  };
  issued_at: string;
}

export type WorkloadAdmissionDecisionV1 = {
  schema_version: typeof WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION;
  admission: "fenced";
  reason: WorkloadAdmissionFenceReason;
  failed_surface: FleetTopologyExpectedSurface | "admission_evidence";
  next_action: string;
  last_accepted_topology?: WorkloadAdmissionTopologyIdentityV1;
  last_accepted_target_bundle?: WorkloadAdmissionTargetBundleV1;
  last_gate_receipt?: WorkloadAdmissionGateReceiptV1;
  decided_at: string;
} | {
  schema_version: typeof WORKLOAD_ADMISSION_DECISION_SCHEMA_VERSION;
  admission: "open";
  accepted_topology: WorkloadAdmissionTopologyIdentityV1;
  accepted_target_bundle: WorkloadAdmissionTargetBundleV1;
  gate_receipt: WorkloadAdmissionGateReceiptV1;
  decided_at: string;
};

export interface WorkloadAdmissionReconcileRequest {
  host: string;
}

export type WorkloadAdmissionReconciler = (
  request: WorkloadAdmissionReconcileRequest,
) => Promise<WorkloadAdmissionGateReceiptV1>;

export class WorkloadAdmissionEvidenceError extends Error {
  readonly reason: WorkloadAdmissionFenceReason;
  readonly failedSurface: FleetTopologyExpectedSurface | "admission_evidence";
  readonly nextAction: string;

  constructor(args: {
    reason: WorkloadAdmissionFenceReason;
    failedSurface: FleetTopologyExpectedSurface | "admission_evidence";
    nextAction: string;
    message: string;
  }) {
    super(args.message);
    this.name = "WorkloadAdmissionEvidenceError";
    this.reason = args.reason;
    this.failedSurface = args.failedSurface;
    this.nextAction = args.nextAction;
  }
}

export interface InterimWorkloadAdmissionReconcilerOptions {
  build: CalyxBuildInfo;
  reachability: "daemon_listener" | "in_process_composition";
  agentsInfraRoot?: string;
  stateStoreOptions?: StateOpenOptions;
  now?: () => Date;
}

function refuseEvidence(args: ConstructorParameters<typeof WorkloadAdmissionEvidenceError>[0]): never {
  throw new WorkloadAdmissionEvidenceError(args);
}

/**
 * Build the deliberately reduced D1 admission receipt from authorities that
 * exist today. Topology is resolved fresh on every call; schema is read-only;
 * the running build is admitted only when its stamped identity is clean.
 */
export function createInterimWorkloadAdmissionReconciler(
  options: InterimWorkloadAdmissionReconcilerOptions,
): WorkloadAdmissionReconciler {
  return async ({ host }) => {
    const snapshot = await loadFleetTopologySnapshot({
      ...(options.agentsInfraRoot ? { agentsInfraRoot: options.agentsInfraRoot } : {}),
      sourceAuthority: "resolved_ref",
    });
    if (
      snapshot.authority.status !== "authoritative"
      || snapshot.validation.status !== "valid"
      || !snapshot.source.commit
      || !snapshot.projection_sha256
    ) {
      refuseEvidence({
        reason: "admission_evidence_missing",
        failedSurface: "topology",
        nextAction: "Restore the canonical agents-infra authority checkout, then retry the launch to rerun workload-admission reconciliation.",
        message: `Authoritative fleet topology is unavailable: ${snapshot.authority.reasons.join(", ") || snapshot.validation.status}.`,
      });
    }
    const hostRecord = snapshot.hosts[host];
    if (!hostRecord || hostRecord.desired_membership !== "active") {
      refuseEvidence({
        reason: hostRecord?.desired_membership === "withdrawn" ? "withdrawn" : "topology_mismatch",
        failedSurface: "topology",
        nextAction: hostRecord?.desired_membership === "withdrawn"
          ? "Reactivate this host through the authoritative fleet lifecycle operation, then retry the launch."
          : "Add this host to authoritative desired-active topology, then retry the launch.",
        message: hostRecord
          ? `Host ${host} is withdrawn in topology ${snapshot.projection_sha256}.`
          : `Host ${host} is not enrolled in topology ${snapshot.projection_sha256}.`,
      });
    }
    if (
      options.build.dirty
      || !options.build.git_head.trim()
      || !options.build.package_version.trim()
    ) {
      refuseEvidence({
        reason: "convergence_drift",
        failedSurface: "running",
        nextAction: `Run \`calyx self upgrade --host ${host} --yes --json\`, then retry the launch.`,
        message: "The running Calyx build does not have a clean stamped identity.",
      });
    }
    let migrationPlan;
    try {
      migrationPlan = await planStateMigrations({
        ...(options.stateStoreOptions ? { storeOptions: options.stateStoreOptions } : {}),
      });
    } catch (error) {
      refuseEvidence({
        reason: "admission_evidence_missing",
        failedSurface: "state_schema",
        nextAction: "Run `calyx state doctor --json`, repair the reported state-store failure, then retry the launch.",
        message: `State-schema evidence is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
      });
    }
    if (
      !migrationPlan.current
      || !migrationPlan.target
      || migrationPlan.current !== migrationPlan.target
      || migrationPlan.pending.length > 0
    ) {
      refuseEvidence({
        reason: "convergence_drift",
        failedSurface: "state_schema",
        nextAction: "Run `calyx state migrate --apply --json`, then retry the launch.",
        message: `State schema is not current for the running build (current=${migrationPlan.current ?? "none"}, target=${migrationPlan.target ?? "none"}).`,
      });
    }

    return {
      schema_version: WORKLOAD_ADMISSION_GATE_RECEIPT_SCHEMA_VERSION,
      profile: WORKLOAD_ADMISSION_INTERIM_PROFILE,
      evaluated_surfaces: [...WORKLOAD_ADMISSION_INTERIM_SURFACES],
      deferred_surfaces: [...WORKLOAD_ADMISSION_INTERIM_DEFERRED_SURFACES],
      host,
      desired_membership: "active",
      topology: {
        schema_version: FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION,
        source_repository: FLEET_TOPOLOGY_SOURCE_REPOSITORY,
        source_commit: snapshot.source.commit,
        projection_sha256: snapshot.projection_sha256,
      },
      target_bundle: {
        schema_version: WORKLOAD_ADMISSION_TARGET_BUNDLE_SCHEMA_VERSION,
        calyx_build: {
          git_head: options.build.git_head,
          package_version: options.build.package_version,
        },
        state_schema_target: migrationPlan.target,
      },
      checks: {
        topology: { status: "pass", authority: "authoritative" },
        reachability: { status: "pass", evidence: options.reachability },
        running: {
          status: "pass",
          git_head: options.build.git_head,
          package_version: options.build.package_version,
          dirty: false,
        },
        state_schema: {
          status: "pass",
          current: migrationPlan.current,
          target: migrationPlan.target,
        },
      },
      issued_at: (options.now?.() ?? new Date()).toISOString(),
    };
  };
}
