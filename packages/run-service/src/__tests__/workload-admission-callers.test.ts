import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";

import {
  RunStore,
  RunService,
  RunNotFoundError,
  WorkloadAdmissionFencedError,
  type RunIntent,
  type RunRecord,
} from "../index.js";
import { RunCreationAdmissionRequiredError } from "../store.js";
import { passingTestWorkloadAdmissionReconciler } from "./support/test-run-service.js";

const roots = new Set<string>();
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

async function productionSourcePaths(directory = sourceRoot): Promise<string[]> {
  const sources: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await productionSourcePaths(entryPath));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      sources.push(entryPath);
    }
  }
  return sources.sort();
}

async function productionProgram(
  sourceOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<ts.Program> {
  const configPath = ts.findConfigFile(sourceRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("run-service tsconfig.json not found.");
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath));
  const overrides = new Map(
    [...sourceOverrides].map(([path, text]) => [resolve(path), text] as const),
  );
  const host = ts.createCompilerHost(parsed.options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => overrides.has(resolve(path)) || originalFileExists(path);
  host.readFile = (path) => overrides.get(resolve(path)) ?? originalReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const replacement = overrides.get(resolve(path));
    return replacement === undefined
      ? originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(path, replacement, languageVersion, true, ts.ScriptKind.TS);
  };
  return ts.createProgram({
    rootNames: await productionSourcePaths(),
    options: { ...parsed.options, noEmit: true },
    host,
  });
}

function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current.flags & ts.SymbolFlags.Alias) {
    if (seen.has(current)) break;
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function sameDeclarationSymbol(left: ts.Symbol, right: ts.Symbol): boolean {
  if (left === right) return true;
  const rightDeclarations = new Set((right.declarations ?? []).map((declaration) => (
    `${resolve(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`
  )));
  return (left.declarations ?? []).some((declaration) => rightDeclarations.has(
    `${resolve(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`,
  ));
}

function bindingElementPropertySymbol(
  checker: ts.TypeChecker,
  declaration: ts.BindingElement,
): ts.Symbol | undefined {
  if (!ts.isObjectBindingPattern(declaration.parent)) return undefined;
  const source = declaration.parent.parent;
  const sourceType = ts.isVariableDeclaration(source) && source.initializer
    ? checker.getTypeAtLocation(source.initializer)
    : ts.isBindingElement(source)
      ? checker.getTypeAtLocation(source.name)
      : undefined;
  if (!sourceType) return undefined;

  const propertyName = declaration.propertyName ?? declaration.name;
  if (
    !ts.isIdentifier(propertyName)
    && !ts.isStringLiteralLike(propertyName)
    && !ts.isNumericLiteral(propertyName)
  ) {
    return undefined;
  }
  return sourceType.getProperty(propertyName.text);
}

function callableSymbol(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>(),
): ts.Symbol | undefined {
  if (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    return callableSymbol(checker, expression.expression, seen);
  }
  if (ts.isCallExpression(expression)) {
    if (
      ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "bind"
    ) {
      return callableSymbol(checker, expression.expression.expression, seen);
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === "bind") {
      return callableSymbol(checker, expression.expression, seen);
    }
    const symbol = checker
      .getTypeAtLocation(expression.expression)
      .getProperty(expression.name.text)
      ?? checker.getSymbolAtLocation(expression.name);
    return symbol ? canonicalSymbol(checker, symbol) : undefined;
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    const symbol = checker
      .getTypeAtLocation(expression.expression)
      .getProperty(expression.argumentExpression.text);
    return symbol ? canonicalSymbol(checker, symbol) : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const raw = checker.getSymbolAtLocation(expression);
  if (!raw) return undefined;
  const symbol = canonicalSymbol(checker, raw);
  if (seen.has(symbol)) return symbol;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isBindingElement(declaration)) {
      const target = bindingElementPropertySymbol(checker, declaration);
      if (target) return canonicalSymbol(checker, target);
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const target = callableSymbol(checker, declaration.initializer, seen);
      if (target) return target;
    }
  }
  return symbol;
}

function isBindCall(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "bind";
}

function namedFunctionSymbol(
  program: ts.Program,
  fileName: string,
  name: string,
): ts.Symbol {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(sourceRoot, fileName));
  if (!source) throw new Error(`${fileName} source not found.`);
  let found: ts.Symbol | undefined;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) found = canonicalSymbol(checker, symbol);
    }
  });
  if (!found) throw new Error(`${fileName}#${name} declaration not found.`);
  return found;
}

function classMethodSymbol(
  program: ts.Program,
  fileName: string,
  className: string,
  methodName: string,
): ts.Symbol {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(sourceRoot, fileName));
  if (!source) throw new Error(`${fileName} source not found.`);
  let found: ts.Symbol | undefined;
  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName) {
        const symbol = checker.getSymbolAtLocation(member.name);
        if (symbol) found = canonicalSymbol(checker, symbol);
      }
    }
  });
  if (!found) throw new Error(`${fileName}#${className}.${methodName} declaration not found.`);
  return found;
}

function productionCallSites(program: ts.Program, target: ts.Symbol): string[] {
  const checker = program.getTypeChecker();
  const sites = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (!resolve(source.fileName).startsWith(`${resolve(sourceRoot)}/`) || source.fileName.includes("/__tests__/")) {
      continue;
    }
    const relativePath = source.fileName.slice(resolve(sourceRoot).length + 1);
    const visit = (node: ts.Node, owner = "<module>"): void => {
      let nextOwner = owner;
      if (
        (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
        && node.name
        && ts.isIdentifier(node.name)
      ) {
        const parent = node.parent;
        nextOwner = ts.isClassDeclaration(parent) && parent.name
          ? `${parent.name.text}.${node.name.text}`
          : node.name.text;
      }
      if (ts.isCallExpression(node) && !isBindCall(node)) {
        const called = callableSymbol(checker, node.expression);
        if (called && sameDeclarationSymbol(called, target)) {
          sites.add(`${relativePath}#${nextOwner}`);
        }
      }
      ts.forEachChild(node, (child) => visit(child, nextOwner));
    };
    visit(source);
  }
  return [...sites].sort();
}

function publicRunCreationEntries(program: ts.Program): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(sourceRoot, "service.ts"));
  if (!source) throw new Error("service.ts source not found.");
  let runService: ts.ClassDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "RunService") runService = node;
  });
  if (!runService) throw new Error("RunService class declaration not found.");
  const methods = new Map<string, { declaration: ts.MethodDeclaration; symbol: ts.Symbol }>();
  const methodNames = new Map<ts.Symbol, string>();
  for (const member of runService.members) {
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
    const raw = checker.getSymbolAtLocation(member.name);
    if (!raw) continue;
    const symbol = canonicalSymbol(checker, raw);
    methods.set(member.name.text, { declaration: member, symbol });
    methodNames.set(symbol, member.name.text);
  }
  const createRun = classMethodSymbol(program, "store.ts", "RunStore", "createRun");
  const calls = new Map<string, Set<string>>();
  const directStoreCreators = new Set<string>();
  for (const [methodName, method] of methods) {
    const callees = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !isBindCall(node)) {
        const called = callableSymbol(checker, node.expression);
        if (called && sameDeclarationSymbol(called, createRun)) {
          directStoreCreators.add(methodName);
        }
        const callee = called
          ? [...methodNames].find(([symbol]) => sameDeclarationSymbol(called, symbol))?.[1]
          : undefined;
        if (callee) callees.add(callee);
      }
      ts.forEachChild(node, visit);
    };
    if (method.declaration.body) visit(method.declaration.body);
    calls.set(methodName, callees);
  }
  expect([...directStoreCreators]).toEqual(["initializeAdmittedRun"]);
  const reachesRunCreation = (methodName: string, seen = new Set<string>()): boolean => {
    if (directStoreCreators.has(methodName)) return true;
    if (seen.has(methodName)) return false;
    seen.add(methodName);
    return [...(calls.get(methodName) ?? [])].some((callee) => (
      reachesRunCreation(callee, new Set(seen))
    ));
  };
  return [...methods]
    .filter(([methodName, { declaration }]) => {
      const hidden = declaration.modifiers?.some((modifier) => (
        modifier.kind === ts.SyntaxKind.PrivateKeyword
        || modifier.kind === ts.SyntaxKind.ProtectedKeyword
      ));
      return !hidden && reachesRunCreation(methodName);
    })
    .map(([methodName]) => methodName)
    .sort();
}

async function runsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-admission-callers-"));
  roots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("workload-admission structural boundary", () => {
  test("discovers every public creation-reachable path and fences direct launch entries", async () => {
    const root = await runsRoot();
    const service = new RunService({
      runsRoot: root,
      subscribers: [],
      workloadAdmission: {
        reconcile: async () => {
          throw new Error("current authority is unavailable");
        },
      },
    });
    const behavioralEntries = {
      launch: {
        expected: "fenced",
        invoke: (intent: RunIntent) => service.launch(intent),
      },
      reconcile: {
        expected: "no_creation",
        invoke: (_intent: RunIntent) => service.reconcile(),
      },
      runInline: {
        expected: "fenced",
        invoke: (intent: RunIntent) => service.runInline(intent),
      },
      stop: {
        expected: "not_found",
        invoke: (intent: RunIntent) => service.stop(intent.run_id),
      },
      submitDetached: {
        expected: "fenced",
        invoke: (intent: RunIntent) => service.submitDetached(intent),
      },
    } as const;
    const program = await productionProgram();
    expect(publicRunCreationEntries(program)).toEqual(
      Object.keys(behavioralEntries).sort(),
    );

    for (const [entry, behavior] of Object.entries(behavioralEntries)) {
      const intent = service.createIntent({
        run_id: `run-refused-${entry.toLowerCase()}`,
        host: "local",
        prompt: `Refuse ${entry}`,
        require_execplan: false,
      });
      if (behavior.expected === "fenced") {
        await expect(behavior.invoke(intent)).rejects.toBeInstanceOf(WorkloadAdmissionFencedError);
      } else if (behavior.expected === "not_found") {
        await expect(behavior.invoke(intent)).rejects.toBeInstanceOf(RunNotFoundError);
      } else {
        await behavior.invoke(intent);
      }
      await expect(service.getRunRecord(intent.run_id)).resolves.toBeUndefined();
    }
  });

  test("discovers every production capability mint and new-record sink package-wide", async () => {
    const program = await productionProgram();
    const issueAdmission = namedFunctionSymbol(
      program,
      "store.ts",
      "issueRunCreationAdmission",
    );
    const createRun = classMethodSymbol(program, "store.ts", "RunStore", "createRun");
    const publishRecord = namedFunctionSymbol(program, "store.ts", "publishRunRecordNoReplace");

    expect(productionCallSites(program, issueAdmission)).toEqual([
      "service.ts#RunService.initializeRun",
    ]);
    expect(productionCallSites(program, createRun)).toEqual([
      "service.ts#RunService.initializeAdmittedRun",
    ]);
    expect(productionCallSites(program, publishRecord)).toEqual([
      "store.ts#RunStore.createRun",
    ]);
  });

  test("symbol inventory survives local aliases and destructured bound createRun calls", async () => {
    const servicePath = join(sourceRoot, "service.ts");
    const source = await readFile(servicePath, "utf8");
    const aliased = source
      .replace(
        "record = await this.store.createRun(admission, intent, {",
        "const { createRun: unboundCreate } = this.store;\n      const persist = unboundCreate.bind(this.store);\n      record = await persist(admission, intent, {",
      )
      .replace(
        "return issueRunCreationAdmission();",
        "const issueAdmission = issueRunCreationAdmission;\n      return issueAdmission();",
      );
    expect(aliased).not.toBe(source);
    const program = await productionProgram(new Map([[servicePath, aliased]]));
    const issueAdmission = namedFunctionSymbol(
      program,
      "store.ts",
      "issueRunCreationAdmission",
    );
    const createRun = classMethodSymbol(program, "store.ts", "RunStore", "createRun");

    expect(productionCallSites(program, issueAdmission)).toEqual([
      "service.ts#RunService.initializeRun",
    ]);
    expect(productionCallSites(program, createRun)).toEqual([
      "service.ts#RunService.initializeAdmittedRun",
    ]);
    expect(publicRunCreationEntries(program)).toEqual([
      "launch",
      "reconcile",
      "runInline",
      "stop",
      "submitDetached",
    ]);
  });

  test("the package exports no run-creation capability", async () => {
    const root = await runsRoot();
    const store = new RunStore(root);
    const intent: RunIntent = {
      run_id: "run-public-store-bypass",
      host: "local",
      created_at: "2026-08-02T12:00:00.000Z",
    };

    const typecheckStoreBoundary = async (): Promise<void> => {
      // @ts-expect-error Public callers cannot satisfy the internal admission parameter.
      await store.createRun(intent);
    };
    void typecheckStoreBoundary;
    const bypass = store.createRun as unknown as (
      intent: RunIntent,
    ) => Promise<RunRecord>;
    await expect(bypass.call(store, intent)).rejects.toBeInstanceOf(
      RunCreationAdmissionRequiredError,
    );
    await expect(store.readRunRecord(intent.run_id)).resolves.toBeUndefined();

    const forgedRecord: RunRecord = {
      schema_version: "1.0",
      run_id: intent.run_id,
      state: "queued",
      intent,
      launch: {
        mode: "inline",
        stage: "accepted",
        admission_identity: "forged-admission",
        request_hash: "forged-request",
        accepted_at: intent.created_at,
        dispatch_attempts: 0,
      },
      integrations: { results: [], all_critical_ok: true },
      recovery: { mode: "normal", resumable: false },
      summary: "Forged record",
      created_at: intent.created_at,
      updated_at: intent.created_at,
    };
    await expect(store.writeRunRecord(intent.run_id, forgedRecord)).rejects.toBeInstanceOf(
      RunCreationAdmissionRequiredError,
    );
    await expect(store.readRunRecord(intent.run_id)).resolves.toBeUndefined();

    const publicApi = await import("../index.js");
    expect(publicApi).not.toHaveProperty("issueRunCreationAdmission");
    expect(publicApi).not.toHaveProperty("RunCreationAdmissionRequiredError");
    const typecheckServiceBoundary = async (): Promise<void> => {
      const service = new RunService({ runsRoot: root });
      // @ts-expect-error The safe initialization seam remains protected.
      await service.initializeRun(intent);
    };
    void typecheckServiceBoundary;
  });

  test("maintenance mode cannot open or close admission", async () => {
    const open = new RunService({
      runsRoot: await runsRoot(),
      subscribers: [],
      workloadAdmission: { reconcile: passingTestWorkloadAdmissionReconciler },
    });
    (open.options as RunService["options"] & { maintenance_mode: boolean })
      .maintenance_mode = true;
    await expect(open.reconcileWorkloadAdmission()).resolves.toMatchObject({
      admission: "open",
    });

    const fenced = new RunService({
      runsRoot: await runsRoot(),
      subscribers: [],
      workloadAdmission: {
        reconcile: async () => {
          throw new Error("evidence missing");
        },
      },
    });
    (fenced.options as RunService["options"] & { maintenance_mode: boolean })
      .maintenance_mode = false;
    await expect(fenced.reconcileWorkloadAdmission()).resolves.toMatchObject({
      admission: "fenced",
      reason: "admission_evidence_missing",
    });
  });
});
