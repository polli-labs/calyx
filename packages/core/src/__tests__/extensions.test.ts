import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  readExtensionManifest,
  checkApiVersionCompatibility,
  discoverExtensions,
  loadExtension,
  ExtensionRunner,
} from "../extensions";
import type { CalyxExtensionManifest, CalyxExtension } from "@polli-labs/calyx-sdk";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/extensions");

// ── readExtensionManifest ───────────────────────────────────────────

describe("readExtensionManifest", () => {
  test("reads a valid manifest", async () => {
    const result = await readExtensionManifest(join(FIXTURES, "valid-ext"));
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.name).toBe("calyx-ext-valid");
    expect(result.manifest?.calyx.apiVersion).toBe("1");
    expect(result.manifest?.calyx.domains).toEqual(["skills"]);
    expect(result.diagnostics).toHaveLength(0);
  });

  test("returns diagnostics for missing package.json", async () => {
    const result = await readExtensionManifest("/tmp/nonexistent-dir");
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === "MANIFEST_READ_FAILED")).toBe(true);
  });

  test("returns diagnostics for invalid manifest (empty name)", async () => {
    const result = await readExtensionManifest(join(FIXTURES, "invalid-manifest-ext"));
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === "MISSING_NAME")).toBe(true);
  });

  test("does not produce a manifest when calyx key is missing", async () => {
    const result = await readExtensionManifest(join(FIXTURES, "missing-calyx-ext"));
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === "MISSING_CALYX")).toBe(true);
  });
});

// ── checkApiVersionCompatibility ────────────────────────────────────

describe("checkApiVersionCompatibility", () => {
  test("returns no diagnostics for matching API version", () => {
    const manifest: CalyxExtensionManifest = {
      name: "test-ext",
      version: "1.0.0",
      calyx: { apiVersion: "1", domains: ["skills"] },
    };
    const diags = checkApiVersionCompatibility(manifest);
    expect(diags).toHaveLength(0);
  });

  test("returns error diagnostic for mismatched API version", () => {
    const manifest: CalyxExtensionManifest = {
      name: "test-ext",
      version: "1.0.0",
      calyx: { apiVersion: "99", domains: ["skills"] },
    };
    const diags = checkApiVersionCompatibility(manifest);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.code).toBe("API_VERSION_MISMATCH");
    expect(diags[0]?.severity).toBe("error");
  });
});

// ── loadExtension ───────────────────────────────────────────────────

describe("loadExtension", () => {
  test("loads a valid extension", async () => {
    const result = await loadExtension(join(FIXTURES, "valid-ext"));
    expect(result.ok).toBe(true);
    expect(result.manifest?.name).toBe("calyx-ext-valid");
    expect(result.extension).toBeDefined();
    expect(result.extension?.hooks?.activate).toBeDefined();
  });

  test("fails for bad API version", async () => {
    const result = await loadExtension(join(FIXTURES, "bad-api-version-ext"));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "API_VERSION_MISMATCH")).toBe(true);
  });

  test("fails for invalid manifest", async () => {
    const result = await loadExtension(join(FIXTURES, "invalid-manifest-ext"));
    expect(result.ok).toBe(false);
  });

  test("fails for nonexistent directory", async () => {
    const result = await loadExtension("/tmp/does-not-exist-ext");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "MANIFEST_READ_FAILED")).toBe(true);
  });
});

// ── discoverExtensions ──────────────────────────────────────────────

describe("discoverExtensions", () => {
  test("discovers valid extensions from a search path", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    // valid-ext and another-valid-ext should load; others should fail or be skipped
    const loadedNames = result.loaded.map((r) => r.manifest?.name).sort();
    expect(loadedNames).toContain("calyx-ext-valid");
    expect(loadedNames).toContain("calyx-ext-another");
    expect(result.loaded.length).toBe(2);
  });

  test("reports failed extensions", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    // bad-api-version-ext and invalid-manifest-ext should be in failed
    // missing-calyx-ext is skipped (no calyx key → not detected as extension)
    expect(result.failed.length).toBeGreaterThanOrEqual(1);
  });

  test("detects domain conflicts", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    // Both valid-ext and another-valid-ext claim "skills"
    expect(result.conflicts["skills"]).toBeDefined();
    expect(result.conflicts["skills"]?.length).toBe(2);
  });

  test("handles unreadable search paths gracefully", async () => {
    const result = await discoverExtensions({
      searchPaths: ["/tmp/nonexistent-search-path-xyz"],
    });
    expect(result.loaded).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === "SEARCH_PATH_UNREADABLE")).toBe(true);
  });

  test("returns deterministic order (alphabetical by directory name)", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    const names = result.loaded.map((r) => r.manifest?.name);
    // another-valid-ext comes before valid-ext alphabetically
    expect(names[0]).toBe("calyx-ext-another");
    expect(names[1]).toBe("calyx-ext-valid");
  });

  test("advisory mode produces warning-severity conflict diagnostics", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
      strict: false,
    });
    const conflictDiags = result.diagnostics.filter((d) => d.code === "DOMAIN_CONFLICT");
    expect(conflictDiags.length).toBeGreaterThanOrEqual(1);
    for (const d of conflictDiags) {
      expect(d.severity).toBe("warning");
      expect(d.message).toContain("advisory");
      expect(d.message).toContain("--strict");
    }
  });

  test("strict mode produces error-severity conflict diagnostics", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
      strict: true,
    });
    const conflictDiags = result.diagnostics.filter((d) => d.code === "DOMAIN_CONFLICT");
    expect(conflictDiags.length).toBeGreaterThanOrEqual(1);
    for (const d of conflictDiags) {
      expect(d.severity).toBe("error");
      expect(d.message).toContain("strict mode");
      expect(d.message).toContain("Remove or reconfigure");
    }
  });

  test("conflict diagnostics list all claiming extension names", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    // Both valid-ext and another-valid-ext claim "skills"
    const skillsConflict = result.diagnostics.find(
      (d) => d.code === "DOMAIN_CONFLICT" && d.message.includes('"skills"')
    );
    expect(skillsConflict).toBeDefined();
    expect(skillsConflict!.message).toContain("calyx-ext-another");
    expect(skillsConflict!.message).toContain("calyx-ext-valid");
  });

  test("no conflicts reported for domains with single owner", async () => {
    const result = await discoverExtensions({
      searchPaths: [FIXTURES],
    });
    // "tools" is only claimed by another-valid-ext
    expect(result.conflicts["tools"]).toBeUndefined();
  });
});

// ── ExtensionRunner ─────────────────────────────────────────────────

describe("ExtensionRunner", () => {
  function makeExtension(name: string, domains: string[], hooks?: Partial<CalyxExtension["hooks"]>): CalyxExtension {
    return {
      manifest: {
        name,
        version: "1.0.0",
        calyx: { apiVersion: "1", domains: domains as CalyxExtensionManifest["calyx"]["domains"] },
      },
      hooks: {
        async activate() { return { ok: true, messages: [`${name} activated`] }; },
        async beforeCommand(_ctx, domain, command) { return { ok: true, messages: [`${name} before ${domain} ${command}`] }; },
        async afterCommand(_ctx, domain, command, exitCode) { return { ok: true, messages: [`${name} after ${domain} ${command} exit=${exitCode}`] }; },
        async deactivate() { return { ok: true, messages: [`${name} deactivated`] }; },
        ...hooks,
      },
    };
  }

  const runnerOpts = { workspaceRoot: "/tmp/test", calyxVersion: "0.1.1" };

  test("reports count and isActivated", async () => {
    const runner = new ExtensionRunner(
      [makeExtension("ext-a", ["skills"]), makeExtension("ext-b", ["tools"])],
      runnerOpts
    );
    expect(runner.count).toBe(2);
    expect(runner.isActivated).toBe(false);
    await runner.activate();
    expect(runner.isActivated).toBe(true);
  });

  test("activates all extensions", async () => {
    const runner = new ExtensionRunner(
      [makeExtension("ext-a", ["skills"]), makeExtension("ext-b", ["tools"])],
      runnerOpts
    );
    const result = await runner.activate();
    expect(result.ok).toBe(true);
    expect(result.messages).toContain("[ext-a] ext-a activated");
    expect(result.messages).toContain("[ext-b] ext-b activated");
  });

  test("runs beforeCommand hooks in alphabetical order", async () => {
    const order: string[] = [];
    const runner = new ExtensionRunner(
      [
        makeExtension("ext-z", ["skills"], {
          async beforeCommand() { order.push("z"); return { ok: true }; },
        }),
        makeExtension("ext-a", ["skills"], {
          async beforeCommand() { order.push("a"); return { ok: true }; },
        }),
      ],
      runnerOpts
    );
    await runner.beforeCommand("skills", "index");
    expect(order).toEqual(["a", "z"]);
  });

  test("beforeCommand blocks when extension returns ok=false", async () => {
    const runner = new ExtensionRunner(
      [
        makeExtension("ext-blocker", ["skills"], {
          async beforeCommand() { return { ok: false, messages: ["blocked!"] }; },
        }),
      ],
      runnerOpts
    );
    const result = await runner.beforeCommand("skills", "sync");
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe("ext-blocker");
  });

  test("beforeCommand skips extensions not targeting the domain", async () => {
    const called: string[] = [];
    const runner = new ExtensionRunner(
      [
        makeExtension("ext-skills", ["skills"], {
          async beforeCommand() { called.push("skills"); return { ok: true }; },
        }),
        makeExtension("ext-tools", ["tools"], {
          async beforeCommand() { called.push("tools"); return { ok: true }; },
        }),
      ],
      runnerOpts
    );
    await runner.beforeCommand("skills", "index");
    expect(called).toEqual(["skills"]);
  });

  test("afterCommand collects results from all relevant extensions", async () => {
    const runner = new ExtensionRunner(
      [makeExtension("ext-a", ["skills"]), makeExtension("ext-b", ["skills"])],
      runnerOpts
    );
    const result = await runner.afterCommand("skills", "sync", 0);
    expect(result.ok).toBe(true);
    expect(result.messages).toContain("[ext-a] ext-a after skills sync exit=0");
    expect(result.messages).toContain("[ext-b] ext-b after skills sync exit=0");
  });

  test("deactivate runs all extensions", async () => {
    const runner = new ExtensionRunner(
      [makeExtension("ext-a", ["skills"])],
      runnerOpts
    );
    await runner.activate();
    const result = await runner.deactivate();
    expect(result.ok).toBe(true);
    expect(result.messages).toContain("[ext-a] ext-a deactivated");
    expect(runner.isActivated).toBe(false);
  });

  test("handles hooks that throw", async () => {
    const runner = new ExtensionRunner(
      [makeExtension("ext-throw", ["skills"], {
        async activate() { throw new Error("boom"); },
      })],
      runnerOpts
    );
    const result = await runner.activate();
    expect(result.ok).toBe(false);
    expect(result.messages.some((m) => m.includes("boom"))).toBe(true);
  });

  test("works with zero extensions", async () => {
    const runner = new ExtensionRunner([], runnerOpts);
    expect(runner.count).toBe(0);
    const activateResult = await runner.activate();
    expect(activateResult.ok).toBe(true);
    const beforeResult = await runner.beforeCommand("skills", "index");
    expect(beforeResult.ok).toBe(true);
  });
});
