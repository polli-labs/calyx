import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { renderInstructionsFromFiles, verifyInstructionsFromFiles } from "../instructions";

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/instructions");
}

describe("instructions domain", () => {
  test("renders deterministic output for a single host", async () => {
    const root = fixtureRoot();
    const result = await renderInstructionsFromFiles(
      {
        fleetPath: path.join(root, "inputs/fleet.v1.yaml"),
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath: path.join(root, "templates/AGENTS.sample.md.mustache"),
        partialsDir: path.join(root, "templates/partials")
      },
      { host: "blade" }
    );

    const expected = await readFile(path.join(root, "expected/blade.instructions.md"), "utf8");
    expect(result.results).toHaveLength(1);
    const firstResult = result.results[0];
    expect(firstResult).toBeDefined();
    if (!firstResult) {
      return;
    }
    expect(firstResult.output).toBe(expected);
    expect(firstResult.missingPartials).toEqual([]);
    expect(firstResult.unresolvedTokens).toEqual([]);
  });

  test("renders all hosts and writes output files", async () => {
    const root = fixtureRoot();
    const outDir = await mkdtemp(path.join(os.tmpdir(), "calyx-instructions-out-"));

    const result = await renderInstructionsFromFiles(
      {
        fleetPath: path.join(root, "inputs/fleet.v1.yaml"),
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath: path.join(root, "templates/AGENTS.sample.md.mustache"),
        partialsDir: path.join(root, "templates/partials")
      },
      { all: true, outputDir: outDir }
    );

    expect(result.results.map((entry) => entry.host)).toEqual(["blade", "worm"]);
    await expect(readFile(path.join(outDir, "blade.instructions.md"), "utf8")).resolves.toContain("Host alias is blade");
    await expect(readFile(path.join(outDir, "worm.instructions.md"), "utf8")).resolves.toContain("Host alias is worm");
  });

  test("verify passes when expected fixtures match", async () => {
    const root = fixtureRoot();
    const verified = await verifyInstructionsFromFiles(
      {
        fleetPath: path.join(root, "inputs/fleet.v1.yaml"),
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath: path.join(root, "templates/AGENTS.sample.md.mustache"),
        partialsDir: path.join(root, "templates/partials")
      },
      {
        all: true,
        expectedDir: path.join(root, "expected")
      }
    );

    expect(verified.ok).toBe(true);
    expect(verified.drifts).toEqual([]);
  });

  test("verify reports drift when expected outputs change", async () => {
    const root = fixtureRoot();
    const verified = await verifyInstructionsFromFiles(
      {
        fleetPath: path.join(root, "inputs/fleet.v1.yaml"),
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath: path.join(root, "templates/AGENTS.sample.md.mustache"),
        partialsDir: path.join(root, "templates/partials")
      },
      {
        all: true,
        expectedDir: path.join(root, "expected-drift")
      }
    );

    expect(verified.ok).toBe(false);
    expect(verified.drifts.some((entry) => entry.host === "worm" && entry.reason.includes("line"))).toBe(true);
  });

  test("tracks missing partials and unresolved tokens", async () => {
    const root = fixtureRoot();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "calyx-instructions-missing-"));
    const templatePath = path.join(tempRoot, "template.md.mustache");
    const partialsDir = path.join(tempRoot, "partials");
    await writeFile(templatePath, "{{> missing}} {{UNSET}}", "utf8");

    const result = await renderInstructionsFromFiles(
      {
        fleetPath: path.join(root, "inputs/fleet.v1.yaml"),
        hostsDir: path.join(root, "inputs/hosts"),
        templatePath,
        partialsDir
      },
      {
        host: "blade"
      }
    );

    const firstResult = result.results[0];
    expect(firstResult).toBeDefined();
    if (!firstResult) {
      return;
    }
    expect(firstResult.missingPartials).toEqual(["missing"]);
    expect(firstResult.unresolvedTokens).toEqual(["UNSET"]);
  });
});
