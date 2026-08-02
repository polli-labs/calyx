import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";
import {
  applyStateMigrations,
  hashTaskManifest,
  installTask,
  loadStateDriver,
  openStateStore,
  showTask,
  type TaskManifest,
} from "@polli-labs/calyx-core";

const tempRoots = new Set<string>();
const STATE_ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

function fixturePath(...parts: string[]): string {
  return path.resolve("fixtures", "tasks", ...parts);
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function exactCodexProjection(task: TaskManifest): TaskManifest {
  const schedule = task.triggers.find((trigger) => trigger.type === "schedule" && trigger.rrule);
  const workspace = task.runtime.workspace;
  const target = task.install?.targets?.find((candidate) => candidate.backend === "codex_app");
  if (schedule?.type !== "schedule" || !schedule.rrule || !workspace?.cwds || !target) {
    throw new Error(`task ${task.id} needs the POL-995 fixture shape`);
  }
  return {
    version: 1,
    kind: "task",
    id: task.id,
    name: task.name,
    status: task.status,
    triggers: [{ type: "schedule", rrule: schedule.rrule }],
    runtime: {
      backend: "codex_app",
      agent: "codex",
      ...(task.runtime.model ? { model: task.runtime.model } : {}),
      ...(task.runtime.reasoning_effort ? { reasoning_effort: task.runtime.reasoning_effort } : {}),
      ...(task.runtime.execution_environment
        ? { execution_environment: task.runtime.execution_environment }
        : {}),
      workspace: { cwds: workspace.cwds },
    },
    prompt: { body: task.prompt.body },
    install: {
      targets: [{
        host: target.host,
        backend: "codex_app",
        ...(target.status ? { status: target.status } : {}),
      }],
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe("tasks command", () => {
  test("tasks validate emits JSON validation summary", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "tasks",
      "validate",
      "--tasks-dir",
      fixturePath("valid"),
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      total: number;
      active: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.total).toBe(3);
    expect(payload.active).toBe(1);
  });

  test("tasks list and show support agent-readable JSON", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "tasks",
      "list",
      "--tasks-dir",
      fixturePath("valid"),
      "--status",
      "paused",
      "--json",
    ]);

    const listPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(listPayload.items).toEqual([
      expect.objectContaining({ id: "skills-quality-check", status: "paused" }),
    ]);

    await program.parseAsync([
      "node",
      "calyx",
      "tasks",
      "show",
      "daily-maintenance",
      "--tasks-dir",
      fixturePath("valid"),
      "--json",
    ]);

    const showPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      task: { id: string; runtime: { backend: string } };
    };
    expect(showPayload.task.id).toBe("daily-maintenance");
    expect(showPayload.task.runtime.backend).toBe("codex_app");
  });

  test("tasks import codex writes task manifests", async () => {
    const outDir = await makeTempRoot("calyx-tasks-cli-import-");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "tasks",
      "import",
      "codex",
      "--codex-home",
      fixturePath("codex-home"),
      "--out-dir",
      outDir,
      "--id",
      "daily-maintenance",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      imported: Array<{ id: string; outputPath: string }>;
    };
    expect(payload.imported[0]?.id).toBe("daily-maintenance");
    await expect(readFile(path.join(outDir, "daily-maintenance.task.yaml"), "utf8")).resolves.toContain(
      "id: daily-maintenance",
    );
  });

  test("tasks render codex writes automation TOML", async () => {
    const outDir = await makeTempRoot("calyx-tasks-cli-render-");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "tasks",
      "render",
      "codex",
      "safe-codex-task",
      "--tasks-dir",
      fixturePath("render-safe"),
      "--out-dir",
      outDir,
      "--host",
      "carbon",
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      automationPath: string;
      automation: { id: string; status: string };
    };
    expect(payload.automation.id).toBe("safe-codex-task");
    expect(payload.automation.status).toBe("ACTIVE");
    await expect(readFile(payload.automationPath, "utf8")).resolves.toContain('id = "safe-codex-task"');
  });

  test("tasks observe codex exposes read-only definition, governance, and projection authority", async () => {
    const root = await makeTempRoot("calyx-tasks-cli-observe-");
    const databasePath = path.join(root, "codex.db");
    const driver = await loadStateDriver();
    const db = driver.open(databasePath);
    try {
      db.exec(`CREATE TABLE automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER,
        cwds TEXT NOT NULL, rrule TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.prepare(`INSERT INTO automations
        (id, name, prompt, status, next_run_at, last_run_at, cwds, rrule, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "daily-maintenance",
          "Daily Maintenance",
          "Run the daily maintenance procedure.",
          "ACTIVE",
          200,
          100,
          JSON.stringify(["/Users/carbon/dev/calyx/dev"]),
          "RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=30",
          1,
          1,
        );
    } finally {
      db.close();
    }
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await buildProgram().parseAsync([
        "node",
        "calyx",
        "tasks",
        "observe",
        "codex",
        "--codex-home",
        fixturePath("codex-home"),
        "--codex-db",
        databasePath,
        "--tasks-dir",
        fixturePath("valid"),
        "--json",
      ]);
      const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        definition_authority: string;
        mutation_authority: string;
        items: Array<{ projection: string; governance: { kind: string; loss_receipt: { ok: boolean } } }>;
      };
      expect(payload.definition_authority).toBe("codex_toml");
      expect(payload.mutation_authority).toBe("unavailable");
      expect(payload.items[0]).toMatchObject({
        projection: "observed",
        governance: { kind: "task_manifest", loss_receipt: { ok: false } },
      });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test("tasks lifecycle commands install, pause/resume, dry-run, reconcile, history, and doctor", async () => {
    const stateRoot = await makeTempRoot("calyx-tasks-cli-state-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(stateRoot, "state");
    await applyStateMigrations();

    try {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = buildProgram();

      await program.parseAsync([
        "node",
        "calyx",
        "tasks",
        "install",
        "safe-codex-task",
        "--tasks-dir",
        fixturePath("render-safe"),
        "--host",
        "carbon",
        "--json",
      ]);
      const installPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        install: { install_id: string; status: string; unattended_enabled: boolean };
      };
      expect(installPayload.install.status).toBe("paused");
      expect(installPayload.install.unattended_enabled).toBe(false);

      await program.parseAsync(["node", "calyx", "tasks", "resume", "safe-codex-task", "--host", "carbon", "--json"]);
      const resumePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        install: { status: string; unattended_enabled: boolean };
      };
      expect(resumePayload.install.status).toBe("active");
      expect(resumePayload.install.unattended_enabled).toBe(false);

      await program.parseAsync(["node", "calyx", "tasks", "pause", "safe-codex-task", "--host", "carbon", "--json"]);
      const pausePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        install: { status: string };
      };
      expect(pausePayload.install.status).toBe("paused");

      await program.parseAsync([
        "node",
        "calyx",
        "tasks",
        "run",
        "safe-codex-task",
        "--tasks-dir",
        fixturePath("render-safe"),
        "--host",
        "carbon",
        "--dry-run",
        "--json",
      ]);
      const runPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        task_run: { status: string; dry_run: boolean; run_id: string | null; receipt_path: string };
        run: null;
      };
      expect(runPayload.task_run.status).toBe("launch_intent_recorded");
      expect(runPayload.task_run.dry_run).toBe(true);
      expect(runPayload.task_run.run_id).toBeNull();
      await expect(readFile(runPayload.task_run.receipt_path, "utf8")).resolves.toContain("safe-codex-task");

      await program.parseAsync([
        "node",
        "calyx",
        "tasks",
        "reconcile",
        "--tasks-dir",
        fixturePath("render-safe"),
        "--host",
        "carbon",
        "--json",
      ]);
      const reconcilePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        inspected: number;
        findings: Array<{ code: string }>;
      };
      expect(reconcilePayload.inspected).toBe(1);
      expect(reconcilePayload.findings.map((finding) => finding.code)).toContain("tasks.app-mutation-disabled");

      await program.parseAsync(["node", "calyx", "tasks", "history", "safe-codex-task", "--json"]);
      const historyPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        history: Array<{ event_type: string }>;
        task_runs: Array<{ task_id: string }>;
      };
      expect(historyPayload.history.map((row) => row.event_type)).toEqual(
        expect.arrayContaining(["task.install.created", "task.run.launch_intent_recorded"]),
      );
      expect(historyPayload.task_runs[0]?.task_id).toBe("safe-codex-task");

      await program.parseAsync(["node", "calyx", "tasks", "doctor", "--json"]);
      const doctorPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        tasks: { schemaParity: string; installCount: number; taskRunCount: number };
      };
      expect(doctorPayload.tasks).toMatchObject({
        schemaParity: "ok",
        installCount: 1,
        taskRunCount: 1,
      });
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("loss receipts are JSON on exit 3 and historical installs fail resume plus reconcile/doctor", async () => {
    const stateRoot = await makeTempRoot("calyx-tasks-cli-render-loss-");
    const renderOut = await makeTempRoot("calyx-tasks-cli-render-loss-out-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    const originalExitCode = process.exitCode;
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(stateRoot, "state");
    await applyStateMigrations();

    try {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      await expect(buildProgram().parseAsync([
        "node",
        "calyx",
        "tasks",
        "render",
        "codex",
        "linnaeus-public-parity",
        "--tasks-dir",
        fixturePath("lossy-pol-995"),
        "--out-dir",
        renderOut,
        "--host",
        "carbon",
        "--json",
      ])).rejects.toMatchObject({ exitCode: 3 });
      const renderReceipt = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        schema_version: string;
        ok: boolean;
        losses: Array<{ path: string }>;
      };
      expect(renderReceipt).toMatchObject({
        schema_version: "calyx.task-render-preflight/v1",
        ok: false,
      });
      expect(renderReceipt.losses.map((loss) => loss.path)).toContain("safety.timeout_minutes");
      await expect(
        readFile(path.join(renderOut, "linnaeus-public-parity", "automation.toml"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      out.mockClear();
      await expect(buildProgram().parseAsync([
        "node",
        "calyx",
        "tasks",
        "install",
        "linnaeus-public-parity",
        "--tasks-dir",
        fixturePath("lossy-pol-995"),
        "--host",
        "carbon",
        "--json",
      ])).rejects.toMatchObject({ exitCode: 3 });
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: false });

      const shown = await showTask(fixturePath("lossy-pol-995"), "linnaeus-public-parity");
      const opened = await openStateStore();
      try {
        const installed = installTask(opened.db, {
          task: exactCodexProjection(shown.task),
          manifest_path: shown.manifestPath,
          host: "carbon",
          installed_by: "pre-pol-1960",
        }).install;
        opened.db.prepare(
          "UPDATE task_installs SET task_json = ?, manifest_hash = ? WHERE install_id = ?",
        ).run(JSON.stringify(shown.task), hashTaskManifest(shown.task), installed.install_id);
      } finally {
        opened.db.close();
      }

      out.mockClear();
      await expect(buildProgram().parseAsync([
        "node",
        "calyx",
        "tasks",
        "resume",
        "linnaeus-public-parity",
        "--host",
        "carbon",
        "--json",
      ])).rejects.toMatchObject({ exitCode: 3 });
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: false });

      out.mockClear();
      process.exitCode = undefined;
      await buildProgram().parseAsync([
        "node",
        "calyx",
        "tasks",
        "reconcile",
        "linnaeus-public-parity",
        "--tasks-dir",
        fixturePath("lossy-pol-995"),
        "--host",
        "carbon",
        "--json",
      ]);
      const reconcilePayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        ok: boolean;
        findings: Array<{ code: string; severity: string; receipt?: { ok: boolean } }>;
      };
      expect(reconcilePayload.ok).toBe(false);
      expect(reconcilePayload.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "tasks.codex-render-loss",
          severity: "error",
          receipt: expect.objectContaining({ ok: false }),
        }),
      ]));
      expect(process.exitCode).toBe(3);

      out.mockClear();
      process.exitCode = undefined;
      await buildProgram().parseAsync(["node", "calyx", "tasks", "doctor", "--json"]);
      const doctorPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
        ok: boolean;
        findings: Array<{ code: string; severity: string; receipt?: { ok: boolean } }>;
      };
      expect(doctorPayload.ok).toBe(false);
      expect(doctorPayload.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "tasks-codex-render-loss",
          severity: "error",
          receipt: expect.objectContaining({ ok: false }),
        }),
      ]));
    } finally {
      process.exitCode = originalExitCode;
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
