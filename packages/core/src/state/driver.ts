/**
 * Runtime guard + thin wrapper around `node:sqlite`.
 *
 * Wave 1 deliberately ships a single driver: the built-in `node:sqlite`
 * module. The runtime guard fails closed with a clear operator message when
 * the module is missing or the Node runtime is below the documented floor
 * (v22.13.0 — first version where `node:sqlite` is available without
 * `--experimental-sqlite`).
 */

import { dirname } from "node:path";

import { assertStatePathAllowedForTests } from "./paths";

export const STATE_DRIVER_ID = "node:sqlite";
export const STATE_DRIVER_MIN_NODE = "22.13.0";

export interface StateDriverDatabase {
  exec(sql: string): void;
  prepare(sql: string): StateDriverStatement;
  close(): void;
  readonly isOpen: boolean;
}

export interface StateDriverStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface StateDriverModule {
  open(path: string): StateDriverDatabase;
  /**
   * Open the database in read-only mode. The file must already exist;
   * planning callers must check existence first to honor the read-only
   * contract on a missing state home.
   */
  openReadOnly(path: string): StateDriverDatabase;
  id: string;
  minNode: string;
}

export class StateDriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StateDriverError";
    this.code = code;
  }
}

export interface ParsedNodeVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseNodeVersion(version: string): ParsedNodeVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareNodeVersions(
  a: ParsedNodeVersion,
  b: ParsedNodeVersion
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isNodeVersionSupported(actual: string, minimum: string = STATE_DRIVER_MIN_NODE): boolean {
  const a = parseNodeVersion(actual);
  const b = parseNodeVersion(minimum);
  if (!a || !b) return false;
  return compareNodeVersions(a, b) >= 0;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { open?: boolean; readOnly?: boolean }
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
    readonly isOpen: boolean;
  };
}

let cachedModule: StateDriverModule | null = null;

function warningTypeFromArg(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && "type" in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

function requireNodeSqliteWithoutExperimentalWarning(requireBuiltin: NodeRequire): NodeSqliteModule {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    const message = typeof warning === "string" ? warning : warning.message;
    const type = warningTypeFromArg(args[0]) ?? (warning instanceof Error ? warning.name : undefined);
    if (type === "ExperimentalWarning" && message.includes("SQLite is an experimental feature")) {
      return;
    }
    (originalEmitWarning as unknown as (warning: string | Error, ...args: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
  try {
    return requireBuiltin("node:sqlite") as NodeSqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * Load the `node:sqlite` driver, asserting the runtime Node version
 * meets the documented floor. Caches the resolved module so repeated
 * loads inside the same process are cheap.
 *
 * Throws StateDriverError with a stable code on:
 *   - `node_version_unsupported` — Node runtime is older than 22.13.0
 *   - `node_sqlite_unavailable` — `node:sqlite` import failed
 */
export async function loadStateDriver(options: {
  actualNodeVersion?: string;
  minNodeVersion?: string;
} = {}): Promise<StateDriverModule> {
  if (cachedModule) return cachedModule;

  const actual = options.actualNodeVersion ?? process.versions.node;
  const minimum = options.minNodeVersion ?? STATE_DRIVER_MIN_NODE;

  if (!isNodeVersionSupported(actual, minimum)) {
    throw new StateDriverError(
      "node_version_unsupported",
      `calyx state requires Node >=${minimum} for built-in node:sqlite (running ${actual}). ` +
        `Upgrade the runtime, or set PATH so calyx and the calyx daemon launch under Node >=${minimum}.`,
    );
  }

  // Use createRequire so bundlers/test runners don't rewrite the
  // "node:" specifier — `node:sqlite` is a built-in and we want the real
  // module, not a virtualized one. See vitest issue with node: prefixes.
  let mod: NodeSqliteModule;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    mod = requireNodeSqliteWithoutExperimentalWarning(require);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new StateDriverError(
      "node_sqlite_unavailable",
      `calyx state could not load node:sqlite: ${cause}. ` +
        `Run on Node >=${minimum} with the built-in SQLite module enabled.`,
    );
  }

  if (!mod || typeof mod.DatabaseSync !== "function") {
    throw new StateDriverError(
      "node_sqlite_unavailable",
      `calyx state loaded node:sqlite but DatabaseSync is missing. ` +
        `Run on Node >=${minimum} with the built-in SQLite module enabled.`,
    );
  }

  function wrap(db: InstanceType<NodeSqliteModule["DatabaseSync"]>): StateDriverDatabase {
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
      get isOpen() {
        return db.isOpen;
      },
    };
  }

  const driver: StateDriverModule = {
    id: STATE_DRIVER_ID,
    minNode: minimum,
    open(path: string): StateDriverDatabase {
      assertStatePathAllowedForTests({ stateDir: dirname(path), dbPath: path });
      return wrap(new mod.DatabaseSync(path));
    },
    openReadOnly(path: string): StateDriverDatabase {
      assertStatePathAllowedForTests({ stateDir: dirname(path), dbPath: path });
      return wrap(new mod.DatabaseSync(path, { readOnly: true }));
    },
  };

  cachedModule = driver;
  return driver;
}

/** Test-only: drop the cached driver so re-loading exercises the guard again. */
export function __resetStateDriverCacheForTests(): void {
  cachedModule = null;
}
