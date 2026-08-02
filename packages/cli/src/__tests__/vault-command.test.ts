import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";
import type { RunCliDependencies } from "../run-cli";
import type {
  InteractiveSessionInspectResult,
  RunActivityEntry,
  RunIntent,
  RunListEntry,
  RunRecord,
} from "@polli-labs/calyx-run-service";

const tempDirs: string[] = [];
const stdinTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  delete process.env["VAULT_PATH"];
  delete process.env["CODEX_THREAD_ID"];
  delete process.env["CODEX_SESSION_ID"];
  delete process.env["CLAUDE_CODE_SESSION_ID"];
  process.exitCode = undefined;
  if (stdinTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinTTYDescriptor);
  }
});

function makeInteractiveActivity(overrides: Partial<Extract<RunActivityEntry, { entry_kind: "interactive_session" }>> = {}): Extract<RunActivityEntry, { entry_kind: "interactive_session" }> {
  return {
    entry_kind: "interactive_session",
    run_id: "interactive:codex:session-1",
    state: "interactive",
    summary: "Codex session session-1",
    created_at: "2026-06-20T21:00:00.000Z",
    updated_at: "2026-06-20T21:05:00.000Z",
    host: "blade",
    backend: "codex",
    session_id: "session-1",
    session_path: "/tmp/session.jsonl",
    cwd: "/home/caleb/dev/calyx/wt/calyx-run/pol-1847",
    source: "codex_sessions",
    bytes: 1200,
    ...overrides,
  };
}

function makeInspectResult(activityId: string): InteractiveSessionInspectResult {
  const [, backend = "codex", sessionId = "session-1"] = activityId.split(":");
  return {
    activity_id: activityId,
    backend: backend === "claude" ? "claude" : "codex",
    session_id: sessionId,
    session_path: "/tmp/session.jsonl",
    source: backend === "claude" ? "claude_projects" : "codex_sessions",
    total_events: 0,
    returned_events: 0,
    truncated: false,
    include_tools: false,
    events: [],
  };
}

function buildVaultActivityDeps(args?: {
  activity?: Extract<RunActivityEntry, { entry_kind: "interactive_session" }>;
  unresolvedParents?: string[];
}): RunCliDependencies {
  const activity = args?.activity ?? makeInteractiveActivity();
  const unresolvedParents = new Set(args?.unresolvedParents ?? []);
  return {
    now: () => new Date("2026-06-21T12:00:00.000Z"),
    currentHostAlias: "blade",
    hostname: () => "blade",
    createRunService: () => ({
      createIntent: vi.fn((input: Partial<RunIntent> & Pick<RunIntent, "host">) => ({
        run_id: input.run_id ?? "noop",
        host: input.host,
        created_at: "2026-06-21T12:00:00.000Z",
      })),
      launch: vi.fn(async () => ({
        run_id: "noop",
        state: "queued" as RunRecord["state"],
        mode: "background" as const,
        run_dir: "/tmp",
        record: {} as RunRecord,
      })),
      getRunRecord: vi.fn(async (runId: string) => (unresolvedParents.has(`run:${runId}`) ? undefined : ({
        run_id: runId,
        host: "blade",
        state: "completed",
        summary: "done",
        created_at: "2026-06-20T12:00:00.000Z",
        updated_at: "2026-06-20T12:05:00.000Z",
      } as unknown as RunRecord))),
      getKernelReceipt: vi.fn(async () => undefined),
      listRuns: vi.fn(async (): Promise<RunListEntry[]> => []),
      listActivity: vi.fn(async (): Promise<RunActivityEntry[]> => [activity]),
      inspectInteractiveSession: vi.fn(async ({ activityId }: { activityId: string }): Promise<InteractiveSessionInspectResult> => {
        if (unresolvedParents.has(activityId)) {
          throw new Error("activity not found");
        }
        return makeInspectResult(activityId);
      }),
      readEvents: vi.fn(async () => []),
      resolveResumeWorktreePath: vi.fn(async () => ({ path: "/tmp/resolved", source: "run_spec" as const })),
      stop: vi.fn(async (runId: string) => ({
        schema_version: "calyx.run-cancellation-result/v1" as const,
        status: "already_terminal" as const,
        run_id: runId,
      })),
      reconcile: vi.fn(async () => ({ scanned: 0, rebuilt: [], classified: [], adopted: [], unresolved: [], skipped: [], noncanonical_directories: [], projection: { status: "not_configured" as const } })),
      executeStoredRun: vi.fn(async () => ({} as RunRecord)),
    }),
  };
}

describe("vault command", () => {
  test("buildProgram registers vault in top-level help", () => {
    const program = buildProgram();
    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain("vault");
  });

  test("vault put dry-run prints machine-readable output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "put",
      "--type",
      "project",
      "--project",
      "calyx",
      "--title",
      "Calyx",
      "--dry-run",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      relativePath: string;
      type: string;
      dryRun: boolean;
    };
    expect(payload.relativePath).toBe("50-projects/calyx/README.md");
    expect(payload.type).toBe("project");
    expect(payload.dryRun).toBe(true);
  });

  test("vault put still requires --title even with a positional file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "vault",
        "put",
        "--type",
        "context",
        "notes.md",
      ]),
    ).rejects.toMatchObject({
      message: "[calyx vault put] --title is required.",
      exitCode: 2,
    });
  });

  test("vault fetch prints bounded machine-readable vault context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "40-context", "source.md"),
      "---\ntitle: Source\nissue: POL-1516\n---\n# Source\n[[target]]\n",
      "utf8",
    );
    await writeFile(path.join(vaultPath, "40-context", "target.md"), "# Target\n", "utf8");
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "fetch",
      "vault://fieldwork/40-context/source.md",
      "--with-frontmatter",
      "--with-links",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      vaultUri: string;
      frontmatter?: Record<string, unknown>;
      links?: { outbound: Array<{ resolvedVaultUri?: string }> };
    };
    expect(payload.schema_version).toBe("calyx.vault.fetch/v1");
    expect(payload.vaultUri).toBe("vault://fieldwork/40-context/source.md");
    expect(payload.frontmatter).toMatchObject({ issue: "POL-1516" });
    expect(payload.links?.outbound[0]?.resolvedVaultUri).toBe("vault://fieldwork/40-context/target.md");
  });

  test("vault related prints same-issue machine-readable results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(path.join(vaultPath, "40-context", "source.md"), "---\nissue: POL-1516\n---\n# Source\n", "utf8");
    await writeFile(path.join(vaultPath, "40-context", "target.md"), "---\nissue: POL-1516\n---\n# Target\n", "utf8");
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "related",
      "40-context/source.md",
      "--relation",
      "same-issue",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      results: Array<{ vaultUri: string; relation: string }>;
    };
    expect(payload.schema_version).toBe("calyx.vault.related/v1");
    expect(payload.results).toEqual([
      expect.objectContaining({
        vaultUri: "vault://fieldwork/40-context/target.md",
        relation: "same-issue",
      }),
    ]);
  });

  test("vault toc and section get print machine-readable markdown slices", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const notePath = path.join(vaultPath, "50-projects", "calyx", "README.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "# Calyx",
        "",
        "Intro.",
        "",
        "## Current Plan",
        "",
        "Read-only primitives first.",
        "",
        "## Later",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "toc",
      "50-projects/calyx/README.md",
      "--json",
    ]);

    const tocPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      headings: Array<{ id: string; text: string }>;
    };
    expect(tocPayload.headings.map((heading) => heading.id)).toEqual(["calyx", "current-plan", "later"]);

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "section",
      "get",
      "50-projects/calyx/README.md",
      "--heading",
      "current-plan",
      "--max-chars",
      "64",
      "--json",
    ]);

    const sectionPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      content: string;
      heading: { id: string };
    };
    expect(sectionPayload.heading.id).toBe("current-plan");
    expect(sectionPayload.content).toContain("Read-only primitives first.");
    expect(sectionPayload.content).not.toContain("## Later");
  });

  test("vault frontmatter get and query print machine-readable provenance rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const workstreams = path.join(vaultPath, "50-projects", "calyx", "workstreams");
    await mkdir(workstreams, { recursive: true });
    await writeFile(
      path.join(workstreams, "focus.md"),
      [
        "---",
        "type: workstream",
        "project: calyx",
        "attention: focus",
        "---",
        "# Focus",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "frontmatter",
      "get",
      "50-projects/calyx/workstreams/focus.md",
      "--json",
    ]);

    const getPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      frontmatter: { type: string; attention: string };
    };
    expect(getPayload.frontmatter.type).toBe("workstream");
    expect(getPayload.frontmatter.attention).toBe("focus");

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "frontmatter",
      "query",
      "--type",
      "workstream",
      "--where",
      'attention == "focus"',
      "--limit",
      "5",
      "--json",
    ]);

    const queryPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      rows: Array<{ relative_path: string; matched_fields: Array<{ field: string }> }>;
    };
    expect(queryPayload.rows).toHaveLength(1);
    expect(queryPayload.rows[0]?.relative_path).toBe("50-projects/calyx/workstreams/focus.md");
    expect(queryPayload.rows[0]?.matched_fields.map((field) => field.field)).toEqual(["type", "attention"]);
  });

  test("vault close-out scaffolds current activity lineage and stamps freshness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;
    process.env["CODEX_THREAD_ID"] = "session-1";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildVaultActivityDeps() });

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "close-out",
      "--parent",
      "interactive:claude:parent-1",
      "--spawned-by",
      "[[10-daily/2026-06-20/handoff]]",
      "--slug",
      "pol-1847-review",
      "--title",
      "POL-1847 provenance helpers",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      relative_path: string;
      wikilink: string;
      slug: string;
      title: string;
      activity: { activity_id: string; author: string; created: string };
      lineage: { parent_session: string; spawned_by: string };
      stamp?: { fields: Array<{ field: string }> };
    };
    expect(payload.schema_version).toBe("calyx.vault.close-out/v1");
    expect(payload.relative_path).toBe("10-daily/2026-06-20/session-closeout-pol-1847-review.md");
    expect(payload.wikilink).toBe("[[10-daily/2026-06-20/session-closeout-pol-1847-review]]");
    expect(payload.slug).toBe("pol-1847-review");
    expect(payload.title).toBe("Session close-out: POL-1847 provenance helpers");
    expect(payload.activity).toMatchObject({
      activity_id: "interactive:codex:session-1",
      author: "codex:blade:session-1",
      created: "2026-06-20T21:00:00.000Z",
    });
    expect(payload.lineage).toEqual({
      parent_session: "interactive:claude:parent-1",
      spawned_by: "[[10-daily/2026-06-20/handoff]]",
    });
    expect(payload.stamp?.fields.map((field) => field.field)).toEqual(["updated", "updated_by"]);

    const closeOut = await readFile(path.join(vaultPath, ...payload.relative_path.split("/")), "utf8");
    expect(closeOut).toContain("type: report");
    expect(closeOut).toContain("subtype: session-closeout");
    expect(closeOut).toContain("status: final");
    expect(closeOut).toContain("tags:");
    expect(closeOut).toContain("- closeout");
    expect(closeOut).toContain("related: []");
    expect(closeOut).toContain("related_issues: []");
    expect(closeOut).toContain("# Session close-out: POL-1847 provenance helpers");
    expect(closeOut).toContain("session: interactive:codex:session-1");
    expect(closeOut).toContain("parent_session: interactive:claude:parent-1");
    expect(closeOut).toContain("spawned_by: \"[[10-daily/2026-06-20/handoff]]\"");
    expect(closeOut).toContain("updated_by: codex:blade:session-1");
  });

  test("vault close-out derives a meaningful slug from title when cwd is generic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;
    process.env["CODEX_THREAD_ID"] = "session-1";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: buildVaultActivityDeps({
        activity: makeInteractiveActivity({ cwd: "/Users/caleb/dev/linnaeus" }),
      }),
    });

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "close-out",
      "--title",
      "POL-1847 review runway",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      relative_path: string;
      slug: string;
      title: string;
    };
    expect(payload.relative_path).toBe("10-daily/2026-06-20/session-closeout-pol-1847-review-runway.md");
    expect(payload.slug).toBe("pol-1847-review-runway");
    expect(payload.title).toBe("Session close-out: POL-1847 review runway");
  });

  test("vault close-out anchors to the activity timestamp's local date", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    process.env["VAULT_PATH"] = vaultPath;
    process.env["CODEX_THREAD_ID"] = "session-1";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: buildVaultActivityDeps({
        activity: makeInteractiveActivity({
          created_at: "2026-06-20T21:00:00-05:00",
          updated_at: "2026-06-21T02:00:00.000Z",
        }),
      }),
    });

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "close-out",
      "--title",
      "late local session",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      anchor_date: string;
      relative_path: string;
    };
    expect(payload.anchor_date).toBe("2026-06-20");
    expect(payload.relative_path).toBe("10-daily/2026-06-20/session-closeout-late-local-session.md");
  });

  test("vault radar-receipt appends a Session Receipt through the weekly journal contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const closeOutPath = path.join(vaultPath, "10-daily", "2026-06-20", "session-closeout-pol-1847.md");
    const radarPath = path.join(vaultPath, "10-daily", "_weekly", "2026-W25", "README.md");
    await mkdir(path.dirname(closeOutPath), { recursive: true });
    await mkdir(path.dirname(radarPath), { recursive: true });
    await writeFile(
      closeOutPath,
      [
        "---",
        "type: report",
        "subtype: session-closeout",
        "session: interactive:codex:session-1",
        "author: codex:blade:session-1",
        "---",
        "",
        "# Session close-out: pol-1847",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      radarPath,
      [
        "---",
        "journal:",
        "  order: newest-first",
        "  sections:",
        "    Session Receipts:",
        "      kind: bullet",
        "      order: newest-first",
        "      bullet: \"- **{date} -- {title}** {body}\"",
        "      continuation_indent: \"  \"",
        "---",
        "",
        "# Weekly",
        "",
        "## Session Receipts",
        "",
        "- **2026-06-20 -- Existing** body",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;
    process.env["CODEX_THREAD_ID"] = "session-1";

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildVaultActivityDeps() });

    await program.parseAsync(["node", "calyx", "vault", "radar-receipt", "--week", "2026-W25", "--json"]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      week: string;
      close_out: { wikilink: string };
      append: { schema_version: string; changed: boolean };
    };
    expect(payload.schema_version).toBe("calyx.vault.radar-receipt/v1");
    expect(payload.week).toBe("2026-W25");
    expect(payload.close_out.wikilink).toBe("[[10-daily/2026-06-20/session-closeout-pol-1847|close-out]]");
    expect(payload.append).toMatchObject({ schema_version: "calyx.vault.journal-append/v1", changed: true });

    const radar = await readFile(radarPath, "utf8");
    expect(radar).toContain("- **2026-06-21 -- Session Receipt: pol-1847**");
    expect(radar).toContain("activity `interactive:codex:session-1`");
    expect(radar).toContain("close-out [[10-daily/2026-06-20/session-closeout-pol-1847|close-out]]");
  });

  test("vault lineage-check flags prose spawned_by and unresolvable parent_session as JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const notePath = path.join(vaultPath, "10-daily", "2026-06-20", "session-closeout-bad.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "---",
        "type: report",
        "subtype: session-closeout",
        "session: interactive:codex:session-1",
        "parent_session: interactive:claude:missing",
        "spawned_by: spawned by Caleb in chat",
        "---",
        "",
        "# Session close-out: bad",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({
      runCli: buildVaultActivityDeps({ unresolvedParents: ["interactive:claude:missing"] }),
    });

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "lineage-check",
      "10-daily/2026-06-20/session-closeout-bad.md",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      ok: boolean;
      findings: Array<{ code: string; field: string; severity: string }>;
    };
    expect(payload.schema_version).toBe("calyx.vault.lineage-check/v1");
    expect(payload.ok).toBe(false);
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "parent_session_unresolved", field: "parent_session", severity: "error" }),
        expect.objectContaining({ code: "spawned_by_prose", field: "spawned_by", severity: "error" }),
      ]),
    );
    expect(process.exitCode).toBe(1);
  });

  test("vault lineage-check requires a dereferenceable session id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const notePath = path.join(vaultPath, "10-daily", "2026-06-20", "session-closeout-missing-session.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "---",
        "type: report",
        "subtype: session-closeout",
        "spawned_by: \"[[10-daily/2026-06-20/handoff]]\"",
        "---",
        "",
        "# Session close-out: missing session",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram({ runCli: buildVaultActivityDeps() });

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "lineage-check",
      "10-daily/2026-06-20/session-closeout-missing-session.md",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      findings: Array<{ code: string; field: string; severity: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.findings).toEqual([
      expect.objectContaining({ code: "session_missing", field: "session", severity: "error" }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("vault footnotes list/get and fetch --footnotes collapsed round-trip the recall ladder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "40-context", "host.md"),
      [
        "# Host",
        "",
        "Spine fact with lineage[^arc].",
        "",
        "## Footnotes",
        "",
        "[^arc]: ARC hardening history.",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "vault", "footnotes", "list", "40-context/host.md", "--json"]);
    const listPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      footnotes: Array<{ key: string; ref_count: number }>;
      receipt: { recall_confidence: string };
    };
    expect(listPayload.schema_version).toBe("calyx.vault.footnotes-list/v1");
    expect(listPayload.footnotes).toEqual([expect.objectContaining({ key: "arc", ref_count: 1 })]);
    expect(listPayload.receipt.recall_confidence).toBe("high");

    await program.parseAsync(["node", "calyx", "vault", "footnotes", "get", "40-context/host.md", "arc", "--json"]);
    const getPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      footnotes: Array<{ key: string; body: string }>;
    };
    expect(getPayload.footnotes[0]?.body).toBe("ARC hardening history.");

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "fetch",
      "40-context/host.md",
      "--footnotes",
      "collapsed",
      "--json",
    ]);
    const fetchPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      text: string;
      footnotes?: { mode: string; collapsed_keys: string[] };
    };
    expect(fetchPayload.footnotes?.mode).toBe("collapsed");
    expect(fetchPayload.footnotes?.collapsed_keys).toEqual(["arc"]);
    expect(fetchPayload.text).toContain("calyx vault footnotes get 40-context/host.md arc");
  });

  test("vault journal entries/get print machine-readable journal receipts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "90-meta"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "90-meta", "meta-log.md"),
      [
        "# Meta Log",
        "",
        "> Entry format. Newest at the top.",
        "",
        "## 2026-06-12 -- Shipped",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "vault", "journal", "entries", "90-meta/meta-log.md", "--json"]);
    const entriesPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      entries: Array<{ key: string }>;
      receipt: { order_source: string };
    };
    expect(entriesPayload.schema_version).toBe("calyx.vault.journal-entries/v1");
    expect(entriesPayload.entries[0]?.key).toBe("2026-06-12/shipped");
    expect(entriesPayload.receipt.order_source).toBe("prose-hint");

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "journal",
      "get",
      "90-meta/meta-log.md",
      "2026-06-12/shipped",
      "--json",
    ]);
    const getPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      entry: { body: string };
    };
    expect(getPayload.schema_version).toBe("calyx.vault.journal-get/v1");
    expect(getPayload.entry.body).toContain("Body.");
  });

  test("vault journal append blocked human dry-run prints pasteable contract without writing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    const notePath = path.join(vaultPath, "40-context", "mixed.md");
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(
      notePath,
      [
        "# Mixed",
        "",
        "## 2026-06-12 -- Newer",
        "",
        "Newer.",
        "",
        "## 2026-06-10 -- Older",
        "",
        "Older.",
        "",
        "## 2026-06-11 -- Import",
        "",
        "Import.",
        "",
      ].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "journal",
      "append",
      "40-context/mixed.md",
      "--title",
      "Blocked",
      "--body",
      "Body",
      "--dry-run",
    ]);

    expect(String(out.mock.calls.at(-1)?.[0])).toContain("journal:\n  order:");
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("dry-run only; no write");
    expect(await readFile(notePath, "utf8")).not.toContain("Blocked");
  });

  test("vault footnotes add inserts at an anchor and stamp refreshes frontmatter with a byte-identical body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    const notePath = path.join(vaultPath, "40-context", "host.md");
    await writeFile(
      notePath,
      ["---", "type: context", "updated: 2026-01-01", "---", "", "# Host", "", "A spine fact.", ""].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "footnotes",
      "add",
      "40-context/host.md",
      "--key",
      "why",
      "--anchor",
      "A spine fact",
      "--body",
      "The lineage detail.",
      "--json",
    ]);
    const addPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      footnotes_block_created: boolean;
    };
    expect(addPayload.schema_version).toBe("calyx.vault.footnotes-add/v1");
    expect(addPayload.footnotes_block_created).toBe(true);

    const afterAdd = await readFile(notePath, "utf8");
    expect(afterAdd).toContain("A spine fact[^why].");
    expect(afterAdd).toContain("[^why]: The lineage detail.");
    const bodyAfterAdd = afterAdd.slice(afterAdd.indexOf("\n# Host"));

    await program.parseAsync([
      "node",
      "calyx",
      "vault",
      "stamp",
      "40-context/host.md",
      "--updated-by",
      "tester:cli",
      "--json",
    ]);
    const stampPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      changed: boolean;
      body_unchanged: boolean;
      fields: Array<{ field: string; value: string }>;
    };
    expect(stampPayload.schema_version).toBe("calyx.vault.stamp/v1");
    expect(stampPayload.changed).toBe(true);
    expect(stampPayload.body_unchanged).toBe(true);
    expect(stampPayload.fields.map((field) => field.field)).toEqual(["updated", "updated_by"]);

    const afterStamp = await readFile(notePath, "utf8");
    expect(afterStamp).toContain("updated_by: tester:cli");
    expect(afterStamp.slice(afterStamp.indexOf("\n# Host"))).toBe(bodyAfterAdd);
  });

  test("vault footnotes lint reports findings and metrics as JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-cli-"));
    tempDirs.push(root);
    const vaultPath = path.join(root, "vault");
    await mkdir(path.join(vaultPath, "40-context"), { recursive: true });
    await writeFile(
      path.join(vaultPath, "40-context", "untidy.md"),
      ["# U", "", "dangling[^ghost]", "", "## Footnotes", "", "[^lonely]: orphan body.", ""].join("\n"),
      "utf8",
    );
    process.env["VAULT_PATH"] = vaultPath;

    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "vault", "footnotes", "lint", "40-context/untidy.md", "--json"]);
    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      schema_version: string;
      findings: Array<{ code: string; key?: string }>;
      metrics: { footnote_share: number };
    };
    expect(payload.schema_version).toBe("calyx.vault.footnotes-lint/v1");
    expect(payload.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["dangling-reference", "orphaned-definition"]),
    );
    expect(payload.metrics.footnote_share).toBeGreaterThan(0);
  });
});
