import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
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
import { renderInstructionTemplateSource } from "./instruction-template-render";

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

function buildInstructionContext(
  fleetInput: InstructionsFleetInput,
  hostInput: InstructionsHostInput,
  hostAlias: string,
  inputFiles: InstructionsRenderInputFiles,
  options: InstructionsRenderOptions,
): InstructionContext {
  const fleetContext = assertInstructionContext(fleetInput.instructions?.context, "fleet.instructions.context");
  const hostContext = assertInstructionContext(hostInput.instructions?.context, "host.instructions.context");
  const derivedContext = buildDerivedInstructionContext(inputFiles, hostAlias);
  const context: InstructionContext = {
    ...derivedContext,
    ...fleetContext,
    ...hostContext,
    ...(options.contextOverrides ?? {}),
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

function renderRoutingHints(routes: unknown): string {
  if (!Array.isArray(routes) || routes.length === 0) {
    return "";
  }
  const lines = [
    "## Tool Routing Hints",
    "",
    "When a task matches one of these patterns, prefer the indicated tool/skill:",
    "",
  ];
  for (const route of routes) {
    if (typeof route !== "object" || route === null || Array.isArray(route)) {
      continue;
    }
    const record = route as Record<string, unknown>;
    const routeTo = typeof record.route_to === "string" ? record.route_to : "";
    const reason = typeof record.reason === "string" ? record.reason : "";
    const patterns = Array.isArray(record.patterns)
      ? record.patterns.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (!routeTo || !reason) {
      continue;
    }
    lines.push(`- **${routeTo}**: ${reason}`);
    if (patterns.length > 0) {
      lines.push(`  - Triggers: ${patterns.map((pattern) => `\`${pattern}\``).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function renderHostContext(hostsInput: unknown, hostAlias: string): string {
  if (typeof hostsInput !== "object" || hostsInput === null || Array.isArray(hostsInput)) {
    return "";
  }
  const host = (hostsInput as { hosts?: Record<string, unknown> }).hosts?.[hostAlias];
  if (typeof host !== "object" || host === null || Array.isArray(host)) {
    return "";
  }
  const record = host as Record<string, unknown>;
  const lines = [`## This Host: \`${hostAlias}\``, ""];
  const gpus = Array.isArray(record.gpus) ? record.gpus : [];
  if (gpus.length > 0) {
    const gpuSummary = gpus
      .filter((gpu): gpu is Record<string, unknown> => typeof gpu === "object" && gpu !== null && !Array.isArray(gpu))
      .map((gpu) => {
        const model = typeof gpu.model === "string" ? gpu.model : "unknown";
        const vramGb = typeof gpu.vram_gb === "number" || typeof gpu.vram_gb === "string" ? ` (${gpu.vram_gb} GB` : "";
        const unified = gpu.type === "unified" ? " unified" : "";
        return vramGb ? `${model}${vramGb}${unified})` : model;
      })
      .join(", ");
    lines.push(`- **GPU**: ${gpuSummary}`);
  } else {
    lines.push("- **GPU**: none");
  }
  if (typeof record.ram_gb === "number" || typeof record.ram_gb === "string") {
    lines.push(`- **RAM**: ${record.ram_gb} GB`);
  }
  if (Array.isArray(record.roles)) {
    lines.push(`- **Roles**: ${record.roles.filter((entry) => typeof entry === "string").join(", ")}`);
  }
  if (Array.isArray(record.services) && record.services.length > 0) {
    lines.push(`- **Services**: ${record.services.filter((entry) => typeof entry === "string").join(", ")}`);
  }
  if (typeof record.notes === "string" && record.notes.trim().length > 0) {
    lines.push(`- **Notes**: ${record.notes.trim()}`);
  }
  return lines.join("\n");
}

function loadYamlSafe(filePath: string, fallback: unknown): unknown {
  try {
    return YAML.parse(readFileSync(filePath, "utf8")) ?? fallback;
  } catch {
    return fallback;
  }
}

function buildDerivedInstructionContext(
  inputFiles: InstructionsRenderInputFiles,
  hostAlias: string,
): InstructionContext {
  const fleetDir = path.dirname(path.resolve(inputFiles.fleetPath));
  const repoRoot = path.resolve(fleetDir, "..", "..");
  const truthsDir = path.join(repoRoot, "fleet", "truths");
  const routing = loadYamlSafe(path.join(truthsDir, "routing.yaml"), { routes: [] }) as { routes?: unknown };
  const hosts = loadYamlSafe(path.join(truthsDir, "hosts.yaml"), { hosts: {} });
  return {
    NOW_ISO: new Date().toISOString(),
    RENDER_HOST: os.hostname(),
    ROUTING_HINTS: renderRoutingHints(routing.routes),
    HOST_CONTEXT: renderHostContext(hosts, hostAlias),
  };
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
      const context = buildInstructionContext(fleetInput, hostInput, hostAlias, inputFiles, options);
      const renderedTemplate = await renderInstructionTemplateSource(
        templateSource,
        inputFiles.partialsDir,
        context,
        { maxPartialDepth },
      );
      const outputPath = options.outputDir ? outputPathForHost(options.outputDir, hostAlias) : undefined;

      if (outputPath) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, renderedTemplate.output, "utf8");
      }

      return {
        host: hostAlias,
        output: renderedTemplate.output,
        missingPartials: renderedTemplate.missingPartials,
        unresolvedTokens: renderedTemplate.unresolvedTokens,
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
