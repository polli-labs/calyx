import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AdapterResult, ArtifactEntry, BackendAdapter, RunDeps, RunReceipt, RunResult, RunSpec } from "@polli-labs/calyx-runner";
import { evaluateArtifactGate, executeRun } from "@polli-labs/calyx-runner";
import {
  acquireLease,
  applyStateMigrations,
  completeMessageDelivery,
  createMessage,
  createMessageDeliveryAttempt,
  createMonitor,
  createMonitorDeliveryPolicy,
  createMonitorWake,
  enqueueMessageOutbox,
  exchangeSessionIngressLaunch,
  defaultMonitorDeliveryBinding,
  evaluatePredicateV1,
  installTask,
  loadStateDriver,
  listLeases,
  listLeaseEvents,
  listMessages,
  listPendingMessageOutbox,
  listMonitorDeliveries,
  listMonitorWakes,
  listTaskRuns,
  openStateStore,
  prepareSessionIngressLaunch,
  readLeaseResourceQuarantine,
  readMonitor,
  readMessageReceiptMirror,
  recordMonitorEvaluation,
  releaseLeasesForTerminalRuns,
  RunIndexProjection,
  upsertRunnerLiveBinding,
  withSqliteMutex,
  type ApiProvenanceV1,
  type TaskManifest,
  type PredicateV1,
} from "@polli-labs/calyx-core";
import {
  AgentRunnerKernel,
  deliverMonitorWakeBindings,
  HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
  HostProcessKernel,
  isCalyxMonitorEvent,
  isCalyxRunEvent,
  isRunTerminalEvent,
  isRunServiceEvent,
  resolveRunIntent,
  type CalyxControlEvent,
  type CalyxStreamEvent,
  type HostProcessReceipt,
  RunAlreadyExistsError,
  RunExecutionSettlementPendingError,
  RunStore,
  RunService,
  type RunIntent,
  type RunRecord,
  type RecordedRunEvent,
  type ResolvedRunSpec,
  type RunResourceAttributionObservation,
  type RunServiceDependencies,
} from "../index.js";
import type { RunTerminalEvent } from "../types.js";
import { createSingleFlightPoller } from "../kernel.js";
import {
  admitHostProcessExecution,
  freezeHostProcessSpawnEnvironment,
  hostProcessExecutionCommitment,
} from "../host-process-execution-binding.js";
import {
  isSystemdServiceCgroup,
  redactServerOnlyEnvironment,
  shouldUseSystemdWorkerIsolation,
  spawnDetachedWorker,
  systemdEnvironmentFileContents,
  systemdEscapeExecShell,
  systemdWorkerEnvironmentRoot,
  systemdWorkerUnitName,
} from "../worker-supervisor.js";
import {
  EventJournalCorruptionError,
  legacyDeadSettlementAuthorityId,
  legacyResourceSettlementAuthorityId,
} from "../store.js";

const STATE_ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

function apiProvenance(
  requestId = "req_00000000-0000-4000-8000-000000000001",
): ApiProvenanceV1 {
  return {
    schema_version: "calyx.provenance/v1",
    request_id: requestId,
    subject: "switchboard",
    asserted_actor: "operator:caleb",
    host: "blade",
    via: "http",
    at: "2026-07-14T04:30:00.000Z",
  };
}

function makeReceipt(
  runId: string,
  spec: RunSpec,
  state: RunReceipt["state"] = "succeeded",
  overrides: Partial<RunReceipt> = {},
): RunReceipt {
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    run_id: runId,
    state,
    run_spec: spec,
    timing: {
      created_at: now,
      completed_at: now,
    },
    exit: {
      exit_code: state === "succeeded" ? 0 : 6,
    },
    artifacts: {
      run_id: runId,
      finalized_at: now,
      required: [],
      discovered: [],
      gate_passed: true,
      missing: [],
    },
    log_summary: {
      total: 1,
      info: 1,
      warn: 0,
      error: 0,
    },
    environment: {
      host: spec.host,
      backend: spec.backend,
    },
    summary: `Run ${runId} ${state}`,
    ...overrides,
  };
}

function makeReceiptSpec(runId: string, intent: RunIntent, backend: RunSpec["backend"]): RunSpec {
  return {
    run_id: runId,
    host: intent.host,
    backend,
    prompt: intent.prompt ?? "",
    require_execplan: false,
    pull_execplan: false,
    worktree: {},
  };
}

function runnerSupervisionPredicate(runId: string): PredicateV1 {
  return {
    schema_version: "predicate/v1",
    kind: "any_of",
    predicates: [
      { schema_version: "predicate/v1", kind: "run.failed", run_id: runId },
      { schema_version: "predicate/v1", kind: "run.terminal", run_id: runId },
    ],
  };
}

function buildDeps(
  state: RunReceipt["state"] = "succeeded",
  receiptOverrides: Partial<RunReceipt> = {},
): Partial<RunServiceDependencies> {
  const adapter: BackendAdapter = {
    name: "mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    spawn: async (): Promise<AdapterResult> => ({
      exit_code: 0,
      stderr: "",
      events: [],
      duration_ms: 1,
    }),
    stop: async (): Promise<void> => {},
  };

  return {
    resolveExecutionKernel: () => new AgentRunnerKernel({
      runtimeAdapterRegistry: {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
      },
      executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
        const spec = rawSpec as RunSpec;
        deps.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: spec.run_id ?? "unknown",
          event: "state_transition",
          from: "queued",
          to: "running",
          message: "mock running",
        });
        const receipt = makeReceipt(spec.run_id ?? "unknown", spec, state, receiptOverrides);
        if (deps.receiptPath) {
          await rm(deps.receiptPath, { force: true });
          await import("node:fs/promises").then((mod) =>
            mod.writeFile(deps.receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
          );
        }
        return { receipt, events: [], dispatch_accepted: true };
      },
    }),
    collectHostResources: async () => ({
      schema_version: "host-resources/v1",
      checked_at: "2026-03-11T12:00:00.000Z",
      gpu: {
        provider: "nvidia-smi",
        status: "unavailable",
        checked_at: "2026-03-11T12:00:00.000Z",
        command: ["nvidia-smi"],
        gpus: [],
        message: "mocked",
      },
    }),
    collectResourceAttribution: async (rootPid?: number): Promise<RunResourceAttributionObservation> => ({
      schema_version: "run-resource-attribution/v1",
      checked_at: "2026-03-11T12:00:00.000Z",
      ...(typeof rootPid === "number" ? { root_pid: rootPid } : {}),
      status: typeof rootPid === "number" ? "attributed" : "pid_missing",
      process_tree: {
        provider: "ps",
        checked_at: "2026-03-11T12:00:00.000Z",
        ...(typeof rootPid === "number" ? { root_pid: rootPid } : {}),
        status: typeof rootPid === "number" ? "attributed" : "pid_missing",
        process_count: typeof rootPid === "number" ? 1 : 0,
        total_cpu_percent: typeof rootPid === "number" ? 3.5 : 0,
        total_rss_kib: typeof rootPid === "number" ? 2048 : 0,
        processes: typeof rootPid === "number" ? [{ pid: rootPid, ppid: 1, cpu_percent: 3.5, rss_kib: 2048 }] : [],
        truncated: false,
        max_processes: 32,
      },
      gpu_processes: {
        provider: "nvidia-smi",
        status: "none",
        checked_at: "2026-03-11T12:00:00.000Z",
        command: ["nvidia-smi"],
        host_process_count: 0,
        attributed_process_count: 0,
        attributed_memory_used_mib: 0,
        processes: [],
      },
    }),
    hostname: () => "blade",
    now: () => "2026-03-11T12:00:00.000Z",
    // POL-2044: pin the classifier platform to Linux so the restart-readopt
    // supervisor-proof gate is deterministic across test hosts (macOS dev
    // machines would otherwise fail closed on launchd). macOS is exercised
    // explicitly by overriding `platform` in the dedicated posture test.
    platform: () => "linux",
  };
}

/**
 * Run `body` while a live detached worker holds the run's execution mutex, so
 * the restart-readopt classifier observes ownership as taken (`!owned`) and
 * reaches the POL-2044 supervisor-proof gate. Mirrors the inline pattern the
 * app-server-binding tests use.
 */
async function withHeldExecutionMutex<T>(
  service: RunService,
  runId: string,
  body: () => Promise<T>,
): Promise<T> {
  let signalAcquired!: () => void;
  let releaseOwner!: () => void;
  const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
  const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
  const held = withSqliteMutex(service.store.paths(runId).executionMutexPath, async () => {
    signalAcquired();
    await release;
  });
  await acquired;
  try {
    return await body();
  } finally {
    releaseOwner();
    await held;
  }
}

/** Stage a live detached `agent_runner` run with the given launch evidence. */
async function stageLiveDetachedRun(
  service: RunService,
  runId: string,
  launchPayload: Record<string, unknown>,
): Promise<void> {
  const intent = service.createIntent({
    run_id: runId,
    host: "local",
    prompt: "Detached worker supervisor-proof fixture",
    require_execplan: false,
  });
  const queued = await service.initializeRun(intent, { launchMode: "detached" });
  await service.store.appendEvent(runId, {
    timestamp: "2026-03-11T12:00:00.000Z",
    run_id: runId,
    source: "run-service",
    event: "launch_dispatched",
    message: "Spawned detached run worker.",
    payload: launchPayload,
  });
  await service.store.writeRunRecord(runId, {
    ...queued,
    state: "running",
    launch: {
      ...queued.launch,
      stage: "executing",
      execution_id: `execution-${runId}`,
      execution_started_at: "2026-03-11T12:00:01.000Z",
    },
    updated_at: "2026-03-11T12:00:01.000Z",
  });
}

function buildReviewFindingsDeps(findings: Record<string, unknown>): Partial<RunServiceDependencies> {
  const adapter: BackendAdapter = {
    name: "mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    spawn: async (): Promise<AdapterResult> => ({
      exit_code: 0,
      stderr: "",
      events: [],
      duration_ms: 1,
    }),
    stop: async (): Promise<void> => {},
  };

  return {
    ...buildDeps(),
    resolveExecutionKernel: () => new AgentRunnerKernel({
      runtimeAdapterRegistry: {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
      },
      executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
        const spec = rawSpec as RunSpec;
        const runId = spec.run_id ?? "unknown";
        deps.onEvent?.({
          timestamp: new Date().toISOString(),
          run_id: runId,
          event: "state_transition",
          from: "queued",
          to: "running",
          message: "mock running",
        });
        const runDir = dirname(deps.receiptPath!);
        const findingsPath = join(runDir, "findings.json");
        await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
        const artifact: ArtifactEntry = {
          name: "findings.json",
          location: "run_dir",
          path: findingsPath,
          required: true,
          detected_at: "2026-03-11T12:00:00.000Z",
        };
        const receipt = makeReceipt(runId, spec, "succeeded", {
          artifacts: {
            run_id: runId,
            finalized_at: "2026-03-11T12:00:00.000Z",
            required: [artifact],
            discovered: [artifact],
            gate_passed: true,
            missing: [],
          },
        });
        if (deps.receiptPath) {
          await rm(deps.receiptPath, { force: true });
          await writeFile(deps.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        }
        return { receipt, events: [], dispatch_accepted: true };
      },
    }),
  };
}

function buildResumeAwareDeps(executedSpecs: RunSpec[]): Partial<RunServiceDependencies> {
  const adapter: BackendAdapter = {
    name: "mock",
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: true,
      forkSession: false,
      approvals: "none",
    },
    spawn: async (): Promise<AdapterResult> => ({
      exit_code: 0,
      stderr: "",
      events: [],
      duration_ms: 1,
    }),
    stop: async (): Promise<void> => {},
  };

  return {
    resolveExecutionKernel: () => new AgentRunnerKernel({
      runtimeAdapterRegistry: {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
      },
      executeRun: async (rawSpec: unknown): Promise<RunResult> => {
        const spec = rawSpec as RunSpec;
        executedSpecs.push(spec);
        return {
          receipt: makeReceipt(spec.run_id ?? "unknown", spec, "succeeded", {
            backend_session: {
              id: spec.resume_session_id ?? "session-new",
              path: `/tmp/${spec.resume_session_id ?? "session-new"}.jsonl`,
              backend: spec.backend,
            },
            environment: {
              host: spec.host,
              backend: spec.backend,
              ...(spec.worktree.path ? { worktree_path: spec.worktree.path } : {}),
            },
          }),
          events: [],
          dispatch_accepted: true,
        };
      },
    }),
    hostname: () => "blade",
    now: () => "2026-04-15T12:00:00.000Z",
  };
}

function makeStoredResumeRecord(args: {
  runId: string;
  sessionId: string;
  worktreePath?: string;
  updatedAt: string;
  resumeSessionId?: string;
  persistWorktreeInSpec?: boolean;
}): RunRecord {
  const backend = "codex";
  const intent: RunIntent = {
    run_id: args.runId,
    kernel: "agent_runner",
    host: "local",
    backend,
    prompt: "Stored prompt",
    require_execplan: false,
    pull_execplan: false,
    created_at: args.updatedAt,
    ...(args.resumeSessionId ? { resume_session_id: args.resumeSessionId } : {}),
  };
  const spec = {
    run_id: args.runId,
    kernel: "agent_runner" as const,
    host: "local",
    backend,
    prompt: "Stored prompt",
    worktree: args.persistWorktreeInSpec && args.worktreePath ? { path: args.worktreePath } : {},
    required_artifacts: [],
    resolved_at: args.updatedAt,
    resolution_log: [],
    ...(args.resumeSessionId ? { resume_session_id: args.resumeSessionId } : {}),
  };
  const receipt = makeReceipt(args.runId, {
    run_id: args.runId,
    host: "local",
    backend,
    prompt: "Stored prompt",
    require_execplan: false,
    pull_execplan: false,
    worktree: {},
    ...(args.resumeSessionId ? { resume_session_id: args.resumeSessionId } : {}),
  }, "succeeded", {
    backend_session: {
      id: args.sessionId,
      path: `/tmp/${args.sessionId}.jsonl`,
      backend,
    },
    environment: {
      host: "local",
      backend,
      ...(args.worktreePath ? { worktree_path: args.worktreePath } : {}),
    },
  });

  return {
    schema_version: "1.0",
    run_id: args.runId,
    state: "succeeded",
    intent,
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "test-admission",
      request_hash: "test-request",
      accepted_at: args.updatedAt,
      dispatch_attempts: 0,
    },
    spec,
    kernel_receipt: receipt,
    integrations: { results: [], all_critical_ok: true },
    recovery: {
      mode: "normal",
      resumable: true,
      checkpoint: {
        backend_session_id: args.sessionId,
        last_event_at: args.updatedAt,
        strategy: "native_session",
      },
    },
    summary: `Run ${args.runId} succeeded.`,
    created_at: args.updatedAt,
    updated_at: args.updatedAt,
    completed_at: args.updatedAt,
  };
}

async function writeCodexInteractiveSession(args: {
  home: string;
  sessionId: string;
  cwd?: string;
  prompt?: string;
  timestamp: string;
  fileStamp?: string;
  mtime?: Date;
}): Promise<string> {
  const codexDir = join(args.home, ".codex", "sessions", "2026", "04", "15");
  await mkdir(codexDir, { recursive: true });
  const fileStamp = args.fileStamp ?? args.timestamp.replace(/:/g, "-").replace(".000Z", "");
  const sessionPath = join(codexDir, `rollout-${fileStamp}-${args.sessionId}.jsonl`);
  await writeFile(
    sessionPath,
    [
      JSON.stringify({
        timestamp: args.timestamp,
        type: "session_meta",
        payload: {
          id: args.sessionId,
          timestamp: args.timestamp,
          ...(args.cwd ? { cwd: args.cwd } : {}),
        },
      }),
      JSON.stringify({
        timestamp: args.timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: args.prompt ?? "Resume interactive session" }],
        },
      }),
    ].join("\n"),
    "utf8",
  );
  if (args.mtime) {
    await utimes(sessionPath, args.mtime, args.mtime);
  }
  return sessionPath;
}

type StreamedRunEvent = CalyxStreamEvent;
type RecordedCalyxRunEvent = Extract<Awaited<ReturnType<RunService["store"]["readEvents"]>>[number], { event_type: string }>;

function isRecordedCalyxRunEvent(event: unknown): event is RecordedCalyxRunEvent {
  return isCalyxRunEvent(event);
}

async function collectIndexedEvents(service: RunService, runId?: string): Promise<StreamedRunEvent[]> {
  const events: StreamedRunEvent[] = [];
  for await (const event of service.store.readEventsSince(undefined, runId ? { run_id: runId } : {})) {
    events.push(event);
  }
  return events;
}

async function waitForFileContains(filePath: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.includes(needle)) {
        return text;
      }
    } catch {
      // Poll until the detached child has created and populated the log file.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain ${needle}`);
}

async function withTempStateHome<T>(fn: () => Promise<T>): Promise<T> {
  const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-state-"));
  const original: Record<string, string | undefined> = {
    CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
    CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
  };
  for (const key of STATE_ENV_KEYS) delete process.env[key];
  process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");
  try {
    return await fn();
  } finally {
    for (const key of STATE_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function withRunIndexProjection<T>(fn: (projection: RunIndexProjection) => Promise<T>): Promise<T> {
  return withTempStateHome(async () => {
    await applyStateMigrations();
    const projection = new RunIndexProjection();
    try {
      return await fn(projection);
    } finally {
      projection.close();
    }
  });
}

async function readRunHandbackReceipt(service: RunService, runId: string): Promise<Record<string, unknown>> {
  const paths = service.store.paths(runId);
  const entries = await readdir(paths.runDir);
  const receiptName = entries.find((entry) => entry.startsWith("handback-") && entry.endsWith(".json"));
  if (!receiptName) {
    throw new Error(`missing handback receipt for ${runId}`);
  }
  return JSON.parse(await readFile(join(paths.runDir, receiptName), "utf8")) as Record<string, unknown>;
}

async function stageProvisionalTerminalHandback(
  service: RunService,
  runId: string,
  options: { receiptBeforeProjection?: boolean } = {},
) {
  const intent = service.createIntent({
    run_id: runId,
    host: "local",
    backend: "codex",
    issue: "POL-2128",
    prompt: "Keep a provisional terminal projection inside the audit boundary",
    require_execplan: false,
    handback: {
      key: `${runId}-handback`,
      recipient_address: "interactive:codex:caller-session",
      thread_key: `${runId}-handback`,
      ack_required: true,
      body_contract: "locator-only terminal outcome",
    },
  });
  const queued = await service.initializeRun(intent, { launchMode: "inline" });
  const spec = await resolveRunIntent(intent, { now: () => queued.launch.accepted_at });
  const completedAt = new Date(
    new Date(queued.launch.accepted_at).getTime() + 2_000,
  ).toISOString();
  const receipt = makeReceipt(
    intent.run_id,
    {
      ...makeReceiptSpec(intent.run_id, intent, spec.backend),
      issue: intent.issue!,
      handback: intent.handback!,
    },
    "succeeded",
    {
      timing: { created_at: intent.created_at, completed_at: completedAt },
      summary: "Authoritative succeeded outcome.",
    },
  );
  const provisionalRecord: RunRecord = {
    ...queued,
    state: "infra_error",
    spec,
    summary: "Provisional finalization failure.",
    updated_at: queued.launch.accepted_at,
    completed_at: queued.launch.accepted_at,
  };
  await service.store.writeSpec(runId, spec);
  if (options.receiptBeforeProjection !== false) {
    await service.store.writeKernelReceipt(runId, receipt);
  }
  await service.store.writeRunRecord(runId, provisionalRecord);
  const terminalPublisher = service as unknown as {
    ensureTerminalEvent(
      record: RunRecord,
      emittedBy: RunTerminalEvent["emitted_by"],
      previousState?: RunRecord["state"],
    ): Promise<RunTerminalEvent | undefined>;
  };
  const initialEvent = await terminalPublisher.ensureTerminalEvent(
    provisionalRecord,
    "launch",
    queued.state,
  );
  if (!initialEvent) throw new Error(`missing provisional terminal event for ${runId}`);
  return { intent, queued, spec, receipt, provisionalRecord, initialEvent };
}

async function prepareLegacyEmbeddedReceiptRace(service: RunService, runId: string) {
  const intent = service.createIntent({
    run_id: runId,
    host: "local",
    prompt: "Preserve durable receipt authority across a reconcile race",
    require_execplan: false,
  });
  const queued = await service.initializeRun(intent, { launchMode: "detached" });
  const launchedAt = "2026-03-11T12:00:01.000Z";
  const completedAt = "2026-03-11T12:00:02.000Z";
  const embeddedReceipt = makeReceipt(
    runId,
    makeReceiptSpec(runId, intent, "codex"),
    "succeeded",
    {
      timing: { created_at: queued.created_at, completed_at: completedAt },
    },
  );
  await service.store.appendEvent(runId, {
    timestamp: launchedAt,
    run_id: runId,
    source: "run-service",
    event: "launch_dispatched",
    message: "Spawned detached run worker.",
    payload: { pid: 45_690, worker_supervisor: "direct" },
  });
  const paths = service.store.paths(runId);
  await writeFile(join(paths.runDir, "pid"), "45690\n", "utf8");
  const runningRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
    ...queued,
    state: "running",
    kernel_receipt: embeddedReceipt,
    updated_at: launchedAt,
  };
  delete runningRecord.launch;
  const terminalRecord = {
    ...runningRecord,
    state: "succeeded" as const,
    summary: `Run ${runId} succeeded.`,
    updated_at: completedAt,
    completed_at: completedAt,
  };
  await writeFile(paths.runRecordPath, `${JSON.stringify(runningRecord, null, 2)}\n`, "utf8");
  return { embeddedReceipt, paths, runningRecord, terminalRecord };
}

describe("RunService", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(runsRoot, { recursive: true, force: true });
  });

  test("foreground launch writes dual-layer artifacts and subscriber drafts", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      host: "local",
      issue: "POL-825",
      prompt: "Ship v5",
      require_execplan: false,
    });

    const result = await service.launch(intent, { detached: false });
    const paths = service.store.paths(intent.run_id);
    const recordText = await readFile(paths.runRecordPath, "utf8");
    const record = JSON.parse(recordText) as { state: string; recovery: { mode: string } };

    expect(result.mode).toBe("foreground");
    expect(record.state).toBe("succeeded");
    expect(record.recovery.mode).toBe("normal");
    await expect(readFile(paths.runRecordPath, "utf8")).resolves.toContain(`"run_id": "${intent.run_id}"`);
    await expect(readFile(paths.specPath, "utf8")).resolves.toContain(`"prompt": "Ship v5"`);
    await expect(readFile(paths.kernelReceiptPath, "utf8")).resolves.toContain(`"state": "succeeded"`);
    await expect(readFile(paths.integrationsPath, "utf8")).resolves.toContain("linear_comment_draft");
    await expect(readFile(join(paths.runDir, "linear-comment.md"), "utf8")).resolves.toContain("POL-825");
    await expect(readFile(join(paths.runDir, "vault-backlink.md"), "utf8")).resolves.toContain(intent.run_id);
  });

  test("does not publish a kernel terminal transition before its typed receipt", async () => {
    let terminalCallbackObserved!: () => void;
    const terminalCallback = new Promise<void>((resolve) => {
      terminalCallbackObserved = resolve;
    });
    let releaseReceiptWrite!: () => void;
    const receiptWriteReleased = new Promise<void>((resolve) => {
      releaseReceiptWrite = resolve;
    });
    const adapter: BackendAdapter = {
      name: "mock",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async () => ({ exit_code: 0, stderr: "", events: [], duration_ms: 1 }),
      stop: async () => {},
    };
    const service = new RunService({ runsRoot, subscribers: [] }, {
      ...buildDeps(),
      resolveExecutionKernel: () => new AgentRunnerKernel({
        runtimeAdapterRegistry: {
          register: () => {},
          create: () => adapter,
          has: () => true,
          list: () => ["mock"],
        },
        executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
          const spec = rawSpec as RunSpec;
          const runningEvent = {
            timestamp: new Date().toISOString(),
            run_id: spec.run_id!,
            event: "state_transition" as const,
            from: "dispatching" as const,
            to: "running" as const,
          };
          const terminalEvent = {
            timestamp: new Date().toISOString(),
            run_id: spec.run_id!,
            event: "state_transition" as const,
            from: "running" as const,
            to: "succeeded" as const,
          };
          deps.onEvent?.(runningEvent);
          deps.onEvent?.(terminalEvent);
          terminalCallbackObserved();
          await receiptWriteReleased;
          const receipt = makeReceipt(spec.run_id!, spec);
          await writeFile(deps.receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          return { receipt, events: [runningEvent, terminalEvent], dispatch_accepted: true };
        },
      }),
    });
    const intent = service.createIntent({
      run_id: "run-terminal-after-receipt",
      host: "local",
      prompt: "Order terminal authority",
      require_execplan: false,
    });

    const execution = service.executeStoredRun(
      (await service.initializeRun(intent, { launchMode: "inline" })).run_id,
    );
    await terminalCallback;
    let preReceiptRecord: RunRecord | undefined;
    let preReceiptReadError: unknown;
    let preReceiptTerminalEvents = -1;
    try {
      await vi.waitFor(async () => {
        expect((await service.getRunRecord(intent.run_id))?.state).toBe("running");
      });
      preReceiptRecord = await service.getRunRecord(intent.run_id);
      try {
        await readFile(service.store.paths(intent.run_id).kernelReceiptPath, "utf8");
      } catch (error) {
        preReceiptReadError = error;
      }
      preReceiptTerminalEvents = (await service.readEvents(intent.run_id)).filter((event) => (
        "event" in event
        && event.event === "state_transition"
        && event.to === "succeeded"
      )).length;
    } finally {
      releaseReceiptWrite();
    }

    await expect(execution).resolves.toMatchObject({ state: "succeeded" });
    expect(preReceiptRecord?.state).toBe("running");
    expect(preReceiptRecord?.kernel_receipt).toBeUndefined();
    expect(preReceiptReadError).toMatchObject({ code: "ENOENT" });
    expect(preReceiptTerminalEvents).toBe(0);
    expect((await service.readEvents(intent.run_id)).filter((event) => (
      "event" in event
      && event.event === "state_transition"
      && event.to === "succeeded"
    ))).toHaveLength(1);
    expect((await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent))
      .toHaveLength(1);
  });

  test("a kernel rejection after publishing its typed receipt preserves receipt authority", async () => {
    const adapter: BackendAdapter = {
      name: "mock",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async () => ({ exit_code: 0, stderr: "", events: [], duration_ms: 1 }),
      stop: async () => {},
    };
    const service = new RunService({
      runsRoot,
      subscribers: [],
      handback: { messageCorrespondence: false },
    }, {
      ...buildDeps(),
      resolveExecutionKernel: () => new AgentRunnerKernel({
        runtimeAdapterRegistry: {
          register: () => {},
          create: () => adapter,
          has: () => true,
          list: () => ["mock"],
        },
        executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
          const spec = rawSpec as RunSpec;
          const receipt = makeReceipt(spec.run_id!, spec, "succeeded");
          await writeFile(deps.receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          throw new Error("kernel cleanup rejected after receipt commit");
        },
      }),
    });
    const intent = service.createIntent({
      run_id: "run-kernel-reject-after-receipt",
      host: "local",
      prompt: "Recover disk-first authority",
      require_execplan: false,
      handback: {
        key: "kernel-reject-receipt-authority",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "kernel-reject-receipt-authority",
        ack_required: true,
        body_contract: "terminal state only",
      },
    });

    const result = await service.launch(intent, { detached: false });
    const persisted = await service.getRunRecord(intent.run_id);
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);

    expect(result.record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(persisted).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.run.state).toBe("succeeded");
    expect(handbackReceipt).toMatchObject({
      outcome: { state: "succeeded" },
      terminal_event: {
        event_id: terminalEvents[0]?.event_id,
        cursor: terminalEvents[0]?.cursor,
      },
    });
    expect((await service.readEvents(intent.run_id)).filter((event) => (
      "event" in event
      && event.event === "state_transition"
      && event.to === "infra_error"
    ))).toHaveLength(0);
  });

  test("preserves receipt-backed success when run_index projection fails after JSON commit", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const projection = new RunIndexProjection();
    const originalUpsert = projection.upsert.bind(projection);
    vi.spyOn(projection, "upsert").mockImplementation(async (row) => (
      row.state === "succeeded"
        ? { status: "disabled", reason: "simulated terminal projection failure" }
        : originalUpsert(row)
    ));
    const service = new RunService({ runsRoot, subscribers: [], runIndex: projection }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-projection-stale",
      host: "local",
      prompt: "Keep receipt authority",
      require_execplan: false,
    });

    const launched = await service.launch(intent, { detached: false });

    expect(launched.record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect((await service.readEvents(intent.run_id)).filter((event) => (
      "event" in event
      && event.event === "state_transition"
      && event.to === "infra_error"
    ))).toHaveLength(0);
    expect((await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent))
      .toHaveLength(1);
    expect((await service.store.listRuns()).find((entry) => entry.run_id === intent.run_id))
      .toMatchObject({ state: "succeeded" });
    projection.close();
  }));

  test("HTTP launch persists immutable creation provenance and ordered capability observations", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-provenance-launch",
      host: "local",
      prompt: "Attribute this launch",
      require_execplan: false,
    });
    const provenance = apiProvenance();

    const result = await service.launch(intent, { detached: false, provenance });
    const persisted = await service.getRunRecord(intent.run_id);
    const events = (await service.readEvents(intent.run_id)).filter(isRunServiceEvent);

    expect(result.record.creation_provenance).toEqual(provenance);
    expect(persisted?.creation_provenance).toEqual(provenance);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "launch_intent",
      "intent_persisted",
      "launch_result",
    ]));
    expect(events.findIndex((event) => event.event === "intent_persisted"))
      .toBeLessThan(events.findIndex((event) => event.event === "launch_intent"));
    expect(events.findIndex((event) => event.event === "launch_intent"))
      .toBeLessThan(events.findIndex((event) => event.event === "launch_result"));
    expect(events.find((event) => event.event === "launch_result")).toMatchObject({
      provenance,
      payload: { correlation_id: provenance.request_id, outcome: "completed" },
    });

    await expect(service.store.writeRunRecord(intent.run_id, {
      ...persisted!,
      creation_provenance: apiProvenance("req_00000000-0000-4000-8000-000000000002"),
    })).rejects.toThrow("creation_provenance is immutable");

    const freshStore = new RunStore(runsRoot);
    await expect(freshStore.writeRunRecord(intent.run_id, {
      ...persisted!,
      creation_provenance: apiProvenance("req_00000000-0000-4000-8000-000000000002"),
    })).rejects.toThrow("creation_provenance is immutable");

    const withoutCreationProvenance = { ...persisted! };
    delete withoutCreationProvenance.creation_provenance;
    const secondFreshStore = new RunStore(runsRoot);
    await expect(secondFreshStore.writeRunRecord(
      intent.run_id,
      withoutCreationProvenance,
    )).rejects.toThrow("creation_provenance is immutable");
  });

  test("ordinary record updates cannot mutate an extant claim incarnation", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-immutable-incarnation",
      host: "local",
      prompt: "Preserve the fresh-claim identity",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    const mutated = {
      ...queued,
      launch: {
        ...queued.launch,
        incarnation_id: "00000000-0000-4000-8000-000000000002",
      },
    };

    await expect(service.store.writeRunRecord(intent.run_id, mutated))
      .rejects.toThrow("launch.incarnation_id is immutable for an extant claim");
    await expect(new RunStore(runsRoot).writeRunRecord(intent.run_id, mutated))
      .rejects.toThrow("launch.incarnation_id is immutable for an extant claim");
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      launch: { incarnation_id: queued.launch.incarnation_id },
    });
  });

  test("exact replay repairs partial launch-admission observations before execution", async () => {
    for (const failedAppend of [1, 2]) {
      const caseRoot = join(runsRoot, `admission-repair-${failedAppend}`);
      const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
      const service = new RunService({ runsRoot: caseRoot }, {
        ...buildDeps(),
        resolveExecutionKernel,
      });
      const intent = service.createIntent({
        run_id: `run-admission-repair-${failedAppend}`,
        host: "local",
        prompt: "Repair my admission observations",
        require_execplan: false,
      });
      const provenance = apiProvenance(
        `req_00000000-0000-4000-8000-00000000003${failedAppend}`,
      );
      const originalAppend = service.store.appendDurableEvent.bind(service.store);
      let calls = 0;
      const append = vi.spyOn(service.store, "appendDurableEvent").mockImplementation(
        async (runId, event) => {
          calls += 1;
          if (calls === failedAppend) throw new Error("simulated admission event failure");
          await originalAppend(runId, event);
        },
      );

      await expect(service.runInline(intent, { provenance })).rejects.toThrow(
        "simulated admission event failure",
      );
      expect(resolveExecutionKernel).not.toHaveBeenCalled();
      append.mockRestore();

      const replay = await service.runInline(intent, { provenance });
      expect(replay.record.state).toBe("succeeded");
      expect(resolveExecutionKernel).toHaveBeenCalledTimes(1);
      const events = (await service.readEvents(intent.run_id)).filter(isRunServiceEvent);
      expect(events.filter((event) => event.event === "intent_persisted")).toHaveLength(1);
      expect(events.filter((event) => event.event === "launch_intent")).toHaveLength(1);
      expect(events.find((event) => event.event === "launch_intent")).toMatchObject({
        provenance,
        payload: {
          correlation_id: provenance.request_id,
          mode: "inline",
        },
      });
    }
  });

  test("independent services cannot dispatch the same run id twice", async () => {
    const workerExecutions: Array<Promise<RunRecord>> = [];
    const spawnWorker = vi.fn(async (args: { runId: string }) => {
      const worker = new RunService({ runsRoot }, buildDeps());
      workerExecutions.push(worker.executeStoredRun(args.runId));
      return { pid: 42_424, supervisor: "direct" as const };
    });
    const serviceA = new RunService({ runsRoot, workerEntrypoint: "/tmp/calyx-worker" }, {
      ...buildDeps(),
      spawnWorker,
    });
    const serviceB = new RunService({ runsRoot, workerEntrypoint: "/tmp/calyx-worker" }, {
      ...buildDeps(),
      spawnWorker,
    });
    const intents = [
      serviceA.createIntent({
        run_id: "run-single-dispatch-cas",
        host: "local",
        prompt: "creator A",
        require_execplan: false,
      }),
      serviceB.createIntent({
        run_id: "run-single-dispatch-cas",
        host: "local",
        prompt: "creator B",
        require_execplan: false,
      }),
    ];
    const provenances = [
      apiProvenance("req_00000000-0000-4000-8000-000000000021"),
      apiProvenance("req_00000000-0000-4000-8000-000000000022"),
    ];

    const outcomes = await Promise.allSettled([
      serviceA.launch(intents[0]!, { provenance: provenances[0] }),
      serviceB.launch(intents[1]!, { provenance: provenances[1] }),
    ]);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(loser).toMatchObject({ reason: expect.any(RunAlreadyExistsError) });
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    const persisted = await serviceA.getRunRecord("run-single-dispatch-cas");
    expect(persisted).toMatchObject({
      intent: {
        ...intents[winnerIndex],
        created_at: persisted?.kernel_receipt?.timing.created_at
          ?? intents[winnerIndex]?.created_at,
      },
      creation_provenance: provenances[winnerIndex],
    });
    const events = await serviceA.store.readEvents("run-single-dispatch-cas");
    expect(events.filter(isRunServiceEvent).filter((event) => event.event === "launch_dispatched")).toHaveLength(1);
    await Promise.all(workerExecutions);
  });

  test("a failed authoritative create is retryable without inventing side-file authority", async () => {
    await withTempStateHome(async () => {
      const service = new RunService({ runsRoot }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-provenance-ghost",
        host: "local",
        prompt: "Retry this launch",
        require_execplan: false,
      });
      const first = apiProvenance("req_00000000-0000-4000-8000-000000000003");
      const second = apiProvenance("req_00000000-0000-4000-8000-000000000004");
      const createRun = vi.spyOn(service.store, "createRun").mockRejectedValueOnce(new Error("record write failed"));

      await expect(service.launch(intent, { detached: false, provenance: first }))
        .rejects.toThrow("record write failed");
      createRun.mockRestore();
      await expect(service.store.listRunIds()).resolves.not.toContain(intent.run_id);
      await expect(service.getRunRecord(intent.run_id)).resolves.toBeUndefined();

      const retried = await service.launch(intent, { detached: false, provenance: second });
      expect(retried.record.creation_provenance).toEqual(second);

      await rm(service.store.paths(intent.run_id).runRecordPath, { force: true });
      await service.reconcile({
        provenance: apiProvenance("req_00000000-0000-4000-8000-000000000005"),
      });
      await expect(service.getRunRecord(intent.run_id)).resolves.toBeUndefined();

      const persistedCreatorEvents = (await service.readEvents(intent.run_id))
        .filter(isRunServiceEvent)
        .filter((event) => event.event === "intent_persisted");
      expect(persistedCreatorEvents).toHaveLength(1);
      expect(persistedCreatorEvents[0]?.provenance).toEqual(second);
    });
  });

  test("persists handback binding and emits terminal success msg", async () => withTempStateHome(async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "handback-success",
      host: "local",
      backend: "codex",
      prompt: "Emit a handback",
      require_execplan: false,
      handback: {
        key: "review:standard:polli-labs-calyx-dev:pr-223",
        recipient_address: "interactive:codex:caller-session",
        recipient_host: "blade",
        thread_key: "review:standard:polli-labs-calyx-dev:pr-223",
        ack_required: true,
        body_contract: "status axes + verdict + counts + locators only",
        subject: "review handback",
      },
    });

    const result = await service.launch(intent, { detached: false });
    expect(result.record.state).toBe("succeeded");
    await expect(readFile(service.store.paths(intent.run_id).runRecordPath, "utf8")).resolves.toContain("\"handback\"");
    await expect(readFile(service.store.paths(intent.run_id).specPath, "utf8")).resolves.toContain("\"handback\"");

    const opened = await openStateStore();
    try {
      const messages = listMessages(opened.db, {
        recipient_address: "interactive:codex:caller-session",
        status: "all",
        include_expired: true,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        sender: "run:handback-success",
        subject: "review handback",
        thread_key: "review:standard:polli-labs-calyx-dev:pr-223",
        idempotency_key: "handback:handback-success:review:standard:polli-labs-calyx-dev:pr-223",
        ack_required: true,
        status: "pending",
      });
      expect(messages[0]?.body).toContain("state: succeeded");
      expect(messages[0]?.body).toContain("review_artifact_status: artifact_missing");
      expect(messages[0]?.body).toContain("review_status: artifact_missing");
      expect(messages[0]?.body).toContain("delivery_status: degraded");
      expect(messages[0]?.body).toContain("verdict: null");
      expect(messages[0]?.body).toContain("counts: total=0 P0=0 P1=0 P2=0 P3=0");
      expect(messages[0]?.body).toContain("run_record_path");
    } finally {
      opened.db.close();
    }

    const receipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(receipt).toMatchObject({
      schema_version: "calyx.run-handback/v1",
      run_id: "handback-success",
      status: "sent",
      flow: "calyx.msg/v1",
      dedupe_key: "handback:handback-success:review:standard:polli-labs-calyx-dev:pr-223",
      outcome: { state: "succeeded" },
      review_summary: {
        status: "artifact_missing",
        review_status: "artifact_missing",
        coverage_status: "unknown",
        delivery_status: "degraded",
        verdict: null,
        counts: { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 },
      },
      message: { inserted: true },
    });
  }));

  test("managed runtime worktree locators do not replace receipt command authority", async () =>
    withTempStateHome(async () => {
      for (const backend of ["claude", "codex"] as const) {
        const runtimeWorktree = join(runsRoot, `managed-runtime-${backend}`);
        const service = new RunService(
          { runsRoot, subscribers: [] },
          buildDeps("succeeded", {
            environment: {
              host: "local",
              backend,
              worktree_path: runtimeWorktree,
            },
          }),
        );
        const intent = service.createIntent({
          run_id: `managed-runtime-authority-${backend}`,
          host: "local",
          backend,
          prompt: "Keep managed worktree command and runtime authority separate",
          repo: "calyx",
          worktree_mode: "managed",
          branch: `managed-runtime-authority-${backend}`,
          require_execplan: false,
          handback: {
            key: `managed-runtime-authority-${backend}`,
            recipient_address: "interactive:codex:caller-session",
            thread_key: `managed-runtime-authority-${backend}`,
            ack_required: true,
            body_contract: "locator-only terminal outcome",
          },
        });

        const launched = await service.launch(intent, { detached: false });
        const stable = await service.reconcile();

        expect(launched.record).toMatchObject({
          state: "succeeded",
          spec: { worktree: { mode: "managed" } },
          kernel_receipt: {
            state: "succeeded",
            run_spec: { worktree: { mode: "managed" } },
            environment: { worktree_path: runtimeWorktree },
          },
        });
        expect(launched.record.spec && "worktree" in launched.record.spec
          ? launched.record.spec.worktree.path
          : undefined).toBeUndefined();
        const storedSpec = await service.store.readSpec(intent.run_id);
        expect((storedSpec as ResolvedRunSpec | undefined)?.worktree.path).toBeUndefined();
        expect(launched.record.kernel_receipt && "run_spec" in launched.record.kernel_receipt
          ? launched.record.kernel_receipt.run_spec.worktree.path
          : undefined).toBeUndefined();
        expect(stable.skipped).toContain(intent.run_id);
        expect(stable.classified).not.toContain(intent.run_id);
      }

      const opened = await openStateStore();
      try {
        const messages = listMessages(opened.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(2);
        expect(messages.every((message) => message.body.includes("state: succeeded"))).toBe(true);
        expect(messages.some((message) => message.body.includes("managed-runtime-claude"))).toBe(true);
        expect(messages.some((message) => message.body.includes("managed-runtime-codex"))).toBe(true);
      } finally {
        opened.db.close();
      }
    }));

  test("canonicalizes managed worktree paths on both receipt correspondence sides", async () => {
    const explicitWorktree = join(runsRoot, "managed-explicit-path");
    const service = new RunService(
      { runsRoot, subscribers: [] },
      buildDeps("infra_error", {
        environment: {
          host: "local",
          backend: "codex",
          worktree_path: explicitWorktree,
        },
        summary: "Managed worktree mode rejected an explicit path.",
      }),
    );
    const intent = service.createIntent({
      run_id: "managed-explicit-path-receipt-authority",
      host: "local",
      backend: "codex",
      prompt: "Preserve the actionable acquisition receipt",
      repo: "calyx",
      worktree_mode: "managed",
      worktree_path: explicitWorktree,
      branch: "calyx-run/managed-explicit-path-receipt-authority",
      require_execplan: false,
    });

    const launched = await service.launch(intent, { detached: false });

    expect(launched.record).toMatchObject({
      state: "infra_error",
      spec: { worktree: { mode: "managed", path: explicitWorktree } },
      kernel_receipt: {
        state: "infra_error",
        summary: "Managed worktree mode rejected an explicit path.",
        run_spec: { worktree: { mode: "managed", path: explicitWorktree } },
        environment: { worktree_path: explicitWorktree },
      },
    });
  });

  test("emits review terminal handback summary from findings json", async () => withTempStateHome(async () => {
    const service = new RunService({ runsRoot }, buildReviewFindingsDeps({
      schema_version: "review-findings/v1",
      agent_ref: "codex:reviewer",
      run: "run:handback-review-summary",
      target: { scope: "pr", repo: "polli-labs/calyx-dev", pr: 228 },
      round: 2,
      review_status: "complete",
      coverage_status: "full",
      delivery_status: "delivered",
      verdict: "mergeable",
      counts: { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 },
      findings: [],
    }));
    const intent = service.createIntent({
      run_id: "handback-review-summary",
      host: "local",
      backend: "codex",
      prompt: "Emit a structured review handback",
      require_execplan: false,
      required_artifacts: ["findings.json"],
      metadata: {
        review_conduct: {
          command: "review",
          target: { scope: "pr", repo: "polli-labs/calyx-dev", pr: 228 },
        },
      },
      handback: {
        key: "review:standard:polli-labs-calyx-dev:pr-228",
        recipient_address: "interactive:codex:caller-session",
        recipient_host: "blade",
        thread_key: "review:standard:polli-labs-calyx-dev:pr-228",
        ack_required: true,
        body_contract: "status axes + verdict + counts + locators only",
        subject: "review handback",
      },
    });

    const result = await service.launch(intent, { detached: false });
    expect(result.record.state).toBe("succeeded");

    const opened = await openStateStore();
    try {
      const messages = listMessages(opened.db, {
        recipient_address: "interactive:codex:caller-session",
        status: "all",
        include_expired: true,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body).toContain("review_artifact_status: available");
      expect(messages[0]?.body).toContain("review_status: complete");
      expect(messages[0]?.body).toContain("coverage_status: full");
      expect(messages[0]?.body).toContain("delivery_status: delivered");
      expect(messages[0]?.body).toContain("verdict: mergeable");
      expect(messages[0]?.body).toContain("counts: total=0 P0=0 P1=0 P2=0 P3=0");
      expect(messages[0]?.body).toContain("round: 2");
      expect(messages[0]?.body).toContain("findings_json_path:");
      expect(messages[0]?.body).not.toContain("findings: []");
    } finally {
      opened.db.close();
    }

    const receipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(receipt).toMatchObject({
      review_summary: {
        status: "available",
        review_status: "complete",
        coverage_status: "full",
        delivery_status: "delivered",
        verdict: "mergeable",
        counts: { total: 0, P0: 0, P1: 0, P2: 0, P3: 0 },
        round: 2,
      },
    });
  }));

  test("emits terminal failure handback msg", async () => withTempStateHome(async () => {
    const service = new RunService({ runsRoot }, buildDeps("failed"));
    const intent = service.createIntent({
      run_id: "handback-failure",
      host: "local",
      backend: "codex",
      prompt: "Fail with a handback",
      require_execplan: false,
      handback: {
        key: "failure-thread",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "failure-thread",
        ack_required: true,
        body_contract: "locator-only terminal outcome",
      },
    });

    const result = await service.launch(intent, { detached: false });
    expect(result.record.state).toBe("failed");

    const opened = await openStateStore();
    try {
      const messages = listMessages(opened.db, { status: "all", include_expired: true });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        sender: "run:handback-failure",
        recipient_address: "interactive:codex:caller-session",
        idempotency_key: "handback:handback-failure:failure-thread",
      });
      expect(messages[0]?.body).toContain("state: failed");
    } finally {
      opened.db.close();
    }
  }));

  test("degrades terminal handback to receipt-only when message correspondence is unavailable", async () => {
    const service = new RunService({ runsRoot, handback: { messageCorrespondence: false } }, buildDeps());
    const intent = service.createIntent({
      run_id: "handback-degrade",
      host: "local",
      backend: "codex",
      prompt: "Receipt-only handback",
      require_execplan: false,
      handback: {
        key: "degrade-thread",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "degrade-thread",
        ack_required: true,
        body_contract: "locator-only terminal outcome",
      },
    });

    const result = await service.launch(intent, { detached: false });
    expect(result.record.state).toBe("succeeded");
    const receipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(receipt).toMatchObject({
      schema_version: "calyx.run-handback/v1",
      run_id: "handback-degrade",
      flow: "receipt-only/v1",
      status: "receipt_only",
      reason: "message_correspondence_disabled",
      outcome: { state: "succeeded" },
    });
  });

  test("reconcile replaces a torn handback receipt even when the terminal event is already complete", async () => {
    const service = new RunService({
      runsRoot,
      subscribers: [],
      handback: { messageCorrespondence: false },
    }, buildDeps());
    const intent = service.createIntent({
      run_id: "handback-torn-reconcile",
      host: "local",
      backend: "codex",
      prompt: "Repair a torn handback",
      require_execplan: false,
      handback: {
        key: "torn-thread",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "torn-thread",
        ack_required: true,
        body_contract: "locator-only terminal outcome",
      },
    });
    await service.launch(intent, { detached: false });
    const entries = await readdir(service.store.paths(intent.run_id).runDir);
    const receiptName = entries.find((entry) => entry.startsWith("handback-") && entry.endsWith(".json"));
    expect(receiptName).toBeDefined();
    const receiptPath = join(service.store.paths(intent.run_id).runDir, receiptName!);
    await writeFile(receiptPath, "{\"schema_version\":", "utf8");

    const reconciled = await service.reconcile();
    const repaired = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent);

    expect(reconciled.skipped).toContain(intent.run_id);
    expect(repaired).toMatchObject({
      schema_version: "calyx.run-handback/v1",
      run_id: intent.run_id,
      handback_key: "torn-thread",
      outcome: { state: "succeeded" },
    });
    expect(terminalEvents).toHaveLength(1);
  });

  test("reconcile repairs a pending terminal-handback message receipt without duplicating correspondence", async () =>
    withTempStateHome(async () => {
      const stateHome = process.env["CALYX_STATE_HOME"]!;
      const messageReceiptPath = join(stateHome, "receipts", "messages.jsonl");
      await mkdir(messageReceiptPath, { recursive: true });
      const service = new RunService({ runsRoot }, buildDeps());
      const intent = service.createIntent({
        run_id: "handback-pending-message-receipt",
        host: "local",
        backend: "codex",
        prompt: "Repair the correspondence receipt",
        require_execplan: false,
        handback: {
          key: "pending-message-receipt-thread",
          recipient_address: "interactive:codex:caller-session",
          thread_key: "pending-message-receipt-thread",
          ack_required: true,
          body_contract: "locator-only terminal outcome",
        },
      });

      await service.launch(intent, { detached: false });
      const pendingReceipt = await readRunHandbackReceipt(service, intent.run_id);
      expect(pendingReceipt).toMatchObject({
        flow: "calyx.msg/v1",
        status: "sent",
        reason: expect.stringContaining("message_receipt_pending"),
        message: { inserted: true },
      });
      expect((pendingReceipt["message"] as Record<string, unknown>)["receipt_path"]).toBeUndefined();

      let opened = await openStateStore();
      let messageId = "";
      try {
        const messages = listMessages(opened.db, { status: "all", include_expired: true });
        expect(messages).toHaveLength(1);
        messageId = messages[0]!.message_id;
        expect(readMessageReceiptMirror(opened.db, messageId)).toMatchObject({ status: "pending" });
      } finally {
        opened.db.close();
      }

      await rm(messageReceiptPath, { recursive: true, force: true });
      await service.reconcile();

      const repairedReceipt = await readRunHandbackReceipt(service, intent.run_id);
      expect(repairedReceipt).toMatchObject({
        flow: "calyx.msg/v1",
        status: "duplicate",
        message: {
          message_id: messageId,
          inserted: false,
          receipt_path: messageReceiptPath,
        },
      });
      expect(repairedReceipt).not.toHaveProperty("reason");
      await expect(readFile(messageReceiptPath, "utf8")).resolves.toContain(messageId);

      opened = await openStateStore();
      try {
        expect(listMessages(opened.db, { status: "all", include_expired: true })).toHaveLength(1);
        expect(readMessageReceiptMirror(opened.db, messageId)).toMatchObject({
          status: "completed",
          receipt_path: messageReceiptPath,
        });
      } finally {
        opened.db.close();
      }
    }));

  test("dedupes terminal handback against a remote voluntary agent msg send", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const voluntary = createMessage(opened.db, {
        sender: "run:handback-idempotent",
        recipient_address: "interactive:codex:caller-session",
        recipient_class: "directed",
        recipient_host: "blade",
        subject: "review handback",
        body: "agent sent this first",
        thread_key: "idem-thread",
        idempotency_key: "handback:handback-idempotent:idem-thread",
        ack_required: true,
        status: "outbox",
        now: "2026-03-11T11:59:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: voluntary.message.message_id,
        target_host: "blade",
        now: "2026-03-11T11:59:00.000Z",
        payload: { recipient_address: "interactive:codex:caller-session" },
      });
    } finally {
      opened.db.close();
    }

    const service = new RunService({ runsRoot }, { ...buildDeps(), hostname: () => "carbon" });
    const intent = service.createIntent({
      run_id: "handback-idempotent",
      host: "local",
      backend: "codex",
      prompt: "Do not double hand back",
      require_execplan: false,
      handback: {
        key: "idem-thread",
        recipient_address: "interactive:codex:caller-session",
        recipient_host: "blade",
        thread_key: "idem-thread",
        ack_required: true,
        body_contract: "locator-only terminal outcome",
      },
    });

    await service.launch(intent, { detached: false });
    const after = await openStateStore();
    try {
      const messages = listMessages(after.db, {
        recipient_address: "interactive:codex:caller-session",
        status: "all",
        include_expired: true,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body).toBe("agent sent this first");
      expect(messages[0]).toMatchObject({ recipient_host: "blade", status: "outbox" });
      expect(listPendingMessageOutbox(after.db, { now: "2026-03-11T12:00:00.000Z" })).toMatchObject([
        { message_id: messages[0]?.message_id, target_host: "blade", status: "pending" },
      ]);
    } finally {
      after.db.close();
    }
    const receipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(receipt).toMatchObject({
      status: "duplicate",
      message: { inserted: false },
      dedupe_key: "handback:handback-idempotent:idem-thread",
    });
  }));

  test("reconcile repairs missing remote terminal handback outbox for a matching duplicate", async () => withTempStateHome(async () => {
    const runId = "handback-replay-outbox";
    const threadKey = "replay-thread";
    const dedupeKey = `handback:${runId}:${threadKey}`;
    await applyStateMigrations();
    const opened = await openStateStore();
    let messageId = "";
    try {
      const inserted = createMessage(opened.db, {
        sender: `run:${runId}`,
        recipient_address: "interactive:codex:caller-session",
        recipient_class: "directed",
        recipient_host: "blade",
        subject: "review handback",
        body: "system inserted this before crashing",
        thread_key: threadKey,
        idempotency_key: dedupeKey,
        ack_required: true,
        status: "outbox",
        now: "2026-03-11T11:59:00.000Z",
      });
      messageId = inserted.message.message_id;
      expect(listPendingMessageOutbox(opened.db, { now: "2026-03-11T12:00:00.000Z" })).toHaveLength(0);
    } finally {
      opened.db.close();
    }

    const service = new RunService({ runsRoot }, { ...buildDeps(), hostname: () => "carbon" });
    const handback = {
      key: threadKey,
      recipient_address: "interactive:codex:caller-session",
      recipient_host: "blade",
      thread_key: threadKey,
      ack_required: true,
      body_contract: "locator-only terminal outcome",
      subject: "review handback",
    };
    const intent = service.createIntent({
      run_id: runId,
      host: "local",
      backend: "codex",
      prompt: "Replay a terminal handback after a crash",
      require_execplan: false,
      handback,
    });
    await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const receiptSpec: RunSpec = {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
      handback,
    };
    const receipt = makeReceipt(intent.run_id, receiptSpec);
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    const queued = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued!,
      state: "succeeded",
      spec,
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: receipt.timing.completed_at,
      completed_at: receipt.timing.completed_at,
    });

    const reconcile = await service.reconcile();
    expect(reconcile.rebuilt).toContain(intent.run_id);

    const after = await openStateStore();
    try {
      const messages = listMessages(after.db, {
        recipient_address: "interactive:codex:caller-session",
        status: "all",
        include_expired: true,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        message_id: messageId,
        sender: `run:${runId}`,
        recipient_host: "blade",
        status: "outbox",
        idempotency_key: dedupeKey,
      });
      expect(listPendingMessageOutbox(after.db, { now: "2026-03-11T12:00:00.000Z" })).toMatchObject([
        { message_id: messageId, target_host: "blade", status: "pending" },
      ]);
    } finally {
      after.db.close();
    }
    const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(handbackReceipt).toMatchObject({
      status: "duplicate",
      dedupe_key: dedupeKey,
      message: {
        message_id: messageId,
        inserted: false,
        outbox_id: expect.any(String),
      },
    });
  }));

  test("emits intended caller-host handback when a wrong-host voluntary duplicate exists", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    let wrongHostMessageId = "";
    try {
      const wrongHost = createMessage(opened.db, {
        sender: "run:handback-wrong-host",
        recipient_address: "interactive:codex:caller-session",
        recipient_class: "directed",
        recipient_host: "carbon",
        subject: "review handback",
        body: "agent accidentally sent this to the local reviewer host",
        thread_key: "wrong-host-thread",
        idempotency_key: "handback:handback-wrong-host:wrong-host-thread",
        ack_required: true,
        status: "pending",
        now: "2026-03-11T11:59:00.000Z",
      });
      wrongHostMessageId = wrongHost.message.message_id;
    } finally {
      opened.db.close();
    }

    const service = new RunService({ runsRoot }, { ...buildDeps(), hostname: () => "carbon" });
    const intent = service.createIntent({
      run_id: "handback-wrong-host",
      host: "local",
      backend: "codex",
      prompt: "Do not let the wrong-host duplicate suppress the caller handback",
      require_execplan: false,
      handback: {
        key: "wrong-host-thread",
        recipient_address: "interactive:codex:caller-session",
        recipient_host: "blade",
        thread_key: "wrong-host-thread",
        ack_required: true,
        body_contract: "locator-only terminal outcome",
      },
    });

    await service.launch(intent, { detached: false });
    const after = await openStateStore();
    try {
      const messages = listMessages(after.db, {
        recipient_address: "interactive:codex:caller-session",
        status: "all",
        include_expired: true,
      });
      expect(messages).toHaveLength(2);
      expect(messages.find((message) => message.message_id === wrongHostMessageId)).toMatchObject({
        recipient_host: "carbon",
        body: "agent accidentally sent this to the local reviewer host",
      });
      const intended = messages.find((message) => message.recipient_host === "blade");
      expect(intended).toMatchObject({
        recipient_host: "blade",
        status: "outbox",
        idempotency_key: expect.stringContaining(":terminal:"),
      });
      expect(intended?.body).toContain("Calyx run terminal handback.");
      expect(listPendingMessageOutbox(after.db, { now: "2026-03-11T12:00:00.000Z" })).toMatchObject([
        { message_id: intended?.message_id, target_host: "blade", status: "pending" },
      ]);
    } finally {
      after.db.close();
    }
    const receipt = await readRunHandbackReceipt(service, intent.run_id);
    expect(receipt).toMatchObject({
      status: "sent",
      dedupe_key: "handback:handback-wrong-host:wrong-host-thread",
      message: {
        inserted: true,
        idempotency_key: expect.stringContaining(":terminal:"),
        duplicate_mismatch: {
          message_id: wrongHostMessageId,
          recipient_address: "interactive:codex:caller-session",
          recipient_host: "carbon",
          idempotency_key: "handback:handback-wrong-host:wrong-host-thread",
        },
      },
    });
  }));

  test("foreground launch discovers required artifacts from the run directory", async () => {
    const adapter: BackendAdapter = {
      name: "mock",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async (): Promise<AdapterResult> => ({
        exit_code: 0,
        stderr: "",
        events: [],
        duration_ms: 1,
      }),
      stop: async (): Promise<void> => {},
    };
    const deps: Partial<RunServiceDependencies> = {
      ...buildDeps(),
      resolveExecutionKernel: () => new AgentRunnerKernel({
        runtimeAdapterRegistry: {
          register: () => {},
          create: () => adapter,
          has: () => true,
          list: () => ["mock"],
        },
        executeRun: async (rawSpec: unknown, runDeps: RunDeps): Promise<RunResult> => {
          const spec = rawSpec as RunSpec;
          const runId = spec.run_id ?? "unknown";
          if (runDeps.receiptPath) {
            await writeFile(join(dirname(runDeps.receiptPath), "findings.md"), "review findings\n", "utf8");
          }
          const discovered = runDeps.discoverArtifacts
            ? await runDeps.discoverArtifacts(process.cwd(), runId)
            : [];
          const artifacts = evaluateArtifactGate(runId, spec.required_artifacts ?? [], discovered);
          const receipt = makeReceipt(runId, spec, "succeeded", { artifacts });
          if (runDeps.receiptPath) {
            await writeFile(runDeps.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
          }
          return { receipt, events: [], dispatch_accepted: true };
        },
      }),
    };
    const service = new RunService({ runsRoot }, deps);
    const intent = service.createIntent({
      host: "local",
      prompt: "Review with run artifacts",
      require_execplan: false,
      required_artifacts: ["findings.md"],
    });

    const result = await service.launch(intent, { detached: false });
    const receipt = result.record.kernel_receipt;
    if (!receipt || "kernel" in receipt) {
      throw new Error("expected agent_runner receipt");
    }

    expect(receipt.artifacts.discovered).toEqual([
      expect.objectContaining({
        name: "findings.md",
        location: "run_dir",
        required: true,
      }),
    ]);
    expect(receipt.artifacts.gate_passed).toBe(true);
  });

  test("persists a typed terminal capture from RunIntent through RunRecord and exact artifact bytes", async () => {
    const sourceDir = join(runsRoot, "typed-output-source");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "SOURCE.txt"), "immutable source\n", "utf8");
    const sourceBefore = await readFile(join(sourceDir, "SOURCE.txt"));
    const canonical = '{"answer":42,"status":"ok"}';
    const outputCapture = {
      name: "proposal-bundle.json",
      source: "agent_terminal_message" as const,
      media_type: "application/json" as const,
      schema: {
        type: "object",
        required: ["answer", "status"],
        properties: {
          answer: { type: "integer" },
          status: { const: "ok" },
        },
        additionalProperties: false,
      },
      max_bytes: 4096,
      required: true as const,
    };
    const adapter: BackendAdapter = {
      name: "codex",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async (options): Promise<AdapterResult> => {
        expect(options.output_capture).toEqual(outputCapture);
        if (options.run_id === "persisted-typed-output-rejected") {
          return {
            exit_code: 0,
            stderr: "",
            events: [],
            duration_ms: 1,
            agent_terminal_message: '{"status":"bad","raw":"REJECTED_RAW_SENTINEL"}',
          };
        }
        return {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 1,
          agent_terminal_message: ' { "status": "ok", "answer": 42 }\n',
        };
      },
      stop: async (): Promise<void> => {},
    };
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new AgentRunnerKernel({
          runtimeAdapterRegistry: {
            register: () => {},
            create: () => adapter,
            has: () => true,
            list: () => ["codex"],
          },
          executeRun,
        }),
        hostname: () => "blade",
      },
    );
    const intent = service.createIntent({
      run_id: "persisted-typed-output-capture",
      host: "local",
      backend: "codex",
      prompt: "Return the typed proposal bundle.",
      require_execplan: false,
      worktree_mode: "existing",
      worktree_path: sourceDir,
      output_capture: outputCapture,
      backend_options: { sandbox: "read-only" },
    });

    const launched = await service.launch(intent, { detached: false });
    const persisted = await service.getRunRecord(intent.run_id);
    expect(launched.record.state).toBe("succeeded");
    expect(persisted?.intent.output_capture).toEqual(outputCapture);
    expect(persisted?.spec && "output_capture" in persisted.spec
      ? persisted.spec.output_capture
      : undefined).toEqual(outputCapture);
    const receipt = persisted?.kernel_receipt;
    if (!receipt || "kernel" in receipt) throw new Error("expected agent_runner receipt");
    expect(receipt.run_spec.output_capture).toEqual(outputCapture);
    expect(receipt.artifacts).toMatchObject({
      gate_passed: true,
      missing: [],
      discovered: [{
        name: "proposal-bundle.json",
        location: "run_dir",
        required: true,
        size_bytes: Buffer.byteLength(canonical),
        sha256: createHash("sha256").update(canonical).digest("hex"),
      }],
    });
    const artifactPath = receipt.artifacts.discovered[0]?.path;
    expect(artifactPath).toBeTypeOf("string");
    expect(await readFile(artifactPath!, "utf8")).toBe(canonical);
    expect((await stat(artifactPath!)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(sourceDir, "SOURCE.txt"))).toEqual(sourceBefore);
    expect(await readdir(sourceDir)).toEqual(["SOURCE.txt"]);
    expect(receipt.agent_terminal_message).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain(' { "status": "ok", "answer": 42 }');
    const terminalEvent = (await service.store.readEvents(intent.run_id)).find(isRunTerminalEvent);
    expect(terminalEvent?.summary.agent_terminal_message).toBeUndefined();
    expect(JSON.stringify(terminalEvent)).not.toContain(' { "status": "ok", "answer": 42 }');

    const rejectedIntent = service.createIntent({
      run_id: "persisted-typed-output-rejected",
      host: "local",
      backend: "codex",
      prompt: "Return an invalid typed proposal bundle.",
      require_execplan: false,
      worktree_mode: "existing",
      worktree_path: sourceDir,
      output_capture: outputCapture,
      backend_options: { sandbox: "read-only" },
    });
    const rejected = await service.launch(rejectedIntent, { detached: false });
    expect(rejected.record.state).toBe("failed");
    const rejectedReceipt = rejected.record.kernel_receipt;
    if (!rejectedReceipt || "kernel" in rejectedReceipt) {
      throw new Error("expected rejected agent_runner receipt");
    }
    expect(rejectedReceipt.agent_terminal_message).toBeUndefined();
    expect(rejectedReceipt.metadata?.output_capture).toMatchObject({
      status: "rejected",
      bytes_observed: Buffer.byteLength('{"status":"bad","raw":"REJECTED_RAW_SENTINEL"}'),
      sha256: createHash("sha256")
        .update('{"status":"bad","raw":"REJECTED_RAW_SENTINEL"}')
        .digest("hex"),
      failure_kind: "invalid_output",
    });
    expect(JSON.stringify(rejectedReceipt)).not.toContain("REJECTED_RAW_SENTINEL");
    const rejectedTerminalEvent = (await service.store.readEvents(rejectedIntent.run_id))
      .find(isRunTerminalEvent);
    expect(rejectedTerminalEvent?.summary.agent_terminal_message).toBeUndefined();
    expect(JSON.stringify(rejectedTerminalEvent)).not.toContain("REJECTED_RAW_SENTINEL");
  });

  test("agent-runner worktree leases use the daemon host even when intent host is local", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-lease-host-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "calyx-run-service-lease-worktree-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");
    const observedLeaseKeys: string[] = [];
    const adapter: BackendAdapter = {
      name: "mock",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async (): Promise<AdapterResult> => {
        const opened = await openStateStore();
        try {
          observedLeaseKeys.push(...listLeases(opened.db, { include_expired: true }).map((lease) => lease.key));
        } finally {
          opened.db.close();
        }
        return {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 1,
        };
      },
      stop: async (): Promise<void> => {},
    };
    const deps = buildDeps();
    delete deps.resolveExecutionKernel;
    const service = new RunService({
      runsRoot,
      runtimeAdapterRegistry: {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
      },
    }, deps);

    try {
      const result = await service.launch(service.createIntent({
        run_id: "lease-host-local-intent",
        host: "local",
        backend: "codex",
        prompt: "Check lease host",
        require_execplan: false,
        worktree_mode: "existing",
        worktree_path: worktreePath,
      }), { detached: false });

      expect(result.record.state).toBe("succeeded");
      expect(observedLeaseKeys).toContain(`worktree:blade:${worktreePath}`);
      expect(observedLeaseKeys).not.toContain(`worktree:local:${worktreePath}`);

      const opened = await openStateStore();
      try {
        expect(listLeases(opened.db, { include_expired: true })).toHaveLength(0);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("an isolated lease mutation fails without contention retry while a writer lock is held", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const holder = await openStateStore({ busyTimeoutMs: 0 });
    const contender = await openStateStore({ busyTimeoutMs: 0 });
    try {
      const acquired = acquireLease(holder.db, {
        key: "worktree:blade:/tmp/calyx-lease-counterfactual",
        holder_activity_id: "run:lease-counterfactual",
        ttl_ms: 5_000,
        now: "2026-07-31T12:00:00.000Z",
      });
      expect(acquired.acquired).toBe(true);
      holder.db.exec("BEGIN IMMEDIATE");

      // This is the pre-fix transaction boundary with no whole-operation
      // retry: the competing lease writer cannot even acquire writer intent.
      expect(() => contender.db.exec("BEGIN IMMEDIATE")).toThrow(/database is locked/u);
    } finally {
      try {
        holder.db.exec("ROLLBACK");
      } catch {
        // No open transaction if setup failed before BEGIN IMMEDIATE.
      }
      contender.db.close();
      holder.db.close();
    }
  }));

  test("SQLite contention cannot crash finalization or strand a worktree lease", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const worktreePath = await mkdtemp(join(tmpdir(), "calyx-run-service-contended-worktree-"));
    const projectionOpened = await openStateStore({ busyTimeoutMs: 0 });
    const projection = new RunIndexProjection({ database: projectionOpened.db });
    const originalUpsert = projection.upsert.bind(projection);
    let projectionLockReleased = Promise.resolve();
    let terminalProjectionContended = false;
    vi.spyOn(projection, "upsert").mockImplementation(async (row) => {
      if (row.state === "succeeded" && !terminalProjectionContended) {
        terminalProjectionContended = true;
        const holder = await openStateStore({ busyTimeoutMs: 0 });
        holder.db.exec("BEGIN IMMEDIATE");
        projectionLockReleased = new Promise<void>((resolve) => {
          setTimeout(() => {
            holder.db.exec("ROLLBACK");
            holder.db.close();
            resolve();
          }, 100);
        });
      }
      return originalUpsert(row);
    });

    let adapterStarted!: () => void;
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    let finishAdapter!: () => void;
    const adapterFinished = new Promise<void>((resolve) => { finishAdapter = resolve; });
    const adapter: BackendAdapter = {
      name: "mock",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async (): Promise<AdapterResult> => {
        adapterStarted();
        await adapterFinished;
        return { exit_code: 0, stderr: "", events: [], duration_ms: 1 };
      },
      stop: async (): Promise<void> => {},
    };
    const deps = buildDeps();
    delete deps.resolveExecutionKernel;
    let renewalContended!: () => void;
    const renewalEnteredWhileLocked = new Promise<void>((resolve) => { renewalContended = resolve; });
    let releaseContended!: () => void;
    const releaseEnteredWhileLocked = new Promise<void>((resolve) => { releaseContended = resolve; });
    const service = new RunService({
      runsRoot,
      runIndex: projection,
      subscribers: [],
      leases: {
        state: { busyTimeoutMs: 0 },
        onTransactionContention: (operation) => {
          if (operation === "renew") renewalContended();
          if (operation === "release") releaseContended();
        },
      },
      runtimeAdapterRegistry: {
        register: () => {},
        create: () => adapter,
        has: () => true,
        list: () => ["mock"],
      },
    }, deps);
    const runId = "run-sqlite-contention-finalization";
    const leaseKey = `worktree:blade:${worktreePath}`;
    const intent = service.createIntent({
      run_id: runId,
      host: "local",
      backend: "codex",
      prompt: "Survive shared SQLite writer contention",
      require_execplan: false,
      worktree_mode: "existing",
      worktree_path: worktreePath,
      lock_timeout_ms: 2_000,
    });

    const launch = service.launch(intent, { detached: false });
    await started;

    // Hold the shared state DB across the first scheduled lease renewal. The
    // renewal must retry its whole BEGIN IMMEDIATE transaction on a fresh WAL
    // snapshot instead of escaping through the runner timer.
    const renewalHolder = await openStateStore({ busyTimeoutMs: 0 });
    renewalHolder.db.exec("BEGIN IMMEDIATE");
    await renewalEnteredWhileLocked;
    renewalHolder.db.exec("ROLLBACK");
    renewalHolder.db.close();

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const opened = await openStateStore({ busyTimeoutMs: 0 });
      const renewed = listLeaseEvents(opened.db, leaseKey)
        .some((event) => event.event_type === "renewed");
      opened.db.close();
      if (renewed) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Hold a second writer while the backend returns so voluntary release also
    // has to retry. The terminal run_index upsert injects its own short lock
    // above, exercising the same cross-process contention after run_record.
    const releaseHolder = await openStateStore({ busyTimeoutMs: 0 });
    releaseHolder.db.exec("BEGIN IMMEDIATE");
    finishAdapter();
    await releaseEnteredWhileLocked;
    releaseHolder.db.exec("ROLLBACK");
    releaseHolder.db.close();

    try {
      await expect(launch).resolves.toMatchObject({
        record: {
          run_id: runId,
          state: "succeeded",
        },
      });
      await projectionLockReleased;
      await expect(projection.readEntry(runId)).resolves.toMatchObject({
        run_id: runId,
        state: "succeeded",
      });

      const terminalEvents = (await service.readEvents(runId)).filter(isRunTerminalEvent);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.run.state).toBe("succeeded");
      await expect(service.getRunRecord(runId)).resolves.toMatchObject({
        state: "succeeded",
        kernel_receipt: { run_id: runId, state: "succeeded" },
      });

      const opened = await openStateStore({ busyTimeoutMs: 0 });
      try {
        expect(listLeases(opened.db, { include_expired: true })).toHaveLength(0);
        expect(listLeaseEvents(opened.db, leaseKey).map((event) => event.event_type))
          .toEqual(expect.arrayContaining(["acquired", "renewed", "released"]));
      } finally {
        opened.db.close();
      }
    } finally {
      await projectionLockReleased;
      projectionOpened.db.close();
      await rm(worktreePath, { recursive: true, force: true });
    }
  }));

  test("observeRun summarizes declared artifact roots", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const worktreePath = await mkdtemp(join(tmpdir(), "calyx-artifact-root-"));
    await mkdir(join(worktreePath, "out", "nested"), { recursive: true });
    await writeFile(join(worktreePath, "out", "summary.md"), "summary", "utf8");
    await writeFile(join(worktreePath, "out", "nested", "receipt.json"), "{}", "utf8");
    const intent = service.createIntent({
      host: "local",
      prompt: "Ship artifacts",
      require_execplan: false,
      worktree_mode: "existing",
      worktree_path: worktreePath,
      artifact_roots: ["out", "missing-out"],
    });
    await service.initializeRun(intent);

    const observation = await service.observeRun(intent.run_id, { tail: 10 });

    expect(observation.artifact_roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "out",
          status: "present",
          exists: true,
          file_count: 2,
          directory_count: 1,
          truncated: false,
        }),
        expect.objectContaining({
          name: "missing-out",
          status: "missing",
          exists: false,
        }),
      ]),
    );
    expect(observation.warnings).toContain("Missing artifact roots: missing-out.");
  });

  test("observeRun does not treat a PID artifact as execution authority", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      host: "local",
      prompt: "Observe resource attribution",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const observation = await service.observeRun(intent.run_id, { tail: 10 });

    expect(observation.process).toMatchObject({
      status: "not_recorded",
    });
    expect(observation.resource_attribution).toMatchObject({
      schema_version: "run-resource-attribution/v1",
      status: "pid_missing",
      process_tree: {
        status: "pid_missing",
      },
      gpu_processes: {
        status: "none",
        attributed_process_count: 0,
      },
    });
  });

  test("foreground host_process launch persists stream logs and stream-aware receipt summary", async () => {
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => "2026-03-11T12:00:00.000Z",
      },
    );
    const intent = service.createIntent({
      host: "local",
      issue: "POL-842",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "console.log('host-process-ok'); console.error('host-process-stderr-ok')"],
        cwd: runsRoot,
        stop_grace_ms: 250,
      },
    });

    const result = await service.launch(intent, { detached: false });
    const paths = service.store.paths(intent.run_id);
    const recordText = await readFile(paths.runRecordPath, "utf8");
    const record = JSON.parse(recordText) as {
      state: string;
      kernel_receipt: {
        kernel: string;
        log_summary: {
          total: number;
          error: number;
          streams?: { stdout_lines?: number; stderr_lines?: number };
          severity?: { unknown: number; error: number };
          classifier_version?: string;
        };
      };
    };

    expect(result.mode).toBe("foreground");
    expect(record.state).toBe("succeeded");
    expect(record.kernel_receipt.kernel).toBe("host_process");
    expect(record.kernel_receipt.log_summary).toMatchObject({
      total: 2,
      error: 0,
      streams: { stdout_lines: 1, stderr_lines: 1 },
      severity: { unknown: 2, error: 0 },
      classifier_version: "host-process-log-summary/v1",
    });
    await expect(readFile(paths.kernelReceiptPath, "utf8")).resolves.toContain(`"kernel": "host_process"`);
    await expect(readFile(join(paths.runDir, "stdout.log"), "utf8")).resolves.toContain("host-process-ok");
    await expect(readFile(join(paths.runDir, "stderr.log"), "utf8")).resolves.toContain("host-process-stderr-ok");
    await expect(readFile(join(paths.runDir, "linear-comment.md"), "utf8")).resolves.toContain("Kernel: host_process");
    const logs = await service.readLogs(intent.run_id, { tail: 10 });
    expect(logs.schema_version).toBe("run-logs/v1");
    expect(logs.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stream_line", source: "host_process", stream: "stdout", text: "host-process-ok" }),
        expect.objectContaining({ kind: "stream_line", source: "host_process", stream: "stderr", text: "host-process-stderr-ok" }),
      ]),
    );
    const observation = await service.observeRun(intent.run_id, { tail: 10 });
    expect(observation.schema_version).toBe("run-observation/v1");
    expect(observation.process.status).toBe("not_recorded");
    expect(observation.logs.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "host_process", stream: "stdout", exists: true }),
        expect.objectContaining({ source: "host_process", stream: "stderr", exists: true }),
      ]),
    );
    expect(observation.host_resources.gpu.provider).toBe("nvidia-smi");
  });

  test("bound host receipts use effect chronology after an arbitrarily delayed intent", async () => {
    const service = new RunService(
      { runsRoot, subscribers: [] },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => "2026-03-11T12:00:00.000Z",
      },
    );
    const intent: RunIntent = {
      ...service.createIntent({
        run_id: "run-host-delayed-effect-chronology",
        host: "local",
        kernel: "host_process",
        host_process: {
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: runsRoot,
          stop_grace_ms: 250,
        },
      }),
      created_at: "2026-03-11T11:00:00.000Z",
    };

    const result = await service.launch(intent, { detached: false });
    const receipt = result.record.kernel_receipt as HostProcessReceipt;

    expect(result.record.state).toBe("succeeded");
    expect(receipt.schema_version).toBe(HOST_PROCESS_RECEIPT_SCHEMA_VERSION);
    expect("execution_binding" in receipt).toBe(true);
    expect(new Date(receipt.timing.created_at).getTime())
      .toBeGreaterThanOrEqual(new Date(result.record.launch.accepted_at).getTime());
    expect(new Date(receipt.timing.created_at).getTime() - new Date(intent.created_at).getTime())
      .toBeGreaterThan(1_000);
    expect(result.record.created_at).toBe(receipt.timing.created_at);
    expect(result.record.intent.created_at).toBe(receipt.timing.created_at);
  });

  test("foreground host_process child cannot inherit or override daemon credentials", async () => {
    const receiptPath = join(runsRoot, "inline-host-process-env.json");
    const previous = {
      catalogToken: process.env["CALYX_INLINE_CATALOG_TOKEN"],
      catalogVerifier: process.env["CALYX_INLINE_CATALOG_VERIFIER"],
      conventionalToken: process.env["CALYX_CONSUMER_API_OPERATOR_TOKEN"],
      conventionalVerifier: process.env["CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256"],
      legacyToken: process.env["CALYX_RUN_SERVER_TOKEN"],
      linearApiKey: process.env["LINEAR_API_KEY"],
      safeInherited: process.env["SAFE_INHERITED_VALUE"],
      removedInherited: process.env["REMOVED_INLINE_VALUE"],
    };
    process.env["CALYX_INLINE_CATALOG_TOKEN"] = "catalog-token";
    process.env["CALYX_INLINE_CATALOG_VERIFIER"] = "catalog-verifier";
    process.env["CALYX_CONSUMER_API_OPERATOR_TOKEN"] = "conventional-token";
    process.env["CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256"] = "conventional-verifier";
    process.env["CALYX_RUN_SERVER_TOKEN"] = "legacy-token";
    process.env["LINEAR_API_KEY"] = "publisher-key";
    process.env["SAFE_INHERITED_VALUE"] = "inherited-admission-value";
    process.env["REMOVED_INLINE_VALUE"] = "must-be-removed";

    try {
      const service = new RunService(
        {
          runsRoot,
          detachedWorkerRedactedEnvNames: [
            "CALYX_INLINE_CATALOG_TOKEN",
            "CALYX_INLINE_CATALOG_VERIFIER",
          ],
        },
        {
          resolveExecutionKernel: () => new HostProcessKernel(),
          hostname: () => "blade",
          now: () => "2026-03-11T12:00:00.000Z",
        },
      );
      const intent = service.createIntent({
        host: "local",
        kernel: "host_process",
        host_process: {
          argv: [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.env.WORKER_ENV_RECEIPT, JSON.stringify(process.env))',
          ],
          cwd: runsRoot,
          env: {
            WORKER_ENV_RECEIPT: receiptPath,
            SAFE_INLINE_VALUE: "preserved",
            REMOVED_INLINE_VALUE: null,
            CALYX_INLINE_CATALOG_TOKEN: "override-token",
            CALYX_INLINE_CATALOG_VERIFIER: "override-verifier",
            CALYX_RUN_SERVER_TOKEN: "override-legacy",
            LINEAR_API_KEY: "override-publisher",
          },
        },
      });

      const expectedSpawnEnvironment = freezeHostProcessSpawnEnvironment(
        intent.host_process?.env,
        process.env,
        ["CALYX_INLINE_CATALOG_TOKEN", "CALYX_INLINE_CATALOG_VERIFIER"],
      );
      const launched = await service.launch(intent, { detached: false });
      const childEnv = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, string>;
      expect(childEnv).toEqual(expectedSpawnEnvironment);
      expect(childEnv).toMatchObject({
        SAFE_INLINE_VALUE: "preserved",
        SAFE_INHERITED_VALUE: "inherited-admission-value",
      });
      expect(childEnv).not.toHaveProperty("REMOVED_INLINE_VALUE");
      expect(childEnv).not.toHaveProperty("CALYX_INLINE_CATALOG_TOKEN");
      expect(childEnv).not.toHaveProperty("CALYX_INLINE_CATALOG_VERIFIER");
      expect(childEnv).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_TOKEN");
      expect(childEnv).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256");
      expect(childEnv).not.toHaveProperty("CALYX_RUN_SERVER_TOKEN");
      expect(childEnv).not.toHaveProperty("LINEAR_API_KEY");
      const binding = launched.record.launch.host_process_execution_binding;
      const receipt = launched.record.kernel_receipt;
      expect(binding).toMatchObject({
        schema_version: "calyx.host-process-execution-binding/v1",
        execution_id: launched.record.launch.execution_id,
        salt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        commitment_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(receipt && "kernel" in receipt && receipt.kernel === "host_process"
        ? receipt.execution_binding
        : undefined).toEqual(binding);
      expect(binding?.commitment_sha256).toBe(hostProcessExecutionCommitment(
        launched.record.spec as Extract<NonNullable<RunRecord["spec"]>, { kernel: "host_process" }>,
        expectedSpawnEnvironment,
        binding!.execution_id,
        binding!.salt,
      ));
      const persistedRecord = await readFile(service.store.paths(intent.run_id).runRecordPath, "utf8");
      expect(persistedRecord).not.toContain("inherited-admission-value");

      // Recovery compares the receipt to the binding admitted before spawn;
      // ambient environment drift after the effect cannot change authority.
      process.env["SAFE_INHERITED_VALUE"] = "changed-after-effect";
      const reconciled = await service.reconcile();
      expect(reconciled.skipped).toContain(intent.run_id);
      await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "succeeded" });
    } finally {
      for (const [key, value] of Object.entries({
        CALYX_INLINE_CATALOG_TOKEN: previous.catalogToken,
        CALYX_INLINE_CATALOG_VERIFIER: previous.catalogVerifier,
        CALYX_CONSUMER_API_OPERATOR_TOKEN: previous.conventionalToken,
        CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256: previous.conventionalVerifier,
        CALYX_RUN_SERVER_TOKEN: previous.legacyToken,
        LINEAR_API_KEY: previous.linearApiKey,
        SAFE_INHERITED_VALUE: previous.safeInherited,
        REMOVED_INLINE_VALUE: previous.removedInherited,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("direct detached worker persists stdout and stderr logs for a successful child", async () => {
    const workerEntrypoint = join(runsRoot, "detached-worker-success.cjs");
    await writeFile(
      workerEntrypoint,
      [
        "process.stdout.write('detached worker stdout\\n');",
        "process.stderr.write('detached worker stderr\\n');",
      ].join("\n"),
      "utf8",
    );

    const runId = "detached-worker-success";
    const runDir = join(runsRoot, runId);
    const result = await spawnDetachedWorker({
      entrypoint: workerEntrypoint,
      runId,
      runsRoot,
      runDir,
    }, {
      platform: "darwin",
    });
    expect(result).toMatchObject({ supervisor: "direct", pid: expect.any(Number) });
    await expect(waitForFileContains(join(runDir, "stdout.log"), "detached worker stdout")).resolves.toContain(
      "detached worker stdout",
    );
    await expect(waitForFileContains(join(runDir, "stderr.log"), "detached worker stderr")).resolves.toContain(
      "detached worker stderr",
    );
  });

  test("detached worker preserves stderr when the child exits immediately", async () => {
    const workerEntrypoint = join(runsRoot, "detached-worker-exit.cjs");
    await writeFile(
      workerEntrypoint,
      [
        "process.stderr.write('worker exited immediately\\n');",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    const runId = "detached-worker-exit";
    const runDir = join(runsRoot, runId);
    await spawnDetachedWorker({
      entrypoint: workerEntrypoint,
      runId,
      runsRoot,
      runDir,
    }, {
      platform: "darwin",
    });
    const stderrPath = join(runDir, "stderr.log");
    await expect(waitForFileContains(stderrPath, "worker exited immediately")).resolves.toContain(
      "worker exited immediately",
    );
  });

  test("detached worker captures ENOENT diagnostics from a missing codex binary", async () => {
    const workerEntrypoint = join(runsRoot, "detached-worker-enoent.cjs");
    await writeFile(
      workerEntrypoint,
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {",
        "  env: { ...process.env, PATH: '' },",
        "  stdio: ['ignore', 'ignore', 'ignore'],",
        "});",
        "child.on('error', (error) => {",
        "  process.stderr.write(`${error.message}\\n`);",
        "  process.exit(1);",
        "});",
      ].join("\n"),
      "utf8",
    );

    const runId = "detached-worker-enoent";
    const runDir = join(runsRoot, runId);
    await spawnDetachedWorker({
      entrypoint: workerEntrypoint,
      runId,
      runsRoot,
      runDir,
    }, {
      platform: "darwin",
    });
    const stderrPath = join(runDir, "stderr.log");
    await expect(waitForFileContains(stderrPath, "ENOENT")).resolves.toContain("spawn codex ENOENT");
  });

  test("systemd worker isolation only triggers for Linux service cgroups unless explicitly overridden", () => {
    const serviceCgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n";
    const userManagerCgroup = "0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-12.scope\n";
    const terminalScopeCgroup = "0::/user.slice/user-1000.slice/session-12.scope\n";

    expect(isSystemdServiceCgroup(serviceCgroup)).toBe(true);
    expect(isSystemdServiceCgroup(userManagerCgroup)).toBe(false);
    expect(isSystemdServiceCgroup(terminalScopeCgroup)).toBe(false);
    expect(shouldUseSystemdWorkerIsolation({ platform: "linux", cgroupText: serviceCgroup, env: {} })).toBe(true);
    expect(shouldUseSystemdWorkerIsolation({ platform: "linux", cgroupText: serviceCgroup, env: { CALYX_RUN_WORKER_SUPERVISOR: "direct" } })).toBe(false);
    expect(shouldUseSystemdWorkerIsolation({ platform: "darwin", cgroupText: serviceCgroup, env: {} })).toBe(false);
    expect(systemdWorkerUnitName("run id/with spaces")).toMatch(/^calyx-run-run-id-with-spaces-[0-9a-f]{8}\.service$/);
    expect(systemdWorkerUnitName("a b")).not.toBe(systemdWorkerUnitName("a/b"));
    expect(systemdWorkerUnitName("x".repeat(300)).length).toBeLessThan(200);
  });

  test("systemd worker env files preserve valid daemon environment entries", () => {
    expect(systemdEnvironmentFileContents({
      PATH: "/usr/bin:/home/caleb/bin",
      CALYX_RUNS_ROOT: "/home/caleb/.calyx/runs",
      QUOTED: 'value with "quotes"',
      MULTILINE: "first\nsecond",
      "bad-name": "ignored",
    })).toBe([
      'PATH="/usr/bin:/home/caleb/bin"',
      'CALYX_RUNS_ROOT="/home/caleb/.calyx/runs"',
      'QUOTED="value with \\"quotes\\""',
      'MULTILINE="first',
      'second"',
      "",
    ].join("\n"));
  });

  test("detached worker environments redact every server-only credential without reading it", () => {
    const source = new Proxy({
      PATH: "/usr/bin",
      CALYX_SWITCHBOARD_TOKEN: "catalog-secret",
      CALYX_CONSUMER_API_OPERATOR_TOKEN: "conventional-secret",
      CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256: "conventional-verifier",
      CALYX_DAEMON_BLADE_VERIFIER: "verifier-is-not-plaintext",
      CALYX_RUN_SERVER_TOKEN: "legacy-shared-secret",
      LINEAR_API_KEY: "linear-publisher-secret",
    }, {
      get(target, property, receiver) {
        if (property !== "PATH") {
          throw new Error(`read redacted value ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as NodeJS.ProcessEnv;

    const redacted = redactServerOnlyEnvironment(source, [
      "CALYX_SWITCHBOARD_TOKEN",
      "CALYX_DAEMON_BLADE_VERIFIER",
    ]);
    expect(redacted).toEqual({ PATH: "/usr/bin" });
    const systemdContents = systemdEnvironmentFileContents(redacted);
    expect(systemdContents).not.toContain("TOKEN");
    expect(systemdContents).not.toContain("VERIFIER");
    expect(systemdContents).not.toContain("LINEAR_API_KEY");
  });

  test("direct detached child receives no daemon credential material", async () => {
    const runId = "direct-worker-secret-boundary";
    const runDir = join(runsRoot, runId);
    const entrypoint = join(runDir, "capture-env.mjs");
    const receiptPath = join(runDir, "worker-env.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(entrypoint, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.WORKER_ENV_RECEIPT, JSON.stringify(process.env));',
    ].join("\n"), "utf8");

    await spawnDetachedWorker(
      { entrypoint, runId, runsRoot, runDir, redactedEnvNames: ["CALYX_CATALOG_TOKEN", "CALYX_CATALOG_VERIFIER"] },
      {
        platform: "darwin",
        env: {
          PATH: process.env.PATH,
          WORKER_ENV_RECEIPT: receiptPath,
          SAFE_VALUE: "preserved",
          CALYX_CATALOG_TOKEN: "catalog-token",
          CALYX_CATALOG_VERIFIER: "catalog-verifier",
          CALYX_CONSUMER_API_OPERATOR_TOKEN: "conventional-token",
          CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256: "conventional-verifier",
          CALYX_RUN_SERVER_TOKEN: "legacy-token",
          LINEAR_API_KEY: "publisher-key",
        },
      },
    );

    let childEnv: Record<string, string> | undefined;
    for (let attempt = 0; attempt < 100 && !childEnv; attempt += 1) {
      childEnv = await readFile(receiptPath, "utf8")
        .then((contents) => JSON.parse(contents) as Record<string, string>)
        .catch(() => undefined);
      if (!childEnv) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(childEnv).toMatchObject({ SAFE_VALUE: "preserved", CALYX_RUNS_ROOT: runsRoot });
    expect(childEnv).not.toHaveProperty("CALYX_CATALOG_TOKEN");
    expect(childEnv).not.toHaveProperty("CALYX_CATALOG_VERIFIER");
    expect(childEnv).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_TOKEN");
    expect(childEnv).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256");
    expect(childEnv).not.toHaveProperty("CALYX_RUN_SERVER_TOKEN");
    expect(childEnv).not.toHaveProperty("LINEAR_API_KEY");
  });

  test("systemd environment file contains no daemon credential material", async () => {
    const runId = "systemd-worker-secret-boundary";
    const runDir = join(runsRoot, runId);
    let capturedEnvironment = "";
    const systemdRun = vi.fn(async (_command: string, args: string[]) => {
      const property = args.find((arg) => arg.startsWith("--property=EnvironmentFile="));
      const envPath = property?.slice("--property=EnvironmentFile=".length);
      capturedEnvironment = envPath ? await readFile(envPath, "utf8") : "";
      await writeFile(join(runDir, "systemd-worker.pid"), "81723\n", "utf8");
      await writeFile(join(runDir, "systemd-worker.cgroup"), "0::/calyx-test.service\n", "utf8");
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });

    await spawnDetachedWorker(
      {
        entrypoint: "/tmp/calyx-worker",
        runId,
        runsRoot,
        runDir,
        redactedEnvNames: ["CALYX_CATALOG_TOKEN", "CALYX_CATALOG_VERIFIER"],
      },
      {
        platform: "linux",
        cgroupText: "0::/system.slice/calyx-run-serve.service\n",
        env: {
          XDG_RUNTIME_DIR: runsRoot,
          SAFE_VALUE: "preserved",
          CALYX_CATALOG_TOKEN: "catalog-token",
          CALYX_CATALOG_VERIFIER: "catalog-verifier",
          CALYX_RUN_SERVER_TOKEN: "legacy-token",
          LINEAR_API_KEY: "publisher-key",
        },
        runSystemdCommand: systemdRun,
      },
    );

    expect(capturedEnvironment).toContain('SAFE_VALUE="preserved"');
    expect(capturedEnvironment).not.toContain("CALYX_CATALOG_TOKEN");
    expect(capturedEnvironment).not.toContain("CALYX_CATALOG_VERIFIER");
    expect(capturedEnvironment).not.toContain("CALYX_RUN_SERVER_TOKEN");
    expect(capturedEnvironment).not.toContain("LINEAR_API_KEY");
  });

  test("systemd worker env files are staged under a runtime temp root", () => {
    expect(systemdWorkerEnvironmentRoot({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000");
    expect(systemdWorkerEnvironmentRoot({ XDG_RUNTIME_DIR: "relative/runtime" })).toBe(tmpdir());
    expect(systemdWorkerEnvironmentRoot({})).toBe(tmpdir());
  });

  test("systemd worker shell wrapper escapes dollar expansion for ExecStart", () => {
    expect(systemdEscapeExecShell('echo "$$" "$1" "$pidfile" "$@"')).toBe('echo "$$$$" "$$1" "$$pidfile" "$$@"');
  });

  test("systemd worker launch falls back to direct spawn before launch evidence exists", async () => {
    const runDir = join(runsRoot, "systemd-env-staging-fallback");
    const directWorker = vi.fn(async () => ({ pid: 4242, supervisor: "direct" as const }));
    const systemdRun = vi.fn(async () => ({ code: 0, signal: null, stdout: "", stderr: "" }));

    const result = await spawnDetachedWorker(
      {
        entrypoint: "/tmp/calyx-worker",
        runId: "systemd-env-staging-fallback",
        runsRoot,
        runDir,
      },
      {
        platform: "linux",
        cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n",
        env: { XDG_RUNTIME_DIR: join(runsRoot, "missing-runtime-root") },
        spawnDirectWorker: directWorker,
        runSystemdCommand: systemdRun,
      },
    );

    expect(result).toMatchObject({ pid: 4242, supervisor: "direct" });
    // POL-2044: the fallback fact is also returned structurally so the launch
    // event persists it rather than leaving it only in worker stderr.
    expect(result.supervisorFallbackReason).toContain("systemd worker environment file staging failed");
    expect(systemdRun).not.toHaveBeenCalled();
    expect(directWorker).toHaveBeenCalledTimes(1);
    await expect(readFile(join(runDir, "stderr.log"), "utf8")).resolves.toContain("falling back to direct supervisor");
  });

  test("systemd-run unavailability falls back to direct spawn only once", async () => {
    const runDir = join(runsRoot, "systemd-run-fallback");
    const directWorker = vi.fn(async () => ({ pid: 5150, supervisor: "direct" as const }));
    const systemdRun = vi.fn(async () => ({ code: 1, signal: null, stdout: "", stderr: "Failed to connect to bus" }));

    const result = await spawnDetachedWorker(
      {
        entrypoint: "/tmp/calyx-worker",
        runId: "systemd-run-fallback",
        runsRoot,
        runDir,
      },
      {
        platform: "linux",
        cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n",
        env: { XDG_RUNTIME_DIR: runsRoot },
        spawnDirectWorker: directWorker,
        runSystemdCommand: systemdRun,
      },
    );

    expect(result).toMatchObject({ pid: 5150, supervisor: "direct" });
    expect(result.supervisorFallbackReason).toContain("systemd-run failed to launch detached run worker");
    expect(systemdRun).toHaveBeenCalledTimes(1);
    expect(systemdRun).toHaveBeenCalledWith("systemd-run", expect.arrayContaining(["--user", expect.stringMatching(/^--unit=calyx-run-/)]));
    expect(directWorker).toHaveBeenCalledTimes(1);
  });

  test("systemd worker launch escapes sibling ExecStart argv", async () => {
    const runId = "systemd-dollar-$id";
    const runDir = join(runsRoot, runId);
    const directWorker = vi.fn(async () => ({ pid: 5150, supervisor: "direct" as const }));
    const capturedArgs: string[][] = [];
    const systemdRun = vi.fn(async (_command: string, args: string[]) => {
      capturedArgs.push(args);
      return { code: 1, signal: null, stdout: "", stderr: "forced fallback" };
    });

    await spawnDetachedWorker(
      {
        entrypoint: "/tmp/calyx-$worker",
        runId,
        runsRoot,
        runDir,
      },
      {
        platform: "linux",
        cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n",
        env: { XDG_RUNTIME_DIR: runsRoot },
        spawnDirectWorker: directWorker,
        runSystemdCommand: systemdRun,
      },
    );

    const systemdArgs = capturedArgs[0] ?? [];
    const runIdIndex = systemdArgs.indexOf("--run-id");
    expect(runIdIndex).toBeGreaterThan(-1);
    expect(systemdArgs[runIdIndex + 1]).toBe("systemd-dollar-$$id");
    expect(systemdArgs).toContain("/tmp/calyx-$$worker");
    expect(systemdArgs.some((arg) => arg.includes("systemd-dollar-$$id/systemd-worker.cgroup"))).toBe(true);
    expect(directWorker).toHaveBeenCalledTimes(1);
  });

  test("explicit systemd worker mode fails closed instead of falling back", async () => {
    const directWorker = vi.fn(async () => ({ pid: 5150, supervisor: "direct" as const }));
    const systemdRun = vi.fn(async () => ({ code: 1, signal: null, stdout: "", stderr: "Failed to connect to bus" }));

    await expect(
      spawnDetachedWorker(
        {
          entrypoint: "/tmp/calyx-worker",
          runId: "explicit-systemd-fail-closed",
          runsRoot,
          runDir: join(runsRoot, "explicit-systemd-fail-closed"),
        },
        {
          platform: "linux",
          env: { XDG_RUNTIME_DIR: runsRoot, CALYX_RUN_WORKER_SUPERVISOR: "systemd" },
          spawnDirectWorker: directWorker,
          runSystemdCommand: systemdRun,
        },
      ),
    ).rejects.toThrow("systemd-run failed to launch detached run worker");

    expect(systemdRun).toHaveBeenCalledTimes(1);
    expect(directWorker).not.toHaveBeenCalled();
  });

  test("systemd worker launch returns unit and cgroup evidence without a PID artifact", async () => {
    const runId = "systemd-success-evidence";
    const runDir = join(runsRoot, runId);
    const directWorker = vi.fn(async () => ({ pid: 5150, supervisor: "direct" as const }));
    const systemdRun = vi.fn(async (command: string) => {
      expect(command).toBe("systemd-run");
      await writeFile(join(runDir, "systemd-worker.cgroup"), "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-systemd-success-evidence.service\n", "utf8");
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });

    const result = await spawnDetachedWorker(
      {
        entrypoint: "/tmp/calyx-worker",
        runId,
        runsRoot,
        runDir,
      },
      {
        platform: "linux",
        cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n",
        env: { XDG_RUNTIME_DIR: runsRoot },
        spawnDirectWorker: directWorker,
        runSystemdCommand: systemdRun,
      },
    );

    expect(result).toMatchObject({
      supervisor: "systemd",
      systemdUnit: expect.stringMatching(/^calyx-run-systemd-success-evidence-[0-9a-f]{8}\.service$/),
      cgroup: expect.stringContaining("calyx-run-systemd-success-evidence.service"),
    });
    await expect(stat(join(runDir, "systemd-worker.pid"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(directWorker).not.toHaveBeenCalled();
  });

  test("systemd launch does not invent PID-based registration when cgroup evidence is delayed", async () => {
    const runId = "systemd-pidfile-timeout";
    const runDir = join(runsRoot, runId);
    const directWorker = vi.fn(async () => ({ pid: 5150, supervisor: "direct" as const }));
    const systemdCommands: Array<{ command: string; args: string[] }> = [];
    const systemdRun = vi.fn(async (command: string, args: string[]) => {
      systemdCommands.push({ command, args });
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });

    await expect(spawnDetachedWorker(
        {
          entrypoint: "/tmp/calyx-worker",
          runId,
          runsRoot,
          runDir,
        },
        {
          platform: "linux",
          cgroupText: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-serve.service\n",
          env: { XDG_RUNTIME_DIR: runsRoot },
          spawnDirectWorker: directWorker,
          runSystemdCommand: systemdRun,
        },
      )).resolves.toMatchObject({
        supervisor: "systemd",
        systemdUnit: expect.stringMatching(/^calyx-run-systemd-pidfile-timeout-[0-9a-f]{8}\.service$/),
      });

    expect(directWorker).not.toHaveBeenCalled();
    expect(systemdCommands.map((entry) => entry.command)).toEqual(["systemd-run"]);
    await expect(stat(join(runDir, "systemd-worker.pid"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("detached launch records worker supervisor evidence", async () => {
    const workerExecutions: Promise<RunRecord>[] = [];
    const service = new RunService({ runsRoot, workerEntrypoint: "/tmp/calyx-worker" }, {
      ...buildDeps(),
      spawnWorker: async (args) => {
        workerExecutions.push(service.executeStoredRun(args.runId));
        return {
          pid: 4242,
          supervisor: "systemd",
          systemdUnit: "calyx-run-worker-receipt.service",
          cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/calyx-run-worker-receipt.service",
        };
      },
    });
    const intent = service.createIntent({
      run_id: "worker-receipt",
      host: "local",
      prompt: "Detached worker receipt",
      require_execplan: false,
    });

    await service.launch(intent);
    const events = await service.store.readEvents(intent.run_id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "launch_dispatched",
          payload: expect.objectContaining({
            pid: 4242,
            worker_supervisor: "systemd",
            systemd_unit: "calyx-run-worker-receipt.service",
            cgroup: expect.stringContaining("calyx-run-worker-receipt.service"),
          }),
        }),
      ]),
    );
    await expect(workerExecutions[0]).resolves.toMatchObject({ state: "succeeded" });
  });

  test("POL-2044: detached launch persists the systemd→direct fallback fact on the launch event", async () => {
    const workerExecutions: Promise<RunRecord>[] = [];
    const service = new RunService({ runsRoot, workerEntrypoint: "/tmp/calyx-worker" }, {
      ...buildDeps(),
      spawnWorker: async (args) => {
        workerExecutions.push(service.executeStoredRun(args.runId));
        return {
          pid: 4243,
          supervisor: "direct",
          supervisorFallbackReason: "systemd-run failed to launch detached run worker worker-fallback-receipt.",
        };
      },
    });
    const intent = service.createIntent({
      run_id: "worker-fallback-receipt",
      host: "local",
      prompt: "Detached worker fallback receipt",
      require_execplan: false,
    });

    await service.launch(intent);
    const events = await service.store.readEvents(intent.run_id);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "launch_dispatched",
          payload: expect.objectContaining({
            pid: 4243,
            worker_supervisor: "direct",
            worker_supervisor_fallback: expect.stringContaining("systemd-run failed to launch detached run worker"),
          }),
        }),
      ]),
    );
    await expect(workerExecutions[0]).resolves.toMatchObject({ state: "succeeded" });
  });

  test("reconcile adopts a live execution mutex across sibling service instances", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-owner-adoption",
      host: "local",
      prompt: "Hold execution ownership",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: "2026-03-11T12:00:00.000Z",
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        // POL-2044: systemd isolation is the only Linux supervisor proven
        // restart-safe, so the adopted live worker must carry it to preserve.
        payload: { worker_supervisor: "systemd" },
      },
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "execution-owner-1",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    let signalAcquired!: () => void;
    let releaseOwner!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const held = withSqliteMutex(service.store.paths(intent.run_id).executionMutexPath, async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    try {
      const sibling = new RunService({ runsRoot }, buildDeps());
      const reconcile = await sibling.reconcile();
      expect(reconcile.adopted).toContain(intent.run_id);
      expect(reconcile.classified).not.toContain(intent.run_id);
      expect((await sibling.getRunRecord(intent.run_id))?.state).toBe("running");
      await expect(stat(join(service.store.paths(intent.run_id).runDir, "pid")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const [assessment] = await sibling.assessRestartReadopt([intent.run_id]);
      expect(assessment).toEqual({
        run_id: intent.run_id,
        readopt_safe: true,
        reason: "detached_agent_runner_worker",
        worker_supervisor: "systemd",
      });
    } finally {
      releaseOwner();
      await held;
    }
  });

  test("reconcile preserves a possibly-live origin-main worker without claiming identity or readopt authority", async () => {
    const observeLegacyWorkerPid = vi.fn(async () => "possibly_live" as const);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-live-worker-adoption",
      host: "local",
      prompt: "Preserve my pre-mutex worker",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: {
          pid: process.pid,
          worker_supervisor: "direct",
        },
      },
    );
    await writeFile(join(service.store.paths(intent.run_id).runDir, "pid"), `${process.pid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(reconciled.adopted).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    const events = await service.store.readEvents(intent.run_id);
    expect(events.filter(isRunTerminalEvent)).toHaveLength(0);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({
          reconcile: "legacy_settlement_pending",
          authority: "legacy_pid_observation",
          worker_pid: process.pid,
          effect_authority: false,
          readopt_safe: false,
        }),
      }),
    ]));
    await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
      run_id: intent.run_id,
      readopt_safe: false,
      reason: "legacy_process_identity_unavailable",
    }]);
    expect(observeLegacyWorkerPid).toHaveBeenCalledWith(process.pid);

    await service.reconcile();
    const replayedEvents = await service.store.readEvents(intent.run_id);
    expect(replayedEvents.filter((event) => (
      isRunServiceEvent(event)
      && event.event === "reconciled"
      && (event.payload as { authority?: unknown } | undefined)?.authority === "legacy_pid_observation"
    ))).toHaveLength(1);
  });

  test("reconcile refuses to settle a multi-launch legacy estate by observing only its last PID", async () => withTempStateHome(async () => {
    const firstPid = 45_670;
    const lastPid = 45_671;
    const observeLegacyWorkerPid = vi.fn(async (pid: number) => (
      pid === firstPid ? "possibly_live" as const : "dead" as const
    ));
    const observeLegacyWorkerProcessGroup = vi.fn(async () => "dead" as const);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
      observeLegacyWorkerProcessGroup,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-multi-launch-fail-closed",
      host: "local",
      prompt: "Do not settle only the last historical launcher",
      require_execplan: false,
      handback: {
        key: "legacy-multi-launch",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "legacy-multi-launch",
        ack_required: true,
        body_contract: "no terminal publication without complete worker authority",
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const firstLaunchAt = "2026-03-11T12:00:01.000Z";
    const lastLaunchAt = "2026-03-11T12:00:02.000Z";
    for (const [timestamp, pid] of [[firstLaunchAt, firstPid], [lastLaunchAt, lastPid]] as const) {
      await service.store.appendEvent(intent.run_id, {
        timestamp,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid, worker_supervisor: "direct" },
      });
    }
    const paths = service.store.paths(intent.run_id);
    await writeFile(join(paths.runDir, "pid"), `${lastPid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: lastLaunchAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(acquireLease(opened.db, {
        key: "worktree:blade:/tmp/legacy-multi-launch",
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: lastLaunchAt,
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.adopted).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(0);
    expect(observeLegacyWorkerPid).not.toHaveBeenCalled();
    expect(observeLegacyWorkerProcessGroup).not.toHaveBeenCalled();
    await expect(readFile(join(paths.runDir, "pid"), "utf8")).resolves.toBe(`${lastPid}\n`);
    expect((await readdir(paths.runDir)).some((entry) => entry.startsWith("handback-"))).toBe(false);
    const after = await openStateStore();
    try {
      expect(listLeases(after.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      after.db.close();
    }
  }));

  test("reconcile separates dead legacy publisher settlement from later process-group lease release", async () => withTempStateHome(async () => {
    const deadWrapperPid = 45_672;
    const leaseKey = "worktree:blade:/tmp/legacy-live-process-group";
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000012");
    const observeLegacyWorkerPid = vi.fn(async () => "dead" as const);
    let processGroupObservation: "possibly_live" | "dead" = "possibly_live";
    const observeLegacyWorkerProcessGroup = vi.fn(async () => processGroupObservation);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
      observeLegacyWorkerProcessGroup,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-live-process-group",
      host: "local",
      prompt: "A dead wrapper does not release inherited resources",
      require_execplan: false,
      handback: {
        key: "legacy-live-process-group",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "legacy-live-process-group",
        ack_required: true,
        body_contract: "terminal publisher outcome with independently fenced resource release",
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: deadWrapperPid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    await writeFile(join(paths.runDir, "pid"), `${deadWrapperPid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(acquireLease(opened.db, {
        key: leaseKey,
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: launchedAt,
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }

    const reconciled = await service.reconcile({ provenance });

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_resource_settlement_pending",
    }]);
    expect(reconciled.adopted).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
      recovery: {
        owner_free_settlement: {
          authority: "legacy_pid_dead",
          legacy_pid: deadWrapperPid,
        },
        resource_settlement: {
          status: "pending",
          authority: "legacy_process_group_observation",
          reason_code: "legacy_detached_process_group_possibly_live",
          legacy_process_group_id: deadWrapperPid,
        },
      },
    });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(1);
    expect(observeLegacyWorkerPid).toHaveBeenCalledWith(deadWrapperPid);
    expect(observeLegacyWorkerProcessGroup).toHaveBeenCalledWith(deadWrapperPid);
    await expect(readFile(join(paths.runDir, "pid"), "utf8")).resolves.toBe(`${deadWrapperPid}\n`);
    await expect(readRunHandbackReceipt(service, intent.run_id)).resolves.toMatchObject({
      run_id: intent.run_id,
    });
    const after = await openStateStore();
    try {
      const retained = listLeases(after.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      });
      expect(retained).toHaveLength(1);
      expect(readLeaseResourceQuarantine(retained[0]!)).toMatchObject({
        run_id: intent.run_id,
        owner_free_authority_id: expect.stringMatching(/^[0-9a-f]{64}$/u),
        legacy_process_group_id: deadWrapperPid,
      });
      expect(acquireLease(after.db, {
        key: leaseKey,
        holder_activity_id: "run:resource-competitor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:05:00.000Z",
      })).toMatchObject({ acquired: false, conflict: { kind: "quarantined" } });
      expect(listLeaseEvents(after.db, leaseKey)).toEqual([
        expect.objectContaining({ event_type: "acquired" }),
        expect.objectContaining({
          event_type: "quarantined",
          request_provenance: provenance,
        }),
      ]);
    } finally {
      after.db.close();
    }

    const pendingRecord = await service.getRunRecord(intent.run_id);
    expect(pendingRecord).toBeDefined();
    observeLegacyWorkerProcessGroup.mockClear();

    const recordWithTornPublisherSettlement = structuredClone(pendingRecord!);
    delete (recordWithTornPublisherSettlement.recovery.owner_free_settlement as Partial<
      NonNullable<RunRecord["recovery"]["owner_free_settlement"]>
    >).settled_at;
    await service.store.writeRunRecord(intent.run_id, recordWithTornPublisherSettlement);
    const tornPublisherSettlement = await service.reconcile();
    expect(tornPublisherSettlement.skipped).not.toContain(intent.run_id);
    expect(tornPublisherSettlement.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_owner_settlement_pending",
    }]);
    expect(observeLegacyWorkerProcessGroup).not.toHaveBeenCalled();

    const recordWithMalformedResourceSettlement = structuredClone(pendingRecord!);
    if (recordWithMalformedResourceSettlement.recovery.resource_settlement?.status !== "pending") {
      throw new Error("expected pending resource settlement fixture");
    }
    recordWithMalformedResourceSettlement.recovery.resource_settlement.observed_at = "not-a-timestamp";
    await service.store.writeRunRecord(intent.run_id, recordWithMalformedResourceSettlement);
    const malformedResourceSettlement = await service.reconcile();
    expect(malformedResourceSettlement.skipped).not.toContain(intent.run_id);
    expect(malformedResourceSettlement.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_resource_settlement_pending",
    }]);
    expect(observeLegacyWorkerProcessGroup).not.toHaveBeenCalled();

    await service.store.writeRunRecord(intent.run_id, pendingRecord!);
    const recordWithoutResourceAuthority = structuredClone(pendingRecord!);
    delete recordWithoutResourceAuthority.recovery.resource_settlement;
    await service.store.writeRunRecord(intent.run_id, recordWithoutResourceAuthority);
    const missingResourceAuthority = await service.reconcile();
    expect(missingResourceAuthority.skipped).not.toContain(intent.run_id);
    expect(missingResourceAuthority.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_resource_settlement_pending",
    }]);
    const retainedWithoutAuthority = await openStateStore();
    try {
      expect(listLeases(retainedWithoutAuthority.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      retainedWithoutAuthority.db.close();
    }
    await service.store.writeRunRecord(intent.run_id, pendingRecord!);

    const recordWithDamagedAdmission = structuredClone(pendingRecord!);
    recordWithDamagedAdmission.launch.admission_identity = "f".repeat(64);
    await service.store.writeRunRecord(intent.run_id, recordWithDamagedAdmission);
    const damagedAdmission = await service.reconcile();
    expect(damagedAdmission.skipped).not.toContain(intent.run_id);
    expect(damagedAdmission.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_owner_settlement_pending",
    }]);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      launch: { admission_identity: "f".repeat(64) },
      recovery: {
        owner_free_settlement: { authority: "legacy_pid_dead" },
        resource_settlement: { status: "pending" },
      },
    });
    const retainedWithDamagedAdmission = await openStateStore();
    try {
      expect(listLeases(retainedWithDamagedAdmission.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      retainedWithDamagedAdmission.db.close();
    }
    await service.store.writeRunRecord(intent.run_id, pendingRecord!);

    const lateSpec = await resolveRunIntent(intent, { now: () => launchedAt });
    const lateReceipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, lateSpec.backend),
      "succeeded",
      { timing: { created_at: intent.created_at, completed_at: "2026-03-11T12:00:03.000Z" } },
    );
    await service.store.writeSpec(intent.run_id, lateSpec);
    await service.store.writeKernelReceipt(intent.run_id, lateReceipt);
    await writeFile(
      paths.eventsPath,
      `${await readFile(paths.eventsPath, "utf8")}{"malformed":\n`,
      "utf8",
    );
    const corruptJournal = await service.reconcile();
    expect(corruptJournal.rebuilt).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
      recovery: {
        owner_free_settlement: pendingRecord!.recovery.owner_free_settlement,
        resource_settlement: pendingRecord!.recovery.resource_settlement,
      },
    });
    expect((await readdir(paths.runDir)).some((entry) => entry.startsWith("events.jsonl.corrupt."))).toBe(true);
    const retainedAfterCorruptReceipt = await openStateStore();
    try {
      expect(listLeases(retainedAfterCorruptReceipt.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      retainedAfterCorruptReceipt.db.close();
    }

    processGroupObservation = "dead";
    const originalAppendEvent = service.store.appendEvent.bind(service.store);
    let injectReleaseProjectionCrash = true;
    const injectedAppendEvent = async (
      runIdOrEvent: string | CalyxStreamEvent,
      event?: RecordedRunEvent,
    ): Promise<void | CalyxStreamEvent> => {
      if (
        injectReleaseProjectionCrash
        && typeof runIdOrEvent === "string"
        && event !== undefined
        && isRunServiceEvent(event)
        && event.event === "reconciled"
        && Number.isSafeInteger((event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id)
      ) {
        injectReleaseProjectionCrash = false;
        throw new Error("injected crash after durable lease release");
      }
      if (typeof runIdOrEvent === "string") {
        if (event === undefined) throw new Error("missing run event");
        await originalAppendEvent(runIdOrEvent, event);
      } else {
        return originalAppendEvent(runIdOrEvent);
      }
    };
    const appendEventSpy = vi.spyOn(service.store, "appendEvent")
      .mockImplementation(injectedAppendEvent as unknown as typeof service.store.appendEvent);

    await expect(service.reconcile({ provenance }))
      .rejects.toThrow("injected crash after durable lease release");
    appendEventSpy.mockRestore();

    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      recovery: {
        resource_settlement: {
          status: "settled",
          authority: "legacy_process_group_extinct",
          reason_code: "legacy_detached_process_group_observed_extinct",
          legacy_process_group_id: deadWrapperPid,
        },
      },
    });
    let releaseReceiptId: number;
    const resourceEvents = (await service.store.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => (
        event.provenance?.request_id === provenance.request_id
        && (event.payload as { effect?: unknown } | undefined)?.effect === "legacy_resource_settlement"
      ));
    expect(resourceEvents).toEqual([
      expect.objectContaining({ event: "reconcile_intent" }),
      expect.objectContaining({
        event: "reconcile_result",
        payload: expect.objectContaining({ outcome: "completed" }),
      }),
    ]);
    const released = await openStateStore();
    try {
      expect(listLeases(released.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(0);
      const releaseReceipt = listLeaseEvents(released.db, leaseKey).at(-1);
      expect(releaseReceipt).toMatchObject({
        event_type: "released",
        reason: expect.stringMatching(/^legacy-resource-settlement:[0-9a-f]{64}$/u),
        request_provenance: provenance,
      });
      releaseReceiptId = releaseReceipt!.event_id;
      expect((await service.store.readEvents(intent.run_id)).some((event) => (
        isRunServiceEvent(event)
        && (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === releaseReceiptId
      ))).toBe(false);
      expect(acquireLease(released.db, {
        key: leaseKey,
        holder_activity_id: "run:resource-competitor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:10:00.000Z",
      }).acquired).toBe(true);
    } finally {
      released.db.close();
    }

    const recoveryProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000013");
    const recovered = await service.reconcile({ provenance: recoveryProvenance });
    expect(recovered.skipped).toContain(intent.run_id);
    const recoveredEvents = (await service.store.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(recoveredEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconcile_intent",
        provenance: recoveryProvenance,
        payload: expect.objectContaining({ effect: "terminal_lease_release" }),
      }),
      expect.objectContaining({
        event: "reconciled",
        provenance: recoveryProvenance,
        payload: expect.objectContaining({
          lease_event_id: releaseReceiptId,
          lease_key: leaseKey,
          holder_activity_id: `run:${intent.run_id}`,
          release_request_id: provenance.request_id,
        }),
      }),
      expect.objectContaining({
        event: "reconcile_result",
        provenance: recoveryProvenance,
        payload: expect.objectContaining({
          effect: "terminal_lease_release",
          outcome: "completed",
        }),
      }),
    ]));
    expect(recoveredEvents.filter((event) => (
      (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === releaseReceiptId
    ))).toHaveLength(1);
    const successor = await openStateStore();
    try {
      expect(listLeases(successor.db, {
        holder_activity_id: "run:resource-competitor",
        include_expired: true,
      })).toEqual([expect.objectContaining({ key: leaseKey })]);
    } finally {
      successor.db.close();
    }

    const secondLeaseKey = "worktree:blade:/tmp/legacy-release-result-crash";
    const secondLease = await openStateStore();
    try {
      expect(acquireLease(secondLease.db, {
        key: secondLeaseKey,
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: "2026-03-11T12:11:00.000Z",
      }).acquired).toBe(true);
    } finally {
      secondLease.db.close();
    }
    const completionCrashProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000014");
    const originalAppendDurableEvent = service.store.appendDurableEvent.bind(service.store);
    let dropReleaseResult = true;
    const appendDurableEventSpy = vi.spyOn(service.store, "appendDurableEvent")
      .mockImplementation(async (runId, event) => {
        if (
          dropReleaseResult
          && isRunServiceEvent(event)
          && event.event === "reconcile_result"
          && event.provenance?.request_id === completionCrashProvenance.request_id
          && (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
        ) {
          dropReleaseResult = false;
          return;
        }
        await originalAppendDurableEvent(runId, event);
      });
    const observedWithoutResult = await service.reconcile({ provenance: completionCrashProvenance });
    expect(observedWithoutResult.skipped).toContain(intent.run_id);
    appendDurableEventSpy.mockRestore();

    let secondReleaseReceiptId: number;
    const secondReleased = await openStateStore();
    try {
      const secondReleaseReceipt = listLeaseEvents(secondReleased.db, secondLeaseKey).at(-1);
      expect(secondReleaseReceipt).toMatchObject({
        event_type: "released",
        request_provenance: completionCrashProvenance,
      });
      secondReleaseReceiptId = secondReleaseReceipt!.event_id;
      expect(acquireLease(secondReleased.db, {
        key: secondLeaseKey,
        holder_activity_id: "run:result-crash-successor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:12:00.000Z",
      }).acquired).toBe(true);
    } finally {
      secondReleased.db.close();
    }
    const beforeResultRecovery = (await service.store.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(beforeResultRecovery.filter((event) => (
      event.event === "reconciled"
      && (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === secondReleaseReceiptId
    ))).toHaveLength(1);
    expect(beforeResultRecovery.some((event) => (
      event.event === "reconcile_result"
      && event.provenance?.request_id === completionCrashProvenance.request_id
      && (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
    ))).toBe(false);

    const resultRecoveryProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000015");
    await service.reconcile({ provenance: resultRecoveryProvenance });
    const afterResultRecovery = (await service.store.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(afterResultRecovery.filter((event) => (
      event.event === "reconciled"
      && (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === secondReleaseReceiptId
    ))).toEqual([
      expect.objectContaining({ provenance: completionCrashProvenance }),
      expect.objectContaining({ provenance: resultRecoveryProvenance }),
    ]);
    expect(afterResultRecovery).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconcile_result",
        provenance: resultRecoveryProvenance,
        payload: expect.objectContaining({
          effect: "terminal_lease_release",
          outcome: "completed",
        }),
      }),
    ]));
    const afterRecoveryEffectCount = afterResultRecovery.filter((event) => (
      (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
    )).length;
    await service.reconcile({
      provenance: apiProvenance("req_00000000-0000-4000-8000-000000000016"),
    });
    expect((await service.store.readEvents(intent.run_id)).filter((event) => (
      isRunServiceEvent(event)
      && (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
    ))).toHaveLength(afterRecoveryEffectCount);
    const resultCrashSuccessor = await openStateStore();
    try {
      expect(listLeases(resultCrashSuccessor.db, {
        holder_activity_id: "run:result-crash-successor",
        include_expired: true,
      })).toEqual([expect.objectContaining({ key: secondLeaseKey })]);
    } finally {
      resultCrashSuccessor.db.close();
    }
  }), 15_000);

  test("terminal lease receipt recovery paginates beyond one thousand settled projections", async () => withTempStateHome(async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-lease-receipt-pagination",
      host: "local",
      prompt: "Recover every terminal lease receipt page",
      require_execplan: false,
    });
    await service.runInline(intent, { detached: false });

    const releaseProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000021");
    await applyStateMigrations();
    const opened = await openStateStore();
    let releaseReceipts: ReturnType<typeof releaseLeasesForTerminalRuns>["release_events"] = [];
    try {
      for (let index = 0; index < 1_001; index += 1) {
        expect(acquireLease(opened.db, {
          key: `worktree:blade:/tmp/paginated-terminal-${String(index).padStart(4, "0")}`,
          holder_activity_id: `run:${intent.run_id}`,
          ttl_ms: 60_000,
          now: "2026-03-11T12:20:00.000Z",
        }).acquired).toBe(true);
      }
      const release = releaseLeasesForTerminalRuns(opened.db, [intent.run_id], {
        now: "2026-03-11T12:21:00.000Z",
        request_provenance: releaseProvenance,
      });
      expect(release.released).toHaveLength(1_001);
      expect(release.release_events).toHaveLength(1_001);
      releaseReceipts = release.release_events;
      expect(acquireLease(opened.db, {
        key: releaseReceipts.at(-1)!.key,
        holder_activity_id: "run:pagination-successor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:22:00.000Z",
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }

    const settledProjectionProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000022");
    const paths = service.store.paths(intent.run_id);
    const existingEvents = await readFile(paths.eventsPath, "utf8");
    const settledProjectionEvents: RecordedRunEvent[] = [{
      timestamp: "2026-03-11T12:22:59.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "reconcile_intent",
      message: "Reconciliation intends to apply terminal_lease_release.",
      provenance: settledProjectionProvenance,
      payload: {
        correlation_id: settledProjectionProvenance.request_id,
        effect: "terminal_lease_release",
        batch_atomic: false,
      },
    }, ...releaseReceipts.slice(0, 1_000).map((receipt): RecordedRunEvent => ({
      timestamp: "2026-03-11T12:23:00.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "reconciled",
      message: `Recorded terminal-run DB lease release ${receipt.event_id} for ${receipt.key}.`,
      provenance: settledProjectionProvenance,
      payload: {
        reconcile: "terminal_lease_release",
        lease_event_id: receipt.event_id,
        lease_key: receipt.key,
        holder_activity_id: receipt.before_lease!.holder_activity_id,
        release_reason: receipt.reason,
        release_request_id: releaseProvenance.request_id,
      },
    }))];
    settledProjectionEvents.push({
      timestamp: "2026-03-11T12:23:01.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "reconcile_result",
      message: "Reconciliation observed terminal_lease_release complete.",
      provenance: settledProjectionProvenance,
      payload: {
        correlation_id: settledProjectionProvenance.request_id,
        effect: "terminal_lease_release",
        outcome: "completed",
        batch_atomic: false,
      },
    });
    await writeFile(
      paths.eventsPath,
      `${existingEvents}${settledProjectionEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const finalReceipt = releaseReceipts.at(-1)!;
    const recoveryProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000023");
    await service.reconcile({ provenance: recoveryProvenance });
    const recoveredEvents = (await service.store.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(recoveredEvents.filter((event) => (
      (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === finalReceipt.event_id
    ))).toEqual([
      expect.objectContaining({
        event: "reconciled",
        provenance: recoveryProvenance,
      }),
    ]);
    expect(recoveredEvents.filter((event) => (
      (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === releaseReceipts[0]!.event_id
    ))).toHaveLength(1);

    const terminalEffectCount = recoveredEvents.filter((event) => (
      (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
    )).length;
    await service.reconcile({
      provenance: apiProvenance("req_00000000-0000-4000-8000-000000000024"),
    });
    expect((await service.store.readEvents(intent.run_id)).filter((event) => (
      isRunServiceEvent(event)
      && (event.payload as { effect?: unknown } | undefined)?.effect === "terminal_lease_release"
    ))).toHaveLength(terminalEffectCount);
    const successor = await openStateStore();
    try {
      expect(listLeases(successor.db, {
        holder_activity_id: "run:pagination-successor",
        include_expired: true,
      })).toEqual([expect.objectContaining({ key: finalReceipt.key })]);
    } finally {
      successor.db.close();
    }

    const malformedChronologyKey = "worktree:blade:/tmp/missing-terminal-release-intent";
    const malformedChronologyProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000025");
    const malformedChronology = await openStateStore();
    let malformedChronologyReceiptId = 0;
    try {
      expect(acquireLease(malformedChronology.db, {
        key: malformedChronologyKey,
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: "2026-03-11T12:24:00.000Z",
      }).acquired).toBe(true);
      const release = releaseLeasesForTerminalRuns(malformedChronology.db, [intent.run_id], {
        now: "2026-03-11T12:25:00.000Z",
        request_provenance: malformedChronologyProvenance,
      });
      malformedChronologyReceiptId = release.release_events[0]!.event_id;
      expect(acquireLease(malformedChronology.db, {
        key: malformedChronologyKey,
        holder_activity_id: "run:malformed-chronology-successor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:26:00.000Z",
      }).acquired).toBe(true);
    } finally {
      malformedChronology.db.close();
    }
    await service.store.appendEvent(intent.run_id, {
      timestamp: "2026-03-11T12:27:00.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "reconciled",
      message: "Forged observation without its required intent.",
      provenance: malformedChronologyProvenance,
      payload: {
        reconcile: "terminal_lease_release",
        lease_event_id: malformedChronologyReceiptId,
        lease_key: malformedChronologyKey,
      },
    });
    await service.store.appendEvent(intent.run_id, {
      timestamp: "2026-03-11T12:27:01.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "reconcile_result",
      message: "Forged completion without its required intent.",
      provenance: malformedChronologyProvenance,
      payload: {
        correlation_id: malformedChronologyProvenance.request_id,
        effect: "terminal_lease_release",
        outcome: "completed",
        batch_atomic: false,
      },
    });
    const chronologyRecoveryProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000026");
    await service.reconcile({ provenance: chronologyRecoveryProvenance });
    expect((await service.store.readEvents(intent.run_id)).filter((event) => (
      isRunServiceEvent(event)
      && event.event === "reconciled"
      && (event.payload as { lease_event_id?: unknown } | undefined)?.lease_event_id === malformedChronologyReceiptId
    ))).toEqual([
      expect.objectContaining({ provenance: malformedChronologyProvenance }),
      expect.objectContaining({ provenance: chronologyRecoveryProvenance }),
    ]);
    const malformedSuccessor = await openStateStore();
    try {
      expect(listLeases(malformedSuccessor.db, {
        holder_activity_id: "run:malformed-chronology-successor",
        include_expired: true,
      })).toEqual([expect.objectContaining({ key: malformedChronologyKey })]);
    } finally {
      malformedSuccessor.db.close();
    }
  }), 30_000);

  test("legacy admission refuses execute-stored and detached replay before mutex contention can publish false adoption", async () => {
    const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
    const spawnWorker = vi.fn(async () => ({ pid: 45_680, supervisor: "direct" as const }));
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      resolveExecutionKernel,
      spawnWorker,
      observeLegacyWorkerPid: async () => "possibly_live",
    });
    const intent = service.createIntent({
      run_id: "run-legacy-effect-admission-denied",
      host: "local",
      prompt: "Never execute this historical admission twice",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    await writeFile(join(service.store.paths(intent.run_id).runDir, "pid"), `${process.pid}\n`, "utf8");
    const stored: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "queued",
      updated_at: launchedAt,
    };
    delete stored.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(stored, null, 2)}\n`,
      "utf8",
    );
    const sibling = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "possibly_live",
    });
    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);

    let signalExecuteRead!: () => void;
    let releaseExecuteRead!: () => void;
    const executeReadStarted = new Promise<void>((resolve) => { signalExecuteRead = resolve; });
    const executeReadRelease = new Promise<void>((resolve) => { releaseExecuteRead = resolve; });
    const executeRead = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async (runId) => {
      signalExecuteRead();
      await executeReadRelease;
      return originalReadRunRecord(runId);
    });
    const refusedExecution = service.executeStoredRun(intent.run_id);
    await executeReadStarted;
    const executeConcurrentReconcile = await sibling.reconcile();
    releaseExecuteRead();
    await expect(refusedExecution).rejects.toBeInstanceOf(RunExecutionSettlementPendingError);
    executeRead.mockRestore();

    let signalReplayRead!: () => void;
    let releaseReplayRead!: () => void;
    const replayReadStarted = new Promise<void>((resolve) => { signalReplayRead = resolve; });
    const replayReadRelease = new Promise<void>((resolve) => { releaseReplayRead = resolve; });
    const replayRead = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async (runId) => {
      signalReplayRead();
      await replayReadRelease;
      return originalReadRunRecord(runId);
    });
    const replayPromise = service.submitDetached(intent);
    await replayReadStarted;
    const replayConcurrentReconcile = await sibling.reconcile();
    releaseReplayRead();
    const replay = await replayPromise;
    replayRead.mockRestore();

    let signalInlineRead!: () => void;
    let releaseInlineRead!: () => void;
    const inlineReadStarted = new Promise<void>((resolve) => { signalInlineRead = resolve; });
    const inlineReadRelease = new Promise<void>((resolve) => { releaseInlineRead = resolve; });
    const inlineRead = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async (runId) => {
      signalInlineRead();
      await inlineReadRelease;
      return originalReadRunRecord(runId);
    });
    const refusedInline = service.runInline(intent, { detached: false });
    await inlineReadStarted;
    const inlineConcurrentReconcile = await sibling.reconcile();
    releaseInlineRead();
    await expect(refusedInline).rejects.toBeInstanceOf(RunExecutionSettlementPendingError);
    inlineRead.mockRestore();

    expect(executeConcurrentReconcile.skipped).not.toContain(intent.run_id);
    expect(executeConcurrentReconcile.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(executeConcurrentReconcile.adopted).not.toContain(intent.run_id);
    expect(replayConcurrentReconcile.skipped).not.toContain(intent.run_id);
    expect(replayConcurrentReconcile.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(replayConcurrentReconcile.adopted).not.toContain(intent.run_id);
    expect(inlineConcurrentReconcile.skipped).not.toContain(intent.run_id);
    expect(inlineConcurrentReconcile.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(inlineConcurrentReconcile.adopted).not.toContain(intent.run_id);
    const eventsAfterConcurrentReconcile = await service.store.readEvents(intent.run_id);
    expect(eventsAfterConcurrentReconcile.some((event) => (
      isRunServiceEvent(event)
      && event.event === "reconciled"
      && ["sqlite_dispatch_mutex", "sqlite_execution_mutex"].includes(
        String((event.payload as { authority?: unknown } | undefined)?.authority),
      )
    ))).toBe(false);

    await expect(service.submitDetached({
      ...intent,
      prompt: "A different request must not inherit the historical admission",
    })).rejects.toBeInstanceOf(RunAlreadyExistsError);

    expect(replay.record).toMatchObject({
      run_id: intent.run_id,
      state: "queued",
    });
    expect(replay.record.launch).not.toHaveProperty("execution_id");
    expect(resolveExecutionKernel).not.toHaveBeenCalled();
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(await service.store.readEvents(intent.run_id)).toEqual(eventsAfterConcurrentReconcile);
  });

  test("damaged settlement markers refuse every execution mode before mutex contention can publish false adoption", async () => {
    const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
    const spawnWorker = vi.fn(async () => ({ pid: 45_681, supervisor: "direct" as const }));
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      resolveExecutionKernel,
      spawnWorker,
    });
    const intent = service.createIntent({
      run_id: "run-damaged-legacy-settlement-admission",
      host: "local",
      prompt: "Settlement markers are permanent execution barriers",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      recovery: {
        ...queued.recovery,
        owner_free_settlement: {
          schema_version: "calyx.owner-free-settlement/v1",
          authority: "legacy_pid_dead",
          authority_id: "0".repeat(64),
          settled_at: "2026-03-11T12:00:01.000Z",
          reason_code: "legacy_detached_worker_observed_dead",
          legacy_pid: 45_681,
        },
      },
    });
    const sibling = new RunService({ runsRoot }, buildDeps());
    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);

    const assertPreMutexBarrier = async (action: () => Promise<unknown>): Promise<void> => {
      let signalRead!: () => void;
      let releaseRead!: () => void;
      const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
      const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
      const read = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async (runId) => {
        signalRead();
        await readRelease;
        return originalReadRunRecord(runId);
      });
      const refused = action();
      await readStarted;
      const reconciled = await sibling.reconcile();
      releaseRead();
      await expect(refused).rejects.toBeInstanceOf(RunExecutionSettlementPendingError);
      read.mockRestore();
      expect(reconciled.skipped).not.toContain(intent.run_id);
      expect(reconciled.unresolved).toContainEqual({
        run_id: intent.run_id,
        reason: "legacy_owner_settlement_pending",
      });
      expect(reconciled.adopted).not.toContain(intent.run_id);
    };

    await assertPreMutexBarrier(() => service.executeStoredRun(intent.run_id));
    await assertPreMutexBarrier(() => service.submitDetached(intent));
    await assertPreMutexBarrier(() => service.runInline(intent, { detached: false }));

    expect(resolveExecutionKernel).not.toHaveBeenCalled();
    expect(spawnWorker).not.toHaveBeenCalled();
    expect((await service.store.readEvents(intent.run_id)).some((event) => (
      isRunServiceEvent(event)
      && event.event === "reconciled"
      && ["sqlite_dispatch_mutex", "sqlite_execution_mutex"].includes(
        String((event.payload as { authority?: unknown } | undefined)?.authority),
      )
    ))).toBe(false);
  });

  test("reconcile rechecks a legacy generation that appears after execution preflight but before mutex observation", async () => {
    for (const mode of ["detached", "inline", "execute"] as const) {
      const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
      const spawnWorker = vi.fn(async () => ({ pid: 45_682, supervisor: "direct" as const }));
      const service = new RunService({
        runsRoot,
        workerEntrypoint: "/tmp/calyx-worker",
      }, {
        ...buildDeps(),
        resolveExecutionKernel,
        spawnWorker,
      });
      const intent = service.createIntent({
        run_id: `run-legacy-transition-${mode}`,
        host: "local",
        prompt: `Observe a ${mode} preflight-to-lock generation change`,
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "detached" });
      const paths = service.store.paths(intent.run_id);
      const launchedAt = "2026-03-11T12:00:01.000Z";
      const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
        ...queued,
        state: "queued",
        updated_at: launchedAt,
      };
      delete legacyRecord.launch;
      if (mode !== "execute") {
        await rm(paths.runDir, { recursive: true, force: true });
      }

      const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
      let signalLockedRead!: () => void;
      let releaseLockedRead!: () => void;
      const lockedReadStarted = new Promise<void>((resolve) => { signalLockedRead = resolve; });
      const lockedReadRelease = new Promise<void>((resolve) => { releaseLockedRead = resolve; });
      const read = vi.spyOn(service.store, "readRunRecord")
        .mockResolvedValueOnce(mode === "execute" ? queued : undefined)
        .mockImplementationOnce(async (runId) => {
          signalLockedRead();
          await lockedReadRelease;
          return originalReadRunRecord(runId);
        });
      const actionPromise = mode === "detached"
        ? service.submitDetached(intent)
        : mode === "inline"
          ? service.runInline(intent, { detached: false })
          : service.executeStoredRun(intent.run_id);
      const action = actionPromise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      await lockedReadStarted;
      await mkdir(paths.runDir, { recursive: true });
      await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
      await writeFile(paths.eventsPath, `${JSON.stringify({
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: 45_682, worker_supervisor: "direct" },
      })}\n`, "utf8");
      await writeFile(join(paths.runDir, "pid"), "45682\n", "utf8");

      const sibling = new RunService({ runsRoot }, {
        ...buildDeps(),
        observeLegacyWorkerPid: async () => "possibly_live",
      });
      const reconciled = await sibling.reconcile();
      releaseLockedRead();
      const outcome = await action;
      if (mode === "detached") {
        expect(outcome).toMatchObject({
          status: "fulfilled",
          value: { run_id: intent.run_id },
        });
      } else {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: expect.any(RunExecutionSettlementPendingError),
        });
      }
      read.mockRestore();

      expect(reconciled.skipped).not.toContain(intent.run_id);
      expect(reconciled.unresolved).toContainEqual({
        run_id: intent.run_id,
        reason: "legacy_publication_authority_unproven",
      });
      expect(reconciled.adopted).not.toContain(intent.run_id);
      expect(resolveExecutionKernel).not.toHaveBeenCalled();
      expect(spawnWorker).not.toHaveBeenCalled();
      expect((await sibling.store.readEvents(intent.run_id)).some((event) => (
        isRunServiceEvent(event)
        && event.event === "reconciled"
        && ["sqlite_dispatch_mutex", "sqlite_execution_mutex"].includes(
          String((event.payload as { authority?: unknown } | undefined)?.authority),
        )
      ))).toBe(false);
    }
  });

  test("execute-stored refuses a legacy generation that appears before contended ownership returns", async () => {
    const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      resolveExecutionKernel,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-transition-contended-execute",
      host: "local",
      prompt: "Do not return a reserved generation as ordinary contention",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const paths = service.store.paths(intent.run_id);
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;

    let signalOwnership!: () => void;
    let releaseOwnership!: () => void;
    const ownershipStarted = new Promise<void>((resolve) => { signalOwnership = resolve; });
    const ownershipRelease = new Promise<void>((resolve) => { releaseOwnership = resolve; });
    const heldOwnership = withSqliteMutex(paths.executionMutexPath, async () => {
      signalOwnership();
      await ownershipRelease;
    });
    await ownershipStarted;

    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
    let signalPreflight!: () => void;
    let releasePreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => { signalPreflight = resolve; });
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const read = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async () => {
      signalPreflight();
      await preflightRelease;
      return queued;
    });
    const outcomePromise = service.executeStoredRun(intent.run_id).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await preflightStarted;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await writeFile(paths.eventsPath, `${JSON.stringify({
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: 45_683, worker_supervisor: "direct" },
    })}\n`, "utf8");
    await writeFile(join(paths.runDir, "pid"), "45683\n", "utf8");
    releasePreflight();

    const outcome = await outcomePromise;
    releaseOwnership();
    await heldOwnership;
    read.mockRestore();

    expect(outcome).toMatchObject({
      status: "rejected",
      reason: expect.any(RunExecutionSettlementPendingError),
    });
    expect(resolveExecutionKernel).not.toHaveBeenCalled();
    expect(await originalReadRunRecord(intent.run_id)).toMatchObject({
      run_id: intent.run_id,
      state: "running",
    });
  });

  test("legacy execute-stored and detached replay refuse mismatched identity before classification writes", async () => {
    const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      resolveExecutionKernel,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-mismatched-effect-boundary",
      host: "local",
      prompt: "Preserve the old publisher despite record damage",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const stored: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      run_id: "foreign-legacy-record",
      state: "running",
    };
    delete stored.launch;
    const paths = service.store.paths(intent.run_id);
    await writeFile(paths.runRecordPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    const before = await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ]);

    await expect(service.executeStoredRun(intent.run_id)).rejects.toBeInstanceOf(
      RunExecutionSettlementPendingError,
    );
    await expect(service.submitDetached(intent)).rejects.toThrow(
      /contains mismatched record identity: record\.run_id=foreign-legacy-record/u,
    );

    expect(resolveExecutionKernel).not.toHaveBeenCalled();
    expect(await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ])).toEqual(before);
  });

  test("reconcile retains a legacy settlement barrier that appears at the owned mismatched-identity reread", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-mismatched-identity-settlement-race",
      host: "local",
      prompt: "Do not false-complete across a late settlement marker",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const paths = service.store.paths(intent.run_id);
    const mismatched = {
      ...queued,
      run_id: "foreign-mismatched-identity-settlement-race",
    };
    await writeFile(paths.runRecordPath, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
    const marked = {
      ...mismatched,
      recovery: {
        ...mismatched.recovery,
        owner_free_settlement: {
          schema_version: "calyx.owner-free-settlement/v1",
          authority: "legacy_pid_dead",
          authority_id: "0".repeat(64),
          settled_at: "2026-03-11T12:00:01.000Z",
          reason_code: "legacy_detached_worker_observed_dead",
          legacy_pid: 45_691,
        },
      },
    };
    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
    let targetReadCount = 0;
    let signalOwnedRead!: () => void;
    let releaseOwnedRead!: () => void;
    const ownedReadStarted = new Promise<void>((resolve) => { signalOwnedRead = resolve; });
    const ownedReadRelease = new Promise<void>((resolve) => { releaseOwnedRead = resolve; });
    const read = vi.spyOn(service.store, "readRunRecord").mockImplementation(async (candidateRunId) => {
      if (candidateRunId === intent.run_id && ++targetReadCount === 2) {
        signalOwnedRead();
        await ownedReadRelease;
      }
      return originalReadRunRecord(candidateRunId);
    });

    const reconcilePromise = service.reconcile();
    await ownedReadStarted;
    await writeFile(paths.runRecordPath, `${JSON.stringify(marked, null, 2)}\n`, "utf8");
    releaseOwnedRead();
    const reconciled = await reconcilePromise;
    read.mockRestore();

    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_owner_settlement_pending",
    }]);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.adopted).not.toContain(intent.run_id);
    expect(reconciled.projection).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("mismatched identity"),
    });
    await expect(readFile(paths.runRecordPath, "utf8"))
      .resolves.toBe(`${JSON.stringify(marked, null, 2)}\n`);
  });

  test("current detached admission with legacy-shaped launch evidence remains redispatchable", async () => {
    const workerExecutions: Array<Promise<RunRecord>> = [];
    const spawnWorker = vi.fn(async (args: { runId: string }) => {
      workerExecutions.push(service.executeStoredRun(args.runId));
      return { pid: 45_681, supervisor: "direct" as const };
    });
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      spawnWorker,
    });
    const intent = service.createIntent({
      run_id: "run-current-pre-registration-crash",
      host: "local",
      prompt: "Repair the current mutex generation",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      launch: {
        ...queued.launch,
        stage: "dispatching",
        dispatch_attempts: 1,
        last_dispatch_at: launchedAt,
      },
      updated_at: launchedAt,
    });
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: 45_681, worker_supervisor: "direct" },
    });

    const reconciled = await service.reconcile();

    expect(reconciled.adopted).toContain(intent.run_id);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(spawnWorker).toHaveBeenCalledOnce();
    await expect(workerExecutions[0]).resolves.toMatchObject({ state: "succeeded" });
  });

  test("possibly-live legacy publisher retains partial receipt and PID bytes without reconciliation writes", async () => {
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "possibly_live",
    });
    const intent = service.createIntent({
      run_id: "run-legacy-partial-receipt",
      host: "local",
      prompt: "Preserve my in-flight receipt publication",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await writeFile(paths.kernelReceiptPath, '{"schema_version":"1.0",\n', "utf8");
    await writeFile(join(paths.runDir, "pid"), `${process.pid}\n`, "utf8");
    const before = await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.kernelReceiptPath, "utf8"),
      readFile(join(paths.runDir, "pid"), "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ]);

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.kernelReceiptPath, "utf8"),
      readFile(join(paths.runDir, "pid"), "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ])).toEqual(before);
  });

  test("HTTP reconcile envelopes an authoritative legacy receipt repair after correspondence is proven", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-authoritative-receipt-provenance",
      host: "local",
      prompt: "Adopt my durable pre-mutex receipt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const completedAt = "2026-03-11T12:00:02.000Z";
    const spec = await resolveRunIntent(intent, { now: () => queued.launch.accepted_at });
    const receipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, spec.backend),
      "succeeded",
      {
        timing: {
          created_at: intent.created_at,
          completed_at: completedAt,
        },
      },
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await writeFile(join(paths.runDir, "pid"), `${process.pid}\n`, "utf8");
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000010");

    const reconciled = await service.reconcile({ provenance });

    expect(reconciled.rebuilt).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    await expect(stat(join(paths.runDir, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    const reconcileEvents = (await service.store.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => event.event === "reconcile_intent" || event.event === "reconcile_result");
    expect(reconcileEvents).toHaveLength(2);
    expect(reconcileEvents[0]).toMatchObject({
      event: "reconcile_intent",
      provenance,
      payload: {
        correlation_id: provenance.request_id,
        effect: "legacy_record_rebuild_from_receipt",
        batch_atomic: false,
      },
    });
    expect(reconcileEvents[1]).toMatchObject({
      event: "reconcile_result",
      provenance,
      payload: {
        correlation_id: provenance.request_id,
        effect: "legacy_record_rebuild_from_receipt",
        outcome: "completed",
        batch_atomic: false,
      },
    });

    // Model a crash after every terminal projection became current but before
    // the historical PID marker was retired. The retry must durably announce
    // that cleanup before unlinking the evidence and publish its result after.
    await writeFile(join(paths.runDir, "pid"), `${process.pid}\n`, "utf8");
    const retirementProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000011");
    const originalAppendDurableEvent = service.store.appendDurableEvent.bind(service.store);
    const boundaryPidPresence: Array<{ event: string; present: boolean }> = [];
    vi.spyOn(service.store, "appendDurableEvent").mockImplementation(async (runId, event) => {
      await originalAppendDurableEvent(runId, event);
      if (
        isRunServiceEvent(event)
        && event.provenance?.request_id === retirementProvenance.request_id
        && (event.event === "reconcile_intent" || event.event === "reconcile_result")
      ) {
        let present = true;
        try {
          await stat(join(paths.runDir, "pid"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          present = false;
        }
        boundaryPidPresence.push({ event: event.event, present });
      }
    });

    const stable = await service.reconcile({ provenance: retirementProvenance });

    expect(stable.skipped).toContain(intent.run_id);
    expect(boundaryPidPresence).toEqual([
      { event: "reconcile_intent", present: true },
      { event: "reconcile_result", present: false },
    ]);
    await expect(stat(join(paths.runDir, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    const retirementEvents = (await service.store.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => event.provenance?.request_id === retirementProvenance.request_id);
    expect(retirementEvents).toEqual([
      expect.objectContaining({
        event: "reconcile_intent",
        payload: expect.objectContaining({ effect: "legacy_pid_evidence_retirement" }),
      }),
      expect.objectContaining({
        event: "reconcile_result",
        payload: expect.objectContaining({
          effect: "legacy_pid_evidence_retirement",
          outcome: "completed",
        }),
      }),
    ]);
  });

  test("terminal legacy embedded receipt cannot substitute for missing durable receipt authority", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-terminal-missing-durable-receipt",
      host: "local",
      prompt: "Require the durable receipt authority",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const completedAt = "2026-03-11T12:00:02.000Z";
    const embeddedReceipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, "codex"),
      "succeeded",
      {
        timing: { created_at: queued.created_at, completed_at: completedAt },
      },
    );
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "succeeded",
      kernel_receipt: embeddedReceipt,
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: completedAt,
      completed_at: completedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    const recordBefore = await readFile(paths.runRecordPath, "utf8");
    const eventsBefore = await readFile(paths.eventsPath, "utf8");

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(reconciled.classified).not.toContain(intent.run_id);
    await expect(service.store.readKernelReceipt(intent.run_id)).resolves.toBeUndefined();
    await expect(readFile(paths.runRecordPath, "utf8")).resolves.toBe(recordBefore);
    await expect(readFile(paths.eventsPath, "utf8")).resolves.toBe(eventsBefore);
  });

  test("reconcile reports a missing canonical record when a terminal legacy record disappears at the owned reread", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const runId = "run-legacy-terminal-owned-read-missing";
    const fixture = await prepareLegacyEmbeddedReceiptRace(service, runId);
    await writeFile(
      fixture.paths.runRecordPath,
      `${JSON.stringify(fixture.terminalRecord, null, 2)}\n`,
      "utf8",
    );
    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
    let targetReadCount = 0;
    let signalOwnedRead!: () => void;
    let releaseOwnedRead!: () => void;
    const ownedReadStarted = new Promise<void>((resolve) => { signalOwnedRead = resolve; });
    const ownedReadRelease = new Promise<void>((resolve) => { releaseOwnedRead = resolve; });
    const read = vi.spyOn(service.store, "readRunRecord").mockImplementation(async (candidateRunId) => {
      if (candidateRunId === runId && ++targetReadCount === 2) {
        signalOwnedRead();
        await ownedReadRelease;
      }
      return originalReadRunRecord(candidateRunId);
    });

    const reconcilePromise = service.reconcile();
    await ownedReadStarted;
    await rm(fixture.paths.runRecordPath);
    releaseOwnedRead();
    const reconciled = await reconcilePromise;
    read.mockRestore();

    expect(reconciled.unresolved).toEqual([{
      run_id: runId,
      reason: "canonical_run_record_missing",
    }]);
    expect(reconciled.skipped).not.toContain(runId);
    expect(reconciled.classified).not.toContain(runId);
    expect(reconciled.adopted).not.toContain(runId);
    await expect(service.store.readKernelReceipt(runId)).resolves.toBeUndefined();
  });

  test.each(["initial", "directory_missing", "terminal_owned", "dispatch_owned"] as const)(
    "reconcile keeps the last-known run index row and reports direct canonical record damage on the %s schedule",
    async (schedule) => withTempStateHome(async () => {
      await applyStateMigrations();
      const projection = new RunIndexProjection();
      try {
        const service = new RunService(
          { runsRoot, subscribers: [], runIndex: projection },
          buildDeps(),
        );
        const runId = `run-canonical-record-missing-${schedule}`;
        const intent = service.createIntent({
          run_id: runId,
          host: "local",
          prompt: "Keep this damaged run visible until disposition is proven",
          require_execplan: false,
        });
        const queued = await service.initializeRun(intent, { launchMode: "detached" });
        if (schedule === "terminal_owned") {
          await service.store.writeRunRecord(runId, {
            ...queued,
            state: "succeeded",
            summary: `Run ${runId} succeeded.`,
            updated_at: "2026-03-11T12:00:02.000Z",
            completed_at: "2026-03-11T12:00:02.000Z",
          });
        }
        const expectedIndexRow = await projection.readEntry(runId);
        expect(expectedIndexRow).toBeDefined();

        let reconcilePromise: Promise<Awaited<ReturnType<RunService["reconcile"]>>>;
        if (schedule === "initial" || schedule === "directory_missing") {
          if (schedule === "directory_missing") {
            await rm(service.store.paths(runId).runDir, { recursive: true, force: true });
          } else {
            await rm(service.store.paths(runId).runRecordPath);
          }
          reconcilePromise = service.reconcile();
        } else {
          const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
          let targetReadCount = 0;
          let signalOwnedRead!: () => void;
          let releaseOwnedRead!: () => void;
          const ownedReadStarted = new Promise<void>((resolve) => { signalOwnedRead = resolve; });
          const ownedReadRelease = new Promise<void>((resolve) => { releaseOwnedRead = resolve; });
          const read = vi.spyOn(service.store, "readRunRecord").mockImplementation(
            async (candidateRunId) => {
              if (candidateRunId === runId && ++targetReadCount === 2) {
                signalOwnedRead();
                await ownedReadRelease;
              }
              return originalReadRunRecord(candidateRunId);
            },
          );
          reconcilePromise = service.reconcile();
          await ownedReadStarted;
          await rm(service.store.paths(runId).runRecordPath);
          releaseOwnedRead();
          await reconcilePromise.finally(() => read.mockRestore());
        }

        const reconciled = await reconcilePromise;
        expect(reconciled.unresolved).toContainEqual({
          run_id: runId,
          reason: "canonical_run_record_missing",
        });
        expect(reconciled.skipped).not.toContain(runId);
        expect(reconciled.classified).not.toContain(runId);
        expect(reconciled.adopted).not.toContain(runId);
        expect(reconciled.rebuilt).not.toContain(runId);
        expect(reconciled.projection).toMatchObject({ status: "repaired" });
        await expect(projection.readEntry(runId)).resolves.toEqual(expectedIndexRow);
        expect((await service.store.listRuns()).map((entry) => entry.run_id)).toContain(runId);
      } finally {
        projection.close();
      }
    }),
  );

  test("the final index rebuild preserves and reports a record that disappears after its last reconciliation read", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const projection = new RunIndexProjection();
    try {
      const service = new RunService(
        { runsRoot, subscribers: [], runIndex: projection },
        buildDeps(),
      );
      const intent = service.createIntent({
        run_id: "run-canonical-record-late-disappearance",
        host: "local",
        prompt: "Do not evict a late-damaged projection",
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "detached" });
      await service.store.writeRunRecord(intent.run_id, {
        ...queued,
        state: "succeeded",
        summary: `Run ${intent.run_id} succeeded.`,
        updated_at: "2026-03-11T12:00:02.000Z",
        completed_at: "2026-03-11T12:00:02.000Z",
      });
      const expectedIndexRow = await projection.readEntry(intent.run_id);
      expect(expectedIndexRow).toBeDefined();

      const originalRebuild = service.store.rebuildRunIndex.bind(service.store);
      const rebuild = vi.spyOn(service.store, "rebuildRunIndex").mockImplementationOnce(async () => {
        await rm(service.store.paths(intent.run_id).runRecordPath);
        return originalRebuild();
      });
      const reconciled = await service.reconcile();
      rebuild.mockRestore();

      expect(reconciled.unresolved).toContainEqual({
        run_id: intent.run_id,
        reason: "canonical_run_record_missing",
      });
      expect(reconciled.projection).toMatchObject({ status: "repaired" });
      await expect(projection.readEntry(intent.run_id)).resolves.toEqual(expectedIndexRow);
    } finally {
      projection.close();
    }
  }));

  test.each(["terminal", "missing"] as const)(
    "reconcile retains unresolved legacy authority when the mutex-owned record becomes %s",
    async (transition) => {
      const service = new RunService({ runsRoot }, {
        ...buildDeps(),
        observeLegacyWorkerPid: async () => "dead",
        observeLegacyWorkerProcessGroup: async () => "dead",
      });
      const runId = `run-legacy-owned-read-${transition}`;
      const fixture = await prepareLegacyEmbeddedReceiptRace(service, runId);
      const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
      let targetReadCount = 0;
      let signalOwnedRead!: () => void;
      let releaseOwnedRead!: () => void;
      const ownedReadStarted = new Promise<void>((resolve) => { signalOwnedRead = resolve; });
      const ownedReadRelease = new Promise<void>((resolve) => { releaseOwnedRead = resolve; });
      const read = vi.spyOn(service.store, "readRunRecord").mockImplementation(async (candidateRunId) => {
        if (candidateRunId === runId && ++targetReadCount === 2) {
          signalOwnedRead();
          await ownedReadRelease;
        }
        return originalReadRunRecord(candidateRunId);
      });

      const reconcilePromise = service.reconcile();
      await ownedReadStarted;
      if (transition === "terminal") {
        await writeFile(
          fixture.paths.runRecordPath,
          `${JSON.stringify(fixture.terminalRecord, null, 2)}\n`,
          "utf8",
        );
      } else {
        await rm(fixture.paths.runRecordPath);
      }
      releaseOwnedRead();
      const reconciled = await reconcilePromise;
      read.mockRestore();

      expect(reconciled.unresolved).toEqual([{
        run_id: runId,
        reason: transition === "missing"
          ? "canonical_run_record_missing"
          : "legacy_publication_authority_unproven",
      }]);
      expect(reconciled.skipped).not.toContain(runId);
      expect(reconciled.classified).not.toContain(runId);
      expect(reconciled.adopted).not.toContain(runId);
      await expect(service.store.readKernelReceipt(runId)).resolves.toBeUndefined();
      if (transition === "terminal") {
        await expect(service.getRunRecord(runId)).resolves.toMatchObject({
          state: "succeeded",
          kernel_receipt: fixture.embeddedReceipt,
        });
      }
    },
  );

  test("reconcile retains unresolved legacy authority when the record changes during the worker probe", async () => {
    let signalProbe!: () => void;
    let releaseProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => { signalProbe = resolve; });
    const probeRelease = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => {
        signalProbe();
        await probeRelease;
        return "dead";
      },
      observeLegacyWorkerProcessGroup: async () => "dead",
    });
    const runId = "run-legacy-post-probe-change";
    const fixture = await prepareLegacyEmbeddedReceiptRace(service, runId);

    const reconcilePromise = service.reconcile();
    await probeStarted;
    await writeFile(
      fixture.paths.runRecordPath,
      `${JSON.stringify({
        ...fixture.runningRecord,
        updated_at: "2026-03-11T12:00:01.500Z",
      }, null, 2)}\n`,
      "utf8",
    );
    releaseProbe();
    const reconciled = await reconcilePromise;

    expect(reconciled.unresolved).toEqual([{
      run_id: runId,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(reconciled.skipped).not.toContain(runId);
    expect(reconciled.classified).not.toContain(runId);
    expect(reconciled.adopted).not.toContain(runId);
    await expect(service.store.readKernelReceipt(runId)).resolves.toBeUndefined();
    await expect(service.getRunRecord(runId)).resolves.toMatchObject({
      state: "running",
      kernel_receipt: fixture.embeddedReceipt,
      updated_at: "2026-03-11T12:00:01.500Z",
    });
  });

  test("reconcile retains unresolved legacy authority when the record disappears before final classification", async () => {
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "dead",
      observeLegacyWorkerProcessGroup: async () => "dead",
    });
    const runId = "run-legacy-final-classification-missing";
    const fixture = await prepareLegacyEmbeddedReceiptRace(service, runId);
    const originalReadKernelReceipt = service.store.readKernelReceipt.bind(service.store);
    let signalReceiptRead!: () => void;
    let releaseReceiptRead!: () => void;
    const receiptReadStarted = new Promise<void>((resolve) => { signalReceiptRead = resolve; });
    const receiptReadRelease = new Promise<void>((resolve) => { releaseReceiptRead = resolve; });
    const readReceipt = vi.spyOn(service.store, "readKernelReceipt").mockImplementationOnce(async (candidateRunId) => {
      signalReceiptRead();
      await receiptReadRelease;
      return originalReadKernelReceipt(candidateRunId);
    });

    const reconcilePromise = service.reconcile();
    await receiptReadStarted;
    await rm(fixture.paths.runRecordPath);
    releaseReceiptRead();
    const reconciled = await reconcilePromise;
    readReceipt.mockRestore();

    expect(reconciled.unresolved).toEqual([{
      run_id: runId,
      reason: "canonical_run_record_missing",
    }]);
    expect(reconciled.skipped).not.toContain(runId);
    expect(reconciled.classified).not.toContain(runId);
    expect(reconciled.adopted).not.toContain(runId);
    await expect(service.store.readKernelReceipt(runId)).resolves.toBeUndefined();
  });

  test("terminal legacy publisher with a valid embedded receipt and partial durable receipt retains its lease and event bytes", async () => withTempStateHome(async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-terminal-partial-receipt",
      host: "local",
      prompt: "Do not garbage-collect beneath my terminal publication",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const completedAt = "2026-03-11T12:00:02.000Z";
    const embeddedReceipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, "codex"),
      "succeeded",
      {
        timing: { created_at: queued.created_at, completed_at: completedAt },
      },
    );
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "succeeded",
      kernel_receipt: embeddedReceipt,
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: completedAt,
      completed_at: completedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await writeFile(paths.kernelReceiptPath, '{"schema_version":"1.0",\n', "utf8");
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(acquireLease(opened.db, {
        key: "session:codex:blade:legacy-terminal-publication",
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: launchedAt,
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }
    const before = await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.kernelReceiptPath, "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ]);

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(await Promise.all([
      readFile(paths.runRecordPath, "utf8"),
      readFile(paths.kernelReceiptPath, "utf8"),
      readFile(paths.eventsPath, "utf8"),
    ])).toEqual(before);
    const after = await openStateStore();
    try {
      expect(listLeases(after.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      after.db.close();
    }
  }));

  test("corrupt legacy event journal remains in place while an unfenced publisher may still own it", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-corrupt-live-journal",
      host: "local",
      prompt: "Do not quarantine beneath my old writer",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const paths = service.store.paths(intent.run_id);
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: process.pid, worker_supervisor: "direct" },
    });
    await writeFile(paths.eventsPath, `${await readFile(paths.eventsPath, "utf8")}{"malformed":\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await writeFile(join(paths.runDir, "pid"), `${process.pid}\n`, "utf8");
    const journalBefore = await readFile(paths.eventsPath, "utf8");

    const reconciled = await service.reconcile();

    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.projection).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("unfenced legacy publisher"),
    });
    expect(await readFile(paths.eventsPath, "utf8")).toBe(journalBefore);
    expect((await readdir(paths.runDir)).some((entry) => entry.startsWith("events.jsonl.corrupt."))).toBe(false);
  });

  test("corrupt-journal reconcile retains pending resource settlement when the owned record disappears", async () => withTempStateHome(async () => {
    const deadPid = 45_692;
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "dead",
      observeLegacyWorkerProcessGroup: async () => "possibly_live",
    });
    const intent = service.createIntent({
      run_id: "run-corrupt-journal-resource-settlement-race",
      host: "local",
      prompt: "Retain resource settlement across journal quarantine",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const paths = service.store.paths(intent.run_id);
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: deadPid, worker_supervisor: "direct" },
    });
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    await writeFile(join(paths.runDir, "pid"), `${deadPid}\n`, "utf8");
    const settled = await service.reconcile();
    expect(settled.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_resource_settlement_pending",
    });
    await writeFile(
      paths.eventsPath,
      `${await readFile(paths.eventsPath, "utf8")}{"malformed":\n`,
      "utf8",
    );
    const originalReadRunRecord = service.store.readRunRecord.bind(service.store);
    let signalOwnedRead!: () => void;
    let releaseOwnedRead!: () => void;
    const ownedReadStarted = new Promise<void>((resolve) => { signalOwnedRead = resolve; });
    const ownedReadRelease = new Promise<void>((resolve) => { releaseOwnedRead = resolve; });
    const read = vi.spyOn(service.store, "readRunRecord").mockImplementationOnce(async (candidateRunId) => {
      signalOwnedRead();
      await ownedReadRelease;
      return originalReadRunRecord(candidateRunId);
    });

    const reconcilePromise = service.reconcile();
    await ownedReadStarted;
    await rm(paths.runRecordPath);
    releaseOwnedRead();
    const reconciled = await reconcilePromise;
    read.mockRestore();

    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "canonical_run_record_missing",
    }]);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.adopted).not.toContain(intent.run_id);
  }));

  test("corrupt current event journal is not quarantined beneath a live execution owner", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-current-corrupt-live-journal",
      host: "local",
      prompt: "Keep the live mutex owner authoritative",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const paths = service.store.paths(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "live-current-owner",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await writeFile(paths.eventsPath, `${await readFile(paths.eventsPath, "utf8")}{"malformed":\n`, "utf8");
    const journalBefore = await readFile(paths.eventsPath, "utf8");
    let signalAcquired!: () => void;
    let releaseOwner!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const held = withSqliteMutex(paths.executionMutexPath, async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    try {
      const reconciled = await service.reconcile();
      expect(reconciled.adopted).toContain(intent.run_id);
      expect(reconciled.classified).not.toContain(intent.run_id);
      expect(reconciled.projection).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("live execution owner"),
      });
      expect(await readFile(paths.eventsPath, "utf8")).toBe(journalBefore);
      expect((await readdir(paths.runDir)).some((entry) => entry.startsWith("events.jsonl.corrupt."))).toBe(false);
    } finally {
      releaseOwner();
      await held;
    }
  });

  test("reconcile never promotes a reused live PID into adoption or readopt authority", async () => {
    const observeLegacyWorkerPid = vi.fn(async () => "possibly_live" as const);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-reused-pid-repair",
      host: "local",
      prompt: "Do not confuse PID reuse with worker ownership",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: process.pid, worker_supervisor: "direct" },
      },
    );
    const pidPath = join(service.store.paths(intent.run_id).runDir, "pid");
    await writeFile(pidPath, `${process.pid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    const reconciled = await service.reconcile();

    expect(observeLegacyWorkerPid).toHaveBeenCalledWith(process.pid);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.adopted).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(0);

    const replayed = await service.reconcile();
    expect(replayed.skipped).not.toContain(intent.run_id);
    expect(replayed.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    });
    expect(replayed.classified).not.toContain(intent.run_id);
    expect(replayed.adopted).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(0);
    await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
      run_id: intent.run_id,
      readopt_safe: false,
      reason: "legacy_process_identity_unavailable",
    }]);
  });

  test("reconcile preserves a legacy terminal publication that lands during the final PID probe", async () => {
    let publishedReceipt!: RunReceipt;
    const intentRunId = "run-legacy-publication-race";
    const observeLegacyWorkerPid = vi.fn(async () => {
      const current = await service.getRunRecord(intentRunId);
      if (!current) throw new Error("legacy record disappeared during publication barrier");
      const completedAt = "2026-03-11T12:00:02.000Z";
      publishedReceipt = makeReceipt(
        intentRunId,
        makeReceiptSpec(intentRunId, current.intent, publishedSpec.backend),
        "succeeded",
        {
          timing: {
            created_at: current.created_at,
            completed_at: completedAt,
          },
        },
      );
      await service.store.writeKernelReceipt(intentRunId, publishedReceipt);
      await service.store.writeRunRecord(intentRunId, {
        ...current,
        state: "succeeded",
        spec: publishedSpec,
        kernel_receipt: publishedReceipt,
        summary: `Run ${intentRunId} succeeded`,
        updated_at: completedAt,
        completed_at: completedAt,
      });
      return "dead" as const;
    });
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
    });
    const intent = service.createIntent({
      run_id: intentRunId,
      host: "local",
      prompt: "Publish while reconciliation probes the old worker",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    const publishedSpec: ResolvedRunSpec = await resolveRunIntent(intent, { now: () => launchedAt });
    await service.store.writeSpec(intent.run_id, publishedSpec);
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: process.pid, worker_supervisor: "direct" },
      },
    );
    const pidPath = join(service.store.paths(intent.run_id).runDir, "pid");
    await writeFile(pidPath, `${process.pid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      spec: publishedSpec,
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    const reconciled = await service.reconcile();

    expect(observeLegacyWorkerPid).toHaveBeenCalledOnce();
    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "succeeded",
      kernel_receipt: publishedReceipt,
    });
    await expect(service.store.readKernelReceipt(intent.run_id)).resolves.toEqual(publishedReceipt);
    await expect(stat(pidPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(1);
  });

  test("reconcile settles a dead legacy publisher once while preserving its PID evidence", async () => {
    const deadPid = 45_678;
    let clock = "2026-03-11T12:00:02.000Z";
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if ((pid === deadPid || pid === -deadPid) && signal === 0) {
        throw Object.assign(new Error("process does not exist"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
    const service = new RunService({
      runsRoot,
      handback: { messageCorrespondence: false },
    }, {
      ...buildDeps(),
      now: () => clock,
    });
    const intent = service.createIntent({
      run_id: "run-legacy-dead-worker-repair",
      host: "local",
      prompt: "Do not preserve stale PID evidence",
      require_execplan: false,
      handback: {
        key: "legacy-dead-settlement",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "legacy-dead-settlement",
        ack_required: true,
        body_contract: "one stable terminal outcome",
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: deadPid, worker_supervisor: "direct" },
      },
    );
    const pidPath = join(service.store.paths(intent.run_id).runDir, "pid");
    await writeFile(pidPath, `${deadPid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    try {
      await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
        run_id: intent.run_id,
        readopt_safe: false,
        reason: "no_execution_owner",
      }]);
      await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      const reconciled = await service.reconcile();
      expect(reconciled.classified).toContain(intent.run_id);
      expect(reconciled.skipped).not.toContain(intent.run_id);
      expect(reconciled.adopted).not.toContain(intent.run_id);
      await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
        state: "infra_error",
        recovery: {
          mode: "orchestrator_crash",
          owner_free_settlement: {
            authority: "legacy_pid_dead",
            reason_code: "legacy_detached_worker_observed_dead",
            legacy_pid: deadPid,
            settled_at: clock,
          },
          resource_settlement: {
            status: "settled",
            authority: "legacy_process_group_extinct",
            reason_code: "legacy_detached_process_group_observed_extinct",
            legacy_process_group_id: deadPid,
            settled_at: clock,
          },
        },
      });
      await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      const firstRecord = await service.getRunRecord(intent.run_id);
      const firstEvents = (await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent);
      const firstHandback = await readRunHandbackReceipt(service, intent.run_id);
      expect(firstEvents).toHaveLength(1);

      clock = "2026-03-11T13:00:00.000Z";
      const second = await service.reconcile();
      expect(second.adopted).not.toContain(intent.run_id);
      expect(await service.getRunRecord(intent.run_id)).toEqual(firstRecord);
      await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toEqual(firstEvents);
      expect(await readRunHandbackReceipt(service, intent.run_id)).toEqual(firstHandback);

      clock = "2026-03-12T12:00:00.000Z";
      const third = await service.reconcile();
      expect(third.adopted).not.toContain(intent.run_id);
      expect(await service.getRunRecord(intent.run_id)).toEqual(firstRecord);
      expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toEqual(firstEvents);
      expect(await readRunHandbackReceipt(service, intent.run_id)).toEqual(firstHandback);
      await expect(stat(pidPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    } finally {
      kill.mockRestore();
    }
  });

  test("HTTP reconcile journals terminal finalization after a crash between legacy settlement and publication", async () => {
    const deadPid = 45_673;
    const service = new RunService({
      runsRoot,
      handback: { messageCorrespondence: false },
    }, {
      ...buildDeps(),
      observeLegacyWorkerPid: async () => "dead",
      observeLegacyWorkerProcessGroup: async () => "dead",
    });
    const intent = service.createIntent({
      run_id: "run-legacy-settlement-finalization-crash",
      host: "local",
      prompt: "Recover terminal publication without changing settlement authority",
      require_execplan: false,
      handback: {
        key: "legacy-settlement-finalization-crash",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "legacy-settlement-finalization-crash",
        ack_required: true,
        body_contract: "one provenance-enveloped terminal publication",
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: deadPid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    await writeFile(join(paths.runDir, "pid"), `${deadPid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

    const firstProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000013");
    const publication = vi.spyOn(service.store, "appendStreamEvent")
      .mockRejectedValueOnce(new Error("simulated terminal publication crash"));

    // POL-1897: a mid-effect crash no longer escapes the pass; the candidate
    // surfaces as typed unresolved and index repair defers with the cause.
    const crashedPass = await service.reconcile({ provenance: firstProvenance });
    expect(crashedPass.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "reconcile_candidate_failed",
    });
    expect(crashedPass.projection).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("simulated terminal publication crash"),
    });
    publication.mockRestore();

    const settledRecord = await service.getRunRecord(intent.run_id);
    expect(settledRecord).toMatchObject({
      state: "infra_error",
      recovery: {
        owner_free_settlement: {
          authority: "legacy_pid_dead",
          legacy_pid: deadPid,
        },
        resource_settlement: {
          status: "settled",
          authority: "legacy_process_group_extinct",
          legacy_process_group_id: deadPid,
        },
      },
    });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(0);
    expect((await readdir(paths.runDir)).some((entry) => entry.startsWith("handback-"))).toBe(false);
    const firstEffectEvents = (await service.store.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => event.provenance?.request_id === firstProvenance.request_id);
    expect(firstEffectEvents).toEqual([
      expect.objectContaining({
        event: "reconcile_intent",
        payload: expect.objectContaining({ effect: "owner_free_execution_classification" }),
      }),
      expect.objectContaining({
        event: "reconcile_result",
        payload: expect.objectContaining({
          effect: "owner_free_execution_classification",
          outcome: "indeterminate",
        }),
      }),
    ]);

    const secondProvenance = apiProvenance("req_00000000-0000-4000-8000-000000000014");
    const repaired = await service.reconcile({ provenance: secondProvenance });

    expect(repaired.skipped).toContain(intent.run_id);
    const repairedRecord = await service.getRunRecord(intent.run_id);
    expect(repairedRecord?.recovery.owner_free_settlement).toEqual(
      settledRecord?.recovery.owner_free_settlement,
    );
    expect(repairedRecord?.recovery.resource_settlement).toEqual(
      settledRecord?.recovery.resource_settlement,
    );
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(1);
    await expect(readRunHandbackReceipt(service, intent.run_id)).resolves.toMatchObject({
      run_id: intent.run_id,
    });
    const secondEffectEvents = (await service.store.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => event.provenance?.request_id === secondProvenance.request_id);
    expect(secondEffectEvents).toEqual([
      expect.objectContaining({
        event: "reconcile_intent",
        payload: expect.objectContaining({ effect: "legacy_settlement_finalization" }),
      }),
      expect.objectContaining({
        event: "reconcile_result",
        payload: expect.objectContaining({
          effect: "legacy_settlement_finalization",
          outcome: "completed",
        }),
      }),
    ]);
  });

  test("reconcile preserves an exact legacy launch when PID disappearance cannot be proved", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-missing-pid-settlement",
      host: "local",
      prompt: "Do not classify across missing legacy PID evidence",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(
      intent.run_id,
      {
        timestamp: launchedAt,
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        payload: { pid: 45_679, worker_supervisor: "direct" },
      },
    );
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
      "utf8",
    );

    const first = await service.reconcile();
    const second = await service.reconcile();

    expect(first.skipped).not.toContain(intent.run_id);
    expect(first.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(first.classified).not.toContain(intent.run_id);
    expect(first.adopted).not.toContain(intent.run_id);
    expect(second.skipped).not.toContain(intent.run_id);
    expect(second.unresolved).toEqual(first.unresolved);
    expect(second.classified).not.toContain(intent.run_id);
    expect(second.adopted).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    expect((await service.store.readEvents(intent.run_id)).filter(isRunTerminalEvent)).toHaveLength(0);
    await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
      run_id: intent.run_id,
      readopt_safe: false,
      reason: "legacy_process_identity_unavailable",
    }]);
  });

  test("reconcile preserves a terminal noncanonical directory and still adopts a canonical sibling", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-owner-adoption-after-legacy-quarantine",
      host: "local",
      prompt: "Keep this live owner adopted",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "execution-owner-after-legacy-quarantine",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const legacyDirectoryName = "legacy run+2025";
    const legacyDirectoryPath = join(runsRoot, legacyDirectoryName);
    await mkdir(legacyDirectoryPath, { recursive: true });
    await writeFile(
      join(legacyDirectoryPath, "run_record.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        run_id: legacyDirectoryName,
        state: "succeeded",
      }, null, 2)}\n`,
      "utf8",
    );

    let signalAcquired!: () => void;
    let releaseOwner!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const held = withSqliteMutex(service.store.paths(intent.run_id).executionMutexPath, async () => {
      signalAcquired();
      await release;
    });
    await acquired;

    try {
      const sibling = new RunService({ runsRoot }, buildDeps());
      const first = await sibling.reconcile();
      const rootEntries = await readdir(runsRoot);

      expect(first.scanned).toBe(2);
      expect(first.skipped).not.toContain(legacyDirectoryName);
      expect(first.noncanonical_directories).toEqual([
        expect.objectContaining({
          directory_name: legacyDirectoryName,
          status: "requires_operator_migration",
          record_state: "succeeded",
          detail:
            "terminal state does not prove legacy writers are quiescent; the directory is preserved until an operator migrates its identity",
        }),
      ]);
      expect(first.adopted).toContain(intent.run_id);
      expect(first.classified).not.toContain(intent.run_id);
      expect(rootEntries).toContain(legacyDirectoryName);
      await expect(stat(legacyDirectoryPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(stat(join(legacyDirectoryPath, ".calyx-quarantine.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(sibling.store.listRunIds()).resolves.toEqual([intent.run_id]);

      const second = await sibling.reconcile();
      expect(second.scanned).toBe(2);
      expect(second.skipped).not.toContain(legacyDirectoryName);
      expect(second.noncanonical_directories).toEqual(first.noncanonical_directories);
      expect(second.adopted).toContain(intent.run_id);
      await expect(stat(legacyDirectoryPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(sibling.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    } finally {
      releaseOwner();
      await held;
    }
  });

  test("reconcile preserves a noncanonical active directory for explicit operator migration", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const legacyDirectoryName = "legacy active+2025";
    const legacyDirectoryPath = join(runsRoot, legacyDirectoryName);
    await mkdir(legacyDirectoryPath, { recursive: true });
    await writeFile(
      join(legacyDirectoryPath, "run_record.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        run_id: legacyDirectoryName,
        state: "running",
      }, null, 2)}\n`,
      "utf8",
    );

    const first = await service.reconcile();
    expect(first.scanned).toBe(1);
    expect(first.noncanonical_directories).toEqual([{
      directory_name: legacyDirectoryName,
      status: "requires_operator_migration",
      reason:
        "run_id must be 1-256 ASCII letters, digits, dot, underscore, colon, or hyphen; it must start with a letter or digit",
      record_state: "running",
      detail: "nonterminal legacy runs are preserved until an operator migrates their identity",
    }]);
    await expect(stat(legacyDirectoryPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(service.store.listRunIds()).resolves.toEqual([]);

    const second = await service.reconcile();
    expect(second.noncanonical_directories).toEqual(first.noncanonical_directories);
    await expect(stat(legacyDirectoryPath)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  test("restart-readopt excludes inline runs without consulting process identity", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-inline-readopt",
      host: "local",
      prompt: "Inline daemon tick",
      require_execplan: false,
    });
    const record = await service.initializeRun(intent, { launchMode: "inline" });
    await service.store.writeRunRecord(intent.run_id, {
      ...record,
      state: "running",
      launch: {
        ...record.launch,
        stage: "executing",
        execution_id: "inline-execution",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
    });

    await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
      run_id: intent.run_id,
      readopt_safe: false,
      reason: "inline_worker",
    }]);
  });

  test("restart-readopt fails closed for an active Codex app-server binding", async () => {
    await withTempStateHome(async () => {
      const service = new RunService({ runsRoot }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-readopt-active-app-server",
        host: "local",
        prompt: "Detached worker with an app-server binding",
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "detached" });
      await service.store.appendEvent(intent.run_id, {
        timestamp: "2026-03-11T12:00:00.000Z",
        run_id: intent.run_id,
        source: "run-service",
        event: "launch_dispatched",
        message: "Spawned detached run worker.",
        // POL-2044: systemd evidence so the run reaches the safe path and the
        // app-server binding is what fails it closed (not the supervisor gate).
        payload: { worker_supervisor: "systemd" },
      });
      await service.store.writeRunRecord(intent.run_id, {
        ...queued,
        state: "running",
        launch: {
          ...queued.launch,
          stage: "executing",
          execution_id: "readopt-active-binding-owner",
          execution_started_at: "2026-03-11T12:00:01.000Z",
        },
        updated_at: "2026-03-11T12:00:01.000Z",
      });

      let signalAcquired!: () => void;
      let releaseOwner!: () => void;
      const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
      const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
      const held = withSqliteMutex(
        service.store.paths(intent.run_id).executionMutexPath,
        async () => {
          signalAcquired();
          await release;
        },
      );
      await acquired;

      try {
        await applyStateMigrations();
        const opened = await openStateStore();
        try {
          upsertRunnerLiveBinding(opened.db, {
            run_id: intent.run_id,
            adapter: "codex_app_server_steer",
            backend: "codex",
            lifecycle_owner: "calyx",
            host: "local",
            status: "active",
            transport_kind: "stdio-jsonl",
          });
        } finally {
          opened.db.close();
        }

        await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
          run_id: intent.run_id,
          readopt_safe: false,
          reason: "active_app_server_binding",
          worker_supervisor: "systemd",
        }]);
      } finally {
        releaseOwner();
        await held;
      }
    });
  });

  test("restart-readopt fails closed when app-server binding state is unavailable", async () => {
    const invalidDbPath = join(runsRoot, "state-db-is-directory");
    await mkdir(invalidDbPath, { recursive: true });
    const service = new RunService({
      runsRoot,
      leases: {
        state: {
          paths: {
            stateDir: dirname(invalidDbPath),
            dbPath: invalidDbPath,
            source: "default",
            dirSource: "default",
          },
        },
      },
    }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-readopt-binding-unavailable",
      host: "local",
      prompt: "Detached worker with unreadable binding state",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.appendEvent(intent.run_id, {
      timestamp: "2026-03-11T12:00:00.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      // POL-2044: systemd evidence so the run reaches the safe path and the
      // unreadable binding state is what fails it closed.
      payload: { worker_supervisor: "systemd" },
    });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "readopt-unavailable-binding-owner",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    let signalAcquired!: () => void;
    let releaseOwner!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const release = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const held = withSqliteMutex(
      service.store.paths(intent.run_id).executionMutexPath,
      async () => {
        signalAcquired();
        await release;
      },
    );
    await acquired;

    try {
      await expect(service.assessRestartReadopt([intent.run_id])).resolves.toEqual([{
        run_id: intent.run_id,
        readopt_safe: false,
        reason: "app_server_binding_unknown",
        worker_supervisor: "systemd",
      }]);
    } finally {
      releaseOwner();
      await held;
    }
  });

  test("POL-2044: a live Linux systemd worker classifies restart-safe", async () => {
    await withTempStateHome(async () => {
      const service = new RunService({ runsRoot }, buildDeps());
      await stageLiveDetachedRun(service, "run-supervisor-systemd", {
        pid: 45_697,
        worker_supervisor: "systemd",
      });
      await withHeldExecutionMutex(service, "run-supervisor-systemd", async () => {
        await expect(service.assessRestartReadopt(["run-supervisor-systemd"])).resolves.toEqual([{
          run_id: "run-supervisor-systemd",
          readopt_safe: true,
          reason: "detached_agent_runner_worker",
          worker_supervisor: "systemd",
        }]);
      });
    });
  });

  test("POL-2044: a live Linux direct worker (systemd fallback) classifies unsafe with the fallback reason", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await stageLiveDetachedRun(service, "run-supervisor-direct", {
      pid: 45_698,
      worker_supervisor: "direct",
      // The persisted fallback fact (POL-2044) proves the direct worker was an
      // unintended systemd→direct fallback, not a deliberate direct launch.
      worker_supervisor_fallback: "systemd-run failed to launch detached run worker run-supervisor-direct.",
    });
    await withHeldExecutionMutex(service, "run-supervisor-direct", async () => {
      await expect(service.assessRestartReadopt(["run-supervisor-direct"])).resolves.toEqual([{
        run_id: "run-supervisor-direct",
        readopt_safe: false,
        reason: "unproven_supervisor_isolation:direct",
        worker_supervisor: "direct",
      }]);
    });
  });

  test("POL-2044: a live worker whose launch event never recorded a supervisor classifies unsafe", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    await stageLiveDetachedRun(service, "run-supervisor-unrecorded", { pid: 45_699 });
    await withHeldExecutionMutex(service, "run-supervisor-unrecorded", async () => {
      await expect(service.assessRestartReadopt(["run-supervisor-unrecorded"])).resolves.toEqual([{
        run_id: "run-supervisor-unrecorded",
        readopt_safe: false,
        reason: "unproven_supervisor_isolation:unrecorded",
      }]);
    });
  });

  test("POL-2044: a live macOS (launchd) worker fails closed regardless of recorded supervisor", async () => {
    // macOS hosts launch direct workers; survival across a `run serve` restart
    // is unproven (POL-1900), so the default posture is fail-closed until proven.
    const service = new RunService({ runsRoot }, { ...buildDeps(), platform: () => "darwin" });
    await stageLiveDetachedRun(service, "run-supervisor-launchd", {
      pid: 45_700,
      worker_supervisor: "direct",
    });
    await withHeldExecutionMutex(service, "run-supervisor-launchd", async () => {
      await expect(service.assessRestartReadopt(["run-supervisor-launchd"])).resolves.toEqual([{
        run_id: "run-supervisor-launchd",
        readopt_safe: false,
        reason: "unproven_supervisor_isolation:launchd",
        worker_supervisor: "direct",
      }]);
    });
  });

  test("foreground launch emits exactly one run.terminal event and indexes it globally", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const observed: CalyxStreamEvent[] = [];
    const unsubscribe = service.subscribeToEvents((event) => observed.push(event));
    const intent = service.createIntent({
      run_id: "run-event-launch-1",
      host: "local",
      prompt: "Emit terminal event",
      require_execplan: false,
    });

    const result = await service.launch(intent, { detached: false });
    unsubscribe();
    const runEvents = await service.store.readEvents(intent.run_id);
    const terminalEvents = runEvents.filter(isRecordedCalyxRunEvent).filter((event) => event.event_type === "run.terminal");
    const indexedEvents = await collectIndexedEvents(service, intent.run_id);

    expect(result.record.state).toBe("succeeded");
    expect(await service.store.hasTerminalEventForRun(intent.run_id)).toBe(true);
    expect(terminalEvents).toHaveLength(1);
    expect(indexedEvents).toHaveLength(1);
    expect(terminalEvents[0]?.event_id).toBe(indexedEvents[0]?.event_id);
    expect(terminalEvents[0]?.cursor).toBe(indexedEvents[0]?.cursor);
    expect(terminalEvents[0]?.cursor).toBe("z1-00000000000000000001");
    expect(observed).toEqual(indexedEvents);
    expect(terminalEvents[0]?.emitted_by).toBe("launch");
    expect(terminalEvents[0]?.pointers.run_record_path).toBe(service.store.paths(intent.run_id).runRecordPath);
  });

  test("a delayed sink cannot let later caller completion or live delivery overtake its durable cursor", async () => {
    let releaseFirstSink!: () => void;
    let signalFirstSink!: () => void;
    const firstSinkEntered = new Promise<void>((resolve) => { signalFirstSink = resolve; });
    const firstSinkRelease = new Promise<void>((resolve) => { releaseFirstSink = resolve; });
    const first = new RunService({
      runsRoot,
      subscribers: [],
      eventLogIngest: async () => {
        signalFirstSink();
        await firstSinkRelease;
        return { status: "ingested", inserted: true };
      },
    }, buildDeps());
    let secondSinkEntered = false;
    const second = new RunService({
      runsRoot,
      subscribers: [],
      eventLogIngest: async () => {
        secondSinkEntered = true;
        return { status: "ingested", inserted: true };
      },
    }, buildDeps());
    const observed: string[] = [];
    const completions: string[] = [];
    first.subscribeToEvents((event) => observed.push(event.cursor));
    second.subscribeToEvents((event) => observed.push(event.cursor));
    type StreamEmitter = {
      emitStreamEvent<T extends CalyxStreamEvent>(event: T): Promise<T>;
    };
    const event = (eventId: string, cursor: string): CalyxControlEvent => ({
      schema_version: "1.0",
      event_id: eventId,
      cursor,
      emitted_at: "2026-05-10T00:00:00.000Z",
      event_type: "daemon.health.checked",
      emitted_by: "self-health",
      control: { host: "blade", daemon_id: "blade-default" },
    });
    const firstEmission = (first as unknown as StreamEmitter).emitStreamEvent(event(
      "evt-delayed-publication-1",
      "2026-05-10T00:00:01.000Z-delayed-first",
    )).then((stored) => {
      completions.push(stored.cursor);
      return stored;
    });
    await firstSinkEntered;
    const secondEmission = (second as unknown as StreamEmitter).emitStreamEvent(event(
      "evt-delayed-publication-2",
      "2026-05-10T00:00:00.000Z-producer-clock-earlier",
    )).then((stored) => {
      completions.push(stored.cursor);
      return stored;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSinkEntered).toBe(false);
    expect(completions).toEqual([]);
    expect(observed).toEqual([]);

    releaseFirstSink();
    const committed = await Promise.all([firstEmission, secondEmission]);
    expect(committed.map((stored) => stored.cursor)).toEqual([
      "z1-00000000000000000001",
      "z1-00000000000000000002",
    ]);
    expect(completions).toEqual(committed.map((stored) => stored.cursor));
    expect(observed).toEqual(committed.map((stored) => stored.cursor));
  });

  test("throwing event subscribers cannot overwrite a durable successful finalization", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    service.subscribeToEvents(() => {
      throw new Error("broken SSE consumer");
    });
    const intent = service.createIntent({
      run_id: "run-throwing-event-subscriber",
      host: "local",
      prompt: "Keep the receipt authoritative",
      require_execplan: false,
    });

    const result = await service.launch(intent, { detached: false });
    const persisted = await service.getRunRecord(intent.run_id);
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent);

    expect(result.record.state).toBe("succeeded");
    expect(persisted).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.run.state).toBe("succeeded");
  });

  test("monitor evaluator creates one wake row and retires terminal runner-supervision monitors", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-state-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        createMonitor(opened.db, {
          monitor_id: "mon_service_1",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-service",
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate("run-monitor-service"),
          rearm_policy: "every_change",
          delivery: defaultMonitorDeliveryBinding(),
          now: "2026-06-11T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const providerConstraint = {
        schema_version: "calyx.provider-constraint/v1" as const,
        cause: "provider_capacity_exhausted" as const,
        backend: "claude",
        kind: "session_window" as const,
        source: "session_transcript" as const,
        observed_at: "2026-07-21T07:06:08.573Z",
        confidence: "definitive" as const,
        reset_hint: "resets 8:10am (UTC)",
      };
      const service = new RunService({
        runsRoot,
        monitorEvaluator: { enabled: true, assignedHost: "blade" },
      }, buildDeps("partial", {
        exit: {
          exit_code: 1,
          partial_reason: "budget_exhaustion",
        },
        terminal_evidence: {
          schema_version: "calyx.agent-terminal-evidence/v1",
          source: "session_fallback",
          status: "authoritative",
          reason: "provider_capacity_exhausted",
          provider_constraint: providerConstraint,
        },
      }));
      const emitted: CalyxStreamEvent[] = [];
      service.subscribeToEvents((event) => emitted.push(event), {
        event_type: "monitor.wake.created",
      });
      const intent = service.createIntent({
        run_id: "run-monitor-service",
        host: "blade",
        prompt: "Wake me when terminal",
        require_execplan: false,
      });

      await service.launch(intent, { detached: false });
      const first = await service.evaluateMonitorsOnce();
      const second = await service.evaluateMonitorsOnce();

      expect(first).toMatchObject({ status: "ok", scanned: 1, evaluated: 1, wakesCreated: 1 });
      expect(second).toMatchObject({ status: "ok", scanned: 0, evaluated: 0, wakesCreated: 0 });
      expect(emitted.filter(isCalyxMonitorEvent)).toHaveLength(1);
      const monitorEvent = emitted.filter(isCalyxMonitorEvent)[0];
      expect(monitorEvent?.monitor).toMatchObject({
        monitor_id: "mon_service_1",
        source_run_id: "run-monitor-service",
        status: "pending",
      });
      expect(monitorEvent?.evaluation.evidence).toContainEqual(
        expect.objectContaining({
          kind: "run.terminal",
          value: expect.objectContaining({ provider_constraint: providerConstraint }),
        }),
      );

      const state = await openStateStore();
      try {
        expect(readMonitor(state.db, "mon_service_1")).toMatchObject({
          status: "cancelled",
          rearm_policy: "every_change",
          last_wake_id: expect.any(String),
        });
        const wakes = listMonitorWakes(state.db, { status: "pending" });
        expect(wakes).toHaveLength(1);
        expect(wakes[0]?.monitor_id).toBe("mon_service_1");
        expect(wakes[0]?.evaluation.evidence).toContainEqual(
          expect.objectContaining({
            kind: "run.terminal",
            value: expect.objectContaining({ provider_constraint: providerConstraint }),
          }),
        );
      } finally {
        state.db.close();
      }
      const receipt = await readFile(join(stateRoot, "state", "receipts", "monitor-wakes.jsonl"), "utf8");
      expect(receipt).toContain("mon_service_1");
      expect(receipt).toContain("run-monitor-service");
      expect(receipt).toContain("\"cause\":\"provider_capacity_exhausted\"");
      expect(receipt).toContain("\"reset_hint\":\"resets 8:10am (UTC)\"");
      expect(receipt).not.toContain("You've hit");
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("monitor evaluator cancels terminal once monitors after creating their wake", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-once-state-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        createMonitor(opened.db, {
          monitor_id: "mon_service_once_terminal",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-once-terminal",
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate("run-monitor-once-terminal"),
          rearm_policy: "once",
          delivery: defaultMonitorDeliveryBinding(),
          now: "2026-06-11T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const service = new RunService({
        runsRoot,
        monitorEvaluator: { enabled: true, assignedHost: "blade" },
      }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-monitor-once-terminal",
        host: "blade",
        prompt: "Wake once when terminal",
        require_execplan: false,
      });

      await service.launch(intent, { detached: false });
      const first = await service.evaluateMonitorsOnce();
      const second = await service.evaluateMonitorsOnce();

      expect(first).toMatchObject({ status: "ok", scanned: 1, evaluated: 1, wakesCreated: 1 });
      expect(second).toMatchObject({ status: "ok", scanned: 0, evaluated: 0, wakesCreated: 0 });

      const state = await openStateStore();
      try {
        expect(readMonitor(state.db, "mon_service_once_terminal")).toMatchObject({
          status: "cancelled",
          rearm_policy: "once",
          last_wake_id: expect.any(String),
        });
        expect(listMonitorWakes(state.db, { status: "pending", monitor_id: "mon_service_once_terminal" })).toHaveLength(1);
      } finally {
        state.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("monitor evaluator bounds open-time state lock contention and retries on the next tick", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-lock-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        createMonitor(opened.db, {
          monitor_id: "mon_service_lock_retry",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-lock-retry",
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate("run-monitor-lock-retry"),
          rearm_policy: "every_change",
          delivery: defaultMonitorDeliveryBinding(),
          now: "2026-06-11T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const service = new RunService({
        runsRoot,
        monitorEvaluator: {
          enabled: true,
          assignedHost: "blade",
          state: { busyTimeoutMs: 1 },
        },
      }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-monitor-lock-retry",
        host: "blade",
        prompt: "Wake me after the lock clears",
        require_execplan: false,
      });
      await service.launch(intent, { detached: false });

      const driver = await loadStateDriver();
      const setupDb = driver.open(join(stateRoot, "state", "calyx.db"));
      try {
        setupDb.exec("PRAGMA busy_timeout = 5000;");
        setupDb.exec("PRAGMA journal_mode = DELETE;");
      } finally {
        setupDb.close();
      }

      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const lockDb = driver.open(join(stateRoot, "state", "calyx.db"));
      try {
        lockDb.exec("PRAGMA busy_timeout = 1;");
        lockDb.exec("BEGIN IMMEDIATE;");
        const locked = await service.evaluateMonitorsOnce();
        expect(locked).toMatchObject({
          status: "error",
          scanned: 0,
          evaluated: 0,
          wakesCreated: 0,
          errors: 1,
        });
        expect(locked.detail).toMatch(/locked|busy/i);
      } finally {
        try {
          lockDb.exec("ROLLBACK;");
        } catch {
          // The assertion above should not depend on rollback success details.
        }
        lockDb.close();
        stderrWrite.mockRestore();
      }

      const retried = await service.evaluateMonitorsOnce();
      expect(retried).toMatchObject({
        status: "ok",
        scanned: 1,
        evaluated: 1,
        wakesCreated: 1,
        errors: 0,
      });

      const state = await openStateStore();
      try {
        expect(readMonitor(state.db, "mon_service_lock_retry")).toMatchObject({
          last_wake_id: expect.any(String),
        });
        expect(listMonitorWakes(state.db, { status: "pending", monitor_id: "mon_service_lock_retry" })).toHaveLength(1);
      } finally {
        state.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("monitor evaluator delivers all Tier-1 bindings exactly once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-delivery-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        createMonitor(opened.db, {
          monitor_id: "mon_service_delivery_all",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-delivery-all",
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate("run-monitor-delivery-all"),
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "all-ntfy",
              adapter: "ntfy",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              ntfy: { url: "https://ntfy.test", topic: "scratch-monitor" },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "all-linear",
              adapter: "linear_comment",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              linear_comment: { issue_id: "POL-1980", dry_run: true },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "all-vault",
              adapter: "vault_receipt",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              vault_receipt: { vault_root: join(stateRoot, "vault") },
            },
          ]),
          now: "2026-06-11T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "ok",
      }));
      const service = new RunService({
        runsRoot,
        monitorEvaluator: {
          enabled: true,
          assignedHost: "blade",
          delivery: { fetch: fetchImpl, env: {} },
        },
      }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-monitor-delivery-all",
        host: "blade",
        issue: "POL-1980",
        prompt: "Wake me when terminal",
        require_execplan: false,
      });

      await service.launch(intent, { detached: false });
      const first = await service.evaluateMonitorsOnce();
      const second = await service.evaluateMonitorsOnce();

      expect(first).toMatchObject({
        status: "ok",
        scanned: 1,
        wakesCreated: 1,
        deliveriesAttempted: 3,
        deliveriesDelivered: 3,
        deliveriesFailed: 0,
      });
      expect(second).toMatchObject({
        status: "ok",
        scanned: 0,
        wakesCreated: 0,
        deliveriesAttempted: 0,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const state = await openStateStore();
      try {
        expect(readMonitor(state.db, "mon_service_delivery_all")).toMatchObject({
          status: "cancelled",
          rearm_policy: "every_change",
          last_wake_id: expect.any(String),
        });
        const deliveries = listMonitorDeliveries(state.db, { monitor_id: "mon_service_delivery_all" });
        expect(deliveries).toHaveLength(3);
        expect(deliveries.map((delivery) => delivery.status)).toEqual(["delivered", "delivered", "delivered"]);
      } finally {
        state.db.close();
      }
      await expect(stat(join(stateRoot, "vault", "10-daily", "2026-03-11", "calyx-monitor-receipts"))).resolves.toBeTruthy();
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("exact-session monitors use shared ingress instead of legacy Codex and Claude wake adapters", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-shared-ingress-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const ingress = prepareSessionIngressLaunch(opened.db, {
          backend: "codex",
          destination_host: "blade",
        });
        exchangeSessionIngressLaunch(opened.db, {
          launch_nonce: ingress.launch_nonce,
          activity_id: "interactive:codex:shared-router-owner",
          harness_session_id: "shared-router-owner",
        });
        createMonitor(opened.db, {
          monitor_id: "mon_shared_router_only",
          owner: "interactive:codex:shared-router-owner",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-shared-router-only",
          preset: "runner-supervision",
          predicate: runnerSupervisionPredicate("run-shared-router-only"),
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "human-ntfy",
              adapter: "ntfy",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              ntfy: { url: "https://ntfy.test", topic: "shared-router" },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "legacy-codex",
              adapter: "codex_automation",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              codex_automation: {
                codex_home: join(stateRoot, "codex-home"),
                thread_id: "019e7637-f599-7811-a4c1-c2edc6297666",
                dry_run: true,
              },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "legacy-claude",
              adapter: "claude_reinvoke",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_reinvoke: {
                command: "claude",
                session_id: "shared-router-owner",
                cwd: stateRoot,
                timeout_ms: 1_000,
              },
            },
          ]),
        });
      } finally {
        opened.db.close();
      }

      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "ok" }));
      const execFile = vi.fn(async () => ({ stdout: "legacy", stderr: "" }));
      const sharedIngress = vi.fn(async () => ({
        target: { adapter: "unix_socket" },
        evidence: { transport: "shared_session_ingress" },
      }));
      const service = new RunService({
        runsRoot,
        monitorEvaluator: {
          enabled: true,
          assignedHost: "blade",
          delivery: { fetch: fetchImpl, execFile, env: {} },
          sessionWake: { deliver: sharedIngress },
        },
      }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-shared-router-only",
        host: "blade",
        prompt: "Use the shared session router",
        require_execplan: false,
      });

      await service.launch(intent, { detached: false });
      const result = await service.evaluateMonitorsOnce();
      expect(result).toMatchObject({
        wakesCreated: 1,
        deliveriesAttempted: 2,
        deliveriesDelivered: 2,
        deliveriesFailed: 0,
        deliveriesSkipped: 2,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(execFile).not.toHaveBeenCalled();
      expect(sharedIngress).toHaveBeenCalledTimes(1);

      const state = await openStateStore();
      try {
        const deliveries = listMonitorDeliveries(state.db, { monitor_id: "mon_shared_router_only" });
        expect(deliveries).toEqual(expect.arrayContaining([
          expect.objectContaining({ binding_id: "human-ntfy", adapter: "ntfy", status: "delivered" }),
          expect.objectContaining({
            binding_id: "session_ingress:interactive:codex:shared-router-owner",
            adapter: "session_ingress",
            status: "delivered",
            target: expect.objectContaining({
              activity_id: "interactive:codex:shared-router-owner",
              pointer_kind: "monitor_wake",
            }),
            evidence: expect.objectContaining({
              wake_state: "wake_delivered",
              first_command: "calyx monitor inbox --json",
            }),
          }),
        ]));
      } finally {
        state.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Tier-2 bridge deliveries record Codex automation and Claude re-invocation evidence", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-tier2-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-tier2");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_tier2",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-tier2",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "codex-thread",
              adapter: "codex_automation",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              codex_automation: {
                codex_home: join(stateRoot, "codex-home"),
                thread_id: "019e7637-f599-7811-a4c1-c2edc6297666",
                dry_run: true,
              },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "claude-session",
              adapter: "claude_reinvoke",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_reinvoke: {
                command: "claude",
                session_id: "session-123",
                cwd: stateRoot,
                timeout_ms: 1_000,
              },
            },
          ]),
          now: "2026-06-11T06:00:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-11T06:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-tier2",
            state: "succeeded",
            updated_at: "2026-06-11T06:01:00.000Z",
            completed_at: "2026-06-11T06:01:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
        const wake = createMonitorWake(opened.db, {
          monitor: updated,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
        const execFile = vi.fn(async (
          command: string,
          args: string[],
          options: { env?: NodeJS.ProcessEnv | undefined },
        ) => {
          expect(command).toBe("claude");
          expect(args).toContain("--resume");
          expect(args).toContain("session-123");
          expect(args.at(-1)).toContain("calyx monitor inbox --json");
          expect(args.at(-1)).toContain(wake.wake_id);
          expect(options.env).toMatchObject({ SAFE_MONITOR_CHILD_VALUE: "preserved" });
          expect(options.env).not.toHaveProperty("CALYX_MONITOR_CATALOG_TOKEN");
          expect(options.env).not.toHaveProperty("CALYX_MONITOR_CATALOG_VERIFIER");
          expect(options.env).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_TOKEN");
          expect(options.env).not.toHaveProperty("CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256");
          expect(options.env).not.toHaveProperty("CALYX_RUN_SERVER_TOKEN");
          expect(options.env).not.toHaveProperty("LINEAR_API_KEY");
          return {
            stdout: `monitor inbox saw ${wake.wake_id}`,
            stderr: "",
          };
        });

        const summary = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-11T06:01:01.000Z",
          execFile,
          env: {
            SAFE_MONITOR_CHILD_VALUE: "preserved",
            CALYX_MONITOR_CATALOG_TOKEN: "catalog-token",
            CALYX_MONITOR_CATALOG_VERIFIER: "catalog-verifier",
            CALYX_CONSUMER_API_OPERATOR_TOKEN: "consumer-token",
            CALYX_CONSUMER_API_OPERATOR_VERIFIER_SHA256: "consumer-verifier",
            CALYX_RUN_SERVER_TOKEN: "legacy-token",
            LINEAR_API_KEY: "publisher-key",
          },
          serverOnlyEnvNames: [
            "CALYX_MONITOR_CATALOG_TOKEN",
            "CALYX_MONITOR_CATALOG_VERIFIER",
          ],
        });

        expect(summary).toMatchObject({
          attempted: 2,
          delivered: 2,
          failed: 0,
        });
        expect(execFile).toHaveBeenCalledTimes(1);
        const deliveries = listMonitorDeliveries(opened.db, { wake_id: wake.wake_id });
        expect(deliveries.map((delivery) => [delivery.binding_id, delivery.status]).sort()).toEqual([
          ["claude-session", "delivered"],
          ["codex-thread", "delivered"],
        ]);
        expect(deliveries.find((delivery) => delivery.binding_id === "codex-thread")?.evidence).toMatchObject({
          adapter: "codex_automation",
          mode: "dry_run",
          prompt_first_action: "calyx monitor inbox --json",
          programmatic_trigger_path: "not_exposed_by_codex_cli_0.138.0",
        });
        expect(deliveries.find((delivery) => delivery.binding_id === "claude-session")?.evidence).toMatchObject({
          adapter: "claude_reinvoke",
          prompt_first_action: "calyx monitor inbox --json",
          stdout: `monitor inbox saw ${wake.wake_id}`,
        });
        expect(listMonitorWakes(opened.db, { status: "pending", monitor_id: monitor.monitor_id })).toHaveLength(1);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Claude channel delivery records receiver acceptance once per wake binding", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-claude-channel-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
      CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN: process.env["CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");
    process.env["CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN"] = "receiver-secret";

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-claude-channel");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_claude_channel",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-claude-channel",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "claude-live-session",
              adapter: "claude_channel",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_channel: {
                receiver_url: "http://127.0.0.1:8788/calyx/monitor-wake",
                channel: "server:calyx-monitor",
                token_env: "CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN",
              },
            },
          ]),
          now: "2026-06-12T04:00:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-12T04:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-claude-channel",
            state: "succeeded",
            updated_at: "2026-06-12T04:01:00.000Z",
            completed_at: "2026-06-12T04:01:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
        const wake = createMonitorWake(opened.db, {
          monitor: updated,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
        const fetchImpl = vi.fn(async (
          url: string,
          init: {
            method: string;
            headers?: Record<string, string> | undefined;
            body?: string | undefined;
            signal?: AbortSignal | undefined;
          },
        ) => {
          expect(url).toBe("http://127.0.0.1:8788/calyx/monitor-wake");
          expect(init.headers?.["Authorization"]).toBe("Bearer receiver-secret");
          expect(JSON.parse(String(init.body))).toEqual({
            schema_version: "calyx.monitor-claude-channel-post/v1",
            wake_id: wake.wake_id,
            monitor_id: monitor.monitor_id,
            materiality: "always",
            first_command: "calyx monitor inbox --json",
          });
          return {
            ok: true,
            status: 202,
            text: async () => JSON.stringify({ ok: true, delivery: "receiver_http_accept_only" }),
          };
        });

        const first = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-12T04:01:01.000Z",
          fetch: fetchImpl,
          env: process.env,
        });
        const second = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-12T04:01:02.000Z",
          fetch: fetchImpl,
          env: process.env,
        });

        expect(first).toMatchObject({
          attempted: 1,
          delivered: 1,
          failed: 0,
        });
        expect(second).toMatchObject({
          attempted: 0,
          skipped: 1,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const deliveries = listMonitorDeliveries(opened.db, { wake_id: wake.wake_id });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({
          binding_id: "claude-live-session",
          status: "delivered",
        });
        expect(deliveries[0]?.evidence).toMatchObject({
          adapter: "claude_channel",
          channel: "server:calyx-monitor",
          payload_first_action: "calyx monitor inbox --json",
          channel_post_ack_semantics: "receiver_http_accept_only",
          http_status: 202,
        });
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (original.CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN === undefined) delete process.env["CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN"];
      else process.env["CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN"] = original.CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Codex app-server steer delivery uses active live bindings and preserves failed wakes", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-codex-steer-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const createWake = async (caseId: string, runId: string) => {
          const predicate = runnerSupervisionPredicate(runId);
          const monitor = createMonitor(opened.db, {
            monitor_id: `mon_service_codex_steer_${caseId}`,
            owner: "operator",
            created_by: "tester",
            create_provenance: "operator",
            assigned_host: "blade",
            source_run_id: runId,
            preset: "runner-supervision",
            predicate,
            rearm_policy: "every_change",
            delivery: createMonitorDeliveryPolicy([
              {
                schema_version: "calyx.monitor-delivery/v1",
                binding_id: `codex-steer-${caseId}`,
                adapter: "codex_app_server_steer",
                materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
                codex_app_server_steer: {
                  run_id: runId,
                  timeout_ms: 2_000,
                },
              },
            ]),
            now: "2026-06-12T06:00:00.000Z",
          });
          const evaluation = await evaluatePredicateV1(predicate, {
            now: () => new Date("2026-06-12T06:01:00.000Z"),
            readRun: () => ({
              run_id: runId,
              state: "failed",
              updated_at: "2026-06-12T06:01:00.000Z",
              completed_at: "2026-06-12T06:01:00.000Z",
            }),
          });
          const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
          const wake = createMonitorWake(opened.db, {
            monitor: updated,
            evaluation,
            suggested_commands: ["calyx monitor inbox --json"],
            created_at: evaluation.evaluated_at,
          }).wake;
          return { monitor: updated, wake };
        };

        const seedBinding = (
          runId: string,
          overrides: Partial<Parameters<typeof upsertRunnerLiveBinding>[1]> = {},
        ) => upsertRunnerLiveBinding(opened.db, {
          run_id: runId,
          adapter: "codex_app_server_steer",
          backend: "codex",
          lifecycle_owner: "calyx",
          host: "blade",
          status: "active",
          codex_home: join(stateRoot, "codex-home"),
          transport_kind: "stdio-jsonl",
          endpoint: {
            transport: "stdio-jsonl",
            command: "codex",
            args: ["app-server", "--listen", "stdio://"],
            experimental_api: true,
          },
          thread_id: `thread-${runId}`,
          active_turn_id: `turn-${runId}`,
          active_turn_source: "app-server-response:turn/start",
          active_turn_observed_at: "2026-06-12T06:00:30.000Z",
          active_turn_status: "in_progress",
          adapter_session_id: `session-${runId}`,
          connection_id: `connection-${runId}`,
          auth_ref: { mode: "codex_home", codex_home: join(stateRoot, "codex-home") },
          now: "2026-06-12T06:00:00.000Z",
          ...overrides,
        });

        const readOnlyDelivery = (wakeId: string) => listMonitorDeliveries(opened.db, { wake_id: wakeId })[0]!;

        const success = await createWake("success", "run-codex-steer-success");
        seedBinding("run-codex-steer-success");
        const steer = vi.fn(async (input) => {
          expect(input).toMatchObject({
            run_id: "run-codex-steer-success",
            thread_id: "thread-run-codex-steer-success",
            expected_turn_id: "turn-run-codex-steer-success",
            timeout_ms: 2_000,
          });
          expect(input.input).toHaveLength(1);
          expect(Object.keys(input.input[0] ?? {}).sort()).toEqual(["text", "text_elements", "type"]);
          expect(String(input.input[0]?.["text"])).toContain(success.wake.wake_id);
          expect(String(input.input[0]?.["text"])).toContain("calyx monitor inbox --json");
          return { turn_id: input.expected_turn_id, response: { accepted: true } };
        });
        const first = await deliverMonitorWakeBindings(opened.db, success.monitor, success.wake, {
          now: () => "2026-06-12T06:01:01.000Z",
          codexAppServerSteer: steer,
          env: {},
        });
        const second = await deliverMonitorWakeBindings(opened.db, success.monitor, success.wake, {
          now: () => "2026-06-12T06:01:02.000Z",
          codexAppServerSteer: steer,
          env: {},
        });
        expect(first).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
        expect(second).toMatchObject({ attempted: 0, skipped: 1 });
        expect(steer).toHaveBeenCalledTimes(1);
        expect(readOnlyDelivery(success.wake.wake_id)).toMatchObject({
          status: "delivered",
          evidence: {
            adapter: "codex_app_server_steer",
            payload_first_action: "calyx monitor inbox --json",
            expected_turn_id: "turn-run-codex-steer-success",
          },
        });

        const cases: Array<{
          id: string;
          code: string;
          seed: (runId: string) => void;
          steer?: ReturnType<typeof vi.fn>;
        }> = [
          {
            id: "no_active_turn",
            code: "no_steerable_turn",
            seed: (runId) => {
              seedBinding(runId, {
                active_turn_id: null,
                active_turn_source: null,
                active_turn_observed_at: null,
                active_turn_status: null,
              });
            },
          },
          {
            id: "expected_mismatch",
            code: "expected_turn_mismatch",
            seed: (runId) => {
              seedBinding(runId);
            },
            steer: vi.fn(async () => {
              throw Object.assign(new Error("expectedTurnId mismatch"), { code: "expected_turn_mismatch" });
            }),
          },
          {
            id: "non_steerable",
            code: "active_turn_not_steerable",
            seed: (runId) => {
              seedBinding(runId, { active_turn_status: "review" });
            },
          },
          {
            id: "closed_transport",
            code: "transport_unavailable",
            seed: (runId) => {
              seedBinding(runId, { status: "closed", closed_at: "2026-06-12T06:00:45.000Z" });
            },
          },
          {
            id: "missing_auth",
            code: "auth_unavailable",
            seed: (runId) => {
              seedBinding(runId, { auth_ref: {} });
            },
          },
          {
            id: "desktop_endpoint",
            code: "transport_unavailable",
            seed: (runId) => {
              seedBinding(runId, {
                endpoint: {
                  transport: "unix-socket",
                  path: join(stateRoot, ".codex", "app-server-control", "desktop-ssh-websocket-v0.sock"),
                },
              });
            },
          },
        ];

        for (const current of cases) {
          const runId = `run-codex-steer-${current.id}`;
          const { monitor, wake } = await createWake(current.id, runId);
          current.seed(runId);
          const summary = await deliverMonitorWakeBindings(opened.db, monitor, wake, {
            now: () => "2026-06-12T06:02:01.000Z",
            codexAppServerSteer: current.steer,
            env: {},
          });
          expect(summary).toMatchObject({ attempted: 1, delivered: 0, failed: 1 });
          expect(readOnlyDelivery(wake.wake_id)).toMatchObject({
            status: "failed",
            error_code: current.code,
          });
          expect(listMonitorWakes(opened.db, { status: "pending", monitor_id: monitor.monitor_id })).toHaveLength(1);
        }
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Claude channel closed and unreachable receivers record failed deliveries without consuming the inbox wake", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-claude-channel-fail-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-claude-channel-fail");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_claude_channel_fail",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-claude-channel-fail",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "claude-closed-session",
              adapter: "claude_channel",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_channel: {
                receiver_url: "http://127.0.0.1:8789/calyx/monitor-wake",
                channel: "server:calyx-monitor",
              },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "claude-unreachable",
              adapter: "claude_channel",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_channel: {
                receiver_url: "http://127.0.0.1:8790/calyx/monitor-wake",
                channel: "server:calyx-monitor",
              },
            },
          ]),
          now: "2026-06-12T05:00:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-12T05:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-claude-channel-fail",
            state: "failed",
            updated_at: "2026-06-12T05:01:00.000Z",
            completed_at: "2026-06-12T05:01:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
        const wake = createMonitorWake(opened.db, {
          monitor: updated,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
        const fetchImpl = vi.fn(async (url: string) => {
          if (url.includes(":8789/")) {
            return {
              ok: false,
              status: 409,
              text: async () => JSON.stringify({ ok: false, error_code: "closed_session" }),
            };
          }
          throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
        });

        const summary = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-12T05:01:01.000Z",
          fetch: fetchImpl,
          env: {},
        });

        expect(summary).toMatchObject({
          attempted: 2,
          delivered: 0,
          failed: 2,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const deliveries = listMonitorDeliveries(opened.db, { wake_id: wake.wake_id });
        expect(deliveries.map((delivery) => [delivery.binding_id, delivery.status, delivery.error_code]).sort()).toEqual([
          ["claude-closed-session", "failed", "closed_session"],
          ["claude-unreachable", "failed", "network_error"],
        ]);
        expect(listMonitorWakes(opened.db, { status: "pending", monitor_id: monitor.monitor_id })).toHaveLength(1);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("Claude re-invocation failure records failed delivery without consuming the inbox wake", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-claude-fail-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-claude-fail");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_claude_fail",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-claude-fail",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "claude-dead-target",
              adapter: "claude_reinvoke",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "always" },
              claude_reinvoke: {
                session_id: "missing-session",
              },
            },
          ]),
          now: "2026-06-11T07:00:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-11T07:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-claude-fail",
            state: "failed",
            updated_at: "2026-06-11T07:01:00.000Z",
            completed_at: "2026-06-11T07:01:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
        const wake = createMonitorWake(opened.db, {
          monitor: updated,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
        const execError = Object.assign(new Error("claude session not found"), {
          stdout: "",
          stderr: "No session found",
        });
        const execFile = vi.fn(async (
          _command: string,
          _args: string[],
          options: { timeoutMs?: number | undefined },
        ) => {
          expect(options.timeoutMs).toBe(30_000);
          throw execError;
        });

        const summary = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-11T07:01:01.000Z",
          execFile,
          env: {},
        });

        expect(summary).toMatchObject({
          attempted: 1,
          delivered: 0,
          failed: 1,
        });
        const deliveries = listMonitorDeliveries(opened.db, { wake_id: wake.wake_id });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({
          binding_id: "claude-dead-target",
          status: "failed",
          error_code: "process_failed",
        });
        expect(deliveries[0]?.evidence).toMatchObject({
          adapter: "claude_reinvoke",
          stderr: "No session found",
          bridge_floor: "wake remains pullable through calyx monitor inbox",
        });
        expect(listMonitorWakes(opened.db, { status: "pending", monitor_id: monitor.monitor_id })).toHaveLength(1);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("delivery materiality routes failed and successful wakes to different bindings", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-materiality-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-materiality");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_materiality",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-materiality",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "failure-ntfy",
              adapter: "ntfy",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "run_failed_or_stalled" },
              ntfy: { url: "https://ntfy.test", topic: "scratch-failures" },
            },
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "success-linear",
              adapter: "linear_comment",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "run_success" },
              linear_comment: { issue_id: "POL-SCRATCH", dry_run: true },
            },
          ]),
          now: "2026-06-11T00:00:00.000Z",
        });
        const failedEvaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-11T04:00:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-materiality",
            state: "failed",
            issue: "POL-SCRATCH",
            updated_at: "2026-06-11T04:00:00.000Z",
            completed_at: "2026-06-11T04:00:00.000Z",
          }),
        });
        const failedMonitor = recordMonitorEvaluation(opened.db, monitor.monitor_id, failedEvaluation)!;
        const failedWake = createMonitorWake(opened.db, {
          monitor: failedMonitor,
          evaluation: failedEvaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: failedEvaluation.evaluated_at,
        }).wake;
        const fetchImpl = vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => "boom",
        }));
        const failedSummary = await deliverMonitorWakeBindings(opened.db, failedMonitor, failedWake, {
          now: () => "2026-06-11T04:00:01.000Z",
          fetch: fetchImpl,
          env: {},
        });
        expect(failedSummary).toMatchObject({
          attempted: 1,
          delivered: 0,
          failed: 1,
        });
        expect(listMonitorWakes(opened.db, { status: "pending", monitor_id: monitor.monitor_id })).toHaveLength(1);

        const successEvaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-11T04:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-materiality",
            state: "succeeded",
            issue: "POL-SCRATCH",
            updated_at: "2026-06-11T04:01:00.000Z",
            completed_at: "2026-06-11T04:01:00.000Z",
          }),
        }, failedEvaluation.cursor);
        const successMonitor = recordMonitorEvaluation(opened.db, monitor.monitor_id, successEvaluation)!;
        const successWake = createMonitorWake(opened.db, {
          monitor: successMonitor,
          evaluation: successEvaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: successEvaluation.evaluated_at,
        }).wake;
        const successSummary = await deliverMonitorWakeBindings(opened.db, successMonitor, successWake, {
          now: () => "2026-06-11T04:01:01.000Z",
          fetch: fetchImpl,
          env: {},
        });
        expect(successSummary).toMatchObject({
          attempted: 1,
          delivered: 1,
          failed: 0,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const failedDeliveries = listMonitorDeliveries(opened.db, { wake_id: failedWake.wake_id });
        const successDeliveries = listMonitorDeliveries(opened.db, { wake_id: successWake.wake_id });
        expect(failedDeliveries.map((delivery) => [delivery.binding_id, delivery.status])).toEqual([
          ["failure-ntfy", "failed"],
        ]);
        expect(successDeliveries.map((delivery) => [delivery.binding_id, delivery.status])).toEqual([
          ["success-linear", "delivered"],
        ]);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("ntfy delivery timeout records a failed delivery without hanging", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-monitor-timeout-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const opened = await openStateStore();
      try {
        const predicate = runnerSupervisionPredicate("run-monitor-timeout");
        const monitor = createMonitor(opened.db, {
          monitor_id: "mon_service_delivery_timeout",
          owner: "operator",
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-timeout",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "every_change",
          delivery: createMonitorDeliveryPolicy([
            {
              schema_version: "calyx.monitor-delivery/v1",
              binding_id: "timeout-ntfy",
              adapter: "ntfy",
              materiality: { schema_version: "calyx.monitor-materiality/v1", kind: "run_failed_or_stalled" },
              ntfy: { url: "https://ntfy.test", topic: "scratch-timeout" },
            },
          ]),
          now: "2026-06-11T05:00:00.000Z",
        });
        const evaluation = await evaluatePredicateV1(predicate, {
          now: () => new Date("2026-06-11T05:01:00.000Z"),
          readRun: () => ({
            run_id: "run-monitor-timeout",
            state: "failed",
            issue: "POL-SCRATCH",
            updated_at: "2026-06-11T05:01:00.000Z",
            completed_at: "2026-06-11T05:01:00.000Z",
          }),
        });
        const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation)!;
        const wake = createMonitorWake(opened.db, {
          monitor: updated,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
        const fetchImpl = vi.fn((_url: string, init: { signal?: AbortSignal | undefined }) =>
          new Promise<{
            ok: boolean;
            status: number;
            text: () => Promise<string>;
          }>((_resolve, reject) => {
            expect(init.signal).toBeInstanceOf(AbortSignal);
            const rejectAborted = () => reject(init.signal?.reason ?? new Error("aborted"));
            if (init.signal?.aborted) {
              rejectAborted();
              return;
            }
            init.signal?.addEventListener("abort", rejectAborted, { once: true });
          })
        );

        const summary = await deliverMonitorWakeBindings(opened.db, updated, wake, {
          now: () => "2026-06-11T05:01:01.000Z",
          fetch: fetchImpl,
          env: {},
          timeoutMs: 1,
        });

        expect(summary).toMatchObject({
          attempted: 1,
          delivered: 0,
          failed: 1,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const deliveries = listMonitorDeliveries(opened.db, { wake_id: wake.wake_id });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({
          binding_id: "timeout-ntfy",
          status: "failed",
          error_code: "network_error",
        });
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("monitor evaluator records task launch intents from active task installs without launching runs", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "calyx-run-service-task-state-"));
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = join(stateRoot, "state");

    try {
      await applyStateMigrations();
      const task: TaskManifest = {
        version: 1,
        kind: "task",
        id: "service-after-task",
        name: "Service After Task",
        status: "active",
        triggers: [
          {
            type: "schedule",
            predicate: {
              schema_version: "predicate/v1",
              kind: "time.after",
              at: "2000-01-01T00:00:00.000Z",
            },
          },
        ],
        runtime: {
          backend: "claude_desktop",
          workspace: { mode: "existing", cwd: runsRoot },
        },
        prompt: { body: "Record a launch intent." },
      };
      const opened = await openStateStore();
      try {
        installTask(opened.db, {
          task,
          manifest_path: "/tmp/service-after-task.task.yaml",
          host: "blade",
          installed_by: "tester",
          status: "active",
          now: "2026-06-11T00:00:00.000Z",
        });
      } finally {
        opened.db.close();
      }

      const service = new RunService({
        runsRoot,
        monitorEvaluator: { enabled: true, assignedHost: "blade" },
      }, buildDeps());

      const first = await service.evaluateMonitorsOnce();
      const second = await service.evaluateMonitorsOnce();

      expect(first).toMatchObject({
        status: "ok",
        scanned: 0,
        taskInstallsScanned: 1,
        taskLaunchIntentsCreated: 1,
      });
      expect(second).toMatchObject({
        status: "ok",
        scanned: 0,
        taskInstallsScanned: 1,
        taskLaunchIntentsCreated: 0,
      });

      const state = await openStateStore();
      try {
        const taskRuns = listTaskRuns(state.db, { task_id: "service-after-task" });
        expect(taskRuns).toHaveLength(1);
        expect(taskRuns[0]).toMatchObject({
          status: "launch_intent_recorded",
          run_id: null,
          dry_run: true,
        });
      } finally {
        state.db.close();
      }
      const receipt = await readFile(join(stateRoot, "state", "receipts", "task-runs.jsonl"), "utf8");
      expect(receipt).toContain("service-after-task");
      expect(receipt).toContain("launch_intent_recorded");
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  test("foreground launch resolves vault:// execplan refs using the configured agents-infra root", async () => {
    const agentsInfraRoot = join(runsRoot, "agents-infra");
    const bladeHome = join(runsRoot, "blade-home");
    const execplanPath = join(bladeHome, "vault", "fieldwork", "20-plans", "vault-plan.md");
    const hostsPath = join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
    const skillsRegistryPath = join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    const templateRegistryPath = join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");

    await mkdir(join(bladeHome, "vault", "fieldwork", "20-plans"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await writeFile(execplanPath, "# ExecPlan\n\nService launch coverage.\n", "utf8");
    await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
    await writeFile(
      templateRegistryPath,
      `${JSON.stringify({
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: bladeHome,
            vault_root: join(bladeHome, "vault", "fieldwork"),
          },
        },
      }),
      "utf8",
    );

    const service = new RunService({ runsRoot, agentsInfraRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-vault-launch-1",
      host: "blade",
      backend: "codex",
      execplan_ref: "vault://20-plans/vault-plan.md",
    });

    const result = await service.launch(intent, { detached: false });

    expect(result.record.state).toBe("succeeded");
    expect(result.record.spec && "execplan_source" in result.record.spec && result.record.spec.execplan_source).toBe(execplanPath);
    await expect(readFile(service.store.paths(intent.run_id).specPath, "utf8")).resolves.toContain(execplanPath);
  });

  test("launch preserves requested repo identity while resolved spec uses canonical slug", async () => {
    const agentsInfraRoot = join(runsRoot, "agents-infra-repo-alias");
    const bladeHome = join(runsRoot, "blade-home-repo-alias");
    const repoPath = join(bladeHome, "dev", "polli", "dev");
    const hostsPath = join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
    const skillsRegistryPath = join(agentsInfraRoot, "instructions", "skills", "SOURCES.json");
    const templateRegistryPath = join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");

    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await mkdir(repoPath, { recursive: true });
    await writeFile(skillsRegistryPath, `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`, "utf8");
    await writeFile(
      templateRegistryPath,
      `${JSON.stringify({
        globals: {
          hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
          variants: [],
          legacy: [],
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: bladeHome,
            repos: {
              polli: {
                path: repoPath,
                aliases: ["polli-labs/polli"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    const service = new RunService({ runsRoot, agentsInfraRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-repo-alias-launch-1",
      host: "blade",
      backend: "codex",
      repo: "git@github.com:polli-labs/polli.git",
      prompt: "Use the repo.",
      branch: "calyx-run/pol-1402",
      require_execplan: false,
    });

    const result = await service.launch(intent, { detached: false });

    expect(result.record.intent.repo).toBe("git@github.com:polli-labs/polli.git");
    expect(result.record.spec && "worktree" in result.record.spec && result.record.spec.worktree.repo).toBe("polli");
    await expect(readFile(service.store.paths(intent.run_id).runRecordPath, "utf8")).resolves.toContain(
      '"repo": "git@github.com:polli-labs/polli.git"',
    );
    await expect(readFile(service.store.paths(intent.run_id).specPath, "utf8")).resolves.toContain('"repo": "polli"');
  });

  test("host_process health watchers can mark an active run healthy from file freshness", async () => {
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => new Date().toISOString(),
      },
    );
    const progressPath = join(runsRoot, "health-progress.jsonl");
    // The child used to emit one progress tick and then `process.exit(0)` at
    // t+1000ms, while the observation below is a bare `vi.waitFor` whose
    // default budget is also 1000ms. Observation window == subject lifetime,
    // so under load the child could die before "running + healthy" was ever
    // sampled and the assertion could never pass. Keep the child alive on a
    // sentinel the test controls, and keep emitting progress so `stale_after_ms`
    // cannot expire mid-observation either. The 60s backstop only prevents a
    // leaked child if this test fails before writing the sentinel.
    const stopPath = join(runsRoot, "health-progress.stop");
    const intent = service.createIntent({
      host: "local",
      issue: "POL-842",
      kernel: "host_process",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const progressPath = process.argv[1];",
            "const stopPath = process.argv[2];",
            "let tick = 0;",
            "setInterval(() => fs.writeFileSync(progressPath, `tick-${++tick}\\n`, 'utf8'), 200);",
            "setTimeout(() => fs.writeFileSync(progressPath, 'tick-1\\n', 'utf8'), 20);",
            "setInterval(() => { if (fs.existsSync(stopPath)) process.exit(0); }, 10);",
            "setTimeout(() => process.exit(0), 60000);",
          ].join(" "),
          progressPath,
          stopPath,
        ],
        cwd: runsRoot,
        stop_grace_ms: 250,
        health: {
          stale_after_ms: 2000,
          poll_interval_ms: 10,
          sources: [{ kind: "file", path: progressPath }],
        },
      },
    });

    const launchPromise = service.launch(intent, { detached: false });
    await vi.waitFor(async () => {
      const record = await service.getRunRecord(intent.run_id);
      expect(record?.state).toBe("running");
      expect(record?.health?.status).toBe("healthy");
      expect(record?.health?.last_progress_at).toBeTypeOf("string");
    }, { timeout: 15_000 });

    const runningRecord = await service.getRunRecord(intent.run_id);
    expect(new Date(runningRecord!.updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(runningRecord!.health!.last_progress_at!).getTime());

    await writeFile(stopPath, "", "utf8");
    const result = await launchPromise;
    expect(result.record.state).toBe("succeeded");
    expect(result.record.health?.status).toBe("healthy");
    expect(result.record.kernel_receipt && "health" in result.record.kernel_receipt).toBe(true);
    const linearComment = await readFile(join(service.store.paths(intent.run_id).runDir, "linear-comment.md"), "utf8");
    expect(linearComment).not.toContain("\nHealth:");
  });

  test("host_process health can become stale while the child process is still running", async () => {
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => new Date().toISOString(),
      },
    );
    const releasePath = join(runsRoot, "health-stale-release");
    const intent = service.createIntent({
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const releasePath = process.argv[1];",
            "const parentPid = process.ppid;",
            "setTimeout(() => process.exit(3), 30_000).unref();",
            "console.log('tick-1');",
            "const releasePoll = setInterval(() => {",
            "  if (fs.existsSync(releasePath)) {",
            "    clearInterval(releasePoll);",
            "    process.exit(0);",
            "  }",
            "  try {",
            "    process.kill(parentPid, 0);",
            "  } catch {",
            "    clearInterval(releasePoll);",
            "    process.exit(2);",
            "  }",
            "  if (!fs.existsSync(path.dirname(releasePath))) {",
            "    clearInterval(releasePoll);",
            "    process.exit(2);",
            "  }",
            "}, 10);",
          ].join(" "),
          releasePath,
        ],
        cwd: runsRoot,
        stop_grace_ms: 250,
        health: {
          stale_after_ms: 40,
          poll_interval_ms: 10,
          sources: [{ kind: "stdout" }],
        },
      },
    });

    const launchPromise = service.launch(intent, { detached: false });
    try {
      await vi.waitFor(async () => {
        const record = await service.getRunRecord(intent.run_id);
        expect(record?.state).toBe("running");
        expect(record?.health?.status).toBe("stale");
        expect(record?.health?.last_progress_at).toBeTypeOf("string");
      });

      const runningRecord = await service.getRunRecord(intent.run_id);
      expect(runningRecord?.state).toBe("running");
      expect(runningRecord?.health?.status).toBe("stale");
      expect(new Date(runningRecord!.updated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(runningRecord!.health!.last_progress_at!).getTime());

      await writeFile(releasePath, "release\n", "utf8");
      const result = await launchPromise;
      expect(result.record.state).toBe("succeeded");
      expect(result.record.health?.status).toBe("stale");
    } finally {
      await writeFile(releasePath, "release\n", "utf8").catch(() => undefined);
      await launchPromise.catch(() => undefined);
    }
  });

  test("agent_runner health becomes stale while active and refreshes on later activity", async () => {
    let adapterStarted = false;
    let releaseActivity!: () => void;
    const activityRelease = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const adapter: BackendAdapter = {
      name: "codex",
      capabilities: {
        streaming: false,
        turnControl: false,
        resumeSession: false,
        forkSession: false,
        approvals: "none",
      },
      spawn: async (opts): Promise<AdapterResult> => {
        adapterStarted = true;
        await activityRelease;
        const emitActivity = (): void => {
          opts.onActivity?.({
            source: "turn",
            timestamp: new Date().toISOString(),
            detail: "test-turn-progress",
          });
        };
        emitActivity();
        const activityTimer = setInterval(emitActivity, 10);
        activityTimer.unref();
        try {
          await completionRelease;
        } finally {
          clearInterval(activityTimer);
        }
        return {
          exit_code: 0,
          stderr: "",
          events: [],
          duration_ms: 160,
        };
      },
      stop: async (): Promise<void> => {},
    };
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new AgentRunnerKernel({
          runtimeAdapterRegistry: {
            register: () => {},
            create: () => adapter,
            has: () => true,
            list: () => ["codex"],
          },
          executeRun,
        }),
        hostname: () => "blade",
        now: () => new Date().toISOString(),
      },
    );
    const intent = service.createIntent({
      host: "local",
      backend: "codex",
      prompt: "watch progress",
      require_execplan: false,
      worktree_mode: "existing",
      worktree_path: runsRoot,
      backend_options: {
        agent_activity: {
          stale_after_ms: 30,
          poll_interval_ms: 10,
        },
      },
    });

    const launchPromise = service.launch(intent, { detached: false });
    try {
      await vi.waitFor(() => {
        expect(adapterStarted).toBe(true);
      });
      await vi.waitFor(async () => {
        const record = await service.getRunRecord(intent.run_id);
        expect(record?.state).toBe("running");
        expect(record?.health?.source).toBe("agent_runner");
        expect(record?.health?.status).toBe("stale");
      });

      releaseActivity();
      await vi.waitFor(async () => {
        const record = await service.getRunRecord(intent.run_id);
        expect(record?.health?.status).toBe("healthy");
        expect(record?.health?.last_activity_at).toBeTypeOf("string");
        expect(record?.health?.last_progress_at).toBeTypeOf("string");
        const active = await service.listRuns();
        const activeEntry = active.find((entry) => entry.run_id === intent.run_id);
        expect(activeEntry?.health_status).toBe("healthy");
        expect(activeEntry?.last_progress_at).toBeTypeOf("string");
      });

      releaseCompletion();
      const result = await launchPromise;
      expect(result.record.state).toBe("succeeded");
      expect(result.record.health?.source).toBe("agent_runner");
      expect(result.record.kernel_receipt && !("kernel" in result.record.kernel_receipt)
        ? result.record.kernel_receipt.health?.source
        : undefined).toBe("agent_runner");
    } finally {
      releaseActivity();
      releaseCompletion();
      await launchPromise.catch(() => undefined);
    }
  });

  test("createSingleFlightPoller reuses the active poll promise and resets after completion", async () => {
    const poller = createSingleFlightPoller();
    let launches = 0;
    let releaseFirst!: () => void;

    const first = poller.run(async () => {
      launches += 1;
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = poller.run(async () => {
      launches += 1;
    });

    expect(second).toBe(first);
    expect(launches).toBe(1);
    expect(poller.current()).toBe(first);

    releaseFirst();
    await second;
    expect(poller.current()).toBeUndefined();

    await poller.run(async () => {
      launches += 1;
    });
    expect(launches).toBe(2);
  });

  test("HostProcessKernel escalates stop requests into a bounded kill path", async () => {
    const kernel = new HostProcessKernel();
    const readyPath = join(runsRoot, "host-process-stop.ready");
    await rm(readyPath, { force: true });
    const intent: RunIntent = {
      run_id: "run-host-stop-1",
      kernel: "host_process",
      host: "local",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const readyPath = process.argv[1];",
            "process.on('SIGTERM', () => {});",
            "fs.writeFileSync(readyPath, 'ready', 'utf8');",
            "setInterval(() => {}, 1000);",
          ].join(" "),
          readyPath,
        ],
        cwd: runsRoot,
        stop_grace_ms: 50,
      },
      created_at: "2026-03-11T12:00:00.000Z",
    };
    const spec = await kernel.resolveIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const executionId = "host-process-stop-execution";
    const hostProcessExecution = admitHostProcessExecution(
      spec,
      executionId,
      freezeHostProcessSpawnEnvironment(spec.process.env, process.env),
    );
    let terminate: (() => void) | undefined;
    const receiptPath = join(runsRoot, "host-process-stop", "kernel_receipt.json");

    const resultPromise = kernel.executeResolvedSpec(spec, {
      intent,
      executionId,
      hostProcessExecution,
      receiptPath,
      defaultWorktreeBase: runsRoot,
      discoverArtifacts: async () => [],
      registerTerminationHook: (handler) => {
        terminate = handler;
      },
    });

    await vi.waitFor(() => {
      expect(terminate).toBeTypeOf("function");
    });
    await vi.waitFor(async () => {
      await expect(readFile(readyPath, "utf8")).resolves.toBe("ready");
    });
    terminate?.();

    const result = await resultPromise;

    expect(result.receipt.state).toBe("cancelled");
    expect(result.receipt.process.stop_requested).toBe(true);
    expect(result.receipt.process.stop_signal).toBe("SIGKILL");
    expect(result.receipt.exit.exit_code).toBe(137);
    await expect(readFile(receiptPath, "utf8")).resolves.toContain(`"state": "cancelled"`);
  });

  test("HostProcessKernel stops a forwarded parent-child tree by targeting the workload process group", async () => {
    const kernel = new HostProcessKernel();
    const childPidPath = join(runsRoot, "host-process-tree-child.pid");
    const childReadyPath = join(runsRoot, "host-process-tree-child.ready");
    const intent: RunIntent = {
      run_id: "run-host-stop-tree-1",
      kernel: "host_process",
      host: "local",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const { spawn } = require('node:child_process');",
            "const childPidPath = process.argv[1];",
            "const childReadyPath = process.argv[2];",
            "const worker = spawn(process.execPath, ['-e', 'const fs = require(\"node:fs\"); const readyPath = process.argv[1]; process.on(\"SIGTERM\",()=>{}); fs.writeFileSync(readyPath, \"ready\", \"utf8\"); setInterval(()=>{},1000);', childReadyPath], { stdio: 'ignore' });",
            "fs.writeFileSync(childPidPath, String(worker.pid), 'utf8');",
            "process.on('SIGTERM', () => {",
            "  try { process.kill(worker.pid, 'SIGTERM'); } catch {}",
            "  process.exit(0);",
            "});",
            "setInterval(() => {}, 1000);",
          ].join(" "),
          childPidPath,
          childReadyPath,
        ],
        cwd: runsRoot,
        stop_grace_ms: 100,
      },
      created_at: "2026-03-11T12:00:00.000Z",
    };
    const spec = await kernel.resolveIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const executionId = "host-process-tree-stop-execution";
    const hostProcessExecution = admitHostProcessExecution(
      spec,
      executionId,
      freezeHostProcessSpawnEnvironment(spec.process.env, process.env),
    );
    let terminate: (() => void) | undefined;
    const receiptPath = join(runsRoot, "host-process-tree-stop", "kernel_receipt.json");

    const resultPromise = kernel.executeResolvedSpec(spec, {
      intent,
      executionId,
      hostProcessExecution,
      receiptPath,
      defaultWorktreeBase: runsRoot,
      discoverArtifacts: async () => [],
      registerTerminationHook: (handler) => {
        terminate = handler;
      },
    });

    await vi.waitFor(() => {
      expect(terminate).toBeTypeOf("function");
    });
    await vi.waitFor(async () => {
      const childPidText = await readFile(childPidPath, "utf8");
      expect(Number.parseInt(childPidText.trim(), 10)).toBeGreaterThan(0);
    });
    await vi.waitFor(async () => {
      await expect(readFile(childReadyPath, "utf8")).resolves.toBe("ready");
    });
    terminate?.();

    const result = await resultPromise;
    const childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10);
    let childAlive = false;
    try {
      process.kill(childPid, 0);
      childAlive = true;
    } catch {
      childAlive = false;
    } finally {
      if (childAlive) {
        process.kill(childPid, "SIGKILL");
      }
    }

    expect(result.receipt.state).toBe("cancelled");
    expect(result.receipt.process.stop_requested).toBe(true);
    expect(result.receipt.process.process_group_id).toBe(result.receipt.process.pid);
    expect(result.receipt.process.stop_signal).toBe("SIGKILL");
    expect(childAlive).toBe(false);
  });

  test("HTTP stop durably admits cancellation before reporting success", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-provenance-stop",
      host: "local",
      prompt: "Stop with attribution",
      require_execplan: false,
    });
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000006");
    await service.initializeRun(intent);
    const kill = vi.spyOn(process, "kill");

    await expect(service.stop(intent.run_id, { reason: "operator request", provenance }))
      .resolves.toEqual({
        schema_version: "calyx.run-cancellation-result/v1",
        status: "cancellation_requested",
        run_id: intent.run_id,
        requested_at: "2026-03-11T12:00:00.000Z",
      });
    expect(kill).not.toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
    await expect(service.store.readCancellation(intent.run_id)).resolves.toEqual({
      schema_version: "calyx.run-cancellation/v1",
      run_id: intent.run_id,
      requested_at: "2026-03-11T12:00:00.000Z",
      reason: "operator request",
      provenance,
    });

    const events = (await service.readEvents(intent.run_id)).filter(isRunServiceEvent);
    const stopEvents = events.filter((event) => event.event === "stop_intent" || event.event === "stop_result");
    expect(stopEvents).toHaveLength(2);
    expect(stopEvents[0]).toMatchObject({
      event: "stop_intent",
      provenance,
      payload: { correlation_id: provenance.request_id, reason: "operator request" },
    });
    expect(stopEvents[1]).toMatchObject({
      event: "stop_result",
      provenance,
      payload: {
        outcome: "completed",
        status: "cancellation_requested",
        requested_at: "2026-03-11T12:00:00.000Z",
        transport: "durable_marker",
      },
    });
    expect(events.filter((event) => (
      event.event === "warning"
      && event.message === "Durable cancellation requested for run worker."
    ))).toHaveLength(1);
  });

  test("stop retries return the first admitted marker even after terminalization", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-stop-retry-after-terminal",
      host: "local",
      prompt: "Preserve cancellation admission",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    const first = await service.stop(intent.run_id, { reason: "first request" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "cancelled",
      summary: `Run ${intent.run_id} cancelled.`,
      completed_at: "2026-03-11T12:01:00.000Z",
      updated_at: "2026-03-11T12:01:00.000Z",
    });

    await expect(service.stop(intent.run_id, { reason: "lost-response retry" }))
      .resolves.toEqual(first);
  });

  test("a failing inline acceleration hook cannot downgrade durable cancellation admission", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-stop-hook-failure",
      host: "local",
      prompt: "The marker is authoritative",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const handlers = (service as unknown as {
      inlineStopHandlers: Map<string, () => void>;
    }).inlineStopHandlers;
    handlers.set(intent.run_id, () => {
      throw new Error("inline hook failed");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.stop(intent.run_id)).resolves.toMatchObject({
      status: "cancellation_requested",
      run_id: intent.run_id,
    });
    await expect(service.store.readCancellation(intent.run_id)).resolves.toMatchObject({
      run_id: intent.run_id,
    });
    expect(warning).toHaveBeenCalledWith(
      `calyx run inline cancellation hook failed for ${intent.run_id}`,
      "inline hook failed",
    );
    warning.mockRestore();
  });

  test("HTTP stop aborts before cancellation when durable intent fails and records marker failures as indeterminate", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-provenance-stop-failure",
      host: "local",
      prompt: "Fail this stop",
      require_execplan: false,
    });
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000007");
    await service.initializeRun(intent);

    const durableAppend = vi.spyOn(service.store, "appendDurableEvent")
      .mockRejectedValueOnce(new Error("fsync failed"));
    const cancellation = vi.spyOn(service.store, "requestCancellation");
    await expect(service.stop(intent.run_id, { provenance })).rejects.toThrow("fsync failed");
    expect(cancellation).not.toHaveBeenCalled();
    durableAppend.mockRestore();

    cancellation.mockRejectedValueOnce(new Error("cancellation fsync failed"));
    await expect(service.stop(intent.run_id, { provenance })).rejects.toThrow("cancellation fsync failed");
    const events = (await service.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(events.filter((event) => event.event === "stop_intent")).toHaveLength(1);
    expect(events.find((event) => event.event === "stop_result")).toMatchObject({
      provenance,
      payload: {
        outcome: "indeterminate",
        status: "cancellation_admission_failed",
        error_code: "cancellation_admission_failed",
      },
    });
  });

  test("HTTP stop on an unknown run is a no-op that creates no run directory", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const runId = "run-provenance-stop-unknown";

    await expect(service.stop(runId, {
      provenance: apiProvenance("req_00000000-0000-4000-8000-000000000008"),
    })).rejects.toMatchObject({ name: "RunNotFoundError", runId });
    await expect(service.store.runExists(runId)).resolves.toBe(false);
    await expect(service.store.listRunIds()).resolves.not.toContain(runId);
  });

  test("an orphan cancellation marker cannot manufacture a known run", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const runId = "run-orphan-cancellation-marker";
    await service.store.requestCancellation({
      schema_version: "calyx.run-cancellation/v1",
      run_id: runId,
      requested_at: "2026-03-11T12:00:00.000Z",
      reason: "orphan fixture",
    });

    await expect(service.stop(runId)).rejects.toMatchObject({
      name: "RunNotFoundError",
      runId,
    });
  });

  test("stop settles an owner-free post-dispatch run through reconcile (POL-1897)", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-stop-owner-free-settlement",
      host: "local",
      prompt: "Dead worker settles on stop",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "worker-crashed-before-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const result = await service.stop(intent.run_id, { reason: "operator stop" });

    expect(result).toMatchObject({
      status: "cancellation_requested",
      worker_ownership: "owner_free",
      settled_state: "infra_error",
    });
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
    const events = await service.readEvents(intent.run_id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({ reconcile: "owner_free_fail_closed" }),
      }),
    ]));
  });

  test("stop on a queued run stays pure cancellation admission", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const reconcileSpy = vi.spyOn(service, "reconcile");
    const intent = service.createIntent({
      run_id: "run-stop-queued-no-settlement",
      host: "local",
      prompt: "Queued runs settle at effect admission, not at stop",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "detached" });

    const result = await service.stop(intent.run_id, { reason: "operator stop" });

    expect(result.status).toBe("cancellation_requested");
    expect(result).not.toHaveProperty("worker_ownership");
    expect(result).not.toHaveProperty("settled_state");
    expect(reconcileSpy).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "queued",
    });
  });

  test("stop on a live-owned run does not settle through reconcile", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const reconcileSpy = vi.spyOn(service, "reconcile");
    const intent = service.createIntent({
      run_id: "run-stop-live-owner-no-settlement",
      host: "local",
      prompt: "A held execution mutex is positive liveness evidence",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "live-worker-holds-mutex",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    let result!: Awaited<ReturnType<RunService["stop"]>>;
    await withSqliteMutex(
      service.store.paths(intent.run_id).executionMutexPath,
      async () => {
        result = await service.stop(intent.run_id, { reason: "operator stop" });
      },
    );

    expect(result.status).toBe("cancellation_requested");
    expect(result).not.toHaveProperty("worker_ownership");
    expect(reconcileSpy).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "running",
    });
  });

  test("targeted reconcile settles its run without visiting damaged unrelated history (POL-1897)", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    // A damaged historical run whose record read raises outside the
    // corruption-typed journal path, sorted before the target.
    const damagedRunId = "run-aa-damaged-history";
    await mkdir(join(runsRoot, damagedRunId), { recursive: true });
    await writeFile(join(runsRoot, damagedRunId, "run_record.json"), "{ not json", "utf8");
    const intent = service.createIntent({
      run_id: "run-scoped-reconcile-target",
      host: "local",
      prompt: "Targeted settlement must not depend on unrelated history",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "worker-crashed-before-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const noncanonicalSweep = vi.spyOn(service.store, "inspectNonCanonicalRunDirectories");
    const fullEnumeration = vi.spyOn(service.store, "listReconcileRunIds");
    const indexRepair = vi.spyOn(service.store, "rebuildRunIndex");

    const scoped = await service.reconcile({ scope: { runId: intent.run_id } });

    expect(scoped.scanned).toBe(1);
    expect(scoped.classified).toContain(intent.run_id);
    expect(scoped.unresolved).toEqual([]);
    expect(scoped.projection).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("narrowed scope"),
    });
    expect(noncanonicalSweep).not.toHaveBeenCalled();
    expect(fullEnumeration).not.toHaveBeenCalled();
    expect(indexRepair).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
    // The damaged bytes were preserved untouched for the scope-'all' repair path.
    await expect(readFile(join(runsRoot, damagedRunId, "run_record.json"), "utf8"))
      .resolves.toBe("{ not json");
  });

  test("a full pass isolates a damaged candidate as typed unresolved and still settles the rest (POL-1897)", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const damagedRunId = "run-aa-damaged-history";
    await mkdir(join(runsRoot, damagedRunId), { recursive: true });
    await writeFile(join(runsRoot, damagedRunId, "run_record.json"), "{ not json", "utf8");
    const intent = service.createIntent({
      run_id: "run-full-pass-target",
      host: "local",
      prompt: "One damaged candidate must not block the estate",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "worker-crashed-before-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const result = await service.reconcile();

    expect(result.unresolved).toContainEqual({
      run_id: damagedRunId,
      reason: "reconcile_candidate_failed",
    });
    expect(result.classified).toContain(intent.run_id);
    expect(result.projection).toMatchObject({
      status: "failed",
      reason: expect.stringContaining(damagedRunId),
    });
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
  });

  test("'active' scope reconciles only projected-active candidates (POL-1897)", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const terminalIntent = service.createIntent({
      run_id: "run-active-scope-terminal",
      host: "local",
      prompt: "Terminal runs stay out of the steady-state cadence",
      require_execplan: false,
    });
    await service.launch(terminalIntent, { detached: false });
    const intent = service.createIntent({
      run_id: "run-active-scope-orphan",
      host: "local",
      prompt: "Active orphans settle on the steady-state cadence",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "worker-crashed-before-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const fullEnumeration = vi.spyOn(service.store, "listReconcileRunIds");
    const indexRepair = vi.spyOn(service.store, "rebuildRunIndex");

    const result = await service.reconcile({ scope: "active" });

    expect(result.scanned).toBe(1);
    expect(result.classified).toContain(intent.run_id);
    expect(fullEnumeration).not.toHaveBeenCalled();
    expect(indexRepair).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
    await expect(service.getRunRecord(terminalIntent.run_id)).resolves.toMatchObject({
      state: "succeeded",
    });
  });

  test("owner-free settlement quarantines the worktree lease instead of releasing it (POL-1897)", async () => withTempStateHome(async () => {
    const leaseKey = "worktree:carbon:/tmp/owner-free-orphan";
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000042");
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-owner-free-lease-quarantine",
      host: "local",
      prompt: "A free mutex proves the publisher gone, not the backend group",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "wrapper-sigkilled-backend-unknown",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(acquireLease(opened.db, {
        key: leaseKey,
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: "2026-03-11T12:00:01.000Z",
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }

    const reconciled = await service.reconcile({ provenance });

    expect(reconciled.classified).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
    const after = await openStateStore();
    try {
      const retained = listLeases(after.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      });
      expect(retained).toHaveLength(1);
      expect(readLeaseResourceQuarantine(retained[0]!)).toMatchObject({
        authority: "owner_free_settlement_unproven_backend",
        reason_code: "backend_resource_extinction_unproven",
        run_id: intent.run_id,
      });
      expect(acquireLease(after.db, {
        key: leaseKey,
        holder_activity_id: "run:worktree-competitor",
        ttl_ms: 60_000,
        now: "2026-03-11T12:10:00.000Z",
      })).toMatchObject({ acquired: false, conflict: { kind: "quarantined" } });
      expect(listLeaseEvents(after.db, leaseKey)).toEqual([
        expect.objectContaining({ event_type: "acquired" }),
        expect.objectContaining({
          event_type: "quarantined",
          request_provenance: provenance,
        }),
      ]);
    } finally {
      after.db.close();
    }
    expect(await service.readEvents(intent.run_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({
          reconcile: "owner_free_resource_quarantine",
          authority: "owner_free_settlement_unproven_backend",
          lease_keys: [leaseKey],
        }),
      }),
    ]));

    // A later full pass neither releases the fenced lease nor duplicates the marker.
    await service.reconcile();
    const second = await openStateStore();
    try {
      expect(listLeases(second.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      second.db.close();
    }
    const quarantineEvents = (await service.readEvents(intent.run_id))
      .filter(isRunServiceEvent)
      .filter((event) => (event.payload as { reconcile?: unknown } | undefined)?.reconcile === "owner_free_resource_quarantine");
    expect(quarantineEvents).toHaveLength(1);
  }));

  test("owner-free quarantine marker publication repairs across append failure and restart (POL-1897)", async () => withTempStateHome(async () => {
    const leaseKey = "worktree:carbon:/tmp/owner-free-marker-repair";
    const intentId = "run-owner-free-marker-repair";
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: intentId,
      host: "local",
      prompt: "Repair a torn SQLite quarantine to run-journal publication",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "wrapper-crashed-with-invalid-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await writeFile(service.store.paths(intent.run_id).kernelReceiptPath, "{invalid receipt\n", "utf8");
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      expect(acquireLease(opened.db, {
        key: leaseKey,
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: "2026-03-11T12:00:01.000Z",
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }

    const quarantineMarkers = async (candidate: RunService): Promise<RecordedRunEvent[]> => (
      (await candidate.readEvents(intent.run_id))
        .filter(isRunServiceEvent)
        .filter((event) => (
          (event.payload as { reconcile?: unknown } | undefined)?.reconcile
            === "owner_free_resource_quarantine"
        ))
    );
    const originalAppendEvent = service.store.appendEvent.bind(service.store);
    const appendEventSpy = vi.spyOn(service.store, "appendEvent").mockImplementation((async (
      runIdOrEvent: string | CalyxStreamEvent,
      event?: RecordedRunEvent,
    ): Promise<void | CalyxStreamEvent> => {
      if (
        typeof runIdOrEvent === "string"
        && event !== undefined
        && isRunServiceEvent(event)
        && (event.payload as { reconcile?: unknown } | undefined)?.reconcile
          === "owner_free_resource_quarantine"
      ) {
        throw new Error("injected quarantine marker append failure");
      }
      if (typeof runIdOrEvent === "string") {
        if (event === undefined) throw new Error("missing run event");
        await originalAppendEvent(runIdOrEvent, event);
        return;
      }
      return originalAppendEvent(runIdOrEvent);
    }) as typeof service.store.appendEvent);

    const tornMarker = await service.reconcile({ scope: "active" });
    appendEventSpy.mockRestore();
    expect(tornMarker.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "reconcile_candidate_failed",
    });
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    await expect(quarantineMarkers(service)).resolves.toHaveLength(0);
    const quarantined = await openStateStore();
    try {
      const retained = listLeases(quarantined.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      });
      expect(retained).toHaveLength(1);
      expect(readLeaseResourceQuarantine(retained[0]!)).toMatchObject({
        authority: "owner_free_settlement_unproven_backend",
        run_id: intent.run_id,
      });
      expect(listLeaseEvents(quarantined.db, leaseKey)
        .filter((event) => event.event_type === "quarantined")).toHaveLength(1);
    } finally {
      quarantined.db.close();
    }

    // Restart over the committed SQLite quarantine. Repair the missing marker,
    // then simulate a second crash before terminal record publication.
    const repairService = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const originalWriteRunRecord = repairService.store.writeRunRecord.bind(repairService.store);
    let injectTerminalRecordFailure = true;
    const writeRunRecordSpy = vi.spyOn(repairService.store, "writeRunRecord").mockImplementation(async (
      runId,
      record,
    ) => {
      if (injectTerminalRecordFailure && record.state === "infra_error") {
        injectTerminalRecordFailure = false;
        throw new Error("injected crash before terminal record publication");
      }
      await originalWriteRunRecord(runId, record);
    });
    const repairedMarker = await repairService.reconcile({ scope: "active" });
    writeRunRecordSpy.mockRestore();
    expect(repairedMarker.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "reconcile_candidate_failed",
    });
    await expect(repairService.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    await expect(quarantineMarkers(repairService)).resolves.toHaveLength(1);

    // A second restart sees both already_quarantined and the repaired marker;
    // it must finish classification without publishing either receipt twice.
    const restartedService = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const settled = await restartedService.reconcile({ scope: "active" });
    expect(settled.classified).toContain(intent.run_id);
    await expect(restartedService.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
    });
    await expect(quarantineMarkers(restartedService)).resolves.toHaveLength(1);
    const afterRestart = await openStateStore();
    try {
      expect(listLeases(afterRestart.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
      expect(listLeaseEvents(afterRestart.db, leaseKey)
        .filter((event) => event.event_type === "quarantined")).toHaveLength(1);
    } finally {
      afterRestart.db.close();
    }
  }));

  test("stop does not claim owner_free while a legacy publisher may still be live (POL-1897)", async () => {
    const legacyPid = 45_777;
    const observeLegacyWorkerPid = vi.fn(async () => "possibly_live" as const);
    const service = new RunService({ runsRoot, subscribers: [] }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
    });
    const intent = service.createIntent({
      run_id: "run-stop-legacy-possibly-live",
      host: "local",
      prompt: "Possibly-live legacy publishers defer settlement",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: legacyPid, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    await writeFile(join(paths.runDir, "pid"), `${legacyPid}\n`, "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

    const result = await service.stop(intent.run_id, { reason: "operator stop" });

    // The free mutexes only gated the targeted reconcile; its deferral means
    // no publisher-extinction claim may be surfaced.
    expect(result.status).toBe("cancellation_requested");
    expect(result).not.toHaveProperty("worker_ownership");
    expect(result).not.toHaveProperty("settled_state");
    expect(observeLegacyWorkerPid).toHaveBeenCalledWith(legacyPid);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "running",
    });
  });

  test("stop does not claim owner_free over untrusted legacy evidence (POL-1897)", async () => {
    const observeLegacyWorkerPid = vi.fn(async () => "dead" as const);
    const service = new RunService({ runsRoot, subscribers: [] }, {
      ...buildDeps(),
      observeLegacyWorkerPid,
    });
    const intent = service.createIntent({
      run_id: "run-stop-legacy-untrusted",
      host: "local",
      prompt: "Untrusted legacy evidence defers settlement",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const launchedAt = "2026-03-11T12:00:01.000Z";
    await service.store.appendEvent(intent.run_id, {
      timestamp: launchedAt,
      run_id: intent.run_id,
      source: "run-service",
      event: "launch_dispatched",
      message: "Spawned detached run worker.",
      payload: { pid: 45_778, worker_supervisor: "direct" },
    });
    const paths = service.store.paths(intent.run_id);
    await writeFile(join(paths.runDir, "pid"), "not-a-pid\n", "utf8");
    const legacyRecord: Omit<RunRecord, "launch"> & { launch?: RunRecord["launch"] } = {
      ...queued,
      state: "running",
      updated_at: launchedAt,
    };
    delete legacyRecord.launch;
    await writeFile(paths.runRecordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");

    const result = await service.stop(intent.run_id, { reason: "operator stop" });

    expect(result.status).toBe("cancellation_requested");
    expect(result).not.toHaveProperty("worker_ownership");
    expect(result).not.toHaveProperty("settled_state");
    expect(observeLegacyWorkerPid).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "running",
    });
  });

  test("pre-admitted cancellation wins before a failing intent resolver and prevents the external effect", async () => {
    const deps = buildDeps();
    const resolveIntent = vi.fn().mockRejectedValue(new Error("resolver must not run after cancellation"));
    const resolveExecutionKernel = vi.fn((intent: RunIntent) => {
      const kernel = deps.resolveExecutionKernel!(intent);
      vi.spyOn(kernel, "resolveIntent").mockImplementation(resolveIntent);
      return kernel;
    });
    const service = new RunService({ runsRoot }, { ...deps, resolveExecutionKernel });
    const intent = service.createIntent({
      run_id: "run-cancel-before-effect",
      host: "local",
      prompt: "This effect must not start",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });
    await service.stop(intent.run_id, { reason: "withdraw before dispatch" });

    const record = await service.executeStoredRun(intent.run_id);
    expect(record).toMatchObject({
      state: "cancelled",
      summary: "Run run-cancel-before-effect was cancelled before execution began.",
    });
    expect(resolveExecutionKernel).toHaveBeenCalledOnce();
    expect(resolveIntent).not.toHaveBeenCalled();
    expect(record.launch.execution_id).toBeUndefined();
    const events = await service.readEvents(intent.run_id);
    expect(events).toContainEqual(expect.objectContaining({
      event: "launch_completed",
      payload: { state: "cancelled", effect_started: false },
    }));
    expect(events.filter(isCalyxRunEvent).filter((event) => event.event_type === "run.terminal"))
      .toHaveLength(1);
    expect((await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent))
      .toEqual([expect.objectContaining({
        event_type: "run.terminal",
        run: expect.objectContaining({ state: "cancelled" }),
      })]);
  });

  test("a cross-process stop admitted while intent resolution is in flight prevents the external effect", async () => {
    const deps = buildDeps();
    let resolverEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolverEntered = resolve; });
    let releaseResolver!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolver = resolve; });
    let executeEffect: ReturnType<typeof vi.fn> | undefined;
    const service = new RunService({ runsRoot }, {
      ...deps,
      resolveExecutionKernel: (intent) => {
        const kernel = deps.resolveExecutionKernel!(intent);
        const resolveIntent = kernel.resolveIntent.bind(kernel);
        const executeResolvedSpec = kernel.executeResolvedSpec.bind(kernel);
        kernel.resolveIntent = async (candidate, options) => {
          resolverEntered();
          await release;
          return resolveIntent(candidate, options);
        };
        executeEffect = vi.fn(executeResolvedSpec);
        kernel.executeResolvedSpec = executeEffect;
        return kernel;
      },
    });
    const sibling = new RunService({ runsRoot }, deps);
    const intent = service.createIntent({
      run_id: "run-stop-during-resolution",
      host: "local",
      prompt: "Do not cross the effect boundary",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });

    const execution = service.executeStoredRun(intent.run_id);
    await entered;
    await sibling.stop(intent.run_id, { reason: "withdraw during resolution" });
    releaseResolver();

    await expect(execution).resolves.toMatchObject({
      state: "cancelled",
      launch: { stage: "accepted" },
    });
    expect(executeEffect).not.toHaveBeenCalled();
  });

  test("a stop waiting behind a failed effect admission wins before failure classification", async () => {
    const deps = buildDeps();
    let executeEffect: ReturnType<typeof vi.fn> | undefined;
    const service = new RunService({ runsRoot }, {
      ...deps,
      resolveExecutionKernel: (intent) => {
        const kernel = deps.resolveExecutionKernel!(intent);
        const executeResolvedSpec = kernel.executeResolvedSpec.bind(kernel);
        executeEffect = vi.fn(executeResolvedSpec);
        kernel.executeResolvedSpec = executeEffect;
        return kernel;
      },
    });
    const sibling = new RunService({ runsRoot }, deps);
    const intent = service.createIntent({
      run_id: "run-stop-after-admission-write-failure",
      host: "local",
      prompt: "Cancellation must not downgrade",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });
    const originalWrite = service.store.writeRunRecord.bind(service.store);
    let stop: Promise<Awaited<ReturnType<RunService["stop"]>>> | undefined;
    vi.spyOn(service.store, "writeRunRecord").mockImplementation(async (runId, record) => {
      if (record.state === "dispatching") {
        stop = sibling.stop(runId, { reason: "cancel at the admission boundary" });
        throw new Error("dispatching record projection failed");
      }
      await originalWrite(runId, record);
    });
    const internals = service as unknown as {
      recoverAndPersistIntegrationStatus(runId: string): Promise<{
        results: [];
        all_critical_ok: true;
      }>;
    };
    vi.spyOn(internals, "recoverAndPersistIntegrationStatus").mockImplementation(async () => {
      if (!stop) throw new Error("stop was not started at the admission boundary");
      await stop;
      return { results: [], all_critical_ok: true };
    });

    const record = await service.executeStoredRun(intent.run_id);

    expect(record).toMatchObject({
      state: "cancelled",
      launch: { stage: "accepted" },
    });
    expect(executeEffect).not.toHaveBeenCalled();
    await expect(service.store.readCancellation(intent.run_id)).resolves.toMatchObject({
      reason: "cancel at the admission boundary",
    });
  });

  test("provenance stop of an already-terminal run records a completed result", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-stop-already-terminal-provenance",
      host: "local",
      prompt: "Already done",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      summary: "Already terminal.",
      completed_at: "2026-03-11T12:00:01.000Z",
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000099");

    await expect(service.stop(intent.run_id, { provenance })).resolves.toMatchObject({
      status: "already_terminal",
    });
    const events = (await service.readEvents(intent.run_id)).filter(isRunServiceEvent);
    expect(events.filter((event) => event.event === "stop_intent")).toHaveLength(1);
    expect(events.filter((event) => event.event === "stop_result")).toEqual([
      expect.objectContaining({
        provenance,
        payload: expect.objectContaining({ outcome: "completed", status: "already_terminal" }),
      }),
    ]);
  });

  test("inline foreground runs can be stopped through RunService.stop", async () => {
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => "2026-03-11T12:00:00.000Z",
      },
    );
    const intent = service.createIntent({
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: runsRoot,
        stop_grace_ms: 50,
      },
    });

    const launchPromise = service.launch(intent, { detached: false });
    let stopResult: Awaited<ReturnType<RunService["stop"]>> | undefined;
    await vi.waitFor(async () => {
      stopResult = await service.stop(intent.run_id);
      expect(stopResult.status).toBe("cancellation_requested");
    });
    const result = await launchPromise;

    expect(stopResult?.status).toBe("cancellation_requested");
    expect(result.record.state).toBe("cancelled");
  });

  test("HTTP reconcile correlates non-atomic intent and result on every affected run", async () => {
    await withTempStateHome(async () => {
      const service = new RunService({ runsRoot }, buildDeps());
      const classifiedIntent = service.createIntent({
        run_id: "run-reconcile-provenance-classified",
        host: "local",
        prompt: "Classify missing worker",
        require_execplan: false,
      });
      const rebuiltIntent = service.createIntent({
        run_id: "run-reconcile-provenance-rebuilt",
        host: "local",
        prompt: "Backfill terminal event",
        require_execplan: false,
      });
      const classifiedQueued = await service.initializeRun(classifiedIntent);
      await service.store.writeRunRecord(classifiedIntent.run_id, {
        ...classifiedQueued,
        state: "dispatching",
        launch: {
          ...classifiedQueued.launch,
          stage: "executing",
          execution_id: "lost-owner-execution",
          execution_started_at: "2026-07-14T04:30:00.000Z",
        },
        updated_at: "2026-07-14T04:30:00.000Z",
      });
      const rebuiltQueued = await service.initializeRun(rebuiltIntent);
      await service.store.writeRunRecord(rebuiltIntent.run_id, {
        ...rebuiltQueued,
        state: "succeeded",
        summary: "Completed before terminal event emission.",
        updated_at: "2026-07-14T04:31:00.000Z",
        completed_at: "2026-07-14T04:31:00.000Z",
      });
      await service.store.appendEvent("run-reconcile-provenance-ghost", {
        timestamp: "2026-07-14T04:31:00.000Z",
        run_id: "run-reconcile-provenance-ghost",
        source: "run-service",
        event: "warning",
        message: "Intent was never persisted.",
      });
      const provenance = apiProvenance("req_00000000-0000-4000-8000-000000000009");

      const result = await service.reconcile({ provenance });
      expect(result.classified).toContain(classifiedIntent.run_id);
      expect(result.rebuilt).toContain(rebuiltIntent.run_id);
      expect(result.skipped).not.toContain("run-reconcile-provenance-ghost");
      expect(result.unresolved).toContainEqual({
        run_id: "run-reconcile-provenance-ghost",
        reason: "canonical_run_record_missing",
      });

      for (const runId of [classifiedIntent.run_id, rebuiltIntent.run_id]) {
        const events = (await service.readEvents(runId)).filter(isRunServiceEvent);
        const reconcileEvents = events.filter(
          (event) => event.event === "reconcile_intent" || event.event === "reconcile_result",
        );
        expect(reconcileEvents).toHaveLength(2);
        expect(reconcileEvents[0]).toMatchObject({
          event: "reconcile_intent",
          provenance,
          payload: { correlation_id: provenance.request_id, batch_atomic: false },
        });
        expect(reconcileEvents[1]).toMatchObject({
          event: "reconcile_result",
          provenance,
          payload: {
            correlation_id: provenance.request_id,
            batch_atomic: false,
            outcome: "completed",
          },
        });
      }
      const ghostEvents = (await service.readEvents("run-reconcile-provenance-ghost"))
        .filter(isRunServiceEvent);
      expect(ghostEvents.some((event) => event.event === "reconcile_intent")).toBe(false);

      const summary = JSON.parse(
        await readFile(join(runsRoot, "last_reconcile.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(summary).toMatchObject({
        batch_atomic: false,
        run_index_authority: "derived_projection",
        provenance,
      });
    });
  });

  test("reconcile does not reconstruct authority from an orphaned kernel receipt", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      host: "local",
      prompt: "Repair record",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, makeReceipt(intent.run_id, {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    }));
    await rm(service.store.paths(intent.run_id).runRecordPath, { force: true });

    const reconcile = await service.reconcile();
    const rebuilt = await service.getRunRecord(intent.run_id);

    expect(reconcile.skipped).not.toContain(intent.run_id);
    expect(reconcile.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "canonical_run_record_missing",
    });
    expect(reconcile.rebuilt).not.toContain(intent.run_id);
    expect(rebuilt).toBeUndefined();
  });

  test("reconcile classifies a post-admission terminal record without a receipt as indeterminate", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-record-before-receipt",
      host: "local",
      prompt: "Do not synthesize success",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-before-receipt-publication",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: "2026-03-11T12:00:02.000Z",
      completed_at: "2026-03-11T12:00:02.000Z",
    });

    const reconciled = await service.reconcile();
    const repaired = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(repaired).toMatchObject({
      state: "infra_error",
      recovery: { mode: "orchestrator_crash", resumable: false },
      summary: expect.stringContaining("outcome is indeterminate"),
    });
    expect(repaired?.kernel_receipt).toBeUndefined();
    expect((await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent))
      .toHaveLength(1);
  });

  test("reconcile backfills a missing terminal event from an existing terminal run record", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-reconcile-event-1",
      host: "local",
      prompt: "Repair missing event",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const receipt = makeReceipt(intent.run_id, {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    const queued = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued!,
      state: "succeeded",
      spec,
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: receipt.timing.completed_at,
      completed_at: receipt.timing.completed_at,
    });

    const reconcile = await service.reconcile();
    const indexedEvents = await collectIndexedEvents(service, intent.run_id);

    expect(reconcile.rebuilt).toContain(intent.run_id);
    expect(indexedEvents).toHaveLength(1);
    expect(indexedEvents[0]?.emitted_by).toBe("reconcile");
    expect(indexedEvents[0]?.event_type).toBe("run.terminal");
    expect(await service.store.hasTerminalEventForRun(intent.run_id)).toBe(true);
  });

  test("reconcile repairs terminal top-level state from the authoritative receipt", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-state-receipt-disagreement",
      host: "local",
      prompt: "Believe the durable receipt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const receipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, spec.backend),
      "failed",
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "published-contradictory-terminal-state",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: receipt.timing.completed_at,
      completed_at: receipt.timing.completed_at,
    });

    const reconciled = await service.reconcile();

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "failed",
      kernel_receipt: { state: "failed" },
      summary: expect.stringContaining("failed"),
    });
  });

  test("reconcile rebuilds the full spec and immutable indexed intent projection from authority", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-authoritative-projection",
      host: "blade",
      backend: "codex",
      issue: "POL-1980",
      prompt: "Repair every contract-bearing projection",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const completedAt = "2026-03-11T12:00:02.000Z";
    const staleCreatedAt = "2025-01-01T00:00:00.000Z";
    const receipt = makeReceipt(
      intent.run_id,
      {
        ...makeReceiptSpec(intent.run_id, intent, spec.backend),
        ...(spec.issue ? { issue: spec.issue } : {}),
      },
      "succeeded",
      {
        timing: {
          created_at: intent.created_at,
          completed_at: completedAt,
        },
      },
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      intent: {
        ...queued.intent,
        host: "stale-host",
        backend: "claude",
        issue: "POL-STALE",
        created_at: staleCreatedAt,
      },
      spec: {
        ...spec,
        host: "stale-host",
        backend: "claude",
        issue: "POL-STALE",
      },
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "published-stale-terminal-projection",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} succeeded.`,
      created_at: staleCreatedAt,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const reconciled = await service.reconcile();
    const repaired = await service.getRunRecord(intent.run_id);

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(repaired).toMatchObject({
      spec: {
        host: "blade",
        backend: "codex",
        issue: "POL-1980",
      },
      intent: {
        host: "blade",
        backend: "codex",
        issue: "POL-1980",
        created_at: intent.created_at,
      },
      created_at: intent.created_at,
    });
    await expect(service.listActivity({
      includeInteractive: false,
      host: "blade",
      agentKind: "codex",
    })).resolves.toEqual([
      expect.objectContaining({ run_id: intent.run_id, host: "blade", backend: "codex", issue: "POL-1980" }),
    ]);
    await expect(service.listActivity({
      includeInteractive: false,
      host: "stale-host",
      agentKind: "claude",
    })).resolves.toEqual([]);
  });

  test("receipt creation time repairs mutually stale record and intent timestamps", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-authoritative-created-at",
      host: "local",
      backend: "codex",
      prompt: "Use receipt timing as creation authority",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const completedAt = "2026-03-11T12:00:02.000Z";
    const receipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, spec.backend),
      "succeeded",
      {
        timing: {
          created_at: intent.created_at,
          completed_at: completedAt,
        },
      },
    );
    const mutuallyStaleCreatedAt = "2025-01-01T00:00:00.000Z";
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      intent: {
        ...queued.intent,
        created_at: mutuallyStaleCreatedAt,
      },
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "published-mutually-stale-created-at",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} succeeded.`,
      created_at: mutuallyStaleCreatedAt,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const repaired = await service.reconcile();
    const stable = await service.reconcile();

    expect(repaired.rebuilt).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      intent: { created_at: receipt.timing.created_at },
      created_at: receipt.timing.created_at,
    });
    expect(stable.skipped).toContain(intent.run_id);
    expect(stable.rebuilt).not.toContain(intent.run_id);
  });

  test("receipt authority rejects chronology that cannot contain the durable execution boundary", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-impossible-durable-chronology",
      host: "local",
      backend: "codex",
      prompt: "Reject an impossible receipt timeline",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => queued.launch.accepted_at });
    const completedAt = new Date(new Date(queued.launch.accepted_at).getTime() + 2_000).toISOString();
    const executionStartedAt = new Date(new Date(queued.launch.accepted_at).getTime() + 60_000).toISOString();
    const receipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, spec.backend),
      "succeeded",
      { timing: { created_at: intent.created_at, completed_at: completedAt } },
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "execution-after-impossible-completion",
        execution_started_at: executionStartedAt,
      },
      kernel_receipt: receipt,
      summary: "Published from an impossible chronology.",
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const reconciled = await service.reconcile();
    const classified = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(classified).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining("does not correspond to durable execution/receipt creation chronology"),
    });
  });

  test("reconcile preserves terminal audit correction but emits one receipt-authoritative handback", async () =>
    withTempStateHome(async () => {
      const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const staged = await stageProvisionalTerminalHandback(
        service,
        "run-terminal-projection-supersession",
      );
      const { intent, receipt } = staged;
      const initialEvents = (await collectIndexedEvents(service, intent.run_id))
        .filter(isCalyxRunEvent)
        .filter((event) => event.event_type === "run.terminal");
      expect(initialEvents).toHaveLength(1);
      expect(initialEvents[0]).toMatchObject({
        run: { state: "infra_error", issue: "POL-2128" },
        summary: { one_line: "Provisional finalization failure." },
      });
      await applyStateMigrations();
      const beforeCorrection = await openStateStore();
      try {
        expect(listMessages(beforeCorrection.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        })).toHaveLength(0);
      } finally {
        beforeCorrection.db.close();
      }
      await expect(readRunHandbackReceipt(service, intent.run_id)).resolves.toMatchObject({
        flow: "withheld/v1",
        status: "withheld",
        outcome: { state: "infra_error" },
        authority_annotation: {
          schema_version: "calyx.run-handback-authority/v1",
          authority_source: "kernel_receipt",
          receipt_status: "receipt_accepted",
          correction_status: "correction_pending",
          receipt_state: "succeeded",
          reason: "validated_kernel_receipt_contradicts_typed_projection",
        },
      });
      expect((await service.readEvents(intent.run_id)).filter((candidate) => (
        isRunServiceEvent(candidate) && candidate.event === "handback_withheld"
      ))).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            projection_state: "infra_error",
            receipt_state: "succeeded",
            reason: "validated_kernel_receipt_contradicts_typed_projection",
          }),
        }),
      ]);

      const corrected = await service.reconcile();
      const stable = await service.reconcile();
      const correctedRecord = await service.getRunRecord(intent.run_id);
      const terminalEvents = (await collectIndexedEvents(service, intent.run_id))
        .filter(isCalyxRunEvent)
        .filter((event) => event.event_type === "run.terminal");
      const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);
      const opened = await openStateStore();
      expect(correctedRecord).toMatchObject({
        state: "succeeded",
        summary: expect.stringContaining("succeeded"),
      });
      try {
        const messages = listMessages(opened.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.body).toContain("state: succeeded");
        expect(messages[0]?.body).not.toContain("state: infra_error");
        expect(messages[0]?.idempotency_key).toBe(
          `handback:${intent.run_id}:${intent.run_id}-handback`,
        );
      } finally {
        opened.db.close();
      }

      expect(corrected.rebuilt).toContain(intent.run_id);
      expect(stable.skipped).toContain(intent.run_id);
      expect(stable.rebuilt).not.toContain(intent.run_id);
      expect(terminalEvents).toHaveLength(2);
      expect(terminalEvents[1]).toMatchObject({
        run: { state: "succeeded", host: "local", backend: "codex", issue: "POL-2128" },
        summary: { one_line: correctedRecord?.summary },
        supersession: {
          schema_version: "calyx.run-terminal-supersession/v1",
          supersedes_event_id: initialEvents[0]?.event_id,
          reason: "receipt_projection_corrected",
        },
      });
      expect(handbackReceipt).toMatchObject({
        outcome: {
          state: "succeeded",
          issue: "POL-2128",
          completed_at: receipt.timing.completed_at,
        },
        terminal_event: { event_id: terminalEvents[1]?.event_id },
        dedupe_key: `handback:${intent.run_id}:${intent.run_id}-handback`,
        message: { inserted: true },
      });
      expect((await service.readEvents(intent.run_id)).filter((candidate) => (
        isRunServiceEvent(candidate) && candidate.event === "handback_withheld"
      ))).toHaveLength(1);
    }));

  test("projection-before-receipt delivery emits one typed authoritative supersession", async () =>
    withTempStateHome(async () => {
      const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const staged = await stageProvisionalTerminalHandback(
        service,
        "run-terminal-projection-delivered-before-receipt",
        { receiptBeforeProjection: false },
      );
      await applyStateMigrations();
      let provisionalMessageId = "";
      const deliveredAt = "2026-03-11T12:00:03.000Z";
      const beforeReceipt = await openStateStore();
      try {
        const [provisional] = listMessages(beforeReceipt.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(provisional).toMatchObject({
          payload: { terminal_state: "infra_error" },
        });
        provisionalMessageId = provisional!.message_id;
        const attempted = createMessageDeliveryAttempt(beforeReceipt.db, {
          message: provisional!,
          binding_id: "terminal-provisional-delivery",
          adapter: "session_ingress",
          attempted_at: "2026-03-11T12:00:02.000Z",
          target: { activity_id: "interactive:codex:caller-session" },
        });
        completeMessageDelivery(beforeReceipt.db, {
          delivery_id: attempted.delivery.delivery_id,
          status: "delivered",
          completed_at: deliveredAt,
          evidence: { accepted: true },
        });
      } finally {
        beforeReceipt.db.close();
      }

      await service.store.writeKernelReceipt(staged.intent.run_id, staged.receipt);
      const corrected = await service.reconcile();
      const stable = await service.reconcile();

      const afterCorrection = await openStateStore();
      try {
        const messages = listMessages(afterCorrection.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(2);
        const provisional = messages.find((message) => message.message_id === provisionalMessageId);
        const authoritative = messages.find((message) => message.message_id !== provisionalMessageId);
        expect(provisional).toMatchObject({
          delivered_at: deliveredAt,
          payload: { terminal_state: "infra_error" },
        });
        expect(authoritative).toMatchObject({
          idempotency_key: expect.stringContaining(":correction:"),
          payload: {
            terminal_state: "succeeded",
            correspondence: {
              schema_version: "calyx.run-handback-correction/v1",
              kind: "authoritative_supersession",
              supersedes_message_id: provisionalMessageId,
              provisional_state: "infra_error",
              authoritative_state: "succeeded",
            },
          },
        });
        expect(authoritative?.body).toContain("Calyx run authoritative terminal correction.");
        expect(authoritative?.body).toContain(`supersedes_message_id: ${provisionalMessageId}`);
        expect(messages.filter((message) => (
          (message.payload["correspondence"] as Record<string, unknown> | undefined)?.["kind"]
          === "authoritative_supersession"
        ))).toHaveLength(1);
      } finally {
        afterCorrection.db.close();
      }

      expect(corrected.rebuilt).toContain(staged.intent.run_id);
      expect(stable.skipped).toContain(staged.intent.run_id);
      await expect(readRunHandbackReceipt(service, staged.intent.run_id)).resolves.toMatchObject({
        status: "corrected",
        outcome: { state: "succeeded" },
        correction: {
          schema_version: "calyx.run-handback-correction/v1",
          kind: "authoritative_supersession",
          supersedes_message_id: provisionalMessageId,
          provisional_state: "infra_error",
          authoritative_state: "succeeded",
          delivery_evidence: {
            schema_version: "calyx.run-handback-delivery-evidence/v1",
            kind: "delivery_receipt",
            observed_at: deliveredAt,
          },
        },
        message: {
          inserted: true,
          disposition: "authoritative_correction",
          supersedes_message_id: provisionalMessageId,
        },
      });
    }));

  test("an undelivered provisional is replaced under the stable handback identity", async () =>
    withTempStateHome(async () => {
      const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const staged = await stageProvisionalTerminalHandback(
        service,
        "run-terminal-projection-undelivered-before-receipt",
        { receiptBeforeProjection: false },
      );
      const beforeReceipt = await openStateStore();
      let provisionalMessageId = "";
      try {
        const [provisional] = listMessages(beforeReceipt.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        provisionalMessageId = provisional!.message_id;
        expect(provisional).toMatchObject({
          status: "pending",
          delivered_at: null,
          payload: { terminal_state: "infra_error" },
        });
      } finally {
        beforeReceipt.db.close();
      }

      await service.store.writeKernelReceipt(staged.intent.run_id, staged.receipt);
      await service.reconcile();

      const afterCorrection = await openStateStore();
      try {
        const messages = listMessages(afterCorrection.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          message_id: provisionalMessageId,
          delivered_at: null,
          payload: {
            terminal_state: "succeeded",
            correspondence: { kind: "terminal_outcome" },
          },
        });
        expect(messages[0]?.body).toContain("state: succeeded");
        expect(messages[0]?.body).not.toContain("authoritative terminal correction");
      } finally {
        afterCorrection.db.close();
      }
      await expect(readRunHandbackReceipt(service, staged.intent.run_id)).resolves.toMatchObject({
        status: "updated",
        outcome: { state: "succeeded" },
        message: {
          message_id: provisionalMessageId,
          inserted: false,
          disposition: "updated_pending",
        },
      });
    }));

  test("a rejected contradictory receipt cannot veto the typed projection handback", async () =>
    withTempStateHome(async () => {
      const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const intent = service.createIntent({
        run_id: "run-terminal-rejected-receipt-fallback",
        host: "local",
        backend: "codex",
        issue: "POL-2128",
        prompt: "Preserve the typed projection when receipt correction is unavailable",
        require_execplan: false,
        handback: {
          key: "run-terminal-rejected-receipt-fallback-handback",
          recipient_address: "interactive:codex:caller-session",
          thread_key: "run-terminal-rejected-receipt-fallback-handback",
          ack_required: true,
          body_contract: "locator-only terminal outcome",
        },
      });
      const queued = await service.initializeRun(intent, { launchMode: "inline" });
      const spec = await resolveRunIntent(intent, { now: () => queued.launch.accepted_at });
      const contradictedReceipt = makeReceipt(
        intent.run_id,
        {
          ...makeReceiptSpec(intent.run_id, intent, spec.backend),
          issue: intent.issue!,
          prompt: "Receipt belongs to a different command projection",
          handback: intent.handback!,
        },
        "succeeded",
        {
          timing: {
            created_at: intent.created_at,
            completed_at: queued.launch.accepted_at,
          },
        },
      );
      const projection: RunRecord = {
        ...queued,
        state: "infra_error",
        spec,
        summary: "Typed projection remains the only admissible terminal outcome.",
        updated_at: queued.launch.accepted_at,
        completed_at: queued.launch.accepted_at,
      };
      await service.store.writeSpec(intent.run_id, spec);
      await service.store.writeKernelReceipt(intent.run_id, contradictedReceipt);
      await service.store.writeRunRecord(intent.run_id, projection);
      const terminalPublisher = service as unknown as {
        ensureTerminalEvent(
          record: RunRecord,
          emittedBy: RunTerminalEvent["emitted_by"],
          previousState?: RunRecord["state"],
        ): Promise<RunTerminalEvent | undefined>;
      };

      await terminalPublisher.ensureTerminalEvent(projection, "launch", queued.state);

      const opened = await openStateStore();
      try {
        const messages = listMessages(opened.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          payload: {
            terminal_state: "infra_error",
            authority_annotation: {
              schema_version: "calyx.run-handback-authority/v1",
              authority_source: "typed_projection",
              receipt_status: "receipt_rejected",
              correction_status: "correction_unavailable",
              receipt_state: "succeeded",
            },
          },
        });
        expect(messages[0]?.body).toContain("receipt_status: receipt_rejected");
        expect(messages[0]?.body).toContain("correction_status: correction_unavailable");
      } finally {
        opened.db.close();
      }
      await expect(readRunHandbackReceipt(service, intent.run_id)).resolves.toMatchObject({
        flow: "calyx.msg/v1",
        status: "sent",
        outcome: { state: "infra_error" },
        authority_annotation: {
          schema_version: "calyx.run-handback-authority/v1",
          authority_source: "typed_projection",
          receipt_status: "receipt_rejected",
          correction_status: "correction_unavailable",
          receipt_state: "succeeded",
          reason: expect.stringContaining("run_spec.prompt"),
        },
        message: { inserted: true },
      });
      expect((await service.readEvents(intent.run_id)).filter((candidate) => (
        isRunServiceEvent(candidate) && candidate.event === "handback_withheld"
      ))).toHaveLength(0);
    }));

  test("concurrent reconcilers publish one corrected terminal handback", async () =>
    withTempStateHome(async () => {
      const first = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const second = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const staged = await stageProvisionalTerminalHandback(
        first,
        "run-terminal-handback-concurrent-correction",
      );

      const outcomes = await Promise.all([first.reconcile(), second.reconcile()]);
      const terminalEvents = (await collectIndexedEvents(first, staged.intent.run_id))
        .filter(isRunTerminalEvent);
      const opened = await openStateStore();
      try {
        const messages = listMessages(opened.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.body).toContain("state: succeeded");
        expect(messages[0]?.idempotency_key).toBe(
          `handback:${staged.intent.run_id}:${staged.intent.run_id}-handback`,
        );
      } finally {
        opened.db.close();
      }

      expect(outcomes.flatMap((outcome) => outcome.rebuilt)).toEqual([staged.intent.run_id]);
      expect(terminalEvents).toHaveLength(2);
      expect(terminalEvents[1]).toMatchObject({
        run: { state: "succeeded" },
        supersession: { supersedes_event_id: terminalEvents[0]?.event_id },
      });
    }));

  test("a restarted reconciler publishes one corrected terminal handback", async () =>
    withTempStateHome(async () => {
      const beforeRestart = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const staged = await stageProvisionalTerminalHandback(
        beforeRestart,
        "run-terminal-handback-restart-correction",
      );

      const afterRestart = new RunService({ runsRoot, subscribers: [] }, buildDeps());
      const corrected = await afterRestart.reconcile();
      const stable = await afterRestart.reconcile();
      const terminalEvents = (await collectIndexedEvents(afterRestart, staged.intent.run_id))
        .filter(isRunTerminalEvent);
      const opened = await openStateStore();
      try {
        const messages = listMessages(opened.db, {
          recipient_address: "interactive:codex:caller-session",
          status: "all",
          include_expired: true,
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]?.body).toContain("state: succeeded");
      } finally {
        opened.db.close();
      }

      expect(corrected.rebuilt).toContain(staged.intent.run_id);
      expect(stable.skipped).toContain(staged.intent.run_id);
      expect(terminalEvents).toHaveLength(2);
      await expect(readRunHandbackReceipt(afterRestart, staged.intent.run_id)).resolves.toMatchObject({
        outcome: { state: "succeeded", issue: "POL-2128" },
        terminal_event: { event_id: terminalEvents[1]?.event_id },
        message: { inserted: true },
      });
    }));

  test("receipt authority repairs accepted and dispatching terminal projections on a later reconcile", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    for (const launchStage of ["accepted", "dispatching"] as const) {
      const intent = service.createIntent({
        run_id: `run-terminal-receipt-${launchStage}-disagreement`,
        host: "local",
        prompt: `Preserve receipt authority from ${launchStage}`,
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "inline" });
      const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
      const receipt = makeReceipt(
        intent.run_id,
        makeReceiptSpec(intent.run_id, intent, spec.backend),
        "failed",
      );
      await service.store.writeSpec(intent.run_id, spec);
      await service.store.writeKernelReceipt(intent.run_id, receipt);
      if (launchStage === "dispatching") {
        await service.store.writeRunRecord(intent.run_id, {
          ...queued,
          state: "running",
          spec,
          launch: {
            ...queued.launch,
            stage: "dispatching",
            dispatch_attempts: 1,
            last_dispatch_at: "2026-03-11T12:00:01.000Z",
          },
          updated_at: "2026-03-11T12:00:01.000Z",
        });
      }

      const first = await service.reconcile();
      expect(first.rebuilt).toContain(intent.run_id);
      const receiptBacked = await service.getRunRecord(intent.run_id);
      expect(receiptBacked).toMatchObject({
        state: "failed",
        launch: { stage: launchStage },
        kernel_receipt: { state: "failed" },
      });
      await service.store.writeRunRecord(intent.run_id, {
        ...receiptBacked!,
        state: "succeeded",
        summary: `Run ${intent.run_id} succeeded.`,
      });

      const second = await service.reconcile();
      expect(second.rebuilt).toContain(intent.run_id);
      await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
        state: "failed",
        launch: { stage: launchStage },
        kernel_receipt: { state: "failed" },
      });
    }
  });

  test("listActiveRuns honors authoritative run_record state after terminal write", async () => {
    // Wave 2.2 removed the racy `runs/index.jsonl` upsert in favor of a
    // SQLite-backed `run_index` projection (POL-1144 — see also
    // store-run-index.test.ts for the SQLite-projection-specific tests).
    // This test keeps the public-API guarantee that landed with POL-1144:
    // after writeRunRecord advances a run to a terminal state, listRuns
    // and listActiveRuns must agree with the authoritative state.
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-active-after-terminal-write",
      host: "local",
      prompt: "active-after-terminal",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const queued = await service.getRunRecord(intent.run_id);
    expect(queued?.state).toBe("queued");

    const completedAt = "2026-04-25T15:17:13.018Z";
    await service.store.writeRunRecord(intent.run_id, {
      ...queued!,
      state: "infra_error" as const,
      summary: `Run ${intent.run_id} infra_error.`,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const recordAfter = await service.getRunRecord(intent.run_id);
    expect(recordAfter?.state).toBe("infra_error");
    expect(recordAfter?.infra_error_classification).toMatchObject({
      failure_layer: "runner_task",
      failure_reason: "unknown",
    });
    expect(recordAfter?.infra_error_classification?.message).toBeTruthy();

    const runs = await service.store.listRuns();
    expect(runs.find((entry) => entry.run_id === intent.run_id)?.state).toBe(
      "infra_error",
    );

    const active = await service.store.listActiveRuns();
    expect(active.find((entry) => entry.run_id === intent.run_id)).toBeUndefined();

    // Wave 2.2 deletion proof: the legacy index.jsonl file must never be
    // created by the create/write/list path.
    await expect(stat(join(runsRoot, "index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("legacy infra_error run records classify from embedded kernel receipt detail", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "legacy-worktree-record",
      host: "local",
      backend: "codex",
      prompt: "Legacy worktree record",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const completedAt = "2026-04-25T15:20:13.018Z";
    const receipt = makeReceipt(intent.run_id, {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    }, "infra_error", {
      summary: `Run ${intent.run_id} infra_error.`,
      exit: {
        exit_code: 6,
        error: "Worktree acquisition failed: worktree locked by run prior-run.",
      },
    });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "infra_error",
      spec,
      kernel_receipt: receipt,
      summary: `Run ${intent.run_id} infra_error.`,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const readBack = await service.getRunRecord(intent.run_id);
    expect(readBack?.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
    expect(readBack?.infra_error_classification?.message).toContain("worktree locked by run");

    await service.prepareGlobalEventAuthority();
    await expect(service.infraErrorCensus()).resolves.toEqual([]);

    const reconcile = await service.reconcile();
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent);

    await expect(service.infraErrorCensus()).resolves.toEqual([
      expect.objectContaining({
        failure_layer: "worktree_acquisition",
        failure_reason: "worktree_locked",
        host: "local",
        kernel: "agent_runner",
        backend: "codex",
        count: 1,
      }),
    ]);

    expect(reconcile.rebuilt).toContain(intent.run_id);
    expect(terminalEvents.at(-1)?.run.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
  });

  test("infraErrorCensus replays one legacy root and audits it without terminal payload", async () => {
    const observer = new RunService({ runsRoot }, buildDeps());
    const writer = new RunService({ runsRoot }, buildDeps());
    const intent = writer.createIntent({
      run_id: "metric-legacy-incarnation-missing",
      host: "carbon",
      backend: "codex",
      prompt: "Exercise the pre-POL-2009 event contract",
      require_execplan: false,
    });
    const queued = await writer.initializeRun(intent);
    const legacyLaunch = { ...queued.launch };
    delete legacyLaunch.incarnation_id;
    const legacyQueued = { ...queued, launch: legacyLaunch };
    await writeFile(
      writer.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify(legacyQueued, null, 2)}\n`,
      "utf8",
    );
    await writer.store.writeRunRecord(intent.run_id, {
      ...legacyQueued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "runner_task",
        failure_reason: "unknown",
        message: "Legacy terminal authority has no fresh-claim identity.",
      },
      summary: "Legacy terminal authority has no incarnation identity.",
      updated_at: "2026-04-25T15:02:00.000Z",
      completed_at: "2026-04-25T15:02:00.000Z",
    });
    await writer.reconcile();
    await observer.prepareGlobalEventAuthority();

    const terminalEvent = (await collectIndexedEvents(writer, intent.run_id))
      .filter(isRunTerminalEvent)[0];
    expect(terminalEvent?.run.incarnation_id).toBeUndefined();
    await expect(observer.infraErrorCensus()).resolves.toEqual([{
      failure_layer: "runner_task",
      failure_reason: "unknown",
      host: "carbon",
      kernel: "agent_runner",
      backend: "codex",
      count: 1,
    }]);
    const audit = await observer.auditTerminalAuthority();
    expect(audit).toMatchObject({
      authoritative: true,
      terminal_event_count: 1,
      legacy_event_count: 1,
      legacy_roots: [{
        root_event_id: terminalEvent?.event_id,
        leaf_event_ids: [terminalEvent?.event_id],
        event_count: 1,
      }],
      ambiguities: [],
    });
    expect(JSON.stringify(audit)).not.toContain("Legacy terminal authority has no incarnation identity");

    const restartedObserver = new RunService({ runsRoot }, buildDeps());
    await restartedObserver.prepareGlobalEventAuthority();
    await expect(restartedObserver.infraErrorCensus()).resolves.toEqual([{
      failure_layer: "runner_task",
      failure_reason: "unknown",
      host: "carbon",
      kernel: "agent_runner",
      backend: "codex",
      count: 1,
    }]);
  });

  test("infraErrorCensus observes sibling terminal events once and reconstructs after restart", async () => {
    const observer = new RunService({ runsRoot }, buildDeps());
    const writer = new RunService({ runsRoot }, buildDeps());
    await observer.prepareGlobalEventAuthority();
    await expect(observer.infraErrorCensus()).resolves.toEqual([]);

    const intent = writer.createIntent({
      run_id: "metric-sibling-worktree-lease-refused",
      host: "carbon.tail-scale.ts.net",
      backend: "claude",
      prompt: "Exercise sibling metric publication",
      require_execplan: false,
    });
    const queued = await writer.initializeRun(intent);
    const completedAt = "2026-04-25T15:02:00.000Z";
    await writer.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "worktree_acquisition",
        failure_reason: "worktree_lease_refused",
        message: "Worktree DB lease acquisition refused by an active holder.",
      },
      summary: `Run ${intent.run_id} infra_error.`,
      updated_at: completedAt,
      completed_at: completedAt,
    });

    // A run record, retained launch tombstone, or ghost-index settlement is
    // not census authority. POL-1990 settlement must publish run.terminal;
    // reconciliation does so here through the sibling store.
    await expect(observer.infraErrorCensus()).resolves.toEqual([]);
    await expect(writer.reconcile()).resolves.toMatchObject({
      rebuilt: expect.arrayContaining([intent.run_id]),
    });

    const expectedPoint = {
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_lease_refused",
      host: "carbon",
      kernel: "agent_runner",
      backend: "claude",
      count: 1,
    };
    await expect(observer.infraErrorCensus()).resolves.toEqual([expectedPoint]);

    // Repeated record writes, terminal-event repair, and export intervals keep
    // the same authoritative incarnation represented exactly once.
    const terminal = await writer.getRunRecord(intent.run_id);
    await writer.store.writeRunRecord(intent.run_id, terminal!);
    await writer.reconcile();
    await expect(observer.infraErrorCensus()).resolves.toEqual([expectedPoint]);

    // A same-state correction replaces the incarnation's classification; its
    // old label set must disappear from the current census.
    await writer.store.writeRunRecord(intent.run_id, {
      ...terminal!,
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "worktree_acquisition",
        failure_reason: "worktree_locked",
        message: "Corrected authority: the worktree is locked by a prior run.",
      },
      summary: "Corrected infra-error classification.",
    });
    await writer.reconcile();
    const correctedTerminalEvents = (await collectIndexedEvents(writer, intent.run_id))
      .filter(isRunTerminalEvent);
    expect(correctedTerminalEvents).toHaveLength(2);
    expect(correctedTerminalEvents[1]).toMatchObject({
      supersession: { supersedes_event_id: correctedTerminalEvents[0]?.event_id },
    });
    const correctedPoint = {
      ...expectedPoint,
      failure_reason: "worktree_locked" as const,
    };
    await expect(observer.infraErrorCensus()).resolves.toEqual([
      { ...expectedPoint, count: 0 },
      correctedPoint,
    ]);

    // Cross-state correction chains replace, rather than accumulate, the
    // incarnation's census contribution.
    const correctedRecord = await writer.getRunRecord(intent.run_id);
    await writer.store.writeRunRecord(intent.run_id, {
      ...correctedRecord!,
      state: "failed",
      summary: "Corrected terminal state: failed.",
    });
    await writer.reconcile();
    await expect(observer.infraErrorCensus()).resolves.toEqual([
      { ...expectedPoint, count: 0 },
      { ...correctedPoint, count: 0 },
    ]);

    const failedRecord = await writer.getRunRecord(intent.run_id);
    await writer.store.writeRunRecord(intent.run_id, {
      ...failedRecord!,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "worktree_acquisition",
        failure_reason: "worktree_lease_refused",
        message: "Final corrected authority: the worktree lease was refused.",
      },
      summary: "Final corrected terminal state: infra_error.",
    });
    await writer.reconcile();
    const correctionChain = (await collectIndexedEvents(writer, intent.run_id))
      .filter(isRunTerminalEvent);
    expect(correctionChain).toHaveLength(4);
    expect(correctionChain.slice(1).map((event) => event.supersession?.supersedes_event_id)).toEqual(
      correctionChain.slice(0, -1).map((event) => event.event_id),
    );
    await expect(observer.infraErrorCensus()).resolves.toEqual([
      expectedPoint,
      { ...correctedPoint, count: 0 },
    ]);

    const restartedObserver = new RunService({ runsRoot }, buildDeps());
    await restartedObserver.prepareGlobalEventAuthority();
    await expect(restartedObserver.infraErrorCensus()).resolves.toEqual([
      expectedPoint,
      { ...correctedPoint, count: 0 },
    ]);
  });

  test("terminal corrections follow the unique supersession leaf across producer clock regression", async () => {
    let clock = "2026-04-25T12:00:00.000Z";
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      now: () => clock,
    });
    const intent = service.createIntent({
      run_id: "metric-clock-regression-chain",
      host: "carbon",
      backend: "codex",
      prompt: "Do not infer correction order from producer wall clock",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "runner_task",
        failure_reason: "unknown",
        message: "Initial classification.",
      },
      summary: "Initial infra error.",
      completed_at: clock,
      updated_at: clock,
    });
    await service.reconcile();

    clock = "2026-04-25T11:00:00.000Z";
    const initial = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...initial!,
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "backend_spawn",
        failure_reason: "backend_spawn_exit",
        message: "Corrected after the producer clock moved backward.",
      },
      summary: "Clock-regressed classification correction.",
      updated_at: clock,
    });
    await service.reconcile();

    clock = "2026-04-25T11:01:00.000Z";
    const corrected = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...corrected!,
      state: "failed",
      summary: "Clock-regressed state correction.",
      updated_at: clock,
    });
    await service.reconcile();

    const terminalEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isRunTerminalEvent);
    expect(terminalEvents.map((event) => event.emitted_at)).toEqual([
      "2026-04-25T12:00:00.000Z",
      "2026-04-25T11:00:00.000Z",
      "2026-04-25T11:01:00.000Z",
    ]);
    expect(terminalEvents.map((event) => event.supersession?.supersedes_event_id)).toEqual([
      undefined,
      terminalEvents[0]?.event_id,
      terminalEvents[1]?.event_id,
    ]);
    await expect(service.infraErrorCensus()).resolves.toEqual([
      expect.objectContaining({ failure_layer: "backend_spawn", count: 0 }),
      expect.objectContaining({ failure_layer: "runner_task", count: 0 }),
    ]);
  });

  test("terminal correction selection includes foreign-run incoming supersession edges", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "metric-cross-run-edge-root",
      host: "carbon",
      backend: "codex",
      prompt: "Fail before branching a globally connected terminal graph",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "runner_task",
        failure_reason: "unknown",
        message: "Initial classification.",
      },
      summary: "Initial infra error.",
      completed_at: "2026-04-25T12:00:00.000Z",
      updated_at: "2026-04-25T12:00:00.000Z",
    });
    await service.reconcile({ scope: { runId: intent.run_id } });
    const root = (await collectIndexedEvents(service, intent.run_id))
      .filter(isRunTerminalEvent)[0]!;
    const foreignChild: RunTerminalEvent = {
      ...root,
      event_id: "evt-cross-run-foreign-child",
      cursor: "2026-04-25T12:01:00.000Z-cross-run-foreign-child",
      emitted_at: "2026-04-25T12:01:00.000Z",
      run: {
        ...root.run,
        run_id: "foreign-linked-run",
        incarnation_id: "00000000-0000-4000-8000-000000000099",
        state: "failed",
      },
      pointers: {
        run_dir: join(runsRoot, "foreign-linked-run"),
        run_record_path: join(runsRoot, "foreign-linked-run", "run_record.json"),
        events_path: join(runsRoot, "foreign-linked-run", "events.jsonl"),
      },
      supersession: {
        schema_version: "calyx.run-terminal-supersession/v1",
        supersedes_event_id: root.event_id,
        reason: "receipt_projection_corrected",
      },
    };
    await service.store.appendStreamEvent(foreignChild);

    const current = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...current!,
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "backend_spawn",
        failure_reason: "backend_spawn_exit",
        message: "This correction must not create a second child.",
      },
      summary: "Attempted correction over a globally inconsistent edge.",
    });
    const result = await service.reconcile({ scope: { runId: intent.run_id } });

    expect(result.unresolved).toContainEqual({
      run_id: intent.run_id,
      reason: "reconcile_candidate_failed",
    });
    const currentRunEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isRunTerminalEvent);
    expect(currentRunEvents).toEqual([root]);
    await expect(service.infraErrorCensus()).rejects.toMatchObject({
      name: "InfraErrorCensusAuthorityError",
      code: "cross_run_supersession",
    });
  });

  test("infraErrorCensus separates fresh claims that reuse both run id and intent timestamp", async () => {
    const observer = new RunService({ runsRoot }, buildDeps());
    const writer = new RunService({ runsRoot }, buildDeps());
    await observer.prepareGlobalEventAuthority();

    const intent = writer.createIntent({
      run_id: "metric-reused-run-id",
      host: "blade.tail-scale.ts.net",
      backend: "codex",
      prompt: "First metric incarnation",
      require_execplan: false,
    });
    const queued = await writer.initializeRun(intent);
    await writer.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "backend_spawn",
        failure_reason: "backend_spawn_exit",
        message: "First incarnation exited before producing a receipt.",
      },
      summary: "First incarnation infra_error.",
      updated_at: "2026-04-25T15:02:00.000Z",
      completed_at: "2026-04-25T15:02:00.000Z",
    });
    await writer.reconcile();
    const firstIncarnationId = queued.launch.incarnation_id;

    // Exact POL-1990 counterexample: after retention/reaping, a fresh claim may
    // reuse the same run_id, byte-identical intent, and therefore the same
    // intent.created_at and admission_identity. Only the fresh-claim
    // incarnation_id distinguishes it.
    await rm(writer.store.paths(intent.run_id).runDir, { recursive: true, force: true });
    const reusedQueued = await writer.initializeRun(intent);
    expect(reusedQueued.created_at).toBe(queued.created_at);
    expect(reusedQueued.launch.admission_identity).toBe(queued.launch.admission_identity);
    expect(reusedQueued.launch.incarnation_id).not.toBe(firstIncarnationId);
    await writer.store.writeRunRecord(intent.run_id, {
      ...reusedQueued,
      state: "infra_error",
      infra_error_classification: {
        schema_version: "infra_error_classification/v1",
        failure_layer: "backend_spawn",
        failure_reason: "backend_spawn_exit",
        message: "Second incarnation exited before producing a receipt.",
      },
      summary: "Second incarnation infra_error.",
      updated_at: "2026-04-26T15:02:00.000Z",
      completed_at: "2026-04-26T15:02:00.000Z",
    });
    await writer.reconcile();

    const terminalEvents = (await collectIndexedEvents(writer, intent.run_id))
      .filter(isRunTerminalEvent);
    expect(terminalEvents).toHaveLength(2);
    expect(new Set(terminalEvents.map((event) => event.run.created_at))).toEqual(
      new Set([intent.created_at]),
    );
    expect(new Set(terminalEvents.map((event) => event.run.incarnation_id)).size).toBe(2);
    expect(terminalEvents.every((event) => event.supersession === undefined)).toBe(true);

    const expectedPoint = {
      failure_layer: "backend_spawn" as const,
      failure_reason: "backend_spawn_exit" as const,
      host: "blade",
      kernel: "agent_runner" as const,
      backend: "codex" as const,
      count: 2,
    };
    await expect(observer.infraErrorCensus()).resolves.toEqual([expectedPoint]);
    await expect(observer.infraErrorCensus()).resolves.toEqual([expectedPoint]);

    const restartedObserver = new RunService({ runsRoot }, buildDeps());
    await restartedObserver.prepareGlobalEventAuthority();
    await expect(restartedObserver.infraErrorCensus()).resolves.toEqual([expectedPoint]);
  });

  test("partial records emit exactly one terminal event and handback while leaving the active set", async () => {
    const service = new RunService({
      runsRoot,
      subscribers: [],
      handback: { messageCorrespondence: false },
    }, buildDeps());
    const intent = service.createIntent({
      run_id: "old-partial-run",
      host: "blade",
      prompt: "Already partial",
      require_execplan: false,
      handback: {
        key: "partial-terminal-thread",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "partial-terminal-thread",
        ack_required: true,
        body_contract: "terminal state and durable locators",
      },
    });
    const queued = await service.initializeRun(intent);
    const completedAt = "2026-04-25T15:17:13.018Z";

    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "partial",
      summary: "Run old-partial-run partial; recovery=orchestrator_crash.",
      updated_at: completedAt,
      completed_at: completedAt,
    });

    const first = await service.reconcile();
    const second = await service.reconcile();
    const active = await service.store.listActiveRuns();
    const localTerminalEvents = (await service.readEvents(intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const indexedTerminalEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);
    const handbackFiles = (await readdir(service.store.paths(intent.run_id).runDir))
      .filter((entry) => entry.startsWith("handback-") && entry.endsWith(".json"));

    expect(first.rebuilt).toContain(intent.run_id);
    expect(second.skipped).toContain(intent.run_id);
    expect(active.find((entry) => entry.run_id === intent.run_id)).toBeUndefined();
    expect(localTerminalEvents).toEqual([
      expect.objectContaining({
        event_type: "run.terminal",
        run: expect.objectContaining({ state: "partial" }),
      }),
    ]);
    expect(indexedTerminalEvents).toEqual([
      expect.objectContaining({
        event_type: "run.terminal",
        run: expect.objectContaining({ state: "partial" }),
      }),
    ]);
    expect(handbackFiles).toHaveLength(1);
    expect(handbackReceipt).toMatchObject({
      schema_version: "calyx.run-handback/v1",
      run_id: intent.run_id,
      status: "receipt_only",
      outcome: { state: "partial" },
    });
  });

  test("store appendEvent is idempotent for duplicate Calyx event ids", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const event: StreamedRunEvent = {
      schema_version: "1.0",
      event_id: "event-dup-1",
      cursor: "2026-03-11T12:00:00.000Z-run-event-dedupe-1-000001",
      emitted_at: "2026-03-11T12:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: "run-event-dedupe-1",
        state: "succeeded",
        kernel: "agent_runner",
        backend: "claude",
        host: "blade",
        created_at: "2026-03-11T12:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: {
        launcher_kind: "cli",
      },
      pointers: {
        run_dir: join(runsRoot, "run-event-dedupe-1"),
        run_record_path: join(runsRoot, "run-event-dedupe-1", "run_record.json"),
        events_path: join(runsRoot, "run-event-dedupe-1", "events.jsonl"),
      },
      summary: {
        one_line: "Run run-event-dedupe-1 succeeded.",
      },
    };

    await service.store.appendEvent(event);
    await service.store.appendEvent(event);

    const runEvents = await service.store.readEvents(event.run.run_id);
    const localTerminalEvents = runEvents.filter(isRecordedCalyxRunEvent).filter((candidate) => candidate.event_id === event.event_id);
    const indexedEvents = await collectIndexedEvents(service, event.run.run_id);

    expect(localTerminalEvents).toHaveLength(1);
    expect(indexedEvents.filter((candidate) => candidate.event_id === event.event_id)).toHaveLength(1);
  });

  test("reconcile replays a global-only terminal event into the per-run journal", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-global-only-repair",
      host: "local",
      prompt: "Heal the global-then-local crash window",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: queued.launch.accepted_at,
      completed_at: queued.launch.accepted_at,
    });
    await service.reconcile();
    const indexedBefore = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    expect(indexedBefore).toHaveLength(1);

    const localWithoutTerminal = (await service.store.readEvents(intent.run_id))
      .filter((event) => !isRunTerminalEvent(event));
    await writeFile(
      service.store.paths(intent.run_id).eventsPath,
      `${localWithoutTerminal.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const repaired = await service.reconcile();
    const localAfter = (await service.store.readEvents(intent.run_id))
      .filter(isRecordedCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const indexedAfter = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");

    expect(repaired.skipped).toContain(intent.run_id);
    expect(localAfter.map((event) => event.event_id)).toEqual([indexedBefore[0]?.event_id]);
    expect(indexedAfter.map((event) => event.event_id)).toEqual([indexedBefore[0]?.event_id]);
  });

  test("reconcile replays a global-only terminal correction instead of minting a competitor", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-terminal-global-correction-repair",
      host: "local",
      prompt: "Heal a partially published terminal correction",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      summary: "Stale terminal summary.",
      updated_at: queued.launch.accepted_at,
      completed_at: queued.launch.accepted_at,
    });
    await service.reconcile();
    const current = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...current!,
      summary: "Corrected terminal summary.",
    });
    await service.reconcile();
    const indexedBefore = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    expect(indexedBefore).toHaveLength(2);
    const correction = indexedBefore[1]!;
    expect(correction).toMatchObject({
      summary: { one_line: "Corrected terminal summary." },
      supersession: { supersedes_event_id: indexedBefore[0]?.event_id },
    });

    const localWithoutCorrection = (await service.store.readEvents(intent.run_id))
      .filter((event) => !isRunTerminalEvent(event) || event.event_id !== correction.event_id);
    await writeFile(
      service.store.paths(intent.run_id).eventsPath,
      `${localWithoutCorrection.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const repaired = await service.reconcile();
    const localAfter = (await service.store.readEvents(intent.run_id))
      .filter(isRecordedCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const indexedAfter = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");

    expect(repaired.skipped).toContain(intent.run_id);
    expect(localAfter.map((event) => event.event_id)).toEqual(indexedBefore.map((event) => event.event_id));
    expect(indexedAfter.map((event) => event.event_id)).toEqual(indexedBefore.map((event) => event.event_id));
  });

  test("execution mutex admits exactly one effect and execute-stored ownership losers exit cleanly", async () => {
    const marker = join(runsRoot, "effect-count.txt");
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new HostProcessKernel(),
        hostname: () => "blade",
        now: () => new Date().toISOString(),
      },
    );
    const intent = service.createIntent({
      run_id: "run-single-execution-owner",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => process.exit(0), 300);`,
        ],
        cwd: runsRoot,
        stop_grace_ms: 50,
      },
    });

    const first = service.runInline(intent);
    await waitForFileContains(marker, "x");
    const loser = await service.executeStoredRun(intent.run_id);
    expect(["dispatching", "running"]).toContain(loser.state);
    expect(loser.launch).toMatchObject({
      stage: "executing",
      execution_id: expect.any(String),
    });

    const completed = await first;
    expect(completed.record.state).toBe("succeeded");
    expect(await readFile(marker, "utf8")).toBe("x");
  });

  test("reconcile adopts a live inline admission-to-execution handoff", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-inline-live-handoff",
      host: "local",
      prompt: "Protect the handoff gap",
      require_execplan: false,
    });
    const originalExecuteStoredRun = service.executeStoredRun.bind(service);
    let handoffEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      handoffEntered = resolve;
    });
    let releaseHandoff!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    vi.spyOn(service, "executeStoredRun").mockImplementation(async (runId, options) => {
      handoffEntered();
      await release;
      return originalExecuteStoredRun(runId, options);
    });

    const launch = service.runInline(intent);
    await entered;
    const reconciled = await service.reconcile();
    expect(reconciled.adopted).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "queued" });

    releaseHandoff();
    await expect(launch).resolves.toMatchObject({ record: { state: "succeeded" } });
  });

  test("reconcile classifies a crashed queued inline admission with no handoff owner", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-inline-crashed-before-handoff",
      host: "local",
      prompt: "No live admission remains",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });

    const reconciled = await service.reconcile();
    expect(reconciled.classified).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
      recovery: { mode: "orchestrator_crash" },
    });
  });

  test("owner-free running records fail closed before a second execution effect", async () => {
    const resolveExecutionKernel = vi.fn(buildDeps().resolveExecutionKernel!);
    const service = new RunService({ runsRoot }, {
      ...buildDeps(),
      resolveExecutionKernel,
    });
    const intent = service.createIntent({
      run_id: "run-owner-free-effect-boundary",
      host: "local",
      prompt: "Do not repeat me",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-execution",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    await expect(service.executeStoredRun(intent.run_id))
      .rejects.toThrow("refusing to repeat an ambiguous execution effect");
    expect(resolveExecutionKernel).not.toHaveBeenCalled();

    const reconcile = await service.reconcile();
    expect(reconcile.classified).toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
      recovery: { mode: "orchestrator_crash" },
    });
  });

  test("detached exact replay recovers a durable receipt after the execution owner exits", async () => {
    const spawnWorker = vi.fn(async () => ({ pid: 44_444, supervisor: "direct" as const }));
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      spawnWorker,
    });
    const intent = service.createIntent({
      run_id: "run-owner-free-durable-receipt",
      host: "local",
      prompt: "Recover my authoritative result",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    const receipt = makeReceipt(intent.run_id, {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-after-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const replay = await service.submitDetached(intent);

    expect(replay.record).toMatchObject({
      state: "succeeded",
      recovery: { mode: "orchestrator_crash" },
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(spawnWorker).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "succeeded",
    });
  });

  test("detached exact replay preserves receipt authority while run_record repair is pending", async () => {
    const spawnWorker = vi.fn(async () => ({ pid: 44_446, supervisor: "direct" as const }));
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      spawnWorker,
    });
    const intent = service.createIntent({
      run_id: "run-owner-free-receipt-repair-pending",
      host: "local",
      prompt: "Do not replay or downgrade my authoritative receipt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    const spec = await resolveRunIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-after-authoritative-receipt-before-projection",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const originalWrite = service.store.writeRunRecord.bind(service.store);
    vi.spyOn(service.store, "writeRunRecord").mockImplementation(async (runId, record) => {
      if (runId === intent.run_id && record.state === "succeeded") {
        throw new Error("injected run_record fsync failure");
      }
      return originalWrite(runId, record);
    });

    const replay = await service.submitDetached(intent);

    expect(replay.record).toMatchObject({
      state: "succeeded",
      recovery: { mode: "orchestrator_crash" },
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(spawnWorker).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    const events = await service.readEvents(intent.run_id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({
          reconcile: "record_rebuild_from_receipt_pending",
          projection_repair: "repair_pending",
        }),
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({ reconcile: "owner_free_fail_closed" }),
      }),
    ]));
  });

  test("receipt recovery cannot be downgraded by a terminal-observation failure", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-receipt-authority-observation-failure",
      host: "local",
      prompt: "Keep the typed receipt authoritative",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-after-authoritative-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    vi.spyOn(service.store, "appendEvent").mockRejectedValue(
      new Error("injected terminal-observation failure"),
    );

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
  });

  test("a corrupt local event journal defers to an existing typed receipt", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-corrupt-events-with-authoritative-receipt",
      host: "local",
      prompt: "Recover from the receipt before classifying",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-with-corrupt-events",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await writeFile(
      service.store.paths(intent.run_id).eventsPath,
      "{\"complete_but_malformed\":\n",
      { encoding: "utf8", flag: "a" },
    );

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);
    const entries = await readdir(service.store.paths(intent.run_id).runDir);

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { run_id: intent.run_id, state: "succeeded" },
    });
    expect(entries.some((entry) => entry.startsWith("events.jsonl.corrupt."))).toBe(true);
  });

  test("receipt recovery fails closed on cross-run identity without projecting the foreign id", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-identity-A",
      host: "local",
      prompt: "Keep this directory authoritative",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-cross-run-owner",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const foreignRunId = "run-recovery-identity-B";
    const foreignSpec = makeReceiptSpec(foreignRunId, intent, spec.backend);
    await writeFile(
      service.store.paths(intent.run_id).kernelReceiptPath,
      `${JSON.stringify(makeReceipt(foreignRunId, foreignSpec), null, 2)}\n`,
      "utf8",
    );

    await expect(service.getKernelReceipt(intent.run_id))
      .rejects.toThrow("contains a mismatched kernel receipt");

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      run_id: intent.run_id,
      state: "infra_error",
      intent: { run_id: intent.run_id },
      recovery: { mode: "orchestrator_crash" },
    });
    expect(record?.summary).toContain("receipt.run_id=run-recovery-identity-B");
    await expect(service.getRunRecord(foreignRunId)).resolves.toBeUndefined();
  });

  test("reconcile repairs a legacy cross-run record as the directory run", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-directory-authority-A",
      host: "local",
      prompt: "Repair this legacy record",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const foreignRunId = "run-directory-authority-B";
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify({
        ...queued,
        run_id: foreignRunId,
        intent: { ...queued.intent, run_id: foreignRunId },
        state: "running",
        launch: {
          ...queued.launch,
          stage: "executing",
          execution_id: "legacy-cross-run-corruption",
          execution_started_at: "2026-03-11T12:00:01.000Z",
        },
        updated_at: "2026-03-11T12:00:01.000Z",
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(service.getRunRecord(intent.run_id))
      .rejects.toThrow("contains mismatched record identity");
    await expect(service.listRuns())
      .rejects.toThrow("run reconciliation before listing runs");
    await expect(service.launch(intent, { detached: false }))
      .rejects.toThrow("contains mismatched record identity");

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(record).toMatchObject({
      run_id: intent.run_id,
      state: "infra_error",
      intent: { run_id: intent.run_id },
      summary: expect.stringContaining(`Run directory ${intent.run_id} contains mismatched record identity`),
    });
    await expect(service.getRunRecord(foreignRunId)).resolves.toBeUndefined();
    expect((await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent)).toHaveLength(1);
  });

  test("terminal reconcile contains nested receipt identity corruption as the directory run", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-nested-directory-authority-A",
      host: "local",
      prompt: "Repair the embedded receipt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const receipt = makeReceipt(
      intent.run_id,
      makeReceiptSpec(intent.run_id, intent, spec.backend),
    );
    const foreignRunId = "run-nested-directory-authority-B";
    await writeFile(
      service.store.paths(intent.run_id).runRecordPath,
      `${JSON.stringify({
        ...queued,
        state: "succeeded",
        spec,
        kernel_receipt: {
          ...receipt,
          artifacts: { ...receipt.artifacts, run_id: foreignRunId },
        },
        summary: "Legacy terminal record with nested cross-run corruption.",
        updated_at: receipt.timing.completed_at,
        completed_at: receipt.timing.completed_at,
      }, null, 2)}\n`,
      "utf8",
    );

    await expect(service.getRunRecord(intent.run_id))
      .rejects.toThrow(`record.kernel_receipt.artifacts.run_id=${foreignRunId}`);
    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(record).toMatchObject({
      run_id: intent.run_id,
      state: "infra_error",
      intent: { run_id: intent.run_id },
      summary: expect.stringContaining(`record.kernel_receipt.artifacts.run_id=${foreignRunId}`),
    });
    expect(record?.kernel_receipt).toBeUndefined();
    await expect(service.getRunRecord(foreignRunId)).resolves.toBeUndefined();
  });

  test("reconcile classifies a torn receipt and continues to rebuild a valid sibling run", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const prepareOwnerFree = async (runId: string) => {
      const intent = service.createIntent({
        run_id: runId,
        host: "local",
        prompt: `Recover ${runId}`,
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "inline" });
      const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
      await service.store.writeSpec(runId, spec);
      await service.store.writeRunRecord(runId, {
        ...queued,
        state: "running",
        spec,
        launch: {
          ...queued.launch,
          stage: "executing",
          execution_id: `lost-${runId}`,
          execution_started_at: "2026-03-11T12:00:01.000Z",
        },
        updated_at: "2026-03-11T12:00:01.000Z",
      });
      return { intent, spec };
    };
    const torn = await prepareOwnerFree("run-recovery-torn");
    const valid = await prepareOwnerFree("run-recovery-valid");
    await writeFile(service.store.paths(torn.intent.run_id).kernelReceiptPath, "{\"run_id\":", "utf8");
    await service.store.writeKernelReceipt(
      valid.intent.run_id,
      makeReceipt(valid.intent.run_id, makeReceiptSpec(valid.intent.run_id, valid.intent, valid.spec.backend)),
    );

    const reconciled = await service.reconcile();

    expect(reconciled.classified).toContain(torn.intent.run_id);
    expect(reconciled.rebuilt).toContain(valid.intent.run_id);
    await expect(service.getRunRecord(torn.intent.run_id)).resolves.toMatchObject({
      run_id: torn.intent.run_id,
      state: "infra_error",
      summary: expect.stringContaining("Kernel receipt is invalid JSON"),
    });
    await expect(service.getRunRecord(valid.intent.run_id)).resolves.toMatchObject({
      run_id: valid.intent.run_id,
      state: "succeeded",
    });
  });

  test("receipt authority reports repair_pending when run_record publication fails", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-record-publication-pending",
      host: "local",
      prompt: "Keep the receipt authoritative without claiming a repaired projection",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-after-authoritative-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    const originalWrite = service.store.writeRunRecord.bind(service.store);
    vi.spyOn(service.store, "writeRunRecord").mockImplementation(async (runId, record) => {
      if (runId === intent.run_id && record.state === "succeeded") {
        throw new Error("injected run_record fsync failure");
      }
      return originalWrite(runId, record);
    });

    const reconciled = await service.reconcile();

    expect(reconciled.repair_pending).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({ state: "running" });
    await expect(service.store.readKernelReceipt(intent.run_id)).resolves.toMatchObject({
      run_id: intent.run_id,
      state: "succeeded",
    });
    expect(await service.readEvents(intent.run_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({
          reconcile: "record_rebuild_from_receipt_pending",
          projection_repair: "repair_pending",
        }),
      }),
    ]));
  });

  test("receipt authority reports repair_pending when JSON publishes but the run index cannot repair", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const projection = new RunIndexProjection();
    const originalUpsert = projection.upsert.bind(projection);
    vi.spyOn(projection, "upsert").mockImplementation(async (row) => (
      row.state === "succeeded"
        ? { status: "disabled", reason: "injected terminal index upsert failure" }
        : originalUpsert(row)
    ));
    vi.spyOn(projection, "replace").mockResolvedValue({
      status: "disabled",
      reason: "injected full index repair failure",
    });
    const service = new RunService({ runsRoot, subscribers: [], runIndex: projection }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-index-repair-pending",
      host: "local",
      prompt: "Do not claim a repaired list projection",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-after-receipt-before-index-repair",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconciled = await service.reconcile();

    expect(reconciled.repair_pending).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(reconciled.projection).toMatchObject({ status: "failed" });
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "succeeded",
      kernel_receipt: { state: "succeeded" },
    });
    expect(await service.readEvents(intent.run_id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "reconciled",
        payload: expect.objectContaining({
          reconcile: "record_rebuild_from_receipt_pending",
          projection_repair: "repair_pending",
        }),
      }),
    ]));
    projection.close();
  }));

  test("the final full index rebuild clears a transient receipt projection repair", async () => withTempStateHome(async () => {
    await applyStateMigrations();
    const projection = new RunIndexProjection();
    const originalUpsert = projection.upsert.bind(projection);
    const originalReplace = projection.replace.bind(projection);
    vi.spyOn(projection, "upsert").mockImplementation(async (row) => (
      row.state === "succeeded"
        ? { status: "disabled", reason: "injected terminal index upsert failure" }
        : originalUpsert(row)
    ));
    vi.spyOn(projection, "replace")
      .mockResolvedValueOnce({
        status: "disabled",
        reason: "injected first full index repair failure",
      })
      .mockImplementation(originalReplace);
    const service = new RunService({ runsRoot, subscribers: [], runIndex: projection }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-index-transient-repair",
      host: "local",
      prompt: "Report the final projection state",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-before-transient-index-repair",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconciled = await service.reconcile();

    expect(reconciled.repair_pending).toEqual([]);
    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(reconciled.projection).toMatchObject({ status: "repaired" });
    const reconcileEvents = (await service.readEvents(intent.run_id)).filter((event) => (
      isRunServiceEvent(event) && event.event === "reconciled"
    ));
    expect(reconcileEvents.at(-1)).toMatchObject({
      payload: {
        reconcile: "record_rebuild_from_receipt",
        projection_repair: "repaired",
        supersedes_projection_repair: "repair_pending",
      },
    });
    projection.close();
  }));

  test("receipt recovery rejects identity-valid but schema-invalid success receipts", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-malformed-shape",
      host: "local",
      prompt: "Do not trust a receipt-shaped stub",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-before-malformed-recovery",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await writeFile(
      service.store.paths(intent.run_id).kernelReceiptPath,
      `${JSON.stringify({ run_id: intent.run_id, state: "succeeded", timing: {} })}\n`,
      "utf8",
    );

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      run_id: intent.run_id,
      state: "infra_error",
      summary: expect.stringContaining("receipt is malformed for agent_runner"),
    });
    expect(record?.kernel_receipt).toBeUndefined();
  });

  test("receipt recovery rejects a schema-valid agent receipt from a stale spec with the same run id", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-stale-agent-spec",
      host: "local",
      prompt: "Execute the current stored prompt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-after-stale-agent-effect",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, {
        ...makeReceiptSpec(intent.run_id, intent, spec.backend),
        prompt: "Execute an obsolete prompt",
      }),
    );

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      run_id: intent.run_id,
      state: "infra_error",
      summary: expect.stringContaining("does not correspond to the stored agent_runner spec at run_spec.prompt"),
    });
  });

  test("receipt recovery compares caller environment while allowing added null server redactions", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-stale-agent-env",
      host: "local",
      prompt: "Execute with the current caller environment",
      require_execplan: false,
      backend_options: { env: { PUBLIC_SETTING: "current" } },
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-after-stale-agent-env-effect",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, {
        ...makeReceiptSpec(intent.run_id, intent, spec.backend),
        backend_options: {
          env: {
            PUBLIC_SETTING: "stale",
            CALYX_CONSUMER_API_SWITCHBOARD_TOKEN: null,
          },
        },
      }),
    );

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(record).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining("does not correspond to the stored agent_runner spec at run_spec.backend_options.env"),
    });
  });

  test("receipt recovery rejects a schema-valid host receipt from a stale process spec with the same run id", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-stale-host-spec",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: runsRoot,
        stop_grace_ms: 250,
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await new HostProcessKernel().resolveIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    const executionId = "lost-after-stale-host-effect";
    const admittedExecution = admitHostProcessExecution(
      spec,
      executionId,
      freezeHostProcessSpawnEnvironment(spec.process.env, process.env),
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: executionId,
        execution_started_at: "2026-03-11T12:00:01.000Z",
        host_process_execution_binding: admittedExecution.binding,
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const receipt: HostProcessReceipt = {
      schema_version: HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
      kernel: "host_process",
      run_id: intent.run_id,
      execution_binding: admittedExecution.binding,
      state: "succeeded",
      timing: {
        created_at: "2026-03-11T12:00:01.000Z",
        completed_at: "2026-03-11T12:00:02.000Z",
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: [process.execPath, "-e", "process.exit(99)"],
        cwd: spec.process.cwd,
        env_keys: [],
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: false,
      },
      summary: "A stale host process reported success.",
    };
    await service.store.writeKernelReceipt(intent.run_id, receipt);

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining("does not correspond to the stored host_process spec at process.argv"),
    });
  });

  test("reconcile preserves a coherent published legacy host receipt as observation-only evidence", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent: RunIntent = {
      ...service.createIntent({
        run_id: "run-legacy-host-terminal-observation",
        host: "local",
        kernel: "host_process",
        host_process: {
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: runsRoot,
          stop_grace_ms: 250,
        },
      }),
      created_at: "2026-03-11T11:00:00.000Z",
    };
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    await expect(service.getResourceTerminalAuthority(queued.run_id)).resolves.toBeUndefined();
    const spec = await new HostProcessKernel().resolveIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    const completedAt = "2026-03-11T12:00:02.000Z";
    const legacyReceipt: HostProcessReceipt = {
      schema_version: "1.0",
      kernel: "host_process",
      run_id: intent.run_id,
      state: "succeeded",
      timing: { created_at: intent.created_at, completed_at: completedAt },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: spec.process.argv,
        cwd: spec.process.cwd,
        env_keys: [],
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: false,
      },
      summary: "Legacy host process succeeded.",
    };
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, legacyReceipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "legacy-host-execution",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      kernel_receipt: legacyReceipt,
      summary: "Legacy host process succeeded.",
      updated_at: completedAt,
      completed_at: completedAt,
    });
    await applyStateMigrations();
    const leased = await openStateStore();
    try {
      expect(acquireLease(leased.db, {
        key: "worktree:blade:/tmp/legacy-observation-only",
        holder_activity_id: `run:${intent.run_id}`,
        ttl_ms: 60_000,
        now: "2026-03-11T12:00:01.000Z",
      }).acquired).toBe(true);
    } finally {
      leased.db.close();
    }

    const reconciled = await service.reconcile();
    const stable = await service.reconcile();
    const preserved = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(stable.skipped).toContain(intent.run_id);
    expect(stable.classified).not.toContain(intent.run_id);
    expect(preserved).toMatchObject({
      state: "succeeded",
      spec,
      kernel_receipt: legacyReceipt,
    });
    await expect(service.getKernelReceipt(intent.run_id)).resolves.toEqual(legacyReceipt);
    await expect(service.getResourceTerminalAuthority(preserved!.run_id)).resolves.toBeUndefined();
    const after = await openStateStore();
    try {
      expect(listLeases(after.db, {
        holder_activity_id: `run:${intent.run_id}`,
        include_expired: true,
      })).toHaveLength(1);
    } finally {
      after.db.close();
    }

    const settled = structuredClone(preserved!);
    const legacyPid = 45_672;
    settled.recovery = {
      mode: "orphaned_process",
      resumable: false,
      owner_free_settlement: {
        schema_version: "calyx.owner-free-settlement/v1",
        authority: "legacy_pid_dead",
        authority_id: "pending",
        settled_at: "2026-03-11T12:00:03.000Z",
        reason_code: "legacy_detached_worker_observed_dead",
        legacy_pid: legacyPid,
      },
      resource_settlement: {
        schema_version: "calyx.resource-settlement/v1",
        status: "settled",
        authority: "legacy_process_group_extinct",
        authority_id: "pending",
        settled_at: "2026-03-11T12:00:04.000Z",
        reason_code: "legacy_detached_process_group_observed_extinct",
        legacy_process_group_id: legacyPid,
      },
    };
    settled.recovery.owner_free_settlement!.authority_id = legacyDeadSettlementAuthorityId(settled, legacyPid);
    const resourceSettlement = settled.recovery.resource_settlement;
    if (resourceSettlement?.status !== "settled") throw new Error("expected settled resource fixture");
    resourceSettlement.authority_id = legacyResourceSettlementAuthorityId(settled, legacyPid);
    await service.store.writeRunRecord(settled.run_id, settled);
    await expect(service.getResourceTerminalAuthority(settled.run_id)).resolves.toMatchObject({
      source: "legacy_resource_settlement",
    });
  });

  test("legacy host receipt cannot reconstruct an owner-free nonterminal run", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-legacy-host-reconstruction-refused",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: runsRoot,
        stop_grace_ms: 250,
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await new HostProcessKernel().resolveIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    const legacyReceipt: HostProcessReceipt = {
      schema_version: "1.0",
      kernel: "host_process",
      run_id: intent.run_id,
      state: "succeeded",
      timing: {
        created_at: intent.created_at,
        completed_at: "2026-03-11T12:00:02.000Z",
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: spec.process.argv,
        cwd: spec.process.cwd,
        env_keys: [],
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: false,
      },
      summary: "Unbound legacy success cannot establish authority.",
    };
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, legacyReceipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "legacy-owner-free-execution",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconciled = await service.reconcile();
    const classified = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(classified).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining("observation-only"),
    });
  });

  test("a late incoherent legacy host receipt is unresolved rather than a benign reconcile skip", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-late-incoherent-legacy-host-receipt",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: runsRoot,
        stop_grace_ms: 250,
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await new HostProcessKernel().resolveIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    await service.store.writeSpec(intent.run_id, spec);
    const legacyReceipt: HostProcessReceipt = {
      schema_version: "1.0",
      kernel: "host_process",
      run_id: intent.run_id,
      state: "succeeded",
      timing: {
        created_at: intent.created_at,
        completed_at: "2026-03-11T12:00:02.000Z",
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: spec.process.argv,
        cwd: spec.process.cwd,
        env_keys: [],
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: false,
      },
      summary: "A late receipt cannot authorize a queued projection.",
    };
    const originalReadKernelReceipt = service.store.readKernelReceipt.bind(service.store);
    let signalReceiptRead!: () => void;
    let releaseReceiptRead!: () => void;
    const receiptReadStarted = new Promise<void>((resolve) => { signalReceiptRead = resolve; });
    const receiptReadRelease = new Promise<void>((resolve) => { releaseReceiptRead = resolve; });
    const readReceipt = vi.spyOn(service.store, "readKernelReceipt").mockImplementationOnce(async (runId) => {
      signalReceiptRead();
      await receiptReadRelease;
      return originalReadKernelReceipt(runId);
    });

    const reconcilePromise = service.reconcile();
    await receiptReadStarted;
    await service.store.writeKernelReceipt(intent.run_id, legacyReceipt);
    releaseReceiptRead();
    const reconciled = await reconcilePromise;
    readReceipt.mockRestore();

    expect(reconciled.unresolved).toEqual([{
      run_id: intent.run_id,
      reason: "legacy_publication_authority_unproven",
    }]);
    expect(reconciled.skipped).not.toContain(intent.run_id);
    expect(reconciled.classified).not.toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    await expect(service.getRunRecord(intent.run_id)).resolves.toEqual(queued);
  });

  test("a legacy host receipt on a queued record refuses a new process effect", async () => {
    const markerPath = join(runsRoot, "legacy-receipt-new-effect.marker");
    const service = new RunService(
      { runsRoot, subscribers: [] },
      {
        ...buildDeps(),
        resolveExecutionKernel: () => new HostProcessKernel(),
      },
    );
    const intent = service.createIntent({
      run_id: "run-legacy-host-new-effect-refused",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
          markerPath,
        ],
        cwd: runsRoot,
        stop_grace_ms: 250,
      },
    });
    await service.initializeRun(intent, { launchMode: "inline" });
    const legacyReceipt: HostProcessReceipt = {
      schema_version: "1.0",
      kernel: "host_process",
      run_id: intent.run_id,
      state: "succeeded",
      timing: {
        created_at: intent.created_at,
        completed_at: "2026-03-11T12:00:02.000Z",
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: intent.host_process!.argv,
        cwd: intent.host_process!.cwd!,
        env_keys: [],
        stop_grace_ms: intent.host_process!.stop_grace_ms!,
        stop_requested: false,
      },
      summary: "Legacy receipt predates a coherent record projection.",
    };
    await service.store.writeKernelReceipt(intent.run_id, legacyReceipt);

    const result = await service.executeStoredRun(intent.run_id);

    expect(result).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining("refusing to admit a new external execution effect"),
    });
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("receipt recovery rejects a host commitment from the same environment keys with stale values", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const executionId = "lost-after-stale-host-environment";
    const intent = service.createIntent({
      run_id: "run-recovery-stale-host-environment",
      host: "local",
      kernel: "host_process",
      host_process: {
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: runsRoot,
        env: { DEPLOYMENT_MODE: "current" },
        stop_grace_ms: 250,
      },
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await new HostProcessKernel().resolveIntent(intent, {
      now: () => "2026-03-11T12:00:00.000Z",
    });
    const staleSpec = {
      ...spec,
      process: {
        ...spec.process,
        env: { DEPLOYMENT_MODE: "stale" },
      },
    };
    const admittedExecution = admitHostProcessExecution(
      spec,
      executionId,
      { DEPLOYMENT_MODE: "current" },
      "c".repeat(43),
    );
    const staleExecution = admitHostProcessExecution(
      staleSpec,
      executionId,
      { DEPLOYMENT_MODE: "stale" },
      "s".repeat(43),
    );
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: executionId,
        execution_started_at: "2026-03-11T12:00:01.000Z",
        host_process_execution_binding: admittedExecution.binding,
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });
    const receipt: HostProcessReceipt = {
      schema_version: HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
      kernel: "host_process",
      run_id: intent.run_id,
      execution_binding: staleExecution.binding,
      state: "succeeded",
      timing: {
        created_at: "2026-03-11T12:00:01.000Z",
        completed_at: "2026-03-11T12:00:02.000Z",
      },
      exit: { exit_code: 0 },
      log_summary: { total: 0, info: 0, warn: 0, error: 0 },
      process: {
        argv: spec.process.argv,
        cwd: spec.process.cwd,
        env_keys: ["DEPLOYMENT_MODE"],
        stop_grace_ms: spec.process.stop_grace_ms,
        stop_requested: false,
      },
      summary: "A stale host environment reported success.",
    };
    await service.store.writeKernelReceipt(intent.run_id, receipt);

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.classified).toContain(intent.run_id);
    expect(reconciled.rebuilt).not.toContain(intent.run_id);
    expect(record).toMatchObject({
      state: "infra_error",
      summary: expect.stringContaining(
        "does not correspond to the stored host_process spec at execution_binding",
      ),
    });
  });

  test("receipt recovery records critical subscribers as unknown and never replays them", async () => {
    const subscriberRun = vi.fn(async () => ({
      name: "critical-publisher",
      critical: true,
      status: "success" as const,
    }));
    const service = new RunService({
      runsRoot,
      subscribers: [{ name: "critical-publisher", critical: true, run: subscriberRun }],
    }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-critical-unknown",
      host: "local",
      prompt: "Do not replay the publisher",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-after-kernel-effect",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(subscriberRun).not.toHaveBeenCalled();
    expect(record?.integrations).toEqual({
      results: [{
        name: "critical-publisher",
        critical: true,
        status: "failed",
        error: expect.stringContaining("outcome is unknown"),
        details: { outcome: "unknown" },
      }],
      all_critical_ok: false,
    });
  });

  test("recovery preserves removed subscriber results across configuration drift", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-recovery-removed-critical-subscriber",
      host: "local",
      prompt: "Preserve historical subscriber truth",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "inline" });
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(
      intent.run_id,
      makeReceipt(intent.run_id, makeReceiptSpec(intent.run_id, intent, spec.backend)),
    );
    await service.store.writeIntegrations(intent.run_id, {
      results: [{
        name: "removed-critical-publisher",
        critical: true,
        status: "failed",
        error: "outcome unknown after crash",
        details: { outcome: "unknown" },
      }],
      all_critical_ok: false,
    });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "lost-with-removed-subscriber",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconciled = await service.reconcile();
    const record = await service.getRunRecord(intent.run_id);

    expect(reconciled.rebuilt).toContain(intent.run_id);
    expect(record?.integrations).toEqual({
      results: [{
        name: "removed-critical-publisher",
        critical: true,
        status: "failed",
        error: "outcome unknown after crash",
        details: { outcome: "unknown" },
      }],
      all_critical_ok: false,
    });
  });

  test("subscriber failures and a torn final-record write preserve receipt authority everywhere", async () => {
    let planSeenBeforeEffect: unknown;
    const subscriber = {
      name: "critical-publisher",
      critical: true,
      async run() {
        planSeenBeforeEffect = await service.store.readIntegrations("run-subscriber-plan-durable");
        throw new Error("publisher rejected");
      },
    };
    const service = new RunService({
      runsRoot,
      subscribers: [subscriber],
      handback: { messageCorrespondence: false },
    }, buildDeps());
    const originalWriteRunRecord = service.store.writeRunRecord.bind(service.store);
    let failedFinalWrite = false;
    vi.spyOn(service.store, "writeRunRecord").mockImplementation(async (runId, record) => {
      if (
        !failedFinalWrite
        && record.state === "succeeded"
        && record.integrations.results.some((result) => result.error === "publisher rejected")
      ) {
        failedFinalWrite = true;
        throw new Error("final run record fsync failed");
      }
      return originalWriteRunRecord(runId, record);
    });
    const intent = service.createIntent({
      run_id: "run-subscriber-plan-durable",
      host: "local",
      prompt: "Persist the subscriber boundary",
      require_execplan: false,
      handback: {
        key: "subscriber-receipt-authority",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "subscriber-receipt-authority",
        ack_required: true,
        body_contract: "terminal state only",
      },
    });

    const result = await service.launch(intent, { detached: false });
    const persisted = await service.getRunRecord(intent.run_id);
    const kernelReceipt = await service.store.readKernelReceipt(intent.run_id);
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);

    expect(planSeenBeforeEffect).toEqual({
      results: [{
        name: "critical-publisher",
        critical: true,
        status: "failed",
        error: expect.stringContaining("outcome is unknown"),
        details: { outcome: "unknown" },
      }],
      all_critical_ok: false,
    });
    expect(failedFinalWrite).toBe(true);
    expect(result.record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { state: "succeeded" },
      integrations: {
        results: [{
          name: "critical-publisher",
          critical: true,
          status: "failed",
          error: "publisher rejected",
        }],
        all_critical_ok: false,
      },
    });
    expect(persisted).toMatchObject({
      state: "succeeded",
      kernel_receipt: { state: "succeeded" },
    });
    expect(kernelReceipt).toMatchObject({ state: "succeeded" });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.run.state).toBe("succeeded");
    expect(handbackReceipt).toMatchObject({
      flow: "receipt-only/v1",
      outcome: { state: "succeeded" },
      terminal_event: { event_id: terminalEvents[0]?.event_id },
    });
    expect((await service.readEvents(intent.run_id)).filter((event) => (
      "event" in event
      && event.event === "state_transition"
      && event.to === "infra_error"
    ))).toHaveLength(0);
  });

  test("integration persistence failure after a durable receipt cannot invent infra_error", async () => {
    const service = new RunService({
      runsRoot,
      subscribers: [{
        name: "critical-publisher",
        critical: true,
        async run() {
          throw new Error("must not run after the durable manifest write fails");
        },
      }],
      handback: { messageCorrespondence: false },
    }, buildDeps());
    const originalWriteIntegrations = service.store.writeIntegrations.bind(service.store);
    let failedManifestWrite = false;
    vi.spyOn(service.store, "writeIntegrations").mockImplementation(async (runId, status) => {
      if (!failedManifestWrite && await service.store.readKernelReceipt(runId)) {
        failedManifestWrite = true;
        throw new Error("integration manifest fsync failed");
      }
      return originalWriteIntegrations(runId, status);
    });
    const intent = service.createIntent({
      run_id: "run-integration-manifest-receipt-authority",
      host: "local",
      prompt: "Keep the typed receipt authoritative",
      require_execplan: false,
      handback: {
        key: "integration-receipt-authority",
        recipient_address: "interactive:codex:caller-session",
        thread_key: "integration-receipt-authority",
        ack_required: true,
        body_contract: "terminal state only",
      },
    });

    const result = await service.launch(intent, { detached: false });
    const persisted = await service.getRunRecord(intent.run_id);
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const handbackReceipt = await readRunHandbackReceipt(service, intent.run_id);

    expect(failedManifestWrite).toBe(true);
    expect(result.record).toMatchObject({
      state: "succeeded",
      kernel_receipt: { state: "succeeded" },
      integrations: {
        results: [{
          name: "critical-publisher",
          critical: true,
          status: "failed",
          details: { outcome: "unknown" },
        }],
        all_critical_ok: false,
      },
    });
    expect(persisted).toMatchObject({
      state: "succeeded",
      kernel_receipt: { state: "succeeded" },
    });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.run.state).toBe("succeeded");
    expect(handbackReceipt).toMatchObject({
      outcome: { state: "succeeded" },
      terminal_event: { event_id: terminalEvents[0]?.event_id },
    });
    expect((await service.readEvents(intent.run_id)).filter((event) => (
      "event" in event
      && event.event === "state_transition"
      && event.to === "infra_error"
    ))).toHaveLength(0);
  });

  test("concurrent terminal reconcilers emit one terminal event", async () => {
    const first = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const second = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = first.createIntent({
      run_id: "run-concurrent-terminal-reconcile",
      host: "local",
      prompt: "Finalize exactly once",
      require_execplan: false,
    });
    const queued = await first.initializeRun(intent, { launchMode: "inline" });
    await first.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "succeeded",
      summary: `Run ${intent.run_id} succeeded.`,
      updated_at: "2026-03-11T12:00:01.000Z",
      completed_at: "2026-03-11T12:00:01.000Z",
    });

    const [firstResult, secondResult] = await Promise.all([
      first.reconcile(),
      second.reconcile(),
    ]);
    const localTerminalEvents = (await first.store.readEvents(intent.run_id))
      .filter(isRecordedCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");
    const indexedTerminalEvents = (await collectIndexedEvents(first, intent.run_id))
      .filter(isCalyxRunEvent)
      .filter((event) => event.event_type === "run.terminal");

    expect(localTerminalEvents).toHaveLength(1);
    expect(indexedTerminalEvents).toHaveLength(1);
    expect([...firstResult.rebuilt, ...secondResult.rebuilt]).toEqual([intent.run_id]);
  });

  test("queues reconcile on its SQLite authority before entering the complete pass", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    let signalAuthorityHeld!: () => void;
    let releaseAuthority!: () => void;
    const authorityHeld = new Promise<void>((resolve) => { signalAuthorityHeld = resolve; });
    const authorityRelease = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    const held = withSqliteMutex(service.store.reconcileMutexPath(), async () => {
      signalAuthorityHeld();
      await authorityRelease;
    }, {
      acquireTimeoutMs: null,
      // Bypass the same-process chain so this regression exercises the exact
      // SQLite authority used by sibling processes.
      queueInProcess: false,
    });
    await authorityHeld;
    const inspect = vi.spyOn(service.store, "inspectNonCanonicalRunDirectories");
    let reconcileSettled = false;
    const reconcile = service.reconcile().finally(() => { reconcileSettled = true; });

    try {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(inspect).not.toHaveBeenCalled();
      expect(reconcileSettled).toBe(false);
    } finally {
      releaseAuthority();
      await held;
    }

    await expect(reconcile).resolves.toMatchObject({ scanned: 0 });
    expect(inspect).toHaveBeenCalledOnce();
  });

  test("event journals fail closed on an invalid unterminated tail without truncation", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-event-journal-torn-tail",
      host: "local",
      prompt: "Recover the append boundary",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });
    await writeFile(
      service.store.paths(intent.run_id).eventsPath,
      "{\"timestamp\":",
      { encoding: "utf8", flag: "a" },
    );

    const corruptBytes = await readFile(service.store.paths(intent.run_id).eventsPath, "utf8");
    await expect(service.readEvents(intent.run_id)).rejects.toBeInstanceOf(EventJournalCorruptionError);
    await expect(service.store.appendEvent(intent.run_id, {
      timestamp: "2026-03-11T12:00:02.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "warning",
      message: "append after tail recovery",
    })).rejects.toBeInstanceOf(EventJournalCorruptionError);
    const entries = await readdir(service.store.paths(intent.run_id).runDir);

    await expect(readFile(service.store.paths(intent.run_id).eventsPath, "utf8"))
      .resolves.toBe(corruptBytes);
    expect(entries.some((entry) => entry.includes("events.jsonl.torn."))).toBe(false);
    expect(entries.some((entry) => entry.includes("events.jsonl.recovery."))).toBe(false);
  });

  test("event appends reject a parseable unterminated tail without inventing its commit boundary", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-event-journal-valid-unterminated-tail",
      host: "local",
      prompt: "Preserve a complete final event without its newline",
      require_execplan: false,
    });
    await service.initializeRun(intent, { launchMode: "inline" });
    const eventsPath = service.store.paths(intent.run_id).eventsPath;
    const original = await readFile(eventsPath, "utf8");
    await writeFile(eventsPath, original.trimEnd(), "utf8");

    const unterminated = original.trimEnd();
    await expect(service.store.appendEvent(intent.run_id, {
      timestamp: "2026-03-11T12:00:02.000Z",
      run_id: intent.run_id,
      source: "run-service",
      event: "warning",
      message: "append after valid tail repair",
    })).rejects.toBeInstanceOf(EventJournalCorruptionError);

    await expect(readFile(eventsPath, "utf8")).resolves.toBe(unterminated);
  });

  test("reconcile quarantines a complete malformed event line and continues with sibling runs", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const prepareTerminal = async (runId: string) => {
      const intent = service.createIntent({
        run_id: runId,
        host: "local",
        prompt: `Repair ${runId}`,
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "inline" });
      await service.store.writeRunRecord(runId, {
        ...queued,
        state: "succeeded",
        summary: `Run ${runId} succeeded before observation repair.`,
        updated_at: "2026-03-11T12:00:01.000Z",
        completed_at: "2026-03-11T12:00:01.000Z",
      });
      return intent;
    };
    const damaged = await prepareTerminal("run-event-journal-damaged-A");
    const sibling = await prepareTerminal("run-event-journal-valid-B");
    await writeFile(
      service.store.paths(damaged.run_id).eventsPath,
      "{\"complete_but_malformed\":\n",
      { encoding: "utf8", flag: "a" },
    );

    const reconciled = await service.reconcile();
    const damagedRecord = await service.getRunRecord(damaged.run_id);
    const siblingRecord = await service.getRunRecord(sibling.run_id);
    const damagedEntries = await readdir(service.store.paths(damaged.run_id).runDir);

    expect(reconciled.classified).toContain(damaged.run_id);
    expect(reconciled.rebuilt).toContain(sibling.run_id);
    expect(damagedRecord).toMatchObject({
      run_id: damaged.run_id,
      state: "infra_error",
      summary: expect.stringContaining("contains invalid JSON"),
    });
    expect(siblingRecord?.state).toBe("succeeded");
    expect(damagedEntries.some((entry) => entry.startsWith("events.jsonl.corrupt."))).toBe(true);
    await expect(service.readEvents(damaged.run_id)).resolves.toEqual(expect.any(Array));
  });

  test("reconcile fails closed without replacing a corrupt global event index", async () => {
    const service = new RunService({ runsRoot, subscribers: [] }, buildDeps());
    const prepareTerminal = async (runId: string) => {
      const intent = service.createIntent({
        run_id: runId,
        host: "local",
        prompt: `Backfill ${runId}`,
        require_execplan: false,
      });
      const queued = await service.initializeRun(intent, { launchMode: "inline" });
      await service.store.writeRunRecord(runId, {
        ...queued,
        state: "succeeded",
        summary: `Run ${runId} succeeded before global index repair.`,
        updated_at: "2026-03-11T12:00:01.000Z",
        completed_at: "2026-03-11T12:00:01.000Z",
      });
      return intent;
    };
    const first = await prepareTerminal("run-global-event-index-damaged-A");
    const second = await prepareTerminal("run-global-event-index-damaged-B");
    await writeFile(
      service.store.eventsIndexPath(),
      "{\"complete_but_malformed\":\n",
      "utf8",
    );

    const corrupted = await readFile(service.store.eventsIndexPath(), "utf8");
    await expect(service.reconcile()).resolves.toMatchObject({
      skipped: expect.arrayContaining([first.run_id, second.run_id]),
      projection: {
        status: "failed",
        reason: expect.stringContaining("events.index.jsonl contains invalid JSON"),
      },
    });
    await expect(readFile(service.store.eventsIndexPath(), "utf8")).resolves.toBe(corrupted);
    const rootEntries = await readdir(runsRoot);
    expect(rootEntries.some((entry) => entry.startsWith("events.index.jsonl.corrupt."))).toBe(false);
    await expect(service.getRunRecord(first.run_id)).resolves.toMatchObject({ state: "succeeded" });
    await expect(service.getRunRecord(second.run_id)).resolves.toMatchObject({ state: "succeeded" });
  });

  test("detached exact replay fails closed when an owner-free execution has no receipt", async () => {
    const spawnWorker = vi.fn(async () => ({ pid: 44_445, supervisor: "direct" as const }));
    const service = new RunService({
      runsRoot,
      workerEntrypoint: "/tmp/calyx-worker",
    }, {
      ...buildDeps(),
      spawnWorker,
    });
    const intent = service.createIntent({
      run_id: "run-owner-free-missing-receipt-submit",
      host: "local",
      prompt: "Do not replay my ambiguous effect",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent, { launchMode: "detached" });
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "crashed-without-receipt",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    await expect(service.submitDetached(intent)).rejects.toThrow(
      "refusing ambiguous effect replay",
    );
    expect(spawnWorker).not.toHaveBeenCalled();
    await expect(service.getRunRecord(intent.run_id)).resolves.toMatchObject({
      state: "infra_error",
      recovery: { mode: "orchestrator_crash" },
    });
  });

  test("reconcile classifies missing receipt as orchestrator_crash when worker is gone", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      host: "local",
      prompt: "Crash me",
      require_execplan: false,
    });
    await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    await service.store.writeSpec(intent.run_id, spec);
    const record = await service.getRunRecord(intent.run_id);
    await service.store.writeRunRecord(intent.run_id, {
      ...record!,
      state: "running",
      spec,
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconcile = await service.reconcile();
    const rebuilt = await service.getRunRecord(intent.run_id);

    expect(reconcile.classified).toContain(intent.run_id);
    expect(rebuilt?.state).toBe("infra_error");
    expect(rebuilt?.recovery.mode).toBe("orchestrator_crash");
    expect(rebuilt?.infra_error_classification).toMatchObject({
      failure_layer: "runner_task",
      failure_reason: "unknown",
    });
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent);
    expect(terminalEvents.at(-1)?.run.infra_error_classification).toMatchObject({
      failure_layer: "runner_task",
      failure_reason: "unknown",
    });
  });

  test("reconcile rebuilds legacy message-only worktree infra_error receipts with a specific classification", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "legacy-worktree-receipt",
      host: "local",
      backend: "codex",
      prompt: "Legacy worktree receipt",
      require_execplan: false,
    });
    const queued = await service.initializeRun(intent);
    const spec = await resolveRunIntent(intent, { now: () => "2026-03-11T12:00:00.000Z" });
    const receipt = makeReceipt(intent.run_id, {
      run_id: intent.run_id,
      host: intent.host,
      backend: spec.backend,
      prompt: spec.prompt,
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    }, "infra_error", {
      summary: `Run ${intent.run_id} infra_error.`,
      exit: {
        exit_code: 6,
        error: "Worktree acquisition failed: worktree locked by run prior-run.",
      },
    });
    await service.store.writeSpec(intent.run_id, spec);
    await service.store.writeKernelReceipt(intent.run_id, receipt);
    await service.store.writeRunRecord(intent.run_id, {
      ...queued,
      state: "running",
      spec,
      launch: {
        ...queued.launch,
        stage: "executing",
        execution_id: "legacy-receipt-without-classification",
        execution_started_at: "2026-03-11T12:00:01.000Z",
      },
      updated_at: "2026-03-11T12:00:01.000Z",
    });

    const reconcile = await service.reconcile();
    const rebuilt = await service.getRunRecord(intent.run_id);

    expect(reconcile.rebuilt).toContain(intent.run_id);
    expect(rebuilt?.state).toBe("infra_error");
    expect(rebuilt?.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
    expect(rebuilt?.infra_error_classification?.message).toContain("worktree locked by run");
    const terminalEvents = (await collectIndexedEvents(service, intent.run_id)).filter(isCalyxRunEvent);
    expect(terminalEvents.at(-1)?.run.infra_error_classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
    const secondReconcile = await service.reconcile();
    expect(secondReconcile.rebuilt).not.toContain(intent.run_id);
    expect(secondReconcile.skipped).toContain(intent.run_id);
  });

  test("resume launches honor the prior session worktree and keep sessions isolated", async () => {
    const executedSpecs: RunSpec[] = [];
    const service = new RunService({ runsRoot }, buildResumeAwareDeps(executedSpecs));
    const sessionAWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-sessionA-"));
    const sessionBWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-sessionB-"));

    await service.store.writeRunRecord("prior-run-A", makeStoredResumeRecord({
      runId: "prior-run-A",
      sessionId: "sess-A",
      worktreePath: sessionAWorktree,
      updatedAt: "2026-04-15T11:58:00.000Z",
    }));
    await service.store.writeRunRecord("prior-run-B", makeStoredResumeRecord({
      runId: "prior-run-B",
      sessionId: "sess-B",
      worktreePath: sessionBWorktree,
      updatedAt: "2026-04-15T11:59:00.000Z",
    }));

    const resultA = await service.launch(service.createIntent({
      run_id: "resume-run-A",
      host: "local",
      backend: "codex",
      prompt: "Resume A",
      require_execplan: false,
      resume_session_id: "sess-A",
    }), { detached: false });

    const resultB = await service.launch(service.createIntent({
      run_id: "resume-run-B",
      host: "local",
      backend: "codex",
      prompt: "Resume B",
      require_execplan: false,
      resume_session_id: "sess-B",
    }), { detached: false });

    expect(executedSpecs[0]?.worktree.path).toBe(sessionAWorktree);
    expect(executedSpecs[1]?.worktree.path).toBe(sessionBWorktree);
    expect(executedSpecs[0]?.worktree.path).not.toBe(executedSpecs[1]?.worktree.path);
    expect(resultA.record.spec && "worktree" in resultA.record.spec && resultA.record.spec.worktree.path).toBe(sessionAWorktree);
    expect(resultB.record.spec && "worktree" in resultB.record.spec && resultB.record.spec.worktree.path).toBe(sessionBWorktree);
  });

  test("resume without a prior run spec adopts the latest interactive activity cwd with provenance", async () => {
    const executedSpecs: RunSpec[] = [];
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-resume-interactive-home-"));
    const olderWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-interactive-old-"));
    const latestWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-interactive-latest-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildResumeAwareDeps(executedSpecs));

    await writeCodexInteractiveSession({
      home: interactiveHome,
      sessionId: "sess-interactive",
      cwd: olderWorktree,
      timestamp: "2026-04-15T11:50:00.000Z",
      fileStamp: "2026-04-15T11-50-00",
      mtime: new Date("2026-04-15T11:50:00.000Z"),
    });
    await writeCodexInteractiveSession({
      home: interactiveHome,
      sessionId: "sess-interactive",
      cwd: latestWorktree,
      timestamp: "2026-04-15T11:59:00.000Z",
      fileStamp: "2026-04-15T11-59-00",
      mtime: new Date("2026-04-15T11:59:00.000Z"),
    });

    const result = await service.launch(service.createIntent({
      run_id: "resume-interactive",
      host: "blade",
      backend: "codex",
      prompt: "Resume interactive",
      require_execplan: false,
      resume_session_id: "sess-interactive",
    }), { detached: false });

    expect(executedSpecs).toHaveLength(1);
    expect(executedSpecs[0]?.worktree.path).toBe(latestWorktree);
    expect(result.record.intent.worktree_path).toBe(latestWorktree);
    expect(result.record.intent.worktree_source).toBe("activity_inventory_cwd");
    expect(result.record.spec && "worktree" in result.record.spec && result.record.spec.worktree.path).toBe(latestWorktree);
    expect(result.record.spec && "worktree" in result.record.spec && result.record.spec.worktree_source).toBe("activity_inventory_cwd");
  });

  test("exact resume replay uses the stored normalized intent after discovery evidence disappears", async () => {
    const executedSpecs: RunSpec[] = [];
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-resume-replay-home-"));
    const worktree = await mkdtemp(join(tmpdir(), "calyx-resume-replay-worktree-"));
    const service = new RunService(
      { runsRoot, interactiveHomeDir: interactiveHome },
      buildResumeAwareDeps(executedSpecs),
    );
    await writeCodexInteractiveSession({
      home: interactiveHome,
      sessionId: "sess-replay",
      cwd: worktree,
      timestamp: "2026-04-15T11:59:00.000Z",
    });
    const rawIntent = service.createIntent({
      run_id: "resume-exact-replay",
      host: "blade",
      backend: "codex",
      prompt: "Resume exactly once",
      require_execplan: false,
      resume_session_id: "sess-replay",
    });

    const first = await service.runInline(rawIntent);
    await rm(interactiveHome, { recursive: true, force: true });
    const replay = await service.runInline(rawIntent);

    expect(replay.record).toEqual(first.record);
    expect(executedSpecs).toHaveLength(1);
    expect(replay.record.intent).toMatchObject({
      worktree_path: worktree,
      worktree_source: "activity_inventory_cwd",
    });
    await expect(service.runInline({ ...rawIntent, prompt: "Changed raw request" }))
      .rejects.toBeInstanceOf(RunAlreadyExistsError);
  });

  test("resume launch fails loudly when no prior run is stored for the session", async () => {
    const executedSpecs: RunSpec[] = [];
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-resume-missing-home-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildResumeAwareDeps(executedSpecs));

    await expect(service.launch(service.createIntent({
      run_id: "resume-missing-session",
      host: "local",
      backend: "codex",
      prompt: "Resume missing",
      require_execplan: false,
      resume_session_id: "sess-missing",
    }), { detached: false })).rejects.toThrow(
      "Activity inventory was consulted for session sess-missing, but no matching interactive session with a cwd was found.",
    );
    expect(executedSpecs).toHaveLength(0);
    await expect(service.getRunRecord("resume-missing-session")).resolves.toBeUndefined();
  });

  test("resume with explicit worktree path takes precedence over an interactive activity cwd", async () => {
    const executedSpecs: RunSpec[] = [];
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-resume-explicit-home-"));
    const inventoryWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-explicit-inventory-"));
    const explicitWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-explicit-flag-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildResumeAwareDeps(executedSpecs));
    await writeCodexInteractiveSession({
      home: interactiveHome,
      sessionId: "sess-explicit",
      cwd: inventoryWorktree,
      timestamp: "2026-04-15T11:59:00.000Z",
    });

    const result = await service.launch(service.createIntent({
      run_id: "resume-explicit",
      host: "blade",
      backend: "codex",
      prompt: "Resume explicit",
      require_execplan: false,
      resume_session_id: "sess-explicit",
      worktree_path: explicitWorktree,
    }), { detached: false });

    expect(executedSpecs).toHaveLength(1);
    expect(executedSpecs[0]?.worktree.path).toBe(explicitWorktree);
    expect(result.record.intent.worktree_path).toBe(explicitWorktree);
    expect(result.record.intent.worktree_source).toBe("explicit_flag");
    expect(result.record.spec && "worktree" in result.record.spec && result.record.spec.worktree_source).toBe("explicit_flag");
  });

  test("resume adopts an interactive cwd that is a valid non-git directory", async () => {
    const executedSpecs: RunSpec[] = [];
    const interactiveHome = await mkdtemp(join(tmpdir(), "calyx-resume-nongit-home-"));
    const nonGitDirectory = await mkdtemp(join(tmpdir(), "calyx-resume-nongit-cwd-"));
    const service = new RunService({ runsRoot, interactiveHomeDir: interactiveHome }, buildResumeAwareDeps(executedSpecs));
    await writeCodexInteractiveSession({
      home: interactiveHome,
      sessionId: "sess-nongit",
      cwd: nonGitDirectory,
      timestamp: "2026-04-15T11:59:00.000Z",
    });

    const result = await service.launch(service.createIntent({
      run_id: "resume-nongit",
      host: "blade",
      backend: "codex",
      prompt: "Resume non-git",
      require_execplan: false,
      resume_session_id: "sess-nongit",
    }), { detached: false });

    expect(executedSpecs).toHaveLength(1);
    expect(executedSpecs[0]?.worktree.path).toBe(nonGitDirectory);
    await expect(stat(join(nonGitDirectory, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.record.intent.worktree_source).toBe("activity_inventory_cwd");
  });

  test("resume launch errors when the prior session worktree no longer exists", async () => {
    const executedSpecs: RunSpec[] = [];
    const service = new RunService({ runsRoot }, buildResumeAwareDeps(executedSpecs));
    const deletedWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-deleted-"));
    await rm(deletedWorktree, { recursive: true, force: true });

    await service.store.writeRunRecord("prior-deleted-worktree", makeStoredResumeRecord({
      runId: "prior-deleted-worktree",
      sessionId: "sess-gone",
      worktreePath: deletedWorktree,
      updatedAt: "2026-04-15T11:57:00.000Z",
    }));

    await expect(service.launch(service.createIntent({
      run_id: "resume-missing-worktree",
      host: "local",
      backend: "codex",
      prompt: "Resume missing worktree",
      require_execplan: false,
      resume_session_id: "sess-gone",
    }), { detached: false })).rejects.toThrow(
      `Error: session's prior working directory at ${deletedWorktree} no longer exists; pass --worktree-path to resume in a different directory.`,
    );
    expect(executedSpecs).toHaveLength(0);
  });

  test("completed spawn-backed Claude runs persist terminal session identity for recovery", async () => {
    const claudeSessionId = "11111111-1111-4111-8111-111111111111";
    const claudeSessionPath = `/tmp/${claudeSessionId}.jsonl`;
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new AgentRunnerKernel({
          runtimeAdapterRegistry: {
            register: () => {},
            create: () => ({
              name: "mock",
              capabilities: {
                streaming: true,
                turnControl: true,
                resumeSession: true,
                forkSession: false,
                approvals: "none",
              },
              async stop(): Promise<void> {},
            }),
            has: () => true,
            list: () => ["mock"],
          },
          executeRun: async (rawSpec: unknown): Promise<RunResult> => {
            const spec = rawSpec as RunSpec;
            const receipt = makeReceipt(spec.run_id ?? "unknown", spec, "succeeded", {
              backend_session: {
                id: claudeSessionId,
                path: claudeSessionPath,
                backend: spec.backend,
              },
              terminal_evidence: {
                schema_version: "calyx.agent-terminal-evidence/v1",
                source: "claude_stream",
                status: "authoritative",
                reason: "completed",
                backend_subtype: "success",
                session_id: "sess-123",
                signal: "SIGTERM",
                num_turns: 2,
                usage: { input_tokens: 120, output_tokens: 30 },
              },
              agent_terminal_message: "Safe final message.",
              metadata: {
                session_summary: {
                  adapter_session_id: "adapter-session-1",
                  turns_total: 2,
                  terminal_turn_index: 2,
                  stop_reason: "continuation_declined",
                  turns: [
                    { turn_index: 1, adapter_turn_id: "adapter-turn-1", backend_turn_id: "backend-turn-1" },
                    { turn_index: 2, adapter_turn_id: "adapter-turn-2", backend_turn_id: "backend-turn-2" },
                  ],
                },
              },
            });
            return { receipt, events: [], dispatch_accepted: true };
          },
        }),
        hostname: () => "blade",
        now: () => "2026-03-11T12:00:00.000Z",
      },
    );

    const intent = service.createIntent({
      host: "local",
      prompt: "Resume-capable run",
      require_execplan: false,
      backend: "claude",
      worktree_path: runsRoot,
      resume_session_id: "sess-previous",
    });

    const result = await service.launch(intent, { detached: false });

    const persistedBackendSession = result.record.kernel_receipt
      && "backend_session" in result.record.kernel_receipt
      ? result.record.kernel_receipt.backend_session
      : undefined;
    expect(persistedBackendSession).toEqual({
      id: claudeSessionId,
      path: claudeSessionPath,
      backend: "claude",
    });
    expect(result.record.recovery.resumable).toBe(true);
    expect(result.record.recovery.checkpoint?.strategy).toBe("native_session");
    expect(result.record.recovery.checkpoint?.backend_session_id).toBe(claudeSessionId);
    expect(result.record.recovery.checkpoint?.backend_session_path).toBe(claudeSessionPath);
    expect(result.record.recovery.checkpoint?.adapter_session_id).toBe("adapter-session-1");
    expect(result.record.recovery.checkpoint?.current_turn_id).toBe("adapter-turn-2");
    expect(result.record.recovery.checkpoint?.backend_thread_id).toBe("backend-turn-2");
    expect(result.record.kernel_receipt && "terminal_evidence" in result.record.kernel_receipt
      ? result.record.kernel_receipt.terminal_evidence
      : undefined).toMatchObject({
      source: "claude_stream",
      reason: "completed",
      num_turns: 2,
    });
    const listEntry = (await service.listRuns()).find((entry) => entry.run_id === intent.run_id);
    expect(listEntry?.terminal).toEqual({
      evidence: expect.objectContaining({
        source: "claude_stream",
        reason: "completed",
        signal: "SIGTERM",
        num_turns: 2,
        usage: { input_tokens: 120, output_tokens: 30 },
      }),
    });
    expect(JSON.stringify(listEntry)).not.toContain("Safe final message.");
    const terminalEvent = (await service.store.readEvents(intent.run_id)).find(isRunTerminalEvent);
    expect(terminalEvent?.summary.terminal_evidence).toMatchObject({
      source: "claude_stream",
      reason: "completed",
      signal: "SIGTERM",
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    expect(terminalEvent?.summary.agent_terminal_message).toBe("Safe final message.");
  });

  test("failed Claude process authority is consistent across record, list, and terminal event", async () => {
    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new AgentRunnerKernel({
          runtimeAdapterRegistry: {
            register: () => {},
            create: () => ({
              name: "mock",
              capabilities: {
                streaming: true,
                turnControl: false,
                resumeSession: true,
                forkSession: false,
                approvals: "none",
              },
              async stop(): Promise<void> {},
            }),
            has: () => true,
            list: () => ["mock"],
          },
          executeRun: async (rawSpec: unknown): Promise<RunResult> => {
            const spec = rawSpec as RunSpec;
            const receipt = makeReceipt(spec.run_id ?? "unknown", spec, "failed", {
              exit: { exit_code: 1 },
              terminal_evidence: {
                schema_version: "calyx.agent-terminal-evidence/v1",
                source: "process_exit",
                status: "authoritative",
                reason: "abnormal_exit",
                backend_subtype: "success",
                exit_code: 1,
                usage: { input_tokens: 12, output_tokens: 3 },
              },
              agent_terminal_message: "Safe final message retained.",
            });
            return { receipt, events: [], dispatch_accepted: true };
          },
        }),
        hostname: () => "blade",
        now: () => "2026-07-17T15:00:00.000Z",
      },
    );
    const intent = service.createIntent({
      host: "local",
      prompt: "Contradictory structured success",
      require_execplan: false,
      backend: "claude",
      worktree_path: runsRoot,
    });

    const result = await service.launch(intent, { detached: false });
    const listEntry = (await service.listRuns()).find((entry) => entry.run_id === intent.run_id);
    const terminalEvent = (await service.store.readEvents(intent.run_id)).find(isRunTerminalEvent);

    expect(result.record.state).toBe("failed");
    expect(result.record.summary).toContain(`Run ${intent.run_id} failed`);
    expect(result.record.summary).not.toContain("completed");
    expect(result.record.kernel_receipt && "terminal_evidence" in result.record.kernel_receipt
      ? result.record.kernel_receipt.terminal_evidence
      : undefined).toMatchObject({
      source: "process_exit",
      status: "authoritative",
      reason: "abnormal_exit",
      exit_code: 1,
    });
    expect(listEntry?.terminal).toMatchObject({
      evidence: {
        source: "process_exit",
        status: "authoritative",
        reason: "abnormal_exit",
        exit_code: 1,
      },
    });
    expect(JSON.stringify(listEntry)).not.toContain("Safe final message retained.");
    expect(terminalEvent?.summary).toMatchObject({
      terminal_evidence: {
        source: "process_exit",
        status: "authoritative",
        reason: "abnormal_exit",
        exit_code: 1,
      },
      agent_terminal_message: "Safe final message retained.",
    });
  });

  test("active Claude records capture id-only stream checkpoints before receipts", async () => {
    let checkpointObserved!: () => void;
    const checkpointSeen = new Promise<void>((resolve) => {
      checkpointObserved = resolve;
    });
    let finishRun!: () => void;
    const finishSignal = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = new RunService(
      { runsRoot },
      {
        resolveExecutionKernel: () => new AgentRunnerKernel({
          runtimeAdapterRegistry: {
            register: () => {},
            create: () => ({
              name: "claude",
              capabilities: {
                streaming: true,
                turnControl: true,
                resumeSession: true,
                forkSession: false,
                approvals: "none",
              },
              async stop(): Promise<void> {},
            }),
            has: () => true,
            list: () => ["mock"],
          },
          executeRun: async (rawSpec: unknown, deps: RunDeps): Promise<RunResult> => {
            const spec = rawSpec as RunSpec;
            const runId = spec.run_id ?? "unknown";
            deps.onEvent?.({
              timestamp: "2026-03-11T12:00:00.000Z",
              run_id: runId,
              event: "state_transition",
              from: "queued",
              to: "dispatching",
              message: "Evaluating dispatch gate",
            });
            deps.onEvent?.({
              timestamp: "2026-03-11T12:00:00.100Z",
              run_id: runId,
              event: "state_transition",
              from: "dispatching",
              to: "running",
              message: "Backend claude starting",
            });
            deps.onSessionCheckpoint?.({
              adapter_session_id: "adapter-session-live",
              backend_session: {
                id: "sess-live",
                backend: "claude",
              },
              timestamp: "2026-03-11T12:00:00.200Z",
            });
            checkpointObserved();
            await finishSignal;
            const receipt = makeReceipt(runId, spec, "succeeded", {
              backend_session: {
                id: "sess-live",
                backend: "claude",
              },
              metadata: {
                session_summary: {
                  adapter_session_id: "adapter-session-live",
                  turns_total: 1,
                  terminal_turn_index: 1,
                  stop_reason: "natural_stop",
                  turns: [
                    { turn_index: 1, adapter_turn_id: "adapter-turn-live", backend_turn_id: "backend-turn-live" },
                  ],
                },
              },
            });
            return { receipt, events: [], dispatch_accepted: true };
          },
        }),
        hostname: () => "blade",
        now: () => "2026-03-11T12:00:00.000Z",
      },
    );

    const intent = service.createIntent({
      host: "local",
      prompt: "Active checkpoint run",
      require_execplan: false,
      backend: "claude",
      worktree_path: runsRoot,
    });

    const launchPromise = service.launch(intent, { detached: false });
    await checkpointSeen;

    await vi.waitFor(async () => {
      const activeRecord = await service.getRunRecord(intent.run_id);
      expect(activeRecord?.state).toBe("running");
      expect(activeRecord?.kernel_receipt).toBeUndefined();
      expect(activeRecord?.recovery.resumable).toBe(true);
      expect(activeRecord?.recovery.checkpoint).toMatchObject({
        adapter_session_id: "adapter-session-live",
        backend_session_id: "sess-live",
        last_event_at: "2026-03-11T12:00:00.200Z",
        strategy: "native_session",
      });
    });

    finishRun();
    const result = await launchPromise;
    expect(result.record.state).toBe("succeeded");
    expect(result.record.recovery.checkpoint?.backend_session_id).toBe("sess-live");
    expect(result.record.recovery.checkpoint?.backend_session_path).toBeUndefined();
  });

  test("exact launch replay returns the existing authoritative result", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-dup-1",
      host: "local",
      prompt: "First launch",
      require_execplan: false,
    });

    await service.launch(intent, { detached: false });

    const replay = await service.launch(intent, { detached: false });
    expect(replay.record.state).toBe("succeeded");
    expect(replay.record.intent).toEqual({
      ...intent,
      created_at: replay.record.kernel_receipt?.timing.created_at,
    });
  });

  test("listRuns applies limit after recent run ordering", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const persistRun = async (runId: string, updatedAt: string): Promise<void> => {
      const record = await service.initializeRun(service.createIntent({
        run_id: runId,
        host: "local",
        prompt: `Prompt for ${runId}`,
        require_execplan: false,
      }));
      await service.store.writeRunRecord(record.run_id, {
        ...record,
        created_at: updatedAt,
        updated_at: updatedAt,
        summary: `Run ${runId} queued.`,
      });
    };

    await persistRun("run-a-old", "2026-05-09T12:01:00.000Z");
    await persistRun("run-z-new", "2026-05-09T12:03:00.000Z");
    await persistRun("run-m-middle", "2026-05-09T12:02:00.000Z");

    const entries = await service.listRuns({ limit: 2 });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.run_id)).toEqual(["run-z-new", "run-m-middle"]);
  });

  test("listActivity applies limit to the combined run and interactive activity view", async () => {
    const home = join(runsRoot, "home");
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "rollout-2026-04-28T12-00-00-019dcafe-1111-7222-8333-abcabcabcabc.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-04-28T12:00:01.000Z",
          type: "session_meta",
          payload: {
            id: "019dcafe-1111-7222-8333-abcabcabcabc",
            timestamp: "2026-04-28T12:00:00.000Z",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-28T12:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Review the activity surface" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const service = new RunService({ runsRoot, interactiveHomeDir: home }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-activity-limit-1",
      host: "local",
      prompt: "Managed run",
      require_execplan: false,
    });
    await service.launch(intent, { detached: false });

    const entries = await service.listActivity({
      includeInteractive: true,
      limit: 1,
      sinceMs: 0,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.entry_kind).toBe("interactive_session");
  });

  test("listActivitySnapshotPage preserves an equal-key interactive row after its managed run", async () => withRunIndexProjection(async (runIndex) => {
    const home = join(runsRoot, "equal-public-activity-key-home");
    const codexDir = join(home, ".codex", "sessions", "2026", "04", "28");
    const sessionId = "019dcafe-1111-7222-8333-equalkey00001";
    const createdAt = "2026-04-28T12:00:00.000Z";
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, `rollout-2026-04-28T12-00-00-${sessionId}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, timestamp: createdAt },
      }),
      "utf8",
    );
    const service = new RunService({ runsRoot, interactiveHomeDir: home, runIndex }, buildDeps());
    const runId = `interactive:codex:${sessionId}`;
    const record = await service.initializeRun(service.createIntent({
      run_id: runId,
      host: "local",
      backend: "codex",
      prompt: "Managed run colliding with an interactive public identity",
      require_execplan: false,
    }));
    await service.store.writeRunRecord(runId, {
      ...record,
      created_at: createdAt,
      updated_at: createdAt,
    });

    const first = await service.listActivitySnapshotPage({
      includeInteractive: true,
      observationHost: "local",
      createdBefore: "2026-04-29T00:00:00.000Z",
      limit: 1,
    });
    expect(first.entries).toEqual([
      expect.objectContaining({
        entry_kind: "calyx_run",
        run_id: runId,
        created_at: createdAt,
      }),
    ]);

    const second = await service.listActivitySnapshotPage({
      includeInteractive: true,
      observationHost: "local",
      createdBefore: "2026-04-29T00:00:00.000Z",
      after: {
        created_at: createdAt,
        run_id: runId,
        entry_kind: "calyx_run",
      },
      expectedMembershipFence: first.membershipFence,
      limit: 1,
    });
    expect(second.entries).toEqual([
      expect.objectContaining({
        entry_kind: "interactive_session",
        run_id: runId,
        created_at: createdAt,
      }),
    ]);
  }));

  test("listActivity projects each managed run once and applies agent-kind filters to every source", async () => withRunIndexProjection(async (runIndex) => {
    const home = join(runsRoot, "managed-run-activity-home");
    const service = new RunService({ runsRoot, interactiveHomeDir: home, runIndex }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-activity-canonical-once",
      host: "local",
      backend: "codex",
      prompt: "One canonical activity row",
      require_execplan: false,
    });
    await service.launch(intent, { detached: false });

    const entries = await service.listActivity({ includeInteractive: true });
    const page = await service.listActivityPage({
      includeInteractive: true,
      limit: 10,
    });
    const beforeCreation = await service.listActivityPage({
      includeInteractive: true,
      createdBefore: "1970-01-01T00:00:00.000Z",
      limit: 10,
    });
    const wrongBackend = await service.listActivity({
      includeInteractive: true,
      agentKind: "claude",
    });

    expect(entries.filter((entry) => entry.run_id === intent.run_id)).toEqual([
      expect.objectContaining({ entry_kind: "calyx_run", backend: "codex" }),
    ]);
    expect(page.filter((entry) => entry.run_id === intent.run_id)).toEqual([
      expect.objectContaining({ entry_kind: "calyx_run", backend: "codex" }),
    ]);
    expect(beforeCreation).toEqual([]);
    expect(entries.filter((entry) => (
      entry.entry_kind === "interactive_session" && entry.source === "calyx_runs"
    ))).toEqual([]);
    expect(page.filter((entry) => (
      entry.entry_kind === "interactive_session" && entry.source === "calyx_runs"
    ))).toEqual([]);
    expect(wrongBackend.find((entry) => entry.run_id === intent.run_id)).toBeUndefined();
  }));

  test("stop retries preserve the first durable cancellation request", async () => {
    const service = new RunService({ runsRoot }, buildDeps());
    const intent = service.createIntent({
      run_id: "run-stop-1",
      host: "local",
      prompt: "Stop me",
      require_execplan: false,
    });
    await service.initializeRun(intent);

    await expect(service.stop(intent.run_id, { reason: "first reason" }))
      .resolves.toMatchObject({ status: "cancellation_requested", run_id: intent.run_id });
    await expect(service.stop(intent.run_id, { reason: "retry reason" }))
      .resolves.toMatchObject({ status: "cancellation_requested", run_id: intent.run_id });
    await expect(service.store.readCancellation(intent.run_id)).resolves.toMatchObject({
      schema_version: "calyx.run-cancellation/v1",
      run_id: intent.run_id,
      reason: "first reason",
    });
    await expect(stat(join(service.store.paths(intent.run_id).runDir, "pid")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
