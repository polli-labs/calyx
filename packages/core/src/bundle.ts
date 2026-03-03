import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BundleBuildOptions, BundleBuildResult } from "./types";

/**
 * Build an extension bundle from a package directory.
 *
 * Reads the extension's package.json to extract name and version,
 * then either plans or executes the build.
 *
 * In plan mode (default), returns the planned build action without
 * side effects. In apply mode, creates the output directory and
 * generates a bundle manifest.
 */
export async function buildBundle(options: BundleBuildOptions): Promise<BundleBuildResult> {
  const pkgPath = path.join(options.path, "package.json");
  const pkgContent = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgContent) as { name?: string; version?: string };

  const name = pkg.name ?? path.basename(options.path);
  const version = pkg.version ?? "0.0.0";
  const outDir = options.outDir ?? path.join(options.path, "dist");
  const apply = Boolean(options.apply);

  if (apply) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });

    const manifest = {
      name,
      version,
      built_at: new Date().toISOString(),
      source: options.path
    };
    await writeFile(
      path.join(outDir, "bundle-manifest.json"),
      JSON.stringify(manifest, null, 2)
    );
  }

  return {
    name,
    version,
    path: options.path,
    outDir,
    apply,
    action: apply ? "build" : "plan-build"
  };
}
