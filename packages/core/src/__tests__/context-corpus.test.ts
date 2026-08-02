import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadContextFixtureCorpusCatalogV1,
  runContextFixtureCorpusFromFileV1
} from "../index";

function catalogPath(): string {
  return path.resolve(process.cwd(), "fixtures/context/v1/corpus.catalog.json");
}

describe("context fixture corpus", () => {
  test("loads the POL-770 catalog with stable fixture ids", async () => {
    const catalog = await loadContextFixtureCorpusCatalogV1(catalogPath());
    expect(catalog.version).toBe("v1");
    expect(catalog.fixtures).toHaveLength(24);

    const ids = new Set(catalog.fixtures.map((fixture) => fixture.id));
    expect(ids.size).toBe(24);
    expect(ids.has("CTX-CAP-001")).toBe(true);
    expect(ids.has("CTX-PLAN-006")).toBe(true);
    expect(ids.has("CTX-PACK-006")).toBe(true);
    expect(ids.has("CTX-DOCS-004")).toBe(true);
    expect(ids.has("CTX-INTRO-004")).toBe(true);
  });

  test("executes the full fixture corpus with deterministic replay receipts", async () => {
    const receipt = await runContextFixtureCorpusFromFileV1(catalogPath());
    expect(receipt.version).toBe("v1");
    expect(receipt.ok).toBe(true);
    expect(receipt.rows).toHaveLength(24);
    expect(receipt.summary.total_fixtures).toBe(24);
    expect(receipt.summary.failed).toBe(0);
    expect(receipt.summary.deterministic_replay_failures).toBe(0);

    const failingRows = receipt.rows.filter((row) => !row.passed);
    expect(failingRows).toHaveLength(0);
  });
});
