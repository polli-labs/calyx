import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname as systemHostname, tmpdir } from "node:os";
import path from "node:path";
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const tempRoots: string[] = [];

function createAdminClientFactory(fetchImpl: typeof fetch): typeof createCalyxAdminClient {
  return (options) => createCalyxAdminClient({
    ...options,
    fetch: fetchImpl,
  });
}

function currentHostAlias(): string {
  return systemHostname().trim().split(".")[0]?.toLowerCase() ?? "";
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function seedManagedConfigs(root: string): Promise<{ managedConfigsRoot: string; liveHome: string }> {
  const managedConfigsRoot = path.join(root, "managed-configs");
  const liveHome = path.join(root, "home");
  await mkdir(path.join(managedConfigsRoot, "shared"), { recursive: true });

  await writeFile(
    path.join(managedConfigsRoot, "shared", "config.toml"),
    'profile = "full-auto"\nmodel = "gpt-5.4"\n',
    "utf8",
  );
  await writeFile(
    path.join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
    `${JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { defaultMode: "allowEdits" },
        env: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(managedConfigsRoot, "shared", "claude.mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          "linear-server": {
            type: "http",
            url: "https://mcp.linear.app/mcp",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { managedConfigsRoot, liveHome };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-config command", () => {
  test("runtime-config plan emits JSON receipts", async () => {
    const root = await makeTempRoot("calyx-runtime-config-cli-plan-");
    const { managedConfigsRoot, liveHome } = await seedManagedConfigs(root);
    const localHost = currentHostAlias();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "runtime-config",
      "plan",
      "--managed-configs-root",
      managedConfigsRoot,
      "--host",
      localHost,
      "--home",
      liveHome,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      backend: string;
      mode: string;
      requestedHost: string;
      summary: { total: number; drift: number };
    };
    expect(payload.backend).toBe("runtime-config");
    expect(payload.mode).toBe("plan");
    expect(payload.requestedHost).toBe(localHost);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.drift).toBe(3);
  });

  test("runtime-config verify exits 3 when live config drifts from managed truth", async () => {
    const root = await makeTempRoot("calyx-runtime-config-cli-verify-");
    const { managedConfigsRoot, liveHome } = await seedManagedConfigs(root);
    const localHost = currentHostAlias();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node",
        "calyx",
        "runtime-config",
        "verify",
        "--managed-configs-root",
        managedConfigsRoot,
        "--host",
        localHost,
        "--home",
        liveHome,
        "--json",
      ]),
    ).rejects.toMatchObject({ exitCode: 3 });

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as { ok: boolean };
    expect(payload.ok).toBe(false);
  });

  test("runtime-config refuses the deleted remote transport flags", async () => {
    const root = await makeTempRoot("calyx-runtime-config-cli-remote-");
    const { managedConfigsRoot, liveHome } = await seedManagedConfigs(root);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      });
      const body = JSON.parse(String(init?.body)) as {
        contractVersion: string;
        backend: string;
        options: { host: string; managedConfigsRoot?: string; liveHome: string };
      };
      expect(body.contractVersion).toBe("host-backend/v1");
      expect(body.backend).toBe("runtime-config");
      expect(body.options.host).toBe("worm");
      expect(body.options.managedConfigsRoot).toBe(managedConfigsRoot);
      expect(body.options.liveHome).toBe(liveHome);

      return new Response(
        JSON.stringify({
          contractVersion: "local-backend/v1",
          backend: "runtime-config",
          mode: "plan",
          host: "worm",
          ok: false,
          generatedAt: "2026-04-06T12:00:00.000Z",
          summary: { total: 3, ok: 0, drift: 3, changed: 3, applied: 0 },
          items: [],
          managedConfigsRoot,
          liveHome,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const program = buildProgram({
      runCli: {
        createAdminClient: createAdminClientFactory(fetchImpl),
        tokenForHost: () => "secret-token",
      },
    });

    await expect(program.parseAsync([
      "node",
      "calyx",
      "runtime-config",
      "plan",
      "--managed-configs-root",
      managedConfigsRoot,
      "--host",
      "worm",
      "--home",
      liveHome,
      "--server-url",
      "http://worm:8740",
      "--json",
    ])).rejects.toThrow();

    expect(out).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("runtime-config plan falls back to the canonical managed truth root when the flag is omitted", async () => {
    const root = await makeTempRoot("calyx-runtime-config-cli-default-root-");
    const liveHome = path.join(root, "home");
    const localHost = currentHostAlias();
    const managedConfigsRoot = path.join(liveHome, "dev", "agents-infra", "dev", "fleet", "configs");
    await mkdir(path.join(managedConfigsRoot, "shared"), { recursive: true });
    await writeFile(
      path.join(managedConfigsRoot, "shared", "config.toml"),
      'profile = "full-auto"\nmodel = "gpt-5.4"\n',
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "shared", "claude.user.global.settings.template.json"),
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/claude-code-settings.json",
          permissions: { defaultMode: "allowEdits" },
          env: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(managedConfigsRoot, "shared", "claude.mcp.json"),
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      "utf8",
    );
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "runtime-config",
      "plan",
      "--host",
      localHost,
      "--home",
      liveHome,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      managedConfigsRoot: string;
      requestedHost: string;
    };
    expect(payload.managedConfigsRoot).toBe(managedConfigsRoot);
    expect(payload.requestedHost).toBe(localHost);
  });
});
