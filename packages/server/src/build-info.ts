import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { CalyxBuildInfo } from "@polli-labs/calyx-core";
import { CALYX_BUILD_INFO_SCHEMA_VERSION } from "@polli-labs/calyx-core";

const BUILD_INFO_FILENAME = ".build-info.json";

function isBuildInfo(value: unknown): value is CalyxBuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CalyxBuildInfo>;
  return (
    candidate.schema_version === CALYX_BUILD_INFO_SCHEMA_VERSION
    && typeof candidate.git_head === "string"
    && typeof candidate.built_at === "string"
    && typeof candidate.package_version === "string"
    && typeof candidate.branch === "string"
    && typeof candidate.dirty === "boolean"
  );
}

export function resolveServerBuildInfoPath(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL(`../dist/${BUILD_INFO_FILENAME}`, moduleUrl));
}

export function loadServerBuildInfo(buildInfoPath = resolveServerBuildInfoPath()): CalyxBuildInfo {
  const raw = JSON.parse(fs.readFileSync(buildInfoPath, "utf8")) as unknown;
  if (!isBuildInfo(raw)) {
    throw new Error(`Invalid Calyx build metadata at ${buildInfoPath}.`);
  }
  return raw;
}
