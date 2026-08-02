import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { searchKnowledgeRegistry } from "@polli-labs/calyx-core";
import {
  browseKnowledgeArtifacts,
  searchKnowledgeArtifacts,
  startKnowledgeSurfaceServer,
  type KnowledgeSurfaceServerHandle
} from "../knowledge-surface";

function knowledgeRegistryFixture(): string {
  return path.resolve(process.cwd(), "fixtures/domains/knowledge/registry.valid.json");
}

const activeServers: KnowledgeSurfaceServerHandle[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const handle = activeServers.pop();
    if (handle) {
      await handle.close();
    }
  }
});

describe("knowledge operator web surface", () => {
  test("browse endpoint sources the full fixture corpus", async () => {
    const result = await browseKnowledgeArtifacts(knowledgeRegistryFixture());

    expect(result.total).toBe(3);
    expect(result.items.map((artifact: { id: string }) => artifact.id)).toEqual([
      "execplan-unified-agents",
      "runbook-async-runner",
      "transcript-sprint-planning"
    ]);
  });

  test("web search returns identical hit sets to core search", async () => {
    const queries: Array<{ query: string; tags?: string[] }> = [
      { query: "doc_type:runbook scope:operations" },
      { query: "meta.docstore_id:ep-2026-0225 metadata.host:blade" },
      { query: "owner:polli-labs", tags: ["ASYNC", "operations"] }
    ];

    for (const entry of queries) {
      const coreResult = await searchKnowledgeRegistry(knowledgeRegistryFixture(), {
        query: entry.query,
        ...(entry.tags ? { tags: [...entry.tags] } : {})
      });
      const webResult = await searchKnowledgeArtifacts(knowledgeRegistryFixture(), {
        query: entry.query,
        ...(entry.tags ? { tags: [...entry.tags] } : {})
      });

      expect(webResult.result.items.map((artifact) => artifact.id)).toEqual(
        coreResult.items.map((artifact: { id: string }) => artifact.id)
      );
    }
  });

  test("serves JSON and HTML search surfaces", async () => {
    const server = await startKnowledgeSurfaceServer({
      registryPath: knowledgeRegistryFixture()
    });
    activeServers.push(server);

    const jsonResponse = await fetch(`${server.url}.json?q=${encodeURIComponent("doc_type:runbook")}`);
    expect(jsonResponse.status).toBe(200);
    const jsonPayload = await jsonResponse.json() as { total: number; items: Array<{ id: string }> };
    expect(jsonPayload.total).toBe(1);
    expect(jsonPayload.items.map((item) => item.id)).toEqual(["runbook-async-runner"]);

    const htmlResponse = await fetch(`${server.url}?q=${encodeURIComponent("meta.host:blade")}`);
    expect(htmlResponse.status).toBe(200);
    const htmlPayload = await htmlResponse.text();
    expect(htmlPayload).toContain("Calyx Knowledge Surface");
    expect(htmlPayload).toContain("execplan-unified-agents");
  });
});
