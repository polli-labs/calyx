import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

import {
  completeMonitorDelivery,
  createMonitorDeliveryAttempt,
  listMonitorDeliveries,
  monitorDeliveryBindings,
  readRunnerLiveBinding,
  readRunnerLiveBindingByRunAdapter,
  readMonitorDeliveryByWakeBinding,
  type MonitorDeliveryAdapterBindingV1,
  type MonitorDeliveryRow,
  type MonitorRow,
  type MonitorWakeRow,
  type PredicateEvidenceRecord,
  type RunnerLiveBindingRow,
  type StateDriverDatabase,
} from "@polli-labs/calyx-core";
import type {
  CodexAppServerSteerInput,
  CodexAppServerSteerResult,
} from "@polli-labs/calyx-runner";
import {
  postTextDeliveryV1,
  type DeliveryV1Fetch,
} from "./delivery.js";
import { redactServerOnlyEnvironment } from "./worker-supervisor.js";

export type MonitorDeliveryFetch = DeliveryV1Fetch;

export type MonitorDeliveryExecFile = (
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
  },
) => Promise<{
  stdout: string;
  stderr: string;
}>;

export type MonitorDeliveryCodexAppServerSteer = (
  input: CodexAppServerSteerInput,
) => Promise<CodexAppServerSteerResult>;

export interface MonitorDeliveryDependencies {
  now: () => string;
  audience?: "all" | "human_only" | undefined;
  fetch?: MonitorDeliveryFetch | undefined;
  execFile?: MonitorDeliveryExecFile | undefined;
  codexAppServerSteer?: MonitorDeliveryCodexAppServerSteer | undefined;
  env?: Record<string, string | undefined> | undefined;
  serverOnlyEnvNames?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

export interface MonitorDeliverySummary {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
  records: MonitorDeliveryRow[];
}

interface DeliveryOutcome {
  status: "delivered" | "failed";
  target: Record<string, unknown>;
  evidence: Record<string, unknown>;
  error_code?: string | null | undefined;
  error_message?: string | null | undefined;
}

const DEFAULT_NTFY_URL = "https://blade.tailc29f0.ts.net/ntfy";
const DEFAULT_NTFY_TOPIC = "agent-notify";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const DEFAULT_EXTERNAL_WRITE_TIMEOUT_MS = 10_000;
const DEFAULT_CLAUDE_REINVOKE_TIMEOUT_MS = 30_000;
const DEFAULT_CLAUDE_CHANNEL_RECEIVER_URL = "http://127.0.0.1:8788/calyx/monitor-wake";
const DEFAULT_CLAUDE_CHANNEL_TOKEN_ENV = "CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN";
const DEFAULT_CODEX_WAKE_RRULE = "RRULE:FREQ=MINUTELY;INTERVAL=1";
const CLAUDE_CHANNEL_POST_SCHEMA_VERSION = "calyx.monitor-claude-channel-post/v1";
const CODEX_APP_SERVER_STEER_PAYLOAD_SCHEMA_VERSION = "calyx.monitor-codex-app-server-steer/v1";

export async function deliverMonitorWakeBindings(
  db: StateDriverDatabase,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
): Promise<MonitorDeliverySummary> {
  const bindings = monitorDeliveryBindings(wake.delivery);
  const summary: MonitorDeliverySummary = {
    attempted: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    records: [],
  };

  for (const binding of bindings) {
    if (deps.audience === "human_only" && isAgentSessionAdapter(binding.adapter)) {
      summary.skipped += 1;
      continue;
    }
    if (binding.enabled === false || !deliveryMaterialityMatches(binding, wake)) {
      summary.skipped += 1;
      continue;
    }
    const existing = readMonitorDeliveryByWakeBinding(
      db,
      wake.wake_id,
      binding.binding_id,
    );
    if (existing) {
      summary.skipped += 1;
      summary.records.push(existing);
      continue;
    }

    const target = plannedTarget(binding, monitor, wake, deps.env ?? process.env);
    const attempt = createMonitorDeliveryAttempt(db, {
      wake,
      binding,
      attempted_at: deps.now(),
      target,
      evidence: {
        materiality: binding.materiality,
        wake_id: wake.wake_id,
        transition_hash: wake.transition_hash,
      },
    });
    if (!attempt.inserted) {
      summary.skipped += 1;
      summary.records.push(attempt.delivery);
      continue;
    }
    summary.attempted += 1;

    const outcome = await deliverBinding(db, binding, monitor, wake, deps, target);
    const completed = completeMonitorDelivery(db, {
      delivery_id: attempt.delivery.delivery_id,
      status: outcome.status,
      completed_at: deps.now(),
      target: outcome.target,
      evidence: outcome.evidence,
      error_code: outcome.error_code ?? null,
      error_message: outcome.error_message ?? null,
    }) ?? attempt.delivery;
    summary.records.push(completed);
    if (completed.status === "delivered") {
      summary.delivered += 1;
    } else if (completed.status === "failed") {
      summary.failed += 1;
    }
  }

  if (summary.records.length === 0) {
    summary.records = listMonitorDeliveries(db, { wake_id: wake.wake_id });
  }
  return summary;
}

function isAgentSessionAdapter(adapter: MonitorDeliveryAdapterBindingV1["adapter"]): boolean {
  return adapter === "codex_automation"
    || adapter === "codex_app_server_steer"
    || adapter === "claude_reinvoke"
    || adapter === "claude_channel";
}

export function deliveryMaterialityMatches(
  binding: MonitorDeliveryAdapterBindingV1,
  wake: MonitorWakeRow,
): boolean {
  switch (binding.materiality.kind) {
    case "always":
      return wake.evaluation.matched;
    case "run_failed_or_stalled":
      return evidenceMatched(wake, ["run.failed", "run.health_stale"])
        || matchedTerminalState(wake, new Set(["failed", "auth_error", "infra_error"]));
    case "run_success":
      return matchedTerminalState(wake, new Set(["succeeded"]));
    case "artifact_churn":
      return evidenceMatched(wake, ["artifact.changed", "vault.path_changed"]);
    default: {
      const exhaustive: never = binding.materiality.kind;
      return Boolean(exhaustive);
    }
  }
}

async function deliverBinding(
  db: StateDriverDatabase,
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  switch (binding.adapter) {
    case "ntfy":
      return deliverNtfy(binding, monitor, wake, deps, target);
    case "linear_comment":
      return deliverLinearComment(binding, monitor, wake, deps, target);
    case "vault_receipt":
      return deliverVaultReceipt(binding, monitor, wake, deps, target);
    case "codex_automation":
      return deliverCodexAutomation(binding, monitor, wake, deps, target);
    case "codex_app_server_steer":
      return deliverCodexAppServerSteer(db, binding, monitor, wake, deps, target);
    case "claude_reinvoke":
      return deliverClaudeReinvoke(binding, monitor, wake, deps, target);
    case "claude_channel":
      return deliverClaudeChannel(binding, monitor, wake, deps, target);
    default: {
      const exhaustive: never = binding.adapter;
      return failedOutcome(target, "unsupported_adapter", String(exhaustive));
    }
  }
}

function plannedTarget(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  switch (binding.adapter) {
    case "ntfy": {
      const topic = binding.ntfy?.topic
        ?? env["CALYX_MONITOR_NTFY_TOPIC"]
        ?? env["AGENT_NOTIFY_NTFY_TOPIC"]
        ?? DEFAULT_NTFY_TOPIC;
      const url = binding.ntfy?.url
        ?? env["CALYX_MONITOR_NTFY_URL"]
        ?? env["AGENT_NOTIFY_NTFY_URL"]
        ?? DEFAULT_NTFY_URL;
      return { adapter: "ntfy", url, topic };
    }
    case "linear_comment": {
      const issue_id = binding.linear_comment?.issue_id ?? issueFromWake(wake) ?? null;
      return {
        adapter: "linear_comment",
        issue_id,
        dry_run: binding.linear_comment?.dry_run === true
          || env["CALYX_MONITOR_LINEAR_DRY_RUN"] === "1",
      };
    }
    case "vault_receipt": {
      const root = binding.vault_receipt?.vault_root
        ?? env["CALYX_MONITOR_VAULT_ROOT"]
        ?? env["FIELDWORK_VAULT_ROOT"]
        ?? join(homedir(), "vault", "fieldwork");
      const date = wake.created_at.slice(0, 10);
      const directory = normalizeReceiptDirectory(
        binding.vault_receipt?.directory ?? `10-daily/${date}/calyx-monitor-receipts`,
      );
      const filename = `${sanitizePathPart(wake.wake_id)}-${sanitizePathPart(binding.binding_id)}.md`;
      return {
        adapter: "vault_receipt",
        vault_root: root,
        directory,
        path: join(root, directory, filename),
        dry_run: binding.vault_receipt?.dry_run === true,
      };
    }
    case "codex_automation": {
      const codexHome = binding.codex_automation?.codex_home
        ?? env["CALYX_MONITOR_CODEX_HOME"]
        ?? env["CODEX_HOME"]
        ?? join(homedir(), ".codex");
      const automationId = sanitizeAutomationId(
        binding.codex_automation?.automation_id
          ?? `calyx-monitor-wake-${wake.wake_id}`,
      );
      const status = binding.codex_automation?.status
        ?? (env["CALYX_MONITOR_CODEX_AUTOMATION_STATUS"] === "ACTIVE" ? "ACTIVE" : "PAUSED");
      return {
        adapter: "codex_automation",
        codex_home: codexHome,
        automation_id: automationId,
        automation_dir: join(codexHome, "automations", automationId),
        automation_path: join(codexHome, "automations", automationId, "automation.toml"),
        memory_path: join(codexHome, "automations", automationId, "memory.md"),
        thread_id: binding.codex_automation?.thread_id
          ?? env["CALYX_MONITOR_CODEX_THREAD_ID"]
          ?? null,
        cwd: binding.codex_automation?.cwd ?? undefined,
        status,
        dry_run: binding.codex_automation?.dry_run === true
          || env["CALYX_MONITOR_CODEX_AUTOMATION_DRY_RUN"] === "1",
        allow_update: binding.codex_automation?.allow_update === true,
      };
    }
    case "codex_app_server_steer": {
      return {
        adapter: "codex_app_server_steer",
        run_id: binding.codex_app_server_steer?.run_id
          ?? env["CALYX_MONITOR_CODEX_APP_SERVER_STEER_RUN_ID"]
          ?? monitor.source_run_id
          ?? null,
        live_binding_id: binding.codex_app_server_steer?.live_binding_id
          ?? env["CALYX_MONITOR_CODEX_APP_SERVER_STEER_BINDING_ID"]
          ?? null,
        timeout_ms: binding.codex_app_server_steer?.timeout_ms
          ?? parsePositiveInteger(env["CALYX_MONITOR_CODEX_APP_SERVER_STEER_TIMEOUT_MS"])
          ?? undefined,
        dry_run: binding.codex_app_server_steer?.dry_run === true
          || env["CALYX_MONITOR_CODEX_APP_SERVER_STEER_DRY_RUN"] === "1",
      };
    }
    case "claude_reinvoke": {
      return {
        adapter: "claude_reinvoke",
        command: binding.claude_reinvoke?.command
          ?? env["CALYX_MONITOR_CLAUDE_COMMAND"]
          ?? "claude",
        cwd: binding.claude_reinvoke?.cwd ?? env["CALYX_MONITOR_CLAUDE_CWD"] ?? undefined,
        session_id: binding.claude_reinvoke?.session_id
          ?? env["CALYX_MONITOR_CLAUDE_SESSION_ID"]
          ?? null,
        continue_latest: binding.claude_reinvoke?.continue_latest === true
          || env["CALYX_MONITOR_CLAUDE_CONTINUE"] === "1",
        dry_run: binding.claude_reinvoke?.dry_run === true
          || env["CALYX_MONITOR_CLAUDE_DRY_RUN"] === "1",
      };
    }
    case "claude_channel": {
      return {
        adapter: "claude_channel",
        receiver_url: binding.claude_channel?.receiver_url
          ?? env["CALYX_MONITOR_CLAUDE_CHANNEL_URL"]
          ?? DEFAULT_CLAUDE_CHANNEL_RECEIVER_URL,
        channel: binding.claude_channel?.channel
          ?? env["CALYX_MONITOR_CLAUDE_CHANNEL_TARGET"]
          ?? null,
        token_env: binding.claude_channel?.token_env
          ?? env["CALYX_MONITOR_CLAUDE_CHANNEL_TOKEN_ENV"]
          ?? DEFAULT_CLAUDE_CHANNEL_TOKEN_ENV,
        timeout_ms: binding.claude_channel?.timeout_ms
          ?? parsePositiveInteger(env["CALYX_MONITOR_CLAUDE_CHANNEL_TIMEOUT_MS"])
          ?? undefined,
        dry_run: binding.claude_channel?.dry_run === true
          || env["CALYX_MONITOR_CLAUDE_CHANNEL_DRY_RUN"] === "1",
      };
    }
  }
}

async function deliverNtfy(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const fetchImpl = resolveFetch(deps);
  if (!fetchImpl) {
    return failedOutcome(target, "adapter_unavailable", "global fetch is unavailable for ntfy delivery");
  }
  const baseUrl = String(target["url"] ?? DEFAULT_NTFY_URL).replace(/\/+$/, "");
  const topic = String(target["topic"] ?? DEFAULT_NTFY_TOPIC);
  const url = `${baseUrl}/${encodeURIComponent(topic)}`;
  const body = renderPlainWakeSummary(monitor, wake);
  try {
    const response = await postTextDeliveryV1(fetchImpl, url, {
      timeoutMs: deps.timeoutMs ?? DEFAULT_EXTERNAL_WRITE_TIMEOUT_MS,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: `Calyx monitor ${monitor.monitor_id}`,
        Tags: "calyx,monitor",
        ...(binding.ntfy?.priority ? { Priority: binding.ntfy.priority } : {}),
      },
      body,
    });
    const responseText = response.response_text;
    const evidence = {
      adapter: "ntfy",
      http_status: response.status,
      response_text: responseText.slice(0, 500),
      body,
    };
    if (!response.ok) {
      return failedOutcome({ ...target, url }, "http_error", `ntfy returned HTTP ${response.status}`, evidence);
    }
    return { status: "delivered", target: { ...target, url }, evidence };
  } catch (err) {
    return failedOutcome({ ...target, url }, "network_error", errorMessage(err));
  }
}

async function deliverLinearComment(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const env = deps.env ?? process.env;
  const issueIdentifier = typeof target["issue_id"] === "string"
    ? target["issue_id"].trim()
    : "";
  const body = renderLinearCommentBody(monitor, wake);
  if (!issueIdentifier) {
    return failedOutcome(target, "target_unavailable", "linear_comment delivery could not resolve a Linear issue target", {
      adapter: "linear_comment",
      prepared_body: body,
    });
  }
  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target,
      evidence: {
        adapter: "linear_comment",
        mode: "dry_run",
        issue_id: issueIdentifier,
        prepared_external_write: true,
        prepared_body: body,
      },
    };
  }
  const apiKey = env["LINEAR_API_KEY"];
  if (!apiKey) {
    return failedOutcome(target, "credential_unavailable", "LINEAR_API_KEY is unavailable to the run-service process", {
      adapter: "linear_comment",
      prepared_body: body,
    });
  }
  const fetchImpl = resolveFetch(deps);
  if (!fetchImpl) {
    return failedOutcome(target, "adapter_unavailable", "global fetch is unavailable for Linear delivery");
  }
  try {
    const issue = await linearGraphql<{ issue?: { id?: string; identifier?: string; url?: string } }>(
      fetchImpl,
      deps,
      apiKey,
      `query IssueById($id: String!) {
        issue(id: $id) { id identifier url }
      }`,
      { id: issueIdentifier },
    );
    const issueId = issue.issue?.id;
    if (!issueId) {
      return failedOutcome(target, "target_unavailable", `Linear issue not found: ${issueIdentifier}`, {
        adapter: "linear_comment",
        prepared_body: body,
      });
    }
    const comment = await linearGraphql<{ commentCreate?: { success?: boolean; comment?: { id?: string; url?: string } } }>(
      fetchImpl,
      deps,
      apiKey,
      `mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id url } }
      }`,
      { input: { issueId, body } },
    );
    if (comment.commentCreate?.success !== true) {
      return failedOutcome(target, "provider_error", "Linear commentCreate returned success=false", {
        adapter: "linear_comment",
        issue_id: issueIdentifier,
        prepared_body: body,
      });
    }
    return {
      status: "delivered",
      target: {
        ...target,
        issue_id: issueIdentifier,
        issue_uuid: issueId,
        issue_url: issue.issue?.url ?? null,
      },
      evidence: {
        adapter: "linear_comment",
        issue_id: issueIdentifier,
        comment_id: comment.commentCreate.comment?.id ?? null,
        comment_url: comment.commentCreate.comment?.url ?? null,
      },
    };
  } catch (err) {
    return failedOutcome(target, "provider_error", errorMessage(err), {
      adapter: "linear_comment",
      prepared_body: body,
    });
  }
}

async function deliverVaultReceipt(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  _deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const path = typeof target["path"] === "string" ? target["path"] : "";
  const markdown = renderVaultReceipt(monitor, wake, binding);
  if (!path) {
    return failedOutcome(target, "target_unavailable", "vault_receipt delivery could not resolve a receipt path", {
      adapter: "vault_receipt",
      prepared_body: markdown,
    });
  }
  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target,
      evidence: {
        adapter: "vault_receipt",
        mode: "dry_run",
        prepared_path: path,
        prepared_body: markdown,
      },
    };
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, { encoding: "utf8", flag: "wx" });
    return {
      status: "delivered",
      target,
      evidence: { adapter: "vault_receipt", path },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return {
        status: "delivered",
        target,
        evidence: { adapter: "vault_receipt", path, already_exists: true },
      };
    }
    return failedOutcome(target, "write_failed", errorMessage(err), {
      adapter: "vault_receipt",
      path,
      prepared_body: markdown,
    });
  }
}

async function deliverCodexAutomation(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const threadId = normalizedString(target["thread_id"]);
  const automationDir = normalizedString(target["automation_dir"]);
  const automationPath = normalizedString(target["automation_path"]);
  const memoryPath = normalizedString(target["memory_path"]);
  if (!threadId) {
    return failedOutcome(
      target,
      "target_unavailable",
      "codex_automation delivery requires a thread_id; app-server turn injection is intentionally out of scope",
      { adapter: "codex_automation", wake_id: wake.wake_id },
    );
  }
  if (!automationDir || !automationPath || !memoryPath) {
    return failedOutcome(target, "target_unavailable", "codex_automation delivery could not resolve an automation path", {
      adapter: "codex_automation",
      wake_id: wake.wake_id,
    });
  }

  const timestamp = isoToMillis(deps.now());
  const existingCreatedAt = await readExistingAutomationCreatedAt(automationPath);
  const automation = {
    version: 1,
    id: String(target["automation_id"] ?? `calyx-monitor-wake-${wake.wake_id}`),
    kind: "cron",
    name: binding.codex_automation?.name ?? `calyx monitor wake ${wake.wake_id}`,
    prompt: renderCodexAutomationPrompt(monitor, wake, threadId),
    status: target["status"] === "ACTIVE" ? "ACTIVE" : "PAUSED",
    rrule: binding.codex_automation?.rrule ?? DEFAULT_CODEX_WAKE_RRULE,
    ...(binding.codex_automation?.model ? { model: binding.codex_automation.model } : {}),
    ...(binding.codex_automation?.reasoning_effort ? { reasoning_effort: binding.codex_automation.reasoning_effort } : {}),
    ...(binding.codex_automation?.execution_environment ? { execution_environment: binding.codex_automation.execution_environment } : {}),
    ...(binding.codex_automation?.cwd ? { cwds: [binding.codex_automation.cwd] } : {}),
    created_at: existingCreatedAt ?? timestamp,
    updated_at: timestamp,
  };
  const tomlText = stringifyToml(automation as never);
  const memoryText = renderCodexAutomationMemory(monitor, wake, threadId);
  const evidence = {
    adapter: "codex_automation",
    surface: "codex_app_automation_toml",
    automation_id: automation.id,
    automation_path: automationPath,
    memory_path: memoryPath,
    thread_id: threadId,
    status: automation.status,
    rrule: automation.rrule,
    prompt_first_action: "calyx monitor inbox --json",
    programmatic_trigger_path: "not_exposed_by_codex_cli_0.138.0",
    bridge_floor: "wake remains pullable through calyx monitor inbox",
    prepared_toml: tomlText,
  };

  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target,
      evidence: {
        ...evidence,
        mode: "dry_run",
        prepared_external_write: true,
        prepared_memory: memoryText,
      },
    };
  }

  try {
    await mkdir(automationDir, { recursive: true });
    await writeFile(automationPath, tomlText, {
      encoding: "utf8",
      flag: target["allow_update"] === true ? "w" : "wx",
    });
    let memorySeeded = false;
    try {
      await writeFile(memoryPath, memoryText, { encoding: "utf8", flag: "wx" });
      memorySeeded = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return {
      status: "delivered",
      target,
      evidence: {
        ...evidence,
        memory_seeded: memorySeeded,
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return failedOutcome(
      target,
      code === "EEXIST" ? "target_exists" : "write_failed",
      errorMessage(err),
      evidence,
    );
  }
}

async function deliverCodexAppServerSteer(
  db: StateDriverDatabase,
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const targetRunId = normalizedString(target["run_id"]);
  const liveBindingId = normalizedString(target["live_binding_id"]);
  const liveBinding = resolveCodexSteerBinding(db, targetRunId, liveBindingId);
  if (!liveBinding) {
    return failedOutcome(target, "steer_binding_unavailable", "codex_app_server_steer delivery requires an active Calyx runner live binding", {
      adapter: "codex_app_server_steer",
      wake_id: wake.wake_id,
      requested_run_id: targetRunId ?? null,
      requested_live_binding_id: liveBindingId ?? null,
    });
  }

  const preconditionFailure = validateCodexSteerBinding(liveBinding, targetRunId, monitor);
  if (preconditionFailure) {
    return failedOutcome(targetForCodexSteer(target, liveBinding), preconditionFailure.code, preconditionFailure.message, {
      adapter: "codex_app_server_steer",
      live_binding_id: liveBinding.binding_id,
      run_id: liveBinding.run_id,
      thread_id: liveBinding.thread_id,
      bridge_floor: "wake remains pullable through calyx monitor inbox",
    });
  }

  const expectedTurnId = liveBinding.active_turn_id!;
  const steerInput = renderCodexAppServerSteerInput(monitor, wake, binding);
  const evidenceBase = {
    adapter: "codex_app_server_steer",
    payload_schema_version: CODEX_APP_SERVER_STEER_PAYLOAD_SCHEMA_VERSION,
    live_binding_id: liveBinding.binding_id,
    run_id: liveBinding.run_id,
    thread_id: liveBinding.thread_id,
    expected_turn_id: expectedTurnId,
    active_turn_source: liveBinding.active_turn_source,
    active_turn_observed_at: liveBinding.active_turn_observed_at,
    payload_first_action: firstMonitorInboxCommand(wake),
    bridge_floor: "wake remains pullable through calyx monitor inbox",
  };
  const completedTarget = targetForCodexSteer(target, liveBinding);

  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target: completedTarget,
      evidence: {
        ...evidenceBase,
        mode: "dry_run",
        prepared_request: {
          method: "turn/steer",
          params: {
            threadId: liveBinding.thread_id,
            expectedTurnId,
            input: steerInput,
          },
        },
      },
    };
  }

  const steer = deps.codexAppServerSteer;
  if (!steer) {
    return failedOutcome(
      completedTarget,
      "transport_unavailable",
      "codex_app_server_steer delivery has no active transport hook",
      evidenceBase,
    );
  }

  try {
    const result = await steer({
      run_id: liveBinding.run_id,
      thread_id: liveBinding.thread_id!,
      expected_turn_id: expectedTurnId,
      input: steerInput,
      ...(typeof target["timeout_ms"] === "number" ? { timeout_ms: target["timeout_ms"] } : {}),
    });
    return {
      status: "delivered",
      target: completedTarget,
      evidence: {
        ...evidenceBase,
        returned_turn_id: result.turn_id,
        response: boundEvidence(result.response, 2_000),
      },
    };
  } catch (error) {
    const code = steerFailureCode(error);
    return failedOutcome(completedTarget, code, errorMessage(error), {
      ...evidenceBase,
      failure_source: "turn/steer",
    });
  }
}

function resolveCodexSteerBinding(
  db: StateDriverDatabase,
  targetRunId: string | undefined,
  liveBindingId: string | undefined,
): RunnerLiveBindingRow | undefined {
  if (liveBindingId) {
    return readRunnerLiveBinding(db, liveBindingId);
  }
  if (!targetRunId) {
    return undefined;
  }
  return readRunnerLiveBindingByRunAdapter(db, targetRunId, "codex_app_server_steer");
}

function validateCodexSteerBinding(
  liveBinding: RunnerLiveBindingRow,
  targetRunId: string | undefined,
  monitor: MonitorRow,
): { code: string; message: string } | undefined {
  const expectedRunId = targetRunId ?? monitor.source_run_id ?? undefined;
  if (expectedRunId && liveBinding.run_id !== expectedRunId) {
    return {
      code: "steer_binding_unavailable",
      message: `live binding run ${liveBinding.run_id} does not match target run ${expectedRunId}`,
    };
  }
  if (liveBinding.status !== "active") {
    return {
      code: "transport_unavailable",
      message: `live binding ${liveBinding.binding_id} is ${liveBinding.status}, not active`,
    };
  }
  if (liveBinding.lifecycle_owner !== "calyx") {
    return {
      code: "steer_binding_unavailable",
      message: `live binding ${liveBinding.binding_id} is not Calyx-owned`,
    };
  }
  if (liveBinding.backend !== "codex" || liveBinding.adapter !== "codex_app_server_steer") {
    return {
      code: "steer_binding_unavailable",
      message: `live binding ${liveBinding.binding_id} is not a Codex app-server steer binding`,
    };
  }
  if (isDesktopAppServerEndpoint(liveBinding)) {
    return {
      code: "transport_unavailable",
      message: "Desktop app-server control endpoints are not structurally reachable by codex_app_server_steer",
    };
  }
  if (!liveBinding.thread_id) {
    return {
      code: "steer_binding_unavailable",
      message: `live binding ${liveBinding.binding_id} has no app-server thread_id`,
    };
  }
  if (Object.keys(liveBinding.auth_ref).length === 0) {
    return {
      code: "auth_unavailable",
      message: `live binding ${liveBinding.binding_id} has no auth reference descriptor`,
    };
  }
  if (!liveBinding.active_turn_id) {
    return {
      code: "no_steerable_turn",
      message: `live binding ${liveBinding.binding_id} has no active turn id`,
    };
  }
  if (!liveBinding.active_turn_source || !liveBinding.active_turn_observed_at) {
    return {
      code: "no_steerable_turn",
      message: `live binding ${liveBinding.binding_id} active turn was not observed from live event state`,
    };
  }
  if (!isActiveTurnStatusSteerable(liveBinding.active_turn_status)) {
    return {
      code: "active_turn_not_steerable",
      message: `live binding ${liveBinding.binding_id} active turn status is ${liveBinding.active_turn_status}`,
    };
  }
  return undefined;
}

function targetForCodexSteer(
  target: Record<string, unknown>,
  liveBinding: RunnerLiveBindingRow,
): Record<string, unknown> {
  return {
    ...target,
    run_id: liveBinding.run_id,
    live_binding_id: liveBinding.binding_id,
    thread_id: liveBinding.thread_id,
    expected_turn_id: liveBinding.active_turn_id,
    transport_kind: liveBinding.transport_kind,
  };
}

function renderCodexAppServerSteerInput(
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  binding: MonitorDeliveryAdapterBindingV1,
): Record<string, unknown>[] {
  const text = [
    "Calyx monitor wake bridge.",
    "",
    "First action: run `calyx monitor inbox --json`, locate the wake below, then acknowledge it with `calyx monitor ack` after handling.",
    "This steer carries a pointer only; do not treat this message as the monitor payload.",
    "",
    `Monitor: ${monitor.monitor_id}`,
    `Wake: ${wake.wake_id}`,
    `Materiality: ${binding.materiality.kind}`,
    `Transition: ${wake.transition_hash}`,
    monitor.source_run_id ? `Run: ${monitor.source_run_id}` : null,
    wake.receipt_path ? `Tier-0 receipt: ${wake.receipt_path}` : null,
    ...infraErrorClassificationLines(wake),
    "",
    "Suggested first command:",
    firstMonitorInboxCommand(wake),
  ].filter((line): line is string => line !== null).join("\n");
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function isDesktopAppServerEndpoint(liveBinding: RunnerLiveBindingRow): boolean {
  const haystack = JSON.stringify({
    transport_kind: liveBinding.transport_kind,
    endpoint: liveBinding.endpoint,
  });
  return haystack.includes("desktop-ssh-websocket-v0.sock")
    || haystack.includes(".codex/app-server-control")
    || haystack.includes("app-server-control/desktop");
}

function isActiveTurnStatusSteerable(status: string | null): boolean {
  if (!status) return true;
  const normalized = status.trim().toLowerCase().replace(/[-\s]/g, "_");
  return normalized === "active"
    || normalized === "in_progress"
    || normalized === "inprogress"
    || normalized === "running";
}

function steerFailureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (
    code === "no_steerable_turn"
    || code === "expected_turn_mismatch"
    || code === "transport_unavailable"
    || code === "steer_binding_unavailable"
    || code === "auth_unavailable"
    || code === "active_turn_not_steerable"
  ) {
    return code;
  }
  const message = errorMessage(error);
  if (looksLikeAuthError(message)) return "auth_unavailable";
  if (/\b(expectedTurnId|expected turn|mismatch)\b/i.test(message)) return "expected_turn_mismatch";
  if (/\b(no active turn|active turn|required active)\b/i.test(message)) return "no_steerable_turn";
  if (/\b(?:not steerable|review|compact)\b/i.test(message)) return "active_turn_not_steerable";
  return "transport_unavailable";
}

function boundEvidence(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  return { truncated_json: json.slice(0, maxChars), truncated: true };
}

async function deliverClaudeReinvoke(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const command = normalizedString(target["command"]) ?? "claude";
  const sessionId = normalizedString(target["session_id"]);
  const continueLatest = target["continue_latest"] === true;
  if (!sessionId && !continueLatest) {
    return failedOutcome(
      target,
      "target_unavailable",
      "claude_reinvoke delivery requires session_id or continue_latest=true",
      { adapter: "claude_reinvoke", wake_id: wake.wake_id },
    );
  }
  const prompt = renderClaudeReinvokePrompt(monitor, wake);
  const args = buildClaudeReinvokeArgs(binding, prompt, sessionId, continueLatest);
  const evidence = {
    adapter: "claude_reinvoke",
    command,
    args: redactPromptArg(args),
    cwd: normalizedString(target["cwd"]) ?? null,
    session_id: sessionId ?? null,
    continue_latest: continueLatest,
    prompt_first_action: "calyx monitor inbox --json",
    prompt_preview: prompt.slice(0, 1_000),
    bridge_floor: "wake remains pullable through calyx monitor inbox",
  };

  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target,
      evidence: {
        ...evidence,
        mode: "dry_run",
        prepared_external_process: true,
      },
    };
  }

  const execImpl = deps.execFile ?? defaultExecFile;
  const timeoutMs = binding.claude_reinvoke?.timeout_ms
    ?? parsePositiveInteger(deps.env?.["CALYX_MONITOR_CLAUDE_TIMEOUT_MS"])
    ?? DEFAULT_CLAUDE_REINVOKE_TIMEOUT_MS;
  try {
    const result = await execImpl(command, args, {
      cwd: normalizedString(target["cwd"]),
      env: mergedProcessEnv(deps.env, deps.serverOnlyEnvNames),
      timeoutMs,
    });
    return {
      status: "delivered",
      target,
      evidence: {
        ...evidence,
        stdout: result.stdout.slice(0, 4_000),
        stderr: result.stderr.slice(0, 4_000),
      },
    };
  } catch (err) {
    const output = isExecErrorWithOutput(err)
      ? {
          stdout: err.stdout.slice(0, 4_000),
          stderr: err.stderr.slice(0, 4_000),
        }
      : {};
    return failedOutcome(target, "process_failed", errorMessage(err), {
      ...evidence,
      ...output,
    });
  }
}

async function deliverClaudeChannel(
  binding: MonitorDeliveryAdapterBindingV1,
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  deps: MonitorDeliveryDependencies,
  target: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  const receiverUrl = normalizedString(target["receiver_url"]) ?? DEFAULT_CLAUDE_CHANNEL_RECEIVER_URL;
  const channel = normalizedString(target["channel"]);
  if (!channel) {
    return failedOutcome(
      target,
      "target_unavailable",
      "claude_channel delivery requires a channel target such as server:calyx-monitor or plugin:<name>",
      { adapter: "claude_channel", wake_id: wake.wake_id },
    );
  }
  const parsedUrl = parseLoopbackReceiverUrl(receiverUrl);
  if (typeof parsedUrl === "string") {
    return failedOutcome(
      target,
      "target_unavailable",
      parsedUrl,
      { adapter: "claude_channel", receiver_url: receiverUrl, channel },
    );
  }
  const fetchImpl = resolveFetch(deps);
  if (!fetchImpl) {
    return failedOutcome(target, "adapter_unavailable", "global fetch is unavailable for claude_channel delivery");
  }

  const payload = renderClaudeChannelPayload(monitor, wake, binding);
  const body = JSON.stringify(payload);
  const evidence = {
    adapter: "claude_channel",
    receiver_url: parsedUrl.toString(),
    channel,
    payload,
    payload_first_action: payload.first_command,
    channel_post_ack_semantics: "receiver_http_accept_only",
    bridge_floor: "wake remains pullable through calyx monitor inbox",
  };
  const completedTarget = {
    ...target,
    receiver_url: parsedUrl.toString(),
    channel,
  };

  if (target["dry_run"] === true) {
    return {
      status: "delivered",
      target: completedTarget,
      evidence: {
        ...evidence,
        mode: "dry_run",
        prepared_external_write: true,
        prepared_body: body,
      },
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const tokenEnv = normalizedString(target["token_env"]);
  const token = tokenEnv ? normalizedString((deps.env ?? process.env)[tokenEnv]) : undefined;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const timeoutMs = binding.claude_channel?.timeout_ms
    ?? (typeof target["timeout_ms"] === "number" ? target["timeout_ms"] : undefined)
    ?? parsePositiveInteger(deps.env?.["CALYX_MONITOR_CLAUDE_CHANNEL_TIMEOUT_MS"])
    ?? deps.timeoutMs;
  const timeoutDeps = timeoutMs ? { ...deps, timeoutMs } : deps;
  try {
    const response = await fetchImpl(parsedUrl.toString(), withExternalWriteTimeout(timeoutDeps, {
      method: "POST",
      headers,
      body,
    }));
    const responseText = await response.text();
    const responseEvidence = {
      ...evidence,
      http_status: response.status,
      response_text: responseText.slice(0, 500),
      auth: token ? "bearer_token_env" : "none",
    };
    if (!response.ok) {
      return failedOutcome(
        completedTarget,
        receiverErrorCode(responseText) ?? "receiver_rejected",
        `claude_channel receiver returned HTTP ${response.status}`,
        responseEvidence,
      );
    }
    return {
      status: "delivered",
      target: completedTarget,
      evidence: responseEvidence,
    };
  } catch (err) {
    return failedOutcome(completedTarget, "network_error", errorMessage(err), evidence);
  }
}

async function linearGraphql<T>(
  fetchImpl: MonitorDeliveryFetch,
  deps: MonitorDeliveryDependencies,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, withExternalWriteTimeout(deps, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  }));
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Linear returned non-JSON response with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`Linear returned HTTP ${response.status}`);
  }
  if (isRecord(payload) && Array.isArray(payload["errors"]) && payload["errors"].length > 0) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(payload["errors"])}`);
  }
  if (!isRecord(payload) || !isRecord(payload["data"])) {
    throw new Error("Linear GraphQL response did not include data");
  }
  return payload["data"] as T;
}

function evidenceMatched(wake: MonitorWakeRow, kinds: string[]): boolean {
  const expected = new Set(kinds);
  return wake.evaluation.evidence.some(
    (record) => expected.has(record.kind) && record.status === "matched",
  );
}

function matchedTerminalState(wake: MonitorWakeRow, states: Set<string>): boolean {
  return wake.evaluation.evidence.some((record) => {
    if (record.kind !== "run.terminal" || record.status !== "matched") return false;
    const value = record.value;
    return isRecord(value) && typeof value["state"] === "string" && states.has(value["state"]);
  });
}

function issueFromWake(wake: MonitorWakeRow): string | undefined {
  for (const record of wake.evaluation.evidence) {
    const issue = issueFromEvidence(record);
    if (issue) return issue;
  }
  return undefined;
}

function issueFromEvidence(record: PredicateEvidenceRecord): string | undefined {
  const value = record.value;
  if (!isRecord(value)) return undefined;
  const issue = value["issue"];
  return typeof issue === "string" && issue.trim() ? issue.trim() : undefined;
}

interface WakeInfraErrorClassification {
  schema_version: string;
  failure_layer: string;
  failure_reason: string;
  message: string;
}

function infraErrorClassificationFromWake(wake: MonitorWakeRow): WakeInfraErrorClassification | undefined {
  for (const record of wake.evaluation.evidence) {
    if (record.kind !== "run.terminal" && record.kind !== "run.failed") {
      continue;
    }
    const value = record.value;
    if (!isRecord(value)) {
      continue;
    }
    const classification = value["infra_error_classification"];
    if (!isRecord(classification)) {
      continue;
    }
    const schemaVersion = classification["schema_version"];
    const failureLayer = classification["failure_layer"];
    const failureReason = classification["failure_reason"];
    const message = classification["message"];
    if (
      typeof schemaVersion === "string"
      && typeof failureLayer === "string"
      && typeof failureReason === "string"
      && typeof message === "string"
    ) {
      return {
        schema_version: schemaVersion,
        failure_layer: failureLayer,
        failure_reason: failureReason,
        message,
      };
    }
  }
  return undefined;
}

function infraErrorClassificationLines(wake: MonitorWakeRow, prefix = ""): string[] {
  const classification = infraErrorClassificationFromWake(wake);
  if (!classification) {
    return [];
  }
  return [
    `${prefix}Infra error: ${classification.failure_layer}/${classification.failure_reason}`,
    `${prefix}Infra message: ${classification.message}`,
  ];
}

function renderPlainWakeSummary(monitor: MonitorRow, wake: MonitorWakeRow): string {
  return [
    `Monitor ${monitor.monitor_id} woke.`,
    monitor.source_run_id ? `Run: ${monitor.source_run_id}` : null,
    monitor.preset ? `Preset: ${monitor.preset}` : null,
    ...infraErrorClassificationLines(wake),
    `Wake: ${wake.wake_id}`,
    `Transition: ${wake.transition_hash}`,
    wake.suggested_commands.length > 0 ? `Next: ${wake.suggested_commands[0]}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderCodexAutomationPrompt(monitor: MonitorRow, wake: MonitorWakeRow, threadId: string): string {
  return [
    "Calyx monitor wake bridge.",
    "",
    "First action: run `calyx monitor inbox --json`, locate the wake below, then acknowledge it with `calyx monitor ack` after handling.",
    "This bridge carries a pointer only; do not treat this prompt as the wake payload.",
    "",
    `Thread: codex://threads/${threadId}`,
    `Monitor: ${monitor.monitor_id}`,
    `Wake: ${wake.wake_id}`,
    `Transition: ${wake.transition_hash}`,
    monitor.source_run_id ? `Run: ${monitor.source_run_id}` : null,
    wake.receipt_path ? `Tier-0 receipt: ${wake.receipt_path}` : null,
    ...infraErrorClassificationLines(wake),
    "",
    "Suggested first commands:",
    "calyx monitor inbox --json",
    `calyx monitor ack ${wake.wake_id} --acked-by codex-automation --json`,
  ].filter((line): line is string => line !== null).join("\n");
}

function renderCodexAutomationMemory(monitor: MonitorRow, wake: MonitorWakeRow, threadId: string): string {
  return [
    "# Calyx Monitor Wake Bridge",
    "",
    `- thread: codex://threads/${threadId}`,
    `- monitor_id: ${monitor.monitor_id}`,
    `- wake_id: ${wake.wake_id}`,
    `- transition_hash: ${wake.transition_hash}`,
    ...infraErrorClassificationLines(wake, "- "),
    "- first_action: calyx monitor inbox --json",
    "- floor: durable pull remains available through calyx monitor inbox",
    "",
  ].join("\n");
}

function renderClaudeReinvokePrompt(monitor: MonitorRow, wake: MonitorWakeRow): string {
  return [
    "Calyx monitor wake bridge.",
    "",
    "First action: run `calyx monitor inbox --json` and inspect the pending wake. Do not rely on this prompt as the payload; it is only a pointer.",
    "After you handle the wake, acknowledge it with `calyx monitor ack <wake-id> --acked-by claude-reinvoke --json`.",
    "",
    `Monitor: ${monitor.monitor_id}`,
    `Wake: ${wake.wake_id}`,
    `Transition: ${wake.transition_hash}`,
    monitor.source_run_id ? `Run: ${monitor.source_run_id}` : null,
    wake.receipt_path ? `Tier-0 receipt: ${wake.receipt_path}` : null,
    ...infraErrorClassificationLines(wake),
    "",
    "Suggested commands:",
    "calyx monitor inbox --json",
    `calyx monitor ack ${wake.wake_id} --acked-by claude-reinvoke --json`,
  ].filter((line): line is string => line !== null).join("\n");
}

function renderClaudeChannelPayload(
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  binding: MonitorDeliveryAdapterBindingV1,
): Record<string, unknown> {
  return {
    schema_version: CLAUDE_CHANNEL_POST_SCHEMA_VERSION,
    wake_id: wake.wake_id,
    monitor_id: monitor.monitor_id,
    materiality: binding.materiality.kind,
    first_command: firstMonitorInboxCommand(wake),
    ...(infraErrorClassificationFromWake(wake)
      ? { infra_error_classification: infraErrorClassificationFromWake(wake) }
      : {}),
  };
}

function firstMonitorInboxCommand(wake: MonitorWakeRow): string {
  return wake.suggested_commands.find((command) => command.trim().startsWith("calyx monitor inbox"))
    ?? "calyx monitor inbox --json";
}

function renderLinearCommentBody(monitor: MonitorRow, wake: MonitorWakeRow): string {
  const lines = [
    `Calyx monitor ${monitor.monitor_id} woke.`,
    "",
    `- Wake: \`${wake.wake_id}\``,
    `- Transition: \`${wake.transition_hash}\``,
    monitor.source_run_id ? `- Run: \`${monitor.source_run_id}\`` : null,
    monitor.preset ? `- Preset: \`${monitor.preset}\`` : null,
    wake.receipt_path ? `- Tier-0 receipt: \`${wake.receipt_path}\`` : null,
    ...infraErrorClassificationLines(wake, "- "),
    "",
    "<!-- calyx-monitor-delivery",
    `wake_id=${wake.wake_id}`,
    `monitor_id=${monitor.monitor_id}`,
    "-->",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function buildClaudeReinvokeArgs(
  binding: MonitorDeliveryAdapterBindingV1,
  prompt: string,
  sessionId: string | undefined,
  continueLatest: boolean,
): string[] {
  const args = ["-p"];
  if (sessionId) {
    args.push("--resume", sessionId);
  } else if (continueLatest) {
    args.push("--continue");
  }
  if (binding.claude_reinvoke?.model) {
    args.push("--model", binding.claude_reinvoke.model);
  }
  if (binding.claude_reinvoke?.permission_mode) {
    args.push("--permission-mode", binding.claude_reinvoke.permission_mode);
  }
  if (binding.claude_reinvoke?.allowed_tools && binding.claude_reinvoke.allowed_tools.length > 0) {
    args.push("--allowedTools", ...binding.claude_reinvoke.allowed_tools);
  }
  args.push(prompt);
  return args;
}

function redactPromptArg(args: string[]): string[] {
  if (args.length === 0) return [];
  return args.map((arg, index) => index === args.length - 1 ? "<wake-context-prompt>" : arg);
}

function renderVaultReceipt(
  monitor: MonitorRow,
  wake: MonitorWakeRow,
  binding: MonitorDeliveryAdapterBindingV1,
): string {
  const date = wake.created_at.slice(0, 10);
  return [
    "---",
    "type: daily",
    `created: ${date}`,
    "author: calyx-monitor",
    "project: calyx",
    "tags: [calyx, monitor, receipt]",
    "---",
    "",
    `# Calyx Monitor Wake ${wake.wake_id}`,
    "",
    `- monitor_id: ${monitor.monitor_id}`,
    `- binding_id: ${binding.binding_id}`,
    `- adapter: ${binding.adapter}`,
    `- materiality: ${binding.materiality.kind}`,
    `- wake_id: ${wake.wake_id}`,
    `- transition_hash: ${wake.transition_hash}`,
    monitor.source_run_id ? `- run_id: ${monitor.source_run_id}` : null,
    ...infraErrorClassificationLines(wake, "- "),
    wake.receipt_path ? `- tier0_receipt: ${wake.receipt_path}` : null,
    "",
    "## Suggested Commands",
    "",
    ...wake.suggested_commands.map((command) => `- \`${command}\``),
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function failedOutcome(
  target: Record<string, unknown>,
  error_code: string,
  error_message: string,
  evidence: Record<string, unknown> = {},
): DeliveryOutcome {
  return {
    status: "failed",
    target,
    evidence,
    error_code,
    error_message,
  };
}

async function readExistingAutomationCreatedAt(automationPath: string): Promise<number | undefined> {
  try {
    const text = await readFile(automationPath, "utf8");
    const parsed = parseToml(text) as Record<string, unknown>;
    const createdAt = parsed["created_at"];
    return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : undefined;
  } catch {
    return undefined;
  }
}

function defaultExecFile(
  command: string,
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: 256_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        }));
        return;
      }
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function resolveFetch(deps: MonitorDeliveryDependencies): MonitorDeliveryFetch | undefined {
  if (deps.fetch) return deps.fetch;
  const candidate = globalThis.fetch as unknown as MonitorDeliveryFetch | undefined;
  return typeof candidate === "function" ? candidate : undefined;
}

function withExternalWriteTimeout(
  deps: MonitorDeliveryDependencies,
  init: Parameters<MonitorDeliveryFetch>[1],
): Parameters<MonitorDeliveryFetch>[1] {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_EXTERNAL_WRITE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return init;
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return init;
  }
  return {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function normalizeReceiptDirectory(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeAutomationId(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "calyx-monitor-wake";
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLoopbackReceiverUrl(rawValue: string): URL | string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    return `claude_channel receiver_url is not a valid URL: ${rawValue}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `claude_channel receiver_url must use http or https: ${rawValue}`;
  }
  if (!isLoopbackHostname(url.hostname)) {
    return `claude_channel receiver_url must target localhost or loopback, got ${url.hostname}`;
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}

function receiverErrorCode(responseText: string): string | undefined {
  try {
    const parsed = JSON.parse(responseText) as unknown;
    if (!isRecord(parsed)) return undefined;
    const errorCode = parsed["error_code"];
    return typeof errorCode === "string" && errorCode.trim() ? errorCode.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isoToMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mergedProcessEnv(
  env: Record<string, string | undefined> | undefined,
  serverOnlyEnvNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  return redactServerOnlyEnvironment({
    ...process.env,
    ...(env ?? {}),
  }, serverOnlyEnvNames);
}

function isExecErrorWithOutput(value: unknown): value is Error & { stdout: string; stderr: string } {
  return value instanceof Error
    && typeof (value as { stdout?: unknown }).stdout === "string"
    && typeof (value as { stderr?: unknown }).stderr === "string";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function looksLikeAuthError(message: string): boolean {
  return /\b(401|403|unauthorized|api key|authentication|login)\b/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
