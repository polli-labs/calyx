import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  WorkflowAgentConfig,
  WorkflowConfig,
  WorkflowFile,
  WorkflowLoggingConfig,
  WorkflowPollingConfig,
  WorkflowPolicyConfig,
  WorkflowSelectionConfig,
  WorkflowTrackerConfig,
  WorkflowWorkspaceConfig,
} from "./types.js";

const trackerSchema = z.object({
  kind: z.string().min(1),
  team: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  active_states: z.array(z.string().min(1)).min(1),
  terminal_states: z.array(z.string().min(1)).min(1),
  claim_state: z.string().min(1).default("In Progress"),
  handoff_state: z.string().min(1).default("In Review"),
  include_labels: z.array(z.string().min(1)).optional(),
  exclude_labels: z.array(z.string().min(1)).optional(),
}).strict();

const pollingSchema = z.object({
  interval_seconds: z.number().int().positive(),
  idle_backoff_seconds: z.number().int().positive(),
  max_interval_seconds: z.number().int().positive(),
  stall_timeout_seconds: z.number().int().positive(),
  max_concurrent_agents: z.number().int().positive(),
  continuation_delay_seconds: z.number().int().positive().default(1),
  failure_backoff_seconds: z.number().int().positive().default(30),
  max_failure_backoff_seconds: z.number().int().positive().default(300),
  max_retries: z.number().int().nonnegative().default(5),
}).strict();

const selectionSchema = z.object({
  max_selected_issues: z.number().int().positive().optional(),
}).strict().default({});

const workflowPolicySchema = z.object({
  allow_done_handoff: z.boolean().default(false),
}).strict().default({ allow_done_handoff: false });

const workspaceSchema = z.object({
  root: z.string().min(1),
  repo_root: z.string().min(1).optional(),
  branch_template: z.string().min(1),
  ref: z.string().min(1).default("HEAD"),
  cleanup_terminal_after_hours: z.number().positive().optional(),
  after_create: z.array(z.string().min(1)).optional(),
  before_run: z.array(z.string().min(1)).optional(),
  after_run: z.array(z.string().min(1)).optional(),
  before_remove: z.array(z.string().min(1)).optional(),
}).strict();

const agentSchema = z.object({
  host: z.string().min(1).default("local"),
  backend: z.enum(["claude", "codex"]),
  profile: z.string().min(1).optional(),
  max_turns_per_run: z.number().int().positive(),
  require_execplan: z.boolean().default(false),
  pull_execplan: z.boolean().default(false),
  allowed_tools: z.array(z.string().min(1)).optional(),
  dangerously_skip_permissions: z.boolean().default(false),
  max_threads: z.number().int().positive().optional(),
  max_turns: z.number().int().positive().optional(),
}).strict().superRefine((agent, ctx) => {
  if (agent.backend === "claude" && agent.max_threads !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["max_threads"],
      message: "Claude does not support max_threads; use max_turns only when an explicit Claude turn cap is intended.",
    });
  }
  if (agent.backend === "codex" && agent.max_turns !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["max_turns"],
      message: "Codex does not support max_turns; use max_threads for Codex sub-agent concurrency.",
    });
  }
});

const loggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).strict().default({ level: "info" });

const workflowSchema = z.object({
  tracker: trackerSchema,
  polling: pollingSchema,
  selection: selectionSchema,
  workflow_policy: workflowPolicySchema,
  workspace: workspaceSchema,
  agent: agentSchema,
  logging: loggingSchema,
}).strict();

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

function normalizeTracker(config: z.infer<typeof trackerSchema>): WorkflowTrackerConfig {
  return {
    kind: config.kind.trim().toLowerCase(),
    ...(config.team ? { team: config.team.trim() } : {}),
    ...(config.project ? { project: config.project.trim() } : {}),
    active_states: config.active_states.map((value) => value.trim()),
    terminal_states: config.terminal_states.map((value) => value.trim()),
    claim_state: config.claim_state.trim(),
    handoff_state: config.handoff_state.trim(),
    ...(config.include_labels ? { include_labels: config.include_labels.map((value) => value.trim()) } : {}),
    ...(config.exclude_labels ? { exclude_labels: config.exclude_labels.map((value) => value.trim()) } : {}),
  };
}

function normalizePolling(config: z.infer<typeof pollingSchema>): WorkflowPollingConfig {
  return {
    interval_seconds: config.interval_seconds,
    idle_backoff_seconds: config.idle_backoff_seconds,
    max_interval_seconds: config.max_interval_seconds,
    stall_timeout_seconds: config.stall_timeout_seconds,
    max_concurrent_agents: config.max_concurrent_agents,
    continuation_delay_seconds: config.continuation_delay_seconds,
    failure_backoff_seconds: config.failure_backoff_seconds,
    max_failure_backoff_seconds: config.max_failure_backoff_seconds,
    max_retries: config.max_retries,
  };
}

function normalizeSelection(config: z.infer<typeof selectionSchema>): WorkflowSelectionConfig {
  return {
    ...(typeof config.max_selected_issues === "number"
      ? { max_selected_issues: config.max_selected_issues }
      : {}),
  };
}

function normalizeWorkflowPolicy(config: z.infer<typeof workflowPolicySchema>): WorkflowPolicyConfig {
  return {
    allow_done_handoff: config.allow_done_handoff,
  };
}

function normalizeWorkspace(
  config: z.infer<typeof workspaceSchema>,
  workflowPath: string,
): WorkflowWorkspaceConfig {
  const workflowDir = path.dirname(workflowPath);
  return {
    root: path.resolve(expandHome(config.root.trim())),
    repo_root: path.resolve(expandHome((config.repo_root ?? workflowDir).trim())),
    branch_template: config.branch_template.trim(),
    ref: config.ref.trim(),
    ...(typeof config.cleanup_terminal_after_hours === "number"
      ? { cleanup_terminal_after_hours: config.cleanup_terminal_after_hours }
      : {}),
    ...(config.after_create ? { after_create: [...config.after_create] } : {}),
    ...(config.before_run ? { before_run: [...config.before_run] } : {}),
    ...(config.after_run ? { after_run: [...config.after_run] } : {}),
    ...(config.before_remove ? { before_remove: [...config.before_remove] } : {}),
  };
}

function normalizeAgent(config: z.infer<typeof agentSchema>): WorkflowAgentConfig {
  return {
    host: config.host.trim(),
    backend: config.backend,
    ...(config.profile ? { profile: config.profile.trim() } : {}),
    max_turns_per_run: config.max_turns_per_run,
    require_execplan: config.require_execplan,
    pull_execplan: config.pull_execplan,
    ...(config.allowed_tools ? { allowed_tools: config.allowed_tools.map((value) => value.trim()) } : {}),
    dangerously_skip_permissions: config.dangerously_skip_permissions,
    ...(typeof config.max_threads === "number" ? { max_threads: config.max_threads } : {}),
    ...(typeof config.max_turns === "number" ? { max_turns: config.max_turns } : {}),
  };
}

function normalizeLogging(config: z.infer<typeof loggingSchema>): WorkflowLoggingConfig {
  return { level: config.level };
}

function parseWorkflowFrontmatter(rawText: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = rawText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("WORKFLOW.md must begin with a YAML frontmatter block delimited by ---.");
  }

  const frontmatterText = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = YAML.parse(frontmatterText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKFLOW.md frontmatter must parse to an object.");
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body,
  };
}

function applyTemplateVariables(template: string, variables: Record<string, string>): string {
  let result = template;
  const conditionalPattern = /\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
  result = result.replace(conditionalPattern, (_full, kind: string, rawName: string, body: string) => {
    const name = rawName.trim();
    const value = variables[name];
    if (kind === "#") {
      return value ? body : "";
    }
    return value ? "" : body;
  });

  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{{${key}}}}`, value);
    result = result.replaceAll(`{{${key}}}`, value);
  }

  return result;
}

function collectUnresolvedTemplateTokens(template: string): string[] {
  const unresolved = new Set<string>();
  for (const match of template.matchAll(/\{\{\{?\s*([^{}]+?)\s*\}?\}\}/g)) {
    const token = match[1]?.trim();
    if (token) {
      unresolved.add(token);
    }
  }
  return [...unresolved].sort();
}

export async function loadWorkflowFile(
  workflowPath: string,
  options: { now?: () => string } = {},
): Promise<WorkflowFile> {
  const absolutePath = path.resolve(workflowPath);
  const rawText = await readFile(absolutePath, "utf8");
  const { frontmatter, body } = parseWorkflowFrontmatter(rawText);
  const parsed = workflowSchema.parse(frontmatter);

  const config: WorkflowConfig = {
    tracker: normalizeTracker(parsed.tracker),
    polling: normalizePolling(parsed.polling),
    selection: normalizeSelection(parsed.selection),
    workflow_policy: normalizeWorkflowPolicy(parsed.workflow_policy),
    workspace: normalizeWorkspace(parsed.workspace, absolutePath),
    agent: normalizeAgent(parsed.agent),
    logging: normalizeLogging(parsed.logging),
  };

  return {
    path: absolutePath,
    loaded_at: options.now ? options.now() : new Date().toISOString(),
    config,
    prompt_template: body,
    raw_frontmatter: frontmatter,
  };
}

export function renderWorkflowPrompt(
  workflow: WorkflowFile,
  variables: Record<string, string>,
  options: { failOnUnresolved?: boolean } = {},
): string {
  const rendered = applyTemplateVariables(workflow.prompt_template, variables);
  const unresolved = collectUnresolvedTemplateTokens(rendered);
  if ((options.failOnUnresolved ?? true) && unresolved.length > 0) {
    throw new Error(`WORKFLOW.md prompt left unresolved placeholders: ${unresolved.join(", ")}`);
  }
  return rendered;
}
