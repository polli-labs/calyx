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

  export type SyncBackend = "claude" | "codex" | "agents" | "all";
  export type PromptBackend = "claude" | "codex" | "all";

  export interface DomainValidationIssue {
    code: string;
    message: string;
    path?: string;
  }

  export interface DomainSyncAction {
    action: string;
    id: string;
    details: string;
  }

  export interface SkillsIndexOptions {
    includeActive?: boolean;
    includeDeprecated?: boolean;
    includeArchived?: boolean;
  }

  export interface SkillsIndexResult {
    version: string;
    total: number;
    items: Array<{
      id: string;
      status?: "active" | "deprecated" | "archived";
    }>;
  }

  export interface SkillsSyncOptions extends SkillsIndexOptions {
    backend?: SyncBackend;
    apply?: boolean;
    pruneDeprecated?: boolean;
  }

  export interface SkillsSyncResult {
    backend: SyncBackend;
    apply: boolean;
    version: string;
    actions: DomainSyncAction[];
  }

  export interface SkillsValidateOptions {
    strict?: boolean;
  }

  export interface SkillsValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
    active: number;
    deprecated: number;
    archived: number;
  }

  export interface ToolsIndexResult {
    version: string;
    total: number;
    items: Array<{
      name: string;
      version: string;
    }>;
  }

  export interface ToolsSyncOptions {
    host?: string;
    all?: boolean;
    apply?: boolean;
  }

  export interface ToolsSyncResult {
    target: string;
    apply: boolean;
    version: string;
    actions: DomainSyncAction[];
  }

  export interface ToolsValidateOptions {
    strict?: boolean;
  }

  export interface ToolsValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
  }

  export interface PromptsIndexResult {
    version: string;
    total: number;
    items: Array<{
      id: string;
      template_path: string;
    }>;
  }

  export interface PromptsSyncOptions {
    backend?: PromptBackend;
    apply?: boolean;
  }

  export interface PromptsSyncResult {
    backend: PromptBackend;
    apply: boolean;
    version: string;
    actions: DomainSyncAction[];
  }

  export interface PromptsValidateOptions {
    strict?: boolean;
  }

  export interface PromptsValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
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

  export function indexSkillsRegistry(registryPath: string, options?: SkillsIndexOptions): Promise<SkillsIndexResult>;

  export function syncSkillsRegistry(registryPath: string, options?: SkillsSyncOptions): Promise<SkillsSyncResult>;

  export function validateSkillsRegistry(
    registryPath: string,
    options?: SkillsValidateOptions
  ): Promise<SkillsValidateResult>;

  export function indexToolsRegistry(registryPath: string): Promise<ToolsIndexResult>;

  export function syncToolsRegistry(registryPath: string, options?: ToolsSyncOptions): Promise<ToolsSyncResult>;

  export function validateToolsRegistry(
    registryPath: string,
    options?: ToolsValidateOptions
  ): Promise<ToolsValidateResult>;

  export function indexPromptsRegistry(registryPath: string): Promise<PromptsIndexResult>;

  export function syncPromptsRegistry(registryPath: string, options?: PromptsSyncOptions): Promise<PromptsSyncResult>;

  export function validatePromptsRegistry(
    registryPath: string,
    options?: PromptsValidateOptions
  ): Promise<PromptsValidateResult>;
}
