/**
 * @polli-labs/calyx-runner — Session file parsers.
 *
 * Parse Claude JSONL session files to extract assistant messages. Supports
 * both terminal-message extraction (single) and full-history extraction
 * (all assistant messages with timestamps).
 *
 * NO TRUNCATION: The terminal message is the highest-signal artifact in
 * the receipt and must be preserved in full.
 */

import { readFile } from "node:fs/promises";
import { detectProviderConstraint } from "../provider-constraint.js";
import type { ProviderConstraint } from "../types.js";

/** A timestamped assistant message extracted from a session file. */
export interface AssistantMessage {
  text: string;
  timestamp: string;
}

/** Filesystem abstraction for testing. */
export interface SessionParserFs {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

const defaultFs: SessionParserFs = {
  readFile: (p, enc) => readFile(p, enc),
};

// ── Claude Code parsing ─────────────────────────────────────────────

/**
 * Extract the terminal (last) assistant message from a Claude Code session JSONL.
 *
 * Claude JSONL record shape:
 * ```
 * { uuid, timestamp, sessionId, type: "assistant", message: { role: "assistant", content: [...] } }
 * ```
 * Content blocks can be `{ type: "text", text: "..." }` or tool results, etc.
 * We extract text blocks.
 */
export async function parseClaudeTerminalMessage(
  sessionPath: string,
  fs: SessionParserFs = defaultFs,
): Promise<string | undefined> {
  const messages = await parseClaudeAssistantMessages(sessionPath, fs);
  const last = messages[messages.length - 1];
  return last?.text;
}

/**
 * Extract ALL assistant messages from a Claude Code session JSONL.
 * Returns them in chronological order with timestamps.
 */
export async function parseClaudeAssistantMessages(
  sessionPath: string,
  fs: SessionParserFs = defaultFs,
): Promise<AssistantMessage[]> {
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const messages: AssistantMessage[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type !== "assistant") continue;

        const timestamp =
          typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();

        const text = extractClaudeMessageText(record);
        if (text) {
          messages.push({ text, timestamp });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Extract an exact Claude API quota/session-limit terminal fact.
 *
 * The transcript record is synthetic assistant output with
 * `isApiErrorMessage=true`; unrelated assistant prose never qualifies.
 */
export async function parseClaudeProviderConstraint(
  sessionPath: string,
  fs: SessionParserFs = defaultFs,
): Promise<ProviderConstraint | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    let latest: ProviderConstraint | undefined;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record["parent_tool_use_id"] != null) {
          continue;
        }
        if (record["type"] === "user") {
          // A new top-level turn makes any earlier turn's terminal constraint
          // historical, even if this turn ends before emitting an assistant row.
          latest = undefined;
          continue;
        }
        if (record["type"] !== "assistant") continue;
        if (record["isApiErrorMessage"] !== true) {
          // The latest top-level assistant result is ordinary output, so a
          // previous turn's provider error cannot classify this resumed turn.
          latest = undefined;
          continue;
        }
        const providerCode = typeof record["error"] === "string"
          ? record["error"]
          : undefined;
        const httpStatus = typeof record["apiErrorStatus"] === "number"
          ? record["apiErrorStatus"]
          : undefined;
        const observedAt = typeof record["timestamp"] === "string"
          ? record["timestamp"]
          : undefined;
        const message = extractClaudeMessageText(record);
        const constraint = detectProviderConstraint({
          backend: "claude",
          source: "session_transcript",
          ...(observedAt ? { observed_at: observedAt } : {}),
          ...(providerCode ? { provider_code: providerCode } : {}),
          ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
          ...(message ? { message } : {}),
        });
        // Near-miss API errors are not capacity authority and supersede an
        // earlier top-level assistant terminal record.
        latest = constraint;
      } catch {
        // Malformed unrelated lines do not erase an exact terminal fact.
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

/** Extract text content from a Claude message record. */
function extractClaudeMessageText(record: Record<string, unknown>): string | undefined {
  const message = record.message as Record<string, unknown> | undefined;
  if (!message) return undefined;

  const content = message.content;

  // Content can be a string directly
  if (typeof content === "string") {
    return content.trim() || undefined;
  }

  // Or an array of content blocks
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as Record<string, unknown>).type === "text" &&
        "text" in block &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        textParts.push((block as Record<string, unknown>).text as string);
      }
    }
    const joined = textParts.join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}
