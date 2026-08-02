import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import type { CtxpackProviderIdV1 } from "../types";
import {
  createSessionProviderAdapterV1,
  normalizeProviderAliasV1,
  normalizeRequestedProvidersV1,
  SessionProviderAdapterError
} from "../index";

const execFileAsync = promisify(execFile);

interface ProviderHarness {
  provider: CtxpackProviderIdV1;
  envVar: string;
  mode: "jsonl" | "gemini" | "hermes";
}

const PROVIDER_HARNESSES: ProviderHarness[] = [
  { provider: "codex", envVar: "CALYX_CONTEXT_CODEX_SESSIONS_ROOT", mode: "jsonl" },
  { provider: "claude", envVar: "CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT", mode: "jsonl" },
  { provider: "gemini", envVar: "CALYX_CONTEXT_GEMINI_SESSIONS_ROOT", mode: "gemini" },
  { provider: "hermes", envVar: "CALYX_CONTEXT_HERMES_HOME", mode: "hermes" }
];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function createHermesFixture(root: string): Promise<{
  newestSourcePath: string;
  malformedSourcePath: string;
}> {
  const dbPath = path.join(root, "state.db");
  await execFileAsync("sqlite3", [
    dbPath,
    `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT,
  content TEXT,
  timestamp TEXT
);
INSERT INTO sessions (session_id, created_at, updated_at)
VALUES
  ('hermes-session-active', '2026-03-05T20:10:00.000Z', '2026-03-05T20:11:00.000Z'),
  ('hermes-session-older', '2026-03-05T18:11:00.000Z', '2026-03-05T18:11:00.000Z');
INSERT INTO messages (session_id, role, content, timestamp)
VALUES
  ('hermes-session-active', 'human', 'hello
there	tool', '2026-03-05T20:10:00.000Z'),
  ('hermes-session-active', 'assistant', 'world', '2026-03-05T20:11:00.000Z'),
  ('hermes-session-older', 'system', 'older', '2026-03-05T18:11:00.000Z');
`
  ]);

  const sessionsDir = path.join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const malformedSourcePath = path.join(sessionsDir, "session_broken.json");
  await writeFile(malformedSourcePath, "{not-json}", "utf8");

  return {
    newestSourcePath: dbPath,
    malformedSourcePath
  };
}

describe("SessionProviderAdapter conformance", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "ctxpack-session-adapters-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    delete process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT;
    delete process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT;
    delete process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT;
    delete process.env.CALYX_CONTEXT_HERMES_HOME;
    delete process.env.CALYX_CONTEXT_HERMES_STATE_DB;
  });

  for (const harness of PROVIDER_HARNESSES) {
    describe(`${harness.provider} adapter`, () => {
      test("detect emits probe evidence with success root", async () => {
        const root = path.join(tmpRoot, `${harness.provider}-sessions`);
        await mkdir(root, { recursive: true });
        process.env[harness.envVar] = root;
        if (harness.mode === "hermes") {
          await createHermesFixture(root);
        }

        const adapter = createSessionProviderAdapterV1(harness.provider);
        const detection = adapter.detect();

        expect(detection.detected).toBe(true);
        expect(detection.detected_root).toBe(root);
        expect(detection.evidence.some((entry) => entry.probe === "provider:alias")).toBe(true);
        expect(
          detection.evidence.some((entry) => entry.result === "success" && entry.detail === "probe_path_readable")
        ).toBe(true);
      });

      test("listSessions + readSession + normalize satisfies shared contract", async () => {
        const root = path.join(tmpRoot, `${harness.provider}-sessions`);
        const newestEntries = [
          { timestamp: "2026-03-05T20:10:00.000Z", role: "user", content: "hello" },
          { timestamp: "2026-03-05T20:11:00.000Z", role: "assistant", content: "world" }
        ];
        const olderEntries = [{ timestamp: "2026-03-05T18:11:00.000Z", role: "system", content: "older" }];

        if (harness.mode === "hermes") {
          await mkdir(root, { recursive: true });
          process.env[harness.envVar] = root;
          await createHermesFixture(root);
        } else {
          const nested = harness.mode === "gemini" ? path.join(root, "tmp", "project-alpha", "chats") : path.join(root, "nested");
          await mkdir(nested, { recursive: true });
          process.env[harness.envVar] = root;

          const newestPath = path.join(
            nested,
            harness.mode === "gemini" ? "session-Active Session_One.json" : "Active Session_One.jsonl"
          );
          const olderPath = path.join(
            harness.mode === "gemini" ? nested : root,
            harness.mode === "gemini" ? "session-older.json" : "older.jsonl"
          );

          await writeFile(
            newestPath,
            harness.mode === "gemini"
              ? JSON.stringify(newestEntries)
              : newestEntries.map((entry) => JSON.stringify(entry)).join("\n"),
            "utf8"
          );
          await writeFile(
            olderPath,
            harness.mode === "gemini"
              ? JSON.stringify(olderEntries)
              : JSON.stringify(olderEntries[0]),
            "utf8"
          );
          await utimes(olderPath, new Date("2026-03-05T18:11:00.000Z"), new Date("2026-03-05T18:11:00.000Z"));
        }

        if (harness.mode === "gemini") {
          const nested = path.join(root, "tmp", "project-alpha", "chats");
          await writeFile(path.join(nested, "session-subagent-ignored.json"), JSON.stringify(newestEntries), "utf8");
          const wrongLayout = path.join(root, "chats");
          await mkdir(wrongLayout, { recursive: true });
          await writeFile(path.join(wrongLayout, "session-outside-layout.json"), JSON.stringify(newestEntries), "utf8");
        }

        const adapter = createSessionProviderAdapterV1(harness.provider);
        const handles = adapter.listSessions();

        expect(handles.length).toBeGreaterThanOrEqual(2);
        expect(handles[0]?.provider).toBe(harness.provider);
        expect(handles[0]?.provider_slug).toBe(harness.provider);
        expect(handles[0]?.session_slug).toBe(
          harness.mode === "gemini"
            ? "session-active-session-one"
            : harness.mode === "hermes"
              ? "hermes-session-active"
              : "active-session-one"
        );
        if (harness.mode === "gemini") {
          expect(handles.some((session) => session.source_path.includes("subagent"))).toBe(false);
        }

        const record = adapter.readSession(handles[0]!);
        expect(record.provider).toBe(harness.provider);
        expect(record.entries).toHaveLength(2);
        if (harness.mode === "hermes") {
          expect(record.entries[0]?.role).toBe("user");
          expect(record.entries[0]?.hermes_role).toBe("human");
          expect(record.entries[0]?.content).toBe("hello\nthere\ttool");
        }

        const normalized = adapter.normalize(record);
        expect(normalized.provider).toBe(harness.provider);
        expect(normalized.provider_slug).toBe(harness.provider);
        expect(normalized.event_count).toBe(2);
        expect(normalized.started_at).toBe("2026-03-05T20:10:00.000Z");
        expect(normalized.last_event_at).toBe("2026-03-05T20:11:00.000Z");
      });

      test("detect reports reason-coded non-detection evidence", () => {
        process.env[harness.envVar] = path.join(tmpRoot, `${harness.provider}-missing`);
        const adapter = createSessionProviderAdapterV1(harness.provider);
        const detection = adapter.detect();

        expect(detection.detected).toBe(false);
        expect(detection.reasons).toContain("adapter_path_missing");
        expect(detection.evidence.some((entry) => entry.reason_code === "adapter_path_missing")).toBe(true);
      });

      test("listSessions throws typed path-missing adapter error when undetected", () => {
        process.env[harness.envVar] = path.join(tmpRoot, `${harness.provider}-missing`);
        const adapter = createSessionProviderAdapterV1(harness.provider);

        expect(() => adapter.listSessions()).toThrow(SessionProviderAdapterError);
        expect(() => adapter.listSessions()).toThrowError(
          expect.objectContaining({
            code: "ADAPTER_PATH_MISSING"
          })
        );
      });

      test("readSession throws typed parse error for malformed session files", async () => {
        const root = path.join(tmpRoot, `${harness.provider}-sessions`);
        let malformedPath = "";
        if (harness.mode === "hermes") {
          await mkdir(root, { recursive: true });
          process.env[harness.envVar] = root;
          const fixture = await createHermesFixture(root);
          malformedPath = fixture.malformedSourcePath;
        } else {
          const malformedParent = harness.mode === "gemini" ? path.join(root, "tmp", "project-alpha", "chats") : root;
          await mkdir(malformedParent, { recursive: true });
          process.env[harness.envVar] = root;
          malformedPath = path.join(
            malformedParent,
            harness.mode === "gemini" ? "session-broken.json" : "broken.jsonl"
          );
          await writeFile(malformedPath, "{not-json}", "utf8");
        }

        const adapter = createSessionProviderAdapterV1(harness.provider);
        const handle =
          harness.mode === "hermes"
            ? {
              provider: harness.provider,
              provider_slug: harness.provider,
              session_id: "broken",
              session_slug: "broken",
              source_path: malformedPath,
              detected_root: root,
              bytes: 10,
              modified_at: new Date("2026-03-05T18:11:00.000Z").toISOString()
            }
            : adapter.listSessions().find((session) => session.source_path === malformedPath);
        expect(handle).toBeDefined();

        expect(() => adapter.readSession(handle!)).toThrow(SessionProviderAdapterError);
        expect(() => adapter.readSession(handle!)).toThrowError(
          expect.objectContaining({
            code: "ADAPTER_PARSE_ERROR"
          })
        );
      });

      test("capabilities advertises all SPI methods as ready", () => {
        const adapter = createSessionProviderAdapterV1(harness.provider);
        expect(adapter.capabilities()).toEqual({
          detect: "ready",
          list: "ready",
          read: "ready",
          normalize: "ready",
          evidence: "ready"
        });
      });
    });
  }

  test("canonical slug + alias normalization resolves first-party variants", () => {
    const claudeTrace = normalizeProviderAliasV1("Claude Code");
    expect(claudeTrace.canonical_slug).toBe("claude-code");
    expect(claudeTrace.canonical_provider).toBe("claude");
    expect(claudeTrace.matched_alias).toBe("claude-code");

    const codexTrace = normalizeProviderAliasV1("OPENAI_codex");
    expect(codexTrace.canonical_slug).toBe("openai-codex");
    expect(codexTrace.canonical_provider).toBe("codex");
    expect(codexTrace.matched_alias).toBe("openai-codex");

    const hermesTrace = normalizeProviderAliasV1("hermes-cli");
    expect(hermesTrace.canonical_slug).toBe("hermes-cli");
    expect(hermesTrace.canonical_provider).toBe("hermes");
    expect(hermesTrace.matched_alias).toBe("hermes-cli");

    const normalized = normalizeRequestedProvidersV1(["Claude Code", "codex", "OPENAI_codex", "hermes-cli", "unknown provider"]);
    expect(normalized.providers).toEqual(["claude", "codex", "hermes"]);
    expect(normalized.unknown).toEqual([
      {
        input: "unknown provider",
        canonical_slug: "unknown-provider"
      }
    ]);
  });

  test("unsupported provider adapter requests throw typed adapter error", () => {
    const original = process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT;
    try {
      process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT = path.join(tmpRoot, "claude");
      expect(() => createSessionProviderAdapterV1("windsurf")).toThrow(SessionProviderAdapterError);
      expect(() => createSessionProviderAdapterV1("windsurf")).toThrowError(
        expect.objectContaining({
          code: "ADAPTER_NOT_INSTALLED"
        })
      );
    } finally {
      restoreEnv("CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT", original);
    }
  });
});
