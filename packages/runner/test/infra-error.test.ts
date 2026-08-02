import { describe, expect, test } from "vitest";
import {
  INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION,
  INFRA_ERROR_FAILURE_LAYERS,
  INFRA_ERROR_FAILURE_REASONS,
  INFRA_ERROR_RULES,
  classifyInfraError,
  infraErrorClassificationSchema,
  type ClassifyInfraErrorContext,
  type InfraErrorFailureLayer,
  type InfraErrorFailureReason,
} from "../src/index.js";

describe("infra_error classification", () => {
  const expectedLayers: readonly InfraErrorFailureLayer[] = [
    "worktree_acquisition",
    "backend_spawn",
    "secrets_auth",
    "daemon_feature",
    "prompts_resolution",
    "runtime_config",
    "runner_task",
    "unknown",
  ];
  const expectedReasons: readonly InfraErrorFailureReason[] = [
    "worktree_ref_unresolved",
    "worktree_locked",
    "worktree_lease_refused",
    "repo_unregistered",
    "worktree_base_not_repo",
    "worktree_branch_required",
    "worktree_ref_invalid",
    "worktree_path_missing",
    "git_worktree_lock",
    "backend_spawn_exit",
    "feature_missing",
    "prompts_source_missing",
    "unknown",
  ];

  test("exports the infra_error_classification/v1 enum contract", () => {
    expect(INFRA_ERROR_CLASSIFICATION_SCHEMA_VERSION).toBe("infra_error_classification/v1");
    expect(INFRA_ERROR_FAILURE_LAYERS).toEqual(expectedLayers);
    expect(INFRA_ERROR_FAILURE_REASONS).toEqual(expectedReasons);
  });

  test.each([
    [
      "worktree_acquisition",
      { site: "worktree_acquisition", message: "Worktree DB lease acquisition refused: lease worktree:carbon:/repo is held by run:abc." },
      "worktree_lease_refused",
    ],
    [
      "backend_spawn",
      { site: "backend_spawn", message: "Adapter session failed: Codex app-server exited code 1." },
      "backend_spawn_exit",
    ],
    [
      "secrets_auth",
      { site: "secrets_auth", message: "Secret token authentication failed before spawn." },
      "unknown",
    ],
    [
      "daemon_feature",
      { site: "daemon_feature_refusal", message: "This intent requires features not supported by that daemon: calyx.run-observation/v1." },
      "feature_missing",
    ],
    [
      "prompts_resolution",
      { site: "prompts_resolution", message: "Run run-1 has no prompt source. Provide --prompt, --prompt-file, --template, or an ExecPlan." },
      "prompts_source_missing",
    ],
    [
      "runtime_config",
      { site: "runtime_config", message: "Runtime config could not be loaded." },
      "unknown",
    ],
    [
      "runner_task",
      { site: "runner_task", message: "Runner task could not finalize the handoff receipt." },
      "unknown",
    ],
    [
      "unknown",
      { message: "unattributed infra_error" },
      "unknown",
    ],
  ] satisfies Array<[InfraErrorFailureLayer, ClassifyInfraErrorContext, InfraErrorFailureReason]>)(
    "classifies layer %s with an always-populated reason",
    (layer, ctx, reason) => {
      const classification = classifyInfraError(ctx);
      expect(classification).toMatchObject({
        schema_version: "infra_error_classification/v1",
        failure_layer: layer,
        failure_reason: reason,
      });
      expect(classification.message).toBeTruthy();
      expect(infraErrorClassificationSchema.parse(classification)).toEqual(classification);
    },
  );

  test("all classifier rules emit known non-empty layer/reason pairs", () => {
    for (const rule of INFRA_ERROR_RULES) {
      expect(INFRA_ERROR_FAILURE_LAYERS).toContain(rule.failure_layer);
      expect(INFRA_ERROR_FAILURE_REASONS).toContain(rule.failure_reason);
      expect(rule.failure_layer).toBeTruthy();
      expect(rule.failure_reason).toBeTruthy();
    }
  });

  test("classifies site-specific worktree failures from message-only legacy receipts", () => {
    const classification = classifyInfraError({
      message: "Worktree acquisition failed: worktree locked by run abc123.",
    });

    expect(classification).toMatchObject({
      failure_layer: "worktree_acquisition",
      failure_reason: "worktree_locked",
    });
  });
});

describe("POL-1826 hardened worktree messages stay keyed to the failure_reason taxonomy", () => {
  // run.ts wraps `wtResult.error` as `Worktree acquisition failed: <error>`
  // before classifying with site "worktree_acquisition"; mirror that exactly so
  // the multi-line remediation messages cannot silently drift to `unknown`.
  const wrap = (error: string): ClassifyInfraErrorContext => ({
    site: "worktree_acquisition",
    message: `Worktree acquisition failed: ${error}`,
  });

  test("bare-SHA fetch-failure remediation classifies as worktree_ref_unresolved", () => {
    const error = [
      'Worktree ref "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" could not be resolved before git worktree add, and a direct fetch from configured remotes did not recover it.',
      "Tried: origin (code 128).",
      "Push the commit to a configured remote (hosts such as GitHub only serve a SHA reachable from an advertised ref).",
    ].join("\n");
    expect(classifyInfraError(wrap(error)).failure_reason).toBe("worktree_ref_unresolved");
  });

  test("lock-contention remediation classifies as worktree_locked, not worktree_lease_refused", () => {
    const error = [
      "Worktree locked by run run-holder (pid 4242, acquired 2026-06-18T00:00:00.000Z)",
      "Retried 3× with backoff, but the holder did not release.",
      "Wait for the holder to release, or pass --steal-lock to forcibly acquire (only when you are certain the holder is dead).",
    ].join("\n");
    expect(classifyInfraError(wrap(error)).failure_reason).toBe("worktree_locked");
  });

  test("lease-contention remediation classifies as worktree_lease_refused", () => {
    const error = [
      "Worktree DB lease unavailable for /repo/wt/x: lease worktree:carbon:/repo/wt/x is held by run:first.",
      "Retried 3× with backoff, but the holder did not release.",
      "Wait for the holder to release, or pass --steal-lock to forcibly acquire (only when you are certain the holder is dead).",
    ].join("\n");
    expect(classifyInfraError(wrap(error)).failure_reason).toBe("worktree_lease_refused");
  });
});
