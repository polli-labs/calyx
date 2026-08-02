import { describe, expect, test } from "vitest";
import type { SessionDiscoveryFs } from "@polli-labs/calyx-runner";
import {
  discoverCodexSession,
  findLatestCodexSession,
} from "../runtime/index.js";

function createMockFs(files: Record<string, string>): SessionDiscoveryFs {
  const dirs = new Map<string, string[]>();

  for (const filePath of Object.keys(files)) {
    const parts = filePath.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1]!;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(name);
  }

  return {
    readdir: async (p: string) => {
      const normalized = p.replace(/\/$/, "");
      const entries = dirs.get(normalized);
      if (!entries) {
        const subDirs = new Set<string>();
        for (const key of dirs.keys()) {
          if (key.startsWith(normalized + "/")) {
            const rest = key.slice(normalized.length + 1);
            const first = rest.split("/")[0];
            if (first) subDirs.add(first);
          }
        }
        if (subDirs.size > 0) return Array.from(subDirs);
        throw new Error(`ENOENT: ${p}`);
      }

      const subDirs = new Set<string>();
      for (const key of dirs.keys()) {
        if (key.startsWith(normalized + "/")) {
          const rest = key.slice(normalized.length + 1);
          const first = rest.split("/")[0];
          if (first) subDirs.add(first);
        }
      }
      return [...entries, ...Array.from(subDirs)];
    },
    readFile: async (p: string) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    stat: async (p: string) => {
      if (files[p] === undefined) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: Date.now() };
    },
    homedir: () => "/home/testuser",
  };
}

describe("discoverCodexSession", () => {
  const baseTime = new Date("2026-03-18T10:00:00Z").getTime();

  test("finds session within time window", async () => {
    const ts = baseTime + 5_000;
    const filename = `rollout-${ts}-abcd-ef01-2345-6789.jsonl`;
    const fs = createMockFs({
      [`/home/testuser/.codex/sessions/2026/03/18/${filename}`]: '{"type":"response_item"}',
    });

    const result = await discoverCodexSession(baseTime, baseTime + 60_000, fs);
    expect(result).toBeDefined();
    expect(result!.id).toBe("abcd-ef01-2345-6789");
    expect(result!.path).toContain(filename);
    expect(result!.backend).toBe("codex");
  });

  test("returns undefined when no sessions in time window", async () => {
    const ts = baseTime - 120_000;
    const filename = `rollout-${ts}-old-uuid.jsonl`;
    const fs = createMockFs({
      [`/home/testuser/.codex/sessions/2026/03/18/${filename}`]: "{}",
    });

    const result = await discoverCodexSession(baseTime, baseTime + 60_000, fs);
    expect(result).toBeUndefined();
  });

  test("picks the latest session within the window", async () => {
    const ts1 = baseTime + 1_000;
    const ts2 = baseTime + 30_000;
    const fs = createMockFs({
      [`/home/testuser/.codex/sessions/2026/03/18/rollout-${ts1}-aaa0-bbb1-ccc2-ddd3.jsonl`]: "{}",
      [`/home/testuser/.codex/sessions/2026/03/18/rollout-${ts2}-eee4-fff5-0001-0002.jsonl`]: "{}",
    });

    const result = await discoverCodexSession(baseTime, baseTime + 60_000, fs);
    expect(result).toBeDefined();
    expect(result!.id).toBe("eee4-fff5-0001-0002");
  });

  test("returns undefined when sessions directory does not exist", async () => {
    const fs = createMockFs({});
    const result = await discoverCodexSession(baseTime, baseTime + 60_000, fs);
    expect(result).toBeUndefined();
  });

  test("ignores files with non-matching filename pattern", async () => {
    const fs = createMockFs({
      "/home/testuser/.codex/sessions/2026/03/18/random-file.jsonl": "{}",
      "/home/testuser/.codex/sessions/2026/03/18/not-a-rollout.txt": "{}",
    });

    const result = await discoverCodexSession(baseTime, baseTime + 60_000, fs);
    expect(result).toBeUndefined();
  });
});

describe("findLatestCodexSession", () => {
  const baseTime = new Date("2026-03-18T10:00:00Z").getTime();

  test("finds the most recent codex session across date dirs", async () => {
    const ts1 = baseTime - 60_000;
    const ts2 = baseTime + 5_000;
    const fs = createMockFs({
      [`/home/testuser/.codex/sessions/2026/03/17/rollout-${ts1}-aaa0-bbb1-ccc2-ddd3.jsonl`]: "{}",
      [`/home/testuser/.codex/sessions/2026/03/18/rollout-${ts2}-eee4-fff5-0001-0002.jsonl`]: "{}",
    });

    const result = await findLatestCodexSession(fs);
    expect(result).toBeDefined();
    expect(result!.id).toBe("eee4-fff5-0001-0002");
    expect(result!.backend).toBe("codex");
    expect(result!.startedAt).toBe(ts2);
  });

  test("returns undefined when no codex sessions exist", async () => {
    const fs = createMockFs({});
    const result = await findLatestCodexSession(fs);
    expect(result).toBeUndefined();
  });

  test("ignores non-rollout files", async () => {
    const fs = createMockFs({
      "/home/testuser/.codex/sessions/2026/03/18/random-file.jsonl": "{}",
    });

    const result = await findLatestCodexSession(fs);
    expect(result).toBeUndefined();
  });
});
