import { access, constants, readFile, readdir } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import {
  PLUGIN_COMPONENT_KINDS,
  type PluginComponentKind,
  type PluginComponents,
  type PluginDoctorIssue,
  type PluginHarness,
  type PluginHarnessSelector,
  type PluginInventoryDiagnostic,
  type PluginManagedBy,
  type PluginObservation,
  type PluginObservationState,
  type PluginPaths,
  type PluginSourceRef,
  type PluginsDoctorResult,
  type PluginsInventoryOptions,
  type PluginsInventoryResult,
  type PluginsShowResult,
  type PluginsTraceOptions,
  type PluginsTraceResult,
} from "./types";

type JsonObject = Record<string, unknown>;

interface MarketplacePluginEntry {
  name: string;
  version?: string;
  description?: string;
  source?: PluginSourceRef;
  root?: string;
  manifest?: string;
  components?: PluginComponents;
}

interface MarketplaceRecord {
  name: string;
  path: string;
  plugins: MarketplacePluginEntry[];
}

interface EnabledPluginRecord {
  marketplace?: string;
  plugin: string;
}

interface InventoryContext {
  home: string;
  codexHome: string;
  claudeHome: string;
  claudeMarketplaceHome: string;
  observedAt: string;
  host: string;
  includeCatalog: boolean;
  diagnostics: PluginInventoryDiagnostic[];
}

const emptyComponents = (): PluginComponents => ({
  skills: [],
  mcpServers: [],
  apps: [],
  hooks: [],
  agents: [],
  commands: [],
  lspServers: [],
  monitors: [],
  bin: [],
  settings: [],
});

function expandHomePath(pathname: string, home = homedir()): string {
  if (pathname === "~") {
    return home;
  }
  if (pathname.startsWith("~/")) {
    return path.join(home, pathname.slice(2));
  }
  return pathname;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(pathname: string): Promise<JsonObject | undefined> {
  if (!(await pathExists(pathname))) {
    return undefined;
  }
  const text = await readFile(pathname, "utf8");
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as JsonObject
    : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asPathStrings(value: unknown): string[] {
  const single = asString(value);
  if (single) {
    return [single];
  }
  if (Array.isArray(value)) {
    return value.map(asString).filter((entry): entry is string => Boolean(entry));
  }
  return [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeState(states: PluginObservationState[]): PluginObservationState[] {
  const order: PluginObservationState[] = ["cataloged", "cached", "enabled", "installed", "active"];
  const seen = new Set(states);
  return order.filter((state) => seen.has(state));
}

function mergeComponents(left: PluginComponents, right: PluginComponents): PluginComponents {
  return {
    skills: sortedUnique([...left.skills, ...right.skills]),
    mcpServers: sortedUnique([...left.mcpServers, ...right.mcpServers]),
    apps: sortedUnique([...left.apps, ...right.apps]),
    hooks: sortedUnique([...left.hooks, ...right.hooks]),
    agents: sortedUnique([...left.agents, ...right.agents]),
    commands: sortedUnique([...left.commands, ...right.commands]),
    lspServers: sortedUnique([...left.lspServers, ...right.lspServers]),
    monitors: sortedUnique([...left.monitors, ...right.monitors]),
    bin: sortedUnique([...left.bin, ...right.bin]),
    settings: sortedUnique([...left.settings, ...right.settings]),
  };
}

function pluginKey(harness: PluginHarness, marketplace: string | undefined, plugin: string): string {
  return `${harness}\0${marketplace ?? ""}\0${plugin}`;
}

function parsePluginRef(ref: string): { marketplace?: string; plugin: string } {
  const trimmed = ref.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex > 0 && atIndex < trimmed.length - 1) {
    return {
      plugin: trimmed.slice(0, atIndex),
      marketplace: trimmed.slice(atIndex + 1),
    };
  }
  return { plugin: trimmed };
}

function recordSourceFromManifest(manifest: JsonObject, fallback?: PluginSourceRef): PluginSourceRef | undefined {
  const repository = asString(manifest.repository);
  if (repository) {
    return { kind: repository.includes("github.com") ? "github" : "git", value: repository };
  }
  const homepage = asString(manifest.homepage);
  if (homepage) {
    return { kind: "url", value: homepage };
  }
  return fallback;
}

function marketplaceRootFromPath(marketplacePath: string): string {
  const dir = path.dirname(marketplacePath);
  if (path.basename(dir) === ".claude-plugin") {
    return path.dirname(dir);
  }
  if (path.basename(dir) === "plugins" && path.basename(path.dirname(dir)) === ".agents") {
    return path.dirname(path.dirname(dir));
  }
  return dir;
}

async function resolveMarketplaceLocalPath(localPath: string, marketplacePath: string): Promise<string> {
  const root = marketplaceRootFromPath(marketplacePath);
  const candidates = [
    path.resolve(root, localPath),
    path.resolve(path.dirname(marketplacePath), localPath),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

async function normalizeMarketplaceSource(raw: unknown, marketplacePath: string): Promise<PluginSourceRef | undefined> {
  const sourceString = asString(raw);
  if (sourceString) {
    return { kind: "local", value: await resolveMarketplaceLocalPath(sourceString, marketplacePath) };
  }

  const source = asObject(raw);
  if (!source) {
    return undefined;
  }
  const kind = asString(source.source) ?? asString(source.type) ?? "unknown";
  if (kind === "local") {
    const localPath = asString(source.path);
    return {
      kind: "local",
      value: localPath ? await resolveMarketplaceLocalPath(localPath, marketplacePath) : marketplaceRootFromPath(marketplacePath),
    };
  }
  const repo = asString(source.repo);
  if (repo) {
    return { kind: "github", value: repo };
  }
  const url = asString(source.url);
  if (url) {
    return { kind: "url", value: url };
  }
  return { kind: "unknown", value: JSON.stringify(source) };
}

function objectKeys(value: unknown): string[] {
  const object = asObject(value);
  return object ? Object.keys(object).sort((left, right) => left.localeCompare(right)) : [];
}

function inlineComponentNames(value: unknown): string[] {
  const keys = objectKeys(value);
  if (keys.length > 0) {
    return keys;
  }
  if (Array.isArray(value)) {
    return sortedUnique(value.map(asString).filter((entry): entry is string => Boolean(entry)));
  }
  return [];
}

function inlineComponentsFromManifestLike(manifest: JsonObject): PluginComponents {
  const components = emptyComponents();
  components.skills.push(...inlineComponentNames(manifest.skills));
  components.mcpServers.push(...inlineComponentNames(manifest.mcpServers));
  components.apps.push(...inlineComponentNames(manifest.apps));
  components.hooks.push(...inlineComponentNames(manifest.hooks));
  components.agents.push(...inlineComponentNames(manifest.agents));
  components.commands.push(...inlineComponentNames(manifest.commands));
  components.lspServers.push(...inlineComponentNames(manifest.lspServers));
  components.monitors.push(...inlineComponentNames(manifest.monitors));
  components.bin.push(...inlineComponentNames(manifest.bin));
  components.settings.push(...inlineComponentNames(manifest.settings));
  return mergeComponents(emptyComponents(), components);
}

function createObservation(input: {
  harness: PluginHarness;
  marketplace?: string;
  plugin: string;
  version?: string;
  description?: string;
  state: PluginObservationState[];
  source?: PluginSourceRef;
  paths?: PluginPaths;
  components?: PluginComponents;
  managedBy?: PluginManagedBy;
  context: InventoryContext;
}): PluginObservation {
  return {
    harness: input.harness,
    ...(input.marketplace ? { marketplace: input.marketplace } : {}),
    plugin: input.plugin,
    ...(input.version ? { version: input.version } : {}),
    ...(input.description ? { description: input.description } : {}),
    state: normalizeState(input.state),
    ...(input.source ? { source: input.source } : {}),
    paths: input.paths ?? {},
    components: input.components ?? emptyComponents(),
    managedBy: input.managedBy ?? input.harness,
    provenance: {
      observedAt: input.context.observedAt,
      host: input.context.host,
    },
  };
}

function upsertObservation(
  observations: Map<string, PluginObservation>,
  observation: PluginObservation,
): void {
  const key = pluginKey(observation.harness, observation.marketplace, observation.plugin);
  const current = observations.get(key);
  if (!current) {
    observations.set(key, observation);
    return;
  }

  const currentIsCatalogOnly = isCatalogOnly(current);
  const observationIsCatalogOnly = isCatalogOnly(observation);
  const preferObservationRuntimePath = currentIsCatalogOnly && !observationIsCatalogOnly;
  const root = preferObservationRuntimePath
    ? observation.paths.root ?? current.paths.root
    : current.paths.root ?? observation.paths.root;
  const manifest = preferObservationRuntimePath
    ? observation.paths.manifest ?? current.paths.manifest
    : current.paths.manifest ?? observation.paths.manifest;
  const marketplace = current.paths.marketplace ?? observation.paths.marketplace;
  observations.set(key, {
    ...current,
    ...(current.version ? {} : observation.version ? { version: observation.version } : {}),
    ...(current.description ? {} : observation.description ? { description: observation.description } : {}),
    state: normalizeState([...current.state, ...observation.state]),
    ...(current.source ? {} : observation.source ? { source: observation.source } : {}),
    paths: {
      ...(root ? { root } : {}),
      ...(manifest ? { manifest } : {}),
      ...(marketplace ? { marketplace } : {}),
    },
    components: mergeComponents(current.components, observation.components),
  });
}

async function listDirNames(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function listFileBasenames(dir: string, extensions?: string[]): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !extensions || extensions.some((extension) => name.endsWith(extension)))
    .map((name) => extensions ? name.replace(/\.[^.]+$/, "") : name)
    .sort((left, right) => left.localeCompare(right));
}

async function collectSkillIds(skillsDir: string): Promise<string[]> {
  if (!(await pathExists(skillsDir))) {
    return [];
  }
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (await pathExists(skillPath)) {
      ids.push(entry.name);
    }
  }
  return sortedUnique(ids);
}

async function collectObjectKeysFromJson(pathname: string, key?: string): Promise<string[]> {
  if (!(await pathExists(pathname))) {
    return [];
  }
  try {
    const parsed = await readJsonObject(pathname);
    const target = key ? asObject(parsed?.[key]) : parsed;
    return target ? Object.keys(target).sort((left, right) => left.localeCompare(right)) : [];
  } catch {
    return [];
  }
}

async function collectAppNames(pathname: string): Promise<string[]> {
  if (!(await pathExists(pathname))) {
    return [];
  }
  try {
    const parsed = await readJsonObject(pathname);
    const appMap = asObject(parsed?.apps);
    if (appMap) {
      return Object.keys(appMap).sort((left, right) => left.localeCompare(right));
    }
    const name = asString(parsed?.name) ?? asString(parsed?.id);
    return name ? [name] : [];
  } catch {
    return [];
  }
}

async function collectCodexComponents(root: string, manifest: JsonObject): Promise<PluginComponents> {
  const components = emptyComponents();
  for (const rel of asPathStrings(manifest.skills)) {
    components.skills.push(...await collectSkillIds(path.resolve(root, rel)));
  }
  if (components.skills.length === 0) {
    components.skills.push(...await collectSkillIds(path.join(root, "skills")));
  }

  for (const rel of asPathStrings(manifest.mcpServers)) {
    components.mcpServers.push(...await collectObjectKeysFromJson(path.resolve(root, rel), "mcpServers"));
  }
  if (components.mcpServers.length === 0) {
    components.mcpServers.push(...await collectObjectKeysFromJson(path.join(root, ".mcp.json"), "mcpServers"));
  }

  for (const rel of asPathStrings(manifest.apps)) {
    components.apps.push(...await collectAppNames(path.resolve(root, rel)));
  }
  if (components.apps.length === 0) {
    components.apps.push(...await collectAppNames(path.join(root, ".app.json")));
  }

  components.agents.push(...await listFileBasenames(path.join(root, "agents"), [".yaml", ".yml", ".json", ".md"]));
  components.commands.push(...await listFileBasenames(path.join(root, "commands"), [".md"]));
  if (await pathExists(path.join(root, "hooks", "hooks.json"))) {
    components.hooks.push("hooks");
  }

  return mergeComponents(inlineComponentsFromManifestLike(manifest), components);
}

async function collectClaudeComponents(root: string): Promise<PluginComponents> {
  const components = emptyComponents();
  components.skills.push(...await collectSkillIds(path.join(root, "skills")));
  components.commands.push(...await listFileBasenames(path.join(root, "commands"), [".md"]));
  components.agents.push(...await listFileBasenames(path.join(root, "agents"), [".md"]));
  if (await pathExists(path.join(root, "hooks", "hooks.json"))) {
    components.hooks.push("hooks");
  }
  components.mcpServers.push(...await collectObjectKeysFromJson(path.join(root, ".mcp.json"), "mcpServers"));
  components.lspServers.push(...await collectObjectKeysFromJson(path.join(root, ".lsp.json"), "lspServers"));
  components.monitors.push(...await collectObjectKeysFromJson(path.join(root, "monitors", "monitors.json"), "monitors"));
  components.bin.push(...await listFileBasenames(path.join(root, "bin")));
  if (await pathExists(path.join(root, "settings.json"))) {
    components.settings.push("settings");
  }
  return mergeComponents(emptyComponents(), components);
}

async function findManifestPaths(
  root: string,
  manifestRelativePath: string,
  diagnostics?: PluginInventoryDiagnostic[],
): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      diagnostics?.push({
        severity: "warning",
        code: "plugin_manifest_scan_failed",
        message: `Failed to scan plugin directory: ${error instanceof Error ? error.message : String(error)}`,
        path: current,
      });
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (absolute.endsWith(manifestRelativePath)) {
        results.push(absolute);
      }
    }
  }

  await walk(root);
  return results.sort((left, right) => left.localeCompare(right));
}

function parseEnabledCodexPluginKey(rawKey: string): EnabledPluginRecord {
  const atIndex = rawKey.lastIndexOf("@");
  if (atIndex > 0 && atIndex < rawKey.length - 1) {
    return {
      plugin: rawKey.slice(0, atIndex),
      marketplace: rawKey.slice(atIndex + 1),
    };
  }
  return { plugin: rawKey };
}

async function readCodexEnabledPlugins(configPath: string, diagnostics: PluginInventoryDiagnostic[]): Promise<EnabledPluginRecord[]> {
  if (!(await pathExists(configPath))) {
    return [];
  }
  try {
    const parsed = parseToml(await readFile(configPath, "utf8")) as JsonObject;
    const plugins = asObject(parsed.plugins);
    if (!plugins) {
      return [];
    }
    const enabled: EnabledPluginRecord[] = [];
    for (const [key, value] of Object.entries(plugins)) {
      const pluginConfig = asObject(value);
      if (pluginConfig?.enabled === true) {
        enabled.push(parseEnabledCodexPluginKey(key));
      }
    }
    return enabled.sort((left, right) => left.plugin.localeCompare(right.plugin));
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      code: "codex_config_parse_failed",
      message: `Failed to parse Codex config.toml: ${error instanceof Error ? error.message : String(error)}`,
      path: configPath,
    });
    return [];
  }
}

async function readCodexMarketplace(pathname: string, fallbackName: string): Promise<MarketplaceRecord | undefined> {
  const parsed = await readJsonObject(pathname);
  if (!parsed) {
    return undefined;
  }
  const name = asString(parsed.name) ?? fallbackName;
  const rawPlugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const plugins: MarketplacePluginEntry[] = [];
  for (const rawPlugin of rawPlugins) {
    const plugin = asObject(rawPlugin);
    const pluginName = asString(plugin?.name);
    if (!pluginName) {
      continue;
    }
    const source = await normalizeMarketplaceSource(plugin?.source, pathname);
    const root = source?.kind === "local" ? source.value : undefined;
    const manifestPath = root ? path.join(root, ".codex-plugin", "plugin.json") : undefined;
    const manifest = manifestPath && await pathExists(manifestPath)
      ? await readJsonObject(manifestPath) ?? {}
      : undefined;
    const version = asString(plugin?.version) ?? (manifest ? asString(manifest.version) : undefined);
    const description = asString(plugin?.description) ?? (manifest ? asString(manifest.description) : undefined);
    const components = root && manifest ? await collectCodexComponents(root, manifest) : undefined;
    plugins.push({
      name: pluginName,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      ...(source ? { source } : {}),
      ...(root ? { root } : {}),
      ...(manifestPath && manifest ? { manifest: manifestPath } : {}),
      ...(components ? { components } : {}),
    });
  }
  return { name, path: pathname, plugins };
}

async function readCodexMarketplaces(context: InventoryContext): Promise<MarketplaceRecord[]> {
  const candidates = [
    path.join(context.home, ".agents", "plugins", "marketplace.json"),
    path.join(context.codexHome, ".tmp", "plugins", ".agents", "plugins", "marketplace.json"),
  ];

  const bundledRoot = path.join(context.codexHome, ".tmp", "bundled-marketplaces");
  for (const name of await listDirNames(bundledRoot)) {
    candidates.push(path.join(bundledRoot, name, ".agents", "plugins", "marketplace.json"));
  }

  const records: MarketplaceRecord[] = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    try {
      const fallbackName = path.basename(path.dirname(path.dirname(candidate)));
      const record = await readCodexMarketplace(candidate, fallbackName);
      if (record) {
        records.push(record);
      }
    } catch (error) {
      context.diagnostics.push({
        severity: "warning",
        code: "codex_marketplace_parse_failed",
        message: `Failed to parse Codex marketplace: ${error instanceof Error ? error.message : String(error)}`,
        path: candidate,
      });
    }
  }
  return records;
}

async function collectCodexPlugins(context: InventoryContext): Promise<PluginObservation[]> {
  const observations = new Map<string, PluginObservation>();
  const cacheRoot = path.join(context.codexHome, "plugins", "cache");

  for (const manifestPath of await findManifestPaths(cacheRoot, path.join(".codex-plugin", "plugin.json"), context.diagnostics)) {
    const relParts = path.relative(cacheRoot, manifestPath).split(path.sep);
    const marketplace = relParts[0];
    const root = path.dirname(path.dirname(manifestPath));
    try {
      const manifest = await readJsonObject(manifestPath) ?? {};
      const plugin = asString(manifest.name) ?? relParts[1] ?? path.basename(root);
      const components = await collectCodexComponents(root, manifest);
      const version = asString(manifest.version);
      const description = asString(manifest.description);
      const source = recordSourceFromManifest(manifest);
      upsertObservation(observations, createObservation({
        harness: "codex",
        ...(marketplace ? { marketplace } : {}),
        plugin,
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        state: ["cached"],
        ...(source ? { source } : {}),
        paths: { root, manifest: manifestPath },
        components,
        context,
      }));
    } catch (error) {
      context.diagnostics.push({
        severity: "warning",
        code: "codex_plugin_parse_failed",
        message: `Failed to parse Codex plugin manifest: ${error instanceof Error ? error.message : String(error)}`,
        path: manifestPath,
      });
    }
  }

  for (const marketplace of await readCodexMarketplaces(context)) {
    for (const entry of marketplace.plugins) {
      upsertObservation(observations, createObservation({
        harness: "codex",
        marketplace: marketplace.name,
        plugin: entry.name,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        state: ["cataloged"],
        ...(entry.source ? { source: entry.source } : {}),
        paths: {
          marketplace: marketplace.path,
          ...(entry.root ? { root: entry.root } : {}),
          ...(entry.manifest ? { manifest: entry.manifest } : {}),
        },
        ...(entry.components ? { components: entry.components } : {}),
        context,
      }));
    }
  }

  const enabled = await readCodexEnabledPlugins(path.join(context.codexHome, "config.toml"), context.diagnostics);
  for (const entry of enabled) {
    upsertObservation(observations, createObservation({
      harness: "codex",
      ...(entry.marketplace ? { marketplace: entry.marketplace } : {}),
      plugin: entry.plugin,
      state: ["enabled"],
      context,
    }));
  }

  return [...observations.values()]
    .filter((plugin) => context.includeCatalog || !isCatalogOnly(plugin))
    .sort(comparePlugins);
}

async function readClaudeKnownMarketplaces(
  claudeHome: string,
  marketplaceHome: string,
  diagnostics: PluginInventoryDiagnostic[],
): Promise<MarketplaceRecord[]> {
  const knownPath = path.join(claudeHome, "plugins", "known_marketplaces.json");
  if (!(await pathExists(knownPath))) {
    return [];
  }
  try {
    const parsed = await readJsonObject(knownPath) ?? {};
    const records: MarketplaceRecord[] = [];
    for (const [marketplaceName, rawValue] of Object.entries(parsed)) {
      const config = asObject(rawValue);
      const installLocation = asString(config?.installLocation);
      if (!installLocation) {
        continue;
      }
      const marketplaceRoot = expandHomePath(installLocation, marketplaceHome);
      const marketplaceJsonPath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
      const pluginsByName = new Map<string, MarketplacePluginEntry>();

      if (await pathExists(marketplaceJsonPath)) {
        try {
          const marketplace = await readJsonObject(marketplaceJsonPath) ?? {};
          const rawPlugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
          for (const rawPlugin of rawPlugins) {
            const plugin = asObject(rawPlugin);
            if (!plugin) {
              continue;
            }
            const pluginName = asString(plugin?.name);
            if (!pluginName) {
              continue;
            }
            const source = await normalizeMarketplaceSource(plugin?.source, marketplaceJsonPath);
            const root = source?.kind === "local" ? source.value : undefined;
            const manifestPath = root ? path.join(root, ".claude-plugin", "plugin.json") : undefined;
            const manifest = manifestPath && await pathExists(manifestPath)
              ? await readJsonObject(manifestPath) ?? {}
              : undefined;
            const version = asString(plugin?.version) ?? (manifest ? asString(manifest.version) : undefined);
            const description = asString(plugin?.description) ?? (manifest ? asString(manifest.description) : undefined);
            const inlineComponents = inlineComponentsFromManifestLike(plugin);
            const rootedComponents = root ? await collectClaudeComponents(root) : emptyComponents();
            const manifestComponents = manifest ? inlineComponentsFromManifestLike(manifest) : emptyComponents();
            pluginsByName.set(pluginName, {
              name: pluginName,
              ...(version ? { version } : {}),
              ...(description ? { description } : {}),
              ...(source ? { source } : {}),
              ...(root ? { root } : {}),
              ...(manifestPath && manifest ? { manifest: manifestPath } : {}),
              components: mergeComponents(mergeComponents(inlineComponents, rootedComponents), manifestComponents),
            });
          }
        } catch (error) {
          diagnostics.push({
            severity: "warning",
            code: "claude_marketplace_parse_failed",
            message: `Failed to parse Claude marketplace: ${error instanceof Error ? error.message : String(error)}`,
            path: marketplaceJsonPath,
          });
        }
      }

      for (const manifestPath of await findManifestPaths(marketplaceRoot, path.join(".claude-plugin", "plugin.json"), diagnostics)) {
        try {
          const manifest = await readJsonObject(manifestPath) ?? {};
          const pluginName = asString(manifest.name);
          if (!pluginName) {
            continue;
          }
          const version = asString(manifest.version);
          const description = asString(manifest.description);
          const root = path.dirname(path.dirname(manifestPath));
          const current = pluginsByName.get(pluginName);
          pluginsByName.set(pluginName, {
            ...(current ?? { name: pluginName }),
            name: pluginName,
            ...(version ? { version } : {}),
            ...(description ? { description } : {}),
            source: current?.source ?? { kind: "local", value: root },
            root: current?.root ?? root,
            manifest: current?.manifest ?? manifestPath,
            components: mergeComponents(
              current?.components ?? emptyComponents(),
              mergeComponents(await collectClaudeComponents(root), inlineComponentsFromManifestLike(manifest)),
            ),
          });
        } catch {
          // Keep scanning the marketplace clone even if one plugin manifest is malformed.
        }
      }
      records.push({
        name: marketplaceName,
        path: (await pathExists(marketplaceJsonPath)) ? marketplaceJsonPath : marketplaceRoot,
        plugins: [...pluginsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
      });
    }
    return records;
  } catch (error) {
    diagnostics.push({
      severity: "warning",
      code: "claude_known_marketplaces_parse_failed",
      message: `Failed to parse Claude known_marketplaces.json: ${error instanceof Error ? error.message : String(error)}`,
      path: knownPath,
    });
    return [];
  }
}

async function collectClaudePlugins(context: InventoryContext): Promise<PluginObservation[]> {
  const observations = new Map<string, PluginObservation>();
  const cacheRoot = path.join(context.claudeHome, "plugins", "cache");

  for (const manifestPath of await findManifestPaths(cacheRoot, path.join(".claude-plugin", "plugin.json"), context.diagnostics)) {
    const relParts = path.relative(cacheRoot, manifestPath).split(path.sep);
    const marketplace = relParts[0];
    const root = path.dirname(path.dirname(manifestPath));
    try {
      const manifest = await readJsonObject(manifestPath) ?? {};
      const plugin = asString(manifest.name) ?? relParts[1] ?? path.basename(root);
      const version = asString(manifest.version) ?? relParts[2];
      const description = asString(manifest.description);
      const source = recordSourceFromManifest(manifest);
      upsertObservation(observations, createObservation({
        harness: "claude",
        ...(marketplace ? { marketplace } : {}),
        plugin,
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        state: ["installed"],
        ...(source ? { source } : {}),
        paths: { root, manifest: manifestPath },
        components: await collectClaudeComponents(root),
        context,
      }));
    } catch (error) {
      context.diagnostics.push({
        severity: "warning",
        code: "claude_plugin_parse_failed",
        message: `Failed to parse Claude plugin manifest: ${error instanceof Error ? error.message : String(error)}`,
        path: manifestPath,
      });
    }
  }

  for (const marketplace of await readClaudeKnownMarketplaces(context.claudeHome, context.claudeMarketplaceHome, context.diagnostics)) {
    for (const entry of marketplace.plugins) {
      upsertObservation(observations, createObservation({
        harness: "claude",
        marketplace: marketplace.name,
        plugin: entry.name,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        state: ["cataloged"],
        ...(entry.source ? { source: entry.source } : {}),
        paths: {
          marketplace: marketplace.path,
          ...(entry.root ? { root: entry.root } : {}),
          ...(entry.manifest ? { manifest: entry.manifest } : {}),
        },
        ...(entry.components ? { components: entry.components } : {}),
        context,
      }));
    }
  }

  return [...observations.values()]
    .filter((plugin) => context.includeCatalog || !isCatalogOnly(plugin))
    .sort(comparePlugins);
}

function isCatalogOnly(plugin: PluginObservation): boolean {
  return plugin.state.length === 1 && plugin.state[0] === "cataloged";
}

function comparePlugins(left: PluginObservation, right: PluginObservation): number {
  return (
    left.harness.localeCompare(right.harness) ||
    (left.marketplace ?? "").localeCompare(right.marketplace ?? "") ||
    left.plugin.localeCompare(right.plugin) ||
    (left.version ?? "").localeCompare(right.version ?? "")
  );
}

function selectedHarnesses(selector: PluginHarnessSelector | undefined): PluginHarness[] {
  if (selector === "codex" || selector === "claude") {
    return [selector];
  }
  return ["codex", "claude"];
}

function summarizePlugins(plugins: PluginObservation[]): PluginsInventoryResult["summary"] {
  const byHarness: Record<PluginHarness, number> = { codex: 0, claude: 0 };
  const byState: Record<PluginObservationState, number> = {
    cataloged: 0,
    cached: 0,
    enabled: 0,
    installed: 0,
    active: 0,
  };

  for (const plugin of plugins) {
    byHarness[plugin.harness] += 1;
    for (const state of plugin.state) {
      byState[state] += 1;
    }
  }

  return {
    total: plugins.length,
    byHarness,
    byState,
  };
}

function resolveContext(options: PluginsInventoryOptions): InventoryContext {
  const home = path.resolve(expandHomePath(options.home ?? homedir()));
  const defaultCodexHome = options.home
    ? path.join(home, ".codex")
    : process.env["CODEX_HOME"] ?? path.join(home, ".codex");
  const codexHome = path.resolve(expandHomePath(options.codexHome ?? defaultCodexHome, home));
  const claudeHome = path.resolve(expandHomePath(options.claudeHome ?? path.join(home, ".claude"), home));
  const claudeMarketplaceHome = options.home
    ? home
    : options.claudeHome && path.basename(claudeHome) === ".claude"
      ? path.dirname(claudeHome)
      : home;
  return {
    home,
    codexHome,
    claudeHome,
    claudeMarketplaceHome,
    observedAt: options.observedAt ?? new Date().toISOString(),
    host: systemHostname().trim().split(".")[0] ?? systemHostname(),
    includeCatalog: Boolean(options.includeCatalog),
    diagnostics: [],
  };
}

export async function listPlugins(options: PluginsInventoryOptions = {}): Promise<PluginsInventoryResult> {
  const context = resolveContext(options);
  const harnesses = selectedHarnesses(options.harness);
  const plugins: PluginObservation[] = [];
  for (const harness of harnesses) {
    plugins.push(...await (harness === "codex" ? collectCodexPlugins(context) : collectClaudePlugins(context)));
  }
  plugins.sort(comparePlugins);

  return {
    schemaVersion: "plugins.inventory/v1",
    generatedAt: context.observedAt,
    home: context.home,
    codexHome: context.codexHome,
    claudeHome: context.claudeHome,
    harnesses,
    includeCatalog: context.includeCatalog,
    plugins,
    diagnostics: context.diagnostics,
    summary: summarizePlugins(plugins),
  };
}

export async function showPlugin(ref: string, options: PluginsInventoryOptions = {}): Promise<PluginsShowResult> {
  const inventory = await listPlugins({ ...options, includeCatalog: options.includeCatalog ?? true });
  const query = parsePluginRef(ref);
  const matches = inventory.plugins.filter((plugin) => {
    if (plugin.plugin !== query.plugin) {
      return false;
    }
    return query.marketplace ? plugin.marketplace === query.marketplace : true;
  });
  return {
    schemaVersion: "plugins.show/v1",
    generatedAt: inventory.generatedAt,
    query: ref,
    matches,
  };
}

export async function tracePluginComponent(
  component: string,
  options: PluginsTraceOptions = {},
): Promise<PluginsTraceResult> {
  const inventory = await listPlugins({ ...options, includeCatalog: options.includeCatalog ?? true });
  const componentKinds: PluginComponentKind[] = options.kind
    ? [options.kind]
    : [...PLUGIN_COMPONENT_KINDS];
  const matches = [];
  for (const plugin of inventory.plugins) {
    for (const kind of componentKinds) {
      for (const candidate of plugin.components[kind]) {
        if (candidate === component) {
          matches.push({ component: candidate, kind, plugin });
        }
      }
    }
  }
  return {
    schemaVersion: "plugins.trace/v1",
    generatedAt: inventory.generatedAt,
    query: component,
    ...(options.kind ? { kind: options.kind } : {}),
    matches,
  };
}

function pluginRef(plugin: PluginObservation): string {
  return plugin.marketplace ? `${plugin.plugin}@${plugin.marketplace}` : plugin.plugin;
}

export async function doctorPlugins(options: PluginsInventoryOptions = {}): Promise<PluginsDoctorResult> {
  const inventory = await listPlugins({ ...options, includeCatalog: true });
  const issues: PluginDoctorIssue[] = [];

  for (const diagnostic of inventory.diagnostics) {
    issues.push({
      severity: diagnostic.severity,
      code: "inventory_error",
      message: diagnostic.message,
      ...(diagnostic.path ? { paths: [diagnostic.path] } : {}),
    });
  }

  for (const plugin of inventory.plugins) {
    if (plugin.harness === "codex" && plugin.state.includes("enabled") && !plugin.state.includes("cached")) {
      issues.push({
        severity: "error",
        code: "enabled_missing_cache",
        message: `Codex plugin ${pluginRef(plugin)} is enabled but no cached manifest was found.`,
        harness: plugin.harness,
        ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
        plugin: plugin.plugin,
      });
    }
    if (isCatalogOnly(plugin)) {
      issues.push({
        severity: "info",
        code: "catalog_only",
        message: `${plugin.harness} plugin ${pluginRef(plugin)} is cataloged but not installed/cached.`,
        harness: plugin.harness,
        ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
        plugin: plugin.plugin,
      });
    }
  }

  const componentOwners = new Map<string, PluginObservation[]>();
  const duplicateCheckedKinds: PluginComponentKind[] = [
    "skills",
    "mcpServers",
    "apps",
    "hooks",
    "agents",
    "commands",
    "lspServers",
    "monitors",
    "bin",
    "settings",
  ];
  for (const plugin of inventory.plugins.filter((entry) => !isCatalogOnly(entry))) {
    for (const kind of duplicateCheckedKinds) {
      for (const component of plugin.components[kind]) {
        const key = `${kind}\0${component}`;
        componentOwners.set(key, [...(componentOwners.get(key) ?? []), plugin]);
      }
    }
  }
  for (const [key, owners] of componentOwners.entries()) {
    if (owners.length < 2) {
      continue;
    }
    const [kind, component] = key.split("\0") as [PluginComponentKind, string];
    issues.push({
      severity: "warning",
      code: "duplicate_component",
      message: `${kind} component "${component}" is provided by multiple plugins: ${owners.map(pluginRef).join(", ")}.`,
      component,
      kind,
      paths: owners.map((owner) => owner.paths.root ?? owner.paths.manifest ?? owner.paths.marketplace ?? pluginRef(owner)),
    });
  }

  const counts = {
    total: issues.length,
    info: issues.filter((issue) => issue.severity === "info").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    error: issues.filter((issue) => issue.severity === "error").length,
  };

  return {
    schemaVersion: "plugins.doctor/v1",
    generatedAt: inventory.generatedAt,
    ok: counts.error === 0,
    inventory,
    issues,
    summary: counts,
  };
}
