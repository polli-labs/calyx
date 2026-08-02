import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CtxpackCapabilitiesResponseDataV1, CtxpackPlanResponseDataV1 } from "../types";
import {
  CTXPACK_ERROR_EXIT_CODES_V1,
  CTXPACK_PRIMITIVES_V1,
  CTXPACK_PROVIDER_ORDER_V1,
  runCtxpackContractStubV1,
  stableStringifyCtxpackV1
} from "../index";

const execFileAsync = promisify(execFile);

function assertPrimitiveStatusConformance(
  provider: CtxpackCapabilitiesResponseDataV1["providers"][number]
): void {
  const evidenceProbeSet = new Set(provider.evidence.map((entry) => entry.probe));
  for (const primitive of CTXPACK_PRIMITIVES_V1) {
    const statusEntry = provider.primitive_status[primitive];
    expect(statusEntry, `missing primitive status for ${provider.provider}:${primitive}`).toBeDefined();
    expect(Array.isArray(statusEntry.evidence)).toBe(true);
    expect(statusEntry.evidence.length, `missing evidence pointers for ${provider.provider}:${primitive}`).toBeGreaterThan(0);

    for (const pointer of statusEntry.evidence) {
      expect(
        evidenceProbeSet.has(pointer),
        `evidence pointer ${pointer} must resolve into provider evidence for ${provider.provider}:${primitive}`
      ).toBe(true);
    }

    if (statusEntry.status !== "ready") {
      expect(
        statusEntry.reason_code,
        `non-ready primitive status must include reason_code for ${provider.provider}:${primitive}`
      ).toBeDefined();
    }
  }
}

describe("ctxpack contract v1", () => {
  let tmpRoot: string;
  let priorCodexRoot: string | undefined;
  let priorClaudeRoot: string | undefined;
  let priorGeminiRoot: string | undefined;
  let priorHermesHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "ctxpack-contracts-"));
    const codexRoot = path.join(tmpRoot, "codex");
    const claudeRoot = path.join(tmpRoot, "claude");
    const geminiRoot = path.join(tmpRoot, "gemini");
    const hermesRoot = path.join(tmpRoot, "hermes");
    await mkdir(codexRoot, { recursive: true });
    await mkdir(claudeRoot, { recursive: true });
    await mkdir(path.join(geminiRoot, "tmp", "project-alpha", "chats"), { recursive: true });
    await mkdir(hermesRoot, { recursive: true });
    await writeFile(
      path.join(codexRoot, "codex-session.jsonl"),
      JSON.stringify({ timestamp: "2026-03-05T18:00:00.000Z", role: "assistant", content: "ok" }),
      "utf8"
    );
    await writeFile(
      path.join(claudeRoot, "claude-session.jsonl"),
      JSON.stringify({ timestamp: "2026-03-05T18:10:00.000Z", role: "assistant", content: "ok" }),
      "utf8"
    );
    await writeFile(
      path.join(geminiRoot, "tmp", "project-alpha", "chats", "session-gemini.json"),
      JSON.stringify([
        { timestamp: "2026-03-05T18:20:00.000Z", role: "assistant", content: "ok" }
      ]),
      "utf8"
    );
    await execFileAsync("sqlite3", [
      path.join(hermesRoot, "state.db"),
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
VALUES ('hermes-session-1', '2026-03-05T18:25:00.000Z', '2026-03-05T18:26:00.000Z');
INSERT INTO messages (session_id, role, content, timestamp)
VALUES ('hermes-session-1', 'assistant', 'ok', '2026-03-05T18:26:00.000Z');
`
    ]);

    priorCodexRoot = process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT;
    priorClaudeRoot = process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT;
    priorGeminiRoot = process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT;
    priorHermesHome = process.env.CALYX_CONTEXT_HERMES_HOME;
    process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT = codexRoot;
    process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT = claudeRoot;
    process.env.CALYX_CONTEXT_GEMINI_SESSIONS_ROOT = geminiRoot;
    process.env.CALYX_CONTEXT_HERMES_HOME = hermesRoot;
  });

  afterEach(async () => {
    if (priorCodexRoot === undefined) {
      delete process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT;
    } else {
      process.env.CALYX_CONTEXT_CODEX_SESSIONS_ROOT = priorCodexRoot;
    }

    if (priorClaudeRoot === undefined) {
      delete process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT;
    } else {
      process.env.CALYX_CONTEXT_CLAUDE_SESSIONS_ROOT = priorClaudeRoot;
    }

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

    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("exposes stable primitive set and default provider ordering", () => {
    const first = runCtxpackContractStubV1("capabilities", {
      include_undetected: false
    });
    const second = runCtxpackContractStubV1("capabilities", {
      include_undetected: false
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(stableStringifyCtxpackV1(first)).toBe(stableStringifyCtxpackV1(second));

    if (!first.ok) {
      return;
    }
    const data = first.data as CtxpackCapabilitiesResponseDataV1;

    expect(first.version).toBe("v1");
    expect(first.primitive).toBe("capabilities");
    expect(data.primitives.map((entry) => entry.primitive)).toEqual(CTXPACK_PRIMITIVES_V1);
    expect(data.exit_code_map).toEqual(CTXPACK_ERROR_EXIT_CODES_V1);
    expect(data.providers.map((provider) => provider.provider)).toEqual(["claude", "codex", "gemini", "hermes"]);
    expect(data.primitives.find((entry) => entry.primitive === "pack")?.available).toBe(true);
    expect(data.primitives.find((entry) => entry.primitive === "docs")?.available).toBe(true);
    expect(data.primitives.find((entry) => entry.primitive === "introspect")?.available).toBe(true);
    for (const provider of data.providers) {
      expect(provider.detected).toBe(true);
      expect(provider.capability_flags).toEqual({
        detect: "ready",
        list: "ready",
        read: "ready",
        normalize: "ready",
        evidence: "ready"
      });
      assertPrimitiveStatusConformance(provider);
    }
  });

  test("include_undetected returns full provider matrix with reason codes", () => {
    const result = runCtxpackContractStubV1("capabilities", {
      include_undetected: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const data = result.data as CtxpackCapabilitiesResponseDataV1;

    expect(data.include_undetected).toBe(true);
    expect(data.providers.map((provider) => provider.provider)).toEqual(CTXPACK_PROVIDER_ORDER_V1);

    const gemini = data.providers.find((provider) => provider.provider === "gemini");
    expect(gemini?.detected).toBe(true);
    expect(gemini?.tier).toBe("tier_1");
    expect(gemini?.evidence.some((entry) => entry.probe === "provider:alias")).toBe(true);
    assertPrimitiveStatusConformance(gemini!);

    const hermes = data.providers.find((provider) => provider.provider === "hermes");
    expect(hermes?.detected).toBe(true);
    expect(hermes?.tier).toBe("tier_1");
    expect(hermes?.evidence.some((entry) => entry.probe.endsWith("/state.db"))).toBe(true);
    assertPrimitiveStatusConformance(hermes!);

    const codex = data.providers.find((provider) => provider.provider === "codex");
    expect(codex?.detected).toBe(true);
    expect(codex?.tier).toBe("tier_0");
    expect(codex?.evidence.some((entry) => entry.probe === "provider:alias")).toBe(true);
    assertPrimitiveStatusConformance(codex!);

    const windsurf = data.providers.find((provider) => provider.provider === "windsurf");
    expect(windsurf?.detected).toBe(false);
    expect(windsurf?.tier).toBe("tier_2");
    expect(windsurf?.reasons).toContain("adapter_not_implemented");
    expect(windsurf?.evidence.some((entry) => entry.reason_code === "adapter_not_implemented")).toBe(true);
    assertPrimitiveStatusConformance(windsurf!);
  });

  test("returns capability_unavailable when requesting undetected provider without flag", () => {
    const result = runCtxpackContractStubV1("capabilities", {
      providers: ["continue"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("capability_unavailable");
      expect(result.error.exit_code).toBe(4);
      expect(result.error.details?.reason_code).toBe("include_undetected_required");
    }
  });

  test("returns adapter_error for unsupported provider id", () => {
    const result = runCtxpackContractStubV1("capabilities", {
      include_undetected: true,
      providers: ["totally-unknown-provider"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("adapter_error");
      expect(result.error.exit_code).toBe(5);
      expect(result.error.details?.reason_code).toBe("provider_not_supported");
      expect(result.error.details?.alias_trace).toEqual([
        {
          input: "totally-unknown-provider",
          canonical_slug: "totally-unknown-provider"
        }
      ]);
    }
  });

  test("normalizes provider aliases to canonical slugs", () => {
    const result = runCtxpackContractStubV1("capabilities", {
      include_undetected: false,
      providers: ["Claude Code", "OPENAI_codex"]
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const data = result.data as CtxpackCapabilitiesResponseDataV1;
    expect(data.providers.map((provider) => provider.provider)).toEqual(["claude", "codex"]);
    expect(data.providers[0]?.alias_trace?.[0]).toEqual({
      input: "Claude Code",
      canonical_slug: "claude-code",
      canonical_provider: "claude",
      matched_alias: "claude-code"
    });
    expect(data.providers[1]?.alias_trace?.[0]).toEqual({
      input: "OPENAI_codex",
      canonical_slug: "openai-codex",
      canonical_provider: "codex",
      matched_alias: "openai-codex"
    });
  });

  test("maps typed error families to locked exit codes", () => {
    expect(CTXPACK_ERROR_EXIT_CODES_V1.validation_error).toBe(2);
    expect(CTXPACK_ERROR_EXIT_CODES_V1.not_found).toBe(3);
    expect(CTXPACK_ERROR_EXIT_CODES_V1.capability_unavailable).toBe(4);
    expect(CTXPACK_ERROR_EXIT_CODES_V1.adapter_error).toBe(5);
    expect(CTXPACK_ERROR_EXIT_CODES_V1.internal_error).toBe(10);
  });

  test("normalizes plan input deterministically and emits stable hashes", () => {
    const first = runCtxpackContractStubV1("plan", {
      roots: ["packages/core/src", ".", "packages/core/src"],
      include: ["**/*.ts", "**/*.md", "**/*.ts"],
      exclude: ["dist/**", ".git/**"],
      include_sessions: false,
      include_git_meta: true,
      budget: { max_tokens: 30000, max_bytes: 90000 }
    });

    const second = runCtxpackContractStubV1("plan", {
      roots: [".", "packages/core/src"],
      include: ["**/*.md", "**/*.ts"],
      exclude: [".git/**", "dist/**"],
      include_sessions: false,
      include_git_meta: true,
      budget: { max_bytes: 90000, max_tokens: 30000 }
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(stableStringifyCtxpackV1(first)).toBe(stableStringifyCtxpackV1(second));

    if (first.ok && second.ok) {
      expect(first.determinism.plan_hash).toBe(second.determinism.plan_hash);
      expect(first.data).toEqual(second.data);
    }
  });

  test("omits sessions by default and enables policy record when requested", () => {
    const defaultPlan = runCtxpackContractStubV1("plan", {
      roots: ["packages/core/src"]
    });
    const sessionsEnabledPlan = runCtxpackContractStubV1("plan", {
      roots: ["packages/core/src"],
      include_sessions: true
    });

    expect(defaultPlan.ok).toBe(true);
    expect(sessionsEnabledPlan.ok).toBe(true);

    if (defaultPlan.ok && sessionsEnabledPlan.ok) {
      const defaultData = defaultPlan.data as CtxpackPlanResponseDataV1;
      const enabledData = sessionsEnabledPlan.data as CtxpackPlanResponseDataV1;

      expect(defaultData.include_sessions).toBe(false);
      expect(defaultData.sessions.reason_code).toBe("sessions_opted_out");
      expect(enabledData.include_sessions).toBe(true);
      expect(enabledData.sessions.reason_code).toBe("session_adapters_unavailable");
    }
  });

  test("returns validation envelope for invalid contract input", () => {
    const result = runCtxpackContractStubV1("pack", {
      plan_hash: ""
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.exit_code).toBe(2);
      expect(result.error.details?.issues).toBeDefined();
    }
  });
});
