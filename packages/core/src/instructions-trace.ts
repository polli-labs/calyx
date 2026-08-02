import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  listInstructionSurfaces,
  reconcileInstructionSurfaces,
  showInstructionSurface,
} from "./instructions-surfaces";
import type {
  InstructionTraceMatch,
  InstructionTraceResult,
  InstructionTraceStatus,
  InstructionTraceVariable,
  InstructionTraceVariableSourceKind,
  InstructionManagedFile,
  InstructionsFleetInput,
  InstructionsHostInput,
  InstructionsShowResult,
  InstructionTemplateTraceChannel,
} from "./types";
import {
  expandHomePath,
  type HostsTruthFile,
  pathExists,
  readHostsTruth,
  resolveAgentsInfraRoot,
  resolveCurrentHostAlias,
} from "./agents-infra";
import { renderInstructionTemplateFile } from "./instruction-template-render";

interface TemplateTraceContext {
  values: Record<string, string>;
  sourcePaths: Record<string, string | undefined>;
  sourceKinds: Record<string, InstructionTraceVariableSourceKind>;
}

interface TraceTemplateEntry {
  templateId: string;
  templatePath: string;
}

export class InstructionTraceLookupError extends Error {
  readonly code: string;
  readonly suggestions: string[];
  readonly matches: string[];

  constructor(
    code: string,
    message: string,
    options: { suggestions?: string[]; matches?: string[] } = {},
  ) {
    super(message);
    this.name = "InstructionTraceLookupError";
    this.code = code;
    this.suggestions = options.suggestions ?? [];
    this.matches = options.matches ?? [];
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeGlobalTemplateRender(text: string): string {
  return text
    .replace(/^last_modified:\s+.+$/m, "last_modified: <normalized>")
    .replace(/^last_reviewed:\s+.+$/m, "last_reviewed: <normalized>")
    .replace(/^- Render host:\s+.+$/m, "- Render host: <normalized>")
    .replace(/^- Time:\s+.+$/m, "- Time: <normalized>");
}

async function readJsonObjectFile(
  filePath: string,
  label: string,
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (options.allowMissing || options.bestEffort) {
      return {};
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`);
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (options.bestEffort) {
      return {};
    }
    const message = error instanceof Error ? error.message : String(error);
    const snippet = text.replace(/\s+/g, " ").slice(0, 120);
    throw new Error(
      `Failed to parse JSON at ${filePath}: ${message}. Content starts with: ${JSON.stringify(snippet)}`,
    );
  }

  if (options.bestEffort) {
    return {};
  }
  throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object.`);
}

async function templateRegistryEntries(agentsInfraRoot: string): Promise<TraceTemplateEntry[]> {
  const registryPath = path.join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json");
  const parsed = (await readJsonObjectFile(registryPath, "template registry")) as {
    globals?: {
      hot?: string;
      variants?: string[];
      legacy?: string[];
    };
  };

  const entries: TraceTemplateEntry[] = [];
  const pushEntry = (templatePath: string | undefined, explicitId?: string): void => {
    if (!templatePath) {
      return;
    }
    const resolvedPath = path.resolve(agentsInfraRoot, templatePath);
    const baseName = path.basename(resolvedPath).replace(/^AGENTS\./, "").replace(/\.md\.mustache$/, "");
    entries.push({
      templateId: explicitId ?? baseName,
      templatePath: resolvedPath,
    });
  };

  pushEntry(parsed.globals?.hot, "global.hot");
  for (const variant of parsed.globals?.variants ?? []) {
    pushEntry(variant);
  }
  for (const legacy of parsed.globals?.legacy ?? []) {
    pushEntry(legacy);
  }

  return entries;
}

function parseRcloneConfig(text: string): Array<{ remote: string; type: string; provider: string }> {
  const sections: Array<{ remote: string; kv: Record<string, string> }> = [];
  let current: { remote: string; kv: Record<string, string> } | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch?.[1]) {
      current = { remote: sectionMatch[1], kv: {} };
      sections.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (kvMatch?.[1] && kvMatch[2]) {
      current.kv[kvMatch[1].trim()] = kvMatch[2].trim();
    }
  }

  return sections.map((section) => ({
    remote: section.remote,
    type: section.kv.type ?? "unknown",
    provider: section.kv.provider ?? "",
  }));
}

function buildRcloneTable(remotes: Array<{ remote: string; type: string; provider: string }>): string {
  if (remotes.length === 0) {
    return "_No remotes detected (skipped)._\\n";
  }

  const rows = remotes.map(({ remote, type, provider }) => {
    let bucket = remote;
    if (remote === "ibrida") {
      bucket = "ibrida-1/";
    }
    if (remote === "iNatOpenData") {
      bucket = "inaturalist-open-data";
    }

    let purpose = "";
    if (remote === "iNatOpenData") {
      purpose = "Public S3 bucket for iNaturalist open photos";
    }
    if (remote === "ibrida") {
      purpose = "Datasets incl. linnaeus training; future machine-labeled outputs";
    }

    return `| \`${remote}:\` | \`${bucket}\` | ${type}${provider ? ` (${provider})` : ""} | ${purpose} |`;
  });

  return ["| Remote | Bucket name | Type | Purpose |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

function variablePreview(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  if (flattened.length <= 96) {
    return flattened;
  }
  return `${flattened.slice(0, 93)}...`;
}

function buildTemplateVariables(
  tokenNames: string[],
  context: TemplateTraceContext,
  includeValues: boolean,
): InstructionTraceVariable[] {
  return tokenNames.map((token) => {
    const sourceKind = context.sourceKinds[token] ?? "unresolved";
    const value = context.values[token];
    return {
      name: token,
      sourceKind,
      ...(context.sourcePaths[token] ? { sourcePath: context.sourcePaths[token] } : {}),
      ...(includeValues && value !== undefined ? { value } : {}),
      ...(!includeValues && value !== undefined ? { valuePreview: variablePreview(value) } : {}),
    };
  });
}

function renderRoutingHints(routes: Array<{ patterns?: string[]; route_to?: string; reason?: string }>): string {
  if (routes.length === 0) {
    return "";
  }
  const lines = [
    "## Tool Routing Hints",
    "",
    "When a task matches one of these patterns, prefer the indicated tool/skill:",
    "",
  ];
  for (const route of routes) {
    lines.push(`- **${route.route_to ?? "unknown"}**: ${route.reason ?? ""}`.trimEnd());
    const triggers = (route.patterns ?? []).map((pattern) => `\`${pattern}\``).join(", ");
    if (triggers.length > 0) {
      lines.push(`  - Triggers: ${triggers}`);
    }
  }
  return lines.join("\n");
}

function renderSprintFocus(sprint: { focus_areas?: string[] }): string {
  if (!sprint.focus_areas?.length) {
    return "";
  }
  return sprint.focus_areas.map((focus) => `  - ${focus}`).join("\n");
}

function renderSprintContext(sprint: {
  current_week?: string;
  sprint_theme?: string;
  focus_areas?: string[];
  key_issues?: string[];
}): string {
  if (!sprint.current_week) {
    return "";
  }

  const lines = [
    "## Current Sprint",
    "",
    `**${sprint.current_week}** — ${sprint.sprint_theme ?? ""}`.trimEnd(),
    "",
  ];
  if (sprint.focus_areas?.length) {
    lines.push("Focus:");
    for (const focus of sprint.focus_areas) {
      lines.push(`- ${focus}`);
    }
  }
  if (sprint.key_issues?.length) {
    lines.push("");
    lines.push(`Key issues: ${sprint.key_issues.join(", ")}`);
  }
  return lines.join("\n").trimEnd();
}

function renderHostContext(hostsTruth: HostsTruthFile, hostAlias: string): string {
  const host = hostsTruth.hosts?.[hostAlias];
  if (!host) {
    return "";
  }

  const lines = [`## This Host: \`${hostAlias}\``, ""];
  if (host.gpus?.length) {
    const gpuSummary = host.gpus
      .map((gpu) => `${gpu.model ?? "unknown"} (${gpu.vram_gb ?? "?"} GB${gpu.type === "unified" ? " unified" : ""})`)
      .join(", ");
    lines.push(`- **GPU**: ${gpuSummary}`);
  } else {
    lines.push("- **GPU**: none");
  }
  if (typeof host.ram_gb === "number") {
    lines.push(`- **RAM**: ${host.ram_gb} GB`);
  }
  if (host.roles?.length) {
    lines.push(`- **Roles**: ${host.roles.join(", ")}`);
  }
  if (host.services?.length) {
    lines.push(`- **Services**: ${host.services.join(", ")}`);
  }
  if (host.notes) {
    lines.push(`- **Notes**: ${host.notes}`);
  }
  return lines.join("\n");
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  return YAML.parse(await readFile(filePath, "utf8")) as T;
}

async function readSystemsGlance(agentsInfraRoot: string, hostAlias: string): Promise<string> {
  const systemsPath = path.join(
    agentsInfraRoot,
    "docs",
    "org-kb",
    "repos",
    "reports",
    "systems",
    `${hostAlias}.md`,
  );
  if (!(await pathExists(systemsPath))) {
    return `- Host: \`${hostAlias}\`\n- No repo-local systems report is available in this source tree.`;
  }

  const text = await readFile(systemsPath, "utf8");
  const body = text.startsWith("---")
    ? text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "")
    : text;
  const firstParagraph = body.trim().split(/\n\s*\n/)[0] ?? "";
  return `${firstParagraph.trim()}\n\n_Source: docs/org-kb/repos/reports/systems/${hostAlias}.md_`;
}

async function buildGlobalTemplateContext(
  agentsInfraRoot: string,
  hostAlias: string,
): Promise<TemplateTraceContext> {
  const localConfigPath = path.join(homedir(), ".config", "polli", "agents.local.json");
  const localConfig = await readJsonObjectFile(localConfigPath, "local agents config", {
    allowMissing: true,
    bestEffort: true,
  });
  const localHostAlias =
    typeof localConfig.hostAlias === "string" && localConfig.hostAlias.trim().length > 0
      ? localConfig.hostAlias.trim()
      : undefined;
  const routingPath = path.join(agentsInfraRoot, "fleet", "truths", "routing.yaml");
  const sprintPath = path.join(agentsInfraRoot, "fleet", "truths", "sprint.yaml");
  const hostsPath = path.join(agentsInfraRoot, "fleet", "truths", "hosts.yaml");
  const rcloneConfigPath = path.join(homedir(), ".config", "rclone", "rclone.conf");
  const harnessSkillsPath = path.join(
    agentsInfraRoot,
    "instructions",
    "templates",
    "partials",
    "harness.codex-cli.skills.md.mustache",
  );

  const routing = (await pathExists(routingPath))
    ? ((await readYamlFile(routingPath)) as { routes?: Array<{ patterns?: string[]; route_to?: string; reason?: string }> })
    : { routes: [] };
  const sprint = (await pathExists(sprintPath))
    ? ((await readYamlFile(sprintPath)) as {
        current_week?: string;
        sprint_theme?: string;
        focus_areas?: string[];
        key_issues?: string[];
      })
    : {};
  const hostsTruth = await readHostsTruth(agentsInfraRoot);
  const harnessSkills = (await pathExists(harnessSkillsPath)) ? await readFile(harnessSkillsPath, "utf8") : "";
  const systemsGlanceHost = localHostAlias ?? hostAlias;
  const systemsGlance = await readSystemsGlance(agentsInfraRoot, systemsGlanceHost);
  const renderHost = systemHostname();
  const rcloneConfigText = (await pathExists(rcloneConfigPath)) ? await readFile(rcloneConfigPath, "utf8") : "";
  const isLocalHost = hostAlias === localHostAlias || hostAlias === renderHost;

  const values: Record<string, string> = {
    NOW_ISO: new Date().toISOString(),
    HOSTNAME: hostAlias,
    HOST_ALIAS: hostAlias,
    RENDER_HOST: renderHost,
    BACKEND_PORT: String(localConfig.backendPort ?? 8010),
    DASH_PORT: String(localConfig.dashPort ?? 5179),
    WEBSITE_PORT: String(localConfig.websitePort ?? 3015),
    GITHUB_USER: String(localConfig.githubUser ?? "frontierkodiak"),
    ORG: String(localConfig.org ?? "polli-labs"),
    SYSTEMS_GLANCE: systemsGlance,
    RCLONE_TABLE: isLocalHost
      ? buildRcloneTable(parseRcloneConfig(rcloneConfigText))
      : "_No remotes detected (staged)._\\n",
    ROUTING_HINTS: renderRoutingHints(routing.routes ?? []),
    SPRINT_CONTEXT: renderSprintContext(sprint),
    HOST_CONTEXT: renderHostContext(hostsTruth, hostAlias),
    SPRINT_WEEK: sprint.current_week ?? "",
    SPRINT_THEME: sprint.sprint_theme ?? "",
    SPRINT_FOCUS: renderSprintFocus(sprint),
    HARNESS_SKILLS: harnessSkills,
  };

  return {
    values,
    sourceKinds: {
      NOW_ISO: "render_time",
      HOSTNAME: "host_builtin",
      HOST_ALIAS: "host_builtin",
      RENDER_HOST: "render_time",
      BACKEND_PORT: "local_config",
      DASH_PORT: "local_config",
      WEBSITE_PORT: "local_config",
      GITHUB_USER: "local_config",
      ORG: "local_config",
      SYSTEMS_GLANCE: "repo_file",
      RCLONE_TABLE: "local_config",
      ROUTING_HINTS: "fleet_truth",
      SPRINT_CONTEXT: "fleet_truth",
      HOST_CONTEXT: "fleet_truth",
      SPRINT_WEEK: "fleet_truth",
      SPRINT_THEME: "fleet_truth",
      SPRINT_FOCUS: "fleet_truth",
      HARNESS_SKILLS: "repo_file",
    },
    sourcePaths: {
      BACKEND_PORT: localConfigPath,
      DASH_PORT: localConfigPath,
      WEBSITE_PORT: localConfigPath,
      GITHUB_USER: localConfigPath,
      ORG: localConfigPath,
      SYSTEMS_GLANCE: path.join(
        agentsInfraRoot,
        "docs",
        "org-kb",
        "repos",
        "reports",
        "systems",
        `${systemsGlanceHost}.md`,
      ),
      RCLONE_TABLE: rcloneConfigPath,
      ROUTING_HINTS: routingPath,
      SPRINT_CONTEXT: sprintPath,
      HOST_CONTEXT: hostsPath,
      SPRINT_WEEK: sprintPath,
      SPRINT_THEME: sprintPath,
      SPRINT_FOCUS: sprintPath,
      HARNESS_SKILLS: harnessSkillsPath,
    },
  };
}

async function buildSurfaceTemplateContext(
  showResult: InstructionsShowResult,
  hostAlias: string,
): Promise<TemplateTraceContext> {
  const fleet = await readYamlFile<InstructionsFleetInput>(showResult.sourceRef.fleetPath);
  const hostInput = await readYamlFile<InstructionsHostInput>(
    path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`),
  );

  const fleetContext = fleet.instructions?.context ?? {};
  const hostContext = hostInput.instructions?.context ?? {};
  const values: Record<string, string> = {};
  const sourceKinds: Record<string, InstructionTraceVariableSourceKind> = {};
  const sourcePaths: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(fleetContext)) {
    values[key] = String(value);
    sourceKinds[key] = "fleet_manifest_context";
    sourcePaths[key] = showResult.sourceRef.fleetPath;
  }
  for (const [key, value] of Object.entries(hostContext)) {
    values[key] = String(value);
    sourceKinds[key] = "host_manifest_context";
    sourcePaths[key] = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);
  }

  values.HOST = hostAlias;
  values.HOSTNAME = hostAlias;
  values.HOST_ALIAS = hostAlias;
  sourceKinds.HOST = "host_builtin";
  sourceKinds.HOSTNAME = "host_builtin";
  sourceKinds.HOST_ALIAS = "host_builtin";
  sourcePaths.HOST = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);
  sourcePaths.HOSTNAME = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);
  sourcePaths.HOST_ALIAS = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);

  if (hostInput.user) {
    values.USER = String(hostInput.user);
    sourceKinds.USER = "host_builtin";
    sourcePaths.USER = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);
  }
  if (hostInput.home) {
    values.HOME = String(hostInput.home);
    sourceKinds.HOME = "host_builtin";
    sourcePaths.HOME = path.join(showResult.sourceRef.hostsDir, `${hostAlias}.yaml`);
  }

  return { values, sourceKinds, sourcePaths };
}

async function resolveHostHomePath(
  agentsInfraRoot: string,
  hostAlias: string,
): Promise<string> {
  const hostsTruth = await readHostsTruth(agentsInfraRoot);
  const host = hostsTruth.hosts?.[hostAlias];
  if (!host) {
    throw new InstructionTraceLookupError(
      "unknown_host",
      `Unknown host alias "${hostAlias}". Add it to fleet/truths/hosts.yaml.`,
    );
  }
  if (!host.home || host.home.trim().length === 0) {
    throw new InstructionTraceLookupError(
      "unknown_host",
      `Host "${hostAlias}" is missing a home path in fleet/truths/hosts.yaml.`,
    );
  }
  return path.resolve(expandHomePath(host.home));
}

function mapReconcileStatus(status: string): InstructionTraceStatus {
  if (status === "missing_expected") {
    return "missing";
  }
  if (status === "managed_ok" || status === "unmanaged_match") {
    return "matches_current_render";
  }
  return "drifted";
}

function managedFilePath(managedFile: InstructionManagedFile): string {
  return managedFile.path;
}

async function fileModifiedAt(pathname: string): Promise<string | undefined> {
  if (!(await pathExists(pathname))) {
    return undefined;
  }
  return (await stat(pathname)).mtime.toISOString();
}

async function buildSurfaceMatches(
  resolvedTargetPath: string,
  surfacesDir: string,
  hostAlias: string,
  options: {
    includeArchived?: boolean;
    includeVariables?: boolean;
    includePartialContents?: boolean;
  },
): Promise<InstructionTraceMatch[]> {
  const summaries = await listInstructionSurfaces(surfacesDir, { includeArchived: true });
  const matches: InstructionTraceMatch[] = [];

  for (const summary of summaries.items) {
    const showResult = await showInstructionSurface(surfacesDir, summary.surfaceId);
    if (!options.includeArchived && showResult.status === "archived") {
      continue;
    }

    for (const binding of showResult.targetBindings) {
      if (!binding.managedFiles?.length) {
        continue;
      }
      const selectorHosts = binding.selectors?.hosts ?? [];
      if (selectorHosts.length > 0 && !selectorHosts.includes(hostAlias)) {
        continue;
      }
      for (const managedFile of binding.managedFiles) {
        const managedPath = managedFilePath(managedFile);
        const expectedPath = path.join(binding.path, managedPath);
        if (path.resolve(expectedPath) !== resolvedTargetPath) {
          continue;
        }

        const reconcile = await reconcileInstructionSurfaces(surfacesDir, {
          host: hostAlias,
          surfaceId: showResult.surfaceId,
          includeArchived: true,
        });
        const finding = reconcile.findings.find((entry) => path.resolve(entry.targetPath) === resolvedTargetPath);
        if (!finding) {
          continue;
        }

        const context = await buildSurfaceTemplateContext(showResult, hostAlias);
        const renderedTemplate = await renderInstructionTemplateFile(
          showResult.sourceRef.templatePath,
          showResult.sourceRef.partialsDir,
          context.values,
          {
            ...(options.includePartialContents ? { includePartialContents: true } : {}),
          },
        );
        const liveModifiedAt = await fileModifiedAt(resolvedTargetPath);

        matches.push({
          kind: "surface_binding",
          matchId: `surface:${showResult.surfaceId}:${binding.bindingId}:${managedPath}`,
          status: mapReconcileStatus(finding.status),
          targetPath: resolvedTargetPath,
          host: hostAlias,
          partials: renderedTemplate.partials,
          variables: buildTemplateVariables(
            renderedTemplate.tokenNames,
            context,
            Boolean(options.includeVariables),
          ),
          renderState: {
            renderedSha256: finding.expectedContentSha256,
            ...(finding.liveContentSha256 ? { liveSha256: finding.liveContentSha256 } : {}),
            ...(liveModifiedAt ? { liveModifiedAt } : {}),
            marker: finding.marker ?? null,
          },
          source: {
            surfaceId: showResult.surfaceId,
            manifestPath: showResult.manifestPath,
            bindingId: binding.bindingId,
            bindingClass: binding.class,
            sourceRef: showResult.sourceRef,
            targetBinding: binding,
            reconcileStatus: finding.status,
            reconcileReason: finding.reason,
            ...(finding.marker ? { marker: finding.marker } : {}),
          },
        });
      }
    }
  }

  return matches;
}

async function buildTemplateFanoutMatch(
  resolvedTargetPath: string,
  agentsInfraRoot: string,
  hostAlias: string,
  targetHomePath: string,
  options: {
    includeVariables?: boolean;
    includePartialContents?: boolean;
  },
): Promise<InstructionTraceMatch | undefined> {
  const templateEntries = await templateRegistryEntries(agentsInfraRoot);
  const partialsDir = path.join(agentsInfraRoot, "instructions", "templates", "partials");
  const claudeTargetPath = path.join(targetHomePath, ".claude", "CLAUDE.md");
  const codexTargetPath = path.join(targetHomePath, ".codex", "AGENTS.md");

  let selectedEntry: TraceTemplateEntry | undefined;
  let channel: InstructionTemplateTraceChannel | undefined;

  if (path.resolve(claudeTargetPath) === resolvedTargetPath) {
    selectedEntry = templateEntries.find((entry) => entry.templateId === "global.hot");
    channel = "claude";
  } else if (path.resolve(codexTargetPath) === resolvedTargetPath) {
    selectedEntry = templateEntries.find((entry) => entry.templateId === "global.hot");
    channel = "agents";
  } else {
    const stagedRoot = path.join(agentsInfraRoot, "generated", "staged");
    if (resolvedTargetPath.startsWith(path.resolve(stagedRoot))) {
      const fileName = path.basename(resolvedTargetPath);
      const match = fileName.match(/^(AGENTS|CLAUDE)\.(.+)\.staged\.md$/);
      if (match?.[1] && match[2]) {
        channel = match[1] === "AGENTS" ? "agents" : "claude";
        selectedEntry = templateEntries.find((entry) => entry.templateId === match[2]);
      }
    }
  }

  if (!selectedEntry || !channel) {
    return undefined;
  }

  const context = await buildGlobalTemplateContext(agentsInfraRoot, hostAlias);
  const values = {
    ...context.values,
    ...(channel === "claude" ? { HARNESS_SKILLS: "" } : {}),
  };
  const renderedTemplate = await renderInstructionTemplateFile(selectedEntry.templatePath, partialsDir, values, {
    ...(options.includePartialContents ? { includePartialContents: true } : {}),
  });
  const renderedOutput = renderedTemplate.output;
  const liveExists = await pathExists(resolvedTargetPath);
  const liveText = liveExists ? await readFile(resolvedTargetPath, "utf8") : undefined;
  const renderedSha256 = sha256Text(renderedOutput);
  const liveSha256 = liveText ? sha256Text(liveText) : undefined;
  const liveModifiedAt = await fileModifiedAt(resolvedTargetPath);
  const status: InstructionTraceStatus =
    !liveExists
      ? "missing"
      : normalizeGlobalTemplateRender(liveText ?? "") === normalizeGlobalTemplateRender(renderedOutput)
        ? "matches_current_render"
        : "drifted";
  const stagedTargetPath = path.join(
    agentsInfraRoot,
    "generated",
    "staged",
    hostAlias,
    `${channel === "agents" ? "AGENTS" : "CLAUDE"}.${selectedEntry.templateId}.staged.md`,
  );

  return {
    kind: "template_fanout",
    matchId: `template:${selectedEntry.templateId}:fanout:${channel}`,
    status,
    targetPath: resolvedTargetPath,
    host: hostAlias,
    partials: renderedTemplate.partials,
    variables: buildTemplateVariables(
      renderedTemplate.tokenNames,
      { ...context, values },
      Boolean(options.includeVariables),
    ),
    renderState: {
      renderedSha256,
      ...(liveSha256 ? { liveSha256 } : {}),
      ...(liveModifiedAt ? { liveModifiedAt } : {}),
      marker: null,
    },
    source: {
      templateId: selectedEntry.templateId,
      templateRegistryPath: path.join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"),
      templatePath: selectedEntry.templatePath,
      partialsDir,
      channel,
      fanoutTargetPath: channel === "agents" ? codexTargetPath : claudeTargetPath,
      stagedTargetPath,
    },
  };
}

function instructionSuggestions(
  targetPath: string,
  knownTargets: string[],
): string[] {
  const basename = path.basename(targetPath).toLowerCase();
  return [...new Set(knownTargets)]
    .filter((candidate) => path.basename(candidate).toLowerCase() === basename)
    .slice(0, 3);
}

async function resolveInstructionTargetMatchesInternal(
  target: string,
  options: {
    surfacesDir?: string;
    agentsInfraRoot?: string;
    host?: string;
    includeArchived?: boolean;
    includeVariables?: boolean;
    includePartialContents?: boolean;
  } = {},
): Promise<{ result: InstructionTraceResult; knownTargets: string[] }> {
  const resolvedTargetPath = path.resolve(expandHomePath(target));
  const agentsInfraRoot = await resolveAgentsInfraRoot({
    ...(options.agentsInfraRoot ? { explicitRoot: options.agentsInfraRoot } : {}),
    ...(options.surfacesDir ? { surfacesDir: options.surfacesDir } : {}),
  });
  const hostAlias = await resolveCurrentHostAlias(options.host, agentsInfraRoot);

  const matches: InstructionTraceMatch[] = [];
  const knownTargets: string[] = [];

  if (options.surfacesDir || agentsInfraRoot) {
    const surfacesDir = options.surfacesDir
      ? path.resolve(expandHomePath(options.surfacesDir))
      : path.join(agentsInfraRoot!, "instructions", "surfaces");
    if (await pathExists(surfacesDir)) {
      const summaries = await listInstructionSurfaces(surfacesDir, { includeArchived: true });
      for (const summary of summaries.items) {
        const showResult = await showInstructionSurface(surfacesDir, summary.surfaceId);
        for (const binding of showResult.targetBindings) {
          for (const managedFile of binding.managedFiles ?? []) {
            knownTargets.push(path.join(binding.path, managedFilePath(managedFile)));
          }
        }
      }
      matches.push(
        ...(await buildSurfaceMatches(resolvedTargetPath, surfacesDir, hostAlias, {
          ...(options.includeArchived ? { includeArchived: true } : {}),
          ...(options.includeVariables ? { includeVariables: true } : {}),
          ...(options.includePartialContents ? { includePartialContents: true } : {}),
        })),
      );
    }
  }

  if (agentsInfraRoot) {
    const targetHomePath = await resolveHostHomePath(agentsInfraRoot, hostAlias);
    knownTargets.push(
      path.join(targetHomePath, ".claude", "CLAUDE.md"),
      path.join(targetHomePath, ".codex", "AGENTS.md"),
    );
    for (const entry of await templateRegistryEntries(agentsInfraRoot)) {
      knownTargets.push(
        path.join(
          agentsInfraRoot,
          "generated",
          "staged",
          hostAlias,
          `AGENTS.${entry.templateId}.staged.md`,
        ),
        path.join(
          agentsInfraRoot,
          "generated",
          "staged",
          hostAlias,
          `CLAUDE.${entry.templateId}.staged.md`,
        ),
      );
    }

    const templateMatch = await buildTemplateFanoutMatch(
      resolvedTargetPath,
      agentsInfraRoot,
      hostAlias,
      targetHomePath,
      {
        ...(options.includeVariables ? { includeVariables: true } : {}),
        ...(options.includePartialContents ? { includePartialContents: true } : {}),
      },
    );
    if (templateMatch) {
      matches.push(templateMatch);
      if ("stagedTargetPath" in templateMatch.source && templateMatch.source.stagedTargetPath) {
        knownTargets.push(templateMatch.source.stagedTargetPath);
      }
    }
  }

  const uniqueMatches = [...new Map(matches.map((match) => [match.matchId, match])).values()];

  return {
    result: {
      target: {
        input: target,
        resolvedPath: resolvedTargetPath,
        host: hostAlias,
        exists: await pathExists(resolvedTargetPath),
      },
      matches: uniqueMatches,
    },
    knownTargets,
  };
}

export async function resolveInstructionTargetMatches(
  target: string,
  options: {
    surfacesDir?: string;
    agentsInfraRoot?: string;
    host?: string;
    includeArchived?: boolean;
  } = {},
): Promise<InstructionTraceResult> {
  const { result } = await resolveInstructionTargetMatchesInternal(target, options);
  return result;
}

export async function traceInstructionTarget(
  target: string,
  options: {
    surfacesDir?: string;
    agentsInfraRoot?: string;
    host?: string;
    includeArchived?: boolean;
    includeVariables?: boolean;
    includePartialContents?: boolean;
  } = {},
): Promise<InstructionTraceResult> {
  const { result, knownTargets } = await resolveInstructionTargetMatchesInternal(target, options);
  if (result.matches.length === 0) {
    throw new InstructionTraceLookupError(
      "unmanaged_target",
      "Target is not managed by any known instruction surface or template fanout.",
      { suggestions: instructionSuggestions(result.target.resolvedPath, knownTargets) },
    );
  }
  if (result.matches.length > 1) {
    throw new InstructionTraceLookupError(
      "ambiguous_target",
      "Target matched more than one instruction source.",
      { matches: result.matches.map((match) => match.matchId) },
    );
  }
  return result;
}
