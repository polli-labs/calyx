/**
 * Extension loader and runtime.
 *
 * Provides deterministic extension discovery, manifest validation, version
 * compatibility checks, and lifecycle management. Extensions are discovered
 * from configured search paths, loaded in alphabetical order, and validated
 * against the current SDK API version before activation.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import type {
  CalyxExtension,
  CalyxExtensionManifest,
  CalyxDomain,
  HookResult,
  ExtensionContext,
} from "@polli-labs/calyx-sdk";
import { validateManifest, CALYX_SDK_API_VERSION } from "@polli-labs/calyx-sdk";

// ── Types ───────────────────────────────────────────────────────────

/** Severity of an extension diagnostic. */
export type ExtensionDiagnosticSeverity = "error" | "warning" | "info";

/** A diagnostic produced during extension discovery or loading. */
export interface ExtensionDiagnostic {
  /** Machine-readable code. */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Severity level. */
  severity: ExtensionDiagnosticSeverity;
  /** Extension name, if known. */
  extensionName?: string;
}

/** Result of loading a single extension. */
export interface ExtensionLoadResult {
  /** Whether the extension loaded successfully. */
  ok: boolean;
  /** Resolved package directory path. */
  packageDir: string;
  /** Parsed manifest (if available). */
  manifest?: CalyxExtensionManifest;
  /** The loaded extension (if successful). */
  extension?: CalyxExtension;
  /** Diagnostics produced during loading. */
  diagnostics: ExtensionDiagnostic[];
}

/** Result of discovering and loading all extensions from search paths. */
export interface ExtensionDiscoveryResult {
  /** Successfully loaded extensions, in deterministic (alphabetical) order. */
  loaded: ExtensionLoadResult[];
  /** Extensions that failed to load. */
  failed: ExtensionLoadResult[];
  /** All diagnostics across all extensions. */
  diagnostics: ExtensionDiagnostic[];
  /** Domain conflict map: domain → list of extension names claiming it. */
  conflicts: Record<string, string[]>;
}

/** Options for extension discovery. */
export interface ExtensionDiscoveryOptions {
  /** Directories to search for extension packages. */
  searchPaths: string[];
  /** If true, treat warnings as errors. */
  strict?: boolean;
}

/** Options for creating an extension runner. */
export interface ExtensionRunnerOptions {
  /** Absolute path to the calyx workspace root. */
  workspaceRoot: string;
  /** Current calyx CLI version string. */
  calyxVersion: string;
}

/** Result from running hooks across all loaded extensions. */
export interface ExtensionHookRunResult {
  /** Whether all hooks returned ok. */
  ok: boolean;
  /** Messages collected from all hooks. */
  messages: string[];
  /** Name of the extension that blocked (if any). */
  blockedBy?: string;
}

// ── Manifest reading ────────────────────────────────────────────────

/**
 * Read and parse a package.json manifest from a directory.
 * Returns the parsed manifest or diagnostics on failure.
 */
export async function readExtensionManifest(
  packageDir: string
): Promise<{ manifest?: CalyxExtensionManifest; diagnostics: ExtensionDiagnostic[] }> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const pkgPath = join(packageDir, "package.json");

  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
  } catch {
    diagnostics.push({
      code: "MANIFEST_READ_FAILED",
      message: `Cannot read ${pkgPath}`,
      severity: "error",
    });
    return { diagnostics };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    diagnostics.push({
      code: "MANIFEST_PARSE_FAILED",
      message: `Invalid JSON in ${pkgPath}`,
      severity: "error",
    });
    return { diagnostics };
  }

  // Validate the calyx manifest portion
  const validation = validateManifest(pkg);
  if (!validation.ok) {
    const nameStr = typeof pkg.name === "string" ? pkg.name : undefined;
    for (const issue of validation.issues) {
      const diag: ExtensionDiagnostic = {
        code: issue.code,
        message: issue.message,
        severity: "error",
      };
      if (nameStr) {
        diag.extensionName = nameStr;
      }
      diagnostics.push(diag);
    }
    return { diagnostics };
  }

  // At this point the manifest is structurally valid
  const manifest: CalyxExtensionManifest = {
    name: pkg.name as string,
    version: pkg.version as string,
    calyx: (pkg as Record<string, unknown>).calyx as CalyxExtensionManifest["calyx"],
  };

  return { manifest, diagnostics };
}

// ── Version compatibility ───────────────────────────────────────────

/**
 * Check whether an extension's declared apiVersion is compatible with
 * the current SDK. Returns diagnostics for incompatibility.
 */
export function checkApiVersionCompatibility(
  manifest: CalyxExtensionManifest
): ExtensionDiagnostic[] {
  const diagnostics: ExtensionDiagnostic[] = [];
  const declared = manifest.calyx.apiVersion;
  const current = CALYX_SDK_API_VERSION;

  if (declared !== current) {
    diagnostics.push({
      code: "API_VERSION_MISMATCH",
      message: `Extension "${manifest.name}" targets apiVersion "${declared}" but current SDK is "${current}".`,
      severity: "error",
      extensionName: manifest.name,
    });
  }

  return diagnostics;
}

// ── Discovery ───────────────────────────────────────────────────────

/**
 * Check if a directory looks like a calyx extension package.
 * Must have a package.json with a `calyx` key.
 */
async function isExtensionDir(dirPath: string): Promise<boolean> {
  try {
    const pkgPath = join(dirPath, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return pkg.calyx !== undefined && pkg.calyx !== null && typeof pkg.calyx === "object";
  } catch {
    return false;
  }
}

/**
 * Discover extension packages in the given search paths.
 *
 * Each search path is scanned for immediate subdirectories that contain
 * a `package.json` with a `calyx` key. Results are sorted alphabetically
 * by directory name for deterministic ordering.
 *
 * Search paths are processed in order; later paths can shadow earlier ones
 * (last-write-wins by extension name). This enables user overrides.
 */
export async function discoverExtensions(
  options: ExtensionDiscoveryOptions
): Promise<ExtensionDiscoveryResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const loaded: ExtensionLoadResult[] = [];
  const failed: ExtensionLoadResult[] = [];

  // Collect candidate directories from all search paths
  const candidates: Map<string, string> = new Map(); // name -> packageDir

  for (const searchPath of options.searchPaths) {
    const resolvedPath = resolve(searchPath);

    let entries: string[];
    try {
      entries = await readdir(resolvedPath);
    } catch {
      diagnostics.push({
        code: "SEARCH_PATH_UNREADABLE",
        message: `Cannot read extension search path: ${resolvedPath}`,
        severity: "warning",
      });
      continue;
    }

    // Sort entries alphabetically for deterministic processing
    entries.sort();

    for (const entry of entries) {
      const candidateDir = join(resolvedPath, entry);

      try {
        const s = await stat(candidateDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      if (await isExtensionDir(candidateDir)) {
        const name = basename(candidateDir);
        if (candidates.has(name)) {
          diagnostics.push({
            code: "EXTENSION_SHADOWED",
            message: `Extension "${name}" in ${candidateDir} shadows ${candidates.get(name)!}`,
            severity: "info",
            extensionName: name,
          });
        }
        candidates.set(name, candidateDir);
      }
    }
  }

  // Load each candidate in deterministic order (alphabetical by name)
  const sortedNames = [...candidates.keys()].sort();

  for (const name of sortedNames) {
    const packageDir = candidates.get(name)!;
    const result = await loadExtension(packageDir);
    diagnostics.push(...result.diagnostics);

    if (result.ok) {
      loaded.push(result);
    } else {
      failed.push(result);
    }
  }

  // Detect domain conflicts (multiple extensions claiming the same domain)
  const domainOwners: Record<string, string[]> = {};
  for (const result of loaded) {
    if (!result.manifest) continue;
    for (const domain of result.manifest.calyx.domains) {
      if (!domainOwners[domain]) {
        domainOwners[domain] = [];
      }
      domainOwners[domain]!.push(result.manifest.name);
    }
  }

  const conflicts: Record<string, string[]> = {};
  for (const [domain, owners] of Object.entries(domainOwners)) {
    if (owners && owners.length > 1) {
      conflicts[domain] = owners;
      const severity = options.strict ? "error" : "warning";
      const resolution = options.strict
        ? ` In strict mode, this is an error. Remove or reconfigure one of the conflicting extensions before proceeding.`
        : ` This is advisory — hooks from all listed extensions will run in alphabetical order. Use --strict to treat as an error.`;
      diagnostics.push({
        code: "DOMAIN_CONFLICT",
        message: `Domain "${domain}" claimed by multiple extensions: ${owners.join(", ")}.${resolution}`,
        severity,
      });
    }
  }

  return { loaded, failed, diagnostics, conflicts };
}

// ── Loading ─────────────────────────────────────────────────────────

/**
 * Load a single extension from a package directory.
 *
 * Steps:
 * 1. Read and validate the package.json manifest.
 * 2. Check API version compatibility.
 * 3. Dynamically import the extension module.
 * 4. Validate the default export conforms to CalyxExtension.
 */
export async function loadExtension(packageDir: string): Promise<ExtensionLoadResult> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const resolvedDir = resolve(packageDir);

  // Step 1: Read manifest
  const manifestResult = await readExtensionManifest(resolvedDir);
  diagnostics.push(...manifestResult.diagnostics);

  if (!manifestResult.manifest) {
    return { ok: false, packageDir: resolvedDir, diagnostics };
  }

  const manifest = manifestResult.manifest;

  // Step 2: API version compatibility
  const compatDiags = checkApiVersionCompatibility(manifest);
  diagnostics.push(...compatDiags);

  if (compatDiags.some((d) => d.severity === "error")) {
    return { ok: false, packageDir: resolvedDir, manifest, diagnostics };
  }

  // Step 3: Dynamic import
  let mod: Record<string, unknown>;
  try {
    const pkgPath = join(resolvedDir, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const mainField = (pkg.main as string | undefined) ?? "index.js";
    const entryPath = join(resolvedDir, mainField);
    mod = (await import(entryPath)) as Record<string, unknown>;
  } catch (err) {
    diagnostics.push({
      code: "MODULE_IMPORT_FAILED",
      message: `Failed to import extension "${manifest.name}": ${err instanceof Error ? err.message : String(err)}`,
      severity: "error",
      extensionName: manifest.name,
    });
    return { ok: false, packageDir: resolvedDir, manifest, diagnostics };
  }

  // Step 4: Validate default export
  const extension = (mod.default ?? mod) as CalyxExtension;

  if (!extension || typeof extension !== "object" || !extension.manifest) {
    diagnostics.push({
      code: "INVALID_EXPORT",
      message: `Extension "${manifest.name}" does not export a valid CalyxExtension object.`,
      severity: "error",
      extensionName: manifest.name,
    });
    return { ok: false, packageDir: resolvedDir, manifest, diagnostics };
  }

  return { ok: true, packageDir: resolvedDir, manifest, extension, diagnostics };
}

// ── Runtime ─────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of loaded extensions.
 *
 * Runs hooks in deterministic order (alphabetical by extension name).
 * A failing `beforeCommand` hook aborts the command; all other hook
 * failures are collected as diagnostics.
 */
export class ExtensionRunner {
  private readonly extensions: CalyxExtension[];
  private readonly workspaceRoot: string;
  private readonly calyxVersion: string;
  private activated = false;

  constructor(extensions: CalyxExtension[], options: ExtensionRunnerOptions) {
    // Sort by name for deterministic ordering
    this.extensions = [...extensions].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name)
    );
    this.workspaceRoot = options.workspaceRoot;
    this.calyxVersion = options.calyxVersion;
  }

  /** Number of extensions in this runner. */
  get count(): number {
    return this.extensions.length;
  }

  /** Whether extensions have been activated. */
  get isActivated(): boolean {
    return this.activated;
  }

  private contextFor(ext: CalyxExtension): ExtensionContext {
    return {
      workspaceRoot: this.workspaceRoot,
      calyxVersion: this.calyxVersion,
      manifest: ext.manifest,
    };
  }

  /** Activate all extensions. Must be called before running commands. */
  async activate(): Promise<ExtensionHookRunResult> {
    const messages: string[] = [];
    let allOk = true;

    for (const ext of this.extensions) {
      if (!ext.hooks?.activate) continue;

      let result: HookResult;
      try {
        result = await ext.hooks.activate(this.contextFor(ext));
      } catch (err) {
        messages.push(`[${ext.manifest.name}] activate threw: ${err instanceof Error ? err.message : String(err)}`);
        allOk = false;
        continue;
      }

      if (result.messages) {
        for (const m of result.messages) {
          messages.push(`[${ext.manifest.name}] ${m}`);
        }
      }

      if (!result.ok) {
        allOk = false;
        messages.push(`[${ext.manifest.name}] activate returned ok=false`);
      }
    }

    this.activated = true;
    return { ok: allOk, messages };
  }

  /**
   * Run beforeCommand hooks for all extensions targeting the given domain.
   * Returns `ok: false` if any extension blocks the command.
   */
  async beforeCommand(domain: CalyxDomain, command: string): Promise<ExtensionHookRunResult> {
    const messages: string[] = [];

    for (const ext of this.extensions) {
      if (!ext.hooks?.beforeCommand) continue;
      if (!ext.manifest.calyx.domains.includes(domain)) continue;

      let result: HookResult;
      try {
        result = await ext.hooks.beforeCommand(this.contextFor(ext), domain, command);
      } catch (err) {
        messages.push(`[${ext.manifest.name}] beforeCommand threw: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, messages, blockedBy: ext.manifest.name };
      }

      if (result.messages) {
        for (const m of result.messages) {
          messages.push(`[${ext.manifest.name}] ${m}`);
        }
      }

      if (!result.ok) {
        return { ok: false, messages, blockedBy: ext.manifest.name };
      }
    }

    return { ok: true, messages };
  }

  /** Run afterCommand hooks for all extensions targeting the given domain. */
  async afterCommand(domain: CalyxDomain, command: string, exitCode: number): Promise<ExtensionHookRunResult> {
    const messages: string[] = [];
    let allOk = true;

    for (const ext of this.extensions) {
      if (!ext.hooks?.afterCommand) continue;
      if (!ext.manifest.calyx.domains.includes(domain)) continue;

      let result: HookResult;
      try {
        result = await ext.hooks.afterCommand(this.contextFor(ext), domain, command, exitCode);
      } catch (err) {
        messages.push(`[${ext.manifest.name}] afterCommand threw: ${err instanceof Error ? err.message : String(err)}`);
        allOk = false;
        continue;
      }

      if (result.messages) {
        for (const m of result.messages) {
          messages.push(`[${ext.manifest.name}] ${m}`);
        }
      }

      if (!result.ok) {
        allOk = false;
      }
    }

    return { ok: allOk, messages };
  }

  /** Deactivate all extensions. Should be called on CLI exit. */
  async deactivate(): Promise<ExtensionHookRunResult> {
    const messages: string[] = [];
    let allOk = true;

    for (const ext of this.extensions) {
      if (!ext.hooks?.deactivate) continue;

      let result: HookResult;
      try {
        result = await ext.hooks.deactivate(this.contextFor(ext));
      } catch (err) {
        messages.push(`[${ext.manifest.name}] deactivate threw: ${err instanceof Error ? err.message : String(err)}`);
        allOk = false;
        continue;
      }

      if (result.messages) {
        for (const m of result.messages) {
          messages.push(`[${ext.manifest.name}] ${m}`);
        }
      }

      if (!result.ok) {
        allOk = false;
      }
    }

    this.activated = false;
    return { ok: allOk, messages };
  }
}
