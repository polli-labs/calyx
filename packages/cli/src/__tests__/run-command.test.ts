import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  CALYX_DAEMON_FEATURES,
  CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
  CALYX_HTTP_SSE_MAX_FRAME_BYTES,
} from "@polli-labs/calyx-core";
import type { FleetTopologyTargetsV1 } from "@polli-labs/calyx-core";
import type {
  ExecuteStoredRunOptions,
  RecordedRunEvent,
  RunActivityEntry,
  InteractiveSessionInspectResult,
  RunIntent,
  RunLaunchResult,
  RunListEntry,
  RunLogResult,
  RunObservationResult,
  RunCancellationResult,
  InfraErrorCensusAuthorityAudit,
  ReconcileResult,
  RunRecord,
} from "@polli-labs/calyx-run-service";
import { HOST_PROCESS_RECEIPT_SCHEMA_VERSION, resolveRunIntent } from "@polli-labs/calyx-run-service";
import { runSpecSchema } from "@polli-labs/calyx-runner";
import {
  buildProgram,
  isRunReconciliationIncomplete,
  type RunCliDependencies,
} from "../run-cli";
import { openClientRecoveryCustody } from "../client-recovery-custody.js";
import {
  TEST_TOPOLOGY_PROJECTION_SHA256,
  passingTestWorkloadAdmissionDecision,
} from "./support/test-run-service.js";

const GENERATED_ERROR_BODY_MAX_BYTES = 1024 * 1024;

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

function typedNotFoundResponse(message: string): Response {
  return new Response(JSON.stringify({
    error: {
      schema_version: "calyx.error/v1",
      code: "not_found",
      message,
    },
  }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function makeRecord(args: {
  state: RunRecord["state"];
  runId?: string;
  exitCode?: number;
  spawnError?: string;
  issue?: string;
  host?: string;
  backend?: "claude" | "codex";
  worktreePath?: string;
  worktreeSource?: "run_spec" | "explicit_flag" | "activity_inventory_cwd";
  branch?: string;
  artifactNames?: string[];
  artifactRoots?: string[];
}): RunRecord {
  const runId = args.runId ?? "run-pol-825";
  const now = new Date().toISOString();
  const host = args.host ?? "local";
  const backend = args.backend ?? "claude";
  return {
    schema_version: "1.0",
    run_id: runId,
    state: args.state,
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "a".repeat(64),
      request_hash: "b".repeat(64),
      accepted_at: now,
      dispatch_attempts: 0,
      execution_id: `exec-${runId}`,
      execution_started_at: now,
    },
    intent: {
      run_id: runId,
      kernel: "agent_runner",
      host,
      backend,
      ...(args.issue ? { issue: args.issue } : {}),
      ...(args.worktreePath ? { worktree_path: args.worktreePath } : {}),
      ...(args.worktreeSource ? { worktree_source: args.worktreeSource } : {}),
      ...(args.artifactRoots ? { artifact_roots: args.artifactRoots } : {}),
      ...(args.branch ? { branch: args.branch } : {}),
      created_at: now,
    },
    spec: {
      run_id: runId,
      kernel: "agent_runner",
      host,
      backend,
      prompt: "Test prompt",
      require_execplan: false,
      worktree: {
        ...(args.worktreePath ? { path: args.worktreePath } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
      },
      ...(args.worktreeSource ? { worktree_source: args.worktreeSource } : {}),
      required_artifacts: [],
      artifact_roots: args.artifactRoots ?? [],
      resolved_at: now,
      resolution_log: [],
    },
    kernel_receipt: {
      schema_version: "1.0",
      run_id: runId,
      state: args.state,
      run_spec: {
        run_id: runId,
        host,
        backend,
        prompt: "Test prompt",
        require_execplan: false,
        pull_execplan: false,
        worktree: {
          ...(args.worktreePath ? { path: args.worktreePath } : {}),
          ...(args.branch ? { branch: args.branch } : {}),
        },
        ...(args.artifactRoots ? { artifact_roots: args.artifactRoots } : {}),
      },
      timing: {
        created_at: now,
        completed_at: now,
      },
      exit: {
        ...(typeof args.exitCode === "number" ? { exit_code: args.exitCode } : {}),
      },
      artifacts: {
        run_id: runId,
        finalized_at: now,
        required: [],
        discovered: (args.artifactNames ?? []).map((name) => ({
          name,
          location: "worktree" as const,
          path: args.worktreePath ? `${args.worktreePath}/${name}` : `/tmp/${name}`,
          required: false,
          detected_at: now,
        })),
        gate_passed: true,
        missing: [],
      },
      log_summary: {
        total: 0,
        info: 0,
        warn: 0,
        error: 0,
      },
      environment: {
        host,
        backend,
        ...(args.worktreePath ? { worktree_path: args.worktreePath } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
      },
      summary: `Run ${runId} ${args.state}`,
      ...(args.spawnError ? { spawn_error: args.spawnError } : {}),
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: { mode: "normal", resumable: false },
    summary: `Run ${runId} ${args.state}.`,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}

function makeAdminWireRecord(record: RunRecord): Omit<RunRecord, "schema_version"> & {
  schema_version: "calyx.run-record/v1";
} {
  return { ...record, schema_version: "calyx.run-record/v1" };
}

function makeTerminalStreamEvent(record: RunRecord, cursor = "z1-00000000000000000001") {
  return {
    schema_version: "1.0",
    event_id: `terminal-${record.run_id}`,
    cursor,
    emitted_at: "2026-07-15T00:00:00.000Z",
    event_type: "run.terminal",
    emitted_by: "worker",
    run: {
      run_id: record.run_id,
      state: record.state,
      kernel: record.spec?.kernel ?? record.intent.kernel ?? "agent_runner",
      host: record.spec?.host ?? record.intent.host,
      created_at: record.created_at,
      recovery_mode: record.recovery.mode,
    },
    origin: { launcher_kind: "cli" },
    pointers: {
      run_dir: `/tmp/${record.run_id}`,
      run_record_path: `/tmp/${record.run_id}/run_record.json`,
      events_path: `/tmp/${record.run_id}/events.jsonl`,
    },
    summary: { one_line: record.summary },
  };
}

function makeHostProcessRecord(args: {
  state: RunRecord["state"];
  runId?: string;
  exitCode?: number;
}): RunRecord {
  const runId = args.runId ?? "run-pol-842";
  const now = new Date().toISOString();
  const executionBinding = {
    schema_version: "calyx.host-process-execution-binding/v1" as const,
    execution_id: `exec-${runId}`,
    salt: "s".repeat(43),
    commitment_sha256: "c".repeat(64),
  };
  return {
    schema_version: "1.0",
    run_id: runId,
    state: args.state,
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "a".repeat(64),
      request_hash: "b".repeat(64),
      accepted_at: now,
      dispatch_attempts: 0,
      execution_id: `exec-${runId}`,
      execution_started_at: now,
      host_process_execution_binding: executionBinding,
    },
    intent: {
      run_id: runId,
      kernel: "host_process",
      host: "local",
      host_process: {
        argv: ["python", "-m", "http.server"],
        cwd: "/tmp/service",
        stop_grace_ms: 5000,
      },
      created_at: now,
    },
    spec: {
      run_id: runId,
      kernel: "host_process",
      host: "local",
      required_artifacts: [],
      resolved_at: now,
      resolution_log: [],
      process: {
        argv: ["python", "-m", "http.server"],
        cwd: "/tmp/service",
        stop_grace_ms: 5000,
      },
    },
    kernel_receipt: {
      schema_version: HOST_PROCESS_RECEIPT_SCHEMA_VERSION,
      kernel: "host_process",
      run_id: runId,
      execution_binding: executionBinding,
      state: args.state,
      timing: {
        created_at: now,
        completed_at: now,
      },
      exit: {
        ...(typeof args.exitCode === "number" ? { exit_code: args.exitCode } : {}),
      },
      log_summary: {
        total: 0,
        info: 0,
        warn: 0,
        error: 0,
      },
      process: {
        argv: ["python", "-m", "http.server"],
        cwd: "/tmp/service",
        env_keys: [],
        pid: 4242,
        stdout_path: "/tmp/service/stdout.log",
        stderr_path: "/tmp/service/stderr.log",
        stop_grace_ms: 5000,
        stop_requested: false,
      },
      summary: `Host process ${runId} ${args.state}`,
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: { mode: "normal", resumable: false },
    summary: `Run ${runId} ${args.state}.`,
    created_at: now,
    updated_at: now,
    completed_at: now,
  };
}

function makeLaunchResult(record: RunRecord, mode: RunLaunchResult["mode"]): RunLaunchResult {
  return {
    run_id: record.run_id,
    state: record.state,
    mode,
    run_dir: `/tmp/${record.run_id}`,
    record,
  };
}

function makePortableLaunchReceipt(runId: string) {
  return {
    schema_version: "calyx.run-launch-result/v1",
    status: "accepted",
    run_id: runId,
    operation: {
      route: `/v1/admin/runs/${runId}`,
      events_route: `/v1/admin/runs/${runId}/events`,
      receipt_route: `/v1/admin/runs/${runId}/receipt`,
    },
  } as const;
}

function makeHealthPayload(overrides?: Record<string, unknown>) {
  return {
    schema_version: "calyx.admin-health/v1",
    protocol_epoch: CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
    daemon_kind: "run-service",
    daemon_id: "run-serve",
    uptime_ms: 10_000,
    started_at: "2026-04-20T00:00:00.000Z",
    build: {
      git_head: "945bcf3abcdef1234567890",
      built_at: "2026-04-18T00:00:00.000Z",
      package_version: "0.2.0",
    },
    active_runs: 0,
    workload_admission: passingTestWorkloadAdmissionDecision("blade"),
    maintenance_mode: false,
    supports_features: [
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.vaultExecplanRefV1,
      CALYX_DAEMON_FEATURES.repoRegistryV1,
      CALYX_DAEMON_FEATURES.systemPromptV1,
      CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
      CALYX_DAEMON_FEATURES.workloadAdmissionV1,
    ],
    ...overrides,
  };
}

function makeRunLaunchTopologyTargets(): FleetTopologyTargetsV1 {
  const target = {
    host: "blade",
    owner: "caleb",
    desired_membership: "active" as const,
    roles: ["gpu"],
    expected_surface_profile: "full",
    expected_surfaces: [
      "topology", "reachability", "toolchain", "clone", "promoted", "running",
      "daemon", "state_schema", "config", "skills", "hot_instruction",
    ] as const,
    run_serve_url: "http://blade:8740",
    catch_up_policy: "required_before_start" as const,
  };
  return {
    schema_version: "fleet-topology-targets/v1",
    intent: "mutating",
    snapshot: {
      schema_version: "fleet-topology-snapshot/v1",
      source: {
        repository: "polli-labs/agents-infra",
        root: "/tmp/agents-infra",
        path: "/tmp/agents-infra/fleet/truths/hosts.yaml",
        ref: "refs/remotes/origin/main",
        commit: "b".repeat(40),
        dirty: false,
      },
      projection_sha256: TEST_TOPOLOGY_PROJECTION_SHA256,
      resolved_at: "2026-08-02T12:00:00.000Z",
      resolver: "@polli-labs/calyx-core/fleet-topology-resolver@v1",
    },
    authority: { status: "authoritative", reasons: [], label: "origin/main" },
    can_emit_green_verdict: true,
    desired_active: [{ ...target, expected_surfaces: [...target.expected_surfaces] }],
    withdrawn: [],
    all_enrolled: [{ ...target, expected_surfaces: [...target.expected_surfaces] }],
  };
}

function makeRunLogResult(runId: string, events: RecordedRunEvent[] = []): RunLogResult {
  return {
    schema_version: "run-logs/v1",
    run_id: runId,
    entries: events.map((event) => {
      const timestamp = "timestamp" in event && typeof event.timestamp === "string"
        ? event.timestamp
        : "emitted_at" in event && typeof event.emitted_at === "string"
          ? event.emitted_at
          : undefined;
      const eventName = "event" in event && typeof event.event === "string"
        ? event.event
        : "event_type" in event && typeof event.event_type === "string"
          ? event.event_type
          : undefined;
      return {
        kind: "event" as const,
        source: "lifecycle" as const,
        text: "message" in event && typeof event.message === "string" && event.message.length > 0
          ? event.message
          : eventName ?? "run event",
        timestamp_source: "event" as const,
        ...(timestamp ? { timestamp } : {}),
        ...(eventName ? { event: eventName } : {}),
      };
    }),
    sources: [],
    options: {
      stream_tail: 40,
      max_stream_bytes: 1024 * 1024,
      stream_tail_defaulted: true,
    },
    warnings: [],
  };
}

function makeRunObservationResult(record: RunRecord): RunObservationResult {
  return {
    schema_version: "run-observation/v1",
    run_id: record.run_id,
    checked_at: "2026-05-19T12:00:00.000Z",
    run: {
      state: record.state,
      summary: record.summary,
      host: record.intent.host,
      ...(record.intent.issue ? { issue: record.intent.issue } : {}),
      ...(record.intent.backend ? { backend: record.intent.backend } : {}),
      ...(record.intent.kernel ? { kernel: record.intent.kernel } : {}),
      updated_at: record.updated_at,
      ...(record.health ? { health: record.health } : {}),
    },
    paths: {
      run_dir: `/tmp/${record.run_id}`,
      ...(record.intent.worktree_path ? { worktree_path: record.intent.worktree_path } : {}),
    },
    process: {
      status: "not_recorded",
      checked_at: "2026-05-19T12:00:00.000Z",
    },
    resource_attribution: {
      schema_version: "run-resource-attribution/v1",
      checked_at: "2026-05-19T12:00:00.000Z",
      root_pid: 4242,
      status: "attributed",
      process_tree: {
        provider: "ps",
        status: "attributed",
        checked_at: "2026-05-19T12:00:00.000Z",
        root_pid: 4242,
        process_count: 2,
        total_cpu_percent: 37.5,
        total_rss_kib: 192000,
        processes: [
          { pid: 4242, ppid: 1, cpu_percent: 12.5, rss_kib: 64000, command: "codex worker" },
          { pid: 4243, ppid: 4242, cpu_percent: 25, rss_kib: 128000, command: "python train.py" },
        ],
        truncated: false,
        max_processes: 32,
      },
      gpu_processes: {
        provider: "nvidia-smi",
        status: "attributed",
        checked_at: "2026-05-19T12:00:00.000Z",
        command: ["nvidia-smi"],
        host_process_count: 2,
        attributed_process_count: 1,
        attributed_memory_used_mib: 512,
        processes: [
          { pid: 4243, process_name: "python", gpu_uuid: "GPU-111", used_gpu_memory_mib: 512 },
        ],
      },
    },
    logs: {
      sources: [],
      warnings: [],
    },
    artifacts: [
      {
        name: "summary.md",
        location: "worktree",
        required: true,
        status: "missing",
        path: record.intent.worktree_path ? `${record.intent.worktree_path}/summary.md` : "/tmp/summary.md",
        exists: false,
      },
    ],
    artifact_roots: (record.intent.artifact_roots ?? []).map((root) => {
      const missing = root.includes("missing");
      return {
        name: root,
        path: record.intent.worktree_path ? `${record.intent.worktree_path}/${root}` : `/tmp/${root}`,
        status: missing ? "missing" as const : "present" as const,
        exists: !missing,
        ...(!missing
          ? {
              file_count: 2,
              directory_count: 1,
              total_size_bytes: 128,
              latest_modified_at: "2026-05-19T12:00:00.000Z",
            }
          : {}),
        truncated: false,
        max_entries: 500,
      };
    }),
    host_resources: {
      schema_version: "host-resources/v1",
      checked_at: "2026-05-19T12:00:00.000Z",
      gpu: {
        provider: "nvidia-smi",
        status: "available",
        checked_at: "2026-05-19T12:00:00.000Z",
        command: ["nvidia-smi"],
        gpus: [{
          index: 0,
          name: "NVIDIA Test",
          utilization_gpu_percent: 12,
          memory_used_mib: 1024,
          memory_total_mib: 24576,
        }],
      },
    },
    warnings: ["Missing required artifacts: summary.md."],
  };
}

async function createHostsTruthFixture(runServeUrls: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-hosts-truth-"));
  await mkdir(join(root, "fleet", "truths"), { recursive: true });
  const hostsYaml = [
    "hosts:",
    ...Object.entries(runServeUrls).flatMap(([host, url]) => [
      `  ${host}:`,
      `    home: /home/${host}`,
      `    run_serve_url: ${url}`,
    ]),
    "",
  ].join("\n");
  await writeFile(join(root, "fleet", "truths", "hosts.yaml"), hostsYaml, "utf8");
  return root;
}

function buildRunCliDeps(args?: {
  launchResult?: RunLaunchResult;
  createIntent?: (input: Partial<RunIntent> & Pick<RunIntent, "host">) => RunIntent;
  fetchSpy?: ReturnType<typeof vi.fn>;
  getRunRecord?: RunRecord | undefined;
  getRunRecordById?: (runId: string) => Promise<RunRecord | undefined>;
  getKernelReceipt?: RunRecord["kernel_receipt"] | undefined;
  readEvents?: RecordedRunEvent[];
  stop?: RunCancellationResult;
  auditTerminalAuthority?: () => Promise<InfraErrorCensusAuthorityAudit>;
  reconcile?: ReconcileResult;
  listRuns?: RunListEntry[];
  listActivity?: RunActivityEntry[];
  inspectInteractiveSession?: InteractiveSessionInspectResult;
  resolveResumeWorktreePath?: (
    sessionId: string,
    options?: { backend?: "claude" | "codex" | undefined },
  ) => Promise<{ path: string; source: NonNullable<RunIntent["worktree_source"]> }>;
  executeStoredRun?: (
    runId: string,
    options?: ExecuteStoredRunOptions,
  ) => Promise<RunRecord>;
  agentsInfraRoot?: string;
  currentHostAlias?: string;
  tokenForHost?: RunCliDependencies["tokenForHost"];
  openRecoveryCustody?: RunCliDependencies["openRecoveryCustody"];
  watchRunChanges?: RunCliDependencies["watchRunChanges"];
  resolveFleetTopology?: RunCliDependencies["resolveFleetTopology"];
}) {
  const launchSpy = vi.fn(async () => args?.launchResult ?? makeLaunchResult(makeRecord({ state: "queued" }), "background"));
  const resolveResumeWorktreePathSpy = vi.fn(
    args?.resolveResumeWorktreePath ?? (async () => ({ path: "/tmp/resolved-worktree", source: "run_spec" as const })),
  );
  const listRunsSpy = vi.fn(async (options?: { limit?: number }): Promise<RunListEntry[]> => {
    const runs = args?.listRuns ?? [];
    return typeof options?.limit === "number" ? runs.slice(0, options.limit) : runs;
  });
  const stopSpy = vi.fn(async () => args?.stop ?? ({
    schema_version: "calyx.run-cancellation-result/v1" as const,
    status: "already_terminal" as const,
    run_id: "run-positional-1",
  }));
  const getRunRecordSpy = vi.fn(
    async (runId: string) => args?.getRunRecordById ? args.getRunRecordById(runId) : args?.getRunRecord,
  );
  const createIntentSpy = vi.fn(
    args?.createIntent ??
      ((input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent => ({
        run_id: input.run_id ?? "generated-run-id",
        host: input.host,
        ...(input.kernel ? { kernel: input.kernel } : {}),
        ...(input.issue ? { issue: input.issue } : {}),
        ...(input.backend ? { backend: input.backend } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.worktree_mode ? { worktree_mode: input.worktree_mode } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.prompt_file ? { prompt_file: input.prompt_file } : {}),
        ...(input.system_prompt ? { system_prompt: input.system_prompt } : {}),
        ...(input.append_system_prompt ? { append_system_prompt: input.append_system_prompt } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.template_vars ? { template_vars: input.template_vars } : {}),
        ...(input.execplan_ref ? { execplan_ref: input.execplan_ref } : {}),
        ...(input.required_features ? { required_features: input.required_features } : {}),
        ...(input.worktree_base ? { worktree_base: input.worktree_base } : {}),
        ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
        ...(input.worktree_ref ? { worktree_ref: input.worktree_ref } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.required_artifacts ? { required_artifacts: input.required_artifacts } : {}),
        ...(input.output_capture ? { output_capture: input.output_capture } : {}),
        ...(input.artifact_roots ? { artifact_roots: input.artifact_roots } : {}),
        ...(input.backend_options ? { backend_options: input.backend_options } : {}),
        ...(input.host_process ? { host_process: input.host_process } : {}),
        ...(input.notifications ? { notifications: input.notifications } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(typeof input.require_execplan === "boolean" ? { require_execplan: input.require_execplan } : {}),
        ...(typeof input.pull_execplan === "boolean" ? { pull_execplan: input.pull_execplan } : {}),
        ...(input.resume_session_id ? { resume_session_id: input.resume_session_id } : {}),
        created_at: "2026-03-11T00:00:00.000Z",
      })),
  );

  const deps: RunCliDependencies = {
    createRunService: () => ({
      createIntent: createIntentSpy,
      launch: launchSpy,
      getRunRecord: getRunRecordSpy,
      getKernelReceipt: vi.fn(async () => args?.getKernelReceipt),
      listRuns: listRunsSpy,
      listActivity: vi.fn(async (): Promise<RunActivityEntry[]> => args?.listActivity ?? []),
      inspectInteractiveSession: vi.fn(async (): Promise<InteractiveSessionInspectResult> => args?.inspectInteractiveSession ?? {
        activity_id: "interactive:codex:session-1",
        backend: "codex",
        session_id: "session-1",
        session_path: "/tmp/session.jsonl",
        source: "codex_sessions",
        total_events: 1,
        returned_events: 1,
        truncated: false,
        include_tools: false,
        events: [{
          index: 0,
          line: 1,
          role: "user",
          kind: "message",
          summary: "hello",
          text: "hello",
        }],
      }),
      readEvents: vi.fn(async (): Promise<RecordedRunEvent[]> => args?.readEvents ?? []),
      readLogs: vi.fn(async (runId: string): Promise<RunLogResult> => makeRunLogResult(runId, args?.readEvents ?? [])),
      observeRun: vi.fn(async (): Promise<RunObservationResult> => makeRunObservationResult(args?.getRunRecord ?? makeRecord({ state: "running" }))),
      resolveResumeWorktreePath: resolveResumeWorktreePathSpy,
      stop: stopSpy,
      auditTerminalAuthority: vi.fn(args?.auditTerminalAuthority ?? (async () => ({
        schema_version: "calyx.infra-error-census-authority-audit/v1" as const,
        authority_source: "sqlite" as const,
        authoritative: true,
        terminal_event_count: 0,
        legacy_event_count: 0,
        uuid_incarnation_count: 0,
        legacy_root_count: 0,
        ambiguity_count: 0,
        legacy_roots: [],
        ambiguities: [],
        truncated: false,
      }))),
      reconcile: vi.fn(async () => args?.reconcile ?? ({
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" as const },
      })),
      executeStoredRun: vi.fn(args?.executeStoredRun ?? (async () => makeRecord({ state: "succeeded", exitCode: 0 }))),
    }),
    resolveFleetTopology: args?.resolveFleetTopology
      ?? (async (intent) => ({ ...makeRunLaunchTopologyTargets(), intent })),
    ...(args?.fetchSpy ? {
      createAdminClient: createAdminClientFactory((async (...fetchArgs: Parameters<typeof fetch>) => {
        const [input, init] = fetchArgs;
        const request = input instanceof Request ? input : new Request(input, init);
        const requestBody = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.clone().text();
        const forwardedInit: RequestInit = {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          ...(requestBody === undefined ? {} : { body: requestBody }),
          signal: request.signal,
        };
        const response = await args.fetchSpy!(new URL(request.url), forwardedInit);
        const pathname = new URL(String(fetchArgs[0]), "http://fixture.invalid").pathname;
        if (response && typeof response === "object" && !("headers" in response)) {
          const fixture = response as {
            status: number;
            statusText?: string;
            text(): Promise<string>;
          };
          return new Response(await fixture.text(), {
            status: fixture.status,
            ...(fixture.statusText ? { statusText: fixture.statusText } : {}),
            headers: {
              "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
              "content-type": pathname.endsWith("/v1/admin/runs") && response.status === 202
                ? "application/vnd.polli.calyx.run-launch-receipt+json;version=1"
                : "application/json",
            },
          });
        }
        if (
          response instanceof Response
        ) {
          response.headers.set("x-calyx-request-id", "req_123e4567-e89b-42d3-a456-426614174000");
          if (response.status === 401) {
            response.headers.set("www-authenticate", 'Bearer realm="calyx-run"');
          }
          if (pathname.endsWith("/v1/admin/health")) {
            response.headers.set("content-type", "application/json");
          }
        }
        return response as Response;
      }) as typeof fetch),
    } : {}),
    ...(args?.agentsInfraRoot ? { agentsInfraRoot: args.agentsInfraRoot } : {}),
    ...(args?.currentHostAlias ? { currentHostAlias: args.currentHostAlias } : {}),
    ...(args?.tokenForHost ? { tokenForHost: args.tokenForHost } : {}),
    ...(args?.openRecoveryCustody ? { openRecoveryCustody: args.openRecoveryCustody } : {}),
    ...(args?.watchRunChanges ? { watchRunChanges: args.watchRunChanges } : {}),
  };

  return {
    deps,
    createIntentSpy,
    launchSpy,
    getRunRecordSpy,
    resolveResumeWorktreePathSpy,
    listRunsSpy,
    stopSpy,
  };
}

async function waitForFileContains(filePath: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const text = await readFile(filePath, "utf8");
      if (text.includes(needle)) {
        return text;
      }
    } catch {
      // Poll until the detached process has created and populated the log file.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain ${needle}`);
}

async function waitForMatchingFiles(dirPath: string, matcher: (entry: string) => boolean): Promise<string[]> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const entries = await readdir(dirPath);
      const matches = entries.filter(matcher);
      if (matches.length > 0) {
        return matches;
      }
    } catch {
      // Poll until the detached daemon has created its state directory.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for matching files in ${dirPath}`);
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function createAgentLaunchFixture(root: string): Promise<{
  repo: string;
  headSha: string;
  home: string;
}> {
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  await execFileText("git", ["init", "--initial-branch=main"], repo);
  await execFileText("git", ["config", "user.email", "fixture@example.com"], repo);
  await execFileText("git", ["config", "user.name", "Fixture"], repo);
  await writeFile(join(repo, "README.md"), "base\n", "utf8");
  await execFileText("git", ["add", "README.md"], repo);
  await execFileText("git", ["commit", "-m", "base"], repo);
  await execFileText("git", ["checkout", "-b", "feature/pol-1799"], repo);
  await writeFile(join(repo, "README.md"), "base\nfeature\n", "utf8");
  await execFileText("git", ["commit", "-am", "feature"], repo);
  await execFileText("git", ["update-ref", "refs/pull/223/head", "feature/pol-1799"], repo);
  const headSha = await execFileText("git", ["rev-parse", "feature/pol-1799"], repo);
  const skillDir = join(home, ".agents", "skills", "fixture-review-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Fixture Review Skill\n\nUse findings-first output.\n", "utf8");
  return { repo, headSha, home };
}

async function createReviewPrHeadFixture(root: string): Promise<{
  repo: string;
  oldHeadSha: string;
  newHeadSha: string;
  home: string;
}> {
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  await execFileText("git", ["init", "--bare", origin], root);
  await execFileText("git", ["init", "--initial-branch=main"], repo);
  await execFileText("git", ["config", "user.email", "fixture@example.com"], repo);
  await execFileText("git", ["config", "user.name", "Fixture"], repo);
  await execFileText("git", ["remote", "add", "origin", origin], repo);
  await writeFile(join(repo, "README.md"), "base\n", "utf8");
  await execFileText("git", ["add", "README.md"], repo);
  await execFileText("git", ["commit", "-m", "base"], repo);
  await execFileText("git", ["push", "origin", "main"], repo);
  await execFileText("git", ["checkout", "-b", "feature/pol-1848"], repo);
  await writeFile(join(repo, "README.md"), "base\nold head\n", "utf8");
  await execFileText("git", ["commit", "-am", "old head"], repo);
  const oldHeadSha = await execFileText("git", ["rev-parse", "HEAD"], repo);
  await execFileText("git", ["update-ref", "refs/pull/223/head", oldHeadSha], repo);
  await writeFile(join(repo, "README.md"), "base\nnew head\n", "utf8");
  await execFileText("git", ["commit", "-am", "new head"], repo);
  const newHeadSha = await execFileText("git", ["rev-parse", "HEAD"], repo);
  await execFileText("git", ["push", "origin", `${newHeadSha}:refs/pull/223/head`], repo);
  const skillDir = join(home, ".agents", "skills", "fixture-review-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Fixture Review Skill\n\nUse findings-first output.\n", "utf8");
  return { repo, oldHeadSha, newHeadSha, home };
}

async function createAgentsInfraRepoRegistryFixture(root: string, repo: string): Promise<string> {
  const agentsInfraRoot = join(root, "agents-infra");
  await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
  await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
  await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
  await writeFile(join(agentsInfraRoot, "instructions", "skills", "SOURCES.json"), "{}\n", "utf8");
  await writeFile(join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"), "{}\n", "utf8");
  await writeFile(
    join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
    [
      "hosts:",
      "  fixture-host:",
      "    repos:",
      "      calyx:",
      `        path: ${JSON.stringify(repo)}`,
      "        aliases:",
      "          - polli-labs/calyx-dev",
      "  fixture-remote:",
      "    repos:",
      "      calyx:",
      `        path: ${JSON.stringify(repo)}`,
      "        aliases:",
      "          - polli-labs/calyx-dev",
      "",
    ].join("\n"),
    "utf8",
  );
  return agentsInfraRoot;
}

async function createReviewAgentRegistryFixture(
  root: string,
  options: {
    backendStrategy?: "prefer_different_from_requester" | "first_available";
    typedOutputCapture?: boolean;
  } = {},
): Promise<string> {
  const registryRoot = join(root, "review-agents");
  await mkdir(join(registryRoot, "reviewer"), { recursive: true });
  await mkdir(join(registryRoot, "reviewer-adversarial"), { recursive: true });
  await writeFile(
    join(registryRoot, "AGENTS.json"),
    JSON.stringify({
      version: "1",
      agents: [
        {
          id: "reviewer",
          path: "reviewer/agent.yaml",
          status: "active",
          description: "Fixture standard reviewer.",
        },
        {
          id: "reviewer-adversarial",
          path: "reviewer-adversarial/agent.yaml",
          status: "active",
          description: "Fixture adversarial reviewer.",
        },
      ],
    }, null, 2),
    "utf8",
  );
  const prompt = [
    "# Fixture Reviewer",
    "",
    "Review {{repo}} at {{target.head_sha}} against {{target.base_sha}}.",
    "Scope: {{scope}}",
    "{{#focus}}Focus: {{focus}}{{/focus}}",
    "",
    "Write findings.md and findings.json into the run artifact directory.",
    "",
  ].join("\n");
  const backendStrategy = options.backendStrategy ?? "prefer_different_from_requester";
  for (const agentId of ["reviewer", "reviewer-adversarial"]) {
    await writeFile(join(registryRoot, agentId, "prompt.md"), prompt, "utf8");
    await writeFile(
      join(registryRoot, agentId, "agent.yaml"),
      [
        "version: 1",
        "kind: agent",
        `id: ${agentId}`,
        "status: active",
        "owner: polli-labs",
        "contract_version: 1",
        `description: Fixture ${agentId}.`,
        "",
        "persona:",
        "  template: prompt.md",
        "",
        "inputs:",
        "  repo:    {type: repo-slug, required: true}",
        "  scope:   {type: enum, values: [pr, branch], default: branch}",
        "  pr:      {type: int, required_if: \"scope == pr\"}",
        "  branch:  {type: git-ref, required_if: \"scope == branch\"}",
        "  base:    {type: git-ref, default: main}",
        "  issue:   {type: linear-issue, required: false}",
        "  focus:   {type: text, repeatable: true, required: false}",
        "",
        "execution:",
        "  kernel: agent_runner",
        "  backend:",
        `    strategy: ${backendStrategy}`,
        "    fallback_order: [codex, claude]",
        "    allowed: [claude, codex]",
        "  model: {claude: opus, codex: gpt-5.4-codex}",
        "  reasoning_effort: high",
        "  safety: {timeout_minutes: 90}",
        "",
        "posture:",
        "  workspace_mutation: forbidden",
        "  artifact_writes:",
        ...(options.typedOutputCapture
          ? [
              "    - path: findings.json",
              "      location: run-artifact",
              "      source: agent_terminal_message",
              "      media_type: application/json",
              "      schema: {type: object, required: [verdict], properties: {verdict: {type: string}}, additionalProperties: false}",
              "      max_bytes: 4096",
              "      required: true",
            ]
          : [
              "    - {path: findings.md, location: run-artifact}",
              "    - {path: findings.json, location: run-artifact}",
            ]),
        "",
        "context:",
        "  type: repo_diff",
        "  worktree: {mode: managed}",
        "  target_pinning: required",
        "",
        "output:",
        options.typedOutputCapture
          ? "  required_artifacts: []"
          : "  required_artifacts: [findings.md, findings.json]",
        "",
        "delivery:",
        "  handback: {flow: handback, ack_required: true}",
        "  thread: resumable",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return join(registryRoot, "AGENTS.json");
}

describe("run command", () => {
  const created: string[] = [];
  const originalHome = process.env["HOME"];
  const originalCodexHome = process.env["CODEX_HOME"];
  const originalCodexThreadId = process.env["CODEX_THREAD_ID"];
  const originalCodexSessionId = process.env["CODEX_SESSION_ID"];
  const originalClaudeCodeSessionId = process.env["CLAUDE_CODE_SESSION_ID"];
  const originalCalyxRunHost = process.env["CALYX_RUN_HOST"];
  const originalCalyxStateHome = process.env["CALYX_STATE_HOME"];
  const originalAgentsInfraRoot = process.env["CALYX_AGENTS_INFRA_ROOT"];

  beforeEach(async () => {
    process.exitCode = undefined;
    delete process.env["CODEX_THREAD_ID"];
    delete process.env["CODEX_SESSION_ID"];
    delete process.env["CLAUDE_CODE_SESSION_ID"];
    process.env["CALYX_RUN_HOST"] = "blade";
    const stateHome = await mkdtemp(join(tmpdir(), "calyx-run-command-state-"));
    created.push(stateHome);
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalCodexHome === undefined) {
      delete process.env["CODEX_HOME"];
    } else {
      process.env["CODEX_HOME"] = originalCodexHome;
    }
    if (originalCodexThreadId === undefined) {
      delete process.env["CODEX_THREAD_ID"];
    } else {
      process.env["CODEX_THREAD_ID"] = originalCodexThreadId;
    }
    if (originalCodexSessionId === undefined) {
      delete process.env["CODEX_SESSION_ID"];
    } else {
      process.env["CODEX_SESSION_ID"] = originalCodexSessionId;
    }
    if (originalClaudeCodeSessionId === undefined) {
      delete process.env["CLAUDE_CODE_SESSION_ID"];
    } else {
      process.env["CLAUDE_CODE_SESSION_ID"] = originalClaudeCodeSessionId;
    }
    if (originalCalyxRunHost === undefined) {
      delete process.env["CALYX_RUN_HOST"];
    } else {
      process.env["CALYX_RUN_HOST"] = originalCalyxRunHost;
    }
    if (originalCalyxStateHome === undefined) {
      delete process.env["CALYX_STATE_HOME"];
    } else {
      process.env["CALYX_STATE_HOME"] = originalCalyxStateHome;
    }
    if (originalAgentsInfraRoot === undefined) {
      delete process.env["CALYX_AGENTS_INFRA_ROOT"];
    } else {
      process.env["CALYX_AGENTS_INFRA_ROOT"] = originalAgentsInfraRoot;
    }
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("local foreground launch builds RunIntent and prints JSON", async () => {
    const record = makeRecord({ state: "succeeded", exitCode: 0, runId: "run-local-1" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "foreground"),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--prompt",
      "Ship the cutover",
      "--template-var",
      "lane=pol-825",
      "--required-artifact",
      "summary.md",
      "--artifact-root",
      "packets",
      "--allowed-tool",
      "bash",
      "--max-threads",
      "3",
      "--agent-activity-stale-after-ms",
      "60000",
      "--agent-activity-poll-interval-ms",
      "5000",
      "--agent-inactivity-timeout-ms",
      "120000",
      "--agent-inactivity-stop-grace-ms",
      "1000",
      "--foreground",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.host).toBe("local");
    expect(intentArg.kernel).toBe("agent_runner");
    expect(intentArg.backend).toBe("codex");
    expect(intentArg.prompt).toBe("Ship the cutover");
    expect(intentArg.template_vars).toEqual({ lane: "pol-825" });
    expect(intentArg.require_execplan).toBe(false);
    expect(intentArg.required_artifacts).toEqual(["summary.md"]);
    expect(intentArg.artifact_roots).toEqual(["packets"]);
    expect(intentArg.backend_options).toMatchObject({
      allowed_tools: ["bash"],
      max_threads: 3,
      agent_activity: {
        stale_after_ms: 60000,
        poll_interval_ms: 5000,
        hard_timeout_ms: 120000,
        stop_grace_ms: 1000,
      },
    });

    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ host: "local" }), { detached: false });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as RunLaunchResult;
    expect(payload.run_id).toBe("run-local-1");
    expect(payload.mode).toBe("foreground");
    expect(process.exitCode).toBeUndefined();
  });

  test("launch reads prompt file on launcher before creating RunIntent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-prompt-file-"));
    created.push(tmp);
    const promptPath = join(tmp, "prompt.md");
    await writeFile(promptPath, "Prompt from carbon.\nKeep the newline.\n", "utf8");
    const record = makeRecord({ state: "queued", runId: "run-prompt-file-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--prompt-file",
      promptPath,
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.prompt).toBe("Prompt from carbon.\nKeep the newline.\n");
    expect(intentArg.require_execplan).toBe(false);
    expect(intentArg).not.toHaveProperty("prompt_file");
  });

  test("launch defaults template prompt sources to no ExecPlan requirement", async () => {
    const record = makeRecord({ state: "queued", runId: "run-template-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--template",
      "ops-review",
      "--template-var",
      "issue=POL-1321",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.template).toBe("ops-review");
    expect(intentArg.template_vars).toEqual({ issue: "POL-1321" });
    expect(intentArg.require_execplan).toBe(false);
  });

  test("launch compiles --agent on the launcher before creating RunIntent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-agent-launch-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const record = makeRecord({ state: "queued", runId: "run-agent-definition-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "claude",
      "--agent",
      "fixture-reviewer",
      "--agent-registry",
      join(process.cwd(), "fixtures/domains/agents/AGENTS.json"),
      "--var",
      `repo=${fixture.repo}`,
      "--var",
      "scope=branch",
      "--var",
      "branch=feature/pol-1799",
      "--var",
      "base=main",
      "--var",
      "focus=security",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend).toBe("claude");
    expect(intentArg.prompt).toContain(`Review ${fixture.repo} at ${fixture.headSha}`);
    expect(intentArg.prompt).toContain("# Materialized Curricula");
    expect(intentArg.require_execplan).toBe(false);
    expect(intentArg.repo).toBe(fixture.repo);
    expect(intentArg.worktree_mode).toBe("managed");
    expect(intentArg.worktree_ref).toBe(fixture.headSha);
    expect(intentArg.required_artifacts).toEqual(["findings.md", "findings.json"]);
    expect(intentArg.backend_options).toMatchObject({
      model: "opus",
      reasoning_effort: "high",
      allowed_tools: expect.arrayContaining(["Read", "Grep", "Glob"]),
      agent_activity: { hard_timeout_ms: 5_400_000 },
    });
    expect(intentArg.metadata?.["agent_definition"]).toMatchObject({
      definition_ref: "fixture-reviewer",
      agent_ref: expect.stringMatching(/^fixture-reviewer@sha256:/),
      target: expect.objectContaining({ head_sha: fixture.headSha }),
      target_repin_policy: "re-pin-or-fail",
    });
  });

  test("launch refuses a blocked agent before creating a RunIntent or spawning a backend", async () => {
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--agent",
      "fixture-blocked",
      "--agent-registry",
      join(process.cwd(), "fixtures/domains/agents/AGENTS.json"),
      "--json",
    ])).rejects.toMatchObject({
      name: "AgentDefinitionLifecycleError",
      exitCode: 2,
      code: "agent_definition_not_launchable",
      agentId: "fixture-blocked",
      status: "blocked",
    });

    expect(createIntentSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch preserves a typed terminal output capture from agent definition to RunIntent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-agent-output-capture-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp, {
      backendStrategy: "first_available",
      typedOutputCapture: true,
    });
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const record = makeRecord({ state: "queued", runId: "run-agent-output-capture-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--agent",
      "reviewer",
      "--agent-registry",
      registryPath,
      "--var",
      `repo=${fixture.repo}`,
      "--var",
      "scope=branch",
      "--var",
      "branch=feature/pol-1799",
      "--var",
      "base=main",
      "--worktree-mode",
      "existing",
      "--worktree-path",
      fixture.repo,
      "--json",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend).toBe("codex");
    expect(intentArg.required_artifacts).toBeUndefined();
    expect(intentArg.output_capture).toEqual({
      name: "findings.json",
      source: "agent_terminal_message",
      media_type: "application/json",
      schema: {
        type: "object",
        required: ["verdict"],
        properties: { verdict: { type: "string" } },
        additionalProperties: false,
      },
      max_bytes: 4096,
      required: true,
    });
    expect(intentArg.backend_options).toMatchObject({ sandbox: "read-only" });
    expect(intentArg.backend_options).not.toHaveProperty("env");
    expect(intentArg.metadata?.["agent_definition"]).toMatchObject({
      output_capture: expect.objectContaining({ name: "findings.json" }),
      workspace_mutation: "forbidden",
    });

    const resolvedSpec = await resolveRunIntent(intentArg);
    expect(() => runSpecSchema.parse(resolvedSpec)).not.toThrow();
  });

  test("review dry-run compiles reviewer launch and returns conduct receipt without launching", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-dry-run-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    process.env["CODEX_THREAD_ID"] = "codex-review-requester";
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      listActivity: [{
        entry_kind: "interactive_session",
        run_id: "interactive:codex:codex-review-requester",
        state: "interactive",
        summary: "Codex review requester",
        created_at: "2026-06-16T00:00:00.000Z",
        updated_at: "2026-06-16T00:01:00.000Z",
        host: "blade",
        backend: "codex",
        session_id: "codex-review-requester",
        session_path: "/home/caleb/.codex/sessions/review.jsonl",
        cwd: fixture.repo,
        source: "codex_sessions",
      }],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--repo",
      fixture.repo,
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--focus",
      "security",
      "--issue",
      "POL-1801",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend).toBe("claude");
    expect(intentArg.prompt).toContain(`Review ${fixture.repo} at ${fixture.headSha}`);
    expect(intentArg.append_system_prompt).toContain("calyx msg send --to interactive:codex:codex-review-requester");
    expect(intentArg.append_system_prompt).toContain("--host blade");
    expect(intentArg.append_system_prompt).toContain("--idempotency-key");
    expect(intentArg.append_system_prompt).not.toContain("--reply-to");
    expect(intentArg.handback).toMatchObject({
      key: expect.stringContaining("review:standard"),
      recipient_address: "interactive:codex:codex-review-requester",
      recipient_host: "blade",
      thread_key: expect.stringContaining("review:standard"),
      ack_required: true,
      flow: "calyx.msg/v1",
      idempotency_key: expect.stringContaining(`handback:${intentArg.run_id}:review:standard`),
    });
    expect(intentArg.metadata?.["review_conduct"]).toMatchObject({
      command: "review",
      agent_id: "reviewer",
      handback: {
        status: "bound",
        address: "interactive:codex:codex-review-requester",
        recipient_host: "blade",
        ack_required: true,
        idempotency_key: expect.stringContaining(`handback:${intentArg.run_id}:review:standard`),
      },
      backend_selection: {
        strategy: "prefer_different_from_requester",
        requester_backend: "codex",
        override: false,
      },
    });
    expect(intentArg.backend_options?.env).not.toHaveProperty("CALYX_REVIEW_HANDBACK_REPLY_TO");
    expect(intentArg.backend_options).toMatchObject({
      env: {
        CALYX_REVIEW_HANDBACK_ADDRESS: "interactive:codex:codex-review-requester",
        CALYX_REVIEW_HANDBACK_HOST: "blade",
        CALYX_REVIEWER_REPLY_ADDRESS: `run:${intentArg.run_id}`,
        CALYX_REVIEW_HANDBACK_IDEMPOTENCY_KEY: expect.stringContaining(`handback:${intentArg.run_id}:review:standard`),
        CALYX_REVIEW_HANDBACK_ACK_REQUIRED: "true",
        CALYX_REVIEW_HANDBACK_BODY_CONTRACT: "status_axes_verdict_counts_locators_only",
      },
    });

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schema_version: "calyx.review.conduct/v1",
      mode: "dry-run",
      dry_run: true,
      agent_id: "reviewer",
      requester: {
        activity_id: "interactive:codex:codex-review-requester",
        backend: "codex",
        indexed: true,
      },
      handback_status: "bound",
      backend: {
        selected: "claude",
        strategy: "prefer_different_from_requester",
        requester_backend: "codex",
        override: false,
      },
      handback: {
        status: "bound",
        flow: "calyx.msg/v1",
        ack_required: true,
        address: "interactive:codex:codex-review-requester",
        recipient_host: "blade",
      },
    });
    expect(String(payload["run_id"])).toMatch(/^review-/);
    expect(String(payload["agent_ref"])).toMatch(/^reviewer@sha256:/);
    expect(payload["target"]).toMatchObject({ head_sha: fixture.headSha });
    expect(payload["handback"]).toMatchObject({ reviewer_reply_address: `run:${String(payload["run_id"])}` });
  });

  test("review --worktree-path reviews an explicit existing worktree (POL-1807)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-worktree-path-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--worktree-path",
      fixture.repo,
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--no-handback",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.worktree_mode).toBe("existing");
    expect(intentArg.worktree_path).toBe(fixture.repo);
    expect(intentArg.worktree_reset_on_reuse).toBeUndefined();
    expect(intentArg.repo).toBeUndefined();
    expect(intentArg.prompt).toContain(`Review ${fixture.repo} at ${fixture.headSha}`);
  });

  test("review --worktree-path resolves a --pr target from the local worktree (POL-1807)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-worktree-path-pr-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--worktree-path",
      fixture.repo,
      "--pr",
      "223",
      "--base",
      "main",
      "--no-handback",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.worktree_mode).toBe("existing");
    expect(intentArg.worktree_path).toBe(fixture.repo);
    expect(intentArg.worktree_reset_on_reuse).toBeUndefined();
    // Existing mode reviews the worktree as-is — no managed PR worktree branch...
    expect(intentArg.branch).toBeUndefined();
    // ...but the PR head still resolves from the local worktree's git for review context.
    expect(intentArg.worktree_ref).toBe(fixture.headSha);
    expect(intentArg.prompt).toContain("## Target Resolution Warnings");
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload["target"]).toMatchObject({
      warnings: [
        expect.stringContaining("No --sha was supplied"),
      ],
    });
  });

  test("review --sha pins an explicit PR head instead of a stale local pull ref", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-pr-sha-"));
    created.push(tmp);
    const fixture = await createReviewPrHeadFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--worktree-path",
      fixture.repo,
      "--pr",
      "223",
      "--base",
      "main",
      "--sha",
      fixture.newHeadSha,
      "--no-handback",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.worktree_ref).toBe(fixture.newHeadSha);
    expect(intentArg.worktree_ref).not.toBe(fixture.oldHeadSha);
    expect(intentArg.prompt).toContain(`Review ${fixture.repo} at ${fixture.newHeadSha}`);
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload["target"]).toMatchObject({
      head_sha: fixture.newHeadSha,
    });
  });

  test("review requires exactly one of --repo or --worktree-path", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "review",
        "--repo",
        "calyx",
        "--worktree-path",
        "/tmp/explicit",
        "--branch",
        "main",
      ]),
    ).rejects.toThrow("either --repo <slug> or --worktree-path <path>, not both");

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "review",
        "--branch",
        "main",
      ]),
    ).rejects.toThrow("requires --repo <slug> or --worktree-path <path>");
  });

  test("review --worktree-path refuses a remote --host (launcher-local path)", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "review",
        "--worktree-path",
        "/tmp/explicit",
        "--branch",
        "main",
        "--host",
        "remote-test-host",
      ]),
    ).rejects.toThrow("launcher-local and cannot target a remote");
  });

  test("review dry-run carries a private-dev alias as canonical identity from plan through launch", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-registry-alias-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    const agentsInfraRoot = await createAgentsInfraRepoRegistryFixture(tmp, fixture.repo);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    process.env["CODEX_THREAD_ID"] = "codex-alias-requester";
    process.env["CALYX_AGENTS_INFRA_ROOT"] = agentsInfraRoot;
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      currentHostAlias: "fixture-host.example",
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--repo",
      "calyx-dev",
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.repo).toBe("calyx");
    expect(intentArg.prompt).toContain(`Review calyx at ${fixture.headSha}`);
    expect(intentArg.append_system_prompt).toContain("--thread review:standard:calyx:branch-feature-pol-1799");
    expect(intentArg.append_system_prompt).not.toContain("review:standard:calyx-dev:");
    expect(intentArg.handback).toMatchObject({
      key: "review:standard:calyx:branch-feature-pol-1799",
      thread_key: "review:standard:calyx:branch-feature-pol-1799",
      idempotency_key: expect.stringMatching(/:review:standard:calyx:branch-feature-pol-1799$/),
    });
    expect(intentArg.backend_options?.env).toMatchObject({
      CALYX_REVIEW_HANDBACK_THREAD: "review:standard:calyx:branch-feature-pol-1799",
      CALYX_REVIEW_HANDBACK_IDEMPOTENCY_KEY: expect.stringMatching(/:review:standard:calyx:branch-feature-pol-1799$/),
    });
    expect(intentArg.metadata?.["agent_definition"]).toMatchObject({
      resolved_vars: expect.objectContaining({ repo: "calyx-dev" }),
      target: expect.objectContaining({
        repo: "calyx",
        requested_repo: "calyx-dev",
        repo_resolution_source: "registry",
        head_sha: fixture.headSha,
      }),
    });
    expect(intentArg.metadata?.["review_conduct"]).toMatchObject({
      target: expect.objectContaining({ repo: "calyx" }),
      handback: expect.objectContaining({
        thread_key: "review:standard:calyx:branch-feature-pol-1799",
        body_contract: expect.stringContaining("Hand back calyx branch feature/pol-1799"),
      }),
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schema_version: "calyx.review.conduct/v1",
      mode: "dry-run",
      target: expect.objectContaining({
        repo: "calyx",
        requested_repo: "calyx-dev",
        head_sha: fixture.headSha,
      }),
      launch: expect.objectContaining({
        repo: "calyx",
        variables: expect.arrayContaining(["repo=calyx"]),
      }),
      handback: expect.objectContaining({
        thread_key: "review:standard:calyx:branch-feature-pol-1799",
      }),
    });
  });

  test("review launch uses the same canonical repo accepted by private-dev dry-run", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-registry-alias-launch-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    const agentsInfraRoot = await createAgentsInfraRepoRegistryFixture(tmp, fixture.repo);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      agentsInfraRoot,
      currentHostAlias: "fixture-host.example",
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--repo",
      "calyx-dev",
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--agent-registry",
      registryPath,
      "--no-handback",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.repo).toBe("calyx");
    expect(intentArg.metadata?.["agent_definition"]).toMatchObject({
      resolved_vars: expect.objectContaining({ repo: "calyx-dev" }),
      target: expect.objectContaining({
        repo: "calyx",
        requested_repo: "calyx-dev",
      }),
    });
    const resolvedSpec = await resolveRunIntent({ ...intentArg, host: "fixture-remote" }, { agentsInfraRoot });
    expect(resolvedSpec.worktree).toMatchObject({
      mode: "managed",
      repo: "calyx",
      ref: fixture.headSha,
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mode: "launched",
      launch: expect.objectContaining({
        repo: "calyx",
        variables: expect.arrayContaining(["repo=calyx"]),
      }),
    });
  });

  test("review reports first_available strategy from compiled agent metadata", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-first-available-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp, { backendStrategy: "first_available" });
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    process.env["CODEX_THREAD_ID"] = "codex-review-requester";
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--repo",
      fixture.repo,
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend).toBe("codex");
    expect(intentArg.metadata?.["review_conduct"]).toMatchObject({
      backend_selection: {
        strategy: "first_available",
        requester_backend: "codex",
        override: false,
      },
    });
    expect(intentArg.metadata?.["agent_definition"]).toMatchObject({
      backend_selection: {
        strategy: "first_available",
        selected_backend: "codex",
        requester_backend: "codex",
        override: false,
      },
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      backend: {
        selected: "codex",
        strategy: "first_available",
        requester_backend: "codex",
        override: false,
        reason: "first_available selected codex; requester backend is codex",
      },
    });
  });

  test("review honors backend override and explicit no-handback", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-override-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--adversarial",
      "--repo",
      fixture.repo,
      "--branch",
      "feature/pol-1799",
      "--base",
      "main",
      "--backend",
      "codex",
      "--no-handback",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend).toBe("codex");
    expect(intentArg.append_system_prompt).toBeUndefined();
    expect(intentArg.metadata?.["review_conduct"]).toMatchObject({
      agent_id: "reviewer-adversarial",
      backend_selection: { override: true },
      handback: { status: "disabled" },
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      agent_id: "reviewer-adversarial",
      backend: {
        selected: "codex",
        override: true,
        reason: "explicit --backend override selected codex",
      },
      handback: {
        status: "disabled",
        reviewer_reply_address: `run:${String(payload["run_id"])}`,
      },
    });
  });

  test("review PR worktree branch includes standard or adversarial flavor", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-pr-branch-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    process.env["CODEX_THREAD_ID"] = "codex-review-requester";
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--adversarial",
      "--repo",
      fixture.repo,
      "--pr",
      "223",
      "--base",
      "main",
      "--agent-registry",
      registryPath,
      "--dry-run",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.branch).toBe("calyx-review/pr-223-adversarial");
    expect(intentArg.worktree_reset_on_reuse).toBe(true);
  });

  test("review degrades handback to receipt-only when remote daemon lacks msg feature", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-msg-degrade-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    process.env["CODEX_THREAD_ID"] = "codex-review-requester";
    const record = makeRecord({ state: "queued", runId: "generated-run-id" });
    const remoteHealth = makeHealthPayload({
      supports_features: [
        CALYX_DAEMON_FEATURES.healthV1,
        CALYX_DAEMON_FEATURES.workloadAdmissionV1,
        CALYX_DAEMON_FEATURES.agentRunnerV1,
        CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
        CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
        CALYX_DAEMON_FEATURES.repoRegistryV1,
        CALYX_DAEMON_FEATURES.systemPromptV1,
        CALYX_DAEMON_FEATURES.backendModelV1,
        CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
        CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
        CALYX_DAEMON_FEATURES.runHandbackV1,
      ],
    });
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(remoteHealth),
          status: 200,
          statusText: "OK",
        } as Response;
      }
      if (url.pathname === "/v1/admin/runs") {
        return {
          ok: true,
          text: async () => JSON.stringify(makePortableLaunchReceipt(record.run_id)),
          status: 202,
          statusText: "Accepted",
        } as Response;
      }
      if (url.pathname === `/v1/admin/runs/${record.run_id}`) {
        return {
          ok: true,
          text: async () => JSON.stringify(makeAdminWireRecord(record)),
          status: 200,
          statusText: "OK",
        } as Response;
      }
      throw new Error(`unexpected URL ${String(url)}`);
    });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "review",
      "--repo",
      fixture.repo,
      "--pr",
      "223",
      "--base",
      "main",
      "--host",
      "blade",
      "--server-url",
      "http://blade:8740",
      "--auth-token",
      "secret-token",
      "--agent-registry",
      registryPath,
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.append_system_prompt).toBeUndefined();
    expect(intentArg.backend_options?.env).toBeUndefined();
    expect(intentArg.handback).toMatchObject({
      recipient_address: "interactive:codex:codex-review-requester",
      recipient_host: "blade",
      flow: "receipt-only/v1",
      idempotency_key: expect.stringContaining(`handback:${intentArg.run_id}:review:standard`),
    });
    expect(intentArg.branch).toBe("calyx-review/pr-223-standard");
    expect(intentArg.worktree_reset_on_reuse).toBe(true);
    expect(intentArg.metadata?.["review_conduct"]).toMatchObject({
      handback: {
        status: "unavailable",
        handback_status: "unavailable",
        flow: "receipt-only/v1",
        manual_relay_required: true,
        unavailable_reason: "message_correspondence_unavailable",
      },
    });
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(payload).toMatchObject({
      mode: "launched",
      handback_status: "unavailable",
      launch_mode: "remote",
      handback: {
        status: "unavailable",
        handback_status: "unavailable",
        manual_relay_required: true,
        reviewer_reply_address: `run:${String(payload["run_id"])}`,
      },
    });
  });

  test("review requires caller identity for default handback", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-review-missing-identity-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    const registryPath = await createReviewAgentRegistryFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "review",
        "--repo",
        fixture.repo,
        "--branch",
        "feature/pol-1799",
        "--base",
        "main",
        "--agent-registry",
        registryPath,
        "--dry-run",
        "--json",
      ]),
    ).rejects.toThrow("could not resolve the caller activity id");

    expect(createIntentSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch lets an explicit --worktree-path override an agent's managed default (POL-1807)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-agent-launch-existing-override-"));
    created.push(tmp);
    const fixture = await createAgentLaunchFixture(tmp);
    process.env["HOME"] = fixture.home;
    process.env["CODEX_HOME"] = join(fixture.home, ".codex");
    const record = makeRecord({ state: "queued", runId: "run-agent-existing-override-1" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    // fixture-reviewer declares context.worktree.mode: managed; an explicit
    // --worktree-path must override it to existing mode rather than erroring
    // (the POL-1811 dogfood `exit 2`).
    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "claude",
      "--agent",
      "fixture-reviewer",
      "--agent-registry",
      join(process.cwd(), "fixtures/domains/agents/AGENTS.json"),
      "--var",
      `repo=${fixture.repo}`,
      "--var",
      "scope=branch",
      "--var",
      "branch=feature/pol-1799",
      "--var",
      "base=main",
      "--worktree-path",
      fixture.repo,
    ]);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.worktree_mode).toBe("existing");
    expect(intentArg.worktree_path).toBe(fixture.repo);
    // Existing mode is path-authoritative — it must not carry a repo identity
    // (the agent's repo var is a path here) or the daemon would registry-resolve
    // it and a local path is not a registered slug (POL-1807 BLOCKER fix).
    expect(intentArg.repo).toBeUndefined();
  });

  test("launch still rejects an explicit --worktree-mode managed together with --worktree-path", async () => {
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--backend",
        "claude",
        "--prompt",
        "Ship it",
        "--worktree-mode",
        "managed",
        "--worktree-path",
        "/tmp/explicit-worktree",
      ]),
    ).rejects.toThrow("does not accept --worktree-mode managed together with --worktree-path");

    expect(createIntentSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch requires an ExecPlan by default when no prompt source is supplied", async () => {
    const record = makeRecord({ state: "queued", runId: "run-issue-execplan-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--issue",
      "POL-1321",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.issue).toBe("POL-1321");
    expect(intentArg.require_execplan).toBe(true);
  });

  test("launch can explicitly require an ExecPlan for a direct prompt source", async () => {
    const record = makeRecord({ state: "queued", runId: "run-strict-prompt-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--prompt",
      "Ship with an explicit plan",
      "--require-execplan",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.prompt).toBe("Ship with an explicit plan");
    expect(intentArg.require_execplan).toBe(true);
  });

  test("launch accepts --no-require-execplan for direct prompt launches", async () => {
    const record = makeRecord({ state: "queued", runId: "run-probe-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--prompt",
      "Probe without a plan",
      "--no-require-execplan",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.prompt).toBe("Probe without a plan");
    expect(intentArg.require_execplan).toBe(false);
  });

  test("remote launch ships launcher-local prompt-file content as inline prompt", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-prompt-file-"));
    created.push(tmp);
    const promptPath = join(tmp, "prompt.md");
    await writeFile(promptPath, "Remote prompt from launcher.\n", "utf8");
    const record = makeRecord({ state: "queued", runId: "generated-run-id" });
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      if (url.pathname === "/v1/admin/runs") {
        return {
          ok: true,
          text: async () => JSON.stringify(makePortableLaunchReceipt(record.run_id)),
          status: 202,
          statusText: "Accepted",
        };
      }
      if (url.pathname === `/v1/admin/runs/${record.run_id}`) {
        return {
          ok: true,
          text: async () => JSON.stringify(makeAdminWireRecord(record)),
          status: 200,
          statusText: "OK",
        };
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "blade",
      "--prompt-file",
      promptPath,
      "--auth-token",
      "secret-token",
      "--server-url",
      "http://blade:8740",
      "--json",
    ]);

    const [, launchInit] = fetchSpy.mock.calls[1] as unknown as [URL, RequestInit];
    const body = JSON.parse(String(launchInit.body)) as { intent: RunIntent };
    expect(body.intent.prompt).toBe("Remote prompt from launcher.\n");
    expect(body.intent.require_execplan).toBe(false);
    expect(body.intent).not.toHaveProperty("prompt_file");
  });

  test("launch resolves system prompt overrides before creating RunIntent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-system-prompt-"));
    created.push(tmp);
    const appendPath = join(tmp, "append.md");
    await writeFile(appendPath, "Append from file.\nSecond line.\n", "utf8");
    const record = makeRecord({ state: "queued", runId: "run-system-prompt-1" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--prompt",
      "Use custom instructions",
      "--system-prompt",
      "Replacement system prompt.",
      "--append-system-prompt-file",
      appendPath,
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.system_prompt).toBe("Replacement system prompt.");
    expect(intentArg.append_system_prompt).toBe("Append from file.\nSecond line.\n");
    expect(intentArg).not.toHaveProperty("append_system_prompt_file");

    const launchCalls = launchSpy.mock.calls as unknown as Array<[RunIntent, { detached: boolean }]>;
    const launchedIntent = launchCalls[0]![0];
    expect(launchedIntent.required_features).toContain(CALYX_DAEMON_FEATURES.systemPromptV1);
  });

  test("launch stores Codex one-off reasoning effort in backend_options", async () => {
    const record = makeRecord({ state: "queued", runId: "run-reasoning-effort-1" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--prompt",
      "Use a larger thinking budget",
      "--reasoning-effort",
      "xhigh",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend_options).toMatchObject({ reasoning_effort: "xhigh" });

    const launchCalls = launchSpy.mock.calls as unknown as Array<[RunIntent, { detached: boolean }]>;
    const launchedIntent = launchCalls[0]![0];
    expect(launchedIntent.backend_options).toMatchObject({ reasoning_effort: "xhigh" });
    expect(launchedIntent.required_features).toContain(CALYX_DAEMON_FEATURES.backendReasoningEffortV1);
  });

  test("launch stores Claude max reasoning effort in backend_options", async () => {
    const record = makeRecord({ state: "queued", runId: "run-reasoning-effort-claude-max" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "claude",
      "--prompt",
      "Use Claude's largest thinking budget",
      "--reasoning-effort",
      "max",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend_options).toMatchObject({ reasoning_effort: "max" });

    const launchCalls = launchSpy.mock.calls as unknown as Array<[RunIntent, { detached: boolean }]>;
    const launchedIntent = launchCalls[0]![0];
    expect(launchedIntent.backend_options).toMatchObject({ reasoning_effort: "max" });
    expect(launchedIntent.required_features).toContain(CALYX_DAEMON_FEATURES.backendReasoningEffortV1);
  });

  test("launch stores Claude model selection in backend_options", async () => {
    const record = makeRecord({ state: "queued", runId: "run-model-claude-opus" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "claude",
      "--prompt",
      "Use the requested model",
      "--model",
      "opus",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend_options).toMatchObject({ model: "opus" });

    const launchCalls = launchSpy.mock.calls as unknown as Array<[RunIntent, { detached: boolean }]>;
    const launchedIntent = launchCalls[0]![0];
    expect(launchedIntent.backend_options).toMatchObject({ model: "opus" });
    expect(launchedIntent.required_features).toContain(CALYX_DAEMON_FEATURES.backendModelV1);
  });

  test("launch stores Claude max turns without relabeling it as threads", async () => {
    const record = makeRecord({ state: "queued", runId: "run-max-turns-claude" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "claude",
      "--prompt",
      "Bound this Claude run",
      "--max-turns",
      "8",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.backend_options).toMatchObject({ max_turns: 8 });
    expect(intentArg.backend_options).not.toHaveProperty("max_threads");

    const launchedIntent = (launchSpy.mock.calls as unknown as Array<[RunIntent]>)[0]![0];
    expect(launchedIntent.backend_options).toMatchObject({ max_turns: 8 });
    expect(launchedIntent.required_features).toContain(CALYX_DAEMON_FEATURES.backendExecutionLimitsV1);
  });

  test.each([
    ["claude", "--max-threads", "Claude has no equivalent"],
    ["codex", "--max-turns", "Codex has no equivalent"],
  ])("launch rejects backend-mismatched execution limit for %s", async (backend, flag, message) => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      backend,
      "--prompt",
      "Do not alias limits",
      flag,
      "8",
    ])).rejects.toThrow(message);

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch rejects model-like profile values before spawning", async () => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--backend",
        "claude",
        "--prompt",
        "Use a profile that is actually a model selector",
        "--profile",
        "opus-4.7",
      ]),
    ).rejects.toThrow("looks like a backend model selector");

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch rejects --model for codex until Codex model forwarding has a contract", async () => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--backend",
        "codex",
        "--prompt",
        "Use an explicit model",
        "--model",
        "gpt-5.5",
      ]),
    ).rejects.toThrow("--model is currently supported for --backend claude only");

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch rejects Claude-only reasoning effort for Codex before launch", async () => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--backend",
        "codex",
        "--prompt",
        "Work",
        "--reasoning-effort",
        "max",
      ]),
    ).rejects.toThrow("Codex accepts: none, minimal, low, medium, high, xhigh");

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch rejects invalid reasoning effort values", async () => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--prompt",
        "Work",
        "--reasoning-effort",
        "maximum",
      ]),
    ).rejects.toThrow("Claude accepts: low, medium, high, xhigh, max");

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("launch rejects mutually exclusive system prompt inline and file flags", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-system-prompt-"));
    created.push(tmp);
    const systemPath = join(tmp, "system.md");
    await writeFile(systemPath, "System from file.\n", "utf8");
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--prompt",
        "Work",
        "--system-prompt",
        "Inline",
        "--system-prompt-file",
        systemPath,
      ]),
    ).rejects.toThrow("either --system-prompt or --system-prompt-file, not both");
  });

  test("launch rejects empty inline system prompt values", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--prompt",
        "Work",
        "--system-prompt",
        "   ",
      ]),
    ).rejects.toThrow("--system-prompt resolved to an empty prompt");
  });

  test("launch rejects missing and oversized system prompt files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "calyx-system-prompt-"));
    created.push(tmp);
    const hugePath = join(tmp, "huge.md");
    await writeFile(hugePath, "x".repeat(32 * 1024 + 1), "utf8");
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--prompt",
        "Work",
        "--append-system-prompt-file",
        join(tmp, "missing.md"),
      ]),
    ).rejects.toThrow("--append-system-prompt-file file not found");

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "local",
        "--prompt",
        "Work",
        "--system-prompt-file",
        hugePath,
      ]),
    ).rejects.toThrow("above the 32768 byte limit");
  });

  test("launch errors when --repo and --worktree-base are both set", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--host",
        "blade",
        "--backend",
        "codex",
        "--prompt",
        "Ship the cutover",
        "--repo",
        "calyx",
        "--worktree-base",
        "/tmp/worktrees",
      ]),
    ).rejects.toThrow("--repo together with --worktree-base");
  });

  test("launch prefers --worktree-path over --repo", async () => {
    const record = makeRecord({ state: "queued", runId: "run-local-repo-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--prompt",
      "Ship the cutover",
      "--repo",
      "calyx",
      "--worktree-path",
      "/tmp/explicit-worktree",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.worktree_path).toBe("/tmp/explicit-worktree");
    expect(intentArg.repo).toBeUndefined();
  });

  test("launch preserves --repo with explicit --worktree-path in create mode", async () => {
    const record = makeRecord({ state: "queued", runId: "run-create-worktree-1" });
    const { deps, createIntentSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "background"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--backend",
      "codex",
      "--prompt",
      "Ship the cutover",
      "--repo",
      "calyx",
      "--worktree-mode",
      "create",
      "--worktree-path",
      "/tmp/exact-worktree",
      "--worktree-branch",
      "caleb/pol-1156-create-worktree-mode",
    ]);

    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.repo).toBe("calyx");
    expect(intentArg.worktree_mode).toBe("create");
    expect(intentArg.worktree_path).toBe("/tmp/exact-worktree");
    expect(intentArg.branch).toBe("caleb/pol-1156-create-worktree-mode");
  });

  test("launch rejects invalid worktree mode combinations", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--backend",
        "codex",
        "--prompt",
        "Ship the cutover",
        "--worktree-mode",
        "managed",
        "--worktree-path",
        "/tmp/nope",
      ]),
    ).rejects.toThrow("--worktree-mode managed");

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--backend",
        "codex",
        "--prompt",
        "Ship the cutover",
        "--worktree-mode",
        "existing",
      ]),
    ).rejects.toThrow("Managed flow: omit --worktree-path");

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--backend",
        "codex",
        "--prompt",
        "Ship the cutover",
        "--worktree-mode",
        "create",
        "--repo",
        "calyx",
        "--worktree-path",
        "/tmp/exact-worktree",
      ]),
    ).rejects.toThrow("--worktree-branch");
  });

  test("new CLI submits and observes the single named launch representation", async () => {
    const record = makeRecord({ state: "queued", runId: "generated-run-id" });
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload()),
          status: 200,
          statusText: "OK",
        };
      }
      if (url.pathname === "/v1/admin/runs") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            schema_version: "calyx.run-launch-result/v1",
            status: "accepted",
            run_id: "generated-run-id",
            operation: {
              route: "/v1/admin/runs/generated-run-id",
              events_route: "/v1/admin/runs/generated-run-id/events",
              receipt_route: "/v1/admin/runs/generated-run-id/receipt",
            },
          }),
          status: 202,
          statusText: "Accepted",
        };
      }
      if (url.pathname === "/v1/admin/runs/generated-run-id") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeAdminWireRecord(record)),
          status: 200,
          statusText: "OK",
        };
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "blade",
      "--prompt",
      "Remote ship",
      "--auth-token",
      "secret-token",
      "--server-url",
      "http://blade:8740",
      "--json",
    ]);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [healthUrl, healthInit] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(healthUrl)).toBe("http://blade:8740/v1/admin/health");
    expect(healthInit.method).toBe("GET");
    expect(healthInit.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });

    const [launchUrl, launchInit] = fetchSpy.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(launchUrl)).toBe("http://blade:8740/v1/admin/runs");
    expect(launchInit.method).toBe("POST");
    expect(launchInit.headers).toMatchObject({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      accept: "application/vnd.polli.calyx.run-launch-receipt+json;version=1",
    });
    expect(JSON.parse(String(launchInit.body))).toMatchObject({
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "run-launch:generated-run-id",
      topology_projection_sha256: TEST_TOPOLOGY_PROJECTION_SHA256,
      intent: {
        kernel: "agent_runner",
        host: "blade",
        prompt: "Remote ship",
        require_execplan: false,
        required_features: [
          CALYX_DAEMON_FEATURES.healthV1,
          CALYX_DAEMON_FEATURES.workloadAdmissionV1,
          CALYX_DAEMON_FEATURES.agentRunnerV1,
          CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
          CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
          CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
        ],
      },
    });

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema_version: "calyx.remote-run-launch/v1",
      status: "accepted",
      run_id: "generated-run-id",
      mode: "remote",
      observation: { status: "available", state: "queued" },
    });
  });

  test("remote foreground launch is rejected before network access", async () => {
    const fetchSpy = vi.fn();
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--prompt", "Do not block an HTTP handler",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--foreground",
    ])).rejects.toThrow("Remote --foreground launch is not supported");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("audit-terminal-authority emits the bounded read-only audit contract", async () => {
    const audit: InfraErrorCensusAuthorityAudit = {
      schema_version: "calyx.infra-error-census-authority-audit/v1",
      authority_source: "sqlite",
      authoritative: true,
      terminal_event_count: 3,
      legacy_event_count: 2,
      uuid_incarnation_count: 1,
      legacy_root_count: 1,
      ambiguity_count: 0,
      legacy_roots: [{
        root_event_id: "legacy-root-event",
        leaf_event_ids: ["legacy-leaf-event"],
        event_count: 2,
      }],
      ambiguities: [],
      truncated: false,
    };
    const auditTerminalAuthority = vi.fn(async () => audit);
    const { deps } = buildRunCliDeps({ auditTerminalAuthority });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "audit-terminal-authority", "--json",
    ]);

    expect(auditTerminalAuthority).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(audit);
    expect(process.exitCode).toBeUndefined();
  });

  test("audit-terminal-authority prints unsafe graph locators and exits one", async () => {
    const auditTerminalAuthority = vi.fn(async (): Promise<InfraErrorCensusAuthorityAudit> => ({
      schema_version: "calyx.infra-error-census-authority-audit/v1",
      authority_source: "legacy_jsonl",
      authoritative: false,
      terminal_event_count: 3,
      legacy_event_count: 2,
      uuid_incarnation_count: 0,
      legacy_root_count: 1,
      ambiguity_count: 1,
      legacy_roots: [{
        root_event_id: "legacy-root",
        leaf_event_ids: ["branch-a", "branch-b"],
        event_count: 3,
      }],
      ambiguities: [{
        code: "branch_ambiguity",
        event_ids: ["legacy-root", "branch-a", "branch-b"],
      }],
      truncated: false,
    }));
    const { deps } = buildRunCliDeps({ auditTerminalAuthority });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await buildProgram({ runCli: deps }).parseAsync([
        "node", "calyx", "run", "audit-terminal-authority",
      ]);

      expect(String(out.mock.calls.at(-1)?.[0])).toContain("authoritative=false");
      expect(String(out.mock.calls.at(-1)?.[0])).toContain("source=legacy_jsonl");
      expect(String(out.mock.calls.at(-1)?.[0])).toContain(
        "ambiguity=branch_ambiguity events=legacy-root,branch-a,branch-b",
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });

  test("audit-terminal-authority maps unreadable authority to exit six", async () => {
    const { deps } = buildRunCliDeps({
      auditTerminalAuthority: vi.fn(async () => {
        throw new Error("existing authority is corrupt");
      }),
    });

    await expect(buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "audit-terminal-authority", "--json",
    ])).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining("existing authority is corrupt"),
    });
  });

  test("local and remote reconcile share the canonical incomplete receipt for unresolved legacy settlement", async () => {
    const completedAt = "2026-07-14T08:30:00.000Z";
    const serviceResult: ReconcileResult = {
      scanned: 4,
      rebuilt: ["run-private-rebuilt"],
      repair_pending: [],
      classified: ["run-private-classified"],
      adopted: ["run-private-adopted"],
      unresolved: [{
        run_id: "run-private-legacy-terminal",
        reason: "legacy_owner_settlement_pending",
      }],
      skipped: [],
      noncanonical_directories: [],
      projection: { status: "repaired", rowCount: 4 },
    };
    const canonicalPayload = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "incomplete",
      scanned: 4,
      changed: {
        rebuilt: 1,
        repair_pending: 0,
        classified: 1,
        adopted: 1,
        skipped: 0,
        unresolved: 1,
        noncanonical_directories: 0,
      },
      unresolved: [{ reason: "legacy_owner_settlement_pending", count: 1 }],
      noncanonical_directories: [],
      projection: { status: "repaired", row_count: 4 },
      completed_at: completedAt,
    };
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date(completedAt));

    try {
      const { deps: localDeps } = buildRunCliDeps({ reconcile: serviceResult });
      await buildProgram({ runCli: localDeps }).parseAsync([
        "node", "calyx", "run", "reconcile", "--json",
      ]);
      const localPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      out.mockClear();

      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return {
            ok: true,
            text: async () => JSON.stringify(makeHealthPayload({
              supports_features: [
                CALYX_DAEMON_FEATURES.healthV1,
                CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1,
              ],
            })),
            status: 200,
            statusText: "OK",
          };
        }
        expect(url.pathname).toBe("/v1/admin/runs/reconcile-preserving/v1");
        return {
          ok: true,
          text: async () => JSON.stringify(canonicalPayload),
          status: 200,
          statusText: "OK",
        };
      });
      const { deps: remoteDeps } = buildRunCliDeps({ fetchSpy });
      await buildProgram({ runCli: remoteDeps }).parseAsync([
        "node", "calyx", "run", "reconcile",
        "--host", "blade",
        "--auth-token", "secret-token",
        "--server-url", "http://blade:8740",
        "--json",
      ]);
      const remotePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
      expect(process.exitCode).toBe(1);

      expect(localPayload).toEqual(canonicalPayload);
      expect(remotePayload).toEqual(canonicalPayload);
      expect(localPayload).toEqual(remotePayload);
    } finally {
      process.exitCode = undefined;
      vi.useRealTimers();
    }
  });

  test("human reconcile output reports the unresolved histogram", async () => {
    const serviceResult: ReconcileResult = {
      scanned: 1,
      rebuilt: [],
      repair_pending: [],
      classified: [],
      adopted: [],
      unresolved: [{
        run_id: "run-private-legacy-terminal",
        reason: "legacy_publication_authority_unproven",
      }],
      skipped: [],
      noncanonical_directories: [],
      projection: { status: "repaired", rowCount: 1 },
    };
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = buildRunCliDeps({ reconcile: serviceResult });

    try {
      await buildProgram({ runCli: deps }).parseAsync([
        "node", "calyx", "run", "reconcile",
      ]);

      expect(out.mock.calls.map(([line]) => String(line))).toEqual([
        expect.stringContaining("unresolved=1"),
        "unresolved_reasons=legacy_publication_authority_unproven:1",
      ]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(
        "1 run authority disposition(s) remain unresolved",
      ));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });

  test.each([
    {
      label: "a nonzero unresolved count",
      status: "completed",
      changedUnresolved: 1,
      unresolved: [],
    },
    {
      label: "a nonempty unresolved histogram",
      status: "completed",
      changedUnresolved: 0,
      unresolved: [{ reason: "legacy_publication_authority_unproven", count: 1 }],
    },
    {
      label: "an unknown future status",
      status: "degraded",
      changedUnresolved: 0,
      unresolved: [],
    },
  ])("reconcile fails closed on $label", ({
    status,
    changedUnresolved,
    unresolved,
  }) => {
    const result = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status,
      scanned: 1,
      changed: {
        rebuilt: 0,
        repair_pending: 0,
        classified: 0,
        adopted: 0,
        skipped: 1,
        unresolved: changedUnresolved,
        noncanonical_directories: 0,
      },
      unresolved,
      noncanonical_directories: [],
      projection: { status: "repaired", row_count: 1 },
      completed_at: "2026-07-14T08:45:00.000Z",
    } as unknown as Parameters<typeof isRunReconciliationIncomplete>[0];

    expect(isRunReconciliationIncomplete(result)).toBe(true);
  });

  test("remote reconcile validates and exits nonzero when projection repair is incomplete", async () => {
    const payload = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "incomplete",
      scanned: 7,
      changed: { rebuilt: 1, repair_pending: 0, classified: 2, adopted: 0, skipped: 4, unresolved: 0, noncanonical_directories: 0 },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "failed" },
      completed_at: "2026-07-14T09:00:00.000Z",
    };
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      expect(url.pathname).toBe("/v1/admin/runs/reconcile-preserving/v1");
      return {
        ok: true,
        text: async () => JSON.stringify(payload),
        status: 200,
        statusText: "OK",
      };
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = buildRunCliDeps({ fetchSpy });

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "reconcile",
      "--host", "blade",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(payload);
    expect(process.exitCode).toBe(1);
  });

  test("remote reconcile surfaces receipt-authoritative projection repairs as incomplete", async () => {
    const payload = {
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "incomplete",
      scanned: 1,
      changed: { rebuilt: 0, repair_pending: 1, classified: 0, adopted: 0, skipped: 0, unresolved: 0, noncanonical_directories: 0 },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "repaired", row_count: 1 },
      completed_at: "2026-07-14T09:05:00.000Z",
    };
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify(payload),
        status: 200,
        statusText: "OK",
      };
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = buildRunCliDeps({ fetchSpy });

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "reconcile",
      "--host", "blade",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(payload);
    expect(process.exitCode).toBe(1);
  });

  test("remote reconcile refuses an older daemon before sending the mutating request", async () => {
    const requestedPaths: string[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      requestedPaths.push(url.pathname);
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("mutating reconcile must not be sent without preservation capability");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload({
          supports_features: [CALYX_DAEMON_FEATURES.healthV1],
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });

    await expect(buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "reconcile",
      "--host", "blade",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("run.reconcile_preserves_noncanonical/v1");

    expect(requestedPaths).toEqual(["/v1/admin/health"]);
  });

  test("remote reconcile never falls back to the destructive predecessor when the preservation route is absent", async () => {
    const requestedPaths: string[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      requestedPaths.push(url.pathname);
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.runReconcilePreservesNoncanonicalV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      expect(url.pathname).toBe("/v1/admin/runs/reconcile-preserving/v1");
      return {
        ok: false,
        text: async () => JSON.stringify({
          error: { schema_version: "calyx.error/v1", code: "not_found", message: "route absent" },
        }),
        status: 404,
        statusText: "Not Found",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });

    await expect(buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "reconcile",
      "--host", "blade",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("status/code pair 404/not_found was not declared");

    expect(requestedPaths).toEqual([
      "/v1/admin/health",
      "/v1/admin/runs/reconcile-preserving/v1",
      "/v1/admin/runs/reconcile-preserving/v1",
    ]);
    expect(requestedPaths).not.toContain("/v1/admin/runs/reconcile");
  });

  test("remote 202 acceptance remains authoritative when immediate observation fails", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/control/v1/admin/health") {
        return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
      }
      if (url.pathname === "/control/v1/admin/runs") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            schema_version: "calyx.run-launch-result/v1",
            status: "accepted",
            run_id: "accepted-before-index",
            operation: {
              route: "/v1/admin/runs/accepted-before-index",
              events_route: "/v1/admin/runs/accepted-before-index/events",
              receipt_route: "/v1/admin/runs/accepted-before-index/receipt",
            },
          }),
          status: 202,
          statusText: "Accepted",
        };
      }
      if (url.pathname === "/control/v1/admin/runs/accepted-before-index") {
        return {
          ok: false,
          text: async () => JSON.stringify({
            error: { schema_version: "calyx.error/v1", code: "not_found", message: "projection not visible yet" },
          }),
          status: 404,
          statusText: "Not Found",
        };
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "accepted-before-index",
      "--prompt", "Observe later",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740/control",
      "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema_version: "calyx.remote-run-launch/v1",
      status: "accepted",
      run_id: "accepted-before-index",
      operation: {
        route: "http://blade:8740/control/v1/admin/runs/accepted-before-index",
        events_route: "http://blade:8740/control/v1/admin/runs/accepted-before-index/events",
        receipt_route: "http://blade:8740/control/v1/admin/runs/accepted-before-index/receipt",
      },
      observation: { status: "unavailable", error: expect.stringContaining("not_found") },
    });
  });

  test("portable remote launch replays exact bytes after a committed response is interrupted", async () => {
    const record = makeRecord({ state: "queued", runId: "run-retry-stable" });
    let launchAttempts = 0;
    const launchBodies: string[] = [];
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/v1/admin/health") {
        return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
      }
      if (url.pathname === "/v1/admin/runs") {
        launchAttempts += 1;
        launchBodies.push(String(init?.body));
        if (launchAttempts === 1) {
          return {
            ok: true,
            text: async () => { throw new Error("response lost after commit"); },
            status: 202,
            statusText: "Accepted",
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            schema_version: "calyx.run-launch-result/v1",
            status: "accepted",
            run_id: "run-retry-stable",
            operation: {
              route: "/v1/admin/runs/run-retry-stable",
              events_route: "/v1/admin/runs/run-retry-stable/events",
              receipt_route: "/v1/admin/runs/run-retry-stable/receipt",
            },
          }),
          status: 202,
          statusText: "Accepted",
        };
      }
      if (url.pathname === "/v1/admin/runs/run-retry-stable") {
        return { ok: true, text: async () => JSON.stringify(makeAdminWireRecord(record)), status: 200, statusText: "OK" };
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-retry-stable",
      "--idempotency-key", "launch-retry-42",
      "--prompt", "Remote exact-byte retry",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ]);

    expect(launchAttempts).toBe(2);
    expect(launchBodies[1]).toBe(launchBodies[0]);
    expect(JSON.parse(launchBodies[0]!)).toMatchObject({
      schema_version: "calyx.run-launch-request/v1",
      idempotency_key: "launch-retry-42",
      topology_projection_sha256: TEST_TOPOLOGY_PROJECTION_SHA256,
      intent: { run_id: "run-retry-stable" },
    });
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      run_id: "run-retry-stable",
      status: "accepted",
      mode: "remote",
      observation: { status: "available", state: "queued" },
    });
  });

  test("new CLI rejects an unknown named launch response major", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
      }
      if (url.pathname === "/v1/admin/runs") {
        return {
          ok: true,
          text: async () => JSON.stringify({ schema_version: "calyx.run-launch-result/v2", run_id: "future-run" }),
          status: 202,
          statusText: "Accepted",
        };
      }
      throw new Error(`Unexpected URL: ${String(url)}`);
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });
    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--prompt", "Reject future major",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("indeterminate_result");
  });

  test("portable launch accepts compatible additions only under the declared vendor media type", async () => {
    const record = makeRecord({ state: "queued", runId: "run-response-skew" });
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
      }
      if (url.pathname === "/v1/admin/runs") {
        return new Response(JSON.stringify({
          schema_version: "calyx.run-launch-result/v1",
          status: "accepted",
          run_id: "run-response-skew",
          future_optional: { emitted_by: "newer-daemon" },
          operation: {
            route: "/v1/admin/runs/run-response-skew",
            events_route: "/v1/admin/runs/run-response-skew/events",
            receipt_route: "/v1/admin/runs/run-response-skew/receipt",
            future_nested: true,
          },
        }), {
          status: 202,
          headers: {
            "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1; charset=utf-8",
          },
        });
      }
      return new Response(JSON.stringify({
        ...makeAdminWireRecord(record),
        future_optional: true,
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const custody = await openClientRecoveryCustody();
    const program = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy,
        openRecoveryCustody: async () => custody,
      }).deps,
    });

    await program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-response-skew",
      "--prompt", "Rolling response skew",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      run_id: "run-response-skew",
      status: "accepted",
      observation: { status: "available", state: "queued" },
    });
  });

  test("portable launch treats a valid body under the wrong media type as indeterminate", async () => {
    let posts = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
      }
      posts += 1;
      return new Response(JSON.stringify({
        schema_version: "calyx.run-launch-result/v1",
        status: "accepted",
        run_id: "run-wrong-media",
        operation: {
          route: "/v1/admin/runs/run-wrong-media",
          events_route: "/v1/admin/runs/run-wrong-media/events",
          receipt_route: "/v1/admin/runs/run-wrong-media/receipt",
        },
      }), { status: 202, headers: { "content-type": "text/plain" } });
    });
    const custody = await openClientRecoveryCustody();
    const program = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy,
        openRecoveryCustody: async () => custody,
      }).deps,
    });

    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-wrong-media",
      "--prompt", "Reject media confusion",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("indeterminate_result");
    expect(posts).toBe(4);
  });

  test("portable launch rejects combined and syntactically invalid Content-Type values", async () => {
    const cases = [
      {
        name: "combined",
        headers: () => {
          const headers = new Headers();
          headers.append(
            "content-type",
            "application/vnd.polli.calyx.run-launch-receipt+json;version=1; charset=utf-8",
          );
          headers.append("content-type", "text/plain");
          return headers;
        },
      },
      {
        name: "unbalanced-quote",
        headers: () => new Headers({
          "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1; charset=\"utf-8",
        }),
      },
    ];
    for (const fixture of cases) {
      let posts = 0;
      const runId = `run-invalid-media-${fixture.name}`;
      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return { ok: true, text: async () => JSON.stringify(makeHealthPayload()), status: 200, statusText: "OK" };
        }
        posts += 1;
        return new Response(JSON.stringify({
          schema_version: "calyx.run-launch-result/v1",
          status: "accepted",
          run_id: runId,
          operation: {
            route: `/v1/admin/runs/${runId}`,
            events_route: `/v1/admin/runs/${runId}/events`,
            receipt_route: `/v1/admin/runs/${runId}/receipt`,
          },
        }), { status: 202, headers: fixture.headers() });
      });
      const program = buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps });
      await expect(program.parseAsync([
        "node", "calyx", "run", "launch",
        "--host", "blade",
        "--run-id", runId,
        "--prompt", fixture.name,
        "--auth-token", "secret-token",
        "--server-url", "http://blade:8740",
        "--json",
      ]), fixture.name).rejects.toThrow("indeterminate_result");
      expect(posts, fixture.name).toBe(4);
    }
  });

  test("retains an encrypted generated launch receipt and replays its exact bytes", async () => {
    const launchBodies: string[] = [];
    const firstFetch = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
      }
      launchBodies.push(String(init?.body));
      return new Response(JSON.stringify({ schema_version: "calyx.run-launch-result/v2" }), { status: 202 });
    });
    const custody = await openClientRecoveryCustody();
    const first = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy: firstFetch,
        openRecoveryCustody: async () => custody,
      }).deps,
    });
    await expect(first.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-recovery-replay",
      "--idempotency-key", "launch-recovery-replay",
      "--prompt", "Persist exact wire bytes",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow(/indeterminate_result.*--replay-request/);

    const [artifactName] = await readdir(custody.receiptsRoot);
    expect(artifactName).toBeTruthy();
    const artifactPath = join(custody.receiptsRoot, artifactName!);
    const artifactMode = (await stat(artifactPath)).mode & 0o777;
    expect(artifactMode).toBe(0o600);
    const envelope = JSON.parse(await readFile(artifactPath, "utf8")) as {
      schema_version: string;
      encryption_algorithm: string;
      ciphertext: string;
    };
    expect(envelope).toMatchObject({
      schema_version: "calyx.client-recovery-envelope/v1",
      encryption_algorithm: "AES-256-GCM",
      ciphertext: expect.any(String),
    });
    expect(JSON.stringify(envelope)).not.toContain("Persist exact wire bytes");
    const receipt = await custody.readReceipt(artifactPath);
    const retainedBody = Buffer.from(receipt.body_bytes, "base64").toString("utf8");
    expect(receipt).toMatchObject({
      schema_version: "calyx.client-indeterminate-result/v1",
      operation_id: "admin.run.launch",
      method: "POST",
      path: "/v1/admin/runs",
      idempotency_key: "launch-recovery-replay",
    });
    expect(Object.keys(receipt.safe_headers).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(new Set(launchBodies)).toEqual(new Set([retainedBody]));

    const tokenForHost = vi.fn(() => "secret-token");
    const replayBodies: string[] = [];
    const record = makeRecord({ state: "queued", runId: "run-recovery-replay" });
    const replayFetch = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === "/v1/admin/runs") {
        replayBodies.push(String(init?.body));
        return new Response(JSON.stringify({
          schema_version: "calyx.run-launch-result/v1",
          status: "accepted",
          run_id: "run-recovery-replay",
          operation: {
            route: "/v1/admin/runs/run-recovery-replay",
            events_route: "/v1/admin/runs/run-recovery-replay/events",
            receipt_route: "/v1/admin/runs/run-recovery-replay/receipt",
          },
        }), {
          status: 202,
          headers: { "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify(makeAdminWireRecord(record)), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    // Recovery replay maps the receipt's endpoint back to a named host through
    // the hosts truth. Without an injected root it reads whatever fleet truth
    // the machine happens to have, so this passed only on a host that owns
    // http://blade:8740 and failed everywhere else with "No configured named
    // host owns recovery endpoint".
    const agentsInfraRoot = await createHostsTruthFixture({ blade: "http://blade:8740" });
    const replayDeps = buildRunCliDeps({
      fetchSpy: replayFetch,
      tokenForHost,
      agentsInfraRoot,
      openRecoveryCustody: async () => custody,
    }).deps;
    const replay = buildProgram({ runCli: replayDeps });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await replay.parseAsync([
      "node", "calyx", "run", "launch",
      "--replay-request", artifactPath,
      "--json",
    ]);
    expect(tokenForHost).toHaveBeenCalledWith("blade");
    expect(replayBodies).toEqual([retainedBody]);
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects copied and tampered encrypted receipts before credential lookup", async () => {
    const initialFetch = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
      }
      throw new Error("response lost after commit");
    });
    const custody = await openClientRecoveryCustody();
    const initial = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy: initialFetch,
        openRecoveryCustody: async () => custody,
      }).deps,
    });
    await expect(initial.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-recovery-security",
      "--idempotency-key", "launch-recovery-security",
      "--prompt", "Preserve the trusted replay binding",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("indeterminate_result");

    const [artifactName] = await readdir(custody.receiptsRoot);
    const artifactPath = join(custody.receiptsRoot, artifactName!);
    const envelope = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
    const ciphertext = String(envelope["ciphertext"]);
    const tamperedPath = join(custody.receiptsRoot, `receipt-${"f".repeat(64)}.json`);
    await writeFile(tamperedPath, `${JSON.stringify({
      ...envelope,
      ciphertext: `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`,
    })}\n`, { mode: 0o600, flag: "wx" });
    const outsideRoot = await mkdtemp(join(tmpdir(), "calyx-untrusted-recovery-"));
    created.push(outsideRoot);
    const outsidePath = join(outsideRoot, artifactName!);
    await writeFile(outsidePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });

    for (const [label, path] of [
      ["tampered", tamperedPath],
      ["outside-root", outsidePath],
    ] as const) {
      const tokenForHost = vi.fn(() => "must-not-resolve");
      const fetchSpy = vi.fn();
      const replay = buildProgram({
        runCli: buildRunCliDeps({
          fetchSpy,
          tokenForHost,
          openRecoveryCustody: async () => custody,
        }).deps,
      });
      await expect(replay.parseAsync([
        "node", "calyx", "run", "launch",
        "--replay-request", path,
        "--json",
      ]), label).rejects.toThrow();
      expect(tokenForHost, label).not.toHaveBeenCalled();
      expect(fetchSpy, label).not.toHaveBeenCalled();
    }
  });

  test("retains recovery evidence only when no definitive initial response exists", async () => {
    const cases = [
      { name: "malformed-2xx", status: 202, body: { schema_version: "calyx.run-launch-result/v2" }, retained: true, error: "indeterminate_result" },
      { name: "server-500", status: 500, body: { error: { schema_version: "calyx.error/v1", code: "internal_error", message: "failed" } }, retained: false, error: "internal_error" },
      { name: "malformed-502", status: 502, raw: "not-json", retained: true },
      { name: "redirect", status: 302, body: { location: "elsewhere" }, retained: true },
      { name: "future-code-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "future_conflict", message: "unknown", retryable: false } }, retained: true, error: "indeterminate_result" },
      { name: "wrong-status-4xx", status: 418, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "wrong status", retryable: false } }, retained: true, error: "indeterminate_result" },
      { name: "retryable-declared-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "try again", retryable: true } }, retained: false, error: "idempotency_conflict" },
      { name: "unknown-retryability-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "unknown retryability" } }, retained: false, error: "idempotency_conflict" },
      { name: "wrong-error-media", status: 409, mediaType: "text/plain", body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "request mismatch", retryable: false } }, retained: true },
      { name: "malformed-declared-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "", extra: true } }, retained: true },
      { name: "duplicate-top-level-terminal-4xx", status: 409, raw: '{"error":{"schema_version":"calyx.error/v1","code":"future_conflict","message":"ambiguous"},"error":{"schema_version":"calyx.error/v1","code":"idempotency_conflict","message":"ambiguous"}}', retained: true },
      { name: "duplicate-nested-terminal-4xx", status: 409, raw: '{"error":{"schema_version":"calyx.error/v1","code":"future_conflict","code":"idempotency_conflict","message":"ambiguous"}}', retained: true },
      { name: "declared-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "request mismatch", retryable: false } }, retained: false, error: "idempotency_conflict" },
      { name: "declared-predecessor-4xx", status: 409, body: { error: { schema_version: "calyx.error/v1", code: "idempotency_conflict", message: "predecessor omitted retryability" } }, retained: false, error: "idempotency_conflict" },
    ] as const;

    for (const fixture of cases) {
      const stateHome = await mkdtemp(join(tmpdir(), `calyx-recovery-${fixture.name}-`));
      created.push(stateHome);
      process.env["CALYX_STATE_HOME"] = stateHome;
      const fetchSpy = vi.fn(async (url: URL) => {
        if (url.pathname === "/v1/admin/health") {
          return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
        }
        return new Response("raw" in fixture ? fixture.raw : JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: { "content-type": "mediaType" in fixture ? fixture.mediaType : "application/json" },
        });
      });
      const program = buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps });
      await expect(program.parseAsync([
        "node", "calyx", "run", "launch",
        "--host", "blade",
        "--run-id", `run-${fixture.name}`,
        "--idempotency-key", `key-${fixture.name}`,
        "--prompt", fixture.name,
        "--auth-token", "secret-token",
        "--server-url", "http://blade:8740",
        "--json",
      ])).rejects.toThrow("error" in fixture ? fixture.error : "indeterminate_result");
      const entries = await readdir(join(stateHome, "recovery", "client", "receipts")).catch(() => []);
      expect(entries.length, fixture.name).toBe(fixture.retained ? 1 : 0);
    }
  });

  test("records error-body consumption failures at the exact recovery stage", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new ReadableStream<Uint8Array>(), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "content-length": String(GENERATED_ERROR_BODY_MAX_BYTES + 1),
        },
      });
    });
    const custody = await openClientRecoveryCustody();
    const program = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy,
        openRecoveryCustody: async () => custody,
      }).deps,
    });

    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-error-body-stage",
      "--idempotency-key", "key-error-body-stage",
      "--prompt", "Preserve the exact response consumption stage",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("indeterminate_result");
    const [receiptName] = await readdir(custody.receiptsRoot);
    const receipt = await custody.readReceipt(join(custody.receiptsRoot, receiptName!));
    expect(receipt).toMatchObject({
      operation_id: "admin.run.launch",
      failure_stage: "response_too_large",
      last_http_status: 500,
    });
  });

  test("retains ambiguity when a later 4xx cannot disprove an earlier keyed admission", async () => {
    let posts = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
      }
      posts += 1;
      if (posts === 1) throw new TypeError("connection interrupted after request write");
      return new Response(JSON.stringify({
        error: {
          schema_version: "calyx.error/v1",
          code: "future_conflict",
          message: "future daemon refusal",
          retryable: false,
        },
      }), { status: 409, headers: { "content-type": "application/json" } });
    });
    const custody = await openClientRecoveryCustody();
    const program = buildProgram({
      runCli: buildRunCliDeps({
        fetchSpy,
        openRecoveryCustody: async () => custody,
      }).deps,
    });
    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-terminal-after-ambiguity",
      "--idempotency-key", "key-terminal-after-ambiguity",
      "--prompt", "Terminal response wins",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("indeterminate_result");
    expect(posts).toBe(5);
    const [receiptName] = await readdir(custody.receiptsRoot);
    const receipt = await custody.readReceipt(join(custody.receiptsRoot, receiptName!));
    expect(receipt).toMatchObject({
      operation_id: "admin.run.launch",
      failure_stage: "invalid_response",
      last_http_status: 409,
    });
  });

  test("does not create recovery evidence for a definitive accepted launch", async () => {
    const record = makeRecord({ state: "queued", runId: "run-cleanup-failure" });
    let posts = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
      }
      if (url.pathname === "/v1/admin/runs") {
        posts += 1;
        return new Response(JSON.stringify({
          schema_version: "calyx.run-launch-result/v1",
          status: "accepted",
          run_id: "run-cleanup-failure",
          operation: {
            route: "/v1/admin/runs/run-cleanup-failure",
            events_route: "/v1/admin/runs/run-cleanup-failure/events",
            receipt_route: "/v1/admin/runs/run-cleanup-failure/receipt",
          },
        }), {
          status: 202,
          headers: { "content-type": "application/vnd.polli.calyx.run-launch-receipt+json;version=1; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify(makeAdminWireRecord(record)), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = buildRunCliDeps({ fetchSpy }).deps;
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--run-id", "run-cleanup-failure",
      "--idempotency-key", "key-cleanup-failure",
      "--prompt", "Cleanup cannot change acceptance",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ]);
    expect(posts).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    const receipts = await readdir(
      join(process.env["CALYX_STATE_HOME"]!, "recovery", "client", "receipts"),
    ).catch(() => []);
    expect(receipts).toEqual([]);
  });

  test("rejects an insecure explicit recovery root before mutation POST", async () => {
    await chmod(process.env["CALYX_STATE_HOME"]!, 0o777);
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return new Response(JSON.stringify(makeHealthPayload()), { status: 200 });
      }
      throw new Error("mutation POST must not occur");
    });
    const program = buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps });
    await expect(program.parseAsync([
      "node", "calyx", "run", "launch",
      "--host", "blade",
      "--prompt", "Reject shared recovery root",
      "--auth-token", "secret-token",
      "--server-url", "http://blade:8740",
      "--json",
    ])).rejects.toThrow("mode-0700 directory");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote launch refuses stale agent_runner daemons before POST dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload({
          supports_features: [
            CALYX_DAEMON_FEATURES.healthV1,
            CALYX_DAEMON_FEATURES.agentRunnerV1,
            CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
            CALYX_DAEMON_FEATURES.vaultExecplanRefV1,
            CALYX_DAEMON_FEATURES.repoRegistryV1,
          ],
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--prompt",
          "Remote ship",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("run.default_path_injection/v1 (POL-1100)");
    } finally {
      vi.useRealTimers();
    }

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [healthUrl] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(healthUrl)).toBe("http://blade:8740/v1/admin/health");
  });

  test("remote launch refuses system prompt intents when the daemon lacks POL-1140 support", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload({
          supports_features: [
            CALYX_DAEMON_FEATURES.healthV1,
            CALYX_DAEMON_FEATURES.agentRunnerV1,
            CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
            CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
            CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
          ],
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--prompt",
          "Remote ship",
          "--system-prompt",
          "Replacement",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("calyx self upgrade --host blade");
    } finally {
      vi.useRealTimers();
    }

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote launch refuses reasoning effort intents when the daemon lacks POL-1319 support", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload({
          supports_features: [
            CALYX_DAEMON_FEATURES.healthV1,
            CALYX_DAEMON_FEATURES.agentRunnerV1,
            CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
            CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
            CALYX_DAEMON_FEATURES.systemPromptV1,
            CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
          ],
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--backend",
          "codex",
          "--prompt",
          "Remote ship",
          "--reasoning-effort",
          "xhigh",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("run.backend_reasoning_effort/v1 (POL-1319)");
    } finally {
      vi.useRealTimers();
    }

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote launch refuses backend model intents when the daemon lacks POL-1494 support", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload({
          supports_features: [
            CALYX_DAEMON_FEATURES.healthV1,
            CALYX_DAEMON_FEATURES.agentRunnerV1,
            CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
            CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
            CALYX_DAEMON_FEATURES.systemPromptV1,
            CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
            CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
          ],
        })),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps, launchSpy } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--backend",
          "claude",
          "--prompt",
          "Remote ship",
          "--model",
          "opus",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("run.backend_model/v1 (POL-1494)");
    } finally {
      vi.useRealTimers();
    }

    expect(launchSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote launch refuses prompt_ref intents when the daemon lacks prompt registry support", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload()),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({
      fetchSpy,
      createIntent: (input) => ({
        run_id: input.run_id ?? "generated-run-id",
        kernel: "agent_runner",
        host: input.host,
        prompt: input.prompt,
        prompt_ref: "prompt://registry/pol-1113",
        created_at: "2026-03-11T00:00:00.000Z",
      } as RunIntent),
    });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--prompt",
          "Remote ship",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("run.prompt_ref/v1 (POL-1113)");
    } finally {
      vi.useRealTimers();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote launch reports protocol epoch mismatches distinctly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run launch should not POST when the protocol epoch mismatches");
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          ...makeHealthPayload(),
          protocol_epoch: 2,
        }),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "launch",
          "--host",
          "blade",
          "--prompt",
          "Remote ship",
          "--auth-token",
          "secret-token",
          "--server-url",
          "http://blade:8740",
        ]),
      ).rejects.toThrow("wire format is incompatible");
    } finally {
      vi.useRealTimers();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("foreground failure sets process exit code from RunRecord", async () => {
    const record = makeRecord({ state: "failed", exitCode: 1, runId: "run-failed-1" });
    const { deps } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "foreground"),
    });
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--host",
      "local",
      "--prompt",
      "Fail the task",
      "--foreground",
    ]);

    expect(process.exitCode).toBe(1);
  });

  test("execute-stored prints spawn_error diagnostics to stderr", async () => {
    const record = makeRecord({
      state: "infra_error",
      exitCode: 6,
      runId: "run-execute-stored-1",
      spawnError: "Failed to spawn codex app-server: spawn codex ENOENT",
    });
    const { deps } = buildRunCliDeps({
      executeStoredRun: async () => record,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "execute-stored",
      "--run-id",
      "run-execute-stored-1",
    ]);

    expect(err).toHaveBeenCalledWith("Failed to spawn codex app-server: spawn codex ENOENT");
    expect(process.exitCode).toBe(6);
  });

  test("execute-stored ownership losers exit cleanly without replaying terminal failure", async () => {
    const record = makeRecord({
      state: "infra_error",
      exitCode: 6,
      runId: "run-execute-stored-contended",
      spawnError: "the execution owner failed later",
    });
    const { deps } = buildRunCliDeps({
      executeStoredRun: async (_runId, options) => {
        options?.onOwnershipResolved?.("contended");
        return record;
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "execute-stored",
      "--run-id",
      "run-execute-stored-contended",
    ]);

    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("host_process launch rejects model and reasoning effort as agent-runner flags", async () => {
    const { deps, launchSpy } = buildRunCliDeps();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "launch",
        "--kernel",
        "host_process",
        "--host",
        "local",
        "--argv",
        "python",
        "--cwd",
        "/tmp/service",
        "--model",
        "opus",
        "--reasoning-effort",
        "xhigh",
      ]),
    ).rejects.toThrow("agent-runner flags: --model, --reasoning-effort");

    expect(launchSpy).not.toHaveBeenCalled();
  });

  test("host_process launch builds a kernel-specific RunIntent without agent-runner fields", async () => {
    const record = makeHostProcessRecord({ state: "succeeded", exitCode: 0, runId: "run-host-1" });
    const { deps, createIntentSpy, launchSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "foreground"),
    });
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "launch",
      "--kernel",
      "host_process",
      "--host",
      "local",
      "--issue",
      "POL-842",
      "--argv",
      "python",
      "--argv",
      "-m",
      "--argv",
      "http.server",
      "--cwd",
      "/tmp/service",
      "--env",
      "PORT=8000",
      "--stop-grace-ms",
      "2500",
      "--health-source",
      "stdout",
      "--health-path",
      "metrics/train.jsonl",
      "--health-stale-after-ms",
      "30000",
      "--health-poll-interval-ms",
      "5000",
      "--foreground",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.kernel).toBe("host_process");
    expect(intentArg.host_process).toEqual({
      argv: ["python", "-m", "http.server"],
      cwd: "/tmp/service",
      env: { PORT: "8000" },
      stop_grace_ms: 2500,
      health: {
        stale_after_ms: 30000,
        poll_interval_ms: 5000,
        sources: [
          { kind: "stdout" },
          { kind: "file", path: "metrics/train.jsonl" },
        ],
      },
    });
    expect(intentArg.backend).toBeUndefined();
    expect(intentArg.prompt).toBeUndefined();
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({
      kernel: "host_process",
      host: "local",
    }), { detached: false });
  });

  test("resume with explicit session-id builds RunIntent with resume_session_id", async () => {
    const record = makeRecord({ state: "succeeded", exitCode: 0, runId: "run-resume-1" });
    const { deps, createIntentSpy, launchSpy, resolveResumeWorktreePathSpy } = buildRunCliDeps({
      launchResult: makeLaunchResult(record, "foreground"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "resume",
      "sess-abc-123",
      "--prompt",
      "Continue the work",
      "--backend",
      "claude",
      "--host",
      "local",
      "--foreground",
      "--json",
    ]);

    expect(createIntentSpy).toHaveBeenCalledTimes(1);
    expect(resolveResumeWorktreePathSpy).toHaveBeenCalledWith("sess-abc-123");
    const intentArg = createIntentSpy.mock.calls[0]?.[0] as RunIntent;
    expect(intentArg.resume_session_id).toBe("sess-abc-123");
    expect(intentArg.prompt).toBe("Continue the work");
    expect(intentArg.backend).toBe("claude");
    expect(intentArg.kernel).toBe("agent_runner");
    expect(intentArg.worktree_path).toBe("/tmp/resolved-worktree");
    expect(intentArg.worktree_source).toBe("run_spec");
    expect(launchSpy).toHaveBeenCalledTimes(1);
  });

  test("local resume resolves different stored worktrees for different sessions", async () => {
    const sessionAWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-sessionA-"));
    const sessionBWorktree = await mkdtemp(join(tmpdir(), "calyx-resume-sessionB-"));
    created.push(sessionAWorktree, sessionBWorktree);

    const { deps, createIntentSpy, resolveResumeWorktreePathSpy } = buildRunCliDeps({
      resolveResumeWorktreePath: async (sessionId: string) =>
        ({ path: sessionId === "sess-A" ? sessionAWorktree : sessionBWorktree, source: "run_spec" }),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node",
      "calyx",
      "run",
      "resume",
      "sess-A",
      "--prompt",
      "Continue session A",
      "--host",
      "local",
      "--foreground",
    ]);

    await buildProgram({ runCli: deps }).parseAsync([
      "node",
      "calyx",
      "run",
      "resume",
      "sess-B",
      "--prompt",
      "Continue session B",
      "--host",
      "local",
      "--foreground",
    ]);

    expect(resolveResumeWorktreePathSpy.mock.calls).toEqual([["sess-A"], ["sess-B"]]);
    const intents = createIntentSpy.mock.calls.map((call) => call[0] as RunIntent);
    expect(intents).toHaveLength(2);
    const intentA = intents[0]!;
    const intentB = intents[1]!;
    expect(intentA.worktree_path).toBe(sessionAWorktree);
    expect(intentB.worktree_path).toBe(sessionBWorktree);
    expect(intentA.worktree_source).toBe("run_spec");
    expect(intentB.worktree_source).toBe("run_spec");
    expect(intentA.worktree_path).not.toBe(intentB.worktree_path);
  });

  test("resume errors when neither session-id nor --last is provided", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "resume",
        "--prompt",
        "Continue the work",
        "--host",
        "local",
      ]),
    ).rejects.toThrow("session-id argument or --last");
  });

  test("resume errors when both session-id and --last are provided", async () => {
    const { deps } = buildRunCliDeps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "resume",
        "sess-abc-123",
        "--last",
        "--prompt",
        "Continue the work",
        "--host",
        "local",
      ]),
    ).rejects.toThrow("not both");
  });

  test("run status renders host_process health semantics explicitly", async () => {
    const record = makeHostProcessRecord({ state: "running", runId: "run-host-health-1" });
    delete record.completed_at;
    record.updated_at = "2026-04-06T21:10:00.000Z";
    record.health = {
      source: "host_process",
      status: "stale",
      checked_at: "2026-04-06T21:10:45.000Z",
      stale_after_ms: 30000,
      last_progress_at: "2026-04-06T21:10:00.000Z",
      observations: [
        {
          kind: "stdout",
          label: "stdout.log",
          path: "/tmp/service/stdout.log",
          exists: true,
          last_modified_at: "2026-04-06T21:10:00.000Z",
        },
      ],
      summary: "Last progress at 2026-04-06T21:10:00.000Z is older than 30000 ms.",
    };
    record.summary = "Run run-host-health-1 running; health=stale; Last progress at 2026-04-06T21:10:00.000Z is older than 30000 ms..";

    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "status",
      "--run-id",
      "run-host-health-1",
      "--details",
    ]);

    const joined = out.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("run-host running");
    expect(joined).toContain("updated: 2026-04-06T21:10:00.000Z");
    expect(joined).toContain("health: stale");
    expect(joined).toContain("health_checked: 2026-04-06T21:10:45.000Z");
    expect(joined).toContain("last_progress: 2026-04-06T21:10:00.000Z");
    expect(joined).toContain("stale_after: 30.0s");
  });

  test("run status renders Claude semantic progress source and availability", async () => {
    const record = makeRecord({ state: "running", runId: "run-claude-health", backend: "claude" });
    delete record.completed_at;
    record.health = {
      source: "agent_runner",
      status: "healthy",
      checked_at: "2026-07-17T12:00:00.000Z",
      stale_after_ms: 30000,
      observations: [{ kind: "claude_stream", label: "claude_stream", exists: true }],
      progress_signal: {
        source: "claude_stream",
        status: "available",
        reason: "semantic_event",
        expected_silence_until: "2026-07-17T12:00:30.000Z",
      },
      summary: "Backend-declared semantic silence is expected until 2026-07-17T12:00:30.000Z.",
    };
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "run", "status", record.run_id, "--details"]);

    const joined = out.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("health: healthy");
    expect(joined).toContain("progress_source: claude_stream");
    expect(joined).toContain("progress_signal: available");
    expect(joined).toContain("progress_signal_reason: semantic_event");
    expect(joined).toContain("progress_expected_silence_until: 2026-07-17T12:00:30.000Z");
  });

  test("run-scoped commands accept positional run id and --run-id compatibility", async () => {
    const record = makeRecord({
      state: "succeeded",
      runId: "run-positional-1",
      worktreePath: "/tmp/calyx/wt/positional",
      branch: "calyx-run/pol-1405",
    });
    const cases: Array<{ command: string; args: string[]; deps: RunCliDependencies }> = [
      { command: "status", args: ["run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "status", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "receipt", args: ["run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "receipt", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "kernel-receipt", args: ["run-positional-1"], deps: buildRunCliDeps({ getKernelReceipt: record.kernel_receipt }).deps },
      { command: "kernel-receipt", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ getKernelReceipt: record.kernel_receipt }).deps },
      { command: "doctor", args: ["run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "doctor", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record }).deps },
      { command: "logs", args: ["run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record, readEvents: [] }).deps },
      { command: "logs", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ getRunRecord: record, readEvents: [] }).deps },
      { command: "stop", args: ["run-positional-1"], deps: buildRunCliDeps({ stop: { schema_version: "calyx.run-cancellation-result/v1", status: "cancellation_requested", run_id: "run-positional-1", requested_at: "2026-07-14T07:00:00.000Z" } }).deps },
      { command: "stop", args: ["--run-id", "run-positional-1"], deps: buildRunCliDeps({ stop: { schema_version: "calyx.run-cancellation-result/v1", status: "cancellation_requested", run_id: "run-positional-1", requested_at: "2026-07-14T07:00:00.000Z" } }).deps },
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});

    for (const item of cases) {
      const program = buildProgram({ runCli: item.deps });
      await program.parseAsync(["node", "calyx", "run", item.command, ...item.args]);
    }
  });

  test("remote stop reports response loss as non-retryable indeterminacy with one exact read command", async () => {
    const runId = "7eb1f79f-5555-4222-8333-eeeeeeeeeeee";
    let stopAttempts = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}/stop`);
      expect(init?.method).toBe("POST");
      stopAttempts += 1;
      throw new Error("connection lost after committed stop");
    });
    const { deps } = buildRunCliDeps({ fetchSpy });

    await expect(buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "stop", runId,
      "--host", "blade",
      "--server-url", "http://blade.internal:8740",
      "--auth-token", "secret-token",
      "--json",
    ])).rejects.toThrow(
      new RegExp(`admin\\.run\\.stop[\\s\\S]*Do not repeat[\\s\\S]*calyx run status ${runId} --server-url http://blade\\.internal:8740 --json[\\s\\S]*inconclusive`),
    );
    expect(stopAttempts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test("run logs preserves the named-route 404 without a lossy lifecycle fallback", async () => {
    const runId = "7eb1f79f-5555-4222-8333-eeeeeeeeeeee";
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}/logs`);
      expect(url.search).toBe("?tail=1");
      return typedNotFoundResponse("missing route");
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "logs",
      runId,
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
      "--tail",
      "1",
      "--json",
    ])).rejects.toMatchObject({ exitCode: 3 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("remote run logs never dereferences the remote session path on the caller host", async () => {
    const runId = "7eb1f79f-6666-4222-8333-eeeeeeeeeeee";
    const fetchSpy = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}/logs`);
      return new Response(JSON.stringify(makeRunLogResult(runId)), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "logs",
      runId,
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
      "--json",
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual(makeRunLogResult(runId));
  });

  test("named run detail readers reject unknown majors and empty successful representations", async () => {
    const runId = "7eb1f79f-7777-4222-8333-eeeeeeeeeeee";
    const fixtures = [
      {
        command: "logs",
        pathname: `/v1/admin/runs/${runId}/logs`,
        body: JSON.stringify({ schema_version: "run-logs/v2", entries: [] }),
      },
      {
        command: "doctor",
        pathname: `/v1/admin/runs/${runId}/observation`,
        body: JSON.stringify({ schema_version: "run-observation/v2" }),
      },
      {
        command: "kernel-receipt",
        pathname: `/v1/admin/runs/${runId}/receipt`,
        body: JSON.stringify({ schema_version: "calyx.run-receipt/v2", garbage: true }),
      },
      {
        command: "kernel-receipt",
        pathname: `/v1/admin/runs/${runId}/receipt`,
        body: "",
      },
    ] as const;

    for (const fixture of fixtures) {
      const fetchSpy = vi.fn(async (url: URL) => {
        expect(url.pathname, fixture.command).toBe(fixture.pathname);
        return new Response(fixture.body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      });
      const program = buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps });
      await expect(program.parseAsync([
        "node", "calyx", "run", fixture.command, runId,
        "--server-url", "http://blade.internal:8740",
        "--auth-token", "secret-token",
        "--json",
      ]), fixture.command).rejects.toThrow("invalid success representation");
      expect(fetchSpy, fixture.command).toHaveBeenCalledTimes(1);
    }
  });

  test("run doctor prints structured liveness, artifact, and GPU observations", async () => {
    const runId = "7eb1f79f-aaaa-4222-8333-abcdefabcdef";
    const record = makeRecord({
      state: "running",
      runId,
      issue: "POL-1502",
      host: "blade",
      backend: "codex",
      worktreePath: "/home/caleb/dev/calyx/wt/pol-1502",
      artifactRoots: ["packets"],
    });
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "run", "doctor", runId]);

    const rendered = String(out.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("process=not_recorded");
    expect(rendered).toContain("artifacts: present=0 missing=1 unknown=0");
    expect(rendered).toContain("artifact_roots:");
    expect(rendered).toContain("present\tpackets /home/caleb/dev/calyx/wt/pol-1502/packets files=2 dirs=1 size=128B");
    expect(rendered).toContain("resources: attributed processes=2 cpu=37.5% rss=187.5MiB gpu_processes=1/2 gpu_mem=512.0MiB");
    expect(rendered).toContain("gpu0 NVIDIA Test 12% 1024/24576MiB");
    expect(rendered).toContain("warning: Missing required artifacts: summary.md.");
  });

  test("run doctor --json queries remote run-observation route", async () => {
    const runId = "7eb1f79f-bbbb-4222-8333-abcdefabcdef";
    const record = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      if (url.pathname === `/v1/admin/runs/${runId}/observation`) {
        expect(url.search).toBe("?tail=5");
        return {
          ok: true,
          text: async () => JSON.stringify(makeRunObservationResult(record)),
          status: 200,
          statusText: "OK",
        };
      }
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}`);
      return {
        ok: true,
        text: async () => JSON.stringify(makeAdminWireRecord(record)),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "doctor",
      runId,
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
      "--tail",
      "5",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as RunObservationResult;
    expect(payload.schema_version).toBe("run-observation/v1");
    expect(payload.host_resources.gpu.status).toBe("available");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run doctor text tolerates older remote observation payloads without resource attribution", async () => {
    const runId = "7eb1f79f-cccc-4222-8333-abcdefabcdef";
    const record = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const observation = makeRunObservationResult(record);
    delete observation.resource_attribution;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}/observation`);
      return {
        ok: true,
        text: async () => JSON.stringify(observation),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "doctor",
      runId,
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
    ]);

    const rendered = String(out.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("resources: unavailable (daemon omitted run.resource_attribution/v1 payload)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run status --details resolves a unique short run prefix and surfaces pickup fields", async () => {
    const runId = "7eb1f79f-1111-4222-8333-abcdefabcdef";
    const record = makeRecord({
      state: "running",
      runId,
      issue: "POL-1405",
      host: "blade",
      backend: "codex",
      worktreePath: "/home/caleb/dev/calyx/wt/pol-1405",
      worktreeSource: "activity_inventory_cwd",
      branch: "calyx-run/pol-1405",
      artifactNames: ["summary.md", "receipt.json"],
    });
    let queriedRunId = "";
    const { deps } = buildRunCliDeps({
      getRunRecordById: async (id) => {
        queriedRunId = id;
        return id === runId ? record : undefined;
      },
      listRuns: [
        {
          run_id: runId,
          state: "running",
          summary: record.summary,
          created_at: record.created_at,
          updated_at: record.updated_at,
          host: "blade",
          issue: "POL-1405",
          backend: "codex",
          recovery_mode: "normal",
          run_dir: "/home/caleb/.calyx/runs/7eb1f79f-1111-4222-8333-abcdefabcdef",
        },
      ],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "run", "status", "7eb1f79f", "--details"]);

    expect(queriedRunId).toBe(runId);
    const joined = out.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("7eb1f79f running host=blade issue=POL-1405 backend=codex");
    expect(joined).toContain(`full_id: ${runId}`);
    expect(joined).toContain("worktree: /home/caleb/dev/calyx/wt/pol-1405");
    expect(joined).toContain("worktree_source: activity_inventory_cwd");
    expect(joined).toContain("branch: calyx-run/pol-1405");
    expect(joined).toContain("run_record: /home/caleb/.calyx/runs/7eb1f79f-1111-4222-8333-abcdefabcdef/run_record.json");
    expect(joined).toContain("artifacts: discovered=2 (summary.md, receipt.json)");
    expect(joined).toContain("next_logs: calyx run logs 7eb1f79f --host blade --tail 40");
  });

  test("run status preserves exact UUID lookup without listing runs", async () => {
    const runId = "7eb1f79f-1111-4222-8333-abcdefabcdef";
    const record = makeRecord({ state: "running", runId, issue: "POL-1405", host: "blade" });
    let queriedRunId = "";
    const { deps, listRunsSpy } = buildRunCliDeps({
      getRunRecordById: async (id) => {
        queriedRunId = id;
        return id === runId ? record : undefined;
      },
      listRuns: [
        {
          run_id: "7eb1f79f-2222-4222-8333-bbbbbbbbbbbb",
          state: "running",
          summary: "Different run.",
          created_at: "2026-05-14T12:00:00.000Z",
          updated_at: "2026-05-14T12:01:00.000Z",
          host: "worm",
          recovery_mode: "normal",
          run_dir: "/tmp/different-run",
        },
      ],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "run", "status", "--run-id", runId, "--details"]);

    expect(queriedRunId).toBe(runId);
    expect(listRunsSpy).not.toHaveBeenCalled();
    expect(String(out.mock.calls.at(-1)?.[0])).toContain(`next_status: calyx run status ${runId} --host blade --details`);
  });

  test("run status probes an exact canonical named id before bounded remote prefix resolution", async () => {
    const runId = "run-host-health-2";
    const record = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const requestedPaths: string[] = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      requestedPaths.push(`${url.pathname}${url.search}`);
      expect(url.pathname).toBe(`/v1/admin/runs/${runId}`);
      return new Response(JSON.stringify(makeAdminWireRecord(record)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "status",
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
      runId,
    ]);

    expect(requestedPaths).toEqual([
      `/v1/admin/runs/${runId}`,
      `/v1/admin/runs/${runId}`,
    ]);
    expect(requestedPaths).not.toContain("/v1/admin/runs");
    expect(String(out.mock.calls.at(-1)?.[0])).toContain(runId);
  });

  test("run status reports ambiguous and missing short run prefixes", async () => {
    const listRuns: RunListEntry[] = [
      {
        run_id: "7eb1f79f-1111-4222-8333-aaaaaaaaaaaa",
        state: "running",
        summary: "Run 7eb1f79f-1111-4222-8333-aaaaaaaaaaaa running.",
        created_at: "2026-05-14T12:00:00.000Z",
        updated_at: "2026-05-14T12:01:00.000Z",
        host: "blade",
        recovery_mode: "normal",
        run_dir: "/tmp/run-a",
      },
      {
        run_id: "7eb1f79f-2222-4222-8333-bbbbbbbbbbbb",
        state: "queued",
        summary: "Run 7eb1f79f-2222-4222-8333-bbbbbbbbbbbb queued.",
        created_at: "2026-05-14T12:00:00.000Z",
        updated_at: "2026-05-14T12:02:00.000Z",
        host: "worm",
        recovery_mode: "normal",
        run_dir: "/tmp/run-b",
      },
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      buildProgram({ runCli: buildRunCliDeps({ listRuns }).deps }).parseAsync([
        "node",
        "calyx",
        "run",
        "status",
        "7eb1f79f",
      ]),
    ).rejects.toThrow("ambiguous");

    await expect(
      buildProgram({ runCli: buildRunCliDeps({ listRuns }).deps }).parseAsync([
        "node",
        "calyx",
        "run",
        "status",
        "deadbeef",
      ]),
    ).rejects.toThrow('Run handle "deadbeef" not found among 2 known run(s).');
  });

  test("run status --host resolves host truth and queries the remote RunService", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-run-status-host-"));
    created.push(root);
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      [
        "hosts:",
        "  blade:",
        "    run_serve_url: http://blade.internal:8740",
        "    consumer_api_credentials:",
        "      - client_id: operator_cli",
        "        credential_tier: control_plane",
        "        verifier_env: CALYX_CONSUMER_API_TEST_OPERATOR_VERIFIER",
        "        token_env: CALYX_CONSUMER_API_TEST_OPERATOR_TOKEN",
        "        outbound: true",
        "        address_grants:",
        "          send_as: [client:operator_cli@blade]",
        "          read: [host:*]",
        "",
      ].join("\n"),
      "utf8",
    );
    const previousToken = process.env["CALYX_CONSUMER_API_TEST_OPERATOR_TOKEN"];
    process.env["CALYX_CONSUMER_API_TEST_OPERATOR_TOKEN"] = "secret-token";
    const runId = "7eb1f79f-3333-4222-8333-cccccccccccc";
    const record = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      if (url.pathname === "/v1/admin/runs/7eb1f79f") {
        return typedNotFoundResponse("exact run id not found");
      }
      if (url.pathname === "/v1/admin/runs") {
        expect(String(url)).toBe("http://blade.internal:8740/v1/admin/runs?host=blade&limit=100");
        return {
          ok: true,
          text: async () => JSON.stringify({
            schema_version: "calyx.run-list/v1",
            count: 1,
            truncated: false,
            runs: [
              {
                run_id: runId,
                state: "running",
                summary: record.summary,
                created_at: record.created_at,
                updated_at: record.updated_at,
                host: "blade",
                backend: "codex",
                recovery_mode: "normal",
                run_dir: "/home/caleb/.calyx/runs/7eb1f79f-3333-4222-8333-cccccccccccc",
              },
            ],
          }),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(`http://blade.internal:8740/v1/admin/runs/${runId}`);
      return {
        ok: true,
        text: async () => JSON.stringify(makeAdminWireRecord(record)),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy, agentsInfraRoot });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    try {
      await program.parseAsync(["node", "calyx", "run", "status", "--host", "blade", "7eb1f79f"]);
    } finally {
      if (previousToken === undefined) {
        delete process.env["CALYX_CONSUMER_API_TEST_OPERATOR_TOKEN"];
      } else {
        process.env["CALYX_CONSUMER_API_TEST_OPERATOR_TOKEN"] = previousToken;
      }
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(out.mock.calls.at(-1)?.[0])).toContain("host=blade");
  });

  test("run status resolves a unique remote prefix beyond the first run-list page", async () => {
    const runId = "7eb1f79f-3333-4222-8333-cccccccccccc";
    const record = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const firstPageRuns: RunListEntry[] = Array.from({ length: 50 }, (_value, index) => ({
      run_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      state: "succeeded",
      summary: `Recent run ${index} succeeded.`,
      created_at: "2026-05-15T12:00:00.000Z",
      updated_at: "2026-05-15T12:01:00.000Z",
      host: "blade",
      recovery_mode: "normal",
      run_dir: `/home/caleb/.calyx/runs/recent-${index}`,
    }));
    const listCursors: Array<string | null> = [];
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/runs/7eb1f79f") {
        return typedNotFoundResponse("exact run id not found");
      }
      if (url.pathname === "/v1/admin/runs") {
        const cursor = url.searchParams.get("cursor");
        listCursors.push(cursor);
        return new Response(JSON.stringify(cursor
          ? {
              schema_version: "calyx.run-list/v1",
              count: 1,
              truncated: false,
              runs: [{
                run_id: runId,
                state: "running",
                summary: record.summary,
                created_at: record.created_at,
                updated_at: record.updated_at,
                host: "blade",
                backend: "codex",
                recovery_mode: "normal",
                run_dir: `/home/caleb/.calyx/runs/${runId}`,
              }],
            }
          : {
              schema_version: "calyx.run-list/v1",
              count: firstPageRuns.length,
              truncated: true,
              next_cursor: "older-page",
              runs: firstPageRuns,
            }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(String(url)).toBe(`http://blade.internal:8740/v1/admin/runs/${runId}`);
      return new Response(JSON.stringify(makeAdminWireRecord(record)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "status",
      "--host",
      "blade",
      "--server-url",
      "http://blade.internal:8740",
      "--auth-token",
      "secret-token",
      "7eb1f79f",
    ]);

    expect(listCursors).toEqual([null, "older-page"]);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(String(out.mock.calls.at(-1)?.[0])).toContain(runId);
  });

  test("run status never resolves a named-host token for an origin-rebound URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-run-status-authority-"));
    created.push(root);
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts:\n  blade:\n    run_serve_url: https://blade.internal:8740\n",
      "utf8",
    );
    const tokenForHost = vi.fn(() => "ambient-operator-token");
    const fetchSpy = vi.fn();
    const { deps } = buildRunCliDeps({ fetchSpy, agentsInfraRoot, tokenForHost });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node", "calyx", "run", "status",
      "7eb1f79f-3333-4222-8333-cccccccccccc",
      "--host", "blade",
      "--server-url", "https://attacker.example:8740",
      "--json",
    ])).rejects.toThrow(/require --auth-token/);
    expect(tokenForHost).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("run status --host uses host truth even when the alias matches the current machine", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-run-status-current-host-"));
    created.push(root);
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    const currentHost = hostname().trim().toLowerCase().replace(/\..*$/, "") || "local";
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      [
        "hosts:",
        `  ${currentHost}:`,
        "    run_serve_url: http://current-host.internal:8740",
        "    consumer_api_credentials:",
        "      - client_id: operator_cli",
        "        credential_tier: control_plane",
        "        verifier_env: CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_VERIFIER",
        "        token_env: CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_TOKEN",
        "        outbound: true",
        "        address_grants:",
        `          send_as: [client:operator_cli@${currentHost}]`,
        "          read: [host:*]",
        "",
      ].join("\n"),
      "utf8",
    );
    const previousToken = process.env["CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_TOKEN"];
    process.env["CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_TOKEN"] = "secret-token";
    const runId = "7eb1f79f-9999-4222-8333-eeeeeeeeeeee";
    const record = makeRecord({ state: "running", runId, host: currentHost, backend: "codex" });
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
      expect(String(url)).toBe(`http://current-host.internal:8740/v1/admin/runs/${runId}`);
      return {
        ok: true,
        text: async () => JSON.stringify(makeAdminWireRecord(record)),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy, agentsInfraRoot });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    try {
      await program.parseAsync(["node", "calyx", "run", "status", "--host", currentHost, runId]);
    } finally {
      if (previousToken === undefined) {
        delete process.env["CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_TOKEN"];
      } else {
        process.env["CALYX_CONSUMER_API_TEST_CURRENT_OPERATOR_TOKEN"] = previousToken;
      }
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["running", false, false],
    ["succeeded", true, true],
    ["completed_dirty", true, true],
    ["failed", true, false],
  ] as const)("run status --json projects %s terminal=%s successful=%s", async (state, terminal, successful) => {
    const runId = "7eb1f79f-a111-4222-8333-eeeeeeeeeeee";
    const { deps } = buildRunCliDeps({ getRunRecord: makeRecord({ state, runId }) });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId, "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      terminal: boolean;
      successful: boolean;
    };
    expect(payload).toMatchObject({
      schema_version: "calyx.run-status/v2",
      terminal,
      successful,
    });
  });

  test("run status keeps maximum-length canonical identifiers exact and rejects invalid identifiers", async () => {
    const validRunId = `r${"a".repeat(255)}`;
    const validOut = vi.spyOn(console, "log").mockImplementation(() => {});
    await buildProgram({
      runCli: buildRunCliDeps({
        getRunRecord: makeRecord({ state: "running", runId: validRunId }),
      }).deps,
    }).parseAsync([
      "node", "calyx", "run", "status", validRunId, "--json",
    ]);

    const payload = JSON.parse(String(validOut.mock.calls.at(-1)?.[0]));
    expect(payload.run_id).toBe(validRunId);
    expect(payload.continuation.selector.run_id).toBe(validRunId);
    expect(payload.response_economics.overflow).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: expect.stringContaining("run_id") }),
    ]));

    validOut.mockClear();
    const invalidRunId = `r${"a".repeat(256)}`;
    await expect(buildProgram({
      runCli: buildRunCliDeps({
        getRunRecord: makeRecord({ state: "running", runId: invalidRunId }),
      }).deps,
    }).parseAsync([
      "node", "calyx", "run", "status", invalidRunId, "--json",
    ])).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining("invalid canonical run_id"),
    });
    expect(validOut).not.toHaveBeenCalled();
  });

  test("run status --json stays compact and decision-first regardless of stored detail size", async () => {
    const runId = "7eb1f79f-a1a1-4222-8333-eeeeeeeeeeee";
    const largeDetail = "detail-".repeat(40_000);
    const record = makeRecord({
      state: "partial",
      runId,
      issue: "POL-2069",
      host: "blade",
      backend: "claude",
      artifactNames: Array.from({ length: 2_000 }, (_value, index) => `artifact-${index}.json`),
    });
    if (
      !record.spec
      || record.spec.kernel !== "agent_runner"
      || !record.kernel_receipt
      || "kernel" in record.kernel_receipt
    ) {
      throw new Error("expected resolved agent-runner record");
    }
    Object.assign(record.spec, {
      prompt: largeDetail,
      resolution_log: Array.from({ length: 1_000 }, (_value, index) => ({
        name: `large-detail-${index}`,
        status: "resolved" as const,
        detail: largeDetail,
      })),
    });
    record.kernel_receipt.run_spec.prompt = largeDetail;
    record.kernel_receipt.summary = largeDetail;
    record.kernel_receipt.agent_terminal_message = largeDetail;
    record.kernel_receipt.exit.partial_reason = "budget_exhaustion";
    record.kernel_receipt.terminal_evidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "session_fallback",
      status: "authoritative",
      reason: "provider_capacity_exhausted",
      provider_constraint: {
        schema_version: "calyx.provider-constraint/v1",
        cause: "provider_capacity_exhausted",
        backend: "claude",
        kind: "session_window",
        source: "session_transcript",
        observed_at: "2026-07-21T07:06:08.573Z",
        confidence: "definitive",
        reset_hint: "resets 8:10am (UTC)",
      },
    };
    record.health = {
      source: "agent_runner",
      status: "stale",
      checked_at: "2026-07-21T07:06:09.000Z",
      stale_after_ms: 30_000,
      last_progress_at: "2026-07-21T07:00:00.000Z",
      observations: Array.from({ length: 1_000 }, (_value, index) => ({
        kind: "stdout" as const,
        label: `${index}-${largeDetail}`,
        path: `/tmp/${largeDetail}`,
        exists: true,
      })),
      progress_signal: {
        source: "claude_stream",
        status: "unavailable",
        reason: "no_structured_events",
      },
      summary: largeDetail,
    };
    record.summary = largeDetail;

    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId, "--json",
    ]);

    const raw = String(out.mock.calls.at(-1)?.[0]);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(4_096);
    expect(raw).not.toContain("\n");
    expect(raw.indexOf('"state":"partial"')).toBeLessThan(160);
    expect(raw.indexOf('"cause":{"category":"provider_constraint"')).toBeLessThan(256);
    expect(raw.indexOf('"partial_reason":"budget_exhaustion"')).toBeLessThan(512);
    expect(raw.indexOf('"next_action":')).toBeLessThan(640);
    expect(raw.indexOf('"diagnostics":')).toBeGreaterThan(raw.indexOf('"next_action":'));
    expect(payload).not.toHaveProperty("intent");
    expect(payload).not.toHaveProperty("launch");
    expect(payload).not.toHaveProperty("spec");
    expect(payload).not.toHaveProperty("kernel_receipt");
    expect(payload).not.toHaveProperty("integrations");
    expect(payload).not.toHaveProperty("recovery");
    expect(payload).not.toHaveProperty("summary");
    expect(payload).not.toHaveProperty("infra_error_classification");
    expect(payload).toMatchObject({
      schema_version: "calyx.run-status/v2",
      run_id: runId,
      state: "partial",
      terminal: true,
      successful: false,
      cause: {
        category: "provider_constraint",
        reason: "provider_capacity_exhausted",
        backend: "claude",
        constraint_kind: "session_window",
      },
      partial_reason: "budget_exhaustion",
      diagnostics: {
        provider_constraint: {
          cause: "provider_capacity_exhausted",
          kind: "session_window",
        },
      },
      health: {
        status: "stale",
        checked_at: "2026-07-21T07:06:09.000Z",
      },
      artifacts: {
        discovered: 2_000,
        required: 0,
        missing: 0,
      },
    });

    out.mockClear();
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
    ]);
    const text = String(out.mock.calls.at(-1)?.[0]);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(text).toContain("next_action: run.receipt reason=run_terminal");
    expect(text.split("\n").slice(2, 5)).toEqual([
      "  cause: provider_constraint/provider_capacity_exhausted",
      "  partial_reason: budget_exhaustion",
      "  next_action: run.receipt reason=run_terminal",
    ]);
    expect(Buffer.byteLength(text.slice(0, text.indexOf("  next_action:")), "utf8")).toBeLessThan(512);
    expect(text).not.toContain("detail-detail-detail");
    expect(text).not.toContain("artifact-0.json");
    expect(text).not.toContain("run_record.json");
    expect(text).not.toContain("agent_terminal_message");
  });

  test("run status and run await share bounded outcome facts and truncate included failure text", async () => {
    const runId = "7eb1f79f-a1c1-4222-8333-eeeeeeeeeeee";
    const record = makeRecord({
      state: "failed",
      runId,
      host: "blade",
      backend: "codex",
      exitCode: 77,
      spawnError: "spawn-".repeat(10_000),
    });
    record.summary = "failure-".repeat(10_000);
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId, "--json",
    ]);
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--json",
    ]);

    const statusRaw = String(out.mock.calls.at(-2)?.[0]);
    const awaitRaw = String(out.mock.calls.at(-1)?.[0]);
    const statusPayload = JSON.parse(statusRaw);
    const awaitPayload = JSON.parse(awaitRaw);
    expect(Buffer.byteLength(statusRaw, "utf8")).toBeLessThanOrEqual(4_096);
    expect(Buffer.byteLength(awaitRaw, "utf8")).toBeLessThanOrEqual(4_096);
    expect(statusRaw).not.toContain("\n");
    expect(awaitRaw).not.toContain("\n");
    expect(awaitPayload).not.toHaveProperty("spec");
    expect(awaitPayload).not.toHaveProperty("kernel_receipt");
    expect(statusPayload.cause).toEqual({ category: "terminal", reason: "failed" });
    expect(statusPayload.cause).toEqual(awaitPayload.cause);
    expect(statusPayload.partial_reason).toBeNull();
    expect(statusPayload.partial_reason).toEqual(awaitPayload.partial_reason);
    expect(statusPayload.diagnostics).toEqual(awaitPayload.diagnostics);
    expect(statusPayload.health).toEqual(awaitPayload.health);
    expect(statusPayload.artifacts).toEqual(awaitPayload.artifacts);
    expect(statusPayload.next_action).toEqual(awaitPayload.next_action);
    expect(statusPayload.continuation).toEqual(awaitPayload.continuation);
    expect(statusPayload.response_economics).toEqual(awaitPayload.response_economics);
    for (const raw of [statusRaw, awaitRaw]) {
      expect(raw.indexOf('"cause":{"category":"terminal","reason":"failed"}')).toBeLessThan(256);
      expect(raw.indexOf('"partial_reason":null')).toBeLessThan(384);
      expect(raw.indexOf('"next_action":')).toBeLessThan(512);
      expect(raw.indexOf('"diagnostics":')).toBeGreaterThan(raw.indexOf('"next_action":'));
    }
    expect(statusPayload.diagnostics.failure).toMatchObject({
      summary_truncated: true,
      exit_code: 77,
      spawn_error_truncated: true,
    });
    expect(Buffer.byteLength(statusPayload.diagnostics.failure.summary, "utf8")).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(statusPayload.diagnostics.failure.spawn_error, "utf8")).toBeLessThanOrEqual(256);
    expect(statusPayload.response_economics.overflow).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "diagnostics.failure.summary", disposition: "truncated" }),
      expect.objectContaining({ field: "diagnostics.failure.spawn_error", disposition: "truncated" }),
    ]));
    expect(statusPayload.response_economics.overflow).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "diagnostics.infra_error.message" }),
    ]));
    expect(statusPayload.continuation.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "run.status", details: true }),
      expect.objectContaining({ operation: "run.receipt", format: "json" }),
      expect.objectContaining({ operation: "run.kernel-receipt", format: "json" }),
    ]));
  });

  test("run status preserves long accepted addressing once in typed continuation and bounds external metadata", async () => {
    const runId = "7eb1f79f-a1d1-4222-8333-eeeeeeeeeeee";
    const serverUrl = `http://blade.internal:8740/${"e".repeat(4_000)}`;
    const runsRoot = `/${"r".repeat(4_000)}`;
    const longHost = "host-".repeat(120);
    const longIssue = "POL-2069-".repeat(100);
    const record = makeRecord({
      state: "failed",
      runId,
      host: longHost,
      issue: longIssue,
      backend: "codex",
      exitCode: 77,
      spawnError: "spawn-".repeat(1_000),
    });
    record.summary = "failure-".repeat(1_000);
    if (!record.kernel_receipt || "kernel" in record.kernel_receipt) {
      throw new Error("expected agent-runner receipt");
    }
    record.kernel_receipt.terminal_evidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "session_fallback",
      status: "authoritative",
      reason: "backend_failure",
      backend_subtype: "subtype-".repeat(100),
      backend_terminal_reason: "terminal-".repeat(100),
      backend_stop_reason: "stop-".repeat(100),
      session_id: "session-".repeat(100),
      signal: "signal-".repeat(100),
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(makeAdminWireRecord(record)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
      "--host", "blade",
      "--server-url", serverUrl,
      "--runs-root", runsRoot,
      "--auth-token", "secret-token",
      "--json",
    ]);

    const raw = String(out.mock.calls.at(-1)?.[0]);
    const payload = JSON.parse(raw);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(4_096);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(16_384);
    expect(payload.host).toHaveLength(256);
    expect(payload.issue).toHaveLength(256);
    expect(payload).not.toHaveProperty("pointers");
    expect(payload.continuation).toMatchObject({
      selector: { kind: "run_id", run_id: runId },
      scope: {
        host: "blade",
        server_url: serverUrl,
        runs_root: runsRoot,
        authentication: "required_not_embedded",
      },
    });
    expect(payload.response_economics).toMatchObject({
      formats: {
        text: { target_bytes: 1_024, hard_bytes: 4_096 },
        json: { target_bytes: 4_096, hard_bytes: 16_384 },
      },
      overflow: expect.arrayContaining([
        expect.objectContaining({ field: "host", disposition: "truncated" }),
        expect.objectContaining({ field: "issue", disposition: "truncated" }),
      ]),
    });
    expect(raw).not.toContain("secret-token");

    out.mockClear();
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
      "--host", "blade",
      "--server-url", serverUrl,
      "--runs-root", runsRoot,
      "--auth-token", "secret-token",
    ]);
    const defaultText = String(out.mock.calls.at(-1)?.[0]);
    expect(Buffer.byteLength(defaultText, "utf8")).toBeLessThanOrEqual(4_096);
    expect(defaultText).not.toContain(serverUrl);
    expect(defaultText).not.toContain(runsRoot);

    out.mockClear();
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
      "--host", "blade",
      "--server-url", serverUrl,
      "--runs-root", runsRoot,
      "--auth-token", "secret-token",
      "--details",
    ]);
    const details = String(out.mock.calls.at(-1)?.[0]);
    expect(details).toContain(
      `next_status: calyx run status ${runId} --host blade --server-url ${serverUrl}`
      + ` --runs-root ${runsRoot} --details`,
    );
    expect(details).not.toContain("secret-token");
  });

  test("run await composes maximum exact and bounded fields within the JSON hard budget", async () => {
    const runId = "7eb1f79f-a1f1-4222-8333-eeeeeeeeeeee";
    const exactAsciiAddress = (prefix: string): string => (
      prefix + "x".repeat(4_096 - Buffer.byteLength(prefix, "utf8"))
    );
    const serverUrl = exactAsciiAddress("http://blade.internal:8740/");
    const runsRoot = exactAsciiAddress("/");
    const boundedUnicode = "😀".repeat(64);
    const escapedSchemaMaximum = "\u0000".repeat(64);
    const escapedUnbounded = "\u0000".repeat(1_000);
    const longTimestamp = `2026-07-21T07:06:08.${"1".repeat(12_000)}Z`;
    const running = makeRecord({
      state: "running",
      runId,
      host: boundedUnicode,
      issue: boundedUnicode,
      backend: "claude",
    });
    const terminal = makeRecord({
      state: "partial",
      runId,
      host: boundedUnicode,
      issue: boundedUnicode,
      backend: "claude",
    });
    for (const record of [running, terminal]) {
      record.created_at = longTimestamp;
      record.updated_at = longTimestamp;
    }
    terminal.completed_at = longTimestamp;
    if (!terminal.kernel_receipt || "kernel" in terminal.kernel_receipt) {
      throw new Error("expected agent-runner receipt");
    }
    terminal.kernel_receipt.exit.partial_reason = "budget_exhaustion";
    terminal.kernel_receipt.terminal_evidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "session_fallback",
      status: "authoritative",
      reason: "provider_capacity_exhausted",
      backend_subtype: escapedUnbounded,
      backend_terminal_reason: escapedUnbounded,
      backend_stop_reason: escapedUnbounded,
      session_id: escapedUnbounded,
      signal: escapedUnbounded,
      provider_constraint: {
        schema_version: "calyx.provider-constraint/v1",
        cause: "provider_capacity_exhausted",
        backend: escapedSchemaMaximum,
        kind: "weekly_limit",
        source: "session_transcript",
        observed_at: longTimestamp,
        confidence: "definitive",
        provider_code: "c".repeat(64),
        http_status: 429,
        reset_hint: "\u0000".repeat(256),
      },
    };
    terminal.health = {
      source: "agent_runner",
      status: "stale",
      checked_at: longTimestamp,
      stale_after_ms: 30_000,
      last_progress_at: longTimestamp,
      observations: [],
      progress_signal: {
        source: "claude_stream",
        status: "unavailable",
        reason: "no_structured_events",
        expected_silence_until: longTimestamp,
      },
      summary: "health fixture",
    };
    const event = makeTerminalStreamEvent(terminal);
    event.event_id = "e".repeat(512);
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith(`/v1/admin/runs/${runId}`)) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 3 ? running : terminal)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--server-url", serverUrl,
      "--runs-root", runsRoot,
      "--auth-token", "secret-token",
      "--json",
    ]);

    const raw = String(out.mock.calls.at(-1)?.[0]);
    const payload = JSON.parse(raw);
    expect(Buffer.byteLength(serverUrl, "utf8")).toBe(4_096);
    expect(Buffer.byteLength(runsRoot, "utf8")).toBe(4_096);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(16_384);
    expect(payload).toMatchObject({
      schema_version: "calyx.run-await/v2",
      state: "partial",
      cause: {
        category: "provider_constraint",
        constraint_kind: "weekly_limit",
      },
      partial_reason: "budget_exhaustion",
      host: boundedUnicode,
      issue: boundedUnicode,
      continuation: {
        scope: {
          host: boundedUnicode,
          server_url: serverUrl,
          runs_root: runsRoot,
          authentication: "required_not_embedded",
        },
      },
      diagnostics: {
        terminal_evidence: {
          source: "session_fallback",
          status: "authoritative",
          reason: "provider_capacity_exhausted",
        },
        provider_constraint: {
          kind: "weekly_limit",
          observed_at: "2026-07-21T07:06:08.111Z",
          provider_code: "c".repeat(64),
          http_status: 429,
          reset_hint_truncated: true,
        },
      },
      created_at: "2026-07-21T07:06:08.111Z",
      updated_at: "2026-07-21T07:06:08.111Z",
      completed_at: "2026-07-21T07:06:08.111Z",
      health: {
        checked_at: "2026-07-21T07:06:08.111Z",
        last_progress_at: "2026-07-21T07:06:08.111Z",
        progress_signal: {
          expected_silence_until: "2026-07-21T07:06:08.111Z",
        },
      },
      last_event: {
        cursor: event.cursor,
        event_id: event.event_id,
      },
    });
    expect(payload.cause.backend).toBe(payload.diagnostics.provider_constraint.backend);
    for (const field of [
      payload.cause.backend,
      payload.diagnostics.provider_constraint.backend,
      payload.diagnostics.provider_constraint.reset_hint,
      payload.diagnostics.terminal_evidence.backend_subtype,
      payload.diagnostics.terminal_evidence.backend_terminal_reason,
      payload.diagnostics.terminal_evidence.backend_stop_reason,
      payload.diagnostics.terminal_evidence.session_id,
      payload.diagnostics.terminal_evidence.signal,
    ]) {
      expect(Buffer.byteLength(JSON.stringify(field), "utf8") - 2).toBeLessThanOrEqual(256);
    }
    expect(payload.response_economics.overflow).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "diagnostics.provider_constraint.backend",
        disposition: "truncated",
      }),
      expect.objectContaining({
        field: "diagnostics.provider_constraint.reset_hint",
        disposition: "truncated",
      }),
      expect.objectContaining({
        field: "diagnostics.terminal_evidence.backend_subtype",
        disposition: "truncated",
      }),
    ]));
    expect(raw).not.toContain("secret-token");
    expect(statusReads).toBe(3);

    out.mockClear();
    const { deps } = buildRunCliDeps({ getRunRecord: terminal });
    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
    ]);
    const text = String(out.mock.calls.at(-1)?.[0]);
    const nextActionOffset = text.indexOf("  next_action:");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(4_096);
    expect(nextActionOffset).toBeGreaterThan(0);
    expect(Buffer.byteLength(text.slice(0, nextActionOffset), "utf8")).toBeLessThan(512);
    expect(nextActionOffset).toBeLessThan(text.indexOf("  host="));
    expect(nextActionOffset).toBeLessThan(text.indexOf("  provider_constraint:"));
    expect(text).not.toContain("\u0000");
    expect(text).toContain("\\u0000");
  });

  test.each([
    ["status", "--host", "路".repeat(86), 256],
    ["status", "--server-url", `http://blade.internal:8740/${"e".repeat(4_000)}${"😀".repeat(20)}`, 4_096],
    ["status", "--runs-root", `/${"r".repeat(3_900)}${"路".repeat(70)}`, 4_096],
    ["await", "--host", "路".repeat(86), 256],
    ["await", "--server-url", `http://blade.internal:8740/${"e".repeat(4_000)}${"😀".repeat(20)}`, 4_096],
    ["await", "--runs-root", `/${"r".repeat(3_900)}${"路".repeat(70)}`, 4_096],
  ] as const)("run %s rejects over-budget multibyte %s before any read", async (
    command,
    option,
    value,
    maximumBytes,
  ) => {
    const runId = "7eb1f79f-a1e1-4222-8333-eeeeeeeeeeee";
    expect(value.length).toBeLessThanOrEqual(maximumBytes);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8") - 2).toBeGreaterThan(maximumBytes);
    const fetchSpy = vi.fn();
    const { deps, getRunRecordSpy, listRunsSpy } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", command, runId,
      ...(option === "--runs-root" ? ["--server-url", "http://blade.internal:8740"] : []),
      option, value,
      "--json",
    ])).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining(`${option} exceeds the ${maximumBytes}-byte exact continuation limit`),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getRunRecordSpy).not.toHaveBeenCalled();
    expect(listRunsSpy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  test("run status text renders the bounded provider constraint", async () => {
    const runId = "7eb1f79f-a1b1-4222-8333-eeeeeeeeeeee";
    const record = makeRecord({ state: "partial", runId, host: "blade", backend: "claude" });
    if (!record.kernel_receipt || "kernel" in record.kernel_receipt) {
      throw new Error("expected agent-runner receipt");
    }
    record.kernel_receipt.exit.partial_reason = "budget_exhaustion";
    record.kernel_receipt.terminal_evidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "session_fallback",
      status: "authoritative",
      reason: "provider_capacity_exhausted",
      provider_constraint: {
        schema_version: "calyx.provider-constraint/v1",
        cause: "provider_capacity_exhausted",
        backend: "claude",
        kind: "session_window",
        source: "session_transcript",
        observed_at: "2026-07-21T07:06:08.573Z",
        confidence: "definitive",
        reset_hint: "resets 8:10am (UTC)",
      },
    };
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "status", runId,
    ]);

    const text = String(out.mock.calls.at(-1)?.[0]);
    expect(text).toContain(
      "provider_constraint: cause=provider_capacity_exhausted backend=claude kind=session_window source=session_transcript",
    );
    expect(text).toContain("provider_reset: resets 8:10am (UTC)");
    expect(text).not.toContain("You've hit");
  });

  test.each([
    "succeeded",
    "failed",
    "partial",
    "cancelled",
    "auth_error",
    "infra_error",
    "completed_dirty",
  ] as const)("run await returns immediately for canonical terminal state %s", async (state) => {
    const runId = "7eb1f79f-a222-4222-8333-eeeeeeeeeeee";
    const watchRunChanges = vi.fn();
    const { deps, launchSpy, stopSpy } = buildRunCliDeps({
      getRunRecord: makeRecord({ state, runId }),
      watchRunChanges,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema_version: "calyx.run-await/v2",
      run_id: runId,
      state,
      terminal: true,
      successful: state === "succeeded" || state === "completed_dirty",
      timed_out: false,
    });
    expect(watchRunChanges).not.toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("run await resolves a unique short prefix before observing terminality", async () => {
    const runId = "7eb1f79f-a2a2-4222-8333-eeeeeeeeeeee";
    const record = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    const { deps } = buildRunCliDeps({
      getRunRecordById: async (candidate) => candidate === runId ? record : undefined,
      listRuns: [{
        run_id: runId,
        state: record.state,
        summary: record.summary,
        created_at: record.created_at,
        updated_at: record.updated_at,
        host: "blade",
        backend: "codex",
        recovery_mode: "normal",
        run_dir: `/tmp/${runId}`,
      }],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", "7eb1f79f", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      run_id: runId,
      short_id: "7eb1f79f",
      terminal: true,
      successful: true,
    });
  });

  test.each([
    ["succeeded", 0],
    ["completed_dirty", 0],
    ["failed", 1],
    ["cancelled", 1],
    ["partial", 2],
    ["infra_error", 6],
    ["auth_error", 8],
  ] as const)("run await --require-success maps %s to stable exit %i after JSON", async (state, exitCode) => {
    const runId = "7eb1f79f-a333-4222-8333-eeeeeeeeeeee";
    const { deps } = buildRunCliDeps({
      getRunRecord: makeRecord({
        state,
        runId,
        ...(state === "failed" ? { exitCode: 77 } : {}),
      }),
    });
    const exitCodeAtWrite: Array<number | string | null | undefined> = [];
    const out = vi.spyOn(console, "log").mockImplementation(() => {
      exitCodeAtWrite.push(process.exitCode);
    });

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--require-success", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ state, terminal: true });
    expect(exitCodeAtWrite).toEqual([undefined]);
    expect(process.exitCode).toBe(exitCode === 0 ? undefined : exitCode);
  });

  test("run await carries decisive cause and stable continuation operations", async () => {
    const runId = "7eb1f79f-a444-4222-8333-eeeeeeeeeeee";
    const record = makeRecord({ state: "partial", runId, host: "blade", backend: "codex" });
    if (!record.kernel_receipt || "kernel" in record.kernel_receipt) {
      throw new Error("expected agent-runner receipt");
    }
    record.kernel_receipt.exit.partial_reason = "budget_exhaustion";
    record.kernel_receipt.terminal_evidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "session_fallback",
      status: "authoritative",
      reason: "provider_capacity_exhausted",
      provider_constraint: {
        schema_version: "calyx.provider-constraint/v1",
        cause: "provider_capacity_exhausted",
        backend: "codex",
        kind: "credits",
        source: "session_transcript",
        observed_at: "2026-07-12T00:00:32.393Z",
        confidence: "definitive",
        reset_hint: "try again at Jul 18th, 2026 2:33 AM",
      },
    };
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(payload.cause).toEqual({
      category: "provider_constraint",
      reason: "provider_capacity_exhausted",
      backend: "codex",
      constraint_kind: "credits",
    });
    expect(payload.partial_reason).toBe("budget_exhaustion");
    expect(payload.diagnostics).toEqual({
      terminal_evidence: {
        source: "session_fallback",
        status: "authoritative",
        reason: "provider_capacity_exhausted",
      },
      provider_constraint: record.kernel_receipt.terminal_evidence.provider_constraint,
    });
    expect(payload).not.toHaveProperty("pointers");
    expect(payload).not.toHaveProperty("commands");
    expect(payload.next_action).toEqual({
      operation: "run.receipt",
      reason: "run_terminal",
    });
    expect(payload.continuation).toMatchObject({
      selector: { kind: "run_id", run_id: runId },
      scope: { host: "blade", authentication: "ambient" },
      operations: expect.arrayContaining([
        expect.objectContaining({ operation: "run.status", format: "json" }),
        expect.objectContaining({ operation: "run.logs", tail: 40 }),
        expect.objectContaining({ operation: "run.receipt", format: "json" }),
        expect.objectContaining({ operation: "run.subscribe", event_type: "run.terminal" }),
      ]),
    });
  });

  test("run await closes the local status-to-watcher race with an immediate reread", async () => {
    const runId = "7eb1f79f-a555-4222-8333-eeeeeeeeeeee";
    let record = makeRecord({ state: "running", runId });
    const close = vi.fn();
    const watchRunChanges = vi.fn(() => {
      record = makeRecord({ state: "succeeded", runId });
      return close;
    });
    const { deps, stopSpy } = buildRunCliDeps({
      getRunRecordById: async () => record,
      watchRunChanges,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: "succeeded",
      terminal: true,
      timed_out: false,
    });
    expect(watchRunChanges).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("run await timeout emits the final canonical state and never mutates the run", async () => {
    const runId = "7eb1f79f-a666-4222-8333-eeeeeeeeeeee";
    const close = vi.fn();
    const { deps, launchSpy, stopSpy } = buildRunCliDeps({
      getRunRecord: makeRecord({ state: "running", runId }),
      watchRunChanges: vi.fn(() => close),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--timeout", "1ms", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: "running",
      terminal: false,
      successful: false,
      timed_out: true,
    });
    expect(process.exitCode).toBe(124);
    expect(close).toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("run await Ctrl-C ends observation with exit 130 and never mutates the run", async () => {
    const runId = "7eb1f79f-a777-4222-8333-eeeeeeeeeeee";
    const close = vi.fn();
    const { deps, launchSpy, stopSpy } = buildRunCliDeps({
      getRunRecord: makeRecord({ state: "running", runId }),
      watchRunChanges: vi.fn(() => {
        setImmediate(() => process.emit("SIGINT"));
        return close;
      }),
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId, "--json",
    ]);

    expect(out).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
    expect(close).toHaveBeenCalled();
    expect(launchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test.each(["0s", "1.5s", "5", "forever"])("run await rejects invalid finite duration %s", async (timeout) => {
    const runId = "7eb1f79f-a888-4222-8333-eeeeeeeeeeee";
    await expect(buildProgram({
      runCli: buildRunCliDeps({ getRunRecord: makeRecord({ state: "running", runId }) }).deps,
    }).parseAsync([
      "node", "calyx", "run", "await", runId, "--timeout", timeout,
    ])).rejects.toThrow(/timeout|duration/u);
  });

  test("run await remote boundary reread closes the initial status-to-stream race", async () => {
    const runId = "7eb1f79f-a999-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const succeeded = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads === 1 ? running : succeeded)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url.pathname).toBe("/v1/admin/events/stream");
      expect(url.searchParams.get("run_id")).toBe(runId);
      expect(url.searchParams.get("event_type")).toBe("run.terminal");
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: "succeeded",
      terminal: true,
      timed_out: false,
    });
    expect(statusReads).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test("run await remote terminal event rereads authority and reports event evidence", async () => {
    const runId = "7eb1f79f-b111-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const succeeded = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    const event = makeTerminalStreamEvent(succeeded);
    event.event_id = "event-".repeat(120);
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 3 ? running : succeeded)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(payload).toMatchObject({
      state: "succeeded",
      last_event: {
        cursor: event.cursor,
        event_id: event.event_id.slice(0, 512),
      },
      response_economics: {
        overflow: expect.arrayContaining([
          expect.objectContaining({ field: "last_event.event_id", disposition: "truncated" }),
        ]),
      },
    });
    expect(statusReads).toBe(3);
  });

  test("run await reconciles canonical status after a remote stream disconnect", async () => {
    const runId = "7eb1f79f-b222-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const succeeded = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 3 ? running : succeeded)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ state: "succeeded" });
    expect(statusReads).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test("run await reconnects a remote stream from its validated cursor", async () => {
    const runId = "7eb1f79f-b333-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const succeeded = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    const event = makeTerminalStreamEvent(succeeded);
    let statusReads = 0;
    let streamReads = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 5 ? running : succeeded)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      streamReads += 1;
      if (streamReads === 2) {
        expect(url.searchParams.get("after")).toBe(event.cursor);
        expect(new Headers(init?.headers).get("last-event-id")).toBe(event.cursor);
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ state: "succeeded" });
    expect(statusReads).toBe(5);
    expect(streamReads).toBe(2);
  });

  test("run await absolute timeout aborts an in-flight remote status reconciliation", async () => {
    const runId = "7eb1f79f-b444-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        if (statusReads === 1) {
          return new Response(JSON.stringify(makeAdminWireRecord(running)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal!.addEventListener("abort", () => {
            reject(signal!.reason);
          }, { once: true });
        });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { deps, launchSpy, stopSpy } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token",
      "--timeout", "25ms", "--require-success", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: "running",
      terminal: false,
      successful: false,
      timed_out: true,
    });
    expect(statusReads).toBe(2);
    expect(process.exitCode).toBe(124);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("run await Ctrl-C aborts an in-flight remote status reconciliation without output", async () => {
    const runId = "7eb1f79f-b555-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    let statusReads = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        if (statusReads === 1) {
          return new Response(JSON.stringify(makeAdminWireRecord(running)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        setImmediate(() => process.emit("SIGINT"));
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal!.addEventListener("abort", () => {
            reject(signal!.reason);
          }, { once: true });
        });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { deps, launchSpy, stopSpy } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    expect(out).not.toHaveBeenCalled();
    expect(statusReads).toBe(2);
    expect(process.exitCode).toBe(130);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("run await retains lagged terminal event evidence across a transient status outage and cursor reconnect", async () => {
    const runId = "7eb1f79f-b666-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const succeeded = makeRecord({ state: "succeeded", runId, host: "blade", backend: "codex" });
    const event = makeTerminalStreamEvent(succeeded);
    let statusReads = 0;
    let streamReads = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        if (statusReads === 4) throw new TypeError("temporary status socket reset");
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 5 ? running : succeeded)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      streamReads += 1;
      if (streamReads === 2) {
        expect(url.searchParams.get("after")).toBe(event.cursor);
        expect(new Headers(init?.headers).get("last-event-id")).toBe(event.cursor);
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token", "--json",
    ]);

    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({
      state: "succeeded",
      terminal: true,
      last_event: { cursor: event.cursor, event_id: event.event_id },
    });
    expect(statusReads).toBe(5);
    expect(streamReads).toBe(1);
  });

  test("run await deduplicates a replayed terminal event while authority lags and emits JSON before failure exit", async () => {
    const runId = "7eb1f79f-b777-4222-8333-eeeeeeeeeeee";
    const running = makeRecord({ state: "running", runId, host: "blade", backend: "codex" });
    const failed = makeRecord({ state: "failed", runId, host: "blade", backend: "codex", exitCode: 77 });
    const event = makeTerminalStreamEvent(failed);
    let statusReads = 0;
    let streamReads = 0;
    const fetchSpy = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.pathname === `/v1/admin/runs/${runId}`) {
        statusReads += 1;
        return new Response(JSON.stringify(makeAdminWireRecord(statusReads < 6 ? running : failed)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      streamReads += 1;
      if (streamReads === 2) {
        expect(url.searchParams.get("after")).toBe(event.cursor);
        expect(new Headers(init?.headers).get("last-event-id")).toBe(event.cursor);
      }
      return new Response(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCodeAtWrite: Array<number | string | null | undefined> = [];
    const out = vi.spyOn(console, "log").mockImplementation(() => {
      exitCodeAtWrite.push(process.exitCode);
    });

    await buildProgram({ runCli: buildRunCliDeps({ fetchSpy }).deps }).parseAsync([
      "node", "calyx", "run", "await", runId,
      "--host", "blade", "--server-url", "http://blade.internal:8740", "--auth-token", "secret-token",
      "--require-success", "--json",
    ]);

    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      state: "failed",
      terminal: true,
      successful: false,
      timed_out: false,
      last_event: { cursor: event.cursor, event_id: event.event_id },
    });
    expect(exitCodeAtWrite).toEqual([undefined]);
    expect(statusReads).toBe(6);
    expect(streamReads).toBe(2);
    expect(process.exitCode).toBe(1);
  });

  test("run receipt text surfaces pickup fields", async () => {
    const record = makeRecord({
      state: "succeeded",
      runId: "7eb1f79f-4444-4222-8333-dddddddddddd",
      issue: "POL-1405",
      host: "blade",
      backend: "claude",
      worktreePath: "/home/caleb/dev/calyx/wt/pol-1405",
      branch: "calyx-run/pol-1405",
      artifactNames: ["operator-report.md"],
    });
    if (record.kernel_receipt && !("kernel" in record.kernel_receipt)) {
      record.kernel_receipt.terminal_evidence = {
        schema_version: "calyx.agent-terminal-evidence/v1",
        source: "claude_stream",
        status: "authoritative",
        reason: "max_turns",
        backend_subtype: "error_max_turns",
        backend_terminal_reason: "max_turns",
        signal: "SIGTERM",
        num_turns: 4,
        usage: { input_tokens: 120, output_tokens: 30 },
      };
      record.kernel_receipt.agent_terminal_message = "Safe final message.";
    }
    const { deps } = buildRunCliDeps({ getRunRecord: record });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync(["node", "calyx", "run", "receipt", "--run-id", record.run_id]);

    const joined = out.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("short_id: 7eb1f79f");
    expect(joined).toContain("issue: POL-1405");
    expect(joined).toContain("worktree: /home/caleb/dev/calyx/wt/pol-1405");
    expect(joined).toContain("branch: calyx-run/pol-1405");
    expect(joined).toContain("artifacts: discovered=1 (operator-report.md)");
    expect(joined).toContain("terminal_source: claude_stream");
    expect(joined).toContain("terminal_status: authoritative");
    expect(joined).toContain("terminal_reason: max_turns");
    expect(joined).toContain("terminal_subtype: error_max_turns");
    expect(joined).toContain("terminal_backend_reason: max_turns");
    expect(joined).toContain("terminal_signal: SIGTERM");
    expect(joined).toContain("terminal_num_turns: 4");
    expect(joined).toContain("terminal_usage: input=120 output=30");
    expect(joined).toContain("Safe final message.");
    expect(joined).toContain(`next_receipt: calyx run receipt ${record.run_id} --host blade`);

    out.mockClear();
    const statusProgram = buildProgram({ runCli: deps });
    await statusProgram.parseAsync([
      "node", "calyx", "run", "status", "--run-id", record.run_id, "--details",
    ]);
    const statusJoined = out.mock.calls.map((call) => String(call[0])).join("\n");
    for (const expectedLine of [
      "terminal_source: claude_stream",
      "terminal_status: authoritative",
      "terminal_reason: max_turns",
      "terminal_subtype: error_max_turns",
      "terminal_backend_reason: max_turns",
      "terminal_signal: SIGTERM",
      "terminal_num_turns: 4",
      "terminal_usage: input=120 output=30",
      "Safe final message.",
    ]) {
      expect(statusJoined).toContain(expectedLine);
    }
  });

  test("run ps includes conductor columns and strips tautological summaries", async () => {
    const { deps } = buildRunCliDeps({
      listRuns: [
        {
          run_id: "run-host-health-2",
          state: "running",
          summary: "Run run-host-health-2 running; health=healthy; Recent progress observed at 2026-04-06T21:10:20.000Z via claude_stream.",
          created_at: "2026-04-06T21:10:00.000Z",
          updated_at: "2026-04-06T21:10:20.000Z",
          health_status: "healthy",
          last_progress_at: "2026-04-06T21:10:20.000Z",
          progress_signal: {
            source: "claude_stream",
            status: "available",
            reason: "semantic_event",
          },
          terminal: {
            evidence: {
              schema_version: "calyx.agent-terminal-evidence/v1",
              source: "claude_stream",
              status: "authoritative",
              reason: "completed",
            },
          },
          host: "local",
          recovery_mode: "normal",
          run_dir: "/tmp/run-host-health-2",
        },
      ],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "ps",
    ]);

    const header = String(out.mock.calls.at(-2)?.[0]);
    const line = String(out.mock.calls.at(-1)?.[0]);
    expect(header).toBe("SHORT_ID\tSTATE\tHEALTH\tHOST\tISSUE\tBACKEND\tBRANCH\tUPDATED\tSUMMARY");
    expect(line).toContain("run-host\trunning\thealthy\tlocal\t-\t-\t-\t2026-04-06T21:10:20.000Z\t");
    expect(line).toContain("progress=claude_stream/available/semantic_event");
    expect(line).toContain("terminal=claude_stream/authoritative/completed");
    expect(line).not.toContain("Run run-host-health-2 running");
  });

  test("run ps honors --limit for local JSON run lists", async () => {
    const { deps } = buildRunCliDeps({
      listRuns: [
        {
          run_id: "run-limit-1",
          state: "succeeded",
          summary: "Run run-limit-1 succeeded.",
          created_at: "2026-05-09T12:03:00.000Z",
          updated_at: "2026-05-09T12:03:00.000Z",
          host: "local",
          recovery_mode: "normal",
          run_dir: "/tmp/run-limit-1",
        },
        {
          run_id: "run-limit-2",
          state: "failed",
          summary: "Run run-limit-2 failed.",
          created_at: "2026-05-09T12:02:00.000Z",
          updated_at: "2026-05-09T12:02:00.000Z",
          host: "local",
          recovery_mode: "normal",
          run_dir: "/tmp/run-limit-2",
        },
        {
          run_id: "run-limit-3",
          state: "cancelled",
          summary: "Run run-limit-3 cancelled.",
          created_at: "2026-05-09T12:01:00.000Z",
          updated_at: "2026-05-09T12:01:00.000Z",
          host: "local",
          recovery_mode: "normal",
          run_dir: "/tmp/run-limit-3",
        },
      ],
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "ps",
      "--limit",
      "2",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as RunListEntry[];
    expect(payload).toHaveLength(2);
    expect(payload.map((entry) => entry.run_id)).toEqual(["run-limit-1", "run-limit-2"]);
  });

  test("run ps can request interactive sessions from a remote host", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.interactiveActivitySurfaceV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/runs?agent_kind=codex&host=mba&include_interactive=1&limit=5&since_ms=43200000",
      );
      return {
        ok: true,
        text: async () => JSON.stringify({
          schema_version: "calyx.run-list/v1",
          count: 1,
          truncated: false,
          runs: [
            {
              entry_kind: "interactive_session",
              run_id: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
              state: "interactive",
              summary: "Audit the run surface",
              created_at: "2026-04-28T12:00:00.000Z",
              updated_at: "2026-04-28T12:01:00.000Z",
              host: "mba",
              backend: "codex",
              session_id: "019dcafe-1111-7222-8333-abcabcabcabc",
              session_path: "/Users/caleb/.codex/sessions/2026/04/28/rollout.jsonl",
              source: "codex_sessions",
            },
          ],
        }),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "ps",
      "--include-interactive",
      "--host",
      "mba",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
      "--agent-kind",
      "codex",
      "--since-hours",
      "12",
      "--limit",
      "5",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as Array<{ entry_kind: string; backend: string }>;
    expect(payload).toEqual([
      expect.objectContaining({
        entry_kind: "interactive_session",
        backend: "codex",
      }),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("run ps rejects a remote list that violates its bound success descriptor", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "ps",
      "--host",
      "mba",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
      "--json",
    ])).rejects.toThrow("daemon returned an invalid success representation");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run subscribe rejects a malformed typed event before advancing its cursor", async () => {
    const cursor = "z1-00000000000000000001";
    const malformed = {
      schema_version: "1.0",
      event_id: "malformed-event",
      cursor,
      emitted_at: "2026-07-15T00:00:00.000Z",
      event_type: "run.progress",
      emitted_by: "launch",
    };
    const fetchSpy = vi.fn(async () => new Response(
      `id: ${cursor}\ndata: ${JSON.stringify(malformed)}\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    ));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      cursor,
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("invalid calyx.stream-event/v1 frame before cursor advancement");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["missing", ""],
    ["empty", "id:\n"],
    ["duplicate", "id: z1-00000000000000000001\nid: z1-00000000000000000001\n"],
  ] as const)("run subscribe rejects a typed event with a %s SSE replay id", async (_case, idLines) => {
    const cursor = "z1-00000000000000000001";
    const event = {
      schema_version: "1.0",
      event_id: "missing-sse-id",
      cursor,
      emitted_at: "2026-07-15T00:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: "run-missing-sse-id",
        state: "succeeded",
        kernel: "agent_runner",
        host: "blade",
        created_at: "2026-07-15T00:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: {
        run_dir: "/tmp/run-missing-sse-id",
        run_record_path: "/tmp/run-missing-sse-id/run_record.json",
        events_path: "/tmp/run-missing-sse-id/events.jsonl",
      },
      summary: { one_line: "must retain protocol replay identity" },
    };
    const fetchSpy = vi.fn(async () => new Response(
      `${idLines}data: ${JSON.stringify(event)}\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      },
    ));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      cursor,
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("invalid calyx.stream-event/v1 frame before cursor advancement");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each(["jsonl", "pretty"] as const)(
    "run subscribe accepts and advances over an explicit admin projection gap in %s mode",
    async (format) => {
      const cursor = "z1-00000000000000000001";
      const gap = {
        schema_version: "calyx.stream-projection-gap/v1",
        cursor,
        event_type: "stream.projection_gap",
        gap: {
          reason: "source_event_exceeds_frame_limit",
          source_event_type: "run.terminal",
        },
      };
      const frame = new TextEncoder().encode(`id: ${cursor}\ndata: ${JSON.stringify(gap)}\n\n`);
      const fetchSpy = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame);
          setImmediate(() => {
            process.emit("SIGINT");
            try {
              controller.close();
            } catch {
              // The generated stream may already have closed on cancellation.
            }
          });
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }));
      const { deps } = buildRunCliDeps({ fetchSpy });
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram({ runCli: deps });

      await program.parseAsync([
        "node",
        "calyx",
        "run",
        "subscribe",
        "--after",
        cursor,
        "--format",
        format,
        "--server-url",
        "http://mba:8740",
        "--auth-token",
        "secret-token",
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const rendered = String(out.mock.calls.at(-1)?.[0]);
      if (format === "jsonl") {
        expect(JSON.parse(rendered)).toEqual(gap);
      } else {
        expect(rendered).toBe(
          `[${cursor}] stream.projection_gap source=run.terminal reason=source_event_exceeds_frame_limit`,
        );
      }
    },
  );

  test("run subscribe rejects the delivery-only gap discriminator as a source filter", async () => {
    const { deps } = buildRunCliDeps({ fetchSpy: vi.fn() });
    const program = buildProgram({ runCli: deps });
    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      "z1-00000000000000000001",
      "--event-type",
      "stream.projection_gap",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("Invalid --event-type value");
  });

  test("run subscribe rejects malformed UTF-8 before advancing its cursor", async () => {
    const cursor = "z1-00000000000000000001";
    const event = {
      schema_version: "1.0",
      event_id: "malformed-utf8-event",
      cursor,
      emitted_at: "2026-07-15T00:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: "run-malformed-utf8",
        state: "succeeded",
        kernel: "agent_runner",
        host: "blade",
        created_at: "2026-07-15T00:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: {
        run_dir: "/tmp/run-malformed-utf8",
        run_record_path: "/tmp/run-malformed-utf8/run_record.json",
        events_path: "/tmp/run-malformed-utf8/events.jsonl",
      },
      summary: { one_line: "replacement-target" },
    };
    const serialized = JSON.stringify(event);
    const [beforeTarget, afterTarget] = serialized.split("replacement-target");
    const bytes = new Uint8Array(Buffer.concat([
      Buffer.from(`id: ${cursor}\ndata: ${beforeTarget}`, "utf8"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(`${afterTarget}\n\n`, "utf8"),
    ]));
    const fetchSpy = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      cursor,
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("invalid calyx.stream-event/v1 frame before cursor advancement");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["chunked unterminated", false],
    ["oversized complete", true],
  ] as const)("run subscribe rejects an %s SSE frame before cursor advancement", async (_name, complete) => {
    const oversized = Buffer.alloc(CALYX_HTTP_SSE_MAX_FRAME_BYTES + 1, 0x61);
    const chunks = complete
      ? [Buffer.concat([Buffer.from("data: "), oversized, Buffer.from("\n\n")])]
      : [
          oversized.subarray(0, 400_000),
          oversized.subarray(400_000, 800_000),
          oversized.subarray(800_000),
        ];
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      "z1-00000000000000000001",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("invalid calyx.stream-event/v1 frame before cursor advancement");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run subscribe rejects a success response with a non-SSE media type", async () => {
    const cursor = "z1-00000000000000000001";
    const fetchSpy = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "subscribe",
      "--after",
      cursor,
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
    ])).rejects.toThrow("Unexpected response media type application/json");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run ps refuses remote interactive queries when the daemon lacks the activity feature", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname !== "/v1/admin/health") {
        throw new Error("run ps should not query /runs when the health guard fails");
      }
      return {
        ok: true,
        text: async () => JSON.stringify(makeHealthPayload()),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    try {
      await expect(
        program.parseAsync([
          "node",
          "calyx",
          "run",
          "ps",
          "--include-interactive",
          "--host",
          "mba",
          "--server-url",
          "http://mba:8740",
          "--auth-token",
          "secret-token",
        ]),
      ).rejects.toThrow("interactive.activity_surface/v1 (POL-1147)");
    } finally {
      vi.useRealTimers();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("run activity show queries remote interactive detail with feature guard", async () => {
    const fetchSpy = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/admin/health") {
        return {
          ok: true,
          text: async () => JSON.stringify(makeHealthPayload({
            supports_features: [
              CALYX_DAEMON_FEATURES.healthV1,
              CALYX_DAEMON_FEATURES.interactiveActivityDetailV1,
            ],
          })),
          status: 200,
          statusText: "OK",
        };
      }
      expect(String(url)).toBe(
        "http://mba:8740/v1/admin/activity/interactive%3Acodex%3A019dcafe-1111-7222-8333-abcabcabcabc?around=health&context=2&include_tools=1",
      );
      return {
        ok: true,
        text: async () => JSON.stringify({
          activity_id: "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
          backend: "codex",
          session_id: "019dcafe-1111-7222-8333-abcabcabcabc",
          session_path: "/Users/caleb/.codex/sessions/rollout.jsonl",
          source: "codex_sessions",
          total_events: 1,
          returned_events: 1,
          truncated: false,
          include_tools: true,
          events: [{
            index: 0,
            line: 10,
            role: "assistant",
            kind: "message",
            summary: "Health detail is available.",
            text: "Health detail is available.",
          }],
        }),
        status: 200,
        statusText: "OK",
      };
    });
    const { deps } = buildRunCliDeps({ fetchSpy });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: deps });

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "activity",
      "show",
      "--activity-id",
      "interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc",
      "--host",
      "mba",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
      "--around",
      "health",
      "--context",
      "2",
      "--include-tools",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { activity_id: string; include_tools: boolean };
    expect(payload.activity_id).toBe("interactive:codex:019dcafe-1111-7222-8333-abcabcabcabc");
    expect(payload.include_tools).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("run activity export validates format before remote queries", async () => {
    const fetchSpy = vi.fn();
    const { deps } = buildRunCliDeps({ fetchSpy });
    const program = buildProgram({ runCli: deps });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "run",
      "activity",
      "export",
      "--activity-id",
      "interactive:codex:session-1",
      "--host",
      "mba",
      "--server-url",
      "http://mba:8740",
      "--auth-token",
      "secret-token",
      "--format",
      "html",
    ])).rejects.toThrow("--format must be one of: markdown, json.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("daemon status reads persisted daemon state", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-cli-daemon-status-"));
    created.push(root);
    const daemonDir = join(root, "daemon-pol-918");
    await mkdir(daemonDir, { recursive: true });
    await writeFile(
      join(daemonDir, "daemon_record.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        daemon_id: "daemon-pol-918",
        workflow_path: "/tmp/WORKFLOW.md",
        status: "running",
        created_at: "2026-03-20T12:00:00.000Z",
        updated_at: "2026-03-20T12:00:00.000Z",
        started_at: "2026-03-20T12:00:00.000Z",
        claimed_issues: 2,
        active_runs: 1,
        next_poll_at: "2026-03-20T12:01:00.000Z",
      }, null, 2)}\n`,
      "utf8",
    );
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "run",
      "daemon",
      "status",
      "--daemon-id",
      "daemon-pol-918",
      "--daemons-root",
      root,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      daemon_id: string;
      status: string;
      active_runs: number;
    };
    expect(payload.daemon_id).toBe("daemon-pol-918");
    expect(payload.status).toBe("running");
    expect(payload.active_runs).toBe(1);
  });

  test("daemon start persists detached stdout and stderr logs under the daemon state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-cli-daemon-start-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const launcherPath = join(root, "daemon-launcher.cjs");
    await writeFile(workflowPath, "# workflow\n", "utf8");
    await writeFile(
      launcherPath,
      [
        "process.stdout.write('daemon detached stdout\\n');",
        "process.stderr.write('daemon detached stderr\\n');",
      ].join("\n"),
      "utf8",
    );

    const originalArgv1 = process.argv[1] ?? process.execPath;
    process.argv[1] = launcherPath;
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "run",
        "daemon",
        "start",
        "--workflow",
        workflowPath,
        "--daemon-id",
        "daemon-pol-1117",
        "--daemons-root",
        root,
        "--runs-root",
        join(root, "runs"),
        "--json",
      ]);
    } finally {
      process.argv[1] = originalArgv1;
    }

    const daemonDir = join(root, "daemon-pol-1117");
    const [stdoutLog] = await waitForMatchingFiles(daemonDir, (entry) => entry.endsWith(".stdout.log"));
    const [stderrLog] = await waitForMatchingFiles(daemonDir, (entry) => entry.endsWith(".stderr.log"));
    await expect(waitForFileContains(join(daemonDir, stdoutLog!), "daemon detached stdout")).resolves.toContain(
      "daemon detached stdout",
    );
    await expect(waitForFileContains(join(daemonDir, stderrLog!), "daemon detached stderr")).resolves.toContain(
      "daemon detached stderr",
    );

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      daemon_id: string;
      state_root: string;
    };
    expect(payload.daemon_id).toBe("daemon-pol-1117");
    expect(payload.state_root).toBe(daemonDir);
  });

  test("daemon tick --project resolves WORKFLOW.md via the repo registry without cwd fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-cli-daemon-project-"));
    created.push(root);
    const agentsInfraRoot = join(root, "agents-infra");
    await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(join(agentsInfraRoot, "instructions", "skills", "SOURCES.json"), "{}");
    await writeFile(join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"), "{}");
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFileCb);
    await execFileP("git", ["init", "--quiet", repoRoot]);
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      `hosts:\n  test-host:\n    home: ${root}\n    repos:\n      calyx: ${repoRoot}\n`,
    );
    // We exercise the project → repo-root → WORKFLOW.md resolution by
    // running `daemon tick` against a deliberately malformed workflow file
    // and asserting the resolver opened the right path. A full tick would
    // require a real tracker call, which we deliberately keep out of unit
    // tests (the daemon ledger and tracker seam tests live in run-service).
    await writeFile(join(repoRoot, "WORKFLOW.md"), "no-frontmatter-here\n");

    const previousEnv = process.env["CALYX_AGENTS_INFRA_ROOT"];
    process.env["CALYX_AGENTS_INFRA_ROOT"] = agentsInfraRoot;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();
    let caughtMessage = "";

    try {
      await program.parseAsync([
        "node",
        "calyx",
        "run",
        "daemon",
        "tick",
        "--project",
        "calyx",
        "--host",
        "test-host",
        "--daemons-root",
        join(root, "daemons"),
        "--runs-root",
        join(root, "runs"),
        "--json",
      ]);
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    } finally {
      if (previousEnv === undefined) {
        delete process.env["CALYX_AGENTS_INFRA_ROOT"];
      } else {
        process.env["CALYX_AGENTS_INFRA_ROOT"] = previousEnv;
      }
    }

    // The workflow loader explodes with a frontmatter parse error sourced
    // from the resolved repo-root WORKFLOW.md. That is enough to prove the
    // project slug walked through hosts.yaml without falling back to cwd.
    expect(caughtMessage).toMatch(/WORKFLOW\.md/);
    expect(caughtMessage).toMatch(/frontmatter/i);
  });

  test("daemon tick refuses both --workflow and --project together", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();
    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "run",
        "daemon",
        "tick",
        "--workflow",
        "/tmp/does-not-matter.md",
        "--project",
        "calyx",
      ]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  test("daemon tick requires --workflow or --project", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "calyx", "run", "daemon", "tick"]),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
