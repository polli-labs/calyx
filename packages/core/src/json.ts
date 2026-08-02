/** Parse JSON while rejecting escape-equivalent or nested duplicate object members. */
export function parseJsonWithoutDuplicateObjectMembers(source: string): unknown {
  let index = 0;
  const fail = (): never => {
    throw new SyntaxError("JSON contains invalid syntax or duplicate object members.");
  };
  const skipWhitespace = (): void => {
    while (/\s/u.test(source[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    if (source[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          fail();
        }
      }
    }
    return fail();
  };
  const parseValue = (): void => {
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      skipWhitespace();
      const names = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skipWhitespace();
        const name = parseString();
        if (names.has(name)) fail();
        names.add(name);
        skipWhitespace();
        if (source[index] !== ":") fail();
        index += 1;
        parseValue();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") fail();
        index += 1;
      }
      fail();
    }
    if (source[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < source.length && !/[\s,}\]]/u.test(source[index]!)) index += 1;
    if (index === start) fail();
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) fail();
  return JSON.parse(source) as unknown;
}
