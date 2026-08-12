import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

/**
 * C1's deliberately narrow slice of the fleet-convergence check contract.
 * The closed surface contains only `toolchain`; C2 owns the complete check
 * suite and aggregate verdict described by the fleet-convergence RFC.
 */
export const FLEET_CONVERGENCE_CHECK_SCHEMA_VERSION = "fleet-convergence-check/v1";
const SELF_UPGRADE_CHILD_SPAWN_CONTRACT =
  "@polli-labs/calyx/self-upgrade-child-spawn@v1";

const nonEmptyString = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

function satisfiesNodeRange(version: string | undefined, range: string | null): boolean {
  const normalizedVersion = valid(version ?? "");
  const normalizedRange = range ? validRange(range) : null;
  return Boolean(normalizedVersion && normalizedRange && satisfies(normalizedVersion, normalizedRange));
}

function matchesDeclaredPnpmVersion(
  observed: string | undefined,
  expected: string | null,
): boolean {
  return Boolean(
    expected
    && valid(expected)
    && observed
    && valid(observed)
    && observed === expected,
  );
}

const executableObservationSchema = z.object({
  executable_realpath: nonEmptyString.optional(),
  version: nonEmptyString.optional(),
  exit_code: z.number().int(),
  error: nonEmptyString.optional(),
}).strict();

const versionObservationSchema = z.object({
  version: nonEmptyString.optional(),
  exit_code: z.number().int(),
  error: nonEmptyString.optional(),
}).strict();

const pnpmObservationSchema = z.object({
  executable_realpath: nonEmptyString.optional(),
  resolution_source: z.literal("pnpm-exec-node-path"),
  self_dispatched: versionObservationSchema,
  intrinsic: versionObservationSchema.extend({
    probe: z.enum(["with-current", "manage-package-manager-versions-disabled"]),
  }).strict(),
  nested: versionObservationSchema,
}).strict();

const pathResolutionEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  directory: nonEmptyString,
  node_candidate: nonEmptyString.optional(),
  pnpm_candidate: nonEmptyString.optional(),
}).strict();

export const fleetConvergenceToolchainCheckSchema = z.object({
  schema_version: z.literal(FLEET_CONVERGENCE_CHECK_SCHEMA_VERSION),
  surface: z.literal("toolchain"),
  status: z.enum(["pass", "drift", "blocked", "unavailable", "unknown", "not_expected"]),
  host: nonEmptyString,
  expected: z.object({
    node_range: nonEmptyString.nullable(),
    package_manager: z.literal("pnpm").optional(),
    pnpm_version: nonEmptyString.nullable(),
  }).strict(),
  observed: z.object({
    process_exec_path_realpath: nonEmptyString.optional(),
    process_node_version: nonEmptyString.optional(),
    child_node: executableObservationSchema,
    child_pnpm: pnpmObservationSchema,
    bootstrap_cwd: nonEmptyString,
    spawn_contract: nonEmptyString,
    environment_contract: z.literal("self-upgrade-bootstrap-isolated-env/v1"),
    path_resolution: z.object({
      observer: z.literal("parent_diagnostic"),
      total_entries: z.number().int().nonnegative(),
      truncated: z.boolean(),
      entries: z.array(pathResolutionEntrySchema).max(32),
    }).strict(),
  }).strict(),
  failures: z.array(z.object({
    code: z.enum([
      "package_contract_unreadable",
      "target_bundle_unavailable",
      "process_node_unreadable",
      "process_node_contract_mismatch",
      "child_node_unavailable",
      "child_node_contract_mismatch",
      "child_pnpm_unavailable",
      "child_pnpm_identity_unavailable",
      "child_pnpm_version_mismatch",
      "child_pnpm_intrinsic_version_mismatch",
      "nested_pnpm_version_mismatch",
    ]),
    message: nonEmptyString,
  }).strict()).max(16),
  checked_at: timestamp,
  evidence: z.object({
    source: z.enum(["self-upgrade-bootstrap-attestation", "unobserved"]),
    spawn_contract: nonEmptyString,
  }).strict(),
  freshness: z.object({
    status: z.enum(["current", "recalled", "unobserved"]),
    observed_at: timestamp.optional(),
  }).strict(),
  repair_owner: z.literal("fleet_ops").optional(),
  next_action: z.object({
    kind: z.enum(["repair_toolchain", "run_self_upgrade_preflight"]),
    description: nonEmptyString,
  }).strict().optional(),
  topology_identity: z.object({
    status: z.literal("not_bound"),
  }).strict(),
  target_bundle_identity: z.object({
    calyx_source_sha: z.string().regex(/^[0-9a-f]{40}$/iu).nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.status === "pass" && value.failures.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check cannot contain failures",
      path: ["failures"],
    });
  }
  if (value.status === "pass" && [
    value.observed.child_node.error,
    value.observed.child_pnpm.self_dispatched.error,
    value.observed.child_pnpm.intrinsic.error,
    value.observed.child_pnpm.nested.error,
  ].some(Boolean)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check cannot contain observation errors",
      path: ["observed"],
    });
  }
  if (value.status === "pass" && (value.repair_owner || value.next_action)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check cannot request a repair action",
      path: ["next_action"],
    });
  }
  if (value.status === "pass" && (
    value.expected.node_range === null
    || value.expected.package_manager !== "pnpm"
    || value.expected.pnpm_version === null
    || !value.observed.process_exec_path_realpath
    || !value.observed.process_node_version
    || value.observed.child_node.exit_code !== 0
    || !value.observed.child_node.executable_realpath
    || !value.observed.child_node.version
    || !value.observed.child_pnpm.executable_realpath
    || value.observed.child_pnpm.self_dispatched.exit_code !== 0
    || !value.observed.child_pnpm.self_dispatched.version
    || value.observed.child_pnpm.intrinsic.exit_code !== 0
    || !value.observed.child_pnpm.intrinsic.version
    || value.observed.child_pnpm.nested.exit_code !== 0
    || !value.observed.child_pnpm.nested.version
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check must contain complete child Node and pnpm identity evidence",
      path: ["observed"],
    });
  }
  if (value.status === "pass" && (
    value.evidence.source !== "self-upgrade-bootstrap-attestation"
    || value.evidence.spawn_contract !== SELF_UPGRADE_CHILD_SPAWN_CONTRACT
    || value.observed.spawn_contract !== SELF_UPGRADE_CHILD_SPAWN_CONTRACT
    || value.evidence.spawn_contract !== value.observed.spawn_contract
    || value.freshness.status !== "current"
    || value.freshness.observed_at !== value.checked_at
    || value.target_bundle_identity.calyx_source_sha === null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check must prove the current bootstrap attestation, exact spawn contract, fresh observation, and target source SHA",
      path: ["evidence"],
    });
  }
  if (value.status === "pass" && value.expected.pnpm_version && (
    value.observed.child_pnpm.self_dispatched.version !== value.expected.pnpm_version
    || value.observed.child_pnpm.intrinsic.version !== value.expected.pnpm_version
    || value.observed.child_pnpm.nested.version !== value.expected.pnpm_version
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check must bind every pnpm child identity to the declared packageManager pin",
      path: ["observed", "child_pnpm"],
    });
  }
  if (value.status === "pass" && (
    !value.expected.node_range
    || !validRange(value.expected.node_range)
    || !value.expected.pnpm_version
    || !valid(value.expected.pnpm_version)
    || !satisfiesNodeRange(value.observed.process_node_version, value.expected.node_range)
    || !satisfiesNodeRange(value.observed.child_node.version, value.expected.node_range)
    || !matchesDeclaredPnpmVersion(
      value.observed.child_pnpm.self_dispatched.version,
      value.expected.pnpm_version,
    )
    || !matchesDeclaredPnpmVersion(
      value.observed.child_pnpm.intrinsic.version,
      value.expected.pnpm_version,
    )
    || !matchesDeclaredPnpmVersion(
      value.observed.child_pnpm.nested.version,
      value.expected.pnpm_version,
    )
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a passing toolchain check must semantically satisfy the declared Node range and exact pnpm pin",
      path: ["observed"],
    });
  }
  if (value.status === "blocked" && value.failures.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a blocked toolchain check must contain at least one failure",
      path: ["failures"],
    });
  }
  if (value.status !== "pass" && (!value.repair_owner || !value.next_action)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a non-passing toolchain check must name repair_owner and next_action",
    });
  }
  if (value.freshness.status === "current" && value.freshness.observed_at !== value.checked_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a current toolchain check must bind freshness.observed_at to checked_at",
      path: ["freshness", "observed_at"],
    });
  }
  if (value.freshness.status === "recalled" && !value.freshness.observed_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a recalled toolchain check must retain the original observation timestamp",
      path: ["freshness", "observed_at"],
    });
  }
  if (value.freshness.status === "unobserved" && value.freshness.observed_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an unobserved toolchain check cannot claim an observation timestamp",
      path: ["freshness", "observed_at"],
    });
  }
});

export type FleetConvergenceToolchainCheck = z.infer<
  typeof fleetConvergenceToolchainCheckSchema
>;
