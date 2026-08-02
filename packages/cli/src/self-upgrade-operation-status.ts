import { watch } from "node:fs";
import { homedir } from "node:os";
import {
  defaultSelfUpgradeOperationRoot,
  discoverSelfUpgradeOperation,
  observeSelfUpgradeOperation,
  type SelfUpgradeOperationObservation,
} from "@polli-labs/calyx-core";

export const SELF_UPGRADE_OPERATION_STATUS_SCHEMA_VERSION =
  "self-upgrade-operation-status/v1";
export const SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES = 512 * 1024;

const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_PATH_LENGTH = 1_024;
const MAX_DURABILITY_ISSUES = 16;
const WATCH_RECHECK_MS = 1_000;
const WATCH_INDETERMINATE_OBSERVATION_LIMIT = 3;

export interface SelfUpgradeOperationStatusOptions {
  operationId?: string;
  watch?: boolean;
}

export interface SelfUpgradeOperationStatusHost {
  host: string;
  execution_status: SelfUpgradeOperationObservation["operation"]["hosts"][string]["execution_status"];
  relay_mode: SelfUpgradeOperationObservation["operation"]["hosts"][string]["relay_mode"];
  dispatch?: SelfUpgradeOperationObservation["operation"]["hosts"][string]["dispatch"];
  latest_phase?: SelfUpgradeOperationObservation["operation"]["hosts"][string]["latest_phase"];
  latest_phase_elapsed_ms?: number;
  elapsed_ms?: number;
  before_head?: string;
  after_head?: string;
  receipt_locator?: {
    host: string;
    route: string;
  };
  error?: string;
}

export interface SelfUpgradeOperationStatusResult {
  schema_version: typeof SELF_UPGRADE_OPERATION_STATUS_SCHEMA_VERSION;
  operation_id: string;
  selection: {
    mode: "explicit" | "latest_active_first";
  };
  observed_at: string;
  projection: {
    status: SelfUpgradeOperationObservation["projection_status"];
    running_state: SelfUpgradeOperationObservation["running_state"];
    owner_liveness: SelfUpgradeOperationObservation["owner_liveness"];
    owner_pid?: number;
    owner_claimed_at?: string;
    updated_at: string;
    last_update_age_ms: number;
  };
  operation: {
    conductor_host: string;
    target_ref: string;
    target_sha?: string;
    policy: SelfUpgradeOperationObservation["operation"]["policy"];
    started_at: string;
    status: SelfUpgradeOperationObservation["operation"]["status"];
    revision: number;
  };
  hosts: SelfUpgradeOperationStatusHost[];
  receipt_evidence: {
    aggregate_path?: string;
    host_locators: Array<{
      host: string;
      route: string;
    }>;
  };
  durability: {
    issue_count: number;
    issues: Array<{
      observed_at: string;
      scope: string;
      code: string;
      message: string;
    }>;
  };
  authority: {
    operation_record: "observation_projection";
    mutation_truth: "host_local_durable_state";
    terminal_truth: "verified_final_receipts";
  };
  bounded: {
    max_json_bytes: number;
    omitted_transition_count: number;
    omitted_durability_issue_count: number;
    truncated_string_count: number;
  };
}

export interface SelfUpgradeOperationStatusDependencies {
  homeDir?: () => string;
  now?: () => string;
  discoverOperation?: typeof discoverSelfUpgradeOperation;
  observeOperation?: typeof observeSelfUpgradeOperation;
  waitForChange?: (root: string, operationId: string) => Promise<void>;
}

type StatusError = Error & { exitCode: number };

function statusError(message: string, exitCode: number): StatusError {
  return Object.assign(new Error(message), { exitCode });
}

function truncateText(
  value: string,
  maxLength: number,
  truncation: { count: number },
): string {
  if (value.length <= maxLength) {
    return value;
  }
  truncation.count += 1;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function ageMs(observedAt: string, updatedAt: string): number {
  const observed = Date.parse(observedAt);
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(updated)) {
    return 0;
  }
  return Math.max(0, observed - updated);
}

export function projectSelfUpgradeOperationStatus(
  observation: SelfUpgradeOperationObservation,
  selectionMode: SelfUpgradeOperationStatusResult["selection"]["mode"],
): SelfUpgradeOperationStatusResult {
  const truncation = { count: 0 };
  const hosts = Object.values(observation.operation.hosts)
    .sort((left, right) => left.host.localeCompare(right.host))
    .map((host): SelfUpgradeOperationStatusHost => ({
      host: truncateText(host.host, MAX_SHORT_TEXT_LENGTH, truncation),
      execution_status: host.execution_status,
      relay_mode: host.relay_mode,
      ...(host.dispatch ? { dispatch: host.dispatch } : {}),
      ...(host.latest_phase ? { latest_phase: host.latest_phase } : {}),
      ...(host.latest_phase_elapsed_ms !== undefined
        ? { latest_phase_elapsed_ms: host.latest_phase_elapsed_ms }
        : {}),
      ...(host.elapsed_ms !== undefined ? { elapsed_ms: host.elapsed_ms } : {}),
      ...(host.before_head ? { before_head: host.before_head } : {}),
      ...(host.after_head ? { after_head: host.after_head } : {}),
      ...(host.receipt_locator
        ? {
            receipt_locator: {
              host: truncateText(host.receipt_locator.host, MAX_SHORT_TEXT_LENGTH, truncation),
              route: truncateText(host.receipt_locator.route, MAX_SHORT_TEXT_LENGTH, truncation),
            },
          }
        : {}),
      ...(host.error
        ? { error: truncateText(host.error, MAX_SHORT_TEXT_LENGTH, truncation) }
        : {}),
    }));
  const allIssues = [...observation.operation.durability_issues]
    .sort((left, right) => (
      right.observed_at.localeCompare(left.observed_at)
      || left.issue_id.localeCompare(right.issue_id)
    ));
  const issues = allIssues.slice(0, MAX_DURABILITY_ISSUES).map((issue) => ({
    observed_at: issue.observed_at,
    scope: issue.scope,
    code: truncateText(issue.code, MAX_SHORT_TEXT_LENGTH, truncation),
    message: truncateText(issue.message, MAX_SHORT_TEXT_LENGTH, truncation),
  }));
  const hostLocators = hosts
    .flatMap((host) => host.receipt_locator ? [host.receipt_locator] : []);

  const result: SelfUpgradeOperationStatusResult = {
    schema_version: SELF_UPGRADE_OPERATION_STATUS_SCHEMA_VERSION,
    operation_id: observation.operation.operation_id,
    selection: {
      mode: selectionMode,
    },
    observed_at: observation.observed_at,
    projection: {
      status: observation.projection_status,
      running_state: observation.running_state,
      owner_liveness: observation.owner_liveness,
      ...(observation.owner_pid !== undefined ? { owner_pid: observation.owner_pid } : {}),
      ...(observation.owner_claimed_at ? { owner_claimed_at: observation.owner_claimed_at } : {}),
      updated_at: observation.operation.updated_at,
      last_update_age_ms: ageMs(
        observation.observed_at,
        observation.operation.updated_at,
      ),
    },
    operation: {
      conductor_host: truncateText(
        observation.operation.conductor_host,
        MAX_SHORT_TEXT_LENGTH,
        truncation,
      ),
      target_ref: truncateText(
        observation.operation.target_ref,
        MAX_SHORT_TEXT_LENGTH,
        truncation,
      ),
      ...(observation.operation.target_sha
        ? { target_sha: observation.operation.target_sha }
        : {}),
      policy: observation.operation.policy,
      started_at: observation.operation.started_at,
      status: observation.operation.status,
      revision: observation.operation.revision,
    },
    hosts,
    receipt_evidence: {
      ...(observation.operation.final_receipt_path
        ? {
            aggregate_path: truncateText(
              observation.operation.final_receipt_path,
              MAX_PATH_LENGTH,
              truncation,
            ),
          }
        : {}),
      host_locators: hostLocators,
    },
    durability: {
      issue_count: allIssues.length,
      issues,
    },
    authority: {
      operation_record: "observation_projection",
      mutation_truth: "host_local_durable_state",
      terminal_truth: "verified_final_receipts",
    },
    bounded: {
      max_json_bytes: SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES,
      omitted_transition_count: observation.operation.transitions.length,
      omitted_durability_issue_count: Math.max(0, allIssues.length - issues.length),
      truncated_string_count: truncation.count,
    },
  };
  serializeSelfUpgradeOperationStatusJson(result);
  return result;
}

/**
 * Encode the one canonical JSON representation emitted by both status and
 * status --watch. The byte ceiling includes the trailing NDJSON delimiter
 * written by the CLI.
 */
export function serializeSelfUpgradeOperationStatusJson(
  result: SelfUpgradeOperationStatusResult,
): string {
  const output = JSON.stringify(result);
  const outputBytes = Buffer.byteLength(`${output}\n`, "utf8");
  if (outputBytes > SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES) {
    throw statusError(
      `Self-upgrade operation status exceeds the ${SELF_UPGRADE_OPERATION_STATUS_MAX_JSON_BYTES}-byte output contract.`,
      6,
    );
  }
  return output;
}

export function formatSelfUpgradeOperationStatusText(
  result: SelfUpgradeOperationStatusResult,
): string {
  const lines = [
    `self upgrade operation ${result.operation_id}`,
    `state: ${result.projection.running_state} (owner=${result.projection.owner_liveness}, projection=${result.projection.status})`,
    `updated: ${result.projection.updated_at} (${result.projection.last_update_age_ms}ms ago)`,
    `target: ${result.operation.target_sha ?? result.operation.target_ref}`,
    "host | execution | phase | elapsed_ms | relay | receipt",
  ];
  for (const host of result.hosts) {
    lines.push([
      host.host,
      host.execution_status,
      host.latest_phase ?? "-",
      host.elapsed_ms !== undefined || host.latest_phase_elapsed_ms !== undefined
        ? String(host.elapsed_ms ?? host.latest_phase_elapsed_ms)
        : "-",
      host.relay_mode,
      host.receipt_locator
        ? `${host.receipt_locator.host}:${host.receipt_locator.route}`
        : "-",
    ].join(" | "));
  }
  if (result.receipt_evidence.aggregate_path) {
    lines.push(`verified receipt evidence: ${result.receipt_evidence.aggregate_path}`);
  } else {
    lines.push("verified receipt evidence: not yet projected");
  }
  lines.push(
    "authority: this record is an observation projection; host-local durable state and verified final receipts decide mutation/result truth.",
  );
  return lines.join("\n");
}

async function defaultWaitForChange(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const watcher = watch(root, { persistent: true }, () => {
      finish();
    });
    watcher.once("error", (error) => {
      finish(error);
    });
    const timer = setTimeout(() => {
      finish();
    }, WATCH_RECHECK_MS);
  });
}

export async function runSelfUpgradeOperationStatus(
  options: SelfUpgradeOperationStatusOptions,
  dependencies: SelfUpgradeOperationStatusDependencies = {},
  emit: (result: SelfUpgradeOperationStatusResult) => void,
): Promise<SelfUpgradeOperationStatusResult> {
  const root = defaultSelfUpgradeOperationRoot(
    (dependencies.homeDir ?? (() => homedir()))(),
  );
  const observe = dependencies.observeOperation ?? observeSelfUpgradeOperation;
  const discover = dependencies.discoverOperation ?? discoverSelfUpgradeOperation;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const explicitOperationId = options.operationId?.trim();
  let observation: SelfUpgradeOperationObservation | undefined;
  try {
    observation = explicitOperationId
      ? await observe(root, explicitOperationId, { now })
      : await discover(root, { now });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw statusError(
        explicitOperationId
          ? `Unknown self-upgrade operation: ${explicitOperationId}`
          : "No self-upgrade operation observations are available.",
        4,
      );
    }
    throw error;
  }
  if (!observation) {
    throw statusError("No self-upgrade operation observations are available.", 4);
  }

  const selectionMode = explicitOperationId ? "explicit" : "latest_active_first";
  let result = projectSelfUpgradeOperationStatus(observation, selectionMode);
  emit(result);
  if (
    !options.watch
    || result.projection.running_state === "terminal"
    || result.projection.running_state === "orphaned"
  ) {
    return result;
  }

  const waitForChange = dependencies.waitForChange ?? defaultWaitForChange;
  let fingerprint = `${result.operation.revision}:${result.projection.running_state}:${result.projection.owner_liveness}`;
  let indeterminateObservations = result.projection.running_state === "indeterminate" ? 1 : 0;
  while (
    result.projection.running_state === "active"
    || result.projection.running_state === "indeterminate"
  ) {
    if (indeterminateObservations >= WATCH_INDETERMINATE_OBSERVATION_LIMIT) {
      throw statusError(
        `Self-upgrade operation ${result.operation_id} owner liveness remained indeterminate across ${WATCH_INDETERMINATE_OBSERVATION_LIMIT} bounded observations.`,
        6,
      );
    }
    await waitForChange(root, result.operation_id);
    observation = await observe(root, result.operation_id, { now });
    result = projectSelfUpgradeOperationStatus(observation, selectionMode);
    const nextFingerprint =
      `${result.operation.revision}:${result.projection.running_state}:${result.projection.owner_liveness}`;
    if (nextFingerprint !== fingerprint) {
      fingerprint = nextFingerprint;
      emit(result);
    }
    indeterminateObservations = result.projection.running_state === "indeterminate"
      ? indeterminateObservations + 1
      : 0;
  }
  return result;
}
