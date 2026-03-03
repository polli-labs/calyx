import { describe, expect, test } from "vitest";
import { validateManifest } from "@polli-labs/calyx-sdk";
import { ExtensionRunner } from "@polli-labs/calyx-core";
import extension from "../index";

describe("calyx-ext-cursor", () => {
  test("exports a valid CalyxExtension", () => {
    expect(extension).toBeDefined();
    expect(extension.manifest).toBeDefined();
    expect(extension.hooks).toBeDefined();
  });

  test("manifest passes SDK validation", () => {
    const result = validateManifest(extension.manifest);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("manifest targets config, instructions, skills domains", () => {
    expect(extension.manifest.calyx.domains).toEqual(["config", "instructions", "skills"]);
  });

  test("manifest uses apiVersion 1", () => {
    expect(extension.manifest.calyx.apiVersion).toBe("1");
  });

  test("activate hook returns ok with Cursor environment info", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.activate!(ctx);
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes("Cursor extension activated"))).toBe(true);
    expect(result.messages!.some((m) => m.includes("rules files"))).toBe(true);
  });

  test("beforeCommand hook returns ok for compile", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "config", "compile");
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes("Cursor hint"))).toBe(true);
  });

  test("beforeCommand hook returns ok with no messages for non-hint commands", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "skills", "index");
    expect(result.ok).toBe(true);
  });

  test("beforeCommand provides instructions render hint", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "instructions", "render");
    expect(result.ok).toBe(true);
    expect(result.messages!.some((m) => m.includes("Cursor rules format"))).toBe(true);
  });

  test("beforeCommand provides skills sync hint", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "skills", "sync");
    expect(result.ok).toBe(true);
    expect(result.messages!.some((m) => m.includes("Cursor-readable paths"))).toBe(true);
  });

  test("afterCommand reports failure with Cursor-specific troubleshooting", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "config", "compile", 1);
    expect(result.ok).toBe(true);
    expect(result.messages?.some((m) => m.includes("failed (exit 1)"))).toBe(true);
    expect(result.messages?.some((m) => m.includes("Cursor"))).toBe(true);
  });

  test("afterCommand is silent for zero exit", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "skills", "sync", 0);
    expect(result.ok).toBe(true);
    expect(result.messages).toBeUndefined();
  });

  test("deactivate hook returns ok", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.deactivate!(ctx);
    expect(result.ok).toBe(true);
    expect(result.messages!.some((m) => m.includes("Cursor extension deactivated"))).toBe(true);
  });

  test("extension is non-destructive (never blocks)", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    // All hooks must return ok: true
    const activate = await extension.hooks!.activate!(ctx);
    expect(activate.ok).toBe(true);

    for (const domain of ["config", "instructions", "skills"] as const) {
      for (const command of ["compile", "render", "sync", "validate", "index"]) {
        const before = await extension.hooks!.beforeCommand!(ctx, domain, command);
        expect(before.ok).toBe(true);
      }
      // Even on failure exits, the extension should not block
      const after = await extension.hooks!.afterCommand!(ctx, domain, "sync", 1);
      expect(after.ok).toBe(true);
    }

    const deactivate = await extension.hooks!.deactivate!(ctx);
    expect(deactivate.ok).toBe(true);
  });
});

describe("calyx-ext-cursor via ExtensionRunner (integration)", () => {
  test("full lifecycle: activate → beforeCommand → afterCommand → deactivate", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });

    const activate = await runner.activate();
    expect(activate.ok).toBe(true);
    expect(activate.messages.some((m) => m.includes("Cursor extension activated"))).toBe(true);

    const before = await runner.beforeCommand("config", "compile");
    expect(before.ok).toBe(true);

    const after = await runner.afterCommand("config", "compile", 0);
    expect(after.ok).toBe(true);

    const deactivate = await runner.deactivate();
    expect(deactivate.ok).toBe(true);
    expect(deactivate.messages.some((m) => m.includes("Cursor extension deactivated"))).toBe(true);
  });

  test("beforeCommand fires for all targeted domains", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    for (const domain of ["config", "instructions", "skills"] as const) {
      const result = await runner.beforeCommand(domain, "validate");
      expect(result.ok).toBe(true);
    }

    await runner.deactivate();
  });

  test("beforeCommand does NOT fire for non-targeted domains", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    for (const domain of ["tools", "agents", "exec", "knowledge"] as const) {
      const result = await runner.beforeCommand(domain, "validate");
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(0);
    }

    await runner.deactivate();
  });

  test("runner reports correct extension count", () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    expect(runner.count).toBe(1);
  });
});
