import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { agentsInfraEnvVar, resolveAgentsInfraRoot, resolveRepoForRun } from "@polli-labs/calyx-core";
import {
  type ClassifierPipeline,
  assertTransition,
  createBuiltInRuntimeAdapterRegistry,
  executeRun,
  type ArtifactEntry,
  type AgentRunnerSessionCheckpoint,
  type LifecycleEvent,
  type ReceiptExit,
  type ReceiptLogSummary,
  type RuntimeAdapterRegistry,
  type RunDeps,
  type RunReceipt,
  type RunResult,
  type RunSpec,
  type RunState,
  type InfraErrorClassification,
  type WorktreeLeaseManager,
  classifyInfraError,
  normalizeInfraErrorClassification,
  writeReceipt,
  writeReceiptAtomically,
} from "@polli-labs/calyx-runner";
import { resolveRunIntent, type ResolveRunIntentOptions } from "./resolve.js";
import { serverOnlyEnvironmentNames } from "./worker-supervisor.js";
import {
  admittedHostProcessExecutionIsValid,
  type AdmittedHostProcessExecution,
} from "./host-process-execution-binding.js";
import type {
  BoundHostProcessReceipt,
  ExecutionReceipt,
  ExecutionKernelId,
  HostProcessHealthConfig,
  RunHealthObservation,
  RunHealthSnapshot,
  ResolvedExecutionSpec,
  ResolvedHostProcessSpec,
  ResolvedRunSpec,
  RunNextTurnInput,
  RunIntent,
} from "./types.js";
import { HOST_PROCESS_RECEIPT_SCHEMA_VERSION } from "./types.js";

export interface ExecutionResult<Receipt extends ExecutionReceipt = ExecutionReceipt> {
  receipt: Receipt;
  events: LifecycleEvent[];
  dispatch_accepted: boolean;
}

export interface ExecutionKernelContext {
  intent: RunIntent;
  executionId: string;
  hostProcessExecution?: AdmittedHostProcessExecution;
  receiptPath: string;
  defaultWorktreeBase: string;
  agentsInfraRoot?: string;
  discoverArtifacts: (cwd: string) => Promise<ArtifactEntry[]>;
  onEvent?: (event: LifecycleEvent) => void;
  onHealthUpdate?: (health: RunHealthSnapshot) => void;
  onSessionCheckpoint?: (checkpoint: AgentRunnerSessionCheckpoint) => void;
  registerTerminationHook?: (handler: () => void) => void;
  nextTurnInput?: RunNextTurnInput;
  serverOnlyEnvNames?: readonly string[];
}

export interface ExecutionKernel<
  Spec extends ResolvedExecutionSpec = ResolvedExecutionSpec,
  Receipt extends ExecutionReceipt = ExecutionReceipt,
> {
  readonly id: ExecutionKernelId;
  resolveIntent(intent: RunIntent, options?: ResolveRunIntentOptions): Promise<Spec>;
  executeResolvedSpec(spec: Spec, context: ExecutionKernelContext): Promise<ExecutionResult<Receipt>>;
  createRecoverySpec(intent: RunIntent, now: () => string): Spec;
}

export interface AgentRunnerKernelDependencies {
  runtimeAdapterRegistry: RuntimeAdapterRegistry;
  executeRun: typeof executeRun;
  exitClassifierPipeline?: ClassifierPipeline;
  worktreeLease?: WorktreeLeaseManager | undefined;
}

const DEFAULT_HOST_PROCESS_STOP_GRACE_MS = 5_000;
const DEFAULT_HOST_PROCESS_HEALTH_POLL_INTERVAL_MS = 5_000;
const HOST_PROCESS_STOP_CONFIRM_MS = 1_000;
const HOST_PROCESS_STOP_POLL_INTERVAL_MS = 25;

interface LineCounter {
  lines: number;
  trailing: string;
}

interface TerminationTarget {
  scope: "process" | "process_group";
  id: number;
}

interface ActiveHealthSource {
  kind: RunHealthObservation["kind"];
  label: string;
  path: string;
  observe: () => Promise<{ exists: boolean; lastModifiedAtMs?: number }>;
}

interface EvaluatedHealthSnapshot {
  snapshot: RunHealthSnapshot;
  lastProgressAtMs?: number;
}

export function createSingleFlightPoller(): {
  run(task: () => Promise<void>): Promise<void>;
  current(): Promise<void> | undefined;
} {
  let active: Promise<void> | undefined;
  return {
    run(task: () => Promise<void>): Promise<void> {
      if (active) {
        return active;
      }
      const work = task();
      active = work;
      void work.finally(() => {
        if (active === work) {
          active = undefined;
        }
      });
      return work;
    },
    current(): Promise<void> | undefined {
      return active;
    },
  };
}

function countLines(counter: LineCounter, chunk: Buffer | string): void {
  const text = `${counter.trailing}${chunk.toString()}`;
  const parts = text.split(/\r?\n/);
  counter.trailing = parts.pop() ?? "";
  counter.lines += parts.length;
}

function finalizeLineCounter(counter: LineCounter): number {
  return counter.lines + (counter.trailing.length > 0 ? 1 : 0);
}

function toSignalExitCode(signal: NodeJS.Signals | null): number | undefined {
  if (!signal) {
    return undefined;
  }
  const signalNumbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  const signalNumber = signalNumbers[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : undefined;
}

function createTerminationTarget(child: ChildProcess): TerminationTarget | undefined {
  if (typeof child.pid !== "number") {
    return undefined;
  }
  if (process.platform === "win32") {
    return {
      scope: "process",
      id: child.pid,
    };
  }
  return {
    scope: "process_group",
    id: child.pid,
  };
}

function describeTerminationTarget(target: TerminationTarget | undefined, fallbackPid: number | undefined): string {
  if (target) {
    return target.scope === "process_group"
      ? `host process group ${target.id}`
      : `host process ${target.id}`;
  }
  return `host process ${fallbackPid ?? "unknown"}`;
}

function toTerminationSignalPid(target: TerminationTarget): number {
  return target.scope === "process_group" ? -target.id : target.id;
}

function isTerminationTargetAlive(target: TerminationTarget): boolean {
  try {
    process.kill(toTerminationSignalPid(target), 0);
    return true;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ESRCH") {
      return false;
    }
    if (errno.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function signalTerminationTarget(target: TerminationTarget, signal: NodeJS.Signals): void {
  process.kill(toTerminationSignalPid(target), signal);
}

async function waitForTerminationTargetExit(target: TerminationTarget, timeoutMs: number): Promise<boolean> {
  if (!isTerminationTargetAlive(target)) {
    return true;
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(
      HOST_PROCESS_STOP_POLL_INTERVAL_MS,
      Math.max(1, deadline - Date.now()),
    )));
    if (!isTerminationTargetAlive(target)) {
      return true;
    }
  }
  return !isTerminationTargetAlive(target);
}

function toIsoTimestamp(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

function defaultHealthSourceLabel(
  source: HostProcessHealthConfig["sources"][number],
): string {
  if (source.label?.trim()) {
    return source.label.trim();
  }
  if (source.kind === "file") {
    return source.path.trim();
  }
  return source.kind === "stdout" ? "stdout.log" : "stderr.log";
}

function normalizeHostProcessHealthConfig(
  health: HostProcessHealthConfig | undefined,
  cwd: string,
  runId: string,
): ResolvedHostProcessSpec["health"] | undefined {
  if (!health) {
    return undefined;
  }

  if (!Number.isFinite(health.stale_after_ms) || health.stale_after_ms <= 0) {
    throw new Error(
      `Run ${runId} has invalid host_process.health.stale_after_ms=${String(health.stale_after_ms)}.`,
    );
  }

  const sources = (health.sources ?? [])
    .map((source) => {
      if (source.kind === "file") {
        const filePath = source.path.trim();
        if (!filePath) {
          throw new Error(`Run ${runId} requires non-empty host_process.health.sources[].path for kind=file.`);
        }
        return {
          kind: "file" as const,
          label: defaultHealthSourceLabel(source),
          path: path.resolve(cwd, filePath),
        };
      }

      return {
        kind: source.kind,
        label: defaultHealthSourceLabel(source),
      };
    });

  if (sources.length === 0) {
    throw new Error(`Run ${runId} requires at least one host_process.health source when health is configured.`);
  }

  const pollIntervalMs = health.poll_interval_ms ?? Math.min(
    health.stale_after_ms,
    DEFAULT_HOST_PROCESS_HEALTH_POLL_INTERVAL_MS,
  );
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      `Run ${runId} has invalid host_process.health.poll_interval_ms=${String(health.poll_interval_ms)}.`,
    );
  }

  return {
    stale_after_ms: health.stale_after_ms,
    poll_interval_ms: pollIntervalMs,
    sources,
  };
}

async function safeStatMtimeMs(filePath: string): Promise<{ exists: boolean; lastModifiedAtMs?: number }> {
  try {
    const stats = await stat(filePath);
    return { exists: true, lastModifiedAtMs: stats.mtimeMs };
  } catch {
    return { exists: false };
  }
}

function materializeActiveHealthSources(args: {
  config: NonNullable<ResolvedHostProcessSpec["health"]>;
  stdoutPath: string;
  stderrPath: string;
  getStdoutActivityAtMs: () => number | undefined;
  getStderrActivityAtMs: () => number | undefined;
}): ActiveHealthSource[] {
  return args.config.sources.map((source) => {
    if (source.kind === "stdout") {
      return {
        kind: source.kind,
        label: source.label,
        path: args.stdoutPath,
        observe: async () => {
          const lastModifiedAtMs = args.getStdoutActivityAtMs();
          return {
            exists: true,
            ...(typeof lastModifiedAtMs === "number" ? { lastModifiedAtMs } : {}),
          };
        },
      };
    }
    if (source.kind === "stderr") {
      return {
        kind: source.kind,
        label: source.label,
        path: args.stderrPath,
        observe: async () => {
          const lastModifiedAtMs = args.getStderrActivityAtMs();
          return {
            exists: true,
            ...(typeof lastModifiedAtMs === "number" ? { lastModifiedAtMs } : {}),
          };
        },
      };
    }
    return {
      kind: source.kind,
      label: source.label,
      path: source.path ?? path.resolve(source.label),
      observe: async () => safeStatMtimeMs(source.path ?? path.resolve(source.label)),
    };
  });
}

function buildHostProcessHealthSummary(args: {
  status: RunHealthSnapshot["status"];
  staleAfterMs: number;
  lastProgressAtMs?: number;
  freshestLabel?: string;
}): string {
  if (args.status === "healthy" && args.lastProgressAtMs) {
    return `Recent progress observed at ${toIsoTimestamp(args.lastProgressAtMs)} via ${args.freshestLabel ?? "configured health sources"}.`;
  }
  if (args.status === "stale" && args.lastProgressAtMs) {
    return `Last progress at ${toIsoTimestamp(args.lastProgressAtMs)} is older than ${args.staleAfterMs} ms.`;
  }
  if (args.status === "stale") {
    return `No post-launch progress was observed within ${args.staleAfterMs} ms.`;
  }
  return "Waiting for first post-launch progress signal from configured health sources.";
}

async function evaluateHostProcessHealth(args: {
  checkedAtMs: number;
  launchedAtMs: number;
  config: NonNullable<ResolvedHostProcessSpec["health"]>;
  sources: ActiveHealthSource[];
  lastProgressAtMs?: number;
}): Promise<EvaluatedHealthSnapshot> {
  const observations: RunHealthObservation[] = [];
  let nextLastProgressAtMs = args.lastProgressAtMs;
  let freshestLabel: string | undefined;

  for (const source of args.sources) {
    const observed = await source.observe();
    observations.push({
      kind: source.kind,
      label: source.label,
      path: source.path,
      exists: observed.exists,
      ...(typeof observed.lastModifiedAtMs === "number"
        ? { last_modified_at: toIsoTimestamp(observed.lastModifiedAtMs) }
        : {}),
    });

    if (
      typeof observed.lastModifiedAtMs === "number"
      && observed.lastModifiedAtMs > args.launchedAtMs
      && (nextLastProgressAtMs === undefined || observed.lastModifiedAtMs > nextLastProgressAtMs)
    ) {
      nextLastProgressAtMs = observed.lastModifiedAtMs;
      freshestLabel = source.label;
    }
  }

  const referenceMs = nextLastProgressAtMs ?? args.launchedAtMs;
  const ageMs = Math.max(0, args.checkedAtMs - referenceMs);
  let status: RunHealthSnapshot["status"];
  if (nextLastProgressAtMs === undefined) {
    status = ageMs > args.config.stale_after_ms ? "stale" : "unknown";
  } else {
    status = ageMs > args.config.stale_after_ms ? "stale" : "healthy";
  }

  return {
    ...(typeof nextLastProgressAtMs === "number" ? { lastProgressAtMs: nextLastProgressAtMs } : {}),
    snapshot: {
      source: "host_process",
      status,
      checked_at: toIsoTimestamp(args.checkedAtMs),
      stale_after_ms: args.config.stale_after_ms,
      ...(nextLastProgressAtMs ? { last_progress_at: toIsoTimestamp(nextLastProgressAtMs) } : {}),
      observations,
      summary: buildHostProcessHealthSummary({
        status,
        staleAfterMs: args.config.stale_after_ms,
        ...(typeof nextLastProgressAtMs === "number" ? { lastProgressAtMs: nextLastProgressAtMs } : {}),
        ...(freshestLabel ? { freshestLabel } : {}),
      }),
    },
  };
}

function shouldEmitHealthSnapshot(
  previous: RunHealthSnapshot | undefined,
  next: RunHealthSnapshot,
): boolean {
  if (!previous) {
    return true;
  }
  if (previous.status !== next.status) {
    return true;
  }
  if (previous.last_progress_at !== next.last_progress_at) {
    return true;
  }
  const previousObservations = previous.observations.map((observation) =>
    `${observation.label}:${observation.exists}:${observation.last_modified_at ?? "missing"}`,
  );
  const nextObservations = next.observations.map((observation) =>
    `${observation.label}:${observation.exists}:${observation.last_modified_at ?? "missing"}`,
  );
  return previousObservations.join("|") !== nextObservations.join("|");
}

function normalizeHostProcessIntent(intent: RunIntent): {
  argv: string[];
  cwd: string;
  env?: Record<string, string | null>;
  stopGraceMs: number;
  health?: NonNullable<ResolvedHostProcessSpec["health"]>;
} {
  const unsupportedFields = [
    ["backend", intent.backend],
    ["profile", intent.profile],
    ["prompt", intent.prompt],
    ["prompt_file", intent.prompt_file],
    ["template", intent.template],
    ["template_vars", intent.template_vars],
    ["execplan_ref", intent.execplan_ref],
    ["repo", intent.repo],
    ["worktree_mode", intent.worktree_mode],
    ["worktree_base", intent.worktree_base],
    ["worktree_path", intent.worktree_path],
    ["worktree_ref", intent.worktree_ref],
    ["branch", intent.branch],
    ["steal_lock", intent.steal_lock],
    ["lock_timeout_ms", intent.lock_timeout_ms],
    ["require_execplan", intent.require_execplan],
    ["pull_execplan", intent.pull_execplan],
    ["required_artifacts", intent.required_artifacts],
    ["artifact_roots", intent.artifact_roots],
    ["backend_options", intent.backend_options],
  ]
    .filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      if (typeof value === "object" && value !== null) {
        return Object.keys(value).length > 0;
      }
      return value !== undefined && value !== false;
    })
    .map(([field]) => field);
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Run ${intent.run_id} selected kernel host_process, but agent_runner-only fields were set: ${unsupportedFields.join(", ")}.`,
    );
  }

  const hostProcess = intent.host_process;
  if (!hostProcess) {
    throw new Error(`Run ${intent.run_id} selected kernel host_process but provided no host_process spec.`);
  }
  const argv = hostProcess.argv.map((value) => value.trim()).filter((value) => value.length > 0);
  if (argv.length === 0) {
    throw new Error(`Run ${intent.run_id} requires at least one --argv value when kernel=host_process.`);
  }
  const cwd = hostProcess.cwd?.trim();
  if (!cwd) {
    throw new Error(`Run ${intent.run_id} requires --cwd when kernel=host_process.`);
  }
  const stopGraceMs = hostProcess.stop_grace_ms ?? DEFAULT_HOST_PROCESS_STOP_GRACE_MS;
  if (!Number.isFinite(stopGraceMs) || stopGraceMs <= 0) {
    throw new Error(
      `Run ${intent.run_id} has invalid host_process.stop_grace_ms=${String(hostProcess.stop_grace_ms)}.`,
    );
  }

  const env = hostProcess.env
    ? Object.fromEntries(
        Object.entries(hostProcess.env)
          .map(([key, value]) => [key.trim(), value] as const)
          .filter(([key]) => key.length > 0),
      )
    : undefined;

  const resolvedCwd = path.resolve(cwd);
  const normalizedHealth = hostProcess.health
    ? normalizeHostProcessHealthConfig(hostProcess.health, resolvedCwd, intent.run_id)
    : undefined;

  return {
    argv,
    cwd: resolvedCwd,
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    stopGraceMs,
    ...(normalizedHealth ? { health: normalizedHealth } : {}),
  };
}

function buildHostProcessExit(args: {
  stopRequested: boolean;
  spawnError: Error | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  teardownError?: string;
  infraErrorClassification?: InfraErrorClassification;
}): ReceiptExit {
  const exit: ReceiptExit = {};
  const exitCode = args.code ?? toSignalExitCode(args.signal);
  if (typeof exitCode === "number") {
    exit.exit_code = exitCode;
  }
  if (args.spawnError) {
    exit.error = args.spawnError.message;
    exit.failure_class = "infra_error";
    exit.failure_source = "heuristic";
    if (args.infraErrorClassification) {
      exit.failure_layer = args.infraErrorClassification.failure_layer;
      exit.failure_reason = args.infraErrorClassification.failure_reason;
    }
    return exit;
  }
  if (args.teardownError) {
    exit.error = args.teardownError;
    exit.failure_class = "infra_error";
    exit.failure_source = "heuristic";
    if (args.infraErrorClassification) {
      exit.failure_layer = args.infraErrorClassification.failure_layer;
      exit.failure_reason = args.infraErrorClassification.failure_reason;
    }
    return exit;
  }
  if (!args.stopRequested && typeof exitCode === "number" && exitCode !== 0) {
    exit.failure_class = "task_failure";
    exit.failure_source = args.signal ? "heuristic" : "exit_code";
  }
  return exit;
}

function buildHostProcessSummary(
  spec: ResolvedHostProcessSpec,
  state: RunState,
  teardownError?: string,
): string {
  const command = spec.process.argv.join(" ");
  if (state === "cancelled") {
    return `Host process ${command} cancelled after stop request.`;
  }
  if (state === "succeeded") {
    return `Host process ${command} succeeded.`;
  }
  if (state === "infra_error") {
    if (teardownError) {
      return `Host process ${command} stop failed: ${teardownError}`;
    }
    return `Host process ${command} failed before launch completed.`;
  }
  return `Host process ${command} ${state}.`;
}

const HOST_PROCESS_LOG_SUMMARY_CLASSIFIER_VERSION = "host-process-log-summary/v1";

function buildHostProcessLogSummary(stdoutLines: number, stderrLines: number): ReceiptLogSummary {
  const total = stdoutLines + stderrLines;
  return {
    total,
    info: 0,
    warn: 0,
    error: 0,
    streams: {
      stdout_lines: stdoutLines,
      stderr_lines: stderrLines,
    },
    severity: {
      info: 0,
      warn: 0,
      error: 0,
      unknown: total,
    },
    classifier_version: HOST_PROCESS_LOG_SUMMARY_CLASSIFIER_VERSION,
  };
}

async function writeKernelReceipt(
  receiptPath: string,
  expectedRunId: string,
  receipt: ExecutionReceipt,
): Promise<void> {
  if (
    receipt.schema_version !== HOST_PROCESS_RECEIPT_SCHEMA_VERSION
    || !("kernel" in receipt)
    || receipt.kernel !== "host_process"
    || !("execution_binding" in receipt)
    || receipt.run_id !== expectedRunId
  ) {
    throw new Error("Refusing to publish an invalid host-process kernel receipt.");
  }
  await writeReceiptAtomically(receipt, receiptPath);
}

function toRunnerSpec(spec: ResolvedRunSpec): RunSpec {
  return {
    run_id: spec.run_id,
    host: spec.host,
    backend: spec.backend,
    require_execplan: spec.require_execplan ?? spec.execplan_source !== undefined,
    pull_execplan: false,
    worktree: spec.worktree,
    prompt: spec.prompt,
    ...(spec.system_prompt ? { system_prompt: spec.system_prompt } : {}),
    ...(spec.append_system_prompt ? { append_system_prompt: spec.append_system_prompt } : {}),
    ...(typeof spec.max_turns_per_run === "number" ? { max_turns_per_run: spec.max_turns_per_run } : {}),
    ...(spec.issue ? { issue: spec.issue } : {}),
    ...(spec.profile ? { profile: spec.profile } : {}),
    ...(spec.execplan_source ? { execplan_ref: spec.execplan_source } : {}),
    ...(spec.required_artifacts.length > 0 ? { required_artifacts: spec.required_artifacts } : {}),
    ...(spec.artifact_roots && spec.artifact_roots.length > 0 ? { artifact_roots: spec.artifact_roots } : {}),
    ...(spec.output_capture ? { output_capture: spec.output_capture } : {}),
    ...(spec.backend_options ? { backend_options: spec.backend_options } : {}),
    ...(spec.notifications ? { notifications: spec.notifications } : {}),
    ...(spec.handback ? { handback: spec.handback } : {}),
    ...(spec.metadata ? { metadata: spec.metadata } : {}),
    ...(spec.resume_session_id ? { resume_session_id: spec.resume_session_id } : {}),
  };
}

export class AgentRunnerKernel implements ExecutionKernel<ResolvedRunSpec, RunReceipt> {
  readonly id = "agent_runner" as const;

  constructor(
    private readonly deps: AgentRunnerKernelDependencies = {
      runtimeAdapterRegistry: createBuiltInRuntimeAdapterRegistry(),
      executeRun,
    },
  ) {}

  async resolveIntent(intent: RunIntent, options?: ResolveRunIntentOptions): Promise<ResolvedRunSpec> {
    return resolveRunIntent(intent, options);
  }

  async executeResolvedSpec(
    spec: ResolvedRunSpec,
    context: ExecutionKernelContext,
  ): Promise<ExecutionResult<RunReceipt>> {
    const adapter = this.deps.runtimeAdapterRegistry.create(spec.backend);
    const existingBackendEnv = spec.backend_options?.env ?? {};
    const secretEnvNames = serverOnlyEnvironmentNames(
      process.env,
      context.serverOnlyEnvNames,
      Object.keys(existingBackendEnv),
    );
    const safeSpec: ResolvedRunSpec = spec.output_capture
      ? spec
      : {
          ...spec,
          backend_options: {
            ...(spec.backend_options ?? {}),
            env: {
              ...existingBackendEnv,
              ...Object.fromEntries(secretEnvNames.map((name) => [name, null])),
            },
          },
        };
    context.registerTerminationHook?.(() => {
      void adapter.stop(spec.run_id);
    });
    const result: RunResult = await this.deps.executeRun(toRunnerSpec(safeSpec), {
      adapter,
      ...(spec.output_capture ? { backendEnvironmentRedactions: secretEnvNames } : {}),
      worktree: {
        base_path: context.intent.worktree_base ?? context.defaultWorktreeBase,
        resolve_repo: async (slug: string) => {
          const agentsInfraRoot = context.agentsInfraRoot ?? await resolveAgentsInfraRoot();
          if (!agentsInfraRoot) {
            throw new Error(
              `Repo slug ${slug} requires agents-infra root discovery, but it could not be found on the target host. Set ${agentsInfraEnvVar()} or ensure ~/dev/agents-infra/dev exists.`,
            );
          }
          return resolveRepoForRun(slug, spec.host, agentsInfraRoot);
        },
        ...(typeof context.intent.lock_timeout_ms === "number"
          ? { lock_timeout_ms: context.intent.lock_timeout_ms }
          : {}),
        ...(this.deps.worktreeLease ? { lease: this.deps.worktreeLease } : {}),
      },
      discoverArtifacts: async (cwd: string) => context.discoverArtifacts(cwd),
      receiptPath: context.receiptPath,
      ...(this.deps.exitClassifierPipeline ? { exitClassifierPipeline: this.deps.exitClassifierPipeline } : {}),
      ...(context.onEvent ? { onEvent: context.onEvent } : {}),
      ...(context.onHealthUpdate ? { onHealthUpdate: context.onHealthUpdate } : {}),
      ...(context.onSessionCheckpoint ? { onSessionCheckpoint: context.onSessionCheckpoint } : {}),
      ...(context.nextTurnInput ? { nextTurnInput: context.nextTurnInput } : {}),
    } as RunDeps);
    // The kernel boundary, not an injected runner implementation, owns the
    // durable typed-receipt postcondition. Production executeRun already
    // publishes this path; the idempotent rewrite validates and fsyncs the
    // exact enriched receipt being returned before RunService reads authority.
    await writeReceipt(result.receipt, context.receiptPath);
    return result;
  }

  createRecoverySpec(intent: RunIntent, now: () => string): ResolvedRunSpec {
    return {
      run_id: intent.run_id,
      kernel: "agent_runner",
      host: intent.host,
      backend: intent.backend ?? "claude",
      prompt: intent.prompt ?? "",
      require_execplan: intent.require_execplan !== false,
      worktree: {
        ...(intent.repo ? { repo: intent.repo } : {}),
      },
      required_artifacts: intent.required_artifacts ?? [],
      artifact_roots: intent.artifact_roots ?? [],
      ...(intent.output_capture ? { output_capture: intent.output_capture } : {}),
      ...(intent.issue ? { issue: intent.issue } : {}),
      ...(intent.profile ? { profile: intent.profile } : {}),
      ...(typeof intent.max_turns_per_run === "number" ? { max_turns_per_run: intent.max_turns_per_run } : {}),
      ...(intent.backend_options ? { backend_options: intent.backend_options } : {}),
      ...(intent.notifications ? { notifications: intent.notifications } : {}),
      ...(intent.handback ? { handback: intent.handback } : {}),
      ...(intent.metadata ? { metadata: intent.metadata } : {}),
      ...(intent.resume_session_id ? { resume_session_id: intent.resume_session_id } : {}),
      resolved_at: now(),
      resolution_log: [],
    };
  }
}

export class HostProcessKernel implements ExecutionKernel<ResolvedHostProcessSpec, BoundHostProcessReceipt> {
  readonly id = "host_process" as const;

  async resolveIntent(intent: RunIntent, options?: ResolveRunIntentOptions): Promise<ResolvedHostProcessSpec> {
    const normalized = normalizeHostProcessIntent(intent);
    return {
      run_id: intent.run_id,
      kernel: "host_process",
      host: intent.host,
      required_artifacts: [],
      artifact_roots: [],
      ...(intent.notifications ? { notifications: intent.notifications } : {}),
      ...(intent.handback ? { handback: intent.handback } : {}),
      ...(intent.metadata ? { metadata: intent.metadata } : {}),
      resolved_at: options?.now ? options.now() : new Date().toISOString(),
      resolution_log: [
        {
          name: "host_process",
          status: "resolved",
          detail: `Using run launch --kernel host_process with ${normalized.argv[0]} in ${normalized.cwd}.`,
        },
      ],
      process: {
        argv: normalized.argv,
        cwd: normalized.cwd,
        ...(normalized.env ? { env: normalized.env } : {}),
        stop_grace_ms: normalized.stopGraceMs,
      },
      ...(normalized.health ? { health: normalized.health } : {}),
    };
  }

  async executeResolvedSpec(
    spec: ResolvedHostProcessSpec,
    context: ExecutionKernelContext,
  ): Promise<ExecutionResult<BoundHostProcessReceipt>> {
    const admittedExecution = context.hostProcessExecution;
    if (
      !admittedExecution
      || admittedExecution.binding.execution_id !== context.executionId
      || !admittedHostProcessExecutionIsValid(spec, admittedExecution)
    ) {
      throw new Error(
        `Run ${spec.run_id} host-process execution is missing its exact admitted environment binding.`,
      );
    }
    // Bound host receipts use effect-admission chronology. The unbound
    // predecessor used intent.created_at, which could precede admission by an
    // arbitrarily long queue delay; those receipts remain observation-only.
    const receiptCreatedAt = new Date().toISOString();
    const events: LifecycleEvent[] = [];
    const emit = (event: Omit<LifecycleEvent, "timestamp" | "run_id">): void => {
      const next: LifecycleEvent = {
        timestamp: new Date().toISOString(),
        run_id: spec.run_id,
        ...event,
      };
      events.push(next);
      context.onEvent?.(next);
    };
    let state: RunState = "queued";
    const transition = (
      to: RunState,
      message: string,
      infraErrorClassification?: InfraErrorClassification,
    ): void => {
      assertTransition(state, to);
      const from = state;
      state = to;
      emit({
        event: "state_transition",
        from,
        to,
        message,
        ...(to === "infra_error"
          ? {
              infra_error_classification: normalizeInfraErrorClassification(
                infraErrorClassification,
                { site: "backend_spawn", message },
              ),
            }
          : {}),
      });
    };

    const runDir = path.dirname(context.receiptPath);
    await mkdir(runDir, { recursive: true });
    const stdoutPath = path.join(runDir, "stdout.log");
    const stderrPath = path.join(runDir, "stderr.log");
    const stdoutStream = createWriteStream(stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(stderrPath, { flags: "w" });
    const stdoutCounter: LineCounter = { lines: 0, trailing: "" };
    const stderrCounter: LineCounter = { lines: 0, trailing: "" };
    let stdoutLastActivityAtMs: number | undefined;
    let stderrLastActivityAtMs: number | undefined;

    let stopRequested = false;
    let stopSignal: NodeJS.Signals | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let healthTimer: NodeJS.Timeout | undefined;
    let lastHealthSnapshot: RunHealthSnapshot | undefined;
    let lastProgressAtMs: number | undefined;
    let healthPoller: ReturnType<typeof createSingleFlightPoller> | undefined;
    let stopRequestedAtMs: number | undefined;

    let child: ChildProcess;
    try {
      child = spawnChild(spec.process.argv[0]!, spec.process.argv.slice(1), {
        cwd: spec.process.cwd,
        env: admittedExecution.spawn_environment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const spawnError = error instanceof Error ? error : new Error(String(error));
      const infraErrorClassification = classifyInfraError({
        site: "backend_spawn",
        message: spawnError.message,
      });
      if (state === "queued") {
        transition("dispatching", "Preparing host process launch.");
      }
      transition("infra_error", infraErrorClassification.message, infraErrorClassification);
      const receipt: BoundHostProcessReceipt = {
        schema_version: HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
        kernel: "host_process",
        run_id: spec.run_id,
        execution_binding: admittedExecution.binding,
        state: "infra_error",
        infra_error_classification: infraErrorClassification,
        timing: {
          created_at: receiptCreatedAt,
          completed_at: completedAt,
          duration_ms: new Date(completedAt).getTime() - new Date(receiptCreatedAt).getTime(),
        },
        exit: buildHostProcessExit({
          stopRequested: false,
          spawnError,
          code: null,
          signal: null,
          infraErrorClassification,
        }),
        log_summary: buildHostProcessLogSummary(0, 0),
        process: {
          argv: spec.process.argv,
          cwd: spec.process.cwd,
          env_keys: Object.keys(spec.process.env ?? {}).sort(),
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
          stop_grace_ms: spec.process.stop_grace_ms,
          stop_requested: false,
        },
        summary: buildHostProcessSummary(spec, "infra_error"),
        ...(spec.metadata ? { metadata: spec.metadata } : {}),
      };
      stdoutStream.end();
      stderrStream.end();
      await Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
      await writeKernelReceipt(context.receiptPath, spec.run_id, receipt);
      return { receipt, events, dispatch_accepted: true };
    }
    const terminationTarget = createTerminationTarget(child);

    child.stdout?.on("data", (chunk) => {
      countLines(stdoutCounter, chunk);
      stdoutLastActivityAtMs = Date.now();
    });
    child.stderr?.on("data", (chunk) => {
      countLines(stderrCounter, chunk);
      stderrLastActivityAtMs = Date.now();
    });
    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    emit({
      event: "backend_spawned",
      message: `Host process spawned: ${spec.process.argv.join(" ")}`,
      payload: {
        pid: child.pid,
        ...(terminationTarget?.scope === "process_group"
          ? { process_group_id: terminationTarget.id }
          : {}),
        cwd: spec.process.cwd,
      },
    });
    transition("dispatching", "Preparing host process launch.");
    const startedAt = new Date().toISOString();
    const startedAtMs = new Date(startedAt).getTime();
    transition("running", `Host process running in ${spec.process.cwd}`);

    if (spec.health) {
      const poller = createSingleFlightPoller();
      healthPoller = poller;
      const activeHealthSources = materializeActiveHealthSources({
        config: spec.health,
        stdoutPath,
        stderrPath,
        getStdoutActivityAtMs: () => stdoutLastActivityAtMs,
        getStderrActivityAtMs: () => stderrLastActivityAtMs,
      });

      const pollHealth = (checkedAtMs: number, forceEmit = false): Promise<void> =>
        poller.run(async () => {
          const evaluated = await evaluateHostProcessHealth({
            checkedAtMs,
            launchedAtMs: startedAtMs,
            config: spec.health!,
            sources: activeHealthSources,
            ...(typeof lastProgressAtMs === "number" ? { lastProgressAtMs } : {}),
          });
          lastProgressAtMs = evaluated.lastProgressAtMs;
          if (forceEmit || shouldEmitHealthSnapshot(lastHealthSnapshot, evaluated.snapshot)) {
            lastHealthSnapshot = evaluated.snapshot;
            context.onHealthUpdate?.(evaluated.snapshot);
          }
        });

      await pollHealth(startedAtMs, true);
      healthTimer = setInterval(() => {
        void pollHealth(Date.now());
      }, spec.health.poll_interval_ms);
      healthTimer.unref?.();
    }

    context.registerTerminationHook?.(() => {
      if (!child || stopRequested) {
        return;
      }
      stopRequested = true;
      stopRequestedAtMs = Date.now();
      stopSignal = "SIGTERM";
      emit({
        event: "warning",
        message: `Stop requested; forwarding SIGTERM to ${describeTerminationTarget(terminationTarget, child.pid)}.`,
        payload: {
          pid: child.pid,
          ...(terminationTarget?.scope === "process_group"
            ? { process_group_id: terminationTarget.id }
            : {}),
          signal: "SIGTERM",
          stop_grace_ms: spec.process.stop_grace_ms,
        },
      });
      try {
        if (terminationTarget) {
          signalTerminationTarget(terminationTarget, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        return;
      }
      killTimer = setTimeout(() => {
        if (terminationTarget) {
          if (!isTerminationTargetAlive(terminationTarget)) {
            return;
          }
        } else if (!child || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        stopSignal = "SIGKILL";
        emit({
          event: "warning",
          message: `${describeTerminationTarget(terminationTarget, child.pid)} exceeded stop grace; sending SIGKILL.`,
          payload: {
            pid: child.pid,
            ...(terminationTarget?.scope === "process_group"
              ? { process_group_id: terminationTarget.id }
              : {}),
            signal: "SIGKILL",
          },
        });
        try {
          if (terminationTarget) {
            signalTerminationTarget(terminationTarget, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // The process may have exited between the timer firing and the signal.
        }
      }, spec.process.stop_grace_ms);
      killTimer.unref?.();
    });

    const exitResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let settled = false;
      const settle = (payload: { code: number | null; signal: NodeJS.Signals | null; error?: Error }): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(payload);
      };
      child.once("error", (error) => {
        settle({
          code: null,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
      child.once("close", (code, signal) => {
        settle({ code, signal });
      });
    });

    if (killTimer) {
      clearTimeout(killTimer);
    }
    if (healthTimer) {
      clearInterval(healthTimer);
    }
    if (healthPoller?.current()) {
      await healthPoller.current();
    }

    stdoutStream.end();
    stderrStream.end();
    await Promise.allSettled([
      finished(stdoutStream),
      finished(stderrStream),
    ]);

    let teardownError: string | undefined;
    if (stopRequested && terminationTarget && isTerminationTargetAlive(terminationTarget)) {
      const elapsedSinceStopMs = typeof stopRequestedAtMs === "number"
        ? Math.max(0, Date.now() - stopRequestedAtMs)
        : spec.process.stop_grace_ms;
      const remainingGraceMs = Math.max(0, spec.process.stop_grace_ms - elapsedSinceStopMs);
      if (remainingGraceMs > 0) {
        await waitForTerminationTargetExit(terminationTarget, remainingGraceMs);
      }
      if (isTerminationTargetAlive(terminationTarget)) {
        if (stopSignal !== "SIGKILL") {
          stopSignal = "SIGKILL";
          emit({
            event: "warning",
            message: `${describeTerminationTarget(terminationTarget, child.pid)} exceeded stop grace; sending SIGKILL.`,
            payload: {
              pid: child.pid,
              ...(terminationTarget.scope === "process_group"
                ? { process_group_id: terminationTarget.id }
                : {}),
              signal: "SIGKILL",
            },
          });
          try {
            signalTerminationTarget(terminationTarget, "SIGKILL");
          } catch {
            // The process group may have disappeared between the liveness check and the signal.
          }
        }
        const fullyStopped = await waitForTerminationTargetExit(terminationTarget, HOST_PROCESS_STOP_CONFIRM_MS);
        if (!fullyStopped) {
          teardownError = `${describeTerminationTarget(terminationTarget, child.pid)} remained alive after stop escalation.`;
        }
      }
    }

    const stdoutLines = finalizeLineCounter(stdoutCounter);
    const stderrLines = finalizeLineCounter(stderrCounter);
    const terminalState: RunState = teardownError
      ? "infra_error"
      : exitResult.error
      ? "infra_error"
      : stopRequested
        ? "cancelled"
        : (exitResult.code ?? toSignalExitCode(exitResult.signal)) === 0
          ? "succeeded"
          : "failed";
    const terminalMessage = exitResult.error
      ? exitResult.error.message
      : teardownError
        ? teardownError
      : stopRequested
        ? `Host process exited after stop request (${stopSignal ?? "SIGTERM"}).`
        : `Host process exited with code ${String(exitResult.code ?? toSignalExitCode(exitResult.signal) ?? "unknown")}.`;
    const infraErrorClassification = terminalState === "infra_error"
      ? classifyInfraError({ site: "backend_spawn", message: terminalMessage })
      : undefined;
    transition(terminalState, terminalMessage, infraErrorClassification);

    const completedAt = new Date().toISOString();
    if (spec.health) {
      const activeHealthSources = materializeActiveHealthSources({
        config: spec.health,
        stdoutPath,
        stderrPath,
        getStdoutActivityAtMs: () => stdoutLastActivityAtMs,
        getStderrActivityAtMs: () => stderrLastActivityAtMs,
      });
      const evaluated = await evaluateHostProcessHealth({
        checkedAtMs: new Date(completedAt).getTime(),
        launchedAtMs: startedAtMs,
        config: spec.health,
        sources: activeHealthSources,
        ...(typeof lastProgressAtMs === "number" ? { lastProgressAtMs } : {}),
      });
      lastProgressAtMs = evaluated.lastProgressAtMs;
      lastHealthSnapshot = evaluated.snapshot;
    }
    const receipt: BoundHostProcessReceipt = {
      schema_version: HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
      kernel: "host_process",
      run_id: spec.run_id,
      execution_binding: admittedExecution.binding,
      state: terminalState,
      ...(infraErrorClassification ? { infra_error_classification: infraErrorClassification } : {}),
      timing: {
        created_at: receiptCreatedAt,
        ...(startedAt ? { started_at: startedAt } : {}),
        completed_at: completedAt,
        duration_ms: new Date(completedAt).getTime() - new Date(receiptCreatedAt).getTime(),
        ...(startedAt
          ? { backend_duration_ms: new Date(completedAt).getTime() - new Date(startedAt).getTime() }
          : {}),
      },
      exit: buildHostProcessExit({
        stopRequested,
        spawnError: exitResult.error,
        code: exitResult.code,
        signal: exitResult.signal,
        ...(teardownError ? { teardownError } : {}),
        ...(infraErrorClassification ? { infraErrorClassification } : {}),
      }),
      log_summary: buildHostProcessLogSummary(stdoutLines, stderrLines),
      process: {
        argv: spec.process.argv,
        cwd: spec.process.cwd,
        env_keys: Object.keys(spec.process.env ?? {}).sort(),
        ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
        ...(terminationTarget?.scope === "process_group" ? { process_group_id: terminationTarget.id } : {}),
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: stopRequested,
        ...(stopSignal ? { stop_signal: stopSignal } : {}),
      },
      ...(lastHealthSnapshot ? { health: lastHealthSnapshot } : {}),
      summary: buildHostProcessSummary(spec, terminalState, teardownError),
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    };
    await writeKernelReceipt(context.receiptPath, spec.run_id, receipt);
    return {
      receipt,
      events,
      dispatch_accepted: true,
    };
  }

  createRecoverySpec(intent: RunIntent, now: () => string): ResolvedHostProcessSpec {
    const normalized = normalizeHostProcessIntent(intent);
    return {
      run_id: intent.run_id,
      kernel: "host_process",
      host: intent.host,
      required_artifacts: [],
      ...(intent.notifications ? { notifications: intent.notifications } : {}),
      ...(intent.metadata ? { metadata: intent.metadata } : {}),
      resolved_at: now(),
      resolution_log: [],
      process: {
        argv: normalized.argv,
        cwd: normalized.cwd,
        ...(normalized.env ? { env: normalized.env } : {}),
        stop_grace_ms: normalized.stopGraceMs,
      },
      ...(normalized.health ? { health: normalized.health } : {}),
    };
  }
}
