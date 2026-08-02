import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

interface DirectoryIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface DirectoryLineageIdentity extends DirectoryIdentity {
  path: string;
}

function durableDirectoryError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export type DurableDirectoryEntryKind = "directory" | "file" | "symlink" | "other";

export interface DurableDirectoryEntry {
  name: string;
  kind: DurableDirectoryEntryKind;
}

export interface DurableDirectoryMetadata extends DirectoryIdentity {
  kind: DurableDirectoryEntryKind;
  mode: number;
  mtimeMs: number;
}

export interface DurableDirectoryAuthority {
  /** List a directory relative to the held authority root. */
  readdir: (relativePath?: string) => Promise<DurableDirectoryEntry[]>;
  /** Inspect one entry without following its final component. */
  lstat: (relativePath: string) => Promise<DurableDirectoryMetadata>;
  /** Read one regular file without following its final component. */
  readFile: (relativePath: string, maxBytes?: number) => Promise<string>;
  /** Create, fsync, and retain one new regular file. */
  writeFileExclusive: (relativePath: string, contents: string, mode: number) => Promise<void>;
  /** Crash-durably replace one regular file through a same-directory temp. */
  replaceFile: (
    relativePath: string,
    temporaryRelativePath: string,
    contents: string,
    mode: number,
  ) => Promise<void>;
  mkdir: (relativePath: string, mode: number) => Promise<void>;
  remove: (
    relativePath: string,
    options?: { force?: boolean; recursive?: boolean },
  ) => Promise<void>;
  rename: (fromRelativePath: string, toRelativePath: string) => Promise<void>;
  link: (fromRelativePath: string, toRelativePath: string) => Promise<void>;
}

export interface DurableDirectoryAnchor {
  /** Stable operator-facing pathname. Use `authority` for every child I/O. */
  readonly directory: string;
  /** Child-I/O pathname only when `descriptorBacked` is true. */
  readonly anchoredDirectory?: string;
  /** Whether `anchoredDirectory` traverses children through the held fd. */
  readonly descriptorBacked: boolean;
  /**
   * Mutation-capable relative I/O bound to the held directory itself. On
   * platforms without descriptor-path traversal, a private helper retains the
   * directory as its process cwd; canonical path changes cannot redirect it.
   */
  readonly authority: DurableDirectoryAuthority;
  /** Fail closed if the canonical pathname no longer resolves to the held directory. */
  assertCanonical: () => Promise<void>;
  /** Crash-durably synchronize the held directory itself. */
  sync: () => Promise<void>;
  chmod: (mode: number) => Promise<void>;
  close: () => Promise<void>;
}

export interface DurableDirectoryOpenOptions {
  /** Deterministic portability-test seam; production probes procfs/fdescfs. */
  descriptorPathCandidates?: (fd: number) => readonly string[];
  /** Deterministic child-traversal probe seam; production resolves a named child. */
  descriptorChildTraversalProbe?: (candidate: string) => Promise<boolean>;
  /** Deterministic lifecycle-test seam; production begins authority I/O immediately. */
  authorityOperationGate?: () => Promise<void>;
  /** Deterministic exclusive-create failure seam; production performs no callback. */
  afterExclusiveFileCreated?: (relativePath: string) => Promise<void>;
}

type DirectoryWorkerRequest = {
  id: number;
  op: "link" | "lstat" | "mkdir" | "readFile" | "readdir" | "remove" | "rename"
    | "replaceFile" | "writeFileExclusive";
  path?: string;
  from?: string;
  to?: string;
  temporaryPath?: string;
  contents?: string;
  mode?: number;
  force?: boolean;
  recursive?: boolean;
  maxBytes?: number;
  injectedFailure?: string;
};

type DirectoryWorkerResponse = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message: string };
};

interface DirectoryWorker {
  request: <T>(request: Omit<DirectoryWorkerRequest, "id">) => Promise<T>;
  /** Let an intentionally abandoned bounded operation finish without retaining the CLI. */
  allowProcessExit: () => void;
  close: () => Promise<void>;
}

/**
 * Darwin's fdescfs exposes a held directory at `/dev/fd/<n>` but rejects child
 * lookup. A long-lived helper process gives us the equivalent authority: its
 * cwd is a kernel-held directory reference, so relative I/O continues to hit
 * the captured directory after any lexical ancestor rename or replacement.
 *
 * Keep this worker dependency-free and embedded. Calyx can run from a package
 * install without a separately deployed helper artifact.
 */
const DURABLE_DIRECTORY_WORKER_SOURCE = String.raw`
const fs = require("node:fs");

function safeRelative(value, allowDot) {
  if (typeof value !== "string" || value.includes("\0") || value.startsWith("/")) {
    const error = new Error("Unsafe durable-directory relative path");
    error.code = "EINVAL";
    throw error;
  }
  if (allowDot && value === ".") return value;
  const segments = value.split("/");
  if (segments.length !== 1 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    const error = new Error("Unsafe durable-directory relative path");
    error.code = "EINVAL";
    throw error;
  }
  return value;
}

function kind(metadata) {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  if (metadata.isSymbolicLink()) return "symlink";
  return "other";
}

function metadata(relativePath) {
  const value = fs.lstatSync(safeRelative(relativePath, true));
  return {
    kind: kind(value),
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    dev: value.dev,
    ino: value.ino,
  };
}

function syncCwd() {
  const fd = fs.openSync(".", fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fileTooLarge(maxBytes) {
  const error = new Error("Durable authority file exceeds the bounded read limit of " + maxBytes + " bytes");
  error.code = "EFBIG";
  return error;
}

function readRegularFile(relativePath, maxBytes) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    const error = new Error("Invalid durable authority bounded read limit");
    error.code = "EINVAL";
    throw error;
  }
  const fd = fs.openSync(
    safeRelative(relativePath, false),
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const value = fs.fstatSync(fd);
    if (!value.isFile()) {
      const error = new Error("Durable authority path is not a regular file");
      error.code = "EINVAL";
      throw error;
    }
    if (maxBytes === undefined) return fs.readFileSync(fd, "utf8");
    if (value.size > maxBytes) throw fileTooLarge(maxBytes);
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, maxBytes + 1)));
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const requestedBytes = Math.min(buffer.length, maxBytes + 1 - totalBytes);
      if (requestedBytes === 0) break;
      const bytesRead = fs.readSync(fd, buffer, 0, requestedBytes, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) throw fileTooLarge(maxBytes);
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusive(relativePath, contents, mode, injectedFailure) {
  const target = safeRelative(relativePath, false);
  let created = false;
  let committed = false;
  try {
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    created = true;
    let failure;
    try {
      if (injectedFailure) {
        const error = new Error(injectedFailure);
        error.code = "EIO";
        throw error;
      }
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      failure = error;
    }
    try {
      fs.closeSync(fd);
    } catch (error) {
      failure = failure || error;
    }
    if (failure) throw failure;
    syncCwd();
    committed = true;
  } finally {
    if (created && !committed) {
      try {
        fs.rmSync(target, { force: true });
        syncCwd();
      } catch {
        // Preserve the original create/write/sync failure.
      }
    }
  }
}

function replaceFile(relativePath, temporaryPath, contents, mode) {
  const target = safeRelative(relativePath, false);
  const temporary = safeRelative(temporaryPath, false);
  let renamed = false;
  try {
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    try {
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    renamed = true;
    syncCwd();
  } finally {
    if (!renamed) fs.rmSync(temporary, { force: true });
  }
}

function execute(request) {
  switch (request.op) {
    case "lstat":
      return metadata(request.path);
    case "readdir":
      return fs.readdirSync(safeRelative(request.path || ".", true), { withFileTypes: true })
        .map((entry) => ({ name: entry.name, kind: kind(entry) }));
    case "readFile":
      return readRegularFile(request.path, request.maxBytes);
    case "writeFileExclusive":
      writeExclusive(request.path, request.contents, request.mode, request.injectedFailure);
      return null;
    case "replaceFile":
      replaceFile(request.path, request.temporaryPath, request.contents, request.mode);
      return null;
    case "mkdir":
      fs.mkdirSync(safeRelative(request.path, false), { mode: request.mode, recursive: false });
      return null;
    case "remove":
      fs.rmSync(safeRelative(request.path, false), {
        force: Boolean(request.force),
        recursive: Boolean(request.recursive),
      });
      return null;
    case "rename":
      fs.renameSync(safeRelative(request.from, false), safeRelative(request.to, false));
      return null;
    case "link":
      fs.linkSync(safeRelative(request.from, false), safeRelative(request.to, false));
      return null;
    default: {
      const error = new Error("Unknown durable-directory worker operation");
      error.code = "EINVAL";
      throw error;
    }
  }
}

function respond(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

respond({ id: 0, ok: true, value: metadata(".") });
let input = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    queue = queue.then(() => {
      let request;
      try {
        request = JSON.parse(line);
        respond({ id: request.id, ok: true, value: execute(request) });
      } catch (error) {
        respond({
          id: request && Number.isInteger(request.id) ? request.id : -1,
          ok: false,
          error: { code: error && error.code, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
  }
});
`;

function directoryLineage(directory: string): string[] {
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  const lineage = [root];
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    lineage.push(cursor);
  }
  return lineage;
}

/**
 * macOS exposes the physical `/private/var` tree through the platform-owned
 * `/var -> private/var` alias. Canonicalize only that exact ancestor alias;
 * every managed component beneath it remains subject to no-follow identity
 * checks. The returned physical path is also the operator-visible authority
 * path, so later locators never name an unverified lexical alias.
 */
async function canonicalDurableTarget(directory: string): Promise<string> {
  const target = path.resolve(directory);
  if (!target.startsWith(`/var${path.sep}`)) {
    return target;
  }
  try {
    const varMetadata = await lstat("/var");
    if (!varMetadata.isSymbolicLink() || await realpath("/var") !== "/private/var") {
      return target;
    }
    const physicalVar = await lstat("/private/var");
    if (!physicalVar.isDirectory() || physicalVar.isSymbolicLink()) {
      return target;
    }
    return path.join("/private/var", path.relative("/var", target));
  } catch {
    return target;
  }
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryEntryKind(metadata: {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): DurableDirectoryEntryKind {
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  if (metadata.isSymbolicLink()) return "symlink";
  return "other";
}

function assertSafeRelativePath(relativePath: string, allowDot = false): string {
  if (
    typeof relativePath !== "string"
    || relativePath.includes("\0")
    || path.isAbsolute(relativePath)
  ) {
    throw Object.assign(new Error(`Unsafe durable-directory relative path: ${relativePath}`), {
      code: "EINVAL",
    });
  }
  if (allowDot && relativePath === ".") return relativePath;
  const segments = relativePath.split(path.sep);
  if (
    segments.length !== 1
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw Object.assign(new Error(`Unsafe durable-directory relative path: ${relativePath}`), {
      code: "EINVAL",
    });
  }
  return relativePath;
}

function workerFailure(
  response: DirectoryWorkerResponse,
  stderr: string,
): Error & { code?: string } {
  const detail = response.error?.message ?? "Durable-directory helper rejected an operation.";
  const suffix = stderr.trim() ? ` (${stderr.trim().slice(-2_048)})` : "";
  return Object.assign(new Error(`${detail}${suffix}`), {
    ...(response.error?.code ? { code: response.error.code } : {}),
  });
}

async function startDirectoryWorker(
  directory: string,
  expectedIdentity: DirectoryIdentity,
): Promise<DirectoryWorker> {
  const child = spawn(process.execPath, ["-e", DURABLE_DIRECTORY_WORKER_SOURCE], {
    cwd: directory,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let readyResolve!: (value: DurableDirectoryMetadata) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<DurableDirectoryMetadata>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let exitResolve!: () => void;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  const rejectAll = (error: Error): void => {
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const acceptResponse = (response: DirectoryWorkerResponse): void => {
    if (response.id === 0) {
      if (!response.ok) {
        readyReject(workerFailure(response, stderr));
        return;
      }
      readyResolve(response.value as DurableDirectoryMetadata);
      return;
    }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.value);
    else waiter.reject(workerFailure(response, stderr));
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        acceptResponse(JSON.parse(line) as DirectoryWorkerResponse);
      } catch (error) {
        rejectAll(durableDirectoryError(
          `Durable-directory helper emitted invalid output: ${error instanceof Error ? error.message : String(error)}`,
          "EIO",
        ));
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  child.on("error", (error) => {
    rejectAll(error);
  });
  child.on("close", (code, signal) => {
    closed = true;
    const error = durableDirectoryError(
      `Durable-directory helper exited before completing I/O (code=${String(code)}, signal=${String(signal)}).${stderr.trim() ? ` ${stderr.trim().slice(-2_048)}` : ""}`,
      "EIO",
    );
    rejectAll(error);
    exitResolve();
  });

  let workerMetadata: DurableDirectoryMetadata;
  try {
    workerMetadata = await ready;
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  if (workerMetadata.kind !== "directory" || !sameDirectoryIdentity(workerMetadata, expectedIdentity)) {
    child.stdin.end();
    await exited;
    throw durableDirectoryError(
      `Durable directory identity changed while starting held-cwd authority: ${directory}`,
      "ESTALE",
    );
  }

  return {
    request: async <T>(request: Omit<DirectoryWorkerRequest, "id">): Promise<T> => {
      if (closed) {
        throw durableDirectoryError(`Durable-directory helper is closed: ${directory}`, "EBADF");
      }
      const id = nextId;
      nextId += 1;
      const response = new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => { resolve(value as T); },
          reject,
        });
      });
      const payload = `${JSON.stringify({ ...request, id })}\n`;
      child.stdin.write(payload, "utf8", (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error);
      });
      return response;
    },
    allowProcessExit: (): void => {
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        (stream as typeof stream & { unref?: () => void }).unref?.();
      }
    },
    close: async (): Promise<void> => {
      if (closed) return;
      child.stdin.end();
      await exited;
    },
  };
}

async function captureRealDirectoryLineage(
  directory: string,
): Promise<DirectoryLineageIdentity[]> {
  const lineage = directoryLineage(directory);
  const captured: DirectoryLineageIdentity[] = [];
  for (const candidate of lineage) {
    let current;
    try {
      current = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(
          new Error(`Durable directory path disappeared: ${candidate}`),
          { code: "ENOENT" },
        );
      }
      throw error;
    }
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw durableDirectoryError(`Durable directory path is not a real directory: ${candidate}`, "EINVAL");
    }
    captured.push({ path: candidate, dev: current.dev, ino: current.ino });
  }
  return captured;
}

async function assertRealDirectoryLineage(
  directory: string,
  expected?: readonly DirectoryLineageIdentity[],
): Promise<void> {
  const current = await captureRealDirectoryLineage(directory);
  for (const [index, currentEntry] of current.entries()) {
    const expectedEntry = expected?.[index];
    if (expectedEntry && (
      expectedEntry.path !== currentEntry.path
      || !sameDirectoryIdentity(currentEntry, expectedEntry)
    )) {
      throw durableDirectoryError(`Durable directory lineage identity changed: ${currentEntry.path}`, "ESTALE");
    }
  }
  if (expected && expected.length !== current.length) {
    throw durableDirectoryError(`Durable directory lineage changed: ${directory}`, "ESTALE");
  }
}

async function descriptorDirectoryPath(
  handle: FileHandle,
  identity: DirectoryIdentity,
  options: DurableDirectoryOpenOptions,
): Promise<string | undefined> {
  const candidates = options.descriptorPathCandidates?.(handle.fd) ?? [
    `/proc/self/fd/${handle.fd}`,
    `/dev/fd/${handle.fd}`,
  ];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (!metadata.isDirectory() || !sameDirectoryIdentity(metadata, identity)) {
        continue;
      }
      const childTraversal = options.descriptorChildTraversalProbe
        ? await options.descriptorChildTraversalProbe(candidate)
        : await descriptorPathTraversesNamedChild(candidate);
      if (
        childTraversal
      ) {
        return candidate;
      }
    } catch {
      // Try the next descriptor filesystem. Linux exposes /proc/self/fd;
      // Darwin exposes /dev/fd but does not support child traversal there.
    }
  }
  return undefined;
}

async function descriptorPathTraversesNamedChild(candidate: string): Promise<boolean> {
  // Darwin's fdescfs can expose the directory identity at /dev/fd/<n> while
  // rejecting /dev/fd/<n>/<child>. Resolve a named, non-mutating probe instead
  // of `/.`, which only names the directory itself and proves no child-lookup
  // capability. Prefer a positive lookup of an entry observed through the
  // same descriptor path. For an empty or concurrently emptied directory,
  // lookup a deliberately absent one-segment name: ENOENT proves the parent
  // accepted child traversal, while Darwin fdescfs reports ENOTDIR.
  const entries = await readdir(candidate);
  for (const entry of entries) {
    try {
      await lstat(path.join(candidate, entry));
      return true;
    } catch {
      // The observed entry may have raced with deletion; try the next one.
    }
  }
  try {
    await lstat(path.join(candidate, `.calyx-durable-child-probe-${process.pid}`));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTDIR" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
    return false;
  }
}

function authorityPath(
  directory: string,
  relativePath: string,
  allowDot = false,
): string {
  const safe = assertSafeRelativePath(relativePath, allowDot);
  return safe === "." ? directory : path.join(directory, safe);
}

function boundedFileTooLarge(maxBytes: number): Error & { code: string } {
  return Object.assign(
    new Error(`Durable authority file exceeds the bounded read limit of ${maxBytes} bytes`),
    { code: "EFBIG" },
  );
}

async function readRegularFileNoFollow(
  targetPath: string,
  maxBytes?: number,
): Promise<string> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw Object.assign(new Error("Invalid durable authority bounded read limit"), {
      code: "EINVAL",
    });
  }
  const handle = await open(
    targetPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw Object.assign(
        new Error(`Durable authority path is not a regular file: ${targetPath}`),
        { code: "EINVAL" },
      );
    }
    if (maxBytes === undefined) return await handle.readFile("utf8");
    if (metadata.size > maxBytes) throw boundedFileTooLarge(maxBytes);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, maxBytes + 1)));
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const requestedBytes = Math.min(buffer.length, maxBytes + 1 - totalBytes);
      if (requestedBytes === 0) break;
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    if (totalBytes > maxBytes) throw boundedFileTooLarge(maxBytes);
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

function createDirectoryAuthority(args: {
  anchoredDirectory: string;
  worker?: DirectoryWorker;
  sync: () => Promise<void>;
  run: <T>(operation: () => Promise<T>) => Promise<T>;
  afterExclusiveFileCreated?: (relativePath: string) => Promise<void>;
}): DurableDirectoryAuthority {
  const { anchoredDirectory, worker, sync, run, afterExclusiveFileCreated } = args;
  if (worker) {
    return {
      readdir: (relativePath = ".") => run(() => worker.request<DurableDirectoryEntry[]>({
        op: "readdir",
        path: assertSafeRelativePath(relativePath, true),
      })),
      lstat: (relativePath) => run(() => worker.request<DurableDirectoryMetadata>({
        op: "lstat",
        path: assertSafeRelativePath(relativePath, true),
      })),
      readFile: (relativePath, maxBytes) => run(() => worker.request<string>({
        op: "readFile",
        path: assertSafeRelativePath(relativePath),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      })),
      writeFileExclusive: (relativePath, contents, mode) => run(async () => {
        let injectedFailure: string | undefined;
        try {
          await afterExclusiveFileCreated?.(relativePath);
        } catch (error) {
          injectedFailure = error instanceof Error ? error.message : String(error);
        }
        return worker.request<void>({
          op: "writeFileExclusive",
          path: assertSafeRelativePath(relativePath),
          contents,
          mode,
          ...(injectedFailure ? { injectedFailure } : {}),
        });
      }),
      replaceFile: (relativePath, temporaryRelativePath, contents, mode) => run(() => worker.request<void>({
        op: "replaceFile",
        path: assertSafeRelativePath(relativePath),
        temporaryPath: assertSafeRelativePath(temporaryRelativePath),
        contents,
        mode,
      })),
      mkdir: (relativePath, mode) => run(() => worker.request<void>({
        op: "mkdir",
        path: assertSafeRelativePath(relativePath),
        mode,
      })),
      remove: (relativePath, options = {}) => run(() => worker.request<void>({
        op: "remove",
        path: assertSafeRelativePath(relativePath),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
      })),
      rename: (fromRelativePath, toRelativePath) => run(() => worker.request<void>({
        op: "rename",
        from: assertSafeRelativePath(fromRelativePath),
        to: assertSafeRelativePath(toRelativePath),
      })),
      link: (fromRelativePath, toRelativePath) => run(() => worker.request<void>({
        op: "link",
        from: assertSafeRelativePath(fromRelativePath),
        to: assertSafeRelativePath(toRelativePath),
      })),
    };
  }

  return {
    readdir: (relativePath = ".") => run(async () => (
      await readdir(authorityPath(anchoredDirectory, relativePath, true), { withFileTypes: true })
    ).map((entry) => ({ name: entry.name, kind: directoryEntryKind(entry) }))),
    lstat: (relativePath) => run(async () => {
      const metadata = await lstat(authorityPath(anchoredDirectory, relativePath, true));
      return {
        kind: directoryEntryKind(metadata),
        mode: metadata.mode,
        mtimeMs: metadata.mtimeMs,
        dev: metadata.dev,
        ino: metadata.ino,
      };
    }),
    readFile: (relativePath, maxBytes) => run(() => readRegularFileNoFollow(
      authorityPath(anchoredDirectory, relativePath),
      maxBytes,
    )),
    writeFileExclusive: (relativePath, contents, mode) => run(async () => {
      const target = authorityPath(anchoredDirectory, relativePath);
      let created = false;
      let committed = false;
      try {
        const handle = await open(
          target,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0),
          mode,
        );
        created = true;
        let failure: unknown;
        try {
          await afterExclusiveFileCreated?.(relativePath);
          await handle.writeFile(contents, "utf8");
          await handle.sync();
        } catch (error) {
          failure = error;
        }
        try {
          await handle.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
        await sync();
        committed = true;
      } finally {
        if (created && !committed) {
          await rm(target, { force: true }).catch(() => undefined);
          await sync().catch(() => undefined);
        }
      }
    }),
    replaceFile: (relativePath, temporaryRelativePath, contents, mode) => run(async () => {
      const target = authorityPath(anchoredDirectory, relativePath);
      const temporary = authorityPath(anchoredDirectory, temporaryRelativePath);
      let renamed = false;
      try {
        const handle = await open(
          temporary,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
            | (fsConstants.O_NOFOLLOW ?? 0),
          mode,
        );
        try {
          await handle.writeFile(contents, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
        renamed = true;
        await sync();
      } finally {
        if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
      }
    }),
    mkdir: (relativePath, mode) => run(async () => {
      await mkdir(authorityPath(anchoredDirectory, relativePath), {
        mode,
        recursive: false,
      });
    }),
    remove: (relativePath, options = {}) => run(async () => {
      await rm(authorityPath(anchoredDirectory, relativePath), options);
    }),
    rename: (fromRelativePath, toRelativePath) => run(async () => {
      await rename(
        authorityPath(anchoredDirectory, fromRelativePath),
        authorityPath(anchoredDirectory, toRelativePath),
      );
    }),
    link: (fromRelativePath, toRelativePath) => run(async () => {
      await link(
        authorityPath(anchoredDirectory, fromRelativePath),
        authorityPath(anchoredDirectory, toRelativePath),
      );
    }),
  };
}

async function openDirectoryAnchor(
  directory: string,
  requestedOpenPath?: string,
  options: DurableDirectoryOpenOptions = {},
  expectedIdentity?: DirectoryIdentity,
): Promise<DurableDirectoryAnchor> {
  const target = await canonicalDurableTarget(directory);
  const openPath = requestedOpenPath
    ? await canonicalDurableTarget(requestedOpenPath)
    : target;
  const expectedLineage = await captureRealDirectoryLineage(target);
  const expectedTarget = expectedLineage.at(-1)!;
  if (expectedIdentity && !sameDirectoryIdentity(expectedTarget, expectedIdentity)) {
    throw durableDirectoryError(`Durable directory identity changed before anchoring: ${target}`, "ESTALE");
  }
  const handle = await open(
    openPath,
    fsConstants.O_RDONLY
      | (fsConstants.O_DIRECTORY ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let closed = false;
  let activeOperations = 0;
  let resourceClosePromise: Promise<void> | undefined;
  let worker: DirectoryWorker | undefined;
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw durableDirectoryError(`Durable directory path is not a real directory: ${target}`, "EINVAL");
    }
    const identity: DirectoryIdentity = { dev: metadata.dev, ino: metadata.ino };
    if (
      !sameDirectoryIdentity(identity, expectedTarget)
      || (expectedIdentity && !sameDirectoryIdentity(identity, expectedIdentity))
    ) {
      throw durableDirectoryError(`Durable directory identity changed while anchoring: ${target}`, "ESTALE");
    }
    const descriptorPath = await descriptorDirectoryPath(handle, identity, options);
    const authorityDirectory = descriptorPath ?? target;
    if (!descriptorPath) {
      worker = await startDirectoryWorker(target, identity);
    }
    const closeResources = (): Promise<void> => {
      resourceClosePromise ??= (async () => {
        try {
          await worker?.close();
        } finally {
          await handle.close();
        }
      })();
      return resourceClosePromise;
    };
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (closed) {
        throw Object.assign(new Error(`Durable directory authority is closed: ${target}`), {
          code: "EBADF",
        });
      }
      activeOperations += 1;
      try {
        await options.authorityOperationGate?.();
        return await operation();
      } finally {
        activeOperations -= 1;
        if (closed && activeOperations === 0) {
          // A caller may intentionally abandon a bounded diagnostic write. Do
          // not block close beyond that caller's bound, but retain the held fd
          // until the in-flight operation settles so its numeric descriptor
          // can never be recycled underneath pathname-based child I/O.
          void closeResources().catch(() => undefined);
        }
      }
    };
    const assertCanonicalRaw = async (): Promise<void> => {
      await assertRealDirectoryLineage(target, expectedLineage);
      const held = await handle.stat();
      if (!held.isDirectory() || !sameDirectoryIdentity(held, identity)) {
        throw durableDirectoryError(`Durable directory descriptor identity changed: ${target}`, "ESTALE");
      }
    };
    const syncRaw = async (): Promise<void> => { await handle.sync(); };
    const assertCanonical = (): Promise<void> => run(assertCanonicalRaw);
    // Construction must establish canonical identity before exposing the
    // authority. Keep that proof outside the optional operation test gate.
    await assertCanonicalRaw();
    return {
      directory: target,
      ...(descriptorPath ? { anchoredDirectory: descriptorPath } : {}),
      descriptorBacked: descriptorPath !== undefined,
      authority: createDirectoryAuthority({
        anchoredDirectory: authorityDirectory,
        ...(worker ? { worker } : {}),
        sync: syncRaw,
        run,
        ...(options.afterExclusiveFileCreated
          ? { afterExclusiveFileCreated: options.afterExclusiveFileCreated }
          : {}),
      }),
      assertCanonical,
      sync: () => run(syncRaw),
      chmod: (mode: number) => run(async () => { await handle.chmod(mode); }),
      close: async () => {
        if (closed) {
          if (resourceClosePromise) await resourceClosePromise;
          return;
        }
        closed = true;
        if (activeOperations === 0) {
          await closeResources();
        } else {
          worker?.allowProcessExit();
        }
      },
    };
  } catch (error) {
    await worker?.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openPrivateDirectoryTree(
  directory: string,
  mode: number,
  options: DurableDirectoryOpenOptions,
): Promise<DurableDirectoryAnchor> {
  const target = await canonicalDurableTarget(directory);
  const root = path.parse(target).root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let anchor = await openDirectoryAnchor(root, undefined, options);
  try {
    for (const segment of segments) {
      let created = false;
      let childIdentity: DurableDirectoryMetadata;
      try {
        childIdentity = await anchor.authority.lstat(segment);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await anchor.authority.mkdir(segment, mode);
          created = true;
          await anchor.sync();
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        childIdentity = await anchor.authority.lstat(segment);
      }
      if (childIdentity.kind !== "directory") {
        throw durableDirectoryError(
          `Durable directory path is not a real directory: ${path.join(anchor.directory, segment)}`,
          "EINVAL",
        );
      }

      const childDirectory = path.join(anchor.directory, segment);
      const childOpenPath = anchor.descriptorBacked
        ? path.join(anchor.anchoredDirectory!, segment)
        : undefined;
      const child = await openDirectoryAnchor(
        childDirectory,
        childOpenPath,
        options,
        childIdentity,
      );
      try {
        if (created) {
          await child.chmod(mode);
          await child.sync();
        }
        await anchor.assertCanonical();
        await child.assertCanonical();
      } catch (error) {
        await child.close().catch(() => undefined);
        throw error;
      }
      try {
        await anchor.close();
      } catch (error) {
        await child.close().catch(() => undefined);
        throw error;
      }
      anchor = child;
    }

    await anchor.chmod(mode);
    await anchor.sync();
    await anchor.assertCanonical();
    return anchor;
  } catch (error) {
    await anchor.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Create a private directory one held parent at a time and synchronize every
 * new entry. This never directs a mkdir through an unheld ancestor path.
 */
export async function ensurePrivateDirectoryDurable(
  directory: string,
  mode: number,
): Promise<void> {
  const anchor = await openPrivateDirectoryTree(directory, mode, {});
  await anchor.close();
}

/**
 * Create and hold a private directory authority. Consumers must perform child
 * I/O through `authority`, synchronize with `sync()`, and call
 * `assertCanonical()` after publication before accepting the result. Linux
 * normally uses descriptor traversal; Darwin retains the directory as a
 * helper process cwd. Neither route can be redirected by a later pathname
 * replacement.
 */
export async function openPrivateDirectoryDurable(
  directory: string,
  mode: number,
  options: DurableDirectoryOpenOptions = {},
): Promise<DurableDirectoryAnchor> {
  return openPrivateDirectoryTree(directory, mode, options);
}

/** Open an existing canonical directory without creating or changing it. */
export async function openExistingDirectoryDurable(
  directory: string,
  options: DurableDirectoryOpenOptions = {},
): Promise<DurableDirectoryAnchor> {
  return openDirectoryAnchor(directory, undefined, options);
}

/**
 * Hold a child directory through an already-anchored parent. Descriptor-path
 * platforms open through the parent fd. Held-cwd platforms first capture the
 * child identity through the parent helper, then require the separately opened
 * child authority to match it before use.
 */
export async function openChildDirectoryDurable(
  parent: DurableDirectoryAnchor,
  childName: string,
  options: DurableDirectoryOpenOptions = {},
): Promise<DurableDirectoryAnchor> {
  if (
    !childName
    || childName === "."
    || childName === ".."
    || path.basename(childName) !== childName
    || childName.includes("\0")
  ) {
    throw durableDirectoryError(`Durable child directory name is unsafe: ${JSON.stringify(childName)}`, "EINVAL");
  }
  await parent.assertCanonical();
  const childIdentity = await parent.authority.lstat(childName);
  if (childIdentity.kind !== "directory") {
    throw durableDirectoryError(
      `Durable directory path is not a real directory: ${path.join(parent.directory, childName)}`,
      "EINVAL",
    );
  }
  const child = await openDirectoryAnchor(
    path.join(parent.directory, childName),
    parent.descriptorBacked ? path.join(parent.anchoredDirectory!, childName) : undefined,
    options,
    childIdentity,
  );
  try {
    await parent.assertCanonical();
    await child.assertCanonical();
    return child;
  } catch (error) {
    await child.close().catch(() => undefined);
    throw error;
  }
}
