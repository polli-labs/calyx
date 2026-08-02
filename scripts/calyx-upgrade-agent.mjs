#!/usr/bin/env node
/**
 * Remote-side entry point for `calyx self upgrade --fleet`.
 *
 * # Why this file exists
 *
 * A fleet upgrade is, by construction, an operation between two *different*
 * versions of Calyx: the conductor runs the version it has, and the remote runs
 * the version it is about to stop running. Any contract the conductor states in
 * the remote's own vocabulary — an argv flag table, an option name, an env var
 * the remote must already understand — is a fact derived from code the
 * conductor cannot read. The mismatch is invisible until dispatch and it
 * degrades badly: `0f8128a` added `--target-fetch-remote`, `--target-fetch-ref`
 * and `--startup-contract-payload` to the conductor's remote invocation, and
 * none of the four fleet hosts had a build that accepted them.
 *
 * The asymmetry that fixes it: **this file is never installed.** It is read out
 * of the target commit, which the remote has just fetched, by a frozen shell
 * preamble the conductor emits fresh on every dispatch. So the program that
 * composes the planner's argv and the program that parses it are always the
 * same commit, and a single CI process can check them against each other —
 * which `self-upgrade-conductor-preamble.test.ts` does.
 *
 * For the same reason this file runs the planner it *builds from its own tree*,
 * not the host's installed build. Shelling out to the installed CLI would
 * reintroduce the identical defect one hop further down.
 *
 * # Contract
 *
 * argv (from the preamble, positional, permanently four):
 *   1. clone_root   absolute path to the host's calyx checkout
 *   2. fetch_remote git remote the preamble fetched from
 *   3. fetch_ref    git ref the preamble fetched
 *   4. target_sha   40-hex commit this file was extracted from
 *
 * stdin: exactly one UTF-8 versioned `calyx-upgrade-plan/*` JSON object,
 * <=256 KiB. v1 is accepted only to bootstrap an installed pre-POL-2048
 * conductor onto the transparent-update target.
 *
 * stdout: nothing of this file's own authorship *except* a single
 * `calyx-upgrade-preamble/v1` failure envelope when the bootstrap cannot reach
 * the planner. On success the planner's stdio is inherited, so the conductor
 * reads the planner's terminal JSON exactly as it always has.
 *
 * exit: `78` when the bootstrap failed and no host state was touched;
 * otherwise the planner's own exit code.
 */

/* global process, Buffer */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bootstrap failure envelope. Frozen: a stale conductor must still parse it. */
const BOOTSTRAP_ENVELOPE_SCHEMA = "calyx-upgrade-preamble/v1";
/** Exit code reserved for "the bootstrap never reached the planner". */
const BOOTSTRAP_EXIT_CODE = 78;
/**
 * Written by the preamble into the scratch tree it created, holding the target
 * SHA. Two jobs: it proves this process is running out of a throwaway clone the
 * bootstrap owns, and it is the *only* thing that authorises the recursive
 * delete at the end. Without it this file would happily remove whatever
 * checkout it happened to be sitting in.
 */
const SCRATCH_MARKER_FILENAME = ".calyx-upgrade-scratch";
const PLAN_SCHEMA_V1 = "calyx-upgrade-plan/v1";
const PLAN_SCHEMA_VERSION = "calyx-upgrade-plan/v2";
const PLAN_MAX_BYTES = 256 * 1024;
const PROGRESS_RELAY_SCHEMA = "self-upgrade-operation/v1";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const TREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class BootstrapError extends Error {
  /**
   * @param {string} code lowercase snake-case code; part of the frozen envelope
   * @param {string} message operator-facing, single line
   */
  constructor(code, message) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

/**
 * The plan's shape is the conductor→agent contract. This validator is
 * deliberately total and deliberately strict: an unknown key means the
 * conductor is newer than the commit being installed (a rollback dispatched
 * from a forward conductor), and driving an old target with instructions it
 * cannot interpret is exactly the failure mode this file exists to end.
 *
 * @param {unknown} value
 * @returns {{
 *   schema_version: string,
 *   fleet_operation_id: string,
 *   host: string,
 *   clone_root: string,
 *   target: { original_ref: string, target_sha: string, fetch_remote: string, fetch_ref: string },
 *   request: {
 *     dry_run: boolean, yes: boolean, force: boolean,
 *     abort_runs: boolean, drain_all: boolean, drain_deadline_ms: number,
 *   },
 *   startup_contract_payload: string | null,
 *   progress_relay: { schema: string } | null,
 * }}
 */
export function assertUpgradePlan(value) {
  const plan = requireObject(value, "plan");
  const schemaVersion = plan["schema_version"];
  if (schemaVersion !== PLAN_SCHEMA_V1 && schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new BootstrapError(
      "agent_plan_schema_unsupported",
      `the upgrade plan declares an unsupported schema_version; this agent implements ${PLAN_SCHEMA_V1} and ${PLAN_SCHEMA_VERSION}`,
    );
  }
  requireExactKeys(plan, [
    "schema_version",
    "fleet_operation_id",
    "host",
    "clone_root",
    "target",
    "request",
    "startup_contract_payload",
    "progress_relay",
  ], "plan");

  const target = requireObject(plan["target"], "plan.target");
  requireExactKeys(target, ["original_ref", "target_sha", "fetch_remote", "fetch_ref"], "plan.target");
  const request = requireObject(plan["request"], "plan.request");
  requireExactKeys(
    request,
    schemaVersion === PLAN_SCHEMA_V1
      ? ["dry_run", "yes", "force", "abort_runs", "continuous", "drain_deadline_ms"]
      : ["dry_run", "yes", "force", "abort_runs", "drain_all", "drain_deadline_ms"],
    "plan.request",
  );

  const targetSha = requireString(target["target_sha"], "plan.target.target_sha");
  if (!FULL_SHA_PATTERN.test(targetSha)) {
    throw new BootstrapError("agent_plan_invalid", "plan.target.target_sha is not a lowercase 40-hex commit id");
  }
  const cloneRoot = requireString(plan["clone_root"], "plan.clone_root");
  if (!path.isAbsolute(cloneRoot)) {
    throw new BootstrapError("agent_plan_invalid", "plan.clone_root is not an absolute path");
  }
  const drainDeadlineMs = request["drain_deadline_ms"];
  if (!Number.isSafeInteger(drainDeadlineMs) || Number(drainDeadlineMs) < 0) {
    throw new BootstrapError("agent_plan_invalid", "plan.request.drain_deadline_ms is not a non-negative integer");
  }

  const startupContractPayload = plan["startup_contract_payload"];
  if (startupContractPayload !== null) {
    requireString(startupContractPayload, "plan.startup_contract_payload");
  }
  const progressRelay = plan["progress_relay"];
  if (progressRelay !== null) {
    const relay = requireObject(progressRelay, "plan.progress_relay");
    requireExactKeys(relay, ["schema"], "plan.progress_relay");
    if (relay["schema"] !== PROGRESS_RELAY_SCHEMA) {
      throw new BootstrapError(
        "agent_plan_invalid",
        `plan.progress_relay.schema must be ${PROGRESS_RELAY_SCHEMA}`,
      );
    }
  }

  return {
    schema_version: PLAN_SCHEMA_VERSION,
    fleet_operation_id: requireString(plan["fleet_operation_id"], "plan.fleet_operation_id"),
    host: requireString(plan["host"], "plan.host"),
    clone_root: cloneRoot,
    target: {
      original_ref: requireString(target["original_ref"], "plan.target.original_ref"),
      target_sha: targetSha,
      fetch_remote: requireString(target["fetch_remote"], "plan.target.fetch_remote"),
      fetch_ref: requireString(target["fetch_ref"], "plan.target.fetch_ref"),
    },
    request: {
      dry_run: requireBoolean(request["dry_run"], "plan.request.dry_run"),
      yes: requireBoolean(request["yes"], "plan.request.yes"),
      force: requireBoolean(request["force"], "plan.request.force"),
      abort_runs: requireBoolean(request["abort_runs"], "plan.request.abort_runs"),
      // Preserve the old conductor's request semantics during the bootstrap:
      // v1 defaulted to drain and used continuous=true to opt into preservation.
      drain_all: schemaVersion === PLAN_SCHEMA_V1
        ? !requireBoolean(request["continuous"], "plan.request.continuous")
        : requireBoolean(request["drain_all"], "plan.request.drain_all"),
      drain_deadline_ms: Number(drainDeadlineMs),
    },
    startup_contract_payload: startupContractPayload === null
      ? null
      : String(startupContractPayload),
    progress_relay: progressRelay === null ? null : { schema: PROGRESS_RELAY_SCHEMA },
  };
}

/**
 * Compose the planner invocation.
 *
 * This is the only place in the fleet path that speaks `calyx self upgrade`'s
 * flag table, and it ships in the same commit as that flag table — so a test
 * can hand this output to the real commander tree and fail the build on a
 * mismatch. That check is the whole point: the conductor-authored argv it
 * replaces could not be checked by anything, because the definition it was
 * written against lived on another machine.
 *
 * @param {ReturnType<typeof assertUpgradePlan>} plan
 * @returns {string[]}
 */
export function buildPlannerArgv(plan) {
  return [
    "self",
    "upgrade",
    "--host",
    plan.host,
    "--to",
    plan.target.original_ref,
    "--target-sha",
    plan.target.target_sha,
    "--target-fetch-remote",
    plan.target.fetch_remote,
    "--target-fetch-ref",
    plan.target.fetch_ref,
    "--drain-deadline",
    String(plan.request.drain_deadline_ms),
    "--json",
    ...(plan.startup_contract_payload
      ? ["--startup-contract-payload", plan.startup_contract_payload]
      : []),
    ...(plan.request.yes ? ["--yes"] : []),
    ...(plan.request.force ? ["--force"] : []),
    ...(plan.request.abort_runs ? ["--abort-runs"] : []),
    ...(plan.request.drain_all ? ["--drain-all"] : []),
    ...(plan.request.dry_run ? ["--dry-run"] : []),
  ];
}

/**
 * Private single-hop process context for the phase relay, exactly as the
 * pre-preamble dispatch set it. It is not a CLI surface.
 *
 * @param {ReturnType<typeof assertUpgradePlan>} plan
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function buildPlannerEnv(plan, baseEnv) {
  const env = { ...baseEnv };
  delete env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"];
  delete env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"];
  if (plan.progress_relay) {
    env["CALYX_SELF_UPGRADE_PROGRESS_SCHEMA"] = plan.progress_relay.schema;
    env["CALYX_SELF_UPGRADE_FLEET_OPERATION_ID"] = plan.fleet_operation_id;
  }
  return env;
}

/** @param {unknown} value @param {string} label */
function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BootstrapError("agent_plan_invalid", `${label} is not a JSON object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label */
function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BootstrapError("agent_plan_invalid", `${label} is not a non-empty string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new BootstrapError("agent_plan_invalid", `${label} is not a boolean`);
  }
  return value;
}

/** @param {Record<string, unknown>} value @param {string[]} keys @param {string} label */
function requireExactKeys(value, keys, label) {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new BootstrapError("agent_plan_unknown_field", `${label} carries unknown field "${key}"`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new BootstrapError("agent_plan_invalid", `${label} is missing required field "${key}"`);
    }
  }
}

/**
 * Prove this process is running out of a bootstrap-created scratch clone.
 *
 * Everything below builds into, and finally deletes, `TREE_ROOT`. Inferring
 * "this must be a throwaway tree" from the file's own location is exactly the
 * kind of unchecked derivation this whole contract exists to eliminate — and
 * getting it wrong destroys a working checkout. So the bootstrap leaves
 * evidence and this reads it.
 *
 * @param {string} targetSha
 */
function assertBootstrappedScratchTree(targetSha) {
  let marker;
  try {
    marker = readFileSync(path.join(TREE_ROOT, SCRATCH_MARKER_FILENAME), "utf8").trim();
  } catch {
    throw new BootstrapError(
      "agent_not_bootstrapped",
      `${TREE_ROOT} carries no ${SCRATCH_MARKER_FILENAME}; the upgrade agent only runs from a tree the preamble created`,
    );
  }
  if (marker !== targetSha) {
    throw new BootstrapError(
      "agent_not_bootstrapped",
      `${SCRATCH_MARKER_FILENAME} names a different target commit than the preamble arguments`,
    );
  }
}

/**
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
async function readBoundedStdin(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    bytes += buffer.byteLength;
    if (bytes > PLAN_MAX_BYTES) {
      throw new BootstrapError(
        "agent_plan_oversized",
        `the upgrade plan exceeds the ${PLAN_MAX_BYTES}-byte stdin budget`,
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new BootstrapError("agent_plan_absent", "no upgrade plan arrived on stdin");
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<number>}
 */
function runToCompletion(file, args, options) {
  return new Promise((resolve, reject) => {
    // Build output belongs to the diagnostic channel: both child streams are
    // wired to fd 2. stdout carries the planner's terminal JSON and nothing
    // else, so a chatty package manager cannot corrupt the host verdict.
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", 2, 2],
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(signal ? 128 : (code ?? 1));
    });
  });
}

/**
 * Locate an executable by absolute path or by walking PATH. `pnpm` and
 * `with-polli-secrets` are host tools, not Calyx code; a missing one is a
 * bootstrap failure, never a silent degradation.
 *
 * @param {string} name
 * @param {string[]} extraCandidates
 * @returns {string | undefined}
 */
function resolveExecutable(name, extraCandidates) {
  const pathEntries = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const candidate of [...extraCandidates, ...pathEntries.map((entry) => path.join(entry, name))]) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/**
 * Build the target commit's own planner inside the throwaway tree.
 *
 * The build deliberately happens here and not in the host's checkout: a
 * `--dry-run` fleet pass must be able to answer with the *target's* planner
 * without advancing or rebuilding the host's clone. The clone stays untouched
 * until the planner itself decides to move it, after its own preflight.
 *
 * @returns {Promise<string>} absolute path to the built planner entry point
 */
async function buildTargetPlanner() {
  const pnpm = resolveExecutable("pnpm", [
    path.join(process.env["HOME"] ?? "", ".local", "share", "pnpm", "pnpm"),
    "/usr/local/bin/pnpm",
    "/opt/homebrew/bin/pnpm",
  ]);
  if (!pnpm) {
    throw new BootstrapError("agent_pnpm_unavailable", "pnpm was not found on the remote host");
  }
  const installCode = await runToCompletion(pnpm, ["install", "--frozen-lockfile"], { cwd: TREE_ROOT });
  if (installCode !== 0) {
    throw new BootstrapError(
      "agent_build_failed",
      `pnpm install --frozen-lockfile failed in the target tree with exit code ${installCode}`,
    );
  }
  // The workspace's own root `build` script, not a restatement of it: the
  // package list, the ordering and the build-info stamp stay owned by
  // package.json, so this file cannot drift away from how the repo builds.
  const buildCode = await runToCompletion(pnpm, ["build"], { cwd: TREE_ROOT });
  if (buildCode !== 0) {
    throw new BootstrapError(
      "agent_build_failed",
      `pnpm build failed in the target tree with exit code ${buildCode}`,
    );
  }
  const plannerEntry = path.join(TREE_ROOT, "packages", "cli", "dist", "bin.js");
  if (!statSync(plannerEntry, { throwIfNoEntry: false })) {
    throw new BootstrapError(
      "agent_build_failed",
      "the target tree built without producing packages/cli/dist/bin.js",
    );
  }
  return plannerEntry;
}

/**
 * @param {ReturnType<typeof assertUpgradePlan>} plan
 * @param {string} plannerEntry
 * @returns {Promise<number>}
 */
function runPlanner(plan, plannerEntry) {
  const configHome = process.env["XDG_CONFIG_HOME"]
    ?? path.join(process.env["HOME"] ?? "", ".config");
  const withPolliSecrets = resolveExecutable("with-polli-secrets", [
    path.join(configHome, "polli", "bin", "with-polli-secrets"),
  ]);
  if (!withPolliSecrets) {
    throw new BootstrapError(
      "agent_secrets_wrapper_unavailable",
      "with-polli-secrets was not found; the planner cannot resolve the host operator credential",
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      withPolliSecrets,
      [process.execPath, plannerEntry, ...buildPlannerArgv(plan)],
      {
        cwd: TREE_ROOT,
        env: buildPlannerEnv(plan, process.env),
        // Inherited stdio: the planner's terminal JSON reaches the conductor
        // byte-for-byte and this process never becomes a parser between them.
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(signal ? 128 : (code ?? 1));
    });
  });
}

/** @param {string} code @param {string} message */
function emitBootstrapFailure(code, message) {
  process.stdout.write(`${JSON.stringify({
    schema_version: BOOTSTRAP_ENVELOPE_SCHEMA,
    status: "preamble_failed",
    code,
    message,
  })}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 4) {
    throw new BootstrapError(
      "agent_arity",
      `the upgrade agent requires exactly four positional arguments, received ${argv.length}`,
    );
  }
  const [cloneRoot, fetchRemote, fetchRef, targetSha] = argv;
  assertBootstrappedScratchTree(targetSha);
  const plan = assertUpgradePlan(JSON.parse(await readBoundedStdin(process.stdin)));
  // The preamble's argv and the plan restate the same four facts. They are
  // restated across a process boundary that *this* process can cross, so the
  // restatement is checkable — and checked, here, before anything runs.
  if (
    plan.clone_root !== cloneRoot
    || plan.target.fetch_remote !== fetchRemote
    || plan.target.fetch_ref !== fetchRef
    || plan.target.target_sha !== targetSha
  ) {
    throw new BootstrapError(
      "agent_plan_argv_mismatch",
      "the upgrade plan disagrees with the preamble arguments it was dispatched with",
    );
  }
  if (!statSync(path.join(cloneRoot, ".git"), { throwIfNoEntry: false })) {
    throw new BootstrapError("agent_clone_root_invalid", "the plan's clone_root is not a git checkout");
  }
  return runPlanner(plan, await buildTargetPlanner());
}

async function runAgent() {
  let exitCode = BOOTSTRAP_EXIT_CODE;
  // Establish tree ownership before anything else so the cleanup below can
  // never fire against a directory this process did not receive from the
  // bootstrap.
  const ownsTree = Boolean(
    statSync(path.join(TREE_ROOT, SCRATCH_MARKER_FILENAME), { throwIfNoEntry: false }),
  );
  try {
    exitCode = await main();
  } catch (error) {
    const code = error instanceof BootstrapError ? error.code : "agent_failed";
    emitBootstrapFailure(code, error instanceof Error ? error.message : String(error));
    exitCode = BOOTSTRAP_EXIT_CODE;
  } finally {
    if (ownsTree) {
      // The scratch tree is this process's to own and to remove. The preamble
      // `exec`s into here precisely so no supervisor is left holding it.
      rmSync(TREE_ROOT, { recursive: true, force: true });
    }
  }
  process.exit(exitCode);
}

/**
 * Run only when invoked as a program. The pure halves of this file — plan
 * validation and argv composition — exist to be read by the repo's own tests
 * against the real CLI definition, and an import that upgraded a host would
 * make that check unaffordable.
 */
function invokedAsProgram() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (invokedAsProgram()) {
  await runAgent();
}
