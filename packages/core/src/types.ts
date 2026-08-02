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

export type LocalBackendMode = "plan" | "apply" | "verify";

export interface LocalBackendReceiptSummaryV1 {
  total: number;
  ok: number;
  drift: number;
  changed: number;
  applied: number;
}

export interface LocalBackendReceiptV1<TItem> {
  contractVersion: "local-backend/v1";
  backend: string;
  mode: LocalBackendMode;
  host: string;
  ok: boolean;
  generatedAt: string;
  summary: LocalBackendReceiptSummaryV1;
  items: TItem[];
}

export type RuntimeConfigComponent = "codex" | "claude-settings" | "claude-mcp";

export type RuntimeConfigItemStatus = "ok" | "drift" | "applied";

export interface RuntimeConfigItemResult {
  component: RuntimeConfigComponent;
  status: RuntimeConfigItemStatus;
  targetPath: string;
  stagedPath: string;
  liveExists: boolean;
  desiredSha256: string;
  liveSha256?: string;
  outputSha256?: string;
  backupPath?: string;
  changes: string[];
}

export interface RuntimeConfigOptions {
  host: string;
  managedConfigsRoot?: string;
  liveHome?: string;
  components?: RuntimeConfigComponent[];
}

export interface RuntimeConfigResult extends LocalBackendReceiptV1<RuntimeConfigItemResult> {
  backend: "runtime-config";
  requestedHost: string;
  managedConfigsRoot: string;
  liveHome: string;
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
  contextOverrides?: InstructionContext;
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

export type VaultPutInputType =
  | "execplan"
  | "report"
  | "context"
  | "project"
  | "workstream"
  | "prompt"
  | "library"
  | "meta";

export type VaultArtifactType = VaultPutInputType | "daily";

export interface VaultPutOptions {
  type?: VaultPutInputType;
  title: string;
  daily?: boolean;
  issue?: string;
  project?: string;
  workstream?: string;
  author?: string;
  assignee?: string;
  updated?: string;
  updatedBy?: string;
  status?: string;
  inputFilePath?: string;
  inputFrontmatterOverride?: Record<string, unknown>;
  mergeInputFrontmatter?: boolean;
  stdinText?: string;
  dryRun?: boolean;
  vaultPath?: string;
}

export type VaultBacklinkStatus =
  | "not-requested"
  | "dry-run"
  | "posted"
  | "skipped-no-api-key"
  | "skipped-not-found"
  | "failed";

export interface VaultBacklinkResult {
  status: VaultBacklinkStatus;
  issue?: string;
  message: string;
}

export interface VaultPutResult {
  vaultPath: string;
  outputPath: string;
  relativePath: string;
  author: string;
  type: VaultArtifactType;
  dryRun: boolean;
  content: string;
  issue?: string;
  backlink: VaultBacklinkResult;
}

export interface VaultSearchOptions {
  type?: VaultPutInputType;
  issueOnly?: boolean;
  filesOnly?: boolean;
  mode?: VaultSearchMode;
  limit?: number;
  vaultPath?: string;
}

export type VaultSearchMode = "literal" | "semantic" | "hybrid";

export interface VaultCapabilityWarning {
  code: string;
  message: string;
}

export interface VaultTrustPosture {
  source: "local-vault";
  untrustedSourceContent: boolean;
  notes: string[];
}

export interface VaultArtifactSummary {
  vaultUri: string;
  absolutePath: string;
  relativePath: string;
  title?: string;
  frontmatter?: Record<string, unknown>;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface VaultSearchMatch extends VaultArtifactSummary {
  rank: number;
  snippet?: string;
  matchCount?: number;
  lineNumbers?: number[];
}

export interface VaultSearchResult {
  schema_version?: "calyx.vault.search/v1";
  vaultPath: string;
  query: string;
  status: number;
  stdout: string;
  stderr: string;
  command: string[];
  fileScope?: string[];
  mode?: VaultSearchMode;
  requestedMode?: VaultSearchMode;
  matches?: VaultSearchMatch[];
  limit?: number;
  truncated?: boolean;
  bounds?: {
    resultLimit: number;
    returned: number;
    omitted: number;
  };
  warnings?: VaultCapabilityWarning[];
  trust?: VaultTrustPosture;
}

export type VaultFetchFootnotesMode = "collapsed" | "expanded";

export interface VaultFetchOptions {
  vaultPath?: string;
  maxBytes?: number;
  withFrontmatter?: boolean;
  withLinks?: boolean;
  footnotes?: VaultFetchFootnotesMode;
}

export interface VaultFetchResult {
  schema_version: "calyx.vault.fetch/v1";
  vaultPath: string;
  vaultUri: string;
  absolutePath: string;
  relativePath: string;
  frontmatter?: Record<string, unknown>;
  text: string;
  bytes: {
    maxBytes: number;
    returnedBytes: number;
    totalBytes: number;
    truncated: boolean;
  };
  contentHash: string;
  mtimeMs: number;
  links?: {
    outbound: VaultMarkdownLink[];
  };
  footnotes?: VaultFetchFootnotesProjection;
  warnings: VaultCapabilityWarning[];
  trust: VaultTrustPosture;
}

export interface VaultFetchFootnotesProjection {
  mode: VaultFetchFootnotesMode;
  collapsed_keys: string[];
  elided_chars: number;
  original_chars: number;
  projected_chars: number;
  receipt: VaultFootnoteRecallReceipt;
}

export type VaultMarkdownLinkKind = "wikilink" | "markdown";

export interface VaultMarkdownLink {
  kind: VaultMarkdownLinkKind;
  raw: string;
  target: string;
  label?: string;
  resolvedVaultUri?: string;
  resolvedRelativePath?: string;
}

export type VaultRelatedRelation = "wikilink" | "backlink" | "same-issue" | "same-project";

export interface VaultRelatedOptions {
  vaultPath?: string;
  relation?: VaultRelatedRelation;
  depth?: number;
  limit?: number;
  withFrontmatter?: boolean;
}

export interface VaultRelatedMatch extends VaultArtifactSummary {
  relation: VaultRelatedRelation;
  depth: number;
  evidence: string[];
}

export interface VaultRelatedResult {
  schema_version: "calyx.vault.related/v1";
  vaultPath: string;
  source: VaultArtifactSummary;
  relation: VaultRelatedRelation;
  depth: number;
  limit: number;
  results: VaultRelatedMatch[];
  bounds: {
    resultLimit: number;
    returned: number;
    omitted: number;
    scanLimit: number;
    scannedFiles: number;
    scanTruncated: boolean;
  };
  warnings: VaultCapabilityWarning[];
  trust: VaultTrustPosture;
}

export interface VaultSyncStatusResult {
  provider: "obsidian-desktop" | "obsidian-headless" | "none";
  health: "healthy" | "degraded" | "unavailable";
  available: boolean;
  attempted: boolean;
  path: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  warnings: VaultCapabilityWarning[];
  runtime?: {
    serviceName: string;
    probePath: string;
    active: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
}

export interface VaultSyncHygienePrefixStatus {
  prefix: string;
  localFiles: number;
  serverFiles: number;
  pendingFiles: number;
}

export interface VaultSyncHygieneResult {
  applicable: boolean;
  available: boolean;
  attempted: boolean;
  configRoot: string;
  requiredExcludedFolders: string[];
  configuredExcludedFolders: string[];
  missingExcludedFolders: string[];
  trackedPrefixes: VaultSyncHygienePrefixStatus[];
  warnings: VaultCapabilityWarning[];
  configPath?: string;
  stateDbPath?: string;
  vaultId?: string;
}

export interface VaultStatusOptions {
  vaultPath?: string;
}

export interface VaultStatusResult {
  vaultPath: string;
  totalFiles: number;
  counts: Record<string, number>;
  syncStatus: VaultSyncStatusResult;
  syncHygiene: VaultSyncHygieneResult;
}

export interface VaultMarkdownHeading {
  id: string;
  slug: string;
  level: number;
  text: string;
  line_start: number;
  line_end: number;
  byte_start: number;
  byte_end: number;
  section_hash: string;
}

export interface VaultMarkdownNoteRef {
  vaultPath: string;
  absolute_path: string;
  relative_path: string;
  uri: string;
}

export interface VaultTableOfContentsOptions {
  vaultPath?: string;
}

export interface VaultTableOfContentsResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.toc/v1";
  content_hash: string;
  headings: VaultMarkdownHeading[];
}

export interface VaultSectionOptions {
  heading: string;
  maxChars?: number;
  vaultPath?: string;
}

export interface VaultTruncationInfo {
  truncated: boolean;
  max_chars: number;
  original_chars: number;
}

export interface VaultSectionResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.section/v1";
  heading: VaultMarkdownHeading;
  content: string;
  section_hash: string;
  content_hash: string;
  truncation: VaultTruncationInfo;
}

export interface VaultFrontmatterOptions {
  vaultPath?: string;
}

export interface VaultByteSpan {
  byte_start: number;
  byte_end: number;
}

export interface VaultFrontmatterResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.frontmatter/v1";
  content_hash: string;
  frontmatter: Record<string, unknown>;
  frontmatter_span: VaultByteSpan | null;
  frontmatter_hash: string;
}

export type VaultFrontmatterQueryOperator = "==" | "!=";

export interface VaultFrontmatterFieldMatch {
  field: string;
  operator: VaultFrontmatterQueryOperator;
  expected: string;
  actual: unknown;
}

export interface VaultFrontmatterQueryOptions {
  type?: string;
  where?: string;
  limit?: number;
  vaultPath?: string;
}

export interface VaultFrontmatterQueryRow extends VaultMarkdownNoteRef {
  content_hash: string;
  frontmatter: Record<string, unknown>;
  frontmatter_span: VaultByteSpan | null;
  matched_fields: VaultFrontmatterFieldMatch[];
}

export interface VaultFrontmatterQueryResult {
  schema_version: "calyx.vault.frontmatter-query/v1";
  vaultPath: string;
  query: {
    type?: string;
    where?: string;
    limit: number;
  };
  rows: VaultFrontmatterQueryRow[];
  truncated: boolean;
  warnings: VaultCapabilityWarning[];
}

// ── Vault footnotes recall plane (POL-1763) ─────────────────────────────────
// Vault-side instance of the POL-1737 activity recall contract: named footnote
// keys are the stable cursors, `list → get` is the drill-down ladder, and the
// best-effort parser reports a recall-confidence receipt instead of crashing.

export type VaultFootnoteKind = "named" | "numeric" | "inline";

export type VaultFootnoteRecallConfidence = "high" | "medium" | "low";

export interface VaultFootnoteAmbiguousSpan {
  line: number;
  reason: string;
  excerpt: string;
}

export interface VaultFootnoteRecallReceipt {
  recall_confidence: VaultFootnoteRecallConfidence;
  refs_found: number;
  definitions_found: number;
  inline_footnotes_found: number;
  duplicate_definition_keys: string[];
  reference_only_keys: string[];
  definition_only_keys: string[];
  definitions_outside_block: number;
  footnotes_block_present: boolean;
  ambiguous_spans: VaultFootnoteAmbiguousSpan[];
  guard_hits: string[];
}

export interface VaultFootnoteRecord {
  key: string;
  kind: VaultFootnoteKind;
  ref_count: number;
  ref_lines: number[];
  preview: string;
  body_chars: number;
  definition_line: number | null;
  definition_count: number;
  in_block: boolean;
  orphaned: boolean;
  dangling: boolean;
}

export interface VaultFootnotesBlockInfo {
  present: boolean;
  heading_id?: string;
  line_start?: number;
  line_end?: number;
}

export interface VaultFootnotesListOptions {
  vaultPath?: string;
}

export interface VaultFootnotesListResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.footnotes-list/v1";
  content_hash: string;
  footnotes: VaultFootnoteRecord[];
  block: VaultFootnotesBlockInfo;
  receipt: VaultFootnoteRecallReceipt;
}

export interface VaultFootnoteTextCursor {
  total_chars: number;
  returned: Array<[number, number]>;
  next?: number;
}

export interface VaultFootnoteBody {
  key: string;
  kind: VaultFootnoteKind;
  body: string;
  body_chars: number;
  ref_count: number;
  ref_lines: number[];
  definition_line: number | null;
  truncated?: boolean;
  text_cursor?: VaultFootnoteTextCursor;
}

export interface VaultFootnotesGetOptions {
  keys?: string[];
  range?: string;
  maxChars?: number;
  vaultPath?: string;
}

export interface VaultFootnotesGetResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.footnotes-get/v1";
  content_hash: string;
  footnotes: VaultFootnoteBody[];
  receipt: VaultFootnoteRecallReceipt;
}

export interface VaultFootnoteAddOptions {
  key: string;
  anchor: string;
  body: string;
  renumber?: boolean;
  dryRun?: boolean;
  vaultPath?: string;
}

export interface VaultFootnoteAddResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.footnotes-add/v1";
  dryRun: boolean;
  key: string;
  anchor: {
    kind: "text" | "block-id";
    matched_line: number;
  };
  reference_line: number;
  definition_line: number;
  footnotes_block_created: boolean;
  renumbered: Array<{ from: string; to: string }>;
  content_hash_before: string;
  content_hash_after: string;
  content?: string;
  receipt: VaultFootnoteRecallReceipt;
}

export type VaultFootnoteLintSeverity = "info" | "warning";

export interface VaultFootnoteLintFinding {
  code: string;
  severity: VaultFootnoteLintSeverity;
  message: string;
  key?: string;
  line?: number;
}

// Altitude metrics ride on `footnotes lint` as Archaeologist groundwork
// (POL-1386): the vault stratum consumes footnote_share and staleness fields
// as finding-class inputs without a separate `calyx vault lint` surface yet.
export interface VaultFootnoteAltitudeMetrics {
  body_lines: number;
  spine_lines: number;
  footnote_block_lines: number;
  spine_chars: number;
  footnote_chars: number;
  footnote_share: number;
  updated: string | null;
  last_probed: string | null;
  days_since_updated: number | null;
  days_since_last_probed: number | null;
}

export interface VaultFootnotesLintOptions {
  vaultPath?: string;
}

export interface VaultFootnotesLintResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.footnotes-lint/v1";
  content_hash: string;
  findings: VaultFootnoteLintFinding[];
  metrics: VaultFootnoteAltitudeMetrics;
  receipt: VaultFootnoteRecallReceipt;
}

export interface VaultFootnotesGcOptions {
  dropOrphans?: boolean;
  renumber?: boolean;
  dryRun?: boolean;
  vaultPath?: string;
}

export interface VaultFootnotesGcAction {
  code:
    | "created-block"
    | "relocated-definition"
    | "deduped-definition"
    | "dropped-orphan"
    | "renumbered-key"
    | "normalized-block-spacing";
  key?: string;
  detail: string;
}

export interface VaultFootnotesGcResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.footnotes-gc/v1";
  dryRun: boolean;
  changed: boolean;
  actions: VaultFootnotesGcAction[];
  content_hash_before: string;
  content_hash_after: string;
  content?: string;
  receipt: VaultFootnoteRecallReceipt;
}

// ── Vault journal recall and append plane (POL-1775) ───────────────────────

export type VaultJournalEntryKind = "heading" | "bullet" | "table_row";
export type VaultJournalOrder = "newest-first" | "chronological" | "mixed" | "unknown";
export type VaultJournalOrderSource = "frontmatter" | "prose-hint" | "inferred" | "caller" | "unknown";
export type VaultJournalRecallConfidence = "high" | "medium" | "low";

export interface VaultJournalAmbiguousSpan {
  line: number;
  reason: string;
  excerpt: string;
}

export interface VaultJournalSameDayCollision {
  date: string;
  count: number;
  keys: string[];
}

export interface VaultJournalSectionInfo {
  heading_id?: string;
  heading_text?: string;
  line_start?: number;
  line_end?: number;
  kind: VaultJournalEntryKind;
  entries_found?: number;
  order?: VaultJournalOrder;
  append_supported: boolean;
  append_blockers?: string[];
}

export interface VaultJournalRecallReceipt {
  recall_confidence: VaultJournalRecallConfidence;
  order: VaultJournalOrder;
  order_source: VaultJournalOrderSource;
  entries_found: number;
  sections_found: number;
  heading_patterns: string[];
  same_day_collisions: VaultJournalSameDayCollision[];
  append_supported: boolean;
  append_blockers: string[];
  ambiguous_spans: VaultJournalAmbiguousSpan[];
  guard_hits: string[];
}

export interface VaultJournalEntryRecord {
  key: string;
  kind: VaultJournalEntryKind;
  date: string | null;
  title: string;
  slug: string;
  ordinal_on_date: number | null;
  date_out_of_order?: boolean;
  section?: VaultJournalSectionInfo;
  line_start: number;
  line_end: number;
  char_start: number;
  char_end: number;
  body_chars: number;
  preview: string;
  fields: Record<string, string>;
}

export interface VaultJournalSuggestedContract {
  journal: {
    order: Exclude<VaultJournalOrder, "mixed" | "unknown">;
    entry?: {
      kind: "heading" | "bullet";
      heading?: string;
      bullet?: string;
      fields?: string[];
      continuation_indent?: string;
    };
    sections?: Record<string, {
      kind: "heading" | "bullet" | "table-row";
      order?: Exclude<VaultJournalOrder, "mixed" | "unknown">;
      mode?: "read-only";
      heading?: string;
      bullet?: string;
      fields?: string[];
      continuation_indent?: string;
    }>;
  };
}

export interface VaultJournalEntriesOptions {
  section?: string;
  kind?: "auto" | VaultJournalEntryKind | "table-row";
  last?: number;
  vaultPath?: string;
}

export interface VaultJournalEntriesResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.journal-entries/v1";
  content_hash: string;
  entries: VaultJournalEntryRecord[];
  sections: VaultJournalSectionInfo[];
  receipt: VaultJournalRecallReceipt;
}

export interface VaultJournalEntryBody {
  key: string;
  kind: VaultJournalEntryKind;
  title: string;
  body: string;
  body_chars: number;
  truncated?: boolean;
  text_cursor?: VaultFootnoteTextCursor;
}

export interface VaultJournalGetOptions {
  key: string;
  section?: string;
  range?: string;
  maxChars?: number;
  vaultPath?: string;
}

export interface VaultJournalGetResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.journal-get/v1";
  content_hash: string;
  entry: VaultJournalEntryBody;
  receipt: VaultJournalRecallReceipt;
}

export interface VaultJournalAppendOptions {
  title: string;
  date?: string;
  body?: string;
  fields?: Record<string, string>;
  section?: string;
  dryRun?: boolean;
  vaultPath?: string;
}

export interface VaultJournalAppendResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.journal-append/v1";
  dryRun: boolean;
  changed: boolean;
  entry?: VaultJournalEntryRecord;
  date_out_of_order: boolean;
  warnings: string[];
  insertion?: {
    kind: VaultJournalEntryKind;
    order: VaultJournalOrder;
    line: number;
    char: number;
    retry_count: 0 | 1;
  };
  stamped?: Pick<VaultStampResult, "fields" | "frontmatter_created" | "frontmatter_diff">;
  content_hash_before: string;
  content_hash_after?: string;
  content?: string;
  suggested_contract?: VaultJournalSuggestedContract;
  receipt: VaultJournalRecallReceipt;
}

// ── Vault stamp (POL-1764) ──────────────────────────────────────────────────

export interface VaultStampOptions {
  updated?: string;
  updatedBy?: string;
  lastProbed?: string;
  fields?: Record<string, string>;
  dryRun?: boolean;
  vaultPath?: string;
}

export interface VaultStampFieldChange {
  field: string;
  previous: string | null;
  value: string;
}

export interface VaultStampResult extends VaultMarkdownNoteRef {
  schema_version: "calyx.vault.stamp/v1";
  dryRun: boolean;
  changed: boolean;
  fields: VaultStampFieldChange[];
  frontmatter_created: boolean;
  body_hash: string;
  body_unchanged: true;
  content_hash_before: string;
  content_hash_after: string;
  frontmatter_diff: string[];
  warnings: VaultCapabilityWarning[];
}

export type InstructionSurfaceStatus = "active" | "archived";

export type InstructionTargetClass =
  | "host_home"
  | "repo_root"
  | "directory_root"
  | "staged_preview"
  | "bundle_output";

export interface InstructionTargetSelectors {
  hosts?: string[];
}

export interface InstructionManagedFile {
  path: string;
  sourcePath?: string;
  context?: InstructionContext;
  marker?: "frontmatter" | "none";
}

export interface InstructionTargetBinding {
  bindingId: string;
  class: InstructionTargetClass;
  path: string;
  managedFiles?: InstructionManagedFile[];
  selectors?: InstructionTargetSelectors;
  description?: string;
}

export interface InstructionSurfaceSourceRef {
  fleetPath: string;
  hostsDir: string;
  templatePath: string;
  partialsDir: string;
  expectedDir?: string;
}

export interface InstructionSurfaceManifest {
  surfaceId: string;
  status: InstructionSurfaceStatus;
  owner?: string;
  description?: string;
  sourceRef: InstructionSurfaceSourceRef;
  targetBindings?: InstructionTargetBinding[];
}

export type InstructionSurfaceResolvedSourceRef = InstructionSurfaceSourceRef;

export interface InstructionsSurfaceSummary {
  surfaceId: string;
  status: InstructionSurfaceStatus;
  manifestPath: string;
  owner?: string;
  description?: string;
  bindingCount: number;
}

export interface InstructionsListOptions {
  includeArchived?: boolean;
}

export interface InstructionsListResult {
  total: number;
  items: InstructionsSurfaceSummary[];
}

export interface InstructionsShowResult {
  surfaceId: string;
  status: InstructionSurfaceStatus;
  manifestPath: string;
  owner?: string;
  description?: string;
  sourceRef: InstructionSurfaceResolvedSourceRef;
  targetBindings: InstructionTargetBinding[];
}

export interface InstructionsTargetsOptions extends InstructionsListOptions {
  surfaceId?: string;
}

export interface InstructionTargetEntry extends InstructionTargetBinding {
  surfaceId: string;
  manifestPath: string;
  status: InstructionSurfaceStatus;
}

export interface InstructionsTargetsResult {
  total: number;
  items: InstructionTargetEntry[];
}

export type InstructionsSurfaceRenderOptions = InstructionsRenderOptions;

export interface InstructionsSurfaceRenderResult extends InstructionsRenderResult {
  surfaceId: string;
  manifestPath: string;
  sourceRef: InstructionSurfaceResolvedSourceRef;
  targetBindings: InstructionTargetBinding[];
}

export interface InstructionsSurfaceVerifyOptions extends InstructionsRenderOptions {
  expectedDir?: string;
}

export interface InstructionsSurfaceVerifyResult extends InstructionsVerifyResult {
  surfaceId: string;
  manifestPath: string;
  sourceRef: InstructionSurfaceResolvedSourceRef;
  targetBindings: InstructionTargetBinding[];
  expectedDir: string;
}

export interface InstructionManagedMarker {
  managedBy: "instructions";
  surfaceId?: string;
  bindingId?: string;
  bundleId?: string;
  renderedHost?: string;
  contentSha256?: string;
  appliedAt?: string;
}

export type InstructionReconcileStatus =
  | "managed_ok"
  | "managed_drift"
  | "unmanaged_match"
  | "unmanaged_present"
  | "missing_expected"
  | "archived_managed_present"
  | "ownership_conflict";

export type InstructionReconcileReason =
  | "content_matches_without_marker"
  | "content_differs_without_marker"
  | "marker_matches"
  | "marker_content_mismatch"
  | "marker_document_shape_mismatch"
  | "file_missing"
  | "target_root_missing"
  | "archived_surface_target_present"
  | "marker_surface_mismatch"
  | "marker_binding_mismatch"
  | "marker_malformed";

export interface InstructionReconcileEvidence {
  liveExists: boolean;
  targetRootExists: boolean;
  isSymlink?: boolean;
  symlinkTarget?: string;
  nestedFrontmatter?: boolean;
}

export interface InstructionReconcileFinding {
  surfaceId: string;
  bindingId: string;
  manifestPath: string;
  targetClass: InstructionTargetClass;
  targetPath: string;
  managedFile: string;
  status: InstructionReconcileStatus;
  reason: InstructionReconcileReason;
  expectedContentSha256: string;
  liveContentSha256?: string;
  marker?: InstructionManagedMarker;
  evidence: InstructionReconcileEvidence;
}

export interface InstructionReconcileSummary {
  totalTargets: number;
  okTargets: number;
  findings: number;
  byStatus: Record<InstructionReconcileStatus, number>;
}

export interface InstructionsSurfaceReconcileOptions {
  host: string;
  surfaceId?: string;
  includeArchived?: boolean;
  repoRoot?: string;
}

export interface InstructionsSurfaceReconcileResult {
  host: string;
  findings: InstructionReconcileFinding[];
  summary: InstructionReconcileSummary;
  resolvedSurfaces: InstructionsSurfaceSummary[];
}

export type InstructionMutationMode = "apply" | "adopt";

export type InstructionMutationAction =
  | "write_missing"
  | "update_managed"
  | "reviewed_overwrite"
  | "adopt_unmanaged"
  | "already_managed";

export interface InstructionMutationPlannedChange {
  surfaceId: string;
  bindingId: string;
  manifestPath: string;
  targetClass: InstructionTargetClass;
  targetPath: string;
  managedFile: string;
  action: InstructionMutationAction;
  expectedContentSha256: string;
  liveContentSha256?: string;
}

export interface InstructionMutationChange extends InstructionMutationPlannedChange {
  marker?: InstructionManagedMarker;
  backupPath?: string;
}

export interface InstructionMutationSummary {
  totalTargets: number;
  changedTargets: number;
  unchangedTargets: number;
  blockedTargets: number;
  byAction: Record<InstructionMutationAction, number>;
}

export interface InstructionsSurfaceMutationOptions {
  host: string;
  surfaceId?: string;
  includeArchived?: boolean;
  repoRoot?: string;
  dryRun?: boolean;
  reviewedOverwrite?: boolean;
  reviewedOverwriteBackupDir?: string;
}

export interface InstructionsSurfaceMutationResult {
  host: string;
  mode: InstructionMutationMode;
  dryRun?: boolean;
  reviewedOverwrite?: boolean;
  plannedChanges: InstructionMutationPlannedChange[];
  changes: InstructionMutationChange[];
  blockedFindings: InstructionReconcileFinding[];
  summary: InstructionMutationSummary;
  resolvedSurfaces: InstructionsSurfaceSummary[];
}

export type InstructionTraceVariableSourceKind =
  | "fleet_manifest_context"
  | "host_manifest_context"
  | "host_builtin"
  | "fleet_truth"
  | "render_time"
  | "local_config"
  | "repo_file"
  | "unresolved";

export interface InstructionTraceVariable {
  name: string;
  sourceKind: InstructionTraceVariableSourceKind;
  sourcePath?: string;
  value?: string;
  valuePreview?: string;
}

export interface InstructionTracePartial {
  name: string;
  path?: string;
  order: number;
  missing?: boolean;
  content?: string;
}

export type InstructionTraceStatus = "matches_current_render" | "drifted" | "missing";

export interface InstructionTraceRenderState {
  renderedSha256: string;
  liveSha256?: string;
  liveModifiedAt?: string;
  marker?: InstructionManagedMarker | null;
}

export interface InstructionSurfaceTraceSource {
  surfaceId: string;
  manifestPath: string;
  bindingId: string;
  bindingClass: InstructionTargetClass;
  sourceRef: InstructionSurfaceResolvedSourceRef;
  targetBinding: InstructionTargetBinding;
  reconcileStatus?: InstructionReconcileStatus;
  reconcileReason?: InstructionReconcileReason;
  marker?: InstructionManagedMarker;
}

export type InstructionTemplateTraceChannel = "agents" | "claude";

export interface InstructionTemplateTraceSource {
  templateId: string;
  templateRegistryPath: string;
  templatePath: string;
  partialsDir: string;
  channel: InstructionTemplateTraceChannel;
  stagedTargetPath?: string;
  fanoutTargetPath?: string;
}

export interface InstructionTraceMatch {
  kind: "surface_binding" | "template_fanout";
  matchId: string;
  status: InstructionTraceStatus;
  targetPath: string;
  host: string;
  partials: InstructionTracePartial[];
  variables: InstructionTraceVariable[];
  renderState: InstructionTraceRenderState;
  source: InstructionSurfaceTraceSource | InstructionTemplateTraceSource;
}

export interface InstructionTraceResult {
  target: {
    input: string;
    resolvedPath: string;
    host: string;
    exists: boolean;
  };
  matches: InstructionTraceMatch[];
}

export type InstructionStackHarness = "codex" | "claude";

export type InstructionStackSourceKind =
  | "managed"
  | "user"
  | "project"
  | "local"
  | "rule"
  | "import";

export type InstructionStackLoadReason =
  | "session_start"
  | "cwd_inheritance"
  | "nested_traversal"
  | "include";

export type InstructionStackResolutionStatus =
  | "resolved"
  | "ambiguous_provenance"
  | "unresolved_provenance"
  | "refused_sensitive_import";

export interface InstructionStackLocator {
  path: string;
  line?: number;
}

export interface InstructionStackMetrics {
  rawLines: number;
  rawBytes: number;
  estimatedTokens: number;
  includedBytes: number;
  truncated: boolean;
}

export interface InstructionStackMetadataValue {
  value?: string;
  source: "frontmatter" | "inherited" | "provenance" | "derived" | "unknown";
  sourcePath?: string;
  candidates?: string[];
}

export interface InstructionStackPartialProvenance {
  order: number;
  name: string;
  path?: string;
  missing: boolean;
  sha256?: string;
  rawLines?: number;
  rawBytes?: number;
}

export interface InstructionStackProvenanceCandidate {
  id: string;
  kind: "direct_file" | "surface_binding" | "template_fanout";
  owner?: string;
  lifecycle?: string;
  sourcePath?: string;
  manifestPath?: string;
  templatePath?: string;
  installedTargetPath: string;
  partials: InstructionStackPartialProvenance[];
}

export interface InstructionStackSource {
  order: number;
  kind: InstructionStackSourceKind;
  loadReason: InstructionStackLoadReason;
  selectedAs: string;
  targetPath: string;
  canonicalPath: string;
  scope: InstructionStackMetadataValue;
  owner: InstructionStackMetadataValue;
  lifecycle: InstructionStackMetadataValue;
  status: InstructionStackResolutionStatus;
  contentSha256?: string;
  sourceRevision?: {
    repoRoot: string;
    commitSha: string;
    headBlobSha?: string;
    workingBlobSha?: string;
    tracked: boolean;
  };
  metrics?: InstructionStackMetrics;
  mirrorTargets: string[];
  provenance: InstructionStackProvenanceCandidate[];
  parentSourcePath?: string;
}

export type InstructionStackStructuralFindingCode =
  | "missing_global_source"
  | "unresolved_source"
  | "ambiguous_source"
  | "ambiguous_owner"
  | "missing_owner"
  | "missing_lifecycle"
  | "sensitive_import_refused"
  | "import_cycle"
  | "import_depth_exceeded";

export interface InstructionStackStructuralFinding {
  code: InstructionStackStructuralFindingCode;
  message: string;
  locators: InstructionStackLocator[];
  candidateOwners: string[];
  candidateSources: string[];
}

export type InstructionStackAdvisoryKind =
  | "repeated_imperative"
  | "wrong_altitude"
  | "conflicting_claim"
  | "stale_child_after_authority_moved";

export interface InstructionStackAdvisory {
  id: string;
  kind: InstructionStackAdvisoryKind;
  confidence: "high" | "medium" | "low";
  reason: string;
  locators: InstructionStackLocator[];
  fingerprint: string;
}

export interface InstructionStackResult {
  schemaVersion: "calyx.instructions-stack/v1";
  cwd: string;
  harness: InstructionStackHarness;
  host: string;
  resolution: {
    rulesVersion: "calyx.instructions-resolution/observed-2026-07-21";
    projectRoot?: string;
    globalCandidates: string[];
    perDirectoryCandidates: string[];
    projectDocMaxBytes?: number;
    projectRootMarkers?: string[];
    importsMaxDepth?: number;
    lazyNestedGuides: boolean;
    evidence: string[];
  };
  sources: InstructionStackSource[];
  totals: {
    sourceCount: number;
    rawLines: number;
    rawBytes: number;
    estimatedTokens: number;
    includedBytes: number;
    mirrorTargetCount: number;
  };
  structural: {
    ok: boolean;
    findings: InstructionStackStructuralFinding[];
  };
  advisories: InstructionStackAdvisory[];
  limitations: string[];
}

export interface InstructionStackOptions {
  cwd: string;
  harness: InstructionStackHarness;
  host: string;
  homeDir?: string;
  codexHome?: string;
  claudeConfigDir?: string;
  agentsInfraRoot?: string;
  codexProjectRoot?: string;
  codexProjectDocFallbackFilenames?: string[];
  codexProjectDocMaxBytes?: number;
  codexProjectRootMarkers?: string[];
  claudeManagedInstructionPaths?: string[];
}

export type SyncBackend = "claude" | "codex" | "agents" | "all";
export type CodexSkillsSyncMode = "alias-agents" | "native";

export type PluginHarness = "codex" | "claude";
export type PluginHarnessSelector = PluginHarness | "all";
export type PluginObservationState =
  | "cataloged"
  | "cached"
  | "enabled"
  | "installed"
  | "active";
export type PluginManagedBy = PluginHarness | "calyx" | "unknown";
export const PLUGIN_COMPONENT_KINDS = [
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
] as const;
export type PluginComponentKind = typeof PLUGIN_COMPONENT_KINDS[number];

export interface PluginComponents {
  skills: string[];
  mcpServers: string[];
  apps: string[];
  hooks: string[];
  agents: string[];
  commands: string[];
  lspServers: string[];
  monitors: string[];
  bin: string[];
  settings: string[];
}

export interface PluginSourceRef {
  kind: "local" | "git" | "github" | "url" | "bundled" | "unknown";
  value: string;
}

export interface PluginPaths {
  root?: string;
  manifest?: string;
  marketplace?: string;
}

export interface PluginProvenance {
  observedAt: string;
  host: string;
}

export interface PluginObservation {
  harness: PluginHarness;
  marketplace?: string;
  plugin: string;
  version?: string;
  description?: string;
  state: PluginObservationState[];
  source?: PluginSourceRef;
  paths: PluginPaths;
  components: PluginComponents;
  managedBy: PluginManagedBy;
  provenance: PluginProvenance;
}

export interface PluginInventoryDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface PluginInventorySummary {
  total: number;
  byHarness: Record<PluginHarness, number>;
  byState: Record<PluginObservationState, number>;
}

export interface PluginsInventoryOptions {
  harness?: PluginHarnessSelector;
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  includeCatalog?: boolean;
  observedAt?: string;
}

export interface PluginsInventoryResult {
  schemaVersion: "plugins.inventory/v1";
  generatedAt: string;
  home: string;
  codexHome: string;
  claudeHome: string;
  harnesses: PluginHarness[];
  includeCatalog: boolean;
  plugins: PluginObservation[];
  diagnostics: PluginInventoryDiagnostic[];
  summary: PluginInventorySummary;
}

export interface PluginsShowResult {
  schemaVersion: "plugins.show/v1";
  generatedAt: string;
  query: string;
  matches: PluginObservation[];
}

export interface PluginsTraceOptions extends PluginsInventoryOptions {
  kind?: PluginComponentKind;
}

export interface PluginTraceMatch {
  component: string;
  kind: PluginComponentKind;
  plugin: PluginObservation;
}

export interface PluginsTraceResult {
  schemaVersion: "plugins.trace/v1";
  generatedAt: string;
  query: string;
  kind?: PluginComponentKind;
  matches: PluginTraceMatch[];
}

export type PluginDoctorIssueCode =
  | "inventory_error"
  | "enabled_missing_cache"
  | "duplicate_component"
  | "catalog_only";

export interface PluginDoctorIssue {
  severity: "info" | "warning" | "error";
  code: PluginDoctorIssueCode;
  message: string;
  harness?: PluginHarness;
  marketplace?: string;
  plugin?: string;
  component?: string;
  kind?: PluginComponentKind;
  paths?: string[];
}

export interface PluginsDoctorResult {
  schemaVersion: "plugins.doctor/v1";
  generatedAt: string;
  ok: boolean;
  inventory: PluginsInventoryResult;
  issues: PluginDoctorIssue[];
  summary: {
    total: number;
    info: number;
    warning: number;
    error: number;
  };
}

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

export type SkillLifecycleStatus = "active" | "deprecated" | "archived" | "retired";

/**
 * Provenance class for a skill — which source-of-truth regime owns its content.
 * Derived from {@link SkillSource.type}; ORTHOGONAL to {@link SkillLifecycleStatus}
 * (a skill's lifecycle being deprecated/archived does NOT change its provenance).
 *
 * Slice 0 (read-only) derives the three git-regime classes from source.type:
 *   internal -> repo-managed, external -> vendored, repo-maintained -> repo-maintained.
 * The db-regime classes (agent-proposed, local-manual) are assigned by the agent
 * write path in a later slice and are never derivable from source.type.
 * installed-mirror describes an install OUTPUT (orphan mirror), never a registry source,
 * so deriveProvenanceClass never returns it.
 */
export type ProvenanceClass =
  | "repo-managed"
  | "vendored"
  | "repo-maintained"
  | "agent-proposed"
  | "local-manual"
  | "installed-mirror";

export interface SkillSource {
  type: string;
  repo?: string;
  path: string;
  ref?: string;
  license?: string;
  /**
   * Current source-of-truth regime for the skill's content (POL-1729 Slice 2).
   * ORTHOGONAL to {@link ProvenanceClass} (origin) — a skill keeps its
   * provenance class when migrated.
   *
   *   - absent ⇒ `git` (backward-compatible default): the skill's content lives
   *     in its source repo and is git-synced by `calyx skills sync`.
   *   - `db` ⇒ the skill's source-of-truth is the agent-owned DB
   *     (`skill_content`); the re-materializer renders its mirrors and
   *     `calyx skills sync` never touches it (no-cross-regime-clobber).
   */
  regime?: "git" | "db";
  [key: string]: unknown;
}

export interface SkillRegistryEntry {
  id: string;
  status?: SkillLifecycleStatus;
  deprecated_by?: string;
  archived_at?: string;
  retired_at?: string;
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
  includeRetired?: boolean;
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
  codexMode?: CodexSkillsSyncMode;
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
  retired: number;
}

export type SkillInstallationState =
  | "matches_expected"
  | "differs"
  | "missing"
  | "expected_unavailable";

export interface SkillValidationCheck {
  id: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface SkillResolvedSource {
  type: string;
  repo?: string;
  path: string;
  ref?: string | null;
  license?: string | null;
  resolvedSkillPath?: string;
  resolvedSkillDir?: string;
  available: boolean;
  provenance_class?: ProvenanceClass;
  /**
   * Current source-of-truth regime (POL-1729 Slice 2): `git` (default) or `db`
   * (agent-owned, re-materializer-rendered). ORTHOGONAL to provenance_class.
   */
  regime: "git" | "db";
}

export interface SkillInstallationInfo {
  backend: Exclude<SyncBackend, "all">;
  entryName: string;
  expectedPath: string;
  present: boolean;
  state: SkillInstallationState;
  liveSkillPath?: string;
  expectedSkillSha256?: string;
  liveSkillSha256?: string;
  expectedTreeSha256?: string;
  liveTreeSha256?: string;
}

export interface SkillFleetInstallationInfo {
  host: string;
  backend: Exclude<SyncBackend, "all">;
  entryName: string;
  expectedPath: string;
}

export interface SkillsShowResult {
  id: string;
  status: SkillLifecycleStatus;
  registry: {
    path: string;
    version: string;
  };
  source: SkillResolvedSource;
  localInstallations: SkillInstallationInfo[];
  fleetInstallations: SkillFleetInstallationInfo[];
  validation: {
    ok: boolean;
    checks: SkillValidationCheck[];
  };
  notes: string[];
}

export type SkillUsageBackendStatus = "ok" | "degraded" | "unavailable";

export interface SkillUsageRow {
  skill_name: string;
  use_count: number;
}

export interface SkillUsageResult {
  schema_version: "skills.usage/v1";
  status: SkillUsageBackendStatus;
  source: "loki";
  endpoint: string;
  since: string; // requested window, e.g. "7d"
  limit?: number; // display bound; absent when the query was unbounded (the curator's full-vector path)
  observed_at: string; // ISO-8601
  signal_scope: "claude-only"; // Codex injection telemetry is the POL-1834 gap
  skills: SkillUsageRow[];
  notes: string[];
  unavailable_reason?: string; // present when status !== "ok"
  suggestions?: string[]; // operator guidance for non-ok backends; absent on the ok path
}

export type CuratorRecommendationAction =
  | "low-signal"
  | "archive-candidate"
  | "duplicate-candidate"
  | "consolidate-candidate";

export interface CuratorRecommendation {
  skill_id: string;
  provenance_class?: ProvenanceClass;
  current_status: SkillLifecycleStatus;
  action: CuratorRecommendationAction;
  rationale: string;
  use_count: number;
  signal_basis: "claude-only" | "none";
  /**
   * Present only on `consolidate-candidate`: the near-duplicate peer skill id
   * and the normalized similarity score (0..1) that flagged the pair. The pair
   * is reported once (lexicographically smaller id is `skill_id`).
   */
  consolidate_with?: string;
  similarity?: number;
}

export interface CuratorReport {
  schema_version: "skills.curator-report/v1";
  mode: "dry-run";
  observed_at: string;
  registry: { path: string; version: string };
  total_skills: number;
  provenance_breakdown: Record<string, number>;
  usage_backend: { status: SkillUsageBackendStatus; signal_scope: "claude-only"; codex_gap: string };
  recommendations: CuratorRecommendation[];
  summary: Record<CuratorRecommendationAction, number>;
  notes: string[];
}

/**
 * Receipt returned by `applyCuratorReport` (POL-1729 Slice 3). The curator's
 * deterministic apply only ARCHIVES (tombstones + prunes) deprecated
 * archive-candidates that are not pinned; consolidation is judgment work left to
 * the agent/operator `curator consolidate` verb. The rollback cursor is the
 * `skill_write_log.event_seq` high-water mark captured BEFORE any mutation, so
 * `curator rollback` can replay the pass window in reverse.
 */
export interface CuratorApplyReceipt {
  schema_version: "skills.curator-apply/v1";
  /** Deterministic pass id (host + ISO timestamp) recorded on every applied write-log row's note. */
  pass_id: string;
  host_id: string;
  observed_at: string;
  dry_run: boolean;
  /**
   * Blind-sensor gate: when the usage backend is not "ok" this is set, NOTHING
   * is mutated, and all counts are zero. A blind sensor never drives an actuator.
   */
  blocked?: { reason: string };
  /**
   * The write-log high-water mark captured before mutating (the rollback cursor).
   * `curator rollback --pass` replays rows with `event_seq > rollback_cursor`.
   * Null when blocked or when migration is absent.
   */
  rollback_cursor: number | null;
  /** Skill ids archived (tombstoned + pruned) this pass. */
  archived: string[];
  /** Archive-candidates skipped because they are pinned. */
  pinned_skipped: string[];
  /** Skill ids considered but skipped for a non-pin reason (e.g. already tombstoned). */
  skipped: string[];
  /** Consolidation candidates reported for the agent/operator (never auto-applied). */
  consolidate_candidates: CuratorRecommendation[];
  notes: string[];
}

export interface CuratorStatusReport {
  schema_version: "skills.curator-status/v1";
  observed_at: string;
  registry: { path: string; version: string };
  total_skills: number;
  provenance_breakdown: Record<string, number>;
  lifecycle_breakdown: Record<string, number>;
  usage_backend: { status: SkillUsageBackendStatus; endpoint: string; signal_scope: "claude-only" };
  notes: string[];
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

export interface PromptsRenderOptions {
  registryPath?: string;
  promptId: string;
  variables?: Record<string, string>;
  failOnUndeclaredVariables?: boolean;
  failOnUnresolvedPlaceholders?: boolean;
}

export interface PromptsRenderResult {
  promptId: string;
  registryPath: string;
  templatePath: string;
  renderedPrompt: string;
  variables: Record<string, string>;
  requiredVariables: string[];
  optionalVariables: string[];
  targets: string[];
  undeclaredVariables: string[];
  unresolvedPlaceholders: string[];
}

export type TaskStatus = "draft" | "active" | "paused" | "retired" | "failed_needs_attention";
export type TaskRuntimeBackend = "calyx" | "codex_app" | "claude_desktop" | "claude_routine";
export type TaskRuntimeAgent = string;
export type TaskReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type TaskExecutionEnvironment = string;
export type TaskTriggerType = "manual" | "schedule" | "event";
export type TaskInstallTargetStatus = "active" | "paused" | "retired" | "draft";

export interface TaskPredicateTriggerV1 {
  schema_version: "predicate/v1";
  kind: string;
  [key: string]: unknown;
}

export interface TaskScheduleTrigger {
  type: "schedule";
  rrule?: string;
  predicate?: TaskPredicateTriggerV1;
  timezone?: string;
  misfire_policy?: string;
  [key: string]: unknown;
}

export interface TaskManualTrigger {
  type: "manual";
  [key: string]: unknown;
}

export interface TaskEventTrigger {
  type: "event";
  event?: string;
  [key: string]: unknown;
}

export type TaskTrigger = TaskScheduleTrigger | TaskManualTrigger | TaskEventTrigger;

export interface TaskWorkspace {
  mode?: string;
  cwd?: string;
  cwds?: string[];
  [key: string]: unknown;
}

export interface TaskRuntime {
  backend: TaskRuntimeBackend;
  agent?: TaskRuntimeAgent;
  model?: string;
  reasoning_effort?: TaskReasoningEffort;
  execution_environment?: TaskExecutionEnvironment;
  workspace?: TaskWorkspace;
  [key: string]: unknown;
}

export interface TaskPrompt {
  body: string;
  skills?: string[];
  [key: string]: unknown;
}

export interface TaskState {
  memory?: string;
  control?: string;
  outputs?: string[];
  [key: string]: unknown;
}

export interface TaskSafety {
  max_concurrency?: number;
  timeout_minutes?: number;
  stale_lock_minutes?: number;
  unattended_writes?: string;
  destructive_actions?: string;
  requires_activity_quiet_window?: boolean;
  [key: string]: unknown;
}

export interface TaskInstallTarget {
  host: string;
  backend: TaskRuntimeBackend;
  status?: TaskInstallTargetStatus;
  [key: string]: unknown;
}

export interface TaskInstall {
  targets?: TaskInstallTarget[];
  [key: string]: unknown;
}

export interface TaskManifest {
  version: 1;
  id: string;
  name: string;
  status: TaskStatus;
  kind?: "task";
  owner?: string;
  description?: string;
  triggers: TaskTrigger[];
  runtime: TaskRuntime;
  prompt: TaskPrompt;
  state?: TaskState;
  safety?: TaskSafety;
  install?: TaskInstall;
  [key: string]: unknown;
}

export interface TaskManifestDocument {
  manifestPath: string;
  task: TaskManifest;
}

export interface TasksValidateOptions {
  strict?: boolean;
}

export interface TasksValidateResult extends DomainValidationResult {
  tasksDir: string;
  total: number;
  draft: number;
  active: number;
  paused: number;
  retired: number;
  failed_needs_attention: number;
}

export interface TasksListOptions {
  includePaused?: boolean;
  includeRetired?: boolean;
  statuses?: TaskStatus[];
}

export interface TaskListItem {
  id: string;
  name: string;
  status: TaskStatus;
  manifestPath: string;
  description?: string;
  runtimeBackend: TaskRuntimeBackend;
  agent?: TaskRuntimeAgent;
  model?: string;
  installTargets: TaskInstallTarget[];
}

export interface TasksListResult {
  tasksDir: string;
  total: number;
  items: TaskListItem[];
}

export interface TasksShowResult {
  tasksDir: string;
  manifestPath: string;
  task: TaskManifest;
}

export interface TasksCodexImportOptions {
  codexHome: string;
  outDir: string;
  id?: string;
}

export interface TasksCodexImportItem {
  id: string;
  sourcePath: string;
  outputPath: string;
  task: TaskManifest;
  warnings: DomainValidationIssue[];
}

export interface TasksCodexImportResult {
  codexHome: string;
  outDir: string;
  imported: TasksCodexImportItem[];
}

export interface TasksCodexRenderOptions {
  tasksDir: string;
  taskId: string;
  outDir: string;
  host?: string;
  now?: Date;
}

export type TaskRenderLossCode =
  | "manifest.field_not_representable"
  | "target.ambiguous"
  | "target.missing"
  | "target.field_not_representable"
  | "trigger.missing_rrule"
  | "trigger.extra"
  | "trigger.field_not_representable"
  | "prompt.field_not_representable"
  | "state.field_not_representable"
  | "safety.field_not_representable"
  | "runtime.backend_not_codex"
  | "runtime.agent_not_codex"
  | "runtime.execution_environment_not_supported"
  | "runtime.field_not_representable"
  | "workspace.missing"
  | "workspace.field_not_representable"
  | "workspace.cwd_conflict"
  | "status.not_representable";

export interface TaskRenderLoss {
  code: TaskRenderLossCode;
  path: string;
  related_paths?: string[];
  message: string;
}

export interface TaskRenderSelectedTarget {
  index: number | null;
  path: string;
  host: string;
  status_source_path: string;
}

export interface TaskRenderPreflightReceipt {
  schema_version: "calyx.task-render-preflight/v1";
  renderer: "codex_app";
  task_id: string;
  manifest_path?: string;
  requested_host: string | null;
  selected_target: TaskRenderSelectedTarget | null;
  ok: boolean;
  losses: TaskRenderLoss[];
}

export interface TasksCodexRenderPreflightOptions {
  host?: string;
  manifestPath?: string;
}

export interface CodexAutomationDocument {
  version: 1;
  id: string;
  kind: "cron";
  name: string;
  prompt: string;
  status: "ACTIVE" | "PAUSED";
  rrule: string;
  model?: string;
  reasoning_effort?: TaskReasoningEffort;
  execution_environment?: "local" | "sandbox";
  cwds?: string[];
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

export interface TasksCodexRenderResult {
  id: string;
  taskId: string;
  host: string;
  outDir: string;
  automationDir: string;
  automationPath: string;
  automation: CodexAutomationDocument;
  tomlText: string;
  warnings: DomainValidationIssue[];
}

export type CodexAutomationDefinitionAuthority = "codex_toml";
export type CodexAutomationMutationAuthority = "unavailable" | "codex_app_tool";
export type CodexAutomationProjectionStatus = "observed" | "missing" | "drifted" | "unavailable";
export type CodexAutomationDefinitionStatus = "observed" | "malformed" | "unreadable" | "changed_during_read";
export type CodexAutomationGovernanceKind = "task_manifest" | "exemption" | "none";
export type CodexAutomationClassification =
  | "governed_current"
  | "governed_paused"
  | "ungoverned_active"
  | "ungoverned_paused"
  | "explicit_exemption"
  | "distinct_project_binding"
  | "duplicate"
  | "expired_finite_schedule"
  | "finite_schedule_indeterminate"
  | "definition_projection_drift"
  | "lossy_blocked"
  | "definition_invalid";

export interface CodexAutomationProjectionRow {
  id: string;
  name: string;
  status: string;
  rrule: string;
  cwds: string[];
  next_run_at: number | null;
  last_run_at: number | null;
}

export interface CodexAutomationObservationFinding {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  automation_id?: string;
  path?: string;
  expected?: unknown;
  observed?: unknown;
}

export interface CodexAutomationGovernanceObservation {
  kind: CodexAutomationGovernanceKind;
  source_path: string | null;
  source_digest: string | null;
  install_id: string | null;
  status: "current" | "drifted" | "expired" | "lossy" | "missing";
  classification: string | null;
  loss_receipt: TaskRenderPreflightReceipt | null;
}

export interface CodexAutomationObservationItem {
  id: string;
  definition_path: string;
  definition_status: CodexAutomationDefinitionStatus;
  definition_digest: string | null;
  definition_authority: CodexAutomationDefinitionAuthority;
  mutation_authority: CodexAutomationMutationAuthority;
  name: string | null;
  status: "ACTIVE" | "PAUSED" | null;
  rrule: string | null;
  cwds: string[] | null;
  projection: CodexAutomationProjectionStatus;
  projection_row: CodexAutomationProjectionRow | null;
  governance: CodexAutomationGovernanceObservation;
  classifications: CodexAutomationClassification[];
  duplicate_of: string | null;
  findings: CodexAutomationObservationFinding[];
}

export interface ObserveCodexAutomationsOptions {
  codexHome: string;
  codexDatabasePath?: string;
  tasksDir?: string;
  governancePath?: string;
  calyxStateDatabasePath?: string;
  mutationAuthority?: CodexAutomationMutationAuthority;
  now?: Date;
}

export interface ObserveCodexAutomationsResult {
  schema_version: "calyx.tasks-codex-observation/v1";
  ok: boolean;
  observed_at: string;
  codex_home: string;
  codex_database_path: string | null;
  tasks_dir: string | null;
  governance_path: string | null;
  definition_authority: CodexAutomationDefinitionAuthority;
  mutation_authority: CodexAutomationMutationAuthority;
  counts: {
    definitions: number;
    active: number;
    paused: number;
    projection_observed: number;
    projection_missing: number;
    projection_drifted: number;
    projection_unavailable: number;
    errors: number;
    warnings: number;
  };
  items: CodexAutomationObservationItem[];
  findings: CodexAutomationObservationFinding[];
}

export type AgentLifecycleStatus = "active" | "blocked" | "deprecated" | "archived" | "retired";

export type AgentLaunchBackend = "claude" | "codex";
export type AgentBackendSelectionStrategy = "prefer_different_from_requester" | "first_available";

export interface AgentLifecycleMetadata {
  status?: AgentLifecycleStatus;
  blocked_reason?: string;
  blocked_by?: string[];
  replaced_by?: string;
  archived_at?: string;
  retired_at?: string;
  [key: string]: unknown;
}

export interface AgentRegistryEntry {
  id: string;
  path: string;
  status?: AgentLifecycleStatus;
  lifecycle?: AgentLifecycleMetadata;
  description?: string;
  [key: string]: unknown;
}

export interface AgentsRegistry {
  version: string;
  generated_at?: string;
  agents: AgentRegistryEntry[];
  [key: string]: unknown;
}

export interface AgentDefinitionInput {
  type: string;
  required?: boolean;
  required_if?: string;
  default?: string | number | boolean;
  values?: Array<string | number | boolean>;
  repeatable?: boolean;
  [key: string]: unknown;
}

export type AgentJsonPrimitive = string | number | boolean | null;
export type AgentJsonValue = AgentJsonPrimitive | AgentJsonValue[] | { [key: string]: AgentJsonValue };

export interface AgentRunOutputCapture {
  name: string;
  source: "agent_terminal_message";
  media_type: "application/json";
  schema: AgentJsonValue;
  max_bytes: number;
  required: true;
}

export interface AgentArtifactWrite {
  path: string;
  location?: string;
  source?: "agent_terminal_message";
  media_type?: "application/json";
  schema?: AgentJsonValue;
  max_bytes?: number;
  required?: true;
  [key: string]: unknown;
}

export interface AgentDefinition {
  version: number;
  kind: "agent";
  id: string;
  status: AgentLifecycleStatus;
  owner: string;
  contract_version: number;
  description: string;
  persona: {
    template: string;
    skills?: string[];
    curricula?: string[];
    [key: string]: unknown;
  };
  inputs?: Record<string, AgentDefinitionInput>;
  execution: {
    kernel: "agent_runner";
    backend: {
      strategy?: AgentBackendSelectionStrategy;
      fallback_order?: AgentLaunchBackend[];
      allowed?: AgentLaunchBackend[];
      [key: string]: unknown;
    };
    model?: Partial<Record<AgentLaunchBackend, string>>;
    reasoning_effort?: string;
    safety?: {
      timeout_minutes?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  posture?: {
    workspace_mutation?: "forbidden" | "allowed" | "restricted";
    artifact_writes?: AgentArtifactWrite[];
    delivery_writes?: Array<{ surface: string; required?: boolean; required_if?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  context?: {
    type?: string;
    worktree?: {
      mode?: "existing" | "managed" | "create";
      [key: string]: unknown;
    };
    target_pinning?: "required" | "optional";
    [key: string]: unknown;
  };
  output?: {
    required_artifacts?: string[];
    [key: string]: unknown;
  };
  delivery?: Record<string, unknown>;
  surfaces?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentsIndexOptions {
  includeActive?: boolean;
  includeBlocked?: boolean;
  includeDeprecated?: boolean;
  includeArchived?: boolean;
  includeRetired?: boolean;
}

export interface AgentsIndexItem {
  id: string;
  status: AgentLifecycleStatus;
  path: string;
  definition_path: string;
  description?: string;
  owner?: string;
  contract_version?: number;
  lifecycle?: AgentLifecycleMetadata;
}

export interface AgentsIndexResult {
  version: string;
  registry_path: string;
  total: number;
  items: AgentsIndexItem[];
}

export interface AgentsShowResult {
  version: string;
  registry_path: string;
  definition_path: string;
  status: AgentLifecycleStatus;
  lifecycle?: AgentLifecycleMetadata;
  agent: AgentDefinition;
}

export interface AgentsValidateOptions {
  strict?: boolean;
}

export interface AgentsValidateResult extends DomainValidationResult {
  version: string;
  registry_path: string;
  total: number;
  active: number;
  blocked: number;
  deprecated: number;
  archived: number;
  retired: number;
}

export interface AgentLaunchTarget {
  /** Canonical host-truth slug, or the explicit path for path-authoritative launches. */
  repo: string;
  /** Operator-supplied identifier retained only when canonicalization changed it. */
  requested_repo?: string;
  repo_resolution_source?: "registry" | "explicit_path" | "cwd_remote";
  scope: "pr" | "branch";
  pr?: number;
  branch?: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  head_sha: string;
  merge_base_sha: string;
  resolved_at: string;
  warnings?: string[];
}

export interface AgentProcedureRef {
  kind: "curriculum" | "skill";
  id: string;
  digest: string;
  digest_algorithm: "sha256-file-v1" | "sha256-dir-v1";
  mode: "embedded" | "host-resolved";
  source_path: string;
}

export interface AgentDefinitionSource {
  repo?: string;
  commit?: string;
  path: string;
  dirty: boolean;
}

export interface AgentDefinitionSnapshotFile {
  path: string;
  sha256: string;
  contents: string;
}

export interface AgentDefinitionSnapshot {
  mode: "inline";
  files: AgentDefinitionSnapshotFile[];
}

export interface AgentDefinitionProvenance {
  definition_ref: string;
  agent_ref: string;
  definition_digest: string;
  definition_digest_algorithm: "agent-dir-v1";
  definition_source: AgentDefinitionSource;
  definition_snapshot?: AgentDefinitionSnapshot;
  procedure_refs: AgentProcedureRef[];
}

export interface AgentCompiledLaunchResult {
  agent_id: string;
  registry_path: string;
  definition_path: string;
  prompt: string;
  backend: AgentLaunchBackend;
  backend_strategy: AgentBackendSelectionStrategy;
  model?: string;
  reasoning_effort?: string;
  repo?: string;
  worktree_mode?: "existing" | "managed" | "create";
  worktree_ref?: string;
  branch?: string;
  required_artifacts: string[];
  output_capture?: AgentRunOutputCapture;
  backend_options: Record<string, unknown>;
  target?: AgentLaunchTarget;
  resolved_vars: Record<string, unknown>;
  provenance: AgentDefinitionProvenance;
  metadata: Record<string, unknown>;
}

export type KnowledgeArtifactKind = "execplan" | "transcript" | "report" | "runbook" | "reference";

export interface KnowledgeArtifactEntry {
  id: string;
  title: string;
  kind: KnowledgeArtifactKind;
  source_path?: string;
  tags?: string[];
  linked_issues?: string[];
  created_at?: string;
  metadata?: Record<string, unknown>;
  frontmatter?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface KnowledgeRegistry {
  version: string;
  artifacts: KnowledgeArtifactEntry[];
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

export interface KnowledgeValidateResult extends DomainValidationResult {
  version: string;
  total: number;
}

// ── Wrapper guardrails ──────────────────────────────────────────────

export type WrapperDeprecationPhase = "active" | "warn" | "error";

export type WrapperStatus = "implemented" | "deferred" | "deprecated" | "retired";

export interface WrapperDefinition {
  wrapper: string;
  target: string;
  status: WrapperStatus;
  phase: string;
  notes?: string;
  /** ISO-8601 date when this wrapper was retired. Present only for retired wrappers. */
  retiredAt?: string;
  /** ISO-8601 date when this wrapper was explicitly deprecated. Present only for deprecated wrappers. */
  deprecatedAt?: string;
  /** Explicit rationale for the deprecation decision. */
  rationale?: string;
  /** Canonical commands operators should use instead. */
  alternatives?: string[];
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

// ── Exec lifecycle domain ───────────────────────────────────────────

export type ExecRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ExecLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ExecRunRecord {
  run_id: string;
  command: string;
  state: ExecRunState;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  logs?: ExecLogEntry[];
}

export interface ExecRunStore {
  version: string;
  runs: ExecRunRecord[];
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

export interface ExecValidateResult extends DomainValidationResult {
  version: string;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

// ── Exec notify ─────────────────────────────────────────────────────

export type ExecNotifyChannel = "stdout" | "ntfy" | "agent-mail";

export interface ExecNotifyOptions {
  message: string;
  level?: "info" | "warn" | "error";
  channel?: ExecNotifyChannel;
  title?: string;
}

export interface ExecNotifyResult {
  message: string;
  level: "info" | "warn" | "error";
  channel: ExecNotifyChannel;
  title?: string;
  timestamp: string;
  delivered: boolean;
}

// ── Doctor (health check) ───────────────────────────────────────────

export type DoctorDomainHealth = "ok" | "warning" | "error" | "unconfigured";

export interface DoctorDomainStatus {
  domain: string;
  health: DoctorDomainHealth;
  path?: string;
  source?: string;
  message?: string;
}

export interface DoctorOptions {
  json?: boolean;
  host?: string;
  agentsInfraRoot?: string;
  includeRepoRegistry?: boolean;
}

export type DoctorFindingCode = "daemon-serves-from-clone";

export interface DoctorFinding {
  code: DoctorFindingCode;
  severity: "error";
  message: string;
  evidence: string[];
  remediation: string;
}

export type RepoRegistryRootHealth = "ok" | "error";

export type RepoRegistryRootCode =
  | "repo-root-ok"
  | "repo-root-missing"
  | "repo-root-not-directory"
  | "repo-root-not-git-repository"
  | "repo-root-check-error";

export interface RepoRegistryRootStatus {
  host: string;
  repo: string;
  configured_root: string;
  source: string;
  ok: boolean;
  health: RepoRegistryRootHealth;
  code: RepoRegistryRootCode;
  aliases?: string[];
  normalized_aliases?: string[];
  /** Identities authored directly in fleet truth. */
  configured_aliases?: string[];
  /** Collision-checked convention aliases derived from configured truth. */
  derived_aliases?: string[];
  git_toplevel?: string;
  message?: string;
  remediation?: string;
}

export interface RepoRegistryAliasCollision {
  normalized_identity: string;
  aliases: string[];
  repos: string[];
}

export interface RepoRegistryDoctorResult {
  ok: boolean;
  host: string;
  source_path: string;
  roots: RepoRegistryRootStatus[];
  alias_collisions?: RepoRegistryAliasCollision[];
  code?: "repo-registry-input-error";
  message?: string;
  remediation?: string;
}

export interface DoctorResult {
  ok: boolean;
  timestamp: string;
  domains: DoctorDomainStatus[];
  repoRegistry?: RepoRegistryDoctorResult;
  findings?: DoctorFinding[];
}

// ── Verify fleet ────────────────────────────────────────────────────

export interface VerifyFleetOptions {
  strict?: boolean;
}

export interface VerifyFleetDomainResult {
  domain: string;
  ok: boolean;
  errors: number;
  warnings: number;
  message?: string;
}

export interface VerifyFleetResult {
  ok: boolean;
  timestamp: string;
  domains: VerifyFleetDomainResult[];
}

// ── Tools versions bump ─────────────────────────────────────────────

export interface ToolVersionBumpOptions {
  tool: string;
  to: string;
  apply?: boolean;
}

export interface ToolVersionBumpResult {
  tool: string;
  from: string | undefined;
  to: string;
  apply: boolean;
  action: "plan-bump" | "bump" | "not-found";
}

// ── Bundle build ────────────────────────────────────────────────────

export interface BundleBuildOptions {
  path: string;
  outDir?: string;
  apply?: boolean;
}

export interface BundleBuildResult {
  name: string;
  version: string;
  path: string;
  outDir: string;
  apply: boolean;
  action: "plan-build" | "build";
}

// ── Install bootstrap ───────────────────────────────────────────────

export interface InstallBootstrapOptions {
  target?: string;
  apply?: boolean;
  executablePath?: string;
  installsRoot?: string;
}

export interface InstallBootstrapStaleBuild {
  executablePath: string;
  packageDir: string;
  workspaceRoot: string;
  newestSourcePath: string;
  remediation: string;
}

export interface InstallBootstrapResult {
  target: string;
  apply: boolean;
  action: "plan-bootstrap" | "bootstrap" | "blocked-bootstrap";
  steps: string[];
  wrapperPath: string;
  sourceExecutablePath?: string;
  /** Set when bootstrap found (plan) or deleted (apply) the retired `calyx.legacy` shadow wrapper. */
  retiredLegacyWrapperPath?: string;
  warnings?: string[];
  staleBuild?: InstallBootstrapStaleBuild;
}

// ── Knowledge execplan new ──────────────────────────────────────────

export type KnowledgeExecPlanKind = "implementation" | "planning" | "research";

export type KnowledgeExecPlanState =
  | "draft"
  | "ready"
  | "in_progress"
  | "done"
  | "blocked"
  | "superseded";

export type KnowledgeExecPlanRunnerHarness = "codex-cli" | "claude-code" | "human";

export type KnowledgeExecPlanRunnerMode = "interactive" | "exec";

export interface KnowledgeExecPlanNewOptions {
  title: string;
  issueId?: string;
  kind?: KnowledgeExecPlanKind;
  state?: KnowledgeExecPlanState;
  owner?: string;
  scope?: string;
  targetRepo?: string;
  targetBranch?: string;
  targetWorkdir?: string;
  targetHosts?: string[];
  runnerHarness?: KnowledgeExecPlanRunnerHarness;
  runnerMode?: KnowledgeExecPlanRunnerMode;
  outPath?: string;
  apply?: boolean;
}

export interface KnowledgeExecPlanNewResult {
  id: string;
  title: string;
  issueId?: string;
  kind: KnowledgeExecPlanKind;
  state: KnowledgeExecPlanState;
  outPath?: string;
  content: string;
  apply: boolean;
  action: "plan-create" | "create";
}

export interface KnowledgeExecPlanPromoteOptions {
  inputPath: string;
  title?: string;
  issueId?: string;
  project?: string;
  workstream?: string;
  author?: string;
  assignee?: string;
  updated?: string;
  updatedBy?: string;
  status?: string;
  vaultPath?: string;
  dryRun?: boolean;
}

export interface KnowledgeExecPlanPromoteResult {
  sourcePath: string;
  outputPath: string;
  relativePath: string;
  title: string;
  issueId?: string;
  dryRun: boolean;
  action: "plan-promote" | "promote";
  content: string;
}

// ── Knowledge docstore adapter ──────────────────────────────────────

export type DocstoreAdapterVerb = "search" | "get" | "list";

export interface DocstoreAdapterOptions {
  verb: DocstoreAdapterVerb;
  query?: string;
  id?: string;
}

export interface DocstoreAdapterResult {
  verb: DocstoreAdapterVerb;
  delegated: boolean;
  exitCode: number;
  output: string;
}

// ── Agent-mail extension adapter ────────────────────────────────────

export type AgentMailVerb = "status" | "send" | "inbox" | "read";

export interface AgentMailAdapterOptions {
  verb: AgentMailVerb;
  projectKey?: string;
  threadId?: string;
  message?: string;
}

export interface AgentMailAdapterResult {
  verb: AgentMailVerb;
  delegated: boolean;
  exitCode: number;
  output: string;
}

// ── Context (ctxpack) contract v1 ───────────────────────────────────

export type CtxpackContractVersion = "v1";

export type CtxpackPrimitiveV1 = "capabilities" | "plan" | "pack" | "docs" | "introspect";

export type CtxpackErrorCodeV1 =
  | "validation_error"
  | "not_found"
  | "capability_unavailable"
  | "adapter_error"
  | "internal_error";

export interface CtxpackDeterminismMetaV1 {
  normalized: boolean;
  normalization_version: string;
  plan_hash_input?: string;
  plan_hash?: string;
}

export interface CtxpackCapabilityV1 {
  primitive: CtxpackPrimitiveV1;
  available: boolean;
  since: CtxpackContractVersion;
  notes?: string;
}

export type CtxpackProviderIdV1 =
  | "claude"
  | "codex"
  | "aider"
  | "continue"
  | "cursor"
  | "gemini"
  | "hermes"
  | "windsurf"
  | "zed";

export type CtxpackCapabilityFlagStatusV1 = "ready" | "planned" | "capability_unavailable";

export type CtxpackProviderTierV1 = "tier_0" | "tier_1" | "tier_2";

export type CtxpackCapabilityReasonCodeV1 =
  | "adapter_not_implemented"
  | "adapter_not_installed"
  | "adapter_path_missing"
  | "adapter_permission_denied"
  | "adapter_parse_error"
  | "adapter_unsupported_version"
  | "adapter_internal"
  | "provider_not_supported"
  | "include_undetected_required";

export type CtxpackPlanOmissionReasonCodeV1 =
  | "not_included_by_pattern"
  | "excluded_by_pattern"
  | "non_regular_file";

export type CtxpackPlanBudgetReasonCodeV1 =
  | "budget_bytes_exceeded"
  | "budget_tokens_exceeded"
  | "budget_bytes_and_tokens_exceeded";

export type CtxpackPlanGitReasonCodeV1 =
  | "git_meta_disabled"
  | "git_repo_not_detected"
  | "git_probe_error";

export type CtxpackPlanSessionReasonCodeV1 =
  | "sessions_opted_out"
  | "session_adapters_unavailable";

export interface CtxpackProviderCapabilityFlagsV1 {
  detect: CtxpackCapabilityFlagStatusV1;
  list: CtxpackCapabilityFlagStatusV1;
  read: CtxpackCapabilityFlagStatusV1;
  normalize: CtxpackCapabilityFlagStatusV1;
  evidence: CtxpackCapabilityFlagStatusV1;
}

export interface CtxpackProviderPrimitiveSupportV1 {
  capabilities: boolean;
  plan: boolean;
  pack: boolean;
  docs: boolean;
  introspect: boolean;
}

export interface CtxpackProviderPrimitiveStatusV1 {
  status: CtxpackCapabilityFlagStatusV1;
  reason_code?: CtxpackCapabilityReasonCodeV1;
  evidence: string[];
}

export interface CtxpackProviderPrimitiveStatusMapV1 {
  capabilities: CtxpackProviderPrimitiveStatusV1;
  plan: CtxpackProviderPrimitiveStatusV1;
  pack: CtxpackProviderPrimitiveStatusV1;
  docs: CtxpackProviderPrimitiveStatusV1;
  introspect: CtxpackProviderPrimitiveStatusV1;
}

export interface CtxpackCapabilityEvidenceV1 {
  probe: string;
  result: "success" | "missing" | "error";
  detail?: string;
  reason_code?: CtxpackCapabilityReasonCodeV1;
  metadata?: Record<string, unknown>;
}

export interface CtxpackProviderCapabilityV1 {
  provider: CtxpackProviderIdV1;
  tier: CtxpackProviderTierV1;
  detected: boolean;
  capability_flags: CtxpackProviderCapabilityFlagsV1;
  primitives: CtxpackProviderPrimitiveSupportV1;
  primitive_status: CtxpackProviderPrimitiveStatusMapV1;
  reasons?: CtxpackCapabilityReasonCodeV1[];
  alias_trace?: CtxpackProviderAliasTraceV1[];
  evidence: CtxpackCapabilityEvidenceV1[];
}

export interface CtxpackPlanFileEntryV1 {
  root: string;
  path: string;
  bytes: number;
  tokens_estimate: number;
}

export interface CtxpackPlanOmittedEntryV1 {
  root: string;
  path: string;
  reason_code: CtxpackPlanOmissionReasonCodeV1;
  matched_pattern?: string;
}

export interface CtxpackPlanTruncationCandidateV1 {
  root: string;
  path: string;
  bytes: number;
  tokens_estimate: number;
  reason_code: CtxpackPlanBudgetReasonCodeV1;
}

export interface CtxpackPlanBudgetReportV1 {
  max_bytes?: number;
  max_tokens?: number;
  estimated_bytes: number;
  estimated_tokens: number;
  selected_bytes: number;
  selected_tokens: number;
  within_budget: boolean;
  over_budget_by: {
    bytes: number;
    tokens: number;
  };
  truncation_candidates: CtxpackPlanTruncationCandidateV1[];
}

export interface CtxpackPlanSessionPolicyV1 {
  included: boolean;
  planned_count: number;
  reason_code: CtxpackPlanSessionReasonCodeV1;
}

export interface CtxpackPlanGitProbeV1 {
  probe: string;
  result: "success" | "missing" | "error";
  detail?: string;
  reason_code?: CtxpackPlanGitReasonCodeV1;
}

export interface CtxpackPlanGitMetaV1 {
  included: boolean;
  detected: boolean;
  reason_code?: CtxpackPlanGitReasonCodeV1;
  root?: string;
  branch?: string;
  tracked_changes?: number;
  untracked_files?: number;
  probes: CtxpackPlanGitProbeV1[];
}

export interface CtxpackPlanStatsV1 {
  roots_scanned: number;
  files_considered: number;
  files_selected: number;
  files_omitted: number;
}

export interface CtxpackProviderAliasTraceV1 {
  input: string;
  canonical_slug: string;
  canonical_provider?: CtxpackProviderIdV1;
  matched_alias?: string;
}

export type CtxpackAdapterErrorCodeV1 =
  | "ADAPTER_NOT_INSTALLED"
  | "ADAPTER_PATH_MISSING"
  | "ADAPTER_PERMISSION_DENIED"
  | "ADAPTER_PARSE_ERROR"
  | "ADAPTER_UNSUPPORTED_VERSION"
  | "ADAPTER_INTERNAL";

export interface CtxpackSessionHandleV1 {
  provider: CtxpackProviderIdV1;
  provider_slug: string;
  session_id: string;
  session_slug: string;
  source_path: string;
  detected_root: string;
  bytes: number;
  modified_at: string;
}

export interface CtxpackProviderSessionRecordV1 {
  provider: CtxpackProviderIdV1;
  handle: CtxpackSessionHandleV1;
  entries: Record<string, unknown>[];
}

export interface CtxpackNormalizedSessionV1 {
  provider: CtxpackProviderIdV1;
  provider_slug: string;
  session_id: string;
  session_slug: string;
  source_path: string;
  event_count: number;
  started_at?: string;
  last_event_at?: string;
}

export interface CtxpackProviderDetectionReportV1 {
  provider: CtxpackProviderIdV1;
  provider_slug: string;
  detected: boolean;
  detected_root?: string;
  reasons?: CtxpackCapabilityReasonCodeV1[];
  evidence: CtxpackCapabilityEvidenceV1[];
}

export interface CtxpackSessionListQueryV1 {
  limit?: number;
}

export interface SessionProviderAdapter {
  provider: CtxpackProviderIdV1;
  detect(): CtxpackProviderDetectionReportV1;
  listSessions(query?: CtxpackSessionListQueryV1): CtxpackSessionHandleV1[];
  readSession(handle: CtxpackSessionHandleV1): CtxpackProviderSessionRecordV1;
  normalize(session: CtxpackProviderSessionRecordV1): CtxpackNormalizedSessionV1;
  capabilities(): CtxpackProviderCapabilityFlagsV1;
}

export interface CtxpackRequestBaseV1 {
  version: CtxpackContractVersion;
  primitive: CtxpackPrimitiveV1;
  request_id?: string;
  json?: boolean;
}

export interface CtxpackCapabilitiesRequestV1 extends CtxpackRequestBaseV1 {
  primitive: "capabilities";
  include_undetected?: boolean;
  providers?: string[];
}

export type CtxpackContextProfileV1 = "default" | "chatgpt-web";

export type CtxpackSourceRefTypeV1 =
  | "vault_ref"
  | "vault_query"
  | "activity_ref"
  | "file_ref"
  | "capture_ref"
  | "unsupported";

export type CtxpackSourceGraphWarningCodeV1 =
  | "unsupported_seed_type"
  | "vault_search_capability_unavailable"
  | "vault_search_fallback_used"
  | "vault_search_fallback_incomplete"
  | "vault_fetch_truncated"
  | "source_budget_exceeded"
  | "source_resolution_failed";

export interface CtxpackSourceGraphWarningV1 {
  code: CtxpackSourceGraphWarningCodeV1;
  message: string;
  seed?: string;
  source_id?: string;
  detail?: Record<string, unknown>;
}

export interface CtxpackSeedPlanV1 {
  input: string;
  source_type: CtxpackSourceRefTypeV1;
  status: "selected" | "omitted" | "unsupported" | "error";
  reason: string;
  selected_source_ids: string[];
  omitted_count: number;
  warnings: CtxpackSourceGraphWarningV1[];
}

export interface CtxpackSourceGraphNodeV1 {
  id: string;
  source_type: Exclude<CtxpackSourceRefTypeV1, "unsupported">;
  seed: string;
  reason_selected: string;
  title?: string;
  vault_uri?: string;
  relative_path?: string;
  absolute_path?: string;
  source_path?: string;
  bytes?: number;
  returned_bytes?: number;
  tokens_estimate?: number;
  content_sha256?: string;
  mtime?: string;
  truncated?: boolean;
  frontmatter?: Record<string, unknown>;
  provenance: {
    adapter: string;
    operation: string;
    evidence: string;
  };
  trust?: VaultTrustPosture;
}

export interface CtxpackSourceGraphOmittedV1 {
  seed: string;
  source_type: CtxpackSourceRefTypeV1;
  reason_code: "budget_bytes_exceeded" | "budget_tokens_exceeded" | "unsupported_seed_type" | "candidate_limit_exceeded" | "resolution_failed";
  message: string;
  candidate?: {
    vault_uri?: string;
    relative_path?: string;
    title?: string;
  };
}

export interface CtxpackSourceGraphV1 {
  profile: CtxpackContextProfileV1;
  goal?: string;
  seeds: CtxpackSeedPlanV1[];
  nodes: CtxpackSourceGraphNodeV1[];
  omitted: CtxpackSourceGraphOmittedV1[];
  warnings: CtxpackSourceGraphWarningV1[];
  trust: VaultTrustPosture;
  stats: {
    seeds_requested: number;
    nodes_selected: number;
    nodes_omitted: number;
    warnings: number;
    bytes_selected: number;
    tokens_estimate: number;
  };
}

export interface CtxpackVaultCandidateReportV1 {
  selected: Array<{
    seed: string;
    vault_uri: string;
    relative_path: string;
    title?: string;
    snippet?: string;
  }>;
  omitted_count: number;
}

export interface CtxpackPlanRequestV1 extends CtxpackRequestBaseV1 {
  primitive: "plan";
  goal?: string;
  profile?: CtxpackContextProfileV1;
  seeds?: string[];
  vault_path?: string;
  roots?: string[];
  include_sessions?: boolean;
  include_git_meta?: boolean;
  include?: string[];
  exclude?: string[];
  budget?: {
    max_bytes?: number;
    max_tokens?: number;
  };
  inputs?: Record<string, unknown>;
}

export interface CtxpackPackRequestV1 extends CtxpackRequestBaseV1 {
  primitive: "pack";
  goal?: string;
  profile?: CtxpackContextProfileV1;
  seeds?: string[];
  vault_path?: string;
  budget?: {
    max_bytes?: number;
    max_tokens?: number;
  };
  include?: string[];
  exclude?: string[];
  plan_hash?: string;
  out_dir?: string;
  apply?: boolean;
  redaction_mode?: "strict" | "advisory";
}

export interface CtxpackDocsRequestV1 extends CtxpackRequestBaseV1 {
  primitive: "docs";
  bundle_path?: string;
  format?: "markdown" | "json";
  topic?: string;
}

export interface CtxpackIntrospectRequestV1 extends CtxpackRequestBaseV1 {
  primitive: "introspect";
  bundle_path?: string;
  enable_experimental?: boolean;
  target?: string;
}

export type CtxpackRequestV1 =
  | CtxpackCapabilitiesRequestV1
  | CtxpackPlanRequestV1
  | CtxpackPackRequestV1
  | CtxpackDocsRequestV1
  | CtxpackIntrospectRequestV1;

export interface CtxpackCapabilitiesResponseDataV1 {
  include_undetected: boolean;
  primitives: CtxpackCapabilityV1[];
  providers: CtxpackProviderCapabilityV1[];
  exit_code_map: Record<CtxpackErrorCodeV1, number>;
}

export interface CtxpackPlanResponseDataV1 {
  plan_version: "ctxpack.plan.v1";
  plan_hash?: string;
  plan_hash_input?: string;
  goal?: string;
  profile?: CtxpackContextProfileV1;
  source_graph?: CtxpackSourceGraphV1;
  vault_candidates?: CtxpackVaultCandidateReportV1;
  warnings?: CtxpackSourceGraphWarningV1[];
  apply_command?: string;
  roots: string[];
  include_patterns: string[];
  exclude_patterns: string[];
  default_exclude_patterns: string[];
  include_sessions: boolean;
  include_git_meta: boolean;
  files: {
    selected: CtxpackPlanFileEntryV1[];
    omitted: CtxpackPlanOmittedEntryV1[];
  };
  budget: CtxpackPlanBudgetReportV1;
  sessions: CtxpackPlanSessionPolicyV1;
  git_meta: CtxpackPlanGitMetaV1;
  stats: CtxpackPlanStatsV1;
  exit_code_map: Record<CtxpackErrorCodeV1, number>;
}

export type CtxpackPackRedactionReasonCodeV1 = "credential_pattern" | "secret_assignment";

export interface CtxpackPackManifestEntryV1 {
  root: string;
  path: string;
  source_path: string;
  bundle_path: string;
  source_type?: CtxpackSourceRefTypeV1;
  vault_uri?: string;
  trust_posture?: string;
  bytes_source: number;
  bytes_packed: number;
  tokens_estimate: number;
  sha256_source: string;
  sha256_packed: string;
  redaction_applied: boolean;
  redaction_match_count: number;
}

export interface CtxpackPackRedactionEntryV1 {
  root: string;
  path: string;
  line: number;
  reason_code: CtxpackPackRedactionReasonCodeV1;
  source_preview: string;
}

export interface CtxpackPackRedactionReportV1 {
  mode: "strict" | "advisory";
  entries: CtxpackPackRedactionEntryV1[];
  redacted_files: number;
  redaction_events: number;
}

export interface CtxpackPackTruncationReportV1 {
  omitted: CtxpackPlanOmittedEntryV1[];
  truncation_candidates: CtxpackPlanTruncationCandidateV1[];
  sessions_reason_code: CtxpackPlanSessionReasonCodeV1;
  sessions_planned_count: number;
  reason_counters: Record<string, number>;
  omitted_total: number;
  truncation_total: number;
}

export interface CtxpackPackSummaryV1 {
  pack_version: "ctxpack.pack.v1";
  plan_hash: string;
  profile?: CtxpackContextProfileV1;
  goal?: string;
  apply: boolean;
  out_dir: string;
  docs_path?: string;
  files_selected: number;
  files_materialized: number;
  bytes_source: number;
  bytes_packed: number;
  redaction_mode: "strict" | "advisory";
  redacted_files: number;
  redaction_events: number;
  omitted_total: number;
  truncation_total: number;
}

export interface CtxpackPackResponseDataV1 {
  pack_version: "ctxpack.pack.v1";
  plan_hash: string;
  profile?: CtxpackContextProfileV1;
  goal?: string;
  apply: boolean;
  out_dir: string;
  manifest_path: string;
  summary_path: string;
  docs_path?: string;
  files_root: string;
  source_graph?: CtxpackSourceGraphV1;
  warnings?: CtxpackSourceGraphWarningV1[];
  manifest: CtxpackPackManifestEntryV1[];
  redaction: CtxpackPackRedactionReportV1;
  truncation: CtxpackPackTruncationReportV1;
  summary: CtxpackPackSummaryV1;
  exit_code_map: Record<CtxpackErrorCodeV1, number>;
}

export interface CtxpackDocsSectionV1 {
  id: "bundle" | "profile" | "sources" | "files" | "redaction" | "truncation";
  heading: string;
  body: string[];
}

export interface CtxpackDocsResponseDataV1 {
  docs_version: "ctxpack.docs.v1";
  format: "markdown" | "json";
  bundle_path: string;
  pack_version: string;
  plan_hash: string;
  topic?: string;
  sections: CtxpackDocsSectionV1[];
  markdown?: string;
  summary: CtxpackPackSummaryV1;
  exit_code_map: Record<CtxpackErrorCodeV1, number>;
}

export interface CtxpackIntrospectCountV1 {
  key: string;
  count: number;
}

export interface CtxpackIntrospectResponseDataV1 {
  introspect_version: "ctxpack.introspect.v1";
  bundle_path: string;
  plan_hash: string;
  target?: string;
  metrics: {
    files_total: number;
    redacted_files: number;
    redaction_events: number;
    omitted_total: number;
    truncation_total: number;
    bytes_source: number;
    bytes_packed: number;
    roots: CtxpackIntrospectCountV1[];
    extensions: CtxpackIntrospectCountV1[];
  };
  exit_code_map: Record<CtxpackErrorCodeV1, number>;
}

export interface CtxpackErrorPayloadV1 {
  code: CtxpackErrorCodeV1;
  exit_code: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface CtxpackErrorEnvelopeV1 {
  version: CtxpackContractVersion;
  ok: false;
  primitive?: CtxpackPrimitiveV1;
  error: CtxpackErrorPayloadV1;
}

export interface CtxpackSuccessEnvelopeV1<
  TPrimitive extends CtxpackPrimitiveV1 = CtxpackPrimitiveV1,
  TData extends object = object
> {
  version: CtxpackContractVersion;
  ok: true;
  primitive: TPrimitive;
  determinism: CtxpackDeterminismMetaV1;
  data: TData;
}

export type CtxpackOutputEnvelopeV1 = CtxpackSuccessEnvelopeV1 | CtxpackErrorEnvelopeV1;

export type CtxpackFixtureRunnerV1 = (
  request: CtxpackRequestV1
) => CtxpackOutputEnvelopeV1 | Promise<CtxpackOutputEnvelopeV1>;

export interface CtxpackFixtureCaseV1 {
  id: string;
  request: CtxpackRequestV1;
  expected: CtxpackOutputEnvelopeV1;
}

export interface CtxpackFixtureExecutionV1 {
  id: string;
  request: CtxpackRequestV1;
  output: CtxpackOutputEnvelopeV1;
  normalized_json: string;
  digest: string;
}

// ── Context compatibility wrappers ────────────────────────────────────

export type ContextPrimitive = CtxpackPrimitiveV1;
export type ContextErrorCode = CtxpackErrorCodeV1;

export interface ContextErrorEnvelope {
  ok: false;
  error: {
    code: ContextErrorCode;
    exit_code: number;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ContextFixtureCaseV1 {
  id: string;
  primitive: ContextPrimitive;
  input: Record<string, unknown>;
}

export interface ContextFixtureExecutionResultV1 {
  id: string;
  primitive: ContextPrimitive;
  ok: boolean;
  output: CtxpackOutputEnvelopeV1;
  stable_json: string;
  stable_hash: string;
}

// ── Production wiring: source resolution ────────────────────────────

/** Domains that use a `--registry` path. */
export type RegistryDomain = "skills" | "tools" | "prompts" | "agents" | "knowledge";

/** Domains that use a `--store` path. */
export type StoreDomain = "exec";

/** Union of all resolvable source domains. */
export type SourceDomain = RegistryDomain | StoreDomain;

/** Calyx configuration file schema. */
export interface CalyxConfig {
  version: string;
  registries?: Partial<Record<RegistryDomain, string>>;
  stores?: Partial<Record<StoreDomain, string>>;
}

/** Options controlling how source paths are resolved. */
export interface ResolveSourceOptions {
  /** Explicit CLI flag value — highest precedence. */
  cliValue?: string;
  /** Override for the config file path (instead of default location). */
  configPath?: string;
}

/** Result of resolving a source path. */
export interface ResolveSourceResult {
  /** The resolved path (if found). */
  path: string | undefined;
  /** How the path was resolved. */
  source: "cli" | "env" | "config" | "default" | "none";
}

/** Result of loading the Calyx config file. */
export interface CalyxConfigLoadResult {
  config: CalyxConfig | undefined;
  configPath: string | undefined;
  source: "env" | "default" | "none";
}

/** Result of the `calyx config show` command. */
export interface ConfigShowResult {
  configPath: string | undefined;
  configSource: "env" | "default" | "none";
  resolved: Record<SourceDomain, ResolveSourceResult>;
}
