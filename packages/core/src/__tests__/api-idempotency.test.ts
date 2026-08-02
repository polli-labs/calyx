import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  API_IDEMPOTENCY_CANONICALIZER,
  API_IDEMPOTENCY_SCHEMA_MAJOR,
  readApiIdempotency,
  recordApiIdempotency,
  type RecordApiIdempotencyInput,
} from "../state/api-idempotency";
import { loadStateDriver, type StateDriverDatabase } from "../state/driver";
import { applyMigrations, STATE_MIGRATIONS } from "../state/migrations";
import type { ApiProvenanceV1 } from "../state/provenance";

const PROVENANCE: ApiProvenanceV1 = {
  schema_version: "calyx.provenance/v1",
  request_id: "req_00000000-0000-4000-8000-000000000001",
  subject: "switchboard",
  asserted_actor: "operator:caleb",
  host: "blade",
  via: "http",
  at: "2026-07-21T00:00:00.000Z",
};

describe("domain-neutral API idempotency ledger", () => {
  let root: string;
  let db: StateDriverDatabase;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calyx-api-idempotency-"));
    const driver = await loadStateDriver();
    db = driver.open(join(root, "state.db"));
    applyMigrations(db, STATE_MIGRATIONS, driver.id, () => "2026-07-21T00:00:00.000Z");
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test("scopes replay identity by subject and operation across message and marks capabilities", () => {
    const message = recordApiIdempotency(db, {
      subject: " switchboard ",
      operation_id: " msg.send ",
      idempotency_key: " shared-key ",
      first_request_provenance: PROVENANCE,
      wire_request_hash: "wire-message",
      request_hash: "semantic-message",
      semantic_canonicalizer: "calyx.msg-send-semantic/v1",
      response_status: 200,
      response: { schema_version: "calyx.msg-send-result/v1", message_id: "msg_1" },
      created_at: PROVENANCE.at,
    });
    const mark = recordApiIdempotency(db, {
      subject: "switchboard",
      operation_id: "attention.mark.create",
      idempotency_key: "shared-key",
      asserted_actor: "operator:caleb",
      first_request_id: PROVENANCE.request_id,
      first_request_provenance: PROVENANCE,
      request_hash: "semantic-mark",
      response_status: 201,
      response: { schema_version: "calyx.activity-mark/v1", mark_id: "mark_1" },
      created_at: PROVENANCE.at,
    });

    expect(message).toMatchObject({
      subject: "switchboard",
      operation_id: "msg.send",
      idempotency_key: "shared-key",
      asserted_actor: "operator:caleb",
      first_request_id: PROVENANCE.request_id,
      first_request_provenance: PROVENANCE,
      wire_request_hash: "wire-message",
      canonicalizer: API_IDEMPOTENCY_CANONICALIZER,
      schema_major: API_IDEMPOTENCY_SCHEMA_MAJOR,
      semantic_canonicalizer: "calyx.msg-send-semantic/v1",
      response_status: 200,
      response: { schema_version: "calyx.msg-send-result/v1", message_id: "msg_1" },
    });
    expect(mark).toMatchObject({
      operation_id: "attention.mark.create",
      wire_request_hash: null,
      semantic_canonicalizer: null,
      request_hash: "semantic-mark",
      response_status: 201,
      response: { schema_version: "calyx.activity-mark/v1", mark_id: "mark_1" },
    });
    expect(readApiIdempotency(db, " switchboard ", " attention.mark.create ", " shared-key "))
      .toEqual(mark);
    expect(readApiIdempotency(db, "switchboard", "msg.send", "shared-key")).toEqual(message);
    expect(readApiIdempotency(db, "another-client", "msg.send", "shared-key")).toBeUndefined();
  });

  test("preserves the provenance binding and required-identity validation contract", () => {
    const base: RecordApiIdempotencyInput = {
      subject: "switchboard",
      operation_id: "attention.mark.create",
      idempotency_key: "mark-key",
      first_request_provenance: PROVENANCE,
      request_hash: "semantic-mark",
      response_status: 201,
      response: { mark_id: "mark_1" },
    };

    expect(() => recordApiIdempotency(db, { ...base, subject: "" }))
      .toThrow("subject must be non-empty");
    expect(() => recordApiIdempotency(db, { ...base, operation_id: "  " }))
      .toThrow("operation_id must be non-empty");
    expect(() => recordApiIdempotency(db, { ...base, idempotency_key: "\t" }))
      .toThrow("idempotency_key must be non-empty");
    expect(() => recordApiIdempotency(db, { ...base, subject: "other-client" }))
      .toThrow("first request provenance subject must match the idempotency subject");
    expect(() => recordApiIdempotency(db, { ...base, asserted_actor: "run:other" }))
      .toThrow("first request provenance asserted_actor must match the idempotency asserted_actor");
    expect(() => recordApiIdempotency(db, {
      ...base,
      first_request_id: "req_00000000-0000-4000-8000-000000000002",
    })).toThrow("first request provenance request_id must match the idempotency first_request_id");
    expect((db.prepare("SELECT COUNT(*) AS n FROM api_idempotency").get() as { n: number }).n)
      .toBe(0);
  });
});
