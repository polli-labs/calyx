import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { allPackages } from "../../../../scripts/lib/workspace.mjs";
import { INTERFACE_EXTERNAL_SERVICE_DESCRIPTORS, INTERFACE_MANIFEST_RECORDS } from "../interface-manifest";

function docsRoot(): string {
  return path.resolve(process.cwd(), "docs");
}

/**
 * Docs coherence tests.
 *
 * These assertions verify that the CLI reference documentation stays in
 * sync with the implemented command surface. If a new domain command is
 * added without updating the docs, these tests will fail.
 */

describe("CLI reference completeness", () => {
  test("documents all domain command groups", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredGroups = [
      "## Doctor",
      "## Verify Commands",
      "## Bundle Commands",
      "## Install Commands",
      "## Config Commands",
      "## Instructions Commands",
      "## Skills Commands",
      "## Tools Commands",
      "## Prompts Commands",
      "## Agents Commands",
      "## Knowledge Commands",
      "## Context Commands",
      "## MCP Commands",
      "## Runtime Config Commands",
      "## Run Commands",
      "## Exec Commands",
      "## Retired Wrappers"
    ];

    for (const group of requiredGroups) {
      expect(cliRef, `CLI reference missing section: ${group}`).toContain(group);
    }
  });

  test("documents all canonical subcommands", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const requiredSubcommands = [
      "calyx doctor",
      "calyx verify fleet",
      "calyx bundle build",
      "calyx install bootstrap",
      "calyx config compile",
      "calyx config show",
      "calyx instructions trace",
      "calyx instructions render",
      "calyx instructions verify",
      "calyx skills index",
      "calyx skills show",
      "calyx skills sync",
      "calyx skills validate",
      "calyx tools index",
      "calyx tools sync",
      "calyx tools validate",
      "calyx prompts index",
      "calyx prompts render",
      "calyx prompts sync",
      "calyx prompts validate",
      "calyx agents list",
      "calyx agents show",
      "calyx agents validate",
      "calyx knowledge index",
      "calyx knowledge search",
      "calyx knowledge link",
      "calyx knowledge validate",
      "calyx context capabilities",
      "calyx context plan",
      "calyx context pack",
      "calyx context docs",
      "calyx context introspect",
      "calyx mcp manifest",
      "calyx mcp serve",
      "calyx runtime-config plan",
      "calyx runtime-config apply",
      "calyx runtime-config verify",
      "calyx run launch",
      "calyx run status",
      "calyx run await",
      "calyx run receipt",
      "calyx run kernel-receipt",
      "calyx run ps",
      "calyx run logs",
      "calyx run audit-terminal-authority",
      "calyx run stop",
      "calyx run reconcile",
      "calyx run serve",
      "calyx exec launch",
      "calyx exec status",
      "calyx exec logs",
      "calyx exec receipt",
      "calyx exec validate"
    ];

    for (const cmd of requiredSubcommands) {
      expect(cliRef, `CLI reference missing subcommand: ${cmd}`).toContain(cmd);
    }
  });

  test("documents retired wrappers with canonical replacements", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    const retiredWrappers = [
      "skills-sync",
      "skills-sync-claude",
      "skills-sync-codex",
      "prompts-sync-claude",
      "prompts-sync-codex",
      "agents-render",
      "exec-launch"
    ];

    for (const wrapper of retiredWrappers) {
      expect(cliRef, `CLI reference missing retired wrapper: ${wrapper}`).toContain(wrapper);
    }
  });

  test("documents the Wave 4 interface manifest skeleton and first covered records", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    expect(cliRef).toContain("## Interface Manifest");
    expect(cliRef).toContain("calyx.interface-manifest/v0");
    expect(cliRef).toContain("selection_contract_ref");
    expect(cliRef).toContain("stop_condition_contract_ref");
    expect(cliRef).toContain("Remote Body Worktree");

    for (const record of INTERFACE_MANIFEST_RECORDS) {
      if (record.invocation_kind === "http_api") {
        expect(record.docs_links).toContain("docs/architecture/consumer-api.md");
        continue;
      }
      const expected = record.invocation_kind === "commander"
        ? `calyx ${record.path.join(" ")}`
        : record.agent_context.command_path;
      expect(cliRef, `CLI reference missing interface manifest surface: ${expected}`).toContain(expected);
    }

    for (const descriptor of INTERFACE_EXTERNAL_SERVICE_DESCRIPTORS) {
      expect(cliRef, `CLI reference missing external descriptor: ${descriptor.id}`).toContain(descriptor.id);
    }
  });

  test("keeps one current self-upgrade section aligned with the manifest", async () => {
    const [cliRef, operatorRunbook] = await Promise.all([
      readFile(path.join(docsRoot(), "cli-reference.md"), "utf8"),
      readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8"),
    ]);
    const selfUpgrade = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "self.upgrade");
    const exitOne = Object.entries(selfUpgrade?.error_contract.exit_codes ?? {})
      .find(([code]) => code === "1")?.[1];
    const guardrailNotes = Object.entries(selfUpgrade?.safety_contract ?? {})
      .find(([field]) => field === "guardrail_notes")?.[1];

    expect(exitOne).toContain("unverified");
    expect(selfUpgrade?.error_contract.common_failures)
      .toContain("unverifiable current-invocation receipt");
    expect(guardrailNotes)
      .toContain("Failed, unverified, or skipped non-dry-run fleet hosts are persisted as pending daemon_build rows with promoted_rev/running_rev payload fields when known.");
    expect(cliRef.match(/^### `calyx self upgrade`$/gm)).toHaveLength(1);
    expect(cliRef.match(/^### `calyx self health`$/gm)).toHaveLength(1);
    expect(cliRef.match(/^### `calyx self drift`$/gm)).toHaveLength(1);
    expect(cliRef.match(/^### `calyx self freshness`$/gm)).toHaveLength(1);
    expect(cliRef.match(/^### `calyx self nudge`$/gm)).toHaveLength(1);
    expect(cliRef).toContain("current-invocation receipt (`unverified`)");
    expect(operatorRunbook).toContain("A fleet host row with `status=unverified`");
    expect(operatorRunbook).toContain("`upgrade_receipt_auth_unavailable` warning predicts");
    expect(operatorRunbook).toContain("`--fail-fast`\n  stops only after `status=failed`");
    expect(operatorRunbook).toContain("`verification_receipt=<host>:<route>`");
  });

  test("does not claim blanket JSON support on current first-contact surfaces", async () => {
    const docs = await Promise.all([
      readFile(path.resolve(process.cwd(), "README.md"), "utf8"),
      readFile(path.join(docsRoot(), "onboarding.md"), "utf8"),
      readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8"),
      readFile(path.join(docsRoot(), "cli-reference.md"), "utf8"),
    ]);
    const currentFirstContact = docs.join("\n");

    expect(currentFirstContact).not.toMatch(/(?:all|every) commands? supports? `--json`/i);
    expect(currentFirstContact).toContain(
      "Data-bearing commands expose `--json` where their help documents it.",
    );
  });

  test("keeps historical planning and rollout artifacts out of current docs", async () => {
    const docFiles = await readdir(docsRoot(), { recursive: true });
    for (const retiredDirectory of ["adr/archive/", "execplans/", "planning/", "receipts/"]) {
      expect(docFiles.some((file) => file.startsWith(retiredDirectory) && file.endsWith(".md"))).toBe(false);
    }

    const retiredPaths = [
      "ops-soak-pol-698-receipts.md",
      "ci-signal-revalidation-receipts.md",
      "post-ga-watchlist.md",
      "post-ga-incident-checklist.md",
      "post-ga-support-playbook.md",
      "rc-checklist.md",
      "migration-guide.md",
      "migration-wrappers.md",
      "migration-docstore-workflows.md",
      "skills-subsumption-catalogue.md",
    ];

    for (const retiredPath of retiredPaths) {
      await expect(access(path.join(docsRoot(), retiredPath))).rejects.toThrow();
    }
  });

  test("documents host_process as the durable local process path", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");

    expect(cliRef).toContain("host_process");
    expect(cliRef).toContain("single operator-facing orchestration surface");
    expect(cliRef).toContain("not the durable-process path");
  });

  test("keeps current HTTP guidance on the versioned profile-prefixed contract", async () => {
    const cliRef = await readFile(path.join(docsRoot(), "cli-reference.md"), "utf8");
    const operatorRunbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");
    const consumerApi = await readFile(path.join(docsRoot(), "architecture", "consumer-api.md"), "utf8");
    const currentCliRef = cliRef
      .split("\n")
      .filter((line) => !line.includes("pre-PR1 `/health` payloads"))
      .join("\n");

    expect(currentCliRef).not.toMatch(/calyx run serve --token/);
    expect(currentCliRef).not.toMatch(/POST \/v1\/messages(?:`|\s|$)/);
    expect(currentCliRef).not.toContain("/local-backends/runtime-config/");
    expect(currentCliRef).not.toMatch(/GET \/health\b/);
    expect(currentCliRef).not.toMatch(/(?<!\/v1\/admin)\/events\/stream\b/);
    expect(operatorRunbook).not.toMatch(/(?<!\/v1\/admin)\/health\b/);

    expect(cliRef).toContain("POST /v1/internal/messages/receive");
    expect(cliRef).toContain("calyx.msg-forward/v1");
    expect(cliRef).toContain("GET  /v1/admin/activity/{activity_id}/attachments/{encoded_ref}");
    expect(cliRef).not.toContain("GET  /v1/activity/{activity_id}/attachments/{encoded_ref}");
    for (const route of [
      "GET /v1/messages/inbox",
      "GET /v1/messages/threads/{key}",
      "GET /v1/message-text/{messageId}",
      "GET /v1/message-operations/{outboxId}",
      "GET /v1/messages/doctor",
    ]) expect(consumerApi).toContain(route);
    expect(consumerApi).toContain("subject owns authority/provenance");
    expect(consumerApi).toContain("grant-authorized routable `reply_address`");

    for (const route of [
      "POST /v1/admin/monitors",
      "POST /v1/admin/monitors/{id}/cancel",
      "POST /v1/admin/monitors/wakes/{wakeId}/ack",
    ]) expect(cliRef).toContain(route);

    const currentSource = (await Promise.all([
      "packages/server/src/server.ts",
      "packages/cli/src/run-cli.ts",
      "packages/cli/src/self-drift.ts",
      "packages/cli/src/self-health.ts",
      "packages/cli/src/commands/self-upgrade.ts",
      "packages/core/src/interface-manifest.ts",
    ].map((file) => readFile(path.resolve(process.cwd(), file), "utf8")))).join("\n");
    expect(currentSource).not.toContain("/local-backends/runtime-config/");
    expect(currentSource).not.toMatch(/GET \/health\b/);
    expect(currentSource).not.toMatch(/(?<!\/v1\/admin)GET \/events\/stream\b/);
    expect(currentSource).not.toContain("isAuthorizedRequest");
    expect(currentSource).not.toContain("POST /v1/monitors requires");
  });
});

describe("architecture contract coherence", () => {
  test("keeps observation admission explicit and future cascade bounds global", async () => {
    const workflow = await readFile(path.join(docsRoot(), "architecture/workflow-engine.md"), "utf8");
    const consumerApi = await readFile(path.join(docsRoot(), "architecture/consumer-api.md"), "utf8");

    expect(workflow).toContain("an observation, not an instruction to execute");
    expect(workflow).toMatch(/A valid observation never grants\s+execution authority/);
    expect(workflow).toContain("positively constructed");
    expect(workflow).toContain("subject-scoped idempotency key");
    expect(workflow).toContain("chain-global hard bounds");
    expect(workflow).toContain("The first two callers forbid cascade-originated admissions entirely");
    expect(workflow).toMatch(
      /No generic scanner schema, cursor\/checkpoint protocol, replay registry, or\s+event acknowledgement contract lands in advance/,
    );
    expect(workflow).toMatch(/Copied per-child balances\s+are not chain-global enforcement/);
    expect(workflow).toMatch(
      /does not preselect a record\s+layout, transaction protocol, or cross-authority design/,
    );
    expect(consumerApi).toMatch(/Consumer-profile filings remain inert with respect to\s+workflow coordination/);
    expect(consumerApi).toMatch(
      /separately authorized internal\/control-plane\s+delivery effects retain their declared behavior/,
    );
  });
});

describe("README completeness", () => {
  test("README routes first contact to current authorities", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    const requiredRoutes = [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/onboarding.md",
      "docs/architecture/README.md",
      "docs/operator-runbook.md",
      "packages/cli/src/run-cli.ts",
      "packages/core/src/interface-manifest.ts",
    ];

    for (const route of requiredRoutes) {
      expect(readme, `README missing current route: ${route}`).toContain(route);
    }
  });

  test("README routes historical material out of current docs", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Historical plans, migration archaeology, rollout receipts");
    expect(readme).toContain("Git, Linear, or the vault");
  });

  test("README documents extension model", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("extension-sdk.md");
    expect(readme).toContain("@polli-labs/calyx-sdk");
  });

  /**
   * This test was named "the complete package inventory" while checking a
   * hand-written list of twelve names against the README — which can only ever
   * prove that the README still mentions the packages someone remembered in
   * March. Incompleteness was structurally undetectable: add a package, and
   * both the README and the list stay silently, identically wrong. The
   * inventory now comes from the workspace, and the row-set comparison runs in
   * both directions so a deleted package leaves a stale row behind loudly.
   */
  test("README documents the complete package inventory", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");
    const documented = new Map(
      [...readme.matchAll(/^\| `(?<name>[^`]+)` \| `(?<directory>packages\/[^`]+)` \|/gmu)]
        .map((row) => [row.groups!.name!, row.groups!.directory!]),
    );
    const derived = new Map(
      allPackages()
        .filter((workspacePackage) => workspacePackage.relativePath.startsWith("packages/"))
        .map((workspacePackage) => [workspacePackage.name, workspacePackage.relativePath]),
    );

    expect(Object.fromEntries(documented), "README package table drifted from the workspace")
      .toEqual(Object.fromEntries(derived));
  });

  test("README links to current docs", async () => {
    const readme = await readFile(path.resolve(process.cwd(), "README.md"), "utf8");

    const requiredLinks = [
      "docs/onboarding.md",
      "docs/production-wiring.md",
      "docs/cli-reference.md",
      "docs/extension-sdk.md",
      "docs/operator-runbook.md",
      "docs/ci-reliability-runbook.md",
      "docs/architecture/README.md",
      "docs/architecture/consumer-api.md",
      "docs/architecture/wire-contracts.md",
      "docs/architecture/session-ingress.md",
    ];

    for (const link of requiredLinks) {
      expect(readme, `README missing link: ${link}`).toContain(link);
    }
  });
});

describe("extension SDK doc completeness", () => {
  test("extension-sdk.md exists and has required sections", async () => {
    const sdkDoc = await readFile(path.join(docsRoot(), "extension-sdk.md"), "utf8");

    const requiredSections = [
      "## Concepts",
      "## Quick start",
      "## API Reference",
      "## Lifecycle",
      "## Compatibility"
    ];

    for (const section of requiredSections) {
      expect(sdkDoc, `extension-sdk.md missing section: ${section}`).toContain(section);
    }
  });

  test("extension-sdk.md documents all 8 domains", async () => {
    const sdkDoc = await readFile(path.join(docsRoot(), "extension-sdk.md"), "utf8");

    const domains = [
      "config", "instructions", "skills", "tools",
      "prompts", "agents", "knowledge", "exec"
    ];

    for (const domain of domains) {
      expect(sdkDoc, `extension-sdk.md missing domain: ${domain}`).toContain(domain);
    }
  });
});

describe("operator runbook completeness", () => {
  test("operator-runbook.md exists and has required sections", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    const requiredSections = [
      "## Prerequisites",
      "## Command pattern",
      "## Daily operator workflows",
      "## Operator verification checklist",
      "## Failure classification",
      "## Retired wrappers"
    ];

    for (const section of requiredSections) {
      expect(runbook, `operator-runbook.md missing section: ${section}`).toContain(section);
    }
  });

  test("operator-runbook.md covers operator run and exec validation commands", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    const domains = [
      "calyx config compile",
      "calyx runtime-config plan",
      "calyx runtime-config verify",
      "calyx instructions render",
      "calyx instructions verify",
      "calyx skills validate",
      "calyx tools validate",
      "calyx prompts validate",
      "calyx agents validate",
      "calyx knowledge validate",
      "calyx run launch",
      "calyx run status",
      "calyx run await",
      "calyx run receipt",
      "calyx exec validate"
    ];

    for (const cmd of domains) {
      expect(runbook, `operator-runbook.md missing command: ${cmd}`).toContain(cmd);
    }
  });

  test("operator-runbook.md keeps current retired-name routing", async () => {
    const runbook = await readFile(path.join(docsRoot(), "operator-runbook.md"), "utf8");

    expect(runbook).toContain("retired wrapper names are rejected");
    expect(runbook).toContain("canonical replacement");
  });
});

describe("onboarding guide completeness", () => {
  test("onboarding.md exists and has required sections", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const requiredSections = [
      "## Prerequisites",
      "## Install",
      "## First commands",
      "## Command surface map",
      "## Building extensions",
      "## Troubleshooting"
    ];

    for (const section of requiredSections) {
      expect(guide, `onboarding.md missing section: ${section}`).toContain(section);
    }
  });

  test("onboarding.md links to key reference docs", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const requiredLinks = [
      "cli-reference.md",
      "extension-sdk.md",
      "operator-runbook.md"
    ];

    for (const link of requiredLinks) {
      expect(guide, `onboarding.md missing link: ${link}`).toContain(link);
    }
  });

  test("onboarding.md covers extension domains plus first-party operator surfaces", async () => {
    const guide = await readFile(path.join(docsRoot(), "onboarding.md"), "utf8");

    const domains = [
      "config", "instructions", "skills", "tools",
      "prompts", "agents", "knowledge", "exec", "run", "runtime-config"
    ];

    for (const domain of domains) {
      expect(guide, `onboarding.md missing domain: ${domain}`).toContain(domain);
    }
  });
});

describe("production wiring doc completeness", () => {
  test("production-wiring.md exists and has required sections", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");

    const requiredSections = [
      "## Configuration Model",
      "## Quick Start",
      "## Environment Variable Reference",
      "## Config File Schema",
      "## Fixture Mode"
    ];

    for (const section of requiredSections) {
      expect(doc, `production-wiring.md missing section: ${section}`).toContain(section);
    }
  });

  test("production-wiring.md documents all domain env vars", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");

    const envVars = [
      "CALYX_SKILLS_REGISTRY",
      "CALYX_TOOLS_REGISTRY",
      "CALYX_PROMPTS_REGISTRY",
      "CALYX_AGENTS_REGISTRY",
      "CALYX_KNOWLEDGE_REGISTRY",
      "CALYX_EXEC_STORE",
      "CALYX_CONFIG"
    ];

    for (const envVar of envVars) {
      expect(doc, `production-wiring.md missing env var: ${envVar}`).toContain(envVar);
    }
  });

  test("production-wiring.md documents calyx config show", async () => {
    const doc = await readFile(path.join(docsRoot(), "production-wiring.md"), "utf8");
    expect(doc).toContain("calyx config show");
  });
});
