import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { allPackages, runtimeClosure, workspaceDependencies } from "../../../../scripts/lib/workspace.mjs";

/**
 * `scripts/lib/workspace.mjs` derives the workspace once; these tests hold each
 * consumer against it.
 *
 * Deriving is not enough on its own — the repo already derived the command list
 * correctly in `interface-manifest.test.ts` and it did not save `calyx doctor`,
 * because the deriver and the consumer were different processes on different
 * machines. What closes the gap is a check that reads the literal and the truth
 * in the same process and errors. That is what lives here: for the vitest alias
 * map, the release publish plan, the root TypeScript project graph, and the
 * fail-closed behaviour of the derivation itself.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd());
const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureWorkspace(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "calyx-workspace-derivation-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return root;
}

describe("workspace derivation", () => {
  test("every derived package is a real, installed directory", () => {
    const packages = allPackages();

    expect(packages.length).toBeGreaterThan(1);
    for (const workspacePackage of packages) {
      expect(existsSync(path.join(workspacePackage.directory, "package.json"))).toBe(true);
      expect(workspacePackage.relativePath).not.toContain("\\");
      expect(workspacePackage.manifest.name).toBe(workspacePackage.name);
    }
    expect([...new Set(packages.map((entry) => entry.name))]).toHaveLength(packages.length);
  });

  test("a runtime closure is dependency-first and self-contained", () => {
    const closure = runtimeClosure("@polli-labs/calyx");
    const positions = new Map(closure.map((entry, index) => [entry.name, index]));

    expect(closure.at(-1)?.name).toBe("@polli-labs/calyx");
    for (const workspacePackage of closure) {
      for (const dependency of workspaceDependencies(workspacePackage.manifest)) {
        const dependencyPosition = positions.get(dependency);
        expect(dependencyPosition, `${dependency} is missing from the closure that needs it`).toBeDefined();
        expect(dependencyPosition!).toBeLessThan(positions.get(workspacePackage.name)!);
      }
    }
  });

  test("a lockfile that disagrees with the workspace throws instead of shrinking the answer", async () => {
    const root = await fixtureWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n  packages/known:\n\n",
      "packages/known/package.json": '{ "name": "known" }',
      "packages/unregistered/package.json": '{ "name": "unregistered" }',
    });

    expect(() => allPackages(root)).toThrowError(/On disk but not in the lockfile: packages\/unregistered/u);
  });

  test("a workspace glob this reader cannot expand throws instead of returning fewer packages", async () => {
    const root = await fixtureWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      "pnpm-lock.yaml": "importers:\n\n  .:\n",
    });

    expect(() => allPackages(root)).toThrowError(/is not derivable here/u);
  });

  test("an unknown closure entry point throws", () => {
    expect(() => runtimeClosure("@polli-labs/calyx-imaginary")).toThrowError(/is not a workspace package/u);
  });
});

describe("vitest source aliases", () => {
  const artifactConsumed = allPackages()
    .filter((workspacePackage) => workspacePackage.manifest.calyx?.testResolution?.mode === "artifact");

  /**
   * The config cannot be imported here — it is a root `.ts` file outside every
   * package's `rootDir` — so this asserts the property that made the old map
   * dangerous rather than the map itself: that no package is named in it. A
   * name can only get back into `vitest.config.ts` by someone re-typing it, and
   * that is what fails. The complementary half is inside the config, where a
   * derived alias whose `src/index.ts` is missing throws at load time on every
   * single test run, which is stricter than any assertion out here.
   */
  test("the config names no package of its own", async () => {
    const config = await readFile(path.join(repoRoot, "vitest.config.ts"), "utf8");

    expect(config).toContain("allPackages()");
    for (const workspacePackage of allPackages()) {
      expect(config, `vitest.config.ts hard-codes ${workspacePackage.name} again`)
        .not.toContain(`"${workspacePackage.name}"`);
    }
  });

  /**
   * An artifact-resolved package opts out of source aliasing, so nothing here
   * can tell it apart from the accidental omission this derivation replaced
   * unless the opt-out is load-bearing, buildable, and earned. All three are
   * checked: something must import it by name (or the declaration is vestigial
   * and the package should just be aliased), the gate must have built the
   * artifact that import resolves to (or the suite is testing nothing at all),
   * and the package must declare an explicit release channel — testing the
   * artifact instead of the source is only worth its fidelity cost when that
   * artifact is a deliberate published contract rather than a by-product.
   */
  test("every artifact-resolved package is a built, imported, published contract", async () => {
    for (const workspacePackage of artifactConsumed) {
      const reason = workspacePackage.manifest.calyx?.testResolution?.reason;
      expect(typeof reason === "string" && reason.length > 80, `${workspacePackage.name} opts out with no stated reason`).toBe(true);
      expect(
        existsSync(path.join(workspacePackage.directory, "dist")),
        `${workspacePackage.name} is consumed as an artifact but the gate left no dist/ for the suite to resolve`,
      ).toBe(true);
      expect(
        workspacePackage.manifest.calyx?.release?.channel,
        `${workspacePackage.name} is tested through its artifact but declares no release channel, so nothing makes that artifact a contract`,
      ).toBeDefined();

      const importers: string[] = [];
      for (const candidate of allPackages()) {
        if (candidate.name === workspacePackage.name) continue;
        const sourceRoot = path.join(candidate.directory, "src");
        if (!existsSync(sourceRoot)) continue;
        for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
          const source = await readFile(path.join(entry.parentPath, entry.name), "utf8");
          if (source.includes(`from "${workspacePackage.name}`)) importers.push(entry.name);
        }
      }
      expect(
        importers.length,
        `nothing imports ${workspacePackage.name} by name, so its artifact opt-out is dead weight`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("release publish plan", () => {
  async function releasePlan(...args: readonly string[]): Promise<string[]> {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/release-plan.mjs", ...args], { cwd: repoRoot });
    return stdout.split("\n").filter((line) => line.length > 0);
  }

  test("the plan is exactly the runtime closure of the declared entry points, minus the gated ones", async () => {
    const packages = allPackages();
    const channelOf = (name: string): unknown =>
      packages.find((workspacePackage) => workspacePackage.name === name)?.manifest.calyx?.release?.channel;
    const expected: string[] = [];
    for (const entryPoint of packages.filter((workspacePackage) => channelOf(workspacePackage.name) === "tagged")) {
      for (const dependency of runtimeClosure(entryPoint.name)) {
        if (!expected.includes(dependency.name)) expected.push(dependency.name);
      }
    }

    expect(await releasePlan()).toEqual(expected.filter((name) => channelOf(name) !== "gated"));
    expect(await releasePlan("--gated-dependencies")).toEqual(expected.filter((name) => channelOf(name) === "gated"));
  });

  test("nothing the plan publishes can 404 on a consumer's install", async () => {
    const published = new Set(await releasePlan());
    const gated = new Set(await releasePlan("--gated-dependencies"));
    const byName = new Map(allPackages().map((workspacePackage) => [workspacePackage.name, workspacePackage]));

    for (const name of published) {
      for (const dependency of workspaceDependencies(byName.get(name)!.manifest)) {
        expect(
          published.has(dependency) || gated.has(dependency),
          `${name} is published but its runtime dependency ${dependency} is neither published nor gated`,
        ).toBe(true);
      }
    }
  });

  test("every gated package is published by the workflow it names", async () => {
    const gated = allPackages().filter((workspacePackage) => workspacePackage.manifest.calyx?.release?.channel === "gated");

    expect(gated.length).toBeGreaterThan(0);
    for (const workspacePackage of gated) {
      const workflow = workspacePackage.manifest.calyx?.release?.workflow as string;
      const contents = await readFile(path.join(repoRoot, workflow), "utf8");
      expect(contents, `${workflow} does not publish ${workspacePackage.name}`)
        .toContain(`--filter ${workspacePackage.name} publish`);
    }
  });

  test("the release workflow names no package of its own", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("scripts/release-plan.mjs");
    for (const workspacePackage of allPackages()) {
      expect(workflow, `release.yml hard-codes ${workspacePackage.name} again`)
        .not.toContain(`--filter ${workspacePackage.name}`);
    }
  });
});

describe("root TypeScript project graph", () => {
  test("references every packages/* workspace package and nothing else", async () => {
    const contents = await readFile(path.join(repoRoot, "tsconfig.json"), "utf8");
    const referenced = (JSON.parse(contents) as { references: readonly { path: string }[] }).references
      .map((reference) => reference.path);
    const expected = allPackages()
      .filter((workspacePackage) => workspacePackage.relativePath.startsWith("packages/"))
      .map((workspacePackage) => `./${workspacePackage.relativePath}`)
      .sort();

    expect(referenced).toEqual(expected);
    for (const reference of referenced) {
      expect(existsSync(path.join(repoRoot, reference, "tsconfig.json")), `${reference} has no tsconfig.json`).toBe(true);
    }
  });
});
