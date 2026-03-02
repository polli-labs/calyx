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

  export type AgentLifecycleStatus = "active" | "deprecated" | "archived";
  export type AgentDeployBackend = "claude" | "codex" | "all";

  export interface AgentHostBinding {
    host: string;
    role?: string;
    [key: string]: unknown;
  }

  export interface AgentRegistryEntry {
    id: string;
    name: string;
    description?: string;
    status?: AgentLifecycleStatus;
    deprecated_by?: string;
    archived_at?: string;
    hosts?: AgentHostBinding[];
    capabilities?: string[];
    [key: string]: unknown;
  }

  export interface AgentsIndexOptions {
    includeActive?: boolean;
    includeDeprecated?: boolean;
    includeArchived?: boolean;
  }

  export interface AgentsIndexResult {
    version: string;
    total: number;
    items: AgentRegistryEntry[];
  }

  export interface AgentsSyncOptions extends AgentsIndexOptions {
    backend?: AgentDeployBackend;
    apply?: boolean;
  }

  export interface AgentsSyncResult {
    backend: AgentDeployBackend;
    apply: boolean;
    version: string;
    actions: DomainSyncAction[];
  }

  export interface AgentsValidateOptions {
    strict?: boolean;
  }

  export interface AgentsValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
    active: number;
    deprecated: number;
    archived: number;
  }

  export interface AgentProfile {
    id: string;
    name: string;
    description?: string;
    status: AgentLifecycleStatus;
    hosts: AgentHostBinding[];
    capabilities: string[];
  }

  export interface AgentsRenderProfilesOptions extends AgentsIndexOptions {
    format?: "text" | "json";
  }

  export interface AgentsRenderProfilesResult {
    version: string;
    total: number;
    profiles: AgentProfile[];
  }

  export interface AgentsDeployOptions extends AgentsIndexOptions {
    backend?: AgentDeployBackend;
    apply?: boolean;
  }

  export interface AgentsDeployResult {
    backend: AgentDeployBackend;
    apply: boolean;
    version: string;
    actions: DomainSyncAction[];
  }

  export function deployAgentsRegistry(registryPath: string, options?: AgentsDeployOptions): Promise<AgentsDeployResult>;

  export function indexAgentsRegistry(registryPath: string, options?: AgentsIndexOptions): Promise<AgentsIndexResult>;

  export function renderAgentProfiles(
    registryPath: string,
    options?: AgentsRenderProfilesOptions
  ): Promise<AgentsRenderProfilesResult>;

  export function syncAgentsRegistry(registryPath: string, options?: AgentsSyncOptions): Promise<AgentsSyncResult>;

  export function validateAgentsRegistry(
    registryPath: string,
    options?: AgentsValidateOptions
  ): Promise<AgentsValidateResult>;

  export type KnowledgeArtifactKind = "execplan" | "transcript" | "report" | "runbook" | "reference";

  export interface KnowledgeArtifactEntry {
    id: string;
    title: string;
    kind: KnowledgeArtifactKind;
    source_path?: string;
    tags?: string[];
    linked_issues?: string[];
    created_at?: string;
    [key: string]: unknown;
  }

  export interface KnowledgeIndexOptions {
    kind?: KnowledgeArtifactKind;
  }

  export interface KnowledgeIndexResult {
    version: string;
    total: number;
    items: KnowledgeArtifactEntry[];
  }

  export interface KnowledgeSearchOptions {
    query: string;
    kind?: KnowledgeArtifactKind;
    tags?: string[];
  }

  export interface KnowledgeSearchResult {
    query: string;
    total: number;
    items: KnowledgeArtifactEntry[];
  }

  export interface KnowledgeLinkOptions {
    artifactId: string;
    issueId: string;
    apply?: boolean;
  }

  export interface KnowledgeLinkResult {
    artifactId: string;
    issueId: string;
    apply: boolean;
    action: string;
  }

  export interface KnowledgeValidateOptions {
    strict?: boolean;
  }

  export interface KnowledgeValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
  }

  export function indexKnowledgeRegistry(registryPath: string, options?: KnowledgeIndexOptions): Promise<KnowledgeIndexResult>;

  export function searchKnowledgeRegistry(registryPath: string, options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult>;

  export function linkKnowledgeArtifact(registryPath: string, options: KnowledgeLinkOptions): Promise<KnowledgeLinkResult>;

  export function validateKnowledgeRegistry(
    registryPath: string,
    options?: KnowledgeValidateOptions
  ): Promise<KnowledgeValidateResult>;

  // Exec lifecycle domain

  export type ExecRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

  export interface ExecLogEntry {
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
  }

  export interface ExecLaunchOptions {
    command: string;
    metadata?: Record<string, unknown>;
    apply?: boolean;
  }

  export interface ExecLaunchResult {
    run_id: string;
    command: string;
    state: ExecRunState;
    created_at: string;
    apply: boolean;
  }

  export interface ExecStatusOptions {
    run_id: string;
  }

  export interface ExecStatusResult {
    run_id: string;
    command: string;
    state: ExecRunState;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    exit_code?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }

  export interface ExecLogsOptions {
    run_id: string;
    level?: "info" | "warn" | "error";
    tail?: number;
  }

  export interface ExecLogsResult {
    run_id: string;
    total: number;
    entries: ExecLogEntry[];
  }

  export interface ExecReceiptOptions {
    run_id: string;
  }

  export interface ExecReceiptResult {
    run_id: string;
    command: string;
    state: ExecRunState;
    created_at: string;
    started_at?: string;
    completed_at?: string;
    exit_code?: number;
    error?: string;
    duration_ms?: number;
    metadata?: Record<string, unknown>;
    log_summary: {
      total: number;
      info: number;
      warn: number;
      error: number;
    };
    summary: string;
  }

  export interface ExecValidateOptions {
    strict?: boolean;
  }

  export interface ExecValidateResult {
    ok: boolean;
    errors: DomainValidationIssue[];
    warnings: DomainValidationIssue[];
    version: string;
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  }

  export function launchExecRun(storePath: string, options: ExecLaunchOptions): Promise<ExecLaunchResult>;

  export function getExecStatus(storePath: string, options: ExecStatusOptions): Promise<ExecStatusResult>;

  export function getExecLogs(storePath: string, options: ExecLogsOptions): Promise<ExecLogsResult>;

  export function getExecReceipt(storePath: string, options: ExecReceiptOptions): Promise<ExecReceiptResult>;

  export function validateExecStore(storePath: string, options?: ExecValidateOptions): Promise<ExecValidateResult>;

  // Wrapper guardrails

  export type WrapperDeprecationPhase = "active" | "warn" | "error";
  export type WrapperStatus = "implemented" | "deferred";

  export interface WrapperDefinition {
    wrapper: string;
    target: string;
    status: WrapperStatus;
    phase: string;
    notes?: string;
  }

  export interface WrapperTelemetryEvent {
    event: "calyx.wrapper.invoked";
    wrapper: string;
    target: string;
    timestamp: string;
    pid: number;
    cwd: string;
    deprecation_phase: WrapperDeprecationPhase;
  }

  export interface WrapperGuardrailResult {
    allowed: boolean;
    phase: WrapperDeprecationPhase;
    message?: string;
  }

  export const WRAPPER_REGISTRY: WrapperDefinition[];

  export function emitWrapperTelemetry(wrapper: string, target: string): WrapperTelemetryEvent;

  export function checkWrapperGuardrail(wrapper: string, target: string): WrapperGuardrailResult;

  export function getWrapperDeprecationPhase(): WrapperDeprecationPhase;

  export function getDeferredWrapperMessage(wrapper: string): string;

  // Production wiring: source resolution

  export type RegistryDomain = "skills" | "tools" | "prompts" | "agents" | "knowledge";
  export type StoreDomain = "exec";
  export type SourceDomain = RegistryDomain | StoreDomain;

  export interface ResolveSourceOptions {
    cliValue?: string | undefined;
    configPath?: string | undefined;
  }

  export interface ResolveSourceResult {
    path: string | undefined;
    source: "cli" | "env" | "config" | "default" | "none";
  }

  export interface ConfigShowResult {
    configPath: string | undefined;
    configSource: "env" | "default" | "none";
    resolved: Record<SourceDomain, ResolveSourceResult>;
  }

  export function resolveSourcePath(
    domain: SourceDomain,
    options?: ResolveSourceOptions
  ): Promise<ResolveSourceResult>;

  export function requireSourcePath(
    domain: SourceDomain,
    options?: ResolveSourceOptions
  ): Promise<string>;

  export function showConfig(configPathOverride?: string): Promise<ConfigShowResult>;
}
