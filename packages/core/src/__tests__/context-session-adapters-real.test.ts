import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CtxpackProviderIdV1 } from "../types";
import { createSessionProviderAdapterV1 } from "../index";

const execFileAsync = promisify(execFile);

interface ProviderParityExpectation {
  provider: CtxpackProviderIdV1;
  expected: {
    event_count: number;
    started_at?: string;
    last_event_at?: string;
    entries: Array<{
      role: string;
      content: string;
    }>;
  };
}

interface ProviderParityCatalog {
  version: "v1";
  providers: ProviderParityExpectation[];
}

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/context/v1/session-adapters");
}

async function installGeminiRealFixture(rootPath: string): Promise<void> {
  const fixturePath = path.join(fixtureRoot(), "gemini", "session-current-schema.json");
  const fixtureRaw = await readFile(fixturePath, "utf8");
  const targetPath = path.join(rootPath, "tmp", "project-alpha", "chats", "session-real-gemini.json");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, fixtureRaw, "utf8");
}

async function installHermesRealFixture(rootPath: string): Promise<void> {
  const sqlPath = path.join(fixtureRoot(), "hermes", "state.sql");
  const sql = await readFile(sqlPath, "utf8");
  const dbPath = path.join(rootPath, "state.db");
  await mkdir(rootPath, { recursive: true });
  await execFileAsync("sqlite3", [dbPath, sql]);
}

async function loadParityCatalog(): Promise<ProviderParityCatalog> {
  const catalogPath = path.join(fixtureRoot(), "parity.expected.json");
  const raw = await readFile(catalogPath, "utf8");
  return JSON.parse(raw) as ProviderParityCatalog;
}

function compactEntries(entries: readonly Record<string, unknown>[]): Array<{ role: string; content: string }> {
  return entries.map((entry) => ({
    role: typeof entry["role"] === "string" ? entry["role"] : "unknown",
    content: typeof entry["content"] === "string" ? entry["content"] : String(entry["content"] ?? "")
  }));
}

describe("session adapter real corpus parity gate", () => {
  let tmpRoot = "";
  let priorGeminiRoot: string | undefined;
  let priorHermesHome: string | undefined;
  let priorHermesStateDb: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "calyx-context-real-corpus-"));
    priorGeminiRoot = process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT;
    priorHermesHome = process.env.CALYX_CONTEXT_HERMES_HOME;
    priorHermesStateDb = process.env.CALYX_CONTEXT_HERMES_STATE_DB;
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    if (priorGeminiRoot === undefined) {
      delete process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT;
    } else {
      process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT = priorGeminiRoot;
    }

    if (priorHermesHome === undefined) {
      delete process.env.CALYX_CONTEXT_HERMES_HOME;
    } else {
      process.env.CALYX_CONTEXT_HERMES_HOME = priorHermesHome;
    }

    if (priorHermesStateDb === undefined) {
      delete process.env.CALYX_CONTEXT_HERMES_STATE_DB;
    } else {
      process.env.CALYX_CONTEXT_HERMES_STATE_DB = priorHermesStateDb;
    }
  });

  test("passes parity gate for gemini + hermes real-format fixtures", async () => {
    const geminiRoot = path.join(tmpRoot, "gemini");
    const hermesRoot = path.join(tmpRoot, "hermes");
    await installGeminiRealFixture(geminiRoot);
    await installHermesRealFixture(hermesRoot);

    process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT = geminiRoot;
    process.env.CALYX_CONTEXT_HERMES_HOME = hermesRoot;
    delete process.env.CALYX_CONTEXT_HERMES_STATE_DB;

    const catalog = await loadParityCatalog();
    expect(catalog.version).toBe("v1");

    const report: Array<{ provider: CtxpackProviderIdV1; passed: boolean }> = [];
    for (const providerExpectation of catalog.providers) {
      const adapter = createSessionProviderAdapterV1(providerExpectation.provider);
      const detection = adapter.detect();
      expect(detection.detected).toBe(true);

      const handles = adapter.listSessions();
      expect(handles.length).toBeGreaterThan(0);

      const targetSessionId =
        providerExpectation.provider === "gemini" ? "session-real-gemini" : "session-hermes-real-1";
      const handle = handles.find((candidate) => candidate.session_id === targetSessionId) ?? handles[0];
      expect(handle).toBeDefined();

      const record = adapter.readSession(handle!);
      const normalized = adapter.normalize(record);
      const compact = compactEntries(record.entries);

      const expected = providerExpectation.expected;
      const actual = {
        event_count: normalized.event_count,
        ...(normalized.started_at ? { started_at: normalized.started_at } : {}),
        ...(normalized.last_event_at ? { last_event_at: normalized.last_event_at } : {}),
        entries: compact
      };

      const passed = JSON.stringify(actual) === JSON.stringify(expected);
      report.push({
        provider: providerExpectation.provider,
        passed
      });
      expect(actual).toEqual(expected);
    }

    expect(report).toEqual([
      { provider: "gemini", passed: true },
      { provider: "hermes", passed: true }
    ]);
  });
});
