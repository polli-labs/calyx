/**
 * @polli-labs/calyx-runner — Dispatch gate.
 *
 * Evaluates pre-dispatch checks against a RunSpec and produces a typed
 * DispatchReceipt. The gate decides whether a run should proceed (accepted)
 * or be rejected with structured reasons.
 *
 * Checks:
 *  1. prompt_present — at least one prompt source is provided
 *  2. backend_supported — backend is a known value
 *  3. execplan_required — if require_execplan is true, execplan_ref must exist
 *  4. host_specified — host must be non-empty
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import { randomUUID } from "node:crypto";
import type { DispatchCheck, DispatchReceipt, RunSpec } from "./types.js";

const SUPPORTED_BACKENDS = new Set(["claude", "codex"]);

/** Individual dispatch check: prompt source is present. */
function checkPromptPresent(spec: RunSpec): DispatchCheck {
  const hasPrompt = !!(spec.prompt || spec.prompt_file || spec.prompt_template);
  return {
    name: "prompt_present",
    passed: hasPrompt,
    message: hasPrompt
      ? "At least one prompt source provided"
      : "No prompt source: prompt, prompt_file, or prompt_template required",
  };
}

/** Individual dispatch check: backend is supported. */
function checkBackendSupported(spec: RunSpec): DispatchCheck {
  const supported = SUPPORTED_BACKENDS.has(spec.backend);
  return {
    name: "backend_supported",
    passed: supported,
    message: supported
      ? `Backend '${spec.backend}' is supported`
      : `Backend '${spec.backend}' is not supported`,
  };
}

/** Individual dispatch check: execplan ref is present when required. */
function checkExecplanRequired(spec: RunSpec): DispatchCheck {
  if (!spec.require_execplan) {
    return {
      name: "execplan_required",
      passed: true,
      message: "ExecPlan not required for this run",
    };
  }
  const hasRef = !!spec.execplan_ref;
  return {
    name: "execplan_required",
    passed: hasRef,
    message: hasRef
      ? `ExecPlan ref provided: ${spec.execplan_ref}`
      : "require_execplan is true but no execplan_ref provided",
  };
}

/** Individual dispatch check: host is specified. */
function checkHostSpecified(spec: RunSpec): DispatchCheck {
  const hasHost = spec.host.length > 0;
  return {
    name: "host_specified",
    passed: hasHost,
    message: hasHost ? `Host: ${spec.host}` : "Host must be specified",
  };
}

/** Determine the dispatch lane from the RunSpec. */
function determineLane(spec: RunSpec): DispatchReceipt["lane"] {
  if (spec.execplan_ref) return "execplan";
  if (spec.prompt_template) return "prompt_template";
  return "prompt_only";
}

/**
 * Run all dispatch checks and produce a DispatchReceipt.
 *
 * @param spec - The run specification to evaluate.
 * @param opts - Optional overrides (run_id, timestamp, override).
 * @returns A fully populated DispatchReceipt.
 */
export function evaluateDispatch(
  spec: RunSpec,
  opts?: {
    run_id?: string;
    timestamp?: string;
    override?: { reason: string };
  },
): DispatchReceipt {
  const checks = [
    checkPromptPresent(spec),
    checkBackendSupported(spec),
    checkExecplanRequired(spec),
    checkHostSpecified(spec),
  ];

  const allPassed = checks.every((c) => c.passed);
  const overridden = !allPassed && !!opts?.override;
  const decision = allPassed || overridden ? "accepted" : "rejected";

  const warnings: string[] = [];
  if (spec.backend_options?.dangerously_skip_permissions) {
    warnings.push("dangerously_skip_permissions is enabled");
  }

  const failedChecks = checks.filter((c) => !c.passed);
  const rejectionReason =
    decision === "rejected" && failedChecks.length > 0
      ? failedChecks.map((c) => c.message).join("; ")
      : undefined;

  const run_id = opts?.run_id ?? spec.run_id;
  const lane = decision === "accepted" ? determineLane(spec) : undefined;
  const override_reason = overridden ? opts!.override!.reason : undefined;

  const receipt: DispatchReceipt = {
    dispatch_id: randomUUID(),
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    decision,
    overridden,
    checks,
    warnings,
  };
  if (run_id !== undefined) receipt.run_id = run_id;
  if (lane !== undefined) receipt.lane = lane;
  if (rejectionReason !== undefined) receipt.rejection_reason = rejectionReason;
  if (override_reason !== undefined) receipt.override_reason = override_reason;

  return receipt;
}
