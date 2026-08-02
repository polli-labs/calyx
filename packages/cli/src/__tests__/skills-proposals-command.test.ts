import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildProgram } from "../run-cli";

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  thrown?: unknown;
}

async function runCalyx(argv: string[]): Promise<CapturedIO> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    out.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts) => {
    err.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  });

  let thrown: unknown;
  let exitCode: number | null = null;
  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "calyx", ...argv]);
  } catch (e) {
    thrown = e;
    if (e && typeof e === "object" && "exitCode" in e) {
      const code = (e as { exitCode?: unknown }).exitCode;
      if (typeof code === "number") exitCode = code;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out, stderr: err, exitCode, thrown };
}

describe("calyx skills propose / proposals CLI (POL-1363)", () => {
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
    delete process.env["CALYX_STATE_DB"];
    workRoot = await mkdtemp(join(tmpdir(), "calyx-skills-prop-cli-"));
    stateHome = join(workRoot, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
    agentsInfraRoot = join(workRoot, "agents-infra");
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

  test("state migrate --plan --json shows 0004 pending before apply", async () => {
    const result = await runCalyx(["state", "migrate", "--plan", "--json"]);
    expect(result.thrown).toBeUndefined();
    const parsed = JSON.parse(result.stdout.join("\n"));
    const ids = (parsed.pending as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain("0004");
  });

  test("state migrate --apply --json applies 0004 idempotently", async () => {
    const apply = await runCalyx(["state", "migrate", "--apply", "--json"]);
    expect(apply.thrown).toBeUndefined();
    const applied = JSON.parse(apply.stdout.join("\n")) as {
      applied: Array<{ id: string }>;
    };
    expect(applied.applied.map((m) => m.id)).toContain("0004");
    const second = await runCalyx(["state", "migrate", "--apply", "--json"]);
    expect(second.thrown).toBeUndefined();
    const repeat = JSON.parse(second.stdout.join("\n")) as {
      applied: Array<{ id: string }>;
    };
    expect(repeat.applied).toEqual([]);
  });

  test("state doctor --domain skill_proposals --json reports schema parity green on a clean db", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const doctor = await runCalyx([
      "state",
      "doctor",
      "--domain",
      "skill_proposals",
      "--json",
    ]);
    expect(doctor.thrown).toBeUndefined();
    const report = JSON.parse(doctor.stdout.join("\n")) as {
      ok: boolean;
      domains: Array<{ domain: string; status: string }>;
    };
    expect(report.ok).toBe(true);
    const skill = report.domains.find((d) => d.domain === "skill_proposals");
    expect(skill?.status).toBe("ok");
  });

  test("state doctor --domain activity --domain skill_proposals --json resolves both real domains", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const doctor = await runCalyx([
      "state",
      "doctor",
      "--domain",
      "activity",
      "--domain",
      "skill_proposals",
      "--json",
    ]);
    expect(doctor.thrown).toBeUndefined();
    const report = JSON.parse(doctor.stdout.join("\n")) as {
      ok: boolean;
      domains: Array<{ domain: string; status: string; detail?: string }>;
    };
    expect(report.ok).toBe(true);
    // activity graduated to a real schema-backed domain in POL-1838.
    const activity = report.domains.find((d) => d.domain === "activity")!;
    expect(activity.status).toBe("ok");
    const skill = report.domains.find((d) => d.domain === "skill_proposals")!;
    expect(skill.status).toBe("ok");
  });

  test("propose create + proposals show round-trip via JSON", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const contentPath = join(workRoot, "SKILL.md");
    await writeFile(contentPath, "# fieldwork-conventions\n\nDraft\n", "utf8");
    const created = await runCalyx([
      "skills",
      "propose",
      "create",
      "fieldwork-conventions",
      "--target",
      "agents-infra",
      "--content-file",
      contentPath,
      "--summary",
      "POL-1363 demo",
      "--author",
      "claude:worm",
      "--json",
    ]);
    expect(created.thrown).toBeUndefined();
    const createdJson = JSON.parse(created.stdout.join("\n")) as {
      result: { proposal: { proposal_id: string; status: string } };
    };
    expect(createdJson.result.proposal.status).toBe("proposed");
    const proposalId = createdJson.result.proposal.proposal_id;

    const show = await runCalyx([
      "skills",
      "proposals",
      "show",
      proposalId,
      "--json",
    ]);
    expect(show.thrown).toBeUndefined();
    const shown = JSON.parse(show.stdout.join("\n")) as {
      result: {
        proposal: { skill_id: string };
        events: Array<{ event_type: string }>;
      };
    };
    expect(shown.result.proposal.skill_id).toBe("fieldwork-conventions");
    expect(shown.result.events[0]!.event_type).toBe("created");
  });

  test("propose create with install-mirror --source-root exits with named alternative", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    for (const sourceRoot of [
      "/home/test/.claude/skills/fieldwork-conventions",
      "/home/test/.agents/skills",
    ]) {
      const result = await runCalyx([
        "skills",
        "propose",
        "create",
        "fieldwork-conventions",
        "--target",
        "repo-local",
        "--source-root",
        sourceRoot,
        "--content",
        "x",
      ]);
      expect(result.thrown).toBeDefined();
      const message = (result.thrown as Error).message;
      expect(message).toMatch(/installed harness mirror/i);
      expect(message).toMatch(/repo-local/);
    }
  });

  test("proposals validate transitions to validated and proposals list filters by status", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const created = await runCalyx([
      "skills",
      "propose",
      "create",
      "fieldwork-conventions",
      "--target",
      "agents-infra",
      "--content",
      "# Draft",
      "--summary",
      "list test",
      "--json",
    ]);
    expect(created.thrown).toBeUndefined();
    const createdJson = JSON.parse(created.stdout.join("\n")) as {
      result: { proposal: { proposal_id: string } };
    };
    const proposalId = createdJson.result.proposal.proposal_id;

    const validated = await runCalyx([
      "skills",
      "proposals",
      "validate",
      proposalId,
      "--actor",
      "claude:worm",
      "--json",
    ]);
    expect(validated.thrown).toBeUndefined();
    const validatedJson = JSON.parse(validated.stdout.join("\n")) as {
      result: { proposal: { status: string } };
    };
    expect(validatedJson.result.proposal.status).toBe("validated");

    const listValidated = await runCalyx([
      "skills",
      "proposals",
      "list",
      "--status",
      "validated",
      "--limit",
      "5",
      "--json",
    ]);
    const listJson = JSON.parse(listValidated.stdout.join("\n")) as {
      result: { proposals: Array<{ proposal_id: string; status: string }> };
    };
    expect(listJson.result.proposals.map((p) => p.proposal_id)).toContain(proposalId);
    expect(listJson.result.proposals.every((p) => p.status === "validated")).toBe(true);
  });

  test("proposals materialize writes patch + manifest under --output and exits clean", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const diffPath = join(workRoot, "change.diff");
    await writeFile(
      diffPath,
      "diff --git a/SKILL.md b/SKILL.md\n+++ b/SKILL.md\n",
      "utf8",
    );
    const created = await runCalyx([
      "skills",
      "propose",
      "patch",
      "calyx-dev",
      "--target",
      "repo-local",
      "--source-root",
      join(workRoot, "calyx-repo"),
      "--diff-file",
      diffPath,
      "--summary",
      "materialize test",
      "--json",
    ]);
    expect(created.thrown).toBeUndefined();
    const createdJson = JSON.parse(created.stdout.join("\n")) as {
      result: { proposal: { proposal_id: string } };
    };
    const proposalId = createdJson.result.proposal.proposal_id;
    await runCalyx(["skills", "proposals", "validate", proposalId, "--json"]);

    const outputPath = join(workRoot, "out", "skill.patch");
    const materialized = await runCalyx([
      "skills",
      "proposals",
      "materialize",
      proposalId,
      "--output",
      outputPath,
      "--json",
    ]);
    expect(materialized.thrown).toBeUndefined();
    const matJson = JSON.parse(materialized.stdout.join("\n")) as {
      result: {
        proposal: { status: string };
        artifact_path: string;
        manifest_path: string;
      };
    };
    expect(matJson.result.proposal.status).toBe("materialized");
    expect(matJson.result.artifact_path).toBe(outputPath);
    const body = await readFile(outputPath, "utf8");
    expect(body).toContain("diff --git");
    const manifest = JSON.parse(
      await readFile(matJson.result.manifest_path, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["proposal_id"]).toBe(proposalId);
  });

  test("proposals materialize refuses install-mirror output paths", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const created = await runCalyx([
      "skills",
      "propose",
      "patch",
      "fieldwork-conventions",
      "--target",
      "agents-infra",
      "--diff",
      "diff --git a/x b/x\n",
      "--json",
    ]);
    const createdJson = JSON.parse(created.stdout.join("\n")) as {
      result: { proposal: { proposal_id: string } };
    };
    const proposalId = createdJson.result.proposal.proposal_id;
    const result = await runCalyx([
      "skills",
      "proposals",
      "materialize",
      proposalId,
      "--output",
      "/home/test/.agents/skills/x.patch",
    ]);
    expect(result.thrown).toBeDefined();
    const message = (result.thrown as Error).message;
    expect(message).toMatch(/installed harness mirror|under an installed/i);
  });

  test("proposals review --status accepted appends the review event", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const created = await runCalyx([
      "skills",
      "propose",
      "create",
      "fieldwork-conventions",
      "--target",
      "agents-infra",
      "--content",
      "# Draft",
      "--json",
    ]);
    const createdJson = JSON.parse(created.stdout.join("\n")) as {
      result: { proposal: { proposal_id: string } };
    };
    const proposalId = createdJson.result.proposal.proposal_id;

    await runCalyx(["skills", "proposals", "validate", proposalId, "--json"]);
    const reviewed = await runCalyx([
      "skills",
      "proposals",
      "review",
      proposalId,
      "--status",
      "accepted",
      "--actor",
      "caleb",
      "--note",
      "looks good",
      "--json",
    ]);
    expect(reviewed.thrown).toBeUndefined();
    const reviewedJson = JSON.parse(reviewed.stdout.join("\n")) as {
      result: { proposal: { status: string }; event: { note: string } };
    };
    expect(reviewedJson.result.proposal.status).toBe("accepted");
    expect(reviewedJson.result.event.note).toBe("looks good");
  });

  test("state migrate --plan --json is read-only when DB does not exist", async () => {
    const result = await runCalyx(["state", "migrate", "--plan", "--json"]);
    expect(result.thrown).toBeUndefined();
    await expect(
      (await import("node:fs/promises")).stat(stateHome),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
