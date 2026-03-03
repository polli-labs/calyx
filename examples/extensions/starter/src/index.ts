/**
 * calyx-ext-starter — Starter template for Calyx extensions.
 *
 * Copy this directory as a starting point for your own extension.
 * Update the manifest (name, version, domains) and implement your
 * hook logic below.
 *
 * Extension lifecycle:
 *   load → activate → (beforeCommand → command → afterCommand)* → deactivate
 *
 * All hooks are optional — remove any you don't need.
 *
 * @see https://github.com/polli-labs/calyx/blob/main/docs/extension-sdk.md
 */

import type {
  CalyxExtension,
  CalyxDomain,
  ExtensionContext,
  HookResult,
} from "@polli-labs/calyx-sdk";

const extension: CalyxExtension = {
  manifest: {
    // Update these to match your package.json
    name: "calyx-ext-starter",
    version: "0.1.0",
    calyx: {
      apiVersion: "1",
      // Declare which domains your extension targets.
      // Hooks only fire for commands in these domains.
      // Available: config, instructions, skills, tools, prompts, agents, knowledge, exec
      domains: ["skills"],
    },
  },

  hooks: {
    /**
     * Called once when the extension is loaded.
     * Use for one-time setup or environment validation.
     */
    async activate(ctx: ExtensionContext): Promise<HookResult> {
      const messages: string[] = [];
      messages.push(
        `[${ctx.manifest.name}] activated (calyx ${ctx.calyxVersion})`
      );
      messages.push(`[${ctx.manifest.name}] workspace: ${ctx.workspaceRoot}`);
      return { ok: true, messages };
    },

    /**
     * Called before each domain command.
     * Return { ok: false } to abort the command.
     * Return { ok: true } to allow it to proceed.
     */
    async beforeCommand(
      ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string
    ): Promise<HookResult> {
      console.log(`[${ctx.manifest.name}] before → ${domain} ${command}`);
      return { ok: true };
    },

    /**
     * Called after each domain command completes.
     * Use for telemetry, cleanup, or diagnostic summaries.
     */
    async afterCommand(
      ctx: ExtensionContext,
      domain: CalyxDomain,
      command: string,
      exitCode: number
    ): Promise<HookResult> {
      console.log(
        `[${ctx.manifest.name}] after → ${domain} ${command} (exit ${exitCode})`
      );
      return { ok: true };
    },

    /**
     * Called once on CLI exit. Use for cleanup.
     */
    async deactivate(ctx: ExtensionContext): Promise<HookResult> {
      console.log(`[${ctx.manifest.name}] deactivated`);
      return { ok: true };
    },
  },
};

export default extension;
