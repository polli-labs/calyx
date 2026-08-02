import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_INFO_FILENAME = ".build-info.json";
const BUILD_INFO_SCHEMA_VERSION = "build-info/v1";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repoRoot, "packages");
const builtAt = new Date().toISOString();
const gitHead = git(["rev-parse", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;

for (const packageDir of listPackageDirs(packagesRoot)) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== "string" || packageVersion.trim().length === 0) {
    throw new Error(`Package ${packageJsonPath} is missing a valid version field.`);
  }

  const distDir = path.join(packageDir, "dist");
  const stats = statSync(distDir, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) {
    throw new Error(`Expected ${distDir} to exist after build.`);
  }

  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    path.join(distDir, BUILD_INFO_FILENAME),
    `${JSON.stringify(
      {
        schema_version: BUILD_INFO_SCHEMA_VERSION,
        git_head: gitHead,
        built_at: builtAt,
        package_version: packageVersion,
        branch,
        dirty,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function listPackageDirs(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((candidate) => statSync(path.join(candidate, "package.json"), { throwIfNoEntry: false })?.isFile());
}
