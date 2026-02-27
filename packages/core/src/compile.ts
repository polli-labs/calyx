import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { mergeWithPolicies } from "./merge";
import { compareTomlSemantics } from "./parity";
import { expandTokens } from "./tokens";
import type {
  CodexInput,
  CompileContext,
  CompileInputFiles,
  CompileOptions,
  CompileResult,
  FleetInput,
  HostInput,
  ProjectTrustEntry,
  ValidationMode
} from "./types";
import { validateInputs } from "./validate";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProjects(projects: CodexInput["projects"]): Record<string, { trust_level: string }> | undefined {
  if (!projects) {
    return undefined;
  }

  if (isRecord(projects) && !("defaults" in projects) && !("extra" in projects)) {
    const normalized: Record<string, { trust_level: string }> = {};
    for (const [projectPath, value] of Object.entries(projects)) {
      const trustLevel = isRecord(value) && typeof value.trust_level === "string" ? value.trust_level : "trusted";
      normalized[projectPath] = { trust_level: trustLevel };
    }
    return normalized;
  }

  const manifest = projects as { defaults?: ProjectTrustEntry[]; extra?: Array<string | ProjectTrustEntry> };
  const normalized: Record<string, { trust_level: string }> = {};

  for (const item of manifest.defaults ?? []) {
    normalized[item.path] = { trust_level: item.trust_level ?? "trusted" };
  }

  for (const item of manifest.extra ?? []) {
    if (typeof item === "string") {
      normalized[item] = { trust_level: "trusted" };
      continue;
    }

    normalized[item.path] = { trust_level: item.trust_level ?? "trusted" };
  }

  return normalized;
}

function normalizeCodex(codex: CodexInput): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  if (isRecord(codex.top_level)) {
    Object.assign(output, codex.top_level);
  }

  if (isRecord(codex.profiles)) {
    output.profiles = codex.profiles;
  }

  if (isRecord(codex.mcp_servers)) {
    output.mcp_servers = codex.mcp_servers;
  }

  if (isRecord(codex.features)) {
    output.features = codex.features;
  }

  if (isRecord(codex.history)) {
    output.history = codex.history;
  }

  const projects = normalizeProjects(codex.projects);
  if (projects) {
    output.projects = projects;
  }

  if (isRecord(codex.otel)) {
    output.otel = codex.otel;
  }

  if (isRecord(codex.notice)) {
    output.notice = codex.notice;
  }

  return output;
}

function parseYamlFile<T>(filePath: string): Promise<T> {
  return fs.readFile(filePath, "utf8").then((content) => {
    const parsed = YAML.parse(content) as T;
    return parsed;
  });
}

function ensureCodex(root: FleetInput | HostInput): CodexInput {
  if (isRecord(root.codex)) {
    return root.codex as CodexInput;
  }

  return {};
}

export async function compileFromFiles(
  inputFiles: CompileInputFiles,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const mode: ValidationMode = options.mode ?? "strict";
  const warnings: string[] = [];

  const [fleetRaw, hostRaw] = await Promise.all([
    parseYamlFile<FleetInput>(inputFiles.fleetPath),
    parseYamlFile<HostInput>(inputFiles.hostPath)
  ]);

  validateInputs(fleetRaw, hostRaw, mode, warnings);

  const context: CompileContext = {
    host: hostRaw.host,
    user: hostRaw.user,
    home: hostRaw.home
  };

  const fleetExpanded = expandTokens(fleetRaw, context);
  const hostExpanded = expandTokens(hostRaw, context);

  const merged = mergeWithPolicies(fleetExpanded, hostExpanded, fleetExpanded.array_policies);
  const codexOutput = normalizeCodex(ensureCodex(merged));
  const tomlText = stringifyToml(codexOutput as any);

  if (options.outputPath && options.write) {
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, tomlText, "utf8");
  }

  return {
    configObject: codexOutput,
    tomlText,
    warnings
  };
}

export function parseTomlToObject(tomlText: string): Record<string, unknown> {
  return parseToml(tomlText) as Record<string, unknown>;
}

export async function checkSemanticParity(generatedToml: string, expectedTomlPath: string): Promise<void> {
  const expectedToml = await fs.readFile(expectedTomlPath, "utf8");
  const parity = compareTomlSemantics(generatedToml, expectedToml);
  if (!parity.equal) {
    throw new Error(`Semantic parity failed: ${parity.reason}`);
  }
}
