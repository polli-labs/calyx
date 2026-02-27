export type ValidationMode = "strict" | "advisory";

export type ArrayMergePolicy = "replace" | "append_unique";

export interface CompilerOutputConfig {
  format?: "toml";
  path_template?: string;
}

export interface FleetCompilerConfig {
  schema_version?: string;
  output?: CompilerOutputConfig;
}

export interface ArrayPolicyConfig {
  default?: ArrayMergePolicy;
  by_path?: Record<string, ArrayMergePolicy>;
}

export interface SecretsPolicy {
  mode?: string;
  forbidden_literal_patterns?: string[];
}

export interface ProjectTrustEntry {
  path: string;
  trust_level?: string;
}

export interface ProjectsInput {
  defaults?: ProjectTrustEntry[];
  extra?: Array<string | ProjectTrustEntry>;
}

export interface CodexInput {
  top_level?: Record<string, unknown>;
  profiles?: Record<string, Record<string, unknown>>;
  mcp_servers?: Record<string, Record<string, unknown>>;
  features?: Record<string, unknown>;
  history?: Record<string, unknown>;
  projects?: ProjectsInput | Record<string, { trust_level?: string }>;
  otel?: Record<string, unknown>;
  notice?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FleetInput {
  version: string;
  compiler?: FleetCompilerConfig;
  array_policies?: ArrayPolicyConfig;
  secrets?: SecretsPolicy;
  codex?: CodexInput;
  [key: string]: unknown;
}

export interface HostInput {
  host: string;
  user: string;
  home: string;
  os?: string;
  codex?: CodexInput;
  [key: string]: unknown;
}

export interface CompileContext {
  host: string;
  user: string;
  home: string;
}

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

export type InstructionContextValue = string | number | boolean;

export type InstructionContext = Record<string, InstructionContextValue>;

export interface InstructionsFleetInput {
  version?: string;
  instructions?: {
    context?: InstructionContext;
  };
}

export interface InstructionsHostInput {
  host?: string;
  user?: string;
  home?: string;
  instructions?: {
    context?: InstructionContext;
  };
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

export interface DomainValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface DomainValidationResult {
  ok: boolean;
  errors: DomainValidationIssue[];
  warnings: DomainValidationIssue[];
}

export interface DomainSyncAction {
  action: string;
  id: string;
  details: string;
}

export type SkillLifecycleStatus = "active" | "deprecated" | "archived";

export interface SkillSource {
  type: string;
  repo?: string;
  path: string;
  ref?: string;
  license?: string;
  [key: string]: unknown;
}

export interface SkillRegistryEntry {
  id: string;
  status?: SkillLifecycleStatus;
  deprecated_by?: string;
  archived_at?: string;
  local_archive_path?: string;
  source: SkillSource;
  [key: string]: unknown;
}

export interface SkillsRegistry {
  version: string;
  generated_at?: string;
  skills: SkillRegistryEntry[];
  [key: string]: unknown;
}

export interface SkillsIndexOptions {
  includeActive?: boolean;
  includeDeprecated?: boolean;
  includeArchived?: boolean;
}

export interface SkillsIndexResult {
  version: string;
  total: number;
  items: SkillRegistryEntry[];
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

export interface SkillsValidateResult extends DomainValidationResult {
  version: string;
  total: number;
  active: number;
  deprecated: number;
  archived: number;
}

export interface ToolInstallSpec {
  method: string;
  [key: string]: unknown;
}

export interface ToolRegistryEntry {
  name: string;
  version: string;
  status?: string;
  install?: ToolInstallSpec;
  [key: string]: unknown;
}

export interface ToolsRegistry {
  version: string;
  tools: ToolRegistryEntry[];
  [key: string]: unknown;
}

export interface ToolsIndexResult {
  version: string;
  total: number;
  items: ToolRegistryEntry[];
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

export interface ToolsValidateResult extends DomainValidationResult {
  version: string;
  total: number;
}

export type PromptBackend = "claude" | "codex" | "all";

export interface PromptRegistryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  template_path: string;
  variables: string[];
  optional_variables?: string[];
  targets: string[];
  exported_as_slash_command?: boolean;
  [key: string]: unknown;
}

export interface PromptsRegistry {
  version: string;
  schema_version?: string;
  prompts: PromptRegistryEntry[];
  [key: string]: unknown;
}

export interface PromptsIndexResult {
  version: string;
  total: number;
  items: PromptRegistryEntry[];
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

export interface PromptsValidateResult extends DomainValidationResult {
  version: string;
  total: number;
}
