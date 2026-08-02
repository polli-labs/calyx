import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadWorkflowFile, renderWorkflowPrompt } from "../workflow.js";

describe("workflow loader", () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  test("loads WORKFLOW.md frontmatter and normalizes repo/workspace paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  team: Polli Labs
  project: Calyx
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 2
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 3
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}} in {{WORKSPACE_PATH}}
`,
      "utf8",
    );

    const workflow = await loadWorkflowFile(workflowPath, {
      now: () => "2026-03-20T00:00:00.000Z",
    });

    expect(workflow.path).toBe(workflowPath);
    expect(workflow.config.workspace.repo_root).toBe(root);
    expect(workflow.config.workspace.ref).toBe("HEAD");
    expect(workflow.config.polling.continuation_delay_seconds).toBe(1);
    expect(workflow.config.polling.max_retries).toBe(5);
    expect(workflow.prompt_template).toContain("{{ISSUE_IDENTIFIER}}");
  });

  test("keeps workflow execution limits backend-specific", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-limits-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const workflow = (backend: "claude" | "codex", limit: string) => `---
tracker:
  kind: linear
  active_states: [Todo]
  terminal_states: [Done]
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 1
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: ${backend}
  max_turns_per_run: 1
  ${limit}
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}}
`;

    await writeFile(workflowPath, workflow("claude", "max_turns: 8"), "utf8");
    expect((await loadWorkflowFile(workflowPath)).config.agent.max_turns).toBe(8);

    await writeFile(workflowPath, workflow("claude", "max_threads: 8"), "utf8");
    await expect(loadWorkflowFile(workflowPath)).rejects.toThrow("Claude does not support max_threads");

    await writeFile(workflowPath, workflow("codex", "max_turns: 8"), "utf8");
    await expect(loadWorkflowFile(workflowPath)).rejects.toThrow("Codex does not support max_turns");
  });

  test("renders prompt variables with Calyx token replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-render-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  active_states: [Todo]
  terminal_states: [Done]
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 1
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 1
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}} at {{WORKSPACE_PATH}}
`,
      "utf8",
    );

    const workflow = await loadWorkflowFile(workflowPath);
    const rendered = renderWorkflowPrompt(workflow, {
      ISSUE_IDENTIFIER: "POL-918",
      WORKSPACE_PATH: "/tmp/workspace",
    });

    expect(rendered).toContain("POL-918");
    expect(rendered).toContain("/tmp/workspace");
  });

  test("defaults claim_state to 'In Progress' and handoff_state to 'In Review'", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-defaults-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  active_states: [Todo]
  terminal_states: [Done]
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 1
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 1
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}} at {{WORKSPACE_PATH}}
`,
      "utf8",
    );

    const workflow = await loadWorkflowFile(workflowPath);
    expect(workflow.config.tracker.claim_state).toBe("In Progress");
    expect(workflow.config.tracker.handoff_state).toBe("In Review");
  });

  test("honors explicit claim_state and handoff_state overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-overrides-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  active_states: [Todo]
  terminal_states: [Done]
  claim_state: Doing
  handoff_state: Awaiting Review
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 1
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 1
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}}
`,
      "utf8",
    );

    const workflow = await loadWorkflowFile(workflowPath);
    expect(workflow.config.tracker.claim_state).toBe("Doing");
    expect(workflow.config.tracker.handoff_state).toBe("Awaiting Review");
  });

  test("fails on unresolved workflow placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "calyx-workflow-unresolved-"));
    created.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  active_states: [Todo]
  terminal_states: [Done]
polling:
  interval_seconds: 60
  idle_backoff_seconds: 15
  max_interval_seconds: 300
  stall_timeout_seconds: 900
  max_concurrent_agents: 1
workspace:
  root: ${join(root, "wt")}
  branch_template: calyx/{{IDENTIFIER}}
agent:
  backend: codex
  max_turns_per_run: 1
logging:
  level: info
---
Issue {{ISSUE_IDENTIFIER}} at {{WORKSPACE_PATH}}
`,
      "utf8",
    );

    const workflow = await loadWorkflowFile(workflowPath);

    expect(() => renderWorkflowPrompt(workflow, { ISSUE_IDENTIFIER: "POL-918" })).toThrow(/unresolved placeholders/i);
  });
});
