import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type {
  InstructionContext,
  InstructionDrift,
  InstructionsFleetInput,
  InstructionsHostInput,
  InstructionsRenderInputFiles,
  InstructionsRenderOptions,
  InstructionsRenderResult,
  InstructionsVerifyOptions,
  InstructionsVerifyResult
} from "./types";

const UNRESOLVED_TOKEN_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}/g;

function parseYamlText<T>(yamlText: string, filePath: string): T {
  try {
    return YAML.parse(yamlText) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML at ${filePath}: ${message}`);
  }
}

async function parseYamlFile<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, "utf8");
  return parseYamlText<T>(text, filePath);
}

function assertInstructionContext(value: unknown, label: string): InstructionContext {
  if (!value) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with scalar values.`);
  }

  const context: InstructionContext = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      context[key] = raw;
      continue;
    }

    throw new Error(`${label}.${key} must be a string, number, or boolean.`);
  }

  return context;
}

function replaceInstructionTokens(source: string, replacements: InstructionContext): string {
  return Object.entries(replacements).reduce((acc, [key, value]) => acc.split(`{{${key}}}`).join(String(value)), source);
}

function expandPartials(
  source: string,
  partialsDir: string,
  maxDepth: number,
  missingPartials: Set<string>,
  depth = 0
): string {
  if (depth > maxDepth) {
    return source;
  }

  if (!source.includes("{{>")) {
    return source;
  }

  const includePattern = /\{\{>\s*([^}\s]+)\s*\}\}/g;
  return source.replace(includePattern, (_match, rawName: string) => {
    const partialName = rawName.trim();
    const partialPath = path.join(partialsDir, `${partialName}.md.mustache`);
    try {
      const content = readFileSync(partialPath, "utf8");
      return content;
    } catch {
      missingPartials.add(partialName);
      return `<!-- Missing partial: ${partialName} -->`;
    }
  });
}

function expandPartialsRecursive(
  source: string,
  partialsDir: string,
  maxDepth: number,
  missingPartials: Set<string>,
  depth = 0
): string {
  const expanded = expandPartials(source, partialsDir, maxDepth, missingPartials, depth);
  if (expanded === source || depth > maxDepth) {
    return expanded;
  }
  return expandPartialsRecursive(expanded, partialsDir, maxDepth, missingPartials, depth + 1);
}

function collectUnresolvedTokens(rendered: string): string[] {
  const unresolved = new Set<string>();
  for (const match of rendered.matchAll(UNRESOLVED_TOKEN_PATTERN)) {
    const token = match[1];
    if (token) {
      unresolved.add(token);
    }
  }
  return [...unresolved].sort();
}

function buildInstructionContext(
  fleetInput: InstructionsFleetInput,
  hostInput: InstructionsHostInput,
  hostAlias: string
): InstructionContext {
  const fleetContext = assertInstructionContext(fleetInput.instructions?.context, "fleet.instructions.context");
  const hostContext = assertInstructionContext(hostInput.instructions?.context, "host.instructions.context");
  const context: InstructionContext = {
    ...fleetContext,
    ...hostContext
  };

  context.HOST = hostAlias;
  context.HOSTNAME = hostAlias;
  context.HOST_ALIAS = hostAlias;
  if (typeof hostInput.user === "string") {
    context.USER = hostInput.user;
  }
  if (typeof hostInput.home === "string") {
    context.HOME = hostInput.home;
  }

  return context;
}

async function resolveHosts(hostsDir: string, options: InstructionsRenderOptions): Promise<string[]> {
  if (!options.all && !options.host) {
    throw new Error("instructions render/verify requires --host <alias> or --all.");
  }

  if (options.all) {
    const entries = await fs.readdir(hostsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name.replace(/\.yaml$/, ""))
      .sort();
  }

  return [options.host as string];
}

function outputPathForHost(outputDir: string, host: string): string {
  return path.join(outputDir, `${host}.instructions.md`);
}

function firstDiffReason(expected: string, actual: string): string {
  const expectedLines = expected.split(/\r?\n/);
  const actualLines = actual.split(/\r?\n/);
  const maxLines = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < maxLines; index += 1) {
    const expectedLine = expectedLines[index] ?? "<EOF>";
    const actualLine = actualLines[index] ?? "<EOF>";
    if (expectedLine !== actualLine) {
      return `line ${index + 1} mismatch: expected ${JSON.stringify(expectedLine)} but got ${JSON.stringify(actualLine)}`;
    }
  }

  return "content mismatch";
}

async function verifyHostOutput(
  host: string,
  renderedOutput: string,
  expectedDir: string,
  drifts: InstructionDrift[]
): Promise<void> {
  const expectedPath = path.join(expectedDir, `${host}.instructions.md`);
  let expectedOutput = "";
  try {
    expectedOutput = await fs.readFile(expectedPath, "utf8");
  } catch {
    drifts.push({
      host,
      expectedPath,
      reason: `Expected output file not found: ${expectedPath}`
    });
    return;
  }

  if (renderedOutput !== expectedOutput) {
    drifts.push({
      host,
      expectedPath,
      reason: firstDiffReason(expectedOutput, renderedOutput)
    });
  }
}

export async function renderInstructionsFromFiles(
  inputFiles: InstructionsRenderInputFiles,
  options: InstructionsRenderOptions = {}
): Promise<InstructionsRenderResult> {
  const [fleetInput, templateSource] = await Promise.all([
    parseYamlFile<InstructionsFleetInput>(inputFiles.fleetPath),
    fs.readFile(inputFiles.templatePath, "utf8")
  ]);
  const hostAliases = await resolveHosts(inputFiles.hostsDir, options);
  const maxPartialDepth = options.maxPartialDepth ?? 5;

  const results = await Promise.all(
    hostAliases.map(async (hostAlias) => {
      const hostPath = path.join(inputFiles.hostsDir, `${hostAlias}.yaml`);
      const hostInput = await parseYamlFile<InstructionsHostInput>(hostPath);
      const context = buildInstructionContext(fleetInput, hostInput, hostAlias);
      const missingPartials = new Set<string>();
      const templateWithPartials = expandPartialsRecursive(templateSource, inputFiles.partialsDir, maxPartialDepth, missingPartials);
      const output = replaceInstructionTokens(templateWithPartials, context);
      const unresolvedTokens = collectUnresolvedTokens(output);
      const outputPath = options.outputDir ? outputPathForHost(options.outputDir, hostAlias) : undefined;

      if (outputPath) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, output, "utf8");
      }

      return {
        host: hostAlias,
        output,
        missingPartials: [...missingPartials].sort(),
        unresolvedTokens,
        ...(outputPath ? { outputPath } : {})
      };
    })
  );

  return { results };
}

export async function verifyInstructionsFromFiles(
  inputFiles: InstructionsRenderInputFiles,
  options: InstructionsVerifyOptions
): Promise<InstructionsVerifyResult> {
  const rendered = await renderInstructionsFromFiles(inputFiles, options);
  const drifts: InstructionDrift[] = [];

  for (const result of rendered.results) {
    if (result.missingPartials.length > 0) {
      drifts.push({
        host: result.host,
        expectedPath: path.join(options.expectedDir, `${result.host}.instructions.md`),
        reason: `Missing partials: ${result.missingPartials.join(", ")}`
      });
    }

    if (result.unresolvedTokens.length > 0) {
      drifts.push({
        host: result.host,
        expectedPath: path.join(options.expectedDir, `${result.host}.instructions.md`),
        reason: `Unresolved tokens: ${result.unresolvedTokens.join(", ")}`
      });
    }

    await verifyHostOutput(result.host, result.output, options.expectedDir, drifts);
  }

  return {
    ok: drifts.length === 0,
    drifts,
    results: rendered.results
  };
}
