import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StateDriverDatabase } from "../state/driver";

import {
  acquireLease,
  applyStateMigrations,
  checkLeaseSchema,
  LEASE_RESOURCE_QUARANTINE_METADATA_KEY,
  listLeaseEvents,
  listLeases,
  listTerminalLeaseReleaseEventsForRun,
  openStateStore,
  parseLeaseKey,
  quarantineRunWorktreeLeases,
  readLease,
  readLeaseResourceQuarantine,
  releaseLease,
  releaseLeasesForTerminalRuns,
  releaseQuarantinedRunWorktreeLeases,
  renewLease,
  runStateDoctor,
  STATE_MIGRATIONS,
  stealLease,
} from "../state";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

const REQUEST_PROVENANCE = {
  schema_version: "calyx.provenance/v1" as const,
  request_id: "req_11111111-1111-4111-8111-111111111111",
  subject: "control-plane:test",
  asserted_actor: "operator:tester",
  host: "blade",
  via: "http" as const,
  at: "2026-06-12T10:00:00.000Z",
};

describe("lease state", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-leases-"));
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

  test("migration 0012 creates leases and state doctor reports the domain", async () => {
    const opened = await openStateStore();
    try {
      expect(checkLeaseSchema(opened.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor({ domains: ["leases"] });
    expect(report.ok).toBe(true);
    expect(report.leases).toMatchObject({
      migrationApplied: true,
      schemaParity: "ok",
      rowCount: 0,
      expiredCount: 0,
    });
    expect(report.domains?.find((domain) => domain.domain === "leases")).toMatchObject({
      status: "ok",
    });
  });

  test("parses lease keys with owning-host topology", () => {
    expect(parseLeaseKey("worktree:blade:/home/caleb/dev/calyx")).toMatchObject({
      resource_kind: "worktree",
      owner_host: "blade",
      resource_host: "blade",
      resource_path: "/home/caleb/dev/calyx",
    });
    expect(parseLeaseKey("session:codex:carbon:session-1")).toMatchObject({
      resource_kind: "session",
      owner_host: "carbon",
      resource_host: "carbon",
      resource_path: "codex:carbon:session-1",
    });
    expect(parseLeaseKey("vault:40-context/note.md", { coordinator_host: "blade" })).toMatchObject({
      resource_kind: "vault",
      owner_host: "blade",
      resource_host: null,
      resource_path: "40-context/note.md",
    });
    expect(parseLeaseKey("issue:POL-1790", { coordinator_host: "blade" })).toMatchObject({
      resource_kind: "issue",
      owner_host: "blade",
      resource_host: null,
      resource_path: "POL-1790",
    });
  });

  test("acquires, conflicts, renews, steals with provenance, and releases", async () => {
    const opened = await openStateStore();
    try {
      const key = "worktree:blade:/tmp/calyx-pol-1790";
      const acquired = acquireLease(opened.db, {
        key,
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:00.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(acquired.acquired).toBe(true);
      expect(acquired.lease).toMatchObject({
        key,
        holder_activity_id: "run:first",
        expires_at: "2026-06-12T10:01:00.000Z",
      });

      const conflicted = acquireLease(opened.db, {
        key,
        holder_activity_id: "run:second",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:10.000Z",
      });
      expect(conflicted.acquired).toBe(false);
      expect(conflicted.conflict?.lease?.holder_activity_id).toBe("run:first");

      const renewed = renewLease(opened.db, {
        key,
        holder_activity_id: "run:first",
        ttl_ms: 120_000,
        now: "2026-06-12T10:00:30.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(renewed.renewed).toBe(true);
      expect(renewed.lease).toMatchObject({
        holder_activity_id: "run:first",
        renewed_at: "2026-06-12T10:00:30.000Z",
        expires_at: "2026-06-12T10:02:30.000Z",
      });

      const stolen = stealLease(opened.db, {
        key,
        holder_activity_id: "run:second",
        ttl_ms: 60_000,
        provenance: "first runner is abandoned",
        now: "2026-06-12T10:01:00.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(stolen.previous_lease?.holder_activity_id).toBe("run:first");
      expect(stolen.lease).toMatchObject({
        holder_activity_id: "run:second",
        stolen_from_holder_activity_id: "run:first",
        stolen_at: "2026-06-12T10:01:00.000Z",
      });
      expect(stolen.lease.steal_provenance).toMatchObject({
        text: "first runner is abandoned",
        stolen_by: "run:second",
      });

      const missingHolderRelease = releaseLease(opened.db, { key });
      expect(missingHolderRelease.released).toBe(false);
      expect(missingHolderRelease.conflict?.kind).toBe("holder-required");

      const wrongRelease = releaseLease(opened.db, {
        key,
        holder_activity_id: "run:first",
      });
      expect(wrongRelease.released).toBe(false);
      expect(wrongRelease.conflict?.kind).toBe("holder-mismatch");

      const released = releaseLease(opened.db, {
        key,
        holder_activity_id: "run:second",
        now: "2026-06-12T10:01:30.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(released.released).toBe(true);
      expect(listLeases(opened.db, { include_expired: true })).toHaveLength(0);
      const events = listLeaseEvents(opened.db, key);
      expect(events.map((event) => event.event_type)).toEqual([
        "acquired",
        "renewed",
        "stolen",
        "released",
      ]);
      expect(events[0]).toMatchObject({
        before_lease: null,
        after_lease: { holder_activity_id: "run:first" },
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(events[2]).toMatchObject({
        before_lease: { holder_activity_id: "run:first" },
        after_lease: { holder_activity_id: "run:second" },
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(events[3]).toMatchObject({
        before_lease: { holder_activity_id: "run:second" },
        after_lease: null,
        request_provenance: REQUEST_PROVENANCE,
      });
    } finally {
      opened.db.close();
    }
  });

  test("records an absent-prior steal honestly as an acquisition", async () => {
    const opened = await openStateStore();
    try {
      const key = "worktree:blade:/tmp/steal-without-prior";
      const stolen = stealLease(opened.db, {
        key,
        holder_activity_id: "run:first",
        ttl_ms: 60_000,
        provenance: "operator recovered an unleased worktree",
        now: "2026-06-12T10:00:00.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(stolen.previous_lease).toBeUndefined();
      expect(stolen.lease).toMatchObject({
        stolen_from_holder_activity_id: null,
        stolen_at: null,
      });
      expect(listLeaseEvents(opened.db, key)).toEqual([
        expect.objectContaining({
          event_type: "acquired",
          reason: "operator recovered an unleased worktree",
          before_lease: null,
          after_lease: expect.objectContaining({ holder_activity_id: "run:first" }),
          request_provenance: REQUEST_PROVENANCE,
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("ordinary expired leases can be replaced and terminal run GC releases held leases", async () => {
    const opened = await openStateStore();
    try {
      const expired = acquireLease(opened.db, {
        key: "worktree:blade:/tmp/expired",
        holder_activity_id: "interactive:codex:old",
        ttl_ms: 1_000,
        now: "2026-06-12T10:00:00.000Z",
      });
      expect(expired.acquired).toBe(true);

      const reacquired = acquireLease(opened.db, {
        key: "worktree:blade:/tmp/expired",
        holder_activity_id: "run:new",
        ttl_ms: 1_000,
        now: "2026-06-12T10:00:02.000Z",
      });
      expect(reacquired.acquired).toBe(true);
      expect(reacquired.lease?.holder_activity_id).toBe("run:new");

      const terminal = acquireLease(opened.db, {
        key: "worktree:blade:/tmp/terminal",
        holder_activity_id: "run:terminal-1",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:02.000Z",
      });
      expect(terminal.acquired).toBe(true);

      const gc = releaseLeasesForTerminalRuns(opened.db, ["terminal-1"], {
        now: "2026-06-12T10:00:03.000Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(gc.released.map((lease) => lease.key)).toEqual(["worktree:blade:/tmp/terminal"]);
      expect(gc.release_events).toEqual([
        expect.objectContaining({
          event_id: expect.any(Number),
          key: "worktree:blade:/tmp/terminal",
          event_type: "released",
          reason: "terminal-run-reconcile",
        }),
      ]);
      expect(listTerminalLeaseReleaseEventsForRun(opened.db, "terminal-1"))
        .toEqual(gc.release_events);
      expect(listTerminalLeaseReleaseEventsForRun(opened.db, "terminal-1", {
        after_event_id: gc.release_events[0]!.event_id,
        limit: 1,
      })).toEqual([]);
      expect(listTerminalLeaseReleaseEventsForRun(opened.db, "new")).toEqual([]);
      expect(listLeaseEvents(opened.db, "worktree:blade:/tmp/terminal").at(-1)).toMatchObject({
        event_type: "released",
        reason: "terminal-run-reconcile",
        before_lease: { holder_activity_id: "run:terminal-1" },
        after_lease: null,
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(listLeases(opened.db, { include_expired: true }).map((lease) => lease.key)).toEqual([
        "worktree:blade:/tmp/expired",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("expired run-held worktrees stay fenced until terminal reconciliation or explicit steal", async () => {
    const opened = await openStateStore();
    try {
      const terminalKey = "worktree:blade:/tmp/expired-run-terminal";
      expect(acquireLease(opened.db, {
        key: terminalKey,
        holder_activity_id: "run:expired-terminal",
        ttl_ms: 1_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);

      const blocked = acquireLease(opened.db, {
        key: terminalKey,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:02.000Z",
      });
      expect(blocked).toMatchObject({
        acquired: false,
        conflict: {
          kind: "quarantined",
          lease: { holder_activity_id: "run:expired-terminal" },
        },
      });
      expect(releaseLease(opened.db, {
        key: terminalKey,
        holder_activity_id: "run:expired-terminal",
        now: "2026-06-12T10:00:02.000Z",
      })).toMatchObject({ released: false, conflict: { kind: "quarantined" } });

      expect(releaseLeasesForTerminalRuns(opened.db, ["expired-terminal"], {
        now: "2026-06-12T10:00:03.000Z",
      }).released.map((lease) => lease.key)).toEqual([terminalKey]);
      expect(acquireLease(opened.db, {
        key: terminalKey,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:04.000Z",
      }).acquired).toBe(true);

      const stolenKey = "worktree:blade:/tmp/expired-run-steal";
      expect(acquireLease(opened.db, {
        key: stolenKey,
        holder_activity_id: "run:expired-steal",
        ttl_ms: 1_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);
      const stolen = stealLease(opened.db, {
        key: stolenKey,
        holder_activity_id: "run:operator-successor",
        ttl_ms: 60_000,
        provenance: "operator proved the historical resource safe",
        now: "2026-06-12T10:00:02.000Z",
      });
      expect(stolen).toMatchObject({
        stolen: true,
        previous_lease: { holder_activity_id: "run:expired-steal" },
        lease: { holder_activity_id: "run:operator-successor" },
      });
    } finally {
      opened.db.close();
    }
  });

  test("resource quarantine survives TTL and generic GC until authority-bound release", async () => {
    const opened = await openStateStore();
    try {
      const key = "worktree:blade:/tmp/legacy-resource";
      const runId = "legacy-resource";
      const ownerFreeAuthorityId = "a".repeat(64);
      const resourceAuthorityId = "b".repeat(64);
      expect(acquireLease(opened.db, {
        key,
        holder_activity_id: `run:${runId}`,
        ttl_ms: 1_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);

      const quarantined = quarantineRunWorktreeLeases(opened.db, {
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        expected_resource_authority_id: resourceAuthorityId,
        legacy_process_group_id: 45_672,
        quarantined_at: "2026-06-12T10:00:00.500Z",
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(quarantined.quarantined.map((lease) => lease.key)).toEqual([key]);
      expect(readLeaseResourceQuarantine(readLease(opened.db, key)!)).toEqual({
        schema_version: "calyx.lease-resource-quarantine/v1",
        status: "active",
        authority: "legacy_process_group_observation",
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        expected_resource_authority_id: resourceAuthorityId,
        legacy_process_group_id: 45_672,
        quarantined_at: "2026-06-12T10:00:00.500Z",
      });
      expect(quarantineRunWorktreeLeases(opened.db, {
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        expected_resource_authority_id: resourceAuthorityId,
        legacy_process_group_id: 45_672,
        quarantined_at: "2026-06-12T10:00:00.500Z",
      }).already_quarantined.map((lease) => lease.key)).toEqual([key]);
      expect(listLeaseEvents(opened.db, key)).toEqual([
        expect.objectContaining({ event_type: "acquired" }),
        expect.objectContaining({
          event_type: "quarantined",
          reason: "legacy-process-group-observation:45672",
          before_lease: expect.objectContaining({
            metadata: expect.not.objectContaining({
              [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: expect.anything(),
            }),
          }),
          after_lease: expect.objectContaining({
            metadata: expect.objectContaining({
              [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: expect.objectContaining({
                run_id: runId,
              }),
            }),
          }),
          request_provenance: REQUEST_PROVENANCE,
        }),
      ]);

      expect(acquireLease(opened.db, {
        key,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:05.000Z",
      })).toMatchObject({ acquired: false, conflict: { kind: "quarantined" } });
      expect(renewLease(opened.db, {
        key,
        holder_activity_id: "run:competitor",
        now: "2026-06-12T10:00:00.750Z",
      })).toMatchObject({ renewed: false, conflict: { kind: "holder-mismatch" } });
      expect(renewLease(opened.db, {
        key,
        holder_activity_id: `run:${runId}`,
        now: "2026-06-12T10:00:00.750Z",
      })).toMatchObject({ renewed: false, conflict: { kind: "quarantined" } });
      expect(releaseLease(opened.db, {
        key,
        holder_activity_id: "run:competitor",
        now: "2026-06-12T10:00:05.000Z",
      })).toMatchObject({ released: false, conflict: { kind: "holder-mismatch" } });
      expect(releaseLease(opened.db, {
        key,
        holder_activity_id: `run:${runId}`,
        now: "2026-06-12T10:00:05.000Z",
      })).toMatchObject({ released: false, conflict: { kind: "quarantined" } });
      expect(releaseLeasesForTerminalRuns(opened.db, [runId], {
        now: "2026-06-12T10:00:06.000Z",
      }).released).toEqual([]);
      expect(() => releaseQuarantinedRunWorktreeLeases(opened.db, {
        run_id: runId,
        owner_free_authority_id: "c".repeat(64),
        resource_authority_id: resourceAuthorityId,
        legacy_process_group_id: 45_672,
        now: "2026-06-12T10:00:07.000Z",
      })).toThrow(/does not match the proven terminal resource settlement/u);
      expect(readLease(opened.db, key)).toBeDefined();
      expect(() => releaseQuarantinedRunWorktreeLeases(opened.db, {
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        resource_authority_id: "c".repeat(64),
        legacy_process_group_id: 45_672,
        now: "2026-06-12T10:00:07.500Z",
      })).toThrow(/does not match the proven terminal resource settlement/u);
      expect(readLease(opened.db, key)).toBeDefined();

      expect(releaseQuarantinedRunWorktreeLeases(opened.db, {
        run_id: runId,
        owner_free_authority_id: ownerFreeAuthorityId,
        resource_authority_id: resourceAuthorityId,
        legacy_process_group_id: 45_672,
        now: "2026-06-12T10:00:08.000Z",
        request_provenance: REQUEST_PROVENANCE,
      }).released.map((lease) => lease.key)).toEqual([key]);
      expect(readLease(opened.db, key)).toBeUndefined();
      expect(listLeaseEvents(opened.db, key).at(-1)).toMatchObject({
        event_type: "released",
        reason: `legacy-resource-settlement:${resourceAuthorityId}`,
        request_provenance: REQUEST_PROVENANCE,
      });
      expect(acquireLease(opened.db, {
        key,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:09.000Z",
      }).acquired).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("malformed or caller-supplied resource quarantine metadata fails closed", async () => {
    const opened = await openStateStore();
    try {
      const key = "worktree:blade:/tmp/malformed-resource-quarantine";
      expect(acquireLease(opened.db, {
        key,
        holder_activity_id: "run:malformed-quarantine",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);
      opened.db.prepare("UPDATE leases SET metadata_json = ? WHERE key = ?").run(
        JSON.stringify({ [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: { status: "torn" } }),
        key,
      );
      const relationalKey = "issue:POL-LEASE-QUARANTINE-RELATION";
      expect(acquireLease(opened.db, {
        key: relationalKey,
        holder_activity_id: "run:relational-quarantine",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);
      opened.db.prepare("UPDATE leases SET metadata_json = ? WHERE key = ?").run(
        JSON.stringify({
          [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: {
            schema_version: "calyx.lease-resource-quarantine/v1",
            status: "active",
            authority: "legacy_process_group_observation",
            run_id: "relational-quarantine",
            owner_free_authority_id: "a".repeat(64),
            expected_resource_authority_id: "b".repeat(64),
            legacy_process_group_id: 45_673,
            quarantined_at: "2026-06-12T10:00:00.000Z",
          },
        }),
        relationalKey,
      );

      expect(acquireLease(opened.db, {
        key,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:01.000Z",
      })).toMatchObject({ acquired: false, conflict: { kind: "quarantined" } });
      expect(renewLease(opened.db, {
        key,
        holder_activity_id: "run:malformed-quarantine",
        now: "2026-06-12T10:00:01.000Z",
      })).toMatchObject({ renewed: false, conflict: { kind: "quarantined" } });
      expect(releaseLease(opened.db, {
        key,
        holder_activity_id: "run:malformed-quarantine",
        now: "2026-06-12T10:00:01.000Z",
      })).toMatchObject({ released: false, conflict: { kind: "quarantined" } });
      expect(releaseLeasesForTerminalRuns(opened.db, ["malformed-quarantine"]).released).toEqual([]);
      expect(releaseLeasesForTerminalRuns(opened.db, ["relational-quarantine"]).released).toEqual([]);
      expect(readLeaseResourceQuarantine(readLease(opened.db, relationalKey)!)).toBeUndefined();
      expect(() => releaseQuarantinedRunWorktreeLeases(opened.db, {
        run_id: "malformed-quarantine",
        owner_free_authority_id: "a".repeat(64),
        resource_authority_id: "b".repeat(64),
        legacy_process_group_id: 45_673,
      })).toThrow(/does not match the proven terminal resource settlement/u);

      const malformedReport = await runStateDoctor({ domains: ["leases"] });
      expect(malformedReport.ok).toBe(false);
      expect(malformedReport.leases.malformed).toEqual([
        expect.objectContaining({
          key: relationalKey,
          code: "resource-quarantine-malformed",
        }),
        expect.objectContaining({
          key,
          code: "resource-quarantine-malformed",
        }),
      ]);
      expect(malformedReport.domains?.find((domain) => domain.domain === "leases")).toMatchObject({
        status: "drift",
      });

      const stolen = stealLease(opened.db, {
        key,
        holder_activity_id: "run:operator-successor",
        ttl_ms: 60_000,
        provenance: "operator repaired malformed quarantine",
        now: "2026-06-12T10:00:02.000Z",
      });
      expect(stolen.stolen).toBe(true);
      expect(stolen.lease.metadata).not.toHaveProperty(LEASE_RESOURCE_QUARANTINE_METADATA_KEY);

      expect(() => acquireLease(opened.db, {
        key: "worktree:blade:/tmp/caller-reserved-metadata",
        holder_activity_id: "run:caller",
        ttl_ms: 60_000,
        metadata: { [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: {} },
      })).toThrow(/reserved for typed run-service resource fencing/u);
      expect(() => stealLease(opened.db, {
        key,
        holder_activity_id: "run:caller",
        ttl_ms: 60_000,
        provenance: "caller attempted reserved metadata",
        metadata: { [LEASE_RESOURCE_QUARANTINE_METADATA_KEY]: {} },
      })).toThrow(/reserved for typed run-service resource fencing/u);
    } finally {
      opened.db.close();
    }
  });

  test("malformed and non-object metadata fail closed without blocking valid terminal GC", async () => {
    const opened = await openStateStore();
    try {
      const arrayKey = "worktree:blade:/tmp/array-metadata";
      const malformedKey = "worktree:blade:/tmp/malformed-metadata";
      const provenanceKey = "worktree:blade:/tmp/malformed-provenance";
      const scalarKey = "worktree:blade:/tmp/scalar-metadata";
      const validKey = "worktree:blade:/tmp/valid-metadata";
      for (const [key, runId, metadata] of [
        [arrayKey, "array-metadata", {}],
        [malformedKey, "malformed-metadata", {}],
        [provenanceKey, "malformed-provenance", {}],
        [scalarKey, "scalar-metadata", {}],
        [validKey, "valid-metadata", { purpose: "terminal-gc-regression" }],
      ] as const) {
        expect(acquireLease(opened.db, {
          key,
          holder_activity_id: `run:${runId}`,
          ttl_ms: 60_000,
          now: "2026-06-12T10:00:00.000Z",
          metadata,
        }).acquired).toBe(true);
      }
      opened.db.prepare("UPDATE leases SET metadata_json = '[]' WHERE key = ?").run(arrayKey);
      opened.db.prepare("UPDATE leases SET metadata_json = '{' WHERE key = ?").run(malformedKey);
      opened.db.prepare("UPDATE leases SET steal_provenance_json = '{' WHERE key = ?").run(provenanceKey);
      opened.db.prepare("UPDATE leases SET metadata_json = '\"scalar\"' WHERE key = ?").run(scalarKey);

      expect(() => readLease(opened.db, arrayKey)).toThrow(/metadata_json must be a JSON object/u);
      expect(() => readLease(opened.db, malformedKey)).toThrow(/metadata_json is not valid JSON/u);
      expect(() => readLease(opened.db, provenanceKey)).toThrow(/steal_provenance_json is not valid JSON/u);
      expect(() => readLease(opened.db, scalarKey)).toThrow(/metadata_json must be a JSON object/u);
      expect(() => acquireLease(opened.db, {
        key: arrayKey,
        holder_activity_id: "run:competitor",
        ttl_ms: 60_000,
      })).toThrow(/metadata_json must be a JSON object/u);

      expect(releaseLeasesForTerminalRuns(opened.db, [
        "array-metadata",
        "malformed-metadata",
        "malformed-provenance",
        "scalar-metadata",
        "valid-metadata",
      ]).released.map((lease) => lease.key)).toEqual([validKey]);
      expect((opened.db.prepare(
        "SELECT key FROM leases WHERE key IN (?, ?, ?, ?) ORDER BY key ASC",
      ).all(arrayKey, malformedKey, provenanceKey, scalarKey) as Array<{ key: string }>).map((row) => row.key)).toEqual([
        arrayKey,
        malformedKey,
        provenanceKey,
        scalarKey,
      ]);

      const report = await runStateDoctor({ domains: ["leases"] });
      expect(report.ok).toBe(false);
      expect(report.leases.schemaParity).toBe("ok");
      expect(report.leases.malformed).toEqual([
        expect.objectContaining({ key: arrayKey, code: "metadata-not-object" }),
        expect.objectContaining({ key: malformedKey, code: "metadata-not-object" }),
        expect.objectContaining({ key: provenanceKey, code: "steal-provenance-not-object" }),
        expect.objectContaining({ key: scalarKey, code: "metadata-not-object" }),
      ]);
      expect(report.domains?.find((domain) => domain.domain === "leases")).toMatchObject({
        status: "drift",
      });
    } finally {
      opened.db.close();
    }
  });

  test("migration 0029 preserves lease history and advances event ids for quarantine receipts", async () => {
    const upgradeOptions = {
      env: {
        ...process.env,
        CALYX_STATE_HOME: join(root, "upgrade-lease-events-0029"),
      },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0028"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const key = "vault:lease-migration-history";
      expect(acquireLease(before.db, {
        key,
        holder_activity_id: "interactive:codex:migration",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);
      expect(renewLease(before.db, {
        key,
        holder_activity_id: "interactive:codex:migration",
        now: "2026-06-12T10:00:30.000Z",
      }).renewed).toBe(true);
      expect(listLeaseEvents(before.db, key).map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
      }))).toEqual([
        { event_id: 1, event_type: "acquired" },
        { event_id: 2, event_type: "renewed" },
      ]);
      expect(checkLeaseSchema(before.db)).toEqual({
        status: "drift",
        findings: [expect.objectContaining({
          table: "lease_events",
          code: "invalid-table-constraint",
        })],
      });
    } finally {
      before.db.close();
    }

    const migrated = await applyStateMigrations({ storeOptions: upgradeOptions });
    expect(migrated.applied.map((migration) => migration.id)).toEqual([
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
    ]);
    const after = await openStateStore(upgradeOptions);
    try {
      const preservedKey = "vault:lease-migration-history";
      expect(listLeaseEvents(after.db, preservedKey).map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
        key: event.key,
      }))).toEqual([
        { event_id: 1, event_type: "acquired", key: preservedKey },
        { event_id: 2, event_type: "renewed", key: preservedKey },
      ]);
      const quarantineKey = "worktree:blade:/tmp/migration-quarantine";
      expect(acquireLease(after.db, {
        key: quarantineKey,
        holder_activity_id: "run:migration-quarantine",
        ttl_ms: 60_000,
        now: "2026-06-12T10:01:00.000Z",
      }).acquired).toBe(true);
      quarantineRunWorktreeLeases(after.db, {
        run_id: "migration-quarantine",
        owner_free_authority_id: "d".repeat(64),
        expected_resource_authority_id: "e".repeat(64),
        legacy_process_group_id: 45_674,
        quarantined_at: "2026-06-12T10:01:01.000Z",
      });
      expect(listLeaseEvents(after.db, quarantineKey).map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
      }))).toEqual([
        { event_id: 3, event_type: "acquired" },
        { event_id: 4, event_type: "quarantined" },
      ]);
      expect(checkLeaseSchema(after.db)).toEqual({ status: "ok", findings: [] });
    } finally {
      after.db.close();
    }
  });

  test("terminal run GC cannot delete a lease reassigned before its atomic delete", async () => {
    const primary = await openStateStore();
    const racer = await openStateStore();
    try {
      const key = "worktree:blade:/tmp/terminal-race";
      expect(acquireLease(primary.db, {
        key,
        holder_activity_id: "run:terminal-race",
        ttl_ms: 60_000,
        now: "2026-06-12T10:00:00.000Z",
      }).acquired).toBe(true);

      let interleaved = false;
      const wrapped: StateDriverDatabase = {
        exec: (sql) => primary.db.exec(sql),
        prepare: (sql) => {
          const statement = primary.db.prepare(sql);
          if (!/^DELETE FROM leases\b/.test(sql.trim())) return statement;
          return {
            run: (...params) => statement.run(...params),
            get: (...params) => statement.get(...params),
            all: (...params) => {
              if (!interleaved) {
                interleaved = true;
                stealLease(racer.db, {
                  key,
                  holder_activity_id: "run:successor",
                  ttl_ms: 60_000,
                  provenance: "concurrent terminal reconciliation handoff",
                  now: "2026-06-12T10:00:03.000Z",
                });
              }
              return statement.all(...params);
            },
          };
        },
        close: () => primary.db.close(),
        get isOpen() { return primary.db.isOpen; },
      };

      const gc = releaseLeasesForTerminalRuns(wrapped, ["terminal-race"], {
        now: "2026-06-12T10:00:04.000Z",
      });
      expect(interleaved).toBe(true);
      expect(gc.released).toEqual([]);
      expect(listLeases(racer.db, { include_expired: true })).toEqual([
        expect.objectContaining({ key, holder_activity_id: "run:successor" }),
      ]);
      expect(listLeaseEvents(racer.db, key).map((event) => event.event_type)).toEqual([
        "acquired",
        "stolen",
      ]);
    } finally {
      primary.db.close();
      racer.db.close();
    }
  });
});
