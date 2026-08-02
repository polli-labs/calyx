import { createHash } from "node:crypto";
import type { CtxpackRequestV1 } from "../types";

const PATH_ARRAY_KEYS_V1 = new Set(["roots", "include", "exclude", "paths", "artifact_paths"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCtxpackPathListV1(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))].sort((a, b) => a.localeCompare(b));
}

export function normalizeCtxpackValueV1<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCtxpackValueV1(item)) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const normalizedEntries = Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const raw = value[key];
      if (Array.isArray(raw) && PATH_ARRAY_KEYS_V1.has(key) && raw.every((item) => typeof item === "string")) {
        return [key, normalizeCtxpackPathListV1(raw as string[])];
      }
      return [key, normalizeCtxpackValueV1(raw)];
    });

  return Object.fromEntries(normalizedEntries) as T;
}

export function normalizeCtxpackRequestV1<T extends CtxpackRequestV1>(request: T): T {
  return normalizeCtxpackValueV1(request);
}

export function stableStringifyCtxpackV1(value: unknown): string {
  return JSON.stringify(normalizeCtxpackValueV1(value));
}

export function computeCtxpackHashV1(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createCtxpackPlanHashV1(value: unknown): { plan_hash_input: string; plan_hash: string } {
  const planHashInput = stableStringifyCtxpackV1(value);
  return {
    plan_hash_input: planHashInput,
    plan_hash: computeCtxpackHashV1(planHashInput)
  };
}
