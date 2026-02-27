import type { ArrayMergePolicy, ArrayPolicyConfig } from "./types";

const DELETED = Symbol("deleted");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathMatches(pattern: string, path: string[]): boolean {
  const patternParts = pattern.split(".");
  if (patternParts.length !== path.length) {
    return false;
  }

  return patternParts.every((part, index) => part === "*" || part === path[index]);
}

function resolveArrayPolicy(path: string[], policies?: ArrayPolicyConfig): ArrayMergePolicy {
  if (policies?.by_path) {
    for (const [pattern, policy] of Object.entries(policies.by_path)) {
      if (pathMatches(pattern, path)) {
        return policy;
      }
    }
  }

  return policies?.default ?? "replace";
}

function appendUnique(base: unknown[], overlay: unknown[]): unknown[] {
  const merged = [...base];
  const seen = new Set(base.map((item) => JSON.stringify(item)));

  for (const item of overlay) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function mergeRecursive(
  base: unknown,
  overlay: unknown,
  path: string[],
  policies?: ArrayPolicyConfig
): unknown {
  if (overlay === null) {
    return DELETED;
  }

  if (Array.isArray(base) && Array.isArray(overlay)) {
    const policy = resolveArrayPolicy(path, policies);
    return policy === "append_unique" ? appendUnique(base, overlay) : [...overlay];
  }

  if (isRecord(base) && isRecord(overlay)) {
    const result: Record<string, unknown> = { ...base };
    const keys = new Set([...Object.keys(base), ...Object.keys(overlay)]);

    for (const key of keys) {
      if (!(key in overlay)) {
        continue;
      }

      const nextValue = mergeRecursive(base[key], overlay[key], [...path, key], policies);
      if (nextValue === DELETED) {
        delete result[key];
        continue;
      }

      result[key] = nextValue;
    }

    return result;
  }

  return overlay;
}

export function mergeWithPolicies<T>(base: T, overlay: Partial<T>, policies?: ArrayPolicyConfig): T {
  const merged = mergeRecursive(base, overlay, [], policies);
  if (merged === DELETED) {
    throw new Error("Root object cannot be removed during merge.");
  }
  return merged as T;
}
