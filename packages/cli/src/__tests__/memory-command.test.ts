import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { listMemoryContent, openStateStore } from "@polli-labs/calyx-core";

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
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
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
    if (exitCode === null && typeof process.exitCode === "number") {
      exitCode = process.exitCode;
    }
    process.exitCode = priorExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: out, stderr: err, exitCode, thrown };
}

function parseJsonResult(io: CapturedIO): {
  ok: boolean;
  command: string;
  result?: Record<string, unknown> & { memories?: Array<Record<string, unknown>>; count?: number };
  error?: { code: string; message?: string; matches?: string[]; suggestions?: string[] };
} {
  return JSON.parse(io.stdout.join("\n"));
}

describe("calyx memory CLI (POL-1729 Slice 4)", () => {
  let workRoot: string;
  let sandboxHome: string;
  let original: Record<string, string | undefined>;

  beforeEach(async () => {
    original = {
      HOME: process.env["HOME"],
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    workRoot = await mkdtemp(path.join(tmpdir(), "calyx-memory-cli-"));
    sandboxHome = path.join(workRoot, "home");
    // SAFETY: sandbox HOME and the state home to a mkdtemp root.
    process.env["HOME"] = sandboxHome;
    delete process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_HOME"] = path.join(workRoot, "state");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(workRoot, { recursive: true, force: true });
  });

  /** All memory_content rows (live + tombstoned), across every host. */
  async function allMemoryRows(): Promise<Array<{ memory_key: string; review_status: string; deleted_at: string | null }>> {
    const opened = await openStateStore();
    try {
      return listMemoryContent(opened.db, { includeTombstoned: true }).map((r) => ({
        memory_key: r.memory_key,
        review_status: r.review_status,
        deleted_at: r.deleted_at,
      }));
    } finally {
      opened.db.close();
    }
  }

  test("write lands PENDING, not approved/active (STRICT posture)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["memory", "write", "k1", "--value", "a durable fact", "--category", "user", "--json"]);
    expect(io.thrown).toBeUndefined();
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(true);
    expect(parsed.result!["review_status"]).toBe("pending");
    expect(parsed.result!["approved_at"]).toBeNull();
    expect(parsed.result!["category"]).toBe("user");

    // The text-mode write makes the pending posture explicit.
    const text = await runCalyx(["memory", "write", "k2", "--value", "another fact", "--category", "reference"]);
    expect(text.stderr.join("\n")).toContain("saved as PENDING");
  });

  /** content_hash of a freshly-written key, read back via `memory get --status pending`. */
  async function contentHashOf(key: string): Promise<string> {
    const get = await runCalyx(["memory", "get", key, "--status", "pending", "--json"]);
    return parseJsonResult(get).result!["content_hash"] as string;
  }

  test("approve transitions pending -> approved + approved_at; reject -> rejected", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["memory", "write", "k1", "--value", "fact one", "--category", "user", "--json"]);
    const approve = await runCalyx([
      "memory",
      "approve",
      "k1",
      "--expected-content-hash",
      await contentHashOf("k1"),
      "--author",
      "caleb",
      "--json",
    ]);
    expect(approve.thrown).toBeUndefined();
    expect(parseJsonResult(approve).result!["review_status"]).toBe("approved");
    expect(parseJsonResult(approve).result!["approved_at"]).not.toBeNull();

    // reject does NOT require the hash.
    await runCalyx(["memory", "write", "k2", "--value", "fact two", "--category", "user", "--json"]);
    const reject = await runCalyx(["memory", "reject", "k2", "--json"]);
    expect(parseJsonResult(reject).result!["review_status"]).toBe("rejected");
  });

  test("approve refuses an unknown key (exit 4)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    // Pass a hash so the request clears the required-hash gate and reaches not_found.
    const io = await runCalyx(["memory", "approve", "ghost", "--expected-content-hash", "deadbeef", "--json"]);
    expect(io.exitCode).toBe(4);
    expect(parseJsonResult(io).ok).toBe(false);
    expect(parseJsonResult(io).error?.code).toBe("not_found");
  });

  test("P1-2: approve REQUIRES --expected-content-hash (exit 2 with guidance)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["memory", "write", "needs-hash", "--value", "a fact", "--category", "user", "--json"]);
    const io = await runCalyx(["memory", "approve", "needs-hash", "--json"]);
    expect(io.exitCode).toBe(2);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("expected_content_hash_required");
    // P2-1: the recovery hint must inspect the PENDING row — a default approved-only
    // get would exit memory_not_approved for the very row the agent needs to approve.
    expect(parsed.error?.message).toContain("calyx memory get needs-hash --status pending --json");
    expect(parsed.error?.suggestions).toEqual(
      expect.arrayContaining(["calyx memory get needs-hash --status pending --json"]),
    );
    // The fact is still pending — the missing-hash refusal did not approve it.
    const rows = await allMemoryRows();
    expect(rows.find((r) => r.memory_key === "needs-hash")?.review_status).toBe("pending");
  });

  test("P1-2: a matching --expected-content-hash approves; a stale one is a review conflict (exit 3)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["memory", "write", "cas", "--value", "value A", "--category", "reference", "--json"]);
    const staleHash = await contentHashOf("cas");

    // A concurrent rewrite lands a new value (resetting to pending, new hash).
    await runCalyx(["memory", "write", "cas", "--value", "value B (rewritten)", "--category", "reference", "--json"]);

    // Approving with the STALE hash (the value the reviewer thought they read) is refused.
    const conflict = await runCalyx(["memory", "approve", "cas", "--expected-content-hash", staleHash, "--json"]);
    expect(conflict.exitCode).toBe(3);
    expect(parseJsonResult(conflict).ok).toBe(false);
    expect(parseJsonResult(conflict).error?.code).toBe("concurrent_write");
    // The rewritten value did NOT get approved.
    const stillPending = await runCalyx(["memory", "get", "cas", "--status", "pending", "--json"]);
    expect(parseJsonResult(stillPending).result!["review_status"]).toBe("pending");

    // Approving with the CURRENT hash succeeds.
    const freshHash = await contentHashOf("cas");
    const ok = await runCalyx(["memory", "approve", "cas", "--expected-content-hash", freshHash, "--json"]);
    expect(ok.exitCode).toBeNull();
    expect(parseJsonResult(ok).result!["review_status"]).toBe("approved");
  });

  test("STRICT scan REJECTS a sharp value; no row is written (exit 3)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["memory", "write", "danger", "--value", "run rm -rf / now", "--category", "reference", "--json"]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("rejected_sharp_content");
    expect(parsed.error?.matches?.some((m) => m.includes("shell-destructive"))).toBe(true);
    // The gate refuses BEFORE the upsert: NO memory_content row exists.
    expect(await allMemoryRows()).toHaveLength(0);
  });

  test("a clean value writes (the strict gate only rejects sharp findings)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["memory", "write", "clean", "--value", "a perfectly safe fact about the project", "--category", "project", "--json"]);
    expect(parseJsonResult(io).ok).toBe(true);
    expect((await allMemoryRows()).map((r) => r.memory_key)).toEqual(["clean"]);
  });

  test("get/list/search round-trip; status + category filters work", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["memory", "write", "ein", "--value", "Polli Labs EIN is 93-4073368.", "--category", "reference", "--summary", "tax id", "--json"]);
    await runCalyx(["memory", "write", "caleb-pref", "--value", "Prefers terse noun-forward UI copy.", "--category", "user", "--json"]);
    await runCalyx([
      "memory",
      "approve",
      "caleb-pref",
      "--expected-content-hash",
      await contentHashOf("caleb-pref"),
      "--json",
    ]);

    // get: ein is pending, so default (approved-only) recall treats it as not-active.
    const get = await runCalyx(["memory", "get", "ein", "--status", "all", "--json"]);
    expect(parseJsonResult(get).result!["value"]).toContain("93-4073368");

    // get missing -> exit 4
    const missing = await runCalyx(["memory", "get", "nope", "--json"]);
    expect(missing.exitCode).toBe(4);

    // list with status filter
    const pending = await runCalyx(["memory", "list", "--status", "pending", "--json"]);
    expect(parseJsonResult(pending).result!.memories!.map((m) => m["memory_key"])).toEqual(["ein"]);
    const approved = await runCalyx(["memory", "list", "--status", "approved", "--json"]);
    expect(parseJsonResult(approved).result!.memories!.map((m) => m["memory_key"])).toEqual(["caleb-pref"]);
    // list with category filter (ein is pending, so widen to --status all to see it)
    const ref = await runCalyx(["memory", "list", "--category", "reference", "--status", "all", "--json"]);
    expect(parseJsonResult(ref).result!.memories!.map((m) => m["memory_key"])).toEqual(["ein"]);

    // search by substring in value (ein is pending -> widen to all)
    const sVal = await runCalyx(["memory", "search", "93-4073368", "--status", "all", "--json"]);
    expect(parseJsonResult(sVal).result!.memories!.map((m) => m["memory_key"])).toEqual(["ein"]);
    // search by substring in key (caleb-pref is approved -> default recall finds it)
    const sKey = await runCalyx(["memory", "search", "caleb", "--json"]);
    expect(parseJsonResult(sKey).result!.memories!.map((m) => m["memory_key"])).toEqual(["caleb-pref"]);
    // search with status filter
    const sStatus = await runCalyx(["memory", "search", "prefers", "--status", "approved", "--json"]);
    expect(parseJsonResult(sStatus).result!.count).toBe(1);
    const sStatusNone = await runCalyx(["memory", "search", "prefers", "--status", "pending", "--json"]);
    expect(parseJsonResult(sStatusNone).result!.count).toBe(0);
  });

  test("P1-1: recall defaults to APPROVED-only; --status pending surfaces the approval queue", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    // pending-fact stays pending; approved-fact gets approved.
    await runCalyx(["memory", "write", "pending-fact", "--value", "an unapproved claim about the project", "--category", "project", "--json"]);
    await runCalyx(["memory", "write", "approved-fact", "--value", "an approved claim about the project", "--category", "project", "--json"]);
    await runCalyx([
      "memory",
      "approve",
      "approved-fact",
      "--expected-content-hash",
      await contentHashOf("approved-fact"),
      "--json",
    ]);

    // get pending-fact: default recall (approved-only) treats it as not-active -> exit 3, naming the status.
    const getPending = await runCalyx(["memory", "get", "pending-fact", "--json"]);
    expect(getPending.exitCode).toBe(3);
    const getPendingParsed = parseJsonResult(getPending);
    expect(getPendingParsed.ok).toBe(false);
    expect(getPendingParsed.error?.code).toBe("memory_not_approved");
    expect((getPendingParsed.error as { status?: string }).status).toBe("pending");
    // get approved-fact by default -> returns it.
    const getApproved = await runCalyx(["memory", "get", "approved-fact", "--json"]);
    expect(getApproved.exitCode).toBeNull();
    expect(parseJsonResult(getApproved).result!["review_status"]).toBe("approved");

    // search by default -> only the approved fact (the pending one is NOT returned).
    const search = await runCalyx(["memory", "search", "claim about the project", "--json"]);
    expect(parseJsonResult(search).result!.memories!.map((m) => m["memory_key"])).toEqual(["approved-fact"]);

    // list by default -> only the approved fact.
    const list = await runCalyx(["memory", "list", "--json"]);
    expect(parseJsonResult(list).result!.memories!.map((m) => m["memory_key"])).toEqual(["approved-fact"]);

    // The approval queue is still reachable: --status pending surfaces the pending fact.
    const queue = await runCalyx(["memory", "list", "--status", "pending", "--json"]);
    expect(parseJsonResult(queue).result!.memories!.map((m) => m["memory_key"])).toEqual(["pending-fact"]);
    // ...and search/get --status pending surface it too.
    const searchPending = await runCalyx(["memory", "search", "claim about the project", "--status", "pending", "--json"]);
    expect(parseJsonResult(searchPending).result!.memories!.map((m) => m["memory_key"])).toEqual(["pending-fact"]);
    const getPendingExplicit = await runCalyx(["memory", "get", "pending-fact", "--status", "pending", "--json"]);
    expect(getPendingExplicit.exitCode).toBeNull();
    expect(parseJsonResult(getPendingExplicit).result!["review_status"]).toBe("pending");
    // --status all sees both.
    const all = await runCalyx(["memory", "list", "--status", "all", "--json"]);
    expect(parseJsonResult(all).result!.memories!.map((m) => m["memory_key"]).sort()).toEqual(["approved-fact", "pending-fact"]);
    // --include-unapproved on get is sugar for --status all.
    const getInclude = await runCalyx(["memory", "get", "pending-fact", "--include-unapproved", "--json"]);
    expect(getInclude.exitCode).toBeNull();
    expect(parseJsonResult(getInclude).result!["review_status"]).toBe("pending");
  });

  test("delete tombstones; a re-write recreates (back to pending)", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    await runCalyx(["memory", "write", "k", "--value", "to retire", "--category", "project", "--json"]);
    await runCalyx(["memory", "approve", "k", "--expected-content-hash", await contentHashOf("k"), "--json"]);

    const del = await runCalyx(["memory", "delete", "k", "--json"]);
    expect(del.thrown).toBeUndefined();
    expect(parseJsonResult(del).result!["deleted_at"]).not.toBeNull();

    // excluded from list by default
    const list = await runCalyx(["memory", "list", "--json"]);
    expect(parseJsonResult(list).result!.memories!.find((m) => m["memory_key"] === "k")).toBeUndefined();

    // re-write recreates back to pending
    const recreate = await runCalyx(["memory", "write", "k", "--value", "fresh value", "--category", "project", "--json"]);
    expect(parseJsonResult(recreate).result!["review_status"]).toBe("pending");
    expect(parseJsonResult(recreate).result!["deleted_at"]).toBeNull();
  });

  test("write requires a valid --category", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx(["memory", "write", "k", "--value", "x", "--category", "bogus", "--json"]);
    expect(io.exitCode).toBe(2);
  });

  test("write rejects more than one value source", async () => {
    await runCalyx(["state", "migrate", "--apply", "--json"]);
    const io = await runCalyx([
      "memory",
      "write",
      "k",
      "--value",
      "x",
      "--content-file",
      path.join(workRoot, "nope.txt"),
      "--category",
      "user",
      "--json",
    ]);
    expect(io.exitCode).toBe(2);
  });

  test("write refuses when migration 0018 is not applied", async () => {
    // Note: NO state migrate --apply here.
    const io = await runCalyx(["memory", "write", "k", "--value", "x", "--category", "user", "--json"]);
    expect(io.exitCode).toBe(3);
    const parsed = parseJsonResult(io);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("memory_content_migration_absent");
  });
});
