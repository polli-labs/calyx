import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  CALYX_SERVER_STARTUP_CONTRACT,
  applyStateMigrations,
  evaluateStartupContract,
  resolveConsumerApiClientToken,
  resolveConsumerApiCredentialVerifiers,
  type CalyxDaemonDescriptor,
  type ConsumerApiCredentialTruth,
  type FleetConvergenceToolchainCheck,
} from "@polli-labs/calyx-core";
import {
  buildTargetStartupContractPayload,
  computeStartupContractVerdict,
  defaultResolveSupervisorEnvNames,
  inspectSupervisorDefinition,
  parseSupervisorProvidedEnvNames,
  PROJECTOR_CONTRACT_ENV,
  type SupervisorEnvInspection,
} from "../self-upgrade-startup-contract";
import {
  EXPECTED_DAEMON_BASELINE_FEATURES,
  formatSelfUpgradePlan,
  runSelfUpgrade as runSelfUpgradeImpl,
  type SelfUpgradeExecutionError,
} from "../commands/self-upgrade";

const runSelfUpgrade = (
  options: Parameters<typeof runSelfUpgradeImpl>[0],
  dependencies: Parameters<typeof runSelfUpgradeImpl>[1] = {},
) => runSelfUpgradeImpl(
  { ...options, targetOwnedExecution: true },
  {
    attestToolchain: async ({ host, targetSha }) => passingToolchainCheck(host, targetSha),
    ...dependencies,
  },
);

const CONTRACT_MANIFEST_PATH = "packages/core/startup-contract.json";
const CONTRACT_JSON = JSON.stringify(CALYX_SERVER_STARTUP_CONTRACT);
const CONTRACT_WITHOUT_PROJECTOR_MARKER = {
  ...CALYX_SERVER_STARTUP_CONTRACT,
  required_env: CALYX_SERVER_STARTUP_CONTRACT.required_env.filter((name) => name !== PROJECTOR_CONTRACT_ENV),
  required_env_values: undefined,
};
const CONTRACT_WITHOUT_PROJECTOR_MARKER_JSON = JSON.stringify(CONTRACT_WITHOUT_PROJECTOR_MARKER);
const ATTESTED_CONTRACT_JSON = CONTRACT_JSON;
const BEFORE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function passingToolchainCheck(host: string, targetSha: string | null): FleetConvergenceToolchainCheck {
  return {
    schema_version: "fleet-convergence-check/v1",
    surface: "toolchain",
    status: "pass",
    host,
    expected: { node_range: ">=22.13.0", package_manager: "pnpm", pnpm_version: "10.34.1" },
    observed: {
      process_exec_path_realpath: "/usr/bin/node",
      process_node_version: "v22.23.1",
      child_node: { executable_realpath: "/usr/bin/node", version: "v22.23.1", exit_code: 0 },
      child_pnpm: {
        executable_realpath: "/usr/bin/pnpm",
        resolution_source: "pnpm-exec-node-path",
        self_dispatched: { version: "10.34.1", exit_code: 0 },
        intrinsic: { version: "10.34.1", exit_code: 0, probe: "manage-package-manager-versions-disabled" },
        nested: { version: "10.34.1", exit_code: 0 },
      },
      bootstrap_cwd: "$CWD",
      spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1",
      environment_contract: "self-upgrade-bootstrap-isolated-env/v1",
      path_resolution: { observer: "parent_diagnostic", total_entries: 1, truncated: false, entries: [{ index: 0, directory: "/usr/bin" }] },
    },
    failures: [],
    checked_at: "2026-08-02T00:00:00.000Z",
    evidence: { source: "self-upgrade-bootstrap-attestation", spawn_contract: "@polli-labs/calyx/self-upgrade-child-spawn@v1" },
    freshness: { status: "current", observed_at: "2026-08-02T00:00:00.000Z" },
    topology_identity: { status: "not_bound" },
    target_bundle_identity: { calyx_source_sha: targetSha },
  };
}
const BLADE_CREDENTIALS = [{
  client_id: "daemon:blade",
  credential_tier: "internal_runtime",
  verifier_env: "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
  token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
  outbound: true,
  address_grants: { send_as: ["host:blade"], read: ["host:blade"] },
}] satisfies ConsumerApiCredentialTruth[];
const BLADE_CREDENTIAL_ENV_CONTRACT = {
  token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
  verifier_env: ["CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256"],
  allowed_secret_env: [
    "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
    "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
  ],
} as const;

const LINUX_PATH = "/home/caleb/.npm-global/bin:/home/caleb/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const MACOS_PATH = "/Users/carbon/.npm-global/bin:/Users/carbon/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

async function readBladeHostsTruth() {
  return { hosts: { blade: { consumer_api_credentials: BLADE_CREDENTIALS } } };
}

// The exact 2026-07-20 failure shape: an *old* service that launches via the
// general `with-polli-secrets` wrapper (no scoped projector args, no
// CALYX_HOST_ALIAS) supervising a *post-spine* target binary that requires
// CALYX_HOST_ALIAS. The wrapper only projects HOME/PATH here, so the required
// name is definitively absent.
const OLD_WITH_POLLI_SECRETS_UNIT = [
  "# /home/caleb/.config/systemd/user/calyx-run-serve.service",
  "[Unit]",
  "Description=Calyx RunService HTTP server",
  "After=network-online.target",
  "",
  "[Service]",
  "Type=simple",
  "Environment=HOME=/home/caleb",
  "Environment=PATH=/home/caleb/.agents/run:/usr/bin:/bin",
  "ExecStart=/home/caleb/.agents/run/with-polli-secrets /home/caleb/.agents/run/calyx run serve "
    + "--host 0.0.0.0 --port 8740 --runs-root /home/caleb/.calyx/runs --worktree-base /home/caleb/projects",
  "Restart=on-failure",
  "",
  "[Install]",
  "WantedBy=default.target",
].join("\n");

// The current agents-infra projection names each projected env but does not yet
// carry a version marker whose presence is also enforced by the boot contract.
const UNATTESTED_SCOPED_PROJECTOR_UNIT = [
  "[Service]",
  "Environment=HOME=/home/caleb",
  "Environment=PATH=/home/caleb/.agents/run:/usr/bin:/bin",
  "ExecStart=/home/caleb/.agents/run/with-scoped-polli-secrets --host blade "
    + "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN "
    + "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 "
    + "--opaque-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN "
    + "--sha256-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 "
    + "--fixed-env CALYX_HOST_ALIAS=blade --fixed-env CALYX_SYSTEMD_UNIT=calyx-run-serve.service "
    + "--fixed-env HOME=/home/caleb --fixed-env LOGNAME=caleb "
    + `--fixed-env PATH=${LINUX_PATH} --fixed-env USER=caleb `
    + "--fixed-env XDG_CONFIG_HOME=/home/caleb/.config "
    + "--preserve-env LANG -- /home/caleb/.agents/run/calyx run serve --host 0.0.0.0 --port 8740 "
    + "--runs-root /home/caleb/.calyx/runs --worktree-base /home/caleb/projects",
  "Restart=on-failure",
].join("\n");
const SCOPED_PROJECTOR_UNIT = UNATTESTED_SCOPED_PROJECTOR_UNIT.replace(
  "--fixed-env CALYX_HOST_ALIAS=blade",
  `--fixed-env CALYX_HOST_ALIAS=blade --fixed-env ${PROJECTOR_CONTRACT_ENV}=with-scoped-polli-secrets/v2`,
);
const LEGACY_V1_SCOPED_PROJECTOR_UNIT = SCOPED_PROJECTOR_UNIT
  .replace(
    `${PROJECTOR_CONTRACT_ENV}=with-scoped-polli-secrets/v2`,
    `${PROJECTOR_CONTRACT_ENV}=with-scoped-polli-secrets/v1`,
  )
  .replace(
    "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
    "--required-env CALYX_RUN_SERVER_TOKEN --opaque-env CALYX_RUN_SERVER_TOKEN "
      + "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
  );

const UNATTESTED_SCOPED_PROJECTOR_PLIST = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  "<dict>",
  "  <key>Label</key><string>com.pollilabs.calyx.run-serve</string>",
  "  <key>ProgramArguments</key>",
  "  <array>",
  "    <string>/Users/carbon/.agents/run/with-scoped-polli-secrets</string>",
  "    <string>--host</string><string>carbon</string>",
  "    <string>--fixed-env</string><string>CALYX_HOST_ALIAS=carbon</string>",
  "    <string>--fixed-env</string><string>HOME=/Users/carbon</string>",
  "    <string>--fixed-env</string><string>LOGNAME=carbon</string>",
  `    <string>--fixed-env</string><string>PATH=${MACOS_PATH}</string>`,
  "    <string>--fixed-env</string><string>USER=carbon</string>",
  "    <string>--fixed-env</string><string>XDG_CONFIG_HOME=/Users/carbon/.config</string>",
  "    <string>--</string>",
  "    <string>/Users/carbon/.agents/run/calyx</string>",
  "    <string>run</string><string>serve</string>",
  "    <string>--host</string><string>0.0.0.0</string>",
  "    <string>--port</string><string>8740</string>",
  "    <string>--runs-root</string><string>/Users/carbon/.calyx/runs</string>",
  "    <string>--worktree-base</string><string>/Users/carbon/projects</string>",
  "  </array>",
  "  <key>EnvironmentVariables</key>",
  "  <dict>",
  "    <key>PATH</key><string>/usr/bin:/bin</string>",
  "  </dict>",
  "</dict>",
  "</plist>",
].join("\n");
const SCOPED_PROJECTOR_PLIST = UNATTESTED_SCOPED_PROJECTOR_PLIST.replace(
  "<string>CALYX_HOST_ALIAS=carbon</string>",
  `<string>CALYX_HOST_ALIAS=carbon</string>\n    <string>--fixed-env</string><string>${PROJECTOR_CONTRACT_ENV}=with-scoped-polli-secrets/v2</string>`,
);

function executeProjectorFixture(
  unit: string,
  sourceValues: Readonly<Record<string, string>> = {},
  ambientEnv: Readonly<Record<string, string>> = {},
): { started: boolean; env?: Record<string, string>; error?: string } {
  const command = unit.split(/\r?\n/).find((line) => line.startsWith("ExecStart="))?.slice("ExecStart=".length);
  if (!command) return { started: false, error: "missing ExecStart" };
  const tokens = command.split(/\s+/);
  const separator = tokens.indexOf("--");
  if (separator < 0) return { started: false, error: "missing separator" };
  const required: string[] = [];
  const optional: string[] = [];
  const preserved: string[] = [];
  const opaque: string[] = [];
  const sha256: string[] = [];
  const fixed: Record<string, string> = {};
  const buckets: Record<string, string[]> = {
    "--required-env": required,
    "--optional-env": optional,
    "--preserve-env": preserved,
    "--opaque-env": opaque,
    "--sha256-env": sha256,
  };
  for (let index = 1; index < separator; index += 2) {
    const flag = tokens[index] ?? "";
    const value = tokens[index + 1] ?? "";
    if (flag === "--fixed-env") {
      const equals = value.indexOf("=");
      fixed[value.slice(0, equals)] = value.slice(equals + 1);
    } else {
      buckets[flag]?.push(value);
    }
  }
  const secretNames = new Set([...required, ...optional]);
  const validationExtras = [...opaque, ...sha256].filter((name) => !secretNames.has(name));
  if (validationExtras.length > 0) {
    return { started: false, error: `validation env names must also be required or optional: ${validationExtras.join(", ")}` };
  }
  const projectionNames = [...required, ...optional, ...preserved, ...Object.keys(fixed)];
  if (new Set(projectionNames).size !== projectionNames.length) {
    return { started: false, error: "required, optional, preserved, and fixed env sets must be disjoint" };
  }
  const missing = required.filter((name) => !(name in sourceValues));
  if (missing.length > 0) return { started: false, error: `missing: ${missing.join(", ")}` };
  const invalidOpaque = opaque.filter((name) =>
    name in sourceValues && !/^[A-Za-z0-9._~+/-]+={0,2}$/.test(sourceValues[name] ?? ""));
  const invalidSha256 = sha256.filter((name) =>
    name in sourceValues && !/^sha256:[0-9a-f]{64}$/.test(sourceValues[name] ?? ""));
  if (invalidOpaque.length > 0 || invalidSha256.length > 0) {
    return {
      started: false,
      error: `invalid_opaque=${invalidOpaque.join(",")} invalid_sha256=${invalidSha256.join(",")}`,
    };
  }
  const childEnv: Record<string, string> = { ...fixed };
  for (const name of required) childEnv[name] = sourceValues[name] ?? "";
  for (const name of optional) if (name in sourceValues) childEnv[name] = sourceValues[name] ?? "";
  for (const name of preserved) if (name in ambientEnv) childEnv[name] = ambientEnv[name] ?? "";
  const spawned = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    { encoding: "utf8", env: childEnv },
  );
  if (spawned.status !== 0) return { started: false, error: spawned.stderr };
  return { started: true, env: JSON.parse(spawned.stdout) as Record<string, string> };
}

function systemdDescriptor(overrides: Partial<CalyxDaemonDescriptor> = {}): CalyxDaemonDescriptor {
  return {
    schema_version: "calyx-daemon/v1",
    daemon_id: "run-serve",
    daemon_kind: "run-service",
    pid: 4242,
    argv: ["calyx", "run", "serve"],
    cwd: "/home/caleb/dev/calyx/dev",
    runs_root: "/home/caleb/.calyx/runs",
    health_url: "http://127.0.0.1:8740",
    livez_url: "http://127.0.0.1:8740/livez",
    supervisor: { kind: "systemd", unit_name: "calyx-run-serve.service" },
    started_at: "2026-07-20T00:00:00.000Z",
    build: { git_head: "before-sha", built_at: "2026-07-20T00:00:00.000Z", package_version: "0.2.0" },
    restart_order: 10,
    depends_on: [],
    maintenance_mode: false,
    ...overrides,
  };
}

function determined(
  names: string[],
  options: { includeHostCredentials?: boolean } = {},
): () => Promise<SupervisorEnvInspection> {
  const includeHostCredentials = options.includeHostCredentials ?? true;
  const provided = [...new Set([
    ...names,
    PROJECTOR_CONTRACT_ENV,
    ...(includeHostCredentials ? BLADE_CREDENTIAL_ENV_CONTRACT.allowed_secret_env : []),
  ])].sort();
  const fixedEnv = Object.fromEntries(provided
    .filter((name) => !name.startsWith("CALYX_CONSUMER_API_"))
    .map((name) => [name, name === PROJECTOR_CONTRACT_ENV
      ? "with-scoped-polli-secrets/v2"
      : name === "CALYX_HOST_ALIAS" ? "blade" : "fixture"]));
  const requiredEnv = provided.filter((name) => name.startsWith("CALYX_CONSUMER_API_"));
  return async () => ({
    status: "determined",
    provided_env: provided,
    source: "test-fixture",
    projection_contract: "with-scoped-polli-secrets/v2",
    projection: {
      required_env: requiredEnv,
      optional_env: [],
      preserved_env: [],
      fixed_env: fixedEnv,
      opaque_env: requiredEnv.filter((name) => name.endsWith("_TOKEN")),
      sha256_env: requiredEnv.filter((name) => name.includes("_VERIFIER")),
    },
  });
}

describe("parseSupervisorProvidedEnvNames", () => {
  test("the current generated path and argv remain unknown without a version marker", () => {
    const executed = executeProjectorFixture(UNATTESTED_SCOPED_PROJECTOR_UNIT, {
      CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "opaque-token",
      CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: `sha256:${"a".repeat(64)}`,
    });
    expect(executed.started).toBe(true);
    expect(executed.env).not.toHaveProperty(PROJECTOR_CONTRACT_ENV);
    expect(inspectSupervisorDefinition(
      UNATTESTED_SCOPED_PROJECTOR_UNIT,
      "systemd",
      "current agents-infra fixture",
      "blade",
    )).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(new RegExp(PROJECTOR_CONTRACT_ENV)),
    });
  });

  test("a broad wrapper is unknown without an effective-child-environment attestation", () => {
    expect(inspectSupervisorDefinition(OLD_WITH_POLLI_SECRETS_UNIT, "systemd", "fixture", "blade")).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/no names-only effective-child-environment attestation/),
    });
    const satisfyingBroadChild = {
      CALYX_HOST_ALIAS: "blade",
      [PROJECTOR_CONTRACT_ENV]: "with-scoped-polli-secrets/v2",
      CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "opaque-token",
      CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: `sha256:${"a".repeat(64)}`,
    };
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      { encoding: "utf8", env: satisfyingBroadChild },
    );
    expect(child.status).toBe(0);
    const effectiveNames = JSON.parse(child.stdout) as string[];
    expect(evaluateStartupContract(
      CALYX_SERVER_STARTUP_CONTRACT,
      effectiveNames,
      ["CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN", "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256"],
      satisfyingBroadChild,
    )).toMatchObject({
      missing_env: [],
      missing_consumer_api_secret_env: [],
      foreign_consumer_api_secret_env: [],
    });
  });

  test("a scoped-projector systemd unit projects CALYX_HOST_ALIAS via --fixed-env", () => {
    const names = parseSupervisorProvidedEnvNames(SCOPED_PROJECTOR_UNIT, "systemd", "blade");
    expect(names).toContain("CALYX_HOST_ALIAS");
    expect(names).toContain("CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN");
    expect(names).toContain("CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256");
    expect(names).not.toContain("LANG");
  });

  test.each([
    ["wrong --host", SCOPED_PROJECTOR_UNIT.replace("--host blade", "--host worm")],
    ["wrong fixed host alias", SCOPED_PROJECTOR_UNIT.replace("CALYX_HOST_ALIAS=blade", "CALYX_HOST_ALIAS=worm")],
  ])("%s cannot attest compatibility even when the child would start", (_label, unit) => {
    const sourceValues = {
      CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "opaque-token",
      CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: `sha256:${"a".repeat(64)}`,
    };
    const executed = executeProjectorFixture(unit, sourceValues);
    expect(executed.started).toBe(true);
    expect(executed.env?.CALYX_HOST_ALIAS).toBe(unit.includes("CALYX_HOST_ALIAS=worm") ? "worm" : "blade");
    expect(inspectSupervisorDefinition(unit, "systemd", "fixture", "blade")).toMatchObject({ status: "unknown" });
  });

  test("optional and preserved credential names are absent from both the effective child and guaranteed set", () => {
    const unit = SCOPED_PROJECTOR_UNIT
      .replace("--required-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN", "--optional-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN")
      .replace(
        "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
        "--optional-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
      )
      .replace("--preserve-env LANG", "--preserve-env LANG --preserve-env CALYX_CONSUMER_API_PRESERVED_TOKEN");
    const executed = executeProjectorFixture(unit);
    expect(executed.started).toBe(true);
    expect(executed.env).not.toHaveProperty("CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN");
    expect(executed.env).not.toHaveProperty("CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256");
    expect(executed.env).not.toHaveProperty("CALYX_CONSUMER_API_PRESERVED_TOKEN");
    const inspection = inspectSupervisorDefinition(unit, "systemd", "fixture", "blade");
    expect(inspection.status).toBe("determined");
    if (inspection.status === "determined") {
      expect(inspection.provided_env).not.toContain("CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN");
      expect(inspection.provided_env).not.toContain("CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256");
      const diff = evaluateStartupContract(
        CALYX_SERVER_STARTUP_CONTRACT,
        inspection.provided_env,
        ["CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN", "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256"],
      );
      expect(diff.missing_consumer_api_secret_env).toEqual([
        "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
        "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
      ]);
    }
  });

  test("validation-only and malformed projection relationships never attest an effective child", () => {
    const validationOnly = SCOPED_PROJECTOR_UNIT.replace(
      "--required-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 ",
      "",
    );
    expect(executeProjectorFixture(validationOnly)).toMatchObject({
      started: false,
      error: expect.stringMatching(/validation env names must also be required or optional/),
    });
    expect(inspectSupervisorDefinition(validationOnly, "systemd", "fixture", "blade"))
      .toMatchObject({ status: "unknown", reason: expect.stringMatching(/validation env names/) });

    const overlapping = SCOPED_PROJECTOR_UNIT.replace(
      "--fixed-env CALYX_HOST_ALIAS=blade",
      "--required-env CALYX_HOST_ALIAS --fixed-env CALYX_HOST_ALIAS=blade",
    );
    expect(executeProjectorFixture(overlapping)).toMatchObject({
      started: false,
      error: expect.stringMatching(/must be disjoint/),
    });
    expect(inspectSupervisorDefinition(overlapping, "systemd", "fixture", "blade"))
      .toMatchObject({ status: "unknown", reason: expect.stringMatching(/must be disjoint/) });
  });

  test("a required verifier without --sha256-env cannot attest compatibility", async () => {
    const unit = SCOPED_PROJECTOR_UNIT.replace(
      "--sha256-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 ",
      "",
    );
    const executed = executeProjectorFixture(unit, {
      CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "synthetic-token",
      CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: "malformed-verifier",
    });
    expect(executed.started).toBe(true);
    expect(executed.env).toHaveProperty(
      "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
      "malformed-verifier",
    );
    expect(() => resolveConsumerApiCredentialVerifiers(
      "blade",
      { consumer_api_credentials: BLADE_CREDENTIALS },
      executed.env,
    )).toThrow(/canonical sha256/);

    const inspection = inspectSupervisorDefinition(unit, "systemd", "fixture", "blade");
    expect(inspection.status).toBe("determined");
    const verdict = await computeStartupContractVerdict({
      host: "blade",
      repoRoot: "/repo",
      homeDir: () => "/home/caleb",
      pathExists: async () => false,
      consumerApiCredentialEnvContract: BLADE_CREDENTIAL_ENV_CONTRACT,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: async (args) => args[0] === "show"
        ? { code: 0, stdout: CONTRACT_JSON, stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
      resolveSupervisorEnvNames: async () => inspection,
    });
    expect(verdict).toMatchObject({
      status: "incompatible",
      mutation_disposition: "block",
      per_daemon: [expect.objectContaining({
        projection_violation: expect.stringMatching(/--sha256-env/),
      })],
    });
  });

  test.each([
    {
      label: "empty fixed token",
      unit: SCOPED_PROJECTOR_UNIT
        .replace("--required-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN ", "")
        .replace("--opaque-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN ", "")
        .replace("--fixed-env CALYX_HOST_ALIAS=blade", "--fixed-env CALYX_HOST_ALIAS=blade --fixed-env CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN="),
      source: { CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: `sha256:${"a".repeat(64)}` },
      envName: "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
      assertBootRejects: (env: NodeJS.ProcessEnv) => expect(() => resolveConsumerApiClientToken(
        "blade",
        { consumer_api_credentials: BLADE_CREDENTIALS },
        "daemon:blade",
        env,
      )).toThrow(/must be non-empty/),
    },
    {
      label: "malformed fixed verifier",
      unit: SCOPED_PROJECTOR_UNIT
        .replace("--required-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 ", "")
        .replace("--sha256-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256 ", "")
        .replace("--fixed-env CALYX_HOST_ALIAS=blade", "--fixed-env CALYX_HOST_ALIAS=blade --fixed-env CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256=malformed"),
      source: { CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "synthetic-token" },
      envName: "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
      assertBootRejects: (env: NodeJS.ProcessEnv) => expect(() => resolveConsumerApiCredentialVerifiers(
        "blade",
        { consumer_api_credentials: BLADE_CREDENTIALS },
        env,
      )).toThrow(/canonical sha256/),
    },
  ])("$label is visible in the true child env but never attests compatibility", async ({ unit, source, envName, assertBootRejects }) => {
    const executed = executeProjectorFixture(unit, source);
    expect(executed.started).toBe(true);
    expect(executed.env).toHaveProperty(envName);
    assertBootRejects(executed.env ?? {});
    const inspection = inspectSupervisorDefinition(unit, "systemd", "fixture", "blade");
    expect(inspection).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/unsupported generated fixed name/),
    });
    const verdict = await computeStartupContractVerdict({
      host: "blade",
      repoRoot: "/repo",
      homeDir: () => "/home/caleb",
      pathExists: async () => false,
      consumerApiCredentialEnvContract: BLADE_CREDENTIAL_ENV_CONTRACT,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: async (args) => args[0] === "show"
        ? { code: 0, stdout: CONTRACT_JSON, stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
      resolveSupervisorEnvNames: async () => inspection,
    });
    expect(verdict).toMatchObject({
      status: "unknown",
      mutation_disposition: "block",
      blocking_reasons: [expect.objectContaining({ code: "post_contract_supervisor_semantics_unproved" })],
    });
  });

  test("a scoped-projector launchd plist projects CALYX_HOST_ALIAS", () => {
    const names = parseSupervisorProvidedEnvNames(SCOPED_PROJECTOR_PLIST, "launchd", "carbon");
    expect(names).toContain("CALYX_HOST_ALIAS");
    expect(names).toContain("PATH");
  });

  test("a systemd EnvironmentFile= directive degrades to undefined (cannot enumerate safely)", () => {
    const unit = [
      "[Service]",
      "EnvironmentFile=/home/caleb/.config/calyx/run-serve.env",
      "ExecStart=/home/caleb/.agents/run/calyx run serve",
    ].join("\n");
    expect(parseSupervisorProvidedEnvNames(unit, "systemd", "blade")).toBeUndefined();
  });

  test("the default reader stays unknown when systemctl cannot reveal effective drop-ins", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "calyx-systemd-reader-"));
    try {
      const unitDir = path.join(homeRoot, ".config", "systemd", "user");
      const dropInDir = path.join(unitDir, "calyx-run-serve.service.d");
      await mkdir(dropInDir, { recursive: true });
      await writeFile(path.join(unitDir, "calyx-run-serve.service"), SCOPED_PROJECTOR_UNIT, "utf8");
      await writeFile(
        path.join(dropInDir, "override.conf"),
        "[Service]\nExecStart=\nExecStart=/usr/bin/env false\n",
        "utf8",
      );

      const inspection = await defaultResolveSupervisorEnvNames(
        systemdDescriptor(),
        homeRoot,
        "blade",
        async () => ({ code: 1, stdout: "", stderr: "systemctl unavailable" }),
      );

      expect(inspection).toMatchObject({
        status: "unknown",
        reason: expect.stringMatching(/authoritative systemctl --user cat.*bare unit file cannot prove effective systemd composition/),
      });
      expect(inspection.status).not.toBe("determined");
      expect(inspection.status).not.toBe("incompatible");
      const verdict = await computeStartupContractVerdict({
        host: "blade",
        repoRoot: "/repo",
        homeDir: () => homeRoot,
        pathExists: async () => false,
        consumerApiCredentialEnvContract: BLADE_CREDENTIAL_ENV_CONTRACT,
        daemons: [systemdDescriptor()],
        source: { kind: "git", ref: TARGET_SHA },
        execGit: async (args) => args[0] === "show"
          ? { code: 0, stdout: CONTRACT_JSON, stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
        resolveSupervisorEnvNames: async () => inspection,
      });
      expect(verdict).toMatchObject({
        status: "unknown",
        mutation_disposition: "block",
        blocking_reasons: [expect.objectContaining({
          code: "post_contract_supervisor_semantics_unproved",
        })],
      });
    } finally {
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  test("a unit without ExecStart is indeterminate (undefined)", () => {
    expect(parseSupervisorProvidedEnvNames("[Service]\nType=simple\n", "systemd", "blade")).toBeUndefined();
  });

  test("systemd ExecStart modifiers (@-+!) and line continuations are tolerated", () => {
    const unit = [
      "[Service]",
      "ExecStart=-/home/caleb/.agents/run/with-scoped-polli-secrets \\",
      "  --host blade \\",
      "  --fixed-env CALYX_HOST_ALIAS=blade \\",
      `  --fixed-env ${PROJECTOR_CONTRACT_ENV}=with-scoped-polli-secrets/v2 \\`,
      "  --fixed-env CALYX_SYSTEMD_UNIT=calyx-run-serve.service \\",
      "  --fixed-env HOME=/home/caleb \\",
      "  --fixed-env LOGNAME=caleb \\",
      `  --fixed-env PATH=${LINUX_PATH} \\`,
      "  --fixed-env USER=caleb \\",
      "  --fixed-env XDG_CONFIG_HOME=/home/caleb/.config \\",
      "  -- /home/caleb/.agents/run/calyx run serve --host 0.0.0.0 --port 8740 "
        + "--runs-root /home/caleb/.calyx/runs --worktree-base /home/caleb/projects",
    ].join("\n");
    expect(parseSupervisorProvidedEnvNames(unit, "systemd", "blade")).toContain("CALYX_HOST_ALIAS");
  });

  test("base-plus-drop-in ExecStart reset degrades to unknown", () => {
    const unit = [
      "# /usr/lib/systemd/user/calyx-run-serve.service",
      SCOPED_PROJECTOR_UNIT,
      "# /home/caleb/.config/systemd/user/calyx-run-serve.service.d/override.conf",
      "[Service]",
      "ExecStart=",
      `ExecStart=${OLD_WITH_POLLI_SECRETS_UNIT.split("ExecStart=")[1]?.split("\n")[0]}`,
    ].join("\n");
    expect(inspectSupervisorDefinition(unit, "systemd", "fixture", "blade")).toMatchObject({ status: "unknown" });
  });

  test.each([
    "UnsetEnvironment=CALYX_HOST_ALIAS",
    "PassEnvironment=CALYX_HOST_ALIAS",
  ])("%s degrades to unknown", (directive) => {
    expect(inspectSupervisorDefinition(`${SCOPED_PROJECTOR_UNIT}\n${directive}`, "systemd", "fixture", "blade"))
      .toMatchObject({ status: "unknown" });
  });

  test("the scoped projector clears inherited and wrapper-input foreign secrets", () => {
    const unit = `${SCOPED_PROJECTOR_UNIT}\nEnvironment=CALYX_CONSUMER_API_FOREIGN_TOKEN=secret`;
    const inspection = inspectSupervisorDefinition(unit, "systemd", "fixture", "blade");
    expect(inspection.status).toBe("determined");
    if (inspection.status === "determined") {
      expect(inspection.provided_env).not.toContain("CALYX_CONSUMER_API_FOREIGN_TOKEN");
    }
  });

  test("the optional generated VAULT_PATH fixed name stays provable on both platforms", () => {
    const unit = SCOPED_PROJECTOR_UNIT.replace(
      "--fixed-env XDG_CONFIG_HOME=/home/caleb/.config",
      "--fixed-env VAULT_PATH=/home/caleb/vault/fieldwork --fixed-env XDG_CONFIG_HOME=/home/caleb/.config",
    );
    expect(unit).toContain("--fixed-env VAULT_PATH=");
    expect(inspectSupervisorDefinition(unit, "systemd", "fixture", "blade")).toMatchObject({
      status: "determined",
    });

    const plist = SCOPED_PROJECTOR_PLIST.replace(
      "    <string>--fixed-env</string><string>HOME=/Users/carbon</string>",
      "    <string>--fixed-env</string><string>HOME=/Users/carbon</string>\n"
        + "    <string>--fixed-env</string><string>VAULT_PATH=/Users/carbon/vault/fieldwork</string>",
    );
    expect(plist).toContain("VAULT_PATH=/Users/carbon/vault/fieldwork");
    expect(inspectSupervisorDefinition(plist, "launchd", "fixture", "carbon")).toMatchObject({
      status: "determined",
    });
  });

  test("VAULT_PATH is allowed but never required, and other extras stay unsupported", () => {
    expect(inspectSupervisorDefinition(SCOPED_PROJECTOR_UNIT, "systemd", "fixture", "blade")).toMatchObject({
      status: "determined",
    });
    const unit = SCOPED_PROJECTOR_UNIT.replace(
      "--fixed-env XDG_CONFIG_HOME=/home/caleb/.config",
      "--fixed-env SOME_OTHER_NAME=x --fixed-env XDG_CONFIG_HOME=/home/caleb/.config",
    );
    expect(inspectSupervisorDefinition(unit, "systemd", "fixture", "blade")).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/unsupported generated fixed name\(s\): SOME_OTHER_NAME/),
    });
  });

  test("a broad wrapper with a host alias remains unknown rather than identity-incompatible", () => {
    const unit = OLD_WITH_POLLI_SECRETS_UNIT.replace(
      "Environment=HOME=/home/caleb",
      "Environment=HOME=/home/caleb\nEnvironment=CALYX_HOST_ALIAS=blade",
    );
    expect(inspectSupervisorDefinition(unit, "systemd", "fixture", "blade")).toMatchObject({
      status: "unknown",
    });
  });
});

describe("computeStartupContractVerdict", () => {
  const baseArgs = {
    host: "blade",
    repoRoot: "/repo",
    homeDir: () => "/home/caleb",
    pathExists: async () => false,
    consumerApiCredentialEnvContract: BLADE_CREDENTIAL_ENV_CONTRACT,
  };

  function gitShow(contractJson: string | undefined, legacy = true) {
    return async (args: string[]) => {
      if (args[0] === "show" && (args[1] ?? "").includes("startup-contract.json")) {
        return contractJson === undefined
          ? { code: 1, stdout: "", stderr: "path does not exist" }
          : { code: 0, stdout: contractJson, stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: legacy ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  test("names the missing required env when the live supervisor omits it (incompatible)", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(ATTESTED_CONTRACT_JSON),
      resolveSupervisorEnvNames: determined(["HOME", "PATH"]),
    });
    expect(verdict.status).toBe("incompatible");
    expect(verdict.per_daemon[0]?.missing_env).toEqual(["CALYX_HOST_ALIAS"]);
    expect(verdict.required_env).toEqual(["CALYX_HOST_ALIAS", PROJECTOR_CONTRACT_ENV]);
    expect(verdict.remediation).toMatch(/CALYX_HOST_ALIAS/);
    expect(verdict.remediation).toMatch(/agents-infra/);
  });

  test("passes when the live supervisor projects every required name (compatible)", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(ATTESTED_CONTRACT_JSON),
      resolveSupervisorEnvNames: determined(["HOME", "PATH", "CALYX_HOST_ALIAS"]),
    });
    expect(verdict.status).toBe("compatible");
    expect(verdict.remediation).toBeUndefined();
  });

  test("a command marker is still unknown unless the target boot contract enforces it", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(CONTRACT_WITHOUT_PROJECTOR_MARKER_JSON),
      resolveSupervisorEnvNames: determined(["HOME", "PATH", "CALYX_HOST_ALIAS"]),
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.mutation_disposition).toBe("block");
    expect(verdict.per_daemon[0]?.reason).toMatch(/not enforced by the target startup contract/);
  });

  test("a pre-contract target (no manifest at ref) is unknown, never incompatible", async () => {
    const resolveSupervisorEnvNames = vi.fn(determined(["HOME", "PATH"]));
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "old-precontract-sha" },
      execGit: gitShow(undefined),
      resolveSupervisorEnvNames,
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.mutation_disposition).toBe("allow");
    expect(verdict.blocking_reasons).toEqual([]);
    expect(verdict.reason).toMatch(/startup-contract introduction boundary/);
    // Never inspects the supervisor once the target has no contract to check.
    expect(resolveSupervisorEnvNames).not.toHaveBeenCalled();
  });

  test("an uninspectable supervisor is unknown, never incompatible", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor({ supervisor: { kind: "direct", stop_grace_ms: 5_000 } })],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(ATTESTED_CONTRACT_JSON),
      resolveSupervisorEnvNames: async () => ({ status: "unknown", reason: "direct supervisor" }),
    });
    expect(verdict.status).toBe("unknown");
  });

  test.each([
    {
      name: "deleted",
      text: undefined,
      expected: /missing packages\/core\/startup-contract\.json/,
      invalidKind: "manifest_missing",
      remediation: /Rebase the target.*or include the canonical packages\/core\/startup-contract\.json/,
    },
    {
      name: "malformed",
      text: "{not-json",
      expected: /not valid JSON/,
      invalidKind: "manifest_malformed",
      remediation: /Repair the target-side packages\/core\/startup-contract\.json/,
    },
    {
      name: "schema-invalid",
      text: JSON.stringify({ schema_version: "calyx-startup-contract/v1" }),
      expected: /does not satisfy the supported calyx-startup-contract\/v1 schema/,
      invalidKind: "schema_invalid",
      remediation: /Repair the target-side packages\/core\/startup-contract\.json/,
    },
    {
      name: "unsupported newer schema",
      text: JSON.stringify({
        ...CALYX_SERVER_STARTUP_CONTRACT,
        schema_version: "calyx-startup-contract/v2",
      }),
      expected: /schema calyx-startup-contract\/v2 is unsupported/,
      invalidKind: "schema_unsupported",
      remediation: /Upgrade the local Calyx upgrader/,
    },
  ])("a post-contract target with a $name contract is unknown and blocks", async ({
    text,
    expected,
    invalidKind,
    remediation,
  }) => {
    const resolveSupervisorEnvNames = vi.fn(determined(["CALYX_HOST_ALIAS"]));
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "post-contract-sha" },
      execGit: gitShow(text, false),
      resolveSupervisorEnvNames,
    });
    expect(verdict.status).toBe("unknown");
    expect(verdict.mutation_disposition).toBe("block");
    expect(verdict.blocking_reasons).toEqual([
      expect.objectContaining({ code: "target_contract_invalid" }),
    ]);
    expect(verdict.contract_invalid_kind).toBe(invalidKind);
    expect(verdict.contract_error).toMatch(expected);
    expect(verdict.remediation).toMatch(remediation);
    if (invalidKind !== "schema_unsupported") {
      expect(verdict.remediation).not.toMatch(/Upgrade the local Calyx upgrader/);
    }
    expect(resolveSupervisorEnvNames).not.toHaveBeenCalled();
  });

  test("a newer sibling without the manifest is not proven legacy and blocks with boundary remediation", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "newer-sibling-sha" },
      execGit: gitShow(undefined, false),
      resolveSupervisorEnvNames: vi.fn(determined(["CALYX_HOST_ALIAS"])),
    });

    expect(verdict).toMatchObject({
      status: "unknown",
      mutation_disposition: "block",
      contract_invalid_kind: "manifest_missing",
      blocking_reasons: [expect.objectContaining({ code: "target_contract_invalid" })],
    });
    expect(verdict.remediation).toMatch(/Rebase the target.*startup-contract boundary/);
    expect(verdict.remediation).toMatch(/include the canonical packages\/core\/startup-contract\.json/);
  });

  test("typed invalid conductor evidence round-trips into unknown-blocked JSON and plan text", async () => {
    const payload = await buildTargetStartupContractPayload(
      TARGET_SHA,
      "/conductor-repo",
      gitShow("{not-json", false),
    );
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "payload", encoded: payload, targetSha: TARGET_SHA },
      execGit: vi.fn(),
      resolveSupervisorEnvNames: vi.fn(determined(["CALYX_HOST_ALIAS"])),
    });

    expect(JSON.parse(JSON.stringify(verdict))).toMatchObject({
      status: "unknown",
      mutation_disposition: "block",
      contract_invalid_kind: "manifest_malformed",
      blocking_reasons: [expect.objectContaining({ code: "target_contract_invalid" })],
    });
    const text = formatSelfUpgradePlan({
      host: "blade",
      repo_root: "/repo",
      current_head: BEFORE_SHA,
      target_ref: "origin/main",
      target_head: TARGET_SHA,
      target_evidence: {
        original_ref: "origin/main",
        target_sha: TARGET_SHA,
        fetch_remote: "origin",
        fetch_ref: "main",
      },
      dirty: false,
      dirty_paths: [],
      missing_build_artifacts: [],
      daemons: [],
      active_runs_post_reconcile: [],
      preservation: {
        policy: "automatic",
        status: "not_applicable",
        required_features: [],
        unavailable_reasons: [],
      },
      startup_contract: verdict,
      blockers: verdict.blocking_reasons.map((reason) => reason.message),
      warnings: [],
      diagnostics: [],
    });
    expect(text).toContain("status: unknown");
    expect(text).toContain("mutation_disposition: block");
    expect(text).toContain("contract_invalid_kind: manifest_malformed");
    expect(text).toContain("code=target_contract_invalid");
    expect(text).not.toContain("status: incompatible");
  });

  test("foreign consumer secrets are compared against the host-derived allowlist", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(ATTESTED_CONTRACT_JSON),
      resolveSupervisorEnvNames: determined([
        "CALYX_HOST_ALIAS",
        "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
        "CALYX_CONSUMER_API_FOREIGN_TOKEN",
      ], { includeHostCredentials: false }),
      consumerApiCredentialEnvContract: {
        token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
        verifier_env: [],
        allowed_secret_env: ["CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN"],
      },
    });
    expect(verdict.status).toBe("incompatible");
    expect(verdict.per_daemon[0]?.foreign_consumer_api_secret_env)
      .toEqual(["CALYX_CONSUMER_API_FOREIGN_TOKEN"]);
  });

  test("missing host-scoped consumer secrets are part of the complete boot predicate", async () => {
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "git", ref: "target-sha" },
      execGit: gitShow(ATTESTED_CONTRACT_JSON),
      consumerApiCredentialEnvContract: BLADE_CREDENTIAL_ENV_CONTRACT,
      resolveSupervisorEnvNames: determined(["CALYX_HOST_ALIAS"], { includeHostCredentials: false }),
    });
    expect(verdict.status).toBe("incompatible");
    expect(verdict.per_daemon[0]?.missing_consumer_api_secret_env).toEqual([
      "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
      "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
    ]);
  });

  test("a SHA-bound conductor payload remains definitive when the remote lacks the target object", async () => {
    const payload = await buildTargetStartupContractPayload(
      "target-sha",
      "/conductor-repo",
      gitShow(ATTESTED_CONTRACT_JSON),
    );
    const remoteGit = vi.fn(async () => ({ code: 128, stdout: "", stderr: "bad object target-sha" }));
    const verdict = await computeStartupContractVerdict({
      ...baseArgs,
      daemons: [systemdDescriptor()],
      source: { kind: "payload", encoded: payload, targetSha: "target-sha" },
      execGit: remoteGit,
      resolveSupervisorEnvNames: determined(["HOME", "PATH"]),
    });
    expect(verdict.status).toBe("incompatible");
    expect(verdict.contract_source).toBe("conductor-payload:target-sha");
    expect(verdict.contract_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verdict.per_daemon[0]?.missing_env).toEqual(["CALYX_HOST_ALIAS"]);
    expect(remoteGit).not.toHaveBeenCalled();
  });
});

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

describe("runSelfUpgrade startup-contract preflight", () => {
  let root: string;
  let homeRoot: string;
  let repoRoot: string;
  let runsRoot: string;
  let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(async () => {
    previousEnv = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    root = await mkdtemp(path.join(tmpdir(), "calyx-startup-contract-"));
    homeRoot = path.join(root, "home");
    repoRoot = path.join(root, "repo");
    runsRoot = path.join(root, "runs");
    process.env["CALYX_STATE_HOME"] = path.join(homeRoot, "state");
    delete process.env["CALYX_STATE_DB"];
    await applyStateMigrations();
    await mkdir(path.join(repoRoot, "packages", "cli", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "packages", "run-service", "dist"), { recursive: true });
    await mkdir(path.join(repoRoot, "packages", "server", "dist"), { recursive: true });
    await mkdir(runsRoot, { recursive: true });
    await writeFile(path.join(repoRoot, "packages", "cli", "dist", "bin.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "cli", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "run-service", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "server", "dist", "index.js"), "", "utf8");
    await writeFile(path.join(repoRoot, "packages", "server", "dist", ".build-info.json"), "{}", "utf8");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  function runServiceStub() {
    return {
      reconcile: vi.fn(async () => ({
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" as const },
      })),
      listRuns: vi.fn(async () => []),
      getRunRecord: vi.fn(async () => undefined),
      assessRestartReadopt: vi.fn(async () => []),
      stop: vi.fn(async (runId: string) => ({
        schema_version: "calyx.run-cancellation-result/v1" as const,
        status: "cancellation_requested" as const,
        run_id: runId,
        requested_at: "2026-07-20T00:00:00.000Z",
      })),
    };
  }

  function planExecGit(contractJson: string | undefined) {
    let currentHead = BEFORE_SHA;
    return async (args: string[]) => {
      if (args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show" && (args[1] ?? "").includes("startup-contract.json")) {
        return contractJson === undefined
          ? { code: 1, stdout: "", stderr: "does not exist" }
          : { code: 0, stdout: contractJson, stderr: "" };
      }
      if (args[0] === "merge" || args[0] === "reset") {
        currentHead = TARGET_SHA;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "for-each-ref") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${args[1] === "HEAD" ? currentHead : TARGET_SHA}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  test("dry-run reports a broad wrapper honestly as unknown and does not mutate", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const writeDescriptor = vi.fn(async () => path.join(root, "descriptor.json"));
    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor,
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        // The live systemd unit is the old with-polli-secrets service.
        resolveSupervisorEnvNames: async () => inspectSupervisorDefinition(
          OLD_WITH_POLLI_SECRETS_UNIT,
          "systemd",
          "calyx-run-serve.service",
          "blade",
        ),
      },
    );

    expect(result.status).toBe("dry-run");
    expect(result.plan.startup_contract?.status).toBe("unknown");
    expect(result.plan.startup_contract?.per_daemon[0]?.reason).toMatch(/no names-only effective-child-environment attestation/);
    expect(result.plan.startup_contract?.mutation_disposition).toBe("block");
    expect(result.plan.startup_contract?.blocking_reasons).toEqual([
      expect.objectContaining({ code: "post_contract_supervisor_semantics_unproved" }),
    ]);
    expect(result.plan.blockers.join("\n")).toMatch(/no names-only effective-child-environment attestation/);
    // No mutation on a dry-run.
    expect(writeDescriptor).not.toHaveBeenCalled();
  });

  test("dry-run plan text preserves the missing target projector-contract dependency", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(CONTRACT_WITHOUT_PROJECTOR_MARKER_JSON),
        createRunService: () => runServiceStub(),
        // The supervisor side is marker-attested; only the target boot contract
        // is missing the required two-sided projector marker.
        resolveSupervisorEnvNames: determined([
          "HOME",
          "PATH",
          "CALYX_HOST_ALIAS",
          "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
          "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
        ]),
      },
    );

    expect(result.plan.startup_contract).toMatchObject({
      status: "unknown",
      mutation_disposition: "block",
      blocking_reasons: [expect.objectContaining({ code: "post_contract_supervisor_semantics_unproved" })],
      reason: expect.stringMatching(/not enforced by the target startup contract/),
    });
    const text = formatSelfUpgradePlan(result.plan);
    expect(text).toContain(PROJECTOR_CONTRACT_ENV);
    expect(text).toContain("not enforced by the target startup contract");
    expect(text).toContain("POL-2053");
    expect(text).not.toContain("no daemon supervisor definition could be inspected");
  });

  test("the real run refuses before promotion on an incompatible contract", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const prepareInstall = vi.fn(async () => {
      throw new Error("prepareInstall must not be reached on an incompatible contract");
    });
    await expect(
      runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          readHostsTruth: readBladeHostsTruth,
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          execGit: planExecGit(ATTESTED_CONTRACT_JSON),
          createRunService: () => runServiceStub(),
          resolveSupervisorEnvNames: determined(["HOME", "PATH"]),
          prepareInstall,
        },
      ),
    ).rejects.toThrow(/CALYX_HOST_ALIAS/);
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  test("a v2 target rejects a live v1 projector and accepts the staged v2 supervisor", async () => {
    await mkdir(path.join(repoRoot, "packages", "core"), { recursive: true });
    await writeFile(path.join(repoRoot, CONTRACT_MANIFEST_PATH), CONTRACT_JSON, "utf8");
    let liveSupervisor = LEGACY_V1_SCOPED_PROJECTOR_UNIT;
    const resolveSupervisorEnvNames = vi.fn(async () => inspectSupervisorDefinition(
      liveSupervisor,
      "systemd",
      "effective unit",
      "blade",
    ));
    const targetSha = "b".repeat(40);
    const previousSha = "a".repeat(40);
    const installsRoot = path.join(homeRoot, ".calyx", "installs");
    const previousInstallPath = path.join(installsRoot, previousSha);
    const previousBinPath = path.join(
      previousInstallPath,
      "node_modules",
      "@polli-labs",
      "calyx",
      "dist",
      "bin.js",
    );
    await mkdir(path.dirname(previousBinPath), { recursive: true });
    await writeFile(previousBinPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(path.join(previousInstallPath, ".build-info.json"), `${JSON.stringify({
      schema_version: "build-info/v1",
      git_head: previousSha,
      built_at: "2026-07-23T00:00:00.000Z",
      package_version: "0.2.0",
      branch: "main",
      dirty: false,
    })}\n`, "utf8");
    await symlink(previousSha, path.join(installsRoot, "current"), "dir");
    const bootstrapWrapper = path.join(homeRoot, ".agents", "run", "calyx");
    await mkdir(path.dirname(bootstrapWrapper), { recursive: true });
    await writeFile(
      bootstrapWrapper,
      `SOURCE_EXECUTABLE_PATH='${path.join(
        installsRoot,
        "current",
        "node_modules",
        "@polli-labs",
        "calyx",
        "dist",
        "bin.js",
      )}'\n`,
      "utf8",
    );
    const descriptor = systemdDescriptor({
      runs_root: runsRoot,
      cwd: repoRoot,
      argv: [
        process.execPath,
        path.join(
          installsRoot,
          "current",
          "node_modules",
          "@polli-labs",
          "calyx",
          "dist",
          "bin.js",
        ),
        "run",
        "serve",
      ],
      build: {
        git_head: previousSha,
        built_at: "2026-07-23T00:00:00.000Z",
        package_version: "0.2.0",
      },
    });
    const preparedInstall = {
      install_path: path.join(homeRoot, ".calyx", "installs", targetSha),
      current_link: path.join(homeRoot, ".calyx", "installs", "current"),
      build_info_path: path.join(homeRoot, ".calyx", "installs", targetSha, ".build-info.json"),
      bin_path: path.join(
        homeRoot,
        ".calyx",
        "installs",
        targetSha,
        "node_modules",
        "@polli-labs",
        "calyx",
        "dist",
        "bin.js",
      ),
      git_head: targetSha,
      verified_version: "0.2.0",
      pruned: [],
      materialized: true,
      promoted: false,
      mechanism: "pack-install" as const,
      rollback_command: "ln -sfn <previous> current",
    };
    await mkdir(path.dirname(preparedInstall.bin_path), { recursive: true });
    await writeFile(preparedInstall.bin_path, "#!/usr/bin/env node\n", "utf8");
    const prepareInstall = vi.fn(async () => preparedInstall);
    const promoteInstall = vi.fn(async () => {
      throw new Error("promotion-sentinel");
    });
    const restore = vi.fn(async () => {
      liveSupervisor = LEGACY_V1_SCOPED_PROJECTOR_UNIT;
      return {
        schema_version: "self-upgrade-supervisor-rollback/v1" as const,
        status: "succeeded" as const,
      };
    });
    let monotonicMs = 0;
    const start = vi.fn(async () => ({ detail: "started" }));
    let thrown: unknown;

    try {
      await runSelfUpgrade(
        { host: "blade", authToken: "synthetic-auth", targetSha },
        {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        createSupervisorAdapter: () => ({
          kind: "systemd",
          stop: async () => ({ detail: "stopped" }),
          start,
          status: async () => ({ running: true }),
        }),
        createAdminClient: (options) => createCalyxAdminClient({
          ...options,
          fetch: vi.fn(async () => new Response(JSON.stringify({
            schema_version: "calyx.admin-health/v1",
            protocol_epoch: 1,
            daemon_kind: "run-service",
            daemon_id: "run-serve",
            advertised_host: "blade",
            uptime_ms: 10,
            started_at: "2026-07-20T00:00:00.000Z",
            build: {
              git_head: previousSha,
              built_at: "2026-07-23T00:00:00.000Z",
              package_version: "0.2.0",
            },
            active_runs: 0,
            maintenance_mode: false,
            supports_features: [...EXPECTED_DAEMON_BASELINE_FEATURES],
          }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
            },
          })),
        }),
        monotonicNowMs: () => monotonicMs,
        sleep: async () => {
          monotonicMs += 30_000;
        },
        resolveSupervisorEnvNames,
        runBuild: async () => ({ code: 0, stdout: "", stderr: "" }),
        runTargetStatePlan: async () => ({
          code: 0,
          stdout: JSON.stringify({
            driver: "better-sqlite3",
            current: "0001",
            target: "0001",
            ledgerExists: true,
            applied: [{
              id: "0001",
              description: "baseline",
              appliedAt: "2026-07-23T00:00:00.000Z",
            }],
            pending: [],
          }),
          stderr: "",
        }),
        runTargetStateMigrate: async () => ({
          code: 0,
          stdout: JSON.stringify({
            driver: "better-sqlite3",
            applied: [],
            alreadyApplied: [{
              id: "0001",
              description: "baseline",
              appliedAt: "2026-07-23T00:00:00.000Z",
            }],
            current: "0001",
            target: "0001",
          }),
          stderr: "",
        }),
        prepareInstall,
        promoteInstall,
        prepareSupervisorCutover: async ({ preparedInstall: prepared }) => ({
          readiness: {
            schema_version: "self-upgrade-supervisor-readiness/v1",
            status: "ready",
            target_git_head: prepared.git_head,
            source: "agents-infra",
            source_sha256: "c".repeat(64),
            supervisor_kinds: ["systemd"],
          },
          install: async () => {
            liveSupervisor = SCOPED_PROJECTOR_UNIT;
            return {
              schema_version: "self-upgrade-supervisor-install/v1",
              status: "installed",
              installed_sha256: "c".repeat(64),
            };
          },
          restore,
        }),
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("promotion-sentinel");
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(promoteInstall).toHaveBeenCalledOnce();
    // Three live-supervisor inspections: plan time, the POL-2072 pre-mutation
    // gate (which waives the supervisor-repairable verdict because a cutover is
    // staged), and the authoritative post-install gate that sees the repair.
    expect(resolveSupervisorEnvNames).toHaveBeenCalledTimes(3);
    const receipt = (thrown as SelfUpgradeExecutionError).receipt;
    expect(receipt?.rollback?.error).toBeUndefined();
    expect(restore).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      rollback: {
        status: "succeeded",
        supervisor: { status: "succeeded" },
      },
      maintenance_disposition: { status: "released" },
    });
    expect(receipt?.rollback?.daemons_restarted).toContainEqual(
      expect.objectContaining({ daemon_id: "run-serve" }),
    );
    expect(receipt?.rollback?.verified_daemons).toContainEqual(
      expect.objectContaining({
        daemon_id: "run-serve",
        build: expect.objectContaining({ git_head: previousSha }),
      }),
    );
  }, 30_000);

  test("the exact old broad-wrapper incident is unknown but refuses real mutation before promotion", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const writeDescriptor = vi.fn(async () => "");
    const prepareInstall = vi.fn(async () => {
      throw new Error("promotion must not be reached");
    });
    await expect(runSelfUpgrade(
      { host: "blade", authToken: "synthetic-auth" },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor,
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames: async () => inspectSupervisorDefinition(
          OLD_WITH_POLLI_SECRETS_UNIT,
          "systemd",
          "calyx-run-serve.service",
          "blade",
        ),
        prepareInstall,
      },
    )).rejects.toThrow(/POL-2053/);
    expect(writeDescriptor).not.toHaveBeenCalled();
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  test("the exact old broad-wrapper incident refuses a real run before build or promotion", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const runBuild = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const prepareInstall = vi.fn(async () => {
      throw new Error("prepareInstall must not be reached for blocked unknown");
    });
    await expect(runSelfUpgrade(
      { host: "blade", authToken: "synthetic-auth" },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames: async () => inspectSupervisorDefinition(
          OLD_WITH_POLLI_SECRETS_UNIT,
          "systemd",
          "calyx-run-serve.service",
          "blade",
        ),
        runBuild,
        prepareInstall,
      },
    )).rejects.toThrow(/no names-only effective-child-environment attestation/);
    expect(runBuild).not.toHaveBeenCalled();
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  test("a supervisor race between plan and adopted-worktree recheck blocks before build", async () => {
    await mkdir(path.join(repoRoot, "packages", "core"), { recursive: true });
    await writeFile(path.join(repoRoot, CONTRACT_MANIFEST_PATH), CONTRACT_JSON, "utf8");
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const compatible = determined(["HOME", "PATH", "CALYX_HOST_ALIAS"]);
    let inspectionCount = 0;
    const resolveSupervisorEnvNames = vi.fn(async () => {
      inspectionCount += 1;
      return inspectionCount === 1
        ? compatible()
        : inspectSupervisorDefinition(OLD_WITH_POLLI_SECRETS_UNIT, "systemd", "raced unit", "blade");
    });
    const runBuild = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(runSelfUpgrade(
      { host: "blade", authToken: "synthetic-auth" },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames,
        runBuild,
      },
    )).rejects.toThrow(/no names-only effective-child-environment attestation/);
    expect(resolveSupervisorEnvNames).toHaveBeenCalledTimes(2);
    expect(runBuild).not.toHaveBeenCalled();
  });

  test("the pre-promotion gate catches a host whose target contract was not local at plan time", async () => {
    // buildPlan cannot read the contract (git show fails, as on a pinned-SHA
    // host that has not fetched yet) → plan verdict `unknown`, no blocker. After
    // adopt, the worktree carries the incompatible contract, so the authoritative
    // gate refuses before promotion.
    await mkdir(path.join(repoRoot, "packages", "core"), { recursive: true });
    await writeFile(path.join(repoRoot, CONTRACT_MANIFEST_PATH), ATTESTED_CONTRACT_JSON, "utf8");
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const prepareInstall = vi.fn(async () => {
      throw new Error("prepareInstall must not be reached on an incompatible contract");
    });
    await expect(
      runSelfUpgrade(
        { host: "blade", authToken: "secret-token" },
        {
          homeDir: () => homeRoot,
          acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
          resolveCurrentHostAlias: async () => "blade",
          resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
          readHostsTruth: readBladeHostsTruth,
          resolveRepo: async () => repoRoot,
          listDescriptors: async () => [descriptor],
          readDescriptor: async () => descriptor,
          writeDescriptor: vi.fn(async () => ""),
          // git show fails → plan verdict unknown → no blocker → proceeds to adopt.
          execGit: planExecGit(undefined),
          createRunService: () => runServiceStub(),
          resolveSupervisorEnvNames: determined(["HOME", "PATH"]),
          runBuild: async () => ({ code: 0, stdout: "", stderr: "" }),
          prepareInstall,
        },
      ),
    ).rejects.toThrow(/CALYX_HOST_ALIAS/);
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  test("an unknown (pre-contract) verdict does not block the dry-run", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(undefined),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames: determined(["HOME", "PATH"]),
      },
    );
    expect(result.status).toBe("dry-run");
    expect(result.plan.startup_contract).toMatchObject({
      status: "unknown",
      mutation_disposition: "allow",
      blocking_reasons: [],
    });
    expect(result.plan.blockers.some((blocker) => blocker.includes("CALYX_HOST_ALIAS"))).toBe(false);
  });

  test("a supervisor race between plan and adopted-worktree recheck blocks before promotion", async () => {
    await mkdir(path.join(repoRoot, "packages", "core"), { recursive: true });
    await writeFile(path.join(repoRoot, CONTRACT_MANIFEST_PATH), CONTRACT_JSON, "utf8");
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const compatibleInspection = determined(["HOME", "PATH", "CALYX_HOST_ALIAS"]);
    const resolveSupervisorEnvNames = vi.fn()
      .mockImplementationOnce(compatibleInspection)
      .mockImplementationOnce(async () => inspectSupervisorDefinition(
        OLD_WITH_POLLI_SECRETS_UNIT,
        "systemd",
        "raced unit",
        "blade",
      ));
    const prepareInstall = vi.fn(async () => {
      throw new Error("promotion must not be reached");
    });
    await expect(runSelfUpgrade(
      { host: "blade", authToken: "synthetic-auth" },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames,
        runBuild: async () => ({ code: 0, stdout: "", stderr: "" }),
        prepareInstall,
      },
    )).rejects.toThrow(/no names-only effective-child-environment attestation/);
    expect(resolveSupervisorEnvNames).toHaveBeenCalledTimes(2);
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  test("a compatible contract adds no blocker", async () => {
    const descriptor = systemdDescriptor({ runs_root: runsRoot, cwd: repoRoot });
    const result = await runSelfUpgrade(
      { host: "blade", dryRun: true },
      {
        homeDir: () => homeRoot,
        acquireLock: vi.fn(async () => ({ lockPath: path.join(homeRoot, "lock"), release: async () => {} })),
        resolveCurrentHostAlias: async () => "blade",
        resolveAgentsInfraRoot: async () => path.join(root, "agents-infra"),
        readHostsTruth: readBladeHostsTruth,
        resolveRepo: async () => repoRoot,
        listDescriptors: async () => [descriptor],
        readDescriptor: async () => descriptor,
        writeDescriptor: vi.fn(async () => ""),
        execGit: planExecGit(ATTESTED_CONTRACT_JSON),
        createRunService: () => runServiceStub(),
        resolveSupervisorEnvNames: determined([
          "HOME",
          "PATH",
          "CALYX_HOST_ALIAS",
          "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
          "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
        ]),
      },
    );
    expect(result.status).toBe("dry-run");
    expect(result.plan.startup_contract?.status).toBe("compatible");
    expect(result.plan.blockers.some((blocker) => blocker.includes("CALYX_HOST_ALIAS"))).toBe(false);
  });
});
