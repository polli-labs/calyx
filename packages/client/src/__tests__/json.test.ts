import { describe, expect, test } from "vitest";

import {
  DuplicateJsonMemberScanner,
  hasDuplicateJsonMembers,
  parseJsonWithNumberLexemes,
} from "../json.js";

describe("duplicate JSON member detection", () => {
  test("finds nested duplicates and decoded Unicode key collisions", () => {
    expect(hasDuplicateJsonMembers('{"outer":{"same":1,"same":2}}')).toBe(true);
    expect(hasDuplicateJsonMembers('{"key":1,"\\u006bey":2}')).toBe(true);
  });

  test("does not interpret braces or key-looking text inside strings", () => {
    expect(hasDuplicateJsonMembers('{"text":"{\\"same\\":1,\\"same\\":2}","nested":{"same":1}}')).toBe(false);
  });

  test("retains key and container state across arbitrary transport chunks", () => {
    const scanner = new DuplicateJsonMemberScanner();
    const chunks = ['{"outer":[{"k', 'ey":1,"\\u00', '6bey":2}],"tail":"\\', '"key\\""}'];
    expect(chunks.map((chunk) => scanner.write(chunk))).toEqual([false, false, true, true]);

    const unique = new DuplicateJsonMemberScanner();
    for (const chunk of ['{"text":"{\\"same', '\\":1}","nested":', '{"same":1}}']) {
      expect(unique.write(chunk)).toBe(false);
    }
  });

  test("retains exact nested and root number tokens beside rounded values", () => {
    const nested = parseJsonWithNumberLexemes(
      '{"rounded":0.99999999999999999,"items":[90071992547409911e-1]}',
    );
    expect(nested.value).toEqual({ rounded: 1, items: [9007199254740991] });
    if (typeof nested.value !== "object" || nested.value === null || !("items" in nested.value)) {
      throw new Error("Nested number-token fixture parsed with the wrong shape.");
    }
    expect(nested.numberLexemes.byContainer.get(nested.value)?.get("rounded")).toBe("0.99999999999999999");
    expect(nested.numberLexemes.byContainer.get(nested.value.items as object)?.get("0")).toBe(
      "90071992547409911e-1",
    );

    const root = parseJsonWithNumberLexemes("1.0000000000000001");
    expect(root.value).toBe(1);
    expect(root.numberLexemes.root).toBe("1.0000000000000001");
  });
});
