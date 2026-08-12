import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  FLEET_TOPOLOGY_EXPECTED_SURFACES,
  FLEET_TOPOLOGY_RESOLVER_IDENTITY,
  FleetTopologyAuthorityError,
  loadFleetTopologySnapshot,
  resolveFleetTopologyTargets,
  applyStateMigrations,
  createInterimWorkloadAdmissionReconciler,
} from "../index";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();

interface HostInput {
  owner: string;
  roles: string[];
  run_serve_url?: string;
  enrollment?: {
    desired_membership: "active" | "withdrawn";
    expected_surface_profile: string;
    catch_up_policy: "required_before_start";
  };
  [key: string]: unknown;
}

interface TruthInput {
  expected_surface_profiles: Record<string, readonly string[]>;
  hosts: Record<string, HostInput>;
  [key: string]: unknown;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

function enrollment(desiredMembership: "active" | "withdrawn") {
  return {
    desired_membership: desiredMembership,
    expected_surface_profile: "managed-calyx-host",
    catch_up_policy: "required_before_start" as const,
  };
}

function baseTruth(): TruthInput {
  return {
    expected_surface_profiles: {
      "managed-calyx-host": [...FLEET_TOPOLOGY_EXPECTED_SURFACES],
    },
    hosts: {
      blade: {
        owner: "caleb",
        roles: ["hub", "compute"],
        run_serve_url: "http://blade:8740",
        enrollment: enrollment("active"),
      },
      worm: {
        owner: "caleb",
        roles: ["compute"],
        run_serve_url: "http://worm:8740",
        enrollment: enrollment("withdrawn"),
      },
    },
  };
}

async function createAgentsInfraSource(truth: TruthInput): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-fleet-topology-"));
  roots.add(root);
  await mkdir(path.join(root, "fleet", "truths"), { recursive: true });
  await mkdir(path.join(root, "instructions", "skills"), { recursive: true });
  await mkdir(path.join(root, "instructions", "templates"), { recursive: true });
  await writeFile(
    path.join(root, "fleet", "truths", "hosts.yaml"),
    YAML.stringify(truth),
    "utf8",
  );
  await writeFile(
    path.join(root, "instructions", "skills", "SOURCES.json"),
    "{}\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "instructions", "templates", "REGISTRY.json"),
    "{}\n",
    "utf8",
  );
  await writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, [
    "remote",
    "add",
    "origin",
    "https://github.com/polli-labs/agents-infra.git",
  ]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["update-ref", "refs/remotes/origin/main", head]);
  await git(root, ["branch", "--set-upstream-to=origin/main", "main"]);
  return root;
}

async function commitTruth(
  root: string,
  truth: TruthInput,
  options: { updateCanonicalRef?: boolean } = {},
): Promise<string> {
  await writeFile(
    path.join(root, "fleet", "truths", "hosts.yaml"),
    YAML.stringify(truth),
    "utf8",
  );
  await git(root, ["add", "fleet/truths/hosts.yaml"]);
  await git(root, ["commit", "-m", "update truth"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (options.updateCanonicalRef !== false) {
    await git(root, ["update-ref", "refs/remotes/origin/main", head]);
  }
  return head;
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("fleet topology snapshot", () => {
  test("opens the D1 interim receipt on topology, reachability, clean build, and current schema", async () => {
    const agentsInfraRoot = await createAgentsInfraSource(baseTruth());
    const stateRoot = await mkdtemp(path.join(tmpdir(), "calyx-workload-admission-state-"));
    roots.add(stateRoot);
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: stateRoot },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const reconcile = createInterimWorkloadAdmissionReconciler({
      agentsInfraRoot,
      stateStoreOptions,
      reachability: "daemon_listener",
      build: {
        schema_version: "build-info/v1",
        git_head: "a".repeat(40),
        built_at: "2026-08-02T12:00:00.000Z",
        package_version: "0.2.0",
        branch: "main",
        dirty: false,
      },
      now: () => new Date("2026-08-02T12:00:01.000Z"),
    });

    await expect(reconcile({ host: "blade" })).resolves.toMatchObject({
      schema_version: "calyx.workload-admission-gate-receipt/v1",
      profile: "d1-interim-topology-reachability-build-schema",
      evaluated_surfaces: ["topology", "reachability", "running", "state_schema"],
      deferred_surfaces: [
        "toolchain", "clone", "promoted", "daemon", "config", "skills", "hot_instruction",
      ],
      host: "blade",
      desired_membership: "active",
      checks: {
        topology: { status: "pass", authority: "authoritative" },
        reachability: { status: "pass", evidence: "daemon_listener" },
        running: { status: "pass", dirty: false },
        state_schema: { status: "pass" },
      },
    });
    await expect(reconcile({ host: "worm" })).rejects.toMatchObject({
      reason: "withdrawn",
      failedSurface: "topology",
      nextAction: expect.stringContaining("authoritative fleet lifecycle"),
    });

    const dirtyBuildReconcile = createInterimWorkloadAdmissionReconciler({
      agentsInfraRoot,
      stateStoreOptions,
      reachability: "daemon_listener",
      build: {
        schema_version: "build-info/v1",
        git_head: "a".repeat(40),
        built_at: "2026-08-02T12:00:00.000Z",
        package_version: "0.2.0",
        branch: "main",
        dirty: true,
      },
    });
    await expect(dirtyBuildReconcile({ host: "blade" })).rejects.toMatchObject({
      reason: "convergence_drift",
      failedSurface: "running",
      nextAction: "Run `calyx self upgrade --host blade --yes --json`, then retry the launch.",
    });
  });

  test("fetch-then-evaluate admits resolved authority ahead of the checkout", async () => {
    const agentsInfraRoot = await createAgentsInfraSource(baseTruth());
    const checkoutHead = await git(agentsInfraRoot, ["rev-parse", "HEAD"]);
    const fetchedTruth = structuredClone(baseTruth());
    fetchedTruth.hosts.blade!.roles = ["compute", "dev", "hub"];
    const fetchedCommit = await commitTruth(
      agentsInfraRoot,
      fetchedTruth,
      { updateCanonicalRef: false },
    );
    await git(agentsInfraRoot, ["reset", "--hard", checkoutHead]);
    await git(agentsInfraRoot, [
      "fetch",
      "--force",
      ".",
      `${fetchedCommit}:refs/remotes/origin/main`,
    ]);

    const strictCheckout = await loadFleetTopologySnapshot({ agentsInfraRoot });
    expect(strictCheckout.authority.reasons).toContain("source_ref_ambiguous");

    const resolvedAuthority = await loadFleetTopologySnapshot({
      agentsInfraRoot,
      sourceAuthority: "resolved_ref",
    });
    expect(resolvedAuthority).toMatchObject({
      source: { commit: fetchedCommit },
      authority: { status: "authoritative", reasons: [] },
      hosts: { blade: { roles: ["compute", "dev", "hub"] } },
    });

    const stateRoot = await mkdtemp(path.join(tmpdir(), "calyx-workload-admission-fetch-"));
    roots.add(stateRoot);
    const stateStoreOptions = {
      env: { ...process.env, CALYX_STATE_HOME: stateRoot },
    };
    await applyStateMigrations({ storeOptions: stateStoreOptions });
    const reconcile = createInterimWorkloadAdmissionReconciler({
      agentsInfraRoot,
      stateStoreOptions,
      reachability: "daemon_listener",
      build: {
        schema_version: "build-info/v1",
        git_head: "a".repeat(40),
        built_at: "2026-08-02T12:00:00.000Z",
        package_version: "0.2.0",
        branch: "main",
        dirty: false,
      },
    });

    await expect(reconcile({ host: "blade" })).resolves.toMatchObject({
      topology: { source_commit: fetchedCommit },
      checks: { topology: { status: "pass", authority: "authoritative" } },
    });
  });

  test("binds the expanded B1 projection to canonical source identity", async () => {
    const root = await createAgentsInfraSource(baseTruth());
    const head = await git(root, ["rev-parse", "HEAD"]);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });

    expect(snapshot).toMatchObject({
      schema_version: "fleet-topology-snapshot/v1",
      source: {
        repository: "polli-labs/agents-infra",
        ref: "refs/remotes/origin/main",
        commit: head,
        dirty: false,
      },
      validation: { status: "valid", issues: [] },
      authority: {
        status: "authoritative",
        reasons: [],
        label: "authoritative fleet topology snapshot",
      },
      resolver: FLEET_TOPOLOGY_RESOLVER_IDENTITY,
      target_sets: {
        desired_active: ["blade"],
        withdrawn: ["worm"],
        all_enrolled: ["blade", "worm"],
      },
    });
    expect(snapshot.projection_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Date(snapshot.resolved_at).toISOString()).toBe(snapshot.resolved_at);
    expect(snapshot.hosts.blade?.roles).toEqual(["compute", "hub"]);
    expect(snapshot.hosts.blade?.expected_surfaces).toEqual(
      [...FLEET_TOPOLOGY_EXPECTED_SURFACES].sort(),
    );

    const targets = resolveFleetTopologyTargets(snapshot, "mutating");
    expect(targets.can_emit_green_verdict).toBe(true);
    expect(targets.desired_active.map((target) => target.host)).toEqual(["blade"]);
    expect(targets.withdrawn.map((target) => target.host)).toEqual(["worm"]);
    expect(targets.all_enrolled.map((target) => target.host)).toEqual([
      "blade",
      "worm",
    ]);
  });

  test("URL, hosts.yaml key, and daemon-record presence cannot imply active membership", async () => {
    const truth = baseTruth();
    truth.hosts = {
      blade: truth.hosts.blade!,
      daemon_record: {
        owner: "caleb",
        roles: ["compute"],
        enrollment: enrollment("withdrawn"),
        consumer_api_credentials: [
          {
            client_id: "daemon:daemon_record",
            verifier_env: "DAEMON_VERIFIER",
            token_env: "DAEMON_TOKEN",
          },
        ],
        services: ["calyx-run-service"],
      },
      key_only: {
        owner: "caleb",
        roles: ["dev"],
        enrollment: enrollment("withdrawn"),
      },
      url_only: {
        owner: "caleb",
        roles: ["compute"],
        run_serve_url: "http://url-only:8740",
        enrollment: enrollment("withdrawn"),
      },
    };
    const root = await createAgentsInfraSource(truth);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });
    const targets = resolveFleetTopologyTargets(snapshot, "read_only");

    expect(targets.desired_active.map((target) => target.host)).toEqual(["blade"]);
    expect(targets.withdrawn.map((target) => target.host)).toEqual([
      "daemon_record",
      "key_only",
      "url_only",
    ]);
    expect(targets.all_enrolled.map((target) => target.host)).toEqual([
      "blade",
      "daemon_record",
      "key_only",
      "url_only",
    ]);
  });

  test("hosts.yaml key presence without enrollment invalidates the snapshot", async () => {
    const truth = baseTruth();
    truth.hosts.orphan = {
      owner: "caleb",
      roles: ["compute"],
      run_serve_url: "http://orphan:8740",
    };
    const root = await createAgentsInfraSource(truth);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });
    const display = resolveFleetTopologyTargets(snapshot, "read_only");

    expect(snapshot.validation).toMatchObject({
      status: "invalid",
      issues: [{ code: "missing_enrollment", host: "orphan", field: "enrollment" }],
    });
    expect(snapshot.projection_sha256).toBeNull();
    expect(snapshot.target_sets.desired_active).toEqual([]);
    expect(snapshot.authority).toMatchObject({
      status: "non_authoritative",
      reasons: ["source_invalid"],
    });
    expect(display.can_emit_green_verdict).toBe(false);
    expect(display.authority.label).toContain("non-authoritative");
    expect(() => resolveFleetTopologyTargets(snapshot, "mutating"))
      .toThrow(FleetTopologyAuthorityError);
  });

  test("digest excludes credential, daemon, and unrelated host facts", async () => {
    const initial = baseTruth();
    initial.hosts.worm = {
      ...initial.hosts.worm!,
      consumer_api_credentials: [{
        client_id: "daemon:worm",
        token_env: "FIRST_TOKEN_NAME",
      }],
      services: ["old-daemon-record"],
      notes: "first",
    };
    const root = await createAgentsInfraSource(initial);
    const before = await loadFleetTopologySnapshot({ agentsInfraRoot: root });

    const changed = structuredClone(initial);
    changed.hosts = {
      worm: {
        ...changed.hosts.worm!,
        consumer_api_credentials: [{
          client_id: "daemon:worm",
          token_env: "SECOND_TOKEN_NAME",
        }],
        services: ["replacement-daemon-record"],
        notes: "second",
      },
      blade: changed.hosts.blade!,
    };
    const nextHead = await commitTruth(root, changed);
    const after = await loadFleetTopologySnapshot({ agentsInfraRoot: root });

    expect(before.authority.status).toBe("authoritative");
    expect(after.authority.status).toBe("authoritative");
    expect(after.source.commit).toBe(nextHead);
    expect(after.source.commit).not.toBe(before.source.commit);
    expect(after.projection_sha256).toBe(before.projection_sha256);
    expect(after.target_sets).toEqual(before.target_sets);
  });

  test("dirty snapshots remain inspectable but refuse mutating targets", async () => {
    const root = await createAgentsInfraSource(baseTruth());
    await writeFile(path.join(root, "README.md"), "dirty\n", "utf8");

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });
    const display = resolveFleetTopologyTargets(snapshot, "read_only");

    expect(snapshot.projection_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.authority.reasons).toEqual(["source_dirty"]);
    expect(display.desired_active.map((target) => target.host)).toEqual(["blade"]);
    expect(display.can_emit_green_verdict).toBe(false);
    expect(() => resolveFleetTopologyTargets(snapshot, "mutating")).toThrow(
      /source_dirty/u,
    );
  });

  test("detached HEAD is source-ref-ambiguous and cannot authorize mutation", async () => {
    const root = await createAgentsInfraSource(baseTruth());
    await git(root, ["checkout", "--detach"]);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });
    const display = resolveFleetTopologyTargets(snapshot, "read_only");

    expect(snapshot.source.ref).toBeNull();
    expect(snapshot.authority.reasons).toEqual(["source_ref_ambiguous"]);
    expect(display.can_emit_green_verdict).toBe(false);
    expect(() => resolveFleetTopologyTargets(snapshot, "mutating"))
      .toThrow(/source_ref_ambiguous/u);
  });

  test("a clean local commit ahead of the canonical ref remains non-authoritative", async () => {
    const root = await createAgentsInfraSource(baseTruth());
    const next = structuredClone(baseTruth());
    next.hosts.blade!.notes = "unpublished";
    const head = await commitTruth(root, next, { updateCanonicalRef: false });

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });

    expect(snapshot.source.commit).toBe(head);
    expect(snapshot.source.dirty).toBe(false);
    expect(snapshot.authority.reasons).toEqual(["source_ref_ambiguous"]);
    expect(() => resolveFleetTopologyTargets(snapshot, "mutating"))
      .toThrow(/source_ref_ambiguous/u);
  });

  test("an unexpected source repository cannot authorize mutation", async () => {
    const root = await createAgentsInfraSource(baseTruth());
    await git(root, [
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/not-agents-infra.git",
    ]);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });

    expect(snapshot.authority.reasons).toEqual(["source_repository_ambiguous"]);
    expect(() => resolveFleetTopologyTargets(snapshot, "mutating"))
      .toThrow(/source_repository_ambiguous/u);
  });

  test("an unavailable explicit source root is labeled instead of falling back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-fleet-topology-invalid-"));
    roots.add(root);

    const snapshot = await loadFleetTopologySnapshot({ agentsInfraRoot: root });
    const display = resolveFleetTopologyTargets(snapshot, "read_only");

    expect(snapshot.source.root).toBeNull();
    expect(snapshot.validation).toEqual({ status: "not_attempted", issues: [] });
    expect(snapshot.authority.reasons).toEqual(["source_root_unavailable"]);
    expect(display.can_emit_green_verdict).toBe(false);
  });
});
