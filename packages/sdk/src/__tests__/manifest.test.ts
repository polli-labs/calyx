import { describe, expect, test } from "vitest";
import { CALYX_DOMAINS, CALYX_SDK_API_VERSION, validateManifest } from "../index";

describe("validateManifest", () => {
  const validManifest = {
    name: "calyx-ext-hello",
    version: "1.0.0",
    calyx: {
      apiVersion: CALYX_SDK_API_VERSION,
      domains: ["skills"],
    },
  };

  test("accepts a valid manifest", () => {
    const result = validateManifest(validManifest);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test("accepts manifest with multiple domains", () => {
    const result = validateManifest({
      ...validManifest,
      calyx: { apiVersion: "1", domains: ["skills", "tools", "agents"] },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null input", () => {
    const result = validateManifest(null);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("MANIFEST_NOT_OBJECT");
  });

  test("rejects non-object input", () => {
    const result = validateManifest("string");
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("MANIFEST_NOT_OBJECT");
  });

  test("rejects missing name", () => {
    const result = validateManifest({ ...validManifest, name: "" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_NAME")).toBe(true);
  });

  test("rejects missing version", () => {
    const result = validateManifest({ ...validManifest, version: undefined });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_VERSION")).toBe(true);
  });

  test("rejects missing calyx object", () => {
    const result = validateManifest({ name: "ext", version: "1.0.0" });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_CALYX")).toBe(true);
  });

  test("rejects missing apiVersion", () => {
    const result = validateManifest({
      ...validManifest,
      calyx: { apiVersion: "", domains: ["skills"] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_API_VERSION")).toBe(true);
  });

  test("rejects empty domains array", () => {
    const result = validateManifest({
      ...validManifest,
      calyx: { apiVersion: "1", domains: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "MISSING_DOMAINS")).toBe(true);
  });

  test("rejects unknown domain", () => {
    const result = validateManifest({
      ...validManifest,
      calyx: { apiVersion: "1", domains: ["skills", "bogus"] },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "INVALID_DOMAIN")).toBe(true);
  });
});

describe("CALYX_DOMAINS", () => {
  test("contains all 8 domains", () => {
    expect(CALYX_DOMAINS).toHaveLength(8);
    expect(CALYX_DOMAINS).toContain("config");
    expect(CALYX_DOMAINS).toContain("instructions");
    expect(CALYX_DOMAINS).toContain("skills");
    expect(CALYX_DOMAINS).toContain("tools");
    expect(CALYX_DOMAINS).toContain("prompts");
    expect(CALYX_DOMAINS).toContain("agents");
    expect(CALYX_DOMAINS).toContain("knowledge");
    expect(CALYX_DOMAINS).toContain("exec");
  });
});

describe("CALYX_SDK_API_VERSION", () => {
  test("is a non-empty string", () => {
    expect(typeof CALYX_SDK_API_VERSION).toBe("string");
    expect(CALYX_SDK_API_VERSION.length).toBeGreaterThan(0);
  });
});
