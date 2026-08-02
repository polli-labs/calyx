import { availableParallelism } from "node:os";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { allPackages } from "./scripts/lib/workspace.mjs";

/**
 * Both bounds below were inherited from vitest's defaults rather than chosen,
 * and both were wrong for this suite.
 *
 * `maxWorkers` defaulted to `availableParallelism - 1` — 23 forks on a 24-core
 * fleet host. This suite is not CPU-bound work that benefits from that width:
 * 26 test files spawn real subprocesses, 89 call sites bind real loopback HTTP
 * servers, and ~240 replay the full 34-migration SQLite schema. Measured, the
 * pool was never converting that width into speed — one file
 * (`service.test.ts`) owns ~204s of a ~209s run, so effective parallelism was
 * already only ~5x. Narrowing 23 -> 6 cost +1.5% wall time and moved the
 * tightest test from 201ms below the timeout to 1698ms below it.
 *
 * `testTimeout` defaulted to 5000ms. That is not a correctness bound for a test
 * that legitimately applies 34 migrations and stands up real IPC; it measures
 * how loaded the machine is. It also cannot hold on CI hardware, which runs
 * 2-4x slower than a fleet host — tests taking 1.2-1.7s here crossed 5000ms on
 * a GitHub runner. Fifteen tests had already been annotated with 10s/15s/30s
 * escapes one at a time, which is this same change applied privately fifteen
 * times; one declared bound replaces all of them. It exists to catch a genuine
 * hang, not to police speed.
 */
const MAX_WORKERS = Math.min(6, Math.max(1, availableParallelism() - 1));

/**
 * Every workspace package resolves to its source entry unless its own manifest
 * says the suite must consume the built artifact instead
 * (`calyx.testResolution.mode === "artifact"`).
 *
 * This map used to be hand-written, and it was missing
 * `@polli-labs/calyx-client`. That is the worst way for it to be wrong: an
 * absent alias does not error, it silently falls back to the package's `dist/`,
 * so the suite passed on a warm tree and could not run at all on a cold one.
 * Deriving it means a new package is aliased the day it exists, and the only
 * way to opt out is a reasoned declaration in the opting-out package's own
 * manifest — colocated with the thing it describes, not invisible by absence
 * in a list over here.
 */
const sourceAliases = Object.fromEntries(allPackages()
  .filter((workspacePackage) => workspacePackage.manifest.calyx?.testResolution?.mode !== "artifact")
  .map((workspacePackage) => {
    const entry = resolve(import.meta.dirname, workspacePackage.relativePath, "src/index.ts");
    if (!existsSync(entry)) {
      throw new Error(
        `${workspacePackage.name} has no ${workspacePackage.relativePath}/src/index.ts to alias. `
          + "Give it one, or declare `calyx.testResolution` in its manifest with the reason.",
      );
    }
    return [workspacePackage.name, entry] as const;
  }));

export default defineConfig({
  resolve: {
    alias: sourceAliases,
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "examples/**/*.test.ts"],
    setupFiles: [resolve(import.meta.dirname, "vitest.setup.ts")],
    maxWorkers: MAX_WORKERS,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  }
});
