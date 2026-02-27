import { parse as parseToml } from "@iarna/toml";
import type { SemanticParityResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown, path: string[] = []): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return `${path.join(".") || "<root>"}: array length mismatch (${a.length} !== ${b.length})`;
    }

    for (let index = 0; index < a.length; index += 1) {
      const mismatch = deepEqual(a[index], b[index], [...path, String(index)]);
      if (mismatch) {
        return mismatch;
      }
    }

    return null;
  }

  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();

    if (aKeys.length !== bKeys.length || aKeys.some((key, idx) => key !== bKeys[idx])) {
      return `${path.join(".") || "<root>"}: key mismatch (${aKeys.join(",")} !== ${bKeys.join(",")})`;
    }

    for (const key of aKeys) {
      const mismatch = deepEqual(a[key], b[key], [...path, key]);
      if (mismatch) {
        return mismatch;
      }
    }

    return null;
  }

  if (a !== b) {
    return `${path.join(".") || "<root>"}: value mismatch (${String(a)} !== ${String(b)})`;
  }

  return null;
}

export function compareTomlSemantics(generatedToml: string, expectedToml: string): SemanticParityResult {
  const generatedObject = parseToml(generatedToml) as Record<string, unknown>;
  const expectedObject = parseToml(expectedToml) as Record<string, unknown>;
  const mismatch = deepEqual(generatedObject, expectedObject);

  return mismatch ? { equal: false, reason: mismatch } : { equal: true };
}
