import {
  API_REQUEST_ID_PATTERN_SOURCE,
  CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
} from "@polli-labs/calyx-core";

export type DeliveryV1Fetch = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
    redirect?: "error" | "follow" | "manual" | undefined;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: (() => Promise<unknown>) | undefined;
  body?: ReadableStream<Uint8Array> | null | undefined;
  headers?: Headers | undefined;
  redirected?: boolean | undefined;
  url?: string | undefined;
}>;

export interface DeliveryV1PostResult {
  ok: boolean;
  status: number;
  response_text: string;
}

export interface DeliveryV1PostOptions {
  headers?: Record<string, string> | undefined;
  body: string;
  timeoutMs: number;
}

export async function postTextDeliveryV1(
  fetchImpl: DeliveryV1Fetch,
  url: string,
  options: DeliveryV1PostOptions,
): Promise<DeliveryV1PostResult> {
  return runWithDeliveryTimeout(options.timeoutMs, {
    method: "POST",
    headers: options.headers,
    body: options.body,
  }, async (init) => {
    const response = await fetchImpl(url, init);
    return {
      ok: response.ok,
      status: response.status,
      response_text: await response.text(),
    };
  });
}

export async function postJsonDeliveryV1(
  fetchImpl: DeliveryV1Fetch,
  url: string,
  options: Omit<DeliveryV1PostOptions, "body"> & { body: unknown },
): Promise<DeliveryV1PostResult> {
  return runWithDeliveryTimeout(options.timeoutMs, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(options.body),
    redirect: "manual",
  }, async (init) => {
    const response = await fetchImpl(url, init);
    if (response.redirected) throw new Error("JSON delivery rejected a redirected response.");
    if (response.url && response.url !== url) {
      throw new Error(`JSON delivery response URL ${response.url} does not match ${url}.`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`JSON delivery rejected redirect status ${response.status}.`);
    }
    if (response.headers) {
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        throw new Error("JSON delivery response requires Content-Type: application/json.");
      }
      const requestId = response.headers.get("x-calyx-request-id");
      if (!requestId || !new RegExp(API_REQUEST_ID_PATTERN_SOURCE, "u").test(requestId)) {
        throw new Error("JSON delivery response requires a canonical X-Calyx-Request-Id.");
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      response_text: await readJsonDeliveryResponseBounded(
        response,
        CALYX_HTTP_DEFAULT_JSON_RESPONSE_MAX_BYTES,
      ),
    };
  });
}

async function readJsonDeliveryResponseBounded(
  response: Awaited<ReturnType<DeliveryV1Fetch>>,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(0|[1-9]\d*)$/u.test(declaredLength)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("JSON delivery response has a noncanonical Content-Length.");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`JSON delivery response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`JSON delivery response exceeds ${maxBytes} bytes.`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteSize = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      byteSize += next.value.byteLength;
      if (byteSize > maxBytes) {
        throw new Error(`JSON delivery response exceeds ${maxBytes} bytes.`);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

async function runWithDeliveryTimeout<T>(
  timeoutMs: number,
  init: Parameters<DeliveryV1Fetch>[1],
  operation: (timedInit: Parameters<DeliveryV1Fetch>[1]) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation(init);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await operation({
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
