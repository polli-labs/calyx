import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CalyxIndeterminateReceipt } from "@polli-labs/calyx-client/admin";
import { afterEach, describe, expect, test, vi } from "vitest";

import { openClientRecoveryCustody } from "../client-recovery-custody.js";
import { buildProgram } from "../run-cli.js";

const roots: string[] = [];

function fixtureReceipt(): CalyxIndeterminateReceipt {
  return Object.freeze({
    schema_version: "calyx.client-indeterminate-result/v1",
    payload_sensitivity: "sensitive_request_payload",
    integrity_algorithm: "HMAC-SHA-256",
    integrity_tag: Buffer.alloc(32, 1).toString("base64url"),
    credential_binding: Buffer.alloc(32, 2).toString("base64url"),
    contract_digest: "sha256:fixture-contract",
    operation_id: "admin.lease.acquire",
    method: "POST",
    origin: "https://blade.example",
    base_path: "/control",
    path: "/control/v1/admin/leases/acquire",
    safe_headers: Object.freeze({ "Content-Type": "application/json" }),
    body_bytes: Buffer.from(JSON.stringify({ idempotency_key: "fixture-replay" })).toString("base64"),
    idempotency_key: "fixture-replay",
    attempts: 2,
    failure_stage: "network",
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("client replay command", () => {
  test("replays any managed generated receipt and removes it only after a definitive result", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-client-replay-command-"));
    roots.push(root);
    const custody = await openClientRecoveryCustody({ root: join(root, "custody") });
    const receipt = fixtureReceipt();
    const artifactPath = await custody.persistReceipt(receipt);
    const replayIndeterminate = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { replayed: true },
      requestId: "req_00000000-0000-4000-8000-000000000001",
      attempts: 1,
    }));
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = buildProgram({
      runCli: {
        openRecoveryCustody: async () => custody,
        createAdminClient: (() => ({ replayIndeterminate })) as never,
      },
    });

    await program.parseAsync([
      "node",
      "calyx",
      "client",
      "replay",
      artifactPath,
      "--auth-token",
      "fixture-token",
    ]);

    expect(replayIndeterminate).toHaveBeenCalledWith(receipt);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toEqual({
      schema_version: "calyx.client-replay-result/v1",
      operation_id: "admin.lease.acquire",
      result: { replayed: true },
    });
    await expect(lstat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retains the original receipt when replay has no server-authoritative result", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-client-replay-retained-"));
    roots.push(root);
    const custody = await openClientRecoveryCustody({ root: join(root, "custody") });
    const receipt = fixtureReceipt();
    const artifactPath = await custody.persistReceipt(receipt);
    const replayIndeterminate = vi.fn(async () => ({
      ok: false as const,
      kind: "transport" as const,
      stage: "network" as const,
      message: "fixture replay connection loss",
      attempts: 1,
    }));
    const program = buildProgram({
      runCli: {
        openRecoveryCustody: async () => custody,
        createAdminClient: (() => ({ replayIndeterminate })) as never,
      },
    });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "client",
      "replay",
      artifactPath,
      "--auth-token",
      "fixture-token",
    ])).rejects.toMatchObject({ exitCode: 6 });

    expect(replayIndeterminate).toHaveBeenCalledWith(receipt);
    await expect(lstat(artifactPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });
});
