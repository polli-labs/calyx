import type { CompileContext } from "./types";

const TOKEN_PATTERN = /{{\s*(home|user|host)\s*}}/g;

export function expandTokens<T>(value: T, context: CompileContext): T {
  if (typeof value === "string") {
    return value.replace(TOKEN_PATTERN, (_match, key: keyof CompileContext) => context[key]) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandTokens(item, context)) as T;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const expanded: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      expanded[key] = expandTokens(nested, context);
    }
    return expanded as T;
  }

  return value;
}
