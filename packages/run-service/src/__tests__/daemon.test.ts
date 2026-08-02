import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireLock, applyStateMigrations, openStateStore } from "@polli-labs/calyx-core";
import { DaemonService } from "../daemon.js";
import { DAEMON_LEDGER_AGGREGATE_TYPE, daemonAggregateId, daemonLockKey } from "../daemon-ledger.js";
import {
  legacyDeadSettlementAuthorityId,
  legacyLaunchAdmissionIdentity,
  legacyResourceSettlementAuthorityId,
  isRunResourceTerminal,
} from "../store.js";
import { createTrackerRegistry } from "../tracker.js";
import type { RunCancellationResult } from "../service.js";
import type {
  DaemonStateSnapshot,
  IssueRuntimeRecord,
  ReconcileResult,
  RunIntent,
  RunLaunchResult,
  RunRecord,
  TrackerClaimRequest,
  TrackerClaimResult,
  TrackerHandoffRequest,
  TrackerHandoffResult,
  TrackerIssue,
  TrackerPollResult,
} from "../types.js";

function cancellationRequested(runId: string): RunCancellationResult {
  return {
    schema_version: "calyx.run-cancellation-result/v1",
    status: "cancellation_requested",
    run_id: runId,
    requested_at: "2026-03-20T12:00:00.000Z",
  };
}

function makeRunRecord(intent: RunIntent, state: RunRecord["state"], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: "1.0",
    run_id: intent.run_id,
    state,
    intent,
    launch: {
      mode: "inline",
      stage: "executing",
      admission_identity: "test-admission",
      request_hash: "test-request",
      accepted_at: intent.created_at,
      dispatch_attempts: 0,
    },
    integrations: { results: [], all_critical_ok: true },
    recovery: { mode: "normal", resumable: false },
    summary: `Run ${intent.run_id} ${state}`,
    created_at: intent.created_at,
    updated_at: intent.created_at,
    ...(state === "running" ? {} : { completed_at: intent.created_at }),
    ...overrides,
  };
}

function fakeResourceTerminalAuthority(record: RunRecord | undefined) {
  return record && isRunResourceTerminal(record)
    ? {
        schema_version: "calyx.run-resource-terminal-authority/v1" as const,
        run_id: record.run_id,
        source: "current_record" as const,
      }
    : undefined;
}

function makeWorkflowContent(
  root: string,
  options: {
    maxConcurrentAgents?: number;
    maxSelectedIssues?: number;
    handoffState?: string;
    allowDoneHandoff?: boolean;
    maxThreads?: number;
  } = {},
): string {
  return `---
tracker:
  kind: linear
  team: Polli Labs
  project: Calyx
  active_states: [Todo]
  terminal_states: [Done, Canceled]
  handoff_state: ${options.handoffState ?? "In Review"}
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: ${options.maxConcurrentAgents ?? 1}
${typeof options.maxSelectedIssues === "number" ? `selection:
  max_selected_issues: ${options.maxSelectedIssues}
` : ""}${options.allowDoneHandoff ? `workflow_policy:
  allow_done_handoff: true
` : ""}
workspace:
  root: ${join(root, "wt")}
  repo_root: ${join(root, "repo")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 2
${typeof options.maxThreads === "number" ? `  max_threads: ${options.maxThreads}
` : ""}
  require_execplan: false
  pull_execplan: false
logging:
  level: info
---
Work issue {{ISSUE_IDENTIFIER}} in {{WORKSPACE_PATH}}
Run: {{RUN_ID}}
Daemon key: {{DAEMON_RUN_KEY}}
`;
}

function makeFakeRunService(root: string, launchCalls: RunIntent[] = []): import("../service.js").RunService {
  const runRecords = new Map<string, RunRecord>();
  let runCounter = 0;
  return {
    createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
      runCounter += 1;
      return {
        run_id: `run-${runCounter}`,
        kernel: input.kernel ?? "agent_runner",
        host: input.host,
        created_at: "2026-03-20T12:00:00.000Z",
        ...(input.issue ? { issue: input.issue } : {}),
        ...(input.backend ? { backend: input.backend } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
        ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
        ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
        ...(input.backend_options ? { backend_options: input.backend_options } : {}),
        ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
    },
    async launch(intent: RunIntent): Promise<RunLaunchResult> {
      launchCalls.push(intent);
      const record = makeRunRecord(intent, "succeeded");
      runRecords.set(intent.run_id, record);
      return {
        run_id: intent.run_id,
        state: record.state,
        mode: "foreground",
        run_dir: join(root, "runs", intent.run_id),
        record,
      };
    },
    async getRunRecord(runId: string): Promise<RunRecord | undefined> {
      return runRecords.get(runId);
    },
    async getResourceTerminalAuthority(runId: string) {
      return fakeResourceTerminalAuthority(runRecords.get(runId));
    },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
    async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
    },
  } as unknown as import("../service.js").RunService;
}

function makeIssue(identifier: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: `issue-${identifier}`,
    identifier,
    title: `Ship ${identifier}`,
    updated_at: "2026-03-20T12:00:00.000Z",
    state: { name: "Todo", type: "unstarted" },
    labels: ["scope:calyx"],
    team: "Polli Labs",
    project: "Calyx",
    ...overrides,
  };
}

describe("DaemonService", () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("tick launches eligible issues with explicit worktree_path", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-new-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root, { maxThreads: 8 }), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-1",
      identifier: "POL-918",
      title: "Ship daemon",
      updated_at: "2026-03-20T12:00:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: ["scope:calyx"],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [issue],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const runRecords = new Map<string, RunRecord>();
    let runCounter = 0;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        runCounter += 1;
        return {
          run_id: `run-${runCounter}`,
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:00:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.backend_options ? { backend_options: input.backend_options } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded");
        runRecords.set(intent.run_id, record);
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runRecords.get(runId);
      },
      async getResourceTerminalAuthority(runId: string) {
        return fakeResourceTerminalAuthority(runRecords.get(runId));
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const execCalls: Array<{ cmd: string; args: string[]; cwd?: string | undefined }> = [];
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:00:00.000Z",
        exec: async (cmd, args, options) => {
          execCalls.push({ cmd, args, cwd: options?.cwd });
          if (args[0] === "show-ref") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            const workspacePath = args[4]!;
            await mkdir(workspacePath, { recursive: true });
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    const result = await daemon.tick(workflowPath, "daemon-pol-918", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-pol-918");

    expect(result.launched_runs).toHaveLength(1);
    expect(result.active_runs).toBe(0);
    expect(launchCalls[0]?.worktree_path).toBe(join(root, "wt", "POL-918"));
    expect(launchCalls[0]?.branch).toBe("calyx/POL-918");
    expect(launchCalls[0]?.backend_options).toEqual({ max_threads: 8 });
    // Symphony v0: a single successful terminal run releases the claim
    // and hands off (no ledger here, no tracker mutation seam — release
    // happens locally, the run state is still observable on the record).
    expect(state?.issues["POL-918"]?.status).toBe("released");
    expect(execCalls.some((call) => call.args[0] === "worktree" && call.args[1] === "add")).toBe(true);
  });

  test("publisher-terminal runs retain hooks, handoff, capacity, and cleanup until resources settle", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-resource-pending-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workspacePath = join(root, "wt", "POL-1980");
    await mkdir(workspacePath, { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    const workflowContent = makeWorkflowContent(root).replace(
      `  branch_template: calyx/{{IDENTIFIER}}`,
      `  branch_template: calyx/{{IDENTIFIER}}\n  after_run: ["echo after-run"]\n  before_remove: ["echo before-remove"]\n  cleanup_terminal_after_hours: 1`,
    );
    await writeFile(workflowPath, workflowContent, "utf8");

    const activeIssue = makeIssue("POL-1980");
    const nextIssue = makeIssue("POL-1981", { updated_at: "2026-03-20T12:01:00.000Z" });
    let trackedIssues: TrackerIssue[] = [activeIssue, nextIssue];
    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:10:00.000Z",
          issues: trackedIssues,
        };
      },
    }));

    const intent: RunIntent = {
      run_id: "run-resource-pending",
      host: "local",
      created_at: "2026-03-20T12:00:00.000Z",
    };
    const pendingRecord = makeRunRecord(intent, "infra_error", {
      recovery: {
        mode: "orphaned_process",
        resumable: false,
        owner_free_settlement: {
          schema_version: "calyx.owner-free-settlement/v1",
          authority: "legacy_pid_dead",
          authority_id: "a".repeat(64),
          settled_at: "2026-03-20T12:02:00.000Z",
          reason_code: "legacy_detached_worker_observed_dead",
          legacy_pid: 45_672,
        },
        resource_settlement: {
          schema_version: "calyx.resource-settlement/v1",
          status: "pending",
          authority: "legacy_process_group_observation",
          observed_at: "2026-03-20T12:02:00.000Z",
          reason_code: "legacy_detached_process_group_possibly_live",
          legacy_process_group_id: 45_672,
        },
      },
    });
    const legacyRequestHash = "1".repeat(64);
    const unfencedLegacyRecord = makeRunRecord(intent, "infra_error", {
      launch: {
        mode: "detached",
        stage: "executing",
        admission_identity: legacyLaunchAdmissionIdentity(intent.run_id, legacyRequestHash),
        request_hash: legacyRequestHash,
        accepted_at: intent.created_at,
        dispatch_attempts: 1,
        last_dispatch_at: "2026-03-20T12:01:00.000Z",
      },
      recovery: { mode: "orphaned_process", resumable: false },
    });
    let resourceRecord: RunRecord | undefined = unfencedLegacyRecord;
    const fakeRunService = {
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runId === pendingRecord.run_id ? resourceRecord : undefined;
      },
      async stop(runId: string): Promise<RunCancellationResult> {
        return cancellationRequested(runId);
      },
      async reconcile(): Promise<ReconcileResult> {
        return {
          scanned: 1,
          rebuilt: [],
          classified: [],
          adopted: [],
          unresolved: [],
          skipped: [pendingRecord.run_id],
          noncanonical_directories: [],
          projection: { status: "not_configured" },
        };
      },
      async getResourceTerminalAuthority(runId: string) {
        const record = runId === pendingRecord.run_id ? resourceRecord : undefined;
        return record && isRunResourceTerminal(record)
          ? {
              schema_version: "calyx.run-resource-terminal-authority/v1" as const,
              run_id: record.run_id,
              source: "legacy_resource_settlement" as const,
            }
          : undefined;
      },
    } as unknown as import("../service.js").RunService;
    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:10:00.000Z",
        exec: async (cmd, args) => {
          execCalls.push({ cmd, args });
          if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
            await rm(workspacePath, { recursive: true, force: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    await daemon.store.ensureDaemonRoot("daemon-resource-pending");
    await daemon.store.writeStateSnapshot("daemon-resource-pending", {
      schema_version: "1.0",
      daemon_id: "daemon-resource-pending",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [pendingRecord.run_id],
      issues: {
        "POL-1980": {
          issue_id: activeIssue.id,
          issue_identifier: activeIssue.identifier,
          title: activeIssue.title,
          state_name: activeIssue.state.name,
          state_type: activeIssue.state.type,
          workspace_key: activeIssue.identifier,
          workspace_path: workspacePath,
          branch_name: "calyx/POL-1980",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          active_run_id: pendingRecord.run_id,
          last_run_id: pendingRecord.run_id,
          last_seen_at: "2026-03-20T12:00:00.000Z",
        },
      },
    });

    const plan = await daemon.plan(workflowPath, "daemon-resource-pending");
    expect(plan.available_launch_slots).toBe(0);
    expect(plan.active_runs).toContainEqual(expect.objectContaining({
      run_id: pendingRecord.run_id,
      state: "infra_error",
    }));
    const tick = await daemon.tick(workflowPath, "daemon-resource-pending");
    const retained = await daemon.store.readStateSnapshot("daemon-resource-pending");
    expect(tick.active_runs).toBe(1);
    expect(retained?.issues["POL-1980"]).toMatchObject({
      status: "running",
      active_run_id: pendingRecord.run_id,
    });
    expect(retained?.issues["POL-1980"]).not.toHaveProperty("after_run_applied_at");
    expect(retained?.issues["POL-1980"]).not.toHaveProperty("handoff_at");
    expect(execCalls).toEqual([]);

    resourceRecord = pendingRecord;
    const explicitlyPendingTick = await daemon.tick(workflowPath, "daemon-resource-pending");
    const explicitlyRetained = await daemon.store.readStateSnapshot("daemon-resource-pending");
    expect(explicitlyPendingTick.active_runs).toBe(1);
    expect(explicitlyRetained?.issues["POL-1980"]).toMatchObject({
      status: "running",
      active_run_id: pendingRecord.run_id,
    });
    expect(execCalls).toEqual([]);

    trackedIssues = [activeIssue];
    const settledRecord = structuredClone(pendingRecord);
    if (!settledRecord.recovery.owner_free_settlement) {
      throw new Error("expected owner-free settlement fixture");
    }
    settledRecord.recovery.owner_free_settlement.authority_id = legacyDeadSettlementAuthorityId(
      settledRecord,
      45_672,
    );
    settledRecord.recovery.resource_settlement = {
      schema_version: "calyx.resource-settlement/v1",
      status: "settled",
      authority: "legacy_process_group_extinct",
      authority_id: legacyResourceSettlementAuthorityId(settledRecord, 45_672),
      settled_at: "2026-03-20T12:03:00.000Z",
      reason_code: "legacy_detached_process_group_observed_extinct",
      legacy_process_group_id: 45_672,
    };
    resourceRecord = settledRecord;
    await daemon.tick(workflowPath, "daemon-resource-pending");
    const finalized = await daemon.store.readStateSnapshot("daemon-resource-pending");
    expect(finalized?.issues["POL-1980"]).toMatchObject({
      after_run_applied_for_run_id: pendingRecord.run_id,
    });
    expect(execCalls).toEqual([{ cmd: "bash", args: ["-lc", "echo after-run"] }]);

    trackedIssues = [];
    await daemon.store.writeStateSnapshot("daemon-resource-pending", {
      ...finalized!,
      active_run_ids: [],
      issues: {
        ...finalized!.issues,
        "POL-1980": {
          ...finalized!.issues["POL-1980"]!,
          status: "released",
          claim_status: "released",
          active_run_id: undefined,
          last_run_id: pendingRecord.run_id,
          released_at: "2020-01-01T00:00:00.000Z",
        },
      },
    });
    const missingSettlementRecord = structuredClone(pendingRecord);
    delete missingSettlementRecord.recovery.resource_settlement;
    resourceRecord = missingSettlementRecord;
    const missingSettlementTick = await daemon.tick(workflowPath, "daemon-resource-pending");
    expect(missingSettlementTick.cleaned_workspaces).toEqual([]);

    const forgedSettlementRecord = structuredClone(pendingRecord);
    forgedSettlementRecord.recovery.resource_settlement = {
      schema_version: "calyx.resource-settlement/v1",
      status: "settled",
      authority: "legacy_process_group_extinct",
      authority_id: "0".repeat(64),
      settled_at: "2026-03-20T12:03:00.000Z",
      reason_code: "legacy_detached_process_group_observed_extinct",
      legacy_process_group_id: 45_672,
    };
    resourceRecord = forgedSettlementRecord;
    const forgedSettlementTick = await daemon.tick(workflowPath, "daemon-resource-pending");
    expect(forgedSettlementTick.cleaned_workspaces).toEqual([]);

    resourceRecord = undefined;
    const missingRecordTick = await daemon.tick(workflowPath, "daemon-resource-pending");
    expect(missingRecordTick.cleaned_workspaces).toEqual([]);
    await expect(stat(workspacePath)).resolves.toMatchObject({});
    expect(execCalls).toEqual([{ cmd: "bash", args: ["-lc", "echo after-run"] }]);

    resourceRecord = settledRecord;
    const settledCleanupTick = await daemon.tick(workflowPath, "daemon-resource-pending");
    expect(settledCleanupTick.cleaned_workspaces).toEqual(["POL-1980"]);
    expect(execCalls).toEqual([
      { cmd: "bash", args: ["-lc", "echo after-run"] },
      { cmd: "bash", args: ["-lc", "echo before-remove"] },
      {
        cmd: "git",
        args: ["worktree", "remove", "--force", workspacePath],
      },
    ]);
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("plan previews selected and skipped issues without tracker mutation or launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-plan-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const claimCalls: TrackerClaimRequest[] = [];
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [
            makeIssue("POL-1418"),
            makeIssue("POL-1419", { state: { name: "Done", type: "completed" } }),
          ],
        };
      },
      async claimIssue(request: TrackerClaimRequest): Promise<TrackerClaimResult> {
        claimCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-03-20T12:00:00.000Z",
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: makeFakeRunService(root, launchCalls),
        daemonsRoot: join(root, "daemons"),
      },
      { now: () => "2026-03-20T12:00:00.000Z" },
    );

    const plan = await daemon.plan(workflowPath, "daemon-plan");
    const state = await daemon.store.readStateSnapshot("daemon-plan");

    expect(plan.verdict.safe_to_launch).toBe(true);
    expect(plan.selected_issues.map((issue) => issue.issue_identifier)).toEqual(["POL-1418"]);
    expect(plan.skipped_issues.map((issue) => [issue.issue_identifier, issue.reason])).toContainEqual([
      "POL-1419",
      "terminal_state",
    ]);
    expect(claimCalls).toHaveLength(0);
    expect(launchCalls).toHaveLength(0);
    expect(state).toBeUndefined();
  });

  test("selection.max_selected_issues blocks a multi-selection tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-selection-cap-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      makeWorkflowContent(root, { maxConcurrentAgents: 1, maxSelectedIssues: 1 }),
      "utf8",
    );

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [makeIssue("POL-1420"), makeIssue("POL-1421", { updated_at: "2026-03-20T12:01:00.000Z" })],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: makeFakeRunService(root, launchCalls),
        daemonsRoot: join(root, "daemons"),
      },
      { now: () => "2026-03-20T12:00:00.000Z" },
    );

    const plan = await daemon.plan(workflowPath, "daemon-cap");
    await expect(daemon.tick(workflowPath, "daemon-cap")).rejects.toThrow("selection_cap");
    expect(plan.selected_issues.map((issue) => issue.issue_identifier)).toEqual(["POL-1420", "POL-1421"]);
    expect(plan.verdict.safe_to_launch).toBe(false);
    expect(launchCalls).toHaveLength(0);
  });

  test("single-selection workflow remains launchable", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-single-cap-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      makeWorkflowContent(root, { maxConcurrentAgents: 1, maxSelectedIssues: 1 }),
      "utf8",
    );

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [makeIssue("POL-1422")],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: makeFakeRunService(root, launchCalls),
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:00:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            await mkdir(args[4]!, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    const result = await daemon.tick(workflowPath, "daemon-single", { awaitLaunchedRuns: true });
    expect(result.preflight_verdict?.safe_to_launch).toBe(true);
    expect(result.launched_runs).toHaveLength(1);
    expect(launchCalls).toHaveLength(1);
  });

  test("handoff receipt skeleton includes daemon workflow selected issue and handoff fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-receipt-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const issue = makeIssue("POL-1423");
    const trackerRegistry = createTrackerRegistry();
    const handoffCalls: TrackerHandoffRequest[] = [];
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [issue],
        };
      },
      async handoffIssue(request: TrackerHandoffRequest): Promise<TrackerHandoffResult> {
        handoffCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-03-20T12:00:00.000Z",
          comment_id: "comment-1",
        };
      },
    }));

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: makeFakeRunService(root),
        daemonsRoot: join(root, "daemons"),
        activityResolver: {
          async resolve() {
            return { activity_id: "activity-1", latest_assistant_turn_id: "turn-1" };
          },
        },
      },
      {
        now: () => "2026-03-20T12:00:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            await mkdir(args[4]!, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    await daemon.tick(workflowPath, "daemon-receipt", { awaitLaunchedRuns: true });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]?.comment_body).toContain("workflow_path:");
    expect(handoffCalls[0]?.comment_body).toContain("worktree:");
    expect(handoffCalls[0]?.comment_body).toContain("branch:");
    expect(handoffCalls[0]?.comment_body).toContain("handoff_state: In Review");
    expect(handoffCalls[0]?.comment_body).toContain("stop_condition_review: pending");
  });

  test("one-shot daemon tick does not continue after ready_for_review terminal marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-ready-for-review-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const issue = makeIssue("POL-1430");
    const trackerRegistry = createTrackerRegistry();
    const handoffCalls: TrackerHandoffRequest[] = [];
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [issue],
        };
      },
      async handoffIssue(request: TrackerHandoffRequest): Promise<TrackerHandoffResult> {
        handoffCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-03-20T12:00:00.000Z",
          comment_id: "comment-ready-for-review",
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const continuationDecisions: unknown[] = [];
    let launchedRecord: RunRecord | undefined;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        return {
          run_id: "run-ready-for-review",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:00:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(
        intent: RunIntent,
        options?: { nextTurnInput?: (context: unknown) => unknown | Promise<unknown> },
      ): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const nextTurn = await options?.nextTurnInput?.({
          turn_index: 1,
          turn_summary: { turn_index: 1, state: "succeeded" },
          session_summary: {
            adapter_name: "codex",
            adapter_session_id: "adapter-session-ready",
            backend_session_id: "backend-session-ready",
            turns_total: 1,
            terminal_turn_index: 1,
            stop_reason: "natural_stop",
            turns: [],
          },
          session: {
            id: "adapter-session-ready",
            capabilities: { turnControl: true },
          },
          terminal_state: "succeeded",
          classification: { class: "success", confidence: 1, reason: "test" },
          result: {
            exit_code: 0,
            stderr: "",
            duration_ms: 10,
            events: [],
            agent_terminal_message: "ready_for_review",
          },
        });
        continuationDecisions.push(nextTurn);
        const record = makeRunRecord(intent, "succeeded", {
          recovery: {
            mode: "normal",
            resumable: true,
            checkpoint: {
              backend_session_id: "backend-session-ready",
              strategy: "native_session",
            },
          },
          summary: "ready_for_review",
        });
        launchedRecord = record;
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
      async getResourceTerminalAuthority() {
        return fakeResourceTerminalAuthority(launchedRecord);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:00:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            await mkdir(args[4]!, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    const result = await daemon.tick(workflowPath, "daemon-ready-for-review", { awaitLaunchedRuns: true });

    expect(result.launched_runs).toHaveLength(1);
    expect(launchCalls).toHaveLength(1);
    expect(continuationDecisions).toEqual([null]);
    expect(handoffCalls).toHaveLength(1);
    const state = await daemon.store.readStateSnapshot("daemon-ready-for-review");
    expect(state?.issues["POL-1430"]?.status).toBe("released");
    expect(state?.issues["POL-1430"]?.last_run_state).toBe("succeeded");
  });

  test("plan surfaces reconciliation flags for missing worktree state", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-reconcile-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:00:00.000Z",
          issues: [],
        };
      },
    }));

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: makeFakeRunService(root),
        daemonsRoot: join(root, "daemons"),
      },
      { now: () => "2026-03-20T12:00:00.000Z" },
    );
    const state: DaemonStateSnapshot = {
      schema_version: "1.0",
      daemon_id: "daemon-reconcile",
      workflow_path: workflowPath,
      current_interval_seconds: 0,
      active_run_ids: [],
      issues: {
        "POL-1424": {
          issue_id: "issue-POL-1424",
          issue_identifier: "POL-1424",
          title: "Missing worktree",
          state_name: "Todo",
          workspace_key: "POL-1424",
          workspace_path: join(root, "wt", "missing"),
          branch_name: "calyx/POL-1424",
          status: "released",
          claim_status: "released",
          retry_count: 0,
          last_seen_at: "2026-03-20T12:00:00.000Z",
        },
      },
    };
    await daemon.store.ensureDaemonRoot("daemon-reconcile");
    await daemon.store.writeStateSnapshot("daemon-reconcile", state);

    const plan = await daemon.plan(workflowPath, "daemon-reconcile");
    expect(plan.reconciliation_flags.map((flag) => flag.code)).toContain("missing_worktree");
    expect(plan.warnings.map((warning) => warning.code)).toContain("missing_worktree");
  });

  test("tick resumes waiting continuation issues with resume_session_id", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-resume-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-2",
      identifier: "POL-919",
      title: "Resume daemon session",
      updated_at: "2026-03-20T12:10:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:10:00.000Z",
          issues: [issue],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    let runCounter = 0;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        runCounter += 1;
        return {
          run_id: `run-${runCounter}`,
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:10:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.resume_session_id ? { resume_session_id: input.resume_session_id } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded", {
          recovery: {
            mode: "normal",
            resumable: true,
            checkpoint: {
              backend_session_id: "sess-continued",
              strategy: "native_session",
            },
          },
        });
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:10:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    const seededState: DaemonStateSnapshot = {
      schema_version: "1.0",
      daemon_id: "daemon-pol-919",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-919": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: issue.state.name,
          state_type: issue.state.type,
          workspace_key: "POL-919",
          workspace_path: join(root, "wt", "POL-919"),
          branch_name: "calyx/POL-919",
          status: "waiting_continuation",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-03-20T12:09:00.000Z",
          continuation_due_at: "2026-03-20T12:09:01.000Z",
          last_backend_session_id: "sess-123",
        } satisfies IssueRuntimeRecord,
      },
    };
    await daemon.store.ensureDaemonRoot("daemon-pol-919");
    await mkdir(join(root, "wt", "POL-919"), { recursive: true });
    await daemon.store.writeStateSnapshot("daemon-pol-919", seededState);

    await daemon.tick(workflowPath, "daemon-pol-919", { awaitLaunchedRuns: true });

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.resume_session_id).toBe("sess-123");
    expect(launchCalls[0]?.worktree_path).toBe(join(root, "wt", "POL-919"));
  });

  test("tick keeps claimed retry issues even after the tracker moves them to claim_state", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-claimed-retry-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-claimed-retry",
      identifier: "POL-920",
      title: "Retry claimed work",
      updated_at: "2026-03-20T12:20:00.000Z",
      state: { name: "In Progress", type: "started" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:20:00.000Z",
          issues: [issue],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    let launchedRecord: RunRecord | undefined;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        return {
          run_id: "run-retry-1",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:20:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "failed", { summary: "retry failed again" });
        launchedRecord = record;
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
      async getResourceTerminalAuthority() {
        return fakeResourceTerminalAuthority(launchedRecord);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:20:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-pol-920");
    await mkdir(join(root, "wt", "POL-920"), { recursive: true });
    await daemon.store.writeStateSnapshot("daemon-pol-920", {
      schema_version: "1.0",
      daemon_id: "daemon-pol-920",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-920": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "In Progress",
          state_type: "started",
          workspace_key: "POL-920",
          workspace_path: join(root, "wt", "POL-920"),
          branch_name: "calyx/POL-920",
          status: "waiting_retry",
          claim_status: "claimed",
          retry_count: 1,
          last_seen_at: "2026-03-20T12:19:00.000Z",
          retry_due_at: "2026-03-20T12:19:01.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    await daemon.tick(workflowPath, "daemon-pol-920", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-pol-920");

    expect(launchCalls.map((intent) => intent.run_id)).toEqual(["run-retry-1"]);
    expect(state?.issues["POL-920"]?.claim_status).toBe("claimed");
    expect(state?.issues["POL-920"]?.status).toBe("waiting_retry");
  });

  test("tick stops stalled runs and transitions them to waiting_retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-stall-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-3",
      identifier: "POL-916",
      title: "Unstick stalled run",
      updated_at: "2026-03-20T12:20:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:20:00.000Z",
          issues: [issue],
        };
      },
    }));

    const stopCalls: string[] = [];
    const fakeRunService = {
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return {
          ...makeRunRecord(
            {
              run_id: runId,
              host: "local",
              backend: "codex",
              worktree_path: join(root, "wt", "POL-916"),
              created_at: "2026-03-20T12:00:00.000Z",
            },
            "running",
          ),
          updated_at: "2026-03-20T12:00:30.000Z",
        };
      },
      async stop(runId: string): Promise<RunCancellationResult> {
        stopCalls.push(runId);
        return cancellationRequested(runId);
      },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:20:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-pol-916");
    await daemon.store.writeStateSnapshot("daemon-pol-916", {
      schema_version: "1.0",
      daemon_id: "daemon-pol-916",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: ["run-stalled"],
      issues: {
        "POL-916": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: issue.state.name,
          state_type: issue.state.type,
          workspace_key: "POL-916",
          workspace_path: join(root, "wt", "POL-916"),
          branch_name: "calyx/POL-916",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-03-20T12:19:00.000Z",
          active_run_id: "run-stalled",
        },
      },
    });

    const result = await daemon.tick(workflowPath, "daemon-pol-916", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-pol-916");

    expect(stopCalls).toEqual(["run-stalled"]);
    expect(result.cancellation_requested_runs).toEqual(["run-stalled"]);
    expect(state?.issues["POL-916"]?.status).toBe("cancellation_requested");
    expect(state?.issues["POL-916"]?.retry_count).toBe(0);
    expect(state?.issues["POL-916"]?.active_run_id).toBe("run-stalled");
  });

  test("a never-resolving launch handle does not mask a stalled run on the next tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-live-handle-policy-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const stalledIssue = makeIssue("POL-916-HANDLE", {
      title: "Stop when execution stalls",
      updated_at: "2026-03-20T12:00:00.000Z",
    });
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:20:00.000Z",
          issues: [stalledIssue],
        };
      },
    }));

    const runRecords = new Map<string, RunRecord>();
    const stopCalls: string[] = [];
    let runCounter = 0;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        runCounter += 1;
        return {
          run_id: `run-never-resolves-${runCounter}`,
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:00:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        runRecords.set(intent.run_id, makeRunRecord(intent, "running"));
        return new Promise<RunLaunchResult>(() => undefined);
      },
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runRecords.get(runId);
      },
      async getResourceTerminalAuthority(runId: string) {
        return fakeResourceTerminalAuthority(runRecords.get(runId));
      },
      async stop(runId: string): Promise<RunCancellationResult> {
        stopCalls.push(runId);
        return cancellationRequested(runId);
      },
      async reconcile(): Promise<ReconcileResult> {
        return {
          scanned: 0,
          rebuilt: [],
          classified: [],
          adopted: [],
          unresolved: [],
          skipped: [],
          noncanonical_directories: [],
          projection: { status: "not_configured" },
        };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:20:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            await mkdir(args[4]!, { recursive: true });
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    const launched = await daemon.tick(workflowPath, "daemon-live-handle-policy", {
      awaitLaunchedRuns: false,
    });
    expect(launched.launched_runs).toEqual(["run-never-resolves-1"]);

    const secondTick = await daemon.tick(workflowPath, "daemon-live-handle-policy", {
      awaitLaunchedRuns: false,
    });
    const state = await daemon.store.readStateSnapshot("daemon-live-handle-policy");

    expect(stopCalls).toEqual(["run-never-resolves-1"]);
    expect(secondTick.cancellation_requested_runs).toEqual(["run-never-resolves-1"]);
    expect(state?.issues["POL-916-HANDLE"]?.status).toBe("cancellation_requested");
  });

  test("tick clears phantom active runs into retry backoff, then relaunches with a warning event", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-phantom-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-phantom",
      identifier: "POL-1109",
      title: "Fix phantom active run",
      updated_at: "2026-04-18T12:00:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-04-18T12:00:00.000Z",
          issues: [issue],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const runRecords = new Map<string, RunRecord>();
    let runCounter = 0;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        runCounter += 1;
        return {
          run_id: `run-${runCounter}`,
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-04-18T12:00:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded");
        runRecords.set(intent.run_id, record);
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runRecords.get(runId);
      },
      async getResourceTerminalAuthority(runId: string) {
        return fakeResourceTerminalAuthority(runRecords.get(runId));
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    let currentTime = "2026-04-18T12:00:00.000Z";
    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => currentTime,
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-pol-1109");
    await daemon.store.writeStateSnapshot("daemon-pol-1109", {
      schema_version: "1.0",
      daemon_id: "daemon-pol-1109",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: ["run-phantom"],
      issues: {
        "POL-1109": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: issue.state.name,
          state_type: issue.state.type,
          workspace_key: "POL-1109",
          workspace_path: join(root, "wt", "POL-1109"),
          branch_name: "calyx/POL-1109",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-04-18T11:59:00.000Z",
          active_run_id: "run-phantom",
        },
      },
    });

    const firstResult = await daemon.tick(workflowPath, "daemon-pol-1109", { awaitLaunchedRuns: true });
    const firstState = await daemon.store.readStateSnapshot("daemon-pol-1109");
    const events = await daemon.readLogs("daemon-pol-1109");

    expect(firstResult.launched_runs).toEqual([]);
    expect(launchCalls).toHaveLength(0);
    expect(firstState?.issues["POL-1109"]?.status).toBe("waiting_retry");
    expect(firstState?.issues["POL-1109"]?.retry_count).toBe(1);
    expect(firstState?.issues["POL-1109"]?.retry_due_at).toBe("2026-04-18T12:00:30.000Z");
    expect(firstState?.issues["POL-1109"]?.active_run_id).toBeUndefined();

    currentTime = "2026-04-18T12:00:31.000Z";
    const secondResult = await daemon.tick(workflowPath, "daemon-pol-1109", { awaitLaunchedRuns: true });
    const secondState = await daemon.store.readStateSnapshot("daemon-pol-1109");

    expect(secondResult.launched_runs).toEqual(["run-1"]);
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.metadata?.["daemon_dispatch_reason"]).toBe("retry");
    // Symphony v0: a successful re-run on the retry path now releases the
    // claim (and would post the handoff receipt if a tracker mutation seam
    // were configured) rather than parking at waiting_external.
    expect(secondState?.issues["POL-1109"]?.status).toBe("released");
    expect(secondState?.issues["POL-1109"]?.active_run_id).toBeUndefined();

    const phantomEvent = events.find((event) => event.event === "phantom_active_run");
    expect(phantomEvent).toMatchObject({
      level: "warn",
      event: "phantom_active_run",
      payload: {
        issue: "POL-1109",
        run_id: "run-phantom",
        retry_count: 1,
        next_status: "waiting_retry",
      },
    });
    expect(phantomEvent?.message).toContain("POL-1109");
    expect(phantomEvent?.message).toContain("run-phantom");
  });

  test("tick keeps issues with valid active runs active without relaunching", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-live-active-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-live",
      identifier: "POL-1110",
      title: "Respect live active run",
      updated_at: "2026-04-18T12:10:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-04-18T12:10:00.000Z",
          issues: [issue],
        };
      },
    }));

    const launchCalls: RunIntent[] = [];
    const liveIntent: RunIntent = {
      run_id: "run-live",
      kernel: "agent_runner",
      host: "blade",
      issue: issue.identifier,
      backend: "codex",
      prompt: "Existing run",
      created_at: "2026-04-18T12:00:00.000Z",
      worktree_path: join(root, "wt", "POL-1110"),
      branch: "calyx/POL-1110",
    };
    const runRecords = new Map<string, RunRecord>([["run-live", makeRunRecord(liveIntent, "running")]]);
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        launchCalls.push({
          run_id: "unexpected",
          host: input.host,
          created_at: "2026-04-18T12:10:00.000Z",
        });
        return {
          run_id: "unexpected",
          host: input.host,
          created_at: "2026-04-18T12:10:00.000Z",
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded");
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runRecords.get(runId);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-04-18T12:10:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-pol-1110");
    await daemon.store.writeStateSnapshot("daemon-pol-1110", {
      schema_version: "1.0",
      daemon_id: "daemon-pol-1110",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: ["run-live"],
      issues: {
        "POL-1110": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: issue.state.name,
          state_type: issue.state.type,
          workspace_key: "POL-1110",
          workspace_path: join(root, "wt", "POL-1110"),
          branch_name: "calyx/POL-1110",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-04-18T12:09:00.000Z",
          active_run_id: "run-live",
        },
      },
    });

    const result = await daemon.tick(workflowPath, "daemon-pol-1110", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-pol-1110");
    const events = await daemon.readLogs("daemon-pol-1110");

    expect(result.launched_runs).toEqual([]);
    expect(result.active_runs).toBe(1);
    expect(launchCalls).toEqual([]);
    expect(state?.issues["POL-1110"]?.active_run_id).toBe("run-live");
    expect(events.some((event) => event.event === "phantom_active_run")).toBe(false);
  });

  test("failed runs stop retrying after max_retries is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-daemon-retry-cap-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-4",
      identifier: "POL-917",
      title: "Cap retries",
      updated_at: "2026-03-20T12:30:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-03-20T12:30:00.000Z",
          issues: [issue],
        };
      },
    }));

    let runCounter = 0;
    let launchedRecord: RunRecord | undefined;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        runCounter += 1;
        return {
          run_id: `run-${runCounter}`,
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-03-20T12:30:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        const record = makeRunRecord(intent, "failed", {
          summary: "Failed again",
        });
        launchedRecord = record;
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
      async getResourceTerminalAuthority() {
        return fakeResourceTerminalAuthority(launchedRecord);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-03-20T12:30:00.000Z",
        exec: async (_cmd, args) => {
          if (args[0] === "show-ref") {
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-pol-917");
    await mkdir(join(root, "wt", "POL-917"), { recursive: true });
    await daemon.store.writeStateSnapshot("daemon-pol-917", {
      schema_version: "1.0",
      daemon_id: "daemon-pol-917",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-917": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: issue.state.name,
          state_type: issue.state.type,
          workspace_key: "POL-917",
          workspace_path: join(root, "wt", "POL-917"),
          branch_name: "calyx/POL-917",
          status: "waiting_retry",
          claim_status: "claimed",
          retry_count: 5,
          last_seen_at: "2026-03-20T12:29:00.000Z",
          retry_due_at: "2026-03-20T12:29:01.000Z",
        },
      },
    });

    await daemon.tick(workflowPath, "daemon-pol-917", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-pol-917");

    expect(state?.issues["POL-917"]?.status).toBe("waiting_external");
    expect(state?.issues["POL-917"]?.retry_count).toBe(6);
    expect(state?.issues["POL-917"]?.retry_due_at).toBeUndefined();
  });
});

async function makeStateDb(): Promise<{
  db: Awaited<ReturnType<typeof openStateStore>>["db"];
  cleanup: () => Promise<void>;
}> {
  const previous = {
    CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
    CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
  };
  delete process.env["CALYX_STATE_DB"];
  const root = await mkdtemp(join(tmpdir(), "calyx-symphony-ledger-"));
  process.env["CALYX_STATE_HOME"] = join(root, "state");
  await applyStateMigrations();
  const opened = await openStateStore();
  return {
    db: opened.db,
    cleanup: async () => {
      opened.db.close();
      if (previous.CALYX_STATE_HOME === undefined) {
        delete process.env["CALYX_STATE_HOME"];
      } else {
        process.env["CALYX_STATE_HOME"] = previous.CALYX_STATE_HOME;
      }
      if (previous.CALYX_STATE_DB === undefined) {
        delete process.env["CALYX_STATE_DB"];
      } else {
        process.env["CALYX_STATE_DB"] = previous.CALYX_STATE_DB;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("DaemonService Symphony v0 ledger", () => {
  const created: string[] = [];
  let stateDbHandle: { db: Awaited<ReturnType<typeof openStateStore>>["db"]; cleanup: () => Promise<void> } | undefined;

  afterEach(async () => {
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
    if (stateDbHandle) {
      await stateDbHandle.cleanup();
      stateDbHandle = undefined;
    }
  });

  test("tick claims via tracker, mirrors ledger events, and posts a bounded handoff receipt on successful handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-tick-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    const claimCalls: TrackerClaimRequest[] = [];
    const handoffCalls: TrackerHandoffRequest[] = [];
    const issue: TrackerIssue = {
      id: "issue-symph-1",
      identifier: "POL-2001",
      title: "Symphony v0",
      updated_at: "2026-05-13T12:00:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: ["scope:calyx"],
      team: "Polli Labs",
      project: "Calyx",
    };
    let pollCount = 0;
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        pollCount += 1;
        return {
          fetched_at: "2026-05-13T12:00:00.000Z",
          issues: [issue],
        };
      },
      async claimIssue(request: TrackerClaimRequest): Promise<TrackerClaimResult> {
        claimCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-05-13T12:00:00.000Z",
        };
      },
      async handoffIssue(request: TrackerHandoffRequest): Promise<TrackerHandoffResult> {
        handoffCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-05-13T12:00:00.000Z",
          comment_id: "comment-1",
        };
      },
    }));

    const createIntentInputs: Array<Partial<RunIntent> & Pick<RunIntent, "host">> = [];
    let launchedRecord: RunRecord | undefined;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        createIntentInputs.push(input);
        return {
          run_id: "run-symph-1",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-05-13T12:00:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        const record = makeRunRecord(intent, "succeeded");
        launchedRecord = record;
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
      async getResourceTerminalAuthority() {
        return fakeResourceTerminalAuthority(launchedRecord);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
        host: "test-host",
        activityResolver: {
          async resolve() {
            return {
              activity_id: "activity-1",
              latest_assistant_turn_id: "turn-7",
            };
          },
        },
      },
      {
        now: () => "2026-05-13T12:00:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await mkdir(join(root, "wt", "POL-2001"), { recursive: true });
    const result = await daemon.tick(workflowPath, "daemon-symph", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-symph");

    expect(pollCount).toBeGreaterThan(0);
    expect(result.launched_runs).toEqual(["run-symph-1"]);
    expect(createIntentInputs).toHaveLength(1);
    expect(createIntentInputs[0]?.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(createIntentInputs[0]?.prompt).toContain(`Run: ${createIntentInputs[0]?.run_id}`);
    expect(createIntentInputs[0]?.prompt).not.toContain("Run: daemon-symph:POL-2001");
    expect(createIntentInputs[0]?.prompt).toContain("Daemon key: daemon-symph:POL-2001");
    expect(createIntentInputs[0]?.metadata).toMatchObject({
      daemon_run_key: "daemon-symph:POL-2001",
    });
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]?.target_state).toBe("In Progress");
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]?.target_state).toBe("In Review");
    expect(handoffCalls[0]?.comment_body).toContain("Calyx Symphony daemon");
    expect(handoffCalls[0]?.comment_body).toContain("activity-1");
    expect(handoffCalls[0]?.comment_body).toContain("calyx activity turns run:run-symph-1");
    expect(handoffCalls[0]?.comment_body).toContain("ledger_cursor:");
    expect(state?.issues["POL-2001"]?.handoff_at).toBeDefined();
    expect(state?.issues["POL-2001"]?.claim_status).toBe("released");

    // Ledger events: claim, launch, terminal, handoff.
    const ledger = daemon.ledger!;
    const events = ledger.listIssueEvents({
      daemonId: "daemon-symph",
      issueIdentifier: "POL-2001",
    });
    const types = events.map((event) => event.event_type);
    expect(types).toContain("issue.claimed");
    expect(types).toContain("issue.launched");
    expect(types).toContain("issue.terminal");
    expect(types).toContain("issue.handoff");
    // Cursors must be strictly monotonic in append order.
    const cursors = events.map((event) => event.cursor);
    const sorted = [...cursors].sort();
    expect(cursors).toEqual(sorted);
    // Lock released after handoff.
    expect(ledger.readClaim({ daemonId: "daemon-symph", issueIdentifier: "POL-2001" })).toBeUndefined();
  });

  test("restart reconstruction does not double-claim an issue with an open ledger claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-restart-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    const claimCalls: TrackerClaimRequest[] = [];
    const issue: TrackerIssue = {
      id: "issue-restart-1",
      identifier: "POL-3001",
      title: "Survive restart",
      updated_at: "2026-05-13T13:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T13:00:00.000Z",
          issues: [issue],
        };
      },
      async claimIssue(request: TrackerClaimRequest): Promise<TrackerClaimResult> {
        claimCalls.push(request);
        return {
          issue_id: request.issue.id,
          identifier: request.issue.identifier,
          previous_state: request.issue.state.name,
          current_state: request.target_state,
          transitioned: true,
          transition_at: "2026-05-13T13:00:00.000Z",
        };
      },
    }));

    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        return {
          run_id: "run-fresh",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-05-13T13:00:00.000Z",
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        const record = makeRunRecord(intent, "succeeded");
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
        host: "test-host",
      },
      {
        now: () => "2026-05-13T13:00:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    // Simulate a prior daemon instance: claim lock held + claim event written,
    // active_run_id pointed at a missing run record (a crash mid-run).
    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-restart",
      issueIdentifier: "POL-3001",
      ttlMs: 60 * 60 * 1000,
      metadata: { host: "test-host" },
    });
    ledger.recordEvent({
      daemonId: "daemon-restart",
      issueIdentifier: "POL-3001",
      issueId: issue.id,
      eventType: "issue.claimed",
      occurredAt: "2026-05-13T12:55:00.000Z",
      payload: { dispatch_reason: "new" },
    });
    ledger.recordEvent({
      daemonId: "daemon-restart",
      issueIdentifier: "POL-3001",
      issueId: issue.id,
      eventType: "issue.launched",
      occurredAt: "2026-05-13T12:55:30.000Z",
      payload: { run_id: "run-missing" },
    });

    await daemon.store.ensureDaemonRoot("daemon-restart");
    await daemon.store.writeStateSnapshot("daemon-restart", {
      schema_version: "1.0",
      daemon_id: "daemon-restart",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: ["run-missing"],
      issues: {
        "POL-3001": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "In Progress",
          state_type: "started",
          workspace_key: "POL-3001",
          workspace_path: join(root, "wt", "POL-3001"),
          branch_name: "calyx/POL-3001",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-05-13T12:55:00.000Z",
          active_run_id: "run-missing",
          claimed_at: "2026-05-13T12:55:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    // Restart-side reconciliation should clear the phantom active run but keep
    // the claim open (ledger has issue.claimed without issue.handoff).
    const reconciled = await daemon.reconcileFromLedger("daemon-restart", workflowPath);
    expect(reconciled.relinked).toContain("POL-3001");
    expect(reconciled.cleared).not.toContain("POL-3001");

    // Lock must still be held to prevent double-claim attempts.
    const lock = ledger.readClaim({ daemonId: "daemon-restart", issueIdentifier: "POL-3001" });
    expect(lock?.owner_id).toBe("daemon-restart");
    expect(lock?.lock_key).toBe(daemonLockKey("daemon-restart", "POL-3001"));

    // Sanity: aggregate id helper matches what events were written under.
    expect(daemonAggregateId("daemon-restart", "POL-3001")).toBe("daemon-restart:POL-3001");
    const events = ledger.listIssueEvents({
      daemonId: "daemon-restart",
      issueIdentifier: "POL-3001",
    });
    expect(events[0]?.aggregate_type).toBe(DAEMON_LEDGER_AGGREGATE_TYPE);
    expect(claimCalls).toHaveLength(0);
  });

  test("restart reconstruction restores active_run_id from the latest ledger launch event", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-relink-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-relink-1",
      identifier: "POL-3002",
      title: "Relink active run",
      updated_at: "2026-05-13T13:10:00.000Z",
      state: { name: "In Progress", type: "started" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T13:10:00.000Z",
          issues: [issue],
        };
      },
    }));

    const runIntent: RunIntent = {
      run_id: "run-ledger-live",
      kernel: "agent_runner",
      host: "local",
      backend: "codex",
      created_at: "2026-05-13T13:05:00.000Z",
    };
    const fakeRunService = {
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runId === "run-ledger-live" ? makeRunRecord(runIntent, "running") : undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
        host: "test-host",
      },
      {
        now: () => "2026-05-13T13:10:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-relink",
      issueIdentifier: "POL-3002",
      ttlMs: 60 * 60 * 1000,
      metadata: { host: "test-host" },
    });
    ledger.recordEvent({
      daemonId: "daemon-relink",
      issueIdentifier: "POL-3002",
      issueId: issue.id,
      eventType: "issue.claimed",
      occurredAt: "2026-05-13T13:04:00.000Z",
      payload: { dispatch_reason: "new" },
    });
    ledger.recordEvent({
      daemonId: "daemon-relink",
      issueIdentifier: "POL-3002",
      issueId: issue.id,
      eventType: "issue.launched",
      occurredAt: "2026-05-13T13:05:00.000Z",
      payload: { run_id: "run-ledger-live" },
    });

    await daemon.store.ensureDaemonRoot("daemon-relink");
    await daemon.store.writeStateSnapshot("daemon-relink", {
      schema_version: "1.0",
      daemon_id: "daemon-relink",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-3002": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "In Progress",
          state_type: "started",
          workspace_key: "POL-3002",
          workspace_path: join(root, "wt", "POL-3002"),
          branch_name: "calyx/POL-3002",
          status: "waiting_external",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-05-13T13:04:00.000Z",
          claimed_at: "2026-05-13T13:04:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    const reconciled = await daemon.reconcileFromLedger("daemon-relink", workflowPath);
    const state = await daemon.store.readStateSnapshot("daemon-relink");

    expect(reconciled.relinked).toContain("POL-3002");
    expect(state?.issues["POL-3002"]?.active_run_id).toBe("run-ledger-live");
    expect(state?.issues["POL-3002"]?.status).toBe("running");
  });

  test("restart reconstruction does not relink an already-finalized failed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-finalized-retry-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-finalized-1",
      identifier: "POL-3004",
      title: "Do not double count finalized failure",
      updated_at: "2026-05-13T13:30:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T13:30:00.000Z",
          issues: [issue],
        };
      },
    }));

    const failedIntent: RunIntent = {
      run_id: "run-finalized-failed",
      kernel: "agent_runner",
      host: "local",
      backend: "codex",
      created_at: "2026-05-13T13:25:00.000Z",
    };
    const launchCalls: RunIntent[] = [];
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        const intent = {
          run_id: "run-unexpected-retry",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-05-13T13:30:00.000Z",
        } satisfies RunIntent;
        launchCalls.push(intent);
        return intent;
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded");
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return runId === failedIntent.run_id
          ? makeRunRecord(failedIntent, "infra_error", {
            completed_at: "2026-05-13T13:25:10.000Z",
            summary: "backend exited before handoff",
          })
          : undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
      },
      {
        now: () => "2026-05-13T13:30:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-finalized",
      issueIdentifier: "POL-3004",
      ttlMs: 60 * 60 * 1000,
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized",
      issueIdentifier: "POL-3004",
      issueId: issue.id,
      eventType: "issue.claimed",
      occurredAt: "2026-05-13T13:24:00.000Z",
      payload: { dispatch_reason: "new" },
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized",
      issueIdentifier: "POL-3004",
      issueId: issue.id,
      eventType: "issue.launched",
      occurredAt: "2026-05-13T13:25:00.000Z",
      payload: { run_id: failedIntent.run_id },
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized",
      issueIdentifier: "POL-3004",
      issueId: issue.id,
      eventType: "issue.terminal",
      occurredAt: "2026-05-13T13:25:10.000Z",
      payload: { run_id: failedIntent.run_id, run_state: "infra_error" },
    });

    await daemon.store.ensureDaemonRoot("daemon-finalized");
    await daemon.store.writeStateSnapshot("daemon-finalized", {
      schema_version: "1.0",
      daemon_id: "daemon-finalized",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-3004": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "Todo",
          state_type: "unstarted",
          workspace_key: "POL-3004",
          workspace_path: join(root, "wt", "POL-3004"),
          branch_name: "calyx/POL-3004",
          status: "waiting_retry",
          claim_status: "claimed",
          retry_count: 1,
          last_seen_at: "2026-05-13T13:25:00.000Z",
          claimed_at: "2026-05-13T13:24:00.000Z",
          last_run_id: failedIntent.run_id,
          last_run_state: "infra_error",
          last_run_completed_at: "2026-05-13T13:25:10.000Z",
          retry_due_at: "2026-05-13T13:35:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    const firstResult = await daemon.tick(workflowPath, "daemon-finalized", { awaitLaunchedRuns: true });
    const secondResult = await daemon.tick(workflowPath, "daemon-finalized", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-finalized");
    const events = ledger.listIssueEvents({
      daemonId: "daemon-finalized",
      issueIdentifier: "POL-3004",
    });

    expect(firstResult.launched_runs).toEqual([]);
    expect(secondResult.launched_runs).toEqual([]);
    expect(launchCalls).toEqual([]);
    expect(state?.issues["POL-3004"]?.status).toBe("waiting_retry");
    expect(state?.issues["POL-3004"]?.retry_count).toBe(1);
    expect(state?.issues["POL-3004"]?.active_run_id).toBeUndefined();
    expect(events.filter((event) => event.event_type === "issue.terminal")).toHaveLength(1);
  });

  test("already-finalized failed runs can launch a real retry once retry_due_at matures", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-finalized-retry-due-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    await mkdir(join(root, "wt", "POL-3005"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-finalized-2",
      identifier: "POL-3005",
      title: "Retry after finalized failure",
      updated_at: "2026-05-13T13:40:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T13:40:00.000Z",
          issues: [issue],
        };
      },
    }));

    const failedRunId = "run-finalized-failed";
    const launchCalls: RunIntent[] = [];
    let launchedRecord: RunRecord | undefined;
    const fakeRunService = {
      createIntent(input: Partial<RunIntent> & Pick<RunIntent, "host">): RunIntent {
        return {
          run_id: "run-real-retry",
          kernel: input.kernel ?? "agent_runner",
          host: input.host,
          created_at: "2026-05-13T13:40:00.000Z",
          ...(input.issue ? { issue: input.issue } : {}),
          ...(input.backend ? { backend: input.backend } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.require_execplan !== undefined ? { require_execplan: input.require_execplan } : {}),
          ...(input.pull_execplan !== undefined ? { pull_execplan: input.pull_execplan } : {}),
          ...(input.max_turns_per_run !== undefined ? { max_turns_per_run: input.max_turns_per_run } : {}),
        };
      },
      async launch(intent: RunIntent): Promise<RunLaunchResult> {
        launchCalls.push(intent);
        const record = makeRunRecord(intent, "succeeded");
        launchedRecord = record;
        return {
          run_id: intent.run_id,
          state: record.state,
          mode: "foreground",
          run_dir: join(root, "runs", intent.run_id),
          record,
        };
      },
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
      async getResourceTerminalAuthority() {
        return fakeResourceTerminalAuthority(launchedRecord);
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
      },
      {
        now: () => "2026-05-13T13:40:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-finalized-due",
      issueIdentifier: "POL-3005",
      ttlMs: 60 * 60 * 1000,
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized-due",
      issueIdentifier: "POL-3005",
      issueId: issue.id,
      eventType: "issue.claimed",
      occurredAt: "2026-05-13T13:34:00.000Z",
      payload: { dispatch_reason: "new" },
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized-due",
      issueIdentifier: "POL-3005",
      issueId: issue.id,
      eventType: "issue.launched",
      occurredAt: "2026-05-13T13:35:00.000Z",
      payload: { run_id: failedRunId },
    });
    ledger.recordEvent({
      daemonId: "daemon-finalized-due",
      issueIdentifier: "POL-3005",
      issueId: issue.id,
      eventType: "issue.terminal",
      occurredAt: "2026-05-13T13:35:10.000Z",
      payload: { run_id: failedRunId, run_state: "infra_error" },
    });

    await daemon.store.ensureDaemonRoot("daemon-finalized-due");
    await daemon.store.writeStateSnapshot("daemon-finalized-due", {
      schema_version: "1.0",
      daemon_id: "daemon-finalized-due",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-3005": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "Todo",
          state_type: "unstarted",
          workspace_key: "POL-3005",
          workspace_path: join(root, "wt", "POL-3005"),
          branch_name: "calyx/POL-3005",
          status: "waiting_retry",
          claim_status: "claimed",
          retry_count: 1,
          last_seen_at: "2026-05-13T13:35:00.000Z",
          claimed_at: "2026-05-13T13:34:00.000Z",
          last_run_id: failedRunId,
          last_run_state: "infra_error",
          last_run_completed_at: "2026-05-13T13:35:10.000Z",
          retry_due_at: "2026-05-13T13:39:59.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    const result = await daemon.tick(workflowPath, "daemon-finalized-due", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-finalized-due");

    expect(result.launched_runs).toEqual(["run-real-retry"]);
    expect(result.retried_runs).toEqual(["run-real-retry"]);
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.metadata?.["daemon_dispatch_reason"]).toBe("retry");
    expect(state?.issues["POL-3005"]?.claim_status).toBe("released");
    expect(state?.issues["POL-3005"]?.last_run_id).toBe("run-real-retry");
    expect(state?.issues["POL-3005"]?.retry_count).toBe(1);
  });

  test("restart reconstruction releases ledger locks for already-handed-off claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-release-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T13:20:00.000Z",
          issues: [],
        };
      },
    }));
    const fakeRunService = {
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
      },
      {
        now: () => "2026-05-13T13:20:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-release",
      issueIdentifier: "POL-3003",
      ttlMs: 60 * 60 * 1000,
    });
    ledger.recordEvent({
      daemonId: "daemon-release",
      issueIdentifier: "POL-3003",
      issueId: "issue-release-1",
      eventType: "issue.claimed",
      occurredAt: "2026-05-13T13:15:00.000Z",
      payload: { dispatch_reason: "new" },
    });
    ledger.recordEvent({
      daemonId: "daemon-release",
      issueIdentifier: "POL-3003",
      issueId: "issue-release-1",
      eventType: "issue.handoff",
      occurredAt: "2026-05-13T13:16:00.000Z",
      payload: { run_id: "run-release" },
    });

    await daemon.store.ensureDaemonRoot("daemon-release");
    await daemon.store.writeStateSnapshot("daemon-release", {
      schema_version: "1.0",
      daemon_id: "daemon-release",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-3003": {
          issue_id: "issue-release-1",
          issue_identifier: "POL-3003",
          title: "Already handed off",
          state_name: "In Review",
          workspace_key: "POL-3003",
          workspace_path: join(root, "wt", "POL-3003"),
          branch_name: "calyx/POL-3003",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-05-13T13:15:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    const reconciled = await daemon.reconcileFromLedger("daemon-release", workflowPath);
    const state = await daemon.store.readStateSnapshot("daemon-release");

    expect(reconciled.cleared).toContain("POL-3003");
    expect(ledger.readClaim({ daemonId: "daemon-release", issueIdentifier: "POL-3003" })).toBeUndefined();
    expect(state?.issues["POL-3003"]?.claim_status).toBe("released");
  });

  test("tick releases same-daemon ledger claims when claimed issues disappear from the tracker", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-disappeared-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-14T15:00:00.000Z",
          issues: [],
        };
      },
    }));
    const fakeRunService = {
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
      },
      {
        now: () => "2026-05-14T15:00:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-disappeared",
      issueIdentifier: "POL-1400",
      ttlMs: 60 * 60 * 1000,
    });
    ledger.recordEvent({
      daemonId: "daemon-disappeared",
      issueIdentifier: "POL-1400",
      issueId: "issue-disappeared-1",
      eventType: "issue.claimed",
      occurredAt: "2026-05-14T14:55:00.000Z",
      payload: { dispatch_reason: "new" },
    });

    await daemon.store.ensureDaemonRoot("daemon-disappeared");
    await mkdir(join(root, "wt", "POL-1400"), { recursive: true });
    await daemon.store.writeStateSnapshot("daemon-disappeared", {
      schema_version: "1.0",
      daemon_id: "daemon-disappeared",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-1400": {
          issue_id: "issue-disappeared-1",
          issue_identifier: "POL-1400",
          title: "Disappeared claimed issue",
          state_name: "Todo",
          workspace_key: "POL-1400",
          workspace_path: join(root, "wt", "POL-1400"),
          branch_name: "calyx/POL-1400",
          status: "idle",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-05-14T14:55:00.000Z",
          claimed_at: "2026-05-14T14:55:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    const result = await daemon.tick(workflowPath, "daemon-disappeared");
    const state = await daemon.store.readStateSnapshot("daemon-disappeared");

    expect(result.released_issues).toEqual(["POL-1400"]);
    expect(state?.issues["POL-1400"]?.claim_status).toBe("released");
    expect(state?.issues["POL-1400"]?.status).toBe("released");
    expect(ledger.readClaim({ daemonId: "daemon-disappeared", issueIdentifier: "POL-1400" })).toBeUndefined();
  });

  test("tick clears already-released same-daemon claim residue without releasing other owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-residue-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    stateDbHandle = await makeStateDb();

    const trackerRegistry = createTrackerRegistry();
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-14T16:00:00.000Z",
          issues: [],
        };
      },
    }));
    const fakeRunService = {
      async getRunRecord(): Promise<RunRecord | undefined> {
        return undefined;
      },
    async stop(runId: string): Promise<RunCancellationResult> {
      return cancellationRequested(runId);
    },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
        stateDb: stateDbHandle.db,
      },
      {
        now: () => "2026-05-14T16:00:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    const ledger = daemon.ledger!;
    ledger.acquireClaim({
      daemonId: "daemon-residue",
      issueIdentifier: "POL-1400",
      ttlMs: 60 * 60 * 1000,
    });
    acquireLock(
      stateDbHandle.db,
      {
        lock_key: daemonLockKey("daemon-residue", "POL-1401"),
        owner_id: "other-daemon",
        ttl_ms: 60 * 60 * 1000,
      },
      () => new Date("2026-05-14T15:55:00.000Z"),
    );

    await daemon.store.ensureDaemonRoot("daemon-residue");
    await daemon.store.writeStateSnapshot("daemon-residue", {
      schema_version: "1.0",
      daemon_id: "daemon-residue",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: [],
      issues: {
        "POL-1400": {
          issue_id: "issue-residue-1",
          issue_identifier: "POL-1400",
          title: "Released local residue",
          state_name: "Done",
          workspace_key: "POL-1400",
          workspace_path: join(root, "wt", "POL-1400"),
          branch_name: "calyx/POL-1400",
          status: "released",
          claim_status: "released",
          retry_count: 0,
          last_seen_at: "2026-05-14T15:50:00.000Z",
          released_at: "2026-05-14T15:50:00.000Z",
        } satisfies IssueRuntimeRecord,
        "POL-1401": {
          issue_id: "issue-residue-2",
          issue_identifier: "POL-1401",
          title: "Other owner residue",
          state_name: "Done",
          workspace_key: "POL-1401",
          workspace_path: join(root, "wt", "POL-1401"),
          branch_name: "calyx/POL-1401",
          status: "released",
          claim_status: "released",
          retry_count: 0,
          last_seen_at: "2026-05-14T15:50:00.000Z",
          released_at: "2026-05-14T15:50:00.000Z",
        } satisfies IssueRuntimeRecord,
      },
    });

    await daemon.tick(workflowPath, "daemon-residue");
    const state = await daemon.store.readStateSnapshot("daemon-residue");

    expect(ledger.readClaim({ daemonId: "daemon-residue", issueIdentifier: "POL-1400" })).toBeUndefined();
    expect(state?.issues["POL-1400"]?.released_at).toBe("2026-05-14T15:50:00.000Z");
    const otherOwnerLock = ledger.readClaim({ daemonId: "daemon-residue", issueIdentifier: "POL-1401" });
    expect(otherOwnerLock?.owner_id).toBe("other-daemon");
    expect(state?.issues["POL-1401"]?.released_at).toBe("2026-05-14T15:50:00.000Z");
  });

  test("stall guard does not stop runs that are still healthy or recently active", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-symphony-stall-"));
    created.push(root);
    await mkdir(join(root, "repo"), { recursive: true });
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(workflowPath, makeWorkflowContent(root), "utf8");

    const trackerRegistry = createTrackerRegistry();
    const issue: TrackerIssue = {
      id: "issue-live",
      identifier: "POL-4001",
      title: "Live stall check",
      updated_at: "2026-05-13T12:00:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      labels: [],
      team: "Polli Labs",
      project: "Calyx",
    };
    trackerRegistry.register("linear", () => ({
      kind: "linear",
      async pollIssues(): Promise<TrackerPollResult> {
        return {
          fetched_at: "2026-05-13T12:00:00.000Z",
          issues: [issue],
        };
      },
    }));

    const stopCalls: string[] = [];
    const fakeRunService = {
      async getRunRecord(runId: string): Promise<RunRecord | undefined> {
        return {
          ...makeRunRecord(
            {
              run_id: runId,
              host: "local",
              backend: "codex",
              created_at: "2026-05-13T11:00:00.000Z",
            },
            "running",
          ),
          updated_at: "2026-05-13T11:55:00.000Z",
          health: {
            source: "agent_runner",
            status: "healthy",
            checked_at: "2026-05-13T11:59:00.000Z",
            stale_after_ms: 60_000,
            last_activity_at: "2026-05-13T11:59:00.000Z",
            last_progress_at: "2026-05-13T11:59:00.000Z",
            observations: [],
            summary: "agent-runner heartbeat fresh",
          },
        };
      },
      async stop(runId: string): Promise<RunCancellationResult> {
        stopCalls.push(runId);
        return cancellationRequested(runId);
      },
      async reconcile(): Promise<ReconcileResult> {
      return {
        scanned: 0,
        rebuilt: [],
        classified: [],
        adopted: [],
        unresolved: [],
        skipped: [],
        noncanonical_directories: [],
        projection: { status: "not_configured" },
      };
      },
    } as unknown as import("../service.js").RunService;

    const daemon = new DaemonService(
      {
        trackerRegistry,
        runService: fakeRunService,
        daemonsRoot: join(root, "daemons"),
      },
      {
        now: () => "2026-05-13T12:00:00.000Z",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    await daemon.store.ensureDaemonRoot("daemon-stall");
    await daemon.store.writeStateSnapshot("daemon-stall", {
      schema_version: "1.0",
      daemon_id: "daemon-stall",
      workflow_path: workflowPath,
      current_interval_seconds: 60,
      active_run_ids: ["run-live-1"],
      issues: {
        "POL-4001": {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          title: issue.title,
          state_name: "Todo",
          state_type: "unstarted",
          workspace_key: "POL-4001",
          workspace_path: join(root, "wt", "POL-4001"),
          branch_name: "calyx/POL-4001",
          status: "running",
          claim_status: "claimed",
          retry_count: 0,
          last_seen_at: "2026-05-13T11:59:00.000Z",
          active_run_id: "run-live-1",
        },
      },
    });

    const result = await daemon.tick(workflowPath, "daemon-stall", { awaitLaunchedRuns: true });
    const state = await daemon.store.readStateSnapshot("daemon-stall");
    const events = await daemon.readLogs("daemon-stall");

    expect(stopCalls).toEqual([]);
    expect(result.cancellation_requested_runs).toEqual([]);
    expect(state?.issues["POL-4001"]?.status).toBe("running");
    expect(state?.issues["POL-4001"]?.retry_count).toBe(0);
    expect(events.some((event) => event.event === "stall_check_skipped_live")).toBe(true);
  });
});
