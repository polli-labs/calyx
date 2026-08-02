/**
 * Entries are append-only. New operational fixes must add an entry at merge
 * time; removing or renaming an existing ID is a breaking change.
 */

// TODO(POL-1120): Tighten `id` to CalyxDaemonFeature once the feature registry lands.
export interface OperationalFix {
  readonly id: string;
  readonly introduced_by: string;
  readonly issue: string;
  readonly severity: "critical" | "major" | "minor";
  readonly affects: readonly string[];
  readonly summary: string;
}

export const OPERATIONAL_FIXES: readonly OperationalFix[] = [
  {
    id: "run.default_path_injection/v1",
    introduced_by: "901bb01",
    issue: "POL-1100",
    severity: "critical",
    affects: ["agent_runner", "remote_dispatch"],
    summary: "Detached workers inherit usable PATH for codex/claude.",
  },
  {
    id: "daemon.phantom_active_reconcile/v1",
    introduced_by: "7b1ee22",
    issue: "POL-1109",
    severity: "critical",
    affects: ["daemon", "symphony"],
    summary: "Daemon tick loop clears missing active run records.",
  },
  {
    id: "run.vault_execplan_ref/v1",
    introduced_by: "f636ca9",
    issue: "POL-1102",
    severity: "major",
    affects: ["remote_dispatch", "cross_host_execplan"],
    summary: "Resolve --execplan-ref vault://... against per-host vault_root.",
  },
  {
    id: "run.repo_registry/v1",
    introduced_by: "5254f15",
    issue: "POL-1101A",
    severity: "major",
    affects: ["remote_dispatch", "worktree_resolution"],
    summary: "`--repo <slug>` resolves to per-host clean-clone via truth store.",
  },
  {
    id: "run.detached_worker_diagnostics/v1",
    introduced_by: "945bcf3",
    issue: "POL-1117",
    severity: "critical",
    affects: ["agent_runner", "observability"],
    summary: "Persist detached-worker stdio + codex app-server startup stderr to disk.",
  },
] as const;
