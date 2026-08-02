function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("JCS does not permit lone Unicode surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JCS does not permit lone Unicode surrogates");
    }
  }
}

function canonicalizeJcsValue(value: unknown): string {
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS does not permit non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcsValue).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    keys.forEach(assertValidUnicode);
    return `{${keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJcsValue(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`JCS cannot canonicalize ${typeof value}`);
}

export function canonicalizeJcs(value: unknown): string {
  return canonicalizeJcsValue(value);
}
