/**
 * Standalone manifest validation script.
 *
 * Run: npx tsx src/validate.ts
 *
 * Reads this package's package.json and validates the `calyx` manifest
 * against the SDK contract. Use this to verify your extension before
 * publishing or sharing.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateManifest } from "@polli-labs/calyx-sdk";

const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

const manifest = {
  name: pkg.name,
  version: pkg.version,
  calyx: pkg.calyx,
};

const result = validateManifest(manifest);

if (result.ok) {
  console.log("Manifest valid.");
} else {
  console.error("Manifest validation failed:");
  for (const issue of result.issues) {
    console.error(`  [${issue.code}] ${issue.message}`);
  }
  process.exit(1);
}
