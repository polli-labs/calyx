import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addVaultFootnote,
  fetchVaultArtifact,
  gcVaultFootnotes,
  getVaultFootnotes,
  lintVaultFootnotes,
  listVaultFootnotes,
  stampVaultArtifact,
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
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-vault-footnotes-test-"));
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

const CANONICAL_NOTE = [
  "---",
  "type: context",
  "created: 2026-01-01",
  "author: tester",
  "updated: 2026-06-01",
  "last_probed: 2026-06-01",
  "tags: [fleet, test]",
  "---",
  "",
  "# Host Profile",
  "",
  "Current state line with lineage[^arc] and an upgrade note[^os].",
  "",
  "## Storage",
  "",
  "Re-probe:",
  "```",
  "zfs list",
  "[^fenced]: this is not a footnote definition",
  "```",
  "",
  "## Footnotes",
  "",
  "[^arc]: ARC capped detail with a nested reference[^nested].",
  "    Indented continuation line.",
  "",
  "[^os]: OS upgrade history.",
  "",
  "[^nested]: Nested-only footnote body.",
  "",
].join("\n");

const MESSY_NOTE = [
  "# Messy",
  "",
  "Numeric one[^1] and named[^alpha] and dangling[^ghost].",
  "Inline note^[quick inline body] here.",
  "",
  "[^1]: first numeric definition interleaved with prose.",
  "More prose after the definition.",
  "",
  "[^alpha]: alpha body one.",
  "",
  "[^alpha]: alpha body two (different).",
  "## Footnotes",
  "",
  "[^9]: orphan definition inside the block.",
  "",
].join("\n");

describe("listVaultFootnotes", () => {
  test("enumerates named footnotes with refs, previews, and a high-confidence receipt", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await listVaultFootnotes("40-context/host.md", { vaultPath });

    expect(result.schema_version).toBe("calyx.vault.footnotes-list/v1");
    expect(result.uri).toBe("vault://fieldwork/40-context/host.md");
    expect(result.block.present).toBe(true);
    expect(result.footnotes.map((footnote) => footnote.key)).toEqual(["arc", "os", "nested"]);

    const arc = result.footnotes.find((footnote) => footnote.key === "arc");
    expect(arc).toMatchObject({ kind: "named", ref_count: 1, in_block: true, orphaned: false, dangling: false });
    expect(arc?.preview).toContain("ARC capped detail");
    expect(arc?.body_chars).toBeGreaterThan(40);

    // nested is referenced only from arc's definition body: still referenced.
    const nested = result.footnotes.find((footnote) => footnote.key === "nested");
    expect(nested?.orphaned).toBe(false);
    expect(nested?.ref_count).toBe(1);

    expect(result.receipt.recall_confidence).toBe("low");
    expect(result.receipt.ambiguous_spans).toHaveLength(1);
    expect(result.receipt.ambiguous_spans[0]?.reason).toContain("code fence");
    expect(result.receipt.guard_hits).toContain("footnote-like-line-in-code-fence");
  });

  test("tolerates the slack cases: mixed keys, interleaved defs, dupes, dangling refs, inline footnotes, missing blank line", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/messy.md", MESSY_NOTE);

    const result = await listVaultFootnotes("40-context/messy.md", { vaultPath });

    const keys = result.footnotes.map((footnote) => footnote.key);
    expect(keys).toContain("1");
    expect(keys).toContain("alpha");
    expect(keys).toContain("ghost");
    expect(keys).toContain("9");
    expect(keys.some((key) => key.startsWith("inline:L"))).toBe(true);

    const numeric = result.footnotes.find((footnote) => footnote.key === "1");
    expect(numeric?.kind).toBe("numeric");
    const ghost = result.footnotes.find((footnote) => footnote.key === "ghost");
    expect(ghost).toMatchObject({ dangling: true, body_chars: 0 });
    const orphan = result.footnotes.find((footnote) => footnote.key === "9");
    expect(orphan?.orphaned).toBe(true);
    const alpha = result.footnotes.find((footnote) => footnote.key === "alpha");
    expect(alpha?.definition_count).toBe(2);

    expect(result.receipt).toMatchObject({
      recall_confidence: "medium",
      duplicate_definition_keys: ["alpha"],
      reference_only_keys: ["ghost"],
      definition_only_keys: ["9"],
      footnotes_block_present: true,
    });
    expect(result.receipt.definitions_outside_block).toBe(3);
    expect(result.receipt.inline_footnotes_found).toBe(1);
    expect(result.receipt.guard_hits).toEqual(
      expect.arrayContaining([
        "definitions-outside-block",
        "duplicate-definitions",
        "inline-footnotes",
        "missing-blank-line-before-block",
        "references-without-definition",
      ]),
    );
  });

  test("mid-line references followed by colons count as references (blade.md regression)", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "40-context/colon.md",
      [
        "# C",
        "",
        "**Mount topology**[^mounts]: datasets mount at /mango.",
        "",
        "## Footnotes",
        "",
        "[^mounts]: The pre-rewrite note listed wrong mountpoints.",
        "",
      ].join("\n"),
    );

    const result = await listVaultFootnotes("40-context/colon.md", { vaultPath });
    expect(result.footnotes).toEqual([
      expect.objectContaining({ key: "mounts", ref_count: 1, orphaned: false, dangling: false }),
    ]);
    expect(result.receipt.recall_confidence).toBe("high");
  });

  test("footnote-like tokens inside inline code spans are prose, not references", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "40-context/inline-code.md",
      [
        "# I",
        "",
        "Lineage is reached only via `[^key]` markers, like this real one[^real].",
        "",
        "## Footnotes",
        "",
        "[^real]: Actual body.",
        "",
      ].join("\n"),
    );

    const result = await listVaultFootnotes("40-context/inline-code.md", { vaultPath });
    expect(result.footnotes.map((footnote) => footnote.key)).toEqual(["real"]);
    expect(result.receipt.reference_only_keys).toEqual([]);
    expect(result.receipt.recall_confidence).toBe("high");
  });

  test("never crashes on malformed footnote markdown", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(
      vaultPath,
      "40-context/broken.md",
      "# Broken\n\n[^ ]: empty key-ish\n[^x: unterminated\n^[inline only\n[^]: nothing\n\n[^ok]: fine.\nref[^ok]\n",
    );

    const result = await listVaultFootnotes("40-context/broken.md", { vaultPath });
    expect(result.footnotes.some((footnote) => footnote.key === "ok")).toBe(true);
  });
});

describe("getVaultFootnotes", () => {
  test("returns full bodies by key and supports multiple keys", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await getVaultFootnotes("40-context/host.md", { keys: ["arc", "os"], vaultPath });

    expect(result.schema_version).toBe("calyx.vault.footnotes-get/v1");
    expect(result.footnotes).toHaveLength(2);
    expect(result.footnotes[0]?.body).toContain("Indented continuation line.");
    expect(result.footnotes[0]?.truncated).toBeUndefined();
    expect(result.footnotes[1]?.body).toBe("OS upgrade history.");
  });

  test("--range returns an exact slice with an integer text cursor", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await getVaultFootnotes("40-context/host.md", { keys: ["os"], range: "0:10", vaultPath });

    expect(result.footnotes[0]?.body).toBe("OS upgrade");
    expect(result.footnotes[0]?.truncated).toBe(true);
    expect(result.footnotes[0]?.text_cursor).toEqual({
      total_chars: 19,
      returned: [[0, 10]],
      next: 10,
    });
  });

  test("over-budget bodies project head+tail with a copyable --range elision marker", async () => {
    const { vaultPath } = await createTempVault();
    const longBody = "A".repeat(400) + "MIDDLE" + "B".repeat(400);
    await writeNote(
      vaultPath,
      "40-context/long.md",
      `# Long\n\nref[^big]\n\n## Footnotes\n\n[^big]: ${longBody}\n`,
    );

    const result = await getVaultFootnotes("40-context/long.md", { keys: ["big"], maxChars: 100, vaultPath });
    const footnote = result.footnotes[0];

    expect(footnote?.truncated).toBe(true);
    expect(footnote?.body).toMatch(
      /\[\.\.\. \d+ chars omitted \(chars \d+-\d+\) - calyx vault footnotes get 40-context\/long\.md big --range \d+:\d+\]/,
    );
    expect(footnote?.text_cursor?.total_chars).toBe(longBody.length);
    expect(footnote?.text_cursor?.returned).toHaveLength(2);
    expect(footnote?.text_cursor?.next).toBe(60);
  });

  test("unknown keys fail with exit 3 and the available key list", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    await expect(getVaultFootnotes("40-context/host.md", { keys: ["missing"], vaultPath })).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining("Available keys: arc, os, nested"),
    });
  });

  test("--range with more than one key is a usage error", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    await expect(
      getVaultFootnotes("40-context/host.md", { keys: ["arc", "os"], range: "0:5", vaultPath }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  test("out-of-bounds ranges fail loudly with the body bounds", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    await expect(
      getVaultFootnotes("40-context/host.md", { keys: ["os"], range: "0:9999", vaultPath }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("outside body bounds 0:19") });
  });
});

describe("fetchVaultArtifact --footnotes", () => {
  test("collapsed mode elides definitions behind in-band markers carrying footnotes get commands", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await fetchVaultArtifact("40-context/host.md", { footnotes: "collapsed", vaultPath });

    expect(result.footnotes?.mode).toBe("collapsed");
    expect(result.footnotes?.collapsed_keys).toEqual(["arc", "os", "nested"]);
    expect(result.footnotes?.elided_chars).toBeGreaterThan(0);
    expect(result.footnotes?.original_chars).toBe(CANONICAL_NOTE.length);
    // Markers add ~70 chars per ref, so tiny fixtures may not shrink; the
    // projection accounting is what matters (projected text is what returned).
    expect(result.footnotes?.projected_chars).toBe(result.text.length);

    expect(result.text).toMatch(
      /lineage\[\^arc: \d+ chars elided - calyx vault footnotes get 40-context\/host\.md arc\]/,
    );
    expect(result.text).toMatch(
      /\[\.\.\. 3 footnote definitions \(\d+ chars\) elided - calyx vault footnotes list 40-context\/host\.md\]/,
    );
    expect(result.text).not.toContain("ARC capped detail");
    expect(result.text).not.toContain("## Footnotes\n\n[^arc]");
    // The fenced pseudo-definition stays in the spine untouched.
    expect(result.text).toContain("[^fenced]: this is not a footnote definition");
  });

  test("default fetch is unchanged and expanded mode reports a receipt without projecting", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const plain = await fetchVaultArtifact("40-context/host.md", { vaultPath });
    expect(plain.footnotes).toBeUndefined();
    expect(plain.text).toContain("[^arc]: ARC capped detail");

    const expanded = await fetchVaultArtifact("40-context/host.md", { footnotes: "expanded", vaultPath });
    expect(expanded.footnotes?.mode).toBe("expanded");
    expect(expanded.footnotes?.collapsed_keys).toEqual([]);
    expect(expanded.text).toBe(plain.text);
  });

  test("the byte budget pays for the collapsed spine, not the original file", async () => {
    const { vaultPath } = await createTempVault();
    const bigFootnote = "x".repeat(8_000);
    await writeNote(
      vaultPath,
      "40-context/heavy.md",
      `# Heavy\n\nspine line[^h]\n\n## Footnotes\n\n[^h]: ${bigFootnote}\n`,
    );

    const result = await fetchVaultArtifact("40-context/heavy.md", {
      footnotes: "collapsed",
      maxBytes: 500,
      vaultPath,
    });

    expect(result.bytes.truncated).toBe(false);
    expect(result.bytes.totalBytes).toBeLessThan(500);
    expect(result.text).toContain("spine line[^h: 8000 chars elided");
  });

  test("dangling references stay intact in collapsed mode", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/dangle.md", "# D\n\nref[^ghost] here\n\n## Footnotes\n\n[^real]: body.\nref to real[^real]\n");

    const result = await fetchVaultArtifact("40-context/dangle.md", { footnotes: "collapsed", vaultPath });
    expect(result.text).toContain("ref[^ghost] here");
  });
});

describe("addVaultFootnote", () => {
  test("inserts a reference at a unique text anchor and appends the definition to the block", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await addVaultFootnote(
      "40-context/host.md",
      { key: "swap", anchor: "an upgrade note", body: "Swap history detail.\nSecond line.", vaultPath },
    );

    expect(result.dryRun).toBe(false);
    expect(result.footnotes_block_created).toBe(false);
    expect(result.receipt.definition_only_keys).toEqual([]);

    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("an upgrade note[^swap][^os]");
    expect(written).toContain("[^swap]: Swap history detail.\n    Second line.");
    // Definition landed inside the block, after the last existing definition.
    expect(written.indexOf("[^swap]: Swap")).toBeGreaterThan(written.indexOf("[^nested]: Nested-only"));

    const list = await listVaultFootnotes("40-context/host.md", { vaultPath });
    expect(list.footnotes.find((footnote) => footnote.key === "swap")).toMatchObject({
      ref_count: 1,
      orphaned: false,
      in_block: true,
    });
  });

  test("creates the ## Footnotes block when missing", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/bare.md", "# Bare\n\nA fact worth a receipt.\n");

    const result = await addVaultFootnote(
      "40-context/bare.md",
      { key: "receipt", anchor: "worth a receipt", body: "The receipt body.", vaultPath },
    );

    expect(result.footnotes_block_created).toBe(true);
    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("A fact worth a receipt[^receipt].");
    expect(written).toMatch(/## Footnotes\n\n\[\^receipt\]: The receipt body\.\n$/);
  });

  test("supports Obsidian block-id anchors", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/blocks.md", "# B\n\nImportant fact. ^fact1\n");

    await addVaultFootnote("40-context/blocks.md", { key: "why", anchor: "^fact1", body: "Why it matters.", vaultPath });

    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("Important fact.[^why] ^fact1");
  });

  test("refuses duplicate keys, ambiguous anchors, and missing anchors with typed errors", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);
    await writeNote(vaultPath, "40-context/ambiguous.md", "# A\n\nsame phrase\n\nsame phrase\n");

    await expect(
      addVaultFootnote("40-context/host.md", { key: "arc", anchor: "Current state", body: "x", vaultPath }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("already exists") });

    await expect(
      addVaultFootnote("40-context/ambiguous.md", { key: "k", anchor: "same phrase", body: "x", vaultPath }),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("ambiguous anchor: 2 matches") });

    await expect(
      addVaultFootnote("40-context/host.md", { key: "k", anchor: "no such anchor text", body: "x", vaultPath }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  test("--renumber renormalizes numeric keys in appearance order", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(
      vaultPath,
      "40-context/numeric.md",
      "# N\n\nfirst[^4] then second[^2]\n\n## Footnotes\n\n[^4]: four body.\n\n[^2]: two body.\n",
    );

    const result = await addVaultFootnote("40-context/numeric.md", {
      key: "named-new",
      anchor: "then second",
      body: "named body.",
      renumber: true,
      vaultPath,
    });

    expect(result.renumbered).toEqual(
      expect.arrayContaining([
        { from: "4", to: "1" },
        { from: "2", to: "2" },
      ].filter((entry) => entry.from !== entry.to)),
    );
    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("first[^1] then second[^named-new][^2]");
    expect(written).toContain("[^1]: four body.");
    expect(written).toContain("[^2]: two body.");
  });

  test("dry-run previews without writing", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await addVaultFootnote(
      "40-context/host.md",
      { key: "preview", anchor: "Current state line", body: "Preview body.", dryRun: true, vaultPath },
    );

    expect(result.dryRun).toBe(true);
    expect(result.content).toContain("[^preview]: Preview body.");
    expect(await readFile(absolutePath, "utf8")).toBe(CANONICAL_NOTE);
  });
});

describe("lintVaultFootnotes", () => {
  test("surfaces orphans, dangling refs, dupes, out-of-block defs, and inline footnotes", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/messy.md", MESSY_NOTE);

    const result = await lintVaultFootnotes("40-context/messy.md", { vaultPath });
    const codes = result.findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining([
        "orphaned-definition",
        "dangling-reference",
        "duplicate-definition",
        "definition-outside-block",
        "missing-blank-line-before-block",
        "inline-footnote",
      ]),
    );
    expect(result.findings.find((finding) => finding.code === "orphaned-definition")?.key).toBe("9");
    expect(result.findings.find((finding) => finding.code === "dangling-reference")?.key).toBe("ghost");
  });

  test("reports altitude metrics with staleness ages from frontmatter", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await lintVaultFootnotes(
      "40-context/host.md",
      { vaultPath },
      { now: new Date("2026-06-11T12:00:00Z") },
    );

    expect(result.metrics.footnote_block_lines).toBeGreaterThan(5);
    expect(result.metrics.spine_lines).toBeGreaterThan(0);
    expect(result.metrics.footnote_share).toBeGreaterThan(0);
    expect(result.metrics.footnote_share).toBeLessThan(1);
    expect(result.metrics.updated).toBe("2026-06-01");
    expect(result.metrics.days_since_updated).toBe(10);
    expect(result.metrics.days_since_last_probed).toBe(10);
  });
});

describe("gcVaultFootnotes", () => {
  test("relocates stray definitions into the block loss-lessly and keeps orphans by default", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/messy.md", MESSY_NOTE);

    const result = await gcVaultFootnotes("40-context/messy.md", { vaultPath });

    expect(result.changed).toBe(true);
    expect(result.actions.filter((action) => action.code === "relocated-definition")).toHaveLength(3);
    expect(result.actions.some((action) => action.code === "dropped-orphan")).toBe(false);

    const written = await readFile(absolutePath, "utf8");
    const blockStart = written.indexOf("## Footnotes");
    expect(blockStart).toBeGreaterThan(0);
    // Every definition now lives after the block heading; both duplicate alpha bodies survive.
    expect(written.indexOf("[^1]: first numeric")).toBeGreaterThan(blockStart);
    expect(written).toContain("[^alpha]: alpha body one.");
    expect(written).toContain("[^alpha]: alpha body two (different).");
    expect(written).toContain("[^9]: orphan definition inside the block.");
    expect(written).toContain("More prose after the definition.");

    const verify = await listVaultFootnotes("40-context/messy.md", { vaultPath });
    expect(verify.receipt.definitions_outside_block).toBe(0);
  });

  test("is idempotent: a second run reports no changes", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/messy.md", MESSY_NOTE);

    await gcVaultFootnotes("40-context/messy.md", { vaultPath });
    const second = await gcVaultFootnotes("40-context/messy.md", { vaultPath });

    expect(second.changed).toBe(false);
    expect(second.content_hash_after).toBe(second.content_hash_before);
  });

  test("dedupes exact duplicates and drops orphans only with the explicit flag", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(
      vaultPath,
      "40-context/dupes.md",
      "# D\n\nref[^a]\n\n## Footnotes\n\n[^a]: same body.\n\n[^a]: same body.\n\n[^lonely]: orphan body.\n",
    );

    const result = await gcVaultFootnotes("40-context/dupes.md", { dropOrphans: true, vaultPath });

    expect(result.actions.some((action) => action.code === "deduped-definition" && action.key === "a")).toBe(true);
    expect(result.actions.some((action) => action.code === "dropped-orphan" && action.key === "lonely")).toBe(true);

    const written = await readFile(absolutePath, "utf8");
    expect(written.match(/\[\^a\]: same body\./g)).toHaveLength(1);
    expect(written).not.toContain("[^lonely]");
  });

  test("dry-run previews the normalization without writing", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/messy.md", MESSY_NOTE);

    const result = await gcVaultFootnotes("40-context/messy.md", { dryRun: true, vaultPath });

    expect(result.changed).toBe(true);
    expect(result.content).toBeTruthy();
    expect(await readFile(absolutePath, "utf8")).toBe(MESSY_NOTE);
  });

  test("no-ops on a note without footnotes", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/plain.md", "# Plain\n\nNothing here.\n");

    const result = await gcVaultFootnotes("40-context/plain.md", { vaultPath });
    expect(result.changed).toBe(false);
    expect(result.actions).toEqual([]);
  });
});

describe("stampVaultArtifact", () => {
  const deps = {
    env: { CLAUDE_CODE_SESSION_ID: "abcdef1234567" } as NodeJS.ProcessEnv,
    hostnameImpl: () => "blade-test.local",
    now: new Date("2026-06-11T12:00:00Z"),
  };

  test("refreshes updated/updated_by and leaves the body byte-identical", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);
    const originalBody = CANONICAL_NOTE.slice(CANONICAL_NOTE.indexOf("---", 4) + 4);

    const result = await stampVaultArtifact("40-context/host.md", { vaultPath }, deps);

    expect(result.schema_version).toBe("calyx.vault.stamp/v1");
    expect(result.changed).toBe(true);
    expect(result.body_unchanged).toBe(true);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        { field: "updated", previous: "2026-06-01", value: "2026-06-11" },
        { field: "updated_by", previous: null, value: "claude:blade-test:abcdef1234567" },
      ]),
    );

    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("updated: 2026-06-11");
    expect(written).toContain("updated_by: claude:blade-test:abcdef1234567");
    // Untouched frontmatter lines keep their exact formatting.
    expect(written).toContain("tags: [fleet, test]");
    // Body is byte-identical.
    const writtenBody = written.slice(written.indexOf("---", 4) + 4);
    expect(writtenBody).toBe(originalBody);
  });

  test("prefers Codex Desktop thread identity over the shell user", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await stampVaultArtifact(
      "40-context/host.md",
      { vaultPath },
      {
        env: {
          CODEX_THREAD_ID: "019f065c-0edb-7f40-9f5f-9bb1d6eb1d12",
          USER: "caleb",
        } as NodeJS.ProcessEnv,
        hostnameImpl: () => "Calebs-MacBook-Air-2.local",
        now: new Date("2026-06-27T00:00:00Z"),
      },
    );

    expect(result.fields).toEqual(
      expect.arrayContaining([
        {
          field: "updated_by",
          previous: null,
          value: "codex:calebs-macbook-air-2:019f065c-0edb-7f40-9f5f-9bb1d6eb1d12",
        },
      ]),
    );
    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("updated_by: codex:calebs-macbook-air-2:019f065c-0edb-7f40-9f5f-9bb1d6eb1d12");
  });

  test("--last-probed and --field set additional staleness fields", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await stampVaultArtifact(
      "40-context/host.md",
      { lastProbed: "", fields: { reviewed: "2026-06-11" }, vaultPath },
      deps,
    );

    expect(result.fields).toEqual(
      expect.arrayContaining([
        { field: "last_probed", previous: "2026-06-01", value: "2026-06-11" },
        { field: "reviewed", previous: null, value: "2026-06-11" },
      ]),
    );
    const written = await readFile(absolutePath, "utf8");
    expect(written).toContain("last_probed: 2026-06-11");
    expect(written).toContain("reviewed: 2026-06-11");
  });

  test("refuses identity fields and multi-line frontmatter nodes", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);
    await writeNote(
      vaultPath,
      "40-context/multiline.md",
      "---\ntype: context\nrelated:\n  - one\n  - two\n---\n# M\n",
    );

    await expect(
      stampVaultArtifact("40-context/host.md", { fields: { created: "2020-01-01" }, vaultPath }, deps),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("identity field") });

    await expect(
      stampVaultArtifact("40-context/multiline.md", { fields: { related: "x" }, vaultPath }, deps),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("multi-line") });
  });

  test("creates frontmatter when missing, preserving the body exactly", async () => {
    const { vaultPath } = await createTempVault();
    const body = "# Bare note\n\nNo frontmatter here.\n";
    const absolutePath = await writeNote(vaultPath, "40-context/bare.md", body);

    const result = await stampVaultArtifact("40-context/bare.md", { vaultPath }, deps);

    expect(result.frontmatter_created).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "frontmatter_created")).toBe(true);
    const written = await readFile(absolutePath, "utf8");
    expect(written.startsWith("---\nupdated: 2026-06-11\nupdated_by: claude:blade-test:abcdef1234567\n---\n")).toBe(true);
    expect(written.endsWith(body)).toBe(true);
  });

  test("--dry-run prints the frontmatter diff without writing", async () => {
    const { vaultPath } = await createTempVault();
    const absolutePath = await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    const result = await stampVaultArtifact("40-context/host.md", { dryRun: true, vaultPath }, deps);

    expect(result.dryRun).toBe(true);
    expect(result.frontmatter_diff).toEqual(
      expect.arrayContaining(["-updated: 2026-06-01", "+updated: 2026-06-11"]),
    );
    expect(await readFile(absolutePath, "utf8")).toBe(CANONICAL_NOTE);
  });

  test("is idempotent when values are already current", async () => {
    const { vaultPath } = await createTempVault();
    await writeNote(vaultPath, "40-context/host.md", CANONICAL_NOTE);

    await stampVaultArtifact("40-context/host.md", { vaultPath }, deps);
    const second = await stampVaultArtifact("40-context/host.md", { vaultPath }, deps);

    expect(second.changed).toBe(false);
    expect(second.content_hash_after).toBe(second.content_hash_before);
  });
});
