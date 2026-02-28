/**
 * @polli-labs/calyx-sdk — Extension SDK for Calyx.
 *
 * Provides contracts, validation helpers, and lifecycle hooks for building
 * Calyx extensions. Extensions register domain handlers that plug into the
 * calyx CLI and core runtime.
 */

// ── Extension manifest ──────────────────────────────────────────────

/** Supported Calyx domains that extensions can target. */
export type CalyxDomain =
  | "config"
  | "instructions"
  | "skills"
  | "tools"
  | "prompts"
  | "agents"
  | "knowledge"
  | "exec";

/** All known Calyx domains. */
export const CALYX_DOMAINS: readonly CalyxDomain[] = [
  "config",
  "instructions",
  "skills",
  "tools",
  "prompts",
  "agents",
  "knowledge",
  "exec",
] as const;

/**
 * Extension manifest declared in `package.json` under the `calyx` key.
 *
 * @example
 * ```json
 * {
 *   "name": "calyx-ext-hello",
 *   "version": "1.0.0",
 *   "calyx": {
 *     "apiVersion": "1",
 *     "domains": ["skills"]
 *   }
 * }
 * ```
 */
export interface CalyxExtensionManifest {
  /** Extension package name. */
  name: string;
  /** Extension package version (semver). */
  version: string;
  /** Calyx extension metadata. */
  calyx: {
    /** Calyx SDK API version this extension targets. */
    apiVersion: string;
    /** Domains this extension provides handlers for. */
    domains: CalyxDomain[];
  };
}

// ── Lifecycle hooks ─────────────────────────────────────────────────

/** Context passed to extension lifecycle hooks. */
export interface ExtensionContext {
  /** Absolute path to the calyx workspace root. */
  workspaceRoot: string;
  /** Current calyx CLI version string. */
  calyxVersion: string;
  /** Extension's own manifest. */
  manifest: CalyxExtensionManifest;
}

/** Result returned from an extension hook. */
export interface HookResult {
  /** Whether the hook completed successfully. */
  ok: boolean;
  /** Optional diagnostic messages. */
  messages?: string[];
}

/**
 * Extension lifecycle hooks.
 *
 * All hooks are optional. Implement only the ones your extension needs.
 */
export interface CalyxExtensionHooks {
  /** Called once when the extension is loaded. Use for setup/validation. */
  activate?(ctx: ExtensionContext): Promise<HookResult>;
  /** Called before a domain command runs. Return `ok: false` to abort. */
  beforeCommand?(ctx: ExtensionContext, domain: CalyxDomain, command: string): Promise<HookResult>;
  /** Called after a domain command completes. Use for telemetry or cleanup. */
  afterCommand?(ctx: ExtensionContext, domain: CalyxDomain, command: string, exitCode: number): Promise<HookResult>;
  /** Called when the extension is unloaded. Use for cleanup. */
  deactivate?(ctx: ExtensionContext): Promise<HookResult>;
}

// ── Extension definition ────────────────────────────────────────────

/**
 * Full extension definition returned by the extension's default export.
 *
 * @example
 * ```ts
 * import type { CalyxExtension } from "@polli-labs/calyx-sdk";
 *
 * const extension: CalyxExtension = {
 *   manifest: {
 *     name: "calyx-ext-hello",
 *     version: "1.0.0",
 *     calyx: { apiVersion: "1", domains: ["skills"] },
 *   },
 *   hooks: {
 *     async activate(ctx) {
 *       console.log(`[${ctx.manifest.name}] activated`);
 *       return { ok: true };
 *     },
 *   },
 * };
 *
 * export default extension;
 * ```
 */
export interface CalyxExtension {
  /** Extension manifest (mirrors the `calyx` key in package.json). */
  manifest: CalyxExtensionManifest;
  /** Optional lifecycle hooks. */
  hooks?: CalyxExtensionHooks;
}

// ── Validation helpers ──────────────────────────────────────────────

/** Validation issue found in an extension manifest. */
export interface ManifestValidationIssue {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable description. */
  message: string;
}

/** Result of validating an extension manifest. */
export interface ManifestValidationResult {
  /** Whether the manifest is valid. */
  ok: boolean;
  /** List of issues found. */
  issues: ManifestValidationIssue[];
}

/**
 * Validate a CalyxExtensionManifest.
 *
 * Checks required fields, apiVersion format, and domain values.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];

  if (manifest === null || manifest === undefined || typeof manifest !== "object") {
    return { ok: false, issues: [{ code: "MANIFEST_NOT_OBJECT", message: "Manifest must be a non-null object." }] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || m.name.length === 0) {
    issues.push({ code: "MISSING_NAME", message: "Manifest must have a non-empty 'name' string." });
  }

  if (typeof m.version !== "string" || m.version.length === 0) {
    issues.push({ code: "MISSING_VERSION", message: "Manifest must have a non-empty 'version' string." });
  }

  if (m.calyx === null || m.calyx === undefined || typeof m.calyx !== "object") {
    issues.push({ code: "MISSING_CALYX", message: "Manifest must have a 'calyx' object." });
    return { ok: false, issues };
  }

  const calyx = m.calyx as Record<string, unknown>;

  if (typeof calyx.apiVersion !== "string" || calyx.apiVersion.length === 0) {
    issues.push({ code: "MISSING_API_VERSION", message: "calyx.apiVersion must be a non-empty string." });
  }

  if (!Array.isArray(calyx.domains) || calyx.domains.length === 0) {
    issues.push({ code: "MISSING_DOMAINS", message: "calyx.domains must be a non-empty array." });
  } else {
    const domainSet = new Set<string>(CALYX_DOMAINS);
    for (const d of calyx.domains) {
      if (typeof d !== "string" || !domainSet.has(d)) {
        issues.push({
          code: "INVALID_DOMAIN",
          message: `Unknown domain '${String(d)}'. Valid domains: ${CALYX_DOMAINS.join(", ")}.`,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

// ── Constants ───────────────────────────────────────────────────────

/** Current SDK API version. Extensions should declare this in their manifest. */
export const CALYX_SDK_API_VERSION = "1";
