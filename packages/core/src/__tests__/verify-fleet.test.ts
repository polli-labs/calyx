import path from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { verifyFleet } from "../verify-fleet";
import {
  ADAPTER_CACHE_ENV_VAR,
  CONFIG_ENV_VAR,
  DOCSTORE_ROOT_ENV_VAR,
  ENV_VARS,
  POLLI_ROOT_ENV_VAR,
  SOURCE_MODE_ENV_VAR
} from "../resolve";
import { AGENTS_INFRA_ROOT_ENV_VAR } from "../agents-infra";

function tempDir(): string {
  return path.join(tmpdir(), `calyx-verify-fleet-${randomUUID()}`);
}

function fixtureRoot(): string {
  return path.resolve(process.cwd(), "fixtures/domains");
}

const ENV_KEYS_TO_RESTORE = [
  CONFIG_ENV_VAR,
  SOURCE_MODE_ENV_VAR,
  POLLI_ROOT_ENV_VAR,
  DOCSTORE_ROOT_ENV_VAR,
  AGENTS_INFRA_ROOT_ENV_VAR,
  ADAPTER_CACHE_ENV_VAR,
  ...Object.values(ENV_VARS)
];

const envSnapshot = new Map<string, string | undefined>();

async function installAdapterFixtureRoots(baseDir: string): Promise<{
  polliRoot: string;
  agentsInfraRoot: string;
  docstoreRoot: string;
  cacheRoot: string;
}> {
  const polliRoot = path.join(baseDir, "polli");
  const agentsInfraRoot = path.join(baseDir, "agents-infra");
  const docstoreRoot = path.join(baseDir, "docstore");
  const cacheRoot = path.join(baseDir, "cache");

  await mkdir(path.join(polliRoot, "docs/org-kb/agents/skills"), { recursive: true });
  await mkdir(path.join(polliRoot, "docs/org-kb/agents/tools"), { recursive: true });
  await mkdir(path.join(polliRoot, "docs/org-kb/agents/prompts"), { recursive: true });
  await mkdir(path.join(agentsInfraRoot, "instructions/agents"), { recursive: true });
  await mkdir(path.join(agentsInfraRoot, "instructions/skills"), { recursive: true });
  await mkdir(path.join(agentsInfraRoot, "instructions/templates"), { recursive: true });
  await mkdir(path.join(agentsInfraRoot, "fleet/truths"), { recursive: true });
  await mkdir(path.join(docstoreRoot, "execplan/POL-999"), { recursive: true });

  await cp(
    path.join(fixtureRoot(), "skills/registry.valid.json"),
    path.join(polliRoot, "docs/org-kb/agents/skills/SOURCES.json")
  );
  await cp(
    path.join(fixtureRoot(), "tools/registry.valid.json"),
    path.join(polliRoot, "docs/org-kb/agents/tools/TOOLS.json")
  );
  await cp(
    path.join(fixtureRoot(), "prompts/registry.valid.json"),
    path.join(polliRoot, "docs/org-kb/agents/prompts/REGISTRY.json")
  );
  await cp(
    path.join(fixtureRoot(), "agents"),
    path.join(agentsInfraRoot, "instructions/agents"),
    { recursive: true }
  );
  await cp(
    path.join(fixtureRoot(), "skills/registry.valid.json"),
    path.join(agentsInfraRoot, "instructions/skills/SOURCES.json")
  );
  await writeFile(
    path.join(agentsInfraRoot, "instructions/templates/REGISTRY.json"),
    "{}\n",
    "utf8"
  );
  await writeFile(
    path.join(agentsInfraRoot, "fleet/truths/hosts.yaml"),
    "hosts: {}\n",
    "utf8"
  );
  await writeFile(
    path.join(docstoreRoot, "execplan/POL-999/EXECPLAN.md"),
    "# POL-999 Fixture ExecPlan\n\n- fixture content\n",
    "utf8"
  );

  return { polliRoot, agentsInfraRoot, docstoreRoot, cacheRoot };
}

describe("verifyFleet source mode behavior", () => {
  afterEach(async () => {
    for (const key of ENV_KEYS_TO_RESTORE) {
      const original = envSnapshot.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    envSnapshot.clear();
  });

  test("adapter mode validates all domains via adapter-backed fallback paths", async () => {
    const baseDir = tempDir();
    const { polliRoot, agentsInfraRoot, docstoreRoot, cacheRoot } = await installAdapterFixtureRoots(baseDir);

    for (const key of ENV_KEYS_TO_RESTORE) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }

    process.env[CONFIG_ENV_VAR] = "/nonexistent/config.json";
    process.env[SOURCE_MODE_ENV_VAR] = "adapter";
    process.env[POLLI_ROOT_ENV_VAR] = polliRoot;
    process.env[AGENTS_INFRA_ROOT_ENV_VAR] = agentsInfraRoot;
    process.env[DOCSTORE_ROOT_ENV_VAR] = docstoreRoot;
    process.env[ADAPTER_CACHE_ENV_VAR] = cacheRoot;

    try {
      const result = await verifyFleet({ strict: true });
      expect(result.ok).toBe(true);
      expect(result.domains).toHaveLength(6);
      expect(result.domains.every((entry) => !entry.message?.includes("Skipped"))).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  test("auto mode keeps legacy skip behavior when paths are not configured", async () => {
    for (const key of ENV_KEYS_TO_RESTORE) {
      envSnapshot.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env[CONFIG_ENV_VAR] = "/nonexistent/config.json";
    process.env[SOURCE_MODE_ENV_VAR] = "auto";

    const result = await verifyFleet({ strict: true });
    expect(result.ok).toBe(true);
    expect(result.domains).toHaveLength(6);
    expect(result.domains.every((entry) => entry.message?.includes("Skipped"))).toBe(true);
  });
});
