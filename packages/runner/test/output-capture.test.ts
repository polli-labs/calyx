import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  materializeRunOutputCapture,
  RunOutputCaptureError,
} from "../src/output-capture.js";
import type { RunOutputCapture } from "../src/types.js";

function capture(overrides: Partial<RunOutputCapture> = {}): RunOutputCapture {
  return {
    name: "proposal.json",
    source: "agent_terminal_message",
    media_type: "application/json",
    schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        count: { type: "integer" },
      },
      required: ["answer", "count"],
      additionalProperties: false,
    },
    max_bytes: 1024,
    required: true,
    ...overrides,
  };
}

async function expectCaptureError(
  promise: Promise<unknown>,
  failureKind: RunOutputCaptureError["failure_kind"],
): Promise<RunOutputCaptureError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RunOutputCaptureError);
    expect((error as RunOutputCaptureError).failure_kind).toBe(failureKind);
    return error as RunOutputCaptureError;
  }
  throw new Error("Expected output capture to fail.");
}

describe("materializeRunOutputCapture", () => {
  let root: string;
  let runDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calyx-output-capture-"));
    runDir = join(root, "run");
    await mkdir(runDir);
  });

  afterEach(async () => {
    await chmod(runDir, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("publishes canonical JSON with exact bytes, SHA-256, and mode 0600", async () => {
    const canonical = '{"answer":"yes","count":2}';
    const artifact = await materializeRunOutputCapture({
      run_id: "run-canonical",
      run_dir: runDir,
      capture: capture(),
      terminal_message: ' { "count" : 2, "answer" : "yes" }\n',
      now: () => "2026-07-21T18:00:00.000Z",
    });

    expect(artifact).toEqual({
      name: "proposal.json",
      location: "run_dir",
      path: join(await realpath(runDir), "proposal.json"),
      size_bytes: Buffer.byteLength(canonical),
      sha256: createHash("sha256").update(canonical).digest("hex"),
      required: true,
      detected_at: "2026-07-21T18:00:00.000Z",
    });
    expect(await readFile(artifact.path, "utf8")).toBe(canonical);
    expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(runDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves __proto__, constructor, and prototype as ordinary JSON members", async () => {
    const canonical = '{"__proto__":{"polluted":true},"constructor":"owned","prototype":"plain"}';
    const artifact = await materializeRunOutputCapture({
      run_id: "run-special-object-keys",
      run_dir: runDir,
      capture: capture({
        schema: {
          type: "object",
          required: ["__proto__", "constructor", "prototype"],
          additionalProperties: true,
        },
      }),
      terminal_message: '{"prototype":"plain","__proto__":{"polluted":true},"constructor":"owned"}',
    });

    expect(await readFile(artifact.path, "utf8")).toBe(canonical);
    expect(artifact.size_bytes).toBe(Buffer.byteLength(canonical));
    expect(artifact.sha256).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("publishes with atomic no-replace semantics under concurrent writers", async () => {
    const attempts = await Promise.allSettled([
      materializeRunOutputCapture({
        run_id: "run-race-a",
        run_dir: runDir,
        capture: capture(),
        terminal_message: '{"answer":"first","count":1}',
      }),
      materializeRunOutputCapture({
        run_id: "run-race-b",
        run_dir: runDir,
        capture: capture(),
        terminal_message: '{"answer":"second","count":2}',
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ failure_kind: "materialization_failed" }),
    });
    expect([
      '{"answer":"first","count":1}',
      '{"answer":"second","count":2}',
    ]).toContain(await readFile(join(runDir, "proposal.json"), "utf8"));
    expect((await readdir(runDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["missing terminal message", undefined],
    ["empty terminal message", " \n\t"],
    ["malformed JSON", '{"answer":'],
    ["duplicate object key", '{"answer":"first","answer":"second","count":2}'],
    ["schema-invalid JSON", '{"answer":"yes","count":"two"}'],
  ])("fails closed for %s", async (_label, terminalMessage) => {
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-invalid",
        run_dir: runDir,
        capture: capture(),
        terminal_message: terminalMessage,
      }),
      "invalid_output",
    );

    expect(error.message).not.toBe("");
    await expect(lstat(join(runDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects raw output over the declared byte limit without publishing a file", async () => {
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-oversize",
        run_dir: runDir,
        capture: capture({ max_bytes: 20 }),
        terminal_message: '{"answer":"far too long","count":2}',
      }),
      "invalid_output",
    );

    expect(error.message).toContain("limit is 20");
    await expect(lstat(join(runDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["absolute", "/tmp/proposal.json"],
    ["traversal", "../proposal.json"],
    ["nested", "nested/proposal.json"],
    ["backslash", "nested\\proposal.json"],
    ["dot", "."],
    ["dot-dot", ".."],
  ])("rejects an unsafe %s capture name", async (_label, name) => {
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-unsafe-name",
        run_dir: runDir,
        capture: capture({ name }),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("safe basename");
  });

  it("rejects a symlinked run root and does not write through it", async () => {
    const realRunDir = join(root, "real-run");
    const linkedRunDir = join(root, "linked-run");
    await mkdir(realRunDir);
    await symlink(realRunDir, linkedRunDir);

    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-symlink-root",
        run_dir: linkedRunDir,
        capture: capture(),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("not a symlink");
    await expect(lstat(join(realRunDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink target and preserves the file outside the run root", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside-owned", { mode: 0o600 });
    await symlink(outside, join(runDir, "proposal.json"));

    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-symlink-target",
        run_dir: runDir,
        capture: capture(),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("already exists");
    expect(await readFile(outside, "utf8")).toBe("outside-owned");
    expect((await lstat(join(runDir, "proposal.json"))).isSymbolicLink()).toBe(true);
  });

  it("rejects an existing regular target without overwriting it", async () => {
    const target = join(runDir, "proposal.json");
    await writeFile(target, "prior-owner", { mode: 0o600 });

    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-existing-target",
        run_dir: runDir,
        capture: capture(),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("already exists");
    expect(await readFile(target, "utf8")).toBe("prior-owner");
  });

  it("classifies an absent run root as a materialization failure", async () => {
    const absent = join(root, "missing", "run");
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-write-failure",
        run_dir: absent,
        capture: capture(),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("Failed to materialize");
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies a filesystem publication failure and cleans its temporary file", async () => {
    const overlongBasename = `${"x".repeat(1024)}.json`;
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-write-failure",
        run_dir: runDir,
        capture: capture({ name: overlongBasename }),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("Failed to materialize");
    expect(await readdir(runDir)).toEqual([]);
  });

  it("classifies an invalid declared schema as a materialization failure", async () => {
    const error = await expectCaptureError(
      materializeRunOutputCapture({
        run_id: "run-invalid-schema",
        run_dir: runDir,
        capture: capture({ schema: { type: "not-a-json-schema-type" } }),
        terminal_message: '{"answer":"yes","count":2}',
      }),
      "materialization_failed",
    );

    expect(error.message).toContain("schema is invalid");
    await expect(lstat(join(runDir, "proposal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
