import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  open,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fleetConvergenceToolchainCheckSchema } from "./fleet-convergence-check.js";
import {
  openExistingDirectoryDurable,
  openPrivateDirectoryDurable,
  type DurableDirectoryAnchor,
  type DurableDirectoryOpenOptions,
} from "./durable-directory.js";

/**
 * Bounded conductor-side observation of one fleet self-upgrade.
 *
 * Host-local durable operation evidence and verified final receipts decide
 * mutation truth. This record, remote NDJSON, event-log copies, heartbeats,
 * status/watch, and terminal rendering are fail-open projections; none can
 * authorize dispatch or decide whether a host or fleet upgrade succeeded.
 */
export const SELF_UPGRADE_OPERATION_SCHEMA_VERSION = "self-upgrade-operation/v1";
export const SELF_UPGRADE_OPERATION_DIRECTORY_MODE = 0o700;
export const SELF_UPGRADE_OPERATION_FILE_MODE = 0o600;
export const SELF_UPGRADE_OPERATION_STALE_TEMP_MS = 24 * 60 * 60 * 1_000;
export const SELF_UPGRADE_OPERATION_STALE_OWNER_MS = 24 * 60 * 60 * 1_000;
export const SELF_UPGRADE_OPERATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const SELF_UPGRADE_OPERATION_RETENTION_COUNT = 256;
export const SELF_UPGRADE_OPERATION_MAX_HOSTS = 256;
export const SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST = 32;
export const SELF_UPGRADE_OPERATION_MAX_TRANSITIONS = 10_000;
export const SELF_UPGRADE_OPERATION_MAX_DURABILITY_ISSUES = 256;
export const SELF_UPGRADE_OPERATION_MAX_BYTES = 64 * 1024 * 1024;
export const SELF_UPGRADE_OPERATION_OWNER_MAX_BYTES = 64 * 1024;
const SELF_UPGRADE_OWNER_RESTORE_WINDOW_MS = 250;
const SELF_UPGRADE_OWNER_RESTORE_RETRY_MS = 10;

export const SELF_UPGRADE_OPERATION_PHASES = [
  "fetch",
  "build",
  "prepare",
  "supervisor_ready",
  "drain",
  "state_snapshot",
  "supervisor_install",
  "promote",
  "restart",
  "health_wait",
  "rollback",
  "finalize",
] as const;

export const selfUpgradeOperationPhaseSchema = z.enum(SELF_UPGRADE_OPERATION_PHASES);
export type SelfUpgradeOperationPhase = z.infer<typeof selfUpgradeOperationPhaseSchema>;

export const selfUpgradeHostExecutionStatusSchema = z.enum([
  "pending",
  "dry-run",
  "succeeded",
  "unverified",
  "failed",
  "skipped",
]);
export type SelfUpgradeHostExecutionStatus = z.infer<typeof selfUpgradeHostExecutionStatusSchema>;

export const selfUpgradeRelayModeSchema = z.enum([
  "pending",
  "stream",
  "legacy",
  "local",
  "missing",
]);
export type SelfUpgradeRelayMode = z.infer<typeof selfUpgradeRelayModeSchema>;

const nonEmptyString = z.string().trim().min(1);
const operationId = z.string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u);
const timestamp = z.string().datetime({ offset: true });
const nonNegativeInteger = z.number().int().nonnegative();
const fullSha = z.string().regex(/^[0-9a-f]{40}$/iu);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/iu);
const transitionBase = {
  schema_version: z.literal(SELF_UPGRADE_OPERATION_SCHEMA_VERSION),
  record: z.literal("transition"),
  transition_id: nonEmptyString,
  operation_id: operationId,
  emitted_at: timestamp,
  observed_at: timestamp,
};

export const selfUpgradeReceiptLocatorSchema = z.object({
  host: nonEmptyString,
  route: z.string()
    .min(1)
    .max(4_096)
    .regex(/^\/v1\/admin\/self-upgrade-receipts\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u),
}).strict();

const projectedReceiptVerificationSchema = z.object({
  status: z.literal("unavailable"),
  code: z.enum([
    "conductor_auth_unavailable",
    "transport_unavailable",
    "route_unavailable",
    "receipt_binding_unavailable",
  ]),
  attempts: nonNegativeInteger,
  message: nonEmptyString.optional(),
}).strict();

const finalRowSchema = z.object({
  host: nonEmptyString,
  status: selfUpgradeHostExecutionStatusSchema.exclude(["pending"]),
  before_head: fullSha.optional(),
  after_head: fullSha.optional(),
  elapsed_ms: nonNegativeInteger.optional(),
  receipt_locator: selfUpgradeReceiptLocatorSchema.optional(),
  freshness_verdict: z.enum(["fresh", "usable_with_warnings", "stale", "blocked"]).optional(),
}).strict();

const durabilityIssueSchema = z.object({
  issue_id: nonEmptyString,
  observed_at: timestamp,
  scope: z.enum(["operation_state", "final_receipt", "event_log", "progress_output", "artifact"]),
  code: nonEmptyString,
  message: nonEmptyString,
  transition_id: nonEmptyString.optional(),
}).strict();

const hostPhaseTransitionSchema = z.object({
  ...transitionBase,
  kind: z.literal("host_phase"),
  host: nonEmptyString,
  host_operation_id: operationId,
  source_event_id: nonEmptyString.optional(),
  source_cursor: nonEmptyString.optional(),
  source: z.enum(["host_event", "local_event", "legacy_final_receipt"]),
  phase: selfUpgradeOperationPhaseSchema,
  elapsed_ms: nonNegativeInteger,
  synthetic: z.boolean(),
}).strict();

const selfUpgradeOperationTransitionUnion = z.discriminatedUnion("kind", [
  z.object({
    ...transitionBase,
    kind: z.literal("host_dispatched"),
    host: nonEmptyString,
    dispatch: z.enum(["ssh", "local"]),
  }).strict(),
  hostPhaseTransitionSchema,
  z.object({
    ...transitionBase,
    kind: z.literal("host_relay_degraded"),
    host: nonEmptyString,
    reason: z.enum(["pre_relay_binary", "frame_budget_exceeded", "projection_unavailable"]),
  }).strict(),
  z.object({
    ...transitionBase,
    kind: z.literal("host_result"),
    host: nonEmptyString,
    status: selfUpgradeHostExecutionStatusSchema.exclude(["pending"]),
    elapsed_ms: nonNegativeInteger,
    relay_mode: selfUpgradeRelayModeSchema.exclude(["pending"]),
    before_head: fullSha.optional(),
    after_head: fullSha.optional(),
    receipt_locator: selfUpgradeReceiptLocatorSchema.optional(),
    toolchain_check: fleetConvergenceToolchainCheckSchema.optional(),
    /** Non-authoritative remote projection retained when canonical reread is unavailable. */
    projected_receipt_path: nonEmptyString.max(4_096).optional(),
    projected_toolchain_check: fleetConvergenceToolchainCheckSchema.optional(),
    receipt_verification: projectedReceiptVerificationSchema.optional(),
    error: nonEmptyString.optional(),
  }).strict(),
  z.object({
    ...transitionBase,
    kind: z.literal("fleet_final"),
    status: z.enum(["dry-run", "succeeded", "unverified", "failed"]),
    receipt_path: nonEmptyString,
    rows: z.array(finalRowSchema),
  }).strict(),
]);

export const selfUpgradeOperationTransitionSchema = selfUpgradeOperationTransitionUnion
  .superRefine((value, context) => {
    if (value.kind !== "host_phase") {
      return;
    }
    if (value.transition_id !== selfUpgradeHostPhaseTransitionId(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host phase transition_id must content-address the complete phase observation",
      });
    }
    if (value.source === "legacy_final_receipt") {
      if (!value.synthetic || value.source_event_id || value.source_cursor) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "legacy final-receipt phases must be synthetic and cannot claim a source event",
        });
      }
      return;
    }
    if (value.synthetic || !value.source_event_id || !value.source_cursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "relayed durable phases require source_event_id/source_cursor and cannot be synthetic",
      });
    }
  });

export type SelfUpgradeOperationTransition = z.infer<typeof selfUpgradeOperationTransitionSchema>;
export type SelfUpgradeHostPhaseTransition = Extract<SelfUpgradeOperationTransition, { kind: "host_phase" }>;

/**
 * Content-address one complete phase observation. A remote cannot reuse an
 * identity for conflicting bytes and then exploit bounded eviction to make
 * replay arrival-dependent; any changed semantic field is a distinct id.
 */
export function selfUpgradeHostPhaseTransitionId(
  value: Omit<SelfUpgradeHostPhaseTransition, "transition_id">,
): string {
  return selfUpgradeTransitionId([
    value.schema_version,
    value.record,
    value.kind,
    value.operation_id,
    value.emitted_at,
    value.observed_at,
    value.host,
    value.host_operation_id,
    value.source_event_id ?? "",
    value.source_cursor ?? "",
    value.source,
    value.phase,
    String(value.elapsed_ms),
    String(value.synthetic),
  ]);
}

export type SelfUpgradeOperationFinalRow = z.infer<typeof finalRowSchema>;

const hostStateSchema = z.object({
  host: nonEmptyString,
  dispatch: z.enum(["ssh", "local"]).optional(),
  execution_status: selfUpgradeHostExecutionStatusSchema,
  relay_mode: selfUpgradeRelayModeSchema,
  relay_truncated: z.boolean().optional(),
  latest_phase: selfUpgradeOperationPhaseSchema.optional(),
  latest_phase_elapsed_ms: nonNegativeInteger.optional(),
  latest_phase_transition_id: nonEmptyString.optional(),
  elapsed_ms: nonNegativeInteger.optional(),
  before_head: fullSha.optional(),
  after_head: fullSha.optional(),
  receipt_locator: selfUpgradeReceiptLocatorSchema.optional(),
  toolchain_check: fleetConvergenceToolchainCheckSchema.optional(),
  projected_receipt_path: nonEmptyString.max(4_096).optional(),
  projected_toolchain_check: fleetConvergenceToolchainCheckSchema.optional(),
  receipt_verification: projectedReceiptVerificationSchema.optional(),
  error: nonEmptyString.optional(),
}).strict();

export type SelfUpgradeOperationHostState = z.infer<typeof hostStateSchema>;

export const selfUpgradeOperationTopologySnapshotSchema = z.object({
  schema_version: z.literal("fleet-topology-snapshot/v1"),
  source: z.object({
    commit: fullSha,
  }).strict(),
  projection_sha256: sha256,
}).strict();

export type SelfUpgradeOperationTopologySnapshot = z.infer<
  typeof selfUpgradeOperationTopologySnapshotSchema
>;

export const selfUpgradeOperationRecordSchema = z.object({
  schema_version: z.literal(SELF_UPGRADE_OPERATION_SCHEMA_VERSION),
  operation_id: operationId,
  writer_id: nonEmptyString,
  revision: nonNegativeInteger,
  conductor_host: nonEmptyString,
  target_ref: nonEmptyString,
  target_sha: fullSha.optional(),
  topology_snapshot: selfUpgradeOperationTopologySnapshotSchema.optional(),
  policy: z.object({
    dry_run: z.boolean(),
    parallel: z.boolean(),
    fail_fast: z.boolean(),
  }).strict(),
  started_at: timestamp,
  updated_at: timestamp,
  status: z.enum(["running", "dry-run", "succeeded", "unverified", "failed"]),
  hosts: z.record(nonEmptyString, hostStateSchema).superRefine((value, context) => {
    if (Object.keys(value).length > SELF_UPGRADE_OPERATION_MAX_HOSTS) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: SELF_UPGRADE_OPERATION_MAX_HOSTS,
        inclusive: true,
        message: `self-upgrade operations support at most ${SELF_UPGRADE_OPERATION_MAX_HOSTS} hosts`,
      });
    }
  }),
  transitions: z.array(selfUpgradeOperationTransitionSchema).max(SELF_UPGRADE_OPERATION_MAX_TRANSITIONS),
  durability_issues: z.array(durabilityIssueSchema).max(SELF_UPGRADE_OPERATION_MAX_DURABILITY_ISSUES),
  final_receipt_path: nonEmptyString.optional(),
  final_rows: z.array(finalRowSchema).optional(),
}).strict();

export type SelfUpgradeOperationRecord = z.infer<typeof selfUpgradeOperationRecordSchema>;
export type SelfUpgradeReceiptLocator = z.infer<typeof selfUpgradeReceiptLocatorSchema>;
export type SelfUpgradeOperationDurabilityIssue = z.infer<typeof durabilityIssueSchema>;

export type SelfUpgradeOperationOwnerLiveness = "live" | "dead" | "released" | "unknown";
export type SelfUpgradeOperationRunningState = "active" | "orphaned" | "indeterminate" | "terminal";

/**
 * Read-only status projection over the existing U4 operation record.
 *
 * This envelope reports whether the conductor projection is readable and
 * whether its writer generation still exists. It does not elevate the record
 * above host-local durable state or a verified final receipt.
 */
export interface SelfUpgradeOperationObservation {
  operation: SelfUpgradeOperationRecord;
  observed_at: string;
  projection_status: "available" | "degraded";
  running_state: SelfUpgradeOperationRunningState;
  owner_liveness: SelfUpgradeOperationOwnerLiveness;
  owner_pid?: number;
  owner_claimed_at?: string;
}

export interface ObserveSelfUpgradeOperationOptions {
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  readProcessIdentity?: (pid: number) => Promise<string | undefined>;
  directoryOpenOptions?: DurableDirectoryOpenOptions;
}

export type DiscoverSelfUpgradeOperationOptions = ObserveSelfUpgradeOperationOptions;

export type SelfUpgradeTransitionDisposition = "applied" | "duplicate" | "conflict" | "bounded_drop";

export interface SelfUpgradeTransitionApplication {
  record: SelfUpgradeOperationRecord;
  disposition: SelfUpgradeTransitionDisposition;
  changed_host?: string;
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  return (left ?? "").localeCompare(right ?? "");
}

function transitionSort(left: SelfUpgradeOperationTransition, right: SelfUpgradeOperationTransition): number {
  if (left.kind === "fleet_final" && right.kind !== "fleet_final") {
    return 1;
  }
  if (right.kind === "fleet_final" && left.kind !== "fleet_final") {
    return -1;
  }
  const kindOrder: Record<SelfUpgradeOperationTransition["kind"], number> = {
    host_dispatched: 0,
    host_phase: 1,
    host_relay_degraded: 2,
    host_result: 3,
    fleet_final: 4,
  };
  return left.emitted_at.localeCompare(right.emitted_at)
    || compareOptional("host" in left ? left.host : undefined, "host" in right ? right.host : undefined)
    || kindOrder[left.kind] - kindOrder[right.kind]
    || ((left.kind === "host_phase" ? left.elapsed_ms : -1) - (right.kind === "host_phase" ? right.elapsed_ms : -1))
    || left.transition_id.localeCompare(right.transition_id);
}

function normalizedTransition(value: unknown): SelfUpgradeOperationTransition {
  return selfUpgradeOperationTransitionSchema.parse(value);
}

function transitionFingerprint(transition: SelfUpgradeOperationTransition): string {
  // Zod normalization above fixes key order and strips no fields because every
  // transition schema is strict. This comparison therefore distinguishes a
  // true replay from a conflicting reuse of one transition identity.
  return JSON.stringify(transition);
}

function phaseComesAfter(
  candidate: SelfUpgradeHostPhaseTransition,
  current: SelfUpgradeHostPhaseTransition | undefined,
): boolean {
  if (!current) {
    return true;
  }
  return candidate.elapsed_ms > current.elapsed_ms
    || (candidate.elapsed_ms === current.elapsed_ms && candidate.emitted_at > current.emitted_at)
    || (
      candidate.elapsed_ms === current.elapsed_ms
      && candidate.emitted_at === current.emitted_at
      && candidate.transition_id > current.transition_id
    );
}

function reduceOperationHosts(
  initialHosts: readonly string[],
  transitions: readonly SelfUpgradeOperationTransition[],
): Record<string, SelfUpgradeOperationHostState> {
  const hosts: Record<string, SelfUpgradeOperationHostState> = Object.fromEntries(
    initialHosts.map((host) => [host, {
      host,
      execution_status: "pending" as const,
      relay_mode: "pending" as const,
    }]),
  );
  const latestPhases = new Map<string, SelfUpgradeHostPhaseTransition>();

  for (const transition of transitions) {
    if (!("host" in transition)) {
      continue;
    }
    const row: SelfUpgradeOperationHostState = hosts[transition.host] ?? {
      host: transition.host,
      execution_status: "pending" as const,
      relay_mode: "pending" as const,
    };
    hosts[transition.host] = row;

    switch (transition.kind) {
      case "host_dispatched":
        row.dispatch = transition.dispatch;
        if (transition.dispatch === "local") {
          row.relay_mode = "local";
        }
        break;
      case "host_phase": {
        if (transition.source === "host_event") {
          row.relay_mode = "stream";
        } else if (transition.source === "local_event") {
          row.relay_mode = "local";
        } else {
          row.relay_mode = "legacy";
        }
        const current = latestPhases.get(transition.host);
        if (phaseComesAfter(transition, current)) {
          latestPhases.set(transition.host, transition);
          row.latest_phase = transition.phase;
          row.latest_phase_elapsed_ms = transition.elapsed_ms;
          row.latest_phase_transition_id = transition.transition_id;
        }
        break;
      }
      case "host_relay_degraded":
        if (transition.reason === "frame_budget_exceeded") {
          row.relay_truncated = true;
        }
        if (
          transition.reason === "pre_relay_binary"
          && row.relay_mode !== "stream"
          && row.relay_mode !== "local"
        ) {
          row.relay_mode = "legacy";
        }
        break;
      case "host_result":
        row.execution_status = transition.status;
        row.elapsed_ms = transition.elapsed_ms;
        row.relay_mode = transition.relay_mode;
        if (transition.before_head) {
          row.before_head = transition.before_head;
        }
        if (transition.after_head) {
          row.after_head = transition.after_head;
        }
        if (transition.receipt_locator) {
          row.receipt_locator = transition.receipt_locator;
        }
        if (transition.toolchain_check) {
          row.toolchain_check = transition.toolchain_check;
        }
        if (transition.projected_receipt_path) {
          row.projected_receipt_path = transition.projected_receipt_path;
        }
        if (transition.projected_toolchain_check) {
          row.projected_toolchain_check = transition.projected_toolchain_check;
        }
        if (transition.receipt_verification) {
          row.receipt_verification = transition.receipt_verification;
        }
        if (transition.error) {
          row.error = transition.error;
        }
        break;
    }
  }
  return hosts;
}

function maxTimestamp(values: readonly string[]): string {
  return [...values].sort().at(-1)!;
}

function sameReceiptLocator(
  left: SelfUpgradeReceiptLocator | undefined,
  right: SelfUpgradeReceiptLocator | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finalTransitionMatchesReducedHosts(
  transition: Extract<SelfUpgradeOperationTransition, { kind: "fleet_final" }>,
  hosts: Record<string, SelfUpgradeOperationHostState>,
): boolean {
  const expectedHosts = Object.keys(hosts).sort();
  const finalHosts = transition.rows.map((row) => row.host).sort();
  if (JSON.stringify(finalHosts) !== JSON.stringify(expectedHosts)) {
    return false;
  }
  for (const row of transition.rows) {
    const host = hosts[row.host];
    if (
      !host
      || host.execution_status === "pending"
      || row.status !== host.execution_status
      || row.elapsed_ms !== host.elapsed_ms
      || row.before_head !== host.before_head
      || row.after_head !== host.after_head
      || !sameReceiptLocator(row.receipt_locator, host.receipt_locator)
      || (row.receipt_locator && row.receipt_locator.host !== row.host)
    ) {
      return false;
    }
  }
  if (transition.status === "succeeded") {
    return Object.values(hosts).every((host) => host.execution_status === "succeeded");
  }
  if (transition.status === "dry-run") {
    return Object.values(hosts).every((host) => host.execution_status === "dry-run");
  }
  if (transition.status === "unverified") {
    return Object.values(hosts).every((host) => (
      host.execution_status === "succeeded" || host.execution_status === "unverified"
    )) && Object.values(hosts).some((host) => host.execution_status === "unverified");
  }
  return true;
}

function rebuildOperationRecord(
  current: SelfUpgradeOperationRecord,
  transitions: readonly SelfUpgradeOperationTransition[],
): SelfUpgradeOperationRecord {
  const sorted = [...transitions].sort(transitionSort);
  const final = sorted.filter(
    (candidate): candidate is Extract<SelfUpgradeOperationTransition, { kind: "fleet_final" }> => (
      candidate.kind === "fleet_final"
    ),
  ).at(-1);
  return selfUpgradeOperationRecordSchema.parse({
    ...current,
    updated_at: maxTimestamp([
      current.started_at,
      current.updated_at,
      ...sorted.flatMap((candidate) => [candidate.emitted_at, candidate.observed_at]),
    ]),
    status: final?.status ?? "running",
    hosts: reduceOperationHosts(Object.keys(current.hosts), sorted),
    transitions: sorted,
    ...(final ? { final_receipt_path: final.receipt_path, final_rows: final.rows } : {}),
  });
}

export function createSelfUpgradeOperation(args: {
  operationId: string;
  writerId: string;
  conductorHost: string;
  targetRef: string;
  targetSha?: string;
  topologySnapshot?: SelfUpgradeOperationTopologySnapshot;
  hosts: readonly string[];
  dryRun: boolean;
  parallel: boolean;
  failFast: boolean;
  startedAt: string;
}): SelfUpgradeOperationRecord {
  const uniqueHosts = [...new Set(args.hosts)].sort();
  return selfUpgradeOperationRecordSchema.parse({
    schema_version: SELF_UPGRADE_OPERATION_SCHEMA_VERSION,
    operation_id: args.operationId,
    writer_id: args.writerId,
    revision: 0,
    conductor_host: args.conductorHost,
    target_ref: args.targetRef,
    ...(args.targetSha ? { target_sha: args.targetSha } : {}),
    ...(args.topologySnapshot ? { topology_snapshot: args.topologySnapshot } : {}),
    policy: {
      dry_run: args.dryRun,
      parallel: args.parallel,
      fail_fast: args.failFast,
    },
    started_at: args.startedAt,
    updated_at: args.startedAt,
    status: "running",
    hosts: reduceOperationHosts(uniqueHosts, []),
    transitions: [],
    durability_issues: [],
  });
}

export function appendSelfUpgradeOperationDurabilityIssue(
  current: SelfUpgradeOperationRecord,
  value: SelfUpgradeOperationDurabilityIssue,
): SelfUpgradeOperationRecord {
  const issue = durabilityIssueSchema.parse(value);
  const existing = current.durability_issues.find((candidate) => candidate.issue_id === issue.issue_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(issue)) {
      throw new Error(`Conflicting self-upgrade durability issue identity: ${issue.issue_id}`);
    }
    return current;
  }
  if (current.durability_issues.length >= SELF_UPGRADE_OPERATION_MAX_DURABILITY_ISSUES) {
    return current;
  }
  return selfUpgradeOperationRecordSchema.parse({
    ...current,
    updated_at: maxTimestamp([current.updated_at, issue.observed_at]),
    durability_issues: [...current.durability_issues, issue]
      .sort((left, right) => left.observed_at.localeCompare(right.observed_at)
        || left.issue_id.localeCompare(right.issue_id)),
  });
}

export function bindSelfUpgradeOperationTarget(
  current: SelfUpgradeOperationRecord,
  targetSha: string,
  observedAt: string,
): SelfUpgradeOperationRecord {
  if (current.target_sha && current.target_sha !== targetSha) {
    throw new Error(
      `Self-upgrade operation ${current.operation_id} is already bound to ${current.target_sha}; refusing ${targetSha}.`,
    );
  }
  return selfUpgradeOperationRecordSchema.parse({
    ...current,
    target_sha: targetSha,
    updated_at: maxTimestamp([current.updated_at, observedAt]),
  });
}

/**
 * Apply one transition by identity, then rebuild derived state from the whole
 * transition set. Replaying the same transition is a no-op; conflicting reuse
 * of an identity is ignored and reported. Because reduction never depends on
 * arrival order, delayed/reordered phase frames cannot change execution truth.
 */
export function applySelfUpgradeOperationTransition(
  current: SelfUpgradeOperationRecord,
  value: unknown,
): SelfUpgradeTransitionApplication {
  const transition = normalizedTransition(value);
  if (transition.operation_id !== current.operation_id) {
    return { record: current, disposition: "conflict" };
  }
  const existing = current.transitions.find((candidate) => candidate.transition_id === transition.transition_id);
  if (existing) {
    if (transitionFingerprint(existing) === transitionFingerprint(transition)) {
      return { record: current, disposition: "duplicate" };
    }
    if (
      current.status === "running"
      && existing.kind === "host_phase"
      && transition.kind === "host_phase"
    ) {
      const canonical = transitionFingerprint(existing).localeCompare(transitionFingerprint(transition)) <= 0
        ? existing
        : transition;
      if (canonical === transition) {
        const record = rebuildOperationRecord(
          current,
          current.transitions.map((candidate) => (
            candidate.transition_id === transition.transition_id ? transition : candidate
          )),
        );
        return {
          record,
          disposition: "conflict",
          ...(JSON.stringify(current.hosts[transition.host]) !== JSON.stringify(record.hosts[transition.host])
            ? { changed_host: transition.host }
          : {}),
        };
      }
      const updatedAt = maxTimestamp([
        current.updated_at,
        transition.emitted_at,
        transition.observed_at,
      ]);
      if (updatedAt !== current.updated_at) {
        return {
          record: selfUpgradeOperationRecordSchema.parse({
            ...current,
            updated_at: updatedAt,
          }),
          disposition: "conflict",
        };
      }
    }
    return {
      record: current,
      disposition: "conflict",
    };
  }
  // `fleet_final` freezes this observation record. A delayed stream frame may
  // still arrive at a transport boundary, but it cannot revise an already
  // rendered terminal snapshot. Exact replay was handled above, so every novel
  // post-terminal identity is a visible conflict/no-op.
  if (current.status !== "running") {
    return { record: current, disposition: "conflict" };
  }
  if ("host" in transition && !(transition.host in current.hosts)) {
    return { record: current, disposition: "conflict" };
  }
  let retainedTransitions = current.transitions;
  if (transition.kind === "host_phase") {
    const hostPhases = current.transitions.filter((candidate): candidate is SelfUpgradeHostPhaseTransition => (
      candidate.kind === "host_phase" && candidate.host === transition.host
    ));
    if (hostPhases.length >= SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST) {
      const retainedHostPhases = [...hostPhases, transition]
        .sort(transitionSort)
        .slice(-SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST);
      if (!retainedHostPhases.some((candidate) => candidate.transition_id === transition.transition_id)) {
        return { record: current, disposition: "bounded_drop" };
      }
      const retainedIds = new Set(retainedHostPhases.map((candidate) => candidate.transition_id));
      retainedTransitions = current.transitions.filter((candidate) => (
        candidate.kind !== "host_phase"
        || candidate.host !== transition.host
        || retainedIds.has(candidate.transition_id)
      ));
    }
  }
  if (
    (transition.kind === "host_dispatched" || transition.kind === "host_result")
    && current.transitions.some((candidate) => (
      candidate.kind === transition.kind && candidate.host === transition.host
    ))
  ) {
    return { record: current, disposition: "conflict" };
  }
  if (
    transition.kind === "host_relay_degraded"
    && current.transitions.some((candidate) => (
      candidate.kind === "host_relay_degraded"
      && candidate.host === transition.host
      && candidate.reason === transition.reason
    ))
  ) {
    return { record: current, disposition: "bounded_drop" };
  }
  if (retainedTransitions.length >= SELF_UPGRADE_OPERATION_MAX_TRANSITIONS) {
    return {
      record: current,
      disposition: transition.kind === "host_phase" || transition.kind === "host_relay_degraded"
        ? "bounded_drop"
        : "conflict",
    };
  }

  const transitions = [...retainedTransitions, transition].sort(transitionSort);
  const hosts = reduceOperationHosts(Object.keys(current.hosts), transitions);
  if (transition.kind === "fleet_final") {
    if (!finalTransitionMatchesReducedHosts(transition, hosts)) {
      return { record: current, disposition: "conflict" };
    }
  }
  const next = rebuildOperationRecord(current, transitions);
  const host = "host" in transition ? transition.host : undefined;
  return {
    record: next,
    disposition: "applied",
    ...(host && JSON.stringify(current.hosts[host]) !== JSON.stringify(next.hosts[host])
      ? { changed_host: host }
      : {}),
  };
}

export function selfUpgradeTransitionId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
  return `upgrade-transition-${digest}`;
}

export function encodeSelfUpgradeOperationTransition(transition: SelfUpgradeOperationTransition): string {
  return `${JSON.stringify(normalizedTransition(transition))}\n`;
}

export function parseSelfUpgradeOperationTransition(line: string): SelfUpgradeOperationTransition | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const result = selfUpgradeOperationTransitionSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function defaultSelfUpgradeOperationRoot(homeDir: string): string {
  return path.join(homeDir, ".calyx", "self-upgrade-operations");
}

export function selfUpgradeOperationPath(root: string, operationId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u.test(operationId)) {
    throw new Error(`Invalid self-upgrade operation id: ${operationId}`);
  }
  return path.join(root, `${operationId}.json`);
}

async function authorityPathExists(
  anchor: DurableDirectoryAnchor,
  relativePath: string,
): Promise<boolean> {
  try {
    await anchor.authority.lstat(relativePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readRegularFileNoFollow(targetPath: string): Promise<string> {
  const handle = await open(
    targetPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Self-upgrade observation path is not a regular file: ${targetPath}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readSelfUpgradeOperationFromAuthority(
  anchor: DurableDirectoryAnchor,
  operationId: string,
): Promise<SelfUpgradeOperationRecord> {
  // Keep the public operation-id contract even though authority-relative I/O
  // independently rejects traversal. Nested names are not operation ids.
  selfUpgradeOperationPath(anchor.directory, operationId);
  const contents = await anchor.authority.readFile(
    `${operationId}.json`,
    SELF_UPGRADE_OPERATION_MAX_BYTES,
  );
  return selfUpgradeOperationRecordSchema.parse(JSON.parse(contents) as unknown);
}

function assertDurableFileSize(contents: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw Object.assign(new Error(`${label} exceeds ${maxBytes} bytes.`), {
      code: "EFBIG",
    });
  }
}

async function writeExclusiveDurable(
  anchor: DurableDirectoryAnchor,
  relativePath: string,
  contents: string,
  maxBytes = SELF_UPGRADE_OPERATION_MAX_BYTES,
): Promise<void> {
  assertDurableFileSize(contents, maxBytes, "Self-upgrade operation authority file");
  await anchor.authority.writeFileExclusive(
    relativePath,
    contents,
    SELF_UPGRADE_OPERATION_FILE_MODE,
  );
}

async function replaceDurable(
  anchor: DurableDirectoryAnchor,
  relativePath: string,
  contents: string,
  writerId: string,
): Promise<void> {
  assertDurableFileSize(
    contents,
    SELF_UPGRADE_OPERATION_MAX_BYTES,
    "Self-upgrade operation record",
  );
  await anchor.authority.replaceFile(
    relativePath,
    `${relativePath}.${writerId}.${process.pid}.${randomUUID()}.tmp`,
    contents,
    SELF_UPGRADE_OPERATION_FILE_MODE,
  );
}

async function sweepStaleOperationTemps(
  anchor: DurableDirectoryAnchor,
  nowMs: number,
  staleTempMs: number,
): Promise<void> {
  let removed = false;
  for (const entry of await anchor.authority.readdir()) {
    if (entry.kind !== "file" || !/\.json\..+\.tmp$/u.test(entry.name)) {
      continue;
    }
    const metadata = await anchor.authority.lstat(entry.name);
    if (nowMs - metadata.mtimeMs < staleTempMs) {
      continue;
    }
    await anchor.authority.remove(entry.name, { force: true });
    removed = true;
  }
  if (removed) await anchor.sync();
}

const operationOwnerSchema = z.object({
  schema_version: z.literal("self-upgrade-operation-owner/v1"),
  operation_id: operationId,
  writer_id: nonEmptyString,
  claim_token: nonEmptyString,
  pid: z.number().int().positive(),
  process_identity: nonEmptyString.optional(),
  claimed_at: timestamp,
}).strict();

type SelfUpgradeOperationOwner = z.infer<typeof operationOwnerSchema>;

function ownerFingerprint(owner: SelfUpgradeOperationOwner): string {
  return JSON.stringify(owner);
}

async function readOperationOwner(
  anchor: DurableDirectoryAnchor,
  ownerName: string,
): Promise<SelfUpgradeOperationOwner> {
  return operationOwnerSchema.parse(
    JSON.parse(await anchor.authority.readFile(
      ownerName,
      SELF_UPGRADE_OPERATION_OWNER_MAX_BYTES,
    )) as unknown,
  );
}

/** Restore a quarantined generation without overwriting a newer owner. */
async function restoreOwnerGeneration(
  anchor: DurableDirectoryAnchor,
  quarantineName: string,
  ownerName: string,
  owner: SelfUpgradeOperationOwner,
): Promise<boolean> {
  try {
    await anchor.authority.link(quarantineName, ownerName);
    await anchor.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    try {
      const current = await readOperationOwner(anchor, ownerName);
      if (ownerFingerprint(current) !== ownerFingerprint(owner)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  await anchor.authority.remove(quarantineName, { force: true });
  await anchor.sync();
  return true;
}

async function assertOwnerGeneration(
  anchor: DurableDirectoryAnchor,
  ownerName: string,
  expected: SelfUpgradeOperationOwner,
): Promise<void> {
  // A losing recoverer may briefly move this generation before recognizing
  // the claim-token mismatch and restoring it. That cross-process rename,
  // link, and fsync sequence needs a real-time budget rather than a handful of
  // event-loop turns; never tolerate a different generation at the path.
  const deadlineMs = Date.now() + SELF_UPGRADE_OWNER_RESTORE_WINDOW_MS;
  for (;;) {
    try {
      const current = await readOperationOwner(anchor, ownerName);
      if (ownerFingerprint(current) !== ownerFingerprint(expected)) {
        throw new Error(`Self-upgrade operation owner generation changed: ${expected.operation_id}`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadlineMs) {
        throw error;
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, SELF_UPGRADE_OWNER_RESTORE_RETRY_MS); });
    }
  }
}

async function pruneRetainedOperations(
  anchor: DurableDirectoryAnchor,
  currentOperationId: string,
  nowMs: number,
  retentionMs: number,
  retentionCount: number,
): Promise<void> {
  const candidates: Array<{
    operationId: string;
    recordName: string;
    ownerName: string;
    mtimeMs: number;
    revision: number;
    writerId: string;
  }> = [];
  for (const entry of await anchor.authority.readdir()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json") || entry.name.endsWith(".owner.json")) {
      continue;
    }
    const operationId = entry.name.slice(0, -".json".length);
    try {
      const ownerName = `${operationId}.owner.json`;
      // Owned records are mutable projection generations, not stable retention
      // input. Avoid parsing every live record on every new claim.
      if (await authorityPathExists(anchor, ownerName)) {
        continue;
      }
      const [record, metadata] = await Promise.all([
        readSelfUpgradeOperationFromAuthority(anchor, operationId),
        anchor.authority.lstat(entry.name),
      ]);
      // An ownerless observation is stable retention input regardless of its
      // terminal status. Running records remain useful stale/recovery evidence
      // during the retention window, but projection loss must not turn them
      // into permanent residue or make every future claim scan grow without
      // bound.
      candidates.push({
        operationId,
        recordName: entry.name,
        ownerName,
        mtimeMs: metadata.mtimeMs,
        revision: record.revision,
        writerId: record.writer_id,
      });
    } catch {
      // Never prune an unreadable observation record automatically.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs
    || left.operationId.localeCompare(right.operationId));
  let removed = false;
  const retainedPrevious = Math.max(0, retentionCount - 1);
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.operationId === currentOperationId
      || (nowMs - candidate.mtimeMs < retentionMs && index < retainedPrevious)
    ) {
      continue;
    }
    let latest: SelfUpgradeOperationRecord;
    try {
      latest = await readSelfUpgradeOperationFromAuthority(anchor, candidate.operationId);
    } catch {
      continue;
    }
    if (
      latest.revision !== candidate.revision
      || latest.writer_id !== candidate.writerId
      || await authorityPathExists(anchor, candidate.ownerName)
    ) {
      continue;
    }
    await anchor.authority.remove(candidate.recordName, { force: true });
    removed = true;
  }
  if (removed) await anchor.sync();
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPsProcessIdentity(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 2_000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const started = String(stdout).trim().replace(/\s+/gu, " ");
        resolve(started ? `ps:${started}` : undefined);
      },
    );
  });
}

/**
 * Stable process-generation identity. Linux uses boot id + kernel start ticks;
 * Darwin and other POSIX hosts fall back to the process start timestamp from
 * `ps`. PID liveness without a comparable generation remains conservatively
 * live, so unavailable OS evidence can delay recovery but never fence a live
 * writer incorrectly.
 */
async function defaultReadProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const [bootId, processStat] = await Promise.all([
        readRegularFileNoFollow("/proc/sys/kernel/random/boot_id"),
        readRegularFileNoFollow(`/proc/${pid}/stat`),
      ]);
      const commandEnd = processStat.lastIndexOf(")");
      if (commandEnd < 0) {
        return undefined;
      }
      // Fields after the command begin with field 3 (`state`); kernel process
      // start time is field 22, therefore index 19 in this suffix.
      const fields = processStat.slice(commandEnd + 1).trim().split(/\s+/u);
      const startTicks = fields[19];
      const boot = bootId.trim();
      if (boot && startTicks && /^\d+$/u.test(startTicks)) {
        return `linux:${boot}:${startTicks}`;
      }
    } catch {
      // Fall through to the portable process-start probe.
    }
  }
  return readPsProcessIdentity(pid);
}

async function isOwnerProcessGenerationAlive(
  owner: SelfUpgradeOperationOwner,
  isProcessAlive: (pid: number) => boolean,
  readProcessIdentity: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) {
    return false;
  }
  if (!owner.process_identity) {
    // Pre-generation owner records remain conservative: a live PID is enough
    // to prevent automatic recovery, matching their historical behavior.
    return true;
  }
  const currentIdentity = await readProcessIdentity(owner.pid);
  return currentIdentity === undefined || currentIdentity === owner.process_identity;
}

async function sweepStaleOperationOwners(
  anchor: DurableDirectoryAnchor,
  nowMs: number,
  staleOwnerMs: number,
  retentionMs: number,
  isProcessAlive: (pid: number) => boolean,
  readProcessIdentity: (pid: number) => Promise<string | undefined>,
): Promise<void> {
  let changed = false;
  for (const entry of await anchor.authority.readdir()) {
    if (entry.kind !== "file") {
      continue;
    }
    if (entry.name.includes(".owner.json.stale.")) {
      const quarantineName = entry.name;
      try {
        if (nowMs - (await anchor.authority.lstat(quarantineName)).mtimeMs < staleOwnerMs) {
          continue;
        }
        let quarantined: SelfUpgradeOperationOwner;
        try {
          quarantined = await readOperationOwner(anchor, quarantineName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          // An unreadable canonical owner first spends a full stale interval
          // at its original path, then is moved into quarantine. Bound that
          // already-stale, unusable evidence on the next sweep.
          await anchor.authority.remove(quarantineName, { force: true });
          changed = true;
          continue;
        }
        const ownerName = `${quarantined.operation_id}.owner.json`;
        let canonical: SelfUpgradeOperationRecord | undefined;
        try {
          canonical = await readSelfUpgradeOperationFromAuthority(anchor, quarantined.operation_id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            continue;
          }
        }
        if (
          canonical?.writer_id === quarantined.writer_id
        ) {
          let currentOwner: SelfUpgradeOperationOwner | undefined;
          let currentOwnerMtimeMs: number | undefined;
          try {
            [currentOwner, currentOwnerMtimeMs] = await Promise.all([
              readOperationOwner(anchor, ownerName),
              anchor.authority.lstat(ownerName).then((metadata) => metadata.mtimeMs),
            ]);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              continue;
            }
          }
          if (!currentOwner) {
            await restoreOwnerGeneration(anchor, quarantineName, ownerName, quarantined);
            changed = true;
          } else if (ownerFingerprint(currentOwner) === ownerFingerprint(quarantined)) {
            await anchor.authority.remove(quarantineName, { force: true });
            changed = true;
          } else if (
            currentOwnerMtimeMs !== undefined
            && nowMs - currentOwnerMtimeMs >= staleOwnerMs
            && !await isOwnerProcessGenerationAlive(currentOwner, isProcessAlive, readProcessIdentity)
          ) {
            // An observation-recovery writer died after claiming the canonical owner path
            // but before rebinding the canonical record. Roll that exact dead
            // generation aside, restore the writer still named by the record,
            // then discard only the verified failed-recovery generation.
            const failedRecoveryName = `${ownerName}.stale.${randomUUID()}`;
            try {
              await anchor.authority.rename(ownerName, failedRecoveryName);
              await anchor.sync();
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
              }
              throw error;
            }
            let movedRecovery: SelfUpgradeOperationOwner;
            try {
              movedRecovery = await readOperationOwner(anchor, failedRecoveryName);
            } catch {
              // Preserve both pieces of observation ownership evidence when the moved
              // recovery generation cannot be verified.
              continue;
            }
            if (ownerFingerprint(movedRecovery) !== ownerFingerprint(currentOwner)) {
              await restoreOwnerGeneration(anchor, failedRecoveryName, ownerName, movedRecovery);
              continue;
            }
            const restored = await restoreOwnerGeneration(
              anchor,
              quarantineName,
              ownerName,
              quarantined,
            );
            if (!restored) {
              await restoreOwnerGeneration(anchor, failedRecoveryName, ownerName, movedRecovery);
              continue;
            }
            await anchor.authority.remove(failedRecoveryName, { force: true });
            changed = true;
          }
        } else {
          await anchor.authority.remove(quarantineName, { force: true });
          changed = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      continue;
    }
    if (!entry.name.endsWith(".owner.json")) {
      continue;
    }
    const ownerName = entry.name;
    let owner: SelfUpgradeOperationOwner;
    let ownerMtimeMs: number;
    try {
      ownerMtimeMs = (await anchor.authority.lstat(ownerName)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (nowMs - ownerMtimeMs < staleOwnerMs) {
      continue;
    }
    try {
      owner = await readOperationOwner(anchor, ownerName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Exclusive owner writes now roll back on every post-create failure. A
      // stale unreadable file can therefore only be legacy/crash residue. Move
      // the exact path as the cross-process gate, retain it in quarantine for
      // bounded inspection, and let a later sweep discard it.
      try {
        await anchor.authority.rename(ownerName, `${ownerName}.stale.${randomUUID()}`);
        await anchor.sync();
        changed = true;
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
      continue;
    }
    if (await isOwnerProcessGenerationAlive(owner, isProcessAlive, readProcessIdentity)) {
      continue;
    }
    let terminalAuthority: Pick<SelfUpgradeOperationRecord, "revision" | "writer_id"> | undefined;
    let staleRunningAuthority: Pick<SelfUpgradeOperationRecord, "revision" | "writer_id"> | undefined;
    let mismatchedAuthority: Pick<SelfUpgradeOperationRecord, "revision" | "writer_id"> | undefined;
    try {
      // A canonical record that still names this writer makes the owner
      // the recoverable projection generation while it is running. A terminal record is
      // immutable, so its exact dead owner generation can be swept and then
      // admitted to retention.
      const record = await readSelfUpgradeOperationFromAuthority(anchor, owner.operation_id);
      if (record.writer_id !== owner.writer_id) {
        // The readable canonical record proves that this old, dead owner
        // generation cannot own it. Quarantine and recheck both paths below;
        // this also repairs a recovery crash after claiming but before rebind.
        mismatchedAuthority = {
          revision: record.revision,
          writer_id: record.writer_id,
        };
      } else if (record.status === "running") {
        if (nowMs - ownerMtimeMs < Math.max(staleOwnerMs, retentionMs)) {
          continue;
        }
        // A dead writer's running projection remains recoverable for the full
        // retention window, then its exact generation is released so ordinary
        // ownerless age/count retention can bound the record.
        staleRunningAuthority = {
          revision: record.revision,
          writer_id: record.writer_id,
        };
      } else {
        terminalAuthority = {
          revision: record.revision,
          writer_id: record.writer_id,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        continue;
      }
      // Owner-only residue from a claim that never installed its canonical
      // record is safe to sweep once the writer is both old and dead.
    }
    const quarantineName = `${ownerName}.stale.${randomUUID()}`;
    try {
      // Renaming the exact owner path is the cross-process stale-claim gate:
      // only one recovery/sweep process can remove this generation.
      await anchor.authority.rename(ownerName, quarantineName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    await anchor.sync();
    let movedOwner: SelfUpgradeOperationOwner;
    try {
      movedOwner = await readOperationOwner(anchor, quarantineName);
    } catch {
      // Preserve unreadable moved evidence rather than deleting it.
      continue;
    }
    if (ownerFingerprint(movedOwner) !== ownerFingerprint(owner)) {
      await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
      continue;
    }
    if (terminalAuthority) {
      let latest: SelfUpgradeOperationRecord;
      try {
        latest = await readSelfUpgradeOperationFromAuthority(anchor, owner.operation_id);
      } catch {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
      if (
        latest.status === "running"
        || latest.writer_id !== terminalAuthority.writer_id
        || latest.revision !== terminalAuthority.revision
        || await authorityPathExists(anchor, ownerName)
      ) {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
    }
    if (mismatchedAuthority) {
      let latest: SelfUpgradeOperationRecord;
      try {
        latest = await readSelfUpgradeOperationFromAuthority(anchor, owner.operation_id);
      } catch {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
      if (
        latest.writer_id !== mismatchedAuthority.writer_id
        || latest.revision !== mismatchedAuthority.revision
        || await authorityPathExists(anchor, ownerName)
      ) {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
    }
    if (staleRunningAuthority) {
      let latest: SelfUpgradeOperationRecord;
      try {
        latest = await readSelfUpgradeOperationFromAuthority(anchor, owner.operation_id);
      } catch {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
      if (
        latest.status !== "running"
        || latest.writer_id !== staleRunningAuthority.writer_id
        || latest.revision !== staleRunningAuthority.revision
        || await authorityPathExists(anchor, ownerName)
      ) {
        await restoreOwnerGeneration(anchor, quarantineName, ownerName, movedOwner);
        continue;
      }
    }
    await anchor.authority.remove(quarantineName, { force: true });
    changed = true;
  }
  if (changed) await anchor.sync();
}

export interface SelfUpgradeOperationWriter {
  readonly operationPath: string;
  readonly writerId: string;
  readonly record: SelfUpgradeOperationRecord;
  write: (candidate: SelfUpgradeOperationRecord) => Promise<SelfUpgradeOperationRecord>;
  release: () => Promise<void>;
}

export interface ClaimSelfUpgradeOperationOptions {
  now?: () => string;
  nowMs?: () => number;
  staleTempMs?: number;
  staleOwnerMs?: number;
  retentionMs?: number;
  retentionCount?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessIdentity?: (pid: number) => Promise<string | undefined>;
  /** Deterministic held-cwd portability seam. */
  directoryOpenOptions?: DurableDirectoryOpenOptions;
  /** Deterministic race seam after validation but before retention mutation. */
  afterRootValidatedBeforeRetention?: () => Promise<void>;
}

function createClaimedOperationWriter(args: {
  root: string;
  anchor: DurableDirectoryAnchor;
  initial: SelfUpgradeOperationRecord;
  claimToken: string;
}): SelfUpgradeOperationWriter {
  const { root, anchor, initial, claimToken } = args;
  const operationPath = selfUpgradeOperationPath(root, initial.operation_id);
  const operationName = `${initial.operation_id}.json`;
  const ownerName = `${initial.operation_id}.owner.json`;
  let persisted = initial;
  let queue: Promise<void> = Promise.resolve();
  let released = false;

  const readOwnedClaim = async (): Promise<SelfUpgradeOperationOwner> => {
    if (released) {
      throw new Error(`Self-upgrade operation writer was released: ${initial.operation_id}`);
    }
    await anchor.assertCanonical();
    const storedOwner = await readOperationOwner(anchor, ownerName);
    await anchor.assertCanonical();
    if (storedOwner.writer_id !== initial.writer_id || storedOwner.claim_token !== claimToken) {
      throw new Error(`Self-upgrade operation writer claim changed for ${initial.operation_id}.`);
    }
    return storedOwner;
  };

  const write = (candidateValue: SelfUpgradeOperationRecord): Promise<SelfUpgradeOperationRecord> => {
    let result: SelfUpgradeOperationRecord | undefined;
    const task = queue.then(async () => {
      const candidate = selfUpgradeOperationRecordSchema.parse(candidateValue);
      if (candidate.operation_id !== initial.operation_id || candidate.writer_id !== initial.writer_id) {
        throw new Error(`Self-upgrade operation writer identity mismatch for ${initial.operation_id}.`);
      }
      if (candidate.revision !== persisted.revision) {
        throw new Error(
          `Stale self-upgrade operation candidate for ${initial.operation_id}: expected revision ${persisted.revision}, got ${candidate.revision}.`,
        );
      }
      await readOwnedClaim();
      const stored = await readSelfUpgradeOperationFromAuthority(anchor, initial.operation_id);
      await anchor.assertCanonical();
      if (stored.writer_id !== initial.writer_id || stored.revision !== persisted.revision) {
        throw new Error(
          `Canonical self-upgrade operation revision changed for ${initial.operation_id}; refusing stale writer.`,
        );
      }
      result = selfUpgradeOperationRecordSchema.parse({
        ...candidate,
        revision: persisted.revision + 1,
      });
      // Recheck the claim immediately before promotion. A stale writer whose
      // owner generation was recovered cannot replace canonical state.
      await readOwnedClaim();
      await replaceDurable(
        anchor,
        operationName,
        `${JSON.stringify(result, null, 2)}\n`,
        initial.writer_id,
      );
      await anchor.assertCanonical();
      await readOwnedClaim();
      persisted = result;
    });
    queue = task.catch(() => undefined);
    return task.then(() => result!);
  };

  const release = async (): Promise<void> => {
    const task = queue.then(async () => {
      if (released) {
        return;
      }
      try {
        await readOwnedClaim();
        await anchor.authority.remove(ownerName);
        await anchor.sync();
        await anchor.assertCanonical();
      } finally {
        released = true;
        await anchor.close().catch(() => undefined);
      }
    });
    queue = task.catch(() => undefined);
    await task;
  };

  return {
    operationPath,
    writerId: initial.writer_id,
    get record() {
      return persisted;
    },
    write,
    release,
  };
}

/**
 * Exclusively claim one conductor observation identity and install its
 * revision-zero record. Every later write validates both the immutable owner
 * claim and the expected record revision, then fsyncs the replacement file and
 * containing directory. Callers must treat claim/write failure as projection
 * loss; this writer never authorizes or fences host mutation.
 */
export async function claimSelfUpgradeOperation(
  root: string,
  value: SelfUpgradeOperationRecord,
  options: ClaimSelfUpgradeOperationOptions = {},
): Promise<SelfUpgradeOperationWriter> {
  const initial = selfUpgradeOperationRecordSchema.parse(value);
  if (initial.revision !== 0) {
    throw new Error(`Initial self-upgrade operation revision must be 0, got ${initial.revision}.`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? (() => Date.now());
  const readProcessIdentity = options.readProcessIdentity ?? defaultReadProcessIdentity;
  const anchor = await openPrivateDirectoryDurable(
    root,
    SELF_UPGRADE_OPERATION_DIRECTORY_MODE,
    options.directoryOpenOptions ?? {},
  );
  const operationName = `${initial.operation_id}.json`;
  const ownerName = `${initial.operation_id}.owner.json`;
  let ownerClaimed = false;
  try {
    await anchor.assertCanonical();
    await options.afterRootValidatedBeforeRetention?.();
    await sweepStaleOperationTemps(
      anchor,
      nowMs(),
      options.staleTempMs ?? SELF_UPGRADE_OPERATION_STALE_TEMP_MS,
    );
    await sweepStaleOperationOwners(
      anchor,
      nowMs(),
      options.staleOwnerMs ?? SELF_UPGRADE_OPERATION_STALE_OWNER_MS,
      options.retentionMs ?? SELF_UPGRADE_OPERATION_RETENTION_MS,
      options.isProcessAlive ?? defaultIsProcessAlive,
      readProcessIdentity,
    );
    await pruneRetainedOperations(
      anchor,
      initial.operation_id,
      nowMs(),
      options.retentionMs ?? SELF_UPGRADE_OPERATION_RETENTION_MS,
      options.retentionCount ?? SELF_UPGRADE_OPERATION_RETENTION_COUNT,
    );
    await anchor.assertCanonical();

    if (await authorityPathExists(anchor, operationName)) {
      throw new Error(`Self-upgrade operation already exists: ${initial.operation_id}`);
    }
    const claimToken = randomUUID();
    const processIdentity = await readProcessIdentity(process.pid);
    if (!processIdentity) {
      throw new Error("Unable to establish the self-upgrade projection writer process generation.");
    }
    const owner = operationOwnerSchema.parse({
      schema_version: "self-upgrade-operation-owner/v1",
      operation_id: initial.operation_id,
      writer_id: initial.writer_id,
      claim_token: claimToken,
      pid: process.pid,
      process_identity: processIdentity,
      claimed_at: now(),
    });
    try {
      await writeExclusiveDurable(
        anchor,
        ownerName,
        `${JSON.stringify(owner, null, 2)}\n`,
        SELF_UPGRADE_OPERATION_OWNER_MAX_BYTES,
      );
      ownerClaimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Self-upgrade operation writer is already claimed: ${initial.operation_id}`);
      }
      throw error;
    }
    await anchor.assertCanonical();
    if (await authorityPathExists(anchor, operationName)) {
      throw new Error(`Self-upgrade operation already exists: ${initial.operation_id}`);
    }
    await replaceDurable(
      anchor,
      operationName,
      `${JSON.stringify(initial, null, 2)}\n`,
      initial.writer_id,
    );
    await anchor.assertCanonical();
    return createClaimedOperationWriter({
      root: anchor.directory,
      anchor,
      initial,
      claimToken,
    });
  } catch (error) {
    if (ownerClaimed) {
      await anchor.authority.remove(ownerName, { force: true }).catch(() => undefined);
      await anchor.sync().catch(() => undefined);
    }
    await anchor.close().catch(() => undefined);
    throw error;
  }
}

export interface RecoverSelfUpgradeOperationOptions {
  now?: () => string;
  nowMs?: () => number;
  staleOwnerMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessIdentity?: (pid: number) => Promise<string | undefined>;
  /** Deterministic race-test seam after reading the stale generation. */
  afterOwnerInspected?: () => Promise<void>;
  /** Deterministic race-test seam after installing the recovery generation. */
  afterOwnerClaimed?: () => Promise<void>;
  /** Deterministic held-cwd portability seam. */
  directoryOpenOptions?: DurableDirectoryOpenOptions;
}

/**
 * Adopt a non-terminal conductor observation after its previous writer is
 * provably gone. This repairs only projection ownership; it neither resumes nor
 * authorizes host mutation.
 * Moving the exact owner file is the inter-process winner gate; the recovered
 * canonical record advances revision and writer identity before the returned
 * writer can append anything. The old writer is fenced by both the missing
 * claim token and the changed canonical writer/revision.
 */
export async function recoverSelfUpgradeOperation(
  root: string,
  operationId: string,
  writerId: string,
  options: RecoverSelfUpgradeOperationOptions = {},
): Promise<SelfUpgradeOperationWriter> {
  const now = options.now ?? (() => new Date().toISOString());
  const nowMs = options.nowMs ?? (() => Date.now());
  const staleOwnerMs = options.staleOwnerMs ?? SELF_UPGRADE_OPERATION_STALE_OWNER_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const readProcessIdentity = options.readProcessIdentity ?? defaultReadProcessIdentity;
  const anchor = await openExistingDirectoryDurable(root, options.directoryOpenOptions ?? {});
  const operationName = `${operationId}.json`;
  const ownerName = `${operationId}.owner.json`;
  let stored: SelfUpgradeOperationRecord | undefined;
  let quarantinedOwnerName: string | undefined;
  let quarantinedOwner: SelfUpgradeOperationOwner | undefined;
  let claimedOwner = false;
  let canonicalRecovered = false;
  let recoverySucceeded = false;
  const claimToken = randomUUID();
  try {
    stored = await readSelfUpgradeOperationFromAuthority(anchor, operationId);
    if (stored.status !== "running") {
      throw new Error(`Terminal self-upgrade operation cannot be recovered: ${operationId}`);
    }
    if (stored.writer_id === writerId) {
      throw new Error(`Recovery writer must differ from the stale writer for ${operationId}.`);
    }

    if (await authorityPathExists(anchor, ownerName)) {
      const [previousOwner, metadata] = await Promise.all([
        readOperationOwner(anchor, ownerName),
        anchor.authority.lstat(ownerName),
      ]);
      if (previousOwner.writer_id !== stored.writer_id || previousOwner.operation_id !== operationId) {
        throw new Error(`Self-upgrade operation owner does not match canonical writer: ${operationId}`);
      }
      if (
        nowMs() - metadata.mtimeMs < staleOwnerMs
        || await isOwnerProcessGenerationAlive(previousOwner, isProcessAlive, readProcessIdentity)
      ) {
        throw new Error(`Self-upgrade operation writer is still live: ${operationId}`);
      }
      await options.afterOwnerInspected?.();
      quarantinedOwnerName = `${ownerName}.stale.${randomUUID()}`;
      try {
        await anchor.authority.rename(ownerName, quarantinedOwnerName);
        await anchor.sync();
        await anchor.assertCanonical();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Self-upgrade operation recovery lost the owner race: ${operationId}`);
        }
        throw error;
      }
      const movedOwner = await readOperationOwner(anchor, quarantinedOwnerName);
      if (ownerFingerprint(movedOwner) !== ownerFingerprint(previousOwner)) {
        await restoreOwnerGeneration(anchor, quarantinedOwnerName, ownerName, movedOwner);
        quarantinedOwnerName = undefined;
        throw new Error(`Self-upgrade operation recovery lost the owner generation race: ${operationId}`);
      }
      quarantinedOwner = movedOwner;
    }

    const claimedAt = now();
    const processIdentity = await readProcessIdentity(process.pid);
    if (!processIdentity) {
      throw new Error("Unable to establish the recovered projection writer process generation.");
    }
    const owner = operationOwnerSchema.parse({
      schema_version: "self-upgrade-operation-owner/v1",
      operation_id: operationId,
      writer_id: writerId,
      claim_token: claimToken,
      pid: process.pid,
      process_identity: processIdentity,
      claimed_at: claimedAt,
    });
    await writeExclusiveDurable(
      anchor,
      ownerName,
      `${JSON.stringify(owner, null, 2)}\n`,
      SELF_UPGRADE_OPERATION_OWNER_MAX_BYTES,
    );
    claimedOwner = true;
    await anchor.assertCanonical();
    await options.afterOwnerClaimed?.();
    await anchor.assertCanonical();
    await assertOwnerGeneration(anchor, ownerName, owner);
    const latest = await readSelfUpgradeOperationFromAuthority(anchor, operationId);
    if (latest.writer_id !== stored.writer_id || latest.revision !== stored.revision) {
      throw new Error(`Canonical self-upgrade operation changed during recovery: ${operationId}`);
    }
    const issue: SelfUpgradeOperationDurabilityIssue = {
      issue_id: selfUpgradeTransitionId([
        operationId,
        "writer_recovered",
        stored.writer_id,
        writerId,
        String(stored.revision),
      ]),
      observed_at: claimedAt,
      scope: "operation_state",
      code: "writer_recovered",
      message: `Recovered stale writer ${stored.writer_id} at revision ${stored.revision}.`,
    };
    const rebound = appendSelfUpgradeOperationDurabilityIssue(
      selfUpgradeOperationRecordSchema.parse({
        ...stored,
        writer_id: writerId,
        updated_at: maxTimestamp([stored.updated_at, claimedAt]),
      }),
      issue,
    );
    const recovered = selfUpgradeOperationRecordSchema.parse({
      ...rebound,
      revision: stored.revision + 1,
    });
    await assertOwnerGeneration(anchor, ownerName, owner);
    await replaceDurable(
      anchor,
      operationName,
      `${JSON.stringify(recovered, null, 2)}\n`,
      writerId,
    );
    canonicalRecovered = true;
    await anchor.assertCanonical();
    await assertOwnerGeneration(anchor, ownerName, owner);
    if (quarantinedOwnerName) {
      await anchor.authority.remove(quarantinedOwnerName, { force: true });
      await anchor.sync();
      await anchor.assertCanonical();
    }
    recoverySucceeded = true;
    return createClaimedOperationWriter({
      root: anchor.directory,
      anchor,
      initial: recovered,
      claimToken,
    });
  } catch (error) {
    if (claimedOwner && !canonicalRecovered) {
      try {
        const currentOwner = await readOperationOwner(anchor, ownerName);
        if (currentOwner.writer_id === writerId && currentOwner.claim_token === claimToken) {
          await anchor.authority.remove(ownerName, { force: true });
        }
      } catch {
        // Missing is already clean; unreadable/changed ownership evidence is
        // preserved rather than guessed away by the losing recovery writer.
      }
    }
    if (stored && quarantinedOwnerName && quarantinedOwner) {
      let latest: SelfUpgradeOperationRecord | undefined;
      try {
        latest = await readSelfUpgradeOperationFromAuthority(anchor, operationId);
      } catch {
        // Preserve the quarantined generation when the canonical observation cannot
        // be reread safely.
      }
      if (
        latest
        && latest.writer_id === stored.writer_id
        && latest.revision === stored.revision
      ) {
        await restoreOwnerGeneration(
          anchor,
          quarantinedOwnerName,
          ownerName,
          quarantinedOwner,
        ).catch(() => false);
      } else if (latest?.writer_id === writerId && latest.revision === stored.revision + 1) {
        await anchor.authority.remove(quarantinedOwnerName, { force: true }).catch(() => undefined);
      }
    }
    await anchor.sync().catch(() => undefined);
    throw error;
  } finally {
    if (!recoverySucceeded) {
      await anchor.close().catch(() => undefined);
    }
  }
}

export async function readSelfUpgradeOperation(
  root: string,
  operationId: string,
): Promise<SelfUpgradeOperationRecord> {
  const anchor = await openExistingDirectoryDurable(root);
  try {
    const record = await readSelfUpgradeOperationFromAuthority(anchor, operationId);
    await anchor.assertCanonical();
    return record;
  } finally {
    await anchor.close();
  }
}

async function observeSelfUpgradeOperationFromAuthority(
  anchor: DurableDirectoryAnchor,
  operationId: string,
  options: ObserveSelfUpgradeOperationOptions = {},
): Promise<SelfUpgradeOperationObservation> {
  const operation = await readSelfUpgradeOperationFromAuthority(anchor, operationId);
  let owner: SelfUpgradeOperationOwner | undefined;
  let ownerLiveness: SelfUpgradeOperationOwnerLiveness = "released";
  let ownerBindingMismatch = false;
  try {
    owner = await readOperationOwner(anchor, `${operationId}.owner.json`);
    ownerBindingMismatch = owner.operation_id !== operation.operation_id
      || owner.writer_id !== operation.writer_id;
    if (ownerBindingMismatch) {
      // Recovery publishes its replacement owner before rebinding the
      // canonical operation. A mismatch is non-active, but cannot prove that
      // either writer generation is dead.
      ownerLiveness = "unknown";
    } else {
      const processAlive = (options.isProcessAlive ?? defaultIsProcessAlive)(owner.pid);
      if (!processAlive) {
        ownerLiveness = "dead";
      } else if (!owner.process_identity) {
        ownerLiveness = "unknown";
      } else {
        const processIdentity = await (options.readProcessIdentity ?? defaultReadProcessIdentity)(owner.pid);
        ownerLiveness = processIdentity === undefined
          ? "unknown"
          : processIdentity === owner.process_identity
            ? "live"
            : "dead";
      }
    }
  } catch (error) {
    ownerLiveness = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "released"
      : "unknown";
  }

  await anchor.assertCanonical();
  const runningState: SelfUpgradeOperationRunningState = operation.status !== "running"
    ? "terminal"
    : ownerLiveness === "live"
      ? "active"
      : ownerLiveness === "unknown"
        ? "indeterminate"
        : "orphaned";
  const projectionStatus = ownerBindingMismatch
    || ownerLiveness === "unknown"
    || operation.durability_issues.some((issue) => issue.scope === "operation_state")
    ? "degraded"
    : "available";

  return {
    operation,
    observed_at: options.now?.() ?? new Date().toISOString(),
    projection_status: projectionStatus,
    running_state: runningState,
    owner_liveness: ownerLiveness,
    ...(owner ? { owner_pid: owner.pid, owner_claimed_at: owner.claimed_at } : {}),
  };
}

export async function observeSelfUpgradeOperation(
  root: string,
  operationId: string,
  options: ObserveSelfUpgradeOperationOptions = {},
): Promise<SelfUpgradeOperationObservation> {
  const anchor = await openExistingDirectoryDurable(root, options.directoryOpenOptions);
  try {
    return await observeSelfUpgradeOperationFromAuthority(anchor, operationId, options);
  } finally {
    await anchor.close();
  }
}

/**
 * Resolve the most recent operation, preferring a genuinely live writer.
 *
 * Discovery inspects owner-bearing candidates first because only those can be
 * active. This avoids parsing every retained operation merely to select one,
 * while still falling back to the newest readable record when no live
 * operation exists.
 */
export async function discoverSelfUpgradeOperation(
  root: string,
  options: DiscoverSelfUpgradeOperationOptions = {},
): Promise<SelfUpgradeOperationObservation | undefined> {
  const anchor = await openExistingDirectoryDurable(root, options.directoryOpenOptions);
  try {
    const entries = await anchor.authority.readdir();
    const ownerNames = new Set(
      entries
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".owner.json"))
        .map((entry) => entry.name),
    );
    const candidates = (await Promise.all(entries
      .filter((entry) => (
        entry.kind === "file"
        && entry.name.endsWith(".json")
        && !entry.name.endsWith(".owner.json")
      ))
      .map(async (entry) => {
        const operationId = entry.name.slice(0, -".json".length);
        try {
          selfUpgradeOperationPath(anchor.directory, operationId);
          const metadata = await anchor.authority.lstat(entry.name);
          return {
            operationId,
            mtimeMs: metadata.mtimeMs,
            hasOwner: ownerNames.has(`${operationId}.owner.json`),
          };
        } catch {
          return undefined;
        }
      })))
      .filter((candidate): candidate is {
        operationId: string;
        mtimeMs: number;
        hasOwner: boolean;
      } => candidate !== undefined)
      .sort((left, right) => (
        right.mtimeMs - left.mtimeMs
        || left.operationId.localeCompare(right.operationId)
      ));

    const observed = new Map<string, SelfUpgradeOperationObservation>();
    for (const candidate of candidates) {
      if (!candidate.hasOwner) {
        continue;
      }
      try {
        const observation = await observeSelfUpgradeOperationFromAuthority(
          anchor,
          candidate.operationId,
          options,
        );
        observed.set(candidate.operationId, observation);
        if (observation.running_state === "active") {
          return observation;
        }
      } catch {
        // A malformed projection is not a discoverable operation. Explicit
        // lookup still surfaces its exact read error.
      }
    }

    for (const candidate of candidates) {
      const existing = observed.get(candidate.operationId);
      if (existing) {
        return existing;
      }
      try {
        return await observeSelfUpgradeOperationFromAuthority(
          anchor,
          candidate.operationId,
          options,
        );
      } catch {
        // Continue to the next newest readable operation.
      }
    }
    return undefined;
  } finally {
    await anchor.close();
  }
}
