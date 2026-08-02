import startupContractManifest from "../startup-contract.json" with { type: "json" };

import {
  assertConsumerApiServerAmbientIsolation,
  isConsumerApiSecretEnvName,
  type ConsumerApiCredentialTruth,
  type ConsumerApiServerAmbientIsolation,
} from "./consumer-credentials";

/**
 * The credentialized run server's startup **environment contract** (POL-2045).
 *
 * POL-1980 gave the run server a fail-closed boot spine: it refuses to start
 * unless a fixed set of *non-secret* environment variables are present in its
 * process environment (today: `CALYX_HOST_ALIAS`). The supervisor definition
 * (systemd user unit / launchd plist, launched through the
 * `with-scoped-polli-secrets` projector) is what provides those names. When a
 * newer server binary adds a required name that the live supervisor does not
 * project, the daemon fail-closes on restart — the exact 2026-07-20 fleet
 * failure this contract lets `calyx self upgrade` name *before* promotion.
 *
 * The contract carries env var **names only, never values** (matching the
 * POL-1984 secret-handling discipline). It is versioned so an upgrade can read
 * the target binary's contract and refuse a promotion the live supervisor
 * cannot satisfy.
 *
 * Invariant that keeps the upgrade preflight *sound*: `required_env` holds only
 * fixed, non-secret names that a supervisor must project **explicitly** (via a
 * projector `--fixed-env`/`--required-env` arg or a `systemd Environment=` /
 * launchd `EnvironmentVariables` entry). Per-host token/verifier *secret* env
 * names are truth-derived — the server and the supervisor read the same
 * `hosts.yaml`, so they match by construction and never belong here. Because a
 * required name is always projected explicitly, its absence from a live
 * definition is *definitive* (never "maybe loaded implicitly"), so the preflight
 * can emit `incompatible` without risk of a false positive.
 */
export const CALYX_STARTUP_CONTRACT_SCHEMA_VERSION = "calyx-startup-contract/v1";
export const CALYX_CONSUMER_API_SECRET_POLICY = "host-scoped/v1";
export const CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV = "CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT";

/**
 * Repo-root-relative path of the canonical committed boot contract. `calyx
 * self upgrade` reads it from the *target* ref (`git show <target>:<path>`) to preflight a
 * promotion without building or executing the target binary.
 */
export const CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH = "packages/core/startup-contract.json";

export interface CalyxStartupContract {
  schema_version: typeof CALYX_STARTUP_CONTRACT_SCHEMA_VERSION;
  /** Env var names that MUST be present in the server's process env at boot. */
  required_env: string[];
  /** Exact non-secret values required at boot, keyed by a required env name. */
  required_env_values?: Record<string, string>;
  /**
   * Versioned names-only rule for rejecting consumer API secrets that do not
   * belong to this host's run server. The allowlist is derived from hosts truth
   * through the shared consumer credential allowlist derivation.
   */
  consumer_api_secret_policy: typeof CALYX_CONSUMER_API_SECRET_POLICY;
}

/**
 * The committed JSON manifest is the single source of truth. The build bundles
 * this imported value into the `run serve` boot path, while `calyx self upgrade`
 * reads the same file from the pinned target commit before promotion.
 */
export const CALYX_SERVER_STARTUP_CONTRACT: CalyxStartupContract = requireStartupContract(
  startupContractManifest,
  "bundled startup-contract.json",
);
export const CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT = requireStartupContractValue(
  CALYX_SERVER_STARTUP_CONTRACT,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV,
);

/**
 * Fail-closed boot gate: throw if any `required_env` name is absent from `env`.
 * Called first in the `run serve` boot sequence so the contract is *executable
 * truth* the upgrade preflight can trust, not just documentation.
 */
export function assertStartupContractEnvPresent(
  env: NodeJS.ProcessEnv = process.env,
  contract: CalyxStartupContract = CALYX_SERVER_STARTUP_CONTRACT,
): void {
  const missing = contract.required_env.filter(
    (name) => !Object.prototype.hasOwnProperty.call(env, name) || env[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Credentialized run server is missing required startup environment variable(s): ${missing.join(", ")}. `
        + "The supervisor definition (systemd user unit / launchd plist) must project these names.",
    );
  }
  const mismatched = Object.entries(contract.required_env_values ?? {})
    .filter(([name, expected]) => env[name] !== expected)
    .map(([name]) => name);
  if (mismatched.length > 0) {
    throw new Error(
      `Credentialized run server has invalid required startup environment value(s): ${mismatched.join(", ")}. `
        + "The supervisor definition must project the exact versioned boot-contract values.",
    );
  }
}

/** Complete consumer-secret portion of the manifest-backed boot predicate. */
export function assertStartupContractConsumerApiAmbientIsolation(
  host: string,
  rows: readonly ConsumerApiCredentialTruth[],
  env: NodeJS.ProcessEnv = process.env,
  contract: CalyxStartupContract = CALYX_SERVER_STARTUP_CONTRACT,
): ConsumerApiServerAmbientIsolation {
  if (contract.consumer_api_secret_policy !== CALYX_CONSUMER_API_SECRET_POLICY) {
    throw new Error(`Unsupported startup consumer API secret policy ${contract.consumer_api_secret_policy}.`);
  }
  return assertConsumerApiServerAmbientIsolation(host, rows, env);
}

/**
 * Parse and validate a startup-contract manifest (read from a target ref or the
 * versioned install). Returns `undefined` for anything that is not a
 * recognizable contract of the supported schema version. Callers separately
 * prove legacy ancestry; malformed, missing post-contract, and future schemas
 * fail closed so an older upgrader cannot silently accept rules it cannot read.
 */
export function parseStartupContract(raw: unknown): CalyxStartupContract | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = raw as Partial<CalyxStartupContract>;
  if (candidate.schema_version !== CALYX_STARTUP_CONTRACT_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    !isEnvNameArray(candidate.required_env)
    || !isEnvValueRecord(candidate.required_env_values)
    || candidate.consumer_api_secret_policy !== CALYX_CONSUMER_API_SECRET_POLICY
  ) {
    return undefined;
  }
  const requiredEnv = [...candidate.required_env];
  const requiredEnvValues = { ...(candidate.required_env_values ?? {}) };
  if (Object.keys(requiredEnvValues).some((name) => !requiredEnv.includes(name))) {
    return undefined;
  }
  return {
    schema_version: CALYX_STARTUP_CONTRACT_SCHEMA_VERSION,
    required_env: requiredEnv,
    ...(Object.keys(requiredEnvValues).length > 0 ? { required_env_values: requiredEnvValues } : {}),
    consumer_api_secret_policy: CALYX_CONSUMER_API_SECRET_POLICY,
  };
}

function requireStartupContract(raw: unknown, label: string): CalyxStartupContract {
  const parsed = parseStartupContract(raw);
  if (!parsed) {
    throw new Error(`${label} does not satisfy ${CALYX_STARTUP_CONTRACT_SCHEMA_VERSION}.`);
  }
  return parsed;
}

function requireStartupContractValue(contract: CalyxStartupContract, name: string): string {
  const value = contract.required_env_values?.[name];
  if (!contract.required_env.includes(name) || !value) {
    throw new Error(`bundled startup-contract.json must require an exact non-empty value for ${name}.`);
  }
  return value;
}

export interface StartupContractEnvDiff {
  /** Required names absent from the provided set (drives `incompatible`). */
  missing_env: string[];
  /** Exact required values that differ from the supervisor's fixed projection. */
  mismatched_env: string[];
  /** Host-scoped consumer API names required by the boot credential truth but absent. */
  missing_consumer_api_secret_env: string[];
  /** Consumer API secret names outside this host's boot allowlist. */
  foreign_consumer_api_secret_env: string[];
}

/**
 * Pure comparison of a target contract against the set of env var NAMES a live
 * supervisor definition provides. Names only; no values are ever consulted.
 */
export function evaluateStartupContract(
  contract: CalyxStartupContract,
  providedEnvNames: readonly string[],
  allowedConsumerApiSecretEnvNames: readonly string[] = [],
  providedEnvValues: Readonly<Record<string, string>> = {},
): StartupContractEnvDiff {
  const provided = new Set(providedEnvNames);
  const allowedSecrets = new Set(allowedConsumerApiSecretEnvNames);
  return {
    missing_env: contract.required_env.filter((name) => !provided.has(name)),
    mismatched_env: Object.entries(contract.required_env_values ?? {})
      .filter(([name, expected]) => providedEnvValues[name] !== expected)
      .map(([name]) => name)
      .sort(),
    missing_consumer_api_secret_env: contract.consumer_api_secret_policy === CALYX_CONSUMER_API_SECRET_POLICY
      ? [...allowedSecrets].filter((name) => !provided.has(name)).sort()
      : [],
    foreign_consumer_api_secret_env: contract.consumer_api_secret_policy === CALYX_CONSUMER_API_SECRET_POLICY
      ? [...provided].filter((name) => isConsumerApiSecretEnvName(name) && !allowedSecrets.has(name)).sort()
      : [],
  };
}

function isEnvValueRecord(value: unknown): value is Record<string, string> | undefined {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(([name, entry]) =>
    /^[A-Z_][A-Z0-9_]*$/.test(name) && typeof entry === "string" && entry.length > 0);
}

function isEnvNameArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && /^[A-Z_][A-Z0-9_]*$/.test(entry))
    && new Set(value).size === value.length;
}
