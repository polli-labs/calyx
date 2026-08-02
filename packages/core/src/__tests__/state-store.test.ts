import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  applyStateMigrations,
  checkMigrationConsistency,
  classifyStateSchema,
  computeMigrationPlan,
  countStateMigrationsAfter,
  describeStatePaths,
  isNodeVersionSupported,
  loadStateDriver,
  openStateStore,
  parseNodeVersion,
  planStateMigrations,
  reportStateHealth,
  resolveStatePaths,
  runStateDoctor,
  STATE_DB_FILE_MODE,
  STATE_DIR_MODE,
  STATE_DRIVER_ID,
  STATE_DRIVER_MIN_NODE,
  STATE_MIGRATIONS,
  StateDriverError,
  __resetStateDriverCacheForTests,
  type StateDriverDatabase,
  type StateDriverModule,
} from "../state";

async function makeTempStateHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "calyx-state-"));
}

const ENV_KEYS = ["CALYX_STATE_HOME", "CALYX_STATE_DB"] as const;
const TEST_GUARD_ENV = "CALYX_TEST_STATE_GUARD";

function clearStateEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("resolveStatePaths", () => {
  test("defaults to ~/.calyx/state/calyx.db", () => {
    const paths = resolveStatePaths({ env: {}, homeDir: "/home/test" });
    expect(paths.stateDir).toBe("/home/test/.calyx/state");
    expect(paths.dbPath).toBe("/home/test/.calyx/state/calyx.db");
    expect(paths.source).toBe("default");
    expect(paths.dirSource).toBe("default");
  });

  test("CALYX_STATE_HOME overrides directory", () => {
    const paths = resolveStatePaths({
      env: { CALYX_STATE_HOME: "/tmp/state-home" },
      homeDir: "/home/test",
    });
    expect(paths.stateDir).toBe("/tmp/state-home");
    expect(paths.dbPath).toBe("/tmp/state-home/calyx.db");
    expect(paths.source).toBe("env-home");
  });

  test("CALYX_STATE_DB overrides file path and derives directory", () => {
    const paths = resolveStatePaths({
      env: { CALYX_STATE_DB: "/var/lib/calyx/data.sqlite" },
      homeDir: "/home/test",
    });
    expect(paths.dbPath).toBe("/var/lib/calyx/data.sqlite");
    expect(paths.stateDir).toBe("/var/lib/calyx");
    expect(paths.source).toBe("env-db");
    expect(paths.dirSource).toBe("env-db-derived");
  });

  test("CALYX_STATE_DB takes precedence over CALYX_STATE_HOME", () => {
    const paths = resolveStatePaths({
      env: {
        CALYX_STATE_DB: "/abs/explicit.db",
        CALYX_STATE_HOME: "/abs/home",
      },
      homeDir: "/home/test",
    });
    expect(paths.dbPath).toBe("/abs/explicit.db");
    expect(paths.source).toBe("env-db");
  });
});

describe("driver runtime guard", () => {
  test("parseNodeVersion handles v-prefix and dotted forms", () => {
    expect(parseNodeVersion("22.13.0")).toEqual({ major: 22, minor: 13, patch: 0 });
    expect(parseNodeVersion("v22.22.2")).toEqual({ major: 22, minor: 22, patch: 2 });
    expect(parseNodeVersion("garbage")).toBeNull();
  });

  test("isNodeVersionSupported enforces 22.13 floor", () => {
    expect(isNodeVersionSupported("22.13.0")).toBe(true);
    expect(isNodeVersionSupported("22.22.2")).toBe(true);
    expect(isNodeVersionSupported("23.0.0")).toBe(true);
    expect(isNodeVersionSupported("22.12.99")).toBe(false);
    expect(isNodeVersionSupported("20.10.0")).toBe(false);
  });

  test("loadStateDriver fails closed below the floor", async () => {
    __resetStateDriverCacheForTests();
    await expect(
      loadStateDriver({ actualNodeVersion: "20.10.0" }),
    ).rejects.toBeInstanceOf(StateDriverError);
    __resetStateDriverCacheForTests();
    try {
      await loadStateDriver({ actualNodeVersion: "20.10.0" });
    } catch (err) {
      expect(err).toBeInstanceOf(StateDriverError);
      expect((err as StateDriverError).code).toBe("node_version_unsupported");
      expect((err as Error).message).toMatch(/22\.13\.0/);
    }
    __resetStateDriverCacheForTests();
  });

  test("loadStateDriver returns the node:sqlite driver on supported runtime", async () => {
    __resetStateDriverCacheForTests();
    const driver = await loadStateDriver();
    expect(driver.id).toBe(STATE_DRIVER_ID);
    expect(driver.minNode).toBe(STATE_DRIVER_MIN_NODE);
  });
});

describe("state store lifecycle", () => {
  let stateHome: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    originalEnv = {
      CALYX_STATE_HOME: process.env["CALYX_STATE_HOME"],
      CALYX_STATE_DB: process.env["CALYX_STATE_DB"],
    };
    clearStateEnv();
    const root = await makeTempStateHome();
    stateHome = join(root, "state");
    process.env["CALYX_STATE_HOME"] = stateHome;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(stateHome, { recursive: true, force: true });
    // Best effort: clean up the wrapping temp parent too.
    const parent = stateHome.replace(/\/state$/, "");
    if (parent !== stateHome) {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("test guard rejects default state path opens", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "calyx-default-state-guard-"));
    const previousHome = process.env["HOME"];
    const previousGuard = process.env[TEST_GUARD_ENV];
    clearStateEnv();
    process.env["HOME"] = fakeHome;
    process.env[TEST_GUARD_ENV] = "1";

    try {
      await expect(async () => {
        const opened = await openStateStore();
        try {
          throw new Error(`opened default state path ${opened.paths.dbPath}`);
        } finally {
          opened.db.close();
        }
      }).rejects.toThrow("Refusing to open the default Calyx state path during tests");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousGuard === undefined) delete process.env[TEST_GUARD_ENV];
      else process.env[TEST_GUARD_ENV] = previousGuard;
      process.env["CALYX_STATE_HOME"] = stateHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
    expect(homedir()).not.toBe(fakeHome);
  });

  test("test guard rejects direct driver opens of the default state database", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "calyx-default-driver-guard-"));
    const previousHome = process.env["HOME"];
    const previousGuard = process.env[TEST_GUARD_ENV];
    clearStateEnv();
    process.env["HOME"] = fakeHome;
    process.env[TEST_GUARD_ENV] = "1";

    try {
      const driver = await loadStateDriver();
      const defaultPath = resolveStatePaths().dbPath;
      expect(() => {
        const db = driver.open(defaultPath);
        try {
          throw new Error(`opened default state path ${defaultPath}`);
        } finally {
          db.close();
        }
      }).toThrow("Refusing to open the default Calyx state path during tests");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      if (previousGuard === undefined) delete process.env[TEST_GUARD_ENV];
      else process.env[TEST_GUARD_ENV] = previousGuard;
      process.env["CALYX_STATE_HOME"] = stateHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("test guard permits isolated temp state path opens", async () => {
    process.env[TEST_GUARD_ENV] = "1";
    const opened = await openStateStore();
    try {
      expect(opened.paths.stateDir).toBe(stateHome);
      expect(opened.paths.source).toBe("env-home");
    } finally {
      opened.db.close();
    }
  });

  test("describeStatePaths reflects current env", () => {
    const info = describeStatePaths();
    expect(info.stateDir).toBe(stateHome);
    expect(info.dbPath).toBe(join(stateHome, "calyx.db"));
    expect(info.envVars.home).toBe("CALYX_STATE_HOME");
    expect(info.envVars.db).toBe("CALYX_STATE_DB");
  });

  test("openStateStore creates dir at 0700 and applies pragmas", async () => {
    const opened = await openStateStore();
    try {
      expect(opened.driver.id).toBe(STATE_DRIVER_ID);
      expect(opened.foreignKeysEnabled).toBe(true);
      expect(opened.busyTimeoutMs).toBe(5000);
      expect(opened.journalMode.toLowerCase()).toBe("wal");
      expect(opened.createdStateDir).toBe(true);
      expect(opened.createdDb).toBe(true);
    } finally {
      opened.db.close();
    }

    if (process.platform !== "win32") {
      const dirStat = await stat(stateHome);
      expect(dirStat.mode & 0o777).toBe(STATE_DIR_MODE);
      const fileStat = await stat(join(stateHome, "calyx.db"));
      expect(fileStat.mode & 0o777).toBe(STATE_DB_FILE_MODE);
    }
  });

  test("openStateStore applies busy_timeout before other open-time pragmas", async () => {
    const baseDriver = await loadStateDriver();
    const execCalls: string[] = [];
    const driver: StateDriverModule = {
      ...baseDriver,
      open(path: string): StateDriverDatabase {
        const db = baseDriver.open(path);
        return {
          ...db,
          exec(sql: string): void {
            execCalls.push(sql);
            db.exec(sql);
          },
          prepare: (sql) => db.prepare(sql),
          close: () => db.close(),
          get isOpen() {
            return db.isOpen;
          },
        };
      },
    };

    const opened = await openStateStore({ driver });
    try {
      expect(opened.busyTimeoutMs).toBe(5000);
    } finally {
      opened.db.close();
    }

    const firstPragma = execCalls.find((sql) => sql.startsWith("PRAGMA "));
    expect(firstPragma).toBe("PRAGMA busy_timeout = 5000;");
    expect(execCalls.indexOf("PRAGMA busy_timeout = 5000;")).toBeLessThan(
      execCalls.indexOf("PRAGMA journal_mode = WAL;"),
    );
    expect(execCalls.indexOf("PRAGMA busy_timeout = 5000;")).toBeLessThan(
      execCalls.indexOf("PRAGMA foreign_keys = ON;"),
    );
  });

  test("planStateMigrations reports all migrations as pending on a fresh DB", async () => {
    const plan = await planStateMigrations();
    expect(plan.driver).toBe(STATE_DRIVER_ID);
    expect(plan.target).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
    expect(plan.current).toBeNull();
    expect(plan.pending.length).toBe(STATE_MIGRATIONS.length);
    expect(plan.applied.length).toBe(0);
    expect(plan.ledgerExists).toBe(false);
  });

  test("planStateMigrations on a missing DB does not create state dir or db file", async () => {
    await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" });
    const plan = await planStateMigrations();
    expect(plan.pending.length).toBe(STATE_MIGRATIONS.length);
    expect(plan.ledgerExists).toBe(false);
    await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateHome, "calyx.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("planStateMigrations on an existing DB does not mutate it (read-only)", async () => {
    await applyStateMigrations();
    const dbPath = join(stateHome, "calyx.db");
    const beforeMain = (await stat(dbPath)).mtimeMs;
    // Wait one millisecond so any spurious mtime tick would be observable.
    await new Promise((r) => setTimeout(r, 5));
    const plan = await planStateMigrations();
    expect(plan.pending.length).toBe(0);
    expect(plan.ledgerExists).toBe(true);
    expect(plan.current).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
    const afterMain = (await stat(dbPath)).mtimeMs;
    expect(afterMain).toBe(beforeMain);
    if (process.platform !== "win32") {
      expect((await stat(dbPath)).mode & 0o777).toBe(STATE_DB_FILE_MODE);
    }
  });

  test("applyStateMigrations is idempotent and creates the ledger", async () => {
    const first = await applyStateMigrations();
    expect(first.applied.length).toBe(STATE_MIGRATIONS.length);
    expect(first.current).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
    const second = await applyStateMigrations();
    expect(second.applied.length).toBe(0);
    expect(second.alreadyApplied.length).toBe(STATE_MIGRATIONS.length);
    const third = await planStateMigrations();
    expect(third.pending.length).toBe(0);
    expect(third.current).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
  });

  test("reportStateHealth reflects pending state until migrations apply", async () => {
    const before = await reportStateHealth();
    expect(before.pendingMigrations).toBe(STATE_MIGRATIONS.length);
    expect(before.ok).toBe(false);
    expect(before.migrationConsistency.status).toBe("no-ledger");

    await applyStateMigrations();
    const after = await reportStateHealth();
    expect(after.pendingMigrations).toBe(0);
    expect(after.ok).toBe(true);
    expect(after.foreignKeysEnabled).toBe(true);
    expect(after.busyTimeoutMs).toBe(5000);
    expect(after.journalMode.toLowerCase()).toBe("wal");
    expect(after.lastMigration?.id).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
    if (process.platform !== "win32") {
      expect(after.directoryMode.modeOctal).toBe(STATE_DIR_MODE.toString(8).padStart(3, "0"));
      expect(after.databaseMode.modeOctal).toBe(STATE_DB_FILE_MODE.toString(8).padStart(3, "0"));
    }
  });

  test("runStateDoctor flags pending migrations as blocking and clears after apply", async () => {
    const before = await runStateDoctor();
    expect(before.ok).toBe(false);
    expect(before.findings.some((f) => f.code === "pending-migrations")).toBe(true);
    await applyStateMigrations();
    const after = await runStateDoctor();
    expect(after.ok).toBe(true);
    expect(after.findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });

  // POL-2090: a host's schema only advances when something runs there, so a
  // store routinely outlives the build that migrated it. These cases pin the
  // mechanism that makes that survivable, and the boundary where it stops.
  test("an older build's migrator is a no-op against a forward-migrated store", async () => {
    await applyStateMigrations();
    const olderBuildSource = STATE_MIGRATIONS.slice(0, STATE_MIGRATIONS.length - 3);
    const olderTarget = olderBuildSource[olderBuildSource.length - 1]!.id;

    // Boot-time convergence on the older build: pending is source-minus-ledger,
    // so extra ledger rows classify as nothing to do rather than as an error.
    const applied = await applyStateMigrations({ migrations: olderBuildSource });
    expect(applied.applied).toEqual([]);
    expect(applied.current).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]!.id);
    expect(applied.target).toBe(olderTarget);

    const plan = await planStateMigrations({ migrations: olderBuildSource });
    expect(plan.pending).toEqual([]);
    expect(classifyStateSchema(plan.current, plan.target)).toBe("ahead");

    // The older build can still name the divergence: consistency reports the
    // ledger ids it does not know, which is what `state doctor` surfaces.
    const opened = await openStateStore();
    try {
      const consistency = checkMigrationConsistency(opened.db, olderBuildSource);
      expect(consistency.status).toBe("drift");
      expect(consistency.unknownIds).toEqual(
        STATE_MIGRATIONS.slice(-3).map((migration) => migration.id),
      );
    } finally {
      opened.db.close();
    }
  });

  test("classifyStateSchema names the direction a store diverges in", () => {
    expect(classifyStateSchema("0034", "0034")).toBe("current");
    expect(classifyStateSchema("0019", "0034")).toBe("behind");
    expect(classifyStateSchema("0034", "0018")).toBe("ahead");
    // A store with no ledger is behind everything the source declares.
    expect(classifyStateSchema(null, "0034")).toBe("behind");
    expect(classifyStateSchema(null, null)).toBe("current");
    expect(classifyStateSchema("0001", null)).toBe("ahead");
  });

  test("countStateMigrationsAfter measures a remote head against this source", () => {
    const source = STATE_MIGRATIONS.slice(0, 5);
    expect(countStateMigrationsAfter("0005", source)).toBe(0);
    expect(countStateMigrationsAfter("0003", source)).toBe(2);
    expect(countStateMigrationsAfter(null, source)).toBe(5);
    // A head beyond the source counts nothing pending; direction is
    // `classifyStateSchema`'s job, not this counter's.
    expect(countStateMigrationsAfter("0099", source)).toBe(0);
  });

  test("doctor reports drift when ledger contains an unknown migration", async () => {
    const opened = await openStateStore();
    try {
      computeMigrationPlan(opened.db, STATE_MIGRATIONS, opened.driver.id); // no-op assertion that plan works pre-apply
    } finally {
      opened.db.close();
    }
    await applyStateMigrations();
    const opened2 = await openStateStore();
    try {
      opened2.db
        .prepare(
          `INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)`,
        )
        .run("9999", "manually-injected", new Date().toISOString());
    } finally {
      opened2.db.close();
    }
    const report = await runStateDoctor();
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === "migration-drift")).toBe(true);
    expect(report.migrationConsistency.unknownIds).toContain("9999");
  });
});

describe("CALYX_STATE_DB override path", () => {
  let dir: string;
  let originalDb: string | undefined;

  beforeEach(async () => {
    dir = await makeTempStateHome();
    originalDb = process.env["CALYX_STATE_DB"];
    process.env["CALYX_STATE_DB"] = join(dir, "alt.db");
  });

  afterEach(async () => {
    if (originalDb === undefined) delete process.env["CALYX_STATE_DB"];
    else process.env["CALYX_STATE_DB"] = originalDb;
    await rm(dir, { recursive: true, force: true });
  });

  test("opens the database at the override path", async () => {
    await applyStateMigrations();
    const stats = await stat(join(dir, "alt.db"));
    expect(stats.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(STATE_DB_FILE_MODE);
    }
  });

  test("describeStatePaths reflects env-db source", async () => {
    // Touch a file at override location to ensure path describe is independent of state.
    await writeFile(join(dir, "noop.txt"), "x");
    const info = describeStatePaths();
    expect(info.source).toBe("env-db");
    expect(info.dbPath).toBe(join(dir, "alt.db"));
  });
});
