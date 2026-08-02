import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ContextFixtureCaseV1,
  ContextFixtureExecutionResultV1,
  CtxpackFixtureCaseV1,
  CtxpackFixtureExecutionV1,
  CtxpackFixtureRunnerV1,
  CtxpackOutputEnvelopeV1,
  CtxpackRequestV1
} from "../types";
import {
  parseCtxpackOutputEnvelopeV1,
  parseCtxpackRequestV1,
  runCtxpackContractStubV1
} from "./contracts";
import { createCtxpackErrorEnvelopeV1 } from "./errors";
import {
  computeCtxpackHashV1,
  normalizeCtxpackRequestV1,
  normalizeCtxpackValueV1,
  stableStringifyCtxpackV1
} from "./normalize";

export interface CtxpackFixtureHarnessV1 {
  runFixture: (fixture: CtxpackFixtureCaseV1) => Promise<CtxpackFixtureExecutionV1>;
  runAll: (fixtures: readonly CtxpackFixtureCaseV1[]) => Promise<CtxpackFixtureExecutionV1[]>;
}

async function resolveFixtureOutput(
  runner: CtxpackFixtureRunnerV1,
  request: CtxpackRequestV1
): Promise<CtxpackOutputEnvelopeV1> {
  const maybeOutput = await runner(request);
  return parseCtxpackOutputEnvelopeV1(maybeOutput);
}

export function assertCtxpackFixtureMatchV1(
  fixture: CtxpackFixtureCaseV1,
  execution: CtxpackFixtureExecutionV1
): void {
  const expectedJson = stableStringifyCtxpackV1(fixture.expected);
  if (execution.normalized_json !== expectedJson) {
    throw new Error(
      `Fixture mismatch for ${fixture.id}: expected ${expectedJson}, received ${execution.normalized_json}`
    );
  }
}

export function createCtxpackFixtureHarnessV1(runner: CtxpackFixtureRunnerV1): CtxpackFixtureHarnessV1 {
  return {
    async runFixture(fixture: CtxpackFixtureCaseV1): Promise<CtxpackFixtureExecutionV1> {
      const normalizedRequest = normalizeCtxpackRequestV1(fixture.request);
      const request = parseCtxpackRequestV1(normalizedRequest);
      const output = await resolveFixtureOutput(runner, request);
      const normalizedJson = stableStringifyCtxpackV1(output);

      return {
        id: fixture.id,
        request,
        output,
        normalized_json: normalizedJson,
        digest: computeCtxpackHashV1(normalizedJson)
      };
    },

    async runAll(fixtures: readonly CtxpackFixtureCaseV1[]): Promise<CtxpackFixtureExecutionV1[]> {
      const results: CtxpackFixtureExecutionV1[] = [];
      for (const fixture of fixtures) {
        const execution = await this.runFixture(fixture);
        assertCtxpackFixtureMatchV1(fixture, execution);
        results.push(execution);
      }
      return results;
    }
  };
}

export async function runCtxpackFixtureCasesV1(
  fixtures: readonly CtxpackFixtureCaseV1[],
  runner: CtxpackFixtureRunnerV1
): Promise<CtxpackFixtureExecutionV1[]> {
  return createCtxpackFixtureHarnessV1(runner).runAll(fixtures);
}

export async function runCtxpackFixtureStubV1(request: CtxpackRequestV1): Promise<CtxpackOutputEnvelopeV1> {
  return runCtxpackContractStubV1(request.primitive, request);
}

export async function loadContextFixtureCaseV1(pathToFixture: string): Promise<ContextFixtureCaseV1> {
  const fixturePath = resolve(pathToFixture);
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw) as ContextFixtureCaseV1;
}

export function executeContextFixtureCaseV1(
  fixture: ContextFixtureCaseV1
): ContextFixtureExecutionResultV1 {
  const primitive = fixture.primitive;
  const normalizedInput = normalizeCtxpackValueV1(fixture.input ?? {}) as Record<string, unknown>;

  try {
    const output = runCtxpackContractStubV1(primitive, normalizedInput);
    const stableJson = stableStringifyCtxpackV1(output);
    return {
      id: fixture.id,
      primitive,
      ok: output.ok,
      output,
      stable_json: stableJson,
      stable_hash: computeCtxpackHashV1(stableJson)
    };
  } catch (error) {
    const output = createCtxpackErrorEnvelopeV1({
      code: "internal_error",
      primitive,
      message: error instanceof Error ? error.message : String(error)
    });
    const stableJson = stableStringifyCtxpackV1(output);
    return {
      id: fixture.id,
      primitive,
      ok: false,
      output,
      stable_json: stableJson,
      stable_hash: computeCtxpackHashV1(stableJson)
    };
  }
}
