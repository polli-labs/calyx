import { describe, expect, test } from "vitest";
import { validateManifest } from "@polli-labs/calyx-sdk";
import { ExtensionRunner } from "@polli-labs/calyx-core";
import extension from "../index";

describe("calyx-ext-polli", () => {
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

  test("manifest targets skills, tools, agents domains", () => {
    expect(extension.manifest.calyx.domains).toEqual(["skills", "tools", "agents"]);
  });

  test("manifest uses apiVersion 1", () => {
    expect(extension.manifest.calyx.apiVersion).toBe("1");
  });

  test("activate hook returns ok", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.activate!(ctx);
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.length).toBeGreaterThan(0);
  });

  test("beforeCommand hook returns ok for sync", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "skills", "sync");
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
  });

  test("beforeCommand hook returns ok for non-preflight commands", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "skills", "index");
    expect(result.ok).toBe(true);
  });

  test("afterCommand hook reports non-zero exit", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "skills", "sync", 1);
    expect(result.ok).toBe(true);
    expect(result.messages?.some((m) => m.includes("exited with code 1"))).toBe(true);
  });

  test("afterCommand hook is silent for zero exit", async () => {
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
  });
});

describe("calyx-ext-polli via ExtensionRunner (integration)", () => {
  test("full lifecycle: activate → beforeCommand → afterCommand → deactivate for skills sync", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });

    // activate
    const activate = await runner.activate();
    expect(activate.ok).toBe(true);
    expect(activate.messages.some((m) => m.includes("Polli extension activated"))).toBe(true);

    // beforeCommand — skills sync triggers pre-flight
    const before = await runner.beforeCommand("skills", "sync");
    expect(before.ok).toBe(true);
    expect(before.messages.some((m) => m.includes("Pre-flight check: skills sync"))).toBe(true);

    // afterCommand — success exit
    const after = await runner.afterCommand("skills", "sync", 0);
    expect(after.ok).toBe(true);

    // deactivate
    const deactivate = await runner.deactivate();
    expect(deactivate.ok).toBe(true);
    expect(deactivate.messages.some((m) => m.includes("Polli extension deactivated"))).toBe(true);
  });

  test("beforeCommand fires for all targeted domains (skills, tools, agents)", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    for (const domain of ["skills", "tools", "agents"] as const) {
      const result = await runner.beforeCommand(domain, "validate");
      expect(result.ok).toBe(true);
      expect(result.messages.some((m) => m.includes(`Pre-flight check: ${domain} validate`))).toBe(true);
    }

    await runner.deactivate();
  });

  test("beforeCommand does NOT fire for non-targeted domains", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    // calyx-ext-polli targets skills, tools, agents — NOT config, knowledge, exec
    for (const domain of ["config", "knowledge", "exec"] as const) {
      const result = await runner.beforeCommand(domain, "validate");
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(0);
    }

    await runner.deactivate();
  });

  test("afterCommand reports non-zero exit through runner", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    const result = await runner.afterCommand("skills", "deploy", 1);
    expect(result.ok).toBe(true);
    expect(result.messages.some((m) => m.includes("exited with code 1"))).toBe(true);

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
