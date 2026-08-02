import { describe, expect, test } from "vitest";
import {
  CALYX_DAEMON_FEATURES,
  CALYX_DAEMON_FEATURE_LIST,
  FEATURE_DESCRIPTIONS,
  getDaemonCompatibilityRefusal,
  requiredFeaturesForIntent,
} from "../daemon-features";

const FIXED_NOW = new Date("2026-04-20T00:00:00.000Z");
const BASE_HEALTH = {
  build: {
    git_head: "945bcf3abcdef1234567890",
    built_at: "2026-04-18T00:00:00.000Z",
  },
  protocol_epoch: 1,
  supports_features: [...CALYX_DAEMON_FEATURE_LIST],
};

describe("requiredFeaturesForIntent", () => {
  test("applies the agent_runner kernel baseline by default", () => {
    expect(requiredFeaturesForIntent({})).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });

  test("keeps host_process on the health-only baseline", () => {
    expect(requiredFeaturesForIntent({ kernel: "host_process" })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
    ]);
  });

  test("adds vault and repo requirements for matching intent flags", () => {
    expect(requiredFeaturesForIntent({
      execplan_ref: "vault://20-plans/pol-1120.md",
      repo: "calyx",
    })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.vaultExecplanRefV1,
      CALYX_DAEMON_FEATURES.repoRegistryV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });

  test("detects prompt_ref defensively and de-duplicates pre-seeded features", () => {
    expect(requiredFeaturesForIntent({
      required_features: [
        CALYX_DAEMON_FEATURES.healthV1,
        CALYX_DAEMON_FEATURES.promptRefV1,
      ],
      prompt_ref: "prompt://registry/pol-1113",
    } as {
      required_features: typeof CALYX_DAEMON_FEATURE_LIST;
      prompt_ref: string;
    })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.promptRefV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });

  test("adds system prompt support only when replacement or append instructions are present", () => {
    expect(requiredFeaturesForIntent({ prompt: "regular prompt" })).not.toContain(
      CALYX_DAEMON_FEATURES.systemPromptV1,
    );
    expect(requiredFeaturesForIntent({ system_prompt: "Replace defaults." })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.systemPromptV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
    expect(requiredFeaturesForIntent({ append_system_prompt: "Add constraints." })).toContain(
      CALYX_DAEMON_FEATURES.systemPromptV1,
    );
  });

  test("adds artifact root support only when roots are declared", () => {
    expect(requiredFeaturesForIntent({})).not.toContain(CALYX_DAEMON_FEATURES.artifactRootsV1);
    expect(requiredFeaturesForIntent({ artifact_roots: ["packets"] })).toContain(
      CALYX_DAEMON_FEATURES.artifactRootsV1,
    );
  });

  test("adds typed output capture support only when a capture is declared", () => {
    expect(requiredFeaturesForIntent({})).not.toContain(CALYX_DAEMON_FEATURES.outputCaptureV1);
    expect(requiredFeaturesForIntent({ output_capture: { name: "proposal.json" } })).toContain(
      CALYX_DAEMON_FEATURES.outputCaptureV1,
    );
  });

  test("adds run handback support only when a binding is declared", () => {
    expect(requiredFeaturesForIntent({})).not.toContain(CALYX_DAEMON_FEATURES.runHandbackV1);
    expect(requiredFeaturesForIntent({ handback: { key: "review-thread" } })).toContain(
      CALYX_DAEMON_FEATURES.runHandbackV1,
    );
  });

  test("adds backend reasoning effort support only when a one-off effort is present", () => {
    expect(requiredFeaturesForIntent({ prompt: "regular prompt" })).not.toContain(
      CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
    );
    expect(requiredFeaturesForIntent({
      prompt: "Use a larger thinking budget.",
      backend_options: { reasoning_effort: "xhigh" },
    })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.backendReasoningEffortV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });

  test("adds backend model support only when a one-off model is present", () => {
    expect(requiredFeaturesForIntent({ prompt: "regular prompt" })).not.toContain(
      CALYX_DAEMON_FEATURES.backendModelV1,
    );
    expect(requiredFeaturesForIntent({
      prompt: "Use a requested Claude model.",
      backend_options: { model: "opus" },
    })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.backendModelV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });

  test("gates backend-native execution limits as one versioned contract", () => {
    expect(requiredFeaturesForIntent({ prompt: "regular prompt" })).not.toContain(
      CALYX_DAEMON_FEATURES.backendExecutionLimitsV1,
    );
    expect(requiredFeaturesForIntent({
      prompt: "Bound Claude turns.",
      backend_options: { max_turns: 8 },
    })).toContain(CALYX_DAEMON_FEATURES.backendExecutionLimitsV1);
    expect(requiredFeaturesForIntent({
      prompt: "Raise Codex concurrency.",
      backend_options: { max_threads: 8 },
    })).toContain(CALYX_DAEMON_FEATURES.backendExecutionLimitsV1);
  });

  test("requires agent runner activity support for the default agent_runner health surface", () => {
    expect(requiredFeaturesForIntent({ prompt: "regular prompt" })).toContain(
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    );
    expect(requiredFeaturesForIntent({
      prompt: "Watch liveness.",
      backend_options: { agent_activity: { stale_after_ms: 600000 } },
    })).toEqual([
      CALYX_DAEMON_FEATURES.healthV1,
      CALYX_DAEMON_FEATURES.agentRunnerV1,
      CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
      CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
      CALYX_DAEMON_FEATURES.agentRunnerActivityV1,
    ]);
  });
});

describe("daemon feature registry discipline", () => {
  test("keeps every feature description in lockstep with the registry", () => {
    expect(Object.keys(FEATURE_DESCRIPTIONS).sort()).toEqual(
      [...CALYX_DAEMON_FEATURE_LIST].sort(),
    );
  });

  test("registers the POL-1886 boot re-adopt capability flag", () => {
    expect(CALYX_DAEMON_FEATURES.runReadoptOnBootV1).toBe("run.readopt_on_boot/v1");
    expect(CALYX_DAEMON_FEATURE_LIST).toContain(CALYX_DAEMON_FEATURES.runReadoptOnBootV1);
    expect(FEATURE_DESCRIPTIONS[CALYX_DAEMON_FEATURES.runReadoptOnBootV1]).toContain("POL-1879");
  });

  test("refuses every required feature when a daemon health payload lacks it", () => {
    for (const feature of CALYX_DAEMON_FEATURE_LIST) {
      const refusal = getDaemonCompatibilityRefusal(
        "blade",
        {
          ...BASE_HEALTH,
          supports_features: CALYX_DAEMON_FEATURE_LIST.filter((candidate) => candidate !== feature),
        },
        [feature],
        { now: FIXED_NOW },
      );
      expect(refusal?.reason).toBe("missing_features");
      expect(refusal?.missing_features).toEqual([feature]);
      expect(refusal?.message).toContain(FEATURE_DESCRIPTIONS[feature]);
      expect(refusal?.message).toContain('calyx self upgrade --host blade');
    }
  });

  test("formats the pedagogical missing-feature refusal as a stable snapshot", () => {
    const refusal = getDaemonCompatibilityRefusal(
      "blade",
      {
        ...BASE_HEALTH,
        supports_features: [
          CALYX_DAEMON_FEATURES.healthV1,
          CALYX_DAEMON_FEATURES.agentRunnerV1,
          CALYX_DAEMON_FEATURES.detachedWorkerDiagnosticsV1,
        ],
      },
      [
        CALYX_DAEMON_FEATURES.healthV1,
        CALYX_DAEMON_FEATURES.defaultPathInjectionV1,
        CALYX_DAEMON_FEATURES.repoRegistryV1,
      ],
      { now: FIXED_NOW },
    );
    expect(refusal?.message).toMatchInlineSnapshot(`
      "Daemon on "blade" reports build 945bcf3 (built 2 days ago).
      This intent requires features not supported by that daemon:
        - run.default_path_injection/v1 (POL-1100)
        - run.repo_registry/v1 (POL-1101A)
      
      Fix:
        calyx self upgrade --host blade
      
      Re-run the launch after the daemon reports the current feature set."
    `);
  });

  test("formats protocol-epoch mismatches distinctly from feature mismatches", () => {
    const refusal = getDaemonCompatibilityRefusal(
      "blade",
      {
        ...BASE_HEALTH,
        protocol_epoch: 2,
      },
      [CALYX_DAEMON_FEATURES.healthV1],
      { now: FIXED_NOW },
    );
    expect(refusal?.reason).toBe("protocol_epoch_mismatch");
    expect(refusal?.message).toContain("wire format is incompatible");
    expect(refusal?.message).not.toContain("requires features not supported");
  });
});
