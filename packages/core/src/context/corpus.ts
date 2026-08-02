import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CtxpackErrorCodeV1,
  CtxpackOutputEnvelopeV1,
  CtxpackPackRequestV1,
  CtxpackPrimitiveV1
} from "../types";
import { runCtxpackContractStubV1 } from "./contracts";
import { createCtxpackErrorEnvelopeV1 } from "./errors";
import { computeCtxpackHashV1, normalizeCtxpackValueV1, stableStringifyCtxpackV1 } from "./normalize";

export interface ContextFixtureWorkspaceSetupV1 {
  files: Record<string, string>;
  cwd?: boolean;
}

export interface ContextFixtureBundleSetupV1 {
  include?: string[];
  exclude?: string[];
  out_dir?: string;
  redaction_mode?: "strict" | "advisory";
}

export interface ContextFixtureSetupV1 {
  workspace?: ContextFixtureWorkspaceSetupV1;
  bundle?: ContextFixtureBundleSetupV1;
}

export interface ContextFixtureExpectationV1 {
  ok: boolean;
  error_code?: CtxpackErrorCodeV1;
  exit_code?: number;
}

export interface ContextFixtureCorpusCaseV1 {
  id: string;
  primitive: CtxpackPrimitiveV1;
  input?: Record<string, unknown>;
  expected: ContextFixtureExpectationV1;
  deterministic_replay?: boolean;
  setup?: ContextFixtureSetupV1;
}

export interface ContextFixtureCorpusCatalogV1 {
  version: "v1";
  fixtures: ContextFixtureCorpusCaseV1[];
}

export interface ContextFixtureCorpusRowV1 {
  fixture_id: string;
  primitive: CtxpackPrimitiveV1;
  expected_ok: boolean;
  actual_ok: boolean;
  error_code?: CtxpackErrorCodeV1;
  exit_code?: number;
  stable_digest: string;
  deterministic_replay_match: boolean;
  duration_ms: number;
  passed: boolean;
}

export interface ContextFixtureCorpusSummaryV1 {
  total_fixtures: number;
  passed: number;
  failed: number;
  deterministic_replay_failures: number;
}

export interface ContextFixtureCorpusReceiptV1 {
  version: "v1";
  generated_at: string;
  catalog_path?: string;
  ok: boolean;
  rows: ContextFixtureCorpusRowV1[];
  summary: ContextFixtureCorpusSummaryV1;
}

export interface RunContextFixtureCorpusOptions {
  failFast?: boolean;
  catalogPath?: string;
}

interface FixtureRuntimeContext {
  workspacePath?: string;
  bundlePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCatalog(raw: unknown): ContextFixtureCorpusCatalogV1 {
  if (!isRecord(raw)) {
    throw new Error("fixture catalog must be a JSON object");
  }

  if (raw["version"] !== "v1") {
    throw new Error("fixture catalog version must be 'v1'");
  }

  const fixturesRaw = raw["fixtures"];
  if (!Array.isArray(fixturesRaw) || fixturesRaw.length === 0) {
    throw new Error("fixture catalog must include a non-empty fixtures array");
  }

  const seenIds = new Set<string>();
  for (const fixture of fixturesRaw) {
    if (!isRecord(fixture)) {
      throw new Error("fixture entries must be objects");
    }
    const id = fixture["id"];
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("fixture id must be a non-empty string");
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate fixture id detected: ${id}`);
    }
    seenIds.add(id);

    if (typeof fixture["primitive"] !== "string") {
      throw new Error(`fixture ${id} missing primitive`);
    }

    const expected = fixture["expected"];
    if (!isRecord(expected) || typeof expected["ok"] !== "boolean") {
      throw new Error(`fixture ${id} missing expected.ok boolean`);
    }
  }

  return raw as unknown as ContextFixtureCorpusCatalogV1;
}

function substituteTemplateTokens(input: unknown, runtime: FixtureRuntimeContext): unknown {
  if (typeof input === "string") {
    let value = input;
    if (runtime.workspacePath) {
      value = value.replaceAll("${workspace}", runtime.workspacePath);
    }
    if (runtime.bundlePath) {
      value = value.replaceAll("${bundle_path}", runtime.bundlePath);
    }
    return value;
  }

  if (Array.isArray(input)) {
    return input.map((entry) => substituteTemplateTokens(entry, runtime));
  }

  if (!isRecord(input)) {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, substituteTemplateTokens(value, runtime)])
  );
}

async function materializeWorkspace(setup: ContextFixtureWorkspaceSetupV1): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "calyx-context-corpus-"));
  for (const [relativePath, contents] of Object.entries(setup.files)) {
    const absolutePath = path.join(workspace, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
  return workspace;
}

function prepareBundleRequest(setup: ContextFixtureBundleSetupV1): CtxpackPackRequestV1 {
  const include = setup.include && setup.include.length > 0 ? setup.include : ["src/**", "docs/**"];
  const outDir = setup.out_dir && setup.out_dir.trim().length > 0 ? setup.out_dir : ".ctxpack-corpus-out";

  return {
    version: "v1",
    primitive: "pack",
    include,
    ...(setup.exclude && setup.exclude.length > 0 ? { exclude: setup.exclude } : {}),
    out_dir: outDir,
    apply: true,
    redaction_mode: setup.redaction_mode ?? "strict"
  };
}

function assertExpectedOutcome(
  fixture: ContextFixtureCorpusCaseV1,
  output: CtxpackOutputEnvelopeV1,
  replayMatch: boolean
): { passed: boolean; errorCode?: CtxpackErrorCodeV1; exitCode?: number } {
  const expected = fixture.expected;
  const actualOk = output.ok;

  if (expected.ok !== actualOk) {
    if (!output.ok) {
      return {
        passed: false,
        errorCode: output.error.code,
        exitCode: output.error.exit_code
      };
    }
    return {
      passed: false
    };
  }

  if (!output.ok) {
    if (expected.error_code && output.error.code !== expected.error_code) {
      return {
        passed: false,
        errorCode: output.error.code,
        exitCode: output.error.exit_code
      };
    }

    if (expected.exit_code !== undefined && output.error.exit_code !== expected.exit_code) {
      return {
        passed: false,
        errorCode: output.error.code,
        exitCode: output.error.exit_code
      };
    }

    return {
      passed: replayMatch,
      errorCode: output.error.code,
      exitCode: output.error.exit_code
    };
  }

  return {
    passed: replayMatch
  };
}

async function executeFixtureCase(
  fixture: ContextFixtureCorpusCaseV1
): Promise<ContextFixtureCorpusRowV1> {
  const startedAt = Date.now();
  let workspacePath: string | undefined;
  const priorCwd = process.cwd();

  try {
    const runtime: FixtureRuntimeContext = {};
    const setup = fixture.setup;

    if (setup?.workspace) {
      workspacePath = await materializeWorkspace(setup.workspace);
      runtime.workspacePath = workspacePath;
      if (setup.workspace.cwd !== false) {
        process.chdir(workspacePath);
      }
    }

    if (setup?.bundle) {
      const bundleRequest = prepareBundleRequest(setup.bundle);
      const bundleResult = runCtxpackContractStubV1("pack", bundleRequest);
      if (!bundleResult.ok) {
        throw new Error(
          `bundle setup failed for ${fixture.id}: ${bundleResult.error.code} (${bundleResult.error.exit_code})`
        );
      }

      const bundleOut = bundleRequest.out_dir ?? ".ctxpack-corpus-out";
      runtime.bundlePath = path.resolve(process.cwd(), bundleOut);
    }

    const normalizedInput = normalizeCtxpackValueV1(fixture.input ?? {}) as Record<string, unknown>;
    const preparedInput = substituteTemplateTokens(normalizedInput, runtime) as Record<string, unknown>;

    const firstOutput = runCtxpackContractStubV1(fixture.primitive, preparedInput);
    const firstStable = stableStringifyCtxpackV1(firstOutput);
    const firstDigest = computeCtxpackHashV1(firstStable);

    let replayMatch = true;
    if (fixture.deterministic_replay !== false) {
      const replayOutput = runCtxpackContractStubV1(fixture.primitive, preparedInput);
      const replayStable = stableStringifyCtxpackV1(replayOutput);
      const replayDigest = computeCtxpackHashV1(replayStable);
      replayMatch = replayDigest === firstDigest;
    }

    const expected = assertExpectedOutcome(fixture, firstOutput, replayMatch);

    return {
      fixture_id: fixture.id,
      primitive: fixture.primitive,
      expected_ok: fixture.expected.ok,
      actual_ok: firstOutput.ok,
      ...(expected.errorCode ? { error_code: expected.errorCode } : {}),
      ...(expected.exitCode !== undefined ? { exit_code: expected.exitCode } : {}),
      stable_digest: firstDigest,
      deterministic_replay_match: replayMatch,
      duration_ms: Date.now() - startedAt,
      passed: expected.passed
    };
  } catch (error) {
    const envelope = createCtxpackErrorEnvelopeV1({
      primitive: fixture.primitive,
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    });
    const stable = stableStringifyCtxpackV1(envelope);

    return {
      fixture_id: fixture.id,
      primitive: fixture.primitive,
      expected_ok: fixture.expected.ok,
      actual_ok: false,
      error_code: envelope.error.code,
      exit_code: envelope.error.exit_code,
      stable_digest: computeCtxpackHashV1(stable),
      deterministic_replay_match: false,
      duration_ms: Date.now() - startedAt,
      passed: false
    };
  } finally {
    process.chdir(priorCwd);
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  }
}

function summarizeRows(rows: readonly ContextFixtureCorpusRowV1[]): ContextFixtureCorpusSummaryV1 {
  let passed = 0;
  let deterministicReplayFailures = 0;

  for (const row of rows) {
    if (row.passed) {
      passed += 1;
    }
    if (!row.deterministic_replay_match) {
      deterministicReplayFailures += 1;
    }
  }

  return {
    total_fixtures: rows.length,
    passed,
    failed: rows.length - passed,
    deterministic_replay_failures: deterministicReplayFailures
  };
}

export async function loadContextFixtureCorpusCatalogV1(catalogPath: string): Promise<ContextFixtureCorpusCatalogV1> {
  const absolutePath = path.resolve(catalogPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateCatalog(parsed);
}

export async function runContextFixtureCorpusV1(
  catalog: ContextFixtureCorpusCatalogV1,
  options: RunContextFixtureCorpusOptions = {}
): Promise<ContextFixtureCorpusReceiptV1> {
  const rows: ContextFixtureCorpusRowV1[] = [];

  for (const fixture of catalog.fixtures) {
    const row = await executeFixtureCase(fixture);
    rows.push(row);
    if (options.failFast && !row.passed) {
      break;
    }
  }

  const summary = summarizeRows(rows);
  return {
    version: "v1",
    generated_at: new Date().toISOString(),
    ...(options.catalogPath ? { catalog_path: options.catalogPath } : {}),
    ok: summary.failed === 0,
    rows,
    summary
  };
}

export async function runContextFixtureCorpusFromFileV1(
  catalogPath: string,
  options: Omit<RunContextFixtureCorpusOptions, "catalogPath"> = {}
): Promise<ContextFixtureCorpusReceiptV1> {
  const absolutePath = path.resolve(catalogPath);
  const catalog = await loadContextFixtureCorpusCatalogV1(absolutePath);
  return runContextFixtureCorpusV1(catalog, {
    ...options,
    catalogPath: absolutePath
  });
}
