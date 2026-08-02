import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

interface KnowledgeSearchPayload {
  query: string;
  total: number;
  items: Array<{ id: string }>;
}

function knowledgeRegistryFixture(): string {
  return path.resolve(process.cwd(), "fixtures/domains/knowledge/registry.valid.json");
}

async function runKnowledgeSearch(args: string[]): Promise<KnowledgeSearchPayload> {
  const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const program = buildProgram();

  await program.parseAsync([
    "node",
    "calyx",
    "knowledge",
    "search",
    "--registry",
    knowledgeRegistryFixture(),
    "--json",
    ...args
  ]);

  errSpy.mockRestore();
  const rawPayload = outSpy.mock.calls.at(-1)?.[0];
  outSpy.mockRestore();

  if (typeof rawPayload !== "string") {
    throw new Error("Expected JSON payload from calyx knowledge search --json.");
  }
  return JSON.parse(rawPayload) as KnowledgeSearchPayload;
}

describe("knowledge search discoverability", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("supports frontmatter-aware field queries", async () => {
    const payload = await runKnowledgeSearch([
      "--query",
      "doc_type:runbook scope:operations"
    ]);

    expect(payload.total).toBe(1);
    expect(payload.items.map((item) => item.id)).toEqual(["runbook-async-runner"]);
  });

  test("supports metadata-aware namespaced selectors", async () => {
    const payload = await runKnowledgeSearch([
      "--query",
      "meta.docstore_id:ep-2026-0225 metadata.host:blade"
    ]);

    expect(payload.total).toBe(1);
    expect(payload.items.map((item) => item.id)).toEqual(["execplan-unified-agents"]);
  });

  test("applies case-insensitive tag filters after query matching", async () => {
    const payload = await runKnowledgeSearch([
      "--query",
      "owner:polli-labs",
      "--tags",
      "ASYNC,operations"
    ]);

    expect(payload.total).toBe(1);
    expect(payload.items.map((item) => item.id)).toEqual(["runbook-async-runner"]);
  });
});
