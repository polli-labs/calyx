import { randomUUID } from "node:crypto";
import { hostname as systemHostname } from "node:os";
import path from "node:path";
import type {
  AdapterCapabilities,
  RuntimeAdapterFactory,
  AdapterSession,
  AdapterStartOptions,
  AdapterTurnHandle,
  BackendAdapter,
  BackendEvent,
  CodexAppServerSteerInput,
  CodexAppServerSteerResult,
  SessionInfo,
  SessionParserFs,
  TurnEvent,
  TurnInput,
  TurnResult,
} from "@polli-labs/calyx-runner";
import type {
  StateDriverDatabase,
  StateOpenOptions,
} from "@polli-labs/calyx-core";
import {
  clearRunnerLiveBindingActiveTurn,
  closeRunnerLiveBinding,
  openStateStore,
  recordRunnerLiveBindingActiveTurn,
  upsertRunnerLiveBinding,
} from "@polli-labs/calyx-core";
import {
  buildManagedBackendPath,
  CODEX_BACKEND_REASONING_EFFORTS,
  isCodexBackendReasoningEffort,
} from "@polli-labs/calyx-runner";
import type { SessionDiscoveryFs } from "@polli-labs/calyx-runner";
import { findLatestCodexSession } from "./session-discovery.js";
import {
  parseCodexProviderConstraint,
  parseCodexTerminalMessage,
} from "./session-parser.js";
import {
  CodexAppServerConnection,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  type CodexAppServerConnectionOptions,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
  type JsonRpcRequestResolution,
  type SpawnCodexProcess,
} from "./app-server-transport.js";
import { resolveCodexCommand } from "./app-server-command.js";
export { resolveCodexCommand } from "./app-server-command.js";

type ApprovalPolicy =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never"
  | { granular: Record<string, boolean> };

type CodexSandboxMode = "read-only" | "danger-full-access";

interface CodexThreadInfo {
  id: string;
  path: string | null;
  cwd: string;
}

interface CodexThreadResponse {
  thread: CodexThreadInfo;
  sandbox?: {
    type?: unknown;
  };
}

interface CodexTurnInfo {
  id: string;
  status: string;
  error: {
    message: string;
    additionalDetails: string | null;
  } | null;
}

interface TurnContext {
  queue: AsyncTurnEventQueue;
  completion: Promise<TurnResult>;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  events: BackendEvent[];
  stderrOffset: number;
  startedAt: number;
  turnId?: string;
}

interface CodexAppServerTurnSteerProtocolProbe {
  status: "dispatchable" | "unavailable";
  observed_error?: string | undefined;
}

export interface CodexAppServerLiveBindingOptions {
  enabled?: boolean | undefined;
  host?: string | undefined;
  state?: StateOpenOptions | undefined;
  auth_ref?: Record<string, unknown> | undefined;
  protocol_probe_timeout_ms?: number | undefined;
}

export interface CodexAppServerAdapterOptions {
  command?: string;
  args?: string[];
  spawnProcess?: SpawnCodexProcess;
  requestTimeoutMs?: number;
  sessionParserFs?: SessionParserFs;
  sessionDiscoveryFs?: SessionDiscoveryFs;
  liveBindings?: CodexAppServerLiveBindingOptions | undefined;
}

const CODEX_SESSION_CAPABILITIES: AdapterCapabilities = {
  streaming: true,
  turnControl: true,
  resumeSession: true,
  forkSession: false,
  approvals: "client-mediated",
};

const SUPPRESSED_NOTIFICATIONS = [
  "thread/started",
  "thread/status/changed",
  "item/started",
  "item/completed",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
] as const;

function buildChildEnv(env: Record<string, string | null> | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...process.env };
  let hasExplicitPath = false;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key === "PATH") {
      hasExplicitPath = true;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  if (!hasExplicitPath) {
    next.PATH = buildManagedBackendPath(next.PATH, next.HOME);
  }
  return next;
}

function buildAppServerArgs(opts: AdapterStartOptions, configuredArgs: readonly string[] | undefined): string[] {
  if (opts.backend_options?.max_turns !== undefined) {
    throw new Error(
      "Codex app-server does not support backend_options.max_turns. " +
        "Use backend_options.max_threads for Codex sub-agent concurrency.",
    );
  }
  const args = [...(configuredArgs ?? DEFAULT_CODEX_APP_SERVER_ARGS)];
  if (opts.backend_options?.max_threads === undefined) {
    return args;
  }
  const maxThreads = opts.backend_options.max_threads;
  if (!Number.isInteger(maxThreads) || maxThreads <= 0) {
    throw new Error("Codex app-server backend_options.max_threads must be a positive integer.");
  }
  return ["-c", `agents.max_threads=${maxThreads}`, ...args];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  if (
    value === "untrusted"
    || value === "on-failure"
    || value === "on-request"
    || value === "never"
  ) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const granular = (value as Record<string, unknown>)["granular"];
  return typeof granular === "object" && granular !== null;
}

function resolveApprovalPolicy(opts: AdapterStartOptions): ApprovalPolicy | undefined {
  const explicit = opts.backend_options?.["approval_policy"];
  if (isApprovalPolicy(explicit)) {
    return explicit;
  }
  if (opts.backend_options?.dangerously_skip_permissions) {
    return "never";
  }
  return undefined;
}

function resolveSandboxMode(opts: AdapterStartOptions): CodexSandboxMode | undefined {
  const bypass = opts.backend_options?.dangerously_skip_permissions;
  if (bypass !== undefined && typeof bypass !== "boolean") {
    throw new Error("Codex app-server backend_options.dangerously_skip_permissions must be a boolean.");
  }
  const legacySandboxClass = opts.backend_options?.["sandbox_class"];
  if (legacySandboxClass !== undefined) {
    throw new Error(
      "Codex app-server does not support backend_options.sandbox_class. " +
        "Use backend_options.sandbox=read-only or danger-full-access.",
    );
  }

  const explicit = opts.backend_options?.["sandbox"];
  if (explicit !== undefined && explicit !== "read-only" && explicit !== "danger-full-access") {
    throw new Error(
      `Codex app-server backend_options.sandbox must be read-only or danger-full-access; received ${JSON.stringify(explicit)}.`,
    );
  }
  if (bypass && explicit === "read-only") {
    throw new Error(
      "Codex app-server backend_options.sandbox=read-only conflicts with dangerously_skip_permissions=true.",
    );
  }
  if (bypass) {
    return "danger-full-access";
  }
  return explicit;
}

function assertReadOnlySandboxApplied(
  requested: CodexSandboxMode | undefined,
  response: CodexThreadResponse,
): void {
  if (requested !== "read-only") {
    return;
  }
  const applied = response.sandbox?.type;
  if (applied !== "readOnly") {
    throw new Error(
      "Codex app-server did not confirm backend_options.sandbox=read-only; " +
        `response.sandbox.type=${JSON.stringify(applied)}.`,
    );
  }
}

function buildThreadParams(
  opts: AdapterStartOptions,
  approvalPolicy: ApprovalPolicy | undefined,
  sandbox: CodexSandboxMode | undefined,
): Record<string, unknown> {
  if (opts.backend_options?.model) {
    throw new Error(
      `Codex app-server does not yet support backend_options.model=${JSON.stringify(opts.backend_options.model)} through Calyx. ` +
        "Use --backend claude for explicit Calyx model forwarding.",
    );
  }
  const params: Record<string, unknown> = {
    cwd: opts.cwd,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    ephemeral: false,
  };
  if (approvalPolicy !== undefined) {
    params.approvalPolicy = approvalPolicy;
  }
  if (sandbox !== undefined) {
    params.sandbox = sandbox;
  }
  if (opts.system_prompt !== undefined) {
    params.baseInstructions = opts.system_prompt;
  }
  if (opts.append_system_prompt !== undefined) {
    params.developerInstructions = opts.append_system_prompt;
  }
  return params;
}

function buildTurnParams(
  threadId: string,
  opts: AdapterStartOptions,
  input: TurnInput,
  approvalPolicy: ApprovalPolicy | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId,
    cwd: opts.cwd,
    input: [{ type: "text", text: input.prompt, text_elements: [] }],
  };
  if (approvalPolicy !== undefined) {
    params.approvalPolicy = approvalPolicy;
  }
  if (opts.backend_options?.reasoning_effort !== undefined) {
    const effort = opts.backend_options.reasoning_effort;
    if (!isCodexBackendReasoningEffort(effort)) {
      throw new Error(
        `Codex app-server does not support backend_options.reasoning_effort=${JSON.stringify(effort)}. ` +
          `Valid Codex values: ${CODEX_BACKEND_REASONING_EFFORTS.join(", ")}.`,
      );
    }
    params.effort = effort;
  }
  return params;
}

function looksLikeAuthError(message: string): boolean {
  return /\b(401|403|unauthorized|api key|authentication|login)\b/i.test(message);
}

function liveBindingsEnabled(options: CodexAppServerAdapterOptions): boolean {
  return options.liveBindings?.enabled === true;
}

function normalizeHost(value: string | undefined): string {
  const raw = value?.trim() || systemHostname();
  return raw.toLowerCase().replace(/\..*$/, "") || "unknown";
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CODEX_HOME && env.CODEX_HOME.trim()) {
    return env.CODEX_HOME.trim();
  }
  if (env.HOME && env.HOME.trim()) {
    return path.join(env.HOME.trim(), ".codex");
  }
  return undefined;
}

function defaultAuthRef(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const codexHome = resolveCodexHome(env);
  return codexHome
    ? { mode: "codex_home", codex_home: codexHome }
    : { mode: "ambient_codex_auth" };
}

function isTurnSteerProtocolUnavailable(message: string): boolean {
  return /\b(method not found|unknown method|experimentalApi|experimental API|not initialized|unsupported)\b/i.test(message);
}

function steerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class AsyncTurnEventQueue implements AsyncIterable<TurnEvent> {
  private readonly values: TurnEvent[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<TurnEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private done = false;
  private failure: Error | undefined;

  push(value: TurnEvent): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    this.failure = error;
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    return {
      next: async (): Promise<IteratorResult<TurnEvent>> => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift()! };
        }
        if (this.failure) {
          throw this.failure;
        }
        if (this.done) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<TurnEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function createSessionInfo(thread: CodexThreadInfo, fallback: SessionInfo | undefined): SessionInfo {
  if (typeof thread.path === "string" && thread.path.length > 0) {
    return {
      id: thread.id,
      path: thread.path,
      backend: "codex",
    };
  }
  if (fallback && fallback.id === thread.id) {
    return fallback;
  }
  return {
    id: thread.id,
    path: "",
    backend: "codex",
  };
}

class CodexAppServerSession implements AdapterSession {
  readonly id = `codex-app-server-${randomUUID()}`;
  readonly capabilities = CODEX_SESSION_CAPABILITIES;
  readonly backend_session: SessionInfo;
  private readonly approvalPolicy: ApprovalPolicy | undefined;
  private readonly unregisterNotificationListener: () => void;
  private readonly unregisterCloseListener: () => void;
  private closed = false;
  private stopRequested = false;
  private activeTurn: TurnContext | undefined;

  constructor(
    private readonly adapter: CodexAppServerAdapter,
    private readonly connection: CodexAppServerConnection,
    private readonly startOptions: AdapterStartOptions,
    private thread: CodexThreadInfo,
    backendSession: SessionInfo,
    approvalPolicy: ApprovalPolicy | undefined,
  ) {
    this.backend_session = backendSession;
    this.approvalPolicy = approvalPolicy;
    this.unregisterNotificationListener = this.connection.onNotification((message) => {
      this.handleNotification(message);
    });
    this.unregisterCloseListener = this.connection.onClose((error) => {
      this.closed = true;
      this.adapter.unregisterSession(this.startOptions.run_id, this.id);
      void this.adapter.closeLiveBinding(this.startOptions, "connection-close", error.message);
      if (this.activeTurn) {
        const turn = this.activeTurn;
        this.activeTurn = undefined;
        turn.queue.fail(error);
        turn.reject(error);
      }
    });
    this.connection.setRequestHandler(async (message) => this.handleServerRequest(message));
  }

  async startTurn(input: TurnInput): Promise<AdapterTurnHandle> {
    if (this.closed) {
      throw new Error(`Codex adapter session ${this.id} is already closed.`);
    }
    if (this.activeTurn) {
      throw new Error(`Codex adapter session ${this.id} already has an active turn.`);
    }

    const queue = new AsyncTurnEventQueue();
    let resolveCompletion!: (result: TurnResult) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<TurnResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const context: TurnContext = {
      queue,
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      events: [],
      stderrOffset: this.connection.getStderrSnapshot(),
      startedAt: Date.now(),
    };
    this.activeTurn = context;

    try {
      const started = await this.connection.request<{ turn: CodexTurnInfo }>(
        "turn/start",
        buildTurnParams(this.thread.id, this.startOptions, input, this.approvalPolicy),
      );
      context.turnId = started.turn.id;
      await this.adapter.recordActiveTurn(this.startOptions, {
        turn_id: started.turn.id,
        source: "app-server-response:turn/start",
        observed_at: new Date().toISOString(),
        status: started.turn.status,
      });
      context.queue.push({
        kind: "turn",
        payload: {
          phase: "started",
          thread_id: this.thread.id,
          turn_id: started.turn.id,
          message: `Codex turn ${started.turn.id} started.`,
        },
      });
      this.startOptions.onActivity?.({
        source: "turn",
        timestamp: new Date().toISOString(),
        detail: "turn_started",
      });
      if (this.stopRequested) {
        await this.interruptActiveTurn(context.turnId);
      }
      return {
        id: started.turn.id,
        events: context.queue,
        wait: async (): Promise<TurnResult> => completion,
        interrupt: async (): Promise<void> => {
          if (context.turnId) {
            await this.interruptActiveTurn(context.turnId);
          }
        },
      };
    } catch (error) {
      this.activeTurn = undefined;
      queue.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async requestStop(): Promise<void> {
    this.stopRequested = true;
    if (!this.activeTurn?.turnId) {
      return;
    }
    await this.interruptActiveTurn(this.activeTurn.turnId);
  }

  async steerTurn(input: CodexAppServerSteerInput): Promise<CodexAppServerSteerResult> {
    if (this.closed) {
      throw steerError("transport_unavailable", `Codex app-server session ${this.id} is closed.`);
    }
    if (input.thread_id !== this.thread.id) {
      throw steerError(
        "steer_binding_unavailable",
        `Live binding thread ${input.thread_id} does not match active thread ${this.thread.id}.`,
      );
    }
    const turn = this.activeTurn;
    if (!turn?.turnId) {
      throw steerError("no_steerable_turn", `Codex app-server session ${this.id} has no active steerable turn.`);
    }
    if (turn.turnId !== input.expected_turn_id) {
      throw steerError(
        "expected_turn_mismatch",
        `Expected turn ${input.expected_turn_id} but active turn is ${turn.turnId}.`,
      );
    }
    try {
      const response = await this.connection.request<Record<string, unknown>>(
        "turn/steer",
        {
          threadId: input.thread_id,
          expectedTurnId: input.expected_turn_id,
          input: [...input.input],
        },
        input.timeout_ms,
      );
      const turnId = typeof response["turnId"] === "string"
        ? response["turnId"]
        : typeof response["turn_id"] === "string"
          ? response["turn_id"]
          : turn.turnId;
      return { turn_id: turnId, response };
    } catch (error) {
      const message = toErrorMessage(error);
      if (looksLikeAuthError(message)) {
        throw steerError("auth_unavailable", message);
      }
      if (/\b(expectedTurnId|expected turn|mismatch)\b/i.test(message)) {
        throw steerError("expected_turn_mismatch", message);
      }
      if (/\b(no active turn|active turn|required active)\b/i.test(message)) {
        throw steerError("no_steerable_turn", message);
      }
      if (/\b(?:not steerable|review|compact)\b/i.test(message)) {
        throw steerError("active_turn_not_steerable", message);
      }
      throw steerError("transport_unavailable", message);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unregisterNotificationListener();
    this.unregisterCloseListener();
    this.adapter.unregisterSession(this.startOptions.run_id, this.id);
    await this.adapter.closeLiveBinding(this.startOptions, "session-close");
    if (this.activeTurn) {
      this.activeTurn.queue.close();
      this.activeTurn = undefined;
    }
    await this.connection.close();
  }

  private async handleServerRequest(message: JsonRpcRequestMessage): Promise<JsonRpcRequestResolution> {
    const method = message.method;
    const warning = this.approvalPolicy === "never"
      ? `Codex requested approval via ${method} despite approval_policy=never; auto-denying.`
      : `Codex requested approval via ${method}; the Calyx Codex adapter auto-denies interactive approvals.`;
    this.emitWarning(warning, { method, params: message.params });

    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      return { result: { decision: "decline" } };
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      return { result: { decision: "decline" } };
    }
    if (method === "item/permissions/requestApproval") {
      return { result: { permissions: {}, scope: "turn" } };
    }

    return {
      error: {
        code: -32601,
        message: `Unhandled Codex server request ${method}`,
      },
    };
  }

  private handleNotification(message: JsonRpcNotificationMessage): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const params = asRecord(message.params);
      if (!matchesThreadAndTurn(params, this.thread.id, turn.turnId)) {
        return;
      }
      turn.queue.push({
        kind: "item",
        payload: {
          thread_id: this.thread.id,
          turn_id: params["turnId"],
          item_id: params["itemId"],
          delta: params["delta"],
          message: typeof params["delta"] === "string"
            ? params["delta"]
            : "Codex agent message delta.",
        },
      });
      this.startOptions.onActivity?.({
        source: "turn",
        timestamp: new Date().toISOString(),
        detail: "agent_message_delta",
        ...(typeof params["delta"] === "string" ? { bytes: Buffer.byteLength(params["delta"]) } : {}),
      });
      return;
    }
    if (message.method === "rawResponseItem/completed") {
      const params = asRecord(message.params);
      if (!matchesThreadAndTurn(params, this.thread.id, turn.turnId)) {
        return;
      }
      turn.queue.push({
        kind: "item",
        payload: {
          thread_id: this.thread.id,
          turn_id: params["turnId"],
          item: params["item"],
          message: "Codex response item completed.",
        },
      });
      this.startOptions.onActivity?.({
        source: "turn",
        timestamp: new Date().toISOString(),
        detail: "response_item_completed",
      });
      return;
    }
    if (message.method === "turn/started") {
      const params = asRecord(message.params);
      if (typeof params["threadId"] !== "string" || params["threadId"] !== this.thread.id) {
        return;
      }
      const turnInfo = asRecord(params["turn"]);
      if (typeof turnInfo["id"] === "string") {
        turn.turnId = turnInfo["id"];
        void this.adapter.recordActiveTurn(this.startOptions, {
          turn_id: turnInfo["id"],
          source: "app-server-notification:turn/started",
          observed_at: new Date().toISOString(),
          status: typeof turnInfo["status"] === "string" ? turnInfo["status"] : "in_progress",
        });
      }
      this.startOptions.onActivity?.({
        source: "turn",
        timestamp: new Date().toISOString(),
        detail: "turn_started",
      });
      if (this.stopRequested && turn.turnId) {
        void this.interruptActiveTurn(turn.turnId);
      }
      return;
    }
    if (message.method === "turn/completed") {
      const params = asRecord(message.params);
      if (typeof params["threadId"] !== "string" || params["threadId"] !== this.thread.id) {
        return;
      }
      const turnInfo = asRecord(params["turn"]);
      if (turn.turnId && turnInfo["id"] !== turn.turnId) {
        return;
      }
      const completionInfo = {
        id: typeof turnInfo["id"] === "string" ? turnInfo["id"] : turn.turnId ?? randomUUID(),
        status: typeof turnInfo["status"] === "string" ? turnInfo["status"] : "failed",
        error: parseTurnError(turnInfo["error"]),
      };
      this.startOptions.onActivity?.({
        source: "turn",
        timestamp: new Date().toISOString(),
        detail: "turn_completed",
      });
      void this.adapter.clearActiveTurn(this.startOptions, {
        source: "app-server-notification:turn/completed",
        observed_at: new Date().toISOString(),
        status: completionInfo.status,
      });
      this.activeTurn = undefined;
      void this.finishTurn(turn, completionInfo);
      return;
    }
    if (message.method === "configWarning") {
      this.emitWarning("Codex app-server emitted a config warning.", { params: message.params });
      return;
    }
    if (message.method === "error") {
      const params = asRecord(message.params);
      const messageText = typeof params["message"] === "string"
        ? params["message"]
        : "Codex app-server emitted an error notification.";
      turn.queue.push({
        kind: "error",
        payload: {
          message: messageText,
          params,
        },
      });
      turn.events.push({
        event: looksLikeAuthError(messageText) ? "auth_failure" : "task_failure",
        payload: { error: messageText },
      });
    }
  }

  private async finishTurn(turn: TurnContext, info: CodexTurnInfo): Promise<void> {
    try {
      const completion = await this.buildTurnResult(turn, info);
      turn.queue.close();
      turn.resolve(completion);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      turn.queue.fail(failure);
      turn.reject(failure);
    }
  }

  private async buildTurnResult(turn: TurnContext, info: CodexTurnInfo): Promise<TurnResult> {
    const stderr = this.connection.readStderrSince(turn.stderrOffset);
    const failureMessage = info.error
      ? [info.error.message, info.error.additionalDetails].filter((value) => typeof value === "string" && value.length > 0).join("\n")
      : undefined;
    if (failureMessage) {
      turn.events.push({
        event: looksLikeAuthError(failureMessage) ? "auth_failure" : "task_failure",
        payload: { error: failureMessage },
      });
    }
    if (info.status === "interrupted") {
      turn.events.push({ event: "cancelled" });
    }

    const result: TurnResult = {
      exit_code: info.status === "completed" ? 0 : info.status === "interrupted" ? 130 : 1,
      stderr: failureMessage ?? stderr,
      events: turn.events,
      duration_ms: Math.max(0, Date.now() - turn.startedAt),
      session: this.backend_session,
      backend_turn_id: info.id,
      ...(info.status === "interrupted" ? { signal: "SIGINT" } : {}),
    };

    if (this.backend_session.path) {
      const [terminalMessage, providerConstraint] = await Promise.all([
        parseCodexTerminalMessage(
          this.backend_session.path,
          this.adapter.options.sessionParserFs,
        ).catch(() => undefined),
        parseCodexProviderConstraint(
          this.backend_session.path,
          this.adapter.options.sessionParserFs,
        ).catch(() => undefined),
      ]);
      if (terminalMessage) {
        result.agent_terminal_message = terminalMessage;
      }
      if (providerConstraint) {
        result.provider_constraint = providerConstraint;
      }
    }

    return result;
  }

  private async interruptActiveTurn(turnId: string): Promise<void> {
    try {
      await this.connection.request("turn/interrupt", {
        threadId: this.thread.id,
        turnId,
      });
    } catch (error) {
      this.emitWarning(`Failed to interrupt Codex turn ${turnId}; closing app-server session.`, {
        error: toErrorMessage(error),
      });
      await this.connection.close();
    }
  }

  private emitWarning(message: string, payload?: Record<string, unknown>): void {
    this.startOptions.onEvent?.({
      timestamp: new Date().toISOString(),
      run_id: this.startOptions.run_id,
      event: "warning",
      message,
      ...(payload ? { payload } : {}),
    });
    if (this.activeTurn) {
      this.activeTurn.queue.push({
        kind: "warning",
        payload: {
          message,
          ...(payload ?? {}),
        },
      });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function matchesThreadAndTurn(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string | undefined,
): boolean {
  if (typeof params["threadId"] !== "string" || params["threadId"] !== threadId) {
    return false;
  }
  if (!turnId) {
    return true;
  }
  return params["turnId"] === turnId;
}

function parseTurnError(value: unknown): CodexTurnInfo["error"] {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const message = typeof record["message"] === "string" ? record["message"] : "Codex turn failed.";
  return {
    message,
    additionalDetails: typeof record["additionalDetails"] === "string" ? record["additionalDetails"] : null,
  };
}

export class CodexAppServerAdapter implements BackendAdapter {
  readonly name = "codex";
  readonly capabilities = CODEX_SESSION_CAPABILITIES;
  private readonly activeSessionsByRunId = new Map<string, CodexAppServerSession>();
  private readonly activeSessionsBySessionId = new Map<string, CodexAppServerSession>();
  readonly options: CodexAppServerAdapterOptions;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.options = options;
  }

  async startSession(opts: AdapterStartOptions): Promise<AdapterSession> {
    const approvalPolicy = resolveApprovalPolicy(opts);
    const sandbox = resolveSandboxMode(opts);
    const env = buildChildEnv(opts.backend_options?.env);
    const args = buildAppServerArgs(opts, this.options.args);
    const connectionOptions: CodexAppServerConnectionOptions = {
      command: this.options.command ?? resolveCodexCommand(env),
      cwd: opts.cwd,
      env,
      args,
      ...(opts.run_dir ? { runDir: opts.run_dir } : {}),
    };
    if (this.options.spawnProcess !== undefined) {
      connectionOptions.spawnProcess = this.options.spawnProcess;
    }
    if (this.options.requestTimeoutMs !== undefined) {
      connectionOptions.requestTimeoutMs = this.options.requestTimeoutMs;
    }
    const connection = new CodexAppServerConnection(connectionOptions);

    opts.onEvent?.({
      timestamp: new Date().toISOString(),
      run_id: opts.run_id,
      event: "backend_spawned",
      message: `Spawning codex app-server in ${opts.cwd}`,
      payload: {
        args,
        transport: "stdio-jsonl",
      },
    });

    try {
      await connection.request("initialize", {
        clientInfo: {
          name: "calyx-codex-runtime",
          title: "Calyx Codex Runtime",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [...SUPPRESSED_NOTIFICATIONS],
        },
      });
      connection.notify("initialized");

      const threadResponse = await connection.request<CodexThreadResponse>(
        opts.resume_session_id ? "thread/resume" : "thread/start",
        opts.resume_session_id
          ? {
              threadId: opts.resume_session_id,
              cwd: opts.cwd,
              persistExtendedHistory: true,
              ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
              ...(sandbox !== undefined ? { sandbox } : {}),
            }
          : buildThreadParams(opts, approvalPolicy, sandbox),
      );
      assertReadOnlySandboxApplied(sandbox, threadResponse);
      const fallbackSession = await this.resolveFallbackSession(threadResponse.thread.id);
      const backendSession = createSessionInfo(threadResponse.thread, fallbackSession);
      const session = new CodexAppServerSession(
        this,
        connection,
        opts,
        threadResponse.thread,
        backendSession,
        approvalPolicy,
      );
      this.activeSessionsByRunId.set(opts.run_id, session);
      this.activeSessionsBySessionId.set(session.id, session);
      await this.registerLiveBinding(opts, connectionOptions, env, threadResponse.thread, session.id, connection);
      return session;
    } catch (error) {
      try {
        await connection.flushStderrToDisk().catch(() => undefined);
      } finally {
        await connection.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async stop(sessionOrRunId: string): Promise<void> {
    const session = this.activeSessionsByRunId.get(sessionOrRunId)
      ?? this.activeSessionsBySessionId.get(sessionOrRunId);
    if (!session) {
      return;
    }
    await session.requestStop();
  }

  unregisterSession(runId: string, sessionId: string): void {
    this.activeSessionsByRunId.delete(runId);
    this.activeSessionsBySessionId.delete(sessionId);
  }

  activeSessionCount(): number {
    return this.activeSessionsByRunId.size;
  }

  async steerCodexAppServerTurn(input: CodexAppServerSteerInput): Promise<CodexAppServerSteerResult> {
    const session = this.activeSessionsByRunId.get(input.run_id);
    if (!session) {
      throw steerError("transport_unavailable", `No active Codex app-server session for run ${input.run_id}.`);
    }
    return await session.steerTurn(input);
  }

  async recordActiveTurn(
    startOptions: AdapterStartOptions,
    input: {
      turn_id: string;
      source: string;
      observed_at: string;
      status?: string | undefined;
    },
  ): Promise<void> {
    await this.withLiveBindingState(startOptions, "record active Codex turn", (db) => {
      recordRunnerLiveBindingActiveTurn(db, {
        run_id: startOptions.run_id,
        adapter: "codex_app_server_steer",
        turn_id: input.turn_id,
        source: input.source,
        observed_at: input.observed_at,
        status: normalizeCodexTurnStatus(input.status),
      });
    });
  }

  async clearActiveTurn(
    startOptions: AdapterStartOptions,
    input: {
      source: string;
      observed_at: string;
      status?: string | null | undefined;
      last_error?: string | null | undefined;
    },
  ): Promise<void> {
    await this.withLiveBindingState(startOptions, "clear active Codex turn", (db) => {
      clearRunnerLiveBindingActiveTurn(db, {
        run_id: startOptions.run_id,
        adapter: "codex_app_server_steer",
        source: input.source,
        observed_at: input.observed_at,
        status: normalizeCodexTurnStatus(input.status ?? undefined) ?? input.status,
        last_error: input.last_error,
      });
    });
  }

  async closeLiveBinding(startOptions: AdapterStartOptions, source: string, lastError?: string | null): Promise<void> {
    await this.withLiveBindingState(startOptions, "close Codex live binding", (db) => {
      closeRunnerLiveBinding(db, {
        run_id: startOptions.run_id,
        adapter: "codex_app_server_steer",
        source,
        last_error: lastError,
      });
    });
  }

  private async registerLiveBinding(
    startOptions: AdapterStartOptions,
    connectionOptions: CodexAppServerConnectionOptions,
    env: NodeJS.ProcessEnv,
    thread: CodexThreadInfo,
    sessionId: string,
    connection: CodexAppServerConnection,
  ): Promise<void> {
    if (!liveBindingsEnabled(this.options)) {
      return;
    }
    const protocolProbe = await this.probeTurnSteerProtocol(connection, thread.id);
    const timestamp = new Date().toISOString();
    const command = connectionOptions.command;
    const args = connectionOptions.args ?? [...DEFAULT_CODEX_APP_SERVER_ARGS];
    const codexHome = resolveCodexHome(env);
    await this.withLiveBindingState(startOptions, "register Codex live binding", (db) => {
      upsertRunnerLiveBinding(db, {
        run_id: startOptions.run_id,
        adapter: "codex_app_server_steer",
        backend: "codex",
        lifecycle_owner: "calyx",
        host: normalizeHost(this.options.liveBindings?.host),
        status: protocolProbe.status === "dispatchable" ? "active" : "closed",
        codex_home: codexHome ?? null,
        transport_kind: "stdio-jsonl",
        endpoint: {
          transport: "stdio-jsonl",
          command,
          args,
          cwd: connectionOptions.cwd,
          ...(connectionOptions.runDir ? { run_dir: connectionOptions.runDir } : {}),
          experimental_api: true,
          turn_steer_probe: protocolProbe,
        },
        thread_id: thread.id,
        adapter_session_id: sessionId,
        connection_id: sessionId,
        auth_ref: this.options.liveBindings?.auth_ref ?? defaultAuthRef(env),
        now: timestamp,
        closed_at: protocolProbe.status === "dispatchable" ? null : timestamp,
        last_error: protocolProbe.observed_error ?? null,
      });
    });
  }

  private async probeTurnSteerProtocol(
    connection: CodexAppServerConnection,
    threadId: string,
  ): Promise<CodexAppServerTurnSteerProtocolProbe> {
    try {
      await connection.request(
        "turn/steer",
        {
          threadId,
          expectedTurnId: "calyx-turn-steer-startup-probe",
          input: [
            {
              type: "text",
              text: "Calyx startup protocol probe for turn/steer dispatchability.",
              text_elements: [],
            },
          ],
        },
        this.options.liveBindings?.protocol_probe_timeout_ms ?? 5_000,
      );
      return { status: "dispatchable" };
    } catch (error) {
      const message = toErrorMessage(error);
      return {
        status: isTurnSteerProtocolUnavailable(message) ? "unavailable" : "dispatchable",
        observed_error: message,
      };
    }
  }

  private async withLiveBindingState(
    startOptions: AdapterStartOptions,
    action: string,
    callback: (db: StateDriverDatabase) => void,
  ): Promise<void> {
    if (!liveBindingsEnabled(this.options)) {
      return;
    }
    try {
      const opened = await openStateStore(this.options.liveBindings?.state ?? {});
      try {
        callback(opened.db);
      } finally {
        opened.db.close();
      }
    } catch (error) {
      startOptions.onEvent?.({
        timestamp: new Date().toISOString(),
        run_id: startOptions.run_id,
        event: "warning",
        message: `Failed to ${action}: ${toErrorMessage(error)}`,
        payload: {
          adapter: "codex_app_server_steer",
          live_binding: "unavailable",
        },
      });
    }
  }

  private async resolveFallbackSession(threadId: string): Promise<SessionInfo | undefined> {
    const latest = await findLatestCodexSession(this.options.sessionDiscoveryFs);
    if (!latest || latest.id !== threadId) {
      return undefined;
    }
    return {
      id: latest.id,
      ...(latest.path ? { path: latest.path } : {}),
      backend: "codex",
    };
  }
}

export function createCodexAppServerRuntimeAdapterFactory(
  options: CodexAppServerAdapterOptions = {},
): RuntimeAdapterFactory {
  const adapter = new CodexAppServerAdapter(options);
  const factory: RuntimeAdapterFactory = (): CodexAppServerAdapter => adapter;
  factory.activeSessionCount = (): number => adapter.activeSessionCount();
  factory.steerCodexAppServerTurn = (input): Promise<CodexAppServerSteerResult> =>
    adapter.steerCodexAppServerTurn(input);
  return factory;
}

function normalizeCodexTurnStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "inProgress") return "in_progress";
  return value;
}
