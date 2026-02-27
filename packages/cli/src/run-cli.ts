import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  compileFromFiles,
  compareTomlSemantics,
  indexPromptsRegistry,
  indexSkillsRegistry,
  indexToolsRegistry,
  renderInstructionsFromFiles,
  syncPromptsRegistry,
  syncSkillsRegistry,
  syncToolsRegistry,
  validatePromptsRegistry,
  validateSkillsRegistry,
  validateToolsRegistry,
  verifyInstructionsFromFiles
} from "@polli-labs/calyx-core";
import type {
  DomainSyncAction,
  DomainValidationIssue,
  PromptBackend,
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
  registry: string;
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
  registry: string;
  strict?: boolean;
  json?: boolean;
}

interface ToolsIndexCommandOptions {
  registry: string;
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
  registry: string;
  json?: boolean;
}

interface PromptsSyncCommandOptions extends PromptsIndexCommandOptions {
  backend: string;
  apply?: boolean;
}

interface PromptsValidateCommandOptions extends PromptsIndexCommandOptions {
  strict?: boolean;
}

interface CliError extends Error {
  exitCode?: number;
}

interface WrapperTelemetryEvent {
  event: "calyx.wrapper.invoked";
  wrapper: string;
  target: string;
  timestamp: string;
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

function emitWrapperTelemetry(wrapper: string, target: string): WrapperTelemetryEvent {
  const event: WrapperTelemetryEvent = {
    event: "calyx.wrapper.invoked",
    wrapper,
    target,
    timestamp: new Date().toISOString()
  };

  console.error(`[calyx][deprecated] ${wrapper} is a compatibility wrapper. Use "${target}".`);
  console.error(`[calyx][telemetry] ${JSON.stringify(event)}`);
  return event;
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
    .requiredOption("--registry <path>", "Path to skills registry JSON")
    .option("--include-archived", "Include archived skills in index output")
    .option("--exclude-deprecated", "Exclude deprecated skills from index output")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsIndexCommandOptions) => {
      const result = await indexSkillsRegistry(options.registry, {
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
      console.error(`Indexed ${result.items.length}/${result.total} skills from ${options.registry}.`);
    });

  skills
    .command("sync")
    .description("Sync skills from a registry into target backend(s)")
    .requiredOption("--registry <path>", "Path to skills registry JSON")
    .option("--backend <backend>", "Sync backend (claude|codex|agents|all)", "all")
    .option("--include-archived", "Include archived skills")
    .option("--exclude-deprecated", "Exclude deprecated skills")
    .option("--prune-deprecated", "Plan or apply prune actions for deprecated skills")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsSyncCommandOptions) => {
      const backend = parseSkillsBackend(options.backend);
      const result = await syncSkillsRegistry(options.registry, {
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
    .requiredOption("--registry <path>", "Path to skills registry JSON")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsValidateCommandOptions) => {
      const result = await validateSkillsRegistry(options.registry, {
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
    .requiredOption("--registry <path>", "Path to tools registry JSON")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsIndexCommandOptions) => {
      const result = await indexToolsRegistry(options.registry);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const tool of result.items) {
        console.log(`${tool.name}\t${tool.version}`);
      }
      console.error(`Indexed ${result.items.length} tools from ${options.registry}.`);
    });

  tools
    .command("sync")
    .description("Sync tools from a registry into host targets")
    .requiredOption("--registry <path>", "Path to tools registry JSON")
    .option("--host <alias>", "Single host alias to target")
    .option("--all", "Sync all known hosts")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsSyncCommandOptions) => {
      const syncOptions = normalizeToolsSyncTarget(options);
      const result = await syncToolsRegistry(options.registry, syncOptions);

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
    .requiredOption("--registry <path>", "Path to tools registry JSON")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: ToolsValidateCommandOptions) => {
      const result = await validateToolsRegistry(options.registry, {
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
    .requiredOption("--registry <path>", "Path to prompts registry JSON")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsIndexCommandOptions) => {
      const result = await indexPromptsRegistry(options.registry);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const prompt of result.items) {
        console.log(`${prompt.id}\t${prompt.template_path}`);
      }
      console.error(`Indexed ${result.items.length} prompts from ${options.registry}.`);
    });

  prompts
    .command("sync")
    .description("Sync prompts from a registry into backend targets")
    .requiredOption("--registry <path>", "Path to prompts registry JSON")
    .option("--backend <backend>", "Sync backend (claude|codex|all)", "all")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsSyncCommandOptions) => {
      const backend = parsePromptsBackend(options.backend);
      const result = await syncPromptsRegistry(options.registry, {
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
    .requiredOption("--registry <path>", "Path to prompts registry JSON")
    .option("--strict", "Escalate warnings to strict checks")
    .option("--json", "Print machine-readable summary")
    .action(async (options: PromptsValidateCommandOptions) => {
      const result = await validatePromptsRegistry(options.registry, {
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

  program
    .command("skills-sync")
    .description("Compatibility wrapper seed for legacy skills sync path")
    .requiredOption("--registry <path>", "Path to skills registry JSON")
    .option("--backend <backend>", "Sync backend (claude|codex|agents|all)", "all")
    .option("--apply", "Apply sync actions")
    .option("--json", "Print machine-readable summary")
    .action(async (options: SkillsSyncCommandOptions) => {
      const backend = parseSkillsBackend(options.backend);
      const telemetry = emitWrapperTelemetry("skills-sync", "calyx skills sync");
      const result = await syncSkillsRegistry(options.registry, {
        backend,
        apply: Boolean(options.apply)
      });

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              wrapper: telemetry,
              result
            },
            null,
            2
          )
        );
        return;
      }

      printSyncActions("skills", result.actions);
      console.error(`Wrapper ${telemetry.wrapper} generated ${result.actions.length} action(s).`);
    });

  program.addCommand(config);
  program.addCommand(instructions);
  program.addCommand(skills);
  program.addCommand(tools);
  program.addCommand(prompts);
  await program.parseAsync(argv);
}
