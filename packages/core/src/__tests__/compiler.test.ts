import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { compileFromFiles, parseTomlToObject } from "../compile";

async function writeFixturePair(fleetText: string, hostText: string): Promise<{ fleetPath: string; hostPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-core-test-"));
  const fleetPath = path.join(root, "fleet.v2.yaml");
  const hostPath = path.join(root, "host.yaml");
  await Promise.all([writeFile(fleetPath, fleetText, "utf8"), writeFile(hostPath, hostText, "utf8")]);
  return { fleetPath, hostPath };
}

describe("compileFromFiles", () => {
  test("expands tokens and applies append_unique array policy", async () => {
    const fixtures = await writeFixturePair(
      `version: "2"
array_policies:
  default: replace
  by_path:
    codex.profiles.*.trusted_paths: append_unique
codex:
  top_level:
    profile: full-auto
  profiles:
    full-auto:
      trusted_paths:
        - "{{home}}/.agents"
        - "{{home}}/repo"
`,
      `host: blade
user: caleb
home: /home/caleb
codex:
  profiles:
    full-auto:
      trusted_paths:
        - /home/caleb/repo
        - /datasets
`
    );

    const result = await compileFromFiles(fixtures);
    const parsed = parseTomlToObject(result.tomlText);
    const trustedPaths = (parsed.profiles as Record<string, any>)["full-auto"].trusted_paths;

    expect(trustedPaths).toEqual(["/home/caleb/.agents", "/home/caleb/repo", "/datasets"]);
  });

  test("supports project defaults plus extras", async () => {
    const fixtures = await writeFixturePair(
      `version: "2"
codex:
  projects:
    defaults:
      - path: "{{home}}/projects"
        trust_level: trusted
`,
      `host: mba
user: caleb
home: /Users/caleb
codex:
  projects:
    extra:
      - /Users/caleb/repo/polli
`
    );

    const result = await compileFromFiles(fixtures);
    const parsed = parseTomlToObject(result.tomlText);
    expect((parsed.projects as Record<string, unknown>)["/Users/caleb/projects"]).toEqual({ trust_level: "trusted" });
    expect((parsed.projects as Record<string, unknown>)["/Users/caleb/repo/polli"]).toEqual({ trust_level: "trusted" });
  });
});
