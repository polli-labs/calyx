import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkSkillProposalsSchema,
  countSkillProposalsByStatus,
  createSkillProposal,
  listMalformedSkillProposals,
  listSkillProposalEvents,
  listSkillProposals,
  openStateStore,
  planStateMigrations,
  runStateDoctor,
  SKILL_PROPOSAL_TABLES,
  STATE_MIGRATIONS,
  updateSkillProposalStatus,
} from "../state";
import {
  createProposal,
  listProposals,
  materializeProposal,
  reviewProposal,
  showProposal,
  SkillProposalError,
  validateProposal,
} from "../skill-proposals";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

async function makeStateHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-skill-prop-"));
  return root;
}

describe("skill proposals state (migration 0004)", () => {
  let workRoot: string;
  let stateHome: string;
  let agentsInfraRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    workRoot = await makeStateHome();
    stateHome = join(workRoot, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
    // Fake an agents-infra source root in a writable tmp area so resolve helpers work.
    agentsInfraRoot = join(workRoot, "agents-infra");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "instructions", "skills", "SOURCES.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts: {}\n",
      "utf8",
    );
    process.env["CALYX_AGENTS_INFRA_ROOT"] = agentsInfraRoot;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env["CALYX_AGENTS_INFRA_ROOT"];
    await rm(workRoot, { recursive: true, force: true });
  });

  test("migration 0004 is pending on a fresh DB and applies idempotently", async () => {
    const plan = await planStateMigrations();
    expect(plan.pending.map((p) => p.id)).toContain("0004");
    const apply = await applyStateMigrations();
    expect(apply.applied.map((m) => m.id)).toContain("0004");
    const second = await applyStateMigrations();
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.map((m) => m.id)).toContain("0004");
    expect(STATE_MIGRATIONS.map((m) => m.id)).toContain("0004");
  });

  test("SKILL_PROPOSAL_TABLES enumerates the two tables", () => {
    const names = SKILL_PROPOSAL_TABLES.map((t) => t.table).sort();
    expect(names).toEqual(["skill_proposal_events", "skill_proposals"]);
  });

  test("doctor reports skill_proposals schema parity green on a clean database", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor();
    expect(report.skillProposals.migrationApplied).toBe(true);
    expect(report.skillProposals.schemaParity).toBe("ok");
    expect(report.skillProposals.schemaFindings).toEqual([]);
    expect(report.findings.some((f) => f.code === "skill-proposals-schema")).toBe(false);
    expect(report.ok).toBe(true);
  });

  test("doctor reports schema drift when a skill_proposals table is dropped", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP TABLE skill_proposal_events");
    } finally {
      opened.db.close();
    }
    const report = await runStateDoctor();
    expect(report.skillProposals.schemaParity).toBe("drift");
    expect(report.findings.some((f) => f.code === "skill-proposals-schema")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("--domain skill_proposals + activity both resolve to real domains", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({
      domains: ["activity", "skill_proposals"],
    });
    expect(report.domains).toBeDefined();
    // activity graduated to a real domain in POL-1838 (migration 0013).
    const activity = report.domains!.find((d) => d.domain === "activity")!;
    expect(activity.status).toBe("ok");
    expect(activity.findings.filter((f) => f.severity === "error")).toEqual([]);
    const skill = report.domains!.find((d) => d.domain === "skill_proposals")!;
    expect(skill.status).toBe("ok");
    expect(skill.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("--domain unknown surfaces a blocking unknown-domain finding", async () => {
    await applyStateMigrations();
    const report = await runStateDoctor({ domains: ["nonexistent"] });
    const result = report.domains!.find((d) => d.domain === "nonexistent")!;
    expect(result.status).toBe("unknown-domain");
    expect(result.findings.some((f) => f.severity === "error")).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("createSkillProposal seeds the row + created event in one transaction", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      const created = createSkillProposal(opened.db, {
        proposal_id: "prop_test_001",
        skill_id: "fieldwork-conventions",
        kind: "create",
        target: "agents-infra",
        source_root: "/tmp/source",
        target_source_path: "/tmp/source/instructions/skills/fieldwork-conventions",
        summary: "test seed",
        author: "claude:worm",
        payload: { content: "hello" },
      });
      expect(created.status).toBe("proposed");
      const events = listSkillProposalEvents(opened.db, "prop_test_001");
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe("created");
      expect(events[0]!.status_after).toBe("proposed");
    } finally {
      opened.db.close();
    }
  });

  test("updateSkillProposalStatus validates expected status and appends event", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      createSkillProposal(opened.db, {
        proposal_id: "prop_test_002",
        skill_id: "calyx-dev",
        kind: "patch",
        target: "repo-local",
        source_root: "/tmp/source",
        target_source_path: "/tmp/source/skills/calyx-dev",
        payload: { diff: "diff --git ..." },
      });
      const { proposal, event } = updateSkillProposalStatus(opened.db, {
        proposal_id: "prop_test_002",
        expected_status: "proposed",
        next_status: "validated",
        event_type: "validated",
        status_timestamp_column: "validated_at",
      });
      expect(proposal.status).toBe("validated");
      expect(proposal.validated_at).not.toBeNull();
      expect(event.status_after).toBe("validated");

      expect(() =>
        updateSkillProposalStatus(opened.db, {
          proposal_id: "prop_test_002",
          expected_status: "proposed",
          next_status: "materialized",
          event_type: "materialized",
        }),
      ).toThrow(/status "validated"/);
    } finally {
      opened.db.close();
    }
  });

  test("listSkillProposals filters by status with bounded limit", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      for (let i = 0; i < 5; i++) {
        createSkillProposal(opened.db, {
          proposal_id: `prop_seed_${i.toString().padStart(2, "0")}`,
          skill_id: `skill-${i}`,
          kind: "create",
          target: "agents-infra",
          source_root: "/tmp/source",
          target_source_path: `/tmp/source/instructions/skills/skill-${i}`,
        });
      }
      updateSkillProposalStatus(opened.db, {
        proposal_id: "prop_seed_00",
        expected_status: "proposed",
        next_status: "rejected",
        event_type: "review:rejected",
        status_timestamp_column: "rejected_at",
      });
      const proposed = listSkillProposals(opened.db, { status: "proposed", limit: 3 });
      expect(proposed.length).toBe(3);
      const rejected = listSkillProposals(opened.db, { status: "rejected" });
      expect(rejected.map((p) => p.proposal_id)).toEqual(["prop_seed_00"]);
      const counts = countSkillProposalsByStatus(opened.db);
      expect(counts.proposed).toBe(4);
      expect(counts.rejected).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("listMalformedSkillProposals flags install-mirror artifact paths", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      createSkillProposal(opened.db, {
        proposal_id: "prop_mirror",
        skill_id: "test",
        kind: "create",
        target: "agents-infra",
        source_root: "/tmp/source",
        target_source_path: "/tmp/source/instructions/skills/test",
      });
      // Synthesize a bad materialization payload to trigger the mirror finding.
      updateSkillProposalStatus(opened.db, {
        proposal_id: "prop_mirror",
        expected_status: "proposed",
        next_status: "materialized",
        event_type: "materialized",
        payload: {},
        payload_patch: {
          materialization: {
            artifact_path: "/home/user/.agents/skills/test/SKILL.md",
          },
        },
        status_timestamp_column: "materialized_at",
      });
      const findings = listMalformedSkillProposals(opened.db);
      expect(findings.map((f) => f.code)).toContain("materialized-to-mirror");
      const report = await runStateDoctor();
      expect(report.skillProposals.malformed.length).toBeGreaterThan(0);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((f) => f.code === "skill-proposals-materialized-to-mirror"),
      ).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("listMalformedSkillProposals flags install-mirror source roots and target paths", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      createSkillProposal(opened.db, {
        proposal_id: "prop_source_mirror",
        skill_id: "test",
        kind: "create",
        target: "repo-local",
        source_root: "/home/user/.agents/skills",
        target_source_path: "/home/user/.agents/skills/skills/test",
      });
      const findings = listMalformedSkillProposals(opened.db);
      expect(findings.map((f) => f.code)).toContain("source-root-to-mirror");
      expect(findings.map((f) => f.code)).toContain("target-source-to-mirror");
      const report = await runStateDoctor();
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((f) => f.code === "skill-proposals-source-root-to-mirror"),
      ).toBe(true);
      expect(
        report.findings.some((f) => f.code === "skill-proposals-target-source-to-mirror"),
      ).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("schema parity helper detects missing columns and indexes", async () => {
    await applyStateMigrations();
    const opened = await openStateStore();
    try {
      opened.db.exec("DROP INDEX idx_skill_proposals_status");
      const parity = checkSkillProposalsSchema(opened.db);
      expect(parity.status).toBe("drift");
      expect(parity.findings.some((f) => f.code === "missing-index")).toBe(true);
    } finally {
      opened.db.close();
    }
  });
});

describe("skill proposals high-level API", () => {
  let workRoot: string;
  let stateHome: string;
  let agentsInfraRoot: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
      CALYX_AGENTS_INFRA_ROOT: process.env["CALYX_AGENTS_INFRA_ROOT"],
    };
    for (const k of ENV_KEYS) delete process.env[k];
    delete process.env["CALYX_AGENTS_INFRA_ROOT"];
    workRoot = await makeStateHome();
    stateHome = join(workRoot, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
    agentsInfraRoot = join(workRoot, "agents-infra-dev");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(agentsInfraRoot, "instructions", "skills"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "instructions", "templates"), { recursive: true });
    await mkdir(join(agentsInfraRoot, "fleet", "truths"), { recursive: true });
    await writeFile(
      join(agentsInfraRoot, "instructions", "skills", "SOURCES.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      join(agentsInfraRoot, "instructions", "templates", "REGISTRY.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      join(agentsInfraRoot, "fleet", "truths", "hosts.yaml"),
      "hosts: {}\n",
      "utf8",
    );
    process.env["CALYX_AGENTS_INFRA_ROOT"] = agentsInfraRoot;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  test("createProposal end-to-end persists the row + initial event with provenance", async () => {
    const created = await createProposal({
      skill_id: "fieldwork-conventions",
      kind: "create",
      target: "agents-infra",
      content: "# SKILL\n\nDraft\n",
      summary: "Workflow learned from POL-1318",
      author: "claude:worm",
      origin_activity_id: "act_demo",
      origin_message_id: "act_demo:msg:42",
    });
    expect(created.proposal.status).toBe("proposed");
    expect(created.proposal.summary).toBe("Workflow learned from POL-1318");
    expect(created.proposal.target_source_path).toContain(
      "instructions/skills/fieldwork-conventions",
    );
    const show = await showProposal(created.proposal.proposal_id);
    expect(show.proposal.author).toBe("claude:worm");
    expect(show.events.length).toBe(1);
  });

  test("create survives process restart", async () => {
    const created = await createProposal({
      skill_id: "calyx-dev",
      kind: "patch",
      target: "repo-local",
      source_root: join(workRoot, "fake-repo"),
      diff: "diff --git a/skills/calyx-dev/SKILL.md b/skills/calyx-dev/SKILL.md\n",
      summary: "patch",
      author: "codex:blade",
    });
    const proposalId = created.proposal.proposal_id;
    // Simulate restart by re-opening the state store via the public API.
    const reread = await showProposal(proposalId);
    expect(reread.proposal.proposal_id).toBe(proposalId);
    expect(reread.proposal.kind).toBe("patch");
  });

  test("create rejects install-mirror source-root with named alternative", async () => {
    await expect(
      createProposal({
        skill_id: "calyx-dev",
        kind: "create",
        target: "repo-local",
        source_root: "/home/test/.claude/skills/calyx-dev",
        content: "ignore",
      }),
    ).rejects.toThrow(SkillProposalError);
    try {
      await createProposal({
        skill_id: "calyx-dev",
        kind: "create",
        target: "repo-local",
        source_root: "/home/test/.claude/skills/calyx-dev",
        content: "ignore",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SkillProposalError);
      expect((err as SkillProposalError).code).toBe("source-root-is-mirror");
      expect((err as SkillProposalError).suggestions.join(" ")).toMatch(/repo-local/);
    }
    await expect(
      createProposal({
        skill_id: "calyx-dev",
        kind: "create",
        target: "repo-local",
        source_root: "/home/test/.agents/skills",
        content: "ignore",
      }),
    ).rejects.toMatchObject({ code: "source-root-is-mirror" });
  });

  test("validate transitions proposed -> validated when paths are clean", async () => {
    const created = await createProposal({
      skill_id: "fieldwork-conventions",
      kind: "create",
      target: "agents-infra",
      content: "# Draft",
    });
    const result = await validateProposal(created.proposal.proposal_id, { actor: "claude:worm" });
    expect(result.proposal.status).toBe("validated");
    expect(result.checks.every((c) => c.status === "ok")).toBe(true);
    expect(result.event.event_type).toBe("validated");
  });

  test("validate refuses install-mirror target_source_path even if persisted directly", async () => {
    const created = await createProposal({
      skill_id: "calyx-dev",
      kind: "create",
      target: "agents-infra",
      content: "# Draft",
    });
    // Mutate the DB to simulate a stored mirror path (pretend a buggy
    // upstream wrote one). Validation should refuse.
    const opened = await openStateStore();
    try {
      opened.db
        .prepare(
          `UPDATE skill_proposals SET target_source_path = ? WHERE proposal_id = ?`,
        )
        .run("/home/test/.agents/skills/calyx-dev", created.proposal.proposal_id);
    } finally {
      opened.db.close();
    }
    await expect(
      validateProposal(created.proposal.proposal_id),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });

  test("materialize writes patch + manifest under --output and never calls sync", async () => {
    const created = await createProposal({
      skill_id: "fieldwork-conventions",
      kind: "patch",
      target: "agents-infra",
      diff: "diff --git a/x b/x\n",
    });
    await validateProposal(created.proposal.proposal_id);
    const outDir = join(workRoot, "materializations");
    const outputPath = join(outDir, "patch-001.patch");
    const result = await materializeProposal(created.proposal.proposal_id, {
      output_path: outputPath,
      actor: "claude:worm",
    });
    expect(result.proposal.status).toBe("materialized");
    expect(result.artifact_path).toBe(outputPath);
    const body = await readFile(outputPath, "utf8");
    expect(body).toContain("diff --git");
    const manifest = JSON.parse(
      await readFile(result.manifest_path, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["artifact_kind"]).toBe("diff");
    expect(manifest["proposal_id"]).toBe(created.proposal.proposal_id);
  });

  test("materialize refuses install-mirror output paths with named alternative", async () => {
    const created = await createProposal({
      skill_id: "fieldwork-conventions",
      kind: "patch",
      target: "agents-infra",
      diff: "diff --git a/x b/x\n",
    });
    await expect(
      materializeProposal(created.proposal.proposal_id, {
        output_path: "/home/test/.agents/skills/fieldwork-conventions/SKILL.md.patch",
      }),
    ).rejects.toMatchObject({ code: "output-is-mirror" });
  });

  test("review transitions to accepted with timestamps and note recorded in event", async () => {
    const created = await createProposal({
      skill_id: "calyx-dev",
      kind: "file",
      target: "agents-infra",
      relative_source_file: "references/example.md",
      content: "example",
    });
    await validateProposal(created.proposal.proposal_id);
    const reviewed = await reviewProposal(created.proposal.proposal_id, {
      status: "accepted",
      actor: "caleb",
      note: "ready to materialize",
    });
    expect(reviewed.proposal.status).toBe("accepted");
    expect(reviewed.proposal.accepted_at).not.toBeNull();
    expect(reviewed.event.note).toBe("ready to materialize");
  });

  test("list returns proposals filtered by status with bounded limit", async () => {
    for (let i = 0; i < 4; i++) {
      await createProposal({
        skill_id: `skill-${i}`,
        kind: "create",
        target: "agents-infra",
        content: "x",
        proposal_id: `prop_list_${i}`,
      });
    }
    const before = await listProposals({ status: "proposed", limit: 2 });
    expect(before.proposals.length).toBe(2);
    expect(before.proposals.every((p) => p.status === "proposed")).toBe(true);
  });
});
