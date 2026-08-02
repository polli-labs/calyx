import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CalyxIndeterminateReceipt } from "@polli-labs/calyx-client/admin";
import { afterEach, describe, expect, it } from "vitest";

import {
  ClientRecoveryCustodyError,
  openClientRecoveryCustody,
} from "../client-recovery-custody.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calyx-client-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const requestPayload = JSON.stringify({
  secret: "never-write-this-request-in-plaintext",
  idempotency_key: "recovery-idempotency-key",
});

const receipt: CalyxIndeterminateReceipt = Object.freeze({
  schema_version: "calyx.client-indeterminate-result/v1",
  payload_sensitivity: "sensitive_request_payload",
  integrity_algorithm: "HMAC-SHA-256",
  integrity_tag: Buffer.alloc(32, 1).toString("base64url"),
  credential_binding: Buffer.alloc(32, 2).toString("base64url"),
  contract_digest: "sha256:generated-operation-contract",
  operation_id: "admin.msg.send",
  method: "POST",
  origin: "https://calyx.example",
  base_path: "/control",
  path: "/control/v1/admin/msg/send",
  safe_headers: Object.freeze({
    "Content-Type": "application/json",
  }),
  body_bytes: Buffer.from(requestPayload, "utf8").toString("base64"),
  idempotency_key: "recovery-idempotency-key",
  attempts: 4,
  failure_stage: "network",
  last_http_status: 503,
  last_request_id: "req_recovery_01",
});

function mode(metadata: { readonly mode: number }): number {
  return metadata.mode & 0o777;
}

function mutateBase64Url(value: string): string {
  const index = Math.floor(value.length / 2);
  const replacement = value[index] === "A" ? "B" : "A";
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe("client recovery custody", () => {
  it("atomically creates one private 32-byte key across concurrent openers", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "custody");

    const [left, right] = await Promise.all([
      openClientRecoveryCustody({ root }),
      openClientRecoveryCustody({ root }),
    ]);

    expect(left.recoveryReceiptIntegrityKey).toHaveLength(32);
    expect(Buffer.from(left.recoveryReceiptIntegrityKey)).toEqual(
      Buffer.from(right.recoveryReceiptIntegrityKey),
    );
    expect(mode(await lstat(left.root))).toBe(0o700);
    expect(mode(await lstat(left.receiptsRoot))).toBe(0o700);
    expect(mode(await lstat(left.keyPath))).toBe(0o600);
    expect(await readFile(left.keyPath)).toHaveLength(32);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);

    const callerCopy = left.recoveryReceiptIntegrityKey;
    callerCopy.fill(0);
    expect(Buffer.from(right.recoveryReceiptIntegrityKey).equals(Buffer.alloc(32))).toBe(false);
  });

  it("round-trips an exact receipt through the generated-client store without plaintext at rest", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });

    await custody.recoveryStore.save(receipt);
    const path = custody.receiptPath(receipt);
    const envelopeText = await readFile(path, "utf8");

    expect(mode(await lstat(path))).toBe(0o600);
    expect(envelopeText).toContain("calyx.client-recovery-envelope/v1");
    expect(envelopeText).not.toContain(requestPayload);
    expect(envelopeText).not.toContain(receipt.body_bytes);
    expect(envelopeText).not.toContain(receipt.idempotency_key);
    expect(envelopeText).not.toContain(receipt.integrity_tag);
    await expect(custody.readReceipt(path)).resolves.toEqual(receipt);
    expect(Object.isFrozen(await custody.readReceipt(path))).toBe(true);
  });

  it("keeps one stable encrypted slot from pre-dispatch reservation through final indeterminate metadata", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });
    const stableReceipt = Object.fromEntries(Object.entries(receipt).filter(([key]) => (
      key !== "last_http_status" && key !== "last_request_id"
    )));
    const reserved = Object.freeze({
      ...stableReceipt,
      attempts: 0,
      failure_stage: "reserved_before_dispatch",
    }) as CalyxIndeterminateReceipt;

    expect(custody.receiptPath(reserved)).toBe(custody.receiptPath(receipt));
    await custody.recoveryStore.reserve?.(reserved);
    const path = custody.receiptPath(reserved);
    await expect(custody.readReceipt(path)).resolves.toEqual(reserved);

    await custody.recoveryStore.save(receipt);
    await expect(custody.readReceipt(path)).resolves.toEqual(receipt);
    await custody.recoveryStore.release?.(receipt);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ciphertext and authenticated-metadata tampering", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });
    const path = await custody.persistReceipt(receipt);
    const envelope = JSON.parse(await readFile(path, "utf8")) as {
      created_at: string;
      ciphertext: string;
    };

    envelope.ciphertext = mutateBase64Url(envelope.ciphertext);
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
    await expect(custody.readReceipt(path)).rejects.toThrow(/authenticated and decrypted/u);

    await custody.persistReceipt(receipt);
    const metadataTamper = JSON.parse(await readFile(path, "utf8")) as {
      created_at: string;
      ciphertext: string;
    };
    metadataTamper.created_at = "2099-01-01T00:00:00.000Z";
    await writeFile(path, `${JSON.stringify(metadataTamper)}\n`, "utf8");
    await expect(custody.readReceipt(path)).rejects.toThrow(/authenticated and decrypted/u);
  });

  it("rejects a receipt after the protected key is replaced", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "custody");
    const original = await openClientRecoveryCustody({ root });
    const path = await original.persistReceipt(receipt);

    await writeFile(original.keyPath, Buffer.alloc(32, 9));
    const wrongKey = await openClientRecoveryCustody({ root });

    expect(Buffer.from(wrongKey.recoveryReceiptIntegrityKey)).toEqual(Buffer.alloc(32, 9));
    await expect(wrongKey.readReceipt(path)).rejects.toThrow(/authenticated and decrypted/u);
  });

  it("refuses symlinked and non-private protected files", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "custody");
    const custody = await openClientRecoveryCustody({ root });
    const path = await custody.persistReceipt(receipt);

    await chmod(path, 0o644);
    await expect(custody.readReceipt(path)).rejects.toThrow(/mode-0600/u);

    await chmod(path, 0o600);
    const external = join(parent, "external.json");
    await writeFile(external, await readFile(path), { mode: 0o600 });
    await rm(path);
    await symlink(external, path);
    await expect(custody.readReceipt(path)).rejects.toThrow(/mode-0600/u);
  });

  it("refuses a symlinked or permissive recovery integrity key", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "custody");
    const custody = await openClientRecoveryCustody({ root });

    await chmod(custody.keyPath, 0o644);
    await expect(openClientRecoveryCustody({ root })).rejects.toThrow(/mode-0600/u);

    await chmod(custody.keyPath, 0o600);
    const externalKey = join(parent, "external.key");
    await writeFile(externalKey, Buffer.alloc(32, 7), { mode: 0o600 });
    await rm(custody.keyPath);
    await symlink(externalKey, custody.keyPath);
    await expect(openClientRecoveryCustody({ root })).rejects.toThrow(/mode-0600/u);
  });

  it("refuses a recovery root that is not private", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "custody");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o755);

    await expect(openClientRecoveryCustody({ root })).rejects.toThrow(/mode-0700/u);
  });

  it("never adopts partial temp files and atomically replaces an interrupted final envelope", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });
    const partialTemp = join(custody.receiptsRoot, ".receipt-interrupted.tmp");
    await writeFile(partialTemp, "{\"schema_version\":", { mode: 0o600 });

    await expect(custody.readReceipt(partialTemp)).rejects.toThrow(/direct managed child/u);

    const path = custody.receiptPath(receipt);
    await writeFile(path, "{\"schema_version\":", { mode: 0o600 });
    await expect(custody.readReceipt(path)).rejects.toThrow(/not valid JSON/u);
    await expect(custody.persistReceipt(receipt)).resolves.toBe(path);
    await expect(custody.readReceipt(path)).resolves.toEqual(receipt);
    expect((await readdir(custody.receiptsRoot)).filter((name) => (
      name.endsWith(".tmp") && name !== ".receipt-interrupted.tmp"
    ))).toEqual([]);
  });

  it("deletes only a managed receipt and makes cleanup idempotent", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });
    const path = await custody.persistReceipt(receipt);

    await custody.removeReceipt(path);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(custody.removeReceipt(path)).resolves.toBeUndefined();
    await expect(custody.removeReceipt(join(parent, "not-managed.json"))).rejects.toThrow(
      /direct managed child/u,
    );
  });

  it("rejects non-exact receipt objects before encryption", async () => {
    const parent = await temporaryRoot();
    const custody = await openClientRecoveryCustody({ root: join(parent, "custody") });
    const withUnknownAuthority = {
      ...receipt,
      raw_authorization: "Bearer must-never-be-persisted",
    } as unknown as CalyxIndeterminateReceipt;

    await expect(custody.persistReceipt(withUnknownAuthority)).rejects.toBeInstanceOf(
      ClientRecoveryCustodyError,
    );
    expect(await readdir(custody.receiptsRoot)).toEqual([]);
  });
});
