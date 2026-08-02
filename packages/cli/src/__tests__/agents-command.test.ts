import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

function fixtureRegistryPath(): string {
  return path.resolve(process.cwd(), "fixtures/domains/agents/AGENTS.json");
}

describe("agents command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("lists agent definitions from AGENTS.json", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "agents",
      "list",
      "--registry",
      fixtureRegistryPath(),
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      items: Array<{ id: string; description: string }>;
    };
    expect(payload.items).toEqual([
      expect.objectContaining({
        id: "fixture-reviewer",
        description: "Fixture reviewer used by POL-1799 launch tests.",
      }),
    ]);
  });

  test("includes blocked definitions only when explicitly requested", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "agents",
      "list",
      "--registry",
      fixtureRegistryPath(),
      "--include-blocked",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      items: Array<{ id: string; status: string; lifecycle?: { blocked_reason?: string } }>;
    };
    expect(payload.items).toContainEqual(expect.objectContaining({
      id: "fixture-blocked",
      status: "blocked",
      lifecycle: expect.objectContaining({
        blocked_reason: "Prerequisite safety receipts are incomplete.",
      }),
    }));
  });

  test("shows and validates agent definitions", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "agents",
      "show",
      "fixture-reviewer",
      "--registry",
      fixtureRegistryPath(),
      "--json",
    ]);
    const showPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      agent: { id: string; persona: { template: string } };
    };
    expect(showPayload.agent).toMatchObject({
      id: "fixture-reviewer",
      persona: { template: "prompt.md" },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "agents",
      "validate",
      "--registry",
      fixtureRegistryPath(),
      "--strict",
      "--json",
    ]);
    const validatePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      total: number;
    };
    expect(validatePayload).toMatchObject({ ok: true, total: 2, blocked: 1 });
  });

  test("old POL-534 verbs are tombstoned with a reroute message", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await expect(
      program.parseAsync(["node", "calyx", "agents", "sync", "--registry", fixtureRegistryPath()]),
    ).rejects.toThrow("retired by POL-1799");

    expect(err.mock.calls.map((call) => String(call[0])).join("\n")).toContain("calyx agents sync is retired by POL-1799");
  });
});
