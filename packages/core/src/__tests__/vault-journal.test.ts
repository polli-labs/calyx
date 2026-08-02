import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendVaultJournalEntry,
  getVaultJournalEntry,
  listVaultJournalEntries,
} from "../vault";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createTempVault(): Promise<{ root: string; vaultPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-journal-test-"));
  tempDirs.push(root);
  const vaultPath = path.join(root, "vault");
  await mkdir(vaultPath, { recursive: true });
  return { root, vaultPath };
}

async function writeNote(vaultPath: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = path.join(vaultPath, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

const CONTRACTED_NEWEST_FIRST = [
  "---",
  "type: meta-log",
  "updated: 2026-01-01",
  "journal:",
  "  order: newest-first",
  "  entry:",
  "    kind: heading",
  "    heading: \"## {date} -- {title}\"",
  "    fields:",
  "      - Type",
  "      - Author",
  "---",
  "",
  "# Log",
  "",
  "## 2026-06-12 -- Latest",
  "",
  "**Type:** maintenance",
  "**Author:** tester",
  "",
  "Latest body.",
  "",
  "## 2026-06-10 -- Older",
  "",
  "Older body.",
  "",
].join("\n");

describe("vault journal entries", () => {
  test("uses prose/header order hints over mixed historical heading order", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "90-meta/meta-log.md",
      [
        "# Vault Meta Log",
        "",
        "> **Entry format.** Newest at the top. Each entry gets a `## YYYY-MM-DD -- <slug>` heading.",
        "",
        "## 2026-06-12 -- Latest",
        "",
        "Latest body.",
        "",
        "## 2026-06-10 -- Older",
        "",
        "Older body.",
        "",
        "## 2026-06-11 -- Middle tail",
        "",
        "Historical import made the tail mixed.",
        "",
      ].join("\n"),
    );

    const result = await listVaultJournalEntries("90-meta/meta-log.md", { vaultPath });

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ key: "2026-06-12/latest", kind: "heading" });
    expect(result.receipt).toMatchObject({
      order: "newest-first",
      order_source: "prose-hint",
      recall_confidence: "medium",
      append_supported: true,
    });
    expect(result.receipt.guard_hits).toContain("declared-order-overrode-mixed-inference");
  });

  test("blocks mixed maintenance logs without a journal contract and emits a suggested contract on dry-run", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "40-context/fleet-systems/blade-maintenance-log.md",
      [
        "# Blade Maintenance Log",
        "",
        "## 2026-06-10 -- GPU probe",
        "",
        "Probe body.",
        "",
        "## 2026-05-01 -- Older",
        "",
        "Older body.",
        "",
        "## 2026-06-09 -- Import tail",
        "",
        "Mixed body.",
        "",
      ].join("\n"),
    );

    const entries = await listVaultJournalEntries("40-context/fleet-systems/blade-maintenance-log.md", { vaultPath });
    expect(entries.receipt).toMatchObject({
      order: "mixed",
      recall_confidence: "low",
      append_supported: false,
    });
    expect(entries.receipt.append_blockers).toEqual(
      expect.arrayContaining(["missing-journal-contract", "mixed-dated-entry-order"]),
    );

    const dryRun = await appendVaultJournalEntry(
      "40-context/fleet-systems/blade-maintenance-log.md",
      { title: "New entry", body: "Body", dryRun: true, vaultPath },
      { now: new Date("2026-06-12T12:00:00Z") },
    );
    expect(dryRun.changed).toBe(false);
    expect(dryRun.suggested_contract?.journal.entry?.kind).toBe("heading");
  });

  test("parses session-bus FROM headings and disambiguates same-day keys", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "50-projects/ibrida/buses/active/two-way.md",
      [
        "# Bus",
        "",
        "## FROM codex:blade - 2026-04-21 - Dataset pass",
        "",
        "First.",
        "",
        "## FROM claude:worm - 2026-04-21 - Dataset pass",
        "",
        "Second.",
        "",
        "## FROM codex:blade - 2026-04-22 - Handoff",
        "",
        "Third.",
        "",
      ].join("\n"),
    );

    const entries = await listVaultJournalEntries("50-projects/ibrida/buses/active/two-way.md", { vaultPath });
    expect(entries.receipt.heading_patterns).toEqual(["hash-from-agent-date-topic"]);
    expect(entries.receipt.same_day_collisions).toEqual([
      {
        date: "2026-04-21",
        count: 2,
        keys: ["2026-04-21/dataset-pass", "2026-04-21/dataset-pass:2"],
      },
    ]);

    const second = await getVaultJournalEntry("50-projects/ibrida/buses/active/two-way.md", {
      key: "2026-04-21:2",
      vaultPath,
    });
    expect(second.entry.body).toContain("Second.");
  });

  test("indexes W24-style bullet sections and read-only table rows without merging sections into the default stream", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "10-daily/_weekly/2026-W24/README.md",
      [
        "# Weekly Radar",
        "",
        "## Parking Ledger",
        "",
        "| Date | Thread | Parked Until | Reason |",
        "| --- | --- | --- | --- |",
        "| 2026-06-09 | Calyx relaunch | Later | Freshened |",
        "| 2026-06-11 | WFC v4 vision | Static cutover | Deliberate |",
        "",
        "## Session Receipts",
        "",
        "- **2026-06-11 -- POL-1763 shipped** first receipt",
        "  continuation line",
        "- **2026-06-11 -- context-note altitude** second receipt",
        "- **2026-06-12 -- session ritual encoded** third receipt",
        "",
      ].join("\n"),
    );

    const topLevel = await listVaultJournalEntries("10-daily/_weekly/2026-W24/README.md", { vaultPath });
    expect(topLevel.entries).toEqual([]);
    expect(topLevel.sections.map((section) => [section.heading_id, section.kind])).toEqual(
      expect.arrayContaining([
        ["parking-ledger", "table_row"],
        ["session-receipts", "bullet"],
      ]),
    );

    const receipts = await listVaultJournalEntries("10-daily/_weekly/2026-W24/README.md", {
      section: "Session Receipts",
      vaultPath,
    });
    expect(receipts.entries.map((entry) => entry.key)).toEqual([
      "2026-06-11/pol-1763-shipped",
      "2026-06-11/context-note-altitude",
      "2026-06-12/session-ritual-encoded",
    ]);
    expect(receipts.receipt.same_day_collisions[0]?.date).toBe("2026-06-11");

    const table = await listVaultJournalEntries("10-daily/_weekly/2026-W24/README.md", {
      section: "Parking Ledger",
      kind: "table-row",
      vaultPath,
    });
    expect(table.entries[0]).toMatchObject({ kind: "table_row", date: "2026-06-09" });
    expect(table.receipt.append_supported).toBe(false);
    expect(table.receipt.append_blockers).toContain("unsupported-entry-kind");
  });

  test("malformed table rows degrade confidence instead of crashing", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "50-projects/calyx/workstreams/active/skill-curriculum-update-queue.md",
      [
        "# Queue",
        "",
        "## Queue",
        "",
        "| Brief | Target skill | Status | Notes |",
        "|---|---|---|---|",
        "| Good | `fieldwork` | Landed | ok |",
        "| Bad | `orchestrate` | Queued | has | unescaped pipe |",
        "",
      ].join("\n"),
    );

    const result = await listVaultJournalEntries("50-projects/calyx/workstreams/active/skill-curriculum-update-queue.md", {
      section: "Queue",
      kind: "table-row",
      vaultPath,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.receipt.recall_confidence).toBe("low");
    expect(result.receipt.ambiguous_spans[0]?.reason).toContain("expected 4");
  });
});

describe("vault journal get", () => {
  test("supports key forms and long-body range/head-tail projection", async () => {
    const { vaultPath } = await createTempVault();
    const longBody = "x".repeat(200);
    await writeNote(
      vaultPath,
      "90-meta/meta-log.md",
      [
        "# Log",
        "",
        "## 2026-06-12 -- Same",
        "",
        "First body.",
        "",
        "## 2026-06-12 -- Same",
        "",
        longBody,
        "",
      ].join("\n"),
    );

    const bySlugOrdinal = await getVaultJournalEntry("90-meta/meta-log.md", {
      key: "2026-06-12/same:2",
      maxChars: 80,
      vaultPath,
    });
    expect(bySlugOrdinal.entry.truncated).toBe(true);
    expect(bySlugOrdinal.entry.body).toContain("calyx vault journal get 90-meta/meta-log.md 2026-06-12/same:2 --range");

    const byDateOrdinal = await getVaultJournalEntry("90-meta/meta-log.md", {
      key: "2026-06-12:1",
      range: "0:20",
      vaultPath,
    });
    expect(byDateOrdinal.entry.body).toBe("## 2026-06-12 -- Sam");

    await expect(getVaultJournalEntry("90-meta/meta-log.md", { key: "missing", vaultPath })).rejects.toMatchObject({
      exitCode: 3,
    });
  });
});

describe("vault journal append", () => {
  test("appends newest-first heading entries at the write position, flags backdates, and stamps frontmatter", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(vaultPath, "90-meta/meta-log.md", CONTRACTED_NEWEST_FIRST);

    const result = await appendVaultJournalEntry(
      "90-meta/meta-log.md",
      {
        title: "Backdated",
        date: "2026-06-01",
        body: "Backdated body.",
        fields: { Type: "maintenance", Author: "tester" },
        vaultPath,
      },
      {
        env: { USER: "tester" },
        hostnameImpl: () => "blade",
        now: new Date("2026-06-12T12:00:00Z"),
      },
    );

    expect(result.changed).toBe(true);
    expect(result.date_out_of_order).toBe(true);
    expect(result.insertion).toMatchObject({ kind: "heading", order: "newest-first", retry_count: 0 });
    expect(result.stamped?.fields.map((field) => field.field)).toEqual(["updated", "updated_by"]);

    const after = await readFile(notePath, "utf8");
    expect(after.indexOf("## 2026-06-01 -- Backdated")).toBeLessThan(after.indexOf("## 2026-06-12 -- Latest"));
    expect(after).toContain("updated_by: tester");
  });

  test("uses Codex Desktop thread identity for default author fields and stamp", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(vaultPath, "90-meta/meta-log.md", CONTRACTED_NEWEST_FIRST);

    const result = await appendVaultJournalEntry(
      "90-meta/meta-log.md",
      {
        title: "Codex-authored entry",
        date: "2026-06-27",
        body: "Body.",
        fields: { Type: "maintenance" },
        vaultPath,
      },
      {
        env: {
          CODEX_THREAD_ID: "019f065c-0edb-7f40-9f5f-9bb1d6eb1d12",
          USER: "caleb",
        } as NodeJS.ProcessEnv,
        hostnameImpl: () => "Calebs-MacBook-Air-2.local",
        now: new Date("2026-06-27T00:00:00Z"),
      },
    );

    expect(result.stamped?.fields).toEqual(
      expect.arrayContaining([
        {
          field: "updated_by",
          previous: null,
          value: "codex:calebs-macbook-air-2:019f065c-0edb-7f40-9f5f-9bb1d6eb1d12",
        },
      ]),
    );

    const after = await readFile(notePath, "utf8");
    expect(after).toContain("**Author:** codex:calebs-macbook-air-2:019f065c-0edb-7f40-9f5f-9bb1d6eb1d12");
    expect(after).toContain("updated_by: codex:calebs-macbook-air-2:019f065c-0edb-7f40-9f5f-9bb1d6eb1d12");
  });

  test("appends the first entry of an empty contracted log after the header block", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(
      vaultPath,
      "40-context/fleet-systems/new-host-maintenance-log.md",
      [
        "---",
        "type: context",
        "journal:",
        "  order: newest-first",
        "  entry:",
        "    kind: heading",
        "    heading: \"## {date} -- {title}\"",
        "---",
        "",
        "# New Host Maintenance Log",
        "",
        "Header prose describing this log.",
        "",
      ].join("\n"),
    );

    const result = await appendVaultJournalEntry(
      "40-context/fleet-systems/new-host-maintenance-log.md",
      { title: "First entry", date: "2026-06-12", body: "First body.", vaultPath },
      { env: { USER: "tester" }, hostnameImpl: () => "blade", now: new Date("2026-06-12T12:00:00Z") },
    );

    expect(result.changed).toBe(true);
    expect(result.insertion).toMatchObject({ kind: "heading", order: "newest-first" });
    const after = await readFile(notePath, "utf8");
    expect(after.indexOf("# New Host Maintenance Log")).toBeLessThan(after.indexOf("## 2026-06-12 -- First entry"));
    expect(after.indexOf("Header prose describing this log.")).toBeLessThan(after.indexOf("## 2026-06-12 -- First entry"));
  });

  test("appends chronological heading entries at the tail with field skeletons", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(
      vaultPath,
      "40-context/fleet-systems/lmstudio-maintenance-log.md",
      CONTRACTED_NEWEST_FIRST.replace("order: newest-first", "order: chronological"),
    );

    const result = await appendVaultJournalEntry(
      "40-context/fleet-systems/lmstudio-maintenance-log.md",
      { title: "Tail", date: "2026-06-13", body: "Tail body.", fields: { Type: "maintenance" }, vaultPath },
      { now: new Date("2026-06-13T12:00:00Z"), env: { USER: "tester" }, hostnameImpl: () => "blade" },
    );

    expect(result.date_out_of_order).toBe(false);
    const after = await readFile(notePath, "utf8");
    expect(after.trimEnd().endsWith("Tail body.")).toBe(true);
    expect(after).toContain("**Type:** maintenance");
  });

  test("appends multiline bullet bodies with hanging continuation indent inside contracted sections", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(
      vaultPath,
      "10-daily/_weekly/2026-W24/README.md",
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
        "- **2026-06-12 -- Existing** body",
        "",
      ].join("\n"),
    );

    const result = await appendVaultJournalEntry(
      "10-daily/_weekly/2026-W24/README.md",
      { title: "New receipt", body: "first line\nsecond line", section: "Session Receipts", vaultPath },
      { now: new Date("2026-06-13T12:00:00Z"), env: { USER: "tester" }, hostnameImpl: () => "blade" },
    );

    expect(result.entry?.kind).toBe("bullet");
    const after = await readFile(notePath, "utf8");
    expect(after).toContain("- **2026-06-13 -- New receipt** first line\n  second line");
  });

  test("refuses table-row append and reports exit 2", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "10-daily/_weekly/2026-W24/README.md",
      [
        "---",
        "journal:",
        "  order: chronological",
        "  sections:",
        "    Parking Ledger:",
        "      kind: table-row",
        "      mode: read-only",
        "---",
        "",
        "# Weekly",
        "",
        "## Parking Ledger",
        "",
        "| Date | Thread |",
        "| --- | --- |",
        "| 2026-06-09 | Calyx |",
        "",
      ].join("\n"),
    );

    await expect(
      appendVaultJournalEntry(
        "10-daily/_weekly/2026-W24/README.md",
        { title: "Nope", section: "Parking Ledger", vaultPath },
      ),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  test("retries one content-hash conflict and then writes the rebuilt append", async () => {
    const { vaultPath } = await createTempVault();
    const notePath = await writeNote(vaultPath, "90-meta/meta-log.md", CONTRACTED_NEWEST_FIRST);
    const concurrent = CONTRACTED_NEWEST_FIRST.replace("## 2026-06-12 -- Latest", "## 2026-06-13 -- Concurrent\n\nConcurrent body.\n\n## 2026-06-12 -- Latest");
    const reads = [CONTRACTED_NEWEST_FIRST, concurrent, concurrent];
    let written = "";

    const result = await appendVaultJournalEntry(
      "90-meta/meta-log.md",
      { title: "Retry lands", body: "Retry body.", vaultPath },
      {
        now: new Date("2026-06-14T12:00:00Z"),
        env: { USER: "tester" },
        hostnameImpl: () => "blade",
        readFileImpl: (async () => reads.shift() ?? concurrent) as unknown as typeof readFile,
        writeFileImpl: async (_target, content) => {
          written = String(content);
          await writeFile(notePath, written, "utf8");
        },
      },
    );

    expect(result.insertion?.retry_count).toBe(1);
    expect(written).toContain("## 2026-06-14 -- Retry lands");
    expect(written).toContain("## 2026-06-13 -- Concurrent");
  });

  test("exits 5 when the second content-hash conflict also races", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "90-meta/meta-log.md", CONTRACTED_NEWEST_FIRST);
    const concurrent = CONTRACTED_NEWEST_FIRST.replace("Latest body.", "Concurrent body.");
    const secondConcurrent = CONTRACTED_NEWEST_FIRST.replace("Latest body.", "Second concurrent body.");
    const reads = [CONTRACTED_NEWEST_FIRST, concurrent, secondConcurrent];

    await expect(
      appendVaultJournalEntry(
        "90-meta/meta-log.md",
        { title: "Conflict", body: "Body.", vaultPath },
        {
          now: new Date("2026-06-14T12:00:00Z"),
          env: { USER: "tester" },
          hostnameImpl: () => "blade",
          readFileImpl: (async () => reads.shift() ?? secondConcurrent) as unknown as typeof readFile,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 5, code: "append-conflict" });
  });
});
