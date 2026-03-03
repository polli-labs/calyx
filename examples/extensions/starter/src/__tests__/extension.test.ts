import { describe, expect, test } from "vitest";
import { validateManifest } from "@polli-labs/calyx-sdk";
import extension from "../index";

describe("calyx-ext-starter", () => {
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

  test("manifest uses apiVersion 1", () => {
    expect(extension.manifest.calyx.apiVersion).toBe("1");
  });

  test("manifest declares at least one domain", () => {
    expect(extension.manifest.calyx.domains.length).toBeGreaterThan(0);
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
  });

  test("beforeCommand hook returns ok", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.beforeCommand!(ctx, "skills", "index");
    expect(result.ok).toBe(true);
  });

  test("afterCommand hook returns ok", async () => {
    const ctx = {
      workspaceRoot: "/tmp/test",
      calyxVersion: "0.1.1",
      manifest: extension.manifest,
    };
    const result = await extension.hooks!.afterCommand!(ctx, "skills", "index", 0);
    expect(result.ok).toBe(true);
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
