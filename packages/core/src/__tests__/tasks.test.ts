import { parse as parseToml } from "@iarna/toml";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { TaskManifest } from "../types";
import {
  importCodexAutomationTasks,
  listTasks,
  preflightCodexTaskRender,
  renderCodexAutomationTask,
  showTask,
  TaskRenderError,
  validateTasks,
} from "../tasks";
import {
  applyStateMigrations,
  appendTaskRunJsonlReceipt,
  countTaskInstalls,
  createTaskRun,
  hashTaskManifest,
  installTask,
  listTaskRuns,
  openStateStore,
  predicateFromTaskManifest,
  readTaskInstall,
  reconcileTaskInstall,
  runStateDoctor,
  setTaskInstallStatus,
  setTaskRunReceiptPath,
} from "../state";

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
  if (schedule?.type !== "schedule" || !schedule.rrule) {
    throw new Error(`task ${task.id} needs an rrule schedule for this test`);
  }
  const workspace = task.runtime.workspace;
  const target = task.install?.targets?.find((candidate) => candidate.backend === "codex_app");
  if (!workspace?.cwds || !target) {
    throw new Error(`task ${task.id} needs Codex workspace and target fixtures`);
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
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

describe("task manifests", () => {
  test("validates valid task manifests and counts lifecycle states", async () => {
    const result = await validateTasks(fixturePath("valid"), { strict: true });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.active).toBe(1);
    expect(result.paused).toBe(1);
    expect(result.retired).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("validates literal predicate/v1 schedule task manifests", async () => {
    const result = await validateTasks(fixturePath("time-after"), { strict: true });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("rejects invalid task status", async () => {
    const result = await validateTasks(fixturePath("invalid"));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "tasks.invalid-schema",
        path: "invalid-status.task.yaml",
      }),
    ]);
  });

  test("rejects duplicate task ids", async () => {
    const result = await validateTasks(fixturePath("duplicates"));

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "tasks.duplicate-id",
        path: "two.task.yaml:id",
      }),
    ]);
  });

  test("keeps advisory timezone warnings consistent across validate, list, and show", async () => {
    const advisoryValidation = await validateTasks(fixturePath("no-timezone"));
    expect(advisoryValidation.ok).toBe(true);
    expect(advisoryValidation.warnings).toEqual([
      expect.objectContaining({
        code: "tasks.schedule-missing-timezone",
        path: "no-timezone.task.yaml:triggers[0].timezone",
      }),
    ]);

    const strictValidation = await validateTasks(fixturePath("no-timezone"), { strict: true });
    expect(strictValidation.ok).toBe(false);
    expect(strictValidation.errors).toEqual([
      expect.objectContaining({
        code: "tasks.schedule-missing-timezone",
      }),
    ]);

    const listed = await listTasks(fixturePath("no-timezone"));
    expect(listed.items.map((item) => item.id)).toEqual(["no-timezone-task"]);

    const shown = await showTask(fixturePath("no-timezone"), "no-timezone-task");
    expect(shown.task.id).toBe("no-timezone-task");
  });

  test("ignores incidental YAML files that are not task manifests", async () => {
    const result = await validateTasks(fixturePath("with-incidental"), { strict: true });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("lists tasks with default and explicit status filters", async () => {
    const defaultList = await listTasks(fixturePath("valid"));
    expect(defaultList.items.map((item) => item.id)).toEqual(["daily-maintenance"]);

    const pausedList = await listTasks(fixturePath("valid"), { statuses: ["paused"] });
    expect(pausedList.items.map((item) => item.id)).toEqual(["skills-quality-check"]);

    const fullList = await listTasks(fixturePath("valid"), {
      includePaused: true,
      includeRetired: true,
    });
    expect(fullList.items.map((item) => item.id)).toEqual([
      "daily-maintenance",
      "skills-quality-check",
      "minecraft-compatibility-watch",
    ]);
  });

  test("shows one task manifest", async () => {
    const result = await showTask(fixturePath("valid"), "daily-maintenance");

    expect(result.task.name).toBe("Daily Maintenance");
    expect(result.task.runtime.backend).toBe("codex_app");
  });
});

describe("task lifecycle state", () => {
  test("installs a task paused with predicate/v1 trigger and task doctor counts", async () => {
    const root = await makeTempRoot("calyx-task-lifecycle-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(root, "state");

    try {
      await applyStateMigrations();
      const shown = await showTask(fixturePath("render-safe"), "safe-codex-task");
      const opened = await openStateStore();
      try {
        const result = installTask(opened.db, {
          task: shown.task,
          manifest_path: shown.manifestPath,
          host: "carbon",
          installed_by: "tester",
        });
        expect(result.created).toBe(true);
        expect(result.install.status).toBe("paused");
        expect(result.install.unattended_enabled).toBe(false);
        expect(result.install.app_mutation_enabled).toBe(false);
        expect(result.install.predicate).toMatchObject({
          schema_version: "predicate/v1",
          kind: "time.cron",
          expr: "30 7 * * *",
        });
        expect(result.findings.map((finding) => finding.code)).toContain("tasks.app-mutation-disabled");
      } finally {
        opened.db.close();
      }

      const report = await runStateDoctor({ domains: ["tasks"] });
      expect(report.tasks).toMatchObject({
        schemaParity: "ok",
        installCount: 1,
        taskRunCount: 0,
      });
      expect(report.domains?.find((domain) => domain.domain === "tasks")).toMatchObject({ status: "ok" });
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("preserves literal predicate/v1 triggers and records task-run receipts", async () => {
    const root = await makeTempRoot("calyx-task-run-state-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(root, "state");

    try {
      await applyStateMigrations();
      const task: TaskManifest = {
        version: 1,
        kind: "task",
        id: "after-task",
        name: "After Task",
        status: "active",
        triggers: [
          {
            type: "schedule",
            predicate: {
              schema_version: "predicate/v1",
              kind: "time.after",
              at: "2026-06-11T00:00:00.000Z",
            },
          },
        ],
        runtime: { backend: "claude_desktop" },
        prompt: { body: "Run after task." },
      };
      expect(predicateFromTaskManifest(task)).toMatchObject({
        kind: "time.after",
        at: "2026-06-11T00:00:00.000Z",
      });

      const opened = await openStateStore();
      try {
        const install = installTask(opened.db, {
          task,
          manifest_path: "/tmp/after.task.yaml",
          host: "blade",
          installed_by: "tester",
          status: "active",
        }).install;
        const taskRun = createTaskRun(opened.db, {
          task_id: install.task_id,
          install_id: install.install_id,
          trigger_kind: "predicate",
          status: "launch_intent_recorded",
          mode: "advisory",
          dry_run: true,
          launch_policy: install.launch_policy,
          summary: "Task trigger matched; launch intent recorded.",
        });
        const receiptPath = await appendTaskRunJsonlReceipt(path.join(root, "state"), taskRun);
        const withReceipt = setTaskRunReceiptPath(opened.db, taskRun.task_run_id, receiptPath);
        expect(withReceipt?.receipt_path).toBe(receiptPath);
        expect(listTaskRuns(opened.db, { task_id: "after-task" })).toHaveLength(1);
      } finally {
        opened.db.close();
      }
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("Codex automation bridge", () => {
  test("imports Codex automation TOML into a task manifest", async () => {
    const outDir = await makeTempRoot("calyx-task-import-");
    const result = await importCodexAutomationTasks({
      codexHome: fixturePath("codex-home"),
      outDir,
      id: "daily-maintenance",
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "tasks.codex-import-timezone-unset",
        }),
        expect.objectContaining({
          code: "tasks.codex-import-local-memory",
        }),
      ]),
    );
    expect(result.imported[0]?.warnings).toHaveLength(2);
    expect(result.imported[0]?.task.triggers).toEqual([
      expect.objectContaining({
        type: "schedule",
        rrule: "RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=30",
      }),
    ]);
    expect(result.imported[0]?.task).toMatchObject({
      id: "daily-maintenance",
      status: "active",
      runtime: {
        backend: "codex_app",
        model: "gpt-5.4",
        reasoning_effort: "high",
        workspace: {
          cwd: "/Users/carbon/dev/calyx/dev",
        },
      },
      prompt: {
        body: "Run the daily maintenance procedure.",
      },
    });
    expect(result.imported[0]?.task.state).toBeUndefined();

    const written = await readFile(path.join(outDir, "daily-maintenance.task.yaml"), "utf8");
    expect(written).toContain("id: daily-maintenance");
    expect(written).toContain("rrule: RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=30");
    expect(written).toContain("created_at: 1775093733222");
    expect(written).not.toContain("timezone:");
    expect(written).not.toContain("state:");
  });

  test("renders a task as Codex automation TOML", async () => {
    const outDir = await makeTempRoot("calyx-task-render-");
    const result = await renderCodexAutomationTask({
      tasksDir: fixturePath("render-safe"),
      taskId: "safe-codex-task",
      outDir,
      host: "carbon",
      now: new Date(1775093733222),
    });

    const renderedToml = await readFile(result.automationPath, "utf8");
    const parsed = parseToml(renderedToml) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      version: 1,
      id: "safe-codex-task",
      kind: "cron",
      name: "Safe Codex Task",
      prompt: "Run the exactly representable task.\n",
      status: "ACTIVE",
      rrule: "RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=30",
      model: "gpt-5.4",
      reasoning_effort: "high",
      execution_environment: "local",
      cwds: ["/Users/carbon/dev/calyx/dev"],
      created_at: 1775093733222,
      updated_at: 1775093733222,
    });
  });

  test("preserves imported Codex created_at while refreshing updated_at", async () => {
    const taskOutDir = await makeTempRoot("calyx-task-import-roundtrip-");
    const renderOutDir = await makeTempRoot("calyx-task-render-roundtrip-");
    await importCodexAutomationTasks({
      codexHome: fixturePath("codex-home"),
      outDir: taskOutDir,
      id: "daily-maintenance",
    });

    const result = await renderCodexAutomationTask({
      tasksDir: taskOutDir,
      taskId: "daily-maintenance",
      outDir: renderOutDir,
      now: new Date(1776000000000),
    });
    const parsed = parseToml(await readFile(result.automationPath, "utf8")) as Record<string, unknown>;

    expect(parsed.created_at).toBe(1775093733222);
    expect(parsed.updated_at).toBe(1776000000000);
  });

  test("refuses ambiguous Codex render targets without --host", async () => {
    const outDir = await makeTempRoot("calyx-task-render-ambiguous-");

    await expect(
      renderCodexAutomationTask({
        tasksDir: fixturePath("valid-multitarget"),
        taskId: "multi-target-task",
        outDir,
      }),
    ).rejects.toThrow("Pass --host to select one");
  });

  test("preflight enumerates every POL-995-shaped loss at its exact field path", async () => {
    const shown = await showTask(fixturePath("lossy-pol-995"), "linnaeus-public-parity");
    const receipt = preflightCodexTaskRender(shown.task, {
      host: "carbon",
      manifestPath: shown.manifestPath,
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.selected_target).toMatchObject({
      index: 0,
      path: "install.targets[0]",
      host: "carbon",
      status_source_path: "install.targets[0].status",
    });
    expect(receipt.losses.map((loss) => loss.path)).toEqual([
      "description",
      "owner",
      "triggers[0].timezone",
      "triggers[0].misfire_policy",
      "prompt.skills",
      "state.control",
      "state.outputs",
      "safety.destructive_actions",
      "safety.max_concurrency",
      "safety.requires_activity_quiet_window",
      "safety.stale_lock_minutes",
      "safety.timeout_minutes",
      "safety.unattended_writes",
      "runtime.workspace.mode",
      "install.targets[0].metadata",
      "install.targets[0].note",
    ]);
  });

  test("preflight catches predicates, extra triggers, runtime semantics, cwd conflicts, and status loss", async () => {
    const shown = await showTask(fixturePath("render-safe"), "safe-codex-task");
    const task = structuredClone(shown.task);
    const schedule = task.triggers[0];
    if (schedule?.type !== "schedule" || !task.runtime.workspace || !task.install?.targets?.[0]) {
      throw new Error("safe Codex fixture shape changed");
    }
    schedule.predicate = { schema_version: "predicate/v1", kind: "run.terminal", run_id: "run-1" };
    schedule.delivery = "unsupported";
    task.triggers.push({ type: "manual" });
    task.runtime.backend = "claude_desktop";
    task.runtime.agent = "claude";
    task.runtime.argv = ["echo", "not-codex"];
    task.runtime.workspace.cwds = ["/Users/carbon/dev/other"];
    task.install.targets[0]!.status = "retired";
    task["future_safety_policy"] = { approval: "required" };

    const receipt = preflightCodexTaskRender(task, { host: "carbon" });
    expect(receipt.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "future_safety_policy", code: "manifest.field_not_representable" }),
      expect.objectContaining({ path: "triggers[0].predicate" }),
      expect.objectContaining({ path: "triggers[0].delivery" }),
      expect.objectContaining({ path: "triggers[1]", code: "trigger.extra" }),
      expect.objectContaining({ path: "runtime.backend", code: "runtime.backend_not_codex" }),
      expect.objectContaining({ path: "runtime.agent", code: "runtime.agent_not_codex" }),
      expect.objectContaining({ path: "runtime.argv", code: "runtime.field_not_representable" }),
      expect.objectContaining({
        path: "runtime.workspace.cwd",
        related_paths: ["runtime.workspace.cwds[0]"],
      }),
      expect.objectContaining({ path: "install.targets[0].status", code: "status.not_representable" }),
    ]));
  });

  test("lossy render refuses before creating an automation file", async () => {
    const outDir = await makeTempRoot("calyx-task-render-loss-");
    const render = renderCodexAutomationTask({
      tasksDir: fixturePath("lossy-pol-995"),
      taskId: "linnaeus-public-parity",
      outDir,
      host: "carbon",
    });

    await expect(render).rejects.toBeInstanceOf(TaskRenderError);
    await expect(
      readFile(path.join(outDir, "linnaeus-public-parity", "automation.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("install and resume refuse loss while reconcile and doctor flag historical installs", async () => {
    const root = await makeTempRoot("calyx-task-render-lifecycle-loss-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(root, "state");

    try {
      await applyStateMigrations();
      const shown = await showTask(fixturePath("lossy-pol-995"), "linnaeus-public-parity");
      const opened = await openStateStore();
      try {
        expect(() => installTask(opened.db, {
          task: shown.task,
          manifest_path: shown.manifestPath,
          host: "carbon",
          installed_by: "tester",
        })).toThrow(TaskRenderError);
        expect(countTaskInstalls(opened.db)).toBe(0);

        const exactTask = exactCodexProjection(shown.task);
        const installed = installTask(opened.db, {
          task: exactTask,
          manifest_path: shown.manifestPath,
          host: "carbon",
          installed_by: "pre-pol-1960",
        }).install;
        opened.db.prepare(
          "UPDATE task_installs SET task_json = ?, manifest_hash = ? WHERE install_id = ?",
        ).run(JSON.stringify(shown.task), hashTaskManifest(shown.task), installed.install_id);

        expect(() => setTaskInstallStatus(opened.db, installed.install_id, "active")).toThrow(TaskRenderError);
        const historical = readTaskInstall(opened.db, installed.install_id);
        expect(historical?.status).toBe("paused");
        const findings = reconcileTaskInstall(opened.db, historical!, shown.task, shown.manifestPath);
        expect(findings).toEqual(expect.arrayContaining([
          expect.objectContaining({
            code: "tasks.codex-render-loss",
            severity: "error",
            receipt: expect.objectContaining({ ok: false }),
          }),
        ]));
      } finally {
        opened.db.close();
      }

      const report = await runStateDoctor({ domains: ["tasks"] });
      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "tasks-codex-render-loss",
          severity: "error",
          receipt: expect.objectContaining({ ok: false }),
        }),
      ]));
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("doctor fails closed when the historical render-loss scan is truncated", async () => {
    const root = await makeTempRoot("calyx-task-render-doctor-truncation-");
    const original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of STATE_ENV_KEYS) delete process.env[key];
    process.env["CALYX_STATE_HOME"] = path.join(root, "state");

    try {
      await applyStateMigrations();
      const shown = await showTask(fixturePath("render-safe"), "safe-codex-task");
      const opened = await openStateStore();
      try {
        opened.db.exec("BEGIN IMMEDIATE");
        try {
          for (let index = 0; index < 501; index += 1) {
            const task = structuredClone(shown.task);
            task.id = `safe-codex-task-${String(index).padStart(3, "0")}`;
            installTask(opened.db, {
              task,
              manifest_path: shown.manifestPath,
              host: "carbon",
              installed_by: "doctor-truncation-test",
            });
          }
          opened.db.exec("COMMIT");
        } catch (error) {
          opened.db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        opened.db.close();
      }

      const report = await runStateDoctor({ domains: ["tasks"] });
      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "tasks-codex-render-loss-scan-truncated",
          severity: "error",
        }),
      ]));
    } finally {
      for (const key of STATE_ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
