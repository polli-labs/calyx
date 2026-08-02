import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProgram } from "../run-cli";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "calyx-oracle-cli-"));
  tempDirs.push(root);
  return root;
}

describe("oracle command", () => {
  test("buildProgram registers oracle in top-level help", () => {
    const program = buildProgram();
    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain("oracle");
  });

  test("oracle init writes scaffold and bundle plan emits JSON", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "init",
      "pol-1087-oracle-bundle-rfc",
      "--issue",
      "POL-1087",
      "--project",
      "calyx",
      "--out-dir",
      outDir,
      "--json",
    ]);

    const initPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { inquiry_dir: string };
    expect(initPayload.inquiry_dir).toBe(outDir);
    expect(await readFile(path.join(outDir, "inquiry.yaml"), "utf8")).toContain("POL-1087");

    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "bundle",
      outDir,
      "--plan",
      "--json",
    ]);

    const planPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      version: string;
      outputs: Array<{ path: string }>;
    };
    expect(planPayload.version).toBe("oracle-bundle-plan/v1");
    expect(planPayload.outputs.map((output) => output.path)).toContain("oracle-response-skeleton.md");
  });

  test("oracle bundle --apply writes manifest JSON", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(path.join(vaultPath, "note.md"), "# note\n", "utf8");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "init",
      "pol-1180-oracle-apply",
      "--out-dir",
      outDir,
    ]);
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1180-oracle-apply
prompt:
  path: oracle-prompt.md
vault:
  files:
    - note.md
`,
      "utf8",
    );

    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "bundle",
      outDir,
      "--apply",
      "--vault-path",
      vaultPath,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      version: string;
      manifest: { outputs: Array<{ path: string }> };
    };
    expect(payload.version).toBe("oracle-bundle-apply/v1");
    expect(payload.manifest.outputs.map((output) => output.path)).toContain("context/vault-context.md");
    expect(await readFile(path.join(outDir, "receipts", "bundle.manifest.json"), "utf8")).toContain(
      "oracle-bundle-manifest/v1",
    );
  });

  test("oracle run --dry-run emits Gemini plan JSON and blocks OpenAI policy", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    const vaultPath = path.join(root, "vault");
    await mkdir(vaultPath, { recursive: true });
    await writeFile(path.join(vaultPath, "note.md"), "# note\n", "utf8");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "oracle", "init", "pol-1232-oracle-run", "--out-dir", outDir]);
    await writeFile(
      path.join(outDir, "inquiry.yaml"),
      `version: oracle-bundle/v1
id: pol-1232-oracle-run
prompt:
  path: oracle-prompt.md
vault:
  files:
    - note.md
`,
      "utf8",
    );
    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "bundle",
      outDir,
      "--apply",
      "--vault-path",
      vaultPath,
      "--json",
    ]);

    await program.parseAsync(["node", "calyx", "oracle", "run", outDir, "--dry-run", "--json"]);

    const planPayload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      version: string;
      provider: string;
      ready: boolean;
      attachments: Array<{ path: string }>;
    };
    expect(planPayload.version).toBe("oracle-run-plan/v1");
    expect(planPayload.provider).toBe("gemini");
    expect(planPayload.ready).toBe(true);
    expect(planPayload.attachments.map((attachment) => attachment.path)).toContain("context/vault-context.md");

    await expect(
      program.parseAsync(["node", "calyx", "oracle", "run", outDir, "--dry-run", "--provider", "openai"]),
    ).rejects.toThrow(/OpenAI\/GPT Pro API oracle runs are not supported/);
  });

  test("oracle synthesize writes scaffold JSON", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "oracle-response-gemini-sandbox.md"), "# response\n", "utf8");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "oracle", "synthesize", outDir, "--json"]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as {
      version: string;
      responses: Array<{ path: string }>;
      wrote: boolean;
    };
    expect(payload.version).toBe("oracle-synthesis/v1");
    expect(payload.responses.map((response) => response.path)).toEqual(["oracle-response-gemini-sandbox.md"]);
    expect(payload.wrote).toBe(true);
    expect(await readFile(path.join(outDir, "oracle-synthesis.md"), "utf8")).toContain("## Strong Convergence");
  });

  test("oracle doctor reports broken inquiry as non-ok JSON", async () => {
    const root = await tempRoot();
    const outDir = path.join(root, "inquiry");
    await mkdir(outDir, { recursive: true });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "calyx",
      "oracle",
      "doctor",
      outDir,
      "--json",
    ]);

    const payload = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { ok: boolean; findings: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.findings.some((finding) => finding.code === "recipe_invalid")).toBe(true);
    expect(process.exitCode).toBe(3);
  });

});
