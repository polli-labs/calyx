import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { observeCodexAutomations } from "../codex-automation-observer";
import { loadStateDriver } from "../state/driver";

interface DefinitionInput {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  rrule: string;
  cwds?: string[];
  prompt?: string;
}

interface ProjectionInput extends DefinitionInput {
  nextRunAt?: number | null;
  lastRunAt?: number | null;
}

interface MutableRegistryEntry {
  imported_source: { backend: string; id: string; sha256?: string };
  observed: { status?: string; schedule?: string; cwds?: string[] | null };
  decision_owner?: string;
  decision: { classification?: string; owner?: string; expires_at?: string };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function definitionToml(input: DefinitionInput): string {
  const cwds = input.cwds === undefined
    ? ""
    : `cwds = [${input.cwds.map((cwd) => JSON.stringify(cwd)).join(", ")}]\n`;
  return [
    "version = 1",
    `id = ${JSON.stringify(input.id)}`,
    'kind = "cron"',
    `name = ${JSON.stringify(input.name)}`,
    `prompt = ${JSON.stringify(input.prompt ?? `Observe ${input.id}.`)}`,
    `status = ${JSON.stringify(input.status)}`,
    `rrule = ${JSON.stringify(input.rrule)}`,
    cwds.trimEnd(),
    "created_at = 1",
    "updated_at = 1",
    "",
  ].filter((line, index, lines) => line.length > 0 || index === lines.length - 1).join("\n");
}

async function writeDefinition(codexHome: string, input: DefinitionInput): Promise<{ path: string; text: string }> {
  const automationPath = path.join(codexHome, "automations", input.id, "automation.toml");
  await mkdir(path.dirname(automationPath), { recursive: true });
  const text = definitionToml(input);
  await writeFile(automationPath, text, "utf8");
  return { path: automationPath, text };
}

async function writeProjectionDatabase(databasePath: string, rows: ProjectionInput[]): Promise<void> {
  const driver = await loadStateDriver();
  const db = driver.open(databasePath);
  try {
    db.exec(`CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      cwds TEXT NOT NULL,
      rrule TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const insert = db.prepare(`INSERT INTO automations
      (id, name, prompt, status, next_run_at, last_run_at, cwds, rrule, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
    for (const row of rows) {
      insert.run(
        row.id,
        row.name,
        `Observe ${row.id}.`,
        row.status,
        row.nextRunAt ?? null,
        row.lastRunAt ?? null,
        JSON.stringify(row.cwds ?? []),
        row.rrule,
      );
    }
  } finally {
    db.close();
  }
}

async function writeGovernance(
  governancePath: string,
  definitions: Array<DefinitionInput & { text: string }>,
): Promise<void> {
  const entry = (definition: DefinitionInput & { text: string }, classification?: string) => ({
    imported_source: {
      backend: "codex_app",
      id: definition.id,
      sha256: digest(definition.text),
    },
    observed: {
      status: definition.status,
      schedule: definition.rrule,
      cwds: definition.cwds ?? null,
    },
    decision_owner: "Fixture Owner",
    ...(classification
      ? { classification }
      : {
          decision: {
            classification: "explicit_time_bounded_exemption",
            owner: "Fixture Owner",
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
  });
  const active = definitions.filter((definition) => definition.status === "ACTIVE");
  const project = definitions.filter((definition) => definition.id.startsWith("brief-"));
  const residue = definitions.filter((definition) => definition.id.startsWith("wake-"));
  await writeFile(governancePath, YAML.stringify({
    version: 1,
    kind: "codex_desktop_automation_exemption_registry",
    owner: "polli-labs",
    decision_owner: "Fixture Owner",
    active_exemptions: active.map((definition) => entry(definition)),
    paused_project_bindings: project.map((definition) => entry(definition, "distinct_paused_project_binding")),
    paused_monitor_wake_residues: residue.map((definition) => entry(definition, "paused_monitor_wake_residue")),
  }), "utf8");
}

function validRegistryEntry(definition: DefinitionInput, text: string) {
  return {
    imported_source: {
      backend: "codex_app",
      id: definition.id,
      sha256: digest(text),
    },
    observed: {
      status: definition.status,
      schedule: definition.rrule,
      cwds: definition.cwds ?? null,
    },
    decision_owner: "Fixture Owner",
    decision: {
      classification: "explicit_time_bounded_exemption",
      owner: "Fixture Owner",
      expires_at: "2099-01-01T00:00:00Z",
    },
  };
}

function registry(activeExemptions: unknown[]) {
  return {
    version: 1,
    kind: "codex_desktop_automation_exemption_registry",
    owner: "polli-labs",
    decision_owner: "Fixture Owner",
    active_exemptions: activeExemptions,
    paused_project_bindings: [],
    paused_monitor_wake_residues: [],
  };
}

async function snapshot(paths: string[]): Promise<Array<{ path: string; digest: string; mtimeMs: number; size: number }>> {
  return await Promise.all(paths.map(async (filePath) => {
    const [text, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    return { path: filePath, digest: createHash("sha256").update(text).digest("hex"), mtimeMs: metadata.mtimeMs, size: metadata.size };
  }));
}

describe("observeCodexAutomations", () => {
  it("observes the 5 active + 4 distinct cwd + 2 projection-missing residue topology without writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-codex-observe-"));
    const codexHome = path.join(root, ".codex");
    const databasePath = path.join(root, "codex.db");
    const governancePath = path.join(root, "codex-governance.yaml");
    const definitions: DefinitionInput[] = [
      { id: "active-finite-a", name: "Finite A", status: "ACTIVE", rrule: "FREQ=MINUTELY;COUNT=1", cwds: [] },
      { id: "active-steady-a", name: "Steady A", status: "ACTIVE", rrule: "FREQ=HOURLY", cwds: [] },
      { id: "active-steady-b", name: "Steady B", status: "ACTIVE", rrule: "FREQ=DAILY", cwds: ["/repo/configs"] },
      { id: "active-steady-c", name: "Steady C", status: "ACTIVE", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=20", cwds: [] },
      { id: "active-finite-b", name: "Finite B", status: "ACTIVE", rrule: "FREQ=MINUTELY;INTERVAL=45;COUNT=1", cwds: [] },
      { id: "brief-dev", name: "Daily Brief", status: "PAUSED", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO", cwds: ["/dev"] },
      { id: "brief-repo", name: "Daily Brief", status: "PAUSED", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO", cwds: ["/repo"] },
      { id: "brief-agents", name: "Daily Brief", status: "PAUSED", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO", cwds: ["/.agents"] },
      { id: "brief-vault", name: "Daily Brief", status: "PAUSED", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO", cwds: ["/vault"] },
      { id: "wake-one", name: "wake-one", status: "PAUSED", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=1" },
      { id: "wake-two", name: "wake-two", status: "PAUSED", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=1" },
    ];
    const written = await Promise.all(definitions.map((definition) => writeDefinition(codexHome, definition)));
    await writeProjectionDatabase(databasePath, definitions.slice(0, 9).map((definition) => ({
      ...definition,
      ...(definition.id.startsWith("active-steady") ? { nextRunAt: 100, lastRunAt: 50 } : {}),
    })));
    await writeGovernance(governancePath, definitions.map((definition, index) => ({
      ...definition,
      text: written[index]!.text,
    })));
    const observedPaths = [...written.map((item) => item.path), databasePath, governancePath];
    const before = await snapshot(observedPaths);

    const first = await observeCodexAutomations({
      codexHome,
      codexDatabasePath: databasePath,
      governancePath,
      now: new Date("2026-07-21T20:30:00Z"),
    });
    const second = await observeCodexAutomations({
      codexHome,
      codexDatabasePath: databasePath,
      governancePath,
      now: new Date("2026-07-21T20:31:00Z"),
    });
    const after = await snapshot(observedPaths);

    expect(first.counts).toMatchObject({
      definitions: 11,
      active: 5,
      paused: 6,
      projection_observed: 9,
      projection_missing: 2,
      projection_drifted: 0,
    });
    expect(first.definition_authority).toBe("codex_toml");
    expect(first.mutation_authority).toBe("unavailable");
    expect(first.items.filter((item) => item.classifications.includes("finite_schedule_indeterminate"))).toHaveLength(2);
    expect(first.items.filter((item) => item.classifications.includes("distinct_project_binding"))).toHaveLength(4);
    expect(first.items.filter((item) => item.classifications.includes("duplicate"))).toHaveLength(0);
    expect(first.items.filter((item) => item.projection === "missing").map((item) => item.id)).toEqual(["wake-one", "wake-two"]);
    expect(second.items.map((item) => [item.id, item.definition_digest, item.projection])).toEqual(
      first.items.map((item) => [item.id, item.definition_digest, item.projection]),
    );
    expect(after).toEqual(before);
  });

  it("types definition/projection drift and exact duplicates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-codex-drift-"));
    const codexHome = path.join(root, ".codex");
    const databasePath = path.join(root, "codex.db");
    const first: DefinitionInput = { id: "first", name: "same", status: "ACTIVE", rrule: "FREQ=DAILY", cwds: ["/same"], prompt: "same prompt" };
    const second: DefinitionInput = { ...first, id: "second" };
    await writeDefinition(codexHome, first);
    await writeDefinition(codexHome, second);
    await writeProjectionDatabase(databasePath, [
      { ...first, status: "PAUSED" },
      second,
    ]);

    const result = await observeCodexAutomations({ codexHome, codexDatabasePath: databasePath });
    expect(result.items.find((item) => item.id === "first")?.projection).toBe("drifted");
    expect(result.items.find((item) => item.id === "first")?.classifications).toContain("definition_projection_drift");
    expect(result.items.find((item) => item.id === "second")?.duplicate_of).toBe("first");
    expect(result.ok).toBe(false);
  });

  it("fails closed when governance repeats an imported_source id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-codex-governance-duplicate-"));
    const codexHome = path.join(root, ".codex");
    const governancePath = path.join(root, "governance.yaml");
    const definition: DefinitionInput = {
      id: "active",
      name: "Active",
      status: "ACTIVE",
      rrule: "FREQ=DAILY",
      cwds: [],
    };
    const written = await writeDefinition(codexHome, definition);
    const entry = validRegistryEntry(definition, written.text);
    await writeFile(governancePath, YAML.stringify(registry([entry, entry])), "utf8");

    const result = await observeCodexAutomations({ codexHome, governancePath });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tasks.codex-governance-invalid",
        message: expect.stringContaining("repeats imported_source ids: active"),
      }),
    ]));
    expect(result.items[0]?.governance.status).toBe("missing");
  });

  it.each([
    ["digest", (entry: MutableRegistryEntry) => { delete entry.imported_source.sha256; }],
    ["observed status", (entry: MutableRegistryEntry) => { delete entry.observed.status; }],
    ["observed schedule", (entry: MutableRegistryEntry) => { delete entry.observed.schedule; }],
    ["cwd presence", (entry: MutableRegistryEntry) => { delete entry.observed.cwds; }],
    ["expiry", (entry: MutableRegistryEntry) => { delete entry.decision.expires_at; }],
    ["entry decision owner", (entry: MutableRegistryEntry) => { delete entry.decision_owner; }],
    ["decision owner", (entry: MutableRegistryEntry) => { delete entry.decision.owner; }],
    ["classification", (entry: MutableRegistryEntry) => { delete entry.decision.classification; }],
  ])("rejects incomplete active exemption governance: %s", async (_field, mutate) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-codex-governance-incomplete-"));
    const codexHome = path.join(root, ".codex");
    const governancePath = path.join(root, "governance.yaml");
    const definition: DefinitionInput = {
      id: "active",
      name: "Active",
      status: "ACTIVE",
      rrule: "FREQ=DAILY",
    };
    const written = await writeDefinition(codexHome, definition);
    const entry = validRegistryEntry(definition, written.text) as MutableRegistryEntry;
    mutate(entry);
    await writeFile(governancePath, YAML.stringify(registry([entry])), "utf8");

    const result = await observeCodexAutomations({ codexHome, governancePath });

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "tasks.codex-governance-invalid",
        message: expect.stringContaining("registry is invalid"),
      }),
    ]));
    expect(result.items[0]?.governance.status).not.toBe("current");
  });

  it("reports malformed, unreadable, and digest-changing definitions without unstable conclusions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-codex-invalid-"));
    const codexHome = path.join(root, ".codex");
    const malformedPath = path.join(codexHome, "automations", "malformed", "automation.toml");
    const unreadablePath = path.join(codexHome, "automations", "unreadable", "automation.toml");
    const changing = await writeDefinition(codexHome, {
      id: "changing",
      name: "Changing",
      status: "ACTIVE",
      rrule: "FREQ=DAILY",
      cwds: [],
    });
    await mkdir(path.dirname(malformedPath), { recursive: true });
    await mkdir(path.dirname(unreadablePath), { recursive: true });
    await writeFile(malformedPath, "not = [valid", "utf8");
    await writeFile(unreadablePath, definitionToml({ id: "unreadable", name: "Unreadable", status: "PAUSED", rrule: "FREQ=DAILY" }), "utf8");
    let changingReads = 0;
    const result = await observeCodexAutomations(
      { codexHome },
      {
        readText: async (filePath) => {
          if (filePath === unreadablePath) {
            throw new Error("fixture denied");
          }
          if (filePath === changing.path) {
            changingReads += 1;
            return changingReads === 1 ? changing.text : changing.text.replace("Changing", "Changed");
          }
          return await readFile(filePath, "utf8");
        },
      },
    );

    expect(result.items.map((item) => [item.id, item.definition_status])).toEqual([
      ["changing", "changed_during_read"],
      ["malformed", "malformed"],
      ["unreadable", "unreadable"],
    ]);
    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "tasks.codex-definition-changed-during-read",
      "tasks.codex-definition-malformed",
      "tasks.codex-definition-unreadable",
    ]));
  });
});
