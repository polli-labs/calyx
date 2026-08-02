import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV,
  CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH,
  CALYX_STARTUP_CONTRACT_SCHEMA_VERSION,
  consumerApiServerCredentialEnvContract,
  evaluateStartupContract,
  isConsumerApiSecretEnvName,
  parseStartupContract,
  type CalyxDaemonDescriptor,
  type CalyxDaemonSupervisorKind,
  type CalyxStartupContract,
  type ConsumerApiServerCredentialEnvContract,
  type ConsumerApiCredentialTruth,
} from "@polli-labs/calyx-core";

const execFile = promisify(execFileCallback);

const LAUNCH_AGENTS_DIR = path.join("Library", "LaunchAgents");
const STAGED_RUN_SERVICE_DIR = path.join(".calyx", "staged", "run-service");
const DEFAULT_SYSTEMD_UNIT = "calyx-run-serve.service";
const DEFAULT_LAUNCHD_LABEL_PREFIX = "com.pollilabs.calyx";
const STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION = "calyx-startup-contract-payload/v1";
/** Last main commit whose ancestors are explicitly legacy pre-contract targets. */
export const CALYX_STARTUP_CONTRACT_LAST_PRECONTRACT_SHA = "836082a6a9210a733382ee84e957415c3ffce121";

const PROJECTOR_CONTRACT = CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT;
export const PROJECTOR_CONTRACT_ENV = CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV;
const PROJECTOR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const PROJECTOR_GENERATED_FIXED_NAMES = ["CALYX_HOST_ALIAS", "HOME", "LOGNAME", "PATH", "USER", "XDG_CONFIG_HOME"] as const;
/**
 * Generated fixed names the canonical supervisor generator emits only when the
 * host truth carries the corresponding fact. They are allowed but never
 * required, so a host that omits the fact still proves compatible.
 *
 * `VAULT_PATH` is published from `fleet/truths/hosts.yaml:vault_root` by
 * agents-infra `scripts/calyx-run-service.mjs`, deliberately, so the vault root
 * has one authority instead of three literals that agree by luck. Calyx itself
 * reads it (`packages/core/src/context/plan.ts`, `packages/core/src/oracle-bundle.ts`).
 */
const PROJECTOR_OPTIONAL_GENERATED_FIXED_NAMES = ["VAULT_PATH"] as const;
const PROJECTOR_NAME_FLAGS = new Set(["--required-env", "--optional-env", "--preserve-env", "--opaque-env", "--sha256-env"]);
const PROJECTOR_VALUE_FLAGS = new Set(["--host", "--config-home", "--source", "--fixed-env"]);

export type StartupContractStatus = "compatible" | "incompatible" | "unknown";
export type StartupContractMutationDisposition = "allow" | "block";
export type StartupContractInvalidKind =
  | "target_ref_unresolved"
  | "manifest_missing"
  | "manifest_malformed"
  | "schema_unsupported"
  | "schema_invalid"
  | "evidence_malformed"
  | "evidence_misbound"
  | "evidence_digest_invalid";
export type StartupContractBlockingReasonCode =
  | "target_contract_invalid"
  | "startup_contract_incompatible"
  | "post_contract_supervisor_semantics_unproved";

export interface StartupContractBlockingReason {
  code: StartupContractBlockingReasonCode;
  message: string;
}

export interface SupervisorProjectionProvenance {
  required_env: string[];
  optional_env: string[];
  preserved_env: string[];
  fixed_env: Record<string, string>;
  opaque_env: string[];
  sha256_env: string[];
}

/** Result of inspecting one daemon's live supervisor definition (names only). */
export type SupervisorEnvInspection =
  | {
      status: "determined";
      provided_env: string[];
      source: string;
      projection_contract: typeof PROJECTOR_CONTRACT;
      projection: SupervisorProjectionProvenance;
    }
  | { status: "incompatible"; reason: string; source: string; provided_env?: string[] }
  | { status: "unknown"; reason: string };

export interface StartupContractDaemonVerdict {
  daemon_id: string;
  supervisor_kind: CalyxDaemonSupervisorKind;
  status: StartupContractStatus;
  /** Env NAMES the live supervisor definition provides, when determinable. */
  provided_env?: string[];
  /** Required names absent from the live definition (drives `incompatible`). */
  missing_env?: string[];
  /** Required fixed values whose projected values do not match the target. */
  mismatched_env?: string[];
  /** Host-scoped consumer API names required by boot truth but absent. */
  missing_consumer_api_secret_env?: string[];
  /** Consumer API secret names outside the target host's boot allowlist. */
  foreign_consumer_api_secret_env?: string[];
  /** Known supervisor/projector semantic violation. */
  projection_violation?: string;
  /** How the live definition was read (command or file path). */
  source?: string;
  /** Why this daemon is `unknown`. */
  reason?: string;
}

export interface SelfUpgradeStartupContractVerdict {
  status: StartupContractStatus;
  mutation_disposition: StartupContractMutationDisposition;
  blocking_reasons: StartupContractBlockingReason[];
  /** Target contract schema version, when the contract was read. */
  contract_schema_version?: string;
  /** Required env NAMES declared by the target contract, when read. */
  required_env?: string[];
  /** SHA-256 of the exact manifest bytes assessed. */
  contract_digest?: string;
  /** How the target contract was read: `git:<ref>` or `worktree`. */
  contract_source: string;
  per_daemon: StartupContractDaemonVerdict[];
  /** Host-level reason when the verdict is `unknown`. */
  reason?: string;
  /** Manifest/evidence error underlying a contract-level unknown-blocked verdict. */
  contract_error?: string;
  /** Typed target/evidence failure; preserves target repair versus upgrader repair. */
  contract_invalid_kind?: StartupContractInvalidKind;
  /** Operator remediation for any mutation-blocking verdict. */
  remediation?: string;
}

/**
 * Where to read the *target* binary's startup contract from. `git` reads the
 * committed manifest at a ref without building or checking out (`git show`);
 * `worktree` reads it from an already-adopted checkout (the real run's
 * pre-promotion gate, after the tree is at the target head).
 */
export type StartupContractSource =
  | { kind: "git"; ref: string | undefined }
  | { kind: "worktree"; targetSha: string }
  | { kind: "payload"; encoded: string; targetSha: string };

interface TargetStartupContractPayload {
  schema_version: typeof STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION;
  target_sha: string;
  classification: "present" | "legacy_absent" | "invalid";
  manifest_text?: string;
  manifest_sha256?: string;
  invalid_kind?: StartupContractInvalidKind;
  reason?: string;
}

type SupervisorExecResult = { code: number; stdout: string; stderr: string };

export interface ComputeStartupContractVerdictArgs {
  host: string;
  repoRoot: string;
  daemons: ReadonlyArray<Pick<CalyxDaemonDescriptor, "daemon_id" | "supervisor">>;
  source: StartupContractSource;
  execGit: (args: string[], cwd: string) => Promise<SupervisorExecResult>;
  resolveSupervisorEnvNames: (
    descriptor: Pick<CalyxDaemonDescriptor, "daemon_id" | "supervisor">,
    expectedHost: string,
  ) => Promise<SupervisorEnvInspection>;
  homeDir: () => string;
  pathExists: (candidate: string) => Promise<boolean>;
  consumerApiCredentialEnvContract?: ConsumerApiServerCredentialEnvContract;
}

/**
 * Derive a per-host startup-contract verdict. Proven legacy targets and
 * unrecognized supervisor shapes are `unknown`; missing/malformed/unsupported
 * contracts on post-contract targets are also epistemically `unknown`, but
 * fail closed through the independent mutation disposition.
 */
export async function computeStartupContractVerdict(
  args: ComputeStartupContractVerdictArgs,
): Promise<SelfUpgradeStartupContractVerdict> {
  const contractSource = describeContractSource(args.source);
  const read = await readTargetStartupContract(args.source, args.repoRoot, args.execGit);
  if (read.status === "legacy") {
    return {
      status: "unknown",
      mutation_disposition: "allow",
      blocking_reasons: [],
      per_daemon: [],
      contract_source: contractSource,
      reason: read.reason,
    };
  }
  if (read.status === "invalid") {
    const remediation = targetContractInvalidRemediation(read.invalidKind, read.reason);
    return {
      status: "unknown",
      mutation_disposition: "block",
      blocking_reasons: [{ code: "target_contract_invalid", message: remediation }],
      per_daemon: [],
      contract_source: contractSource,
      contract_error: read.reason,
      contract_invalid_kind: read.invalidKind,
      reason: read.reason,
      remediation,
    };
  }
  const contract = read.contract;
  const perDaemon: StartupContractDaemonVerdict[] = [];
  for (const daemon of args.daemons) {
    const inspection = await args.resolveSupervisorEnvNames(daemon, args.host);
    if (inspection.status === "unknown") {
      perDaemon.push({
        daemon_id: daemon.daemon_id,
        supervisor_kind: daemon.supervisor.kind,
        status: "unknown",
        reason: inspection.reason,
      });
      continue;
    }
    if (inspection.status === "incompatible") {
      perDaemon.push({
        daemon_id: daemon.daemon_id,
        supervisor_kind: daemon.supervisor.kind,
        status: "incompatible",
        source: inspection.source,
        ...(inspection.provided_env ? { provided_env: inspection.provided_env } : {}),
        projection_violation: inspection.reason,
      });
      continue;
    }
    if (args.consumerApiCredentialEnvContract === undefined) {
      perDaemon.push({
        daemon_id: daemon.daemon_id,
        supervisor_kind: daemon.supervisor.kind,
        status: "unknown",
        reason: "target-host consumer API secret allowlist could not be derived from hosts truth",
      });
      continue;
    }
    if (!contract.required_env.includes(PROJECTOR_CONTRACT_ENV)) {
      perDaemon.push({
        daemon_id: daemon.daemon_id,
        supervisor_kind: daemon.supervisor.kind,
        status: "unknown",
        reason: `${PROJECTOR_CONTRACT_ENV}=${PROJECTOR_CONTRACT} is not enforced by the target startup contract; generated supervisor argv alone cannot attest the external projector semantics`,
      });
      continue;
    }
    if (contract.required_env_values?.[PROJECTOR_CONTRACT_ENV] !== PROJECTOR_CONTRACT) {
      perDaemon.push({
        daemon_id: daemon.daemon_id,
        supervisor_kind: daemon.supervisor.kind,
        status: "unknown",
        reason: `${PROJECTOR_CONTRACT_ENV}=${PROJECTOR_CONTRACT} exact value is not enforced by the target startup contract`,
      });
      continue;
    }
    const diff = evaluateStartupContract(
      contract,
      inspection.provided_env,
      args.consumerApiCredentialEnvContract.allowed_secret_env,
      inspection.projection.fixed_env,
    );
    const credentialViolation = validateProjectorCredentialProvenance(
      inspection.projection,
      args.consumerApiCredentialEnvContract,
    );
    const incompatible = diff.missing_env.length > 0
      || diff.mismatched_env.length > 0
      || diff.missing_consumer_api_secret_env.length > 0
      || diff.foreign_consumer_api_secret_env.length > 0
      || credentialViolation !== undefined;
    perDaemon.push({
      daemon_id: daemon.daemon_id,
      supervisor_kind: daemon.supervisor.kind,
      status: incompatible ? "incompatible" : "compatible",
      provided_env: inspection.provided_env,
      source: inspection.source,
      ...(credentialViolation ? { projection_violation: credentialViolation } : {}),
      ...(diff.missing_env.length > 0 ? { missing_env: diff.missing_env } : {}),
      ...(diff.mismatched_env.length > 0 ? { mismatched_env: diff.mismatched_env } : {}),
      ...(diff.missing_consumer_api_secret_env.length > 0
        ? { missing_consumer_api_secret_env: diff.missing_consumer_api_secret_env }
        : {}),
      ...(diff.foreign_consumer_api_secret_env.length > 0
        ? { foreign_consumer_api_secret_env: diff.foreign_consumer_api_secret_env }
        : {}),
    });
  }
  const status = aggregateStatus(perDaemon, args.daemons.length);
  const verdict: SelfUpgradeStartupContractVerdict = {
    status,
    mutation_disposition: status === "compatible" ? "allow" : "block",
    blocking_reasons: [],
    contract_schema_version: contract.schema_version,
    required_env: contract.required_env,
    contract_digest: read.digest,
    contract_source: contractSource,
    per_daemon: perDaemon,
  };
  if (status === "incompatible") {
    verdict.remediation = await buildStartupContractRemediation(perDaemon, args.homeDir, args.pathExists);
    verdict.blocking_reasons = [{
      code: "startup_contract_incompatible",
      message: verdict.remediation,
    }];
  } else if (status === "unknown" && perDaemon.length > 0) {
    const reasons = [...new Set(
      perDaemon
        .filter((entry) => entry.status === "unknown")
        .map((entry) => entry.reason?.trim())
        .filter((reason): reason is string => Boolean(reason)),
    )];
    verdict.reason = reasons.length > 0
      ? reasons.join("; ")
      : "startup-contract compatibility could not be determined";
    verdict.remediation = `Target startup-contract semantics are unproved: ${verdict.reason}. `
      + "Promotion is blocked for this post-contract target. POL-2053 owns the two-sided generated supervisor marker rollout; "
      + "stage and verify the source-managed supervisor definition before retrying.";
    verdict.blocking_reasons = [{
      code: "post_contract_supervisor_semantics_unproved",
      message: verdict.remediation,
    }];
  } else if (status === "unknown") {
    verdict.reason = "no daemon supervisor definition could be assessed";
    verdict.remediation = "Target startup-contract semantics are unproved because no daemon supervisor definition could be assessed. "
      + "Promotion is blocked for this post-contract target.";
    verdict.blocking_reasons = [{
      code: "post_contract_supervisor_semantics_unproved",
      message: verdict.remediation,
    }];
  }
  return verdict;
}

function aggregateStatus(
  perDaemon: readonly StartupContractDaemonVerdict[],
  daemonCount: number,
): StartupContractStatus {
  if (daemonCount === 0) {
    return "unknown";
  }
  if (perDaemon.some((entry) => entry.status === "incompatible")) {
    return "incompatible";
  }
  if (perDaemon.every((entry) => entry.status === "compatible")) {
    return "compatible";
  }
  return "unknown";
}

function describeContractSource(source: StartupContractSource): string {
  if (source.kind === "git") {
    return `git:${source.ref ?? "unresolved"}`;
  }
  if (source.kind === "payload") {
    return `conductor-payload:${source.targetSha}`;
  }
  return `worktree:${source.targetSha}`;
}

type ContractReadResult =
  | { status: "found"; contract: CalyxStartupContract; digest: string; manifestText: string }
  | { status: "legacy"; reason: string }
  | { status: "invalid"; invalidKind: StartupContractInvalidKind; reason: string };

function targetContractInvalidRemediation(kind: StartupContractInvalidKind, reason: string): string {
  if (kind === "schema_unsupported") {
    return `${reason} Upgrade the local Calyx upgrader to one that supports this newer target contract before promoting the target.`;
  }
  if (kind === "manifest_missing") {
    return `${reason} Rebase the target onto the startup-contract boundary or include the canonical ${CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH} before promoting it; this target is not proven legacy.`;
  }
  if (kind === "manifest_malformed" || kind === "schema_invalid") {
    return `${reason} Repair the target-side ${CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH} content before promoting the target.`;
  }
  return `${reason} Re-resolve and validate the SHA-bound conductor target evidence before promoting the target.`;
}

async function readTargetStartupContract(
  source: StartupContractSource,
  repoRoot: string,
  execGit: (args: string[], cwd: string) => Promise<SupervisorExecResult>,
): Promise<ContractReadResult> {
  if (source.kind === "git") {
    if (!source.ref) {
      return {
        status: "invalid",
        invalidKind: "target_ref_unresolved",
        reason: "Target ref is unresolved; startup-contract provenance cannot be established.",
      };
    }
    const show = await execGit(["show", `${source.ref}:${CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH}`], repoRoot);
    if (show.code !== 0) {
      return classifyAbsentContract(source.ref, repoRoot, execGit);
    }
    return parseContractText(show.stdout, `target ${source.ref}`);
  }
  if (source.kind === "payload") {
    return decodeTargetStartupContractPayload(source.encoded, source.targetSha);
  }
  const manifestPath = path.join(repoRoot, CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return classifyAbsentContract(source.targetSha, repoRoot, execGit);
  }
  return parseContractText(raw, "adopted target");
}

function parseContractText(text: string, label: string): ContractReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", invalidKind: "manifest_malformed", reason: `${label} startup contract is not valid JSON.` };
  }
  const contract = parseStartupContract(parsed);
  if (!contract) {
    const schema = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { schema_version?: unknown }).schema_version
      : undefined;
    const unsupportedNewer = isUnsupportedNewerStartupContractSchema(schema);
    return {
      status: "invalid",
      invalidKind: unsupportedNewer ? "schema_unsupported" : "schema_invalid",
      reason: unsupportedNewer
        ? `${label} startup contract schema ${schema} is unsupported by this upgrader.`
        : `${label} startup contract does not satisfy the supported ${CALYX_STARTUP_CONTRACT_SCHEMA_VERSION} schema.`,
    };
  }
  return { status: "found", contract, digest: sha256(text), manifestText: text };
}

function isUnsupportedNewerStartupContractSchema(schema: unknown): boolean {
  if (typeof schema !== "string" || schema === CALYX_STARTUP_CONTRACT_SCHEMA_VERSION) {
    return false;
  }
  const candidate = /^calyx-startup-contract\/v(\d+)$/u.exec(schema);
  const supported = /^calyx-startup-contract\/v(\d+)$/u.exec(CALYX_STARTUP_CONTRACT_SCHEMA_VERSION);
  return candidate !== null
    && supported !== null
    && Number(candidate[1]) > Number(supported[1]);
}

async function classifyAbsentContract(
  targetSha: string,
  repoRoot: string,
  execGit: (args: string[], cwd: string) => Promise<SupervisorExecResult>,
): Promise<ContractReadResult> {
  const legacy = await execGit(
    ["merge-base", "--is-ancestor", targetSha, CALYX_STARTUP_CONTRACT_LAST_PRECONTRACT_SHA],
    repoRoot,
  );
  if (legacy.code === 0) {
    return { status: "legacy", reason: `target ${targetSha} predates the startup-contract introduction boundary` };
  }
  return {
    status: "invalid",
    invalidKind: "manifest_missing",
    reason: `Target ${targetSha} is not a proven pre-contract target and is missing ${CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH}.`,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Read, classify, validate, and bind the target manifest once on the conductor. */
export async function buildTargetStartupContractPayload(
  targetSha: string,
  repoRoot: string,
  execGit: (args: string[], cwd: string) => Promise<SupervisorExecResult>,
): Promise<string> {
  const read = await readTargetStartupContract({ kind: "git", ref: targetSha }, repoRoot, execGit);
  let payload: TargetStartupContractPayload;
  if (read.status === "found") {
    payload = {
      schema_version: STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION,
      target_sha: targetSha,
      classification: "present",
      manifest_text: read.manifestText,
      manifest_sha256: read.digest,
    };
  } else if (read.status === "legacy") {
    payload = {
      schema_version: STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION,
      target_sha: targetSha,
      classification: "legacy_absent",
      reason: read.reason,
    };
  } else {
    payload = {
      schema_version: STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION,
      target_sha: targetSha,
      classification: "invalid",
      invalid_kind: read.invalidKind,
      reason: read.reason,
    };
  }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Reject malformed/misbound evidence while preserving a typed invalid-target classification. */
export function validateTargetStartupContractPayload(encoded: string, expectedTargetSha: string): void {
  const read = decodeTargetStartupContractPayload(encoded, expectedTargetSha);
  if (read.status === "invalid" && !isTargetManifestInvalidKind(read.invalidKind)) {
    throw new Error(read.reason);
  }
}

function isTargetManifestInvalidKind(kind: StartupContractInvalidKind): boolean {
  return kind === "manifest_missing"
    || kind === "manifest_malformed"
    || kind === "schema_unsupported"
    || kind === "schema_invalid";
}

function decodeTargetStartupContractPayload(encoded: string, expectedTargetSha: string): ContractReadResult {
  let payload: TargetStartupContractPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TargetStartupContractPayload;
  } catch {
    return { status: "invalid", invalidKind: "evidence_malformed", reason: "Conductor startup-contract payload is malformed." };
  }
  if (payload.schema_version !== STARTUP_CONTRACT_PAYLOAD_SCHEMA_VERSION) {
    return { status: "invalid", invalidKind: "evidence_malformed", reason: "Conductor startup-contract payload schema is unsupported." };
  }
  if (payload.target_sha !== expectedTargetSha) {
    return {
      status: "invalid",
      invalidKind: "evidence_misbound",
      reason: `Conductor startup-contract payload is bound to ${payload.target_sha}, not ${expectedTargetSha}.`,
    };
  }
  if (payload.classification === "legacy_absent") {
    return { status: "legacy", reason: payload.reason ?? `target ${expectedTargetSha} predates the contract` };
  }
  if (payload.classification === "invalid") {
    if (!payload.invalid_kind || !isTargetManifestInvalidKind(payload.invalid_kind)) {
      return {
        status: "invalid",
        invalidKind: "evidence_malformed",
        reason: "Conductor startup-contract payload has an invalid target-contract classification.",
      };
    }
    return {
      status: "invalid",
      invalidKind: payload.invalid_kind,
      reason: payload.reason ?? `target ${expectedTargetSha} contract is invalid`,
    };
  }
  if (!payload.manifest_text || !payload.manifest_sha256 || sha256(payload.manifest_text) !== payload.manifest_sha256) {
    return {
      status: "invalid",
      invalidKind: "evidence_digest_invalid",
      reason: "Conductor startup-contract payload digest does not match its manifest bytes.",
    };
  }
  const parsed = parseContractText(payload.manifest_text, `target ${expectedTargetSha} conductor payload`);
  if (parsed.status !== "found") {
    return parsed;
  }
  if (parsed.digest !== payload.manifest_sha256) {
    return {
      status: "invalid",
      invalidKind: "evidence_digest_invalid",
      reason: "Conductor startup-contract payload digest verification failed.",
    };
  }
  return parsed;
}

/** Typed credential roles shared with boot truth; no secret values are read. */
export function resolveConsumerApiCredentialEnvContract(
  host: string,
  rows: readonly ConsumerApiCredentialTruth[] | undefined,
): ConsumerApiServerCredentialEnvContract | undefined {
  return rows ? consumerApiServerCredentialEnvContract(host, rows) : undefined;
}

function validateProjectorCredentialProvenance(
  projection: SupervisorProjectionProvenance,
  contract: ConsumerApiServerCredentialEnvContract,
): string | undefined {
  const required = new Set(projection.required_env);
  const optional = new Set(projection.optional_env);
  const preserved = new Set(projection.preserved_env);
  const fixed = new Set(Object.keys(projection.fixed_env));
  const opaque = new Set(projection.opaque_env);
  const sha256 = new Set(projection.sha256_env);
  const allowed = new Set(contract.allowed_secret_env);
  const allMentionedConsumerSecrets = uniqueSorted([
    ...projection.required_env,
    ...projection.optional_env,
    ...projection.preserved_env,
    ...Object.keys(projection.fixed_env),
    ...projection.opaque_env,
    ...projection.sha256_env,
  ].filter(isConsumerApiSecretEnvName));
  const foreign = allMentionedConsumerSecrets.filter((name) => !allowed.has(name));
  if (foreign.length > 0) {
    return `scoped projector mentions foreign consumer API secret env name(s): ${foreign.join(", ")}`;
  }
  const conditional = contract.allowed_secret_env.filter((name) => optional.has(name) || preserved.has(name));
  if (conditional.length > 0) {
    return `host credential env name(s) are conditionally projected instead of required: ${conditional.join(", ")}`;
  }
  const fixedSecrets = contract.allowed_secret_env.filter((name) => fixed.has(name));
  if (fixedSecrets.length > 0) {
    return `host credential env name(s) must not be supplied by --fixed-env: ${fixedSecrets.join(", ")}`;
  }
  if (required.has(contract.token_env) && !opaque.has(contract.token_env)) {
    return `host token env ${contract.token_env} must carry --opaque-env validation`;
  }
  const missingSha256 = contract.verifier_env.filter((name) => required.has(name) && !sha256.has(name));
  if (missingSha256.length > 0) {
    return `host verifier env name(s) must carry --sha256-env validation: ${missingSha256.join(", ")}`;
  }
  return undefined;
}

async function buildStartupContractRemediation(
  perDaemon: readonly StartupContractDaemonVerdict[],
  homeDir: () => string,
  pathExists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const incompatible = perDaemon.filter((entry) => entry.status === "incompatible");
  const missing = uniqueSorted(incompatible.flatMap((entry) => entry.missing_env ?? []));
  const mismatched = uniqueSorted(incompatible.flatMap((entry) => entry.mismatched_env ?? []));
  const foreignSecrets = uniqueSorted(
    incompatible.flatMap((entry) => entry.foreign_consumer_api_secret_env ?? []),
  );
  const missingConsumerSecrets = uniqueSorted(
    incompatible.flatMap((entry) => entry.missing_consumer_api_secret_env ?? []),
  );
  const projectionViolations = uniqueSorted(
    incompatible.flatMap((entry) => entry.projection_violation ? [entry.projection_violation] : []),
  );
  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(`missing required env name(s): ${missing.join(", ")}`);
  }
  if (mismatched.length > 0) {
    clauses.push(`mismatched required env value name(s): ${mismatched.join(", ")}`);
  }
  if (missingConsumerSecrets.length > 0) {
    clauses.push(`missing host-scoped consumer API secret env name(s): ${missingConsumerSecrets.join(", ")}`);
  }
  if (foreignSecrets.length > 0) {
    clauses.push(`foreign consumer API secret env name(s) present: ${foreignSecrets.join(", ")}`);
  }
  if (projectionViolations.length > 0) {
    clauses.push(...projectionViolations);
  }
  const stagedPaths: string[] = [];
  for (const entry of incompatible) {
    const staged = stagedArtifactPath(entry.supervisor_kind, homeDir());
    if (staged && (await pathExists(staged)) && !stagedPaths.includes(staged)) {
      stagedPaths.push(staged);
    }
  }
  const pointer = stagedPaths.length > 0
    ? `Apply the staged supervisor definition (${stagedPaths.join(", ")}), then re-run self upgrade.`
    : "Re-project the run-serve supervisor definition from agents-infra "
      + "(dev/scripts/calyx-run-service.mjs, launched via with-scoped-polli-secrets), apply it, then re-run self upgrade.";
  return (
    `Target binary startup contract is incompatible with the live supervisor definition (${clauses.join("; ")}). `
    + "The supervisor definition is source-managed in agents-infra. "
    + pointer
  );
}

function stagedArtifactPath(kind: CalyxDaemonSupervisorKind, homeDir: string): string | undefined {
  if (kind === "systemd") {
    return path.join(homeDir, STAGED_RUN_SERVICE_DIR, "systemd", DEFAULT_SYSTEMD_UNIT);
  }
  if (kind === "launchd") {
    return path.join(homeDir, STAGED_RUN_SERVICE_DIR, "launchd", `${DEFAULT_LAUNCHD_LABEL_PREFIX}.run-serve.plist`);
  }
  return undefined;
}

/**
 * Default live-supervisor reader. systemd is authoritative only through
 * `systemctl --user cat` because a bare unit file hides effective drop-ins;
 * launchd is read from the configured plist. Returns names only — no env
 * values are ever read or printed.
 */
export async function defaultResolveSupervisorEnvNames(
  descriptor: Pick<CalyxDaemonDescriptor, "daemon_id" | "supervisor">,
  homeDir: string,
  expectedHost: string,
  execSystemctl: (command: string, args: string[]) => Promise<SupervisorExecResult | undefined> = tryExecFile,
): Promise<SupervisorEnvInspection> {
  const supervisor = descriptor.supervisor;
  if (supervisor.kind === "direct") {
    return { status: "unknown", reason: "direct supervisor exposes no service unit to inspect" };
  }
  const definition = await readSupervisorDefinition(descriptor, homeDir, execSystemctl);
  if (definition.status === "unavailable") {
    return { status: "unknown", reason: definition.reason };
  }
  return inspectSupervisorDefinition(definition.text, supervisor.kind, definition.source, expectedHost);
}

async function readSupervisorDefinition(
  descriptor: Pick<CalyxDaemonDescriptor, "daemon_id" | "supervisor">,
  homeDir: string,
  execSystemctl: (command: string, args: string[]) => Promise<SupervisorExecResult | undefined>,
): Promise<
  | { status: "found"; text: string; source: string }
  | { status: "unavailable"; reason: string }
> {
  const supervisor = descriptor.supervisor;
  if (supervisor.kind === "systemd") {
    const unitName = normalizeUnitName(supervisor.unit_name ?? descriptor.daemon_id);
    const cat = await execSystemctl("systemctl", ["--user", "cat", unitName]);
    if (cat && cat.code === 0 && cat.stdout.trim().length > 0) {
      return { status: "found", text: cat.stdout, source: `systemctl --user cat ${unitName}` };
    }
    return {
      status: "unavailable",
      reason: `authoritative systemctl --user cat ${unitName} is unavailable; the bare unit file cannot prove effective systemd composition because drop-ins may be hidden`,
    };
  }
  if (supervisor.kind === "launchd") {
    const plistPath = supervisor.plistPath
      ?? path.join(
        homeDir,
        LAUNCH_AGENTS_DIR,
        `${supervisor.label ?? `${DEFAULT_LAUNCHD_LABEL_PREFIX}.${descriptor.daemon_id}`}.plist`,
      );
    const text = await tryReadFile(plistPath);
    return text === undefined
      ? { status: "unavailable", reason: "unable to read the live launchd definition" }
      : { status: "found", text, source: plistPath };
  }
  return { status: "unavailable", reason: `unable to read the live ${supervisor.kind} definition` };
}

function normalizeUnitName(unit: string): string {
  return unit.includes(".") ? unit : `${unit}.service`;
}

/**
 * Parse the env var NAMES a supervisor definition projects into the daemon.
 * Returns `undefined` (→ `unknown`) when the launch command cannot be located
 * or the names cannot be enumerated definitively (e.g. a systemd
 * `EnvironmentFile=` whose contents we will not read). Never reads env values.
 */
export function parseSupervisorProvidedEnvNames(
  definitionText: string,
  kind: CalyxDaemonSupervisorKind,
  expectedHost: string,
): string[] | undefined {
  const inspection = inspectSupervisorDefinition(definitionText, kind, "provided definition", expectedHost);
  return inspection.status === "determined" ? inspection.provided_env : undefined;
}

/**
 * Definitive verdicts are restricted to the versioned scoped projector shape.
 * Raw supervisor composition with reset, unset, inheritance, or drop-in
 * semantics is deliberately `unknown`; `systemctl cat` is not treated as an
 * effective-environment representation.
 */
export function inspectSupervisorDefinition(
  text: string,
  kind: CalyxDaemonSupervisorKind,
  source = "provided definition",
  expectedHost?: string,
): SupervisorEnvInspection {
  if (!expectedHost?.trim()) {
    return { status: "unknown", reason: "expected host is required to attest the supervisor projector" };
  }
  if (kind === "systemd") {
    return inspectSystemdDefinition(text, source, expectedHost);
  }
  if (kind === "launchd") {
    return inspectLaunchdDefinition(text, source, expectedHost);
  }
  return { status: "unknown", reason: "direct supervisor exposes no recognized projector contract" };
}

function inspectSystemdDefinition(text: string, source: string, expectedHost: string): SupervisorEnvInspection {
  const fileMarkers = text.split(/\r?\n/).filter((line) => /^#\s+\//.test(line.trim()));
  if (fileMarkers.length > 1) {
    return { status: "unknown", reason: "systemd base-plus-drop-in composition is not an effective-environment proof" };
  }
  const execStarts: string[] = [];
  const inputEnvNames = new Set<string>();
  for (const line of joinContinuedLines(text)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const environment = /^Environment=(.*)$/.exec(trimmed);
    if (environment) {
      if (!(environment[1] ?? "").trim()) {
        return { status: "unknown", reason: "systemd Environment= reset semantics are not modeled" };
      }
      for (const name of envAssignmentNames(environment[1] ?? "")) {
        inputEnvNames.add(name);
      }
      continue;
    }
    if (/^(?:EnvironmentFile|UnsetEnvironment|PassEnvironment)=/.test(trimmed)) {
      return { status: "unknown", reason: `systemd directive ${trimmed.split("=", 1)[0]}= prevents a definitive environment verdict` };
    }
    const execStart = /^ExecStart=(.*)$/.exec(trimmed);
    if (execStart) {
      const value = (execStart[1] ?? "").trim();
      if (!value) {
        return { status: "unknown", reason: "systemd ExecStart= reset/drop-in semantics are not modeled" };
      }
      execStarts.push(value);
    }
  }
  if (execStarts.length !== 1) {
    return { status: "unknown", reason: "systemd definition does not contain exactly one effective ExecStart" };
  }
  return inspectProjectorCommand(
    tokenizeCommand(stripSystemdExecModifiers(execStarts[0] ?? "")),
    source,
    [...inputEnvNames],
    expectedHost,
    "systemd",
  );
}

function inspectLaunchdDefinition(text: string, source: string, expectedHost: string): SupervisorEnvInspection {
  const programArguments = extractPlistArrayStrings(text, "ProgramArguments");
  if (!programArguments) {
    return { status: "unknown", reason: "launchd definition has no ProgramArguments array" };
  }
  return inspectProjectorCommand(
    programArguments,
    source,
    extractPlistDictKeys(text, "EnvironmentVariables"),
    expectedHost,
    "launchd",
  );
}

interface ProjectorArguments {
  host: string;
  required: string[];
  optional: string[];
  preserved: string[];
  fixed: Map<string, string>;
  opaque: string[];
  sha256: string[];
}

function inspectProjectorCommand(
  tokens: readonly string[],
  source: string,
  _wrapperInputEnvNames: readonly string[],
  expectedHost: string,
  supervisorKind: "systemd" | "launchd",
): SupervisorEnvInspection {
  const projectorPath = tokens[0] ?? "";
  const executable = path.basename(projectorPath);
  if (executable === "with-polli-secrets") {
    return { status: "unknown", reason: "broad with-polli-secrets has no names-only effective-child-environment attestation" };
  }
  if (executable !== "with-scoped-polli-secrets") {
    return { status: "unknown", reason: `unrecognized supervisor projector ${executable || "<missing>"}` };
  }
  const separator = tokens.indexOf("--");
  if (separator < 0 || tokens.indexOf("--", separator + 1) >= 0) {
    return { status: "unknown", reason: "scoped projector must contain exactly one command separator" };
  }
  const projector = parseProjectorArguments(tokens.slice(1, separator));
  if (typeof projector === "string") {
    return { status: "unknown", reason: projector };
  }
  const command = separator >= 0 ? tokens.slice(separator + 1) : [];
  if (projector.host !== expectedHost) {
    return { status: "unknown", reason: `scoped projector host ${projector.host} does not match expected host ${expectedHost}` };
  }
  if (projector.fixed.get("CALYX_HOST_ALIAS") !== expectedHost) {
    return { status: "unknown", reason: `scoped projector must fix CALYX_HOST_ALIAS=${expectedHost}` };
  }
  if (projector.fixed.get(PROJECTOR_CONTRACT_ENV) !== PROJECTOR_CONTRACT) {
    return {
      status: "unknown",
      reason: `scoped projector lacks explicit ${PROJECTOR_CONTRACT_ENV}=${PROJECTOR_CONTRACT} attestation`,
    };
  }
  const projectedHome = projector.fixed.get("HOME") ?? "";
  const canonicalRunDir = path.join(projectedHome, ".agents", "run");
  const expectedFixedNames = new Set<string>([
    ...PROJECTOR_GENERATED_FIXED_NAMES,
    PROJECTOR_CONTRACT_ENV,
    ...(supervisorKind === "systemd" ? ["CALYX_SYSTEMD_UNIT"] : []),
  ]);
  const allowedFixedNames = new Set<string>([
    ...expectedFixedNames,
    ...PROJECTOR_OPTIONAL_GENERATED_FIXED_NAMES,
  ]);
  const missingBaseline = [...expectedFixedNames].filter((name) => !projector.fixed.has(name)).sort();
  const extraFixed = [...projector.fixed.keys()].filter((name) => !allowedFixedNames.has(name)).sort();
  if (missingBaseline.length > 0 || extraFixed.length > 0) {
    return {
      status: "unknown",
      reason: [
        missingBaseline.length > 0 ? `missing generated fixed name(s): ${missingBaseline.join(", ")}` : "",
        extraFixed.length > 0 ? `unsupported generated fixed name(s): ${extraFixed.join(", ")}` : "",
      ].filter(Boolean).join("; "),
    };
  }
  const expectedPath = generatedProjectorPath(projectedHome, supervisorKind);
  const expectedCommand = [
    path.join(canonicalRunDir, "calyx"),
    "run",
    "serve",
    "--host",
    "0.0.0.0",
    "--port",
    "8740",
    "--runs-root",
    path.join(projectedHome, ".calyx", "runs"),
    "--worktree-base",
    path.join(projectedHome, "projects"),
  ];
  if (
    !path.isAbsolute(projectedHome)
    || projectorPath !== path.join(canonicalRunDir, "with-scoped-polli-secrets")
    || command.length !== expectedCommand.length
    || command.some((value, index) => value !== expectedCommand[index])
    || projector.fixed.get("XDG_CONFIG_HOME") !== path.join(projectedHome, ".config")
    || !projector.fixed.get("USER")
    || projector.fixed.get("USER") !== projector.fixed.get("LOGNAME")
    || projector.fixed.get("PATH") !== expectedPath
    || (supervisorKind === "systemd" && projector.fixed.get("CALYX_SYSTEMD_UNIT") !== DEFAULT_SYSTEMD_UNIT)
  ) {
    return { status: "unknown", reason: "scoped projector lacks the exact canonical generated path, fixed-value, and child-command attestation" };
  }
  const projection: SupervisorProjectionProvenance = {
    required_env: uniqueSorted(projector.required),
    optional_env: uniqueSorted(projector.optional),
    preserved_env: uniqueSorted(projector.preserved),
    fixed_env: Object.fromEntries([...projector.fixed.entries()].sort(([left], [right]) => left.localeCompare(right))),
    opaque_env: uniqueSorted(projector.opaque),
    sha256_env: uniqueSorted(projector.sha256),
  };
  return {
    status: "determined",
    projection_contract: PROJECTOR_CONTRACT,
    provided_env: uniqueSorted([...projector.required, ...projector.fixed.keys()]),
    projection,
    source,
  };
}

function generatedProjectorPath(home: string, supervisorKind: "systemd" | "launchd"): string {
  const common = `${home}/.npm-global/bin:${home}/.local/bin`;
  return supervisorKind === "launchd"
    ? `${common}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
    : `${common}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
}

function parseProjectorArguments(tokens: readonly string[]): ProjectorArguments | string {
  const names: Record<"required" | "optional" | "preserved" | "opaque" | "sha256", string[]> = {
    required: [],
    optional: [],
    preserved: [],
    opaque: [],
    sha256: [],
  };
  const flagToBucket = new Map([
    ["--required-env", names.required],
    ["--optional-env", names.optional],
    ["--preserve-env", names.preserved],
    ["--opaque-env", names.opaque],
    ["--sha256-env", names.sha256],
  ]);
  const fixed = new Map<string, string>();
  let host: string | undefined;
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index] ?? "";
    const value = tokens[index + 1];
    if ((!PROJECTOR_NAME_FLAGS.has(flag) && !PROJECTOR_VALUE_FLAGS.has(flag)) || value === undefined || value.startsWith("--")) {
      return `scoped projector has malformed or unsupported flag grammar at ${flag || "<missing>"}`;
    }
    if (flag === "--host") {
      if (host !== undefined) return "scoped projector repeats --host";
      host = value;
      continue;
    }
    if (flag === "--config-home" || flag === "--source") {
      continue;
    }
    if (flag === "--fixed-env") {
      const equals = value.indexOf("=");
      if (equals <= 0) return "--fixed-env requires a valid NAME=VALUE assignment";
      const name = value.slice(0, equals);
      if (!PROJECTOR_NAME_PATTERN.test(name) || fixed.has(name)) return `scoped projector has invalid or duplicate fixed env ${name}`;
      fixed.set(name, value.slice(equals + 1));
      continue;
    }
    if (!PROJECTOR_NAME_PATTERN.test(value)) return `scoped projector has invalid env name ${value}`;
    flagToBucket.get(flag)?.push(value);
  }
  if (!host) return "scoped projector is missing --host";
  for (const [label, values] of Object.entries(names)) {
    if (new Set(values).size !== values.length) return `scoped projector repeats ${label} env names`;
  }
  const projectionGroups = [names.required, names.optional, names.preserved, [...fixed.keys()]];
  const projected = projectionGroups.flat();
  if (new Set(projected).size !== projected.length) {
    return "scoped projector required, optional, preserved, and fixed env sets must be disjoint";
  }
  const secretNames = new Set([...names.required, ...names.optional]);
  const validationExtras = uniqueSorted([...names.opaque, ...names.sha256].filter((name) => !secretNames.has(name)));
  if (validationExtras.length > 0) {
    return `scoped projector validation env names must also be required or optional: ${validationExtras.join(", ")}`;
  }
  return { host, ...names, fixed };
}

function assignmentName(value: string): string {
  const equals = value.indexOf("=");
  return equals >= 0 ? value.slice(0, equals) : value;
}

function envAssignmentNames(rest: string): string[] {
  return tokenizeCommand(rest)
    .map((token) => assignmentName(token))
    .filter((name) => name.length > 0);
}

function stripSystemdExecModifiers(value: string): string {
  return value.replace(/^[@\-+!:]+/, "").trim();
}

function joinContinuedLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const joined: string[] = [];
  let buffer = "";
  for (const line of rawLines) {
    if (line.endsWith("\\")) {
      buffer += `${line.slice(0, -1)} `;
      continue;
    }
    joined.push(`${buffer}${line}`);
    buffer = "";
  }
  if (buffer.length > 0) {
    joined.push(buffer);
  }
  return joined;
}

/** Minimal shell-style tokenizer honoring single and double quotes. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

function extractPlistArrayStrings(text: string, key: string): string[] | undefined {
  const block = extractPlistValueBlock(text, key, "array");
  if (block === undefined) {
    return undefined;
  }
  const strings: string[] = [];
  const pattern = /<string>([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    strings.push(decodeXmlEntities(match[1] ?? ""));
  }
  return strings;
}

function extractPlistDictKeys(text: string, key: string): string[] {
  const block = extractPlistValueBlock(text, key, "dict");
  if (block === undefined) {
    return [];
  }
  const keys: string[] = [];
  const pattern = /<key>([\s\S]*?)<\/key>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    keys.push(decodeXmlEntities(match[1] ?? "").trim());
  }
  return keys;
}

function extractPlistValueBlock(text: string, key: string, container: "array" | "dict"): string | undefined {
  const keyPattern = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>`);
  const keyMatch = keyPattern.exec(text);
  if (!keyMatch) {
    return undefined;
  }
  const after = text.slice(keyMatch.index + keyMatch[0].length);
  const open = after.indexOf(`<${container}>`);
  if (open < 0) {
    return undefined;
  }
  const close = after.indexOf(`</${container}>`, open);
  if (close < 0) {
    return undefined;
  }
  return after.slice(open + container.length + 2, close);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

async function tryExecFile(command: string, args: string[]): Promise<SupervisorExecResult | undefined> {
  try {
    const { stdout, stderr } = await execFile(command, args, { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const typed = error as { code?: number; stdout?: string; stderr?: string } | undefined;
    if (typed && (typeof typed.stdout === "string" || typeof typed.stderr === "string")) {
      return { code: typeof typed.code === "number" ? typed.code : 1, stdout: typed.stdout ?? "", stderr: typed.stderr ?? "" };
    }
    return undefined;
  }
}

async function tryReadFile(candidate: string): Promise<string | undefined> {
  try {
    return await readFile(candidate, "utf8");
  } catch {
    return undefined;
  }
}
