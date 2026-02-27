import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  compileFromFiles,
  compareTomlSemantics,
  renderInstructionsFromFiles,
  verifyInstructionsFromFiles
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

interface CliError extends Error {
  exitCode?: number;
}

function createCliError(message: string, exitCode: number): CliError {
  const error = new Error(message) as CliError;
  error.exitCode = exitCode;
  return error;
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

  program.addCommand(config);
  program.addCommand(instructions);
  await program.parseAsync(argv);
}
