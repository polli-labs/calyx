import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES,
  openPrivateDirectoryDurable,
  type DurableDirectoryAuthority,
  type DurableDirectoryOpenOptions,
} from "@polli-labs/calyx-core";

export const SELF_UPGRADE_RECEIPT_DIRECTORY_MODE = 0o700;
export const SELF_UPGRADE_RECEIPT_FILE_MODE = 0o600;
export const SELF_UPGRADE_RECEIPT_STALE_TEMP_MS = 24 * 60 * 60 * 1_000;
export const SELF_UPGRADE_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const SELF_UPGRADE_RECEIPT_RETENTION_COUNT = 256;
export const SELF_UPGRADE_RECEIPT_MAX_BYTES = CALYX_SELF_UPGRADE_RECEIPT_MAX_BYTES;

const OPERATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254})$/u;

export interface WriteSelfUpgradeReceiptOptions {
  nowMs?: number;
  staleTempMs?: number;
  retentionMs?: number;
  retentionCount?: number;
  /** Deterministic held-cwd portability seam. */
  directoryOpenOptions?: DurableDirectoryOpenOptions;
  /** Deterministic race-test seam after the canonical root descriptor is held. */
  afterRootAnchored?: () => Promise<void>;
  /** Deterministic race seam after validation but before retention mutation. */
  afterRootValidatedBeforeRetention?: () => Promise<void>;
}

export function defaultSelfUpgradeReceiptRoot(homeDir: string): string {
  return path.join(homeDir, ".calyx", "self-upgrade-receipts");
}

export function assertSelfUpgradeReceiptOperationId(operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId) || operationId === "." || operationId === "..") {
    throw new Error(`Invalid self-upgrade receipt operation id: ${operationId}`);
  }
  return operationId;
}

export function selfUpgradeReceiptPath(root: string, operationId: string): string {
  return path.join(root, `${assertSelfUpgradeReceiptOperationId(operationId)}.json`);
}

async function sweepStaleReceiptTemps(
  authority: DurableDirectoryAuthority,
  nowMs: number,
  staleTempMs: number,
): Promise<boolean> {
  let removed = false;
  for (const entry of await authority.readdir()) {
    if (entry.kind !== "file" || !/\.json\..+\.tmp$/u.test(entry.name)) {
      continue;
    }
    const metadata = await authority.lstat(entry.name);
    if (nowMs - metadata.mtimeMs < staleTempMs) {
      continue;
    }
    await authority.remove(entry.name, { force: true });
    removed = true;
  }
  return removed;
}

async function pruneHostReceipts(
  authority: DurableDirectoryAuthority,
  currentOperationId: string,
  nowMs: number,
  retentionMs: number,
  retentionCount: number,
): Promise<boolean> {
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const entry of await authority.readdir()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) {
      continue;
    }
    const operationId = entry.name.slice(0, -".json".length);
    if (operationId === currentOperationId) {
      continue;
    }
    try {
      const parsed = JSON.parse(await authority.readFile(
        entry.name,
        SELF_UPGRADE_RECEIPT_MAX_BYTES,
      )) as {
        schema_version?: unknown;
        status?: unknown;
      };
      if (
        parsed.schema_version !== "self-upgrade-receipt/v1"
        || (parsed.status !== "succeeded" && parsed.status !== "failed")
      ) {
        continue;
      }
      candidates.push({ name: entry.name, mtimeMs: (await authority.lstat(entry.name)).mtimeMs });
    } catch {
      // Unreadable authority is never pruned automatically.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  let removed = false;
  const retainedPrevious = Math.max(0, retentionCount - 1);
  for (const [index, candidate] of candidates.entries()) {
    if (nowMs - candidate.mtimeMs < retentionMs && index < retainedPrevious) {
      continue;
    }
    await authority.remove(candidate.name, { force: true });
    removed = true;
  }
  return removed;
}

/**
 * Crash-durably replace one host-owned final receipt. The self-upgrade lock is
 * the single-writer gate; UUID operation identity prevents cross-operation
 * collision. Same-directory temporary promotion plus file/root synchronization
 * makes a returned path authoritative after a process or host crash.
 */
export async function writeSelfUpgradeReceiptDurable(
  root: string,
  operationId: string,
  contents: string,
  options: WriteSelfUpgradeReceiptOptions = {},
): Promise<string> {
  assertSelfUpgradeReceiptOperationId(operationId);
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > SELF_UPGRADE_RECEIPT_MAX_BYTES) {
    throw new Error(`Self-upgrade receipt exceeds ${SELF_UPGRADE_RECEIPT_MAX_BYTES} bytes.`);
  }
  const nowMs = options.nowMs ?? Date.now();
  const anchor = await openPrivateDirectoryDurable(
    root,
    SELF_UPGRADE_RECEIPT_DIRECTORY_MODE,
    options.directoryOpenOptions,
  );
  const targetPath = selfUpgradeReceiptPath(anchor.directory, operationId);
  const targetName = `${operationId}.json`;
  const temporaryName = `${targetName}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await options.afterRootAnchored?.();
    await anchor.assertCanonical();
    await options.afterRootValidatedBeforeRetention?.();
    const sweptTemps = await sweepStaleReceiptTemps(
      anchor.authority,
      nowMs,
      options.staleTempMs ?? SELF_UPGRADE_RECEIPT_STALE_TEMP_MS,
    );
    const prunedReceipts = await pruneHostReceipts(
      anchor.authority,
      operationId,
      nowMs,
      options.retentionMs ?? SELF_UPGRADE_RECEIPT_RETENTION_MS,
      options.retentionCount ?? SELF_UPGRADE_RECEIPT_RETENTION_COUNT,
    );
    if (sweptTemps || prunedReceipts) await anchor.sync();
    await anchor.assertCanonical();
    await anchor.authority.replaceFile(
      targetName,
      temporaryName,
      contents,
      SELF_UPGRADE_RECEIPT_FILE_MODE,
    );
    await anchor.assertCanonical();
    return targetPath;
  } finally {
    await anchor.close().catch(() => undefined);
  }
}
