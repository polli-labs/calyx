import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import {
  buildCalyxMcpActivityAttachmentsManifestV1,
  buildCalyxMcpVaultContextManifestV1,
  CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
  INTERFACE_MANIFEST_RECORDS
} from "@polli-labs/calyx-core";
import type {
  ActivityAttachmentBytesResult,
  ActivityAttachmentRecordResult,
  ActivityAttachmentsResult
} from "@polli-labs/calyx-run-service";
import { ActivityAttachmentError } from "@polli-labs/calyx-run-service";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";
import {
  startCalyxMcpActivityAttachmentsHttpServerV1,
  startCalyxMcpVaultContextHttpServerV1
} from "../mcp-server";

const roots = new Set<string>();
const clients: Client[] = [];

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {});
  }
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

async function createVault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-mcp-command-"));
  roots.add(root);
  const vaultPath = path.join(root, "vault");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(vaultPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return vaultPath;
}

function manifestCommandPaths(): string[] {
  return INTERFACE_MANIFEST_RECORDS.map((record) => record.agent_context.command_path);
}

function propertyKeys(schema: unknown): string[] {
  const record = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  const properties = record["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties).sort();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeAttachmentFixture(): {
  bytes: Buffer;
  record: ActivityAttachmentRecordResult;
  result: ActivityAttachmentsResult;
} {
  const bytes = Buffer.from("mcp activity attachment image bytes");
  const digest = sha256(bytes);
  const ref = `att:sha256:${digest}`;
  const record: ActivityAttachmentRecordResult = {
    schema_version: "activity.attachment-record/v1",
    classifier_version: "test-classifier",
    ref,
    sha256: digest,
    mime_type: "image/png",
    byte_size: bytes.byteLength,
    source_shape: "codex.input_image.data_url",
    exact_bytes_available: true,
    activity_id: "interactive:codex:test-session",
    message_id: "interactive:codex:test-session:msg:1",
    source_line: 1,
    event_index: 0,
    source_tier: "local-transcript",
    source_locator: "codex://threads/test-session",
    origin_host: "blade",
    served_by_host: "blade",
    source_receipt: {
      mode: "streaming",
      bytes_scanned: bytes.byteLength,
      records_scanned: 1,
      records_decoded: 1,
      oversized_records_skipped: 0,
      max_record_bytes: 64 * 1024 * 1024,
      guard_hits: []
    }
  };
  return {
    bytes,
    record,
    result: {
      schema_version: "activity.attachments/v1",
      classifier_version: "test-classifier",
      activity_id: record.activity_id,
      backend: "codex",
      session_id: "test-session",
      session_path: "/tmp/test-session.jsonl",
      source_receipt: record.source_receipt,
      attachments: [record],
      rollup: {
        images: 1,
        bytes: bytes.byteLength,
        refs: [ref]
      }
    }
  };
}

async function rawHttpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "POST",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("calyx mcp command", () => {
  test("manifest emits validated vault-context MCP descriptors", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "mcp", "manifest", "--surface", "vault-context", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schema_version: string;
      surface: string;
      validation: { ok: boolean };
      tools: Array<{ name: string; read_only: boolean; backing_command: { path: string } }>;
    };
    expect(payload.schema_version).toBe("calyx.mcp.vault-context/v0");
    expect(payload.surface).toBe("vault-context");
    expect(payload.validation.ok).toBe(true);
    expect(payload.tools.map((tool) => tool.name)).toContain("context_plan");
    expect(payload.tools.every((tool) => tool.read_only)).toBe(true);
    expect(payload.tools.find((tool) => tool.name === "vault_fetch")?.backing_command.path).toBe("vault fetch");
  });

  test("manifest emits validated activity-attachments MCP descriptors", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "mcp", "manifest", "--surface", "activity-attachments", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schema_version: string;
      surface: string;
      validation: { ok: boolean };
      security: { bytes_in_activity_projection: boolean; image_tool_success_shape: string };
      tools: Array<{ name: string; read_only: boolean; output_schema_ref: string }>;
    };
    expect(payload.schema_version).toBe("calyx.mcp.activity-attachments/v0");
    expect(payload.surface).toBe("activity-attachments");
    expect(payload.validation.ok).toBe(true);
    expect(payload.security.bytes_in_activity_projection).toBe(false);
    expect(payload.security.image_tool_success_shape).toBe("image_only_content_block");
    expect(payload.tools.map((tool) => tool.name)).toContain("activity_attachment_image");
    expect(payload.tools.every((tool) => tool.read_only)).toBe(true);
    expect(payload.tools.find((tool) => tool.name === "activity_attachment_image")?.output_schema_ref).toBe("McpImageContentBlock");
  });

  test("serve exposes read-only tools over Streamable HTTP", async () => {
    const vaultPath = await createVault({
      "40-context/source.md": "# Source\nPOL-1521 MCP HTTP smoke.\n"
    });
    const stderr = { write: vi.fn() };
    const started = await startCalyxMcpVaultContextHttpServerV1({
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: "CALYX_TEST_CONTEXT_MCP_TOKEN",
      vaultPath,
      cliVersion: "test",
      commandPaths: manifestCommandPaths(),
      agentContextProvider: () => ({
        schema_version: "calyx.agent-context/v1",
        commands: [{ path: "mcp manifest" }, { path: "mcp serve" }]
      }),
      stderr
    });

    try {
      expect(started.result.url).toContain("/mcp");
      expect(started.result.tools).toContain("vault_fetch");

      const client = new Client({ name: "calyx-mcp-command-test", version: "1.0.0" });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(started.result.url));
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

      const tools = await client.listTools();
      const manifestTools = buildCalyxMcpVaultContextManifestV1({ commandPaths: manifestCommandPaths() }).tools;
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["vault_search", "vault_fetch", "agent_context"])
      );
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(manifestTools.map((tool) => tool.name).sort());
      for (const manifestTool of manifestTools) {
        const sdkTool = tools.tools.find((tool) => tool.name === manifestTool.name);
        expect(sdkTool?.description).toBe(manifestTool.description);
        expect(propertyKeys(sdkTool?.inputSchema)).toEqual(propertyKeys(manifestTool.input_schema));
        expect(propertyKeys(sdkTool?.inputSchema)).not.toContain("vault_path");
      }
      expect(tools.tools.find((tool) => tool.name === "vault_fetch")?.annotations?.readOnlyHint).toBe(true);

      const fetched = await client.callTool({
        name: "vault_fetch",
        arguments: {
          vault_uri: "vault://fieldwork/40-context/source.md",
          include_frontmatter: true
        }
      });
      expect(fetched.isError).not.toBe(true);
      const content = fetched.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      if (content[0]?.type === "text") {
        expect(content[0].text).toContain("POL-1521 MCP HTTP smoke.");
      }

      const listedToolNames = tools.tools.map((tool) => tool.name).join("\n");
      expect(listedToolNames).not.toMatch(/vault_put|putVault|write|delete/i);
      expect(stderr.write).toHaveBeenCalled();
    } finally {
      await started.close();
    }
  });

  test("serve exposes activity attachment metadata and image-only blocks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-mcp-activity-attachments-"));
    roots.add(root);
    const attachment = makeAttachmentFixture();
    const stderr = { write: vi.fn() };
    const started = await startCalyxMcpActivityAttachmentsHttpServerV1({
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: "CALYX_TEST_CONTEXT_MCP_TOKEN",
      cliVersion: "test",
      commandPaths: manifestCommandPaths(),
      outDir: path.join(root, "cache"),
      activityService: {
        async inspectActivityAttachments(): Promise<ActivityAttachmentsResult> {
          return attachment.result;
        },
        async inspectActivityAttachmentRecord(options): Promise<ActivityAttachmentRecordResult> {
          if (options.ref !== attachment.record.ref) {
            throw new ActivityAttachmentError(
              "attachment_ref_unknown",
              `Activity ${options.activityId} does not contain attachment ref ${options.ref}.`
            );
          }
          return attachment.record;
        },
        async readActivityAttachmentBytes(options): Promise<ActivityAttachmentBytesResult> {
          if (options.ref !== attachment.record.ref) {
            throw new ActivityAttachmentError(
              "attachment_ref_unknown",
              `Activity ${options.activityId} does not contain attachment ref ${options.ref}.`
            );
          }
          return { record: attachment.record, bytes: attachment.bytes };
        }
      },
      stderr
    });

    try {
      expect(started.result.tools).toEqual([
        "activity_attachments_list",
        "activity_attachment_record",
        "activity_attachment_image"
      ]);

      const client = new Client({ name: "calyx-mcp-activity-test", version: "1.0.0" });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(started.result.url));
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);

      const tools = await client.listTools();
      const manifestTools = buildCalyxMcpActivityAttachmentsManifestV1({ commandPaths: manifestCommandPaths() }).tools;
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(manifestTools.map((tool) => tool.name).sort());
      expect(tools.tools.find((tool) => tool.name === "activity_attachment_image")?.annotations?.readOnlyHint).toBe(true);

      const listed = await client.callTool({
        name: "activity_attachments_list",
        arguments: { activity_id: attachment.record.activity_id }
      });
      expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
      expect(JSON.stringify(listed.structuredContent)).toContain(attachment.record.ref);
      expect(JSON.stringify(listed.content)).not.toContain(attachment.bytes.toString("base64"));

      const image = await client.callTool({
        name: "activity_attachment_image",
        arguments: {
          activity_id: attachment.record.activity_id,
          ref: attachment.record.ref
        }
      });
      expect(image.isError).toBe(false);
      expect(image.structuredContent).toBeUndefined();
      const imageContent = image.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
      expect(imageContent).toHaveLength(1);
      expect(imageContent[0]).toMatchObject({
        type: "image",
        data: attachment.bytes.toString("base64"),
        mimeType: "image/png"
      });
      expect(imageContent[0]?.text).toBeUndefined();

      const bogus = await client.callTool({
        name: "activity_attachment_image",
        arguments: {
          activity_id: attachment.record.activity_id,
          ref: `att:sha256:${"0".repeat(64)}`
        }
      });
      expect(bogus.isError).toBe(true);
      expect(JSON.stringify(bogus.structuredContent)).toContain("calyx.mcp.activity-attachment-error/v0");
      expect(stderr.write).toHaveBeenCalled();
    } finally {
      await started.close();
    }
  });

  test("remote attachment access resolves one fleet-truth URL and credential snapshot", async () => {
    const attachment = makeAttachmentFixture();
    const readHostsTruth = vi.fn()
      .mockReturnValueOnce({
        hosts: {
          worm: { run_serve_url: "https://worm.internal:9443" },
        },
      })
      .mockReturnValue({
        hosts: {
          worm: { run_serve_url: "https://rebound.example:9443" },
        },
      });
    const tokenForHost = vi.fn(() => "worm-operator-token");
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      expect(url).toMatch(/^https:\/\/worm\.internal:9443\//);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer worm-operator-token");
      if (url.endsWith("/v1/admin/health")) {
        return new Response(JSON.stringify({
          schema_version: "calyx.admin-health/v1",
          protocol_epoch: CALYX_DAEMON_HEALTH_PROTOCOL_EPOCH,
          daemon_kind: "run-service",
          daemon_id: "run-serve",
          uptime_ms: 1_000,
          started_at: "2026-07-14T00:00:00.000Z",
          build: {
            git_head: "a".repeat(40),
            built_at: "2026-07-14T00:00:00.000Z",
            package_version: "0.2.0",
          },
          active_runs: 0,
          maintenance_mode: false,
          supports_features: ["activity.attachments/v1"],
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      if (url.includes("/v1/admin/activity/") && url.endsWith("/attachments")) {
        return new Response(JSON.stringify(attachment.result), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-calyx-request-id": "req_123e4567-e89b-42d3-a456-426614174000",
          },
        });
      }
      throw new Error(`Unexpected remote attachment URL: ${url}`);
    });
    const started = await startCalyxMcpActivityAttachmentsHttpServerV1({
      host: "127.0.0.1",
      port: 0,
      cliVersion: "test",
      commandPaths: manifestCommandPaths(),
      agentsInfraRoot: "/unused/agents-infra",
      hostnameImpl: () => "blade",
      readHostsTruth,
      tokenForHost,
      createAdminClient: createAdminClientFactory(fetchImpl),
      activityService: {
        async inspectActivityAttachments() {
          throw new Error("remote MCP access must not dispatch locally");
        },
        async inspectActivityAttachmentRecord() {
          throw new Error("remote MCP access must not dispatch locally");
        },
        async readActivityAttachmentBytes() {
          throw new Error("remote MCP access must not dispatch locally");
        },
      },
    });

    try {
      const client = new Client({ name: "calyx-mcp-authority-test", version: "1.0.0" });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(started.result.url));
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      const listed = await client.callTool({
        name: "activity_attachments_list",
        arguments: { activity_id: attachment.record.activity_id, host: "worm" },
      });

      expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
      expect(readHostsTruth).toHaveBeenCalledTimes(1);
      expect(tokenForHost).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await started.close();
    }
  });

  test("serve refuses browser-readable CORS, bad host headers, and missing bearer auth", async () => {
    const vaultPath = await createVault({
      "40-context/source.md": "# Source\nPOL-1521 MCP HTTP auth smoke.\n"
    });
    const tokenEnv = "CALYX_TEST_CONTEXT_MCP_TOKEN_REQUIRED";
    const previousToken = process.env[tokenEnv];
    process.env[tokenEnv] = "test-token";
    const started = await startCalyxMcpVaultContextHttpServerV1({
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: tokenEnv,
      vaultPath,
      cliVersion: "test",
      commandPaths: manifestCommandPaths(),
      agentContextProvider: () => ({ schema_version: "calyx.agent-context/v1", commands: [] }),
      stderr: { write: vi.fn() }
    });

    try {
      const preflight = await rawHttpRequest(started.result.url, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

      const unauthorized = await rawHttpRequest(started.result.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers["access-control-allow-origin"]).toBeUndefined();

      const badHost = await rawHttpRequest(started.result.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
          host: `attacker.example:${started.result.port}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(badHost.status).toBe(403);
    } finally {
      if (previousToken === undefined) {
        delete process.env[tokenEnv];
      } else {
        process.env[tokenEnv] = previousToken;
      }
      await started.close();
    }
  });

  test("serve refuses non-local binds without an auth token", async () => {
    const tokenEnv = "CALYX_TEST_CONTEXT_MCP_NONLOCAL_TOKEN";
    const previousToken = process.env[tokenEnv];
    delete process.env[tokenEnv];

    await expect(
      startCalyxMcpVaultContextHttpServerV1({
        host: "0.0.0.0",
        port: 0,
        authTokenEnv: tokenEnv,
        cliVersion: "test",
        commandPaths: manifestCommandPaths(),
        agentContextProvider: () => ({ schema_version: "calyx.agent-context/v1", commands: [] }),
      })
    ).rejects.toThrow(/requires CALYX_TEST_CONTEXT_MCP_NONLOCAL_TOKEN to be set/);

    if (previousToken !== undefined) {
      process.env[tokenEnv] = previousToken;
    }
  });
});
