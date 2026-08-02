import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { indexKnowledgeRegistry, searchKnowledgeRegistry } from "@polli-labs/calyx-core";
import type {
  KnowledgeArtifactEntry,
  KnowledgeArtifactKind,
  KnowledgeIndexResult,
  KnowledgeSearchResult
} from "@polli-labs/calyx-core";

const KNOWLEDGE_KINDS: ReadonlySet<KnowledgeArtifactKind> = new Set([
  "execplan",
  "transcript",
  "report",
  "runbook",
  "reference"
]);

export interface KnowledgeSurfaceSearchOptions {
  query?: string;
  kind?: KnowledgeArtifactKind;
  tags?: string[];
}

export interface KnowledgeSurfacePayload {
  registryPath: string;
  query: string;
  kind?: KnowledgeArtifactKind;
  tags?: string[];
  result: KnowledgeSearchResult;
}

export interface KnowledgeSurfacePageModel {
  registryPath: string;
  kind?: KnowledgeArtifactKind;
  tags?: string[];
  query: string;
  indexed: KnowledgeIndexResult;
  search: KnowledgeSearchResult;
}

export interface KnowledgeSurfaceServerOptions {
  registryPath: string;
  host?: string;
  port?: number;
  basePath?: string;
}

export interface KnowledgeSurfaceServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function parseKind(rawValue: string | null): KnowledgeArtifactKind | undefined {
  if (!rawValue) {
    return undefined;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!KNOWLEDGE_KINDS.has(normalized as KnowledgeArtifactKind)) {
    throw new Error(
      `Invalid kind "${rawValue}". Expected one of: ${Array.from(KNOWLEDGE_KINDS).join(", ")}.`
    );
  }
  return normalized as KnowledgeArtifactKind;
}

function parseTags(rawValue: string | null): string[] | undefined {
  if (!rawValue) {
    return undefined;
  }
  const tags = rawValue
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function formatArtifactTags(artifact: KnowledgeArtifactEntry): string {
  if (!artifact.tags || artifact.tags.length === 0) {
    return "none";
  }
  return artifact.tags.join(", ");
}

export async function browseKnowledgeArtifacts(
  registryPath: string,
  options: Pick<KnowledgeSurfaceSearchOptions, "kind"> = {}
): Promise<KnowledgeIndexResult> {
  return indexKnowledgeRegistry(registryPath, {
    ...(options.kind ? { kind: options.kind } : {})
  });
}

export async function searchKnowledgeArtifacts(
  registryPath: string,
  options: KnowledgeSurfaceSearchOptions = {}
): Promise<KnowledgeSurfacePayload> {
  const query = options.query?.trim() ?? "";
  const result = await searchKnowledgeRegistry(registryPath, {
    query,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.tags && options.tags.length > 0 ? { tags: options.tags } : {})
  });

  return {
    registryPath,
    query,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    result
  };
}

export function renderKnowledgeSurfaceHtml(model: KnowledgeSurfacePageModel): string {
  const queryValue = escapeHtml(model.query);
  const kindValue = model.kind ?? "";
  const tagsValue = model.tags?.join(",") ?? "";
  const browseRows = model.indexed.items
    .map((artifact) => {
      return [
        "<tr>",
        `<td>${escapeHtml(artifact.id)}</td>`,
        `<td>${escapeHtml(artifact.kind)}</td>`,
        `<td>${escapeHtml(artifact.title)}</td>`,
        `<td>${escapeHtml(formatArtifactTags(artifact))}</td>`,
        "</tr>"
      ].join("");
    })
    .join("\n");
  const searchRows = model.search.items
    .map((artifact) => {
      return [
        "<tr>",
        `<td>${escapeHtml(artifact.id)}</td>`,
        `<td>${escapeHtml(artifact.kind)}</td>`,
        `<td>${escapeHtml(artifact.title)}</td>`,
        `<td>${escapeHtml(artifact.source_path ?? "n/a")}</td>`,
        `<td>${escapeHtml(formatArtifactTags(artifact))}</td>`,
        "</tr>"
      ].join("");
    })
    .join("\n");

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>Calyx Knowledge Surface</title>",
    "  <style>",
    "    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #0f172a; }",
    "    h1, h2 { margin: 0 0 12px; }",
    "    .meta { margin: 0 0 20px; color: #475569; }",
    "    form { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 16px; }",
    "    label { display: grid; gap: 4px; font-size: 14px; }",
    "    input, select { font-size: 14px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; }",
    "    button { border: 0; border-radius: 8px; padding: 10px 12px; background: #0f766e; color: white; cursor: pointer; }",
    "    table { width: 100%; border-collapse: collapse; margin: 10px 0 22px; }",
    "    th, td { border-bottom: 1px solid #e2e8f0; text-align: left; padding: 8px; font-size: 14px; vertical-align: top; }",
    "    th { color: #334155; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <h1>Calyx Knowledge Surface</h1>",
    `  <p class="meta">Registry: <code>${escapeHtml(model.registryPath)}</code></p>`,
    "  <form method=\"get\" action=\"\">",
    `    <label>Query<input name="q" placeholder="doc_type:runbook meta.docstore_id:ep-..." value="${queryValue}"></label>`,
    "    <label>Kind<select name=\"kind\">",
    `      <option value=""${kindValue === "" ? " selected" : ""}>all</option>`,
    ...Array.from(KNOWLEDGE_KINDS).map(
      (kind) => `      <option value="${kind}"${kind === kindValue ? " selected" : ""}>${kind}</option>`
    ),
    "    </select></label>",
    `    <label>Tags (CSV)<input name="tags" placeholder="operations,async" value="${escapeHtml(tagsValue)}"></label>`,
    "    <label>&nbsp;<button type=\"submit\">Search</button></label>",
    "  </form>",
    `  <h2>Browse (${model.indexed.items.length}/${model.indexed.total})</h2>`,
    "  <table>",
    "    <thead><tr><th>ID</th><th>Kind</th><th>Title</th><th>Tags</th></tr></thead>",
    `    <tbody>${browseRows}</tbody>`,
    "  </table>",
    `  <h2>Search Results (${model.search.total})</h2>`,
    "  <table>",
    "    <thead><tr><th>ID</th><th>Kind</th><th>Title</th><th>Source</th><th>Tags</th></tr></thead>",
    `    <tbody>${searchRows}</tbody>`,
    "  </table>",
    "</body>",
    "</html>"
  ].join("\n");
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function writeHtml(response: ServerResponse, statusCode: number, payload: string): void {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  response.end(payload);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<KnowledgeSurfaceServerOptions, "registryPath" | "basePath">>
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET") {
    writeJson(response, 405, { error: `Method ${method} not allowed.` });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (requestUrl.pathname === "/healthz") {
    writeJson(response, 200, { ok: true, surface: "knowledge" });
    return;
  }

  const basePath = options.basePath;
  const jsonPath = `${basePath}.json`;
  if (requestUrl.pathname !== basePath && requestUrl.pathname !== jsonPath) {
    writeJson(response, 404, { error: "Not found." });
    return;
  }

  const kind = parseKind(requestUrl.searchParams.get("kind"));
  const tags = parseTags(requestUrl.searchParams.get("tags"));
  const query = requestUrl.searchParams.get("q") ?? "";

  const [indexed, searchPayload] = await Promise.all([
    browseKnowledgeArtifacts(options.registryPath, {
      ...(kind ? { kind } : {})
    }),
    searchKnowledgeArtifacts(options.registryPath, {
      query,
      ...(kind ? { kind } : {}),
      ...(tags ? { tags } : {})
    })
  ]);

  if (requestUrl.pathname === jsonPath) {
    writeJson(response, 200, {
      registryPath: searchPayload.registryPath,
      query: searchPayload.query,
      ...(searchPayload.kind ? { kind: searchPayload.kind } : {}),
      ...(searchPayload.tags ? { tags: searchPayload.tags } : {}),
      total: searchPayload.result.total,
      items: searchPayload.result.items
    });
    return;
  }

  writeHtml(
    response,
    200,
    renderKnowledgeSurfaceHtml({
      registryPath: options.registryPath,
      query: searchPayload.query,
      ...(kind ? { kind } : {}),
      ...(tags ? { tags } : {}),
      indexed,
      search: searchPayload.result
    })
  );
}

export async function startKnowledgeSurfaceServer(
  options: KnowledgeSurfaceServerOptions
): Promise<KnowledgeSurfaceServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const basePath = options.basePath ?? "/knowledge";
  const server = createServer((request, response) => {
    handleRequest(request, response, {
      registryPath: options.registryPath,
      basePath
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 400, { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve knowledge surface server address.");
  }

  return {
    server,
    url: `http://${host}:${address.port}${basePath}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
