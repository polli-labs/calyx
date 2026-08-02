import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repoRoot, "packages/client");
const temporaryRoot = await mkdtemp(join(tmpdir(), "calyx-client-package-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactFiles(actual, expected, label) {
  const actualList = [...actual].sort();
  const expectedList = [...expected].sort();
  assert(
    JSON.stringify(actualList) === JSON.stringify(expectedList),
    `${label} inventory drifted. Expected ${expectedList.join(", ")}; received ${actualList.join(", ")}.`,
  );
}

async function reachablePackageFiles(packageJson) {
  const files = new Set(["README.md", "package.json", "dist/.build-info.json"]);
  const queue = [];
  for (const target of Object.values(packageJson.exports)) {
    for (const path of [target.import, target.types]) {
      assert(typeof path === "string" && path.startsWith("./dist/"), `Client export points outside dist: ${path}`);
      queue.push(path.slice(2));
    }
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (files.has(current)) continue;
    files.add(current);
    const source = await readFile(join(packageRoot, current), "utf8");
    const localSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\/[^"']+)["']/gu;
    for (const match of source.matchAll(localSpecifier)) {
      const specifier = match[1];
      const resolvedSpecifier = current.endsWith(".d.ts") && specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.d.ts`
        : specifier;
      queue.push(join(dirname(current), resolvedSpecifier));
    }
  }
  return files;
}

try {
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const expectedFiles = await reachablePackageFiles(packageJson);
  const dryRun = await exec("pnpm", ["pack", "--dry-run", "--json"], { cwd: packageRoot });
  const report = JSON.parse(dryRun.stdout);
  const dryFiles = report.files.map((entry) => entry.path).sort();
  assertExactFiles(dryFiles, expectedFiles, "Packed client dry-run");

  await exec("pnpm", ["pack", "--pack-destination", temporaryRoot], { cwd: packageRoot });
  const tarballs = (await readdir(temporaryRoot)).filter((name) => name.endsWith(".tgz"));
  assert(tarballs.length === 1, `Expected one client tarball, found ${tarballs.length}.`);
  const tarball = join(temporaryRoot, tarballs[0]);
  const tarList = await exec("tar", ["-tzf", tarball]);
  const archivedFiles = tarList.stdout.trim().split("\n").map((path) => path.replace(/^package\//u, "")).sort();
  assertExactFiles(archivedFiles, expectedFiles, "Packed client tarball");

  const fixtureRoot = join(temporaryRoot, "fixture");
  await writeFile(join(temporaryRoot, "fixture-package.json"), JSON.stringify({
    name: "calyx-client-packed-fixture",
    private: true,
    type: "module",
    dependencies: { "@polli-labs/calyx-client": `file:${tarball}` },
  }));
  await mkdir(fixtureRoot);
  await copyFile(join(temporaryRoot, "fixture-package.json"), join(fixtureRoot, "package.json"));
  // `--prefer-offline`, not `--offline`. This fixture installs the packed
  // tarball outside the workspace, so it resolves the client's own runtime
  // dependencies rather than reusing the workspace lockfile. `--offline`
  // additionally requires every one of those to already be in the local pnpm
  // *metadata* mirror — which a developer machine has from months of installs
  // and a fresh runner does not, because `--frozen-lockfile` resolves from the
  // lockfile and never populates it. That made this check pass locally and fail
  // on CI with ERR_PNPM_NO_OFFLINE_META. Prefer the cache, fall back to the
  // registry only for metadata that is genuinely absent.
  await exec("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], { cwd: fixtureRoot });

  const fixtureScript = `
    import assert from "node:assert/strict";
    const root = await import("@polli-labs/calyx-client");
    const consumer = await import("@polli-labs/calyx-client/consumer");
    const admin = await import("@polli-labs/calyx-client/admin");
    const assertDeepFrozenRouteTree = (value, label) => {
      assert.equal(Object.isFrozen(value), true, label + " must be frozen");
      for (const [name, child] of Object.entries(value)) {
        if ((typeof child === "object" && child !== null) || typeof child === "function") {
          assertDeepFrozenRouteTree(child, label + "." + name);
        }
      }
    };
    assert.equal(typeof root.createCalyxClient, "function");
    assert.equal(typeof root.CalyxClientConfigurationError, "function");
    assert.equal("bufferVerifiedBinary" in root, false);
    assert.equal(typeof consumer.createCalyxClient, "function");
    assert.equal(typeof consumer.CalyxClientConfigurationError, "function");
    assert.equal("bufferVerifiedBinary" in consumer, false);
    assert.equal(typeof admin.createCalyxAdminClient, "function");
    assert.equal(typeof admin.bufferVerifiedBinary, "function");
    assertDeepFrozenRouteTree(consumer.consumerOperationRoutes, "consumerOperationRoutes");
    assertDeepFrozenRouteTree(admin.adminOperationRoutes, "adminOperationRoutes");
    assert.throws(() => {
      admin.adminOperationRoutes.selfUpgrade.receipt = () => "/mutated";
    }, TypeError);
    assert.throws(() => {
      admin.adminOperationRoutes.selfUpgrade = {};
    }, TypeError);
    assert.equal(
      admin.adminOperationRoutes.selfUpgrade.receipt({ operationId: "self-upgrade.receipt-01" }),
      "/v1/admin/self-upgrade-receipts/self-upgrade%2Ereceipt-01",
    );
    for (const subpath of ["internal", "generated/consumer/openapi", "transport"]) {
      try {
        await import("@polli-labs/calyx-client/" + subpath);
        assert.fail("Unexpected public client subpath: " + subpath);
      } catch (error) {
        assert.equal(error.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
      }
    }
  `;
  const fixturePath = join(fixtureRoot, "verify.mjs");
  await writeFile(fixturePath, fixtureScript);
  await exec(process.execPath, [fixturePath], { cwd: fixtureRoot });

  assert(Object.keys(packageJson.exports).sort().join(",") === ".,./admin,./consumer", "Client export map drifted.");
  const rootTypes = await readFile(join(packageRoot, "dist/index.d.ts"), "utf8");
  const consumerTypes = await readFile(join(packageRoot, "dist/consumer.d.ts"), "utf8");
  assert(!/AdminClient|createCalyxAdminClient/u.test(`${rootTypes}\n${consumerTypes}`), "Consumer types leak the admin surface.");
  process.stdout.write(`calyx-client packed fixture OK (${dryFiles.length} files; ${tarballs[0]})\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
