declare module "@polli-labs/calyx-core" {
  export type ValidationMode = "strict" | "advisory";
  export type InstructionContextValue = string | number | boolean;
  export type InstructionContext = Record<string, InstructionContextValue>;

  export interface CompileInputFiles {
    fleetPath: string;
    hostPath: string;
  }

  export interface CompileOptions {
    mode?: ValidationMode;
    write?: boolean;
    outputPath?: string;
  }

  export interface CompileResult {
    configObject: Record<string, unknown>;
    tomlText: string;
    warnings: string[];
  }

  export interface SemanticParityResult {
    equal: boolean;
    reason?: string;
  }

  export interface InstructionsRenderInputFiles {
    fleetPath: string;
    hostsDir: string;
    templatePath: string;
    partialsDir: string;
  }

  export interface InstructionsRenderOptions {
    host?: string;
    all?: boolean;
    outputDir?: string;
    maxPartialDepth?: number;
  }

  export interface HostInstructionRenderResult {
    host: string;
    output: string;
    outputPath?: string;
    missingPartials: string[];
    unresolvedTokens: string[];
  }

  export interface InstructionsRenderResult {
    results: HostInstructionRenderResult[];
  }

  export interface InstructionDrift {
    host: string;
    expectedPath: string;
    reason: string;
  }

  export interface InstructionsVerifyOptions extends InstructionsRenderOptions {
    expectedDir: string;
  }

  export interface InstructionsVerifyResult extends InstructionsRenderResult {
    ok: boolean;
    drifts: InstructionDrift[];
  }

  export function compileFromFiles(
    inputFiles: CompileInputFiles,
    options?: CompileOptions
  ): Promise<CompileResult>;

  export function compareTomlSemantics(generatedToml: string, expectedToml: string): SemanticParityResult;

  export function renderInstructionsFromFiles(
    inputFiles: InstructionsRenderInputFiles,
    options?: InstructionsRenderOptions
  ): Promise<InstructionsRenderResult>;

  export function verifyInstructionsFromFiles(
    inputFiles: InstructionsRenderInputFiles,
    options: InstructionsVerifyOptions
  ): Promise<InstructionsVerifyResult>;
}
