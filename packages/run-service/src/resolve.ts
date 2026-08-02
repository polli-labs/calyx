import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentsInfraEnvVar,
  renderPromptTemplate,
  resolveAgentsInfraRoot,
  resolveRepoIdentity,
  resolveVaultUri,
} from "@polli-labs/calyx-core";
import type { WorktreeSpec } from "@polli-labs/calyx-runner";
import type {
  ResolutionStep,
  ResolvedRunSpec,
  RunIntent,
  TemplateResolution,
} from "./types.js";

const execFile = promisify(execFileCallback);

export interface ResolveRunIntentOptions {
  now?: () => string;
  agentsInfraRoot?: string;
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

function docstoreRoot(): string {
  const fromEnv = process.env["DOCSTORE_ROOT"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(homedir(), ".agents", "docstore");
}

function isDocstoreRef(value: string): boolean {
  return value.startsWith("docstore://");
}

function resolveDocstoreRef(ref: string): string {
  const relPath = ref.slice("docstore://".length).trim();
  if (!relPath) {
    throw new Error(`Invalid docstore reference: ${ref}`);
  }
  return path.join(docstoreRoot(), relPath);
}

function resolveInputPath(rawPath: string): string {
  if (isDocstoreRef(rawPath)) {
    return resolveDocstoreRef(rawPath);
  }
  return path.resolve(rawPath);
}

async function resolveExecplanPath(
  rawPath: string,
  host: string,
  options: ResolveRunIntentOptions,
): Promise<string> {
  if (!rawPath.startsWith("vault://")) {
    return resolveInputPath(rawPath);
  }

  const agentsInfraRoot = options.agentsInfraRoot ?? await resolveAgentsInfraRoot();
  if (!agentsInfraRoot) {
    throw new Error(
      `ExecPlan ref ${rawPath} uses vault:// but agents-infra root could not be found on the target host. Set ${agentsInfraEnvVar()} or ensure ~/dev/agents-infra/dev exists.`,
    );
  }

  return resolveVaultUri(rawPath, host, agentsInfraRoot);
}

function parseExecplanSource(issue?: string): string[] {
  if (!issue) {
    return [];
  }
  const root = docstoreRoot();
  return [
    path.join(root, "execplan", issue, "EXECPLAN.md"),
    path.join(root, "execplan", issue, "plan.md"),
    path.join(root, "execplan", "items", issue, "source", "default", "EXECPLAN.md"),
    path.join(root, "execplan", "items", issue, "source", "default", "plan.md"),
    path.join(root, "execplan", "items", issue, "EXECPLAN.md"),
    path.join(root, "execplan", "items", issue, "plan.md"),
  ];
}

async function maybeReadUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pullExecplan(issue: string): Promise<void> {
  await execFile("docstore", ["pull", "execplan", "--since", "365d"]);
  const candidates = parseExecplanSource(issue);
  const matches = await Promise.all(candidates.map((candidate) => maybeReadUtf8(candidate)));
  if (!matches.some((match) => typeof match === "string")) {
    throw new Error(`ExecPlan for ${issue} was not found after docstore pull.`);
  }
}

async function resolveExecplan(
  intent: RunIntent,
  steps: ResolutionStep[],
  options: ResolveRunIntentOptions,
): Promise<{
  sourcePath?: string;
  content?: string;
}> {
  if (intent.pull_execplan && intent.issue) {
    await pullExecplan(intent.issue);
    steps.push({
      name: "execplan_pull",
      status: "resolved",
      detail: `Pulled ExecPlan namespace for ${intent.issue}.`,
    });
  } else {
    steps.push({
      name: "execplan_pull",
      status: "skipped",
      detail: "No explicit ExecPlan pull requested.",
    });
  }

  if (intent.execplan_ref) {
    const resolvedPath = await resolveExecplanPath(intent.execplan_ref, intent.host, options);
    const content = await maybeReadUtf8(resolvedPath);
    if (!content) {
      throw new Error(`ExecPlan ref not found: ${intent.execplan_ref} (${resolvedPath})`);
    }
    steps.push({
      name: "execplan_ref",
      status: "resolved",
      detail: `Resolved explicit ExecPlan ref: ${resolvedPath}`,
    });
    return { sourcePath: resolvedPath, content };
  }

  if (!intent.issue) {
    steps.push({
      name: "execplan_ref",
      status: "skipped",
      detail: "No explicit execplan_ref or issue supplied.",
    });
    return {};
  }

  for (const candidate of parseExecplanSource(intent.issue)) {
    const content = await maybeReadUtf8(candidate);
    if (content) {
      steps.push({
        name: "execplan_ref",
        status: "resolved",
        detail: `Resolved issue-linked ExecPlan: ${candidate}`,
      });
      return { sourcePath: candidate, content };
    }
  }

  steps.push({
    name: "execplan_ref",
    status: "skipped",
    detail: `No local ExecPlan found for ${intent.issue}.`,
  });
  return {};
}

async function resolveTemplatePrompt(
  templateId: string,
  variables: Record<string, string>,
): Promise<TemplateResolution> {
  const renderResult = await renderPromptTemplate({
    promptId: templateId,
    variables,
    failOnUndeclaredVariables: false,
  });
  return {
    templateId,
    prompt: renderResult.renderedPrompt,
    templatePath: renderResult.templatePath,
  };
}

function buildExecplanPrompt(issue: string | undefined, execplanContent: string): string {
  const header = [
    "You are a Calyx run execution worker.",
    "",
    "Hard constraints:",
    "- single bounded execution path",
    "- leave durable receipts in the run directory",
    "- do not stop early",
    issue ? `- update or reference Linear issue ${issue} in artifacts when relevant` : "- record issue context when present",
    "",
    "--- ExecPlan follows ---",
    "",
  ];
  return `${header.join("\n")}${execplanContent}`;
}

function effectiveWorktreeMode(intent: RunIntent): "existing" | "managed" | "create" {
  if (intent.worktree_mode) {
    return intent.worktree_mode;
  }
  return intent.worktree_path ? "existing" : "managed";
}

function deriveManagedBranch(issue: string): string {
  return `calyx-run/${issue.toLowerCase()}`;
}

function buildWorktree(intent: RunIntent, canonicalRepo?: string): WorktreeSpec {
  const worktree: WorktreeSpec = {};
  if (intent.worktree_mode) {
    worktree.mode = intent.worktree_mode;
  }
  if (intent.worktree_path) {
    worktree.path = intent.worktree_path;
  }
  const repo = canonicalRepo ?? intent.repo;
  if (repo) {
    worktree.repo = repo;
  }
  if (intent.worktree_ref) {
    worktree.ref = intent.worktree_ref;
  }
  if (intent.worktree_reset_on_reuse) {
    worktree.reset_on_reuse = true;
  }

  const mode = effectiveWorktreeMode(intent);
  if (intent.branch) {
    worktree.branch = intent.branch;
  } else if (mode === "managed" && intent.repo) {
    if (intent.issue) {
      worktree.branch = deriveManagedBranch(intent.issue);
    } else {
      throw new Error(
        [
          `Managed worktree launch for repo "${intent.repo}" requires either --worktree-branch <branch> or --issue <id>.`,
          "",
          "Pass --worktree-branch <branch> to pin an explicit Calyx-owned branch, or",
          "pass --issue <id> so Calyx can derive the managed branch as",
          "calyx-run/<lowercase issue> (for example, calyx-run/pol-1325).",
        ].join("\n"),
      );
    }
  }

  if (intent.steal_lock) {
    worktree.steal_lock = true;
  }
  return worktree;
}

function repoIdentifierRequiresRegistry(identifier: string): boolean {
  return /[:/]/.test(identifier);
}

export async function resolveRunIntent(
  intent: RunIntent,
  options: ResolveRunIntentOptions = {},
): Promise<ResolvedRunSpec> {
  const resolvedAt = nowIso(options.now);
  const steps: ResolutionStep[] = [];

  const execplan = await resolveExecplan(intent, steps, options);
  if (intent.require_execplan !== false && !execplan.sourcePath) {
    throw new Error(
      `Run ${intent.run_id} requires an ExecPlan, but none was resolved. Provide --execplan-ref, use --no-require-execplan, or ensure the issue-linked ExecPlan exists locally.`,
    );
  }

  let promptText: string | undefined;
  let resolvedTemplate: string | undefined;
  if (intent.template) {
    const templateVars = { ...(intent.template_vars ?? {}) };
    if (!templateVars["execplan_path"] && execplan.sourcePath) {
      templateVars["execplan_path"] = execplan.sourcePath;
    }
    if (!templateVars["issue"] && intent.issue) {
      templateVars["issue"] = intent.issue;
    }
    const resolved = await resolveTemplatePrompt(intent.template, templateVars);
    promptText = resolved.prompt;
    resolvedTemplate = intent.template;
    steps.push({
      name: "prompt_template",
      status: "resolved",
      detail: `Resolved prompt template ${intent.template} from ${resolved.templatePath}.`,
    });
  } else if (intent.prompt) {
    promptText = intent.prompt;
    steps.push({
      name: "prompt_inline",
      status: "resolved",
      detail: "Using inline prompt text.",
    });
  } else if (intent.prompt_file) {
    const promptPath = resolveInputPath(intent.prompt_file);
    const filePrompt = await maybeReadUtf8(promptPath);
    if (filePrompt === undefined) {
      throw new Error(
        `Prompt file not found on target host: ${intent.prompt_file} (${promptPath}). ` +
        "When launching through the calyx CLI, pass --prompt-file from the launcher host so the CLI can ship the file content as inline prompt text before remote dispatch.",
      );
    }
    if (filePrompt.trim().length === 0) {
      throw new Error(`Prompt file resolved to an empty prompt on target host: ${intent.prompt_file} (${promptPath})`);
    }
    promptText = filePrompt;
    steps.push({
      name: "prompt_file",
      status: "resolved",
      detail: `Loaded prompt file ${promptPath}.`,
    });
  } else if (execplan.content) {
    promptText = buildExecplanPrompt(intent.issue, execplan.content);
    steps.push({
      name: "prompt_execplan",
      status: "resolved",
      detail: "Built prompt from resolved ExecPlan content.",
    });
  } else {
    throw new Error(
      `Run ${intent.run_id} has no prompt source. Provide --prompt, --prompt-file, --template, or an ExecPlan.`,
    );
  }

  let canonicalRepo: string | undefined;
  // Existing-mode runs are worktree-path-authoritative; the checkout already
  // exists, so skip repo registry resolution (a local path is not a registered
  // slug). POL-1807.
  if (intent.repo && effectiveWorktreeMode(intent) !== "existing") {
    const agentsInfraRoot = options.agentsInfraRoot ?? await resolveAgentsInfraRoot();
    if (!agentsInfraRoot) {
      if (repoIdentifierRequiresRegistry(intent.repo)) {
        throw new Error(
          `Repo identifier ${intent.repo} requires agents-infra root discovery, but it could not be found on the target host. Set ${agentsInfraEnvVar()} or ensure ~/dev/agents-infra/dev exists.`,
        );
      }
    } else {
      const resolvedRepo = await resolveRepoIdentity(intent.repo, intent.host, agentsInfraRoot);
      canonicalRepo = resolvedRepo.slug;
      if (canonicalRepo !== intent.repo) {
        steps.push({
          name: "repo_identity",
          status: "resolved",
          detail: `Resolved repo identifier ${intent.repo} to canonical host-truth slug ${canonicalRepo}.`,
        });
      }
    }
  }

  const spec: ResolvedRunSpec = {
    run_id: intent.run_id,
    kernel: "agent_runner",
    host: intent.host,
    backend: intent.backend ?? "claude",
    prompt: promptText,
    require_execplan: intent.require_execplan !== false,
    worktree: buildWorktree(intent, canonicalRepo),
    ...(intent.worktree_source ? { worktree_source: intent.worktree_source } : {}),
    required_artifacts: intent.required_artifacts ?? [],
    artifact_roots: intent.artifact_roots ?? [],
    ...(intent.output_capture ? { output_capture: intent.output_capture } : {}),
    resolved_at: resolvedAt,
    resolution_log: steps,
    ...(intent.system_prompt ? { system_prompt: intent.system_prompt } : {}),
    ...(intent.append_system_prompt ? { append_system_prompt: intent.append_system_prompt } : {}),
    ...(intent.issue ? { issue: intent.issue } : {}),
    ...(resolvedTemplate ? { resolved_template: resolvedTemplate } : {}),
    ...(execplan.content ? { execplan_content: execplan.content } : {}),
    ...(execplan.sourcePath ? { execplan_source: execplan.sourcePath } : {}),
    ...(intent.profile ? { profile: intent.profile } : {}),
    ...(typeof intent.max_turns_per_run === "number" ? { max_turns_per_run: intent.max_turns_per_run } : {}),
    ...(intent.backend_options ? { backend_options: intent.backend_options } : {}),
    ...(intent.notifications ? { notifications: intent.notifications } : {}),
    ...(intent.handback ? { handback: intent.handback } : {}),
    ...(intent.metadata ? { metadata: intent.metadata } : {}),
    ...(intent.resume_session_id ? { resume_session_id: intent.resume_session_id } : {}),
  };

  return spec;
}
