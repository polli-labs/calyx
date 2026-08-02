import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  doctorRepoRegistry,
  listRunServeHosts,
  resolveRepo,
  resolveRepoIdentity,
  resolveRepoClone,
  resolveRepoForRun,
  resolveVaultUri,
  suggestNearestRepos,
} from "../agents-infra";
import { runDoctor } from "../doctor";

const execFileP = promisify(execFile);

async function createAgentsInfraFixture(options: {
  includeCarbonHost?: boolean;
  includeCarbonLinnaeus?: boolean;
} = {}): Promise<{
  root: string;
  bladeHome: string;
  carbonHome: string;
  hostsPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-agents-infra-"));
  const bladeHome = path.join(root, "home", "caleb");
  const carbonHome = path.join(root, "home", "carbon");
  const skillsRegistryPath = path.join(root, "instructions", "skills", "SOURCES.json");
  const templateRegistryPath = path.join(root, "instructions", "templates", "REGISTRY.json");
  const hostsPath = path.join(root, "fleet", "truths", "hosts.yaml");

  await mkdir(path.dirname(skillsRegistryPath), { recursive: true });
  await mkdir(path.dirname(templateRegistryPath), { recursive: true });
  await mkdir(path.dirname(hostsPath), { recursive: true });
  await mkdir(bladeHome, { recursive: true });
  await mkdir(carbonHome, { recursive: true });

  await writeFile(
    skillsRegistryPath,
    `${JSON.stringify({ version: "test", skills: [] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    templateRegistryPath,
    `${JSON.stringify({
      globals: {
        hot: "instructions/templates/global/AGENTS.global.hot.md.mustache",
        variants: [],
        legacy: [],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  const hosts = {
    blade: {
      home: bladeHome,
      vault_root: path.join(bladeHome, "vault", "fieldwork"),
      run_serve_url: "http://blade:8740",
      repos: {
        calyx: path.join(bladeHome, "dev", "calyx", "dev"),
        "agents-infra": path.join(bladeHome, "dev", "agents-infra", "dev"),
      },
    },
    worm: {
      home: path.join(root, "worm-home"),
    },
    ...(options.includeCarbonHost === false
      ? {}
      : {
          carbon: {
            home: carbonHome,
            vault_root: "/Users/carbon/vault/fieldwork",
            run_serve_url: "http://carbon:8740",
            repos: {
              calyx: path.join(carbonHome, "dev", "calyx", "dev"),
              ...(options.includeCarbonLinnaeus
                ? { linnaeus: path.join(carbonHome, "dev", "linnaeus", "dev") }
                : {}),
            },
          },
        }),
  };

  await writeFile(
    hostsPath,
    YAML.stringify({
      hosts,
    }),
    "utf8",
  );

  return { root, bladeHome, carbonHome, hostsPath };
}

async function initGitRepo(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await execFileP("git", ["init"], { cwd: repoPath });
}

describe("resolveVaultUri", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("resolves a blade vault URI against the target host vault_root", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(
      resolveVaultUri("vault://20-plans/foo.md", "blade", fixture.root),
    ).resolves.toBe(path.join(fixture.bladeHome, "vault", "fieldwork", "20-plans", "foo.md"));
  });

  test("resolves a carbon vault URI against the target host vault_root", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(
      resolveVaultUri("vault://10-daily/2026-04-18/foo.md", "carbon", fixture.root),
    ).resolves.toBe("/Users/carbon/vault/fieldwork/10-daily/2026-04-18/foo.md");
  });

  test("maps local host to the current host alias before resolving vault_root", async () => {
    const fixture = await createAgentsInfraFixture({ includeCarbonHost: false });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.bladeHome;

    await expect(
      resolveVaultUri("vault://50-projects/calyx/workstreams/bar.md", "local", fixture.root),
    ).resolves.toBe(
      path.join(fixture.bladeHome, "vault", "fieldwork", "50-projects", "calyx", "workstreams", "bar.md"),
    );
  });

  test("throws an actionable error when the target host has no vault_root", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(
      resolveVaultUri("vault://20-plans/foo.md", "worm", fixture.root),
    ).rejects.toThrow(
      'Host "worm" has no vault_root configured in fleet/truths/hosts.yaml. Add it or pass an absolute --execplan-ref path.',
    );
  });

  test("passes absolute paths through unchanged when the ref is not a vault URI", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(
      resolveVaultUri("/tmp/plan.md", "blade", fixture.root),
    ).resolves.toBe("/tmp/plan.md");
  });
});

describe("resolveRepo", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("resolves a configured repo slug for the target host", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepo("calyx", "blade", fixture.root)).resolves.toBe(
      path.join(fixture.bladeHome, "dev", "calyx", "dev"),
    );
  });

  test("keeps scalar repo entries working", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepoIdentity("agents-infra", "blade", fixture.root)).resolves.toEqual({
      slug: "agents-infra",
      path: path.join(fixture.bladeHome, "dev", "agents-infra", "dev"),
    });
  });

  test("resolves explicit aliases to the canonical host-truth slug", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const polliRoot = path.join(fixture.bladeHome, "dev", "polli", "dev");
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              polli: {
                path: polliRoot,
                aliases: ["polli-labs/polli", "github:polli-labs/polli"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    await expect(resolveRepoIdentity("polli-labs/polli", "blade", fixture.root)).resolves.toEqual({
      slug: "polli",
      path: polliRoot,
    });
    await expect(resolveRepo("github:polli-labs/polli", "blade", fixture.root)).resolves.toBe(polliRoot);
  });

  test("derives conventional private-dev leaves from explicit remote identities", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const repos = ["calyx", "typus", "ibrida", "linnaeus", "cosmos"] as const;
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: Object.fromEntries(repos.map((repo) => [repo, {
              path: path.join(fixture.bladeHome, "dev", repo, "dev"),
              aliases: [`polli-labs/${repo}-dev`],
            }])),
          },
        },
      }),
      "utf8",
    );

    for (const repo of repos) {
      await expect(resolveRepoIdentity(`${repo}-dev`, "blade", fixture.root)).resolves.toEqual({
        slug: repo,
        path: path.join(fixture.bladeHome, "dev", repo, "dev"),
      });
    }
  });

  test("refuses a private-dev leaf derived by more than one registered remote", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              "calyx-polli": {
                path: path.join(fixture.bladeHome, "dev", "calyx-polli", "dev"),
                aliases: ["polli-labs/calyx-dev"],
              },
              "calyx-shadow": {
                path: path.join(fixture.bladeHome, "dev", "calyx-shadow", "dev"),
                aliases: ["frontierkodiak/calyx-dev"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    await expect(resolveRepoIdentity("calyx-dev", "blade", fixture.root)).rejects.toThrow(
      /Repo identifier "calyx-dev" is ambiguous[\s\S]*calyx-polli[\s\S]*calyx-shadow[\s\S]*Refuse to guess/,
    );
  });

  test("refuses a derived private-dev leaf that collides with a canonical slug", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              "calyx-dev": path.join(fixture.bladeHome, "dev", "calyx-public", "dev"),
              calyx: {
                path: path.join(fixture.bladeHome, "dev", "calyx", "dev"),
                aliases: ["polli-labs/calyx-dev"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    await expect(resolveRepoIdentity("calyx-dev", "blade", fixture.root)).rejects.toThrow(
      /Repo identifier "calyx-dev" is ambiguous[\s\S]*calyx \([\s\S]*calyx-dev \([\s\S]*Refuse to guess/,
    );
  });

  test("normalizes GitHub URL aliases", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const polliRoot = path.join(fixture.bladeHome, "dev", "polli", "dev");
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              polli: {
                path: polliRoot,
                aliases: ["github:polli-labs/polli"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    await expect(resolveRepo("git@github.com:polli-labs/polli.git", "blade", fixture.root)).resolves.toBe(polliRoot);
    await expect(resolveRepo("https://github.com/polli-labs/polli.git", "blade", fixture.root)).resolves.toBe(polliRoot);
  });

  test("reports slash-bearing unknown identifiers without basename guessing", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepo("polli-labs/calyx", "blade", fixture.root)).rejects.toThrow(
      /does not have repo slug or alias "polli-labs\/calyx"[\s\S]*Available repos on blade: agents-infra, calyx[\s\S]*must match an explicit configured alias[\s\S]*will not basename-guess/,
    );
  });

  test("refuses ambiguous repo aliases before choosing a canonical slug", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              "ibrida-public": {
                path: path.join(fixture.bladeHome, "dev", "ibrida-public", "dev"),
                aliases: ["polli-labs/ibrida"],
              },
              "ibrida-shadow": {
                path: path.join(fixture.bladeHome, "dev", "ibrida-shadow", "dev"),
                aliases: ["git@github.com:polli-labs/ibrida.git", "frontierkodiak/ibrida"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    await expect(resolveRepo("https://github.com/polli-labs/ibrida.git", "blade", fixture.root)).rejects.toThrow(
      /Repo identifier "https:\/\/github.com\/polli-labs\/ibrida.git" is ambiguous[\s\S]*ibrida-public[\s\S]*ibrida-shadow[\s\S]*Refuse to guess/,
    );
  });

  test("throws when the target host alias is unknown", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepo("calyx", "missing-host", fixture.root)).rejects.toThrow(
      'Unknown host alias "missing-host". Add it to fleet/truths/hosts.yaml.',
    );
  });

  test("throws an actionable error when the target host has no repos map", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepo("calyx", "worm", fixture.root)).rejects.toThrow(
      'Host "worm" has no repos configured in fleet/truths/hosts.yaml. Add the repo to fleet/truths/hosts.yaml or pass --worktree-path explicitly.',
    );
  });

  test("throws an actionable error when the repo slug is missing", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(resolveRepo("linnaeus", "blade", fixture.root)).rejects.toThrow(
      'Host "blade" does not have repo slug or alias "linnaeus" in fleet/truths/hosts.yaml. Available repos on blade: agents-infra, calyx. (Add the repo alias to fleet/truths/hosts.yaml or pass --worktree-path explicitly.)',
    );
  });
});

describe("repo registry run preflight", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];
  const originalAgentsInfraRoot = process.env["CALYX_AGENTS_INFRA_ROOT"];

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalAgentsInfraRoot === undefined) {
      delete process.env["CALYX_AGENTS_INFRA_ROOT"];
    } else {
      process.env["CALYX_AGENTS_INFRA_ROOT"] = originalAgentsInfraRoot;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("resolveRepoForRun rejects invalid configured repo roots with actionable context", async () => {
    const fixture = await createAgentsInfraFixture({ includeCarbonLinnaeus: true });
    roots.add(fixture.root);
    const configuredRoot = path.join(fixture.carbonHome, "dev", "linnaeus", "dev");
    await mkdir(configuredRoot, { recursive: true });

    await expect(resolveRepoForRun("linnaeus", "carbon", fixture.root)).rejects.toThrow(
      new RegExp([
        "Repo registry/config failure before worktree acquisition",
        "host: carbon",
        "repo: linnaeus",
        `configured_root: ${configuredRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ].join("[\\s\\S]*")),
    );
  });

  test("doctorRepoRegistry reports invalid and valid roots for the target host", async () => {
    const fixture = await createAgentsInfraFixture({ includeCarbonLinnaeus: true });
    roots.add(fixture.root);
    process.env["HOME"] = fixture.carbonHome;

    const linnaeusRoot = path.join(fixture.carbonHome, "dev", "linnaeus", "dev");
    await mkdir(linnaeusRoot, { recursive: true });
    const calyxRoot = path.join(fixture.carbonHome, "dev", "calyx", "dev");
    await initGitRepo(calyxRoot);

    const result = await doctorRepoRegistry({ agentsInfraRoot: fixture.root, host: "carbon" });

    expect(result.ok).toBe(false);
    expect(result.host).toBe("carbon");
    expect(result.source_path).toBe(fixture.hostsPath);
    expect(result.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "carbon",
          repo: "calyx",
          configured_root: calyxRoot,
          ok: true,
        }),
        expect.objectContaining({
          host: "carbon",
          repo: "linnaeus",
          configured_root: linnaeusRoot,
          ok: false,
          code: "repo-root-not-git-repository",
        }),
      ]),
    );
  });

  test("doctorRepoRegistry reports repo aliases for configured roots", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const polliRoot = path.join(fixture.bladeHome, "dev", "polli", "dev");
    await initGitRepo(polliRoot);
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              polli: {
                path: polliRoot,
                aliases: ["polli-labs/polli", "git@github.com:polli-labs/polli.git"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    const result = await doctorRepoRegistry({ agentsInfraRoot: fixture.root, host: "blade" });

    expect(result.ok).toBe(true);
    expect(result.alias_collisions).toBeUndefined();
    expect(result.roots).toEqual([
      expect.objectContaining({
        repo: "polli",
        aliases: ["polli-labs/polli", "git@github.com:polli-labs/polli.git"],
        normalized_aliases: ["polli-labs/polli"],
      }),
    ]);
  });

  test("doctorRepoRegistry flags normalized alias collisions", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const publicRoot = path.join(fixture.bladeHome, "dev", "ibrida", "dev");
    const shadowRoot = path.join(fixture.bladeHome, "dev", "ibrida-shadow", "dev");
    await initGitRepo(publicRoot);
    await initGitRepo(shadowRoot);
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              "ibrida-public": {
                path: publicRoot,
                aliases: ["polli-labs/ibrida"],
              },
              "ibrida-shadow": {
                path: shadowRoot,
                aliases: ["git@github.com:polli-labs/ibrida.git", "frontierkodiak/ibrida"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    const result = await doctorRepoRegistry({ agentsInfraRoot: fixture.root, host: "blade" });

    expect(result.ok).toBe(false);
    expect(result.alias_collisions).toEqual([
      {
        normalized_identity: "polli-labs/ibrida",
        aliases: ["git@github.com:polli-labs/ibrida.git", "polli-labs/ibrida"],
        repos: ["ibrida-public", "ibrida-shadow"],
      },
    ]);
  });

  test("doctorRepoRegistry exposes private-dev derivation and both collision classes", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const repoRoots = Object.fromEntries(
      ["calyx-polli", "calyx-shadow", "linnaeus", "linnaeus-dev"].map((repo) => [
        repo,
        path.join(fixture.bladeHome, "dev", repo, "dev"),
      ]),
    );
    await Promise.all(Object.values(repoRoots).map((repoRoot) => initGitRepo(repoRoot)));
    await writeFile(
      fixture.hostsPath,
      YAML.stringify({
        hosts: {
          blade: {
            home: fixture.bladeHome,
            repos: {
              "calyx-polli": {
                path: repoRoots["calyx-polli"],
                aliases: ["polli-labs/calyx-dev"],
              },
              "calyx-shadow": {
                path: repoRoots["calyx-shadow"],
                aliases: ["frontierkodiak/calyx-dev"],
              },
              linnaeus: {
                path: repoRoots["linnaeus"],
                aliases: ["polli-labs/linnaeus-dev"],
              },
              "linnaeus-dev": repoRoots["linnaeus-dev"],
            },
          },
        },
      }),
      "utf8",
    );

    const result = await doctorRepoRegistry({ agentsInfraRoot: fixture.root, host: "blade" });

    expect(result.ok).toBe(false);
    expect(result.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: "calyx-polli",
        aliases: ["polli-labs/calyx-dev", "calyx-dev"],
        normalized_aliases: ["calyx-dev", "polli-labs/calyx-dev"],
        configured_aliases: ["polli-labs/calyx-dev"],
        derived_aliases: ["calyx-dev"],
      }),
      expect.objectContaining({
        repo: "linnaeus",
        aliases: ["polli-labs/linnaeus-dev", "linnaeus-dev"],
        configured_aliases: ["polli-labs/linnaeus-dev"],
        derived_aliases: ["linnaeus-dev"],
      }),
    ]));
    expect(result.alias_collisions).toEqual([
      {
        normalized_identity: "calyx-dev",
        aliases: ["calyx-dev"],
        repos: ["calyx-polli", "calyx-shadow"],
      },
      {
        normalized_identity: "linnaeus-dev",
        aliases: ["linnaeus-dev"],
        repos: ["linnaeus", "linnaeus-dev"],
      },
    ]);
  });

  test("runDoctor reports repo-registry input errors instead of hiding them", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    const result = await runDoctor({ agentsInfraRoot: fixture.root, host: "missing-host" });

    expect(result.ok).toBe(false);
    expect(result.repoRegistry).toEqual(
      expect.objectContaining({
        ok: false,
        host: "missing-host",
        source_path: fixture.hostsPath,
        roots: [],
        code: "repo-registry-input-error",
      }),
    );
    expect(result.repoRegistry?.message).toContain('Unknown host alias "missing-host"');
  });

  test("runDoctor reports invalid explicit agents-infra roots", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const invalidRoot = path.join(fixture.root, "not-agents-infra");

    const result = await runDoctor({ agentsInfraRoot: invalidRoot, host: "carbon" });

    expect(result.ok).toBe(false);
    expect(result.repoRegistry).toEqual(
      expect.objectContaining({
        ok: false,
        host: "carbon",
        source_path: path.join(invalidRoot, "fleet", "truths", "hosts.yaml"),
        roots: [],
        code: "repo-registry-input-error",
      }),
    );
    expect(result.repoRegistry?.message).toContain("not a valid agents-infra checkout");
  });

  test("runDoctor reports invalid CALYX_AGENTS_INFRA_ROOT instead of falling through", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);
    const invalidRoot = path.join(fixture.root, "bad-env-root");
    process.env["CALYX_AGENTS_INFRA_ROOT"] = invalidRoot;

    const result = await runDoctor({ host: "carbon" });

    expect(result.ok).toBe(false);
    expect(result.repoRegistry).toEqual(
      expect.objectContaining({
        ok: false,
        host: "carbon",
        source_path: path.join(invalidRoot, "fleet", "truths", "hosts.yaml"),
        roots: [],
        code: "repo-registry-input-error",
      }),
    );
    expect(result.repoRegistry?.message).toContain("CALYX_AGENTS_INFRA_ROOT is not a valid agents-infra checkout");
  });
});

describe("resolveRepoClone", () => {
  const roots = new Set<string>();
  const originalHome = process.env["HOME"];

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }

    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("prefers nested dev repo clones for -dev repo ids before legacy base-name clones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-repo-clone-"));
    roots.add(root);
    const home = path.join(root, "home", "carbon");
    process.env["HOME"] = home;

    const nestedClone = path.join(home, "dev", "linnaeus", "dev", "linnaeus-dev");
    const legacyBaseClone = path.join(home, "repo", "linnaeus");
    await mkdir(path.join(nestedClone, ".git"), { recursive: true });
    await mkdir(path.join(legacyBaseClone, ".git"), { recursive: true });

    await expect(resolveRepoClone("polli-labs/linnaeus-dev")).resolves.toBe(nestedClone);
  });

  test("prefers nested dev clone over base-name dev clone when both exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-repo-clone-"));
    roots.add(root);
    const home = path.join(root, "home", "carbon");
    process.env["HOME"] = home;

    const nestedClone = path.join(home, "dev", "linnaeus", "dev", "linnaeus-dev");
    const baseClone = path.join(home, "dev", "linnaeus", "dev");
    await mkdir(path.join(nestedClone, ".git"), { recursive: true });
    await mkdir(path.join(baseClone, ".git"), { recursive: true });

    await expect(resolveRepoClone("polli-labs/linnaeus-dev")).resolves.toBe(nestedClone);
  });

  test("keeps resolving flat dev clones for repo ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-repo-clone-"));
    roots.add(root);
    const home = path.join(root, "home", "carbon");
    process.env["HOME"] = home;

    const flatClone = path.join(home, "dev", "calyx-dev", "dev");
    await mkdir(path.join(flatClone, ".git"), { recursive: true });

    await expect(resolveRepoClone("polli-labs/calyx-dev")).resolves.toBe(flatClone);
  });

  test("falls back to base-name dev clones for -dev repo ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-repo-clone-"));
    roots.add(root);
    const home = path.join(root, "home", "carbon");
    process.env["HOME"] = home;

    const baseClone = path.join(home, "dev", "linnaeus", "dev");
    await mkdir(path.join(baseClone, ".git"), { recursive: true });

    await expect(resolveRepoClone("polli-labs/linnaeus-dev")).resolves.toBe(baseClone);
  });

  test("keeps resolving legacy repo base-name clones for -dev repo ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "calyx-repo-clone-"));
    roots.add(root);
    const home = path.join(root, "home", "carbon");
    process.env["HOME"] = home;

    const legacyBaseClone = path.join(home, "repo", "linnaeus");
    await mkdir(path.join(legacyBaseClone, ".git"), { recursive: true });

    await expect(resolveRepoClone("polli-labs/linnaeus-dev")).resolves.toBe(legacyBaseClone);
  });
});

describe("listRunServeHosts", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  test("returns only hosts with configured run-serve URLs in stable host order", async () => {
    const fixture = await createAgentsInfraFixture();
    roots.add(fixture.root);

    await expect(listRunServeHosts(fixture.root)).resolves.toEqual([
      { host: "blade", runServeUrl: "http://blade:8740" },
      { host: "carbon", runServeUrl: "http://carbon:8740" },
    ]);
  });
});

describe("suggestNearestRepos", () => {
  const slugs = ["calyx", "ibrida", "linnaeus", "polli", "saffron-switchyard"];

  test("suggests a substring match for an unregistered identifier", () => {
    expect(suggestNearestRepos("saffron", slugs)).toContain("saffron-switchyard");
  });

  test("matches on the basename of a slash-bearing identifier", () => {
    expect(suggestNearestRepos("polli-labs/calyx", slugs)).toContain("calyx");
  });

  test("returns no suggestions for an unrelated identifier", () => {
    expect(suggestNearestRepos("zzz-unrelated", slugs)).toEqual([]);
  });

  test("caps the number of suggestions", () => {
    expect(
      suggestNearestRepos("cal", ["calyx", "calc", "calendar", "california", "other"]),
    ).toHaveLength(3);
  });
});
