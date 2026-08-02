import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RunReceipt } from "../src/types.js";

const fsControl = vi.hoisted(() => ({
  events: [] as string[],
  failTempSync: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const callHandleMethod = async (
    handle: Awaited<ReturnType<typeof actual.open>>,
    method: "writeFile" | "sync" | "close",
    args: unknown[],
  ): Promise<unknown> => {
    const operation = handle[method] as unknown as (...values: unknown[]) => Promise<unknown>;
    return operation.apply(handle, args);
  };

  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const kind = args[1] === "wx" ? "temp" : "directory";
      fsControl.events.push(`${kind}:open`);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "writeFile") {
            return async (...methodArgs: unknown[]) => {
              const result = await callHandleMethod(target, "writeFile", methodArgs);
              fsControl.events.push(`${kind}:write`);
              return result;
            };
          }
          if (property === "sync") {
            return async () => {
              if (kind === "temp" && fsControl.failTempSync) {
                fsControl.events.push("temp:sync:failed");
                throw new Error("injected temp fsync failure");
              }
              const result = await callHandleMethod(target, "sync", []);
              fsControl.events.push(`${kind}:sync`);
              return result;
            };
          }
          if (property === "close") {
            return async () => {
              const result = await callHandleMethod(target, "close", []);
              fsControl.events.push(`${kind}:close`);
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      fsControl.events.push("rename:start");
      await actual.rename(...args);
      fsControl.events.push("rename:complete");
    },
  };
});

import {
  buildRunReceipt,
  writeReceipt,
  writeReceiptAtomically,
} from "../src/receipt.js";
import { runReceiptSchema } from "../src/schemas.js";

function makeReceipt(runId: string): RunReceipt {
  const now = "2026-07-14T08:00:00.000Z";
  return buildRunReceipt({
    run_id: runId,
    state: "succeeded",
    spec: {
      run_id: runId,
      host: "blade",
      backend: "claude",
      prompt: "Prove durable receipt publication",
      require_execplan: false,
      pull_execplan: false,
      worktree: {},
    },
    artifacts: {
      run_id: runId,
      finalized_at: now,
      required: [],
      discovered: [],
      gate_passed: true,
      missing: [],
    },
    events: [],
    environment: { host: "blade", backend: "claude" },
    timing: {
      created_at: now,
      completed_at: now,
    },
  });
}

describe("receipt durability", () => {
  let directory: string;
  let receiptPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "calyx-receipt-durability-"));
    receiptPath = join(directory, "receipt.json");
    fsControl.events.length = 0;
    fsControl.failTempSync = false;
  });

  afterEach(async () => {
    fsControl.failTempSync = false;
    await rm(directory, { recursive: true, force: true });
  });

  test("publishes a complete 0600 receipt only after file and directory fsync", async () => {
    const receipt = makeReceipt("receipt-durable-001");

    await writeReceiptAtomically(receipt, receiptPath);

    const raw = await readFile(receiptPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(receipt);
    const parsed = runReceiptSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.run_id).toBe(receipt.run_id);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(await temporaryReceiptNames(directory, receiptPath)).toEqual([]);
    expect(fsControl.events).toEqual([
      "temp:open",
      "temp:write",
      "temp:sync",
      "temp:close",
      "rename:start",
      "rename:complete",
      "directory:open",
      "directory:sync",
      "directory:close",
    ]);
  });

  test("rejects an invalid receipt before replacing a valid published receipt", async () => {
    const receipt = makeReceipt("receipt-durable-002");
    await writeReceipt(receipt, receiptPath);
    const published = await readFile(receiptPath, "utf8");
    fsControl.events.length = 0;

    const invalid = {
      ...makeReceipt("receipt-invalid-replacement"),
      schema_version: "2.0",
    } as unknown as RunReceipt;

    await expect(writeReceipt(invalid, receiptPath)).rejects.toThrow();
    expect(await readFile(receiptPath, "utf8")).toBe(published);
    expect(fsControl.events).toEqual([]);
    expect(await temporaryReceiptNames(directory, receiptPath)).toEqual([]);
  });

  test("removes the temp file and preserves the prior receipt when preparation fsync fails", async () => {
    const receipt = makeReceipt("receipt-durable-003");
    await writeReceipt(receipt, receiptPath);
    const published = await readFile(receiptPath, "utf8");
    fsControl.events.length = 0;
    fsControl.failTempSync = true;

    await expect(
      writeReceiptAtomically(makeReceipt("receipt-fsync-failure"), receiptPath),
    ).rejects.toThrow("injected temp fsync failure");

    expect(await readFile(receiptPath, "utf8")).toBe(published);
    expect(await temporaryReceiptNames(directory, receiptPath)).toEqual([]);
    expect(fsControl.events).toEqual([
      "temp:open",
      "temp:write",
      "temp:sync:failed",
      "temp:close",
    ]);
  });
});

async function temporaryReceiptNames(directory: string, receiptPath: string): Promise<string[]> {
  const prefix = `${basename(receiptPath)}.tmp.`;
  return (await readdir(directory)).filter((name) => name.startsWith(prefix));
}
