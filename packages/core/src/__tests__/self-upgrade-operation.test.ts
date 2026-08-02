import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applySelfUpgradeOperationTransition,
  appendSelfUpgradeOperationDurabilityIssue,
  bindSelfUpgradeOperationTarget,
  claimSelfUpgradeOperation,
  createSelfUpgradeOperation,
  discoverSelfUpgradeOperation,
  encodeSelfUpgradeOperationTransition,
  observeSelfUpgradeOperation,
  parseSelfUpgradeOperationTransition,
  readSelfUpgradeOperation,
  recoverSelfUpgradeOperation,
  SELF_UPGRADE_OPERATION_MAX_BYTES,
  SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST,
  selfUpgradeHostPhaseTransitionId,
  type SelfUpgradeHostPhaseTransition,
  type SelfUpgradeOperationTransition,
} from "../self-upgrade-operation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function initial() {
  return createSelfUpgradeOperation({
    operationId: "fleet-2026-07-21T08-00-00-000Z",
    writerId: "writer-test",
    conductorHost: "blade",
    targetRef: "origin/main",
    hosts: ["worm", "blade"],
    dryRun: false,
    parallel: true,
    failFast: false,
    startedAt: "2026-07-21T08:00:00.000Z",
  });
}

function phase(args: {
  host: string;
  phase: SelfUpgradeHostPhaseTransition["phase"];
  elapsedMs: number;
  emittedAt: string;
  sourceEventId: string;
}): SelfUpgradeHostPhaseTransition {
  const observation = {
    schema_version: "self-upgrade-operation/v1",
    record: "transition",
    kind: "host_phase",
    operation_id: initial().operation_id,
    emitted_at: args.emittedAt,
    observed_at: "2026-07-21T08:01:00.000Z",
    host: args.host,
    host_operation_id: `host-op-${args.host}`,
    source_event_id: args.sourceEventId,
    source_cursor: `cursor-${args.sourceEventId}`,
    source: "host_event",
    phase: args.phase,
    elapsed_ms: args.elapsedMs,
    synthetic: false,
  } satisfies Omit<SelfUpgradeHostPhaseTransition, "transition_id">;
  return {
    ...observation,
    transition_id: selfUpgradeHostPhaseTransitionId(observation),
  };
}

function applyAll(transitions: readonly SelfUpgradeOperationTransition[]) {
  return transitions.reduce(
    (record, transition) => applySelfUpgradeOperationTransition(record, transition).record,
    initial(),
  );
}

describe("self-upgrade-operation/v1", () => {
  test("reduces duplicate and reordered remote phases idempotently", () => {
    const build = phase({
      host: "worm",
      phase: "build",
      elapsedMs: 2_000,
      emittedAt: "2026-07-21T08:00:02.000Z",
      sourceEventId: "event-build",
    });
    const restart = phase({
      host: "worm",
      phase: "restart",
      elapsedMs: 8_000,
      emittedAt: "2026-07-21T08:00:08.000Z",
      sourceEventId: "event-restart",
    });

    const ordered = applyAll([build, restart]);
    const reordered = applyAll([restart, build, restart]);

    expect(reordered).toEqual(ordered);
    expect(reordered.hosts.worm).toMatchObject({
      execution_status: "pending",
      relay_mode: "stream",
      latest_phase: "restart",
      latest_phase_elapsed_ms: 8_000,
    });
    expect(reordered.transitions).toHaveLength(2);
    expect(applySelfUpgradeOperationTransition(reordered, restart)).toEqual({
      record: reordered,
      disposition: "duplicate",
    });

    const conflicting = {
      ...restart,
      observed_at: "2026-07-21T08:02:00.000Z",
      phase: "fetch" as const,
    };
    expect(parseSelfUpgradeOperationTransition(JSON.stringify(conflicting))).toBeUndefined();
    expect(() => applySelfUpgradeOperationTransition(reordered, conflicting))
      .toThrow(/content-address the complete phase observation/u);
  });

  test("keeps terminal relay evidence authoritative on same-timestamp phase collisions", () => {
    const emittedAt = "2026-07-21T08:00:08.000Z";
    const sameTimestampPhase = phase({
      host: "blade",
      phase: "restart",
      elapsedMs: 8_000,
      emittedAt,
      sourceEventId: "event-same-timestamp-phase",
    });
    const result: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "result-same-timestamp",
      operation_id: initial().operation_id,
      emitted_at: emittedAt,
      observed_at: emittedAt,
      host: "blade",
      status: "succeeded",
      elapsed_ms: 8_000,
      relay_mode: "missing",
    };

    const phaseThenResult = applyAll([sameTimestampPhase, result]);
    const resultThenPhase = applyAll([result, sameTimestampPhase]);

    expect(resultThenPhase).toEqual(phaseThenResult);
    expect(resultThenPhase.hosts.blade).toMatchObject({
      execution_status: "succeeded",
      latest_phase: "restart",
      relay_mode: "missing",
    });
  });

  test("keeps missing progress non-authoritative and becomes terminal only on fleet_final", () => {
    const dispatched: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_dispatched",
      transition_id: "dispatch-blade",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:01.000Z",
      observed_at: "2026-07-21T08:00:01.000Z",
      host: "blade",
      dispatch: "ssh",
    };
    const result: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "result-blade",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:20.000Z",
      observed_at: "2026-07-21T08:00:20.000Z",
      host: "blade",
      status: "succeeded",
      elapsed_ms: 19_000,
      relay_mode: "missing",
      before_head: "a".repeat(40),
      after_head: "b".repeat(40),
      receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
    };
    const wormResult: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "result-worm",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:21.000Z",
      observed_at: "2026-07-21T08:00:21.000Z",
      host: "worm",
      status: "succeeded",
      elapsed_ms: 20_000,
      relay_mode: "missing",
    };
    const beforeFinal = applyAll([dispatched, result, wormResult]);

    expect(beforeFinal.status).toBe("running");
    expect(beforeFinal.hosts.blade).toMatchObject({
      execution_status: "succeeded",
      relay_mode: "missing",
      receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
    });
    expect(beforeFinal.hosts.blade!.latest_phase).toBeUndefined();

    const prematureFinal: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "premature-final",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:10.000Z",
      observed_at: "2026-07-21T08:00:10.000Z",
      status: "succeeded",
      receipt_path: "/receipts/premature.json",
      rows: [{ host: "blade", status: "succeeded" }],
    };
    expect(applySelfUpgradeOperationTransition(
      applySelfUpgradeOperationTransition(initial(), dispatched).record,
      prematureFinal,
    )).toMatchObject({ disposition: "conflict" });

    const final: Extract<SelfUpgradeOperationTransition, { kind: "fleet_final" }> = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "fleet-final",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:30.000Z",
      observed_at: "2026-07-21T08:00:30.000Z",
      status: "succeeded",
      receipt_path: "/receipts/summary.json",
      rows: [{
        host: "blade",
        status: "succeeded",
        before_head: "a".repeat(40),
        after_head: "b".repeat(40),
        elapsed_ms: 19_000,
        receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
        freshness_verdict: "fresh",
      }, {
        host: "worm",
        status: "succeeded",
        elapsed_ms: 20_000,
        freshness_verdict: "fresh",
      }],
    };
    const terminal = applySelfUpgradeOperationTransition(beforeFinal, final).record;

    expect(terminal.status).toBe("succeeded");
    expect(terminal.transitions.at(-1)).toEqual(final);
    expect(terminal.final_receipt_path).toBe("/receipts/summary.json");
    expect(terminal.final_rows).toEqual(final.rows);
    expect(applySelfUpgradeOperationTransition(terminal, final)).toEqual({
      record: terminal,
      disposition: "duplicate",
    });

    const delayedAfterFinal = phase({
      host: "blade",
      phase: "finalize",
      elapsedMs: 25_000,
      emittedAt: "2026-07-21T08:00:25.000Z",
      sourceEventId: "event-delayed-finalize",
    });
    expect(applySelfUpgradeOperationTransition(terminal, delayedAfterFinal)).toEqual({
      record: terminal,
      disposition: "conflict",
    });
  });

  test("strictly parses transition frames and atomically persists the record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-"));
    roots.push(root);
    const transition = phase({
      host: "blade",
      phase: "health_wait",
      elapsedMs: 12_000,
      emittedAt: "2026-07-21T08:00:12.000Z",
      sourceEventId: "event-health",
    });

    expect(parseSelfUpgradeOperationTransition(encodeSelfUpgradeOperationTransition(transition))).toEqual(transition);
    expect(parseSelfUpgradeOperationTransition("ssh: connection banner")).toBeUndefined();
    expect(parseSelfUpgradeOperationTransition(JSON.stringify({
      ...transition,
      elapsed_ms: -1,
    }))).toBeUndefined();
    expect(parseSelfUpgradeOperationTransition(JSON.stringify({
      ...transition,
      extra_claim: "not admitted",
    }))).toBeUndefined();

    const bound = bindSelfUpgradeOperationTarget(initial(), "a".repeat(40), "2026-07-21T08:00:01.000Z");
    const record = applySelfUpgradeOperationTransition(bound, transition).record;
    const writer = await claimSelfUpgradeOperation(root, record, {
      now: () => "2026-07-21T08:00:01.000Z",
    });
    const written = writer.operationPath;

    expect(written).toBe(path.join(root, `${record.operation_id}.json`));
    expect(await readSelfUpgradeOperation(root, record.operation_id)).toEqual(record);
    expect(() => bindSelfUpgradeOperationTarget(record, "b".repeat(40), "2026-07-21T08:00:02.000Z"))
      .toThrow(/already bound/u);
    await writer.release();
  });

  test("rejects nested names at the public operation reader boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-id-"));
    roots.push(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(
      path.join(root, "nested", "operation.json"),
      `${JSON.stringify(initial(), null, 2)}\n`,
      "utf8",
    );

    await expect(readSelfUpgradeOperation(root, "nested/operation"))
      .rejects.toThrow(/Invalid self-upgrade operation id/u);
  });

  test("bounds authoritative operation reads before parsing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-bounded-read-"));
    roots.push(root);
    const operationId = "fleet-oversized-operation";
    const operationPath = path.join(root, `${operationId}.json`);
    await writeFile(operationPath, "{}", "utf8");
    await truncate(operationPath, SELF_UPGRADE_OPERATION_MAX_BYTES + 1);

    await expect(readSelfUpgradeOperation(root, operationId)).rejects.toMatchObject({
      code: "EFBIG",
    });
  });

  test("reports writer-generation liveness without treating the operation projection as mutation truth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-observe-"));
    roots.push(root);
    const record = appendSelfUpgradeOperationDurabilityIssue(initial(), {
      issue_id: "operation-write-degraded",
      observed_at: "2026-07-21T08:00:01.000Z",
      scope: "operation_state",
      code: "projection_write_failed",
      message: "the observation projection lost one update",
    });
    const writer = await claimSelfUpgradeOperation(root, record, {
      now: () => "2026-07-21T08:00:01.000Z",
      readProcessIdentity: async () => "generation-a",
    });
    const observationOptions = {
      now: () => "2026-07-21T08:00:02.000Z",
      readProcessIdentity: async () => "generation-a",
    };

    expect(await observeSelfUpgradeOperation(root, record.operation_id, {
      ...observationOptions,
      isProcessAlive: () => true,
    })).toMatchObject({
      observed_at: "2026-07-21T08:00:02.000Z",
      projection_status: "degraded",
      running_state: "active",
      owner_liveness: "live",
      owner_pid: process.pid,
      owner_claimed_at: "2026-07-21T08:00:01.000Z",
      operation: record,
    });

    expect(await observeSelfUpgradeOperation(root, record.operation_id, {
      ...observationOptions,
      isProcessAlive: () => true,
      readProcessIdentity: async () => "generation-b",
    })).toMatchObject({
      running_state: "orphaned",
      owner_liveness: "dead",
      operation: record,
    });

    expect(await observeSelfUpgradeOperation(root, record.operation_id, {
      ...observationOptions,
      isProcessAlive: () => true,
      readProcessIdentity: async () => undefined,
    })).toMatchObject({
      projection_status: "degraded",
      running_state: "indeterminate",
      owner_liveness: "unknown",
      operation: record,
    });

    await writer.release();
    expect(await observeSelfUpgradeOperation(root, record.operation_id, observationOptions)).toMatchObject({
      running_state: "orphaned",
      owner_liveness: "released",
      operation: record,
    });
  });

  test.each([
    ["operation id", { operation_id: "fleet-different-operation" }],
    ["writer id", { writer_id: "writer-different-generation" }],
  ])("keeps a mismatched %s indeterminate before process liveness", async (_label, mismatch) => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-owner-mismatch-"));
    roots.push(root);
    const record = initial();
    const writer = await claimSelfUpgradeOperation(root, record, {
      now: () => "2026-07-21T08:00:01.000Z",
      readProcessIdentity: async () => "generation-a",
    });
    const ownerPath = path.join(root, `${record.operation_id}.owner.json`);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, ...mismatch }, null, 2)}\n`, "utf8");
    const isProcessAlive = vi.fn(() => true);
    const readProcessIdentity = vi.fn(async () => "generation-a");

    expect(await observeSelfUpgradeOperation(root, record.operation_id, {
      now: () => "2026-07-21T08:00:02.000Z",
      isProcessAlive,
      readProcessIdentity,
    })).toMatchObject({
      projection_status: "degraded",
      running_state: "indeterminate",
      owner_liveness: "unknown",
      operation: record,
    });
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(readProcessIdentity).not.toHaveBeenCalled();

    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await writer.release();
  });

  test("discovers a live operation before a newer ownerless observation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-discover-"));
    roots.push(root);
    const activeRecord = createSelfUpgradeOperation({
      operationId: "fleet-active-older",
      writerId: "writer-active",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:00:00.000Z",
    });
    const active = await claimSelfUpgradeOperation(root, activeRecord, {
      now: () => "2026-07-21T08:00:00.000Z",
      readProcessIdentity: async () => "generation-a",
    });
    const newerRecord = createSelfUpgradeOperation({
      operationId: "fleet-ownerless-newer",
      writerId: "writer-ownerless",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T09:00:00.000Z",
    });
    const newer = await claimSelfUpgradeOperation(root, newerRecord, {
      now: () => "2026-07-21T09:00:00.000Z",
      readProcessIdentity: async () => "generation-b",
    });
    await newer.release();

    expect(await discoverSelfUpgradeOperation(root, {
      now: () => "2026-07-21T09:01:00.000Z",
      isProcessAlive: () => true,
      readProcessIdentity: async (pid) => (
        pid === process.pid ? "generation-a" : undefined
      ),
    })).toMatchObject({
      running_state: "active",
      operation: {
        operation_id: "fleet-active-older",
      },
    });

    await active.release();
    expect(await discoverSelfUpgradeOperation(root, {
      now: () => "2026-07-21T09:02:00.000Z",
    })).toMatchObject({
      running_state: "orphaned",
      operation: {
        operation_id: "fleet-ownerless-newer",
      },
    });
  });

  test("does not select a mismatched live owner over the exact active writer generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-discover-mismatch-"));
    roots.push(root);
    const exactRecord = createSelfUpgradeOperation({
      operationId: "fleet-exact-active",
      writerId: "writer-exact",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:00:00.000Z",
    });
    const exact = await claimSelfUpgradeOperation(root, exactRecord, {
      now: () => "2026-07-21T08:00:00.000Z",
      readProcessIdentity: async () => "generation-a",
    });
    const mismatchedRecord = createSelfUpgradeOperation({
      operationId: "fleet-mismatched-newer",
      writerId: "writer-canonical",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T09:00:00.000Z",
    });
    const mismatched = await claimSelfUpgradeOperation(root, mismatchedRecord, {
      now: () => "2026-07-21T09:00:00.000Z",
      readProcessIdentity: async () => "generation-b",
    });
    const mismatchedOwnerPath = path.join(root, `${mismatchedRecord.operation_id}.owner.json`);
    const mismatchedOwner = JSON.parse(await readFile(mismatchedOwnerPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      mismatchedOwnerPath,
      `${JSON.stringify({ ...mismatchedOwner, writer_id: "writer-different" }, null, 2)}\n`,
      "utf8",
    );

    expect(await discoverSelfUpgradeOperation(root, {
      now: () => "2026-07-21T09:01:00.000Z",
      isProcessAlive: () => true,
      readProcessIdentity: async () => "generation-a",
    })).toMatchObject({
      running_state: "active",
      operation: {
        operation_id: exactRecord.operation_id,
        writer_id: exactRecord.writer_id,
      },
    });

    await writeFile(mismatchedOwnerPath, `${JSON.stringify(mismatchedOwner, null, 2)}\n`, "utf8");
    await mismatched.release();
    await exact.release();
  });

  test("claims one writer, advances revisions, rejects stale candidates, and enforces private modes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-writer-"));
    roots.push(root);
    const writer = await claimSelfUpgradeOperation(root, initial(), {
      now: () => "2026-07-21T08:00:00.000Z",
    });

    await expect(claimSelfUpgradeOperation(root, initial())).rejects.toThrow(/already exists|already claimed/u);
    const candidate = bindSelfUpgradeOperationTarget(
      writer.record,
      "a".repeat(40),
      "2026-07-21T08:00:01.000Z",
    );
    const persisted = await writer.write(candidate);

    expect(persisted.revision).toBe(1);
    expect((await readSelfUpgradeOperation(root, persisted.operation_id)).revision).toBe(1);
    await expect(writer.write(candidate)).rejects.toThrow(/Stale self-upgrade operation candidate/u);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(writer.operationPath)).mode & 0o777).toBe(0o600);
    await writer.release();
    expect(await readdir(root)).not.toContain(`${writer.record.operation_id}.owner.json`);
  });

  test("creates every first-use authority ancestor with private posture", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-first-use-home-"));
    roots.push(home);
    const root = path.join(home, ".calyx", "self-upgrade-operations");
    const writer = await claimSelfUpgradeOperation(root, initial());

    expect((await stat(path.join(home, ".calyx"))).mode & 0o777).toBe(0o700);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(writer.operationPath)).mode & 0o777).toBe(0o600);
    await writer.release();
  });

  test("rejects a symlinked authority ancestor instead of publishing outside the host root", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-symlink-home-"));
    const redirect = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-symlink-target-"));
    roots.push(home, redirect);
    const redirectedRoot = path.join(redirect, "self-upgrade-operations");
    await mkdir(redirectedRoot);
    await symlink(redirect, path.join(home, ".calyx"), "dir");

    await expect(claimSelfUpgradeOperation(
      path.join(home, ".calyx", "self-upgrade-operations"),
      initial(),
    )).rejects.toThrow(/not a real directory/u);
    expect(await readdir(redirectedRoot)).toEqual([]);
  });

  test("holds descriptor authority across a post-claim ancestor swap", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-swap-home-"));
    const redirect = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-swap-target-"));
    roots.push(home, redirect);
    const root = path.join(home, ".calyx", "self-upgrade-operations");
    const redirectedRoot = path.join(redirect, "self-upgrade-operations");
    const writer = await claimSelfUpgradeOperation(root, initial());
    await rename(path.join(home, ".calyx"), path.join(home, ".calyx-held"));
    await mkdir(redirectedRoot);
    await symlink(redirect, path.join(home, ".calyx"), "dir");

    const candidate = bindSelfUpgradeOperationTarget(
      writer.record,
      "a".repeat(40),
      "2026-07-21T08:00:01.000Z",
    );
    await expect(writer.write(candidate)).rejects.toThrow(/not a real directory|identity changed/u);
    expect(await readdir(redirectedRoot)).toEqual([]);
    await expect(writer.release()).rejects.toThrow(/not a real directory|identity changed/u);
  });

  test("canonically bounds reordered remote phase growth without consuming result capacity", () => {
    const phases = Array.from(
      { length: SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST + 1 },
      (_, index) => phase({
        host: "blade",
        phase: "build",
        elapsedMs: index,
        emittedAt: `2026-07-21T08:00:${String(index).padStart(2, "0")}.000Z`,
        sourceEventId: `bounded-${index}`,
      }),
    );
    const ordered = applyAll(phases);
    const reversed = applyAll([...phases].reverse());

    expect(reversed).toEqual(ordered);
    expect(ordered.transitions.filter((transition) => transition.kind === "host_phase"))
      .toHaveLength(SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST);
    expect(ordered.transitions.some((transition) => transition.transition_id === phases[0]!.transition_id))
      .toBe(false);

    const olderOverflow = phase({
      host: "blade",
      phase: "fetch",
      elapsedMs: 0,
      emittedAt: "2026-07-21T07:59:00.000Z",
      sourceEventId: "bounded-older-overflow",
    });
    expect(applySelfUpgradeOperationTransition(ordered, olderOverflow)).toEqual({
      record: ordered,
      disposition: "bounded_drop",
    });

    const result: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "bounded-result",
      operation_id: ordered.operation_id,
      emitted_at: "2026-07-21T08:03:00.000Z",
      observed_at: "2026-07-21T08:03:00.000Z",
      host: "blade",
      status: "succeeded",
      elapsed_ms: 100_000,
      relay_mode: "stream",
    };
    expect(applySelfUpgradeOperationTransition(ordered, result).disposition).toBe("applied");
  });

  test("content addressing composes conflict rejection with cap eviction deterministically", () => {
    const canonical = phase({
      host: "blade",
      phase: "fetch",
      elapsedMs: 0,
      emittedAt: "2026-07-21T07:59:00.000Z",
      sourceEventId: "content-addressed-conflict",
    });
    const conflicting = {
      ...canonical,
      phase: "restart" as const,
      elapsed_ms: 99_000,
      emitted_at: "2026-07-21T08:59:00.000Z",
    };
    const fillers = Array.from(
      { length: SELF_UPGRADE_OPERATION_MAX_PHASE_TRANSITIONS_PER_HOST },
      (_, index) => phase({
        host: "blade",
        phase: "build",
        elapsedMs: index + 1,
        emittedAt: `2026-07-21T08:00:${String(index).padStart(2, "0")}.000Z`,
        sourceEventId: `content-addressed-filler-${index}`,
      }),
    );
    const replay = (values: readonly unknown[]) => values.reduce<ReturnType<typeof initial>>((record, value) => {
      const parsed = parseSelfUpgradeOperationTransition(JSON.stringify(value));
      return parsed ? applySelfUpgradeOperationTransition(record, parsed).record : record;
    }, initial());

    expect(parseSelfUpgradeOperationTransition(JSON.stringify(conflicting))).toBeUndefined();
    expect(replay([canonical, ...fillers, conflicting]))
      .toEqual(replay([conflicting, canonical, ...fillers]));
  });

  test("recovers a dead writer, fences the stale generation, and releases ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-recover-writer-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial(), {
      now: () => "2026-07-21T08:00:00.000Z",
    });
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    await utimes(ownerPath, new Date(0), new Date(0));

    const recovered = await recoverSelfUpgradeOperation(
      root,
      stale.record.operation_id,
      "writer-recovered",
      {
        now: () => "2026-07-21T08:10:00.000Z",
        nowMs: () => 10_000,
        staleOwnerMs: 1_000,
        isProcessAlive: () => false,
      },
    );

    expect(recovered.record.writer_id).toBe("writer-recovered");
    expect(recovered.record.revision).toBe(1);
    expect(recovered.record.durability_issues).toEqual([
      expect.objectContaining({ code: "writer_recovered", scope: "operation_state" }),
    ]);
    await expect(stale.write(stale.record)).rejects.toThrow(/claim changed|ENOENT/u);

    const rebound = await recovered.write(bindSelfUpgradeOperationTarget(
      recovered.record,
      "a".repeat(40),
      "2026-07-21T08:11:00.000Z",
    ));
    expect(rebound.revision).toBe(2);
    await recovered.release();
    await expect(stale.release()).rejects.toThrow(/claim changed|ENOENT/u);
    expect(await readdir(root)).not.toContain(path.basename(ownerPath));
  });

  test("recovers a stale owner when its numeric PID was reused by another process generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-reused-pid-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial(), {
      now: () => "2026-07-21T08:00:00.000Z",
      readProcessIdentity: async () => "generation-original",
    });
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    await utimes(ownerPath, new Date(0), new Date(0));

    const recovered = await recoverSelfUpgradeOperation(
      root,
      stale.record.operation_id,
      "writer-reused-pid-recovery",
      {
        now: () => "2026-07-21T08:10:00.000Z",
        nowMs: () => 10_000,
        staleOwnerMs: 1_000,
        isProcessAlive: () => true,
        readProcessIdentity: async () => "generation-reused",
      },
    );

    expect(recovered.record.writer_id).toBe("writer-reused-pid-recovery");
    await recovered.release();
    await expect(stale.release()).rejects.toThrow(/claim changed|ENOENT/u);
  });

  test("refuses recovery while the exact process generation still owns the projection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-live-generation-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial(), {
      now: () => "2026-07-21T08:00:00.000Z",
      readProcessIdentity: async () => "generation-live",
    });
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    await utimes(ownerPath, new Date(0), new Date(0));

    await expect(recoverSelfUpgradeOperation(
      root,
      stale.record.operation_id,
      "writer-must-not-recover",
      {
        nowMs: () => 10_000,
        staleOwnerMs: 1_000,
        isProcessAlive: () => true,
        readProcessIdentity: async () => "generation-live",
      },
    )).rejects.toThrow(/still live/u);

    await stale.release();
  });

  test("allows only one recovery writer when a released running operation is raced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-recover-race-"));
    roots.push(root);
    const abandoned = await claimSelfUpgradeOperation(root, initial());
    await abandoned.release();

    const recoveries = await Promise.allSettled([
      recoverSelfUpgradeOperation(root, abandoned.record.operation_id, "writer-recovery-a"),
      recoverSelfUpgradeOperation(root, abandoned.record.operation_id, "writer-recovery-b"),
    ]);
    const winners = recoveries.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof recoverSelfUpgradeOperation>>> => (
        result.status === "fulfilled"
      ),
    );
    const losers = recoveries.filter((result) => result.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0]!.value;
    const rebound = await winner.write(bindSelfUpgradeOperationTarget(
      winner.record,
      "a".repeat(40),
      "2026-07-21T08:11:00.000Z",
    ));
    expect(rebound.writer_id).toBe(winner.writerId);
    await winner.release();
  });

  test("fences the inspected generation when two recoverers race a stale owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-stale-owner-race-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial());
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    await utimes(ownerPath, new Date(0), new Date(0));

    let inspected = 0;
    let releaseInspections!: () => void;
    const bothInspected = new Promise<void>((resolve) => { releaseInspections = resolve; });
    let releaseSecond!: () => void;
    const secondMayRename = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let firstClaimed!: () => void;
    const firstOwnerInstalled = new Promise<void>((resolve) => { firstClaimed = resolve; });
    let releaseFirst!: () => void;
    const firstMayContinue = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const afterInspected = async (): Promise<void> => {
      inspected += 1;
      if (inspected === 2) {
        releaseInspections();
      }
      await bothInspected;
    };

    const first = recoverSelfUpgradeOperation(root, stale.record.operation_id, "writer-recovery-first", {
      now: () => "2026-07-21T08:10:00.000Z",
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      isProcessAlive: () => false,
      afterOwnerInspected: afterInspected,
      afterOwnerClaimed: async () => {
        firstClaimed();
        await firstMayContinue;
      },
    });
    const second = recoverSelfUpgradeOperation(root, stale.record.operation_id, "writer-recovery-second", {
      now: () => "2026-07-21T08:10:01.000Z",
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      isProcessAlive: () => false,
      afterOwnerInspected: async () => {
        await afterInspected();
        await secondMayRename;
      },
    });

    await firstOwnerInstalled;
    expect(await observeSelfUpgradeOperation(root, stale.record.operation_id, {
      now: () => "2026-07-21T08:10:00.500Z",
      isProcessAlive: () => true,
      readProcessIdentity: async () => "test-process-generation",
    })).toMatchObject({
      projection_status: "degraded",
      running_state: "indeterminate",
      owner_liveness: "unknown",
      operation: {
        writer_id: stale.record.writer_id,
      },
    });
    releaseSecond();
    const secondResult = await Promise.allSettled([second]);
    expect(secondResult[0]?.status).toBe("rejected");
    releaseFirst();
    const winner = await first;

    expect(winner.record.writer_id).toBe("writer-recovery-first");
    expect((await readSelfUpgradeOperation(root, winner.record.operation_id)).writer_id)
      .toBe("writer-recovery-first");
    await expect(stale.write(stale.record)).rejects.toThrow(/claim changed|ENOENT/u);
    await winner.release();
    await expect(stale.release()).rejects.toThrow(/claim changed|ENOENT/u);
  });

  test("rolls back a dead recovery claim that never rebound canonical authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-recovery-journal-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial());
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    const quarantinePath = `${ownerPath}.stale.interrupted-recovery`;
    await rename(ownerPath, quarantinePath);
    await utimes(quarantinePath, new Date(0), new Date(0));
    await writeFile(ownerPath, `${JSON.stringify({
      schema_version: "self-upgrade-operation-owner/v1",
      operation_id: stale.record.operation_id,
      writer_id: "writer-interrupted-recovery",
      claim_token: "interrupted-recovery-token",
      pid: 999_999,
      claimed_at: "2026-07-21T08:05:00.000Z",
    })}\n`, "utf8");
    await utimes(ownerPath, new Date(0), new Date(0));

    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-recovery-journal-sweeper",
      writerId: "writer-sweeper",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });
    const current = await claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      isProcessAlive: () => false,
    });

    await expect(stale.write(stale.record)).resolves.toMatchObject({ revision: 1 });
    expect(await readdir(root)).not.toContain(path.basename(quarantinePath));
    await stale.release();
    await current.release();
  });

  test("sweeps a dead mismatched recovery owner and leaves the canonical record recoverable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-mismatched-owner-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial());
    await stale.release();
    const ownerPath = path.join(root, `${stale.record.operation_id}.owner.json`);
    await writeFile(ownerPath, `${JSON.stringify({
      schema_version: "self-upgrade-operation-owner/v1",
      operation_id: stale.record.operation_id,
      writer_id: "writer-crashed-before-rebind",
      claim_token: "crashed-before-rebind-token",
      pid: 999_999,
      claimed_at: "2026-07-21T08:05:00.000Z",
    })}\n`, "utf8");
    await utimes(ownerPath, new Date(0), new Date(0));

    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-mismatched-owner-sweeper",
      writerId: "writer-sweeper",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });
    const current = await claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      isProcessAlive: () => false,
    });
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await current.release();

    const recovered = await recoverSelfUpgradeOperation(
      root,
      stale.record.operation_id,
      "writer-recovered-after-mismatch",
      {
        now: () => "2026-07-21T08:11:00.000Z",
        nowMs: () => 11_000,
        staleOwnerMs: 1_000,
        isProcessAlive: () => false,
        readProcessIdentity: async () => "test-process-generation",
      },
    );
    expect(recovered.record.writer_id).toBe("writer-recovered-after-mismatch");
    await recovered.release();
  });

  test("bounds a stale unreadable owner through quarantine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-unreadable-owner-"));
    roots.push(root);
    const stale = await claimSelfUpgradeOperation(root, initial());
    await stale.release();
    const ownerName = `${stale.record.operation_id}.owner.json`;
    const ownerPath = path.join(root, ownerName);
    await writeFile(ownerPath, "{partial-owner\n", "utf8");
    await utimes(ownerPath, new Date(0), new Date(0));

    const claimSweeper = async (operationId: string) => claimSelfUpgradeOperation(
      root,
      createSelfUpgradeOperation({
        operationId,
        writerId: `${operationId}-writer`,
        conductorHost: "blade",
        targetRef: "origin/main",
        hosts: ["blade"],
        dryRun: false,
        parallel: false,
        failFast: false,
        startedAt: "2026-07-21T08:10:00.000Z",
      }),
      {
        nowMs: () => 10_000,
        staleOwnerMs: 1_000,
        isProcessAlive: () => false,
      },
    );

    const first = await claimSweeper("fleet-unreadable-owner-sweeper-one");
    const quarantinedName = (await readdir(root)).find((name) => name.startsWith(`${ownerName}.stale.`));
    expect(quarantinedName).toBeTruthy();
    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await first.release();

    const second = await claimSweeper("fleet-unreadable-owner-sweeper-two");
    expect(await readdir(root)).not.toContain(quarantinedName);
    await second.release();
  });

  test("sweeps dead owner-only and terminal-owner residue before retention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-owner-retention-"));
    roots.push(root);
    let abandonedRecord = createSelfUpgradeOperation({
      operationId: "fleet-abandoned",
      writerId: "writer-abandoned",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:00:00.000Z",
    });
    abandonedRecord = applySelfUpgradeOperationTransition(abandonedRecord, {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "abandoned-result",
      operation_id: abandonedRecord.operation_id,
      emitted_at: "2026-07-21T08:00:01.000Z",
      observed_at: "2026-07-21T08:00:01.000Z",
      host: "blade",
      status: "failed",
      elapsed_ms: 1_000,
      relay_mode: "missing",
      error: "terminal test record",
    }).record;
    abandonedRecord = applySelfUpgradeOperationTransition(abandonedRecord, {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "abandoned-final",
      operation_id: abandonedRecord.operation_id,
      emitted_at: "2026-07-21T08:00:02.000Z",
      observed_at: "2026-07-21T08:00:02.000Z",
      status: "failed",
      receipt_path: "/receipts/abandoned.json",
      rows: [{ host: "blade", status: "failed", elapsed_ms: 1_000 }],
    }).record;
    const abandoned = await claimSelfUpgradeOperation(root, abandonedRecord);
    const abandonedOwnerPath = path.join(root, `${abandoned.record.operation_id}.owner.json`);
    await utimes(abandonedOwnerPath, new Date(0), new Date(0));
    await utimes(abandoned.operationPath, new Date(0), new Date(0));

    const orphanOwnerPath = path.join(root, "fleet-owner-only.owner.json");
    await writeFile(orphanOwnerPath, `${JSON.stringify({
      schema_version: "self-upgrade-operation-owner/v1",
      operation_id: "fleet-owner-only",
      writer_id: "writer-dead",
      claim_token: "dead-token",
      pid: 999_999,
      claimed_at: "2026-07-21T08:00:00.000Z",
    })}\n`, "utf8");
    await utimes(orphanOwnerPath, new Date(0), new Date(0));

    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-current",
      writerId: "writer-current",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });
    const current = await claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      retentionMs: 1_000,
      retentionCount: 1,
      isProcessAlive: () => false,
    });
    const names = await readdir(root);
    expect(names).not.toContain(path.basename(abandoned.operationPath));
    expect(names).not.toContain(path.basename(abandonedOwnerPath));
    expect(names).not.toContain(path.basename(orphanOwnerPath));
    await expect(abandoned.release()).rejects.toThrow(/ENOENT/u);
    await current.release();
  });

  test("retention bounds an incomplete released observation after its recovery window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-running-retention-"));
    roots.push(root);
    const abandoned = await claimSelfUpgradeOperation(root, initial());
    await abandoned.release();
    await utimes(abandoned.operationPath, new Date(0), new Date(0));
    const recentRecord = createSelfUpgradeOperation({
      operationId: "fleet-recent-running-retention",
      writerId: "writer-recent",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:09:00.000Z",
    });
    const recent = await claimSelfUpgradeOperation(root, recentRecord);
    await recent.release();

    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-current-running-retention",
      writerId: "writer-current",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });
    const current = await claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      retentionMs: 1_000,
      retentionCount: 2,
    });

    await expect(readSelfUpgradeOperation(root, abandoned.record.operation_id))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readSelfUpgradeOperation(root, recent.record.operation_id))
      .resolves.toMatchObject({ status: "running" });
    await current.release();
  });

  test("retention releases and bounds a dead running owner generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-dead-running-owner-"));
    roots.push(root);
    const abandoned = await claimSelfUpgradeOperation(root, initial());
    const ownerPath = path.join(root, `${abandoned.record.operation_id}.owner.json`);
    await utimes(ownerPath, new Date(0), new Date(0));
    await utimes(abandoned.operationPath, new Date(0), new Date(0));

    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-current-dead-running-owner",
      writerId: "writer-current",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });
    const current = await claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      staleOwnerMs: 1_000,
      retentionMs: 2_000,
      retentionCount: 1,
      isProcessAlive: () => false,
    });

    await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readSelfUpgradeOperation(root, abandoned.record.operation_id))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(abandoned.release()).rejects.toThrow(/ENOENT/u);
    await current.release();
  });

  test("forced fallback retention cannot delete from an ancestor replacement", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-operation-fallback-"));
    roots.push(home);
    const root = path.join(home, ".calyx", "self-upgrade-operations");
    const abandoned = await claimSelfUpgradeOperation(root, initial());
    await abandoned.release();
    await utimes(abandoned.operationPath, new Date(0), new Date(0));
    const abandonedName = path.basename(abandoned.operationPath);
    const currentRecord = createSelfUpgradeOperation({
      operationId: "fleet-fallback-current",
      writerId: "writer-fallback-current",
      conductorHost: "blade",
      targetRef: "origin/main",
      hosts: ["blade"],
      dryRun: false,
      parallel: false,
      failFast: false,
      startedAt: "2026-07-21T08:10:00.000Z",
    });

    await expect(claimSelfUpgradeOperation(root, currentRecord, {
      nowMs: () => 10_000,
      retentionMs: 0,
      retentionCount: 1,
      directoryOpenOptions: { descriptorPathCandidates: () => [] },
      afterRootValidatedBeforeRetention: async () => {
        await rename(path.join(home, ".calyx"), path.join(home, ".calyx-held"));
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, abandonedName), "replacement\n", "utf8");
      },
    })).rejects.toThrow(/identity changed/u);

    await expect(readFile(path.join(root, abandonedName), "utf8")).resolves.toBe("replacement\n");
    await expect(stat(path.join(home, ".calyx-held", "self-upgrade-operations", abandonedName)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([abandonedName]);
  });

  test("sweeps only stale operation temps and recovers the canonical record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "calyx-upgrade-temp-recovery-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    const staleTemp = path.join(root, "abandoned.json.writer.1.token.tmp");
    const freshTemp = path.join(root, "recent.json.writer.1.token.tmp");
    await writeFile(staleTemp, "partial", "utf8");
    await writeFile(freshTemp, "partial", "utf8");
    await utimes(staleTemp, new Date(0), new Date(0));
    await utimes(freshTemp, new Date(9_500), new Date(9_500));

    const writer = await claimSelfUpgradeOperation(root, initial(), {
      now: () => "2026-07-21T08:00:00.000Z",
      nowMs: () => 10_000,
      staleTempMs: 1_000,
    });
    const names = await readdir(root);

    expect(names).not.toContain(path.basename(staleTemp));
    expect(names).toContain(path.basename(freshTemp));
    expect(await readSelfUpgradeOperation(root, writer.record.operation_id)).toEqual(writer.record);
    await writer.release();
  });

  test("rejects fleet_final rows that disagree with the reduced host observations", () => {
    const blade: SelfUpgradeOperationTransition = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "host_result",
      transition_id: "result-blade-consistency",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:20.000Z",
      observed_at: "2026-07-21T08:00:20.000Z",
      host: "blade",
      status: "succeeded",
      elapsed_ms: 20_000,
      relay_mode: "stream",
      before_head: "a".repeat(40),
      after_head: "b".repeat(40),
      receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
    };
    const worm: SelfUpgradeOperationTransition = {
      ...blade,
      transition_id: "result-worm-consistency",
      host: "worm",
      status: "failed",
      relay_mode: "legacy",
      error: "failed",
      receipt_locator: { host: "worm", route: "/v1/admin/self-upgrade-receipts/worm" },
    };
    const reduced = applyAll([blade, worm]);
    const inconsistent: Extract<SelfUpgradeOperationTransition, { kind: "fleet_final" }> = {
      schema_version: "self-upgrade-operation/v1",
      record: "transition",
      kind: "fleet_final",
      transition_id: "inconsistent-final",
      operation_id: initial().operation_id,
      emitted_at: "2026-07-21T08:00:30.000Z",
      observed_at: "2026-07-21T08:00:30.000Z",
      status: "failed",
      receipt_path: "/receipts/summary.json",
      rows: [{
        host: "blade",
        status: "succeeded",
        elapsed_ms: 20_000,
        before_head: "a".repeat(40),
        after_head: "c".repeat(40),
        receipt_locator: { host: "blade", route: "/v1/admin/self-upgrade-receipts/blade" },
      }, {
        host: "worm",
        status: "succeeded",
        elapsed_ms: 20_000,
        before_head: "a".repeat(40),
        after_head: "b".repeat(40),
        receipt_locator: { host: "worm", route: "/v1/admin/self-upgrade-receipts/worm" },
      }],
    };

    expect(applySelfUpgradeOperationTransition(reduced, inconsistent)).toEqual({
      record: reduced,
      disposition: "conflict",
    });
  });
});
