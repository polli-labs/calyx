import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open as openFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ackMessage,
  drainMessageReceiptMirrors,
  applyStateMigrations,
  checkMessageSchema,
  canonicalizeJcs,
  claimMessageOutboxAttempt,
  claimDirectedMessages,
  createMessage,
  countAuthorizedMessages,
  enqueueMessageOutbox,
  enqueueMessageReceiptMirror,
  expireDirectedClaims,
  expireMessageOutbox,
  openStateStore,
  hashCanonicalJcs,
  listAuthorizedMessages,
  readAuthorizedMessage,
  listMalformedMessageReceiptSnapshots,
  markMessageOutboxAttemptFailed,
  markMessageOutboxDeliveryFailed,
  markMessageOutboxForwarded,
  MSG_SEND_SEMANTIC_CANONICALIZER,
  peekScopeMessages,
  readMessage,
  readMessageOutbox,
  readMessageReceiptMirror,
  readApiIdempotency,
  recordApiIdempotency,
  recoverExpiredMessageOutboxAttempts,
  reportStateHealth,
  resolveMessageAddress,
  runStateDoctor,
  STATE_MIGRATIONS,
  type DrainMessageReceiptMirrorsResult,
} from "../state";
import {
  readMessageReceiptFileEvidence,
  serializeCanonicalMessageReceiptEnvelope,
} from "../state/message-receipt-snapshot";
import { MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL } from "../state/migrations";

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;

interface GenericFileWriteResult {
  bytesWritten: number;
  buffer: unknown;
}

type GenericFileWrite = (...args: unknown[]) => Promise<GenericFileWriteResult>;

interface GenericFileReadResult {
  bytesRead: number;
  buffer: unknown;
}

type GenericFileRead = (...args: unknown[]) => Promise<GenericFileReadResult>;

type GenericFileSync = () => Promise<void>;

interface GenericFileStatResult {
  isFile(): boolean;
}

type GenericFileStat = () => Promise<GenericFileStatResult>;

type ReceiptHistoryCorruption =
  | "invalid_utf8"
  | "duplicate_key"
  | "noncanonical_order"
  | "blank_line"
  | "incomplete_ghost";

function corruptReceiptHistory(
  kind: ReceiptHistoryCorruption,
  canonicalLine: string,
): string | Uint8Array {
  if (kind === "invalid_utf8") {
    return Buffer.concat([Buffer.from(canonicalLine, "utf8"), Buffer.from([0xff, 0x0a])]);
  }
  if (kind === "duplicate_key") {
    return `${canonicalLine.replace(
      "{",
      '{"schema_version":"calyx.message/v1",',
    )}\n`;
  }
  if (kind === "noncanonical_order") {
    const parsed = JSON.parse(canonicalLine) as { schema_version: string; message: unknown };
    return `${JSON.stringify({ message: parsed.message, schema_version: parsed.schema_version })}\n`;
  }
  if (kind === "blank_line") return `${canonicalLine}\n\n`;
  return `${canonicalLine}\n{"schema_version":"calyx.message/v1","message":`;
}

async function fileHandlePrototype(root: string): Promise<{
  read: GenericFileRead;
  write: GenericFileWrite;
  sync: GenericFileSync;
  stat: GenericFileStat;
}> {
  const probe = await openFile(join(root, "file-handle-probe"), "w");
  try {
    return Object.getPrototypeOf(probe) as {
      read: GenericFileRead;
      write: GenericFileWrite;
      sync: GenericFileSync;
      stat: GenericFileStat;
    };
  } finally {
    await probe.close();
  }
}

async function findViteNodeEntrypoint(): Promise<string> {
  const pnpmModules = join(process.cwd(), "node_modules", ".pnpm");
  const packageDirectory = (await readdir(pnpmModules))
    .filter((entry) => entry.startsWith("vite-node@"))
    .sort()
    .at(-1);
  if (!packageDirectory) throw new Error(`vite-node is unavailable under ${pnpmModules}`);
  return join(pnpmModules, packageDirectory, "node_modules", "vite-node", "vite-node.mjs");
}

/**
 * Callers cold-start a real `vite-node` subprocess, so this waits on genuine
 * process startup. The deadline used to be 5_000ms while the enclosing tests
 * carried vitest's 5_000ms default — inner bound equal to outer bound, so the
 * test could never actually report this diagnostic; it just timed out. Keep it
 * strictly below the declared `testTimeout` (30_000ms) so a real startup
 * failure surfaces as "timed out waiting for <path>" instead of an opaque
 * test-level timeout.
 */
async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
      await delay(10);
    }
  }
}

function startMessageReceiptWorker(
  viteNodeEntrypoint: string,
  messageId: string,
  readyPath: string,
  gatePath: string,
): { child: ReturnType<typeof spawn>; result: Promise<DrainMessageReceiptMirrorsResult> } {
  const fixture = join(process.cwd(), "packages", "core", "src", "__tests__", "fixtures", "message-receipt-worker.ts");
  const child = spawn(process.execPath, [
    viteNodeEntrypoint,
    "--script",
    fixture,
    messageId,
    readyPath,
    gatePath,
  ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const result = new Promise<DrainMessageReceiptMirrorsResult>((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`message receipt worker exited ${code}: ${stderr}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        rejectResult(new Error(`message receipt worker produced no result: ${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(line) as DrainMessageReceiptMirrorsResult);
      } catch (error) {
        rejectResult(new Error(`invalid message receipt worker result ${line}: ${String(error)}`));
      }
    });
  });
  return { child, result };
}

describe("message correspondence state", () => {
  let root: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    for (const key of ENV_KEYS) delete process.env[key];
    root = await mkdtemp(join(tmpdir(), "calyx-messages-"));
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

  test("client inbox addresses are explicit, portable, and distinct from legacy authorship shorthand", () => {
    expect(resolveMessageAddress("client:switchboard@blade", { currentHost: "carbon" })).toEqual({
      input: "client:switchboard@blade",
      address: "client:switchboard@blade",
      recipient_class: "directed",
      target_host: "blade",
      kind: "client",
    });
    expect(() => resolveMessageAddress("client:switchboard", { currentHost: "blade" }))
      .toThrow(/client:<client-id>@<host>/);
    expect(resolveMessageAddress("codex:blade:session-1", { currentHost: "carbon" })).toMatchObject({
      address: "interactive:codex:session-1",
      target_host: "blade",
      kind: "authorship_alias",
    });
  });

  test("migrations create message and consumer idempotency tables", async () => {
    const opened = await openStateStore();
    try {
      expect(checkMessageSchema(opened.db)).toEqual({ status: "ok", findings: [] });
      expect(opened.db.prepare("PRAGMA table_info(message_receipt_mirrors)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "receipt_snapshot_json", notnull: 1 }),
        ]));
      expect((opened.db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>).map(({ name }) => name))
        .toEqual(expect.arrayContaining(["wire_request_hash", "semantic_canonicalizer"]));
    } finally {
      opened.db.close();
    }

    await expect(reportStateHealth()).resolves.toMatchObject({
      ok: true,
      messages: { schemaParity: "ok", malformed: [] },
    });
    const report = await runStateDoctor({ domains: ["messages"] });
    expect(report.ok).toBe(true);
    expect(report.messages).toMatchObject({
      migrationApplied: true,
      schemaParity: "ok",
      messageCount: 0,
      outboxCount: 0,
    });
    expect(report.domains?.find((domain) => domain.domain === "messages")).toMatchObject({
      status: "ok",
    });

    const constrained = await openStateStore();
    try {
      const message = createMessage(constrained.db, {
        message_id: "msg_receipt_constraint_fresh",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "fresh receipt constraint",
      }).message;
      enqueueMessageReceiptMirror(constrained.db, message.message_id);
      expect(() => constrained.db.prepare(
        `UPDATE message_receipt_mirrors SET receipt_snapshot_json = NULL WHERE message_id = ?`,
      ).run(message.message_id)).toThrow();
      expect(() => constrained.db.prepare(
        `UPDATE message_receipt_mirrors SET receipt_snapshot_json = '{' WHERE message_id = ?`,
      ).run(message.message_id)).toThrow();
      expect(() => constrained.db.prepare(
        `UPDATE message_receipt_mirrors SET attempt_count = ? WHERE message_id = ?`,
      ).run(0.5, message.message_id)).toThrow();
      expect(() => constrained.db.prepare(
        `UPDATE message_receipt_mirrors SET attempt_count = ? WHERE message_id = ?`,
      ).run("not-an-integer", message.message_id)).toThrow();
      expect(() => constrained.db.prepare(
        `UPDATE message_receipt_mirrors SET status = 'completed' WHERE message_id = ?`,
      ).run(message.message_id)).toThrow();
      expect(() => constrained.db.prepare(
        `INSERT INTO message_receipt_mirrors (
           message_id, receipt_snapshot_json, status, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (NULL, '{}', 'pending', 0, ?, ?, ?)`,
      ).run(message.created_at, message.created_at, message.updated_at)).toThrow();
    } finally {
      constrained.db.close();
    }
  });

  test("receipt mirrors accept both authentic admission branches and refuse later live-state projection", async () => {
    const opened = await openStateStore();
    try {
      const pending = createMessage(opened.db, {
        message_id: "msg_pending_admission_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "pending admission",
        now: "2026-07-14T06:20:00.000Z",
      }).message;
      const outbox = createMessage(opened.db, {
        message_id: "msg_outbox_admission_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "outbox admission",
        status: "outbox",
        now: "2026-07-14T06:20:01.000Z",
      }).message;
      expect(enqueueMessageReceiptMirror(opened.db, pending.message_id)).toMatchObject({ status: "pending" });
      expect(enqueueMessageReceiptMirror(opened.db, outbox.message_id)).toMatchObject({ status: "pending" });

      const advanced = createMessage(opened.db, {
        message_id: "msg_late_snapshot_refused",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not project ACK as admission",
        now: "2026-07-14T06:20:02.000Z",
      }).message;
      expect(ackMessage(opened.db, advanced.message_id, {
        acked_by: "client:reviewer@blade",
        acked_at: "2026-07-14T06:20:03.000Z",
      })).toMatchObject({ changed: true });
      expect(() => enqueueMessageReceiptMirror(opened.db, advanced.message_id))
        .toThrow(/authentic admission snapshot.*status must be outbox or pending/u);
    } finally {
      opened.db.close();
    }
  });

  test("message doctor rejects a migration-current nullable and checkless receipt snapshot", async () => {
    const driftOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "receipt-constraint-drift") },
    };
    await applyStateMigrations({ storeOptions: driftOptions });
    const opened = await openStateStore(driftOptions);
    try {
      expect((opened.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0035");
      opened.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_constrained;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO message_receipt_mirrors SELECT * FROM receipt_mirrors_constrained;
        DROP TABLE receipt_mirrors_constrained;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      expect(checkMessageSchema(opened.db)).toMatchObject({
        status: "drift",
        findings: expect.arrayContaining([
          expect.objectContaining({
            table: "message_receipt_mirrors",
            code: "invalid-column-constraint",
            detail: expect.stringContaining("NOT NULL"),
          }),
          expect.objectContaining({
            table: "message_receipt_mirrors",
            code: "invalid-column-constraint",
            detail: expect.stringContaining("json_valid"),
          }),
        ]),
      });
    } finally {
      opened.db.close();
    }
    const report = await runStateDoctor({ domains: ["messages"], storeOptions: driftOptions });
    expect(report.ok).toBe(false);
    expect(report.messages.schemaParity).toBe("drift");
  });

  test("schema parity proves receipt mirror identity constraints and the exact control law", async () => {
    const driftOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "receipt-identity-schema-drift") },
    };
    await applyStateMigrations({ storeOptions: driftOptions });
    const opened = await openStateStore(driftOptions);
    try {
      opened.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_canonical;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT NOT NULL,
          receipt_snapshot_json TEXT NOT NULL CHECK (json_valid(receipt_snapshot_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (message_id, status)
          /* CONSTRAINT receipt_mirror_control_state
             CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL}) */
        );
        DROP TABLE receipt_mirrors_canonical;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      const report = checkMessageSchema(opened.db);
      expect(report.status).toBe("drift");
      expect(report.findings.map(({ detail }) => detail)).toEqual([
        "message_id must be the single-column primary key",
        "message_id must reference messages(message_id) ON DELETE CASCADE with ON UPDATE NO ACTION",
        "receipt mirror status must enforce the exact relational and chronological control-state constraint",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("schema parity proves critical receipt column domains and exact FK actions", async () => {
    const driftOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "receipt-column-contract-drift") },
    };
    await applyStateMigrations({ storeOptions: driftOptions });
    const opened = await openStateStore(driftOptions);
    try {
      opened.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_canonical;
        CREATE TABLE message_receipt_mirrors (
          message_id BLOB NOT NULL PRIMARY KEY
            REFERENCES messages(message_id) ON UPDATE CASCADE ON DELETE CASCADE,
          receipt_snapshot_json BLOB NOT NULL CHECK (json_valid(receipt_snapshot_json)),
          status NUMERIC CHECK (status IN ('pending', 'completed')),
          attempt_count TEXT DEFAULT 0
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at INTEGER,
          updated_at BLOB,
          CONSTRAINT receipt_mirror_control_state CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL})
        );
        DROP TABLE receipt_mirrors_canonical;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);

      expect(checkMessageSchema(opened.db)).toEqual({
        status: "drift",
        findings: [
          expect.objectContaining({ detail: "message_id must be declared TEXT NOT NULL" }),
          expect.objectContaining({ detail: "receipt_snapshot_json must be declared TEXT NOT NULL" }),
          expect.objectContaining({ detail: "status must be declared TEXT NOT NULL" }),
          expect.objectContaining({ detail: "attempt_count must be declared INTEGER NOT NULL" }),
          expect.objectContaining({ detail: "created_at must be declared TEXT NOT NULL" }),
          expect.objectContaining({ detail: "updated_at must be declared TEXT NOT NULL" }),
          expect.objectContaining({
            detail: "message_id must reference messages(message_id) ON DELETE CASCADE with ON UPDATE NO ACTION",
          }),
        ],
      });
    } finally {
      opened.db.close();
    }
  });

  test("schema parity ignores quoted CHECK decoys instead of treating text as behavior", async () => {
    const driftOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "receipt-quoted-check-decoys") },
    };
    await applyStateMigrations({ storeOptions: driftOptions });
    const opened = await openStateStore(driftOptions);
    try {
      const quotedControlDecoy = `CONSTRAINT receipt_mirror_control_state CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL})`
        .replaceAll("'", "''");
      opened.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_canonical;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT NOT NULL
            DEFAULT 'CHECK (json_valid(receipt_snapshot_json))',
          status TEXT NOT NULL
            DEFAULT 'CHECK (status IN (''pending'', ''completed''))',
          attempt_count INTEGER NOT NULL
            DEFAULT 'CHECK (typeof(attempt_count) = ''integer'' AND attempt_count >= 0)',
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT DEFAULT '${quotedControlDecoy}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
          /* CHECK (json_valid(receipt_snapshot_json))
             CHECK (status IN ('pending', 'completed'))
             CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0)
             CONSTRAINT receipt_mirror_control_state
               CHECK (${MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL}) */
        );
        DROP TABLE receipt_mirrors_canonical;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);

      expect(checkMessageSchema(opened.db)).toEqual({
        status: "drift",
        findings: [
          expect.objectContaining({ detail: expect.stringContaining("json_valid") }),
          expect.objectContaining({ detail: expect.stringContaining("status must enforce CHECK") }),
          expect.objectContaining({ detail: expect.stringContaining("non-negative SQLite integer CHECK") }),
          expect.objectContaining({ detail: expect.stringContaining("exact relational and chronological") }),
        ],
      });
    } finally {
      opened.db.close();
    }
  });

  test("schema parity preserves quoted literal bytes while normalizing CHECK structure", async () => {
    const driftOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "receipt-check-literal-alias") },
    };
    await applyStateMigrations({ storeOptions: driftOptions });
    const opened = await openStateStore(driftOptions);
    try {
      const aliasedControl = MESSAGE_RECEIPT_MIRROR_CONTROL_CHECK_SQL
        .replaceAll("'pending'", "'p ending'");
      opened.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_canonical;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT NOT NULL CHECK (json_valid(receipt_snapshot_json)),
          status TEXT NOT NULL CHECK (status IN ('p ending', 'completed')),
          attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CONSTRAINT receipt_mirror_control_state CHECK (${aliasedControl})
        );
        DROP TABLE receipt_mirrors_canonical;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);

      expect(checkMessageSchema(opened.db)).toEqual({
        status: "drift",
        findings: [
          expect.objectContaining({ detail: expect.stringContaining("status must enforce CHECK") }),
          expect.objectContaining({ detail: expect.stringContaining("exact relational and chronological") }),
        ],
      });
    } finally {
      opened.db.close();
    }
  });

  test.each([
    {
      label: "non-boolean ack_required",
      mutation: "UPDATE messages SET ack_required = 2 WHERE message_id = ?",
      expected: /ack_required must be the SQLite integer 0 or 1/u,
    },
    {
      label: "non-boolean dead_letter",
      mutation: "UPDATE messages SET dead_letter = 2 WHERE message_id = ?",
      expected: /dead_letter must be the SQLite integer 0 or 1/u,
    },
    {
      label: "NULL spooled_at",
      mutation: "UPDATE messages SET spooled_at = NULL WHERE message_id = ?",
      expected: /spooled_at must be a non-null canonical UTC ISO timestamp/u,
      requires_nullable_source: true,
    },
    {
      label: "malformed payload JSON",
      mutation: "UPDATE messages SET payload_json = '{' WHERE message_id = ?",
      expected: /malformed authoritative payload JSON/u,
    },
  ])("receipt enqueue rejects raw corrupt source: $label", async ({
    mutation,
    expected,
    requires_nullable_source,
  }) => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_raw_source_rejected_before_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "raw source is authoritative",
      }).message;
      if (requires_nullable_source) {
        opened.db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE messages_nullable_source AS SELECT * FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_nullable_source RENAME TO messages;
          PRAGMA foreign_keys = ON;
        `);
      }
      opened.db.exec("PRAGMA ignore_check_constraints = ON");
      opened.db.prepare(mutation).run(message.message_id);
      opened.db.exec("PRAGMA ignore_check_constraints = OFF");

      expect(() => enqueueMessageReceiptMirror(opened.db, message.message_id)).toThrow(expected);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toBeUndefined();
      await expect(readFile(
        join(opened.paths.stateDir, "receipts", "messages.jsonl"),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      opened.db.close();
    }
  });

  test("receipt doctor does not skip the empty-string key at the start of its keyset", async () => {
    const opened = await openStateStore();
    try {
      const now = "2026-07-14T06:25:00.000Z";
      opened.db.prepare(
        `INSERT INTO messages (
           message_id, schema_version, sender, recipient_address, recipient_class,
           subject, body, urgency, ack_required, status, expired_claim_cycles,
           dead_letter, created_at, updated_at, spooled_at, payload_json
         ) VALUES (
           '', 'calyx.message/v1', 'client:sender@blade', 'role:reviewer@blade',
           'directed', 'invalid empty identity', '', 'normal', 0, 'pending', 0,
           0, ?, ?, ?, '{}'
         )`,
      ).run(now, now, now);
      opened.db.prepare(
        `INSERT INTO message_receipt_mirrors (
           message_id, receipt_snapshot_json, status, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES ('', '{}', 'pending', 0, ?, ?, ?)`,
      ).run(now, now, now);

      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: "",
          code: "invalid-receipt-control",
          detail: expect.stringContaining("non-empty canonical string"),
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("receipt doctor rejects reducer timestamps that cannot occur chronologically", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_impossible_receipt_chronology",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "time cannot run backwards",
        now: "2026-07-14T06:26:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id, message.created_at);
      opened.db.exec("PRAGMA ignore_check_constraints = ON");
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
            SET attempt_count = 1,
                last_attempt_at = '2026-07-14T06:25:59.000Z',
                updated_at = '2026-07-14T06:25:59.000Z'
          WHERE message_id = ?`,
      ).run(message.message_id);
      opened.db.exec("PRAGMA ignore_check_constraints = OFF");

      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          code: "invalid-receipt-control",
          detail: expect.stringContaining("updated_at cannot precede created_at"),
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("receipt doctor and runtime reject an attempted retry scheduled before its last attempt", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_receipt_retry_before_attempt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "retry time follows attempt time",
        now: "2026-07-14T06:27:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id, message.created_at);
      opened.db.exec("PRAGMA ignore_check_constraints = ON");
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
            SET attempt_count = 1,
                last_attempt_at = '2026-07-14T06:27:02.000Z',
                next_attempt_at = '2026-07-14T06:27:01.000Z',
                updated_at = '2026-07-14T06:27:02.000Z'
          WHERE message_id = ?`,
      ).run(message.message_id);
      opened.db.exec("PRAGMA ignore_check_constraints = OFF");

      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          code: "invalid-receipt-control",
          detail: expect.stringContaining("next_attempt_at cannot precede last_attempt_at"),
        }),
      ]);
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      await expect(readFile(
        join(opened.paths.stateDir, "receipts", "messages.jsonl"),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        attempt_count: 1,
        next_attempt_at: "2026-07-14T06:27:01.000Z",
        last_attempt_at: "2026-07-14T06:27:02.000Z",
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt drain validates raw mirror storage before Number coercion", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_raw_text_attempt_count",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "raw SQLite domains are authoritative",
        now: "2026-07-14T06:28:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id, message.created_at);
      opened.db.exec("PRAGMA ignore_check_constraints = ON");
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
            SET attempt_count = '0x1',
                last_attempt_at = created_at,
                next_attempt_at = created_at,
                updated_at = created_at
          WHERE message_id = ?`,
      ).run(message.message_id);
      opened.db.exec("PRAGMA ignore_check_constraints = OFF");
      expect(opened.db.prepare(
        `SELECT attempt_count, typeof(attempt_count) AS storage
           FROM message_receipt_mirrors
          WHERE message_id = ?`,
      ).get(message.message_id)).toEqual({ attempt_count: "0x1", storage: "text" });

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(opened.db.prepare(
        `SELECT status, attempt_count, typeof(attempt_count) AS storage
           FROM message_receipt_mirrors
          WHERE message_id = ?`,
      ).get(message.message_id)).toEqual({ status: "pending", attempt_count: "0x1", storage: "text" });
      await expect(readFile(
        join(opened.paths.stateDir, "receipts", "messages.jsonl"),
        "utf8",
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      opened.db.close();
    }
  });

  test("message doctor and receipt drain fail closed on structurally invalid snapshot JSON", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_structurally_invalid_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "valid JSON is not a receipt",
        now: "2026-07-14T06:30:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
         SET receipt_snapshot_json = ?
         WHERE message_id = ?`,
      ).run(JSON.stringify({
        schema_version: "calyx.message/v1",
        message_id: message.message_id,
      }), message.message_id);

      // Row integrity is a bounded doctor concern, not schema parity: ordinary
      // request preflight must not walk every historical receipt snapshot.
      expect(checkMessageSchema(opened.db)).toEqual({ status: "ok", findings: [] });
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        receipt_path: null,
        last_error_code: "receipt_snapshot_invalid",
      });
    } finally {
      opened.db.close();
    }

    const report = await runStateDoctor({ domains: ["messages"] });
    expect(report.ok).toBe(false);
    expect(report.messages.schemaParity).toBe("ok");
    expect(report.messages.malformed).toEqual([
      expect.objectContaining({
        message_id: "msg_structurally_invalid_snapshot",
        code: "invalid-receipt-snapshot",
      }),
    ]);
    expect(report.domains?.find((domain) => domain.domain === "messages")).toMatchObject({
      status: "drift",
      findings: [expect.objectContaining({ code: "messages-invalid-receipt-snapshot" })],
    });
  });

  test("message doctor and receipt drain reject a structurally valid forged immutable snapshot", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_forged_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "authoritative subject",
        payload: { authority: "source-row" },
        now: "2026-07-14T06:35:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
         SET receipt_snapshot_json = ?
         WHERE message_id = ?`,
      ).run(JSON.stringify({
        ...message,
        subject: "forged subject",
        payload: { authority: "forged-snapshot" },
      }), message.message_id);

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        last_error_code: "receipt_snapshot_invalid",
        last_error_message: expect.stringContaining("subject does not match"),
      });
    } finally {
      opened.db.close();
    }

    await expect(runStateDoctor({ domains: ["messages"] })).resolves.toMatchObject({
      ok: false,
      messages: {
        malformed: [expect.objectContaining({
          message_id: "msg_forged_snapshot",
          code: "invalid-receipt-snapshot",
          detail: expect.stringContaining("subject does not match"),
        })],
      },
    });
  });

  test("message doctor and receipt drain reject forged lifecycle-only admission evidence", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_forged_lifecycle_snapshot",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "lifecycle remains pending",
        now: "2026-07-14T06:37:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      opened.db.prepare(
        `UPDATE message_receipt_mirrors
         SET receipt_snapshot_json = ?
         WHERE message_id = ?`,
      ).run(JSON.stringify({
        ...message,
        status: "acked",
        updated_at: "2026-07-14T06:38:00.000Z",
        acked_at: "2026-07-14T06:38:00.000Z",
        acked_by: "operator:forged",
      }), message.message_id);

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        last_error_code: "receipt_snapshot_invalid",
        last_error_message: expect.stringContaining("admission snapshot status"),
      });
    } finally {
      opened.db.close();
    }

    await expect(runStateDoctor({ domains: ["messages"] })).resolves.toMatchObject({
      ok: false,
      messages: {
        malformed: [expect.objectContaining({
          message_id: "msg_forged_lifecycle_snapshot",
          code: "invalid-receipt-snapshot",
          detail: expect.stringContaining("admission snapshot status"),
        })],
      },
    });
  });

  test("0027 refuses to launder a structurally valid forged snapshot from current message state", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-invalid-snapshot-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const createdProvenance = {
        schema_version: "calyx.provenance/v1" as const,
        request_id: "req_00000000-0000-4000-8000-000000000011",
        subject: "switchboard",
        asserted_actor: "operator:caleb",
        host: "blade",
        via: "http" as const,
        at: "2026-07-14T06:40:00.000Z",
      };
      const ingressProvenance = {
        schema_version: "calyx.provenance/v1" as const,
        request_id: "req_00000000-0000-4000-8000-000000000012",
        subject: "calyx_internal",
        asserted_actor: "run:forwarder",
        host: "worm",
        via: "http" as const,
        at: "2026-07-14T06:40:01.000Z",
      };
      const message = createMessage(before.db, {
        message_id: "msg_0027_structural_repair",
        sender: "client:switchboard@blade",
        recipient_address: "role:reviewer@worm",
        recipient_class: "directed",
        recipient_host: "worm",
        subject: "preserve provenance while repairing",
        created_provenance: createdProvenance,
        ingress_provenance: ingressProvenance,
        now: "2026-07-14T06:40:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.prepare(
        `UPDATE message_receipt_mirrors
         SET receipt_snapshot_json = ?
         WHERE message_id = ?`,
      ).run(JSON.stringify({
        ...message,
        status: "acked",
        updated_at: "2026-07-14T06:41:00.000Z",
        acked_at: "2026-07-14T06:41:00.000Z",
        acked_by: "operator:forged",
      }), message.message_id);
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(
        /cannot establish an authentic immutable receipt snapshot.*admission snapshot status/u,
      );
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
      const snapshot = JSON.parse((after.db.prepare(
        `SELECT receipt_snapshot_json
         FROM message_receipt_mirrors
         WHERE message_id = ?`,
      ).get("msg_0027_structural_repair") as { receipt_snapshot_json: string }).receipt_snapshot_json) as unknown;
      expect(snapshot).toMatchObject({
        message_id: "msg_0027_structural_repair",
        status: "acked",
        acked_by: "operator:forged",
      });
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses to fabricate provenance from malformed non-null legacy JSON", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-malformed-provenance-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_bad_provenance",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not erase malformed provenance",
        now: "2026-07-14T06:50:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.prepare(
        `UPDATE messages SET created_provenance_json = '[]' WHERE message_id = ?`,
      ).run(message.message_id);
      before.db.prepare(
        `UPDATE message_receipt_mirrors SET receipt_snapshot_json = '{}' WHERE message_id = ?`,
      ).run(message.message_id);
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/cannot reconstruct an honest receipt snapshot from malformed provenance/);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0026");
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses to fabricate payload from malformed legacy JSON", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-malformed-payload-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_bad_payload",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not erase malformed payload",
        now: "2026-07-14T06:55:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.prepare(`UPDATE messages SET payload_json = '{' WHERE message_id = ?`)
        .run(message.message_id);
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/cannot reconstruct an honest receipt snapshot from malformed payload/);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0026");
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses raw SQLite boolean domains that hydration would coerce", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-malformed-source-domain-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_bad_raw_boolean",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not coerce malformed raw domains",
        now: "2026-07-14T06:56:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.prepare(
        `UPDATE messages SET ack_required = 2, dead_letter = 2 WHERE message_id = ?`,
      ).run(message.message_id);
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/authoritative message source.*ack_required must be the SQLite integer 0 or 1/u);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0026");
      expect(after.db.prepare(
        `SELECT ack_required, dead_letter FROM messages WHERE message_id = ?`,
      ).get("msg_0027_bad_raw_boolean")).toEqual({ ack_required: 2, dead_letter: 2 });
    } finally {
      after.db.close();
    }
  });

  test("0027 rejects affinity-coerced numeric mirror keys before rebuilding the identity constraint", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-numeric-receipt-key-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "1",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "numeric affinity is not identity",
        now: "2026-07-14T06:56:30.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.exec(`
        ALTER TABLE message_receipt_mirrors RENAME TO receipt_mirrors_text_key;
        CREATE TABLE message_receipt_mirrors (
          message_id INTEGER,
          receipt_snapshot_json TEXT,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO message_receipt_mirrors
          SELECT CAST(message_id AS INTEGER), receipt_snapshot_json, status,
                 attempt_count, next_attempt_at, last_attempt_at, completed_at,
                 receipt_path, last_error_code, last_error_message, created_at,
                 updated_at
            FROM receipt_mirrors_text_key;
        DROP TABLE receipt_mirrors_text_key;
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      expect(before.db.prepare(
        "SELECT message_id, typeof(message_id) AS storage FROM message_receipt_mirrors",
      ).get()).toEqual({ message_id: 1, storage: "integer" });
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/invalid raw receipt-mirror message id for 1/u);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses chronologically impossible reducer state", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-impossible-chronology-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_impossible_chronology",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "migration must preserve time law",
        now: "2026-07-14T06:56:40.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id, message.created_at);
      before.db.exec("PRAGMA ignore_check_constraints = ON");
      before.db.prepare(
        `UPDATE message_receipt_mirrors
            SET attempt_count = 1,
                last_attempt_at = '2026-07-14T06:56:39.000Z',
                updated_at = '2026-07-14T06:56:39.000Z'
          WHERE message_id = ?`,
      ).run(message.message_id);
      before.db.exec("PRAGMA ignore_check_constraints = OFF");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/invalid receipt-mirror control state.*updated_at cannot precede created_at/u);
  });

  test("0027 refuses an attempted pending mirror whose retry precedes its last attempt", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-retry-before-attempt-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_retry_before_attempt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "migration preserves retry chronology",
        now: "2026-07-14T06:56:45.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id, message.created_at);
      before.db.exec("PRAGMA ignore_check_constraints = ON");
      before.db.prepare(
        `UPDATE message_receipt_mirrors
            SET attempt_count = 1,
                last_attempt_at = '2026-07-14T06:56:47.000Z',
                next_attempt_at = '2026-07-14T06:56:46.000Z',
                updated_at = '2026-07-14T06:56:47.000Z'
          WHERE message_id = ?`,
      ).run(message.message_id);
      before.db.exec("PRAGMA ignore_check_constraints = OFF");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/invalid receipt-mirror control state.*next_attempt_at cannot precede last_attempt_at/u);
  });

  test("0027 refuses false completed receipt control and rolls back untouched", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-invalid-control-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_bad_control",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not strand invalid control state",
        now: "2026-07-14T06:57:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      before.db.exec("PRAGMA ignore_check_constraints = ON");
      before.db.prepare(
        `UPDATE message_receipt_mirrors
         SET status = 'completed', attempt_count = 0, next_attempt_at = NULL,
             last_attempt_at = NULL, completed_at = NULL, receipt_path = NULL
         WHERE message_id = ?`,
      ).run(message.message_id);
      before.db.exec("PRAGMA ignore_check_constraints = OFF");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/cannot preserve invalid receipt-mirror control state.*at least one recorded attempt/u);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0026");
      expect(after.db.prepare(
        `SELECT status, attempt_count, completed_at, receipt_path
           FROM message_receipt_mirrors WHERE message_id = ?`,
      ).get("msg_0027_bad_control")).toEqual({
        status: "completed",
        attempt_count: 0,
        completed_at: null,
        receipt_path: null,
      });
    } finally {
      after.db.close();
    }

    const diagnosed = await openStateStore(upgradeOptions);
    try {
      expect(listMalformedMessageReceiptSnapshots(diagnosed.db)).toEqual([
        expect.objectContaining({
          message_id: "msg_0027_bad_control",
          code: "invalid-receipt-control",
          detail: expect.stringContaining("at least one recorded attempt"),
        }),
      ]);
    } finally {
      diagnosed.db.close();
    }
  });

  test("0027 refuses completed metadata whose JSONL evidence is not the stored snapshot", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-forged-receipt-evidence-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    let receiptPath: string;
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_forged_file_evidence",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "authoritative receipt evidence",
        now: "2026-07-14T06:57:30.000Z",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id, message.created_at);
      await expect(drainMessageReceiptMirrors(before.db, before.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      receiptPath = readMessageReceiptMirror(before.db, message.message_id)!.receipt_path!;
      const envelope = JSON.parse((await readFile(receiptPath, "utf8")).trim()) as {
        schema_version: string;
        message: Record<string, unknown>;
      };
      await writeFile(receiptPath, `${JSON.stringify({
        ...envelope,
        message: { ...envelope.message, subject: "forged file evidence" },
      })}\n`, "utf8");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/completed receipt mirror.*conflicting envelope/u);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
    } finally {
      after.db.close();
    }
  });

  test("0027 pages a multi-page completed estate through bounded external evidence indexes", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-bounded-evidence-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const receiptPath = join(before.paths.stateDir, "receipts", "messages.jsonl");
      const readSnapshot = before.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      );
      const setMessagePath = before.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      );
      const completeMirror = before.db.prepare(
        `UPDATE message_receipt_mirrors
            SET status = 'completed', attempt_count = 1, next_attempt_at = NULL,
                last_attempt_at = ?, completed_at = ?, receipt_path = ?, updated_at = ?
          WHERE message_id = ?`,
      );
      const envelopes: string[] = [];
      before.db.exec("BEGIN");
      try {
        for (let index = 0; index < 300; index += 1) {
          const messageId = `msg_0027_bounded_${String(index).padStart(3, "0")}`;
          const message = createMessage(before.db, {
            message_id: messageId,
            sender: "client:sender@blade",
            recipient_address: "role:reviewer@blade",
            recipient_class: "directed",
            subject: "bounded migration estate",
            now: "2026-07-14T07:10:00.000Z",
          }).message;
          enqueueMessageReceiptMirror(before.db, messageId, message.created_at);
          const snapshotJson = (readSnapshot.get(messageId) as { receipt_snapshot_json: string })
            .receipt_snapshot_json;
          const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
          envelopes.push(serializeCanonicalMessageReceiptEnvelope(snapshot, receiptPath));
          setMessagePath.run(receiptPath, messageId);
          completeMirror.run(
            message.created_at,
            message.created_at,
            receiptPath,
            message.created_at,
            messageId,
          );
        }
        before.db.exec("COMMIT");
      } catch (error) {
        before.db.exec("ROLLBACK");
        throw error;
      }
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${envelopes.join("\n")}\n`, "utf8");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions })).resolves.toBeDefined();
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0035");
      expect((after.db.prepare(
        "SELECT COUNT(*) AS count FROM message_receipt_mirrors",
      ).get() as { count: number | bigint }).count).toBe(300);
      expect(after.db.prepare(
        `SELECT name FROM sqlite_temp_master
          WHERE name LIKE 'calyx_migration_0027_%'`,
      ).all()).toEqual([]);
    } finally {
      after.db.close();
    }
  });

  test.each([
    { kind: "invalid_utf8", expected: /invalid UTF-8/u },
    { kind: "duplicate_key", expected: /not exact canonical JSON/u },
    { kind: "noncanonical_order", expected: /not exact canonical JSON/u },
    { kind: "blank_line", expected: /blank line/u },
    { kind: "incomplete_ghost", expected: /unterminated line/u },
  ] as const)("0027 rejects strict completed journal corruption: $kind", async ({ kind, expected }) => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, `upgrade-strict-${kind}-0027`) },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: `msg_0027_strict_${kind}`,
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "migration proves exact journal bytes",
      }).message;
      enqueueMessageReceiptMirror(before.db, message.message_id);
      await expect(drainMessageReceiptMirrors(before.db, before.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      const receiptPath = readMessageReceiptMirror(before.db, message.message_id)!.receipt_path!;
      const canonicalLine = (await readFile(receiptPath, "utf8")).trimEnd();
      await writeFile(receiptPath, corruptReceiptHistory(kind, canonicalLine));
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions })).rejects.toThrow(expected);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses a populated legacy mirror table without authentic admission snapshots", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-pre-snapshot-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      expect((before.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
      before.db.exec(`
        DROP TABLE message_receipt_mirrors;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      const message = createMessage(before.db, {
        message_id: "msg_0027_pre_snapshot_table",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "repair the real legacy table",
      }).message;
      before.db.prepare(
        `INSERT INTO message_receipt_mirrors (
           message_id, status, attempt_count, next_attempt_at, created_at, updated_at
         ) VALUES (?, 'pending', 0, ?, ?, ?)`,
      ).run(message.message_id, message.created_at, message.created_at, message.updated_at);
      expect((before.db.prepare(
        "PRAGMA table_info(message_receipt_mirrors)",
      ).all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain("receipt_snapshot_json");
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/cannot establish an authentic immutable receipt snapshot/);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0026");
      expect((after.db.prepare(
        "PRAGMA table_info(message_receipt_mirrors)",
      ).all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain("receipt_snapshot_json");
      expect(after.db.prepare(
        "SELECT message_id, status FROM message_receipt_mirrors WHERE message_id = ?",
      ).get("msg_0027_pre_snapshot_table")).toEqual({
        message_id: "msg_0027_pre_snapshot_table",
        status: "pending",
      });
    } finally {
      after.db.close();
    }
  });

  test("0027 refuses NULL-key and orphan mirror rows instead of omitting them from validation", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-orphan-mirror-0027") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0026"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      const message = createMessage(before.db, {
        message_id: "msg_0027_orphan_snapshot_body",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "NULL row keys are not evidence",
        now: "2026-07-14T06:58:00.000Z",
      }).message;
      before.db.exec(`
        DROP TABLE message_receipt_mirrors;
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          receipt_snapshot_json TEXT,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      before.db.prepare(
        `INSERT INTO message_receipt_mirrors (
           message_id, receipt_snapshot_json, status, attempt_count,
           next_attempt_at, created_at, updated_at
         ) VALUES (NULL, ?, 'pending', 0, ?, ?, ?)`,
      ).run(JSON.stringify(message), message.created_at, message.created_at, message.updated_at);
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/without a non-null authoritative message id: NULL/u);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      ).get() as { id: string }).id).toBe("0026");
      expect((after.db.prepare(
        `SELECT COUNT(*) AS count FROM message_receipt_mirrors WHERE message_id IS NULL`,
      ).get() as { count: number }).count).toBe(1);
      expect((after.db.prepare(
        `PRAGMA table_info(message_receipt_mirrors)`,
      ).all() as Array<{ name: string; notnull: number }>).find(({ name }) => name === "message_id"))
        .toMatchObject({ notnull: 0 });
    } finally {
      after.db.close();
    }
  });

  test("0022 refuses to invent immutable snapshots for populated interim mirror tables", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-from-0021") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0020"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      before.db.exec(`
        CREATE TABLE message_receipt_mirrors (
          message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_attempt_at TEXT,
          completed_at TEXT,
          receipt_path TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_message_receipt_mirrors_pending
          ON message_receipt_mirrors(status, next_attempt_at, created_at);
      `);
      const interimMigration = STATE_MIGRATIONS.find((migration) => migration.id === "0021")!;
      before.db.prepare(
        `INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)`,
      ).run(interimMigration.id, interimMigration.description, "2026-07-14T00:00:00.000Z");
      expect((before.db.prepare("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1").get() as { id: string }).id)
        .toBe("0021");
      expect((before.db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain("asserted_actor");
      const insertLegacy = before.db.prepare(
        `INSERT INTO messages
           (message_id, schema_version, sender, recipient_address, recipient_class,
            subject, body, urgency, ack_required, status, created_at, updated_at,
            spooled_at, payload_json)
         VALUES (?, 'calyx.message/v1', 'client:sender@blade', 'role:reviewer@blade',
                 'directed', ?, '', 'normal', 0, 'pending', ?, ?, ?, ?)`,
      );
      insertLegacy.run(
        "msg_legacy_marked",
        "marked legacy mirror",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
        JSON.stringify({
          receipt_mirror: {
            status: "pending",
            attempt_count: 3,
            attempted_at: "2026-07-13T23:58:00.000Z",
            last_error: "disk full",
          },
        }),
      );
      insertLegacy.run(
        "msg_legacy_unmarked",
        "unmarked crash window",
        "2026-07-14T00:01:00.000Z",
        "2026-07-14T00:01:00.000Z",
        "2026-07-14T00:01:00.000Z",
        "{}",
      );
      insertLegacy.run(
        "msg_legacy_completed",
        "completed interim mirror",
        "2026-07-14T00:02:00.000Z",
        "2026-07-14T00:02:00.000Z",
        "2026-07-14T00:02:00.000Z",
        "{}",
      );
      before.db.prepare(
        `UPDATE messages SET receipt_path = ? WHERE message_id = ?`,
      ).run("/legacy/receipts/messages.jsonl", "msg_legacy_completed");
      before.db.prepare(
        `INSERT INTO message_receipt_mirrors (
           message_id, status, attempt_count, next_attempt_at, last_attempt_at,
           completed_at, receipt_path, created_at, updated_at
         ) VALUES (?, 'completed', 1, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        "msg_legacy_completed",
        "2026-07-14T00:02:00.000Z",
        "2026-07-14T00:02:00.000Z",
        "/legacy/receipts/messages.jsonl",
        "2026-07-14T00:02:00.000Z",
        "2026-07-14T00:02:00.000Z",
      );
      before.db.prepare(
        `INSERT INTO api_idempotency
           (subject, operation_id, idempotency_key, request_hash, canonicalizer,
            schema_major, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "switchboard",
        "msg.send",
        "legacy-binding",
        hashCanonicalJcs({ subject: "legacy" }),
        "jcs-rfc8785/v1",
        1,
        200,
        JSON.stringify({ schema_version: "calyx.msg-send-result/v1" }),
        "2026-07-14T00:00:00.000Z",
      );
    } finally {
      before.db.close();
    }

    await expect(applyStateMigrations({ storeOptions: upgradeOptions }))
      .rejects.toThrow(/cannot establish authentic immutable receipt snapshots for 1 legacy mirror row/);
    const after = await openStateStore(upgradeOptions);
    try {
      expect((after.db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain("asserted_actor");
      expect((after.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0021");
      expect((after.db.prepare(
        "PRAGMA table_info(message_receipt_mirrors)",
      ).all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain("receipt_snapshot_json");
      expect(after.db.prepare(
        "SELECT message_id, status, attempt_count FROM message_receipt_mirrors",
      ).all()).toEqual([{
        message_id: "msg_legacy_completed",
        status: "completed",
        attempt_count: 1,
      }]);
    } finally {
      after.db.close();
    }
  });

  test("0028 versions message semantic identity while leaving unrecoverable legacy wire identity unset", async () => {
    const upgradeOptions = {
      env: { ...process.env, CALYX_STATE_HOME: join(root, "upgrade-api-idempotency-0028") },
    };
    await applyStateMigrations({
      storeOptions: upgradeOptions,
      migrations: STATE_MIGRATIONS.filter((migration) => migration.id <= "0027"),
    });
    const before = await openStateStore(upgradeOptions);
    try {
      expect((before.db.prepare("PRAGMA table_info(api_idempotency)").all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toEqual(expect.arrayContaining(["wire_request_hash", "semantic_canonicalizer"]));
      before.db.prepare(
        `INSERT INTO api_idempotency (
           subject, operation_id, idempotency_key, request_hash, canonicalizer,
           schema_major, response_status, response_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "switchboard",
        "msg.send",
        "legacy-semantic-binding",
        hashCanonicalJcs({ recipient_address: "role:reviewer@blade" }),
        "jcs-rfc8785/v1",
        1,
        200,
        JSON.stringify({ schema_version: "calyx.msg-send-result/v1" }),
        "2026-07-14T00:00:00.000Z",
      );
    } finally {
      before.db.close();
    }

    await applyStateMigrations({ storeOptions: upgradeOptions });
    const after = await openStateStore(upgradeOptions);
    try {
      expect(checkMessageSchema(after.db)).toEqual({ status: "ok", findings: [] });
      expect(after.db.prepare(
        `SELECT wire_request_hash, semantic_canonicalizer
           FROM api_idempotency
          WHERE subject = ? AND operation_id = ? AND idempotency_key = ?`,
      ).get("switchboard", "msg.send", "legacy-semantic-binding")).toEqual({
        wire_request_hash: null,
        semantic_canonicalizer: MSG_SEND_SEMANTIC_CANONICALIZER,
      });
    } finally {
      after.db.close();
    }
  });

  test("JCS request hashes are key-order stable and idempotency rows bind subject, operation, and schema", async () => {
    expect(hashCanonicalJcs({ z: 1, nested: { b: true, a: "x" } })).toBe(
      hashCanonicalJcs({ nested: { a: "x", b: true }, z: 1 }),
    );
    expect(hashCanonicalJcs({ body: "first" })).not.toBe(hashCanonicalJcs({ body: "second" }));

    const opened = await openStateStore();
    try {
      const requestHash = hashCanonicalJcs({ recipient_address: "role:reviewer@blade", subject: "review" });
      const wireRequestHash = hashCanonicalJcs({ recipient_address: "role:reviewer@blade.internal", subject: "review" });
      const provenance = {
        schema_version: "calyx.provenance/v1" as const,
        request_id: "req_00000000-0000-4000-8000-000000000001",
        subject: "switchboard",
        asserted_actor: "operator:caleb",
        host: "blade",
        via: "http" as const,
        at: "2026-06-12T00:00:00.000Z",
      };
      recordApiIdempotency(opened.db, {
        subject: "switchboard",
        operation_id: "msg.send",
        idempotency_key: "send-1",
        asserted_actor: "operator:caleb",
        first_request_provenance: provenance,
        wire_request_hash: wireRequestHash,
        request_hash: requestHash,
        semantic_canonicalizer: MSG_SEND_SEMANTIC_CANONICALIZER,
        response_status: 200,
        response: { schema_version: "calyx.msg-send-result/v1", message_id: "msg_1" },
        created_at: "2026-06-12T00:00:00.000Z",
      });
      expect(readApiIdempotency(opened.db, "switchboard", "msg.send", "send-1")).toMatchObject({
        asserted_actor: "operator:caleb",
        first_request_id: provenance.request_id,
        first_request_provenance: provenance,
        wire_request_hash: wireRequestHash,
        request_hash: requestHash,
        canonicalizer: "jcs-rfc8785/v1",
        schema_major: 1,
        semantic_canonicalizer: MSG_SEND_SEMANTIC_CANONICALIZER,
        response_status: 200,
        response: { message_id: "msg_1" },
      });
      expect(readApiIdempotency(opened.db, " switchboard ", " msg.send ", " send-1 "))
        .toMatchObject({ idempotency_key: "send-1" });
      expect(readApiIdempotency(opened.db, "operator_cli", "msg.send", "send-1")).toBeUndefined();
    } finally {
      opened.db.close();
    }
  });

  test("RFC 8785 canonicalization matches the serialization and UTF-16 ordering corpus", () => {
    expect(canonicalizeJcs({
      numbers: [Number("333333333.33333329"), 1e30, 4.50, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    })).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
    expect(canonicalizeJcs({
      "\r": "Carriage Return",
      "1": "One",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
      "€": "Euro Sign",
      "😀": "Emoji",
      "דּ": "Hebrew Letter Dalet With Dagesh",
    })).toBe(
      "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
    );
    expect(canonicalizeJcs({ negative_zero: -0, safe_integer: 9_007_199_254_740_991 }))
      .toBe("{\"negative_zero\":0,\"safe_integer\":9007199254740991}");
    expect(() => canonicalizeJcs({ number: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalizeJcs({ value: "\ud800" })).toThrow("lone Unicode surrogate");
    expect(() => canonicalizeJcs({ "\udc00": "value" })).toThrow("lone Unicode surrogate");
  });

  test("row grants filter before thread pagination, counts, and cursors", async () => {
    const opened = await openStateStore();
    try {
      const common = {
        recipient_class: "directed" as const,
        thread_key: "mixed-thread",
        now: "2026-06-12T00:00:00.000Z",
      };
      createMessage(opened.db, {
        ...common,
        message_id: "msg_unauthorized_first",
        sender: "role:outsider@blade",
        recipient_address: "role:secret@blade",
        subject: "must not affect page",
      });
      createMessage(opened.db, {
        ...common,
        message_id: "msg_authorized_recipient",
        sender: "role:outsider@blade",
        recipient_address: "role:reviewer@blade",
        subject: "authorized recipient",
      });
      createMessage(opened.db, {
        ...common,
        message_id: "msg_authorized_sender",
        sender: "client:switchboard@blade",
        recipient_address: "role:secret@blade",
        subject: "authorized sender",
      });

      const first = listAuthorizedMessages(opened.db, {
        cursor_context: "test:inbox",
        read_grants: ["role:reviewer@blade"],
        send_as_grants: ["client:switchboard@blade"],
        thread_key: "mixed-thread",
        status: "all",
        now: "2026-06-12T00:00:01.000Z",
        limit: 1,
      });
      expect(first.messages.map((message) => message.message_id)).toEqual(["msg_authorized_recipient"]);
      expect(first.truncated).toBe(true);
      expect(first.next_cursor).toBeTruthy();

      const second = listAuthorizedMessages(opened.db, {
        cursor_context: "test:inbox",
        read_grants: ["role:reviewer@blade"],
        send_as_grants: ["client:switchboard@blade"],
        thread_key: "mixed-thread",
        status: "all",
        now: "2026-06-12T00:00:01.000Z",
        limit: 1,
        cursor: first.next_cursor,
      });
      expect(second.messages.map((message) => message.message_id)).toEqual(["msg_authorized_sender"]);
      expect(second.truncated).toBe(false);
      expect(countAuthorizedMessages(opened.db, {
        read_grants: ["role:reviewer@blade"],
        send_as_grants: ["client:switchboard@blade"],
        now: "2026-06-12T00:00:01.000Z",
      })).toMatchObject({ total: 2, open: 2, pending: 2 });
    } finally {
      opened.db.close();
    }
  });

  test("one-kind wildcard grants stay anchored to the canonical address prefix", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_literal_prefix",
        sender: "client:switchboard@blade",
        recipient_address: "role:secret@blade",
        recipient_class: "directed",
        subject: "authorized",
        now: "2026-06-12T00:00:00.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_sql_wildcard_escape",
        sender: "clientXimpostor@blade",
        recipient_address: "role:secret@blade",
        recipient_class: "directed",
        subject: "must stay hidden",
        now: "2026-06-12T00:00:01.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_ascii_case_fold",
        sender: "CLIENT:secret@blade",
        recipient_address: "role:secret@blade",
        recipient_class: "directed",
        subject: "legacy noncanonical rows must stay hidden",
        now: "2026-06-12T00:00:01.500Z",
      });

      const visible = listAuthorizedMessages(opened.db, {
        cursor_context: "test:visible",
        read_grants: [],
        send_as_grants: ["client:*"],
        status: "all",
        now: "2026-06-12T00:00:02.000Z",
      });
      expect(visible.messages.map((message) => message.message_id)).toEqual([
        "msg_literal_prefix",
      ]);
      expect(countAuthorizedMessages(opened.db, {
        read_grants: [],
        send_as_grants: ["client:*"],
        now: "2026-06-12T00:00:02.000Z",
      }).total).toBe(1);
      expect(readAuthorizedMessage(opened.db, "msg_ascii_case_fold", {
        read_grants: [],
        send_as_grants: ["client:*"],
        now: "2026-06-12T00:00:02.000Z",
      })).toBeUndefined();
    } finally {
      opened.db.close();
    }
  });

  test("directed messages claim, ack, and dead-letter after repeated expired claims", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_directed_1",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:target",
        recipient_class: "directed",
        subject: "baton",
        body: "handoff body",
        now: "2026-06-12T00:00:00.000Z",
      });

      const claimed = claimDirectedMessages(opened.db, {
        recipient_address: "interactive:codex:target",
        claimed_by: "interactive:codex:target",
        claim_ttl_ms: 1000,
        now: "2026-06-12T00:00:01.000Z",
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ message_id: "msg_directed_1", status: "claimed" });

      const acked = ackMessage(opened.db, "msg_directed_1", {
        acked_by: "interactive:codex:target",
        acked_at: "2026-06-12T00:00:02.000Z",
      });
      expect(acked.changed).toBe(true);
      expect(acked.message).toMatchObject({ status: "acked", acked_by: "interactive:codex:target" });

      createMessage(opened.db, {
        message_id: "msg_directed_2",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:target",
        recipient_class: "directed",
        subject: "ask",
        now: "2026-06-12T00:01:00.000Z",
      });
      for (let cycle = 0; cycle < 3; cycle += 1) {
        claimDirectedMessages(opened.db, {
          recipient_address: "interactive:codex:target",
          claimed_by: "interactive:codex:target",
          claim_ttl_ms: 1000,
          now: `2026-06-12T00:01:0${cycle}.000Z`,
        });
        expireDirectedClaims(opened.db, {
          recipient_address: "interactive:codex:target",
          now: `2026-06-12T00:01:1${cycle}.000Z`,
        });
      }
      expect(readMessage(opened.db, "msg_directed_2")).toMatchObject({
        status: "dead_letter",
        dead_letter_reason: "expired_claim",
        expired_claim_cycles: 3,
      });
    } finally {
      opened.db.close();
    }
  });

  test("claiming a mixed inbox returns already claimed and newly claimed rows", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_claimed_existing",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:target",
        recipient_class: "directed",
        subject: "first",
        urgency: "high",
        now: "2026-06-12T00:00:00.000Z",
      });
      claimDirectedMessages(opened.db, {
        recipient_address: "interactive:codex:target",
        claimed_by: "interactive:codex:target",
        claim_ttl_ms: 60_000,
        now: "2026-06-12T00:00:01.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_claimed_new",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:target",
        recipient_class: "directed",
        subject: "second",
        urgency: "normal",
        now: "2026-06-12T00:00:02.000Z",
      });

      const rows = claimDirectedMessages(opened.db, {
        recipient_address: "interactive:codex:target",
        claimed_by: "interactive:codex:target",
        claim_ttl_ms: 60_000,
        now: "2026-06-12T00:00:03.000Z",
      });

      expect(rows.map((row) => row.message_id)).toEqual([
        "msg_claimed_existing",
        "msg_claimed_new",
      ]);
      expect(rows.map((row) => row.status)).toEqual(["claimed", "claimed"]);
      expect(rows[0]).toMatchObject({
        claimed_until: "2026-06-12T00:01:01.000Z",
      });
      expect(rows[1]).toMatchObject({
        claimed_until: "2026-06-12T00:01:03.000Z",
      });
    } finally {
      opened.db.close();
    }
  });

  test("claiming a shared queue excludes rows claimed by another worker", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_other_claim",
        sender: "interactive:codex:sender",
        recipient_address: "role:conductor@blade",
        recipient_class: "directed",
        subject: "other worker",
        urgency: "high",
        now: "2026-06-12T00:00:00.000Z",
      });
      claimDirectedMessages(opened.db, {
        recipient_address: "role:conductor@blade",
        claimed_by: "interactive:codex:worker-a",
        claim_ttl_ms: 60_000,
        now: "2026-06-12T00:00:01.000Z",
      });
      createMessage(opened.db, {
        message_id: "msg_self_claim",
        sender: "interactive:codex:sender",
        recipient_address: "role:conductor@blade",
        recipient_class: "directed",
        subject: "self worker",
        urgency: "normal",
        now: "2026-06-12T00:00:02.000Z",
      });

      const claimed = claimDirectedMessages(opened.db, {
        recipient_address: "role:conductor@blade",
        claimed_by: "interactive:codex:worker-b",
        claim_ttl_ms: 60_000,
        now: "2026-06-12T00:00:03.000Z",
      });
      expect(claimed.map((row) => row.message_id)).toEqual(["msg_self_claim"]);
      expect(claimed[0]).toMatchObject({
        status: "claimed",
        claimed_by: "interactive:codex:worker-b",
      });

      const peeked = claimDirectedMessages(opened.db, {
        recipient_address: "role:conductor@blade",
        claimed_by: "interactive:codex:worker-b",
        now: "2026-06-12T00:00:04.000Z",
        peek: true,
      });
      expect(peeked.map((row) => row.message_id)).toEqual([
        "msg_other_claim",
        "msg_self_claim",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("scope bulletins require TTL and are peek-only while outbox rows expire separately", async () => {
    const opened = await openStateStore();
    try {
      expect(() => createMessage(opened.db, {
        sender: "interactive:codex:sender",
        recipient_address: "host:blade",
        recipient_class: "scope",
        subject: "heads-up",
      })).toThrow(/scope messages require expires_at/);

      const scope = createMessage(opened.db, {
        message_id: "msg_scope_1",
        sender: "interactive:codex:sender",
        recipient_address: "host:blade",
        recipient_class: "scope",
        recipient_host: "blade",
        subject: "heads-up",
        expires_at: "2026-06-12T01:00:00.000Z",
        now: "2026-06-12T00:00:00.000Z",
      }).message;
      expect(peekScopeMessages(opened.db, "host:blade", {
        now: "2026-06-12T00:30:00.000Z",
      })).toEqual([scope]);
      expect(peekScopeMessages(opened.db, "host:blade", {
        now: "2026-06-12T01:30:00.000Z",
      })).toEqual([]);

      createMessage(opened.db, {
        message_id: "msg_outbox_1",
        sender: "interactive:codex:sender",
        recipient_address: "interactive:codex:remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "remote baton",
        status: "outbox",
        now: "2026-06-12T00:00:00.000Z",
      });
      enqueueMessageOutbox(opened.db, {
        message_id: "msg_outbox_1",
        target_host: "remote",
        expires_at: "2026-06-12T00:00:10.000Z",
        now: "2026-06-12T00:00:00.000Z",
      });
      const expired = expireMessageOutbox(opened.db, { now: "2026-06-12T00:00:11.000Z" });
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({ status: "delivery_failed", last_error_code: "outbox_expired" });
      expect(readMessage(opened.db, "msg_outbox_1")).toMatchObject({ status: "delivery_failed" });
    } finally {
      opened.db.close();
    }
  });

  test("fences concurrent outbox attempts and retries only an unexpired crashed lease", async () => {
    const first = await openStateStore();
    const second = await openStateStore();
    try {
      createMessage(first.db, {
        message_id: "msg_outbox_fenced_retry",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "one transport owner",
        status: "outbox",
        now: "2026-07-14T02:00:00.000Z",
      });
      const outbox = enqueueMessageOutbox(first.db, {
        message_id: "msg_outbox_fenced_retry",
        target_host: "remote",
        expires_at: "2026-07-14T02:05:00.000Z",
        now: "2026-07-14T02:00:00.000Z",
      });

      const firstAttempt = claimMessageOutboxAttempt(first.db, outbox.outbox_id, {
        attempt_id: "attempt-a",
        attempt_ttl_ms: 10_000,
        now: "2026-07-14T02:00:01.000Z",
      });
      expect(firstAttempt).toMatchObject({
        status: "in_flight",
        attempt_id: "attempt-a",
        attempt_count: 1,
        attempt_expires_at: "2026-07-14T02:00:11.000Z",
      });
      expect(claimMessageOutboxAttempt(second.db, outbox.outbox_id, {
        attempt_id: "attempt-b-lost",
        now: "2026-07-14T02:00:01.000Z",
      })).toBeUndefined();

      expect(recoverExpiredMessageOutboxAttempts(second.db, {
        now: "2026-07-14T02:00:12.000Z",
      })).toEqual([
        expect.objectContaining({
          status: "pending",
          attempt_id: null,
          last_error_code: "outbox_attempt_lease_expired",
        }),
      ]);
      const secondAttempt = claimMessageOutboxAttempt(second.db, outbox.outbox_id, {
        attempt_id: "attempt-b",
        now: "2026-07-14T02:00:13.000Z",
      });
      expect(secondAttempt).toMatchObject({ status: "in_flight", attempt_id: "attempt-b", attempt_count: 2 });

      // A late failure from the fenced-out attempt cannot release or fail the
      // current owner.
      markMessageOutboxAttemptFailed(first.db, outbox.outbox_id, {
        attempt_id: "attempt-a",
        outcome: "not_accepted",
        error_code: "late_timeout",
        now: "2026-07-14T02:00:14.000Z",
      });
      expect(readMessageOutbox(first.db, outbox.outbox_id)).toMatchObject({
        status: "in_flight",
        attempt_id: "attempt-b",
        attempt_count: 2,
      });
      expect(markMessageOutboxForwarded(second.db, outbox.outbox_id, {
        attempt_id: "attempt-b",
        now: "2026-07-14T02:00:15.000Z",
      })).toMatchObject({ status: "forwarded", attempt_id: null });
      markMessageOutboxAttemptFailed(first.db, outbox.outbox_id, {
        attempt_id: "attempt-a",
        outcome: "not_accepted",
        error_code: "even_later_timeout",
        now: "2026-07-14T02:00:16.000Z",
      });
      expect(readMessageOutbox(first.db, outbox.outbox_id)).toMatchObject({
        status: "forwarded",
        forwarded_at: "2026-07-14T02:00:15.000Z",
        last_error_code: null,
      });
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  test("keeps an expired in-flight result indeterminate and reconciles late target acceptance", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_outbox_late_acceptance",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "acceptance outranks local expiry",
        status: "outbox",
        now: "2026-07-14T03:00:00.000Z",
      });
      const outbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_outbox_late_acceptance",
        target_host: "remote",
        expires_at: "2026-07-14T03:00:05.000Z",
        now: "2026-07-14T03:00:00.000Z",
      });
      expect(claimMessageOutboxAttempt(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-slow",
        attempt_ttl_ms: 10_000,
        now: "2026-07-14T03:00:01.000Z",
      })).toMatchObject({ status: "in_flight" });

      // TTL expiry never terminalizes work that a transport attempt owns.
      expect(expireMessageOutbox(opened.db, { now: "2026-07-14T03:00:06.000Z" })).toEqual([]);
      expect(readMessageOutbox(opened.db, outbox.outbox_id)).toMatchObject({ status: "in_flight" });
      expect(readMessage(opened.db, "msg_outbox_late_acceptance")).toMatchObject({ status: "outbox" });

      // A daemon crash after target acceptance but before the local commit is
      // unknowable after both the attempt lease and forwarding TTL expire.
      expect(recoverExpiredMessageOutboxAttempts(opened.db, {
        now: "2026-07-14T03:00:12.000Z",
      })).toEqual([
        expect.objectContaining({
          status: "indeterminate",
          attempt_id: null,
          last_error_code: "outbox_attempt_result_unknown",
        }),
      ]);
      expect(readMessage(opened.db, "msg_outbox_late_acceptance")).toMatchObject({ status: "outbox" });

      // If the original request subsequently returns a positive receipt, its
      // fenced CAS misses and the positive evidence reconciles the projection.
      expect(markMessageOutboxForwarded(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-slow",
        now: "2026-07-14T03:00:13.000Z",
      })).toMatchObject({
        status: "forwarded",
        forwarded_at: "2026-07-14T03:00:13.000Z",
        attempt_id: null,
        last_error_code: null,
      });
      expect(expireMessageOutbox(opened.db, { now: "2026-07-14T03:01:00.000Z" })).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("persists acceptance ambiguity across retries and later explicit rejection", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_outbox_sticky_ambiguity",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "unknown acceptance stays sticky",
        status: "outbox",
        now: "2026-07-14T03:10:00.000Z",
      });
      const outbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_outbox_sticky_ambiguity",
        target_host: "remote",
        expires_at: "2026-07-14T03:15:00.000Z",
        now: "2026-07-14T03:10:00.000Z",
      });
      claimMessageOutboxAttempt(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-unknown",
        now: "2026-07-14T03:14:50.000Z",
      });
      expect(markMessageOutboxAttemptFailed(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-unknown",
        outcome: "unknown",
        error_code: "daemon_timeout",
        retry_after_ms: 1,
        now: "2026-07-14T03:14:59.000Z",
      })).toMatchObject({
        status: "pending",
        acceptance_ambiguous: true,
        last_error_code: "daemon_timeout",
      });

      claimMessageOutboxAttempt(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-rejected",
        now: "2026-07-14T03:14:59.002Z",
      });
      expect(markMessageOutboxAttemptFailed(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-rejected",
        outcome: "not_accepted",
        error_code: "http_409",
        now: "2026-07-14T03:14:59.500Z",
      })).toMatchObject({
        status: "pending",
        acceptance_ambiguous: true,
        last_error_code: "http_409",
      });

      expect(expireMessageOutbox(opened.db, {
        now: "2026-07-14T03:15:00.100Z",
      })).toEqual([
        expect.objectContaining({
          status: "indeterminate",
          acceptance_ambiguous: true,
          last_error_code: "outbox_acceptance_ambiguous",
        }),
      ]);
      expect(readMessage(opened.db, "msg_outbox_sticky_ambiguity")).toMatchObject({
        status: "outbox",
        dead_letter: false,
      });
    } finally {
      opened.db.close();
    }
  });

  test("late target acceptance repairs a stale definitive outbox and message failure", async () => {
    const opened = await openStateStore();
    try {
      createMessage(opened.db, {
        message_id: "msg_outbox_repair_false_failure",
        sender: "client:sender@blade",
        recipient_address: "client:target@remote",
        recipient_class: "directed",
        recipient_host: "remote",
        subject: "repair stale failure",
        status: "outbox",
        now: "2026-07-14T03:30:00.000Z",
      });
      const outbox = enqueueMessageOutbox(opened.db, {
        message_id: "msg_outbox_repair_false_failure",
        target_host: "remote",
        now: "2026-07-14T03:30:00.000Z",
      });
      claimMessageOutboxAttempt(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-accepted",
        now: "2026-07-14T03:30:01.000Z",
      });
      expect(markMessageOutboxDeliveryFailed(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-accepted",
        error_code: "outbox_expired",
        now: "2026-07-14T03:30:02.000Z",
      })).toMatchObject({ status: "delivery_failed" });
      expect(readMessage(opened.db, "msg_outbox_repair_false_failure")).toMatchObject({
        status: "delivery_failed",
        dead_letter: true,
        dead_letter_reason: "outbox_expired",
      });

      expect(markMessageOutboxForwarded(opened.db, outbox.outbox_id, {
        attempt_id: "attempt-accepted",
        now: "2026-07-14T03:30:03.000Z",
      })).toMatchObject({ status: "forwarded", last_error_code: null });
      expect(readMessage(opened.db, "msg_outbox_repair_false_failure")).toMatchObject({
        status: "outbox",
        dead_letter: false,
        dead_letter_reason: null,
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt mirror repairs partial tails and rejects same-id envelope conflicts", async () => {
    const opened = await openStateStore();
    try {
      const stateDir = opened.paths.stateDir;
      const receiptPath = join(stateDir, "receipts", "messages.jsonl");
      await mkdir(join(stateDir, "receipts"), { recursive: true });
      const first = createMessage(opened.db, {
        message_id: "msg_partial_tail",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "recover me",
      }).message;
      enqueueMessageReceiptMirror(opened.db, first.message_id);
      await writeFile(receiptPath, '{"schema_version":"calyx.message/v1","message":', "utf8");
      await expect(drainMessageReceiptMirrors(opened.db, stateDir, {
        message_id: first.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      const repairedLines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(repairedLines).toHaveLength(1);
      expect(JSON.parse(repairedLines[0]!) as unknown).toMatchObject({
        schema_version: "calyx.message/v1",
        message: { message_id: first.message_id, subject: "recover me" },
      });

      const second = createMessage(opened.db, {
        message_id: "msg_identity_conflict",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "authoritative body",
      }).message;
      enqueueMessageReceiptMirror(opened.db, second.message_id);
      await writeFile(receiptPath, `${JSON.stringify({
        schema_version: "calyx.message/v1",
        message: { ...second, subject: "forged body", receipt_path: receiptPath },
      })}\n`, "utf8");
      await expect(drainMessageReceiptMirrors(opened.db, stateDir, {
        message_id: second.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, second.message_id)).toMatchObject({
        status: "pending",
        attempt_count: 1,
        last_error_code: "receipt_identity_conflict",
      });
      expect((await readFile(receiptPath, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("the explicit canonical serializer preserves established pre-change receipt bytes", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_prechange_receipt_fixture",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "existing v1 bytes remain valid",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const preChangeLine = JSON.stringify({
        schema_version: "calyx.message/v1",
        message: { ...snapshot, receipt_path: receiptPath },
      });
      expect(serializeCanonicalMessageReceiptEnvelope(snapshot, receiptPath)).toBe(preChangeLine);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${preChangeLine}\n`, "utf8");

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      expect(await readFile(receiptPath, "utf8")).toBe(`${preChangeLine}\n`);
    } finally {
      opened.db.close();
    }
  });

  test.each([
    "invalid_utf8",
    "duplicate_key",
    "noncanonical_order",
    "blank_line",
  ] as const)("runtime append rejects noncanonical historical bytes: %s", async (kind) => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: `msg_runtime_strict_${kind}`,
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "strict historical bytes",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const canonicalLine = serializeCanonicalMessageReceiptEnvelope(
        JSON.parse(snapshotJson) as unknown,
        receiptPath,
      );
      const corrupted = corruptReceiptHistory(kind, canonicalLine);
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, corrupted);

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        receipt_path: null,
        last_error_code: "receipt_history_invalid",
      });
    } finally {
      opened.db.close();
    }
  });

  test("runtime tail repair removes an incomplete ghost before validating canonical history", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_runtime_incomplete_ghost",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "repair only the incomplete suffix",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const canonicalLine = serializeCanonicalMessageReceiptEnvelope(
        JSON.parse(snapshotJson) as unknown,
        receiptPath,
      );
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, corruptReceiptHistory("incomplete_ghost", canonicalLine));

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      expect(await readFile(receiptPath, "utf8")).toBe(`${canonicalLine}\n`);
    } finally {
      opened.db.close();
    }
  });

  test("completed receipt authority requires matching path and exact readable JSONL evidence", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_completed_receipt_authority",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "completed means proven",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      const receiptPath = readMessageReceiptMirror(opened.db, message.message_id)!.receipt_path!;
      const wrongPath = join(opened.paths.stateDir, "receipts", "wrong.jsonl");

      opened.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      ).run("relative/messages.jsonl", message.message_id);
      opened.db.prepare(
        "UPDATE message_receipt_mirrors SET receipt_path = ? WHERE message_id = ?",
      ).run("relative/messages.jsonl", message.message_id);
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          code: "invalid-receipt-control",
          detail: expect.stringContaining("absolute receipt_path"),
        }),
      ]);
      opened.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      ).run(receiptPath, message.message_id);

      const aliasedPath = `${dirname(receiptPath)}/../receipts/messages.jsonl`;
      opened.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      ).run(aliasedPath, message.message_id);
      opened.db.prepare(
        "UPDATE message_receipt_mirrors SET receipt_path = ? WHERE message_id = ?",
      ).run(aliasedPath, message.message_id);
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          code: "invalid-receipt-control",
          detail: expect.stringContaining("exact normalized absolute receipt_path"),
        }),
      ]);
      opened.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      ).run(receiptPath, message.message_id);

      opened.db.prepare(
        "UPDATE message_receipt_mirrors SET receipt_path = ? WHERE message_id = ?",
      ).run(wrongPath, message.message_id);
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          code: "invalid-receipt-control",
          detail: expect.stringContaining("does not match the authoritative message row"),
        }),
      ]);

      opened.db.prepare(
        "UPDATE message_receipt_mirrors SET receipt_path = ? WHERE message_id = ?",
      ).run(receiptPath, message.message_id);
      await rm(receiptPath);
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          detail: expect.stringMatching(/unreadable.*ENOENT/u),
        }),
      ]);

      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
      await writeFile(receiptPath, `${JSON.stringify({
        schema_version: "calyx.message/v1",
        message: { ...snapshot, subject: "forged evidence", receipt_path: receiptPath },
      })}\n`, "utf8");
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          detail: expect.stringContaining("conflicting envelope"),
        }),
      ]);

      await writeFile(receiptPath, "{malformed-json\n", "utf8");
      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          detail: expect.stringContaining("malformed JSON"),
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test.each([
    { kind: "invalid_utf8", detail: "invalid UTF-8" },
    { kind: "duplicate_key", detail: "not exact canonical JSON" },
    { kind: "noncanonical_order", detail: "not exact canonical JSON" },
    { kind: "blank_line", detail: "blank line" },
    { kind: "incomplete_ghost", detail: "unterminated line" },
  ] as const)("receipt doctor rejects strict journal corruption: $kind", async ({ kind, detail }) => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: `msg_doctor_strict_${kind}`,
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "doctor proves exact bytes",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      const receiptPath = readMessageReceiptMirror(opened.db, message.message_id)!.receipt_path!;
      const canonicalLine = (await readFile(receiptPath, "utf8")).trimEnd();
      await writeFile(receiptPath, corruptReceiptHistory(kind, canonicalLine));

      expect(listMalformedMessageReceiptSnapshots(opened.db)).toEqual([
        expect.objectContaining({
          message_id: message.message_id,
          detail: expect.stringContaining(detail),
        }),
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("receipt evidence indexing saturates duplicate retention under a large hostile history", async () => {
    const opened = await openStateStore();
    try {
      const receiptPath = join(root, "bounded-evidence", "messages.jsonl");
      await mkdir(dirname(receiptPath), { recursive: true });
      const message = createMessage(opened.db, {
        message_id: "msg_duplicate_evidence_stress",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "saturate duplicate evidence",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const canonicalLine = serializeCanonicalMessageReceiptEnvelope(
        JSON.parse(snapshotJson) as unknown,
        receiptPath,
      );
      const envelope = JSON.parse(canonicalLine) as unknown;
      await writeFile(
        receiptPath,
        `${Array.from({ length: 1_000 }, () => canonicalLine).join("\n")}\n`,
        "utf8",
      );

      const evidence = readMessageReceiptFileEvidence(
        receiptPath,
        new Set([message.message_id]),
      );
      expect(evidence.envelopes_by_message_id.size).toBe(1);
      expect(evidence.envelopes_by_message_id.get(message.message_id)).toEqual({
        first_envelope: envelope,
        count: 2,
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt doctor pages a multi-page completed estate through ephemeral evidence indexes", async () => {
    const opened = await openStateStore();
    try {
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const readSnapshot = opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      );
      const setMessagePath = opened.db.prepare(
        "UPDATE messages SET receipt_path = ? WHERE message_id = ?",
      );
      const completeMirror = opened.db.prepare(
        `UPDATE message_receipt_mirrors
            SET status = 'completed', attempt_count = 1, next_attempt_at = NULL,
                last_attempt_at = ?, completed_at = ?, receipt_path = ?, updated_at = ?
          WHERE message_id = ?`,
      );
      const envelopes: string[] = [];
      opened.db.exec("BEGIN");
      try {
        for (let index = 0; index < 300; index += 1) {
          const messageId = `msg_doctor_bounded_${String(index).padStart(3, "0")}`;
          const message = createMessage(opened.db, {
            message_id: messageId,
            sender: "client:sender@blade",
            recipient_address: "role:reviewer@blade",
            recipient_class: "directed",
            subject: "bounded doctor estate",
            now: "2026-07-14T07:00:00.000Z",
          }).message;
          enqueueMessageReceiptMirror(opened.db, messageId, message.created_at);
          const snapshotJson = (readSnapshot.get(messageId) as { receipt_snapshot_json: string })
            .receipt_snapshot_json;
          const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
          envelopes.push(JSON.stringify({
            schema_version: "calyx.message/v1",
            message: { ...snapshot, receipt_path: receiptPath },
          }));
          setMessagePath.run(receiptPath, messageId);
          completeMirror.run(
            message.created_at,
            message.created_at,
            receiptPath,
            message.created_at,
            messageId,
          );
        }
        opened.db.exec("COMMIT");
      } catch (error) {
        opened.db.exec("ROLLBACK");
        throw error;
      }
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${envelopes.join("\n")}\n${envelopes[0]}\n`, "utf8");

      expect(listMalformedMessageReceiptSnapshots(opened.db, 1)).toEqual([
        expect.objectContaining({
          message_id: "msg_doctor_bounded_000",
          detail: expect.stringContaining("multiple envelopes"),
        }),
      ]);
      expect(opened.db.prepare(
        `SELECT name FROM sqlite_temp_master
          WHERE name LIKE 'calyx_receipt_doctor_%'
          ORDER BY name`,
      ).all()).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("a newline repair I/O failure never truncates a valid receipt tail", async () => {
    const opened = await openStateStore();
    try {
      const first = createMessage(opened.db, {
        message_id: "msg_valid_unterminated_receipt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "retain this envelope",
      }).message;
      enqueueMessageReceiptMirror(opened.db, first.message_id);
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: first.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      const receiptPath = readMessageReceiptMirror(opened.db, first.message_id)!.receipt_path!;
      const validTail = (await readFile(receiptPath, "utf8")).trimEnd();
      await writeFile(receiptPath, validTail, "utf8");

      const second = createMessage(opened.db, {
        message_id: "msg_after_unterminated_receipt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "wait for safe repair",
      }).message;
      enqueueMessageReceiptMirror(opened.db, second.message_id);

      const prototype = await fileHandlePrototype(root);
      const originalWrite = prototype.write;
      const writeSpy = vi.spyOn(prototype, "write").mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
      ): Promise<GenericFileWriteResult> {
        const input = args[0];
        const offset = typeof args[1] === "number" ? args[1] : 0;
        const length = typeof args[2] === "number"
          ? args[2]
          : ArrayBuffer.isView(input) ? input.byteLength : undefined;
        if (
          input === "\n"
          || (
            ArrayBuffer.isView(input)
            && length === 1
            && new Uint8Array(input.buffer, input.byteOffset, input.byteLength)[offset] === 0x0a
          )
        ) {
          throw Object.assign(new Error("injected newline write failure"), { code: "EIO" });
        }
        return await Reflect.apply(originalWrite, this, args) as GenericFileWriteResult;
      });
      try {
        await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: second.message_id,
          force: true,
        })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      } finally {
        writeSpy.mockRestore();
      }
      expect(await readFile(receiptPath, "utf8")).toBe(validTail);
      expect(readMessageReceiptMirror(opened.db, second.message_id)).toMatchObject({
        status: "pending",
        last_error_code: "EIO",
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt tail repair completes legal short reads before classifying an unterminated envelope", async () => {
    const opened = await openStateStore();
    try {
      const first = createMessage(opened.db, {
        message_id: "msg_short_read_existing_receipt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not truncate me after a short read",
      }).message;
      enqueueMessageReceiptMirror(opened.db, first.message_id);
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: first.message_id,
        force: true,
      })).resolves.toMatchObject({ completed: 1, failed: 0 });
      const receiptPath = readMessageReceiptMirror(opened.db, first.message_id)!.receipt_path!;
      const firstEnvelope = (await readFile(receiptPath, "utf8")).trimEnd();
      await writeFile(receiptPath, firstEnvelope, "utf8");

      const second = createMessage(opened.db, {
        message_id: "msg_after_short_receipt_read",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "append after complete read",
      }).message;
      enqueueMessageReceiptMirror(opened.db, second.message_id);

      const prototype = await fileHandlePrototype(root);
      const originalRead = prototype.read;
      let shortenedReads = 0;
      const readSpy = vi.spyOn(prototype, "read").mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
      ): Promise<GenericFileReadResult> {
        const requestedLength = typeof args[2] === "number" ? args[2] : 0;
        if (requestedLength > 1) {
          shortenedReads += 1;
          const partialLength = Math.max(1, Math.floor(requestedLength / 2));
          return await Reflect.apply(
            originalRead,
            this,
            [args[0], args[1] ?? 0, partialLength, args[3] ?? null],
          ) as GenericFileReadResult;
        }
        return await Reflect.apply(originalRead, this, args) as GenericFileReadResult;
      });
      try {
        await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: second.message_id,
          force: true,
        })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      } finally {
        readSpy.mockRestore();
      }

      expect(shortenedReads).toBeGreaterThan(1);
      const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(firstEnvelope);
      expect(JSON.parse(lines[1]!) as unknown).toMatchObject({
        message: { message_id: second.message_id },
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt append refuses to complete atop malformed newline-terminated history", async () => {
    const opened = await openStateStore();
    try {
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      await mkdir(dirname(receiptPath), { recursive: true });
      const malformedHistory = "{malformed historical receipt}\n";
      await writeFile(receiptPath, malformedHistory, "utf8");
      const message = createMessage(opened.db, {
        message_id: "msg_after_malformed_receipt_history",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "do not bless corrupt history",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(await readFile(receiptPath, "utf8")).toBe(malformedHistory);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        receipt_path: null,
        last_error_code: "receipt_history_invalid",
      });
    } finally {
      opened.db.close();
    }
  });

  test.each([
    { suffix: "malformed", error_code: "receipt_history_invalid" },
    { suffix: "conflicting", error_code: "receipt_identity_conflict" },
    { suffix: "duplicate", error_code: "receipt_identity_conflict" },
  ])("receipt append scans past an early match and rejects a $suffix suffix", async ({
    suffix,
    error_code,
  }) => {
    const opened = await openStateStore();
    try {
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      await mkdir(dirname(receiptPath), { recursive: true });
      const message = createMessage(opened.db, {
        message_id: `msg_early_match_${suffix}`,
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "the first envelope is provisional",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const snapshotJson = (opened.db.prepare(
        "SELECT receipt_snapshot_json FROM message_receipt_mirrors WHERE message_id = ?",
      ).get(message.message_id) as { receipt_snapshot_json: string }).receipt_snapshot_json;
      const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
      const desiredEnvelope = {
        schema_version: "calyx.message/v1",
        message: { ...snapshot, receipt_path: receiptPath },
      };
      const suffixLine = suffix === "malformed"
        ? "{malformed suffix"
        : JSON.stringify(suffix === "duplicate"
          ? desiredEnvelope
          : {
              ...desiredEnvelope,
              message: { ...desiredEnvelope.message, subject: "conflicting suffix" },
            });
      const history = `${JSON.stringify(desiredEnvelope)}\n${suffixLine}\n`;
      await writeFile(receiptPath, history, "utf8");

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(await readFile(receiptPath, "utf8")).toBe(history);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        receipt_path: null,
        last_error_code: error_code,
      });
      expect(readMessage(opened.db, message.message_id)).toMatchObject({ receipt_path: null });
    } finally {
      opened.db.close();
    }
  });

  test("receipt append retries short writes before fsync and completion", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_short_receipt_write",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "write every byte",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);

      const prototype = await fileHandlePrototype(root);
      const originalWrite = prototype.write;
      let shortened = false;
      const writeSpy = vi.spyOn(prototype, "write").mockImplementation(async function (
        this: unknown,
        ...args: unknown[]
      ): Promise<GenericFileWriteResult> {
        const input = args[0];
        if (!shortened && typeof input === "string" && input.length > 1) {
          shortened = true;
          const partial = input.slice(0, Math.max(1, Math.floor(input.length / 2)));
          return await Reflect.apply(originalWrite, this, [partial, ...args.slice(1)]) as GenericFileWriteResult;
        }
        if (!shortened && ArrayBuffer.isView(input)) {
          const length = typeof args[2] === "number" ? args[2] : input.byteLength;
          if (length > 1) {
            shortened = true;
            const partialLength = Math.max(1, Math.floor(length / 2));
            return await Reflect.apply(
              originalWrite,
              this,
              [input, args[1] ?? 0, partialLength, args[3] ?? null],
            ) as GenericFileWriteResult;
          }
        }
        return await Reflect.apply(originalWrite, this, args) as GenericFileWriteResult;
      });
      try {
        await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: message.message_id,
          force: true,
        })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      } finally {
        writeSpy.mockRestore();
      }

      expect(shortened).toBe(true);
      const receiptPath = readMessageReceiptMirror(opened.db, message.message_id)!.receipt_path!;
      const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!) as unknown).toMatchObject({
        schema_version: "calyx.message/v1",
        message: { message_id: message.message_id, subject: "write every byte" },
      });
    } finally {
      opened.db.close();
    }
  });

  test("exact-line retry fsyncs the receipt file before completing the mirror", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_retry_after_file_fsync_failure",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "matching bytes are not yet durable proof",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);

      const prototype = await fileHandlePrototype(root);
      const originalSync = prototype.sync;
      const originalStat = prototype.stat;
      let receiptFileSyncAttempts = 0;
      const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (
        this: unknown,
      ): Promise<void> {
        const stats = await Reflect.apply(originalStat, this, []) as GenericFileStatResult;
        if (stats.isFile()) {
          receiptFileSyncAttempts += 1;
          if (receiptFileSyncAttempts === 1) {
            const error = new Error("injected receipt file fsync failure") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
        }
        await Reflect.apply(originalSync, this, []);
      });
      try {
        await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: message.message_id,
          force: true,
        })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
        const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
        const firstBytes = await readFile(receiptPath, "utf8");
        expect(firstBytes.trim().split("\n")).toHaveLength(1);
        expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
          status: "pending",
          receipt_path: null,
          last_error_code: "EIO",
        });

        await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
          message_id: message.message_id,
          force: true,
        })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
        expect(receiptFileSyncAttempts).toBe(2);
        expect(await readFile(receiptPath, "utf8")).toBe(firstBytes);
      } finally {
        syncSpy.mockRestore();
      }
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "completed",
        attempt_count: 2,
        last_error_code: null,
      });
    } finally {
      opened.db.close();
    }
  });

  test("receipt mirror remains pending until its containing directory is durable", async () => {
    const opened = await openStateStore();
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_directory_sync",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "directory durability",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);
      const syncedPaths: string[] = [];
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
        syncDirectory: async (directoryPath) => {
          syncedPaths.push(directoryPath);
          throw new Error("injected directory fsync failure");
        },
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        receipt_path: null,
        last_error_code: "mirror_write_failed",
      });

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
        syncDirectory: async (directoryPath) => {
          syncedPaths.push(directoryPath);
        },
      })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      expect(syncedPaths).toEqual([
        join(opened.paths.stateDir, "receipts"),
        join(opened.paths.stateDir, "receipts"),
        opened.paths.stateDir,
      ]);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "completed",
        receipt_path: join(opened.paths.stateDir, "receipts", "messages.jsonl"),
      });
      const lines = (await readFile(join(opened.paths.stateDir, "receipts", "messages.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("replays the enqueued snapshot after append durability and a later ACK", async () => {
    const opened = await openStateStore();
    try {
      const enqueued = createMessage(opened.db, {
        message_id: "msg_ack_after_receipt_fsync",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "immutable before ACK",
        now: "2026-07-14T01:00:00.000Z",
      }).message;
      enqueueMessageReceiptMirror(opened.db, enqueued.message_id, "2026-07-14T01:00:00.000Z");

      // The JSONL append and file fsync have succeeded when the containing
      // directory fsync fails. This is the crash window that used to make a
      // subsequent ACK produce a permanent same-ID envelope conflict.
      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: enqueued.message_id,
        force: true,
        syncDirectory: async () => {
          throw new Error("injected crash after receipt fsync");
        },
      })).resolves.toMatchObject({ attempted: 1, completed: 0, failed: 1, pending: 1 });
      expect(ackMessage(opened.db, enqueued.message_id, {
        acked_by: "client:reviewer@blade",
        acked_at: "2026-07-14T01:01:00.000Z",
      })).toMatchObject({ changed: true, message: { status: "acked" } });

      await expect(drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: enqueued.message_id,
        force: true,
      })).resolves.toMatchObject({ attempted: 1, completed: 1, failed: 0, pending: 0 });
      expect(readMessageReceiptMirror(opened.db, enqueued.message_id)).toMatchObject({
        status: "completed",
        attempt_count: 2,
        last_error_code: null,
      });
      expect(readMessage(opened.db, enqueued.message_id)).toMatchObject({
        status: "acked",
        acked_by: "client:reviewer@blade",
      });
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(canonicalizeJcs(JSON.parse(lines[0]!) as unknown)).toBe(canonicalizeJcs({
        schema_version: "calyx.message/v1",
        message: { ...enqueued, receipt_path: receiptPath },
      }));
    } finally {
      opened.db.close();
    }
  });

  test("serializes concurrent mirror drains through one full receipt transaction", async () => {
    const first = await openStateStore();
    const second = await openStateStore();
    try {
      const message = createMessage(first.db, {
        message_id: "msg_concurrent_receipt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "serialize the mirror",
      }).message;
      enqueueMessageReceiptMirror(first.db, message.message_id);

      const results = await Promise.all([
        drainMessageReceiptMirrors(first.db, first.paths.stateDir, {
          message_id: message.message_id,
          force: true,
        }),
        drainMessageReceiptMirrors(second.db, second.paths.stateDir, {
          message_id: message.message_id,
          force: true,
        }),
      ]);

      expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
      expect(readMessageReceiptMirror(first.db, message.message_id)).toMatchObject({
        status: "completed",
        attempt_count: 1,
      });
      const lines = (await readFile(join(first.paths.stateDir, "receipts", "messages.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!) as unknown).toMatchObject({
        message: { message_id: message.message_id },
      });
    } finally {
      second.db.close();
      first.db.close();
    }
  });

  test("waits asynchronously for a cross-process receipt owner before changing mirror state", async () => {
    const opened = await openStateStore();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_cross_process_receipt",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "wait for the durable owner",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);

      const mutexPath = join(opened.paths.stateDir, "locks", "message-receipts.lock.sqlite3");
      await mkdir(dirname(mutexPath), { recursive: true });
      child = spawn(process.execPath, [
        "-e",
        [
          "const { DatabaseSync } = require('node:sqlite');",
          "const db = new DatabaseSync(process.argv[1]);",
          "db.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');",
          "process.stdout.write('ready\\n');",
          "process.stdin.resume();",
          "process.stdin.once('data', () => {",
          "  db.exec('ROLLBACK');",
          "  db.close();",
          "  process.exit(0);",
          "});",
        ].join("\n"),
        mutexPath,
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let childStderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => { childStderr += String(chunk); });
      await new Promise<void>((resolveReady, rejectReady) => {
        const onExit = (code: number | null) => {
          rejectReady(new Error(`mutex owner exited before ready (${code}): ${childStderr}`));
        };
        child!.once("exit", onExit);
        child!.stdout!.setEncoding("utf8");
        child!.stdout!.once("data", (chunk) => {
          child!.off("exit", onExit);
          if (String(chunk).includes("ready")) resolveReady();
          else rejectReady(new Error(`unexpected mutex owner output: ${String(chunk)}`));
        });
      });

      let settled = false;
      const drain = drainMessageReceiptMirrors(opened.db, opened.paths.stateDir, {
        message_id: message.message_id,
        force: true,
      }).then((result) => {
        settled = true;
        return result;
      });
      await delay(75);
      expect(settled).toBe(false);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "pending",
        attempt_count: 0,
      });

      const childExit = new Promise<void>((resolveExit, rejectExit) => {
        child!.once("exit", (code) => {
          if (code === 0) resolveExit();
          else rejectExit(new Error(`mutex owner exited ${code}: ${childStderr}`));
        });
      });
      child.stdin!.write("release\n");
      await expect(drain).resolves.toMatchObject({ completed: 1, failed: 0, pending: 0 });
      await childExit;
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "completed",
        attempt_count: 1,
      });
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      opened.db.close();
    }
  });

  test("deduplicates one canonical envelope across two production drain processes", async () => {
    const opened = await openStateStore();
    const children: Array<ReturnType<typeof spawn>> = [];
    try {
      const message = createMessage(opened.db, {
        message_id: "msg_process_dedupe",
        sender: "client:sender@blade",
        recipient_address: "role:reviewer@blade",
        recipient_class: "directed",
        subject: "one envelope across processes",
      }).message;
      enqueueMessageReceiptMirror(opened.db, message.message_id);

      const viteNode = await findViteNodeEntrypoint();
      const gatePath = join(root, "process-dedupe.go");
      const readyPaths = [join(root, "process-dedupe-a.ready"), join(root, "process-dedupe-b.ready")];
      const workers = readyPaths.map((readyPath) => startMessageReceiptWorker(
        viteNode,
        message.message_id,
        readyPath,
        gatePath,
      ));
      children.push(...workers.map(({ child }) => child));
      await Promise.all(readyPaths.map(waitForFile));
      await writeFile(gatePath, "go\n", "utf8");
      const results = await Promise.all(workers.map(({ result }) => result));

      expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
      expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
        status: "completed",
        attempt_count: 1,
      });
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(canonicalizeJcs(JSON.parse(lines[0]!) as unknown)).toBe(canonicalizeJcs({
        schema_version: "calyx.message/v1",
        message: { ...message, receipt_path: receiptPath },
      }));
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      opened.db.close();
    }
  });

  test("repairs one malformed tail while separate production processes append different messages", async () => {
    const opened = await openStateStore();
    const children: Array<ReturnType<typeof spawn>> = [];
    try {
      const messages = [
        createMessage(opened.db, {
          message_id: "msg_process_tail_a",
          sender: "client:sender@blade",
          recipient_address: "role:reviewer@blade",
          recipient_class: "directed",
          subject: "tail repair a",
        }).message,
        createMessage(opened.db, {
          message_id: "msg_process_tail_b",
          sender: "client:sender@blade",
          recipient_address: "role:reviewer@blade",
          recipient_class: "directed",
          subject: "tail repair b",
        }).message,
      ];
      for (const message of messages) enqueueMessageReceiptMirror(opened.db, message.message_id);
      const receiptPath = join(opened.paths.stateDir, "receipts", "messages.jsonl");
      await mkdir(dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, '{"schema_version":"calyx.message/v1","message":', "utf8");

      const viteNode = await findViteNodeEntrypoint();
      const gatePath = join(root, "process-tail.go");
      const readyPaths = [join(root, "process-tail-a.ready"), join(root, "process-tail-b.ready")];
      const workers = messages.map((message, index) => startMessageReceiptWorker(
        viteNode,
        message.message_id,
        readyPaths[index]!,
        gatePath,
      ));
      children.push(...workers.map(({ child }) => child));
      await Promise.all(readyPaths.map(waitForFile));
      await writeFile(gatePath, "go\n", "utf8");
      const results = await Promise.all(workers.map(({ result }) => result));

      expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(2);
      expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
      const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      const envelopes = lines.map((line) => JSON.parse(line) as { message: { message_id: string } });
      expect(envelopes.map(({ message }) => message.message_id).sort()).toEqual(
        messages.map(({ message_id }) => message_id).sort(),
      );
      for (const message of messages) {
        const envelope = envelopes.find((candidate) => candidate.message.message_id === message.message_id);
        expect(canonicalizeJcs(envelope)).toBe(canonicalizeJcs({
          schema_version: "calyx.message/v1",
          message: { ...message, receipt_path: receiptPath },
        }));
        expect(readMessageReceiptMirror(opened.db, message.message_id)).toMatchObject({
          status: "completed",
          attempt_count: 1,
        });
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      opened.db.close();
    }
  });
});
