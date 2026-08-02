import {
  INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION,
  INFRA_ERROR_FAILURE_LAYERS,
  INFRA_ERROR_FAILURE_REASONS,
  type InfraErrorClassification,
  type InfraErrorFailureLayer,
  type InfraErrorFailureReason,
} from "./types.js";

export type InfraErrorClassificationSite =
  | "worktree_acquisition"
  | "backend_spawn"
  | "secrets_auth"
  | "daemon_feature_refusal"
  | "prompts_resolution"
  | "runtime_config"
  | "runner_task"
  | "unknown";

export interface ClassifyInfraErrorContext {
  site?: InfraErrorClassificationSite | undefined;
  message?: string | undefined;
  error?: unknown;
}

export interface InfraErrorRule {
  id: string;
  site?: InfraErrorClassificationSite | undefined;
  pattern?: RegExp | undefined;
  failure_layer: InfraErrorFailureLayer;
  failure_reason: InfraErrorFailureReason;
}

const KNOWN_LAYERS = new Set<InfraErrorFailureLayer>(INFRA_ERROR_FAILURE_LAYERS);
const KNOWN_REASONS = new Set<InfraErrorFailureReason>(INFRA_ERROR_FAILURE_REASONS);

export const INFRA_ERROR_RULES: readonly InfraErrorRule[] = [
  {
    id: "worktree-lease-refused",
    site: "worktree_acquisition",
    pattern: /\b(?:db\s+)?lease\b.*(?:held|refus|unavailable|conflict)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_lease_refused",
  },
  {
    id: "worktree-file-lock",
    site: "worktree_acquisition",
    pattern: /worktree locked by run/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_locked",
  },
  {
    id: "worktree-ref-unresolved",
    site: "worktree_acquisition",
    pattern: /worktree ref .*(?:could not be (?:resolved|fetched)|still could not be resolved|fetch .*failed)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_ref_unresolved",
  },
  {
    id: "repo-unregistered",
    site: "worktree_acquisition",
    pattern: /(?:does not have repo slug|repo slug .*could not be resolved|repo slug .*cannot be resolved|repo identifier .*requires agents-infra root|no repo resolver is configured)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "repo_unregistered",
  },
  {
    id: "worktree-base-not-repo",
    site: "worktree_acquisition",
    pattern: /worktree base .* is not a git repository/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_base_not_repo",
  },
  {
    id: "worktree-branch-required",
    site: "worktree_acquisition",
    pattern: /requires (?:either )?--worktree-branch/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_branch_required",
  },
  {
    id: "worktree-path-missing",
    site: "worktree_acquisition",
    pattern: /(?:explicit worktree path (?:does not exist|is not a directory)|existing worktree mode requires --worktree-path|create worktree mode requires --worktree-path|existing path, but it is not available)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_path_missing",
  },
  {
    id: "git-worktree-lock",
    site: "worktree_acquisition",
    pattern: /(?:git worktree add failed.*(?:could not lock|not a git repository|not a git repo)|could not lock config)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "git_worktree_lock",
  },
  {
    id: "worktree-ref-invalid",
    site: "worktree_acquisition",
    pattern: /(?:worktree ref is empty|worktree ref .* is ambiguous|invalid reference|not a valid ref)/i,
    failure_layer: "worktree_acquisition",
    failure_reason: "worktree_ref_invalid",
  },
  {
    id: "prompt-source-missing",
    pattern: /(?:prompt file not found|prompt file resolved to an empty prompt|has no prompt source|no prompt source|requires an execplan|require_execplan is true but no execplan_ref|execplan ref not found|execplan .* was not found|prompt template .* not found|prompts? source missing)/i,
    failure_layer: "prompts_resolution",
    failure_reason: "prompts_source_missing",
  },
  {
    id: "secrets-auth",
    site: "secrets_auth",
    pattern: /\b(?:secret|credential|token|auth|authentication|unauthorized|forbidden)\b/i,
    failure_layer: "secrets_auth",
    failure_reason: "unknown",
  },
  {
    id: "daemon-feature-refusal",
    site: "daemon_feature_refusal",
    pattern: /(?:requires features not supported|protocol epoch|feature|self upgrade --host)/i,
    failure_layer: "daemon_feature",
    failure_reason: "feature_missing",
  },
  {
    id: "backend-spawn-exit",
    site: "backend_spawn",
    pattern: /(?:adapter session failed|completed without producing a turn result|backend event: infra_failure|infra_failure|spawn|app-server exited|exited code|maxbuffer|out of memory|killed process|sigkill|signal)/i,
    failure_layer: "backend_spawn",
    failure_reason: "backend_spawn_exit",
  },
  {
    id: "runtime-config",
    site: "runtime_config",
    failure_layer: "runtime_config",
    failure_reason: "unknown",
  },
  {
    id: "runner-task",
    site: "runner_task",
    failure_layer: "runner_task",
    failure_reason: "unknown",
  },
];

function normalizeMessage(ctx: ClassifyInfraErrorContext): string {
  if (typeof ctx.message === "string" && ctx.message.trim().length > 0) {
    return ctx.message.trim();
  }
  if (ctx.error instanceof Error && ctx.error.message.trim().length > 0) {
    return ctx.error.message.trim();
  }
  if (ctx.error !== undefined) {
    const text = String(ctx.error).trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "unknown";
}

function ruleMatches(rule: InfraErrorRule, site: InfraErrorClassificationSite | undefined, message: string): boolean {
  if (rule.site !== undefined && site !== rule.site) {
    if (site !== undefined || !rule.pattern) {
      return false;
    }
  }
  return rule.pattern ? rule.pattern.test(message) : true;
}

function siteFallback(site: InfraErrorClassificationSite | undefined): InfraErrorRule | undefined {
  switch (site) {
    case "worktree_acquisition":
      return {
        id: "worktree-fallback",
        site,
        failure_layer: "worktree_acquisition",
        failure_reason: "unknown",
      };
    case "backend_spawn":
      return {
        id: "backend-spawn-fallback",
        site,
        failure_layer: "backend_spawn",
        failure_reason: "backend_spawn_exit",
      };
    case "secrets_auth":
      return {
        id: "secrets-auth-fallback",
        site,
        failure_layer: "secrets_auth",
        failure_reason: "unknown",
      };
    case "daemon_feature_refusal":
      return {
        id: "daemon-feature-fallback",
        site,
        failure_layer: "daemon_feature",
        failure_reason: "feature_missing",
      };
    case "prompts_resolution":
      return {
        id: "prompts-fallback",
        site,
        failure_layer: "prompts_resolution",
        failure_reason: "prompts_source_missing",
      };
    case "runtime_config":
      return {
        id: "runtime-config-fallback",
        site,
        failure_layer: "runtime_config",
        failure_reason: "unknown",
      };
    case "runner_task":
      return {
        id: "runner-task-fallback",
        site,
        failure_layer: "runner_task",
        failure_reason: "unknown",
      };
    case "unknown":
    case undefined:
      return undefined;
    default: {
      const exhaustive: never = site;
      throw new Error(`Unhandled infra_error site ${String(exhaustive)}`);
    }
  }
}

export function classifyInfraError(ctx: ClassifyInfraErrorContext = {}): InfraErrorClassification {
  const message = normalizeMessage(ctx);
  const match =
    INFRA_ERROR_RULES.find((rule) => ruleMatches(rule, ctx.site, message))
    ?? INFRA_ERROR_RULES.find((rule) => rule.site === undefined && rule.pattern?.test(message))
    ?? siteFallback(ctx.site);

  const failure_layer = match?.failure_layer ?? "unknown";
  const failure_reason = match?.failure_reason ?? "unknown";
  if (!KNOWN_LAYERS.has(failure_layer) || !KNOWN_REASONS.has(failure_reason)) {
    throw new Error(`Invalid infra_error classification rule output: ${failure_layer}/${failure_reason}`);
  }

  return {
    schema_version: INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION,
    failure_layer,
    failure_reason,
    message,
  };
}

export function normalizeInfraErrorClassification(
  classification: InfraErrorClassification | undefined,
  ctx: ClassifyInfraErrorContext = {},
): InfraErrorClassification {
  if (
    classification
    && classification.schema_version === INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION
    && KNOWN_LAYERS.has(classification.failure_layer)
    && KNOWN_REASONS.has(classification.failure_reason)
    && classification.message.trim().length > 0
  ) {
    return classification;
  }
  return classifyInfraError(ctx);
}
