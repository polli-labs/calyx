import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  AgentCompiledLaunchResult,
  AgentBackendSelectionStrategy,
  AgentDefinition,
  AgentLifecycleMetadata,
  AgentDefinitionProvenance,
  AgentDefinitionSnapshot,
  AgentDefinitionSource,
  AgentLaunchBackend,
  AgentLaunchTarget,
  AgentLifecycleStatus,
  AgentProcedureRef,
  AgentRunOutputCapture,
  AgentRegistryEntry,
  AgentsIndexItem,
  AgentsIndexOptions,
  AgentsIndexResult,
  AgentsRegistry,
  AgentsShowResult,
  AgentsValidateOptions,
  AgentsValidateResult,
  DomainValidationIssue,
} from "./types";
import { pathExists, resolveRepoIdentity } from "./agents-infra";

const agentStatusSchema = z.enum(["active", "blocked", "deprecated", "archived", "retired"]);
const agentBackendSchema = z.enum(["claude", "codex"]);

const agentRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    status: agentStatusSchema.optional(),
    lifecycle: z
      .object({
        status: agentStatusSchema.optional(),
        blocked_reason: z.string().trim().min(1).optional(),
        blocked_by: z.array(z.string().trim().min(1)).min(1).optional(),
        replaced_by: z.string().min(1).optional(),
        archived_at: z.string().min(1).optional(),
        retired_at: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    description: z.string().min(1).optional(),
  })
  .passthrough();

const agentsRegistrySchema = z
  .object({
    version: z.union([z.string().min(1), z.number()]).transform((value) => String(value)),
    generated_at: z.string().min(1).optional(),
    agents: z.array(agentRegistryEntrySchema),
  })
  .passthrough();

const agentInputSchema = z
  .object({
    type: z.string().min(1),
    required: z.boolean().optional(),
    required_if: z.string().min(1).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    repeatable: z.boolean().optional(),
  })
  .passthrough();

const agentJsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(agentJsonValueSchema),
  z.record(agentJsonValueSchema),
]));

const agentArtifactWriteSchema = z.object({
  path: z.string().min(1),
  location: z.string().min(1).optional(),
  source: z.literal("agent_terminal_message").optional(),
  media_type: z.literal("application/json").optional(),
  schema: agentJsonValueSchema.optional(),
  max_bytes: z.number().int().positive().optional(),
  required: z.literal(true).optional(),
}).passthrough().superRefine((artifact, ctx) => {
  const captureFields = [artifact.source, artifact.media_type, artifact.schema, artifact.max_bytes, artifact.required];
  const declaresCapture = captureFields.some((value) => value !== undefined);
  if (!declaresCapture) return;
  if (artifact.location !== "run-artifact") {
    ctx.addIssue({
      code: "custom",
      path: ["location"],
      message: "Typed terminal capture requires location=run-artifact.",
    });
  }
  for (const [field, value] of [
    ["source", artifact.source],
    ["media_type", artifact.media_type],
    ["schema", artifact.schema],
    ["max_bytes", artifact.max_bytes],
    ["required", artifact.required],
  ] as const) {
    if (value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `Typed terminal capture requires ${field}.`,
      });
    }
  }
  if (
    artifact.path === "."
    || artifact.path === ".."
    || artifact.path.includes("/")
    || artifact.path.includes("\\")
    || artifact.path.includes("\0")
    || path.isAbsolute(artifact.path)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "Typed terminal capture path must be a safe basename.",
    });
  }
});

const agentDefinitionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal("1")]).transform(() => 1),
    kind: z.literal("agent"),
    id: z.string().min(1),
    status: agentStatusSchema,
    owner: z.string().min(1),
    contract_version: z.union([z.literal(1), z.literal("1")]).transform(() => 1),
    description: z.string().min(1),
    persona: z
      .object({
        template: z.string().min(1),
        skills: z.array(z.string().min(1)).optional(),
        curricula: z.array(z.string().min(1)).optional(),
      })
      .passthrough(),
    inputs: z.record(agentInputSchema).optional(),
    execution: z
      .object({
        kernel: z.literal("agent_runner"),
        backend: z
          .object({
            strategy: z.enum(["prefer_different_from_requester", "first_available"]).optional(),
            fallback_order: z.array(agentBackendSchema).optional(),
            allowed: z.array(agentBackendSchema).optional(),
          })
          .passthrough(),
        model: z
          .object({
            claude: z.string().min(1).optional(),
            codex: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
        reasoning_effort: z.string().min(1).optional(),
        safety: z
          .object({
            timeout_minutes: z.number().positive().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    posture: z
      .object({
        workspace_mutation: z.enum(["forbidden", "allowed", "restricted"]).optional(),
        artifact_writes: z.array(agentArtifactWriteSchema).optional(),
        delivery_writes: z.array(z.object({ surface: z.string().min(1) }).passthrough()).optional(),
      })
      .passthrough()
      .optional(),
    context: z
      .object({
        type: z.string().min(1).optional(),
        worktree: z
          .object({
            mode: z.enum(["existing", "managed", "create"]).optional(),
          })
          .passthrough()
          .optional(),
        target_pinning: z.enum(["required", "optional"]).optional(),
      })
      .passthrough()
      .optional(),
    output: z
      .object({
        required_artifacts: z.array(z.string().min(1)).optional(),
      })
      .passthrough()
      .optional(),
    delivery: z.record(z.unknown()).optional(),
    surfaces: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .superRefine((definition, ctx) => {
    const captures = (definition.posture?.artifact_writes ?? [])
      .filter((artifact) => artifact.source === "agent_terminal_message");
    if (captures.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["posture", "artifact_writes"],
        message: "Agent definitions support exactly one typed terminal capture.",
      });
    }
  });

const TARGET_TEMPLATE_FIELDS = [
  "repo",
  "requested_repo",
  "repo_resolution_source",
  "scope",
  "pr",
  "branch",
  "base_ref",
  "base_sha",
  "head_ref",
  "head_sha",
  "merge_base_sha",
  "resolved_at",
  "warnings",
] as const;

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DEFAULT_PR_HEAD_POLL_ATTEMPTS = 6;
const DEFAULT_PR_HEAD_POLL_DELAY_MS = 500;
const DEFAULT_PR_HEAD_STABLE_DELAY_MS = 100;
const REMOTE_TRACKING_PREFIX = "refs/remotes/";

const CLAUDE_READONLY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git log:*)",
  "Bash(git merge-base:*)",
  "Bash(git rev-parse:*)",
];

export interface AgentLaunchCompileOptions {
  variables?: Record<string, string[]>;
  backend?: AgentLaunchBackend;
  requesterBackend?: AgentLaunchBackend;
  cwd?: string;
  agentsInfraRoot?: string;
  localHostAlias?: string;
  skillInstallRoots?: string[];
  now?: () => string;
  expectedTargetHeadSha?: string;
  targetHeadPoll?: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

interface ResolveRepoWorktreeOptions {
  agentsInfraRoot?: string;
  localHostAlias?: string;
  registryRequired?: boolean;
}

interface ResolvedRepoWorktree {
  path: string;
  repo: string;
  resolutionSource: "registry" | "explicit_path" | "cwd_remote";
}

interface ResolveAgentTargetOptions extends ResolveRepoWorktreeOptions {
  expectedHeadSha?: string;
  headPoll?: AgentLaunchCompileOptions["targetHeadPoll"];
}

interface RemoteBranchRef {
  remote: string;
  branch: string;
  fetchRefspec: string;
}

interface LoadedAgentDefinition {
  registry: AgentsRegistry;
  entry: AgentRegistryEntry;
  definition: AgentDefinition;
  registryPath: string;
  definitionPath: string;
  definitionDir: string;
}

interface RenderedAgentVariables {
  inputValues: Record<string, unknown>;
  templateValues: Record<string, unknown>;
}

interface ResolvedTextRef {
  id: string;
  path: string;
  text: string;
}

function toIssue(code: string, message: string, issuePath?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(issuePath ? { path: issuePath } : {}),
  };
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

function lifecycleStatus(entry: AgentRegistryEntry, definition?: Pick<AgentDefinition, "status">): AgentLifecycleStatus {
  return entry.lifecycle?.status ?? entry.status ?? definition?.status ?? "active";
}

const NON_LAUNCHABLE_AGENT_STATUSES = new Set<AgentLifecycleStatus>(["blocked", "archived", "retired"]);

function lifecycleMetadata(entry: AgentRegistryEntry, definition?: Pick<AgentDefinition, "status">): AgentLifecycleMetadata {
  return {
    ...entry.lifecycle,
    status: lifecycleStatus(entry, definition),
  };
}

function declaredLifecycleStatuses(loaded: LoadedAgentDefinition): AgentLifecycleStatus[] {
  return [
    loaded.entry.lifecycle?.status,
    loaded.entry.status,
    loaded.definition.status,
  ].filter((status): status is AgentLifecycleStatus => status !== undefined);
}

export class AgentDefinitionLifecycleError extends Error {
  readonly exitCode = 2;
  readonly code: "agent_definition_lifecycle_mismatch" | "agent_definition_not_launchable";
  readonly agentId: string;
  readonly status: AgentLifecycleStatus;
  readonly declaredStatuses: AgentLifecycleStatus[];
  readonly blockedReason: string | undefined;
  readonly blockedBy: string[];

  constructor(args: {
    code: "agent_definition_lifecycle_mismatch" | "agent_definition_not_launchable";
    agentId: string;
    status: AgentLifecycleStatus;
    declaredStatuses: AgentLifecycleStatus[];
    blockedReason?: string;
    blockedBy?: string[];
  }) {
    const stateDetail = args.code === "agent_definition_lifecycle_mismatch"
      ? `declares conflicting lifecycle states (${[...new Set(args.declaredStatuses)].join(", ")})`
      : `is in lifecycle state "${args.status}"`;
    const blockers = args.blockedBy?.length ? ` Blocked by: ${args.blockedBy.join(", ")}.` : "";
    const reason = args.blockedReason ? ` Reason: ${args.blockedReason}` : "";
    const remediation = args.code === "agent_definition_lifecycle_mismatch"
      ? "Make the registry and definition lifecycle states agree before launching."
      : args.status === "blocked"
        ? "Clear the prerequisites, then set every declared lifecycle state to \"active\" before launching."
        : "Select an active replacement or deliberately reactivate this definition before launching.";
    super(
      `Agent "${args.agentId}" ${stateDetail} and cannot be launched.${blockers}${reason} `
      + remediation,
    );
    this.name = "AgentDefinitionLifecycleError";
    this.code = args.code;
    this.agentId = args.agentId;
    this.status = args.status;
    this.declaredStatuses = args.declaredStatuses;
    this.blockedReason = args.blockedReason;
    this.blockedBy = args.blockedBy ?? [];
  }
}

function assertAgentDefinitionLaunchable(loaded: LoadedAgentDefinition): void {
  const statuses = declaredLifecycleStatuses(loaded);
  const uniqueStatuses = [...new Set(statuses)];
  const status = uniqueStatuses.find((candidate) => NON_LAUNCHABLE_AGENT_STATUSES.has(candidate))
    ?? lifecycleStatus(loaded.entry, loaded.definition);
  const lifecycle = lifecycleMetadata(loaded.entry, loaded.definition);
  if (uniqueStatuses.length > 1) {
    throw new AgentDefinitionLifecycleError({
      code: "agent_definition_lifecycle_mismatch",
      agentId: loaded.definition.id,
      status,
      declaredStatuses: statuses,
      ...(lifecycle.blocked_reason ? { blockedReason: lifecycle.blocked_reason } : {}),
      ...(lifecycle.blocked_by ? { blockedBy: lifecycle.blocked_by } : {}),
    });
  }
  if (NON_LAUNCHABLE_AGENT_STATUSES.has(status)) {
    throw new AgentDefinitionLifecycleError({
      code: "agent_definition_not_launchable",
      agentId: loaded.definition.id,
      status,
      declaredStatuses: statuses,
      ...(lifecycle.blocked_reason ? { blockedReason: lifecycle.blocked_reason } : {}),
      ...(lifecycle.blocked_by ? { blockedBy: lifecycle.blocked_by } : {}),
    });
  }
}

function normalizePathForReceipt(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Text(await readFile(filePath, "utf8"));
}

async function collectFilePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFilePaths(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function sha256Directory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of await collectFilePaths(root)) {
    const relativePath = normalizePathForReceipt(path.relative(root, filePath));
    hash.update(`file:${relativePath}\n`);
    hash.update(await readFile(filePath, "utf8"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
          reject(new Error(message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function gitMaybe(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const output = await execFileText("git", args, cwd);
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileText("git", args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitRequired(cwd: string, args: string[], label: string): Promise<string> {
  const output = await gitMaybe(cwd, args);
  if (!output) {
    throw new Error(`Unable to resolve ${label} with git ${args.join(" ")} in ${cwd}.`);
  }
  return output;
}

function normalizeExpectedHeadSha(rawValue: string | undefined): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new Error("Expected PR head SHA must be a full 40- or 64-character commit SHA.");
  }
  return value.toLowerCase();
}

function parseLsRemoteHead(output: string | undefined): string | undefined {
  const head = output?.trim().split(/\s+/)[0]?.trim();
  return head && COMMIT_SHA_PATTERN.test(head) ? head.toLowerCase() : undefined;
}

async function defaultHeadPollSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function parseRemoteNames(stdout: string | undefined): string[] {
  return (stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function remoteBranchCandidates(ref: string, remotes: string[]): RemoteBranchRef[] {
  const body = ref.startsWith(REMOTE_TRACKING_PREFIX)
    ? ref.slice(REMOTE_TRACKING_PREFIX.length)
    : ref;

  return remotes.flatMap((remote) => {
    const prefix = `${remote}/`;
    if (!body.startsWith(prefix)) {
      return [];
    }

    const branch = body.slice(prefix.length);
    if (!branch) {
      return [];
    }

    return [{
      remote,
      branch,
      fetchRefspec: `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
    }];
  });
}

async function refreshRemoteTrackingRef(repoWorktree: string, ref: string, label: string): Promise<void> {
  const remotes = parseRemoteNames(await gitMaybe(repoWorktree, ["remote"]));
  const candidates = remoteBranchCandidates(ref, remotes);
  if (candidates.length === 0) {
    return;
  }
  if (candidates.length > 1) {
    const remoteNames = candidates.map((candidate) => candidate.remote).join(", ");
    throw new Error(`Unable to refresh ${label} ref "${ref}" because it is ambiguous across configured remotes (${remoteNames}).`);
  }

  const candidate = candidates[0]!;
  try {
    await execFileText("git", ["fetch", candidate.remote, candidate.fetchRefspec], repoWorktree);
    return;
  } catch (error) {
    const advertisedHead = parseLsRemoteHead(
      await gitMaybe(repoWorktree, ["ls-remote", candidate.remote, `refs/heads/${candidate.branch}`]),
    );
    const localHead = (await gitMaybe(repoWorktree, ["rev-parse", ref]))?.toLowerCase();
    if (advertisedHead && localHead === advertisedHead) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    const verification = advertisedHead
      ? localHead
        ? `Remote advertised ${advertisedHead}, but local ${ref} resolves to ${localHead}.`
        : `Remote advertised ${advertisedHead}, but local ${ref} does not resolve.`
      : `Could not verify the advertised remote head for ${candidate.remote}/${candidate.branch}.`;
    throw new Error([
      `Unable to refresh ${label} ref "${ref}" from remote "${candidate.remote}" before target pinning.`,
      `git fetch ${candidate.remote} ${candidate.fetchRefspec} failed: ${detail}`,
      verification,
    ].join("\n"));
  }
}

async function ensureCommitObject(repoWorktree: string, sha: string, headRef: string): Promise<void> {
  if (await gitSucceeds(repoWorktree, ["cat-file", "-e", `${sha}^{commit}`])) {
    return;
  }
  if (await gitSucceeds(repoWorktree, ["fetch", "origin", sha])) {
    return;
  }
  if (
    await gitSucceeds(repoWorktree, ["fetch", "origin", headRef])
    && await gitSucceeds(repoWorktree, ["cat-file", "-e", `${sha}^{commit}`])
  ) {
    return;
  }
  throw new Error(`Unable to fetch PR head object ${sha} from origin (${headRef}) before target pinning.`);
}

async function resolveRemotePrHead(
  repoWorktree: string,
  headRef: string,
  expectedHeadSha: string | undefined,
  poll: AgentLaunchCompileOptions["targetHeadPoll"],
): Promise<string | undefined> {
  const attempts = expectedHeadSha
    ? Math.max(1, poll?.attempts ?? DEFAULT_PR_HEAD_POLL_ATTEMPTS)
    : Math.max(2, poll?.attempts ?? DEFAULT_PR_HEAD_POLL_ATTEMPTS);
  const defaultDelayMs = expectedHeadSha
    ? DEFAULT_PR_HEAD_POLL_DELAY_MS
    : DEFAULT_PR_HEAD_STABLE_DELAY_MS;
  const delayMs = Math.max(0, poll?.delayMs ?? defaultDelayMs);
  const sleep = poll?.sleep ?? defaultHeadPollSleep;
  let previousRemoteHead: string | undefined;

  // Stabilization detects in-poll ref movement, not absolute currency; the
  // visible target warning is the contract for post-force-push freshness.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remoteHead = parseLsRemoteHead(await gitMaybe(repoWorktree, ["ls-remote", "origin", headRef]));
    if (expectedHeadSha) {
      if (remoteHead === expectedHeadSha) {
        return remoteHead;
      }
    } else if (remoteHead) {
      if (previousRemoteHead === remoteHead) {
        return remoteHead;
      }
      previousRemoteHead = remoteHead;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return expectedHeadSha ? undefined : previousRemoteHead;
}

function normalizeRemote(remote: string | undefined, fallback: string): string {
  if (!remote) {
    return fallback;
  }
  const githubMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (githubMatch?.[1]) {
    return githubMatch[1];
  }
  return remote;
}

function inferAgentsInfraRoot(registryPath: string): string | undefined {
  const normalized = normalizePathForReceipt(path.resolve(registryPath));
  if (normalized.endsWith("/instructions/agents/AGENTS.json")) {
    return path.dirname(path.dirname(path.dirname(path.resolve(registryPath))));
  }
  return undefined;
}

function resolveDefinitionPath(registryPath: string, entry: AgentRegistryEntry): string {
  return path.isAbsolute(entry.path)
    ? entry.path
    : path.resolve(path.dirname(registryPath), entry.path);
}

async function loadAgentsRegistry(registryPath: string): Promise<AgentsRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read agents registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = agentsRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid agents registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as AgentsRegistry;
}

async function loadAgentYaml(definitionPath: string): Promise<AgentDefinition> {
  let text = "";
  try {
    text = await readFile(definitionPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read agent definition at ${definitionPath}: ${message}`);
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML at ${definitionPath}: ${message}`);
  }

  const parsedDefinition = agentDefinitionSchema.safeParse(parsedYaml);
  if (!parsedDefinition.success) {
    throw new Error(`Invalid agent definition schema at ${definitionPath}: ${formatSchemaError(parsedDefinition.error)}`);
  }

  return parsedDefinition.data as AgentDefinition;
}

export async function loadAgentDefinition(registryPath: string, agentId: string): Promise<LoadedAgentDefinition> {
  const registry = await loadAgentsRegistry(registryPath);
  const entry = registry.agents.find((agent) => agent.id === agentId);
  if (!entry) {
    throw new Error(`Agent definition "${agentId}" was not found in ${registryPath}.`);
  }

  const definitionPath = resolveDefinitionPath(registryPath, entry);
  const definition = await loadAgentYaml(definitionPath);
  return {
    registry,
    entry,
    definition,
    registryPath,
    definitionPath,
    definitionDir: path.dirname(definitionPath),
  };
}

async function loadAllAgentDefinitions(registryPath: string): Promise<LoadedAgentDefinition[]> {
  const registry = await loadAgentsRegistry(registryPath);
  const loaded: LoadedAgentDefinition[] = [];
  for (const entry of registry.agents) {
    const definitionPath = resolveDefinitionPath(registryPath, entry);
    const definition = await loadAgentYaml(definitionPath);
    loaded.push({
      registry,
      entry,
      definition,
      registryPath,
      definitionPath,
      definitionDir: path.dirname(definitionPath),
    });
  }
  return loaded;
}

function issueDetails(issues: DomainValidationIssue[]): string {
  return issues
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
}

function ensureValidOrThrow(validation: AgentsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }
  throw new Error(`Agents registry validation failed at ${registryPath}: ${issueDetails(validation.errors)}`);
}

function toIndexItem(loaded: LoadedAgentDefinition): AgentsIndexItem {
  const lifecycle = lifecycleMetadata(loaded.entry, loaded.definition);
  return {
    id: loaded.definition.id,
    status: lifecycleStatus(loaded.entry, loaded.definition),
    path: normalizePathForReceipt(path.relative(path.dirname(loaded.registryPath), loaded.definitionPath)),
    definition_path: loaded.definitionPath,
    description: loaded.definition.description,
    owner: loaded.definition.owner,
    contract_version: loaded.definition.contract_version,
    lifecycle,
  };
}

function templatePath(loaded: LoadedAgentDefinition): string {
  return path.resolve(loaded.definitionDir, loaded.definition.persona.template);
}

function collectTemplateTokens(template: string): string[] {
  const tokens = new Set<string>();
  const tokenPattern = /{{{?\s*([#^/!]?)\s*([A-Za-z0-9_.-]+|\.)\s*}?}}/g;
  for (const match of template.matchAll(tokenPattern)) {
    const sigil = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token || sigil === "/" || sigil === "!") {
      continue;
    }
    tokens.add(token);
  }
  return [...tokens].sort();
}

function allowedTemplateTokens(definition: AgentDefinition): Set<string> {
  const allowed = new Set<string>([".", "value"]);
  for (const [name, input] of Object.entries(definition.inputs ?? {})) {
    allowed.add(name);
    if (input.repeatable) {
      allowed.add(`${name}_list`);
    }
  }
  for (const field of TARGET_TEMPLATE_FIELDS) {
    allowed.add(`target.${field}`);
  }
  return allowed;
}

function validateTemplateTokens(definition: AgentDefinition, template: string, issuePath: string): DomainValidationIssue[] {
  const allowed = allowedTemplateTokens(definition);
  return collectTemplateTokens(template)
    .filter((token) => !allowed.has(token))
    .map((token) => toIssue("agents.unknown-template-var", `Agent "${definition.id}" references unknown template variable "${token}".`, issuePath));
}

function parseInputValue(name: string, input: NonNullable<AgentDefinition["inputs"]>[string], value: string): string {
  if (input.type === "int") {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`Invalid --var ${name}=${value}: expected int.`);
    }
  }
  if (input.type === "enum" && input.values?.length) {
    const allowed = input.values.map((item) => String(item));
    if (!allowed.includes(value)) {
      throw new Error(`Invalid --var ${name}=${value}: expected one of ${allowed.join(", ")}.`);
    }
  }
  return value;
}

function expressionValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return value.replace(/^["']|["']$/g, "");
}

function evaluateRequiredIf(expression: string | undefined, inputValues: Record<string, unknown>): boolean {
  if (!expression) {
    return false;
  }
  const match = expression.match(/^([A-Za-z0-9_]+)\s*(==|!=)\s*(.+)$/);
  if (!match) {
    throw new Error(`Unsupported required_if expression "${expression}".`);
  }
  const key = match[1]!;
  const operator = match[2]!;
  const rawExpected = match[3]!;
  const actual = inputValues[key];
  const expected = expressionValue(rawExpected);
  return operator === "==" ? actual === expected : actual !== expected;
}

function normalizeAgentVariables(
  definition: AgentDefinition,
  assignments: Record<string, string[]> = {},
): RenderedAgentVariables {
  const inputs = definition.inputs ?? {};
  const inputValues: Record<string, unknown> = {};
  const templateValues: Record<string, unknown> = {};

  for (const suppliedName of Object.keys(assignments).sort()) {
    if (!inputs[suppliedName]) {
      throw new Error(`Unknown --var ${suppliedName} for agent "${definition.id}".`);
    }
  }

  for (const [name, input] of Object.entries(inputs)) {
    const supplied = assignments[name] ?? [];
    if (!input.repeatable && supplied.length > 1) {
      throw new Error(`--var ${name}=... may only be supplied once for agent "${definition.id}".`);
    }

    if (input.repeatable) {
      const parsed = supplied.map((value) => parseInputValue(name, input, value));
      inputValues[name] = parsed;
      templateValues[name] = parsed.length > 0;
      templateValues[`${name}_list`] = parsed;
      continue;
    }

    const rawValue = supplied[0] ?? (input.default !== undefined ? String(input.default) : undefined);
    if (rawValue !== undefined) {
      const parsed = parseInputValue(name, input, rawValue);
      inputValues[name] = input.type === "int" ? Number.parseInt(parsed, 10) : parsed;
      templateValues[name] = parsed;
    } else {
      inputValues[name] = undefined;
      templateValues[name] = "";
    }
  }

  for (const [name, input] of Object.entries(inputs)) {
    const required = input.required === true || evaluateRequiredIf(input.required_if, inputValues);
    const value = inputValues[name];
    const missing = Array.isArray(value) ? value.length === 0 : value === undefined || value === "";
    if (required && missing) {
      const reason = input.required_if ? ` because ${input.required_if}` : "";
      throw new Error(`Missing required --var ${name} for agent "${definition.id}"${reason}.`);
    }
  }

  return { inputValues, templateValues };
}

function valueFromContext(context: Record<string, unknown>, token: string): unknown {
  if (Object.prototype.hasOwnProperty.call(context, token)) {
    return context[token];
  }
  if (!token.includes(".")) {
    return undefined;
  }
  let current: unknown = context;
  for (const part of token.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderStrictTemplate(template: string, context: Record<string, unknown>): string {
  const sectionPattern = /{{\s*([#^])\s*([A-Za-z0-9_.-]+)\s*}}([\s\S]*?){{\s*\/\s*\2\s*}}/g;
  let rendered = template;
  let previous = "";
  while (rendered !== previous) {
    previous = rendered;
    rendered = rendered.replace(sectionPattern, (_full, sigil: string, key: string, body: string) => {
      const value = valueFromContext(context, key);
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      if (sigil === "^") {
        return truthy ? "" : renderStrictTemplate(body, context);
      }
      if (!truthy) {
        return "";
      }
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            const itemContext = typeof item === "object" && item !== null
              ? { ...context, ...(item as Record<string, unknown>), ".": item, value: item }
              : { ...context, ".": item, value: item };
            return renderStrictTemplate(body, itemContext);
          })
          .join("");
      }
      return renderStrictTemplate(body, context);
    });
  }

  return rendered.replace(/{{{?\s*([A-Za-z0-9_.-]+|\.)\s*}?}}/g, (_full, key: string) => {
    const value = valueFromContext(context, key);
    return value === undefined || value === null ? "" : String(value);
  });
}

function normalizeRepoResolverError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message
    .replace(
      /\(Add the repo alias to fleet\/truths\/hosts\.yaml or pass --worktree-path explicitly\.\)/g,
      "Add the alias to fleet/truths/hosts.yaml or pass an explicit path.",
    )
    .replace(
      /Add the repo to fleet\/truths\/hosts\.yaml or pass --worktree-path explicitly\./g,
      "Add the repo to fleet/truths/hosts.yaml or pass an explicit path.",
    ));
}

async function resolveRepoWorktree(
  repo: string,
  cwd: string,
  options: ResolveRepoWorktreeOptions,
): Promise<ResolvedRepoWorktree> {
  let registryError: unknown;
  if (options.agentsInfraRoot && options.localHostAlias) {
    const host = options.localHostAlias.trim();
    try {
      if (host.length > 0) {
        const resolved = await resolveRepoIdentity(repo, host, options.agentsInfraRoot);
        return { path: resolved.path, repo: resolved.slug, resolutionSource: "registry" };
      }
    } catch (error) {
      registryError = error;
    }
  }

  const candidate = path.resolve(cwd, repo);
  if ((path.isAbsolute(repo) || repo.startsWith(".")) && await pathExists(candidate)) {
    return { path: candidate, repo, resolutionSource: "explicit_path" };
  }

  // Managed launches have one authority for repository identity. A rejected
  // registry identifier must not become valid merely because the launcher is
  // standing inside a matching checkout: the daemon will resolve the same
  // identifier without that cwd and reject it. Explicit paths remain the only
  // path-authoritative escape hatch.
  if (registryError) {
    throw normalizeRepoResolverError(registryError);
  }
  if (options.registryRequired) {
    throw new Error(
      `Managed repository target "${repo}" requires host-truth resolution before planning. Discover agents-infra or pass an explicit path.`,
    );
  }

  const cwdTop = await gitMaybe(cwd, ["rev-parse", "--show-toplevel"]);
  if (cwdTop) {
    const remote = await gitMaybe(cwdTop, ["remote", "get-url", "origin"]);
    const normalizedRemote = normalizeRemote(remote, cwdTop);
    if (normalizedRemote === repo || normalizedRemote.endsWith(`/${repo}`) || cwdTop.endsWith(`/${repo}`)) {
      return { path: cwdTop, repo, resolutionSource: "cwd_remote" };
    }
  }

  throw new Error(
    `Unable to resolve repo "${repo}" to a local git worktree for agent target pinning. Add the alias to fleet/truths/hosts.yaml or pass an explicit path.`,
  );
}

async function resolveAgentTarget(
  definition: AgentDefinition,
  inputValues: Record<string, unknown>,
  cwd: string,
  now: () => string,
  options: ResolveAgentTargetOptions,
): Promise<AgentLaunchTarget | undefined> {
  if (definition.context?.type !== "repo_diff") {
    return undefined;
  }

  const repo = typeof inputValues["repo"] === "string" ? inputValues["repo"] : undefined;
  const scope = inputValues["scope"] === "branch" ? "branch" : "pr";
  const baseRef = typeof inputValues["base"] === "string" && inputValues["base"].length > 0
    ? inputValues["base"]
    : "origin/main";

  if (!repo) {
    throw new Error(`Agent "${definition.id}" requires --var repo=<repo> for repo_diff target resolution.`);
  }

  const repoWorktree = await resolveRepoWorktree(repo, cwd, options);

  await refreshRemoteTrackingRef(repoWorktree.path, baseRef, "base");
  const baseSha = await gitRequired(repoWorktree.path, ["rev-parse", baseRef], `base ref ${baseRef}`);
  const repoIdentity = {
    repo: repoWorktree.repo,
    ...(repoWorktree.repo !== repo ? { requested_repo: repo } : {}),
    repo_resolution_source: repoWorktree.resolutionSource,
  };
  if (scope === "branch") {
    const branch = typeof inputValues["branch"] === "string" ? inputValues["branch"] : undefined;
    if (!branch) {
      throw new Error(`Agent "${definition.id}" requires --var branch=<ref> when scope=branch.`);
    }
    const headSha = await gitRequired(repoWorktree.path, ["rev-parse", branch], `branch ${branch}`);
    const mergeBaseSha = await gitRequired(repoWorktree.path, ["merge-base", baseRef, branch], `merge-base ${baseRef} ${branch}`);
    return {
      ...repoIdentity,
      scope,
      branch,
      base_ref: baseRef,
      base_sha: baseSha,
      head_ref: branch,
      head_sha: headSha,
      merge_base_sha: mergeBaseSha,
      resolved_at: now(),
    };
  }

  const prValue = inputValues["pr"];
  const pr = typeof prValue === "number" ? prValue : Number.parseInt(String(prValue ?? ""), 10);
  if (!Number.isFinite(pr)) {
    throw new Error(`Agent "${definition.id}" requires --var pr=<number> when scope=pr.`);
  }
  const headRef = `refs/pull/${pr}/head`;
  const expectedHeadSha = normalizeExpectedHeadSha(options.expectedHeadSha);
  const remoteHead = await resolveRemotePrHead(repoWorktree.path, headRef, expectedHeadSha, options.headPoll);
  const localHead = remoteHead || expectedHeadSha ? undefined : await gitMaybe(repoWorktree.path, ["rev-parse", headRef]);
  const headSha = remoteHead ?? expectedHeadSha ?? localHead;
  if (!headSha) {
    throw new Error(`Unable to resolve PR target ${headRef} for repo "${repo}".`);
  }
  const warnings: string[] = [];
  if (expectedHeadSha && !remoteHead) {
    warnings.push([
      `Pinned --sha ${expectedHeadSha} was not observed on origin ${headRef}`,
      "within the configured poll budget; review target may not be on the PR head.",
    ].join(" "));
  } else if (!expectedHeadSha && remoteHead) {
    warnings.push([
      `No --sha was supplied; PR head ${headSha} was resolved from origin ${headRef}`,
      "by best-effort stability polling. For reviews immediately after a force-push, pass --sha <head> to require an exact head.",
    ].join(" "));
  } else if (!expectedHeadSha && localHead) {
    warnings.push([
      `No --sha was supplied; origin ${headRef} was unavailable, so PR head ${headSha} was resolved from local ${headRef}.`,
      "That local pull ref may be stale; pass --sha <head> to require an exact head.",
    ].join(" "));
  }
  await ensureCommitObject(repoWorktree.path, headSha, headRef);
  const resolvedMergeBaseSha = localHead
    ? await gitRequired(repoWorktree.path, ["merge-base", baseRef, headRef], `merge-base ${baseRef} ${headRef}`)
    : await gitMaybe(repoWorktree.path, ["merge-base", baseRef, headSha]);
  const mergeBaseSha = resolvedMergeBaseSha ?? baseSha;

  return {
    ...repoIdentity,
    scope,
    pr,
    base_ref: baseRef,
    base_sha: baseSha,
    head_ref: headRef,
    head_sha: headSha,
    merge_base_sha: mergeBaseSha,
    resolved_at: now(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function addTargetTemplateValues(templateValues: Record<string, unknown>, target: AgentLaunchTarget | undefined): void {
  if (!target) {
    return;
  }
  for (const [key, value] of Object.entries(target)) {
    templateValues[`target.${key}`] = value;
  }
}

function renderTargetWarnings(target: AgentLaunchTarget | undefined): string {
  const warnings = target?.warnings ?? [];
  if (warnings.length === 0) {
    return "";
  }
  return `\n\n## Target Resolution Warnings\n\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function defaultSkillInstallRoots(): string[] {
  const home = process.env["HOME"]?.trim() || homedir();
  const codexHome = process.env["CODEX_HOME"]?.trim() || path.join(home, ".codex");
  return [
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(codexHome, "skills"),
  ];
}

async function resolveCurriculum(
  id: string,
  loaded: LoadedAgentDefinition,
  agentsInfraRoot: string | undefined,
): Promise<ResolvedTextRef> {
  const candidates = [
    path.join(loaded.definitionDir, "curricula", `${id}.md`),
    path.join(path.dirname(loaded.registryPath), "curricula", `${id}.md`),
    ...(agentsInfraRoot
      ? [
          path.join(agentsInfraRoot, "instructions", "curricula", `${id}.md`),
          path.join(agentsInfraRoot, "instructions", "skills", "polli-dev-conventions", "references", `${id}.md`),
        ]
      : []),
    path.join(process.env["HOME"]?.trim() || homedir(), ".agents", "skills", "polli-dev-conventions", "references", `${id}.md`),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return {
        id,
        path: candidate,
        text: await readFile(candidate, "utf8"),
      };
    }
  }

  throw new Error(`Curriculum "${id}" referenced by agent "${loaded.definition.id}" was not found.`);
}

async function materializeCurricula(
  loaded: LoadedAgentDefinition,
  agentsInfraRoot: string | undefined,
): Promise<{ promptAppendix: string; refs: AgentProcedureRef[] }> {
  const curricula = loaded.definition.persona.curricula ?? [];
  if (curricula.length === 0) {
    return { promptAppendix: "", refs: [] };
  }

  const sections: string[] = ["", "", "# Materialized Curricula", ""];
  const refs: AgentProcedureRef[] = [];
  for (const id of curricula) {
    const curriculum = await resolveCurriculum(id, loaded, agentsInfraRoot);
    const text = curriculum.text.trimEnd();
    sections.push(`## ${id}`, "", text, "");
    refs.push({
      kind: "curriculum",
      id,
      digest: sha256Text(curriculum.text),
      digest_algorithm: "sha256-file-v1",
      mode: "embedded",
      source_path: curriculum.path,
    });
  }

  return {
    promptAppendix: sections.join("\n"),
    refs,
  };
}

async function preflightSkillRefs(
  definition: AgentDefinition,
  skillInstallRoots: string[],
): Promise<AgentProcedureRef[]> {
  const refs: AgentProcedureRef[] = [];
  for (const id of definition.persona.skills ?? []) {
    const candidates = skillInstallRoots.map((root) => path.join(root, id));
    const skillDir = await asyncFind(candidates, async (candidate) => await pathExists(path.join(candidate, "SKILL.md")));
    if (!skillDir) {
      throw new Error(
        `Skill "${id}" referenced by agent "${definition.id}" is not installed. Checked: ${candidates.join(", ")}.`,
      );
    }
    refs.push({
      kind: "skill",
      id,
      digest: await sha256Directory(skillDir),
      digest_algorithm: "sha256-dir-v1",
      mode: "host-resolved",
      source_path: skillDir,
    });
  }
  return refs;
}

async function asyncFind<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) {
    if (await predicate(item)) {
      return item;
    }
  }
  return undefined;
}

async function buildDefinitionSource(loaded: LoadedAgentDefinition): Promise<{
  source: AgentDefinitionSource;
  snapshot?: AgentDefinitionSnapshot;
}> {
  const agentsInfraRoot = inferAgentsInfraRoot(loaded.registryPath);
  const sourceRoot = agentsInfraRoot ?? path.dirname(loaded.registryPath);
  const relativeDefinitionDir = normalizePathForReceipt(path.relative(sourceRoot, loaded.definitionDir));
  const remote = await gitMaybe(sourceRoot, ["remote", "get-url", "origin"]);
  const commit = await gitMaybe(sourceRoot, ["rev-parse", "HEAD"]);
  const dirtyOutput = await gitMaybe(sourceRoot, ["status", "--short", "--", loaded.definitionDir]);
  const dirty = Boolean(dirtyOutput?.trim());
  const source: AgentDefinitionSource = {
    repo: normalizeRemote(remote, sourceRoot),
    ...(commit ? { commit } : {}),
    path: relativeDefinitionDir || normalizePathForReceipt(loaded.definitionDir),
    dirty,
  };

  if (!dirty) {
    return { source };
  }

  const files = await Promise.all((await collectFilePaths(loaded.definitionDir)).map(async (filePath) => ({
    path: normalizePathForReceipt(path.relative(loaded.definitionDir, filePath)),
    sha256: await sha256File(filePath),
    contents: await readFile(filePath, "utf8"),
  })));

  return {
    source,
    snapshot: {
      mode: "inline",
      files,
    },
  };
}

async function buildProvenance(
  loaded: LoadedAgentDefinition,
  procedureRefs: AgentProcedureRef[],
): Promise<AgentDefinitionProvenance> {
  const definitionDigest = await sha256Directory(loaded.definitionDir);
  const source = await buildDefinitionSource(loaded);
  return {
    definition_ref: loaded.definition.id,
    agent_ref: `${loaded.definition.id}@${definitionDigest}`,
    definition_digest: definitionDigest,
    definition_digest_algorithm: "agent-dir-v1",
    definition_source: source.source,
    ...(source.snapshot ? { definition_snapshot: source.snapshot } : {}),
    procedure_refs: procedureRefs,
  };
}

function backendSelectionStrategy(definition: AgentDefinition): AgentBackendSelectionStrategy {
  return definition.execution.backend.strategy ?? "first_available";
}

function selectBackend(definition: AgentDefinition, requested: AgentLaunchBackend | undefined, requester: AgentLaunchBackend | undefined): AgentLaunchBackend {
  const allowed = definition.execution.backend.allowed?.length
    ? definition.execution.backend.allowed
    : ["claude", "codex"] satisfies AgentLaunchBackend[];
  if (requested) {
    if (!allowed.includes(requested)) {
      throw new Error(`Agent "${definition.id}" does not allow backend "${requested}". Allowed: ${allowed.join(", ")}.`);
    }
    return requested;
  }

  const fallback = definition.execution.backend.fallback_order?.length
    ? definition.execution.backend.fallback_order.filter((backend) => allowed.includes(backend))
    : allowed;
  const strategy = backendSelectionStrategy(definition);
  if (strategy === "prefer_different_from_requester" && requester) {
    const different = fallback.find((backend) => backend !== requester);
    if (different) {
      return different;
    }
  }
  return fallback[0] ?? "claude";
}

function buildBackendOptions(
  definition: AgentDefinition,
  backend: AgentLaunchBackend,
  timeoutMs: number | undefined,
): Record<string, unknown> {
  const backendOptions: Record<string, unknown> = {};
  if (definition.posture?.workspace_mutation === "forbidden") {
    if (backend === "claude") {
      backendOptions["allowed_tools"] = CLAUDE_READONLY_ALLOWED_TOOLS;
    } else {
      backendOptions["sandbox"] = "read-only";
      backendOptions["env"] = {
        CALYX_AGENT_WORKSPACE_MUTATION: "forbidden",
      };
    }
  }
  if (timeoutMs !== undefined) {
    backendOptions["agent_activity"] = {
      hard_timeout_ms: timeoutMs,
    };
  }
  return backendOptions;
}

function requiredArtifacts(definition: AgentDefinition): string[] {
  const captureNames = new Set(
    (definition.posture?.artifact_writes ?? [])
      .filter((artifact) => artifact.source === "agent_terminal_message")
      .map((artifact) => artifact.path),
  );
  return [
    ...(definition.output?.required_artifacts ?? []),
    ...(definition.posture?.artifact_writes ?? [])
      .filter((artifact) => artifact.source !== "agent_terminal_message")
      .map((artifact) => artifact.path),
  ].filter((value, index, values) =>
    !captureNames.has(value) && values.indexOf(value) === index
  );
}

function outputCapture(definition: AgentDefinition): AgentRunOutputCapture | undefined {
  const artifact = definition.posture?.artifact_writes
    ?.find((candidate) => candidate.source === "agent_terminal_message");
  if (!artifact) return undefined;
  return {
    name: artifact.path,
    source: "agent_terminal_message",
    media_type: "application/json",
    schema: artifact.schema!,
    max_bytes: artifact.max_bytes!,
    required: true,
  };
}

export async function validateAgentsRegistry(
  registryPath: string,
  options: AgentsValidateOptions = {},
): Promise<AgentsValidateResult> {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  let registry: AgentsRegistry;

  try {
    registry = await loadAgentsRegistry(registryPath);
  } catch (error) {
    return {
      ok: false,
      errors: [toIssue("agents.registry-read-failed", error instanceof Error ? error.message : String(error))],
      warnings,
      version: "unknown",
      registry_path: registryPath,
      total: 0,
      active: 0,
      blocked: 0,
      deprecated: 0,
      archived: 0,
      retired: 0,
    };
  }

  const knownIds = new Set<string>();
  let active = 0;
  let blocked = 0;
  let deprecated = 0;
  let archived = 0;
  let retired = 0;

  for (const [index, entry] of registry.agents.entries()) {
    if (knownIds.has(entry.id)) {
      errors.push(toIssue("agents.duplicate-id", `Duplicate agent id "${entry.id}".`, `agents[${index}].id`));
    }
    knownIds.add(entry.id);

    const definitionPath = resolveDefinitionPath(registryPath, entry);
    let definition: AgentDefinition | undefined;
    try {
      definition = await loadAgentYaml(definitionPath);
    } catch (error) {
      errors.push(toIssue("agents.definition-invalid", error instanceof Error ? error.message : String(error), `agents[${index}].path`));
      continue;
    }

    if (definition.id !== entry.id) {
      errors.push(
        toIssue(
          "agents.definition-id-mismatch",
          `Registry id "${entry.id}" does not match definition id "${definition.id}".`,
          `agents[${index}].id`,
        ),
      );
    }

    const status = lifecycleStatus(entry, definition);
    const declaredStatuses = [entry.lifecycle?.status, entry.status, definition.status]
      .filter((candidate): candidate is AgentLifecycleStatus => candidate !== undefined);
    if (new Set(declaredStatuses).size > 1) {
      errors.push(toIssue(
        "agents.lifecycle-status-mismatch",
        `Agent "${entry.id}" declares conflicting lifecycle states: ${declaredStatuses.join(", ")}.`,
        `agents[${index}].lifecycle.status`,
      ));
    }
    if (status === "active") {
      active += 1;
    } else if (status === "blocked") {
      blocked += 1;
      if (!entry.lifecycle?.blocked_reason) {
        errors.push(toIssue(
          "agents.blocked-missing-reason",
          `Blocked agent "${entry.id}" must set lifecycle.blocked_reason.`,
          `agents[${index}].lifecycle.blocked_reason`,
        ));
      }
    } else if (status === "deprecated") {
      deprecated += 1;
    } else if (status === "archived") {
      archived += 1;
      if (!entry.lifecycle?.archived_at && strict) {
        errors.push(toIssue("agents.archived-missing-date", `Archived agent "${entry.id}" should set lifecycle.archived_at.`, `agents[${index}].lifecycle.archived_at`));
      }
    } else if (status === "retired") {
      retired += 1;
      if (!entry.lifecycle?.retired_at && strict) {
        errors.push(toIssue("agents.retired-missing-date", `Retired agent "${entry.id}" should set lifecycle.retired_at.`, `agents[${index}].lifecycle.retired_at`));
      }
    }

    const promptPath = templatePath({
      registry,
      entry,
      definition,
      registryPath,
      definitionPath,
      definitionDir: path.dirname(definitionPath),
    });
    try {
      const template = await readFile(promptPath, "utf8");
      errors.push(...validateTemplateTokens(definition, template, `${entry.path}:${definition.persona.template}`));
    } catch (error) {
      errors.push(toIssue("agents.template-read-failed", error instanceof Error ? error.message : String(error), `${entry.path}:persona.template`));
    }

    for (const curriculum of definition.persona.curricula ?? []) {
      try {
        await resolveCurriculum(curriculum, {
          registry,
          entry,
          definition,
          registryPath,
          definitionPath,
          definitionDir: path.dirname(definitionPath),
        }, inferAgentsInfraRoot(registryPath));
      } catch (error) {
        errors.push(toIssue("agents.curriculum-missing", error instanceof Error ? error.message : String(error), `${entry.path}:persona.curricula`));
      }
    }

    if ((definition.persona.skills ?? []).length === 0) {
      const issue = toIssue("agents.no-skill-refs", `Agent "${definition.id}" declares no persona.skills refs.`, `${entry.path}:persona.skills`);
      if (strict) {
        warnings.push(issue);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    registry_path: registryPath,
    total: registry.agents.length,
    active,
    blocked,
    deprecated,
    archived,
    retired,
  };
}

export async function indexAgentsRegistry(
  registryPath: string,
  options: AgentsIndexOptions = {},
): Promise<AgentsIndexResult> {
  const validation = await validateAgentsRegistry(registryPath, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  const includeActive = options.includeActive ?? true;
  const includeBlocked = options.includeBlocked ?? false;
  const includeDeprecated = options.includeDeprecated ?? true;
  const includeArchived = options.includeArchived ?? false;
  const includeRetired = options.includeRetired ?? false;
  const loaded = await loadAllAgentDefinitions(registryPath);
  const items = loaded
    .filter((entry) => {
      const status = lifecycleStatus(entry.entry, entry.definition);
      if (status === "active") {
        return includeActive;
      }
      if (status === "blocked") {
        return includeBlocked;
      }
      if (status === "deprecated") {
        return includeDeprecated;
      }
      if (status === "archived") {
        return includeArchived;
      }
      return includeRetired;
    })
    .map(toIndexItem);

  return {
    version: validation.version,
    registry_path: registryPath,
    total: validation.total,
    items,
  };
}

export async function showAgentDefinition(registryPath: string, agentId: string): Promise<AgentsShowResult> {
  const loaded = await loadAgentDefinition(registryPath, agentId);
  const lifecycle = lifecycleMetadata(loaded.entry, loaded.definition);
  return {
    version: loaded.registry.version,
    registry_path: registryPath,
    definition_path: loaded.definitionPath,
    status: lifecycle.status ?? loaded.definition.status,
    lifecycle,
    agent: loaded.definition,
  };
}

export async function compileAgentLaunch(
  registryPath: string,
  agentId: string,
  options: AgentLaunchCompileOptions = {},
): Promise<AgentCompiledLaunchResult> {
  const loaded = await loadAgentDefinition(registryPath, agentId);
  assertAgentDefinitionLaunchable(loaded);

  const promptTemplatePath = templatePath(loaded);
  const promptTemplate = await readFile(promptTemplatePath, "utf8");
  const tokenIssues = validateTemplateTokens(loaded.definition, promptTemplate, `${loaded.entry.path}:${loaded.definition.persona.template}`);
  if (tokenIssues.length > 0) {
    throw new Error(`Agent "${agentId}" prompt template is invalid: ${issueDetails(tokenIssues)}.`);
  }

  const variables = normalizeAgentVariables(loaded.definition, options.variables);
  const now = options.now ?? (() => new Date().toISOString());
  const agentsInfraRoot = options.agentsInfraRoot ?? inferAgentsInfraRoot(registryPath);
  const target = await resolveAgentTarget(
    loaded.definition,
    variables.inputValues,
    options.cwd ?? process.cwd(),
    now,
    {
      ...(agentsInfraRoot ? { agentsInfraRoot } : {}),
      ...(options.localHostAlias ? { localHostAlias: options.localHostAlias } : {}),
      registryRequired: loaded.definition.context?.worktree?.mode === "managed",
      ...(options.expectedTargetHeadSha ? { expectedHeadSha: options.expectedTargetHeadSha } : {}),
      ...(options.targetHeadPoll ? { headPoll: options.targetHeadPoll } : {}),
    },
  );
  if (loaded.definition.context?.target_pinning === "required" && loaded.definition.context.type === "repo_diff" && !target) {
    throw new Error(`Agent "${agentId}" requires target_pinning but no target was resolved.`);
  }
  if (target) {
    // The launch prompt is executable context, so it names the canonical repo.
    // The exact operator input remains available in resolved_vars and, when it
    // changed, target.requested_repo.
    variables.templateValues["repo"] = target.repo;
  }
  addTargetTemplateValues(variables.templateValues, target);

  const curricula = await materializeCurricula(loaded, agentsInfraRoot);
  const skillRefs = await preflightSkillRefs(loaded.definition, options.skillInstallRoots ?? defaultSkillInstallRoots());
  const procedureRefs = [...curricula.refs, ...skillRefs];
  const provenance = await buildProvenance(loaded, procedureRefs);
  const renderedPrompt = `${renderStrictTemplate(promptTemplate, variables.templateValues).trimEnd()}${renderTargetWarnings(target)}${curricula.promptAppendix}`;
  const backendStrategy = backendSelectionStrategy(loaded.definition);
  const backend = selectBackend(loaded.definition, options.backend, options.requesterBackend);
  const timeoutMinutes = loaded.definition.execution.safety?.timeout_minutes;
  const timeoutMs = typeof timeoutMinutes === "number" ? Math.round(timeoutMinutes * 60 * 1000) : undefined;
  const backendOptions = buildBackendOptions(loaded.definition, backend, timeoutMs);
  const artifacts = requiredArtifacts(loaded.definition);
  const capture = outputCapture(loaded.definition);
  if (capture && loaded.definition.posture?.workspace_mutation !== "forbidden") {
    throw new Error(`Agent "${agentId}" output capture requires posture.workspace_mutation=forbidden.`);
  }
  if (capture && backend !== "codex") {
    throw new Error(`Agent "${agentId}" output capture requires the Codex backend.`);
  }
  const model = loaded.definition.execution.model?.[backend];
  const reasoningEffort = loaded.definition.execution.reasoning_effort;

  const metadata = {
    agent_definition: {
      registry_path: registryPath,
      definition_path: loaded.definitionPath,
      prompt_template_path: promptTemplatePath,
      definition_ref: provenance.definition_ref,
      agent_ref: provenance.agent_ref,
      definition_digest: provenance.definition_digest,
      definition_digest_algorithm: provenance.definition_digest_algorithm,
      definition_source: provenance.definition_source,
      ...(provenance.definition_snapshot ? { definition_snapshot: provenance.definition_snapshot } : {}),
      procedure_refs: provenance.procedure_refs,
      resolved_vars: variables.inputValues,
      ...(target ? { target, target_rounds: [target] } : {}),
      target_template_namespace: target ? TARGET_TEMPLATE_FIELDS.map((field) => `target.${field}`) : [],
      target_repin_policy: loaded.definition.context?.target_pinning === "required" ? "re-pin-or-fail" : "none",
      target_unavailable_handback: "target-moved; re-pin required",
      required_artifacts: artifacts,
      ...(capture ? { output_capture: capture } : {}),
      workspace_mutation: loaded.definition.posture?.workspace_mutation ?? "allowed",
      backend_selection: {
        strategy: backendStrategy,
        selected_backend: backend,
        override: Boolean(options.backend),
        ...(options.requesterBackend ? { requester_backend: options.requesterBackend } : {}),
      },
      compiled_at: now(),
    },
  };

  return {
    agent_id: loaded.definition.id,
    registry_path: registryPath,
    definition_path: loaded.definitionPath,
    prompt: renderedPrompt,
    backend,
    backend_strategy: backendStrategy,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(target
      ? { repo: target.repo }
      : typeof variables.inputValues["repo"] === "string"
        ? { repo: variables.inputValues["repo"] }
        : {}),
    ...(loaded.definition.context?.worktree?.mode ? { worktree_mode: loaded.definition.context.worktree.mode } : {}),
    ...(target ? { worktree_ref: target.head_sha } : {}),
    ...(target?.scope === "branch" && target.branch ? { branch: target.branch } : {}),
    required_artifacts: artifacts,
    ...(capture ? { output_capture: capture } : {}),
    backend_options: backendOptions,
    ...(target ? { target } : {}),
    resolved_vars: variables.inputValues,
    provenance,
    metadata,
  };
}
