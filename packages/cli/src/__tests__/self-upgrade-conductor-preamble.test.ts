import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { buildProgram } from "../run-cli";
import {
  buildRemoteDispatchCommand,
  buildRemotePreamble,
  buildRemoteUpgradePlan,
  encodeRemoteUpgradePlan,
  parseRemoteBootstrapFailure,
  REMOTE_BOOTSTRAP_EXIT_CODE,
  REMOTE_SCRATCH_MARKER_FILENAME,
  type RemoteUpgradePlan,
} from "../commands/self-upgrade-fleet";

const execFile = promisify(execFileCallback);

const AGENT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/calyx-upgrade-agent.mjs",
);

const OPERATION_ID = "fleet-2026-07-25T00-00-00-000Z-preamble";
const HOST = "worm";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "calyx",
      GIT_AUTHOR_EMAIL: "calyx@example.invalid",
      GIT_COMMITTER_NAME: "calyx",
      GIT_COMMITTER_EMAIL: "calyx@example.invalid",
    },
  });
  return result.stdout.trim();
}

/**
 * A two-repo fixture shaped like a fleet host: an `origin` the host fetches
 * from, and the host's own checkout, deliberately left behind origin's tip.
 *
 * The agent lives in the *commit* and never in the checkout's working tree.
 * That is the property under test: the preamble has to reach code that exists
 * only at the target SHA, because reaching code the host already has installed
 * is the failure this contract replaces.
 */
async function createHostFixture(agentSource: string | undefined): Promise<{
  cloneRoot: string;
  targetSha: string;
  staleSha: string;
}> {
  const root = await makeTempRoot("calyx-preamble-fixture-");
  const origin = path.join(root, "origin");
  const clone = path.join(root, "clone");
  await mkdir(origin, { recursive: true });
  await git(origin, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(path.join(origin, "README.md"), "seed\n", "utf8");
  await git(origin, ["add", "."]);
  await git(origin, ["commit", "--quiet", "-m", "seed"]);
  const staleSha = await git(origin, ["rev-parse", "HEAD"]);

  await execFile("git", ["clone", "--quiet", origin, clone]);

  if (agentSource !== undefined) {
    await mkdir(path.join(origin, "scripts"), { recursive: true });
    await writeFile(path.join(origin, "scripts", "calyx-upgrade-agent.mjs"), agentSource, "utf8");
  }
  await writeFile(path.join(origin, "README.md"), "target\n", "utf8");
  await git(origin, ["add", "."]);
  await git(origin, ["commit", "--quiet", "-m", "target"]);
  const targetSha = await git(origin, ["rev-parse", "HEAD"]);

  return { cloneRoot: clone, targetSha, staleSha };
}

interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runCapturing(
  file: string,
  args: string[],
  options: { stdin: string; env?: NodeJS.ProcessEnv },
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = execFileCallback(
      file,
      args,
      { encoding: "utf8", ...(options.env ? { env: options.env } : {}) },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end(options.stdin);
  });
}

/** Run the preamble exactly as ssh would: `bash -c <script> <argv0> $1..$4`. */
function runPreamble(args: {
  cloneRoot: string;
  fetchRemote?: string;
  fetchRef?: string;
  targetSha: string;
  stdin: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandOutcome> {
  return runCapturing(
    "bash",
    [
      "-c",
      buildRemotePreamble(OPERATION_ID, HOST),
      "calyx-upgrade-preamble",
      args.cloneRoot,
      args.fetchRemote ?? "origin",
      args.fetchRef ?? "main",
      args.targetSha,
    ],
    { stdin: args.stdin, ...(args.env ? { env: args.env } : {}) },
  );
}

function samplePlan(overrides: Partial<RemoteUpgradePlan> = {}): RemoteUpgradePlan {
  return {
    ...buildRemoteUpgradePlan({
      fleetOperationId: OPERATION_ID,
      host: HOST,
      cloneRoot: "/srv/worm/calyx",
      targetEvidence: {
        original_ref: "origin/main",
        target_sha: "a".repeat(40),
        fetch_remote: "origin",
        fetch_ref: "main",
      },
      startupContractPayload: "cGF5bG9hZA",
      options: {
        dryRun: true,
        drainDeadlineMs: 600_000,
        yes: true,
        force: false,
        abortRuns: false,
        drainAll: true,
      },
    }),
    ...overrides,
  };
}

/**
 * An agent stand-in that reports exactly what the preamble handed it. Used only
 * where the *preamble's* half of the contract is under test; the real agent's
 * behaviour is exercised separately below.
 */
const ECHO_AGENT = `import { readFileSync } from "node:fs";
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  stdin: readFileSync(0, "utf8"),
  readme: readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  marker: readFileSync(new URL("../${REMOTE_SCRATCH_MARKER_FILENAME}", import.meta.url), "utf8").trim(),
  nodeMajor: Number(process.versions.node.split(".")[0]),
}));
`;

describe("conductor→remote upgrade preamble", () => {
  test("hands the agent from the target commit four positional arguments and the plan on stdin", async () => {
    const fixture = await createHostFixture(ECHO_AGENT);
    const plan = encodeRemoteUpgradePlan(samplePlan({
      clone_root: fixture.cloneRoot,
      target: {
        original_ref: "origin/main",
        target_sha: fixture.targetSha,
        fetch_remote: "origin",
        fetch_ref: "main",
      },
    }));

    const result = await runPreamble({
      cloneRoot: fixture.cloneRoot,
      targetSha: fixture.targetSha,
      stdin: plan,
    });

    expect(result.code, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      argv: string[];
      stdin: string;
      readme: string;
      marker: string;
      nodeMajor: number;
    };
    expect(observed.argv).toEqual([fixture.cloneRoot, "origin", "main", fixture.targetSha]);
    // The plan crosses untouched: the preamble is required never to read, parse
    // or re-encode a single byte of it.
    expect(observed.stdin).toBe(plan);
    // The agent ran out of the *target* tree, not the host's checkout.
    expect(observed.readme).toBe("target\n");
    expect(observed.marker).toBe(fixture.targetSha);
    expect(observed.nodeMajor).toBeGreaterThanOrEqual(22);
    // The host checkout is exactly where it was: a dry run may not move it.
    expect(await git(fixture.cloneRoot, ["rev-parse", "HEAD"])).toBe(fixture.staleSha);
    expect(await git(fixture.cloneRoot, ["status", "--porcelain"])).toBe("");
  });

  test.each([
    {
      name: "a malformed target sha",
      mutate: (fixture: { cloneRoot: string; targetSha: string }) => ({ ...fixture, targetSha: "not-a-sha" }),
      code: "target_sha_invalid",
    },
    {
      name: "a target the fetched ref does not contain",
      mutate: (fixture: { cloneRoot: string; targetSha: string }) => ({
        ...fixture,
        targetSha: "b".repeat(40),
      }),
      code: "target_unreachable",
    },
    {
      name: "a clone root that is not a checkout",
      mutate: (fixture: { cloneRoot: string; targetSha: string }) => ({
        ...fixture,
        cloneRoot: "/nonexistent/calyx",
      }),
      code: "clone_root_invalid",
    },
  ])("refuses $name with exit 78 and one frozen envelope", async ({ mutate, code }) => {
    const fixture = await createHostFixture(ECHO_AGENT);
    const args = mutate({ cloneRoot: fixture.cloneRoot, targetSha: fixture.targetSha });

    const result = await runPreamble({ ...args, stdin: "{}\n" });

    expect(result.code).toBe(REMOTE_BOOTSTRAP_EXIT_CODE);
    expect(parseRemoteBootstrapFailure(result.stdout)).toMatchObject({
      schema_version: "calyx-upgrade-preamble/v1",
      status: "preamble_failed",
      code,
    });
    // Nothing was attempted, so nothing moved.
    expect(await git(fixture.cloneRoot, ["rev-parse", "HEAD"])).toBe(fixture.staleSha);
  });

  test("says so plainly when the target commit predates the agent, and leaves no scratch behind", async () => {
    const fixture = await createHostFixture(undefined);
    const tmp = await makeTempRoot("calyx-preamble-tmpdir-");

    const result = await runPreamble({
      cloneRoot: fixture.cloneRoot,
      targetSha: fixture.targetSha,
      stdin: "{}\n",
      env: { ...process.env, TMPDIR: tmp },
    });

    expect(result.code).toBe(REMOTE_BOOTSTRAP_EXIT_CODE);
    expect(parseRemoteBootstrapFailure(result.stdout)?.code).toBe("agent_missing");
    // Nothing reached the agent, so nothing is left to own the scratch clone.
    // A host that keeps failing must not keep accumulating checkouts in /tmp.
    expect(await readdir(tmp)).toEqual([]);
  });

  test("skips a node below the workspace floor and keeps looking", async () => {
    const fixture = await createHostFixture(ECHO_AGENT);
    const fakeBin = await makeTempRoot("calyx-preamble-oldnode-");
    // The frozen candidate list is ordered, not filtered on existence: a node
    // that fails the >=22.13.0 probe must be stepped over, not adopted.
    await writeFile(path.join(fakeBin, "node"), "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(path.join(fakeBin, "node"), 0o755);

    const result = await runPreamble({
      cloneRoot: fixture.cloneRoot,
      targetSha: fixture.targetSha,
      stdin: "{}\n",
      env: { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}` },
    });

    expect(result.code, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { nodeMajor: number }).nodeMajor).toBeGreaterThanOrEqual(22);
  });

  test("recovers the envelope from behind an rc file's stdout banner", () => {
    const noisy = [
      "Welcome to worm!",
      "  * some banner",
      JSON.stringify({
        schema_version: "calyx-upgrade-preamble/v1",
        status: "preamble_failed",
        code: "node_unavailable",
        message: "no node >=22.13.0 was found on the remote host",
      }),
      "",
    ].join("\n");

    expect(parseRemoteBootstrapFailure(noisy)?.code).toBe("node_unavailable");
    expect(parseRemoteBootstrapFailure("Welcome to worm!\n")).toBeUndefined();
  });

  test("names nothing the remote must already understand", () => {
    const command = buildRemoteDispatchCommand(OPERATION_ID, HOST, "/srv/worm/calyx", {
      original_ref: "origin/main",
      target_sha: "c".repeat(40),
      fetch_remote: "origin",
      fetch_ref: "main",
    });

    // The four irreducible git facts, and no fifth thing.
    expect(command.endsWith(
      ` calyx-upgrade-preamble '/srv/worm/calyx' 'origin' 'main' '${"c".repeat(40)}'`,
    )).toBe(true);
    for (const forbidden of ["self upgrade", "--json", "--target-sha", "--dry-run", "with-polli-secrets"]) {
      expect(command, `the frozen preamble must not name ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("calyx-upgrade-agent", () => {
  // A dynamic specifier keeps the repo-root script out of the package's
  // TypeScript program while still exercising the real module.
  const loadAgent = async (): Promise<{
    assertUpgradePlan: (value: unknown) => RemoteUpgradePlan;
    buildPlannerArgv: (plan: RemoteUpgradePlan) => string[];
    buildPlannerEnv: (plan: RemoteUpgradePlan, base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  }> => import(pathToFileURL(AGENT_PATH).href);

  /** A scratch tree shaped the way the preamble leaves one. */
  async function materializeScratchTree(options: { marker?: string }): Promise<string> {
    const scratch = await makeTempRoot("calyx-agent-scratch-");
    await mkdir(path.join(scratch, "scripts"), { recursive: true });
    await copyFile(AGENT_PATH, path.join(scratch, "scripts", "calyx-upgrade-agent.mjs"));
    await writeFile(path.join(scratch, "sentinel.txt"), "still here\n", "utf8");
    if (options.marker !== undefined) {
      await writeFile(path.join(scratch, REMOTE_SCRATCH_MARKER_FILENAME), `${options.marker}\n`, "utf8");
    }
    return scratch;
  }

  test("accepts exactly what the conductor builds", async () => {
    const { assertUpgradePlan } = await loadAgent();
    const plan = samplePlan();
    expect(assertUpgradePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  test.each([
    [false, true],
    [true, false],
  ])("normalizes legacy v1 continuous=%s to drain_all=%s", async (continuous, drainAll) => {
    const { assertUpgradePlan, buildPlannerArgv } = await loadAgent();
    const current = samplePlan();
    const legacy = {
      ...current,
      schema_version: "calyx-upgrade-plan/v1",
      request: {
        dry_run: current.request.dry_run,
        yes: current.request.yes,
        force: current.request.force,
        abort_runs: current.request.abort_runs,
        continuous,
        drain_deadline_ms: current.request.drain_deadline_ms,
      },
    };

    const normalized = assertUpgradePlan(legacy);
    expect(normalized.schema_version).toBe("calyx-upgrade-plan/v2");
    expect(normalized.request.drain_all).toBe(drainAll);
    expect(buildPlannerArgv(normalized).includes("--drain-all")).toBe(drainAll);
  });

  test.each([
    ["an unsupported schema version", { schema_version: "calyx-upgrade-plan/v3" }, "agent_plan_schema_unsupported"],
    ["a field this commit cannot interpret", { future_knob: true }, "agent_plan_unknown_field"],
  ])("refuses %s", async (_name, overrides, code) => {
    const { assertUpgradePlan } = await loadAgent();
    const plan = { ...JSON.parse(JSON.stringify(samplePlan())), ...overrides };
    // A forward conductor driving an older target must stop, not proceed with
    // instructions the target has no way to honour.
    expect(() => assertUpgradePlan(plan)).toThrow();
    try {
      assertUpgradePlan(plan);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
    }
  });

  test("composes a planner invocation the real CLI accepts", async () => {
    const { buildPlannerArgv } = await loadAgent();
    const argv = buildPlannerArgv(samplePlan());

    expect(argv.slice(0, 2)).toEqual(["self", "upgrade"]);

    // The check the conductor-authored argv could never have: the flag table
    // and the code that speaks it are read by one process, from one commit, and
    // disagreement fails the build instead of the fleet.
    const upgrade = buildProgram()
      .commands.find((command) => command.name() === "self")
      ?.commands.find((command) => command.name() === "upgrade");
    expect(upgrade).toBeDefined();
    const declared = new Map(
      upgrade!.options.map((option) => [option.long, option.required || option.optional]),
    );

    for (let index = 2; index < argv.length; index += 1) {
      const token = argv[index]!;
      if (!token.startsWith("--")) {
        continue;
      }
      expect(declared.has(token), `calyx self upgrade declares no ${token}`).toBe(true);
      if (declared.get(token)) {
        const value = argv[index + 1];
        expect(value, `${token} expects a value`).toBeDefined();
        expect(value!.startsWith("--")).toBe(false);
        index += 1;
      }
    }
  });

  test("carries every requested option into the invocation", async () => {
    const { buildPlannerArgv } = await loadAgent();
    const plan = samplePlan();
    const argv = buildPlannerArgv(plan);

    expect(argv).toContain("--dry-run");
    expect(argv).toContain("--drain-all");
    expect(argv).toContain("--yes");
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--abort-runs");
    expect(argv[argv.indexOf("--host") + 1]).toBe(HOST);
    expect(argv[argv.indexOf("--target-sha") + 1]).toBe(plan.target.target_sha);
    expect(argv[argv.indexOf("--target-fetch-remote") + 1]).toBe(plan.target.fetch_remote);
    expect(argv[argv.indexOf("--target-fetch-ref") + 1]).toBe(plan.target.fetch_ref);
    expect(argv[argv.indexOf("--drain-deadline") + 1]).toBe("600000");
    expect(argv[argv.indexOf("--startup-contract-payload") + 1]).toBe(plan.startup_contract_payload);
  });

  test("keeps the phase relay in the environment and out of the flag table", async () => {
    const { buildPlannerArgv, buildPlannerEnv } = await loadAgent();
    const plan = samplePlan();

    expect(buildPlannerArgv(plan).join(" ")).not.toContain("relay");
    expect(buildPlannerEnv(plan, { PATH: "/usr/bin" })).toMatchObject({
      PATH: "/usr/bin",
      CALYX_SELF_UPGRADE_PROGRESS_SCHEMA: "self-upgrade-operation/v1",
      CALYX_SELF_UPGRADE_FLEET_OPERATION_ID: OPERATION_ID,
    });
    // A relay-less plan must not inherit a stray relay claim from the
    // conductor's own environment.
    expect(buildPlannerEnv({ ...plan, progress_relay: null }, {
      CALYX_SELF_UPGRADE_FLEET_OPERATION_ID: "inherited",
    })).toEqual({});
  });

  test("refuses a plan that disagrees with the preamble it arrived with", async () => {
    const fixture = await createHostFixture(undefined);
    const scratch = await materializeScratchTree({ marker: fixture.targetSha });

    const result = await runCapturing(
      process.execPath,
      [
        path.join(scratch, "scripts", "calyx-upgrade-agent.mjs"),
        fixture.cloneRoot,
        "origin",
        "main",
        fixture.targetSha,
      ],
      { stdin: encodeRemoteUpgradePlan(samplePlan({ clone_root: "/somewhere/else" })) },
    );

    expect(result.code).toBe(REMOTE_BOOTSTRAP_EXIT_CODE);
    expect(parseRemoteBootstrapFailure(result.stdout)).toMatchObject({
      status: "preamble_failed",
      code: "agent_plan_argv_mismatch",
    });
  });

  test("will not run — or delete — a tree the bootstrap did not create", async () => {
    const fixture = await createHostFixture(undefined);
    const scratch = await materializeScratchTree({});

    const result = await runCapturing(
      process.execPath,
      [
        path.join(scratch, "scripts", "calyx-upgrade-agent.mjs"),
        fixture.cloneRoot,
        "origin",
        "main",
        fixture.targetSha,
      ],
      { stdin: encodeRemoteUpgradePlan(samplePlan()) },
    );

    expect(result.code).toBe(REMOTE_BOOTSTRAP_EXIT_CODE);
    expect(parseRemoteBootstrapFailure(result.stdout)?.code).toBe("agent_not_bootstrapped");
    // The agent ends by recursively removing the tree it runs from. Its
    // authority to do that is the marker the preamble wrote and nothing else —
    // inferring it from the file's own location would destroy a real checkout.
    expect(await readFile(path.join(scratch, "sentinel.txt"), "utf8")).toBe("still here\n");
  });

  test("refuses a marker that names a different target commit", async () => {
    const fixture = await createHostFixture(undefined);
    const scratch = await materializeScratchTree({ marker: "d".repeat(40) });

    const result = await runCapturing(
      process.execPath,
      [
        path.join(scratch, "scripts", "calyx-upgrade-agent.mjs"),
        fixture.cloneRoot,
        "origin",
        "main",
        fixture.targetSha,
      ],
      { stdin: encodeRemoteUpgradePlan(samplePlan()) },
    );

    expect(result.code).toBe(REMOTE_BOOTSTRAP_EXIT_CODE);
    expect(parseRemoteBootstrapFailure(result.stdout)?.code).toBe("agent_not_bootstrapped");
  });
});
