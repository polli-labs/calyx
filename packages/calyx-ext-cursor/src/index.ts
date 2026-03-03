/**
 * calyx-ext-cursor — Harness-target extension for Cursor.
 *
 * Provides environment readiness hints and command diagnostics tailored
 * to Cursor-based agent workflows. This extension is non-destructive:
 * it never blocks commands (always returns ok: true).
 *
 * Capabilities:
 * - activate: check for Cursor-specific environment indicators
 * - beforeCommand: pre-flight hints for config/instructions/skills commands
 * - afterCommand: Cursor-aware diagnostic suggestions on failure
 * - deactivate: clean teardown
 */

import type {
  CalyxExtension,
  CalyxDomain,
  ExtensionContext,
  HookResult,
} from "@polli-labs/calyx-sdk";

/**
 * Environment indicators that suggest a Cursor workspace.
 * These are checked on activation for readiness hints.
 */
const CURSOR_ENV_INDICATORS: Record<string, string> = {
  CURSOR_SESSION_ID: "Active Cursor session identifier",
  CURSOR_WORKSPACE: "Cursor workspace root path",
};

/**
 * Cursor rules file paths relative to workspace root.
 * Checked during config/instructions commands for awareness.
 */
const CURSOR_RULES_FILES = [".cursor/rules", ".cursorrules"] as const;

/** Commands where Cursor-specific hints are most valuable. */
const HINT_COMMANDS = new Set(["compile", "render", "sync", "validate"]);

function detectCursorEnvironment(): { detected: boolean; hints: string[] } {
  const hints: string[] = [];
  let detected = false;

  for (const [envVar, description] of Object.entries(CURSOR_ENV_INDICATORS)) {
    if (process.env[envVar]) {
      detected = true;
    } else {
      hints.push(`${envVar} is not set — ${description}.`);
    }
  }

  return { detected, hints };
}

const extension: CalyxExtension = {
  manifest: {
    name: "calyx-ext-cursor",
    version: "0.1.0",
    calyx: { apiVersion: "1", domains: ["config", "instructions", "skills"] },
  },

  hooks: {
    async activate(ctx: ExtensionContext): Promise<HookResult> {
      const messages: string[] = [];
      messages.push(`Cursor extension activated (calyx ${ctx.calyxVersion})`);

      const { detected, hints } = detectCursorEnvironment();
      if (detected) {
        messages.push("Cursor environment detected.");
      } else {
        messages.push(
          "Cursor environment not detected — extension will still provide advisory diagnostics."
        );
      }

      for (const hint of hints) {
        messages.push(hint);
      }

      // Advise about Cursor rules files
      messages.push(
        `Cursor rules files to check: ${CURSOR_RULES_FILES.join(", ")} (relative to workspace root)`
      );

      return { ok: true, messages };
    },

    async beforeCommand(
      _ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string
    ): Promise<HookResult> {
      if (!HINT_COMMANDS.has(command)) {
        return { ok: true };
      }

      const messages: string[] = [];

      if (domain === "config" && command === "compile") {
        messages.push(
          "Cursor hint: ensure compiled config includes Cursor-compatible paths if targeting Cursor workspaces."
        );
      }

      if (domain === "instructions" && command === "render") {
        messages.push(
          "Cursor hint: rendered instructions should be compatible with Cursor rules format (.cursor/rules or .cursorrules)."
        );
      }

      if (domain === "skills" && command === "sync") {
        messages.push(
          "Cursor hint: skills sync should target Cursor-readable paths. Verify backend flag matches your Cursor workspace."
        );
      }

      return { ok: true, messages };
    },

    async afterCommand(
      _ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string,
      exitCode: number
    ): Promise<HookResult> {
      if (exitCode === 0) {
        return { ok: true };
      }

      const messages: string[] = [];
      messages.push(
        `${domain} ${command} failed (exit ${exitCode}) — Cursor-specific troubleshooting:`
      );

      if (domain === "config") {
        messages.push(
          "Check that fleet YAML includes Cursor-compatible host entries. Run `calyx config compile --help` for options."
        );
      } else if (domain === "instructions") {
        messages.push(
          "Verify template partials are compatible with Cursor rules format. Check .cursor/rules in the workspace."
        );
      } else if (domain === "skills") {
        messages.push(
          "Ensure skills registry paths are accessible from the Cursor workspace. Try `calyx skills validate --strict`."
        );
      }

      return { ok: true, messages };
    },

    async deactivate(_ctx: ExtensionContext): Promise<HookResult> {
      return { ok: true, messages: ["Cursor extension deactivated."] };
    },
  },
};

export default extension;
