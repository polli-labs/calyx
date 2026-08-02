import { describe, expect, test } from "vitest";
import { toCalyxAdminReconcileResult, type ActivityMarkListPage, type ActivityMarkRow } from "@polli-labs/calyx-core";
import { isCalyxRunEvent } from "@polli-labs/calyx-run-service";

import {
  adminReconcileResultSchema,
  activityAttachmentObservationSchema,
  activityMarkCreateRequestSchema,
  activityMarkListQuerySchema,
  activityMarkListSchema,
  activityMarkRevocationSchema,
  activityMarkSchema,
  activityMessagesObservationSchema,
  activityTextObservationSchema,
  activityTurnsObservationSchema,
  CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
  CONSUMER_BACKEND_MAX_CHARS,
  CONSUMER_CURSOR_MAX_CHARS,
  CONSUMER_HOST_MAX_CHARS,
  CONSUMER_MESSAGE_REFERENCE_MAX_CHARS,
  CONSUMER_MESSAGE_SUBJECT_MAX_CHARS,
  CONSUMER_MIME_TYPE_MAX_CHARS,
  CONSUMER_PORTABLE_ID_MAX_CHARS,
  CONSUMER_PRESET_MAX_CHARS,
  CONSUMER_ROUTE_LOCATOR_MAX_CHARS,
  CONSUMER_RUN_LOCATOR_MAX_CHARS,
  leaseObservationSchema,
  messageObservationSchema,
  monitorObservationSchema,
  toAdminHealth,
  toActivityAttachmentObservation,
  toActivityMark,
  toActivityMarkList,
  toActivityMarkRevocation,
  toActivityMessagesObservation,
  toActivityTurnsObservation,
  toInteractiveObservation,
  toLeaseObservation,
  toMessageObservation,
  toMonitorObservation,
  toRunObservation,
  toRunObservationEvent,
  toRunObservationGapEvent,
  toWakeObservation,
  wakeObservationSchema,
} from "../consumer-dtos.js";

function recursiveKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) recursiveKeys(entry, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      recursiveKeys(entry, into);
    }
  }
  return into;
}

function expectNoKeys(value: unknown, forbidden: readonly string[]): void {
  const keys = recursiveKeys(value);
  for (const key of forbidden) {
    expect(keys.has(key), `forbidden recursive key ${key}`).toBe(false);
  }
}

describe("consumer DTO positive construction", () => {
  test("projects only bounded consumer-visible activity attention fields", () => {
    const projected = toInteractiveObservation({
      entry_kind: "interactive_session",
      run_id: "interactive:codex:session-safe",
      state: "interactive",
      summary: "private backend summary with token=secret",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      host: "blade",
      backend: "codex",
      session_id: "session-safe",
      session_path: "/Users/caleb/.codex/sessions/private.jsonl",
      cwd: "/Users/caleb/dev/calyx/wt/calyx-run/pol-1994-step2-dtos",
      source: "codex_sessions",
      bytes: 42,
      hidden_messages: [{ text: "hidden token=secret" }],
      tool_call_count: 9,
    } as never, {
      attention_state: "awaiting",
      latest_visible_message_excerpt: "  Consumer-safe latest\nmessage.  ",
      visible_message_count: 2,
      hidden_message_count: 7,
      tool_call_count: 9,
    } as never);

    expect(projected).toMatchObject({
      schema_version: "calyx.run-observation/v1",
      kind: "interactive",
      attention_state: "awaiting",
      repo_ref: "calyx",
      worktree_ref: "calyx-run",
      latest_visible_message_excerpt: "Consumer-safe latest message.",
      visible_message_count: 2,
    });
    expectNoKeys(projected, [
      "session_path", "cwd", "source", "bytes", "hidden_messages",
      "hidden_message_count", "tool_call_count", "token",
    ]);

    const bounded = toInteractiveObservation({
      entry_kind: "interactive_session",
      run_id: "interactive:claude:session-bounded",
      state: "interactive",
      summary: "private",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      backend: "claude",
      session_id: "session-bounded",
      session_path: "/tmp/private.jsonl",
      cwd: "/tmp/private/acquisition-target",
      source: "claude_projects",
    }, {
      attention_state: "unknown",
      latest_visible_message_excerpt: "x".repeat(CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS + 100),
      visible_message_count: -1,
    } as never);
    if (bounded.kind !== "interactive") throw new Error("expected interactive observation");
    expect(bounded.latest_visible_message_excerpt).toHaveLength(
      CONSUMER_ACTIVITY_MESSAGE_EXCERPT_MAX_CHARS,
    );
    expect(bounded.latest_visible_message_excerpt).toMatch(/\.\.\.$/u);
    expect(bounded).not.toHaveProperty("visible_message_count");
    expect(bounded).not.toHaveProperty("repo_ref");
  });

  test("projects distinct worktrees and canonical public, clone, and bare workspace layouts", () => {
    const observe = (cwd: string, sessionId: string) => toInteractiveObservation({
      entry_kind: "interactive_session",
      run_id: `interactive:codex:${sessionId}`,
      state: "interactive",
      summary: "private",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      backend: "codex",
      session_id: sessionId,
      session_path: `/tmp/private/${sessionId}.jsonl`,
      cwd,
      source: "codex_sessions",
    });

    const firstWorktree = observe("/Users/caleb/dev/calyx/wt/feature-a", "feature-a");
    const secondWorktree = observe("/Users/caleb/dev/calyx/wt/feature-b", "feature-b");
    if (firstWorktree.kind !== "interactive" || secondWorktree.kind !== "interactive") {
      throw new Error("expected interactive observations");
    }
    expect(firstWorktree).toMatchObject({ repo_ref: "calyx", worktree_ref: "feature-a" });
    expect(secondWorktree).toMatchObject({ repo_ref: "calyx", worktree_ref: "feature-b" });
    expect(firstWorktree.worktree_ref).not.toBe(secondWorktree.worktree_ref);

    const publicClone = observe("/Users/caleb/dev/linnaeus/public/linnaeus", "public");
    expect(publicClone).toMatchObject({ repo_ref: "linnaeus" });
    expect(publicClone).not.toHaveProperty("worktree_ref");

    const developmentClone = observe("/Users/caleb/dev/calyx/dev", "dev");
    expect(developmentClone).toMatchObject({ repo_ref: "calyx" });

    const bareProject = observe("/Users/caleb/dev/typus", "bare");
    expect(bareProject).toMatchObject({ repo_ref: "typus" });
  });

  test("projects authoritative activity marks without membership or revocation internals", () => {
    const createdProvenance = {
      schema_version: "calyx.provenance/v1" as const,
      request_id: "req_123e4567-e89b-42d3-a456-426614174000",
      subject: "client:switchboard",
      asserted_actor: "operator:caleb",
      host: "blade",
      via: "http" as const,
      at: "2026-07-21T00:00:00.000Z",
    };
    const revokedProvenance = {
      ...createdProvenance,
      request_id: "req_123e4567-e89b-42d3-a456-426614174001",
      at: "2026-07-21T00:01:00.000Z",
    };
    const row: ActivityMarkRow = {
      mark_id: "mark_123e4567-e89b-42d3-a456-426614174000",
      subject: createdProvenance.subject,
      target_kind: "message",
      target_id: "interactive:codex:session-1:msg:42",
      kind: "high_signal",
      reason: "Decision boundary.",
      marked_at: createdProvenance.at,
      created_provenance: createdProvenance,
      marked_revision: 1,
      marked_lineage_token: "1".repeat(32),
      revoked_at: revokedProvenance.at,
      revoked_provenance: revokedProvenance,
      revoked_revision: 2,
      revoked_lineage_token: "2".repeat(32),
    };
    const mark = toActivityMark(row);
    expect(mark).toEqual({
      schema_version: "calyx.activity-mark/v1",
      mark_id: row.mark_id,
      marked_by: row.subject,
      target_kind: row.target_kind,
      target_id: row.target_id,
      kind: row.kind,
      reason: row.reason,
      marked_at: row.marked_at,
      created_provenance: row.created_provenance,
    });
    expect(mark).not.toHaveProperty("subject");
    expectNoKeys(mark, ["marked_revision", "marked_lineage_token", "revoked_revision", "revoked_lineage_token"]);
    expect(activityMarkSchema.parse(mark)).toEqual(mark);

    const revocation = toActivityMarkRevocation(row);
    expect(revocation).toMatchObject({
      ...mark,
      schema_version: "calyx.activity-mark-revocation/v1",
      revoked_at: revokedProvenance.at,
      revoked_provenance: revokedProvenance,
    });
    expect(activityMarkRevocationSchema.parse(revocation)).toEqual(revocation);
    expect(() => toActivityMarkRevocation({
      ...row,
      revoked_at: null,
      revoked_provenance: null,
      revoked_revision: null,
      revoked_lineage_token: null,
    })).toThrow("has not been revoked");

    const page: ActivityMarkListPage = {
      snapshot_at: "2026-07-21T00:02:00.000Z",
      generation: "a".repeat(32),
      revision: 1,
      lineage_token: "b".repeat(32),
      truncated: false,
      marks: [{
        ...row,
        revoked_at: null,
        revoked_provenance: null,
        revoked_revision: null,
        revoked_lineage_token: null,
      }],
    };
    const list = toActivityMarkList(page);
    expect(list).toEqual({
      schema_version: "calyx.activity-mark-list/v1",
      snapshot_at: page.snapshot_at,
      truncated: false,
      marks: [{ ...mark }],
    });
    expectNoKeys(list, ["generation", "revision", "lineage_token"]);
    expect(activityMarkListSchema.parse(list)).toEqual(list);

    expect(activityMarkCreateRequestSchema.safeParse({
      schema_version: "calyx.activity-mark-create-request/v1",
      idempotency_key: "mark-1",
      target_kind: "message",
      target_id: row.target_id,
      kind: "foundational",
    }).success).toBe(true);
    expect(activityMarkListQuerySchema.safeParse({ target_kind: "message" }).success).toBe(true);
    expect(activityMarkListQuerySchema.safeParse({ target_id: row.target_id }).success).toBe(true);
    expect(activityMarkListQuerySchema.safeParse({
      target_kind: "turn",
      target_id: row.target_id,
    }).success).toBe(false);
  });

  test.each([
    ["malformed run identity", "activity", "run::bad"],
    ["authorship alias", "activity", "codex:carbon:019f9000-1111-7222-8333-abcabcabcabc"],
    ["bad final source-line grammar", "message", "interactive:codex:session-1:msg:01"],
  ])("admits plausible-but-invalid %s to non-leaking target resolution", (_name, targetKind, targetId) => {
    expect(activityMarkCreateRequestSchema.safeParse({
      schema_version: "calyx.activity-mark-create-request/v1",
      idempotency_key: "non-leaking-target",
      target_kind: targetKind,
      target_id: targetId,
      kind: "high_signal",
    }).success).toBe(true);
  });

  test("keeps mark-create shape and length failures at the DTO boundary", () => {
    const base = {
      schema_version: "calyx.activity-mark-create-request/v1" as const,
      idempotency_key: "shape-boundary",
      target_kind: "activity" as const,
      target_id: "run:valid-shape",
      kind: "high_signal" as const,
    };
    expect(activityMarkCreateRequestSchema.safeParse({
      schema_version: base.schema_version,
      idempotency_key: base.idempotency_key,
      target_kind: base.target_kind,
      kind: base.kind,
    }).success).toBe(false);
    expect(activityMarkCreateRequestSchema.safeParse({ ...base, target_id: "" }).success).toBe(false);
    expect(activityMarkCreateRequestSchema.safeParse({
      ...base,
      target_id: `run:${"a".repeat(1_021)}`,
    }).success).toBe(false);
  });

  test("admin health and reconcile receipts recursively omit local paths, process data, raw errors, and run identifiers", () => {
    const health = toAdminHealth({
      schema_version: "daemon-health/v1",
      protocol_epoch: 1,
      daemon_kind: "run-service",
      daemon_id: "run-serve",
      advertised_host: "blade",
      pid: 1234,
      uptime_ms: 12_000,
      started_at: "2026-07-13T00:00:00.000Z",
      build: { git_head: "abc", built_at: "2026-07-13T00:00:00.000Z", package_version: "0.2.0" },
      env: { inherited_path: "/private/bin:/usr/bin" },
      promoted_build: {
        status: "ok",
        install_path: "/private/install",
        current_link: "/private/current",
        build_info_path: "/private/build.json",
        build: { git_head: "def", built_at: "2026-07-13T00:00:00.000Z", package_version: "0.2.0" },
        error: "private promoted error",
      },
      clone_head: { status: "ok", repo_root: "/private/repo", git_head: "fed", error: "private clone error" },
      state_schema: {
        status: "ahead",
        driver: "node-sqlite",
        current: "0034",
        target: "0018",
        pending: 0,
        error: "private state path /tmp/secret/calyx.db",
      },
      active_runs: 2,
      active_run_ids: ["run-secret-1", "run-secret-2"],
      maintenance_mode: false,
      supports_features: ["daemon.health/v1"],
      interactive_sessions: {
        window_ms: 1_000,
        scanned_at: "2026-07-13T00:00:01.000Z",
        codex: 1,
        claude: 0,
        total: 1,
        status: "unavailable",
        reason: "error",
        error: "private session path /tmp/secret",
      },
    });
    expect(health).toMatchObject({ schema_version: "calyx.admin-health/v1", active_runs: 2 });
    // Operators get the schema position; the cause of an unreadable ledger
    // stays on the daemon side, exactly like promoted_build.error.
    expect(health.state_schema).toEqual({
      status: "ahead",
      driver: "node-sqlite",
      current: "0034",
      target: "0018",
      pending: 0,
    });
    expectNoKeys(health, [
      "pid", "env", "inherited_path", "install_path", "current_link", "build_info_path",
      "repo_root", "active_run_ids", "error", "run_id", "receipt_path",
    ]);

    const reconcile = toCalyxAdminReconcileResult({
      scanned: 4,
      rebuilt: ["run-secret-1"],
      repair_pending: [],
      classified: ["run-secret-2"],
      adopted: ["run-secret-3"],
      unresolved: [],
      skipped: ["run-secret-4"],
      noncanonical_directories: [],
      projection: { status: "repaired", rowCount: 4 },
    }, "2026-07-13T00:00:02.000Z");
    expect(reconcile).toEqual({
      schema_version: "calyx.admin-reconcile-result/v1",
      status: "completed",
      scanned: 4,
      changed: { rebuilt: 1, repair_pending: 0, classified: 1, adopted: 1, skipped: 1, unresolved: 0, noncanonical_directories: 0 },
      unresolved: [],
      noncanonical_directories: [],
      projection: { status: "repaired", row_count: 4 },
      completed_at: "2026-07-13T00:00:02.000Z",
    });
    expectNoKeys(reconcile, ["run_id", "run_ids", "rebuilt_runs", "receipt_path", "error"]);

    const failedReconcile = toCalyxAdminReconcileResult({
      scanned: 4,
      rebuilt: [],
      repair_pending: ["run-secret-repair"],
      classified: [],
      adopted: [],
      skipped: ["run-secret-1", "run-secret-2", "run-secret-3", "run-secret-4"],
      unresolved: [
        { run_id: "run-secret-legacy-1", reason: "legacy_owner_settlement_pending" },
        { run_id: "run-secret-legacy-2", reason: "legacy_owner_settlement_pending" },
        { run_id: "run-secret-resource", reason: "legacy_resource_settlement_pending" },
      ],
      noncanonical_directories: [{
        directory_name: "legacy active run",
        status: "requires_operator_migration",
        record_state: "running",
      }],
      projection: { status: "failed", reason: "private database path and error" },
    }, "2026-07-13T00:00:03.000Z");
    expect(failedReconcile).toMatchObject({
      status: "incomplete",
      changed: { unresolved: 3 },
      unresolved: [
        { reason: "legacy_owner_settlement_pending", count: 2 },
        { reason: "legacy_resource_settlement_pending", count: 1 },
      ],
      noncanonical_directories: [{
        directory_name: "legacy active run",
        status: "requires_operator_migration",
        record_state: "running",
      }],
      projection: { status: "failed" },
    });
    expect(JSON.stringify(failedReconcile)).not.toContain("private database path");
    expect(JSON.stringify(failedReconcile)).not.toContain("run-secret-legacy");
  });

  test("admin reconciliation exposes only bounded noncanonical directory examples", () => {
    const reconcile = toCalyxAdminReconcileResult({
      scanned: 0,
      rebuilt: [],
      repair_pending: [],
      classified: [],
      adopted: [],
      unresolved: [],
      skipped: [],
      noncanonical_directories: Array.from({ length: 65 }, (_, index) => ({
        directory_name: `${"d".repeat(300)}-${index}`,
        status: "requires_operator_migration" as const,
        record_state: "r".repeat(100),
      })),
      projection: { status: "repaired", rowCount: 0 },
    });

    expect(reconcile.status).toBe("incomplete");
    expect(reconcile.changed.noncanonical_directories).toBe(65);
    expect(reconcile.noncanonical_directories).toHaveLength(64);
    expect(reconcile.noncanonical_directories[0]?.directory_name).toHaveLength(255);
    expect(reconcile.noncanonical_directories[0]?.record_state).toHaveLength(64);
    expect(adminReconcileResultSchema.parse(reconcile)).toEqual(reconcile);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      noncanonical_directories: Array.from({ length: 65 }, () => reconcile.noncanonical_directories[0]),
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      status: "completed",
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      noncanonical_directories: [],
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      changed: { ...reconcile.changed, unresolved: 2 },
      unresolved: [{ reason: "legacy_owner_settlement_pending", count: 1 }],
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      changed: { ...reconcile.changed, unresolved: 2 },
      unresolved: [
        { reason: "legacy_owner_settlement_pending", count: 1 },
        { reason: "legacy_owner_settlement_pending", count: 1 },
      ],
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      status: "completed",
      changed: { ...reconcile.changed, noncanonical_directories: 0, repair_pending: 1 },
      noncanonical_directories: [],
    }).success).toBe(false);
    expect(adminReconcileResultSchema.safeParse({
      ...reconcile,
      status: "completed",
      changed: { ...reconcile.changed, noncanonical_directories: 0 },
      noncanonical_directories: [],
      projection: { status: "failed" },
    }).success).toBe(false);
  });

  test("run observations cannot inherit intents, prompts, env, local paths, receipts, or raw errors", () => {
    const projected = toRunObservation({
      run_id: "run-safe",
      state: "running",
      summary: "Caleb's unreleased acquisition target is Silver Dragonfly",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      health_status: "healthy",
      issue: "POL-1980",
      host: "blade",
      backend: "codex",
      recovery_mode: "normal",
      run_dir: "/tmp/private/run-safe",
      intent: { prompt: "must never cross", env: { SECRET: "value" } },
      receipt_path: "/tmp/private/receipt.json",
      raw_error: "private failure",
    } as never, {
      intent: {
        host: "blade",
        backend: "codex",
        branch: "caleb/pol-1980",
        prompt: "must never cross",
        metadata: { pr_url: "https://github.com/polli-labs/calyx-dev/pull/999", env: { SECRET: "value" } },
      },
      spec: { kernel: { command: ["rm", "-rf", "/"] } },
      kernel_receipt: { receipt_path: "/tmp/private/kernel.json" },
      integrations: {},
      recovery: { mode: "normal" },
    } as never);

    expect(projected).toMatchObject({
      schema_version: "calyx.run-observation/v1",
      run_id: "run-safe",
      branch: "caleb/pol-1980",
      pr_url: "https://github.com/polli-labs/calyx-dev/pull/999",
    });
    expect(projected.summary).toBe("Run run-safe is running.");
    expect(projected.summary).not.toMatch(/acquisition|silver dragonfly/i);
    expect(projected).not.toHaveProperty("attention_state");
    expectNoKeys(projected, [
      "intent", "spec", "prompt", "env", "run_dir", "session_path", "cwd",
      "receipt_path", "kernel_receipt", "raw_error", "integrations", "recovery",
    ]);
  });

  test.each([
    "PR #273",
    "javascript:alert(1)",
    "file:///tmp/private-receipt",
    "https://secret@example.test/polli-labs/calyx-dev/pull/273",
    "https://github.com/polli-labs/calyx-dev/pull/273?access_token=SECRET",
    "https://github.com/polli-labs/calyx-dev/pull/273#token=SECRET",
  ])(
    "omits non-HTTP pr_url metadata from run observations: %s",
    (prUrl) => {
      const projected = toRunObservation({
        run_id: "run-invalid-pr-url",
        state: "running",
        summary: "private summary",
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:01:00.000Z",
        host: "blade",
        backend: "codex",
      } as never, {
        intent: {
          host: "blade",
          backend: "codex",
          prompt: "private prompt",
          metadata: { pr_url: prUrl },
        },
      } as never);

      expect(projected).not.toHaveProperty("pr_url");
    },
  );

  test("omits an oversized branch instead of exposing an unbounded consumer field", () => {
    const projected = toRunObservation({
      run_id: "run-oversized-branch",
      state: "running",
      summary: "private summary",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      host: "blade",
      backend: "codex",
    } as never, {
      intent: {
        host: "blade",
        backend: "codex",
        branch: `secret-${"x".repeat(512)}`,
        prompt: "private prompt",
      },
    } as never);

    expect(projected).not.toHaveProperty("branch");
  });

  test("bounds normalized PR URLs and durable event optionals after projection", () => {
    const expandedPath = "é".repeat(400);
    const projected = toRunObservation({
      run_id: "run-normalized-url-bound",
      state: "running",
      summary: "private summary",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      host: "h".repeat(256),
      backend: "codex",
    } as never, {
      intent: { host: "blade", metadata: { pr_url: `https://github.com/${expandedPath}` } },
    } as never);
    expect(projected).not.toHaveProperty("pr_url");
    expect(projected.host).toBe("unknown");

    const event = toRunObservationEvent({
      schema_version: "1.0",
      event_id: "evt-bounded-observation",
      cursor: "2026-07-13T00:00:00.000Z-run-bounded-observation-000001",
      emitted_at: "2026-07-13T00:00:00.000Z",
      event_type: "run.terminal",
      emitted_by: "launch",
      run: {
        run_id: "run-bounded-observation",
        state: "succeeded",
        kernel: "agent_runner",
        host: "h".repeat(300),
        issue: "P".repeat(129),
        created_at: "2026-07-13T00:00:00.000Z",
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: { run_dir: "/tmp/run", run_record_path: "/tmp/run/record", events_path: "/tmp/run/events" },
      summary: { one_line: "private" },
      enrichment: { branch: "b".repeat(257) },
    });
    expect(event.run.host).toBe("unknown");
    expect(event.run).not.toHaveProperty("issue");
    expect(event.run).not.toHaveProperty("branch");
    expect(event.run).not.toHaveProperty("attention_state");
  });

  test("projects every admitted but consumer-unrepresentable run row to a total bounded gap receipt", () => {
    const oversizedTimestamp = `2026-07-13T00:00:00.${"1".repeat(80)}Z`;
    const source = {
      schema_version: "1.0",
      event_id: "evt-unrepresentable-observation",
      cursor: "2026-07-13T00:00:00.000Z-run-unrepresentable-observation-000001",
      emitted_at: oversizedTimestamp,
      event_type: "run.warning",
      emitted_by: "launch",
      run: {
        run_id: "r".repeat(257),
        state: "s".repeat(65),
        kernel: "agent_runner",
        backend: "b".repeat(65),
        host: "h".repeat(256),
        issue: "P".repeat(129),
        created_at: oversizedTimestamp,
        started_at: oversizedTimestamp,
        completed_at: oversizedTimestamp,
        recovery_mode: "normal",
      },
      origin: { launcher_kind: "cli" },
      pointers: {
        run_dir: "/private/run-dir",
        run_record_path: "/private/run-record.json",
        events_path: "/private/events.jsonl",
      },
      summary: { one_line: "x".repeat(241) },
      enrichment: { branch: "b".repeat(257) },
      payload: { token: "private" },
    };

    expect(isCalyxRunEvent(source)).toBe(true);
    expect(() => toRunObservationEvent(source as never)).toThrow();

    const gap = toRunObservationGapEvent(source as never);
    expect(gap).toEqual({
      schema_version: "calyx.run-observation-gap/v1",
      cursor: source.cursor,
      event_type: "run.projection_gap",
      gap: {
        reason: "source_event_unrepresentable",
        source_event_type: "run.warning",
      },
    });
    expectNoKeys(gap, [
      "run_id",
      "host",
      "issue",
      "branch",
      "backend",
      "state",
      "emitted_at",
      "created_at",
      "started_at",
      "completed_at",
      "summary",
      "pointers",
      "payload",
      "token",
      "error",
    ]);
  });

  test("monitor and wake observations cannot inherit predicates, bindings, commands, tokens, paths, or delivery evidence", () => {
    const monitor = {
      monitor_id: "mon-safe",
      schema_version: "monitor/v1",
      status: "active",
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:01:00.000Z",
      owner: "operator",
      created_by: "operator",
      create_provenance: "operator",
      assigned_host: "blade",
      source_run_id: "run-safe",
      preset: "runner-supervision",
      predicate: { command: "private" },
      rearm_policy: "every_change",
      delivery: { bindings: [{ command: ["secret"], cwd: "/tmp/private", token: "secret" }] },
      last_evaluated_at: null,
      last_match: null,
      last_transition_hash: null,
      last_wake_id: null,
      last_error: "raw private failure",
    } as never;
    const deliveries = [{
      status: "delivered",
      updated_at: "2026-07-13T00:02:00.000Z",
      target: { command: ["secret"], cwd: "/tmp/private" },
      evidence: { receipt_path: "/tmp/private/receipt.json", token: "secret" },
      error_message: "private",
    }] as never;
    const monitorObservation = toMonitorObservation(monitor, deliveries, 1);
    expect(monitorObservation).toMatchObject({
      schema_version: "calyx.monitor-observation/v1",
      monitor_id: "mon-safe",
      delivery_summary: { state: "delivered", attempted: 1, delivered: 1, failed: 0 },
    });
    expectNoKeys(monitorObservation, [
      "predicate", "delivery", "bindings", "command", "cwd", "token", "target",
      "evidence", "receipt_path", "error_message", "last_error", "suggested_commands",
    ]);

    const wakeObservation = toWakeObservation({
      wake_id: "wake-safe",
      monitor_id: "mon-safe",
      status: "pending",
      created_at: "2026-07-13T00:03:00.000Z",
      evaluation: { matched: true, evidence: [{ command: "secret", cwd: "/tmp/private" }] },
      delivery: { bindings: [{ token: "secret" }] },
      suggested_commands: ["rm -rf /"],
      receipt_path: "/tmp/private/wake.json",
    } as never, "blade");
    expect(wakeObservation).toMatchObject({
      schema_version: "calyx.wake-observation/v1",
      wake_id: "wake-safe",
      receipt_locator: { host: "blade", route: "/v1/monitors/wakes?monitor=mon-safe" },
    });
    expectNoKeys(wakeObservation, [
      "evaluation", "evidence", "delivery", "bindings", "command", "cwd", "token",
      "suggested_commands", "receipt_path",
    ]);
  });

  test("activity observations recursively omit source paths, visibility internals, tool payloads, and extraction provenance", () => {
    const message = {
      id: "msg-visible",
      activity_id: "interactive:codex:session-safe",
      turn_id: "turn-safe",
      role: "assistant",
      visibility: "default",
      text: "Visible bounded response: Silver Dragonfly acquisition target",
      summary: "Silver Dragonfly acquisition target; command=/bin/private path=/tmp/private token=secret",
      timestamp: "2026-07-13T00:00:01.000Z",
      truncated: false,
      attachments: [{ extracted_path: "/tmp/private/extracted.png" }],
      event_refs: [1],
      source_lines: [2],
      classification: { reason: "hidden", tool_payload: { token: "secret" } },
    };
    const source = {
      schema_version: "activity.messages/v1",
      activity_id: "interactive:codex:session-safe",
      backend: "codex",
      session_id: "session-safe",
      session_path: "/tmp/private/session.jsonl",
      source: "codex_sessions",
      cwd: "/tmp/private/repo",
      host: "blade",
      total_messages: 1,
      matched_messages: 1,
      returned_messages: 1,
      truncated: false,
      source_receipt: { source_path: "/tmp/private/session.jsonl" },
      selector: { visibility: "default", explain_classification: true },
      messages: [message],
    };
    const projectedMessages = toActivityMessagesObservation(source as never);
    expect(projectedMessages.messages[0]?.text).toContain("Silver Dragonfly acquisition target");
    expect(projectedMessages.messages[0]?.summary).toBe("Assistant message.");
    expect(projectedMessages.messages[0]?.summary).not.toMatch(/silver dragonfly|acquisition|\/tmp|\/bin|secret/i);
    expect(projectedMessages).not.toHaveProperty("returned_messages");
    expectNoKeys(projectedMessages, [
      "session_path", "cwd", "source", "source_receipt", "source_path", "selector",
      "visibility", "classification", "tool_payload", "attachments", "event_refs",
      "source_lines", "extracted_path", "provenance_path", "original_locator",
    ]);

    const projectedTurns = toActivityTurnsObservation({
      ...source,
      schema_version: "activity.turns/v1",
      total_events: 1,
      total_turns: 1,
      matched_turns: 1,
      returned_turns: 1,
      turns: [{
        turn_id: "turn-safe",
        index: 0,
        activity_id: "interactive:codex:session-safe",
        role: "assistant",
        state: "complete",
        summary: "Silver Dragonfly acquisition target; cwd=/tmp/private command=/bin/private",
        source_lines: [1, 2],
        event_refs: [1, 2],
        tool_call_count: 1,
        tool_result_count: 1,
        attachments: { images: 1, bytes: 10, refs: ["secret"] },
        messages: [message],
      }],
    } as never);
    expect(projectedTurns.turns[0]?.summary).toBe("Assistant turn is complete.");
    expect(projectedTurns.turns[0]?.summary).not.toMatch(/silver dragonfly|acquisition|\/tmp|\/bin/i);
    expect(projectedTurns.turns[0]).toMatchObject({
      messages_truncated: false,
    });
    expect(projectedTurns).not.toHaveProperty("returned_turns");
    expect(projectedTurns.turns[0]).not.toHaveProperty("activity_id");
    expect(projectedTurns.turns[0]?.messages[0]).not.toHaveProperty("activity_id");
    expect(projectedTurns.turns[0]?.messages[0]).not.toHaveProperty("turn_id");
    expect(projectedTurns.turns[0]).not.toHaveProperty("omitted_message_count");
    expect(projectedTurns.turns[0]).not.toHaveProperty("messages_recovery");
    expectNoKeys(projectedTurns, [
      "session_path", "cwd", "source", "source_receipt", "selector", "source_lines",
      "event_refs", "tool_call_count", "tool_result_count", "attachments", "classification",
      "visibility", "tool_payload",
    ]);

    const projectedAttachment = toActivityAttachmentObservation({
      ref: `att:sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
      mime_type: "image/png",
      byte_size: 12,
      source_shape: "codex.local_path",
      exact_bytes_available: true,
      activity_id: "interactive:codex:session-safe",
      message_id: "msg-visible",
      source_line: 4,
      event_index: 2,
      original_locator: "/tmp/private/original.png",
      extracted_path: "/tmp/private/extracted.png",
      provenance_path: "/tmp/private/provenance.json",
      origin_host: "blade",
      served_by_host: "blade",
      source_tier: "origin-daemon",
    });
    expectNoKeys(projectedAttachment, [
      "source_shape", "source_line", "event_index", "original_locator", "extracted_path",
      "provenance_path", "served_by_host", "source_tier", "cache_status",
    ]);
  });

  test("monitor, wake, activity, and attachment response strings enforce exact positive DTO ceilings", () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    const monitor = {
      schema_version: "calyx.monitor-observation/v1",
      monitor_id: "m",
      status: "active",
      preset: "runner-supervision",
      run_locator: "run:r",
      created_at: timestamp,
      updated_at: timestamp,
      delivery_summary: { state: "none", attempted: 0, delivered: 0, failed: 0 },
      wake_count: 0,
    };
    expect(monitorObservationSchema.safeParse({
      ...monitor,
      monitor_id: "m".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS),
      preset: "p".repeat(CONSUMER_PRESET_MAX_CHARS),
      run_locator: `run:${"r".repeat(CONSUMER_RUN_LOCATOR_MAX_CHARS - 4)}`,
    }).success).toBe(true);
    expect(monitorObservationSchema.safeParse({
      ...monitor,
      monitor_id: "m".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(monitorObservationSchema.safeParse({
      ...monitor,
      preset: "p".repeat(CONSUMER_PRESET_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(monitorObservationSchema.safeParse({
      ...monitor,
      run_locator: `run:${"r".repeat(CONSUMER_RUN_LOCATOR_MAX_CHARS - 3)}`,
    }).success).toBe(false);

    const wake = {
      schema_version: "calyx.wake-observation/v1",
      wake_id: "w",
      monitor_id: "m",
      status: "pending",
      created_at: timestamp,
      reason_summary: "Monitor predicate matched.",
      receipt_locator: { host: "blade", route: "/v1/monitors/wakes" },
    };
    expect(wakeObservationSchema.safeParse({
      ...wake,
      receipt_locator: {
        host: "h".repeat(CONSUMER_HOST_MAX_CHARS),
        route: `/v1/${"r".repeat(CONSUMER_ROUTE_LOCATOR_MAX_CHARS - 4)}`,
      },
    }).success).toBe(true);
    expect(wakeObservationSchema.safeParse({
      ...wake,
      receipt_locator: { ...wake.receipt_locator, host: "h".repeat(CONSUMER_HOST_MAX_CHARS + 1) },
    }).success).toBe(false);
    expect(wakeObservationSchema.safeParse({
      ...wake,
      receipt_locator: {
        ...wake.receipt_locator,
        route: `/v1/${"r".repeat(CONSUMER_ROUTE_LOCATOR_MAX_CHARS - 3)}`,
      },
    }).success).toBe(false);

    const activityMessages = {
      schema_version: "activity.messages/v1",
      activity_id: "a",
      backend: "codex",
      session_id: "s",
      host: "blade",
      total_messages: 1,
      matched_messages: 1,
      truncated: true,
      next_cursor: "c",
      messages: [{
        id: "message",
        activity_id: "a",
        turn_id: "turn",
        role: "assistant",
        summary: "Assistant message.",
        timestamp,
        truncated: false,
      }],
    };
    expect(activityMessagesObservationSchema.safeParse({
      ...activityMessages,
      activity_id: "a".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS),
      backend: "b".repeat(CONSUMER_BACKEND_MAX_CHARS),
      next_cursor: "c".repeat(CONSUMER_CURSOR_MAX_CHARS),
    }).success).toBe(true);
    expect(activityMessagesObservationSchema.safeParse({
      ...activityMessages,
      backend: "b".repeat(CONSUMER_BACKEND_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(activityMessagesObservationSchema.safeParse({
      ...activityMessages,
      next_cursor: "c".repeat(CONSUMER_CURSOR_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(activityMessagesObservationSchema.safeParse({
      ...activityMessages,
      messages: [{
        ...activityMessages.messages[0],
        id: "m".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
      }],
    }).success).toBe(false);

    expect(activityTurnsObservationSchema.safeParse({
      schema_version: "activity.turns/v1",
      activity_id: "a",
      backend: "codex",
      session_id: "s",
      total_turns: 1,
      matched_turns: 1,
      truncated: false,
      turns: [{
        turn_id: "t".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
        index: 0,
        role: "assistant",
        state: "complete",
        summary: "Assistant turn is complete.",
        messages_truncated: false,
        messages: [],
      }],
    }).success).toBe(false);
    expect(activityTextObservationSchema.safeParse({
      schema_version: "activity.text/v1",
      activity_id: "a",
      backend: "codex",
      session_id: "s",
      message_id: "m".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
      text: "safe",
      text_cursor: { total_chars: 4, returned: [[0, 4]] },
    }).success).toBe(false);

    const digest = "a".repeat(64);
    const maximumMimeType = `${"a".repeat(126)}/${"b".repeat(128)}`;
    expect(maximumMimeType).toHaveLength(CONSUMER_MIME_TYPE_MAX_CHARS);
    const attachment = {
      ref: `att:sha256:${digest}`,
      sha256: digest,
      mime_type: maximumMimeType,
      byte_size: 12,
      exact_bytes_available: true,
      activity_id: "a",
      message_id: "m",
      origin_host: "h".repeat(CONSUMER_HOST_MAX_CHARS),
    };
    expect(activityAttachmentObservationSchema.safeParse(attachment).success).toBe(true);
    expect(activityAttachmentObservationSchema.safeParse({
      ...attachment,
      mime_type: `${"a".repeat(127)}/${"b".repeat(128)}`,
    }).success).toBe(false);
    expect(activityAttachmentObservationSchema.safeParse({
      ...attachment,
      activity_id: "a".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(activityAttachmentObservationSchema.safeParse({
      ...attachment,
      origin_host: "h".repeat(CONSUMER_HOST_MAX_CHARS + 1),
    }).success).toBe(false);
  });

  test("message and lease response identities and locators fail closed at their exact ceilings", () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    const messageSource = {
      message_id: "message-safe",
      sender: "client:sender",
      recipient_address: "client:recipient",
      recipient_class: "directed",
      subject: "subject",
      body: "body",
      thread_key: "thread",
      reply_to: "parent",
      urgency: "normal",
      ack_required: false,
      expires_at: null,
      status: "pending",
      created_at: timestamp,
      updated_at: timestamp,
    };
    expect(toMessageObservation(messageSource as never)).toMatchObject({
      message_id: "message-safe",
      body_locator: "/v1/message-text/message-safe",
    });
    expect(() => toMessageObservation({
      ...messageSource,
      message_id: "m".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
    } as never)).toThrow();
    expect(() => toMessageObservation({
      ...messageSource,
      subject: "s".repeat(CONSUMER_MESSAGE_SUBJECT_MAX_CHARS + 1),
    } as never)).toThrow();

    const message = {
      ...toMessageObservation(messageSource as never),
      subject: "s".repeat(CONSUMER_MESSAGE_SUBJECT_MAX_CHARS),
      thread_key: "t".repeat(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS),
      reply_to: "r".repeat(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS),
      body_locator: `/v1/message-text/${"m".repeat(CONSUMER_ROUTE_LOCATOR_MAX_CHARS - 17)}`,
    };
    expect(message.body_locator).toHaveLength(CONSUMER_ROUTE_LOCATOR_MAX_CHARS);
    expect(messageObservationSchema.safeParse(message).success).toBe(true);
    expect(messageObservationSchema.safeParse({
      ...message,
      thread_key: "t".repeat(CONSUMER_MESSAGE_REFERENCE_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(messageObservationSchema.safeParse({
      ...message,
      body_locator: `${message.body_locator}m`,
    }).success).toBe(false);

    const leaseSource = {
      key: "worktree:blade:polli",
      resource_kind: "worktree",
      owner_host: "blade",
      holder_activity_id: "interactive:codex:session-safe",
      acquired_at: timestamp,
      renewed_at: null,
      expires_at: "2026-07-15T01:00:00.000Z",
    };
    expect(toLeaseObservation(leaseSource as never)).toMatchObject({
      owner_host: "blade",
      holder_locator: "interactive:codex:session-safe",
    });
    expect(() => toLeaseObservation({
      ...leaseSource,
      owner_host: "h".repeat(CONSUMER_HOST_MAX_CHARS + 1),
    } as never)).toThrow();
    expect(() => toLeaseObservation({
      ...leaseSource,
      holder_activity_id: "a".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS + 1),
    } as never)).toThrow();
    expect(leaseObservationSchema.safeParse({
      ...toLeaseObservation(leaseSource as never),
      owner_host: "h".repeat(CONSUMER_HOST_MAX_CHARS),
      holder_locator: "a".repeat(CONSUMER_PORTABLE_ID_MAX_CHARS),
    }).success).toBe(true);
  });

  test("activity page discriminators and nested turn recovery are exact and identity-normalized", () => {
    const activityId = "interactive:codex:session-bounded";
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `msg-${index}`,
      activity_id: activityId,
      turn_id: "turn-bounded",
      role: "assistant",
      visibility: "default",
      text: `message ${index}`,
      summary: `message ${index}`,
      truncated: false,
      event_refs: [index],
      source_lines: [index + 1],
      classification: { reason: "assistant" },
    }));
    const projected = toActivityTurnsObservation({
      schema_version: "activity.turns/v1",
      classifier_version: "test",
      activity_id: activityId,
      backend: "codex",
      session_id: "session-bounded",
      session_path: "/tmp/private/session.jsonl",
      source: "codex_sessions",
      source_state: "complete",
      warnings: [],
      source_receipt: {},
      total_events: 101,
      total_messages: 101,
      total_turns: 1,
      matched_turns: 1,
      returned_turns: 1,
      truncated: false,
      selector: {},
      turns: [{
        turn_id: "turn-bounded",
        index: 0,
        activity_id: activityId,
        role: "assistant",
        state: "complete",
        source_lines: [1, 101],
        event_refs: [0, 100],
        total_message_count: 101,
        visible_message_count: 101,
        tool_call_count: 0,
        tool_result_count: 0,
        attachments: { images: 0, bytes: 0, refs: [] },
        summary: "private summary",
        messages,
      }],
    } as never);

    expect(projected).toMatchObject({
      truncated: false,
      turns: [{
        messages_truncated: true,
        omitted_message_count: 1,
        messages_recovery: { operation_id: "activity.messages" },
      }],
    });
    expect(projected.turns[0]?.messages).toHaveLength(100);
    expect(projected.turns[0]).not.toHaveProperty("activity_id");
    expect(projected.turns[0]?.messages[0]).not.toHaveProperty("activity_id");
    expect(projected.turns[0]?.messages[0]).not.toHaveProperty("turn_id");
    const cloneAsWireObject = () => structuredClone(projected) as unknown as {
      turns: Array<Record<string, unknown>>;
      truncated: boolean;
      next_cursor?: string;
    };

    const missingRecovery = cloneAsWireObject();
    delete missingRecovery.turns[0]!["messages_recovery"];
    expect(activityTurnsObservationSchema.safeParse(missingRecovery).success).toBe(false);

    const wrongOperation = cloneAsWireObject();
    wrongOperation.turns[0]!["messages_recovery"] = { operation_id: "activity.turns" };
    expect(activityTurnsObservationSchema.safeParse(wrongOperation).success).toBe(false);

    const zeroOmitted = cloneAsWireObject();
    zeroOmitted.turns[0]!["omitted_message_count"] = 0;
    expect(activityTurnsObservationSchema.safeParse(zeroOmitted).success).toBe(false);

    const dishonestLegacyCounts = cloneAsWireObject();
    dishonestLegacyCounts.turns[0]!["messages_truncated"] = false;
    dishonestLegacyCounts.turns[0]!["total_messages"] = 101;
    dishonestLegacyCounts.turns[0]!["returned_messages"] = 100;
    expect(activityTurnsObservationSchema.safeParse(dishonestLegacyCounts).success).toBe(false);

    const legacyRoute = cloneAsWireObject();
    legacyRoute.turns[0]!["messages_route"] = `/v1/activity/${encodeURIComponent(activityId)}/messages`;
    expect(activityTurnsObservationSchema.safeParse(legacyRoute).success).toBe(false);

    const redundantTurnIdentity = cloneAsWireObject();
    redundantTurnIdentity.turns[0]!["activity_id"] = activityId;
    expect(activityTurnsObservationSchema.safeParse(redundantTurnIdentity).success).toBe(false);

    const redundantMessageIdentity = cloneAsWireObject();
    const nestedMessage = (redundantMessageIdentity.turns[0]!["messages"] as Array<Record<string, unknown>>)[0]!;
    nestedMessage["activity_id"] = activityId;
    nestedMessage["turn_id"] = "turn-bounded";
    expect(activityTurnsObservationSchema.safeParse(redundantMessageIdentity).success).toBe(false);

    const falsePageWithCursor = cloneAsWireObject();
    falsePageWithCursor.next_cursor = "cursor-for-complete-page";
    expect(activityTurnsObservationSchema.safeParse(falsePageWithCursor).success).toBe(false);

    const truePageWithoutCursor = cloneAsWireObject();
    truePageWithoutCursor.truncated = true;
    expect(activityTurnsObservationSchema.safeParse(truePageWithoutCursor).success).toBe(false);

    const truePage = cloneAsWireObject();
    truePage.truncated = true;
    truePage.next_cursor = "next-turn";
    expect(activityTurnsObservationSchema.safeParse(truePage).success).toBe(true);

    const messagePageSource = {
      schema_version: "activity.messages/v1",
      activity_id: activityId,
      backend: "codex",
      session_id: "session-bounded",
      total_messages: 101,
      matched_messages: 101,
      messages,
    } as never;
    const completeMessagePage = toActivityMessagesObservation(messagePageSource);
    expect(completeMessagePage).not.toHaveProperty("returned_messages");
    expect(completeMessagePage).not.toHaveProperty("next_cursor");
    expect(activityMessagesObservationSchema.safeParse({
      ...completeMessagePage,
      next_cursor: "cursor-for-complete-page",
    }).success).toBe(false);
    expect(activityMessagesObservationSchema.safeParse({
      ...completeMessagePage,
      truncated: true,
    }).success).toBe(false);
    expect(activityMessagesObservationSchema.safeParse({
      ...completeMessagePage,
      truncated: true,
      next_cursor: "next-message",
    }).success).toBe(true);
    expect(activityMessagesObservationSchema.safeParse({
      ...completeMessagePage,
      returned_messages: 100,
    }).success).toBe(false);
  });
});
