import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type {
  CalyxIndeterminateReceipt,
  CalyxRecoveryStore,
} from "@polli-labs/calyx-client/admin";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const ENVELOPE_SCHEMA = "calyx.client-recovery-envelope/v1" as const;
const ENCRYPTION_ALGORITHM = "AES-256-GCM" as const;
const RECEIPT_FILE_PATTERN = /^receipt-[a-f0-9]{64}\.json$/u;

const RECEIPT_KEYS = new Set([
  "schema_version",
  "payload_sensitivity",
  "integrity_algorithm",
  "integrity_tag",
  "credential_binding",
  "contract_digest",
  "operation_id",
  "method",
  "origin",
  "base_path",
  "path",
  "safe_headers",
  "body_bytes",
  "idempotency_key",
  "attempts",
  "failure_stage",
  "last_http_status",
  "last_request_id",
]);

const ENVELOPE_KEYS = new Set([
  "schema_version",
  "encryption_algorithm",
  "created_at",
  "iv",
  "auth_tag",
  "ciphertext",
]);

interface ClientRecoveryEnvelope {
  readonly schema_version: typeof ENVELOPE_SCHEMA;
  readonly encryption_algorithm: typeof ENCRYPTION_ALGORITHM;
  readonly created_at: string;
  readonly iv: string;
  readonly auth_tag: string;
  readonly ciphertext: string;
}

interface ClientRecoveryPaths {
  readonly root: string;
  readonly keyPath: string;
  readonly receiptsRoot: string;
  readonly protectedDirectories: readonly string[];
}

export interface ClientRecoveryCustodyOptions {
  /** Overrides the private recovery root. Primarily useful for isolated callers and tests. */
  readonly root?: string;
}

export interface ClientRecoveryCustody {
  readonly root: string;
  readonly keyPath: string;
  readonly receiptsRoot: string;
  /** A defensive copy suitable for CalyxClientOptions.recoveryReceiptIntegrityKey. */
  readonly recoveryReceiptIntegrityKey: Uint8Array;
  readonly recoveryStore: CalyxRecoveryStore;
  receiptPath(receipt: CalyxIndeterminateReceipt): string;
  persistReceipt(receipt: CalyxIndeterminateReceipt): Promise<string>;
  readReceipt(path: string): Promise<CalyxIndeterminateReceipt>;
  removeReceipt(path: string): Promise<void>;
}

export class ClientRecoveryCustodyError extends Error {
  override readonly name = "ClientRecoveryCustodyError";
}

function recoveryPaths(options: ClientRecoveryCustodyOptions): ClientRecoveryPaths {
  if (options.root) {
    const root = resolvePath(options.root);
    return {
      root,
      keyPath: join(root, "recovery-integrity.key"),
      receiptsRoot: join(root, "receipts"),
      protectedDirectories: [root, join(root, "receipts")],
    };
  }

  const stateHome = process.env["CALYX_STATE_HOME"]?.trim();
  if (stateHome) {
    const protectedStateHome = resolvePath(stateHome);
    const recoveryRoot = join(protectedStateHome, "recovery");
    const root = join(recoveryRoot, "client");
    return {
      root,
      keyPath: join(root, "recovery-integrity.key"),
      receiptsRoot: join(root, "receipts"),
      protectedDirectories: [
        protectedStateHome,
        recoveryRoot,
        root,
        join(root, "receipts"),
      ],
    };
  }

  const protectedRoot = resolvePath(join(homedir(), ".calyx-recovery"));
  const root = join(protectedRoot, "client");
  return {
    root,
    keyPath: join(root, "recovery-integrity.key"),
    receiptsRoot: join(root, "receipts"),
    protectedDirectories: [protectedRoot, root, join(root, "receipts")],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryTree(path: string): Promise<void> {
  const missing: string[] = [];
  let cursor = resolvePath(path);
  while (true) {
    try {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ClientRecoveryCustodyError(`${cursor} must be a real directory.`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  for (const directory of missing.reverse()) {
    let created = false;
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error;
    }
    if (created) await chmod(directory, PRIVATE_DIRECTORY_MODE);
    await syncDirectory(dirname(directory));
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const currentUid = process.getuid?.();
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (typeof currentUid === "number" && metadata.uid !== currentUid)
    || (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new ClientRecoveryCustodyError(
      `${path} must be a real, current-user-owned mode-0700 directory.`,
    );
  }
}

async function ensurePrivateDirectories(paths: ClientRecoveryPaths): Promise<void> {
  await ensureDirectoryTree(paths.receiptsRoot);
  for (const directory of paths.protectedDirectories) {
    await assertPrivateDirectory(directory);
  }
}

function assertPrivateFileMetadata(path: string, metadata: Stats): void {
  const currentUid = process.getuid?.();
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (typeof currentUid === "number" && metadata.uid !== currentUid)
    || (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
  ) {
    throw new ClientRecoveryCustodyError(
      `${path} must be a regular, current-user-owned mode-0600 file.`,
    );
  }
}

async function readProtectedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  assertPrivateFileMetadata(path, before);
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    assertPrivateFileMetadata(path, opened);
    if (!sameFileIdentity(before, opened)) {
      throw new ClientRecoveryCustodyError(`${path} changed before it could be opened.`);
    }
    if (opened.size > maximumBytes) {
      throw new ClientRecoveryCustodyError(`${path} exceeds the protected-file size bound.`);
    }
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (after.isSymbolicLink() || !sameFileIdentity(opened, after)) {
      throw new ClientRecoveryCustodyError(`${path} changed while it was being read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function createRecoveryKey(paths: ClientRecoveryPaths): Promise<Uint8Array> {
  const temporaryPath = join(paths.root, `.recovery-integrity-${randomUUID()}.tmp`);
  let createdTemporary = false;
  try {
    const key = randomBytes(KEY_BYTES);
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    createdTemporary = true;
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // A hard link publishes the fully synced key without replacing a winner
      // created by another process racing to initialize the same custody root.
      await link(temporaryPath, paths.keyPath);
      await syncDirectory(paths.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (createdTemporary) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await syncDirectory(paths.root).catch(() => undefined);
    }
  }

  return readRecoveryKey(paths.keyPath);
}

async function readRecoveryKey(path: string): Promise<Uint8Array> {
  const key = await readProtectedFile(path, KEY_BYTES);
  if (key.byteLength !== KEY_BYTES) {
    throw new ClientRecoveryCustodyError(`Recovery integrity key ${path} must contain exactly ${KEY_BYTES} bytes.`);
  }
  return Uint8Array.from(key);
}

async function loadOrCreateRecoveryKey(paths: ClientRecoveryPaths): Promise<Uint8Array> {
  try {
    return await readRecoveryKey(paths.keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createRecoveryKey(paths);
  }
}

function canonicalBase64Url(value: unknown, name: string, byteLength?: number): Buffer {
  if (typeof value !== "string") {
    throw new ClientRecoveryCustodyError(`${name} must be a base64url string.`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (byteLength !== undefined && bytes.byteLength !== byteLength)) {
    throw new ClientRecoveryCustodyError(`${name} is not canonical base64url data.`);
  }
  return bytes;
}

function validatedReceipt(value: unknown): CalyxIndeterminateReceipt {
  if (!isRecord(value) || Object.keys(value).some((key) => !RECEIPT_KEYS.has(key))) {
    throw new ClientRecoveryCustodyError("Recovery receipt has an invalid runtime shape.");
  }
  const safeHeaders = value["safe_headers"];
  if (
    value["schema_version"] !== "calyx.client-indeterminate-result/v1"
    || value["payload_sensitivity"] !== "sensitive_request_payload"
    || value["integrity_algorithm"] !== "HMAC-SHA-256"
    || typeof value["integrity_tag"] !== "string"
    || typeof value["credential_binding"] !== "string"
    || typeof value["contract_digest"] !== "string"
    || typeof value["operation_id"] !== "string"
    || typeof value["method"] !== "string"
    || typeof value["origin"] !== "string"
    || typeof value["base_path"] !== "string"
    || typeof value["path"] !== "string"
    || !isRecord(safeHeaders)
    || Object.values(safeHeaders).some((header) => typeof header !== "string")
    || typeof value["body_bytes"] !== "string"
    || typeof value["idempotency_key"] !== "string"
    || !Number.isSafeInteger(value["attempts"])
    || (value["attempts"] as number) < 0
    || typeof value["failure_stage"] !== "string"
    || (value["last_http_status"] !== undefined && !Number.isSafeInteger(value["last_http_status"]))
    || (value["last_request_id"] !== undefined && typeof value["last_request_id"] !== "string")
    || ((value["last_http_status"] === undefined) !== (value["last_request_id"] === undefined))
  ) {
    throw new ClientRecoveryCustodyError("Recovery receipt has an invalid runtime shape.");
  }

  return Object.freeze({
    schema_version: value["schema_version"],
    payload_sensitivity: value["payload_sensitivity"],
    integrity_algorithm: value["integrity_algorithm"],
    integrity_tag: value["integrity_tag"],
    credential_binding: value["credential_binding"],
    contract_digest: value["contract_digest"],
    operation_id: value["operation_id"],
    method: value["method"],
    origin: value["origin"],
    base_path: value["base_path"],
    path: value["path"],
    safe_headers: Object.freeze({ ...safeHeaders }) as Readonly<Record<string, string>>,
    body_bytes: value["body_bytes"],
    idempotency_key: value["idempotency_key"],
    attempts: value["attempts"] as number,
    failure_stage: value["failure_stage"],
    ...(value["last_http_status"] !== undefined ? {
      last_http_status: value["last_http_status"] as number,
      last_request_id: value["last_request_id"] as string,
    } : {}),
  });
}

function serializeReceipt(receipt: CalyxIndeterminateReceipt): Buffer {
  return Buffer.from(JSON.stringify(validatedReceipt(receipt)), "utf8");
}

function parseEnvelope(bytes: Buffer): ClientRecoveryEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ClientRecoveryCustodyError("Recovery receipt envelope is not valid JSON.");
  }
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))
    || value["schema_version"] !== ENVELOPE_SCHEMA
    || value["encryption_algorithm"] !== ENCRYPTION_ALGORITHM
    || typeof value["created_at"] !== "string"
    || typeof value["iv"] !== "string"
    || typeof value["auth_tag"] !== "string"
    || typeof value["ciphertext"] !== "string"
  ) {
    throw new ClientRecoveryCustodyError("Recovery receipt envelope has an invalid runtime shape.");
  }
  return {
    schema_version: value["schema_version"],
    encryption_algorithm: value["encryption_algorithm"],
    created_at: value["created_at"],
    iv: value["iv"],
    auth_tag: value["auth_tag"],
    ciphertext: value["ciphertext"],
  };
}

function envelopeAad(envelope: Pick<ClientRecoveryEnvelope, "schema_version" | "encryption_algorithm" | "created_at">): Buffer {
  return Buffer.from(JSON.stringify([
    envelope.schema_version,
    envelope.encryption_algorithm,
    envelope.created_at,
  ]), "utf8");
}

function envelopeEncryptionKey(recoveryIntegrityKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    recoveryIntegrityKey,
    Buffer.alloc(0),
    "calyx.client-recovery-envelope-aes-256-gcm/v1",
    KEY_BYTES,
  ));
}

function encryptReceipt(receipt: CalyxIndeterminateReceipt, key: Uint8Array): ClientRecoveryEnvelope {
  const iv = randomBytes(IV_BYTES);
  const metadata = {
    schema_version: ENVELOPE_SCHEMA,
    encryption_algorithm: ENCRYPTION_ALGORITHM,
    created_at: new Date().toISOString(),
  } as const;
  const cipher = createCipheriv("aes-256-gcm", envelopeEncryptionKey(key), iv);
  cipher.setAAD(envelopeAad(metadata));
  const ciphertext = Buffer.concat([cipher.update(serializeReceipt(receipt)), cipher.final()]);
  return {
    ...metadata,
    iv: iv.toString("base64url"),
    auth_tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptReceipt(envelope: ClientRecoveryEnvelope, key: Uint8Array): CalyxIndeterminateReceipt {
  const iv = canonicalBase64Url(envelope.iv, "Recovery envelope IV", IV_BYTES);
  const authTag = canonicalBase64Url(envelope.auth_tag, "Recovery envelope authentication tag", AUTH_TAG_BYTES);
  const ciphertext = canonicalBase64Url(envelope.ciphertext, "Recovery envelope ciphertext");
  try {
    const decipher = createDecipheriv("aes-256-gcm", envelopeEncryptionKey(key), iv);
    decipher.setAAD(envelopeAad(envelope));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validatedReceipt(JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof ClientRecoveryCustodyError) throw error;
    throw new ClientRecoveryCustodyError("Recovery receipt could not be authenticated and decrypted.");
  }
}

function receiptDigest(receipt: CalyxIndeterminateReceipt): string {
  const value = validatedReceipt(receipt);
  // Failure stage, attempt count, response authority, and the receipt HMAC can
  // advance after dispatch. Keep one stable custody slot for the exact replay
  // identity so a pre-dispatch reservation remains usable if finalization
  // later fails.
  const replayIdentity = {
    schema_version: value.schema_version,
    payload_sensitivity: value.payload_sensitivity,
    credential_binding: value.credential_binding,
    contract_digest: value.contract_digest,
    operation_id: value.operation_id,
    method: value.method,
    origin: value.origin,
    base_path: value.base_path,
    path: value.path,
    safe_headers: Object.fromEntries(Object.entries(value.safe_headers).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))),
    body_bytes: value.body_bytes,
    idempotency_key: value.idempotency_key,
  };
  return createHash("sha256").update(JSON.stringify(replayIdentity)).digest("hex");
}

function receiptPath(paths: ClientRecoveryPaths, receipt: CalyxIndeterminateReceipt): string {
  return join(paths.receiptsRoot, `receipt-${receiptDigest(receipt)}.json`);
}

function assertManagedReceiptPath(paths: ClientRecoveryPaths, path: string): string {
  const resolved = resolvePath(path);
  if (dirname(resolved) !== paths.receiptsRoot || !RECEIPT_FILE_PATTERN.test(resolved.slice(paths.receiptsRoot.length + 1))) {
    throw new ClientRecoveryCustodyError(`Receipt must be a direct managed child of ${paths.receiptsRoot}.`);
  }
  return resolved;
}

async function persistReceipt(
  paths: ClientRecoveryPaths,
  key: Uint8Array,
  receipt: CalyxIndeterminateReceipt,
): Promise<string> {
  await ensurePrivateDirectories(paths);
  const targetPath = receiptPath(paths, receipt);
  const temporaryPath = join(paths.receiptsRoot, `.receipt-${randomUUID()}.tmp`);
  const envelope = encryptReceipt(receipt, key);
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  let createdTemporary = false;
  try {
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    createdTemporary = true;
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
    createdTemporary = false;
    await syncDirectory(paths.receiptsRoot);
  } catch (error) {
    if (createdTemporary) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await syncDirectory(paths.receiptsRoot).catch(() => undefined);
    }
    throw error;
  }
  return targetPath;
}

async function readReceipt(
  paths: ClientRecoveryPaths,
  key: Uint8Array,
  path: string,
): Promise<CalyxIndeterminateReceipt> {
  await ensurePrivateDirectories(paths);
  const managedPath = assertManagedReceiptPath(paths, path);
  const bytes = await readProtectedFile(managedPath, MAX_ENVELOPE_BYTES);
  return decryptReceipt(parseEnvelope(bytes), key);
}

async function removeReceipt(paths: ClientRecoveryPaths, path: string): Promise<void> {
  await ensurePrivateDirectories(paths);
  const managedPath = assertManagedReceiptPath(paths, path);
  try {
    const metadata = await lstat(managedPath);
    assertPrivateFileMetadata(managedPath, metadata);
    await unlink(managedPath);
    await syncDirectory(paths.receiptsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Opens the CLI's durable, encrypted custody boundary for generated-client recovery receipts. */
export async function openClientRecoveryCustody(
  options: ClientRecoveryCustodyOptions = {},
): Promise<ClientRecoveryCustody> {
  const paths = recoveryPaths(options);
  try {
    await ensurePrivateDirectories(paths);
    const key = await loadOrCreateRecoveryKey(paths);
    const recoveryStore: CalyxRecoveryStore = Object.freeze({
      custody: "encrypted_access_controlled",
      reserve: async (receipt: CalyxIndeterminateReceipt) => {
        await persistReceipt(paths, key, receipt);
      },
      save: async (receipt: CalyxIndeterminateReceipt) => {
        await persistReceipt(paths, key, receipt);
      },
      release: async (receipt: CalyxIndeterminateReceipt) => {
        await removeReceipt(paths, receiptPath(paths, receipt));
      },
    });
    return Object.freeze({
      root: paths.root,
      keyPath: paths.keyPath,
      receiptsRoot: paths.receiptsRoot,
      get recoveryReceiptIntegrityKey() {
        return Uint8Array.from(key);
      },
      recoveryStore,
      receiptPath: (receipt: CalyxIndeterminateReceipt) => receiptPath(paths, receipt),
      persistReceipt: (receipt: CalyxIndeterminateReceipt) => persistReceipt(paths, key, receipt),
      readReceipt: (path: string) => readReceipt(paths, key, path),
      removeReceipt: (path: string) => removeReceipt(paths, path),
    });
  } catch (error) {
    if (error instanceof ClientRecoveryCustodyError) throw error;
    throw new ClientRecoveryCustodyError(
      `Cannot open client recovery custody at ${paths.root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
