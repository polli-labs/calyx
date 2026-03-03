import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  compileFromFiles,
  compareTomlSemantics,
  deployAgentsRegistry,
  discoverExtensions,
  loadExtension,
  getExecLogs,
  getExecReceipt,
  getExecStatus,
  indexAgentsRegistry,
  indexKnowledgeRegistry,
  indexPromptsRegistry,
  indexSkillsRegistry,
  indexToolsRegistry,
  launchExecRun,
  linkKnowledgeArtifact,
  renderAgentProfiles,
  renderInstructionsFromFiles,
  requireSourcePath,
  searchKnowledgeRegistry,
  showConfig,
  syncAgentsRegistry,
  syncPromptsRegistry,
  syncSkillsRegistry,
  syncToolsRegistry,
  validateAgentsRegistry,
  validateExecStore,
  validateKnowledgeRegistry,
  validatePromptsRegistry,
  validateSkillsRegistry,
  validateToolsRegistry,
  verifyInstructionsFromFiles,
  WRAPPER_REGISTRY,
  getDeferredWrapperMessage,
  getRetiredWrapperMessage
} from "@polli-labs/calyx-core";
import type {
  AgentDeployBackend,
  DomainSyncAction,
  DomainValidationIssue,
  ExtensionDiagnostic,
  KnowledgeArtifactKind,
  PromptBackend,
  SourceDomain,
  SyncBackend,
  ToolsSyncOptions
} from "@polli-labs/calyx-core";

interface CompileCommandOptions {
  fleet: string;
  hostsDir: string;
  host: string;
  out?: string;
  mode: "strict" | "advisory";
  write?: boolean;
  parity?: string;
  json?: boolean;
}

interface InstructionsBaseCommandOptions {
  fleet: string;
  hostsDir: string;
  host?: string;
  all?: boolean;
  template: string;
  partialsDir: string;
  outDir?: string;
  json?: boolean;
}

interface InstructionsVerifyCommandOptions extends InstructionsBaseCommandOptions {
  expectedDir: string;
}

interface SkillsIndexCommandOptions {
  registry?: string;
  includeArchived?: boolean;
  excludeDeprecated?: boolean;
  json?: boolean;
}

interface SkillsSyncCommandOptions extends SkillsIndexCommandOptions {
  backend: string;
  apply?: boolean;
  pruneDeprecated?: boolean;
}

interface SkillsValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface ToolsIndexCommandOptions {
  registry?: string;
  json?: boolean;
}

interface ToolsSyncCommandOptions extends ToolsIndexCommandOptions {
  host?: string;
  all?: boolean;
  apply?: boolean;
}

interface ToolsValidateCommandOptions extends ToolsIndexCommandOptions {
  strict?: boolean;
}

interface PromptsIndexCommandOptions {
  registry?: string;
  json?: boolean;
}

interface PromptsSyncCommandOptions extends PromptsIndexCommandOptions {
  backend: string;
  apply?: boolean;
}

interface PromptsValidateCommandOptions extends PromptsIndexCommandOptions {
  strict?: boolean;
}

interface AgentsIndexCommandOptions {
  registry?: string;
  includeArchived?: boolean;
  excludeDeprecated?: boolean;
  json?: boolean;
}

interface AgentsRenderProfilesCommandOptions extends AgentsIndexCommandOptions {
  format?: string;
}

interface AgentsDeployCommandOptions extends AgentsIndexCommandOptions {
  backend: string;
  apply?: boolean;
}

interface AgentsSyncCommandOptions extends AgentsIndexCommandOptions {
  backend: string;
  apply?: boolean;
}

interface AgentsValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface KnowledgeIndexCommandOptions {
  registry?: string;
  kind?: string;
  json?: boolean;
}

interface KnowledgeSearchCommandOptions {
  registry?: string;
  query: string;
  kind?: string;
  tags?: string;
  json?: boolean;
}

interface KnowledgeLinkCommandOptions {
  registry?: string;
  artifact: string;
  issue: string;
  apply?: boolean;
  json?: boolean;
}

interface KnowledgeValidateCommandOptions {
  registry?: string;
  strict?: boolean;
  json?: boolean;
}

interface ExecLaunchCommandOptions {
  store?: string;
  command: string;
  apply?: boolean;
  json?: boolean;
}

interface ExecStatusCommandOptions {
  store?: string;
  runId: string;
  json?: boolean;
}

interface ExecLogsCommandOptions {
  store?: string;
  runId: string;
  level?: string;
  tail?: string;
  json?: boolean;
}

interface ExecReceiptCommandOptions {
  store?: string;
  runId: string;
  json?: boolean;
}

interface ExecValidateCommandOptions {
  store?: string;
  strict?: boolean;
  json?: boolean;
}

interface ConfigShowCommandOptions {
  json?: boolean;
}

interface ExtensionsListCommandOptions {
  searchPath?: string[];
  json?: boolean;
}

interface ExtensionsValidateCommandOptions extends ExtensionsListCommandOptions {
  strict?: boolean;
}

interface ExtensionsCheckCommandOptions {
  path: string;
  json?: boolean;
}

interface CliError extends Error {
  exitCode?: number;
}

function createCliError(message: string, exitCode: number): CliError {
  const error = new Error(message) as CliError;
  error.exitCode = exitCode;
  return error;
}

function parseSkillsBackend(rawValue: string): SyncBackend {
  const value = rawValue.trim().toLowerCase();
  if (value === "claude" || value === "codex" || value === "agents" || value === "all") {
    return value;
  }

  throw createCliError(`Invalid --backend value for skills sync: ${rawValue}`, 2);
}

function parsePromptsBackend(rawValue: string): PromptBackend {
  const value = rawValue.trim().toLowerCase();
  if (value === "claude" || value === "codex" || value === "all") {
    return value;
  }

  throw createCliError(`Invalid --backend value for prompts sync: ${rawValue}`, 2);
}

function parseAgentsBackend(rawValue: string): AgentDeployBackend {
  const value = rawValue.trim().toLowerCase();
  if (value === "claude" || value === "codex" || value === "all") {
    return value;
  }

  throw createCliError(`Invalid --backend value for agents sync: ${rawValue}`, 2);
}

function parseKnowledgeKind(rawValue: string): KnowledgeArtifactKind {
  const value = rawValue.trim().toLowerCase();
  if (value === "execplan" || value === "transcript" || value === "report" || value === "runbook" || value === "reference") {
    return value;
  }

  throw createCliError(`Invalid --kind value: ${rawValue}. Must be one of: execplan, transcript, report, runbook, reference.`, 2);
}

function parseLogLevel(rawValue: string): "info" | "warn" | "error" {
  const value = rawValue.trim().toLowerCase();
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }

  throw createCliError(`Invalid --level value: ${rawValue}. Must be one of: info, warn, error.`, 2);
}

function issueText(issue: DomainValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

function printValidationIssues(domain: string, issues: DomainValidationIssue[], level: "error" | "warning"): void {
  if (issues.length === 0) {
    return;
  }

  const label = level === "error" ? "errors" : "warnings";
  console.error(`[${domain}] ${label}:`);
  for (const issue of issues) {
    console.error(`- (${issue.code}) ${issueText(issue)}`);
  }
}

function printSyncActions(domain: string, actions: DomainSyncAction[]): void {
  for (const action of actions) {
    console.error(`[${domain}] ${action.action} ${action.id} (${action.details})`);
  }
}

function normalizeToolsSyncTarget(options: ToolsSyncCommandOptions): ToolsSyncOptions {
  if (options.host && options.all) {
    throw createCliError("tools sync accepts either --host <alias> or --all, not both.", 2);
  }

  return {
    ...(options.host ? { host: options.host } : {}),
    all: Boolean(options.all),
    apply: Boolean(options.apply)
  };
}

/**
 * Resolve a source path for a domain using production wiring precedence:
 * CLI flag > env var > config file.
 */
async function resolve(domain: SourceDomain, cliValue?: string): Promise<string> {
  return requireSourcePath(domain, { cliValue });
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program.name("calyx").description("Calyx control plane CLI").version("0.1.0");

  const config = new Command("config").description("Config compiler commands");

  config
    .command("compile")
    .description("Compile fleet/host YAML inputs to Codex TOML")
    .requiredOption("--fleet <path>", "Path to fleet.v2.yaml")
    .requiredOption("--hosts-dir <path>", "Path to hosts directory")
    .requiredOption("--host <host>", "Host key to compile")
    .option("--out <path>", "Write output TOML path")
    .option("--mode <mode>", "Validation mode (strict|advisory)", "strict")
    .option("--write", "Write TOML to --out path")
    .option("--parity <path>", "Expected TOML fixture path for semantic parity check")
    .option("--json", "Print machine-readable summary")
    .action(async (options: CompileCommandOptions) => {
      const hostPath = `${options.hostsDir}/${options.host}.yaml`;
      const compileOptions = {
        mode: options.mode,
        write: Boolean(options.write),
        ...(options.out ? { outputPath: options.out } : {})
      };
      const result = await compileFromFiles(
        {
          fleetPath: options.fleet,
          hostPath
        },
        compileOptions
      );

      let parity: { equal: boolean; reason?: string } | undefined;
      if (options.parity) {
        const expectedToml = await readFile(options.parity, "utf8");
        parity = compareTomlSemantics(result.tomlText, expectedToml);
        if (parity && !parity.equal) {
          throw new Error(`Semantic parity failed: ${parity.reason}`);
        }
      }

      if (options.json) {
        const payload = {
          host: options.host,
          warnings: result.warnings,
          wrote: Boolean(options.write && options.out),
          outputPath: options.out ?? null,
          parity
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!options.write) {
        process.stdout.write(result.tomlText);
      }

      if (result.warnings.length > 0) {
        console.error(`Validation warnings (${options.mode}):\n- ${result.warnings.join("\n- ")}`);
      }

      if (parity?.equal) {
        console.error(`Semantic parity OK for ${options.host}.`);
      }
    });

  config
    .command("show")
    .description("Show resolved source paths for all domains (config/env/defaults)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ConfigShowCommandOptions) => {
      const result = await showConfig();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.configPath) {
        console.error(`Config file: ${result.configPath} (source: ${result.configSource})`);
      } else {
        console.error("Config file: not found");
      }

      console.error("");
      for (const [domain, info] of Object.entries(result.resolved)) {
        const pathStr = info.path ?? "(not configured)";
        console.log(`${domain}\t${pathStr}\t[${info.source}]`);
      }
    });

  const instructions = new Command("instructions").description("Instructions rendering and parity commands");

  instructions
    .command("render")
    .description("Render instruction templates with deterministic token + partial semantics")
    .requiredOption("--fleet <path>", "Path to fleet instructions YAML")
    .requiredOption("--hosts-dir <path>", "Path to host instructions directory")
    .requiredOption("--template <path>", "Path to instruction template (*.md.mustache)")
    .requiredOption("--partials-dir <path>", "Path to partial templates directory")
    .option("--host <host>", "Host alias to render")
    .option("--all", "Render all hosts under --hosts-dir")
    .option("--out-dir <path>", "Write rendered output files to this directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsBaseCommandOptions) => {
      const renderOptions = {
        all: Boolean(options.all),
        ...(options.host ? { host: options.host } : {}),
        ...(options.outDir ? { outputDir: options.outDir } : {})
      };
      const renderResult = await renderInstructionsFromFiles(
        {
          fleetPath: options.fleet,
          hostsDir: options.hostsDir,
          templatePath: options.template,
          partialsDir: options.partialsDir
        },
        renderOptions
      );

      if (options.json) {
        console.log(JSON.stringify(renderResult, null, 2));
        return;
      }

      const firstResult = renderResult.results[0];
      if (!options.outDir && renderResult.results.length === 1 && firstResult) {
        process.stdout.write(firstResult.output);
      }

      if (options.outDir) {
        for (const hostResult of renderResult.results) {
          if (hostResult.outputPath) {
            console.error(`Rendered ${hostResult.host} -> ${hostResult.outputPath}`);
          }
        }
      }

      for (const hostResult of renderResult.results) {
        if (hostResult.missingPartials.length > 0) {
          console.error(`[${hostResult.host}] Missing partials: ${hostResult.missingPartials.join(", ")}`);
        }
        if (hostResult.unresolvedTokens.length > 0) {
          console.error(`[${hostResult.host}] Unresolved tokens: ${hostResult.unresolvedTokens.join(", ")}`);
        }
      }
    });

  instructions
    .command("verify")
    .description("Verify rendered instruction outputs against expected fixtures")
    .requiredOption("--fleet <path>", "Path to fleet instructions YAML")
    .requiredOption("--hosts-dir <path>", "Path to host instructions directory")
    .requiredOption("--template <path>", "Path to instruction template (*.md.mustache)")
    .requiredOption("--partials-dir <path>", "Path to partial templates directory")
    .requiredOption("--expected-dir <path>", "Path to expected rendered outputs")
    .option("--host <host>", "Host alias to verify")
    .option("--all", "Verify all hosts under --hosts-dir")
    .option("--out-dir <path>", "Write rendered output files to this directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: InstructionsVerifyCommandOptions) => {
      const verifyOptions = {
        expectedDir: options.expectedDir,
        all: Boolean(options.all),
        ...(options.host ? { host: options.host } : {}),
        ...(options.outDir ? { outputDir: options.outDir } : {})
      };
      const verifyResult = await verifyInstructionsFromFiles(
        {
          fleetPath: options.fleet,
          hostsDir: options.hostsDir,
          templatePath: options.template,
          partialsDir: options.partialsDir
        },
        verifyOptions
      );

      if (options.json) {
        console.log(JSON.stringify(verifyResult, null, 2));
      } else if (verifyResult.ok) {
        console.error(`Instruction verify OK (${verifyResult.results.length} host(s)).`);
      } else {
        for (const drift of verifyResult.drifts) {
          console.error(`[${drift.host}] drift: ${drift.reason} (${drift.expectedPath})`);
        }
      }

      if (!verifyResult.ok) {
        throw createCliError(`Instruction verify failed for ${verifyResult.drifts.length} drift(s).`, 3);
      }
    });

  const skills = new Command("skills").description("Skills registry index/sync/validate commands");

  skills
    .command("index")
    .description("Index skills from a registry")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--include-archived", "Include archived skills in index output")
    .option("--exclude-deprecated", "Exclude deprecated skills from index output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsIndexCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const result = await indexSkillsRegistry(registryPath, {
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const skill of result.items) {
        const status = skill.status ?? "active";
        console.log(`${skill.id}\t${status}`);
      }
      console.error(`Indexed ${result.items.length}/${result.total} skills from ${registryPath}.`);
    });

  skills
    .command("sync")
    .description("Sync skills from a registry into target backend(s)")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--backend <backend>", "Sync backend (claude|codex|agents|all)", "all")
    .option("--include-archived", "Include archived skills")
    .option("--exclude-deprecated", "Exclude deprecated skills")
    .option("--prune-deprecated", "Plan or apply prune actions for deprecated skills")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsSyncCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const backend = parseSkillsBackend(options.backend);
      const result = await syncSkillsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply),
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated,
        pruneDeprecated: Boolean(options.pruneDeprecated)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("skills", result.actions);
      console.error(
        `Skills sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for backend=${result.backend}.`
      );
    });

  skills
    .command("validate")
    .description("Validate skills registry structure and lifecycle constraints")
    .option("--registry <path>", "Path to skills registry JSON (or set CALYX_SKILLS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsValidateCommandOptions) => {
      const registryPath = await resolve("skills", options.registry);
      const result = await validateSkillsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Skills validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, active=${result.active}, deprecated=${result.deprecated}, archived=${result.archived}.`
        );
        printValidationIssues("skills", result.warnings, "warning");
        printValidationIssues("skills", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`skills validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const tools = new Command("tools").description("Tools registry index/sync/validate commands");

  tools
    .command("index")
    .description("Index tools from a registry")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsIndexCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const result = await indexToolsRegistry(registryPath);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const tool of result.items) {
        console.log(`${tool.name}\t${tool.version}`);
      }
      console.error(`Indexed ${result.items.length} tools from ${registryPath}.`);
    });

  tools
    .command("sync")
    .description("Sync tools from a registry into host targets")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--host <alias>", "Single host alias to target")
    .option("--all", "Sync all known hosts")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsSyncCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const syncOptions = normalizeToolsSyncTarget(options);
      const result = await syncToolsRegistry(registryPath, syncOptions);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("tools", result.actions);
      console.error(`Tools sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for ${result.target}.`);
    });

  tools
    .command("validate")
    .description("Validate tools registry structure and version metadata")
    .option("--registry <path>", "Path to tools registry JSON (or set CALYX_TOOLS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsValidateCommandOptions) => {
      const registryPath = await resolve("tools", options.registry);
      const result = await validateToolsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Tools validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("tools", result.warnings, "warning");
        printValidationIssues("tools", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`tools validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const prompts = new Command("prompts").description("Prompts registry index/sync/validate commands");

  prompts
    .command("index")
    .description("Index prompts from a registry")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsIndexCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const result = await indexPromptsRegistry(registryPath);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const prompt of result.items) {
        console.log(`${prompt.id}\t${prompt.template_path}`);
      }
      console.error(`Indexed ${result.items.length} prompts from ${registryPath}.`);
    });

  prompts
    .command("sync")
    .description("Sync prompts from a registry into backend targets")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--backend <backend>", "Sync backend (claude|codex|all)", "all")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsSyncCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const backend = parsePromptsBackend(options.backend);
      const result = await syncPromptsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("prompts", result.actions);
      console.error(
        `Prompts sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for backend=${result.backend}.`
      );
    });

  prompts
    .command("validate")
    .description("Validate prompts registry structure and variable contracts")
    .option("--registry <path>", "Path to prompts registry JSON (or set CALYX_PROMPTS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsValidateCommandOptions) => {
      const registryPath = await resolve("prompts", options.registry);
      const result = await validatePromptsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Prompts validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("prompts", result.warnings, "warning");
        printValidationIssues("prompts", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`prompts validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const agents = new Command("agents").description("Agents registry index/sync/validate commands");

  agents
    .command("index")
    .description("Index agents from a registry")
    .option("--registry <path>", "Path to agents registry JSON (or set CALYX_AGENTS_REGISTRY)")
    .option("--include-archived", "Include archived agents in index output")
    .option("--exclude-deprecated", "Exclude deprecated agents from index output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsIndexCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await indexAgentsRegistry(registryPath, {
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const agent of result.items) {
        const status = agent.status ?? "active";
        console.log(`${agent.id}\t${agent.name}\t${status}`);
      }
      console.error(`Indexed ${result.items.length}/${result.total} agents from ${registryPath}.`);
    });

  agents
    .command("render-profiles")
    .description("Render agent profiles from a registry (id, name, status, hosts, capabilities)")
    .option("--registry <path>", "Path to agents registry JSON (or set CALYX_AGENTS_REGISTRY)")
    .option("--include-archived", "Include archived agents in profile output")
    .option("--exclude-deprecated", "Exclude deprecated agents from profile output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsRenderProfilesCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await renderAgentProfiles(registryPath, {
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const profile of result.profiles) {
        const hosts = profile.hosts.map((h) => `${h.host}${h.role ? `(${h.role})` : ""}`).join(", ") || "none";
        const caps = profile.capabilities.join(", ") || "none";
        console.log(`${profile.id}\t${profile.name}\t${profile.status}\thosts=${hosts}\tcapabilities=${caps}`);
      }
      console.error(`Rendered ${result.profiles.length}/${result.total} agent profiles from ${registryPath}.`);
    });

  agents
    .command("deploy")
    .description("Deploy agents from a registry into target backend(s) (plan/apply)")
    .option("--registry <path>", "Path to agents registry JSON (or set CALYX_AGENTS_REGISTRY)")
    .option("--backend <backend>", "Deploy backend (claude|codex|all)", "all")
    .option("--include-archived", "Include archived agents")
    .option("--exclude-deprecated", "Exclude deprecated agents")
    .option("--apply", "Apply deploy actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsDeployCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const backend = parseAgentsBackend(options.backend);
      const result = await deployAgentsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply),
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("agents", result.actions);
      console.error(
        `Agents deploy ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for backend=${result.backend}.`
      );
    });

  agents
    .command("sync")
    .description("Sync agents from a registry into target backend(s)")
    .option("--registry <path>", "Path to agents registry JSON (or set CALYX_AGENTS_REGISTRY)")
    .option("--backend <backend>", "Deploy backend (claude|codex|all)", "all")
    .option("--include-archived", "Include archived agents")
    .option("--exclude-deprecated", "Exclude deprecated agents")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsSyncCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const backend = parseAgentsBackend(options.backend);
      const result = await syncAgentsRegistry(registryPath, {
        backend,
        apply: Boolean(options.apply),
        includeArchived: Boolean(options.includeArchived),
        includeDeprecated: !options.excludeDeprecated
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printSyncActions("agents", result.actions);
      console.error(
        `Agents sync ${result.apply ? "apply" : "plan"} generated ${result.actions.length} action(s) for backend=${result.backend}.`
      );
    });

  agents
    .command("validate")
    .description("Validate agents registry structure and lifecycle constraints")
    .option("--registry <path>", "Path to agents registry JSON (or set CALYX_AGENTS_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: AgentsValidateCommandOptions) => {
      const registryPath = await resolve("agents", options.registry);
      const result = await validateAgentsRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Agents validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, active=${result.active}, deprecated=${result.deprecated}, archived=${result.archived}.`
        );
        printValidationIssues("agents", result.warnings, "warning");
        printValidationIssues("agents", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`agents validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const knowledge = new Command("knowledge").description("Knowledge artifact index/search/link/validate commands");

  knowledge
    .command("index")
    .description("Index knowledge artifacts from a registry")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .option("--kind <kind>", "Filter by artifact kind")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeIndexCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await indexKnowledgeRegistry(registryPath, {
        ...(options.kind ? { kind: parseKnowledgeKind(options.kind) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const artifact of result.items) {
        console.log(`${artifact.id}\t${artifact.kind}\t${artifact.title}`);
      }
      console.error(`Indexed ${result.items.length}/${result.total} artifacts from ${registryPath}.`);
    });

  knowledge
    .command("search")
    .description("Search knowledge artifacts by query")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .requiredOption("--query <query>", "Search query string")
    .option("--kind <kind>", "Filter by artifact kind")
    .option("--tags <tags>", "Comma-separated tag filter")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeSearchCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await searchKnowledgeRegistry(registryPath, {
        query: options.query,
        ...(options.kind ? { kind: parseKnowledgeKind(options.kind) } : {}),
        ...(options.tags ? { tags: options.tags.split(",").map((t) => t.trim()) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const artifact of result.items) {
        console.log(`${artifact.id}\t${artifact.kind}\t${artifact.title}`);
      }
      console.error(`Found ${result.total} artifact(s) matching "${result.query}".`);
    });

  knowledge
    .command("link")
    .description("Link a knowledge artifact to a Linear issue")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .requiredOption("--artifact <id>", "Artifact ID to link")
    .requiredOption("--issue <id>", "Linear issue ID to link to")
    .option("--apply", "Apply the link action")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeLinkCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await linkKnowledgeArtifact(registryPath, {
        artifactId: options.artifact,
        issueId: options.issue,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(`[knowledge] ${result.action} ${result.artifactId} -> ${result.issueId}`);
    });

  knowledge
    .command("validate")
    .description("Validate knowledge registry structure and artifact contracts")
    .option("--registry <path>", "Path to knowledge registry JSON (or set CALYX_KNOWLEDGE_REGISTRY)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: KnowledgeValidateCommandOptions) => {
      const registryPath = await resolve("knowledge", options.registry);
      const result = await validateKnowledgeRegistry(registryPath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(`Knowledge validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}.`);
        printValidationIssues("knowledge", result.warnings, "warning");
        printValidationIssues("knowledge", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`knowledge validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  const exec = new Command("exec").description("Execution lifecycle commands (launch/status/logs/receipt)");

  exec
    .command("launch")
    .description("Launch a new execution run (plan/apply)")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--command <command>", "Command string to launch")
    .option("--apply", "Apply the launch (create a real run record)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecLaunchCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await launchExecRun(storePath, {
        command: options.command,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.error(
        `[exec] ${result.apply ? "launched" : "plan-launch"} run ${result.run_id}: command="${result.command}", state=${result.state}`
      );
    });

  exec
    .command("status")
    .description("Get status of an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecStatusCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecStatus(storePath, {
        run_id: options.runId
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const parts = [`${result.run_id}: ${result.state}`];
      if (result.exit_code !== undefined) {
        parts.push(`exit_code=${result.exit_code}`);
      }
      if (result.error) {
        parts.push(`error: ${result.error}`);
      }
      console.log(parts.join(", "));
    });

  exec
    .command("logs")
    .description("View logs of an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--level <level>", "Filter by log level (info|warn|error)")
    .option("--tail <n>", "Show only the last N log entries")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecLogsCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecLogs(storePath, {
        run_id: options.runId,
        ...(options.level ? { level: parseLogLevel(options.level) } : {}),
        ...(options.tail ? { tail: parseInt(options.tail, 10) } : {})
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const entry of result.entries) {
        console.log(`[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`);
      }
      console.error(`${result.total} log entries for run ${result.run_id}.`);
    });

  exec
    .command("receipt")
    .description("Generate a receipt for an execution run")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .requiredOption("--run-id <id>", "Run ID to query")
    .option("--json", "Print machine-readable JSON receipt")
    .action(async (options: ExecReceiptCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await getExecReceipt(storePath, {
        run_id: options.runId
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.summary);
      console.log(`  command: ${result.command}`);
      console.log(`  created: ${result.created_at}`);
      if (result.started_at) {
        console.log(`  started: ${result.started_at}`);
      }
      if (result.completed_at) {
        console.log(`  completed: ${result.completed_at}`);
      }
      if (result.duration_ms !== undefined) {
        console.log(`  duration: ${result.duration_ms}ms`);
      }
      console.log(`  logs: ${result.log_summary.total} total (${result.log_summary.info} info, ${result.log_summary.warn} warn, ${result.log_summary.error} error)`);
    });

  exec
    .command("validate")
    .description("Validate exec run store structure and lifecycle constraints")
    .option("--store <path>", "Path to exec run store JSON (or set CALYX_EXEC_STORE)")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExecValidateCommandOptions) => {
      const storePath = await resolve("exec", options.store);
      const result = await validateExecStore(storePath, {
        strict: Boolean(options.strict)
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Exec validate ${result.ok ? "OK" : "FAILED"}: total=${result.total}, queued=${result.queued}, running=${result.running}, succeeded=${result.succeeded}, failed=${result.failed}, cancelled=${result.cancelled}.`
        );
        printValidationIssues("exec", result.warnings, "warning");
        printValidationIssues("exec", result.errors, "error");
      }

      if (!result.ok) {
        throw createCliError(`exec validate failed with ${result.errors.length} error(s).`, 3);
      }
    });

  // ── Retired wrapper tombstones ──────────────────────────────────────
  // Wrappers retired in P9. Emit a clear "removed" message pointing to
  // the canonical command, with exit code 6.

  for (const def of WRAPPER_REGISTRY.filter((d) => d.status === "retired")) {
    program
      .command(def.wrapper)
      .description(`[retired] Removed in ${def.phase} — use: ${def.target}`)
      .allowUnknownOption(true)
      .action(() => {
        const message = getRetiredWrapperMessage(def.wrapper);
        throw createCliError(message, 6);
      });
  }

  // ── Deferred wrapper tombstones ───────────────────────────────────
  // Register placeholder commands for known-deferred wrappers so users
  // get a clear "not yet implemented" message instead of commander's
  // default "unknown command" error.

  for (const def of WRAPPER_REGISTRY.filter((d) => d.status === "deferred")) {
    program
      .command(def.wrapper)
      .description(`[deferred] Not yet implemented — target: ${def.target}`)
      .allowUnknownOption(true)
      .action(() => {
        const message = getDeferredWrapperMessage(def.wrapper);
        throw createCliError(message, 5);
      });
  }

  // ── Extensions commands ────────────────────────────────────────────

  const extensions = new Command("extensions").description("Extension discovery, loading, and validation commands");

  function printExtensionDiagnostics(diagnostics: ExtensionDiagnostic[]): void {
    for (const d of diagnostics) {
      const prefix = d.extensionName ? `[${d.extensionName}]` : "[extensions]";
      console.error(`${prefix} ${d.severity}: (${d.code}) ${d.message}`);
    }
  }

  function resolveExtensionSearchPaths(rawPaths?: string[]): string[] {
    if (rawPaths && rawPaths.length > 0) {
      return rawPaths;
    }
    const envPaths = process.env["CALYX_EXTENSIONS_PATH"];
    if (envPaths) {
      return envPaths.split(":").filter((p) => p.length > 0);
    }
    return [];
  }

  extensions
    .command("list")
    .description("Discover and list installed extensions from search paths")
    .option("--search-path <paths...>", "Directories to search for extensions (or set CALYX_EXTENSIONS_PATH)")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsListCommandOptions) => {
      const searchPaths = resolveExtensionSearchPaths(options.searchPath);

      if (searchPaths.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ loaded: [], failed: [], diagnostics: [], conflicts: {} }, null, 2));
        } else {
          console.error("No extension search paths configured. Use --search-path or CALYX_EXTENSIONS_PATH.");
        }
        return;
      }

      const result = await discoverExtensions({ searchPaths });

      if (options.json) {
        console.log(JSON.stringify({
          loaded: result.loaded.map((r) => ({
            name: r.manifest?.name,
            version: r.manifest?.version,
            domains: r.manifest?.calyx.domains,
            apiVersion: r.manifest?.calyx.apiVersion,
            packageDir: r.packageDir,
          })),
          failed: result.failed.map((r) => ({
            name: r.manifest?.name,
            packageDir: r.packageDir,
            diagnostics: r.diagnostics,
          })),
          diagnostics: result.diagnostics,
          conflicts: result.conflicts,
        }, null, 2));
        return;
      }

      for (const r of result.loaded) {
        if (!r.manifest) continue;
        const domains = r.manifest.calyx.domains.join(", ");
        console.log(`${r.manifest.name}\tv${r.manifest.version}\tapi=${r.manifest.calyx.apiVersion}\tdomains=[${domains}]`);
      }

      if (result.failed.length > 0) {
        console.error(`\n${result.failed.length} extension(s) failed to load:`);
        for (const r of result.failed) {
          console.error(`  ${r.packageDir}`);
        }
      }

      printExtensionDiagnostics(result.diagnostics);
      console.error(`\nDiscovered ${result.loaded.length} extension(s) from ${searchPaths.length} search path(s).`);
    });

  extensions
    .command("validate")
    .description("Validate all discoverable extensions (manifests, compatibility, conflicts)")
    .option("--search-path <paths...>", "Directories to search for extensions (or set CALYX_EXTENSIONS_PATH)")
    .option("--strict", "Treat warnings as errors")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsValidateCommandOptions) => {
      const searchPaths = resolveExtensionSearchPaths(options.searchPath);

      if (searchPaths.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ ok: true, loaded: 0, failed: 0, conflicts: 0, diagnostics: [] }, null, 2));
        } else {
          console.error("No extension search paths configured. Use --search-path or CALYX_EXTENSIONS_PATH.");
        }
        return;
      }

      const result = await discoverExtensions({ searchPaths, strict: Boolean(options.strict) });

      const hasErrors = result.diagnostics.some((d) => d.severity === "error");
      const hasWarnings = result.diagnostics.some((d) => d.severity === "warning");
      const conflictCount = Object.keys(result.conflicts).length;
      const ok = !hasErrors && (!options.strict || !hasWarnings);

      if (options.json) {
        console.log(JSON.stringify({
          ok,
          loaded: result.loaded.length,
          failed: result.failed.length,
          conflicts: conflictCount,
          diagnostics: result.diagnostics,
        }, null, 2));
      } else {
        console.error(
          `Extensions validate ${ok ? "OK" : "FAILED"}: loaded=${result.loaded.length}, failed=${result.failed.length}, conflicts=${conflictCount}.`
        );
        printExtensionDiagnostics(result.diagnostics);
      }

      if (!ok) {
        throw createCliError(
          `Extensions validate failed with ${result.failed.length} load failure(s) and ${conflictCount} conflict(s).`,
          3
        );
      }
    });

  extensions
    .command("check")
    .description("Check a single extension package for manifest validity and SDK compatibility")
    .requiredOption("--path <path>", "Path to the extension package directory")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ExtensionsCheckCommandOptions) => {
      const result = await loadExtension(options.path);

      if (options.json) {
        console.log(JSON.stringify({
          ok: result.ok,
          name: result.manifest?.name,
          version: result.manifest?.version,
          apiVersion: result.manifest?.calyx.apiVersion,
          domains: result.manifest?.calyx.domains,
          packageDir: result.packageDir,
          diagnostics: result.diagnostics,
        }, null, 2));
        return;
      }

      if (result.ok && result.manifest) {
        const domains = result.manifest.calyx.domains.join(", ");
        console.error(
          `Extension check OK: ${result.manifest.name} v${result.manifest.version} (api=${result.manifest.calyx.apiVersion}, domains=[${domains}])`
        );
      } else {
        console.error(`Extension check FAILED for ${options.path}:`);
        printExtensionDiagnostics(result.diagnostics);
      }

      if (!result.ok) {
        throw createCliError(`Extension check failed for ${options.path}.`, 3);
      }
    });

  program.addCommand(config);
  program.addCommand(instructions);
  program.addCommand(skills);
  program.addCommand(tools);
  program.addCommand(prompts);
  program.addCommand(agents);
  program.addCommand(knowledge);
  program.addCommand(exec);
  program.addCommand(extensions);
  await program.parseAsync(argv);
}
