/**
 * The pnpm workspace, derived once, for build-time consumers.
 *
 * Several surfaces need to know "which packages exist" or "what does this
 * package actually need at runtime": the vitest source-alias map, the root
 * TypeScript project graph, the release publish plan, the README package table.
 * Each of them used to restate the answer as a literal, and every one of those
 * literals sits on the far side of a boundary no single process crosses — a
 * release runner, a cold checkout, another machine, a later day. When they
 * drift they do not error, they degrade: an unaliased package silently resolves
 * to a stale `dist/`, an unpublished runtime dependency 404s on the consumer's
 * install. Deriving here is only half the fix; the other half is that each
 * consumer is checked against this module by a test, because a deriver nothing
 * consumes saves nobody.
 *
 * Two files hold the truth and this module requires them to agree:
 * `pnpm-workspace.yaml` says which directories are packages, and the lockfile's
 * `importers` says which directories pnpm actually installed. A package added
 * without `pnpm install`, an importer whose directory is gone, an unsupported
 * workspace glob, and a package directory with no name all throw here. That is
 * the point: this module fails closed, so a consumer can trust that a short
 * answer means a small workspace and not a silent parse miss.
 *
 * The YAML readers below are deliberately narrow. They read one top-level block
 * and reject any shape they do not fully understand rather than pull a YAML
 * parser into the root toolchain, which has no other need for one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const WORKSPACE_PROTOCOL = "workspace:";

const workspaceCache = new Map();

/**
 * Every workspace package, sorted by name. Throws if the workspace declaration
 * and the lockfile disagree about which directories are installed.
 */
export function allPackages(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const cached = workspaceCache.get(root);
  if (cached) return cached;
  const discovered = discoverPackages(root);
  assertLockfileAgreement(root, discovered);
  const packages = Object.freeze(discovered);
  workspaceCache.set(root, packages);
  return packages;
}

/**
 * `entryPackageName` plus every workspace package it needs at runtime, in
 * dependency-first order — the order a publish must use, and the set an install
 * of the entry package must be able to resolve. Only `workspace:` references in
 * the runtime dependency fields count; devDependencies are build-time only.
 */
export function runtimeClosure(entryPackageName, repoRoot = DEFAULT_REPO_ROOT) {
  const byName = new Map(allPackages(repoRoot).map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  if (!byName.has(entryPackageName)) {
    throw new Error(
      `${entryPackageName} is not a workspace package. Known packages: ${[...byName.keys()].join(", ")}.`,
    );
  }
  const ordered = [];
  const visited = new Set();
  const visit = (name, requiredBy) => {
    if (visited.has(name)) return;
    const workspacePackage = byName.get(name);
    if (!workspacePackage) {
      throw new Error(`Workspace dependency ${name}, required by ${requiredBy}, is not a workspace package.`);
    }
    visited.add(name);
    for (const dependency of workspaceDependencies(workspacePackage.manifest)) visit(dependency, name);
    ordered.push(workspacePackage);
  };
  visit(entryPackageName, entryPackageName);
  return Object.freeze(ordered);
}

/** The `workspace:`-protocol runtime dependency names declared by one manifest. */
export function workspaceDependencies(manifest) {
  return [...new Set(
    RUNTIME_DEPENDENCY_FIELDS
      .flatMap((field) => Object.entries(manifest[field] ?? {}))
      .filter(([, reference]) => String(reference).startsWith(WORKSPACE_PROTOCOL))
      .map(([name]) => name),
  )].sort();
}

function discoverPackages(root) {
  const byName = new Map();
  for (const relativePath of workspaceDirectories(root)) {
    const manifestPath = path.join(root, relativePath, "package.json");
    if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`${relativePath}/package.json declares no name, so no consumer can reference it.`);
    }
    const duplicate = byName.get(manifest.name);
    if (duplicate) {
      throw new Error(`Duplicate workspace package ${manifest.name} in ${duplicate.relativePath} and ${relativePath}.`);
    }
    byName.set(manifest.name, Object.freeze({
      name: manifest.name,
      relativePath,
      directory: path.join(root, relativePath),
      manifest: Object.freeze(manifest),
    }));
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function workspaceDirectories(root) {
  const patterns = yamlSequence(readRepoFile(root, "pnpm-workspace.yaml"), "packages", "pnpm-workspace.yaml");
  const directories = new Set();
  for (const pattern of patterns) {
    for (const directory of expandWorkspacePattern(root, pattern)) directories.add(directory);
  }
  return [...directories].sort();
}

function expandWorkspacePattern(root, pattern) {
  const segments = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  const wildcards = segments.filter((segment) => segment.includes("*"));
  if (wildcards.length === 0 && !pattern.startsWith("!")) return [segments.join("/")];
  if (wildcards.length !== 1 || wildcards[0] !== "*" || segments.at(-1) !== "*") {
    throw new Error(
      `pnpm-workspace.yaml pattern "${pattern}" is not derivable here; support an exact directory or one trailing "/*" segment, or teach this reader the new shape.`,
    );
  }
  const parentSegments = segments.slice(0, -1);
  return readdirSync(path.join(root, ...parentSegments), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [...parentSegments, entry.name].join("/"));
}

function assertLockfileAgreement(root, packages) {
  const importers = new Set(
    yamlMappingKeys(readRepoFile(root, "pnpm-lock.yaml"), "importers", "pnpm-lock.yaml").filter((key) => key !== "."),
  );
  const onDisk = new Set(packages.map((workspacePackage) => workspacePackage.relativePath));
  const uninstalled = [...onDisk].filter((directory) => !importers.has(directory));
  const orphaned = [...importers].filter((directory) => !onDisk.has(directory));
  if (uninstalled.length === 0 && orphaned.length === 0) return;
  throw new Error([
    "pnpm-workspace.yaml and pnpm-lock.yaml disagree about the workspace.",
    uninstalled.length > 0 ? `On disk but not in the lockfile: ${uninstalled.join(", ")}.` : "",
    orphaned.length > 0 ? `In the lockfile but not on disk: ${orphaned.join(", ")}.` : "",
    "Run `pnpm install` and commit the lockfile.",
  ].filter(Boolean).join(" "));
}

function readRepoFile(root, fileName) {
  return readFileSync(path.join(root, fileName), "utf8");
}

/** The entries of one top-level YAML block, trimmed; nested detail is skipped. */
function topLevelBlock(source, blockName, fileName) {
  const lines = source.split(/\r?\n/u);
  const start = lines.indexOf(`${blockName}:`);
  if (start < 0) throw new Error(`${fileName} has no top-level \`${blockName}:\` block.`);
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ")) break;
    const indent = line.length - line.trimStart().length;
    if (indent > 2) continue;
    if (indent !== 2) throw new Error(`${fileName} \`${blockName}:\` has an unreadable line: ${JSON.stringify(line)}.`);
    entries.push(line.trim());
  }
  if (entries.length === 0) throw new Error(`${fileName} \`${blockName}:\` is empty.`);
  return entries;
}

function yamlSequence(source, blockName, fileName) {
  return topLevelBlock(source, blockName, fileName).map((entry) => {
    const match = /^-\s+(?<value>\S.*)$/u.exec(entry);
    if (!match) throw new Error(`${fileName} \`${blockName}:\` is not a plain sequence: ${JSON.stringify(entry)}.`);
    return unquote(match.groups.value);
  });
}

function yamlMappingKeys(source, blockName, fileName) {
  return topLevelBlock(source, blockName, fileName).map((entry) => {
    const match = /^(?<key>[^:]+):(?:\s*\{\s*\})?$/u.exec(entry);
    if (!match) throw new Error(`${fileName} \`${blockName}:\` is not a plain mapping: ${JSON.stringify(entry)}.`);
    return unquote(match.groups.key);
  });
}

function unquote(value) {
  const trimmed = value.trim();
  return /^(["']).*\1$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}
