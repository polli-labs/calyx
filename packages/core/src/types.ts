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
