import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const CALYX_STATE_HOME_ENV = "CALYX_STATE_HOME";
export const CALYX_STATE_DB_ENV = "CALYX_STATE_DB";
export const CALYX_TEST_STATE_GUARD_ENV = "CALYX_TEST_STATE_GUARD";

export const DEFAULT_STATE_HOME_SUBPATH = ".calyx/state";
export const DEFAULT_DB_FILENAME = "calyx.db";

export interface ResolvedStatePaths {
  /** Absolute path to the directory that holds calyx.db. */
  stateDir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Provenance of the resolved DB path. */
  source: "env-db" | "env-home" | "default";
  /** Provenance of the resolved state directory. */
  dirSource: "env-db-derived" | "env-home" | "default";
}

export interface ResolveStatePathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * Resolve the canonical state directory and database path.
 *
 * Precedence:
 *   1. CALYX_STATE_DB (file path; directory is derived)
 *   2. CALYX_STATE_HOME (directory; file is `${dir}/calyx.db`)
 *   3. Default: `${homedir}/.calyx/state/calyx.db`
 *
 * Relative paths from env are resolved against the current working directory.
 */
export function resolveStatePaths(
  options: ResolveStatePathsOptions = {}
): ResolvedStatePaths {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();

  const dbEnv = env[CALYX_STATE_DB_ENV]?.trim();
  if (dbEnv) {
    const dbPath = isAbsolute(dbEnv) ? dbEnv : resolve(dbEnv);
    return {
      stateDir: dirname(dbPath),
      dbPath,
      source: "env-db",
      dirSource: "env-db-derived",
    };
  }

  const homeEnv = env[CALYX_STATE_HOME_ENV]?.trim();
  if (homeEnv) {
    const stateDir = isAbsolute(homeEnv) ? homeEnv : resolve(homeEnv);
    return {
      stateDir,
      dbPath: resolve(stateDir, DEFAULT_DB_FILENAME),
      source: "env-home",
      dirSource: "env-home",
    };
  }

  const stateDir = resolve(home, DEFAULT_STATE_HOME_SUBPATH);
  return {
    stateDir,
    dbPath: resolve(stateDir, DEFAULT_DB_FILENAME),
    source: "default",
    dirSource: "default",
  };
}

export function assertStatePathAllowedForTests(
  paths: Pick<ResolvedStatePaths, "stateDir" | "dbPath">,
  options: ResolveStatePathsOptions = {},
): void {
  const env = options.env ?? process.env;
  if (!env[CALYX_TEST_STATE_GUARD_ENV]?.trim()) {
    return;
  }

  const defaultOptions: ResolveStatePathsOptions = { env: {} };
  if (options.homeDir !== undefined) {
    defaultOptions.homeDir = options.homeDir;
  }
  const defaultPaths = resolveStatePaths(defaultOptions);
  if (paths.stateDir !== defaultPaths.stateDir && paths.dbPath !== defaultPaths.dbPath) {
    return;
  }

  throw new Error(
    `Refusing to open the default Calyx state path during tests: ${paths.dbPath}. `
      + `Set ${CALYX_STATE_HOME_ENV} or ${CALYX_STATE_DB_ENV} to an isolated temp path.`,
  );
}
