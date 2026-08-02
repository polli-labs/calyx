import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  ACTIVITY_ATTACHMENT_MAX_BYTES,
  writeVerifiedAttachmentCache,
  type ActivityAttachmentRecordResult,
} from "@polli-labs/calyx-run-service";
import {
  fetchRemoteActivityAttachmentRecord,
  materializeRemoteActivityAttachment,
  requestRemoteAttachmentToCache,
  resolveRunServerAccess,
} from "../activity-attachment-client.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

async function makeOutDir(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "calyx-attachment-stream-"));
  created.push(outDir);
  return outDir;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function generatedClientDeps(fetchImpl: typeof fetch) {
  return {
    createAdminClient: (options: Parameters<typeof createCalyxAdminClient>[0]) => (
      createCalyxAdminClient({ ...options, fetch: fetchImpl })
    ),
  };
}

function makeRecord(bytes: Uint8Array): ActivityAttachmentRecordResult {
  const digest = sha256(bytes);
  return {
    schema_version: "activity.attachment-record/v1",
    classifier_version: "v1.test",
    ref: `att:sha256:${digest}`,
    sha256: digest,
    mime_type: "application/octet-stream",
    byte_size: bytes.byteLength,
    source_shape: "codex.input_image.data_url",
    exact_bytes_available: true,
    activity_id: "interactive:codex:session-1",
    message_id: "interactive:codex:session-1:msg:1",
    source_line: 1,
    event_index: 0,
    source_tier: "origin-daemon",
    origin_host: "carbon",
    served_by_host: "carbon",
    source_receipt: {
      mode: "streaming",
      bytes_scanned: 1,
      records_scanned: 1,
      records_decoded: 1,
      oversized_records_skipped: 0,
      max_record_bytes: ACTIVITY_ATTACHMENT_MAX_BYTES,
      source_bytes: 1,
      guard_hits: [],
    },
  };
}

describe("run-server credential authority", () => {
  const hostsTruth = {
    hosts: {
      blade: { run_serve_url: "https://blade.example:443/calyx/control/" },
    },
  };

  test("resolves ambient credentials only for the exact normalized base-path binding", async () => {
    const tokenForHost = vi.fn(() => "ambient-token");
    await expect(resolveRunServerAccess({
      host: "blade",
      serverUrl: "https://blade.example/calyx/control",
    }, {
      agentsInfraRoot: "/unused",
      readHostsTruth: () => hostsTruth,
      tokenForHost,
    })).resolves.toEqual({
      host: "blade",
      serverUrl: "https://blade.example/calyx/control",
      token: "ambient-token",
    });
    expect(tokenForHost).toHaveBeenCalledOnce();
  });

  test.each([
    ["different base path", "https://blade.example/calyx/other"],
    ["different repeated trailing slash path", "https://blade.example/calyx/control//"],
    ["query", "https://blade.example/calyx/control?tenant=other"],
    ["fragment", "https://blade.example/calyx/control#other"],
    ["userinfo", "https://operator@blade.example/calyx/control"],
    ["different effective port", "https://blade.example:444/calyx/control"],
  ])("does not resolve ambient credentials for a %s", async (_name, serverUrl) => {
    const tokenForHost = vi.fn(() => "ambient-token");
    await expect(resolveRunServerAccess({ host: "blade", serverUrl }, {
      agentsInfraRoot: "/unused",
      readHostsTruth: () => hostsTruth,
      tokenForHost,
    })).resolves.toEqual({ host: "blade", serverUrl });
    expect(tokenForHost).not.toHaveBeenCalled();
  });

  test.each([
    "https://blade.example/calyx/control?tenant=other",
    "https://blade.example/calyx/control#other",
  ])("rejects query or fragment data in configured run-server URLs", async (configuredUrl) => {
    await expect(resolveRunServerAccess({ host: "blade" }, {
      agentsInfraRoot: "/unused",
      readHostsTruth: () => ({
        hosts: { blade: { run_serve_url: configuredUrl } },
      }),
      tokenForHost: vi.fn(() => "ambient-token"),
    })).rejects.toMatchObject({ code: "run_server_url_invalid" });
  });
});

function responseHeaders(
  record: ActivityAttachmentRecordResult,
  overrides: Record<string, string | null> = {},
): Headers {
  const headers = new Headers({
    "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
    "content-type": record.mime_type,
    "content-length": String(record.byte_size),
    digest: `sha-256=${Buffer.from(record.sha256, "hex").toString("base64")}`,
    etag: `"sha256:${record.sha256}"`,
    "x-calyx-attachment-ref": record.ref,
    "x-calyx-source-tier": record.source_tier,
    ...(record.origin_host ? { "x-calyx-origin-host": record.origin_host } : {}),
    ...(record.served_by_host ? { "x-calyx-served-by-host": record.served_by_host } : {}),
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

function streamingResponse(
  record: ActivityAttachmentRecordResult,
  chunks: Uint8Array[],
  headerOverrides: Record<string, string | null> = {},
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers: responseHeaders(record, headerOverrides),
  });
}

async function transfer(
  outDir: string,
  record: ActivityAttachmentRecordResult,
  response: Response,
) {
  return requestRemoteAttachmentToCache({
    serverUrl: "http://carbon:8740",
    token: "secret",
    activityId: record.activity_id,
    ref: record.ref,
    outDir,
    remoteLabel: "carbon",
    attachment: record,
    deps: generatedClientDeps(vi.fn(async () => response)),
  });
}

async function expectNoPartialPublish(outDir: string, _record: ActivityAttachmentRecordResult): Promise<void> {
  const tmpEntries = await readdir(join(outDir, "_tmp")).catch(() => []);
  expect(tmpEntries).toEqual([]);
  const topLevel = await readdir(outDir, { withFileTypes: true });
  expect(topLevel.filter((entry) => entry.isFile())).toEqual([]);
}

describe("remote activity attachment streaming", () => {
  test.each([
    ["digest", (record: ActivityAttachmentRecordResult) => ({ ...record, sha256: "A".repeat(64) }), undefined],
    ["content-addressed ref", (record: ActivityAttachmentRecordResult) => ({ ...record, ref: `att:sha256:${"0".repeat(64)}` }), undefined],
    ["requested ref", (record: ActivityAttachmentRecordResult) => record, `att:sha256:${"0".repeat(64)}`],
    ["activity id", (record: ActivityAttachmentRecordResult) => ({ ...record, activity_id: "interactive:codex:other" }), undefined],
    ["MIME type", (record: ActivityAttachmentRecordResult) => ({ ...record, mime_type: "not a mime" }), undefined],
    ["source tier", (record: ActivityAttachmentRecordResult) => (
      { ...record, source_tier: undefined } as unknown as ActivityAttachmentRecordResult
    ), undefined],
    ["illegal source tier", (record: ActivityAttachmentRecordResult) => (
      { ...record, source_tier: "archive tier" }
    ), undefined],
    ["oversized source tier", (record: ActivityAttachmentRecordResult) => (
      { ...record, source_tier: `a${"b".repeat(128)}` }
    ), undefined],
  ] as const)("rejects a record with a mismatched %s before cache or byte fetch", async (_name, mutate, requestedRef) => {
    const outDir = await makeOutDir();
    const record = mutate(makeRecord(Buffer.from("record-bound")));
    const fetchImpl = vi.fn();
    await expect(materializeRemoteActivityAttachment({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: "interactive:codex:session-1",
      ref: requestedRef ?? record.ref,
      outDir,
      remoteLabel: "carbon",
      record,
      deps: generatedClientDeps(fetchImpl),
    })).rejects.toMatchObject({ code: "attachment_response_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(outDir)).toEqual([]);
  });

  test("accepts a rolling-open future source tier that obeys the shared token law", async () => {
    const outDir = await makeOutDir();
    const bytes = Buffer.from("future-tier-bound");
    const record = { ...makeRecord(bytes), source_tier: "future-archive:v2" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bytes, {
      status: 200,
      headers: responseHeaders(record),
    }));

    await expect(materializeRemoteActivityAttachment({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: record.activity_id,
      ref: record.ref,
      outDir,
      remoteLabel: "carbon",
      record,
      deps: generatedClientDeps(fetchImpl),
    })).resolves.toMatchObject({ source_tier: "future-archive:v2" });
  });

  test("binds the dynamic byte response MIME and cancels a rejected body", async () => {
    const outDir = await makeOutDir();
    const bytes = Buffer.from("mime-bound");
    const record = makeRecord(bytes);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 200,
      headers: responseHeaders(record, { "content-type": "image/png" }),
    });

    await expect(transfer(outDir, record, response))
      .rejects.toMatchObject({ code: "attachment_response_invalid" });
    expect(cancel).toHaveBeenCalledTimes(1);
    await expectNoPartialPublish(outDir, record);
  });

  test("validates metadata-only record identity before returning without a byte fetch", async () => {
    const outDir = await makeOutDir();
    const record = {
      ...makeRecord(Buffer.from("metadata-only")),
      exact_bytes_available: false,
      activity_id: "interactive:codex:wrong-session",
    };
    const fetchImpl = vi.fn();

    await expect(materializeRemoteActivityAttachment({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: "interactive:codex:session-1",
      ref: record.ref,
      outDir,
      remoteLabel: "carbon",
      record,
      deps: generatedClientDeps(fetchImpl),
    })).rejects.toMatchObject({ code: "attachment_response_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(outDir)).toEqual([]);
  });

  test("rejects a shape-valid remote record whose identity does not match its request", async () => {
    const record = {
      ...makeRecord(Buffer.from("remote-record")),
      activity_id: "interactive:codex:wrong-session",
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(record), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
      },
    }));

    await expect(fetchRemoteActivityAttachmentRecord({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: "interactive:codex:session-1",
      ref: record.ref,
      deps: generatedClientDeps(fetchImpl),
    })).rejects.toMatchObject({ code: "attachment_response_invalid" });
  });

  test.each([
    ["missing", { "content-length": null }, "attachment_response_invalid"],
    ["wrong", { "content-length": "4" }, "attachment_size_mismatch"],
    ["oversized", { "content-length": String(ACTIVITY_ATTACHMENT_MAX_BYTES + 1) }, "attachment_response_invalid"],
  ] as const)("rejects %s Content-Length before publishing", async (_name, overrides, code) => {
    const outDir = await makeOutDir();
    const bytes = Buffer.from("abc");
    const record = makeRecord(bytes);
    await expect(transfer(outDir, record, streamingResponse(record, [bytes], overrides)))
      .rejects.toMatchObject({ code });
    await expectNoPartialPublish(outDir, record);
  });

  test.each([
    ["digest", { digest: "sha-256=invalid" }],
    ["etag", { etag: "\"sha256:invalid\"" }],
    ["ref", { "x-calyx-attachment-ref": "att:sha256:invalid" }],
    ["source tier", { "x-calyx-source-tier": "forwarded-daemon" }],
    ["origin host", { "x-calyx-origin-host": "worm" }],
    ["served-by host", { "x-calyx-served-by-host": "worm" }],
  ] as const)("rejects an inexact %s binding header", async (_name, overrides) => {
    const outDir = await makeOutDir();
    const bytes = Buffer.from("header-bound");
    const record = makeRecord(bytes);
    await expect(transfer(outDir, record, streamingResponse(record, [bytes], overrides)))
      .rejects.toMatchObject({ code: "attachment_response_invalid" });
    await expectNoPartialPublish(outDir, record);
  });

  test.each([
    ["overrun", [Buffer.from("123"), Buffer.from("4")]],
    ["underrun", [Buffer.from("12")]],
  ] as const)("rejects a stream %s and removes the temporary file", async (_name, chunks) => {
    const outDir = await makeOutDir();
    const record = makeRecord(Buffer.from("123"));
    await expect(transfer(outDir, record, streamingResponse(record, [...chunks])))
      .rejects.toMatchObject({ code: "attachment_size_mismatch" });
    await expectNoPartialPublish(outDir, record);
  });

  test("rejects a body digest mismatch after an exact-length stream", async () => {
    const outDir = await makeOutDir();
    const record = makeRecord(Buffer.from("expected"));
    await expect(transfer(outDir, record, streamingResponse(record, [Buffer.from("rejected")])))
      .rejects.toMatchObject({ code: "attachment_digest_mismatch" });
    await expectNoPartialPublish(outDir, record);
  });

  test("streams a large multi-chunk body into an atomically published cache object", async () => {
    const outDir = await makeOutDir();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 37, 0x5a);
    const record = makeRecord(bytes);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 17 * 1024) {
      chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + 17 * 1024)));
    }
    const result = await transfer(outDir, record, streamingResponse(record, chunks));
    expect(result.cache_status).toBe("written");
    expect(sha256(await readFile(result.path))).toBe(record.sha256);
    expect(await readdir(join(outDir, "_tmp")).catch(() => [])).toEqual([]);
  });

  test("verifies a large cache hit by file and does not refetch bytes", async () => {
    const outDir = await makeOutDir();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 19, 0x31);
    const record = makeRecord(bytes);
    await writeVerifiedAttachmentCache({
      outDir,
      attachment: record,
      bytes,
      sourceTier: record.source_tier,
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("cache hit must not fetch");
    });
    const result = await materializeRemoteActivityAttachment({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: record.activity_id,
      ref: record.ref,
      outDir,
      remoteLabel: "carbon",
      record,
      deps: generatedClientDeps(fetchImpl),
    });
    expect(result.cache_status).toBe("hit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects an oversized record before creating cache state or contacting the owner", async () => {
    const outDir = await makeOutDir();
    const record = {
      ...makeRecord(Buffer.from("small")),
      byte_size: ACTIVITY_ATTACHMENT_MAX_BYTES + 1,
    };
    const fetchImpl = vi.fn();
    await expect(materializeRemoteActivityAttachment({
      serverUrl: "http://carbon:8740",
      token: "secret",
      activityId: record.activity_id,
      ref: record.ref,
      outDir,
      remoteLabel: "carbon",
      record,
      deps: generatedClientDeps(fetchImpl),
    })).rejects.toMatchObject({ code: "attachment_size_limit_exceeded" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(outDir)).toEqual([]);
  });

  test("does not replace a valid cache object when a concurrent transfer resolves as a hit", async () => {
    const outDir = await makeOutDir();
    const bytes = Buffer.from("already cached");
    const record = makeRecord(bytes);
    await writeVerifiedAttachmentCache({
      outDir,
      attachment: record,
      bytes,
      sourceTier: record.source_tier,
    });
    const result = await transfer(outDir, record, streamingResponse(record, [bytes]));
    expect(result.cache_status).toBe("hit");
    expect(await readFile(result.path, "utf8")).toBe("already cached");
    expect(await readdir(join(outDir, "_tmp")).catch(() => [])).toEqual([]);
  });
});
