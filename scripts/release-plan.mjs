#!/usr/bin/env node
/**
 * The tag release's publish plan, derived from the workspace.
 *
 * `release.yml` used to name four packages by hand. `@polli-labs/calyx` has
 * eight `workspace:*` runtime dependencies; pnpm rewrites each of them to a
 * concrete version on publish, so a plan that omits one produces a package that
 * installs into an `ERR_PNPM_FETCH_404` on someone else's machine, days later,
 * with nothing in the release logs to say why. That is the same shape that took
 * the fleet down on 2026-07-23: a hand-kept package list and a real dependency
 * graph, separated by a boundary no checker crossed.
 *
 * So the plan is not a list. Packages declare their own release channel in
 * their own `package.json` under `calyx.release`:
 *
 *   tagged  — an entry point a consumer installs by name. Publishing it means
 *             publishing its whole runtime closure.
 *   gated   — deliberately withheld from the tag release and published by its
 *             own named workflow. It still counts as satisfied closure, and
 *             `--gated-dependencies` lists the ones a release must already find
 *             on the registry.
 *
 * Everything else is published if and only if some entry point needs it at
 * runtime, which is the only reason to publish a package at all.
 *
 * Usage:
 *   node scripts/release-plan.mjs                       # publish, in order
 *   node scripts/release-plan.mjs --gated-dependencies  # must already exist
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { allPackages, runtimeClosure } from "./lib/workspace.mjs";

const CHANNELS = new Set(["tagged", "gated"]);
const repoRoot = path.resolve(import.meta.dirname, "..");

function releaseChannel(workspacePackage) {
  const declaration = workspacePackage.manifest.calyx?.release;
  if (declaration === undefined) return undefined;
  const { channel, workflow } = declaration;
  if (!CHANNELS.has(channel)) {
    throw new Error(
      `${workspacePackage.name} declares calyx.release.channel "${channel}"; expected one of ${[...CHANNELS].join(", ")}.`,
    );
  }
  if (channel === "gated") {
    if (typeof workflow !== "string" || !existsSync(path.join(repoRoot, workflow))) {
      throw new Error(
        `${workspacePackage.name} is gated out of the tag release but names no workflow that exists (${workflow}), so nothing publishes it.`,
      );
    }
  }
  return channel;
}

const packages = allPackages(repoRoot);
const entryPoints = packages.filter((workspacePackage) => releaseChannel(workspacePackage) === "tagged");
if (entryPoints.length === 0) {
  throw new Error('No package declares `"calyx": { "release": { "channel": "tagged" } }`, so the tag release would publish nothing.');
}

const closure = [];
for (const entryPoint of entryPoints) {
  for (const dependency of runtimeClosure(entryPoint.name, repoRoot)) {
    if (!closure.includes(dependency)) closure.push(dependency);
  }
}

const requested = process.argv.slice(2);
const unknownFlags = requested.filter((flag) => flag !== "--gated-dependencies");
if (unknownFlags.length > 0) throw new Error(`Unknown option(s): ${unknownFlags.join(", ")}.`);
const wantGated = requested.includes("--gated-dependencies");

const selected = closure.filter((workspacePackage) => (releaseChannel(workspacePackage) === "gated") === wantGated);
process.stdout.write(selected.map((workspacePackage) => workspacePackage.name).join("\n"));
if (selected.length > 0) process.stdout.write("\n");
