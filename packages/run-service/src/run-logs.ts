import { open } from "node:fs/promises";
import path from "node:path";
import type {
  RecordedRunEvent,
  RunLogEntry,
  RunLogResult,
  RunLogSourceSummary,
  RunLogStream,
  RunRecord,
} from "./types.js";
import { isCalyxRunEvent } from "./types.js";

const DEFAULT_STREAM_TAIL = 40;
const MAX_STREAM_BYTES = 1024 * 1024;

export interface ReadRunLogsOptions {
  tail?: number;
  streamTail?: number;
  maxStreamBytes?: number;
}

export interface RunLogStoreLike {
  paths(runId: string): { runDir: string };
  readEvents(runId: string): Promise<RecordedRunEvent[]>;
  readRunRecord(runId: string): Promise<RunRecord | undefined>;
}

function eventToLogEntry(event: RecordedRunEvent): RunLogEntry {
  if (isCalyxRunEvent(event)) {
    return {
      kind: "event",
      source: "lifecycle",
      text: event.summary.one_line,
      timestamp: event.emitted_at,
      timestamp_source: "event",
      event: event.event_type,
    };
  }
  const text = typeof event.message === "string" && event.message.length > 0
    ? event.message
    : event.event;
  return {
    kind: "event",
    source: "lifecycle",
    text,
    timestamp: event.timestamp,
    timestamp_source: "event",
    event: event.event,
  };
}

function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

async function readTailText(filePath: string, maxBytes: number): Promise<{
  text: string;
  fileSizeBytes: number;
  readFromByte: number;
  truncatedHeadBytes: number;
  latestModifiedAt: string;
} | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const readFromByte = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, readFromByte);
    }
    return {
      text: buffer.toString("utf8"),
      fileSizeBytes: stats.size,
      readFromByte,
      truncatedHeadBytes: readFromByte,
      latestModifiedAt: stats.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readStreamEntries(args: {
  runDir: string;
  source: "host_process" | "run_worker";
  stream: RunLogStream;
  tail: number;
  maxBytes: number;
}): Promise<{ entries: RunLogEntry[]; summary: RunLogSourceSummary }> {
  const filePath = path.join(args.runDir, `${args.stream}.log`);
  const tailText = await readTailText(filePath, args.maxBytes);
  if (!tailText) {
    return {
      entries: [],
      summary: {
        source: args.source,
        stream: args.stream,
        path: filePath,
        exists: false,
        selected_lines: 0,
      },
    };
  }

  let lines = splitLogLines(tailText.text);
  const truncatedPartialLine = tailText.truncatedHeadBytes > 0 && !tailText.text.startsWith("\n");
  if (truncatedPartialLine && lines.length > 0) {
    lines = lines.slice(1);
  }
  const selected = args.tail > 0 ? lines.slice(-args.tail) : [];
  const lineBase = tailText.truncatedHeadBytes > 0
    ? undefined
    : Math.max(1, lines.length - selected.length + 1);

  const entries = selected.map((line, index): RunLogEntry => ({
    kind: "stream_line",
    source: args.source,
    stream: args.stream,
    text: line,
    timestamp: tailText.latestModifiedAt,
    timestamp_source: "file_mtime",
    ...(typeof lineBase === "number" ? { line: lineBase + index } : {}),
    path: filePath,
    ...(tailText.truncatedHeadBytes > 0 ? { truncated_head_bytes: tailText.truncatedHeadBytes } : {}),
  }));

  return {
    entries,
    summary: {
      source: args.source,
      stream: args.stream,
      path: filePath,
      exists: true,
      file_size_bytes: tailText.fileSizeBytes,
      read_from_byte: tailText.readFromByte,
      ...(tailText.truncatedHeadBytes > 0 ? { truncated_head_bytes: tailText.truncatedHeadBytes } : {}),
      selected_lines: selected.length,
      ...(tailText.truncatedHeadBytes === 0 ? { line_count: lines.length } : {}),
      latest_modified_at: tailText.latestModifiedAt,
    },
  };
}

function sortEntries(entries: RunLogEntry[]): RunLogEntry[] {
  return entries.slice().sort((left, right) => {
    const leftTimestamp = left.timestamp ?? "";
    const rightTimestamp = right.timestamp ?? "";
    const byTimestamp = leftTimestamp.localeCompare(rightTimestamp);
    if (byTimestamp !== 0) return byTimestamp;
    if (left.kind !== right.kind) return left.kind === "event" ? -1 : 1;
    if (left.source !== right.source) return left.source.localeCompare(right.source);
    if ((left.stream ?? "") !== (right.stream ?? "")) return (left.stream ?? "").localeCompare(right.stream ?? "");
    return (left.line ?? 0) - (right.line ?? 0);
  });
}

function recordUsesHostProcess(record?: RunRecord): boolean {
  if (!record) return false;
  if (record.intent.kernel === "host_process") return true;
  if (record.spec?.kernel === "host_process") return true;
  return Boolean(
    record.kernel_receipt
      && "kernel" in record.kernel_receipt
      && record.kernel_receipt.kernel === "host_process",
  );
}

export async function readRunLogs(
  store: RunLogStoreLike,
  runId: string,
  options: ReadRunLogsOptions = {},
): Promise<RunLogResult> {
  const record = await store.readRunRecord(runId);
  const paths = store.paths(runId);
  const streamTailDefaulted = typeof options.streamTail !== "number" && typeof options.tail !== "number";
  const streamTail = options.streamTail ?? options.tail ?? DEFAULT_STREAM_TAIL;
  const maxStreamBytes = options.maxStreamBytes ?? MAX_STREAM_BYTES;
  const source = recordUsesHostProcess(record) ? "host_process" : "run_worker";
  const events = await store.readEvents(runId);
  const selectedEvents = typeof options.tail === "number" ? events.slice(-options.tail) : events;
  const streamResults = await Promise.all([
    readStreamEntries({ runDir: paths.runDir, source, stream: "stdout", tail: streamTail, maxBytes: maxStreamBytes }),
    readStreamEntries({ runDir: paths.runDir, source, stream: "stderr", tail: streamTail, maxBytes: maxStreamBytes }),
  ]);
  const entries = sortEntries([
    ...selectedEvents.map(eventToLogEntry),
    ...streamResults.flatMap((result) => result.entries),
  ]);
  const sources = streamResults.map((result) => result.summary);
  const warnings = sources
    .filter((summary) => typeof summary.truncated_head_bytes === "number" && summary.truncated_head_bytes > 0)
    .map((summary) => `${summary.stream ?? "stream"} log read from byte ${summary.read_from_byte}; earlier bytes omitted.`);

  return {
    schema_version: "run-logs/v1",
    run_id: runId,
    entries,
    sources,
    options: {
      ...(typeof options.tail === "number" ? { tail: options.tail } : {}),
      stream_tail: streamTail,
      max_stream_bytes: maxStreamBytes,
      stream_tail_defaulted: streamTailDefaulted,
    },
    warnings,
  };
}
