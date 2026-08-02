import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ackMonitorWake,
  applyStateMigrations,
  cancelMonitor,
  claimMonitorWakes,
  checkMonitorSchema,
  completeMonitorDelivery,
  createMonitor,
  createMonitorDeliveryAttempt,
  createMonitorSessionIngressDeliveryAttempt,
  createMonitorDeliveryPolicy,
  createMonitorWake,
  defaultMonitorDeliveryBinding,
  defaultRunnerSupervisionDeliveryBinding,
  evaluatePredicateV1,
  listMonitorDeliveries,
  listMonitorHistory,
  listMonitorWakes,
  monitorDeliveryBindings,
  openStateStore,
  readMonitor,
  readMonitorDeliveryAggregate,
  readMonitorWake,
  recordMonitorEvaluation,
  runStateDoctor,
  STATE_MIGRATIONS,
  type PredicateV1,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

const REQUEST_PROVENANCE = {
  schema_version: "calyx.provenance/v1" as const,
  request_id: "req_22222222-2222-4222-8222-222222222222",
  subject: "control-plane:test",
  asserted_actor: "operator:tester",
  host: "blade",
  via: "http" as const,
  at: "2026-06-11T00:00:00.000Z",
};

function runnerSupervisionPredicate(runId: string): PredicateV1 {
  return {
    schema_version: "predicate/v1",
    kind: "any_of",
    predicates: [
      { schema_version: "predicate/v1", kind: "run.failed", run_id: runId },
      { schema_version: "predicate/v1", kind: "run.terminal", run_id: runId },
    ],
  };
}

describe("monitor state and predicates", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-monitors-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
    await applyStateMigrations();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("migration 0007 creates monitor tables and state doctor reports them", async () => {
    const opened = await openStateStore();
    try {
      expect(checkMonitorSchema(opened.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor({ domains: ["monitors"] });
    expect(report.ok).toBe(true);
    expect(report.monitors).toMatchObject({
      migrationApplied: true,
      schemaParity: "ok",
      monitorCount: 0,
      wakeCount: 0,
    });
    expect(report.domains?.find((domain) => domain.domain === "monitors")).toMatchObject({
      status: "ok",
    });
  });

  test("migration 0033 persists monitor wake claimant leases", async () => {
    const opened = await openStateStore();
    try {
      expect((opened.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
      const columns = (opened.db.prepare("PRAGMA table_info(monitor_wakes)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["claimed_by", "claimed_until"]));
      const indexes = (opened.db.prepare("PRAGMA index_list(monitor_wakes)").all() as Array<{ name: string }>)
        .map((index) => index.name);
      expect(indexes).toEqual(expect.arrayContaining([
        "idx_monitor_wakes_claimed_until",
        "idx_monitor_wakes_claimant",
      ]));
    } finally {
      opened.db.close();
    }
  });

  test("evaluates runner predicates with evidence and de-duplicates wake transitions", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-core");
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_core_1",
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "blade",
        source_run_id: "run-monitor-core",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "every_change",
        delivery: defaultMonitorDeliveryBinding(),
        now: "2026-06-11T00:00:00.000Z",
      });

      const providerConstraint = {
        schema_version: "calyx.provider-constraint/v1" as const,
        cause: "provider_capacity_exhausted" as const,
        backend: "claude",
        kind: "session_window",
        source: "session_transcript",
        observed_at: "2026-07-21T07:06:08.573Z",
        confidence: "definitive" as const,
        reset_hint: "resets 8:10am (UTC)",
      };
      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-core",
          state: "succeeded",
          provider_constraint: providerConstraint,
          updated_at: "2026-06-11T00:01:00.000Z",
          completed_at: null,
        }),
      });
      expect(evaluation.matched).toBe(true);
      expect(evaluation.evidence).toContainEqual(
        expect.objectContaining({
          kind: "run.terminal",
          value: expect.objectContaining({ provider_constraint: providerConstraint }),
        }),
      );
      const completedEvaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:01.000Z"),
        readRun: () => ({
          run_id: "run-monitor-core",
          state: "succeeded",
          provider_constraint: providerConstraint,
          updated_at: "2026-06-11T00:01:01.000Z",
          completed_at: "2026-06-11T00:01:00.500Z",
        }),
      }, evaluation.cursor);
      expect(completedEvaluation.transition_hash).toBe(evaluation.transition_hash);
      expect(completedEvaluation.evidence).toContainEqual(
        expect.objectContaining({
          kind: "run.terminal",
          value: expect.objectContaining({ completed_at: "2026-06-11T00:01:00.500Z" }),
        }),
      );
      const changedConstraintEvaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:02.000Z"),
        readRun: () => ({
          run_id: "run-monitor-core",
          state: "succeeded",
          provider_constraint: {
            ...providerConstraint,
            backend: "codex",
            kind: "credits",
            source: "backend_stderr",
            reset_hint: "try again at 03:00 UTC",
          },
          updated_at: "2026-06-11T00:01:02.000Z",
          completed_at: "2026-06-11T00:01:00.500Z",
        }),
      }, completedEvaluation.cursor);
      expect(changedConstraintEvaluation.transition_hash).not.toBe(evaluation.transition_hash);

      const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation);
      expect(updated?.last_match).toBe(true);

      const first = createMonitorWake(opened.db, {
        monitor: updated!,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      });
      const second = createMonitorWake(opened.db, {
        monitor: updated!,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      });
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.wake.wake_id).toBe(first.wake.wake_id);
      const completedUpdated = recordMonitorEvaluation(opened.db, monitor.monitor_id, completedEvaluation);
      const completedSecond = createMonitorWake(opened.db, {
        monitor: completedUpdated!,
        evaluation: completedEvaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: completedEvaluation.evaluated_at,
      });
      expect(completedSecond.inserted).toBe(false);
      expect(completedSecond.wake.wake_id).toBe(first.wake.wake_id);

      const pending = listMonitorWakes(opened.db, { status: "pending" });
      expect(pending).toHaveLength(1);
      expect(() => ackMonitorWake(opened.db, first.wake.wake_id, {
        acked_by: "operator",
        acked_at: "2026-06-11T00:01:30.000Z",
      })).toThrow(/monitor_wake_not_claimed/);
      expect(claimMonitorWakes(opened.db, {
        claimed_by: "operator",
        claimed_at: "2026-06-11T00:01:30.000Z",
      })).toHaveLength(1);
      const acked = ackMonitorWake(opened.db, first.wake.wake_id, {
        acked_by: "operator",
        acked_at: "2026-06-11T00:02:00.000Z",
      });
      expect(acked.changed).toBe(true);
      expect(acked.wake?.status).toBe("acked");
      expect(listMonitorHistory(opened.db, monitor.monitor_id).map((row) => row.event_type)).toContain("monitor.wake.acked");
      expect(readMonitor(opened.db, monitor.monitor_id)?.last_transition_hash).toBe(evaluation.transition_hash);
    } finally {
      opened.db.close();
    }
  });

  test("claims monitor wakes once and projects shared session ingress as bounded delivery evidence", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-claim");
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_claim_1",
        owner: "interactive:codex:claim-owner",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "blade",
        source_run_id: "run-monitor-claim",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "once",
        delivery: defaultMonitorDeliveryBinding(),
        now: "2026-06-11T00:00:00.000Z",
      });
      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-claim",
          state: "failed",
          updated_at: "2026-06-11T00:01:00.000Z",
          completed_at: "2026-06-11T00:01:00.000Z",
        }),
      });
      const wake = createMonitorWake(opened.db, {
        monitor,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      }).wake;

      const claimed = claimMonitorWakes(opened.db, {
        claimed_by: "interactive:codex:claim-owner",
        claimed_at: "2026-06-11T00:02:00.000Z",
      });
      expect(claimed).toEqual([expect.objectContaining({ wake_id: wake.wake_id, status: "claimed" })]);
      expect(claimMonitorWakes(opened.db, { claimed_by: "other" })).toEqual([]);
      expect(listMonitorHistory(opened.db, monitor.monitor_id)).toContainEqual(
        expect.objectContaining({
          event_type: "monitor.wake.claimed",
          evidence: expect.objectContaining({ claimed_by: "interactive:codex:claim-owner" }),
        }),
      );

      const projected = createMonitorSessionIngressDeliveryAttempt(opened.db, {
        wake: claimed[0]!,
        activity_id: monitor.owner,
        attempted_at: "2026-06-11T00:02:01.000Z",
        target: { pointer_kind: "monitor_wake", pointer_id: wake.wake_id },
      });
      completeMonitorDelivery(opened.db, {
        delivery_id: projected.delivery.delivery_id,
        status: "delivered",
        completed_at: "2026-06-11T00:02:02.000Z",
        evidence: { wake_state: "wake_delivered", first_command: "calyx monitor inbox --json" },
      });
      expect(listMonitorDeliveries(opened.db, { wake_id: wake.wake_id })).toEqual([
        expect.objectContaining({
          adapter: "session_ingress",
          status: "delivered",
          target: expect.objectContaining({ activity_id: monitor.owner }),
          evidence: expect.objectContaining({ wake_state: "wake_delivered" }),
        }),
      ]);

      expect(ackMonitorWake(opened.db, wake.wake_id, {
        acked_by: monitor.owner,
        acked_at: "2026-06-11T00:02:03.000Z",
      }).wake).toMatchObject({
        status: "acked",
        acked_by: monitor.owner,
      });
    } finally {
      opened.db.close();
    }
  });

  test("isolates wake claims by monitor owner and replays the claimant lease after response loss", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-owner-isolation");
      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T01:01:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-owner-isolation",
          state: "failed",
          updated_at: "2026-06-11T01:01:00.000Z",
          completed_at: "2026-06-11T01:01:00.000Z",
        }),
      });
      const createOwnedWake = (monitorId: string, owner: string) => {
        const monitor = createMonitor(opened.db, {
          monitor_id: monitorId,
          owner,
          created_by: "tester",
          create_provenance: "operator",
          assigned_host: "blade",
          source_run_id: "run-monitor-owner-isolation",
          preset: "runner-supervision",
          predicate,
          rearm_policy: "once",
          delivery: defaultMonitorDeliveryBinding(),
          now: "2026-06-11T01:00:00.000Z",
        });
        return createMonitorWake(opened.db, {
          monitor,
          evaluation,
          suggested_commands: ["calyx monitor inbox --json"],
          created_at: evaluation.evaluated_at,
        }).wake;
      };
      const ownerA = "interactive:codex:owner-a";
      const ownerB = "interactive:codex:owner-b";
      const wakeA = createOwnedWake("mon_owner_a", ownerA);
      const wakeB = createOwnedWake("mon_owner_b", ownerB);

      const first = claimMonitorWakes(opened.db, {
        claimed_by: ownerA,
        claimed_at: "2026-06-11T01:02:00.000Z",
      });
      expect(first).toEqual([
        expect.objectContaining({
          wake_id: wakeA.wake_id,
          status: "claimed",
          claimed_by: ownerA,
          claimed_until: "2026-06-11T01:07:00.000Z",
        }),
      ]);
      expect(readMonitorWake(opened.db, wakeB.wake_id)).toMatchObject({
        status: "pending",
        claimed_by: null,
        claimed_until: null,
      });

      const replay = claimMonitorWakes(opened.db, {
        claimed_by: ownerA,
        claimed_at: "2026-06-11T01:02:30.000Z",
      });
      expect(replay).toEqual(first);
      expect(listMonitorHistory(opened.db, "mon_owner_a").filter(
        (event) => event.event_type === "monitor.wake.claimed",
      )).toHaveLength(1);

      const ownerBClaim = claimMonitorWakes(opened.db, {
        claimed_by: ownerB,
        claimed_at: "2026-06-11T01:03:00.000Z",
      });
      expect(ownerBClaim.map((wake) => wake.wake_id)).toEqual([wakeB.wake_id]);

      expect(() => ackMonitorWake(opened.db, wakeA.wake_id, {
        acked_by: ownerA,
        acked_at: "2026-06-11T01:07:01.000Z",
      })).toThrow(/monitor_wake_claim_expired/);
      const recoveredAfterLease = claimMonitorWakes(opened.db, {
        claimed_by: ownerA,
        claimed_at: "2026-06-11T01:07:01.000Z",
      });
      expect(recoveredAfterLease).toEqual([
        expect.objectContaining({
          wake_id: wakeA.wake_id,
          status: "claimed",
          claimed_by: ownerA,
          claimed_until: "2026-06-11T01:12:01.000Z",
        }),
      ]);
      expect(listMonitorHistory(opened.db, "mon_owner_a")).toContainEqual(
        expect.objectContaining({ event_type: "monitor.wake.claim.expired", wake_id: wakeA.wake_id }),
      );
      expect(() => ackMonitorWake(opened.db, wakeA.wake_id, {
        acked_by: ownerB,
        acked_at: "2026-06-11T01:08:00.000Z",
      })).toThrow(/monitor_wake_claimant_mismatch/);
      expect(readMonitorWake(opened.db, wakeA.wake_id)?.status).toBe("claimed");
      expect(ackMonitorWake(opened.db, wakeA.wake_id, {
        acked_by: ownerA,
        acked_at: "2026-06-11T01:08:00.000Z",
      })).toMatchObject({
        changed: true,
        wake: expect.objectContaining({ status: "acked", acked_by: ownerA }),
      });
      expect(ackMonitorWake(opened.db, wakeA.wake_id, { acked_by: ownerA }).changed).toBe(false);
      expect(() => ackMonitorWake(opened.db, wakeA.wake_id, { acked_by: ownerB }))
        .toThrow(/monitor_wake_claimant_mismatch/);
    } finally {
      opened.db.close();
    }
  });

  test("uses a stable logical transition for terminal runner wakes across run snapshot shape changes", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-stable-transition");
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_stable_transition_1",
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "blade",
        source_run_id: "run-monitor-stable-transition",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "every_change",
        delivery: defaultMonitorDeliveryBinding(),
        now: "2026-06-11T00:00:00.000Z",
      });

      const originalShape = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-stable-transition",
          state: "succeeded",
          updated_at: "2026-06-11T00:01:00.000Z",
          completed_at: "2026-06-11T00:01:00.000Z",
        }),
      });
      const upgradedShape = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:02:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-stable-transition",
          state: "succeeded",
          issue: "POL-1770",
          summary: "Newer daemon shape includes extra run metadata.",
          updated_at: "2026-06-11T00:02:00.000Z",
          completed_at: "2026-06-11T00:01:00.000Z",
        }),
      });

      expect(originalShape.matched).toBe(true);
      expect(upgradedShape.matched).toBe(true);
      expect(upgradedShape.transition_hash).toBe(originalShape.transition_hash);

      const firstUpdated = recordMonitorEvaluation(opened.db, monitor.monitor_id, originalShape);
      const firstWake = createMonitorWake(opened.db, {
        monitor: firstUpdated!,
        evaluation: originalShape,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: originalShape.evaluated_at,
      });
      claimMonitorWakes(opened.db, {
        claimed_by: monitor.owner,
        claimed_at: "2026-06-11T00:01:15.000Z",
        monitor_id: monitor.monitor_id,
      });
      ackMonitorWake(opened.db, firstWake.wake.wake_id, {
        acked_by: monitor.owner,
        acked_at: "2026-06-11T00:01:30.000Z",
      });

      const upgradedUpdated = recordMonitorEvaluation(opened.db, monitor.monitor_id, upgradedShape);
      const upgradedWake = createMonitorWake(opened.db, {
        monitor: upgradedUpdated!,
        evaluation: upgradedShape,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: upgradedShape.evaluated_at,
      });

      expect(firstWake.inserted).toBe(true);
      expect(upgradedWake.inserted).toBe(false);
      expect(upgradedWake.wake.wake_id).toBe(firstWake.wake.wake_id);
      expect(listMonitorWakes(opened.db, { status: "all", monitor_id: monitor.monitor_id })).toHaveLength(1);
      expect(listMonitorWakes(opened.db, { status: "acked", monitor_id: monitor.monitor_id })).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("stores first-request provenance and keeps cancel and wake ack atomic with history", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-provenance");
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_provenance_1",
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "blade",
        source_run_id: "run-monitor-provenance",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "every_change",
        delivery: defaultMonitorDeliveryBinding(),
        now: "2026-06-11T00:00:00.000Z",
        created_request_provenance: REQUEST_PROVENANCE,
      });
      expect(monitor.created_request_provenance).toEqual(REQUEST_PROVENANCE);
      expect(listMonitorHistory(opened.db, monitor.monitor_id).at(-1)).toMatchObject({
        event_type: "monitor.created",
        provenance: REQUEST_PROVENANCE,
      });

      opened.db.exec("ALTER TABLE monitor_history RENAME TO monitor_history_unavailable");
      expect(() => cancelMonitor(opened.db, monitor.monitor_id, {
        cancelled_at: "2026-06-11T00:01:00.000Z",
        provenance: REQUEST_PROVENANCE,
      })).toThrow(/monitor_history/);
      expect(readMonitor(opened.db, monitor.monitor_id)?.status).toBe("active");
      opened.db.exec("ALTER TABLE monitor_history_unavailable RENAME TO monitor_history");

      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:02:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-provenance",
          state: "failed",
          updated_at: "2026-06-11T00:02:00.000Z",
          completed_at: "2026-06-11T00:02:00.000Z",
        }),
      });
      const wake = createMonitorWake(opened.db, {
        monitor,
        evaluation,
        suggested_commands: [],
        created_at: evaluation.evaluated_at,
      }).wake;
      claimMonitorWakes(opened.db, {
        claimed_by: monitor.owner,
        claimed_at: "2026-06-11T00:02:30.000Z",
        monitor_id: monitor.monitor_id,
      });
      opened.db.exec("ALTER TABLE monitor_history RENAME TO monitor_history_unavailable");
      expect(() => ackMonitorWake(opened.db, wake.wake_id, {
        acked_by: monitor.owner,
        acked_at: "2026-06-11T00:03:00.000Z",
        provenance: REQUEST_PROVENANCE,
      })).toThrow(/monitor_history/);
      expect(readMonitorWake(opened.db, wake.wake_id)?.status).toBe("claimed");
      opened.db.exec("ALTER TABLE monitor_history_unavailable RENAME TO monitor_history");

      expect(ackMonitorWake(opened.db, wake.wake_id, {
        acked_by: monitor.owner,
        acked_at: "2026-06-11T00:03:00.000Z",
        provenance: REQUEST_PROVENANCE,
      }).changed).toBe(true);
      const replayProvenance = {
        ...REQUEST_PROVENANCE,
        request_id: "req_33333333-3333-4333-8333-333333333333",
      };
      expect(ackMonitorWake(opened.db, wake.wake_id, {
        acked_by: monitor.owner,
        provenance: replayProvenance,
      }).changed).toBe(false);
      const ackHistory = listMonitorHistory(opened.db, monitor.monitor_id)
        .filter((row) => row.event_type === "monitor.wake.acked");
      expect(ackHistory).toHaveLength(1);
      expect(ackHistory[0]?.provenance).toEqual(REQUEST_PROVENANCE);

      expect(cancelMonitor(opened.db, monitor.monitor_id, {
        cancelled_at: "2026-06-11T00:04:00.000Z",
        provenance: REQUEST_PROVENANCE,
      })?.status).toBe("cancelled");
      expect(cancelMonitor(opened.db, monitor.monitor_id, {
        cancelled_at: "2026-06-11T00:05:00.000Z",
        provenance: replayProvenance,
      })?.status).toBe("cancelled");
      const cancelHistory = listMonitorHistory(opened.db, monitor.monitor_id)
        .filter((row) => row.event_type === "monitor.cancelled");
      expect(cancelHistory).toHaveLength(1);
      expect(cancelHistory[0]?.provenance).toEqual(REQUEST_PROVENANCE);
    } finally {
      opened.db.close();
    }
  });

  test("records per-binding delivery state exactly once", async () => {
    const opened = await openStateStore();
    try {
      const predicate = runnerSupervisionPredicate("run-monitor-delivery");
      const delivery = createMonitorDeliveryPolicy([
        {
          schema_version: "calyx.monitor-delivery/v1",
          binding_id: "test-ntfy",
          adapter: "ntfy",
          materiality: {
            schema_version: "calyx.monitor-materiality/v1",
            kind: "run_failed_or_stalled",
          },
          ntfy: { topic: "scratch" },
        },
      ]);
      const monitor = createMonitor(opened.db, {
        monitor_id: "mon_delivery_1",
        owner: "operator",
        created_by: "tester",
        create_provenance: "operator",
        assigned_host: "blade",
        source_run_id: "run-monitor-delivery",
        preset: "runner-supervision",
        predicate,
        rearm_policy: "every_change",
        delivery,
        now: "2026-06-11T00:00:00.000Z",
      });
      const evaluation = await evaluatePredicateV1(predicate, {
        now: () => new Date("2026-06-11T00:01:00.000Z"),
        readRun: () => ({
          run_id: "run-monitor-delivery",
          state: "failed",
          issue: "POL-TEST",
          updated_at: "2026-06-11T00:01:00.000Z",
          completed_at: "2026-06-11T00:01:00.000Z",
        }),
      });
      const updated = recordMonitorEvaluation(opened.db, monitor.monitor_id, evaluation);
      const wake = createMonitorWake(opened.db, {
        monitor: updated!,
        evaluation,
        suggested_commands: ["calyx monitor inbox --json"],
        created_at: evaluation.evaluated_at,
      }).wake;

      const binding = delivery.bindings[0]!;
      const first = createMonitorDeliveryAttempt(opened.db, {
        wake,
        binding,
        attempted_at: "2026-06-11T00:01:01.000Z",
        target: { topic: "scratch" },
      });
      const second = createMonitorDeliveryAttempt(opened.db, {
        wake,
        binding,
        attempted_at: "2026-06-11T00:01:02.000Z",
        target: { topic: "scratch" },
      });
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.delivery.delivery_id).toBe(first.delivery.delivery_id);

      const failed = completeMonitorDelivery(opened.db, {
        delivery_id: first.delivery.delivery_id,
        status: "failed",
        completed_at: "2026-06-11T00:01:03.000Z",
        evidence: { http_status: 500 },
        error_code: "http_error",
        error_message: "ntfy returned HTTP 500",
      });
      const repeated = completeMonitorDelivery(opened.db, {
        delivery_id: first.delivery.delivery_id,
        status: "delivered",
        completed_at: "2026-06-11T00:01:04.000Z",
      });

      expect(failed?.status).toBe("failed");
      expect(repeated?.status).toBe("failed");
      expect(listMonitorDeliveries(opened.db, { wake_id: wake.wake_id })).toHaveLength(1);
      expect(listMonitorHistory(opened.db, monitor.monitor_id).map((row) => row.event_type)).toEqual(
        expect.arrayContaining(["monitor.delivery.attempted", "monitor.delivery.failed"]),
      );
      const report = await runStateDoctor({ domains: ["monitors"] });
      expect(report.monitors.deliveryCount).toBe(1);
      expect(report.monitors.deliveryCounts.failed).toBe(1);

      const insertBulkDelivery = opened.db.prepare(
        `INSERT INTO monitor_deliveries
          (delivery_id, wake_id, monitor_id, binding_id, adapter, status,
           attempted_at, delivered_at, failed_at, updated_at, target_json,
           evidence_json, error_code, error_message)
         VALUES (?, ?, ?, ?, 'ntfy', ?, ?, ?, ?, ?, '{}', '{}', ?, ?)`,
      );
      opened.db.exec("BEGIN");
      try {
        for (let index = 0; index < 501; index += 1) {
          const delivered = index % 2 === 0;
          const attemptedAt = new Date(Date.parse("2026-06-11T00:02:00.000Z") + index).toISOString();
          const completedAt = new Date(Date.parse("2026-06-11T00:03:00.000Z") + index).toISOString();
          insertBulkDelivery.run(
            `delivery_bulk_${index}`,
            wake.wake_id,
            monitor.monitor_id,
            `bulk-${index}`,
            delivered ? "delivered" : "failed",
            attemptedAt,
            delivered ? completedAt : null,
            delivered ? null : completedAt,
            completedAt,
            delivered ? null : "bulk_failure",
            delivered ? null : "proof failure",
          );
        }
        opened.db.exec("COMMIT");
      } catch (error) {
        opened.db.exec("ROLLBACK");
        throw error;
      }
      expect(readMonitorDeliveryAggregate(opened.db, monitor.monitor_id)).toMatchObject({
        attempted: 502,
        delivered: 251,
        failed: 251,
      });
    } finally {
      opened.db.close();
    }
  });

  test("accepts Tier-2 harness bridge delivery bindings", () => {
    const delivery = createMonitorDeliveryPolicy([
      {
        schema_version: "calyx.monitor-delivery/v1",
        binding_id: "codex-thread",
        adapter: "codex_automation",
        materiality: {
          schema_version: "calyx.monitor-materiality/v1",
          kind: "always",
        },
        codex_automation: {
          thread_id: "019e7637-f599-7811-a4c1-c2edc6297666",
          dry_run: true,
        },
      },
      {
        schema_version: "calyx.monitor-delivery/v1",
        binding_id: "claude-session",
        adapter: "claude_reinvoke",
        materiality: {
          schema_version: "calyx.monitor-materiality/v1",
          kind: "always",
        },
        claude_reinvoke: {
          session_id: "session-123",
          cwd: "/tmp/calyx",
          dry_run: true,
        },
      },
      {
        schema_version: "calyx.monitor-delivery/v1",
        binding_id: "codex-steer",
        adapter: "codex_app_server_steer",
        materiality: {
          schema_version: "calyx.monitor-materiality/v1",
          kind: "always",
        },
        codex_app_server_steer: {
          run_id: "run-monitor-delivery",
          timeout_ms: 2_000,
        },
      },
      {
        schema_version: "calyx.monitor-delivery/v1",
        binding_id: "claude-channel",
        adapter: "claude_channel",
        materiality: {
          schema_version: "calyx.monitor-materiality/v1",
          kind: "always",
        },
        claude_channel: {
          receiver_url: "http://127.0.0.1:8788/calyx/monitor-wake",
          channel: "server:calyx-monitor",
          dry_run: true,
        },
      },
    ]);

    expect(monitorDeliveryBindings(delivery).map((binding) => binding.adapter)).toEqual([
      "codex_automation",
      "claude_reinvoke",
      "codex_app_server_steer",
      "claude_channel",
    ]);
  });

  test("runner-supervision default delivery is Tier-0 only (no failing Tier-1 skeleton) — POL-1899", () => {
    const delivery = defaultRunnerSupervisionDeliveryBinding();
    // Tier-0 (durable state row + JSONL receipt + SSE) is always present and unconditional.
    expect(delivery.tier0.adapters).toEqual(["state-row", "jsonl-receipt", "sse"]);
    // A static preset cannot carry a valid ntfy topic / Linear issue / vault path / agent
    // session, so it must default no Tier-1 push binding rather than ones that silently
    // target_unavailable. Tier-1 deliveries are explicit --deliver opt-ins.
    expect(monitorDeliveryBindings(delivery)).toEqual([]);
  });

  test("evaluates the bounded predicate/v1 vocabulary with evidence and cursors", async () => {
    const artifact = "/tmp/calyx-artifact";
    const changedArtifact: PredicateV1 = {
      schema_version: "predicate/v1",
      kind: "artifact.changed",
      path: artifact,
    };

    const artifactExists = await evaluatePredicateV1(
      { schema_version: "predicate/v1", kind: "artifact.exists", path: artifact },
      {
        now: () => new Date("2026-06-11T01:00:00.000Z"),
        statPath: () => ({ exists: true, path: artifact, mtime_ms: 10, size: 20 }),
      },
    );
    expect(artifactExists.matched).toBe(true);
    expect(artifactExists.evidence).toContainEqual(
      expect.objectContaining({ kind: "artifact.exists", source: "artifact", status: "matched" }),
    );

    const artifactBaseline = await evaluatePredicateV1(changedArtifact, {
      now: () => new Date("2026-06-11T01:00:00.000Z"),
      statPath: () => ({ exists: true, path: artifact, mtime_ms: 10, size: 20 }),
    });
    expect(artifactBaseline.matched).toBe(false);
    const artifactChanged = await evaluatePredicateV1(
      changedArtifact,
      {
        now: () => new Date("2026-06-11T01:01:00.000Z"),
        statPath: () => ({ exists: true, path: artifact, mtime_ms: 11, size: 25 }),
      },
      artifactBaseline.cursor,
    );
    expect(artifactChanged.matched).toBe(true);
    expect(artifactChanged.cursor).toMatchObject({ last_identity: { size: 25 } });

    const vaultPredicate: PredicateV1 = {
      schema_version: "predicate/v1",
      kind: "vault.path_changed",
      path: "40-context/example.md",
    };
    const vaultBaseline = await evaluatePredicateV1(vaultPredicate, {
      now: () => new Date("2026-06-11T01:00:00.000Z"),
      statPath: () => ({ exists: true, path: "40-context/example.md", mtime_ms: 100, size: 200 }),
    });
    const vaultChanged = await evaluatePredicateV1(
      vaultPredicate,
      {
        now: () => new Date("2026-06-11T01:02:00.000Z"),
        statPath: () => ({ exists: true, path: "40-context/example.md", mtime_ms: 101, size: 200 }),
      },
      vaultBaseline.cursor,
    );
    expect(vaultChanged.matched).toBe(true);
    expect(vaultChanged.evidence[0]).toMatchObject({ kind: "vault.path_changed", source: "vault" });

    const receipt = await evaluatePredicateV1(
      { schema_version: "predicate/v1", kind: "receipt.appeared", run_id: "run-receipt" },
      {
        now: () => new Date("2026-06-11T01:03:00.000Z"),
        readRun: () => ({
          run_id: "run-receipt",
          state: "succeeded",
          updated_at: "2026-06-11T01:03:00.000Z",
          receipt_path: "/tmp/kernel-receipt.json",
        }),
      },
    );
    expect(receipt.matched).toBe(true);
    expect(receipt.evidence[0]).toMatchObject({ kind: "receipt.appeared", status: "matched" });

    const trackerState: PredicateV1 = {
      schema_version: "predicate/v1",
      kind: "tracker.state_changed",
      tracker_id: "POL-1732",
      to_state: "In Review",
    };
    const trackerBaseline = await evaluatePredicateV1(trackerState, {
      now: () => new Date("2026-06-11T01:04:00.000Z"),
      readTracker: () => ({ tracker_id: "POL-1732", state: "In Progress", labels: [] }),
    });
    const trackerChanged = await evaluatePredicateV1(
      trackerState,
      {
        now: () => new Date("2026-06-11T01:05:00.000Z"),
        readTracker: () => ({ tracker_id: "POL-1732", state: "In Review", labels: ["monitor"] }),
      },
      trackerBaseline.cursor,
    );
    expect(trackerChanged.matched).toBe(true);

    const labelChanged = await evaluatePredicateV1(
      {
        schema_version: "predicate/v1",
        kind: "tracker.label_changed",
        tracker_id: "POL-1732",
        label: "monitor",
      },
      {
        now: () => new Date("2026-06-11T01:06:00.000Z"),
        readTracker: () => ({ tracker_id: "POL-1732", state: "In Review", labels: ["monitor"] }),
      },
      trackerBaseline.cursor,
    );
    expect(labelChanged.matched).toBe(true);

    const timeAfterPredicate: PredicateV1 = {
      schema_version: "predicate/v1",
      kind: "time.after",
      at: "2026-06-11T01:00:00.000Z",
    };
    const timeAfterFirst = await evaluatePredicateV1(timeAfterPredicate, {
      now: () => new Date("2026-06-11T01:10:00.000Z"),
    });
    const timeAfterSecond = await evaluatePredicateV1(timeAfterPredicate, {
      now: () => new Date("2026-06-11T01:11:00.000Z"),
    });
    expect(timeAfterFirst.matched).toBe(true);
    expect(timeAfterSecond.transition_hash).toBe(timeAfterFirst.transition_hash);

    const cronFirst = await evaluatePredicateV1(
      { schema_version: "predicate/v1", kind: "time.cron", expr: "*/5 * * * *" },
      { now: () => new Date("2026-06-11T01:10:00.000Z") },
    );
    const cronRepeat = await evaluatePredicateV1(
      { schema_version: "predicate/v1", kind: "time.cron", expr: "*/5 * * * *" },
      { now: () => new Date("2026-06-11T01:10:30.000Z") },
      cronFirst.cursor,
    );
    expect(cronFirst.matched).toBe(true);
    expect(cronRepeat.matched).toBe(false);

    const debounced = await evaluatePredicateV1(
      {
        schema_version: "predicate/v1",
        kind: "debounce",
        window_ms: 1000,
        predicate: { schema_version: "predicate/v1", kind: "run.terminal", run_id: "run-done" },
      },
      {
        now: () => new Date("2026-06-11T01:10:00.000Z"),
        readRun: () => ({ run_id: "run-done", state: "succeeded", updated_at: "2026-06-11T01:09:00.000Z" }),
      },
    );
    const debouncedMatured = await evaluatePredicateV1(
      {
        schema_version: "predicate/v1",
        kind: "debounce",
        window_ms: 1000,
        predicate: { schema_version: "predicate/v1", kind: "run.terminal", run_id: "run-done" },
      },
      {
        now: () => new Date("2026-06-11T01:10:02.000Z"),
        readRun: () => ({ run_id: "run-done", state: "succeeded", updated_at: "2026-06-11T01:09:00.000Z" }),
      },
      debounced.cursor,
    );
    expect(debounced.matched).toBe(false);
    expect(debouncedMatured.matched).toBe(true);
    expect(debouncedMatured.evidence.map((record) => record.kind)).toEqual(
      expect.arrayContaining(["debounce", "run.terminal"]),
    );

    const allOf = await evaluatePredicateV1(
      {
        schema_version: "predicate/v1",
        kind: "all_of",
        predicates: [
          { schema_version: "predicate/v1", kind: "time.after", at: "2026-06-11T01:00:00.000Z" },
          { schema_version: "predicate/v1", kind: "artifact.exists", path: artifact },
        ],
      },
      {
        now: () => new Date("2026-06-11T01:12:00.000Z"),
        statPath: () => ({ exists: true, path: artifact, mtime_ms: 10, size: 20 }),
      },
    );
    expect(allOf.matched).toBe(true);
    expect(allOf.evidence[0]).toMatchObject({ kind: "all_of", status: "matched" });
  });
});
