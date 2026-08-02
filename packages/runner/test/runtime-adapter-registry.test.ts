import { describe, expect, test } from "vitest";
import {
  createRuntimeAdapterRegistry,
  type BackendAdapter,
  type AdapterResult,
  type AdapterSpawnOptions,
} from "@polli-labs/calyx-runner";

function createMockAdapter(name: string): BackendAdapter {
  return {
    name,
    capabilities: {
      streaming: false,
      turnControl: false,
      resumeSession: false,
      forkSession: false,
      approvals: "none",
    },
    async spawn(_opts: AdapterSpawnOptions): Promise<AdapterResult> {
      return {
        exit_code: 0,
        stderr: "",
        events: [],
        duration_ms: 1,
      };
    },
    async stop(): Promise<void> {},
  };
}

describe("RuntimeAdapterRegistry", () => {
  test("registers and creates adapters explicitly", () => {
    const registry = createRuntimeAdapterRegistry();
    registry.register("mock", () => createMockAdapter("mock"));

    const adapter = registry.create("mock");

    expect(adapter.name).toBe("mock");
    expect(registry.has("mock")).toBe(true);
    expect(registry.list()).toEqual(["mock"]);
  });

  test("throws for unsupported backends", () => {
    const registry = createRuntimeAdapterRegistry();
    expect(() => registry.create("missing")).toThrow('Unsupported backend "missing"');
  });
});
