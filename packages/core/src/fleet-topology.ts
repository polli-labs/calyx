import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  GIT_PROBE_TIMEOUT_MS,
  HOSTS_TRUTH_RELATIVE_PATH,
  resolveAgentsInfraRoot,
  resolveExplicitAgentsInfraRoot,
} from "./agents-infra";
import { canonicalizeJcs } from "./state/canonical-json";

export const FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION =
  "fleet-topology-snapshot/v1" as const;
export const FLEET_TOPOLOGY_TARGETS_SCHEMA_VERSION =
  "fleet-topology-targets/v1" as const;
export const FLEET_TOPOLOGY_SOURCE_REPOSITORY =
  "polli-labs/agents-infra" as const;
export const FLEET_TOPOLOGY_RESOLVER_IDENTITY =
  "@polli-labs/calyx-core/fleet-topology-resolver@v1" as const;

export const FLEET_TOPOLOGY_EXPECTED_SURFACES = [
  "topology",
  "reachability",
  "toolchain",
  "clone",
  "promoted",
  "running",
  "daemon",
  "state_schema",
  "config",
  "skills",
  "hot_instruction",
] as const;

export type FleetTopologyExpectedSurface =
  (typeof FLEET_TOPOLOGY_EXPECTED_SURFACES)[number];
export type FleetTopologyDesiredMembership = "active" | "withdrawn";
export type FleetTopologyCatchUpPolicy = "required_before_start";
export type FleetTopologyResolutionIntent = "read_only" | "mutating";

export type FleetTopologyAuthorityReason =
  | "source_root_unavailable"
  | "source_git_unavailable"
  | "source_repository_ambiguous"
  | "source_ref_ambiguous"
  | "source_changed_during_resolution"
  | "source_dirty"
  | "source_invalid";

export interface FleetTopologyHostRecord {
  owner: string;
  desired_membership: FleetTopologyDesiredMembership;
  roles: string[];
  expected_surface_profile: string;
  expected_surfaces: FleetTopologyExpectedSurface[];
  run_serve_url: string | null;
  catch_up_policy: FleetTopologyCatchUpPolicy;
}

export interface FleetTopologyTarget extends FleetTopologyHostRecord {
  host: string;
}

export interface FleetTopologyValidationIssue {
  code: string;
  message: string;
  host: string | null;
  field: string | null;
}

export interface FleetTopologySnapshotV1 {
  schema_version: typeof FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION;
  source: {
    repository: typeof FLEET_TOPOLOGY_SOURCE_REPOSITORY;
    root: string | null;
    path: string | null;
    ref: string | null;
    commit: string | null;
    dirty: boolean | null;
  };
  projection_sha256: string | null;
  hosts: Record<string, FleetTopologyHostRecord>;
  target_sets: {
    desired_active: string[];
    withdrawn: string[];
    all_enrolled: string[];
  };
  validation: {
    status: "valid" | "invalid" | "not_attempted";
    issues: FleetTopologyValidationIssue[];
  };
  authority: {
    status: "authoritative" | "non_authoritative";
    reasons: FleetTopologyAuthorityReason[];
    label: string;
  };
  resolved_at: string;
  resolver: typeof FLEET_TOPOLOGY_RESOLVER_IDENTITY;
}

export interface FleetTopologyTargetsV1 {
  schema_version: typeof FLEET_TOPOLOGY_TARGETS_SCHEMA_VERSION;
  intent: FleetTopologyResolutionIntent;
  snapshot: Pick<
    FleetTopologySnapshotV1,
    "schema_version" | "source" | "projection_sha256" | "resolved_at" | "resolver"
  >;
  authority: FleetTopologySnapshotV1["authority"];
  can_emit_green_verdict: boolean;
  desired_active: FleetTopologyTarget[];
  withdrawn: FleetTopologyTarget[];
  all_enrolled: FleetTopologyTarget[];
}

export interface LoadFleetTopologySnapshotOptions {
  agentsInfraRoot?: string;
  /**
   * `strict_checkout` preserves the B2 mutation-authority contract: the
   * checkout must be clean and exactly at its configured upstream ref.
   * `resolved_ref` reads committed topology content from that upstream ref,
   * so a fetch that advances the ref ahead of the checkout is benign for
   * host-local workload admission.
   */
  sourceAuthority?: "strict_checkout" | "resolved_ref";
}

interface ValidatedEnrolledHostProjection {
  expectedSurfaceProfiles: Record<string, FleetTopologyExpectedSurface[]>;
  hosts: Record<string, FleetTopologyHostRecord>;
}

type NormalizedFleetTopologyHost = Omit<
  FleetTopologyHostRecord,
  "expected_surface_profile"
>;

interface NormalizedFleetTopologyProjection {
  hosts: Record<string, NormalizedFleetTopologyHost>;
}

interface GitCommandResult {
  ok: boolean;
  stdout: string;
}

interface GitSourceProbe {
  ok: boolean;
  topLevel: string | null;
  headRef: string | null;
  sourceRef: string | null;
  headCommit: string | null;
  sourceRefCommit: string | null;
  repository: string | null;
  dirty: boolean | null;
  status: string | null;
}

const execFileAsync = promisify(execFile);
const EXPECTED_SURFACE_SET = new Set<string>(FLEET_TOPOLOGY_EXPECTED_SURFACES);
const ENROLLMENT_FIELDS = new Set([
  "desired_membership",
  "expected_surface_profile",
  "catch_up_policy",
]);
const AUTHORITY_REASON_ORDER: readonly FleetTopologyAuthorityReason[] = [
  "source_root_unavailable",
  "source_git_unavailable",
  "source_repository_ambiguous",
  "source_ref_ambiguous",
  "source_changed_during_resolution",
  "source_dirty",
  "source_invalid",
];

class FleetTopologySourceValidationError extends Error {
  readonly code: string;
  readonly host: string | null;
  readonly field: string | null;

  constructor(
    code: string,
    message: string,
    details: { host?: string; field?: string } = {},
  ) {
    super(message);
    this.name = "FleetTopologySourceValidationError";
    this.code = code;
    this.host = details.host ?? null;
    this.field = details.field ?? null;
  }
}

export class FleetTopologyAuthorityError extends Error {
  readonly reasons: FleetTopologyAuthorityReason[];

  constructor(reasons: readonly FleetTopologyAuthorityReason[]) {
    super(
      "Mutating fleet target resolution requires an authoritative "
      + `${FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION}; refusal reasons: ${reasons.join(", ")}.`,
    );
    this.name = "FleetTopologyAuthorityError";
    this.reasons = [...reasons];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim().toLowerCase()
    && /^[a-z][a-z0-9_-]*$/u.test(value);
}

function rejectSource(
  code: string,
  message: string,
  details: { host?: string; field?: string } = {},
): never {
  throw new FleetTopologySourceValidationError(code, message, details);
}

function usableFleetRouting(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

function validateEnrolledHostProjection(
  input: unknown,
  label: string,
): ValidatedEnrolledHostProjection {
  if (!isPlainObject(input) || !isPlainObject(input.hosts)) {
    rejectSource(
      "invalid_hosts_mapping",
      `${label}.hosts must be a mapping`,
      { field: "hosts" },
    );
  }

  const rawProfiles = input.expected_surface_profiles;
  if (!isPlainObject(rawProfiles) || Object.keys(rawProfiles).length === 0) {
    rejectSource(
      "invalid_surface_profiles",
      `${label}.expected_surface_profiles must be a non-empty mapping`,
      { field: "expected_surface_profiles" },
    );
  }

  const expectedSurfaceProfiles: Record<string, FleetTopologyExpectedSurface[]> = {};
  for (const profile of Object.keys(rawProfiles).sort()) {
    if (!canonicalToken(profile)) {
      rejectSource(
        "invalid_surface_profile",
        `${label}.expected_surface_profiles profile ${JSON.stringify(profile)} must be canonical lowercase`,
        { field: "expected_surface_profiles" },
      );
    }
    const rawSurfaces = rawProfiles[profile];
    if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
      rejectSource(
        "invalid_surface_profile",
        `${label}.expected_surface_profiles.${profile} must be a non-empty array`,
        { field: "expected_surface_profiles" },
      );
    }
    if (rawSurfaces.some(
      (surface) => typeof surface !== "string" || !EXPECTED_SURFACE_SET.has(surface),
    )) {
      const unknown = rawSurfaces.find(
        (surface) => typeof surface !== "string" || !EXPECTED_SURFACE_SET.has(surface),
      );
      rejectSource(
        "unknown_expected_surface",
        `${label}.expected_surface_profiles.${profile} contains unknown surface ${JSON.stringify(unknown)}`,
        { field: "expected_surface_profiles" },
      );
    }
    const surfaces = rawSurfaces as FleetTopologyExpectedSurface[];
    if (new Set(surfaces).size !== surfaces.length) {
      rejectSource(
        "invalid_surface_profile",
        `${label}.expected_surface_profiles.${profile} contains duplicate surfaces`,
        { field: "expected_surface_profiles" },
      );
    }
    expectedSurfaceProfiles[profile] = [...surfaces].sort();
  }

  const hosts: Record<string, FleetTopologyHostRecord> = {};
  const hostEntries = Object.entries(input.hosts)
    .sort(([left], [right]) => left.localeCompare(right));
  if (hostEntries.length === 0) {
    rejectSource(
      "invalid_hosts_mapping",
      `${label}.hosts must not be empty`,
      { field: "hosts" },
    );
  }

  for (const [host, rawEntry] of hostEntries) {
    const hostLabel = `${label}.hosts.${host}`;
    if (!isPlainObject(rawEntry)) {
      rejectSource("invalid_host_record", `${hostLabel} must be a mapping`, { host });
    }
    if (!Object.hasOwn(rawEntry, "owner")
      || typeof rawEntry.owner !== "string"
      || rawEntry.owner.trim().length === 0) {
      rejectSource(
        "missing_owner",
        `${hostLabel}.owner must be a non-empty accountable identity`,
        { host, field: "owner" },
      );
    }
    if (!canonicalToken(rawEntry.owner)) {
      rejectSource(
        "invalid_owner",
        `${hostLabel}.owner must be a canonical lowercase identity`,
        { host, field: "owner" },
      );
    }

    const rawRoles = rawEntry.roles;
    if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
      rejectSource(
        "empty_roles",
        `${hostLabel}.roles must be a non-empty array`,
        { host, field: "roles" },
      );
    }
    if (rawRoles.some((role) => !canonicalToken(role))
      || new Set(rawRoles).size !== rawRoles.length) {
      rejectSource(
        "invalid_roles",
        `${hostLabel}.roles must contain unique canonical lowercase roles`,
        { host, field: "roles" },
      );
    }

    const enrollment = rawEntry.enrollment;
    if (!isPlainObject(enrollment)) {
      rejectSource(
        "missing_enrollment",
        `${hostLabel}.enrollment must be a mapping`,
        { host, field: "enrollment" },
      );
    }
    const unsupportedFields = Object.keys(enrollment)
      .filter((field) => !ENROLLMENT_FIELDS.has(field))
      .sort();
    if (unsupportedFields.length > 0) {
      rejectSource(
        "unsupported_enrollment_field",
        `${hostLabel}.enrollment has unsupported field(s): ${unsupportedFields.join(", ")}`,
        { host, field: "enrollment" },
      );
    }
    const missingFields = [...ENROLLMENT_FIELDS]
      .filter((field) => !Object.hasOwn(enrollment, field));
    if (missingFields.length > 0) {
      rejectSource(
        "missing_enrollment_field",
        `${hostLabel}.enrollment is missing required field(s): ${missingFields.join(", ")}`,
        { host, field: "enrollment" },
      );
    }

    const desiredMembership = enrollment.desired_membership;
    if (desiredMembership !== "active" && desiredMembership !== "withdrawn") {
      rejectSource(
        "invalid_desired_membership",
        `${hostLabel}.enrollment.desired_membership must be active or withdrawn`,
        { host, field: "desired_membership" },
      );
    }
    const expectedSurfaceProfile = enrollment.expected_surface_profile;
    if (typeof expectedSurfaceProfile !== "string"
      || !Object.hasOwn(expectedSurfaceProfiles, expectedSurfaceProfile)) {
      rejectSource(
        "unknown_surface_profile",
        `${hostLabel}.enrollment.expected_surface_profile names unknown profile ${JSON.stringify(expectedSurfaceProfile)}`,
        { host, field: "expected_surface_profile" },
      );
    }
    const catchUpPolicy = enrollment.catch_up_policy;
    if (catchUpPolicy !== "required_before_start") {
      rejectSource(
        "invalid_catch_up_policy",
        `${hostLabel}.enrollment.catch_up_policy must be required_before_start`,
        { host, field: "catch_up_policy" },
      );
    }
    if (desiredMembership === "active" && !usableFleetRouting(rawEntry.run_serve_url)) {
      rejectSource(
        "active_host_missing_routing",
        `${hostLabel} is desired-active but has no usable run_serve_url`,
        { host, field: "run_serve_url" },
      );
    }
    if (desiredMembership === "withdrawn"
      && rawEntry.run_serve_url !== undefined
      && !usableFleetRouting(rawEntry.run_serve_url)) {
      rejectSource(
        "invalid_fleet_routing",
        `${hostLabel}.run_serve_url is present but unusable`,
        { host, field: "run_serve_url" },
      );
    }

    const expectedSurfaces = expectedSurfaceProfiles[expectedSurfaceProfile]!;
    hosts[host] = {
      owner: rawEntry.owner,
      desired_membership: desiredMembership,
      roles: [...rawRoles as string[]].sort(),
      expected_surface_profile: expectedSurfaceProfile,
      expected_surfaces: [...expectedSurfaces],
      run_serve_url: usableFleetRouting(rawEntry.run_serve_url)
        ? rawEntry.run_serve_url
        : null,
      catch_up_policy: catchUpPolicy,
    };
  }

  return { expectedSurfaceProfiles, hosts };
}

async function runGit(root: string, args: readonly string[]): Promise<GitCommandResult> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, ...args],
      {
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
    );
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function canonicalGithubRepository(remoteUrl: string): string | null {
  const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/iu.exec(remoteUrl);
  if (scpMatch?.[1] && scpMatch[2]) {
    return `${scpMatch[1].toLowerCase()}/${scpMatch[2].toLowerCase()}`;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
    if (!segments[0] || !segments[1]) {
      return null;
    }
    return `${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

async function probeGitSource(root: string): Promise<GitSourceProbe> {
  const [topLevel, headRef, sourceRef, headCommit, sourceRefCommit, status, remotes] =
    await Promise.all([
      runGit(root, ["rev-parse", "--show-toplevel"]),
      runGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
      runGit(root, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
      runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]),
      runGit(root, ["rev-parse", "--verify", "@{upstream}^{commit}"]),
      runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      runGit(root, ["remote"]),
    ]);
  const canonicalSourceRef = sourceRef.ok
    && /^refs\/remotes\/[^/]+\/.+/u.test(sourceRef.stdout)
    ? sourceRef.stdout
    : null;
  const configuredRemotes = remotes.ok
    ? remotes.stdout.split("\n").filter((remote) => remote.length > 0)
    : [];
  const remoteName = canonicalSourceRef?.split("/")[2]
    ?? (configuredRemotes.length === 1 ? configuredRemotes[0]! : null);
  const remoteUrl = remoteName
    ? await runGit(root, ["remote", "get-url", remoteName])
    : { ok: false, stdout: "" };

  return {
    ok: topLevel.ok && headCommit.ok && status.ok,
    topLevel: topLevel.ok ? topLevel.stdout : null,
    headRef: headRef.ok ? headRef.stdout : null,
    sourceRef: canonicalSourceRef,
    headCommit: headCommit.ok ? headCommit.stdout.toLowerCase() : null,
    sourceRefCommit: sourceRefCommit.ok
      ? sourceRefCommit.stdout.toLowerCase()
      : null,
    repository: remoteUrl.ok ? canonicalGithubRepository(remoteUrl.stdout) : null,
    dirty: status.ok ? status.stdout.length > 0 : null,
    status: status.ok ? status.stdout : null,
  };
}

function sameGitProbe(left: GitSourceProbe, right: GitSourceProbe): boolean {
  return left.ok === right.ok
    && left.topLevel === right.topLevel
    && left.headRef === right.headRef
    && left.sourceRef === right.sourceRef
    && left.headCommit === right.headCommit
    && left.sourceRefCommit === right.sourceRefCommit
    && left.repository === right.repository
    && left.dirty === right.dirty
    && left.status === right.status;
}

function sameResolvedRefProbe(left: GitSourceProbe, right: GitSourceProbe): boolean {
  return left.ok === right.ok
    && left.topLevel === right.topLevel
    && left.sourceRef === right.sourceRef
    && left.sourceRefCommit === right.sourceRefCommit
    && left.repository === right.repository;
}

function normalizedProjection(
  hosts: Readonly<Record<string, FleetTopologyHostRecord>>,
): NormalizedFleetTopologyProjection {
  const normalizedHosts: Record<string, NormalizedFleetTopologyHost> = {};
  for (const host of Object.keys(hosts).sort()) {
    const record = hosts[host]!;
    normalizedHosts[host] = {
      owner: record.owner,
      desired_membership: record.desired_membership,
      roles: [...record.roles].sort(),
      expected_surfaces: [...record.expected_surfaces].sort(),
      run_serve_url: record.run_serve_url,
      catch_up_policy: record.catch_up_policy,
    };
  }
  return { hosts: normalizedHosts };
}

function projectionDigest(hosts: Readonly<Record<string, FleetTopologyHostRecord>>): string {
  return createHash("sha256")
    .update(canonicalizeJcs(normalizedProjection(hosts)), "utf8")
    .digest("hex");
}

function targetSets(hosts: Readonly<Record<string, FleetTopologyHostRecord>>):
FleetTopologySnapshotV1["target_sets"] {
  const allEnrolled = Object.keys(hosts).sort();
  return {
    desired_active: allEnrolled.filter(
      (host) => hosts[host]?.desired_membership === "active",
    ),
    withdrawn: allEnrolled.filter(
      (host) => hosts[host]?.desired_membership === "withdrawn",
    ),
    all_enrolled: allEnrolled,
  };
}

function orderedReasons(
  reasons: ReadonlySet<FleetTopologyAuthorityReason>,
): FleetTopologyAuthorityReason[] {
  return AUTHORITY_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function validationIssue(error: FleetTopologySourceValidationError):
FleetTopologyValidationIssue {
  return {
    code: error.code,
    message: error.message,
    host: error.host,
    field: error.field,
  };
}

/**
 * Loads the B1 enrolled-host authority through Calyx's existing agents-infra
 * root resolution, then binds its expanded projection to Git and SHA-256
 * identity. Invalid or non-authoritative inputs remain inspectable but carry
 * no mutation authority.
 */
export async function loadFleetTopologySnapshot(
  options: LoadFleetTopologySnapshotOptions = {},
): Promise<FleetTopologySnapshotV1> {
  const sourceAuthority = options.sourceAuthority ?? "strict_checkout";
  const resolvedRoot = options.agentsInfraRoot
    ? await resolveExplicitAgentsInfraRoot(options.agentsInfraRoot)
    : await resolveAgentsInfraRoot();
  const reasons = new Set<FleetTopologyAuthorityReason>();
  let root: string | null = null;
  let sourcePath: string | null = null;
  let probeBefore: GitSourceProbe | null = null;
  let probeAfter: GitSourceProbe | null = null;
  let hosts: Record<string, FleetTopologyHostRecord> = {};
  let issues: FleetTopologyValidationIssue[] = [];

  if (resolvedRoot) {
    root = await realpath(resolvedRoot).catch(() => null);
  }
  if (!root) {
    reasons.add("source_root_unavailable");
  } else {
    sourcePath = path.join(root, HOSTS_TRUTH_RELATIVE_PATH);
    probeBefore = await probeGitSource(root);
    try {
      const rawText = sourceAuthority === "resolved_ref"
        ? await (async (): Promise<string> => {
            if (!probeBefore?.sourceRefCommit) {
              throw new FleetTopologySourceValidationError(
                "source_read_failed",
                `Unable to resolve committed ${HOSTS_TRUTH_RELATIVE_PATH} authority`,
              );
            }
            const committed = await runGit(root, [
              "show",
              `${probeBefore.sourceRefCommit}:${HOSTS_TRUTH_RELATIVE_PATH}`,
            ]);
            if (!committed.ok) {
              throw new FleetTopologySourceValidationError(
                "source_read_failed",
                `Unable to read committed ${HOSTS_TRUTH_RELATIVE_PATH} authority`,
              );
            }
            return committed.stdout;
          })()
        : await readFile(sourcePath, "utf8");
      let parsed: unknown;
      try {
        parsed = YAML.parse(rawText) as unknown;
      } catch {
        throw new FleetTopologySourceValidationError(
          "invalid_yaml",
          `${HOSTS_TRUTH_RELATIVE_PATH} is not valid YAML`,
        );
      }
      hosts = validateEnrolledHostProjection(parsed, HOSTS_TRUTH_RELATIVE_PATH).hosts;
    } catch (error) {
      const validationError = error instanceof FleetTopologySourceValidationError
        ? error
        : new FleetTopologySourceValidationError(
          "source_read_failed",
          `Unable to read ${HOSTS_TRUTH_RELATIVE_PATH}`,
        );
      issues = [validationIssue(validationError)];
      reasons.add("source_invalid");
    }
    probeAfter = await probeGitSource(root);

    if (!probeBefore.ok || !probeAfter.ok) {
      reasons.add("source_git_unavailable");
    }
    if (probeAfter.topLevel === null
      || await realpath(probeAfter.topLevel).catch(() => null) !== root
      || probeAfter.repository !== FLEET_TOPOLOGY_SOURCE_REPOSITORY) {
      reasons.add("source_repository_ambiguous");
    }
    if (probeAfter.sourceRef === null
      || probeAfter.sourceRefCommit === null
      || (
        sourceAuthority === "strict_checkout"
        && (probeAfter.headRef === null
          || probeAfter.headCommit === null
          || probeAfter.headCommit !== probeAfter.sourceRefCommit)
      )) {
      reasons.add("source_ref_ambiguous");
    }
    const sourceStable = sourceAuthority === "resolved_ref"
      ? sameResolvedRefProbe(probeBefore, probeAfter)
      : sameGitProbe(probeBefore, probeAfter);
    if (!sourceStable) {
      reasons.add("source_changed_during_resolution");
    }
    if (sourceAuthority === "strict_checkout" && probeAfter.dirty === true) {
      reasons.add("source_dirty");
    }
  }

  const reasonList = orderedReasons(reasons);
  const authoritative = reasonList.length === 0;
  const authority: FleetTopologySnapshotV1["authority"] = {
    status: authoritative ? "authoritative" : "non_authoritative",
    reasons: reasonList,
    label: authoritative
      ? "authoritative fleet topology snapshot"
      : `non-authoritative fleet topology snapshot: ${reasonList.join(", ")}`,
  };

  return {
    schema_version: FLEET_TOPOLOGY_SNAPSHOT_SCHEMA_VERSION,
    source: {
      repository: FLEET_TOPOLOGY_SOURCE_REPOSITORY,
      root,
      path: sourcePath,
      ref: sourceAuthority === "resolved_ref"
        ? probeBefore?.sourceRef ?? null
        : probeAfter?.sourceRef ?? null,
      commit: sourceAuthority === "resolved_ref"
        ? probeBefore?.sourceRefCommit ?? null
        : probeAfter?.headCommit ?? null,
      dirty: probeAfter?.dirty ?? null,
    },
    projection_sha256: issues.length === 0 && root
      ? projectionDigest(hosts)
      : null,
    hosts,
    target_sets: targetSets(hosts),
    validation: {
      status: root === null
        ? "not_attempted"
        : issues.length === 0 ? "valid" : "invalid",
      issues,
    },
    authority,
    resolved_at: new Date().toISOString(),
    resolver: FLEET_TOPOLOGY_RESOLVER_IDENTITY,
  };
}

function recordsFor(
  snapshot: FleetTopologySnapshotV1,
  hosts: readonly string[],
): FleetTopologyTarget[] {
  return hosts.flatMap((host) => {
    const record = snapshot.hosts[host];
    return record ? [{
      host,
      ...record,
      roles: [...record.roles],
      expected_surfaces: [...record.expected_surfaces],
    }] : [];
  });
}

/**
 * Resolves every B3 fleet target set from one snapshot. Callers must declare
 * whether they are only displaying the snapshot or intend to mutate fleet
 * state; non-authoritative snapshots can never cross the mutating boundary.
 */
export function resolveFleetTopologyTargets(
  snapshot: FleetTopologySnapshotV1,
  intent: FleetTopologyResolutionIntent,
): FleetTopologyTargetsV1 {
  if (intent === "mutating" && snapshot.authority.status !== "authoritative") {
    throw new FleetTopologyAuthorityError(snapshot.authority.reasons);
  }
  return {
    schema_version: FLEET_TOPOLOGY_TARGETS_SCHEMA_VERSION,
    intent,
    snapshot: {
      schema_version: snapshot.schema_version,
      source: snapshot.source,
      projection_sha256: snapshot.projection_sha256,
      resolved_at: snapshot.resolved_at,
      resolver: snapshot.resolver,
    },
    authority: snapshot.authority,
    can_emit_green_verdict: snapshot.authority.status === "authoritative",
    desired_active: recordsFor(snapshot, snapshot.target_sets.desired_active),
    withdrawn: recordsFor(snapshot, snapshot.target_sets.withdrawn),
    all_enrolled: recordsFor(snapshot, snapshot.target_sets.all_enrolled),
  };
}
