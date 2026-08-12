import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  fleetConvergenceToolchainCheckSchema,
  listFleetConvergenceRows,
  openStateStore,
  resolveStatePaths,
  type FleetConvergenceToolchainCheck,
} from "@polli-labs/calyx-core";
import { satisfies, valid, validRange } from "semver";

export const SELF_UPGRADE_CHILD_SPAWN_CONTRACT =
  "@polli-labs/calyx/self-upgrade-child-spawn@v1";
const MAX_PATH_TRACE_ENTRIES = 32;
export const SELF_UPGRADE_TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;
export const SELF_UPGRADE_BUILD_TIMEOUT_MS = 30 * 60 * 1_000;
const SELF_UPGRADE_CHILD_TERMINATION_GRACE_MS = 5_000;
const SELF_UPGRADE_PROBE_CAPTURE_BYTES = 64 * 1_024;
const SELF_UPGRADE_BOOTSTRAP_SANDBOX_OWNER_MARKER = ".calyx-self-upgrade-bootstrap-owner";
const SELF_UPGRADE_BOOTSTRAP_SANDBOX_OWNER_CONTENT = "self-upgrade-bootstrap-sandbox/v1\n";
const SELF_UPGRADE_BOOTSTRAP_SANDBOX_MAX_PERMISSION_REPAIR_ENTRIES = 10_000;
const SELF_UPGRADE_BOOTSTRAP_SANDBOX_NAME = /^operation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SELF_UPGRADE_BOOTSTRAP_INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

// This probe runs under `pnpm exec node`, so both the Node identity and the
// nested pnpm invocation are observed from the package-manager-owned context
// that root lifecycle scripts inherit. The intrinsic probe distinguishes the
// PATH executable from pnpm's repo-root packageManager self-dispatch.
const PNPM_EXEC_CONTEXT_PROBE = String.raw`
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function resolveExecutable(name) {
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    const directory = path.isAbsolute(entry) ? entry : path.resolve(process.cwd(), entry || ".");
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // execvp would continue to the next PATH entry.
    }
  }
  return undefined;
}

function observe(result) {
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const exitCode = typeof result.status === "number" ? result.status : -1;
  return {
    exit_code: exitCode,
    ...(stdout ? { version: stdout.split(/\s+/u)[0] } : {}),
    // This payload becomes durable attestation evidence. Never relay child
    // process errors or stderr here: they inherit the daemon environment and
    // can contain a credential. The stable exit code identifies the failed
    // probe without turning arbitrary child output into fleet state.
    ...(exitCode !== 0 ? { error: "pnpm probe failed" } : {}),
  };
}

const nested = observe(childProcess.spawnSync("pnpm", ["--version"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
}));
let intrinsicProbe = "with-current";
let intrinsic = observe(childProcess.spawnSync("pnpm", ["with", "current", "--version"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
}));
if (intrinsic.exit_code !== 0) {
  intrinsicProbe = "manage-package-manager-versions-disabled";
  intrinsic = observe(childProcess.spawnSync(
    "pnpm",
    ["--config.manage-package-manager-versions=false", "--version"],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  ));
}

process.stdout.write(JSON.stringify({
  node: {
    executable_realpath: fs.realpathSync(process.execPath),
    version: process.version,
    exit_code: 0,
  },
  pnpm: {
    executable_realpath: resolveExecutable("pnpm"),
    resolution_source: "pnpm-exec-node-path",
    intrinsic: { ...intrinsic, probe: intrinsicProbe },
    nested,
  },
}));
`;

export interface SelfUpgradeChildResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out?: boolean;
  /** The leader exited while its POSIX process group still had descendants. */
  process_group_violation?: boolean;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

/**
 * The structured outcome of the two bootstrap mutation phases. Raw child
 * stdout/stderr are deliberately absent: package-manager output is never a
 * durable self-upgrade diagnostic authority.
 */
export interface SelfUpgradeBuildResult {
  code: number;
  timed_out?: boolean;
  phase?: "install" | "build";
  command?: "pnpm";
  args?: readonly string[];
}

export interface SelfUpgradeChildSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Finite child deadline. Callers choose the short probe or build budget. */
  timeoutMs?: number;
  /** SIGTERM-to-SIGKILL grace period after a deadline. */
  terminationGraceMs?: number;
  /** Upper bound for each in-memory stdout/stderr capture when enabled. */
  maxCaptureBytes?: number;
  /** Drain child stdout/stderr without retaining bytes. Used by real builds. */
  captureOutput?: boolean;
}

export type SelfUpgradeChildSpawn = (
  command: string,
  args: readonly string[],
  options: SelfUpgradeChildSpawnOptions,
) => Promise<SelfUpgradeChildResult>;

/**
 * Build the one bootstrap-child environment shared by attestation and the
 * install/build mutation. The caller owns the fresh private workspace root;
 * this function never forwards the invoking process's HOME, XDG config, or
 * temporary-directory selectors.
 */
export function buildSelfUpgradeBootstrapChildEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  const root = path.resolve(workspaceRoot);
  const childEnv: NodeJS.ProcessEnv = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
  };
  for (const name of SELF_UPGRADE_BOOTSTRAP_INHERITED_ENV_ALLOWLIST) {
    const value = sourceEnv[name];
    if (value !== undefined) {
      childEnv[name] = value;
    }
  }
  return Object.freeze(childEnv) as NodeJS.ProcessEnv;
}

/**
 * One owned root for the bootstrap children that attest, build, pack, and
 * install a target. Its environment is deliberately constructed before an
 * accepted target can project credentials into the planner process.
 */
export interface SelfUpgradeBootstrapSandbox {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SelfUpgradeBootstrapSandboxCleanupResult {
  readonly status: "cleaned" | "residue" | "inspection_unavailable";
}

/**
 * Test-only seams for post-removal observations. They never carry a path,
 * error, or recovery claim into a caller result.
 */
interface SelfUpgradeBootstrapSandboxCleanupOptions {
  afterSuccessfulRemoval?: (root: string) => Promise<void>;
  lstatRoot?: typeof lstat;
}

type SelfUpgradeBootstrapSandboxRootProbe = "absent" | "present" | "inspection_unavailable";

interface SelfUpgradeBootstrapSandboxRootIdentity {
  readonly device: number;
  readonly inode: number;
}

function selfUpgradeBootstrapSandboxParent(homeDirectory: string): string {
  return path.join(path.resolve(homeDirectory), ".calyx", "self-upgrade-bootstrap");
}

function isSelfUpgradeBootstrapSandboxName(name: string): boolean {
  return SELF_UPGRADE_BOOTSTRAP_SANDBOX_NAME.test(name);
}

function selfUpgradeBootstrapSandboxMarker(root: string): string {
  return path.join(root, SELF_UPGRADE_BOOTSTRAP_SANDBOX_OWNER_MARKER);
}

export function createSelfUpgradeBootstrapSandbox(args: {
  homeDirectory: string;
  sourceEnv: NodeJS.ProcessEnv;
  operationId?: string;
}): SelfUpgradeBootstrapSandbox {
  const operationId = args.operationId ?? randomUUID();
  const name = `operation-${operationId}`;
  if (!isSelfUpgradeBootstrapSandboxName(name)) {
    throw new Error("Self-upgrade bootstrap sandbox operation id must be a UUID.");
  }
  const root = path.join(selfUpgradeBootstrapSandboxParent(args.homeDirectory), name);
  return Object.freeze({
    root,
    env: buildSelfUpgradeBootstrapChildEnvironment(args.sourceEnv, root),
  });
}

/** Create the local workspace and private homes before a child receives the projection. */
export async function initializeSelfUpgradeBootstrapSandbox(
  sandbox: SelfUpgradeBootstrapSandbox,
): Promise<void> {
  const parent = path.dirname(sandbox.root);
  const name = path.basename(sandbox.root);
  if (!isSelfUpgradeBootstrapSandboxName(name)) {
    throw new Error("Refusing to initialize an unrecognized self-upgrade bootstrap sandbox root.");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(sandbox.root, { mode: 0o700 });
  try {
    await writeFile(
      selfUpgradeBootstrapSandboxMarker(sandbox.root),
      SELF_UPGRADE_BOOTSTRAP_SANDBOX_OWNER_CONTENT,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await Promise.all([
      mkdir(sandbox.env.HOME!, { recursive: true, mode: 0o700 }),
      mkdir(sandbox.env.XDG_CONFIG_HOME!, { recursive: true, mode: 0o700 }),
      mkdir(sandbox.env.TMPDIR!, { recursive: true, mode: 0o700 }),
    ]);
  } catch (error) {
    // This root was created by this invocation and has not been exposed to a
    // child yet. Best-effort removal here avoids an unmarked orphan.
    await rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function hasSelfUpgradeBootstrapSandboxMarker(root: string): Promise<boolean> {
  try {
    const marker = selfUpgradeBootstrapSandboxMarker(root);
    const metadata = await lstat(marker);
    return metadata.isFile()
      && (await readFile(marker, "utf8")) === SELF_UPGRADE_BOOTSTRAP_SANDBOX_OWNER_CONTENT;
  } catch {
    return false;
  }
}

async function probeSelfUpgradeBootstrapSandboxRoot(
  root: string,
  options: SelfUpgradeBootstrapSandboxCleanupOptions,
): Promise<SelfUpgradeBootstrapSandboxRootProbe> {
  const lstatRoot = options.lstatRoot ?? lstat;
  try {
    await lstatRoot(root);
    return "present";
  } catch (error) {
    // Only an ENOENT observation proves that recursive cleanup reached a
    // terminal absence. Permission, I/O, and every other probe failure remain
    // explicitly unavailable local hygiene observations.
    return isErrno(error, "ENOENT") ? "absent" : "inspection_unavailable";
  }
}

async function captureSelfUpgradeBootstrapSandboxRootIdentity(
  root: string,
): Promise<SelfUpgradeBootstrapSandboxRootIdentity | undefined> {
  try {
    const metadata = await lstat(root);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || !Number.isSafeInteger(metadata.dev)
      || !Number.isSafeInteger(metadata.ino)
      || metadata.ino === 0
    ) {
      return undefined;
    }
    return { device: metadata.dev, inode: metadata.ino };
  } catch {
    return undefined;
  }
}

async function hasSameSelfUpgradeBootstrapSandboxRootIdentity(
  root: string,
  expected: SelfUpgradeBootstrapSandboxRootIdentity,
): Promise<boolean> {
  const actual = await captureSelfUpgradeBootstrapSandboxRootIdentity(root);
  return actual?.device === expected.device && actual.inode === expected.inode;
}

function cleanupResultFromRootProbe(
  probe: SelfUpgradeBootstrapSandboxRootProbe,
): SelfUpgradeBootstrapSandboxCleanupResult {
  if (probe === "absent") return { status: "cleaned" };
  if (probe === "present") return { status: "residue" };
  return { status: "inspection_unavailable" };
}

async function removeAndProbeSelfUpgradeBootstrapSandbox(
  root: string,
  options: SelfUpgradeBootstrapSandboxCleanupOptions,
): Promise<{ removal_succeeded: boolean; probe: SelfUpgradeBootstrapSandboxRootProbe }> {
  try {
    await rm(root, { recursive: true, force: true });
    await options.afterSuccessfulRemoval?.(root);
    return {
      removal_succeeded: true,
      probe: await probeSelfUpgradeBootstrapSandboxRoot(root, options),
    };
  } catch {
    return {
      removal_succeeded: false,
      probe: await probeSelfUpgradeBootstrapSandboxRoot(root, options),
    };
  }
}

/**
 * A package-manager child can make one of its private cache directories
 * untraversable. Repair only directories reached from this invocation's
 * marker-gated root,
 * never follow links, and bound the traversal before one retry.
 */
async function repairSelfUpgradeBootstrapSandboxPermissions(root: string): Promise<boolean> {
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    if (!directory) continue;
    if (++visited > SELF_UPGRADE_BOOTSTRAP_SANDBOX_MAX_PERMISSION_REPAIR_ENTRIES) {
      return false;
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(directory);
    } catch {
      return false;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return false;
    }
    try {
      await chmod(directory, 0o700);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          queue.push(path.join(directory, entry.name));
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Best-effort cleanup for this invocation's exact private root. If ordinary
 * recursive removal is denied, repair permissions only below that root and
 * retry once. This is local hygiene, not a crash-recovery or security claim.
 */
export async function cleanupSelfUpgradeBootstrapSandbox(
  sandbox: SelfUpgradeBootstrapSandbox,
  options: SelfUpgradeBootstrapSandboxCleanupOptions = {},
): Promise<SelfUpgradeBootstrapSandboxCleanupResult> {
  if (!(await hasSelfUpgradeBootstrapSandboxMarker(sandbox.root))) {
    return cleanupResultFromRootProbe(await probeSelfUpgradeBootstrapSandboxRoot(sandbox.root, options));
  }
  // Ownership is established before any recursive mutation. A failed rm can
  // remove the in-root marker before encountering a hostile child directory,
  // so a same-root in-memory identity lets this one invocation repair/retry
  // without minting a durable recovery record or accepting a replacement root.
  const rootIdentity = await captureSelfUpgradeBootstrapSandboxRootIdentity(sandbox.root);

  const initial = await removeAndProbeSelfUpgradeBootstrapSandbox(sandbox.root, options);
  if (initial.probe !== "present") {
    return cleanupResultFromRootProbe(initial.probe);
  }
  // A success followed by a present root may be a delete/recreate race. Do
  // not delete that replacement: its original marker is gone and this action
  // owns no cleanup authority beyond the root it created.
  if (
    initial.removal_succeeded
    || !rootIdentity
    || !(await hasSameSelfUpgradeBootstrapSandboxRootIdentity(sandbox.root, rootIdentity))
  ) {
    return { status: "residue" };
  }

  // The first removal failed while the original, marker-gated root was still
  // present. Repair only its descendants, then make one retry and classify the
  // final root probe instead of trusting rm's completion result.
  if (!(await repairSelfUpgradeBootstrapSandboxPermissions(sandbox.root))) {
    return cleanupResultFromRootProbe(await probeSelfUpgradeBootstrapSandboxRoot(sandbox.root, options));
  }
  const retried = await removeAndProbeSelfUpgradeBootstrapSandbox(sandbox.root, options);
  return cleanupResultFromRootProbe(retried.probe);
}

function boundedText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (encoded.byteLength <= byteLimit) {
    return { text: value, truncated: false };
  }
  // Buffer#toString replaces a partial multibyte character with U+FFFD, which
  // can itself exceed the requested byte ceiling. Walk Unicode code points so
  // the retained prefix is valid UTF-8 and never grows at decode time.
  const characters: string[] = [];
  let retainedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + characterBytes > byteLimit) break;
    characters.push(character);
    retainedBytes += characterBytes;
  }
  return {
    text: characters.join(""),
    truncated: true,
  };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7F) return true;
  }
  return false;
}

function staticChildFailureDiagnostic(
  result: SelfUpgradeChildResult,
  fallback: string,
): string {
  if (result.timed_out) {
    return "child process timed out before producing complete evidence";
  }
  if (result.process_group_violation) {
    return "child process exited before its process group became terminal";
  }
  if (result.stderr_truncated || result.stdout_truncated) {
    return "child process did not produce complete bounded evidence";
  }
  return fallback;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

type PosixProcessGroupExit = "exited" | "running" | "unknown";

async function waitForPosixProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<PosixProcessGroupExit> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      // Permission and stale-handle failures are not proof that a detached
      // group is gone. Only ESRCH proves child-tree terminality.
      return isErrno(error, "ESRCH") ? "exited" : "unknown";
    }
    if (Date.now() >= deadline) return "running";
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * One spawn authority for both C1 probes and the real install/build children.
 * Cwd, environment snapshot, command lookup, and stdio handling cannot drift
 * between the attestation and the mutation it authorizes.
 */
export const spawnSelfUpgradeChild: SelfUpgradeChildSpawn = async (
  command,
  args,
  options,
) => {
  const maxCaptureBytes = options.maxCaptureBytes ?? SELF_UPGRADE_PROBE_CAPTURE_BYTES;
  const captureOutput = options.captureOutput ?? true;
  const timeoutMs = options.timeoutMs ?? SELF_UPGRADE_TOOLCHAIN_PROBE_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? SELF_UPGRADE_CHILD_TERMINATION_GRACE_MS;
  return await new Promise<SelfUpgradeChildResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A pnpm child can have lifecycle descendants. Make it a process group
      // on POSIX so terminality covers the whole child tree instead of leaving
      // an inherited-environment subprocess under the upgrade lock.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let capturesFlushed = false;
    let timedOut = false;
    let settled = false;
    let spawnError = false;
    let childExitCode: number | undefined;
    let timeoutEscalationComplete = false;
    let timeoutReapFailed = false;
    let ordinaryTerminalityVerificationComplete = process.platform === "win32";
    let ordinaryTerminalityVerificationStarted = false;
    let ordinaryTerminalityReapFailed = false;
    let processGroupViolation = false;

    const terminate = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // A child can exit between the timeout and signal delivery. `close`
        // remains the authoritative completion notification.
      }
    };
    let killTimer: NodeJS.Timeout | undefined;

    const appendCapture = (
      current: string,
      chunk: string,
    ): { text: string; truncated: boolean } => {
      const remaining = Math.max(0, maxCaptureBytes - Buffer.byteLength(current, "utf8"));
      if (remaining === 0) return { text: current, truncated: true };
      const bounded = boundedText(chunk, remaining);
      return { text: current + bounded.text, truncated: bounded.truncated };
    };

    const appendStdoutCapture = (chunk: Buffer | string): void => {
      if (!captureOutput) return;
      const text = Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : chunk;
      const captured = appendCapture(stdout, text);
      stdout = captured.text;
      stdoutTruncated ||= captured.truncated;
    };

    const appendStderrCapture = (chunk: Buffer | string): void => {
      if (!captureOutput) return;
      const text = Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : chunk;
      const captured = appendCapture(stderr, text);
      stderr = captured.text;
      stderrTruncated ||= captured.truncated;
    };

    const flushCaptures = (): void => {
      if (!captureOutput || capturesFlushed) return;
      capturesFlushed = true;
      appendStdoutCapture(stdoutDecoder.end());
      appendStderrCapture(stderrDecoder.end());
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      if (spawnError) {
        reject(new Error("Unable to start self-upgrade child process."));
        return;
      }
      if (timeoutReapFailed || ordinaryTerminalityReapFailed) {
        reject(new Error("Self-upgrade child process group did not reach proven terminality."));
        return;
      }
      resolve({
        // A leader that exits 0 while a lifecycle child continues is not a
        // successful bootstrap command. The tree was reaped, but the command
        // contract was violated and callers must fail closed.
        code: timedOut ? 124 : processGroupViolation ? 125 : code,
        stdout,
        stderr,
        ...(timedOut ? { timed_out: true } : {}),
        ...(processGroupViolation ? { process_group_violation: true } : {}),
        ...(stdoutTruncated ? { stdout_truncated: true } : {}),
        ...(stderrTruncated ? { stderr_truncated: true } : {}),
      });
    };

    const maybeFinish = (): void => {
      if (spawnError) {
        void finish(1);
        return;
      }
      if (childExitCode === undefined) return;
      // The leader can close immediately after SIGTERM while a lifecycle
      // descendant remains in the detached process group. A timeout is not
      // terminal until the scheduled SIGKILL escalation has completed and the
      // group is confirmed gone.
      if (timedOut && !timeoutEscalationComplete) return;
      if (!timedOut && !ordinaryTerminalityVerificationComplete) {
        if (!ordinaryTerminalityVerificationStarted) {
          ordinaryTerminalityVerificationStarted = true;
          void (async () => {
            if (process.platform !== "win32" && child.pid) {
              const initial = await waitForPosixProcessGroupExit(child.pid, terminationGraceMs);
              if (initial !== "exited") {
                // An ordinary exit is not terminal while a process-group
                // descendant survives. Reap it and surface the violation;
                // never silently turn an exiting parent into a successful
                // attestation, install, or build result.
                processGroupViolation = true;
                if (initial === "running") {
                  terminate("SIGTERM");
                  const afterTerm = await waitForPosixProcessGroupExit(
                    child.pid,
                    Math.max(100, terminationGraceMs),
                  );
                  if (afterTerm !== "exited") {
                    terminate("SIGKILL");
                    const afterKill = await waitForPosixProcessGroupExit(
                      child.pid,
                      Math.max(100, terminationGraceMs),
                    );
                    ordinaryTerminalityReapFailed = afterKill !== "exited";
                  }
                } else {
                  // The group could not be inspected conclusively. A signal
                  // would be an unproven mutation, so report no terminality.
                  ordinaryTerminalityReapFailed = true;
                }
              }
            } else if (process.platform !== "win32") {
              processGroupViolation = true;
              ordinaryTerminalityReapFailed = true;
            }
            ordinaryTerminalityVerificationComplete = true;
            maybeFinish();
          })();
        }
        return;
      }
      void finish(childExitCode);
    };

    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => {
        void (async () => {
          terminate("SIGKILL");
          if (process.platform !== "win32" && child.pid) {
            timeoutReapFailed = (await waitForPosixProcessGroupExit(
              child.pid,
              Math.max(100, terminationGraceMs),
            )) !== "exited";
          }
          timeoutEscalationComplete = true;
          maybeFinish();
        })();
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendStdoutCapture(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendStderrCapture(chunk);
    });
    child.once("error", () => {
      spawnError = true;
      childExitCode = 1;
      maybeFinish();
    });
    child.once("close", (code) => {
      flushCaptures();
      childExitCode = code ?? 1;
      maybeFinish();
    });
  });
};

export async function runSelfUpgradeBuild(
  repoRoot: string,
  childSpawn: SelfUpgradeChildSpawn = spawnSelfUpgradeChild,
  env: NodeJS.ProcessEnv,
): Promise<SelfUpgradeBuildResult> {
  // Dependency resolution must not execute source lifecycle hooks. The explicit
  // workspace build below is the sole intended source-script authority.
  const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts"] as const;
  const install = await childSpawn("pnpm", installArgs, {
    cwd: repoRoot,
    env,
    timeoutMs: SELF_UPGRADE_BUILD_TIMEOUT_MS,
    captureOutput: false,
  });
  if (install.code !== 0) {
    return {
      phase: "install",
      command: "pnpm",
      args: installArgs,
      code: install.code,
      ...(install.timed_out ? { timed_out: true } : {}),
    };
  }
  const buildArgs = ["-w", "build"] as const;
  const build = await childSpawn("pnpm", buildArgs, {
    cwd: repoRoot,
    env,
    timeoutMs: SELF_UPGRADE_BUILD_TIMEOUT_MS,
    captureOutput: false,
  });
  return {
    phase: "build",
    command: "pnpm",
    args: buildArgs,
    code: build.code,
    ...(build.timed_out ? { timed_out: true } : {}),
  };
}

interface PackageContract {
  nodeRange: string | null;
  pnpmVersion: string | null;
}

function normalizeVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return valid(value.trim()) ?? undefined;
}

function nodeSatisfiesDeclaredContract(
  version: string | undefined,
  contract: PackageContract,
): boolean {
  const normalized = normalizeVersion(version);
  return Boolean(
    normalized
    && contract.nodeRange
    && validRange(contract.nodeRange)
    && satisfies(normalized, contract.nodeRange),
  );
}

async function readPackageContract(repoRoot: string): Promise<PackageContract> {
  try {
    const decoded = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: unknown;
      engines?: { node?: unknown };
    };
    const declaredNodeRange = typeof decoded.engines?.node === "string"
      ? decoded.engines.node.trim()
      : null;
    const nodeRange = declaredNodeRange && validRange(declaredNodeRange)
      ? declaredNodeRange
      : null;
    const packageManager = typeof decoded.packageManager === "string"
      ? decoded.packageManager.match(/^pnpm@([^\s+]+)(?:\+.*)?$/u)
      : null;
    const pnpmVersion = valid(packageManager?.[1] ?? "");
    return {
      nodeRange,
      pnpmVersion: pnpmVersion ?? null,
    };
  } catch {
    return { nodeRange: null, pnpmVersion: null };
  }
}

function redactPath(value: string, cwd: string): string {
  const home = homedir();
  const normalized = value.trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > 1_024
    || containsControlCharacter(normalized)
  ) {
    return "$REDACTED_PATH";
  }
  if (normalized === cwd) return "$CWD";
  if (normalized.startsWith(`${cwd}${path.sep}`)) return `$CWD${normalized.slice(cwd.length)}`;
  if (normalized === home) return "$HOME";
  if (normalized.startsWith(`${home}${path.sep}`)) return `$HOME${normalized.slice(home.length)}`;
  // An executable or PATH entry outside the source worktree/home is useful
  // only as an identity class. Do not preserve its full absolute path because
  // it may include a sensitive build mount or an inherited token directory.
  const basename = path.basename(normalized);
  return /^[A-Za-z0-9._+-]+$/u.test(basename) ? `$EXTERNAL/${basename}` : "$EXTERNAL";
}

async function executableCandidate(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) return undefined;
    await access(filePath, fsConstants.X_OK);
    return await realpath(filePath);
  } catch {
    return undefined;
  }
}

async function tracePath(env: NodeJS.ProcessEnv, cwd: string): Promise<{
  total_entries: number;
  truncated: boolean;
  entries: Array<{
    index: number;
    directory: string;
    node_candidate?: string;
    pnpm_candidate?: string;
  }>;
}> {
  const directories = (env.PATH ?? "").split(path.delimiter);
  const entries = [];
  for (const [index, directory] of directories.slice(0, MAX_PATH_TRACE_ENTRIES).entries()) {
    const resolvedDirectory = path.isAbsolute(directory)
      ? directory
      : path.resolve(cwd, directory || ".");
    const nodeCandidate = await executableCandidate(path.join(resolvedDirectory, "node"));
    const pnpmCandidate = await executableCandidate(path.join(resolvedDirectory, "pnpm"));
    entries.push({
      index,
      directory: redactPath(resolvedDirectory, cwd),
      ...(nodeCandidate ? { node_candidate: redactPath(nodeCandidate, cwd) } : {}),
      ...(pnpmCandidate ? { pnpm_candidate: redactPath(pnpmCandidate, cwd) } : {}),
    });
  }
  return {
    total_entries: directories.length,
    truncated: directories.length > MAX_PATH_TRACE_ENTRIES,
    entries,
  };
}

function firstVersion(value: string): string | undefined {
  const candidate = value.trim().split(/\s+/u)[0];
  return candidate ? normalizeVersion(candidate) : undefined;
}

interface VersionProbe {
  version?: unknown;
  exit_code?: unknown;
  error?: unknown;
}

interface PnpmContextProbe {
  node?: {
    executable_realpath?: unknown;
    version?: unknown;
    exit_code?: unknown;
    error?: unknown;
  };
  pnpm?: {
    executable_realpath?: unknown;
    resolution_source?: unknown;
    intrinsic?: VersionProbe & { probe?: unknown };
    nested?: VersionProbe;
  };
}

function decodeVersionProbe(
  value: VersionProbe | undefined,
  fallbackError: string,
): { version?: string; exit_code: number; error?: string } {
  const exitCode = typeof value?.exit_code === "number" ? value.exit_code : -1;
  const version = typeof value?.version === "string" ? firstVersion(value.version) : undefined;
  const error = exitCode !== 0 || !version
      ? fallbackError
      : undefined;
  return {
    ...(version ? { version } : {}),
    exit_code: exitCode,
    ...(error ? { error } : {}),
  };
}

export interface AttestSelfUpgradeToolchainOptions {
  host: string;
  repoRoot: string;
  targetSha: string | null;
  checkedAt: string;
  /** Frozen, private bootstrap-child projection; ambient process.env is never valid evidence. */
  env: NodeJS.ProcessEnv;
  childSpawn?: SelfUpgradeChildSpawn;
  processIdentity?: { execPath: string; version: string };
}

export async function attestSelfUpgradeToolchain(
  options: AttestSelfUpgradeToolchainOptions,
): Promise<FleetConvergenceToolchainCheck> {
  const contract = await readPackageContract(options.repoRoot);
  const env = options.env;
  const childSpawn = options.childSpawn ?? spawnSelfUpgradeChild;
  const processIdentity = options.processIdentity ?? {
    execPath: process.execPath,
    version: process.version,
  };
  const processExecPath = await realpath(processIdentity.execPath).catch(() => processIdentity.execPath);
  const failures: FleetConvergenceToolchainCheck["failures"][number][] = [];
  if (contract.nodeRange === null || contract.pnpmVersion === null) {
    failures.push({
      code: "package_contract_unreadable",
      message: "package.json must declare a valid Node semver range and an exact pnpm packageManager version.",
    });
  }
  if (options.targetSha === null) {
    failures.push({
      code: "target_bundle_unavailable",
      message: "A bootstrap toolchain pass requires the exact target Calyx source SHA.",
    });
  }
  if (!normalizeVersion(processIdentity.version)) {
    failures.push({
      code: "process_node_unreadable",
      message: `Unable to parse process Node ${processIdentity.version}.`,
    });
  } else if (!nodeSatisfiesDeclaredContract(processIdentity.version, contract)) {
    failures.push({
      code: "process_node_contract_mismatch",
      message: `Calyx process Node ${processIdentity.version} does not satisfy declared engines.node ${contract.nodeRange ?? "unknown"}.`,
    });
  }

  let selfDispatched: FleetConvergenceToolchainCheck["observed"]["child_pnpm"]["self_dispatched"];
  try {
    const result = await childSpawn("pnpm", ["--version"], {
      cwd: options.repoRoot,
      env,
      timeoutMs: SELF_UPGRADE_TOOLCHAIN_PROBE_TIMEOUT_MS,
      maxCaptureBytes: SELF_UPGRADE_PROBE_CAPTURE_BYTES,
    });
    const version = result.code === 0 ? firstVersion(result.stdout) : undefined;
    selfDispatched = {
      exit_code: result.code,
      ...(version ? { version } : {}),
      ...(result.code !== 0 || !version
        ? { error: staticChildFailureDiagnostic(result, "self-dispatched pnpm probe failed") }
        : {}),
    };
  } catch {
    selfDispatched = { exit_code: -1, error: "self-dispatched pnpm probe could not be started" };
  }

  let contextResult: SelfUpgradeChildResult;
  let context: PnpmContextProbe = {};
  try {
    contextResult = await childSpawn("pnpm", ["exec", "node", "-e", PNPM_EXEC_CONTEXT_PROBE], {
      cwd: options.repoRoot,
      env,
      timeoutMs: SELF_UPGRADE_TOOLCHAIN_PROBE_TIMEOUT_MS,
      maxCaptureBytes: SELF_UPGRADE_PROBE_CAPTURE_BYTES,
    });
    if (contextResult.code === 0) {
      try {
        context = JSON.parse(contextResult.stdout) as PnpmContextProbe;
      } catch {
        context = {};
      }
    }
  } catch {
    contextResult = { code: -1, stdout: "", stderr: "" };
  }

  const childNode: FleetConvergenceToolchainCheck["observed"]["child_node"] = {
    exit_code: typeof context.node?.exit_code === "number"
      ? context.node.exit_code
      : contextResult.code,
    ...(typeof context.node?.executable_realpath === "string"
      ? { executable_realpath: redactPath(context.node.executable_realpath, options.repoRoot) }
      : {}),
    ...(typeof context.node?.version === "string" && normalizeVersion(context.node.version)
      ? { version: context.node.version }
      : {}),
    ...(contextResult.code !== 0 || typeof context.node?.error === "string"
      ? { error: staticChildFailureDiagnostic(contextResult, "pnpm exec node probe failed") }
        : {}),
  };
  if (childNode.exit_code !== 0 || !childNode.version || !childNode.executable_realpath) {
    failures.push({
      code: "child_node_unavailable",
      message: childNode.error ?? "pnpm exec node returned incomplete Node identity evidence.",
    });
  } else if (!nodeSatisfiesDeclaredContract(childNode.version, contract)) {
    failures.push({
      code: "child_node_contract_mismatch",
      message: `pnpm-executed Node ${childNode.version} does not satisfy declared engines.node ${contract.nodeRange ?? "unknown"}.`,
    });
  }

  const intrinsicBase = decodeVersionProbe(
    context.pnpm?.intrinsic,
    staticChildFailureDiagnostic(contextResult, "intrinsic pnpm probe failed"),
  );
  const intrinsicProbe = context.pnpm?.intrinsic?.probe === "manage-package-manager-versions-disabled"
    ? "manage-package-manager-versions-disabled" as const
    : "with-current" as const;
  const nested = decodeVersionProbe(
    context.pnpm?.nested,
    staticChildFailureDiagnostic(contextResult, "nested pnpm probe failed"),
  );
  const childPnpm: FleetConvergenceToolchainCheck["observed"]["child_pnpm"] = {
    ...(typeof context.pnpm?.executable_realpath === "string"
      ? { executable_realpath: redactPath(context.pnpm.executable_realpath, options.repoRoot) }
      : {}),
    resolution_source: "pnpm-exec-node-path",
    self_dispatched: selfDispatched,
    intrinsic: { ...intrinsicBase, probe: intrinsicProbe },
    nested,
  };

  if (selfDispatched.exit_code !== 0 || !selfDispatched.version) {
    failures.push({
      code: "child_pnpm_unavailable",
      message: selfDispatched.error ?? "Self-dispatched pnpm version was unavailable.",
    });
  } else if (selfDispatched.version !== contract.pnpmVersion) {
    failures.push({
      code: "child_pnpm_version_mismatch",
      message: `Bootstrap pnpm self-dispatched ${selfDispatched.version}, not declared packageManager pnpm@${contract.pnpmVersion ?? "unknown"}.`,
    });
  }
  if (
    !childPnpm.executable_realpath
    || childPnpm.intrinsic.exit_code !== 0
    || !childPnpm.intrinsic.version
    || childPnpm.nested.exit_code !== 0
    || !childPnpm.nested.version
  ) {
    failures.push({
      code: "child_pnpm_identity_unavailable",
      message: "pnpm-owned child context did not return complete executable, intrinsic, and nested identity evidence.",
    });
  }
  if (
    childPnpm.intrinsic.version
    && childPnpm.intrinsic.version !== contract.pnpmVersion
  ) {
    failures.push({
      code: "child_pnpm_intrinsic_version_mismatch",
      message: `Child-resolved pnpm executable is intrinsically ${childPnpm.intrinsic.version}, not declared packageManager pnpm@${contract.pnpmVersion ?? "unknown"}.`,
    });
  }
  if (childPnpm.nested.version && childPnpm.nested.version !== contract.pnpmVersion) {
    failures.push({
      code: "nested_pnpm_version_mismatch",
      message: `A pnpm lifecycle child resolves pnpm ${childPnpm.nested.version}, not declared packageManager pnpm@${contract.pnpmVersion ?? "unknown"}.`,
    });
  }

  const pathTrace = await tracePath(env, options.repoRoot);
  return fleetConvergenceToolchainCheckSchema.parse({
    schema_version: "fleet-convergence-check/v1",
    surface: "toolchain",
    status: failures.length === 0 ? "pass" : "blocked",
    host: options.host,
    expected: {
      node_range: contract.nodeRange,
      ...(contract.pnpmVersion ? { package_manager: "pnpm" } : {}),
      pnpm_version: contract.pnpmVersion,
    },
    observed: {
      process_exec_path_realpath: redactPath(processExecPath, options.repoRoot),
      process_node_version: processIdentity.version,
      child_node: childNode,
      child_pnpm: childPnpm,
      bootstrap_cwd: redactPath(options.repoRoot, options.repoRoot),
      spawn_contract: SELF_UPGRADE_CHILD_SPAWN_CONTRACT,
      environment_contract: "self-upgrade-bootstrap-isolated-env/v1",
      path_resolution: {
        observer: "parent_diagnostic",
        total_entries: pathTrace.total_entries,
        truncated: pathTrace.truncated,
        entries: pathTrace.entries,
      },
    },
    failures,
    checked_at: options.checkedAt,
    evidence: {
      source: "self-upgrade-bootstrap-attestation",
      spawn_contract: SELF_UPGRADE_CHILD_SPAWN_CONTRACT,
    },
    freshness: { status: "current", observed_at: options.checkedAt },
    ...(failures.length > 0
      ? {
          repair_owner: "fleet_ops",
          next_action: {
            kind: "repair_toolchain",
            description: `Repair ${options.host}'s child-resolved Node/pnpm toolchain, then rerun calyx self upgrade --host ${options.host} --dry-run.`,
          },
        }
      : {}),
    topology_identity: { status: "not_bound" },
    target_bundle_identity: { calyx_source_sha: options.targetSha },
  });
}

export async function createUnobservedToolchainCheck(args: {
  host: string;
  repoRoot: string;
  targetSha: string | null;
  checkedAt: string;
}): Promise<FleetConvergenceToolchainCheck> {
  const contract = await readPackageContract(args.repoRoot);
  return fleetConvergenceToolchainCheckSchema.parse({
    schema_version: "fleet-convergence-check/v1",
    surface: "toolchain",
    status: "unknown",
    host: args.host,
    expected: {
      node_range: contract.nodeRange,
      ...(contract.pnpmVersion ? { package_manager: "pnpm" } : {}),
      pnpm_version: contract.pnpmVersion,
    },
    observed: {
      child_node: { exit_code: -1, error: "Not observed by this command." },
      child_pnpm: {
        resolution_source: "pnpm-exec-node-path",
        self_dispatched: { exit_code: -1, error: "Not observed by this command." },
        intrinsic: {
          exit_code: -1,
          error: "Not observed by this command.",
          probe: "with-current",
        },
        nested: { exit_code: -1, error: "Not observed by this command." },
      },
      bootstrap_cwd: redactPath(args.repoRoot, args.repoRoot),
      spawn_contract: SELF_UPGRADE_CHILD_SPAWN_CONTRACT,
      environment_contract: "self-upgrade-bootstrap-isolated-env/v1",
      path_resolution: {
        observer: "parent_diagnostic",
        total_entries: 0,
        truncated: false,
        entries: [],
      },
    },
    failures: [],
    checked_at: args.checkedAt,
    evidence: { source: "unobserved", spawn_contract: SELF_UPGRADE_CHILD_SPAWN_CONTRACT },
    freshness: { status: "unobserved" },
    repair_owner: "fleet_ops",
    next_action: {
      kind: "run_self_upgrade_preflight",
      description: `Run calyx self upgrade --host ${args.host} --dry-run to attest the bootstrap toolchain.`,
    },
    topology_identity: { status: "not_bound" },
    target_bundle_identity: { calyx_source_sha: args.targetSha },
  });
}

function normalizeHostAlias(value: string): string {
  return value.trim().toLowerCase().split(".")[0] ?? "";
}

async function recallPersistedBlockedToolchainCheck(args: {
  host: string;
  targetSha: string | null;
}): Promise<FleetConvergenceToolchainCheck | undefined> {
  if (!args.targetSha) return undefined;
  const paths = resolveStatePaths();
  try {
    await access(paths.dbPath);
  } catch {
    return undefined;
  }

  try {
    const opened = await openStateStore();
    try {
      const row = listFleetConvergenceRows(opened.db, { leg: "daemon_build" })
        .find((candidate) => normalizeHostAlias(candidate.host) === normalizeHostAlias(args.host));
      if (!row || row.target_rev !== args.targetSha || !row.receipt_path) return undefined;
      if (!row.payload || typeof row.payload !== "object" || !("toolchain_check" in row.payload)) {
        return undefined;
      }
      const parsed = fleetConvergenceToolchainCheckSchema.safeParse(
        (row.payload as { toolchain_check?: unknown }).toolchain_check,
      );
      if (!parsed.success || parsed.data.status !== "blocked") return undefined;
      if (
        normalizeHostAlias(parsed.data.host) !== normalizeHostAlias(args.host)
        || parsed.data.target_bundle_identity.calyx_source_sha !== args.targetSha
      ) {
        return undefined;
      }
      return fleetConvergenceToolchainCheckSchema.parse({
        ...parsed.data,
        freshness: {
          status: "recalled",
          observed_at: parsed.data.checked_at,
        },
      });
    } finally {
      opened.db.close();
    }
  } catch {
    return undefined;
  }
}

export type SelfUpgradeToolchainCleanupDiagnosticDetail = "residue" | "inspection_unavailable";

/**
 * Non-authoritative local hygiene signal carried beside a completed toolchain
 * observation. It never changes the check's status or names a recoverable
 * workspace, reference, cursor, or cleanup authority.
 */
export interface SelfUpgradeToolchainObservationDiagnostic {
  readonly kind: "operation_cleanup";
  readonly severity: "warning";
  readonly detail: SelfUpgradeToolchainCleanupDiagnosticDetail;
  readonly message: string;
  readonly actions: readonly string[];
}

export interface SelfUpgradeToolchainObservation {
  readonly check: FleetConvergenceToolchainCheck;
  readonly diagnostics: readonly SelfUpgradeToolchainObservationDiagnostic[];
}

export type ToolchainCheckForHostResult = FleetConvergenceToolchainCheck | SelfUpgradeToolchainObservation;

export type ProductionToolchainCheckForHost = (args: {
  host: string;
  repoRoot: string;
  targetSha: string | null;
  checkedAt: string;
}) => Promise<SelfUpgradeToolchainObservation>;

function cleanupObservationDiagnostic(
  cleanup: SelfUpgradeBootstrapSandboxCleanupResult,
): SelfUpgradeToolchainObservationDiagnostic | undefined {
  if (cleanup.status === "cleaned") return undefined;
  const detail: SelfUpgradeToolchainCleanupDiagnosticDetail = cleanup.status;
  return {
    kind: "operation_cleanup",
    severity: "warning",
    detail,
    message: detail === "residue"
      ? "Best-effort local self-upgrade cleanup left residue; no recovery authority was recorded."
      : "Best-effort local self-upgrade cleanup could not prove root absence; no recovery authority was recorded.",
    actions: [],
  };
}

export function createProductionToolchainCheckForHost(options: {
  currentHostAlias: string;
  attestToolchain?: typeof attestSelfUpgradeToolchain;
  recallBlockedToolchainCheck?: typeof recallPersistedBlockedToolchainCheck;
  /** Source only for the allowlisted child values; it is never passed to a child verbatim. */
  bootstrapEnvSource?: NodeJS.ProcessEnv;
  homeDir?: () => string;
  childSpawn?: SelfUpgradeChildSpawn;
  processIdentity?: { execPath: string; version: string };
}): ProductionToolchainCheckForHost {
  const attestToolchain = options.attestToolchain ?? attestSelfUpgradeToolchain;
  const recallBlockedToolchainCheck = options.recallBlockedToolchainCheck
    ?? recallPersistedBlockedToolchainCheck;
  const homeDir = options.homeDir ?? homedir;
  return async (args) => {
    if (normalizeHostAlias(args.host) === normalizeHostAlias(options.currentHostAlias)) {
      const sandbox = createSelfUpgradeBootstrapSandbox({
        homeDirectory: homeDir(),
        sourceEnv: options.bootstrapEnvSource ?? process.env,
      });
      await initializeSelfUpgradeBootstrapSandbox(sandbox);
      let attestation: FleetConvergenceToolchainCheck | undefined;
      let attestationFailure: unknown;
      let attestationSucceeded = false;
      try {
        attestation = await attestToolchain({
          ...args,
          env: sandbox.env,
          ...(options.childSpawn ? { childSpawn: options.childSpawn } : {}),
          ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
        });
        attestationSucceeded = true;
      } catch (error) {
        attestationFailure = error;
      }
      // This is local best-effort hygiene after the attestation, not evidence
      // about the child toolchain and not a recovery authority. In particular,
      // a cleanup residue must not convert a completed observation into a
      // blocked toolchain result.
      let cleanup: SelfUpgradeBootstrapSandboxCleanupResult;
      try {
        cleanup = await cleanupSelfUpgradeBootstrapSandbox(sandbox);
      } catch {
        cleanup = { status: "inspection_unavailable" };
      }
      if (!attestationSucceeded) {
        throw attestationFailure;
      }
      if (!attestation) {
        throw new Error("Self-upgrade toolchain check completed without an attestation result.");
      }
      const diagnostic = cleanupObservationDiagnostic(cleanup);
      return {
        check: attestation,
        diagnostics: diagnostic ? [diagnostic] : [],
      };
    }
    const recalled = await recallBlockedToolchainCheck({
      host: args.host,
      targetSha: args.targetSha,
    });
    return {
      check: recalled ?? await createUnobservedToolchainCheck(args),
      diagnostics: [],
    };
  };
}
