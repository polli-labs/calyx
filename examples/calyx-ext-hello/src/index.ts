/**
 * calyx-ext-hello — Sample Calyx extension.
 *
 * Demonstrates the full extension lifecycle: activate, beforeCommand,
 * afterCommand, and deactivate hooks. Use this as a starting point for
 * building your own Calyx extension.
 */

import type { CalyxExtension } from "@polli-labs/calyx-sdk";

const extension: CalyxExtension = {
  manifest: {
    name: "calyx-ext-hello",
    version: "1.0.0",
    calyx: { apiVersion: "1", domains: ["skills"] },
  },
  hooks: {
    async activate(ctx) {
      console.log(`[calyx-ext-hello] activated (calyx ${ctx.calyxVersion})`);
      console.log(`[calyx-ext-hello] workspace: ${ctx.workspaceRoot}`);
      return { ok: true, messages: ["Extension ready."] };
    },

    async beforeCommand(_ctx, domain, command) {
      console.log(`[calyx-ext-hello] before → ${domain} ${command}`);
      // Return { ok: false } to prevent the command from running.
      return { ok: true };
    },

    async afterCommand(_ctx, domain, command, exitCode) {
      console.log(`[calyx-ext-hello] after → ${domain} ${command} (exit ${exitCode})`);
      return { ok: true };
    },

    async deactivate(_ctx) {
      console.log("[calyx-ext-hello] deactivated");
      return { ok: true };
    },
  },
};

export default extension;
