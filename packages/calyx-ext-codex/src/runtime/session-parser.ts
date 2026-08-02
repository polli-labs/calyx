import {
  detectProviderConstraint,
  type AssistantMessage,
  type ProviderConstraint,
  type SessionParserFs,
} from "@polli-labs/calyx-runner";
import { readFile } from "node:fs/promises";

const defaultFs: SessionParserFs = {
  readFile: (p, enc) => readFile(p, enc),
};

export async function parseCodexTerminalMessage(
  sessionPath: string,
  fs: SessionParserFs = defaultFs,
): Promise<string | undefined> {
  const messages = await parseCodexAssistantMessages(sessionPath, fs);
  const last = messages[messages.length - 1];
  return last?.text;
}

export async function parseCodexAssistantMessages(
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
        if (record.type !== "response_item") continue;
        const payload = record.payload as Record<string, unknown> | undefined;
        if (!payload) continue;
        if (payload.role !== "assistant" || payload.type !== "message") continue;

        const timestamp =
          typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();

        const text = extractCodexMessageText(payload);
        if (text) {
          messages.push({ text, timestamp });
        }
      } catch {
        // Skip malformed lines.
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Detect the exact Codex exhausted-credits terminal shape.
 *
 * A credits=false token snapshot is not terminal by itself: already-running
 * sessions can continue after the account stops admitting fresh work. Bind it
 * to the subsequent task_complete with no assistant message before emitting a
 * durable capacity cause.
 */
export async function parseCodexProviderConstraint(
  sessionPath: string,
  fs: SessionParserFs = defaultFs,
): Promise<ProviderConstraint | undefined> {
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    let exhaustedCreditsObservedAt: string | undefined;
    let terminalConstraint: ProviderConstraint | undefined;

    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type !== "event_msg") continue;
        const payload = asRecord(record.payload);
        if (!payload) continue;
        const timestamp = typeof record.timestamp === "string" ? record.timestamp : undefined;

        if (payload.type === "task_started") {
          // This is the authoritative boundary for a resumed turn. Until that
          // turn itself completes with matching exhaustion evidence, an older
          // terminal constraint is historical.
          exhaustedCreditsObservedAt = undefined;
          terminalConstraint = undefined;
          continue;
        }

        if (payload.type === "token_count") {
          const rateLimits = asRecord(payload.rate_limits) ?? asRecord(asRecord(payload.info)?.rate_limits);
          const credits = asRecord(rateLimits?.credits);
          if (credits?.has_credits === false) {
            exhaustedCreditsObservedAt = timestamp;
          } else if (credits?.has_credits === true) {
            exhaustedCreditsObservedAt = undefined;
          }
          continue;
        }

        if (payload.type === "task_complete") {
          if (payload.last_agent_message === null && exhaustedCreditsObservedAt) {
            terminalConstraint = detectProviderConstraint({
              backend: "codex",
              source: "session_transcript",
              observed_at: exhaustedCreditsObservedAt,
              credits_available: false,
            });
          } else {
            // Only the latest completed turn may author terminal capacity.
            terminalConstraint = undefined;
          }
          exhaustedCreditsObservedAt = undefined;
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return terminalConstraint;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function extractCodexMessageText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;

  if (typeof content === "string") {
    return content.trim() || undefined;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        "text" in block &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const btype = (block as Record<string, unknown>).type;
        if (btype === "output_text" || btype === "text") {
          textParts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
    const joined = textParts.join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}
