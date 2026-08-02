import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  DomainSyncAction,
  DomainValidationIssue,
  PromptBackend,
  PromptsIndexResult,
  PromptRegistryEntry,
  PromptsRenderOptions,
  PromptsRenderResult,
  PromptsRegistry,
  PromptsSyncOptions,
  PromptsSyncResult,
  PromptsValidateOptions,
  PromptsValidateResult
} from "./types";
import { requireSourcePath } from "./resolve";

const promptRegistryEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    template_path: z.string().min(1),
    variables: z.array(z.string().min(1)),
    optional_variables: z.array(z.string().min(1)).optional(),
    targets: z.array(z.string().min(1)),
    exported_as_slash_command: z.boolean().optional()
  })
  .passthrough();

const promptsRegistrySchema = z
  .object({
    version: z.string().min(1),
    schema_version: z.string().min(1).optional(),
    prompts: z.array(promptRegistryEntrySchema)
  })
  .passthrough();

interface PromptsError extends Error {
  exitCode?: number;
}

type PromptSyncBackend = Exclude<PromptBackend, "all">;

interface ParsedPromptTemplate {
  metadata: Record<string, string>;
  body: string;
}

interface PreparedPromptFileMutation {
  kind: "write" | "delete";
  targetPath: string;
  stagedDir?: string;
  stagedPath?: string;
  backupPath: string;
  hadExistingTarget: boolean;
  movedExistingTarget: boolean;
  wroteNewFile: boolean;
}

function toIssue(code: string, message: string, path?: string): DomainValidationIssue {
  return {
    code,
    message,
    ...(path ? { path } : {})
  };
}

function createPromptsError(message: string, exitCode = 1): PromptsError {
  const error = new Error(message) as PromptsError;
  error.exitCode = exitCode;
  return error;
}

function formatSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${at}: ${issue.message}`;
    })
    .join("; ");
}

async function loadPromptsRegistry(registryPath: string): Promise<PromptsRegistry> {
  let text = "";
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read prompts registry at ${registryPath}: ${message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON at ${registryPath}: ${message}`);
  }

  const parsedRegistry = promptsRegistrySchema.safeParse(parsedJson);
  if (!parsedRegistry.success) {
    throw new Error(`Invalid prompts registry schema at ${registryPath}: ${formatSchemaError(parsedRegistry.error)}`);
  }

  return parsedRegistry.data as PromptsRegistry;
}

async function resolvePromptsRegistryPath(registryPath?: string): Promise<string> {
  try {
    return await requireSourcePath("prompts", registryPath ? { cliValue: registryPath } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createPromptsError(message, 1);
  }
}

async function loadResolvedPromptsRegistry(registryPath?: string): Promise<{ registryPath: string; registry: PromptsRegistry }> {
  const resolvedRegistryPath = await resolvePromptsRegistryPath(registryPath);
  return {
    registryPath: resolvedRegistryPath,
    registry: await loadPromptsRegistry(resolvedRegistryPath),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parsePromptTemplate(rawText: string): ParsedPromptTemplate {
  if (!rawText.startsWith("---\n") && !rawText.startsWith("---\r\n")) {
    return {
      metadata: {},
      body: rawText
    };
  }

  const match = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/);
  if (!match) {
    return {
      metadata: {},
      body: rawText
    };
  }

  const metadata: Record<string, string> = {};
  for (const rawLine of (match[1] ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  return {
    metadata,
    body: rawText.slice(match[0].length).replace(/^\r?\n+/, "")
  };
}

function firstNonEmptyLine(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return "";
}

function oneLine(value: string): string {
  return value
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
}

function yamlValue(value: string): string {
  return JSON.stringify(oneLine(value));
}

function renderClaudePrompt(
  description: string,
  metadata: Record<string, string>,
  body: string
): string {
  const lines = ["---", `description: ${yamlValue(description)}`];
  const argumentHint = metadata["argument-hint"]?.trim();
  const allowedTools = metadata["allowed-tools"]?.trim();
  const model = metadata["model"]?.trim();
  const disableModelInvocation = metadata["disable-model-invocation"]?.trim();

  if (argumentHint) {
    lines.push(`argument-hint: ${yamlValue(argumentHint)}`);
  }
  if (allowedTools) {
    lines.push(`allowed-tools: ${yamlValue(allowedTools)}`);
  }
  if (model) {
    lines.push(`model: ${yamlValue(model)}`);
  }
  if (disableModelInvocation) {
    lines.push(`disable-model-invocation: ${yamlValue(disableModelInvocation)}`);
  }

  lines.push("---", "", body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function renderCodexPrompt(
  description: string,
  metadata: Record<string, string>,
  body: string
): string {
  const lines = ["---", `description: ${yamlValue(description)}`];
  const argumentHint = metadata["argument-hint"]?.trim();
  if (argumentHint) {
    lines.push(`argument-hint: ${yamlValue(argumentHint)}`);
  }

  lines.push("---", "", body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function promptBackends(backend: PromptBackend): PromptSyncBackend[] {
  if (backend === "all") {
    return ["claude", "codex"];
  }
  return [backend];
}

function resolvePromptInstallDir(backend: PromptSyncBackend): string {
  if (backend === "claude") {
    return path.join(path.resolve(homedir()), ".claude", "commands");
  }

  const codexHome = process.env.CODEX_HOME?.trim().length
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(path.resolve(homedir()), ".codex");
  return path.join(codexHome, "prompts");
}

function promptManifestName(backend: PromptSyncBackend): string {
  return backend === "claude" ? ".polli-managed-commands.json" : ".polli-managed-prompts.json";
}

function promptInstallPath(installDir: string, promptId: string): string {
  return path.join(installDir, `${promptId}.md`);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  return readFile(filePath, "utf8");
}

async function readManagedManifest(manifestPath: string): Promise<Set<string>> {
  const raw = await readTextIfExists(manifestPath);
  if (!raw) {
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((value) => String(value)));
    }
  } catch {
    return new Set<string>();
  }

  return new Set<string>();
}

function serializeManagedManifest(names: Iterable<string>): string {
  return `${JSON.stringify([...new Set(names)].sort(), null, 2)}\n`;
}

async function stagePromptWrite(targetPath: string, content: string): Promise<PreparedPromptFileMutation> {
  const parentDir = path.dirname(targetPath);
  await mkdir(parentDir, { recursive: true });

  const stagedDir = await mkdtemp(path.join(parentDir, ".calyx-prompt-stage-"));
  const stagedPath = path.join(stagedDir, path.basename(targetPath));
  try {
    await writeFile(stagedPath, content, "utf8");
    return {
      kind: "write",
      targetPath,
      stagedDir,
      stagedPath,
      backupPath: path.join(parentDir, `.calyx-prompt-backup-${randomUUID()}`),
      hadExistingTarget: await pathExists(targetPath),
      movedExistingTarget: false,
      wroteNewFile: false
    };
  } catch (error) {
    if (await pathExists(stagedDir)) {
      await rm(stagedDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function preparePromptDelete(targetPath: string): Promise<PreparedPromptFileMutation | undefined> {
  if (!(await pathExists(targetPath))) {
    return undefined;
  }

  return {
    kind: "delete",
    targetPath,
    backupPath: path.join(path.dirname(targetPath), `.calyx-prompt-backup-${randomUUID()}`),
    hadExistingTarget: true,
    movedExistingTarget: false,
    wroteNewFile: false
  };
}

async function cleanupPreparedPromptMutations(preparedMutations: PreparedPromptFileMutation[]): Promise<void> {
  for (const preparedMutation of preparedMutations) {
    if (preparedMutation.stagedDir && (await pathExists(preparedMutation.stagedDir))) {
      await rm(preparedMutation.stagedDir, { recursive: true, force: true });
    }
    if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
      await rm(preparedMutation.backupPath, { force: true });
    }
  }
}

async function commitPreparedPromptMutations(preparedMutations: PreparedPromptFileMutation[]): Promise<void> {
  const committedMutations: PreparedPromptFileMutation[] = [];

  try {
    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.hadExistingTarget) {
        await rename(preparedMutation.targetPath, preparedMutation.backupPath);
        preparedMutation.movedExistingTarget = true;
      }

      if (preparedMutation.kind === "delete") {
        committedMutations.push(preparedMutation);
        continue;
      }

      try {
        await rename(preparedMutation.stagedPath!, preparedMutation.targetPath);
        preparedMutation.wroteNewFile = true;
        committedMutations.push(preparedMutation);
      } catch (error) {
        if (
          preparedMutation.movedExistingTarget &&
          !(await pathExists(preparedMutation.targetPath)) &&
          (await pathExists(preparedMutation.backupPath))
        ) {
          await rename(preparedMutation.backupPath, preparedMutation.targetPath).catch(() => undefined);
          preparedMutation.movedExistingTarget = false;
        }
        throw error;
      }
    }

    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
        await rm(preparedMutation.backupPath, { force: true });
        preparedMutation.movedExistingTarget = false;
      }
    }
  } catch (error) {
    for (const committedMutation of committedMutations.reverse()) {
      if (committedMutation.wroteNewFile && (await pathExists(committedMutation.targetPath))) {
        await rm(committedMutation.targetPath, { force: true });
        committedMutation.wroteNewFile = false;
      }
      if (committedMutation.movedExistingTarget && (await pathExists(committedMutation.backupPath))) {
        await rename(committedMutation.backupPath, committedMutation.targetPath).catch(() => undefined);
        committedMutation.movedExistingTarget = false;
      }
    }
    throw error;
  } finally {
    for (const preparedMutation of preparedMutations) {
      if (preparedMutation.stagedDir && (await pathExists(preparedMutation.stagedDir))) {
        await rm(preparedMutation.stagedDir, { recursive: true, force: true });
      }
      if (preparedMutation.movedExistingTarget && (await pathExists(preparedMutation.backupPath))) {
        await rm(preparedMutation.backupPath, { force: true });
      }
    }
  }
}

async function resolveTemplatePath(registryPath: string, prompt: PromptRegistryEntry): Promise<string> {
  if (path.isAbsolute(prompt.template_path)) {
    return prompt.template_path;
  }

  let currentDir = path.dirname(registryPath);
  let lastCandidate = path.resolve(currentDir, prompt.template_path);
  while (true) {
    const candidate = path.resolve(currentDir, prompt.template_path);
    if (await pathExists(candidate)) {
      return candidate;
    }
    lastCandidate = candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return lastCandidate;
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

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
}

function evaluatePromptsRegistry(registry: PromptsRegistry, options: PromptsValidateOptions = {}): PromptsValidateResult {
  const strict = options.strict ?? false;
  const errors: DomainValidationIssue[] = [];
  const warnings: DomainValidationIssue[] = [];
  const knownIds = new Set<string>();

  for (const [index, prompt] of registry.prompts.entries()) {
    if (knownIds.has(prompt.id)) {
      errors.push(toIssue("prompts.duplicate-id", `Duplicate prompt id "${prompt.id}".`, `prompts[${index}].id`));
    }
    knownIds.add(prompt.id);

    const variableDuplicates = duplicateValues(prompt.variables);
    if (variableDuplicates.length > 0) {
      errors.push(
        toIssue(
          "prompts.duplicate-required-variable",
          `Prompt "${prompt.id}" has duplicate required variables: ${variableDuplicates.join(", ")}.`,
          `prompts[${index}].variables`
        )
      );
    }

    const optionalVariables = prompt.optional_variables ?? [];
    const optionalDuplicates = duplicateValues(optionalVariables);
    if (optionalDuplicates.length > 0) {
      errors.push(
        toIssue(
          "prompts.duplicate-optional-variable",
          `Prompt "${prompt.id}" has duplicate optional variables: ${optionalDuplicates.join(", ")}.`,
          `prompts[${index}].optional_variables`
        )
      );
    }

    const overlap = prompt.variables.filter((variable) => optionalVariables.includes(variable));
    if (overlap.length > 0) {
      const issue = toIssue(
        "prompts.variable-overlap",
        `Prompt "${prompt.id}" repeats variables in required and optional sets: ${overlap.join(", ")}.`,
        `prompts[${index}]`
      );
      if (strict) {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }

    if (prompt.targets.length === 0) {
      errors.push(
        toIssue("prompts.targets-empty", `Prompt "${prompt.id}" must declare at least one target.`, `prompts[${index}].targets`)
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    version: registry.version,
    total: registry.prompts.length
  };
}

function ensureValidOrThrow(validation: PromptsValidateResult, registryPath: string): void {
  if (validation.ok) {
    return;
  }

  const details = validation.errors
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  throw new Error(`Prompts registry validation failed at ${registryPath}: ${details}`);
}

export async function validatePromptsRegistry(
  registryPath: string,
  options: PromptsValidateOptions = {}
): Promise<PromptsValidateResult> {
  const registry = await loadPromptsRegistry(registryPath);
  return evaluatePromptsRegistry(registry, options);
}

export async function indexPromptsRegistry(registryPath: string): Promise<PromptsIndexResult> {
  const registry = await loadPromptsRegistry(registryPath);
  const validation = evaluatePromptsRegistry(registry, { strict: true });
  ensureValidOrThrow(validation, registryPath);

  return {
    version: registry.version,
    total: registry.prompts.length,
    items: registry.prompts
  };
}

async function buildPromptInstallContent(
  backend: PromptSyncBackend,
  registryPath: string,
  prompt: PromptRegistryEntry
): Promise<string> {
  const templatePath = await resolveTemplatePath(registryPath, prompt);
  if (!(await pathExists(templatePath))) {
    throw new Error(`Unable to resolve template for prompt "${prompt.id}" (${prompt.template_path}).`);
  }

  const rawTemplate = await readFile(templatePath, "utf8");
  const parsedTemplate = parsePromptTemplate(rawTemplate);
  const description =
    prompt.description.trim() ||
    parsedTemplate.metadata["description"]?.trim() ||
    firstNonEmptyLine(parsedTemplate.body) ||
    prompt.id;

  if (backend === "claude") {
    return renderClaudePrompt(description, parsedTemplate.metadata, parsedTemplate.body);
  }
  return renderCodexPrompt(description, parsedTemplate.metadata, parsedTemplate.body);
}

async function findStaleManagedPromptIds(
  targetBackends: PromptSyncBackend[],
  desiredPromptIds: Set<string>
): Promise<string[]> {
  const staleIds = new Set<string>();

  for (const targetBackend of targetBackends) {
    const installDir = resolvePromptInstallDir(targetBackend);
    const manifestPath = path.join(installDir, promptManifestName(targetBackend));
    const managedIds = await readManagedManifest(manifestPath);
    for (const managedId of managedIds) {
      if (!desiredPromptIds.has(managedId)) {
        staleIds.add(managedId);
      }
    }
  }

  return [...staleIds].sort();
}

async function preparePromptSyncMutations(
  targetBackends: PromptSyncBackend[],
  prompts: PromptRegistryEntry[],
  registryPath: string
): Promise<PreparedPromptFileMutation[]> {
  const preparedMutations: PreparedPromptFileMutation[] = [];

  try {
    for (const targetBackend of targetBackends) {
      const installDir = resolvePromptInstallDir(targetBackend);
      const desiredFiles = new Map<string, string>();

      for (const prompt of prompts) {
        desiredFiles.set(prompt.id, await buildPromptInstallContent(targetBackend, registryPath, prompt));
      }

      for (const [promptId, contents] of desiredFiles.entries()) {
        const targetPath = promptInstallPath(installDir, promptId);
        const liveContents = await readTextIfExists(targetPath);
        if (liveContents === contents) {
          continue;
        }

        preparedMutations.push(await stagePromptWrite(targetPath, contents));
      }

      const manifestPath = path.join(installDir, promptManifestName(targetBackend));
      const managedIds = await readManagedManifest(manifestPath);
      for (const managedId of [...managedIds].sort()) {
        if (desiredFiles.has(managedId)) {
          continue;
        }

        const preparedDeletion = await preparePromptDelete(promptInstallPath(installDir, managedId));
        if (preparedDeletion) {
          preparedMutations.push(preparedDeletion);
        }
      }

      const manifestContents = serializeManagedManifest(desiredFiles.keys());
      const liveManifest = await readTextIfExists(manifestPath);
      if (liveManifest !== manifestContents) {
        preparedMutations.push(await stagePromptWrite(manifestPath, manifestContents));
      }
    }
  } catch (error) {
    await cleanupPreparedPromptMutations(preparedMutations);
    throw error;
  }

  return preparedMutations;
}

export async function syncPromptsRegistry(
  registryPath: string,
  options: PromptsSyncOptions = {}
): Promise<PromptsSyncResult> {
  const backend: PromptBackend = options.backend ?? "all";
  const apply = Boolean(options.apply);
  const indexed = await indexPromptsRegistry(registryPath);
  const targetBackends = promptBackends(backend);
  const desiredPromptIds = new Set(indexed.items.map((prompt) => prompt.id));
  const staleManagedPromptIds = await findStaleManagedPromptIds(targetBackends, desiredPromptIds);

  const actions: DomainSyncAction[] = [
    ...indexed.items.map((prompt) => ({
      action: apply ? "sync" : "plan-sync",
      id: prompt.id,
      details: `backend=${backend}`
    })),
    ...staleManagedPromptIds.map((promptId) => ({
      action: apply ? "prune" : "plan-prune",
      id: promptId,
      details: `backend=${backend}`
    }))
  ];

  if (apply) {
    const preparedMutations = await preparePromptSyncMutations(targetBackends, indexed.items, registryPath);
    if (preparedMutations.length > 0) {
      await commitPreparedPromptMutations(preparedMutations);
    }
  }

  return {
    backend,
    apply,
    version: indexed.version,
    actions
  };
}

export async function renderPromptTemplate(options: PromptsRenderOptions): Promise<PromptsRenderResult> {
  const { registryPath, registry } = await loadResolvedPromptsRegistry(options.registryPath);
  const prompt = registry.prompts.find((entry) => entry.id === options.promptId);
  if (!prompt) {
    throw createPromptsError(`Prompt "${options.promptId}" was not found in ${registryPath}.`, 1);
  }

  const variables = { ...(options.variables ?? {}) };
  const requiredVariables = [...prompt.variables];
  const optionalVariables = [...(prompt.optional_variables ?? [])];
  const declaredVariables = new Set<string>([...requiredVariables, ...optionalVariables]);

  const missingVariables = requiredVariables.filter((name) => !(name in variables));
  if (missingVariables.length > 0) {
    throw createPromptsError(
      `Prompt "${prompt.id}" is missing required variables: ${missingVariables.join(", ")}.`,
      1,
    );
  }

  const undeclaredVariables = Object.keys(variables)
    .filter((name) => !declaredVariables.has(name))
    .sort();
  if ((options.failOnUndeclaredVariables ?? true) && undeclaredVariables.length > 0) {
    throw createPromptsError(
      `Prompt "${prompt.id}" received undeclared variables: ${undeclaredVariables.join(", ")}.`,
      1,
    );
  }

  const templatePath = await resolveTemplatePath(registryPath, prompt);
  let templateBody = "";
  try {
    templateBody = await readFile(templatePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createPromptsError(`Failed to read prompt template at ${templatePath}: ${message}`, 1);
  }

  const renderedPrompt = applyTemplateVariables(templateBody, variables);
  const unresolvedPlaceholders = collectUnresolvedTemplateTokens(renderedPrompt);
  if ((options.failOnUnresolvedPlaceholders ?? true) && unresolvedPlaceholders.length > 0) {
    throw createPromptsError(
      `Prompt "${prompt.id}" left unresolved placeholders after render: ${unresolvedPlaceholders.join(", ")}.`,
      1,
    );
  }

  return {
    promptId: prompt.id,
    registryPath,
    templatePath,
    renderedPrompt,
    variables,
    requiredVariables,
    optionalVariables,
    targets: [...prompt.targets],
    undeclaredVariables,
    unresolvedPlaceholders,
  };
}
