import { describe, expect, test } from "vitest";
import { validateManifest } from "@polli-labs/calyx-sdk";
import { ExtensionRunner } from "@polli-labs/calyx-core";
import extension from "../index";

describe("calyx-ext-linear", () => {
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

  test("manifest targets agents and exec domains", () => {
    expect(extension.manifest.calyx.domains).toEqual(["agents", "exec"]);
  });

  test("manifest uses apiVersion 1", () => {
    expect(extension.manifest.calyx.apiVersion).toBe("1");
  });

  test("activate hook returns ok with messages", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.activate!(ctx);
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes("Linear extension activated"))).toBe(true);
  });

  test("beforeCommand returns ok for issue-context commands", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "exec", "launch");
    expect(result.ok).toBe(true);
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes("Linear context check"))).toBe(true);
  });

  test("beforeCommand is silent for non-issue-context commands", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "exec", "validate");
    expect(result.ok).toBe(true);
    expect(result.messages).toBeUndefined();
  });

  test("afterCommand reports non-zero exit with Linear hint", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "exec", "launch", 1);
    expect(result.ok).toBe(true);
    expect(result.messages!.some((m) => m.includes("failed (exit 1)"))).toBe(true);
    expect(result.messages!.some((m) => m.includes("Linear"))).toBe(true);
  });

  test("afterCommand is silent for zero exit", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "agents", "deploy", 0);
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
    expect(result.messages!.some((m) => m.includes("Linear extension deactivated"))).toBe(true);
  });
});

describe("calyx-ext-linear via ExtensionRunner (integration)", () => {
  test("full lifecycle: activate → beforeCommand → afterCommand → deactivate for exec launch", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });

    const activate = await runner.activate();
    expect(activate.ok).toBe(true);
    expect(activate.messages.some((m) => m.includes("Linear extension activated"))).toBe(true);

    const before = await runner.beforeCommand("exec", "launch");
    expect(before.ok).toBe(true);
    expect(before.messages.some((m) => m.includes("Linear context check: exec launch"))).toBe(true);

    const after = await runner.afterCommand("exec", "launch", 0);
    expect(after.ok).toBe(true);

    const deactivate = await runner.deactivate();
    expect(deactivate.ok).toBe(true);
    expect(deactivate.messages.some((m) => m.includes("Linear extension deactivated"))).toBe(true);
  });

  test("beforeCommand fires for both targeted domains (agents, exec)", async () => {
    const runner = new ExtensionRunner([extension], {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
    });
    await runner.activate();

    for (const domain of ["agents", "exec"] as const) {
      const result = await runner.beforeCommand(domain, "deploy");
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

    for (const domain of ["skills", "tools", "config", "knowledge"] as const) {
      const result = await runner.beforeCommand(domain, "launch");
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

    const result = await runner.afterCommand("exec", "launch", 1);
    expect(result.ok).toBe(true);
    expect(result.messages.some((m) => m.includes("failed (exit 1)"))).toBe(true);

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
