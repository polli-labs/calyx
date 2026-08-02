type JsonContainer =
  | { kind: "array"; state: "value_or_end" | "comma_or_end" }
  | { kind: "object"; keys: Set<string>; state: "key_or_end" | "colon" | "value" | "comma_or_end" };

export interface JsonNumberLexemes {
  /** Exact JSON number tokens keyed by their parsed object/array container and property. */
  readonly byContainer: WeakMap<object, ReadonlyMap<string, string>>;
  /** Exact token when the complete JSON value is itself a number. */
  readonly root?: string;
}

export interface ParsedJsonWithNumberLexemes {
  readonly value: unknown;
  readonly numberLexemes: JsonNumberLexemes;
}

/**
 * Parse JSON while retaining exact number tokens beside the ordinary value.
 *
 * Node 22's source-aware JSON.parse reviver is the syntax and materialization
 * authority. Keeping token provenance out-of-band lets generated integer
 * validators reject decimals or out-of-range values that binary64 would round
 * into an apparently safe integer without changing the public response shape.
 */
export function parseJsonWithNumberLexemes(text: string): ParsedJsonWithNumberLexemes {
  const byContainer = new WeakMap<object, Map<string, string>>();
  let possibleRoot: string | undefined;
  const value = JSON.parse(text, function (
    this: object,
    key: string,
    parsed: unknown,
    context?: { readonly source?: unknown },
  ): unknown {
    if (typeof parsed !== "number" || typeof context?.source !== "string") return parsed;
    let entries = byContainer.get(this);
    if (!entries) {
      entries = new Map();
      byContainer.set(this, entries);
    }
    entries.set(key, context.source);
    if (key === "") possibleRoot = context.source;
    return parsed;
  }) as unknown;
  return {
    value,
    numberLexemes: {
      byContainer,
      ...(typeof value === "number" && possibleRoot !== undefined ? { root: possibleRoot } : {}),
    },
  };
}

/**
 * Incrementally detects duplicate decoded object member names.
 *
 * JSON.parse remains the syntax authority. This scanner only recognizes enough
 * of valid JSON's token structure to identify object keys, including escaped
 * keys split across transport chunks. Keeping it incremental lets bounded HTTP
 * reads pay this required security pass while bytes arrive instead of adding a
 * second whole-document JavaScript walk after a large response is buffered.
 */
export class DuplicateJsonMemberScanner {
  private readonly containers: JsonContainer[] = [];
  private rootState: "value" | "complete" = "value";
  private scalar = false;
  private stringState: { readonly key: boolean; escaped: boolean; raw?: string } | undefined;
  private duplicate = false;

  write(text: string): boolean {
    let index = 0;
    while (index < text.length && !this.duplicate) {
      const character = text[index]!;
      if (this.stringState) {
        this.consumeStringCharacter(character);
        index += 1;
        continue;
      }
      if (this.scalar) {
        if (!/[\s,}\]]/u.test(character)) {
          index += 1;
          continue;
        }
        this.scalar = false;
        continue;
      }
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      const container = this.containers.at(-1);
      if (character === "\"") {
        const key = container?.kind === "object" && container.state === "key_or_end";
        if (!key) this.startValue();
        this.stringState = { key, escaped: false, ...(key ? { raw: "\"" } : {}) };
      } else if (character === "{") {
        this.startValue();
        this.containers.push({ kind: "object", keys: new Set(), state: "key_or_end" });
      } else if (character === "[") {
        this.startValue();
        this.containers.push({ kind: "array", state: "value_or_end" });
      } else if (character === ":") {
        if (container?.kind === "object" && container.state === "colon") container.state = "value";
      } else if (character === ",") {
        if (container?.kind === "object" && container.state === "comma_or_end") container.state = "key_or_end";
        if (container?.kind === "array" && container.state === "comma_or_end") container.state = "value_or_end";
      } else if (character === "}" || character === "]") {
        this.containers.pop();
      } else {
        this.startValue();
        this.scalar = true;
      }
      index += 1;
    }
    return this.duplicate;
  }

  private startValue(): void {
    const container = this.containers.at(-1);
    if (!container) {
      if (this.rootState === "value") this.rootState = "complete";
      return;
    }
    if (container.kind === "object" && container.state === "value") container.state = "comma_or_end";
    if (container.kind === "array" && container.state === "value_or_end") container.state = "comma_or_end";
  }

  private consumeStringCharacter(character: string): void {
    const state = this.stringState!;
    if (state.key) state.raw += character;
    if (state.escaped) {
      state.escaped = false;
      return;
    }
    if (character === "\\") {
      state.escaped = true;
      return;
    }
    if (character !== "\"") return;
    this.stringState = undefined;
    if (!state.key) return;
    const container = this.containers.at(-1);
    if (container?.kind !== "object") return;
    container.state = "colon";
    try {
      const key = JSON.parse(state.raw!) as string;
      if (container.keys.has(key)) {
        this.duplicate = true;
        return;
      }
      container.keys.add(key);
    } catch {
      // JSON.parse classifies malformed JSON after the bounded read completes.
    }
  }
}

/** Detect duplicate decoded member names in an already-bounded JSON value. */
export function hasDuplicateJsonMembers(text: string): boolean {
  return new DuplicateJsonMemberScanner().write(text);
}
