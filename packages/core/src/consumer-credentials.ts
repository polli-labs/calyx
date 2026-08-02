import { createHash } from "node:crypto";

import type { HostsTruthFile, HostTruthEntry } from "./agents-infra";

export const CALYX_HOST_ALIAS_ENV = "CALYX_HOST_ALIAS";

const CONSUMER_API_SECRET_ENV_PATTERN =
  /^CALYX_CONSUMER_API_[A-Z0-9_]*_(?:TOKEN|VERIFIER(?:_SHA256)?)$/;

/** Shared fail-closed naming law for server-only consumer credential material. */
export function isConsumerApiSecretEnvName(name: string): boolean {
  return CONSUMER_API_SECRET_ENV_PATTERN.test(name);
}

export const CREDENTIAL_TIERS = ["consumer", "control_plane", "internal_runtime"] as const;
export type CredentialTier = (typeof CREDENTIAL_TIERS)[number];

export const INTERFACE_PROFILES = [
  "consumer_v1",
  "control_plane_admin_v1",
  "internal_runtime",
] as const;
export type InterfaceProfile = (typeof INTERFACE_PROFILES)[number];

export interface AddressGrants {
  send_as: readonly string[];
  read: readonly string[];
}

/** Source-truth declaration. Secrets remain in the named environment variables. */
export interface ConsumerApiCredentialTruth {
  client_id: string;
  credential_tier: CredentialTier;
  verifier_env: string;
  token_env: string;
  outbound: boolean;
  address_grants: AddressGrants;
}

/** Server-only credential projection. It deliberately cannot carry a bearer token. */
export interface ResolvedConsumerApiCredentialVerifier {
  client_id: string;
  credential_tier: CredentialTier;
  verifier: string;
  verifier_env: string;
  address_grants: AddressGrants;
}

const MESSAGE_ADDRESS_KINDS = [
  "run",
  "interactive",
  "client",
  "role",
  "host",
] as const;

function requireCanonicalNonEmpty(label: string, value: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be non-empty.`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not have surrounding whitespace.`);
  }
  return value;
}

function normalizeClientId(value: string): string {
  const canonical = requireCanonicalNonEmpty("client_id", value);
  if (!/^[a-z][a-z0-9_.:-]*$/.test(canonical)) {
    throw new Error(`client_id ${JSON.stringify(value)} is not canonical.`);
  }
  return canonical;
}

function assertCredentialSubjectTier(clientId: string, credentialTier: CredentialTier): void {
  const daemonSubject = clientId.startsWith("daemon:");
  const internalRuntime = credentialTier === "internal_runtime";
  if (daemonSubject !== internalRuntime) {
    throw new Error(
      `Credential ${clientId} must use internal_runtime if and only if client_id is daemon:<host>.`,
    );
  }
  if (daemonSubject && !/^daemon:[a-z0-9][a-z0-9.-]*$/.test(clientId)) {
    throw new Error(`Daemon credential client_id ${clientId} must use a canonical daemon:<host> subject.`);
  }
}

function normalizeEnvName(label: "verifier_env" | "token_env", value: string): string {
  const canonical = requireCanonicalNonEmpty(label, value);
  if (!isConsumerApiSecretEnvName(canonical)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} must use the reserved CALYX_CONSUMER_API_* credential namespace.`,
    );
  }
  if (label === "token_env" && !canonical.endsWith("_TOKEN")) {
    throw new Error(`${label} ${JSON.stringify(value)} must end in _TOKEN.`);
  }
  if (label === "verifier_env" && !/_VERIFIER(?:_SHA256)?$/u.test(canonical)) {
    throw new Error(`${label} ${JSON.stringify(value)} must end in _VERIFIER or _VERIFIER_SHA256.`);
  }
  return canonical;
}

function canonicalTarget(label: string, target: string, pattern: RegExp): string {
  if (!pattern.test(target)) {
    throw new Error(`address grant ${JSON.stringify(label)} is not canonical.`);
  }
  return target;
}

/**
 * Validates the grant language without normalizing it. This keeps source truth,
 * runtime matching, and future generated validators on one exact grammar.
 */
export function normalizeAddressGrant(value: string): string {
  const canonical = requireCanonicalNonEmpty("address grant", value);
  if (/\s/.test(canonical)) {
    throw new Error(`address grant ${JSON.stringify(value)} must not contain whitespace.`);
  }
  if (canonical === "fleet") {
    return canonical;
  }

  const separator = canonical.indexOf(":");
  if (separator <= 0 || separator === canonical.length - 1) {
    throw new Error(`address grant ${JSON.stringify(value)} is not a canonical MessageAddress or one-kind wildcard.`);
  }
  const kind = canonical.slice(0, separator);
  const target = canonical.slice(separator + 1);
  if (!(MESSAGE_ADDRESS_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`address grant ${JSON.stringify(value)} has unknown or non-canonical kind ${JSON.stringify(kind)}.`);
  }
  if (target === "*") {
    return canonical;
  }
  if (target.includes("*")) {
    throw new Error(`address grant ${JSON.stringify(value)} may use only the one-kind wildcard <kind>:*.`);
  }

  switch (kind) {
    case "run":
      canonicalTarget(value, target, /^[a-z0-9][a-z0-9._:-]*$/);
      break;
    case "interactive":
      canonicalTarget(value, target, /^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9._:-]*$/);
      break;
    case "client":
      canonicalTarget(value, target, /^[a-z][a-z0-9_.:-]*@[a-z0-9][a-z0-9.-]*$/);
      break;
    case "role":
      canonicalTarget(value, target, /^[a-z][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/);
      break;
    case "host":
      canonicalTarget(value, target, /^[a-z0-9][a-z0-9.-]*$/);
      break;
  }
  return canonical;
}

function normalizeGrantSet(label: string, values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array.`);
  }
  const normalized = values.map(normalizeAddressGrant).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate grants.`);
  }
  return normalized;
}

function normalizeCredentialTruthRow(row: ConsumerApiCredentialTruth): ConsumerApiCredentialTruth {
  if (!(CREDENTIAL_TIERS as readonly string[]).includes(row.credential_tier)) {
    throw new Error(`credential_tier for ${JSON.stringify(row.client_id)} must be consumer, control_plane, or internal_runtime.`);
  }
  if (typeof row.outbound !== "boolean") {
    throw new Error(`outbound for ${JSON.stringify(row.client_id)} must be a boolean.`);
  }
  if (!row.address_grants || typeof row.address_grants !== "object") {
    throw new Error(`address_grants for ${JSON.stringify(row.client_id)} must be present.`);
  }
  const clientId = normalizeClientId(row.client_id);
  assertCredentialSubjectTier(clientId, row.credential_tier);
  return {
    client_id: clientId,
    credential_tier: row.credential_tier,
    verifier_env: normalizeEnvName("verifier_env", row.verifier_env),
    token_env: normalizeEnvName("token_env", row.token_env),
    outbound: row.outbound,
    address_grants: {
      send_as: normalizeGrantSet("address_grants.send_as", row.address_grants.send_as),
      read: normalizeGrantSet("address_grants.read", row.address_grants.read),
    },
  };
}

function semanticIdentity(row: Pick<ConsumerApiCredentialTruth, "client_id" | "credential_tier" | "address_grants">): string {
  return JSON.stringify({
    client_id: row.client_id,
    credential_tier: row.credential_tier,
    address_grants: row.address_grants,
  });
}

function validateCredentialTruthRows(
  rows: readonly ConsumerApiCredentialTruth[],
): readonly ConsumerApiCredentialTruth[] {
  const normalizedRows = rows.map(normalizeCredentialTruthRow);
  const seenEnvNames = new Map<string, "verifier_env" | "token_env">();
  const identityByClient = new Map<string, string>();
  const outboundCountByClient = new Map<string, number>();

  for (const row of normalizedRows) {
    for (const [kind, envName] of [
      ["verifier_env", row.verifier_env],
      ["token_env", row.token_env],
    ] as const) {
      const priorKind = seenEnvNames.get(envName);
      if (priorKind) {
        throw new Error(`consumer_api_credentials reuses environment name ${envName} across ${priorKind} and ${kind}.`);
      }
      seenEnvNames.set(envName, kind);
    }

    const identity = semanticIdentity(row);
    const priorIdentity = identityByClient.get(row.client_id);
    if (priorIdentity !== undefined && priorIdentity !== identity) {
      throw new Error(`Credentials sharing client_id ${row.client_id} must have identical tier and grants.`);
    }
    identityByClient.set(row.client_id, identity);
    outboundCountByClient.set(
      row.client_id,
      (outboundCountByClient.get(row.client_id) ?? 0) + (row.outbound ? 1 : 0),
    );
  }

  for (const [clientId, outboundCount] of outboundCountByClient) {
    if (outboundCount !== 1) {
      throw new Error(`Credentials sharing client_id ${clientId} must have exactly one outbound row; found ${outboundCount}.`);
    }
  }

  return normalizedRows.sort((left, right) =>
    left.client_id.localeCompare(right.client_id) || left.verifier_env.localeCompare(right.verifier_env));
}

/** Validates source truth without resolving either server or client secret material. */
export function validateConsumerApiCredentialTruth(
  rows: readonly ConsumerApiCredentialTruth[],
): readonly ConsumerApiCredentialTruth[] {
  if (rows.length === 0) {
    throw new Error("At least one consumer API credential truth row is required.");
  }
  return validateCredentialTruthRows(rows);
}

function normalizeVerifier(label: string, value: string): string {
  const canonical = requireCanonicalNonEmpty(label, value);
  if (!/^sha256:[0-9a-f]{64}$/.test(canonical)) {
    throw new Error(`${label} must be a canonical sha256:<64 lowercase hex> verifier.`);
  }
  return canonical;
}

export function hashConsumerApiBearer(token: string): string {
  const bearer = requireCanonicalNonEmpty("bearer token", token);
  if (/\s/.test(bearer)) {
    throw new Error("bearer token must not contain whitespace.");
  }
  return `sha256:${createHash("sha256").update(bearer, "utf8").digest("hex")}`;
}

/** Resolves only verifier material for run-server startup. It never reads token_env. */
export function resolveConsumerApiCredentialVerifiers(
  host: string,
  entry: HostTruthEntry | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly ResolvedConsumerApiCredentialVerifier[] {
  const rows = entry?.consumer_api_credentials;
  if (!rows || rows.length === 0) {
    throw new Error(`Host ${host} has no consumer_api_credentials; refusing to start run serve.`);
  }

  const normalizedRows = validateCredentialTruthRows(rows);
  const seenVerifiers = new Map<string, string>();
  return validateResolvedConsumerApiCredentialVerifiers(normalizedRows.map((row) => {
    const verifier = normalizeVerifier(row.verifier_env, env[row.verifier_env] ?? "");
    const priorOwner = seenVerifiers.get(verifier);
    if (priorOwner !== undefined) {
      throw new Error(`Credential verifier collision between ${priorOwner} and ${row.client_id}.`);
    }
    seenVerifiers.set(verifier, row.client_id);
    return {
      client_id: row.client_id,
      credential_tier: row.credential_tier,
      verifier,
      verifier_env: row.verifier_env,
      address_grants: row.address_grants,
    };
  }));
}

/** Validates direct server composition just as strictly as hosts-truth loading. */
export function validateResolvedConsumerApiCredentialVerifiers(
  rows: readonly ResolvedConsumerApiCredentialVerifier[],
): readonly ResolvedConsumerApiCredentialVerifier[] {
  if (rows.length === 0) {
    throw new Error("At least one consumer API credential verifier is required.");
  }
  const seenVerifierEnvs = new Set<string>();
  const ownerByVerifier = new Map<string, string>();
  const identityByClient = new Map<string, string>();
  const normalized = rows.map((input) => {
    const clientId = normalizeClientId(input.client_id);
    if (!(CREDENTIAL_TIERS as readonly string[]).includes(input.credential_tier)) {
      throw new Error(`credential_tier for ${JSON.stringify(clientId)} must be consumer, control_plane, or internal_runtime.`);
    }
    assertCredentialSubjectTier(clientId, input.credential_tier);
    const verifierEnv = normalizeEnvName("verifier_env", input.verifier_env);
    if (seenVerifierEnvs.has(verifierEnv)) {
      throw new Error(`consumer API credential verifiers repeat verifier_env ${verifierEnv}.`);
    }
    seenVerifierEnvs.add(verifierEnv);
    const addressGrants = {
      send_as: normalizeGrantSet("address_grants.send_as", input.address_grants.send_as),
      read: normalizeGrantSet("address_grants.read", input.address_grants.read),
    };
    const verifier = normalizeVerifier(verifierEnv, input.verifier);
    const priorOwner = ownerByVerifier.get(verifier);
    if (priorOwner !== undefined) {
      throw new Error(`Credential verifier collision between ${priorOwner} and ${clientId}.`);
    }
    ownerByVerifier.set(verifier, clientId);
    const identity = semanticIdentity({ client_id: clientId, credential_tier: input.credential_tier, address_grants: addressGrants });
    const priorIdentity = identityByClient.get(clientId);
    if (priorIdentity !== undefined && priorIdentity !== identity) {
      throw new Error(`Credentials sharing client_id ${clientId} must have identical tier and grants.`);
    }
    identityByClient.set(clientId, identity);
    return {
      client_id: clientId,
      credential_tier: input.credential_tier,
      verifier,
      verifier_env: verifierEnv,
      address_grants: addressGrants,
    };
  });
  return normalized.sort((left, right) =>
    left.client_id.localeCompare(right.client_id) || left.verifier_env.localeCompare(right.verifier_env));
}

export interface ConsumerApiServerAmbientIsolation {
  daemon_client_id: string;
  token_env: string;
}

/** Names-only credential roles required by one run server's scoped projector. */
export interface ConsumerApiServerCredentialEnvContract {
  token_env: string;
  verifier_env: readonly string[];
  allowed_secret_env: readonly string[];
}

export function consumerApiServerCredentialEnvContract(
  host: string,
  rows: readonly ConsumerApiCredentialTruth[],
): ConsumerApiServerCredentialEnvContract {
  const normalizedRows = validateConsumerApiCredentialTruth(rows);
  const hostAlias = requireCanonicalNonEmpty("host", host).toLowerCase();
  const daemonClientId = `daemon:${hostAlias}`;
  const selected = normalizedRows.find((row) => row.client_id === daemonClientId && row.outbound);
  if (!selected) {
    throw new Error(`Run server ${hostAlias} has no selected outbound ${daemonClientId} credential.`);
  }
  if (selected.credential_tier !== "internal_runtime") {
    throw new Error(`${daemonClientId} must use the internal_runtime credential tier.`);
  }
  const verifierEnv = [...new Set(normalizedRows.map((row) => row.verifier_env))].sort();
  return {
    token_env: selected.token_env,
    verifier_env: verifierEnv,
    allowed_secret_env: [...new Set([selected.token_env, ...verifierEnv])].sort(),
  };
}

/**
 * Env-name allowlist for one run server's startup process. This is the shared
 * names-only derivation used by both the boot gate and self-upgrade preflight;
 * secret values are never read.
 */
export function consumerApiServerAllowedSecretEnvNames(
  host: string,
  rows: readonly ConsumerApiCredentialTruth[],
): readonly string[] {
  return consumerApiServerCredentialEnvContract(host, rows).allowed_secret_env;
}

/**
 * Credentialized daemons bind identity explicitly. Host/home inference is not
 * an authentication input because multiple fleet aliases can share one home.
 */
export function resolveConsumerApiServerHostAlias(
  truth: HostsTruthFile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[CALYX_HOST_ALIAS_ENV];
  if (!raw) {
    throw new Error(`Credentialized run server requires ${CALYX_HOST_ALIAS_ENV}=<canonical-host-alias>.`);
  }
  const hostAlias = requireCanonicalNonEmpty(CALYX_HOST_ALIAS_ENV, raw);
  if (hostAlias !== hostAlias.toLowerCase() || !/^[a-z0-9][a-z0-9.-]*$/.test(hostAlias)) {
    throw new Error(`${CALYX_HOST_ALIAS_ENV} ${JSON.stringify(raw)} is not a canonical host alias.`);
  }
  if (!truth.hosts?.[hostAlias]) {
    throw new Error(`${CALYX_HOST_ALIAS_ENV} names unknown host ${hostAlias}.`);
  }
  return hostAlias;
}

/**
 * Proves the server process received only the one plaintext token it owns.
 * Presence checks intentionally never read token values; failures name env
 * variables only.
 */
export function assertConsumerApiServerAmbientIsolation(
  host: string,
  rows: readonly ConsumerApiCredentialTruth[],
  env: NodeJS.ProcessEnv = process.env,
): ConsumerApiServerAmbientIsolation {
  const normalizedRows = validateConsumerApiCredentialTruth(rows);
  const hostAlias = requireCanonicalNonEmpty("host", host).toLowerCase();
  const daemonClientId = `daemon:${hostAlias}`;
  const daemonRows = normalizedRows.filter((row) => row.client_id === daemonClientId);
  if (daemonRows.length === 0) {
    throw new Error(`Run server ${hostAlias} has no ${daemonClientId} credential.`);
  }
  if (daemonRows.some((row) => row.credential_tier !== "internal_runtime")) {
    throw new Error(`${daemonClientId} must use the internal_runtime credential tier.`);
  }
  const selected = daemonRows.find((row) => row.outbound);
  if (!selected) {
    throw new Error(`${daemonClientId} has no selected outbound credential row.`);
  }
  const hasEnv = (name: string): boolean => Object.prototype.hasOwnProperty.call(env, name);
  if (!hasEnv(selected.token_env)) {
    throw new Error(`Run server ${hostAlias} is missing its selected daemon token env ${selected.token_env}.`);
  }
  const allowedSecretEnvs = new Set(consumerApiServerAllowedSecretEnvNames(hostAlias, normalizedRows));
  const foreignSecretEnvs = normalizedRows
    .map((row) => row.token_env)
    .filter((name) => name !== selected.token_env && hasEnv(name))
    .concat(Object.keys(env).filter((name) =>
      isConsumerApiSecretEnvName(name) && !allowedSecretEnvs.has(name)))
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  if (foreignSecretEnvs.length > 0) {
    throw new Error(`Run server ${hostAlias} received foreign consumer API secret env(s): ${foreignSecretEnvs.join(", ")}.`);
  }
  return { daemon_client_id: daemonClientId, token_env: selected.token_env };
}

/** Resolves one named client's sole outbound token without reading any other token_env. */
export function resolveConsumerApiClientToken(
  host: string,
  entry: HostTruthEntry | undefined,
  clientId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const normalizedClientId = normalizeClientId(clientId);
  const rows = entry?.consumer_api_credentials;
  if (!rows || rows.length === 0) {
    return undefined;
  }
  const matches = validateCredentialTruthRows(rows).filter((row) => row.client_id === normalizedClientId);
  if (matches.length === 0) {
    return undefined;
  }
  const selected = matches.find((row) => row.outbound)!;
  const token = env[selected.token_env] ?? "";
  try {
    hashConsumerApiBearer(token);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Host ${host} outbound credential ${normalizedClientId} from ${selected.token_env} is invalid: ${detail}`);
  }
  return token;
}

export function profilesForCredentialTier(tier: CredentialTier): readonly InterfaceProfile[] {
  if (tier === "consumer") return ["consumer_v1"];
  if (tier === "internal_runtime") return ["internal_runtime"];
  return ["consumer_v1", "control_plane_admin_v1"];
}

export function credentialMayUseProfile(
  tier: CredentialTier,
  profile: InterfaceProfile,
): boolean {
  return profilesForCredentialTier(tier).includes(profile);
}

export function addressGrantMatches(grant: string, address: string): boolean {
  const normalizedGrant = normalizeAddressGrant(grant);
  const normalizedAddress = normalizeAddressGrant(address);
  if (!normalizedGrant.endsWith(":*")) {
    return normalizedGrant === normalizedAddress;
  }
  return normalizedAddress.startsWith(`${normalizedGrant.slice(0, -2)}:`);
}

export function addressGranted(grants: readonly string[], address: string): boolean {
  return grants.some((grant) => addressGrantMatches(grant, address));
}
