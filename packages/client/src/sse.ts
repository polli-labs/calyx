import { createParser } from "eventsource-parser";

import {
  hasDuplicateJsonMembers,
  parseJsonWithNumberLexemes,
} from "./json.js";
import type { JsonNumberLexemes, ParsedJsonWithNumberLexemes } from "./json.js";

export interface CalyxEventStream<T> extends AsyncIterable<T> {
  readonly latestEventId: string | undefined;
  readonly closed: Promise<void>;
  cancel(): void;
}

export interface CalyxEventStreamReconnect {
  readonly maxAttempts: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly initialEventId?: string;
  /** Generated replay-header validation applied before event cursor authority advances. */
  validateEventId?(eventId: string): boolean;
  connect(lastEventId: string | undefined, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  random?(): number;
}

interface QueueWaiter<T> {
  resolve(value: IteratorResult<T>): void;
  reject(error: Error): void;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private pendingValue: {
    readonly value: T;
    resolve(): void;
    reject(error: Error): void;
  } | undefined;
  private ended = false;
  private failure?: Error;

  push(value: T): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error("SSE event queue is closed."));
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return Promise.resolve();
    }
    if (this.pendingValue) return Promise.reject(new Error("SSE event queue exceeded its single-event capacity."));
    return new Promise<void>((resolve, reject) => {
      this.pendingValue = { value, resolve, reject };
    });
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    this.pendingValue?.reject(error);
    this.pendingValue = undefined;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.pendingValue) {
          const pending = this.pendingValue;
          this.pendingValue = undefined;
          pending.resolve();
          return { done: false, value: pending.value };
        }
        if (this.failure) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/** A terminal SSE representation failure; callers must not reconnect it as a network disconnect. */
export class CalyxSseProtocolError extends Error {
  override readonly name = "CalyxSseProtocolError";
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function parseEventJson(text: string): ParsedJsonWithNumberLexemes {
  if (hasDuplicateJsonMembers(text)) throw new SyntaxError("Duplicate SSE JSON member.");
  return parseJsonWithNumberLexemes(text);
}

function abortFailure(): Error {
  return new Error("SSE stream was aborted by the caller.");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortFailure());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortFailure());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function reconnectDelay(
  reconnect: CalyxEventStreamReconnect,
  attempt: number,
  serverDelayMs: number | undefined,
): number {
  const exponential = reconnect.minDelayMs * (2 ** Math.max(0, attempt - 1));
  const bounded = Math.min(reconnect.maxDelayMs, Math.max(reconnect.minDelayMs, serverDelayMs ?? exponential));
  const random = Math.min(1, Math.max(0, reconnect.random?.() ?? Math.random()));
  // Symmetric 20% jitter prevents a fleet of clients reconnecting in lockstep.
  return Math.round(bounded * (0.8 + (0.4 * random)));
}

export function createCalyxEventStream<T>(
  initialBody: ReadableStream<Uint8Array>,
  validate: (value: unknown, numberLexemes?: JsonNumberLexemes) => boolean,
  selectCursor: (value: T) => string | undefined,
  callerSignal?: AbortSignal,
  reconnect?: CalyxEventStreamReconnect,
  maxFrameBytes = 1_048_576,
): CalyxEventStream<T> {
  const queue = new AsyncEventQueue<T>();
  const lifecycle = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let activeReaderCancellation: Promise<void> | undefined;
  let pendingBody: ReadableStream<Uint8Array> | undefined = initialBody;
  let pendingBodyCancellation: Promise<void> | undefined;
  let latestEventId = reconnect?.initialEventId;
  let serverDelayMs: number | undefined;
  let settled = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Iteration is the primary failure surface. Keep `closed` rejectable for
  // explicit awaiters without making it an unhandled secondary rejection.
  void closed.catch(() => undefined);

  const settleSuccess = (): void => {
    if (settled) return;
    settled = true;
    queue.end();
    resolveClosed();
  };
  const settleFailure = (failure: Error): void => {
    if (settled) return;
    settled = true;
    queue.fail(failure);
    rejectClosed(failure);
  };
  const abort = (): Promise<void> => {
    if (!lifecycle.signal.aborted) lifecycle.abort();
    const failure = abortFailure();
    settleFailure(failure);
    if (activeReader && !activeReaderCancellation) {
      activeReaderCancellation = activeReader.cancel(failure).catch(() => undefined);
    }
    if (!activeReader && pendingBody && !pendingBodyCancellation) {
      pendingBodyCancellation = pendingBody.cancel(failure).catch(() => undefined);
    }
    return activeReaderCancellation ?? pendingBodyCancellation ?? Promise.resolve();
  };
  const handleCallerAbort = (): void => {
    void abort();
  };

  callerSignal?.addEventListener("abort", handleCallerAbort, { once: true });
  if (callerSignal?.aborted) void abort();

  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let frameBytes = 0;
    let lineHasContent = false;
    let pendingCarriageReturn = false;
    let protocolFailure: Error | undefined;
    let pendingDelivery: Promise<void> | undefined;
    let eventHasIdField = false;
    let framingLine = "";
    let framingLinePendingCarriageReturn = false;
    const inspectFramingLine = (): void => {
      const separator = framingLine.indexOf(":");
      const field = separator === -1 ? framingLine : framingLine.slice(0, separator);
      if (field === "id") {
        if (eventHasIdField) throw new CalyxSseProtocolError("SSE event contains duplicate id fields.");
        eventHasIdField = true;
      }
      if (framingLine.length === 0) eventHasIdField = false;
      framingLine = "";
    };
    const inspectFraming = (text: string): void => {
      for (const character of text) {
        if (framingLinePendingCarriageReturn) {
          inspectFramingLine();
          framingLinePendingCarriageReturn = false;
          if (character === "\n") continue;
        }
        if (character === "\r") framingLinePendingCarriageReturn = true;
        else if (character === "\n") inspectFramingLine();
        else framingLine += character;
      }
    };
    const parser = createParser({
      onEvent(event) {
        if (protocolFailure) return;
        try {
          const parsed = parseEventJson(event.data);
          if (!validate(parsed.value, parsed.numberLexemes)) {
            throw new Error("SSE event failed its generated structural contract.");
          }
          const typedValue = parsed.value as T;
          const payloadCursor = selectCursor(typedValue);
          if (typeof payloadCursor !== "string" || payloadCursor.length === 0) {
            throw new Error("SSE event omitted its validated payload cursor.");
          }
          if (event.id === undefined || event.id.length === 0) {
            throw new Error("SSE event omitted its required nonempty id.");
          }
          if (event.id !== payloadCursor) {
            throw new Error("SSE event id does not match its validated payload cursor.");
          }
          if (reconnect?.validateEventId && !reconnect.validateEventId(event.id)) {
            throw new Error("SSE event cursor violates its generated Last-Event-ID contract.");
          }
          latestEventId = event.id;
          pendingDelivery = queue.push(typedValue);
        } catch (error: unknown) {
          protocolFailure = new CalyxSseProtocolError(asError(error, "Invalid SSE event.").message);
        }
      },
      onError(error) {
        protocolFailure = new CalyxSseProtocolError(`Invalid SSE framing: ${error.message}`);
      },
      onRetry(milliseconds) {
        serverDelayMs = milliseconds;
      },
    });
    const feed = async (text: string): Promise<void> => {
      let offset = 0;
      while (offset < text.length) {
        let boundary = offset;
        while (boundary < text.length && text[boundary] !== "\r" && text[boundary] !== "\n") boundary += 1;
        if (boundary < text.length) boundary += 1;
        const segment = text.slice(offset, boundary);
        inspectFraming(segment);
        parser.feed(segment);
        if (protocolFailure) throw protocolFailure;
        if (pendingDelivery) {
          const delivery = pendingDelivery;
          pendingDelivery = undefined;
          await delivery;
        }
        offset = boundary;
      }
    };
    const reader = body.getReader();
    if (pendingBody === body) pendingBody = undefined;
    activeReader = reader;
    activeReaderCancellation = undefined;
    try {
      while (true) {
        if (lifecycle.signal.aborted) throw abortFailure();
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const byte of chunk.value) {
          const finishLine = (): void => {
            if (!lineHasContent) frameBytes = 0;
            lineHasContent = false;
          };
          if (pendingCarriageReturn) {
            if (byte === 0x0a) {
              frameBytes += 1;
              if (frameBytes > maxFrameBytes) {
                throw new CalyxSseProtocolError(`SSE frame exceeds ${maxFrameBytes} wire bytes.`);
              }
              finishLine();
              pendingCarriageReturn = false;
              continue;
            }
            finishLine();
            pendingCarriageReturn = false;
          }
          frameBytes += 1;
          if (frameBytes > maxFrameBytes) {
            throw new CalyxSseProtocolError(`SSE frame exceeds ${maxFrameBytes} wire bytes.`);
          }
          if (byte === 0x0d) pendingCarriageReturn = true;
          else if (byte === 0x0a) finishLine();
          else lineHasContent = true;
        }
        let text: string;
        try {
          text = decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new CalyxSseProtocolError("SSE stream contains invalid UTF-8.");
        }
        await feed(text);
      }
      if (pendingCarriageReturn) {
        if (!lineHasContent) frameBytes = 0;
        pendingCarriageReturn = false;
      }
      let finalText: string;
      try {
        finalText = decoder.decode();
      } catch {
        throw new CalyxSseProtocolError("SSE stream contains invalid UTF-8.");
      }
      await feed(finalText);
      // eventsource-parser defers a terminal bare CR until it can distinguish
      // CR from CRLF. Complete that valid line ending without fabricating an
      // additional blank line when the stream ended after an ordinary field.
      if (framingLinePendingCarriageReturn) await feed("\n");
    } catch (error: unknown) {
      if (!activeReaderCancellation) {
        activeReaderCancellation = reader.cancel(error).catch(() => undefined);
      }
      await activeReaderCancellation;
      throw error;
    } finally {
      if (activeReader === reader) {
        activeReader = undefined;
        activeReaderCancellation = undefined;
      }
      reader.releaseLock();
    }
  };

  void (async () => {
    let body = initialBody;
    let reconnectAttempt = 0;
    let lastFailure: Error | undefined;
    try {
      while (!settled) {
        let endedCleanly = false;
        try {
          await consume(body);
          endedCleanly = true;
          lastFailure = undefined;
        } catch (error: unknown) {
          lastFailure = asError(error, "SSE stream failed.");
          if (lastFailure instanceof CalyxSseProtocolError) throw lastFailure;
          if (lifecycle.signal.aborted) throw abortFailure();
        }

        if (!reconnect || reconnectAttempt >= reconnect.maxAttempts) {
          if (endedCleanly) settleSuccess();
          else throw lastFailure ?? new Error("SSE stream failed.");
          return;
        }

        let connected = false;
        while (!connected && reconnectAttempt < reconnect.maxAttempts) {
          reconnectAttempt += 1;
          await delay(reconnectDelay(reconnect, reconnectAttempt, serverDelayMs), lifecycle.signal);
          try {
            const connectedBody = await reconnect.connect(
              latestEventId && latestEventId.length > 0 ? latestEventId : undefined,
              lifecycle.signal,
            );
            if (settled || lifecycle.signal.aborted) {
              const failure = abortFailure();
              await connectedBody.cancel(failure).catch(() => undefined);
              throw failure;
            }
            body = connectedBody;
            pendingBody = body;
            pendingBodyCancellation = undefined;
            connected = true;
          } catch (error: unknown) {
            lastFailure = asError(error, "SSE reconnect failed.");
          }
        }
        if (!connected) throw lastFailure ?? new Error("SSE reconnect failed.");
      }
    } catch (error: unknown) {
      settleFailure(asError(error, "SSE stream failed."));
    } finally {
      callerSignal?.removeEventListener("abort", handleCallerAbort);
    }
  })();

  return {
    get latestEventId() {
      return latestEventId;
    },
    closed,
    cancel: () => {
      void abort();
    },
    [Symbol.asyncIterator]() {
      const iterator = queue[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => {
          await abort();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
