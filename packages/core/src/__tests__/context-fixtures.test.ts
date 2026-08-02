import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CtxpackOutputEnvelopeV1 } from "../types";
import {
  executeContextFixtureCaseV1,
  loadContextFixtureCaseV1,
  parseCtxpackOutputEnvelopeV1,
  runCtxpackContractStubV1,
  runCtxpackFixtureCasesV1,
  runCtxpackFixtureStubV1
} from "../index";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/context/v1");
}

async function readGolden(name: string): Promise<CtxpackOutputEnvelopeV1> {
  const raw = await readFile(path.join(fixtureRoot(), "goldens", name), "utf8");
  return parseCtxpackOutputEnvelopeV1(JSON.parse(raw));
}

describe("ctxpack fixture harness", () => {
  test("executes context fixture cases and produces stable hashes", async () => {
    const fixture = await loadContextFixtureCaseV1(path.join(fixtureRoot(), "inputs", "harness.input.json"));

    const first = executeContextFixtureCaseV1(fixture);
    const second = executeContextFixtureCaseV1(fixture);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.stable_hash).toBe(second.stable_hash);
    expect(first.stable_json).toBe(second.stable_json);
    expect(first.output.primitive).toBe("plan");
  });

  test("matches golden envelopes through fixture runner", async () => {
    const validationError = await readGolden("error.validation_error.json");
    const workspace = await mkdtemp(path.join(tmpdir(), "calyx-context-fixture-pack-"));
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export const fixture = true;\n", "utf8");

    const prior = process.cwd();
    process.chdir(workspace);

    try {
      const expectedPack = runCtxpackContractStubV1("pack", {
        version: "v1",
        primitive: "pack",
        include: ["src/**"]
      });

      const executions = await runCtxpackFixtureCasesV1(
        [
          {
            id: "golden-pack-success",
            request: {
              version: "v1",
              primitive: "pack",
              include: ["src/**"]
            },
            expected: expectedPack
          }
        ],
        runCtxpackFixtureStubV1
      );

      expect(executions).toHaveLength(1);
      expect(executions[0]?.output).toEqual(expectedPack);
    } finally {
      process.chdir(prior);
      await rm(workspace, { recursive: true, force: true });
    }

    const validationOutput = runCtxpackContractStubV1("pack", {
      version: "v1",
      primitive: "pack",
      plan_hash: ""
    });
    expect(validationOutput).toEqual(validationError);
  });
});
