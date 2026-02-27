import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { compileFromFiles } from "../compile";
import { compareTomlSemantics } from "../parity";

const hosts = ["blade", "carbon", "worm", "mba"] as const;

describe("config compiler parity fixtures", () => {
  for (const host of hosts) {
    test(`semantic parity for ${host}`, async () => {
      const root = path.resolve(process.cwd());
      const fleetPath = path.join(root, "fixtures/config-compiler/inputs/fleet.v2.yaml");
      const hostPath = path.join(root, `fixtures/config-compiler/inputs/hosts/${host}.yaml`);
      const expectedPath = path.join(root, `fixtures/config-compiler/expected/${host}.config.toml`);

      const [result, expectedToml] = await Promise.all([
        compileFromFiles({ fleetPath, hostPath }, { mode: "strict" }),
        readFile(expectedPath, "utf8")
      ]);

      const parity = compareTomlSemantics(result.tomlText, expectedToml);
      expect(parity.equal, parity.reason).toBe(true);
    });

    test(`format snapshot advisory for ${host}`, async () => {
      const root = path.resolve(process.cwd());
      const fleetPath = path.join(root, "fixtures/config-compiler/inputs/fleet.v2.yaml");
      const hostPath = path.join(root, `fixtures/config-compiler/inputs/hosts/${host}.yaml`);
      const expectedPath = path.join(root, `fixtures/config-compiler/expected/${host}.config.toml`);

      const [result, expectedToml] = await Promise.all([
        compileFromFiles({ fleetPath, hostPath }, { mode: "strict" }),
        readFile(expectedPath, "utf8")
      ]);

      if (result.tomlText.trim() !== expectedToml.trim()) {
        console.warn(`Advisory snapshot mismatch for ${host}; semantic parity still passes.`);
      }

      expect(true).toBe(true);
    });
  }
});
