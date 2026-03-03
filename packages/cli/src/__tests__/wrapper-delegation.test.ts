import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveWrapperDelegation, buildProgram } from "../run-cli";
import { WRAPPER_REGISTRY } from "@polli-labs/calyx-core";

/**
 * Wrapper delegation tests (POL-679 R2).
 *
 * Validates that implemented wrappers perform real delegation to
 * canonical commands via argv rewriting — not advisory-only no-ops.
 */

afterEach(() => {
  delete process.env["CALYX_FAIL_ON_DEPRECATED"];
});

// ── resolveWrapperDelegation unit tests ──────────────────────────────

describe("resolveWrapperDelegation", () => {
  const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

  test("returns null for non-wrapper commands", () => {
    expect(resolveWrapperDelegation(["node", "calyx", "doctor"])).toBeNull();
    expect(resolveWrapperDelegation(["node", "calyx", "skills", "sync"])).toBeNull();
    expect(resolveWrapperDelegation(["node", "calyx", "config", "compile"])).toBeNull();
  });

  test("returns null for retired wrappers (handled by buildProgram)", () => {
    expect(resolveWrapperDelegation(["node", "calyx", "skills-sync"])).toBeNull();
  });

  test("returns null for deferred wrappers (handled by buildProgram)", () => {
    expect(resolveWrapperDelegation(["node", "calyx", "agents-fleet"])).toBeNull();
  });

  test("returns null for empty argv", () => {
    expect(resolveWrapperDelegation([])).toBeNull();
    expect(resolveWrapperDelegation(["node", "calyx"])).toBeNull();
  });

  test.each(implemented.map((d) => [d.wrapper, d.target]))(
    "rewrites %s to %s",
    (wrapper, target) => {
      const result = resolveWrapperDelegation(["node", "calyx", wrapper]);
      expect(result).not.toBeNull();

      const expectedParts = target.replace(/^calyx\s+/, "").split(/\s+/);
      expect(result!.slice(0, 2)).toEqual(["node", "calyx"]);
      expect(result!.slice(2)).toEqual(expectedParts);
    }
  );

  test("forwards trailing arguments after wrapper name", () => {
    const result = resolveWrapperDelegation([
      "node", "calyx", "agents-toolkit-doctor", "--json"
    ]);
    expect(result).toEqual(["node", "calyx", "doctor", "--json"]);
  });

  test("forwards multiple arguments including values", () => {
    const result = resolveWrapperDelegation([
      "node", "calyx", "agents-tools-bump", "--tool", "cass", "--to", "2.0.0"
    ]);
    expect(result).toEqual([
      "node", "calyx", "tools", "versions", "bump", "--tool", "cass", "--to", "2.0.0"
    ]);
  });

  test("forwards subcommand + args for multi-level targets", () => {
    const result = resolveWrapperDelegation([
      "node", "calyx", "docstore", "search", "--query", "hello"
    ]);
    // docstore → calyx knowledge docstore, forwarded: search --query hello
    expect(result).toEqual([
      "node", "calyx", "knowledge", "docstore", "search", "--query", "hello"
    ]);
  });

  test("forwards args for execplan-new wrapper", () => {
    const result = resolveWrapperDelegation([
      "node", "calyx", "execplan-new", "--title", "My Plan", "--issue-id", "POL-123", "--json"
    ]);
    expect(result).toEqual([
      "node", "calyx", "knowledge", "execplan", "new",
      "--title", "My Plan", "--issue-id", "POL-123", "--json"
    ]);
  });

  test("emits telemetry to stderr on delegation", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveWrapperDelegation(["node", "calyx", "agents-toolkit-doctor"]);

    // Should have: deprecation warning, telemetry JSON, delegation message
    expect(stderrSpy).toHaveBeenCalledTimes(3);
    expect(stderrSpy.mock.calls[0]![0]).toContain("[calyx][deprecated]");
    expect(stderrSpy.mock.calls[1]![0]).toContain("[calyx][telemetry]");
    expect(stderrSpy.mock.calls[2]![0]).toContain("delegates to");

    stderrSpy.mockRestore();
  });

  test("throws CliError when CALYX_FAIL_ON_DEPRECATED=1", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      resolveWrapperDelegation(["node", "calyx", "agents-toolkit-doctor"])
    ).toThrow("CALYX_FAIL_ON_DEPRECATED");

    stderrSpy.mockRestore();
  });

  test("guardrail error has exitCode 6", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      resolveWrapperDelegation(["node", "calyx", "agent-notify"]);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      expect((error as { exitCode?: number }).exitCode).toBe(6);
    }

    stderrSpy.mockRestore();
  });
});

// ── Integration: rewritten argv routes to canonical Commander command ─

describe("wrapper delegation integration", () => {
  test("rewritten argv for agents-toolkit-doctor resolves to doctor command", () => {
    const program = buildProgram();
    const argv = resolveWrapperDelegation(["node", "calyx", "agents-toolkit-doctor", "--json"]);
    expect(argv).not.toBeNull();

    // The rewritten argv should target the "doctor" command which exists in the program
    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
    expect(argv![2]).toBe("doctor");
  });

  test("rewritten argv for agents-fleet-smoke resolves to verify fleet", () => {
    const program = buildProgram();
    const argv = resolveWrapperDelegation(["node", "calyx", "agents-fleet-smoke", "--json"]);
    expect(argv).not.toBeNull();

    const verifyCmd = program.commands.find((c) => c.name() === "verify");
    expect(verifyCmd).toBeDefined();
    const fleetCmd = verifyCmd!.commands.find((c) => c.name() === "fleet");
    expect(fleetCmd).toBeDefined();
    expect(argv!.slice(2, 4)).toEqual(["verify", "fleet"]);
  });

  test("rewritten argv for agents-bundle-build resolves to bundle build", () => {
    const program = buildProgram();
    const argv = resolveWrapperDelegation([
      "node", "calyx", "agents-bundle-build", "--path", "/tmp/pkg"
    ]);
    expect(argv).not.toBeNull();

    const bundleCmd = program.commands.find((c) => c.name() === "bundle");
    expect(bundleCmd).toBeDefined();
    const buildCmd = bundleCmd!.commands.find((c) => c.name() === "build");
    expect(buildCmd).toBeDefined();
    expect(argv!.slice(2, 4)).toEqual(["bundle", "build"]);
    expect(argv!.slice(4)).toEqual(["--path", "/tmp/pkg"]);
  });

  test("every implemented wrapper target resolves to a real command in the program", () => {
    const program = buildProgram();
    const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

    for (const def of implemented) {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const argv = resolveWrapperDelegation(["node", "calyx", def.wrapper]);
      stderrSpy.mockRestore();

      expect(argv, `${def.wrapper} should produce rewritten argv`).not.toBeNull();

      // Walk the command tree to verify the target leaf command exists
      const parts = argv!.slice(2); // e.g. ['doctor'] or ['tools', 'versions', 'bump']
      const targetLeaf = parts[parts.length - 1];
      const parentParts = parts.slice(0, -1);
      let parent: typeof program | undefined = program;
      for (const part of parentParts) {
        parent = parent?.commands.find((c) => c.name() === part) as typeof program | undefined;
      }

      const leafCmd = parent?.commands.find((c) => c.name() === targetLeaf);
      expect(
        leafCmd,
        `target command "${def.target}" (leaf: "${targetLeaf}") not found for wrapper "${def.wrapper}"`
      ).toBeDefined();
    }
  });
});

// ── Regression: wrappers must NOT be no-op success ───────────────────

describe("wrapper delegation prevents no-op regression", () => {
  test("implemented wrapper action handler is superseded by runCli delegation", () => {
    // The buildProgram action handler for implemented wrappers is advisory-only.
    // Real delegation happens in runCli via resolveWrapperDelegation.
    // This test proves that resolveWrapperDelegation produces a non-null
    // result for every implemented wrapper — meaning runCli will always
    // route to the canonical command instead of the advisory action.
    const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");
    expect(implemented.length).toBe(9);

    for (const def of implemented) {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = resolveWrapperDelegation(["node", "calyx", def.wrapper, "--json"]);
      stderrSpy.mockRestore();

      expect(
        result,
        `wrapper "${def.wrapper}" must delegate (not no-op)`
      ).not.toBeNull();

      // argv[2] must be the canonical target's first segment, not the wrapper name
      const firstTargetSegment = def.target.replace(/^calyx\s+/, "").split(/\s+/)[0];
      expect(result![2]).toBe(firstTargetSegment);
    }
  });

  test("non-zero exit propagation: guardrail blocks all implemented wrappers in error mode", () => {
    process.env["CALYX_FAIL_ON_DEPRECATED"] = "1";
    const implemented = WRAPPER_REGISTRY.filter((d) => d.status === "implemented");

    for (const def of implemented) {
      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        resolveWrapperDelegation(["node", "calyx", def.wrapper]);
        expect.unreachable(`wrapper "${def.wrapper}" should have thrown`);
      } catch (error: unknown) {
        expect((error as { exitCode?: number }).exitCode).toBe(6);
      }
      stderrSpy.mockRestore();
    }
  });
});
