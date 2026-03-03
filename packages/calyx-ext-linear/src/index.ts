/**
 * calyx-ext-linear — First-party Linear extension for Calyx.
 *
 * Provides issue-context awareness for agents and exec domain commands.
 * Emits advisory hints when Linear environment variables are missing and
 * surfaces contextual diagnostics after command failures.
 *
 * Capabilities:
 * - activate: check for LINEAR_API_KEY / LINEAR_TEAM environment hints
 * - beforeCommand: hint when exec/agents commands lack issue context
 * - afterCommand: structured diagnostic with Linear-friendly context on failure
 * - deactivate: clean teardown
 *
 * This extension is non-destructive: it never blocks commands (always ok: true).
 */

import type {
  CalyxExtension,
  CalyxDomain,
  ExtensionContext,
  HookResult,
} from "@polli-labs/calyx-sdk";

/** Environment variables checked for Linear integration readiness. */
const LINEAR_ENV_HINTS: Record<string, string> = {
  LINEAR_API_KEY: "Linear API access (issue linking, status updates)",
  LINEAR_TEAM: "Default Linear team for issue context",
};

/** Commands where issue context is most valuable. */
const ISSUE_CONTEXT_COMMANDS = new Set(["launch", "deploy", "sync", "status"]);

function checkLinearEnvironment(): string[] {
  const hints: string[] = [];
  for (const [envVar, purpose] of Object.entries(LINEAR_ENV_HINTS)) {
    if (!process.env[envVar]) {
      hints.push(`${envVar} is not set — ${purpose}.`);
    }
  }
  return hints;
}

const extension: CalyxExtension = {
  manifest: {
    name: "calyx-ext-linear",
    version: "0.1.0",
    calyx: { apiVersion: "1", domains: ["agents", "exec"] },
  },

  hooks: {
    async activate(ctx: ExtensionContext): Promise<HookResult> {
      const messages: string[] = [];
      messages.push(`Linear extension activated (calyx ${ctx.calyxVersion})`);

      const envHints = checkLinearEnvironment();
      for (const hint of envHints) {
        messages.push(hint);
      }

      return { ok: true, messages };
    },

    async beforeCommand(
      _ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string
    ): Promise<HookResult> {
      if (!ISSUE_CONTEXT_COMMANDS.has(command)) {
        return { ok: true };
      }

      const messages: string[] = [];
      messages.push(`Linear context check: ${domain} ${command}`);

      // Hint about issue tracking for exec launches and agent deployments
      if (domain === "exec" && command === "launch") {
        messages.push(
          "Tip: Link exec runs to Linear issues for traceability (--issue flag or LINEAR_ISSUE env)."
        );
      }

      if (domain === "agents" && command === "deploy") {
        messages.push(
          "Tip: Agent deployments can be tracked via Linear issue updates."
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
        `${domain} ${command} failed (exit ${exitCode}) — consider filing or updating a Linear issue with the diagnostic output.`
      );

      if (domain === "exec") {
        messages.push(
          "Run `calyx exec receipt --run-id <id> --json` for a structured failure report suitable for Linear comments."
        );
      }

      return { ok: true, messages };
    },

    async deactivate(_ctx: ExtensionContext): Promise<HookResult> {
      return { ok: true, messages: ["Linear extension deactivated."] };
    },
  },
};

export default extension;
