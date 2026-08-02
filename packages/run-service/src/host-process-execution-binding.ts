import { randomBytes } from "node:crypto";
import { hashCanonicalJcs } from "@polli-labs/calyx-core";

import { redactServerOnlyEnvironment } from "./worker-supervisor.js";
import type {
  HostProcessExecutionBinding,
  ResolvedHostProcessSpec,
} from "./types.js";

export const HOST_PROCESS_EXECUTION_BINDING_SCHEMA_VERSION =
  "calyx.host-process-execution-binding/v1" as const;

const HOST_PROCESS_EXECUTION_SALT_BYTES = 32;

export interface AdmittedHostProcessExecution {
  binding: HostProcessExecutionBinding;
  /** Exact final environment passed to child_process.spawn. Never persisted. */
  spawn_environment: Readonly<Record<string, string>>;
}

/**
 * Resolve and freeze the exact child environment once, at effect admission.
 * Server-only names are removed both before and after applying overrides so a
 * caller cannot reintroduce daemon credentials through a host-process spec.
 */
export function freezeHostProcessSpawnEnvironment(
  overrides: Readonly<Record<string, string | null>> | undefined,
  inheritedEnvironment: NodeJS.ProcessEnv,
  serverOnlyEnvNames: readonly string[] = [],
): Readonly<Record<string, string>> {
  const environment: NodeJS.ProcessEnv = {
    ...redactServerOnlyEnvironment(inheritedEnvironment, serverOnlyEnvNames),
  };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  const redacted = redactServerOnlyEnvironment(environment, serverOnlyEnvNames);
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(redacted)) {
    if (value !== undefined) entries.push([key, value]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Commit a host-process receipt to the exact admitted effect without exposing
 * environment values on the receipt surface. The execution id is minted at
 * the effect-admission boundary, so a receipt from an earlier attempt cannot
 * be replayed even when its process specification is otherwise identical.
 */
export function hostProcessExecutionCommitment(
  spec: ResolvedHostProcessSpec,
  spawnEnvironment: Readonly<Record<string, string>>,
  executionId: string,
  salt: string,
): string {
  return hashCanonicalJcs({
    domain: HOST_PROCESS_EXECUTION_BINDING_SCHEMA_VERSION,
    execution_id: executionId,
    salt,
    process: {
      argv: spec.process.argv,
      cwd: spec.process.cwd,
      env: spawnEnvironment,
      stop_grace_ms: spec.process.stop_grace_ms,
    },
  });
}

export function admitHostProcessExecution(
  spec: ResolvedHostProcessSpec,
  executionId: string,
  spawnEnvironment: Readonly<Record<string, string>>,
  salt = randomBytes(HOST_PROCESS_EXECUTION_SALT_BYTES).toString("base64url"),
): AdmittedHostProcessExecution {
  const binding = Object.freeze({
    schema_version: HOST_PROCESS_EXECUTION_BINDING_SCHEMA_VERSION,
    execution_id: executionId,
    salt,
    commitment_sha256: hostProcessExecutionCommitment(
      spec,
      spawnEnvironment,
      executionId,
      salt,
    ),
  });
  return {
    binding,
    spawn_environment: spawnEnvironment,
  };
}

/** Fail closed if an in-memory admitted effect no longer matches its binding. */
export function admittedHostProcessExecutionIsValid(
  spec: ResolvedHostProcessSpec,
  admitted: AdmittedHostProcessExecution,
): boolean {
  return admitted.binding.commitment_sha256 === hostProcessExecutionCommitment(
    spec,
    admitted.spawn_environment,
    admitted.binding.execution_id,
    admitted.binding.salt,
  );
}
