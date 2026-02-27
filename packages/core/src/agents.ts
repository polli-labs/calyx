import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  AgentDeployBackend,
  AgentLifecycleStatus,
  AgentProfile,
  AgentsDeployOptions,
  AgentsDeployResult,
  AgentsIndexOptions,
  AgentsIndexResult,
  AgentsRegistry,
  AgentsRenderProfilesOptions,
  AgentsRenderProfilesResult,
  AgentsSyncOptions,
  AgentsSyncResult,
  AgentsValidateOptions,
  AgentsValidateResult,
  DomainSyncAction,
  DomainValidationIssue
} from "./types";

const agentStatusSchema = z.enum(["active", "deprecated", "archived"]);

const agentHostBindingSchema = z
  .object({
    host: z.string().min(1),
    role: z.string().min(1).optional()
  })
  .passthrough();

const agentRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    status: agentStatusSchema.optional(),
    deprecated_by: z.string().min(1).optional(),
    archived_at: z.string().min(1).optional(),
    hosts: z.array(agentHostBindingSchema).optional(),
    capabilities: z.array(z.string().min(1)).optional()
  })
  .passthrough();

const agentsRegistrySchema = z
  .object({
    version: z.string().min(1),
    generated_at: z.string().min(1).optional(),
    agents: z.array(agentRegistryEntrySchema)
  })
  .passthrough();

function toIssue(code: string, message: string, path?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(path ? { path } : {})
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

function lifecycleStatus(entryStatus?: AgentLifecycleStatus): AgentLifecycleStatus {
  return entryStatus ?? "active";
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

function evaluateAgentsRegistry(registry: AgentsRegistry, options: AgentsValidateOptions = {}): AgentsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];

  const knownIds = new Set<string>();
  let active = 0;
  let deprecated = 0;
  let archived = 0;

  for (const [index, agent] of registry.agents.entries()) {
    const status = lifecycleStatus(agent.status);

    if (knownIds.has(agent.id)) {
      errors.push(toIssue("agents.duplicate-id", `Duplicate agent id "${agent.id}".`, `agents[${index}].id`));
    }
    knownIds.add(agent.id);

    if (status === "active") {
      active += 1;
    }
    if (status === "deprecated") {
      deprecated += 1;
      if (!agent.deprecated_by) {
        errors.push(
          toIssue(
            "agents.deprecated-missing-replacement",
            `Deprecated agent "${agent.id}" must set deprecated_by.`,
            `agents[${index}].deprecated_by`
          )
        );
      }
    }
    if (status === "archived") {
      archived += 1;
      if (!agent.archived_at) {
        const issue = toIssue(
          "agents.archived-missing-date",
          `Archived agent "${agent.id}" should set archived_at.`,
          `agents[${index}].archived_at`
        );
        if (strict) {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }
    }

    if (agent.deprecated_by && agent.deprecated_by === agent.id) {
      errors.push(
        toIssue(
          "agents.invalid-self-replacement",
          `Agent "${agent.id}" cannot deprecate to itself.`,
          `agents[${index}].deprecated_by`
        )
      );
    }

    if (agent.deprecated_by && status !== "deprecated") {
      warnings.push(
        toIssue(
          "agents.unexpected-replacement",
          `Agent "${agent.id}" sets deprecated_by without deprecated status.`,
          `agents[${index}].deprecated_by`
        )
      );
    }

    if (agent.hosts) {
      const hostNames = new Set<string>();
      for (const [hostIndex, binding] of agent.hosts.entries()) {
        if (hostNames.has(binding.host)) {
          const issue = toIssue(
            "agents.duplicate-host-binding",
            `Agent "${agent.id}" has duplicate host binding "${binding.host}".`,
            `agents[${index}].hosts[${hostIndex}].host`
          );
          if (strict) {
            errors.push(issue);
          } else {
            warnings.push(issue);
          }
        }
        hostNames.add(binding.host);
      }
    }
  }

  for (const [index, agent] of registry.agents.entries()) {
    if (!agent.deprecated_by || !agent.deprecated_by.trim()) {
      continue;
    }

    if (!knownIds.has(agent.deprecated_by)) {
      const issue = toIssue(
        "agents.replacement-not-found",
        `Agent "${agent.id}" references missing replacement "${agent.deprecated_by}".`,
        `agents[${index}].deprecated_by`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    total: registry.agents.length,
    active,
    deprecated,
    archived
  };
}

function ensureValidOrThrow(validation: AgentsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Agents registry validation failed at ${registryPath}: ${details}`);
}

export async function validateAgentsRegistry(
  registryPath: string,
  options: AgentsValidateOptions = {}
): Promise<AgentsValidateResult> {
  const registry = await loadAgentsRegistry(registryPath);
  return evaluateAgentsRegistry(registry, options);
}

export async function indexAgentsRegistry(
  registryPath: string,
  options: AgentsIndexOptions = {}
): Promise<AgentsIndexResult> {
  const includeActive = options.includeActive ?? true;
  const includeDeprecated = options.includeDeprecated ?? true;
  const includeArchived = options.includeArchived ?? false;

  const registry = await loadAgentsRegistry(registryPath);
  const validation = evaluateAgentsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  const items = registry.agents.filter((agent) => {
    const status = lifecycleStatus(agent.status);
    if (status === "active") {
      return includeActive;
    }
    if (status === "deprecated") {
      return includeDeprecated;
    }
    return includeArchived;
  });

  return {
    version: registry.version,
    total: registry.agents.length,
    items
  };
}

export async function syncAgentsRegistry(registryPath: string, options: AgentsSyncOptions = {}): Promise<AgentsSyncResult> {
  const backend: AgentDeployBackend = options.backend ?? "all";
  const apply = Boolean(options.apply);

  const indexed = await indexAgentsRegistry(registryPath, {
    ...(options.includeActive !== undefined ? { includeActive: options.includeActive } : {}),
    ...(options.includeDeprecated !== undefined ? { includeDeprecated: options.includeDeprecated } : {}),
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {})
  });

  const actions: DomainSyncAction[] = indexed.items.map((agent) => ({
    action: apply ? "sync" : "plan-sync",
    id: agent.id,
    details: `backend=${backend}`
  }));

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}

export async function renderAgentProfiles(
  registryPath: string,
  options: AgentsRenderProfilesOptions = {}
): Promise<AgentsRenderProfilesResult> {
  const indexed = await indexAgentsRegistry(registryPath, {
    ...(options.includeActive !== undefined ? { includeActive: options.includeActive } : {}),
    ...(options.includeDeprecated !== undefined ? { includeDeprecated: options.includeDeprecated } : {}),
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {})
  });

  const profiles: AgentProfile[] = indexed.items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    status: lifecycleStatus(agent.status),
    hosts: agent.hosts ?? [],
    capabilities: agent.capabilities ?? []
  }));

  return {
    version: indexed.version,
    total: indexed.total,
    profiles
  };
}

export async function deployAgentsRegistry(
  registryPath: string,
  options: AgentsDeployOptions = {}
): Promise<AgentsDeployResult> {
  const backend: AgentDeployBackend = options.backend ?? "all";
  const apply = Boolean(options.apply);

  const indexed = await indexAgentsRegistry(registryPath, {
    ...(options.includeActive !== undefined ? { includeActive: options.includeActive } : {}),
    ...(options.includeDeprecated !== undefined ? { includeDeprecated: options.includeDeprecated } : {}),
    ...(options.includeArchived !== undefined ? { includeArchived: options.includeArchived } : {})
  });

  const actions: DomainSyncAction[] = indexed.items.map((agent) => ({
    action: apply ? "deploy" : "plan-deploy",
    id: agent.id,
    details: `backend=${backend}`
  }));

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}
