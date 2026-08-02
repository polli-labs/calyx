import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  admitApiRequestAudit,
  apiRequestAuditDoctor,
  applyStateMigrations,
  finalizeApiRequestAudit,
  markApiRequestAuditIndeterminate,
  listApiRequestAudits,
  openStateStore,
  pruneApiRequestAudits,
  readApiRequestAudit,
  recoverAdmittedApiRequestAudits,
} from "../state";

describe("HTTP request audit", () => {
  let root: string;
  let original: string | undefined;

  beforeEach(async () => {
    original = process.env["CALYX_STATE_HOME"];
    root = await mkdtemp(join(tmpdir(), "calyx-request-audit-"));
    process.env["CALYX_STATE_HOME"] = join(root, "state");
    await applyStateMigrations();
  });

  afterEach(async () => {
    if (original === undefined) delete process.env["CALYX_STATE_HOME"];
    else process.env["CALYX_STATE_HOME"] = original;
    await rm(root, { recursive: true, force: true });
  });

  test("CAS-finalizes 2xx as completed and 3xx-5xx as rejected", async () => {
    const opened = await openStateStore();
    try {
      for (const [suffix, status, outcome] of [["ok", 204, "response_completed"], ["redirect", 302, "response_rejected"], ["bad", 409, "response_rejected"]] as const) {
        const requestId = `req_123e4567-e89b-42d3-a456-4266141740${suffix === "ok" ? "01" : suffix === "redirect" ? "02" : "03"}`;
        admitApiRequestAudit(opened.db, {
          request_id: requestId,
          server_instance_id: "server-a",
          operation_id: "msg.send",
          subject: "switchboard",
          served_by_host: "blade",
          admitted_at: "2026-07-14T04:00:00.000Z",
        });
        expect(finalizeApiRequestAudit(opened.db, { request_id: requestId, response_status: status }).outcome).toBe(outcome);
        expect(() => finalizeApiRequestAudit(opened.db, { request_id: requestId, response_status: status })).toThrow(/already finalized/);
      }
      expect(apiRequestAuditDoctor(opened.db)).toMatchObject({ schema_status: "ok", retained: 3 });
    } finally {
      opened.db.close();
    }
  });

  test("recovery excludes current-process admissions and abandoned responses become indeterminate", async () => {
    const opened = await openStateStore();
    try {
      for (const [requestId, server] of [
        ["req_123e4567-e89b-42d3-a456-426614174010", "current"],
        ["req_123e4567-e89b-42d3-a456-426614174011", "dead"],
      ] as const) {
        admitApiRequestAudit(opened.db, { request_id: requestId, server_instance_id: server, operation_id: "msg.send", subject: "switchboard", served_by_host: "blade" });
      }
      expect(recoverAdmittedApiRequestAudits(opened.db, { current_server_instance_id: "current" })).toBe(1);
      expect(readApiRequestAudit(opened.db, "req_123e4567-e89b-42d3-a456-426614174010")?.outcome).toBe("admitted");
      expect(readApiRequestAudit(opened.db, "req_123e4567-e89b-42d3-a456-426614174011")?.outcome).toBe("indeterminate");
      expect(markApiRequestAuditIndeterminate(opened.db, "req_123e4567-e89b-42d3-a456-426614174010")).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("seek-pages the full ledger across admitted-at ties without duplicates", async () => {
    const opened = await openStateStore();
    try {
      const ids = [
        "req_00000000-0000-4000-8000-000000000001",
        "req_00000000-0000-4000-8000-000000000002",
        "req_00000000-0000-4000-8000-000000000003",
        "req_00000000-0000-4000-8000-000000000004",
        "req_00000000-0000-4000-8000-000000000005",
      ];
      for (const [index, requestId] of ids.entries()) {
        admitApiRequestAudit(opened.db, {
          request_id: requestId,
          server_instance_id: "server-page",
          operation_id: "msg.send",
          subject: "switchboard",
          served_by_host: "blade",
          admitted_at: index < 3
            ? "2026-07-14T04:00:02.000Z"
            : "2026-07-14T04:00:01.000Z",
        });
      }
      const snapshot = "2026-07-14T04:00:03.000Z";
      const first = listApiRequestAudits(opened.db, { limit: 3, snapshot_at: snapshot });
      expect(first.map((row) => row.request_id)).toEqual(ids.slice(0, 3));
      const second = listApiRequestAudits(opened.db, {
        limit: 3,
        snapshot_at: snapshot,
        after: {
          admitted_at: first.at(-1)!.admitted_at,
          request_id: first.at(-1)!.request_id,
        },
      });
      expect(second.map((row) => row.request_id)).toEqual(ids.slice(3));
      expect(new Set([...first, ...second].map((row) => row.request_id)).size).toBe(5);
    } finally {
      opened.db.close();
    }
  });

  test("CHECK constraints reject invalid row shapes and pruning is bounded to 500 terminal rows", async () => {
    const opened = await openStateStore();
    try {
      expect(() => opened.db.prepare(
        `INSERT INTO api_request_audit
           (request_id, server_instance_id, operation_id, subject, served_by_host, via,
            admitted_at, finalized_at, response_status, error_code, outcome)
         VALUES ('bad', 'server', 'op', 'subject', 'blade', 'tcp',
                 '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, 'admitted')`,
      ).run()).toThrow();
      const insert = opened.db.prepare(
        `INSERT INTO api_request_audit
           (request_id, server_instance_id, operation_id, subject, served_by_host, via,
            admitted_at, finalized_at, response_status, error_code, outcome)
         VALUES (?, 'server', 'op', 'subject', 'blade', 'http',
                 '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:01.000Z', 200, NULL, 'response_completed')`,
      );
      opened.db.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < 501; index += 1) insert.run(`old-${index}`);
      opened.db.exec("COMMIT");
      expect(pruneApiRequestAudits(opened.db, { now: "2026-07-14T00:00:00.000Z" })).toBe(500);
      expect(apiRequestAuditDoctor(opened.db).retained).toBe(1);
    } finally {
      opened.db.close();
    }
  });
});
