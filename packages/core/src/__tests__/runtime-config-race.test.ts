import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const sourceOpenRace = vi.hoisted(() => ({
  candidatePath: "",
  afterCandidateRealpath: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (pathValue: PathLike): Promise<string> => {
      const resolved = await actual.realpath(pathValue);
      const hook = sourceOpenRace.afterCandidateRealpath;
      if (hook && String(pathValue) === sourceOpenRace.candidatePath) {
        sourceOpenRace.afterCandidateRealpath = undefined;
        await hook();
      }
      return resolved;
    },
  };
});

import { planRuntimeConfig } from "../runtime-config";

const tempRoots: string[] = [];

async function seedRaceFixture(prefix: string): Promise<{
  root: string;
  managedConfigsRoot: string;
  hostDirectory: string;
  candidatePath: string;
  outsideDirectory: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  const managedConfigsRoot = path.join(root, "managed-configs");
  const hostDirectory = path.join(managedConfigsRoot, "carbon");
  const outsideDirectory = path.join(root, "outside-carbon");
  await Promise.all([
    mkdir(hostDirectory, { recursive: true }),
    mkdir(outsideDirectory, { recursive: true }),
  ]);
  const candidatePath = path.join(hostDirectory, "config.toml");
  await Promise.all([
    writeFile(candidatePath, 'model = "trusted"\n', "utf8"),
    writeFile(path.join(outsideDirectory, "config.toml"), 'model = "attacker"\n', "utf8"),
  ]);
  return { root, managedConfigsRoot, hostDirectory, candidatePath, outsideDirectory };
}

afterEach(async () => {
  sourceOpenRace.candidatePath = "";
  sourceOpenRace.afterCandidateRealpath = undefined;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime-config managed-source race resistance", () => {
  test("rejects a host-directory symlink swap between candidate realpath and open", async () => {
    const fixture = await seedRaceFixture("calyx-runtime-config-directory-race-");
    let raceTriggered = false;
    sourceOpenRace.candidatePath = fixture.candidatePath;
    sourceOpenRace.afterCandidateRealpath = async () => {
      raceTriggered = true;
      await rename(fixture.hostDirectory, `${fixture.hostDirectory}.trusted`);
      await symlink(fixture.outsideDirectory, fixture.hostDirectory, "dir");
    };

    await expect(planRuntimeConfig({
      host: "carbon",
      managedConfigsRoot: fixture.managedConfigsRoot,
      liveHome: path.join(fixture.root, "home"),
      components: ["codex"],
    })).rejects.toThrow(/changed before it could be opened|escapes|changed during source open/);
    expect(raceTriggered).toBe(true);
  });

  test("rejects a managed-root symlink swap between candidate realpath and open", async () => {
    const fixture = await seedRaceFixture("calyx-runtime-config-root-race-");
    const outsideManagedRoot = path.join(fixture.root, "outside-managed-root");
    await mkdir(path.join(outsideManagedRoot, "carbon"), { recursive: true });
    await writeFile(
      path.join(outsideManagedRoot, "carbon", "config.toml"),
      'model = "root-attacker"\n',
      "utf8",
    );
    let raceTriggered = false;
    sourceOpenRace.candidatePath = fixture.candidatePath;
    sourceOpenRace.afterCandidateRealpath = async () => {
      raceTriggered = true;
      await rename(fixture.managedConfigsRoot, `${fixture.managedConfigsRoot}.trusted`);
      await symlink(outsideManagedRoot, fixture.managedConfigsRoot, "dir");
    };

    await expect(planRuntimeConfig({
      host: "carbon",
      managedConfigsRoot: fixture.managedConfigsRoot,
      liveHome: path.join(fixture.root, "home"),
      components: ["codex"],
    })).rejects.toThrow(/changed before it could be opened|escapes|changed during source open/);
    expect(raceTriggered).toBe(true);
  });
});
