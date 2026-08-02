#!/usr/bin/env node
/* global process, console */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { allPackages } from "./lib/workspace.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

// Phase order is the contract. `build` runs first and exactly once, so every
// later phase reads a complete workspace closure derived from the pnpm
// dependency graph rather than residual `dist/` left by an earlier run. Both
// `typecheck` and `test` resolve `@polli-labs/calyx-client/admin` through its
// published `dist/` exports, so neither is meaningful before `build`.
const PHASES = ["build", "lint", "typecheck", "test", "client:package-check", "contract:check"];

const cold = process.argv.includes("--cold");
if (cold) {
  const removed = removeBuildOutputs();
  console.log(`[verify] --cold removed ${removed} build output director${removed === 1 ? "y" : "ies"}`);
}

const buildable = countBuildablePackages();
const results = [];

for (const phase of PHASES) {
  console.log(`\n[verify] ${phase}`);
  const startedAt = process.hrtime.bigint();
  const outcome = spawnSync("pnpm", [phase], { cwd: repoRoot, stdio: "inherit" });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const status = outcome.error ? 1 : (outcome.status ?? 1);
  if (outcome.error) console.error(`[verify] failed to spawn pnpm ${phase}: ${outcome.error.message}`);
  results.push({ phase, elapsedMs, status });
  if (status !== 0) break;
}

const failed = results.find((entry) => entry.status !== 0);
printSummary(results, failed, buildable);
process.exit(failed ? failed.status : 0);

function printSummary(entries, failure, packageBuilds) {
  const width = Math.max(...entries.map((entry) => entry.phase.length), 5);
  const total = entries.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  console.log("\n[verify] phase summary");
  for (const entry of entries) {
    const seconds = (entry.elapsedMs / 1000).toFixed(1).padStart(7);
    console.log(`  ${entry.phase.padEnd(width)}  ${seconds}s  ${entry.status === 0 ? "ok" : `FAILED (exit ${entry.status})`}`);
  }
  console.log(`  ${"total".padEnd(width)}  ${(total / 1000).toFixed(1).padStart(7)}s`);
  console.log(`  workspace package builds: ${packageBuilds} (one build phase)`);
  if (failure) {
    const skipped = PHASES.slice(PHASES.indexOf(failure.phase) + 1);
    console.log(`[verify] stopped at ${failure.phase}; not run: ${skipped.join(", ") || "(none)"}`);
  }
}

// `--cold` clears every workspace package, not just the ones `pnpm build`
// rebuilds: the claim it makes is that no phase reused a warm tree, and a
// directory listing of `packages/` cannot make that claim about `examples/*`.
function removeBuildOutputs() {
  let removed = 0;
  for (const workspacePackage of allPackages(repoRoot)) {
    const distDir = path.join(workspacePackage.directory, "dist");
    if (!existsSync(distDir)) continue;
    rmSync(distDir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// Mirrors what `pnpm build` filters to, so the summary count cannot claim
// builds the build phase never ran.
function countBuildablePackages() {
  return allPackages(repoRoot).filter((workspacePackage) =>
    workspacePackage.relativePath.startsWith("packages/")
    && typeof workspacePackage.manifest.scripts?.build === "string").length;
}
