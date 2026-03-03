import { describe, expect, test } from "vitest";
import { validateManifest } from "@polli-labs/calyx-sdk";
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
