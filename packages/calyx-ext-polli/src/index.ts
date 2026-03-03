/**
 * calyx-ext-polli — First-party Polli extension for Calyx.
 *
 * Provides registry pre-flight validation before sync/deploy commands and
 * emits fleet-level diagnostics. This extension targets the skills, tools,
 * and agents domains.
 *
 * Capabilities:
 * - beforeCommand: pre-flight checks on validate/sync/deploy commands
 * - afterCommand: structured diagnostic summary
 * - activate: environment readiness check
 */

import type {
  CalyxExtension,
  CalyxDomain,
  ExtensionContext,
  HookResult,
} from "@polli-labs/calyx-sdk";

/** Commands that trigger pre-flight checks. */
const PREFLIGHT_COMMANDS = new Set(["sync", "deploy", "validate"]);

/** Required environment variables for Polli fleet operations. */
const POLLI_ENV_HINTS: Record<string, string> = {
  skills: "CALYX_SKILLS_REGISTRY",
  tools: "CALYX_TOOLS_REGISTRY",
  agents: "CALYX_AGENTS_REGISTRY",
};

function checkEnvironmentHint(domain: CalyxDomain): string | undefined {
  const envVar = POLLI_ENV_HINTS[domain];
  if (envVar && !process.env[envVar]) {
    return `${envVar} is not set — ${domain} commands may fall back to config file or fail.`;
  }
  return undefined;
}

const extension: CalyxExtension = {
  manifest: {
    name: "calyx-ext-polli",
    version: "0.1.0",
    calyx: { apiVersion: "1", domains: ["skills", "tools", "agents"] },
  },

  hooks: {
    async activate(ctx: ExtensionContext): Promise<HookResult> {
      const messages: string[] = [];
      messages.push(`Polli extension activated (calyx ${ctx.calyxVersion})`);

      // Check for expected environment hints
      for (const domain of ctx.manifest.calyx.domains) {
        const hint = checkEnvironmentHint(domain as CalyxDomain);
        if (hint) {
          messages.push(hint);
        }
      }

      return { ok: true, messages };
    },

    async beforeCommand(
      _ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string
    ): Promise<HookResult> {
      const messages: string[] = [];

      if (!PREFLIGHT_COMMANDS.has(command)) {
        return { ok: true };
      }

      messages.push(`Pre-flight check: ${domain} ${command}`);

      // Check environment readiness for this domain
      const hint = checkEnvironmentHint(domain);
      if (hint) {
        messages.push(`Warning: ${hint}`);
      }

      return { ok: true, messages };
    },

    async afterCommand(
      _ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string,
      exitCode: number
    ): Promise<HookResult> {
      if (exitCode !== 0) {
        return {
          ok: true,
          messages: [`${domain} ${command} exited with code ${exitCode} — review diagnostics above.`],
        };
      }

      return { ok: true };
    },

    async deactivate(_ctx: ExtensionContext): Promise<HookResult> {
      return { ok: true, messages: ["Polli extension deactivated."] };
    },
  },
};

export default extension;
