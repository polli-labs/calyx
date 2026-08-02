import { watch as watchFs } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyRuntimeConfig,
  planRuntimeConfig,
  resolveRuntimeConfigMutationReceiptPaths,
  RuntimeConfigApplyInProgressError,
  verifyRuntimeConfig,
  type RuntimeConfigMutationIntentReceiptV1,
  type RuntimeConfigMutationResultReceiptV1,
} from "../runtime-config";
import { loadStateDriver } from "../state/driver";
import type { ApiProvenanceV1 } from "../state/provenance";

const FIXED_TIME = new Date("2026-07-14T04:05:06.000Z");
const tempRoots: string[] = [];

function makeProvenance(requestId: string): ApiProvenanceV1 {
  return {
    schema_version: "calyx.provenance/v1",
    request_id: requestId,
    subject: "daemon:blade",
    asserted_actor: "operator:caleb",
    host: "blade",
    via: "http",
    at: FIXED_TIME.toISOString(),
  };
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function seedCodex(root: string, includeLive = true): Promise<{
  managedConfigsRoot: string;
  liveHome: string;
}> {
  const managedConfigsRoot = path.join(root, "managed-configs");
  const liveHome = path.join(root, "home");
  await mkdir(path.join(managedConfigsRoot, "carbon"), { recursive: true });
  await writeFile(
    path.join(managedConfigsRoot, "carbon", "config.toml"),
    [
      'profile = "full-auto"',
      'model = "desired-secret-model"',
      "",
      "[mcp_servers.private_service]",
      'url = "https://desired-secret.example/mcp"',
      "",
    ].join("\n"),
    "utf8",
  );
  if (includeLive) {
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(liveHome, ".codex", "config.toml"),
      'profile = "full-auto"\nmodel = "live-secret-model"\n',
      "utf8",
    );
  }
  return { managedConfigsRoot, liveHome };
}

async function seedClaudeSettings(root: string): Promise<{ managedConfigsRoot: string; liveHome: string }> {
  const managedConfigsRoot = path.join(root, "managed-configs");
  const liveHome = path.join(root, "home");
  await mkdir(path.join(managedConfigsRoot, "shared"), { recursive: true });
  await writeFile(
    path.join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
    `${JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { defaultMode: "allowEdits" },
      env: { PRIVATE_TOKEN: "desired-secret-token" },
    }, null, 2)}\n`,
    "utf8",
  );
  return { managedConfigsRoot, liveHome };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-config mutation provenance", () => {
  test("writes deterministic, bounded, private, durable per-component receipts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
    const roots = await Promise.all([
      makeTempRoot("calyx-runtime-provenance-a-"),
      makeTempRoot("calyx-runtime-provenance-b-"),
    ]);
    const provenance = {
      ...makeProvenance("req_12345678-1234-4123-8123-123456789abc"),
      ignored_secret: "provenance-secret-that-must-be-stripped",
    } as ApiProvenanceV1;
    const serializedReceipts: string[][] = [];

    for (const root of roots) {
      const { managedConfigsRoot, liveHome } = await seedCodex(root);
      const result = await applyRuntimeConfig({
        host: "carbon",
        managedConfigsRoot,
        liveHome,
        components: ["codex"],
      }, provenance);
      expect(result.items[0]?.status).toBe("applied");

      const paths = resolveRuntimeConfigMutationReceiptPaths(liveHome, provenance.request_id, "codex");
      const intentText = await readFile(paths.intent, "utf8");
      const resultText = await readFile(paths.result, "utf8");
      serializedReceipts.push([intentText, resultText]);
      expect((await readdir(path.dirname(paths.intent))).sort()).toEqual([
        "codex.intent.json",
        "codex.result.json",
      ]);
      expect((await stat(paths.intent)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.result)).mode & 0o777).toBe(0o600);
      expect(Buffer.byteLength(intentText, "utf8")).toBeLessThan(16 * 1024);
      expect(Buffer.byteLength(resultText, "utf8")).toBeLessThan(16 * 1024);

      for (const text of [intentText, resultText]) {
        expect(text).not.toContain("desired-secret-model");
        expect(text).not.toContain("live-secret-model");
        expect(text).not.toContain("desired-secret.example");
        expect(text).not.toContain("provenance-secret-that-must-be-stripped");
        expect(text).not.toContain(managedConfigsRoot);
        expect(text).not.toContain(liveHome);
      }

      const intent = JSON.parse(intentText) as RuntimeConfigMutationIntentReceiptV1;
      const applied = JSON.parse(resultText) as RuntimeConfigMutationResultReceiptV1;
      expect(intent).toMatchObject({
        schema_version: "calyx.runtime-config-mutation-intent/v1",
        apply_id: provenance.request_id,
        component: "codex",
        target_locator: "~/.codex/config.toml",
        planned_phases: ["backup", "target", "state"],
        phase: "intent",
        outcome: "pending",
        recorded_at: FIXED_TIME.toISOString(),
        provenance: makeProvenance(provenance.request_id),
      });
      expect(applied).toMatchObject({
        schema_version: "calyx.runtime-config-mutation-result/v1",
        apply_id: provenance.request_id,
        component: "codex",
        planned_phases: ["backup", "target", "state"],
        phase: "complete",
        outcome: "applied",
        completed_phases: ["backup", "target", "state"],
        intent_recorded_at: FIXED_TIME.toISOString(),
        recorded_at: FIXED_TIME.toISOString(),
      });
      expect(applied.hashes.output_sha256).toBe(applied.hashes.desired_sha256);
    }

    expect(serializedReceipts[0]).toEqual(serializedReceipts[1]);
  });

  test("validates provenance before mutation and keeps plan and verify receipt-free", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-validation-");
    const { managedConfigsRoot, liveHome } = await seedCodex(root);
    const options = { host: "carbon", managedConfigsRoot, liveHome, components: ["codex"] as const };

    await planRuntimeConfig({ ...options, components: [...options.components] });
    await verifyRuntimeConfig({ ...options, components: [...options.components] });
    await expect(stat(path.join(liveHome, ".calyx", "receipts"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidProvenance = {
      ...makeProvenance("req_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      subject: "not canonical",
    } as ApiProvenanceV1;
    await expect(applyRuntimeConfig({ ...options, components: [...options.components] }, invalidProvenance))
      .rejects.toThrow("provenance subject must be a canonical credential client_id");
    await expect(stat(path.join(liveHome, ".calyx", "receipts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(liveHome, ".codex", "config.toml"), "utf8")).toContain("live-secret-model");
  });

  test("rejects a concurrent apply before planning or mutation and succeeds after lock release", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-lock-");
    const { managedConfigsRoot, liveHome } = await seedCodex(root);
    const targetPath = path.join(liveHome, ".codex", "config.toml");
    const beforeTarget = await readFile(targetPath, "utf8");
    const lockPath = path.join(liveHome, ".calyx", "runtime-config-apply.lock.sqlite3");
    await mkdir(path.dirname(lockPath), { recursive: true });
    const driver = await loadStateDriver();
    const holder = driver.open(lockPath);
    holder.exec("BEGIN IMMEDIATE");
    const provenance = makeProvenance("req_dddddddd-dddd-4ddd-8ddd-dddddddddddd");

    try {
      await expect(applyRuntimeConfig({
        host: "carbon",
        managedConfigsRoot,
        liveHome,
        components: ["codex"],
      }, provenance)).rejects.toBeInstanceOf(RuntimeConfigApplyInProgressError);
      expect(await readFile(targetPath, "utf8")).toBe(beforeTarget);
      await expect(stat(path.join(liveHome, ".calyx", "runtime-config-state.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(liveHome, ".calyx", "receipts")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    await expect(applyRuntimeConfig({
      host: "carbon",
      managedConfigsRoot,
      liveHome,
      components: ["codex"],
    }, provenance)).resolves.toMatchObject({
      mode: "apply",
      items: [expect.objectContaining({ component: "codex", status: "applied" })],
    });
  });

  test("rejects malformed request ids in the public receipt-path contract", () => {
    expect(() => resolveRuntimeConfigMutationReceiptPaths(
      "/tmp/runtime-config-home",
      "req_12345678123441238123123456789abc----",
      "codex",
    )).toThrow("validated request id or deterministic local id");
  });

  test("rejects runtime component traversal before constructing receipt paths", () => {
    expect(() => resolveRuntimeConfigMutationReceiptPaths(
      "/tmp/runtime-config-home",
      "req_12345678-1234-4123-8123-123456789abc",
      "../../outside" as unknown as "codex",
    )).toThrow("component must be one of: codex, claude-settings, claude-mcp");
  });

  test("keeps prior component receipts honest when a later backup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_TIME);
    const root = await makeTempRoot("calyx-runtime-provenance-partial-");
    const codex = await seedCodex(root, false);
    await seedClaudeSettings(root);
    await mkdir(path.join(codex.liveHome, ".claude"), { recursive: true });
    const claudePath = path.join(codex.liveHome, ".claude", "settings.json");
    const originalClaude = '{"env":{"PRIVATE_TOKEN":"live-secret-token"}}\n';
    await writeFile(claudePath, originalClaude, "utf8");
    await mkdir(`${claudePath}.bak.2026-07-14T040506000Z`);
    const provenance = makeProvenance("req_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    await expect(applyRuntimeConfig({
      host: "carbon",
      managedConfigsRoot: codex.managedConfigsRoot,
      liveHome: codex.liveHome,
      components: ["codex", "claude-settings"],
    }, provenance)).rejects.toThrow();

    const codexPaths = resolveRuntimeConfigMutationReceiptPaths(codex.liveHome, provenance.request_id, "codex");
    const claudePaths = resolveRuntimeConfigMutationReceiptPaths(
      codex.liveHome,
      provenance.request_id,
      "claude-settings",
    );
    const codexResult = await readJson<RuntimeConfigMutationResultReceiptV1>(codexPaths.result);
    const claudeIntent = await readJson<RuntimeConfigMutationIntentReceiptV1>(claudePaths.intent);
    const claudeResult = await readJson<RuntimeConfigMutationResultReceiptV1>(claudePaths.result);

    expect(codexResult).toMatchObject({ outcome: "applied", phase: "complete" });
    expect(claudeIntent).toMatchObject({ outcome: "pending", planned_phases: ["backup", "target"] });
    expect(claudeResult).toMatchObject({
      outcome: "failed",
      phase: "backup",
      completed_phases: [],
      failure_id: "runtime_config_backup_failed",
    });
    expect(await readFile(path.join(codex.liveHome, ".codex", "config.toml"), "utf8")).toContain(
      "desired-secret-model",
    );
    expect(await readFile(claudePath, "utf8")).toBe(originalClaude);
  });

  test("does not record applied when durable target persistence fails after intent", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-target-failure-");
    const { managedConfigsRoot, liveHome } = await seedClaudeSettings(root);
    const targetDirectory = path.join(liveHome, ".claude");
    await mkdir(targetDirectory, { recursive: true });
    await chmod(targetDirectory, 0o500);
    const provenance = makeProvenance("req_cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    try {
      await expect(applyRuntimeConfig({
        host: "carbon",
        managedConfigsRoot,
        liveHome,
        components: ["claude-settings"],
      }, provenance)).rejects.toThrow();
    } finally {
      await chmod(targetDirectory, 0o700);
    }

    const paths = resolveRuntimeConfigMutationReceiptPaths(liveHome, provenance.request_id, "claude-settings");
    expect(await readJson<RuntimeConfigMutationIntentReceiptV1>(paths.intent)).toMatchObject({
      outcome: "pending",
      planned_phases: ["target"],
    });
    expect(await readJson<RuntimeConfigMutationResultReceiptV1>(paths.result)).toMatchObject({
      outcome: "failed",
      phase: "target",
      completed_phases: [],
      failure_id: "runtime_config_target_failed",
    });
    await expect(stat(path.join(targetDirectory, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("records a partial result rather than applied when ownership-state durability fails", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-state-failure-");
    const { managedConfigsRoot, liveHome } = await seedCodex(root, false);
    const provenance = makeProvenance("req_dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const paths = resolveRuntimeConfigMutationReceiptPaths(liveHome, provenance.request_id, "codex");
    await mkdir(path.dirname(paths.intent), { recursive: true, mode: 0o700 });
    const calyxStateDirectory = path.join(liveHome, ".calyx");
    let permissionChanged: (() => void) | undefined;
    const permissionChange = new Promise<void>((resolve) => { permissionChanged = resolve; });
    const watcher = watchFs(path.dirname(paths.intent), (_event, filename) => {
      if (filename !== path.basename(paths.intent)) return;
      void chmod(calyxStateDirectory, 0o500).then(() => permissionChanged?.());
    });

    try {
      await expect(applyRuntimeConfig({
        host: "carbon",
        managedConfigsRoot,
        liveHome,
        components: ["codex"],
      }, provenance)).rejects.toThrow();
      await permissionChange;
    } finally {
      watcher.close();
      await chmod(calyxStateDirectory, 0o700);
    }

    expect(await readJson<RuntimeConfigMutationIntentReceiptV1>(paths.intent)).toMatchObject({
      outcome: "pending",
      planned_phases: ["target", "state"],
    });
    const result = await readJson<RuntimeConfigMutationResultReceiptV1>(paths.result);
    expect(result).toMatchObject({
      outcome: "partial",
      phase: "state",
      completed_phases: ["target"],
      failure_id: "runtime_config_state_failed",
    });
    expect(result.hashes.output_sha256).toBe(result.hashes.desired_sha256);
    expect(await readFile(path.join(liveHome, ".codex", "config.toml"), "utf8")).toContain(
      "desired-secret-model",
    );
    await expect(stat(path.join(calyxStateDirectory, "runtime-config-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves the effect failure when failure-receipt persistence also fails", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-double-failure-");
    const { managedConfigsRoot, liveHome } = await seedClaudeSettings(root);
    const provenance = makeProvenance("req_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const paths = resolveRuntimeConfigMutationReceiptPaths(liveHome, provenance.request_id, "claude-settings");
    await mkdir(paths.result, { recursive: true });
    const targetDirectory = path.join(liveHome, ".claude");
    await mkdir(targetDirectory, { recursive: true });
    await chmod(targetDirectory, 0o500);

    let thrown: unknown;
    try {
      await applyRuntimeConfig({
        host: "carbon",
        managedConfigsRoot,
        liveHome,
        components: ["claude-settings"],
      }, provenance);
    } catch (error) {
      thrown = error;
    } finally {
      await chmod(targetDirectory, 0o700);
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(await readJson<RuntimeConfigMutationIntentReceiptV1>(paths.intent)).toMatchObject({ outcome: "pending" });
    expect((await stat(paths.result)).isDirectory()).toBe(true);
  });

  test("fails closed instead of replacing or following a live target symlink", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-symlink-");
    const { managedConfigsRoot, liveHome } = await seedCodex(root, false);
    const linkedTarget = path.join(root, "operator-owned-config.toml");
    const original = 'profile = "full-auto"\nmodel = "operator-owned"\n';
    await writeFile(linkedTarget, original, "utf8");
    await mkdir(path.join(liveHome, ".codex"), { recursive: true });
    const targetPath = path.join(liveHome, ".codex", "config.toml");
    await symlink(linkedTarget, targetPath);
    const provenance = makeProvenance("req_ffffffff-ffff-4fff-8fff-ffffffffffff");

    await expect(applyRuntimeConfig({
      host: "carbon",
      managedConfigsRoot,
      liveHome,
      components: ["codex"],
    }, provenance)).rejects.toThrow("target is a symbolic link");

    const paths = resolveRuntimeConfigMutationReceiptPaths(liveHome, provenance.request_id, "codex");
    expect(await readJson<RuntimeConfigMutationIntentReceiptV1>(paths.intent)).toMatchObject({
      outcome: "pending",
      planned_phases: ["backup", "target", "state"],
    });
    expect(await readJson<RuntimeConfigMutationResultReceiptV1>(paths.result)).toMatchObject({
      outcome: "failed",
      phase: "target",
      completed_phases: [],
      failure_id: "runtime_config_target_failed",
    });
    expect(await readFile(linkedTarget, "utf8")).toBe(original);
    expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
  });

  test("refuses a symlink anywhere in the fixed receipt-directory chain", async () => {
    const root = await makeTempRoot("calyx-runtime-provenance-receipt-symlink-");
    const { managedConfigsRoot, liveHome } = await seedCodex(root);
    const externalReceipts = path.join(root, "external-receipts");
    await mkdir(path.join(liveHome, ".calyx"), { recursive: true });
    await mkdir(externalReceipts);
    await symlink(externalReceipts, path.join(liveHome, ".calyx", "receipts"));
    const provenance = makeProvenance("req_11111111-1111-4111-8111-111111111111");

    await expect(applyRuntimeConfig({
      host: "carbon",
      managedConfigsRoot,
      liveHome,
      components: ["codex"],
    }, provenance)).rejects.toThrow("is a symbolic link; refusing redirected evidence");

    expect(await readdir(externalReceipts)).toEqual([]);
    expect(await readFile(path.join(liveHome, ".codex", "config.toml"), "utf8")).toContain("live-secret-model");
  });
});
