import type {
  ApiProvenanceV1,
  WorkloadAdmissionDecisionV1,
  WorkloadAdmissionGateReceiptV1,
  WorkloadAdmissionReconciler,
} from "@polli-labs/calyx-core";
import {
  RunService as ProductionRunService,
  type RunIntent,
  type RunServiceDependencies,
  type RunServiceOptions,
} from "@polli-labs/calyx-run-service";

interface InitializeRunForTestOptions {
  creationProvenance?: ApiProvenanceV1 | undefined;
  launchMode?: "inline" | "detached" | undefined;
  admissionIdentity?: string | undefined;
  requestHash?: string | undefined;
  acceptedAt?: string | undefined;
}

export const TEST_TOPOLOGY_PROJECTION_SHA256 = "a".repeat(64);

export function passingTestWorkloadAdmissionReceipt(host = "blade"): WorkloadAdmissionGateReceiptV1 {
  return {
    schema_version: "calyx.workload-admission-gate-receipt/v1",
    profile: "d1-interim-topology-reachability-build-schema",
    evaluated_surfaces: ["topology", "reachability", "running", "state_schema"],
    deferred_surfaces: [
      "toolchain",
      "clone",
      "promoted",
      "daemon",
      "config",
      "skills",
      "hot_instruction",
    ],
    host,
    desired_membership: "active",
    topology: {
      schema_version: "fleet-topology-snapshot/v1",
      source_repository: "polli-labs/agents-infra",
      source_commit: "b".repeat(40),
      projection_sha256: TEST_TOPOLOGY_PROJECTION_SHA256,
    },
    target_bundle: {
      schema_version: "calyx.workload-admission-target-bundle/v1",
      calyx_build: {
        git_head: "c".repeat(40),
        package_version: "0.2.0-test",
      },
      state_schema_target: "0027_test",
    },
    checks: {
      topology: { status: "pass", authority: "authoritative" },
      reachability: { status: "pass", evidence: "in_process_composition" },
      running: {
        status: "pass",
        git_head: "c".repeat(40),
        package_version: "0.2.0-test",
        dirty: false,
      },
      state_schema: {
        status: "pass",
        current: "0027_test",
        target: "0027_test",
      },
    },
    issued_at: "2026-08-02T12:00:00.000Z",
  };
}

export function passingTestWorkloadAdmissionDecision(host = "blade"): WorkloadAdmissionDecisionV1 {
  const gateReceipt = passingTestWorkloadAdmissionReceipt(host);
  return {
    schema_version: "calyx.workload-admission-decision/v1",
    admission: "open",
    accepted_topology: gateReceipt.topology,
    accepted_target_bundle: gateReceipt.target_bundle,
    gate_receipt: gateReceipt,
    decided_at: "2026-08-02T12:00:01.000Z",
  };
}

const passingTestWorkloadAdmissionReconciler: WorkloadAdmissionReconciler =
  async ({ host }) => passingTestWorkloadAdmissionReceipt(host);

/** Test-only composition with an explicit passing receipt, never a runtime bypass. */
export class RunService extends ProductionRunService {
  constructor(
    options: RunServiceOptions = {},
    deps: Partial<RunServiceDependencies> = {},
  ) {
    super({
      ...options,
      workloadAdmission: options.workloadAdmission ?? {
        reconcile: passingTestWorkloadAdmissionReconciler,
      },
    }, deps);
  }

  /** Test-state seeding that still crosses production workload admission. */
  initializeRun(intent: RunIntent, options: InitializeRunForTestOptions = {}) {
    return super.initializeRun(intent, options);
  }
}
