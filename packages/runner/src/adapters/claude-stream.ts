import { StringDecoder } from "node:string_decoder";
import type {
  AgentActivityProgress,
  AgentTerminalEvidence,
  AgentTerminalReason,
  LifecycleEvent,
  ProviderConstraint,
} from "../types.js";
import type { SessionInfo } from "./types.js";
import { detectProviderConstraint } from "../provider-constraint.js";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_EVENTS = 5;
const MAX_EXPECTED_SILENCE_MS = 5 * 60 * 1000;
const SAFE_RETRY_ERROR_TYPES = new Set([
  "api_error",
  "authentication_error",
  "billing_error",
  "overloaded_error",
  "rate_limit_error",
]);

export interface ClaudeStreamProjection {
  terminal_evidence?: AgentTerminalEvidence;
  provider_constraint?: ProviderConstraint;
  agent_terminal_message?: string;
  session?: SessionInfo;
  structured_record_count: number;
  semantic_progress_count: number;
  malformed_line_count: number;
  unknown_record_count: number;
  protocol_failed: boolean;
}

export interface ClaudeStreamParserOptions {
  run_id: string;
  /** Preassigned Claude session identity; mismatched stream ids are never surfaced. */
  expected_session_id?: string;
  now?: () => string;
  onEvent?: (event: LifecycleEvent) => void;
  onActivity?: (activity: AgentActivityProgress) => void;
  onSession?: (session: SessionInfo) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function terminalReason(subtype: string | undefined, terminal: string | undefined): AgentTerminalReason {
  const normalized = `${subtype ?? ""} ${terminal ?? ""}`.toLowerCase();
  if (normalized.includes("max_turn")) return "max_turns";
  if (normalized.includes("budget")) return "budget_exhaustion";
  if (
    normalized.includes("abort")
    || normalized.includes("interrupt")
    || normalized.includes("operator_stop")
  ) return "operator_stop";
  if (normalized.includes("defer") || normalized.includes("background_requested")) return "deferred";
  if (subtype === "success") return "completed";
  if (subtype?.startsWith("error_")) return "backend_failure";
  return "unknown";
}

function safeUsage(value: unknown): AgentTerminalEvidence["usage"] {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = nonNegativeInteger(usage["input_tokens"]);
  const outputTokens = nonNegativeInteger(usage["output_tokens"]);
  const cacheCreationInputTokens = nonNegativeInteger(usage["cache_creation_input_tokens"]);
  const cacheReadInputTokens = nonNegativeInteger(usage["cache_read_input_tokens"]);
  const projected = {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: cacheCreationInputTokens }
      : {}),
    ...(cacheReadInputTokens !== undefined ? { cache_read_input_tokens: cacheReadInputTokens } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Incrementally projects Claude Code stream-json into sparse lifecycle facts.
 *
 * Raw thinking, partial deltas, tool inputs, tool results, and unknown record
 * payloads never leave this parser. Only the final assistant message is
 * retained, matching the existing terminal-message receipt contract.
 */
export class ClaudeStreamParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private structuredRecordCount = 0;
  private semanticProgressCount = 0;
  private malformedLineCount = 0;
  private unknownRecordCount = 0;
  private lastAssistantMessage: string | undefined;
  private terminalEvidence: AgentTerminalEvidence | undefined;
  private providerConstraint: ProviderConstraint | undefined;
  private terminalMessage: string | undefined;
  private session: SessionInfo | undefined;
  private identityConfirmed: boolean;
  private identityRejected = false;
  private protocolFailed = false;
  private terminalRecordCount = 0;
  private terminalProgressCounted = false;
  private terminalEventPublished = false;

  constructor(private readonly opts: ClaudeStreamParserOptions) {
    this.identityConfirmed = opts.expected_session_id === undefined;
  }

  write(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }

  finish(): ClaudeStreamProjection {
    this.buffer += this.decoder.end();
    this.drain(true);
    if (
      this.terminalEvidence?.status === "authoritative"
      && !this.protocolFailed
      && !this.terminalProgressCounted
    ) {
      // Count the result as semantic progress, but do not publish its terminal
      // event until the adapter has reconciled it with process-exit authority.
      this.semanticProgressCount += 1;
      this.terminalProgressCounted = true;
    }
    if (this.terminalEvidence) {
      this.terminalEvidence = {
        ...this.terminalEvidence,
        malformed_line_count: this.malformedLineCount,
        unknown_record_count: this.unknownRecordCount,
      };
    }
    return {
      ...(this.terminalEvidence ? { terminal_evidence: this.terminalEvidence } : {}),
      ...(this.providerConstraint ? { provider_constraint: this.providerConstraint } : {}),
      ...(this.terminalMessage ? { agent_terminal_message: this.terminalMessage } : {}),
      ...(this.session ? { session: this.session } : {}),
      structured_record_count: this.structuredRecordCount,
      semantic_progress_count: this.semanticProgressCount,
      malformed_line_count: this.malformedLineCount,
      unknown_record_count: this.unknownRecordCount,
      protocol_failed: this.protocolFailed,
    };
  }

  /**
   * Publish the one sparse result event after the adapter has reconciled
   * structured backend evidence with authoritative process termination.
   */
  publishTerminalEvent(evidence: AgentTerminalEvidence): void {
    if (
      this.terminalEventPublished
      || !this.terminalProgressCounted
      || this.protocolFailed
      || this.terminalEvidence?.status !== "authoritative"
    ) {
      return;
    }
    this.terminalEventPublished = true;
    this.emitEvent("backend_event", "Claude terminal authority resolved.", {
      source: evidence.source,
      kind: "result",
      status: evidence.status,
      reason: evidence.reason,
      ...(evidence.backend_subtype ? { backend_subtype: evidence.backend_subtype } : {}),
      ...(evidence.session_id ? { session_id: evidence.session_id } : {}),
      ...(evidence.exit_code !== undefined ? { exit_code: evidence.exit_code } : {}),
      ...(evidence.signal ? { signal: evidence.signal } : {}),
    });
    this.publishProgress("result", "semantic_event");
  }

  private now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  private emitEvent(event: LifecycleEvent["event"], message: string, payload?: Record<string, unknown>): void {
    try {
      this.opts.onEvent?.({
        timestamp: this.now(),
        run_id: this.opts.run_id,
        event,
        message,
        ...(payload ? { payload } : {}),
      });
    } catch {
      // Observability sinks must never tear down the backend stdout reader.
    }
  }

  private emitProgress(
    detail: string,
    reason: "stream_initialized" | "semantic_event",
    expectedSilenceMs?: number,
  ): void {
    this.semanticProgressCount += 1;
    this.publishProgress(detail, reason, expectedSilenceMs);
  }

  private publishProgress(
    detail: string,
    reason: "stream_initialized" | "semantic_event",
    expectedSilenceMs?: number,
  ): void {
    try {
      this.opts.onActivity?.({
        source: "claude_stream",
        timestamp: this.now(),
        semantic: true,
        detail,
        ...(expectedSilenceMs !== undefined ? { expected_silence_ms: expectedSilenceMs } : {}),
        signal: {
          source: "claude_stream",
          status: "available",
          reason,
        },
      });
    } catch {
      // Health projection is observational; parsing remains authoritative.
    }
  }

  private drain(flush: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
    }
    if (flush && this.buffer.trim().length > 0) {
      this.parseLine(this.buffer.replace(/\r$/u, ""));
      this.buffer = "";
    } else if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      this.buffer = "";
      this.reportMalformed("oversized_line");
    }
  }

  private parseLine(line: string): void {
    if (line.trim().length === 0) return;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.reportMalformed("oversized_line");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.reportMalformed("invalid_json");
      return;
    }
    const record = asRecord(parsed);
    if (!record) {
      this.reportMalformed("non_object_record");
      return;
    }
    this.structuredRecordCount += 1;
    if (this.identityRejected) return;
    if (!this.validateRecordIdentity(record)) return;
    const type = stringValue(record["type"]);
    if (!this.validateKnownRecordShape(type, record)) return;
    switch (type) {
      case "system":
        this.projectSystem(record);
        return;
      case "assistant":
        this.projectAssistant(record);
        return;
      case "user":
        this.projectUser(record);
        return;
      case "result":
        this.projectResult(record);
        return;
      default:
        this.unknownRecordCount += 1;
        if (this.unknownRecordCount <= MAX_DIAGNOSTIC_EVENTS) {
          this.emitEvent("warning", "Claude stream record type is not projected.", {
            reason: "unknown_record_type",
            unknown_record_count: this.unknownRecordCount,
          });
        }
    }
  }

  private projectSystem(record: Record<string, unknown>): void {
    const subtype = stringValue(record["subtype"]);
    if (subtype === "init") {
      const sessionId = stringValue(record["session_id"]);
      if (sessionId) {
        this.session = { id: sessionId, backend: "claude" };
        try {
          this.opts.onSession?.(this.session);
        } catch {
          // Receipt projection still retains the session id.
        }
      }
      this.emitEvent("backend_event", "Claude structured stream initialized.", {
        source: "claude_stream",
        kind: "stream_initialized",
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(stringValue(record["model"]) ? { model: stringValue(record["model"]) } : {}),
        ...(stringValue(record["claude_code_version"])
          ? { claude_code_version: stringValue(record["claude_code_version"]) }
          : {}),
      });
      this.emitProgress("stream_initialized", "stream_initialized");
      return;
    }
    if (subtype === "api_retry") {
      const legacyError = asRecord(record["error"]);
      const attempt = nonNegativeInteger(record["attempt"]);
      const maxRetries = nonNegativeInteger(record["max_retries"]);
      const retryDelayMs = nonNegativeInteger(record["retry_delay_ms"]);
      const errorStatus = nonNegativeInteger(record["error_status"])
        ?? nonNegativeInteger(legacyError?.["status"]);
      const rawErrorType = stringValue(legacyError?.["type"]);
      const errorType = rawErrorType && SAFE_RETRY_ERROR_TYPES.has(rawErrorType)
        ? rawErrorType
        : rawErrorType ? "unknown" : undefined;
      this.emitEvent("backend_event", "Claude API retry scheduled.", {
        source: "claude_stream",
        kind: "api_retry",
        ...(attempt !== undefined ? { attempt } : {}),
        ...(maxRetries !== undefined ? { max_retries: maxRetries } : {}),
        ...(retryDelayMs !== undefined ? { retry_delay_ms: retryDelayMs } : {}),
        ...(errorType ? { error_type: errorType } : {}),
        ...(errorStatus !== undefined ? { error_status: errorStatus } : {}),
      });
      this.emitProgress(
        "api_retry",
        "semantic_event",
        retryDelayMs !== undefined
          ? Math.min(retryDelayMs, MAX_EXPECTED_SILENCE_MS)
          : undefined,
      );
      return;
    }
    this.unknownRecordCount += 1;
  }

  private projectAssistant(record: Record<string, unknown>): void {
    const message = asRecord(record["message"]);
    const content = Array.isArray(message?.["content"]) ? message["content"] : [];
    let textBlocks = 0;
    let toolUseBlocks = 0;
    const text: string[] = [];
    for (const item of content) {
      const block = asRecord(item);
      if (!block) continue;
      if (block["type"] === "text") {
        textBlocks += 1;
        const value = stringValue(block["text"]);
        if (value) text.push(value);
      } else if (block["type"] === "tool_use") {
        toolUseBlocks += 1;
      }
      // Thinking/redacted_thinking and all tool payload fields are intentionally ignored.
    }
    if (record["parent_tool_use_id"] == null && text.length > 0) {
      this.lastAssistantMessage = text.join("\n");
    }
    if (record["isApiErrorMessage"] === true) {
      const providerCode = stringValue(record["error"]);
      const httpStatus = nonNegativeInteger(record["apiErrorStatus"]);
      const observedAt = stringValue(record["timestamp"]);
      const constraint = detectProviderConstraint({
        backend: "claude",
        source: "backend_stream",
        ...(observedAt ? { observed_at: observedAt } : { observed_at: this.now() }),
        ...(providerCode ? { provider_code: providerCode } : {}),
        ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
        ...(text.length > 0 ? { message: text.join("\n") } : {}),
      });
      if (constraint) this.providerConstraint = constraint;
    }
    this.emitEvent("backend_event", "Claude assistant message completed.", {
      source: "claude_stream",
      kind: "assistant_completed",
      text_blocks: textBlocks,
      tool_use_blocks: toolUseBlocks,
      subagent: record["parent_tool_use_id"] != null,
    });
    this.emitProgress("assistant_completed", "semantic_event");
  }

  private projectUser(record: Record<string, unknown>): void {
    const message = asRecord(record["message"]);
    const content = Array.isArray(message?.["content"]) ? message["content"] : [];
    let toolResultBlocks = 0;
    for (const item of content) {
      if (asRecord(item)?.["type"] === "tool_result") toolResultBlocks += 1;
    }
    this.emitEvent("backend_event", "Claude tool result completed.", {
      source: "claude_stream",
      kind: "tool_result_completed",
      tool_result_blocks: toolResultBlocks,
      subagent: record["parent_tool_use_id"] != null,
    });
    this.emitProgress("tool_result_completed", "semantic_event");
  }

  private projectResult(record: Record<string, unknown>): void {
    this.terminalRecordCount += 1;
    if (this.terminalRecordCount > 1) {
      this.failProtocol("duplicate_result");
      this.terminalEvidence = {
        schema_version: "calyx.agent-terminal-evidence/v1",
        source: "claude_stream",
        status: "malformed",
        reason: "malformed_result",
        malformed_line_count: this.malformedLineCount,
        unknown_record_count: this.unknownRecordCount,
      };
      return;
    }
    const subtype = stringValue(record["subtype"]);
    const resultText = stringValue(record["result"]);
    const recordSessionId = stringValue(record["session_id"]);
    const sessionId = recordSessionId ?? this.session?.id;
    if (sessionId && !this.session) {
      this.session = { id: sessionId, backend: "claude" };
      try {
        this.opts.onSession?.(this.session);
      } catch {
        // Receipt projection still retains the session id.
      }
    }
    if (!subtype || (subtype === "success" && !resultText)) {
      this.failProtocol("malformed_result");
      this.terminalEvidence = {
        schema_version: "calyx.agent-terminal-evidence/v1",
        source: "claude_stream",
        status: "malformed",
        reason: "malformed_result",
        ...(sessionId ? { session_id: sessionId } : {}),
        malformed_line_count: this.malformedLineCount,
        unknown_record_count: this.unknownRecordCount,
      };
      return;
    }
    const backendTerminalReason = stringValue(record["terminal_reason"]);
    const reason = terminalReason(subtype, backendTerminalReason);
    if (reason === "completed") {
      // Current structured success is authoritative over any earlier API
      // error record observed in this same stream.
      this.providerConstraint = undefined;
    }
    const permissionDenials = Array.isArray(record["permission_denials"])
      ? record["permission_denials"].length
      : undefined;
    const usage = safeUsage(record["usage"]);
    const backendStopReason = stringValue(record["stop_reason"]);
    const durationMs = finiteNumber(record["duration_ms"]);
    const durationApiMs = finiteNumber(record["duration_api_ms"]);
    const numTurns = nonNegativeInteger(record["num_turns"]);
    const totalCostUsd = finiteNumber(record["total_cost_usd"]);
    const terminalEvidence: AgentTerminalEvidence = {
      schema_version: "calyx.agent-terminal-evidence/v1",
      source: "claude_stream",
      status: "authoritative",
      reason,
      backend_subtype: subtype,
      ...(backendTerminalReason ? { backend_terminal_reason: backendTerminalReason } : {}),
      ...(backendStopReason ? { backend_stop_reason: backendStopReason } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(durationApiMs !== undefined ? { duration_api_ms: durationApiMs } : {}),
      ...(numTurns !== undefined ? { num_turns: numTurns } : {}),
      ...(totalCostUsd !== undefined ? { total_cost_usd: totalCostUsd } : {}),
      ...(permissionDenials !== undefined ? { permission_denial_count: permissionDenials } : {}),
      ...(usage ? { usage } : {}),
      malformed_line_count: this.malformedLineCount,
      unknown_record_count: this.unknownRecordCount,
    };
    this.terminalEvidence = terminalEvidence;
    this.terminalMessage = resultText ?? this.lastAssistantMessage;
  }

  private validateRecordIdentity(record: Record<string, unknown>): boolean {
    if (!this.opts.expected_session_id) return true;
    const sessionId = stringValue(record["session_id"]);
    if (!sessionId) {
      this.failProtocol("session_id_missing");
      return false;
    }
    if (sessionId !== this.opts.expected_session_id) {
      this.failProtocol("session_id_mismatch");
      return false;
    }
    this.identityConfirmed = true;
    return true;
  }

  private validateKnownRecordShape(
    type: string | undefined,
    record: Record<string, unknown>,
  ): boolean {
    if (!type) {
      this.failProtocol("malformed_record");
      return false;
    }
    if (type === "system") {
      if (!stringValue(record["subtype"])) {
        this.failProtocol("malformed_record");
        return false;
      }
      return true;
    }
    if (type === "assistant" || type === "user") {
      const message = asRecord(record["message"]);
      const content = message?.["content"];
      if (
        !Array.isArray(content)
        || content.some((item) => !stringValue(asRecord(item)?.["type"]))
      ) {
        this.failProtocol("malformed_record");
        return false;
      }
    }
    return true;
  }

  private failProtocol(
    reason:
      | "malformed_record"
      | "malformed_result"
      | "session_id_missing"
      | "session_id_mismatch"
      | "duplicate_result",
  ): void {
    this.reportMalformed(reason);
    this.protocolFailed = true;
    this.identityRejected = true;
    this.identityConfirmed = false;
    this.semanticProgressCount = 0;
    this.lastAssistantMessage = undefined;
    this.terminalEvidence = undefined;
    this.providerConstraint = undefined;
    this.terminalMessage = undefined;
    this.session = undefined;
    try {
      this.opts.onActivity?.({
        source: "claude_stream",
        timestamp: this.now(),
        semantic: false,
        detail: "malformed_stream",
        signal: { source: "claude_stream", status: "failed", reason: "malformed_stream" },
      });
    } catch {
      // Protocol health projection is observational.
    }
  }

  private reportMalformed(
    reason:
      | "invalid_json"
      | "non_object_record"
      | "oversized_line"
      | "malformed_record"
      | "malformed_result"
      | "session_id_missing"
      | "session_id_mismatch"
      | "duplicate_result",
  ): void {
    this.malformedLineCount += 1;
    if (this.malformedLineCount <= MAX_DIAGNOSTIC_EVENTS) {
      this.emitEvent("warning", "Claude stream record could not be projected.", {
        reason,
        malformed_line_count: this.malformedLineCount,
      });
    }
  }
}
