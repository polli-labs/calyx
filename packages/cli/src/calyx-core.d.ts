declare module "@polli-labs/calyx-core" {
  export type ValidationMode = "strict" | "advisory";

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

  export function compileFromFiles(
    inputFiles: CompileInputFiles,
    options?: CompileOptions
  ): Promise<CompileResult>;

  export function compareTomlSemantics(generatedToml: string, expectedToml: string): SemanticParityResult;
}
