---
tracker:
  kind: linear
  team: Polli Labs
  project: Agents Tooling (Ongoing)
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
  claim_state: In Progress
  handoff_state: In Review
  include_labels: [symphony-dogfood]
polling:
  interval_seconds: 120
  idle_backoff_seconds: 60
  max_interval_seconds: 600
  stall_timeout_seconds: 1800
  max_concurrent_agents: 1
  continuation_delay_seconds: 5
  failure_backoff_seconds: 60
  max_failure_backoff_seconds: 600
  max_retries: 2
workspace:
  root: ~/dev/calyx/wt
  repo_root: ~/dev/calyx/dev
  branch_template: symphony/{{IDENTIFIER}}
  ref: main
  cleanup_terminal_after_hours: 168
agent:
  host: local
  backend: claude
  max_turns_per_run: 20
  require_execplan: false
  pull_execplan: false
  dangerously_skip_permissions: false
logging:
  level: info
---
You are the Calyx Symphony daemon working on Linear issue {{ISSUE_IDENTIFIER}} — {{ISSUE_TITLE}}.

Workspace:
- worktree: {{WORKSPACE_PATH}}
- branch:   {{BRANCH_NAME}}
- repo:     {{REPO_ROOT}}

Runtime:
- daemon_id: {{DAEMON_ID}}
- run_id:    {{RUN_ID}}
- issue_url: {{ISSUE_URL}}

Operating rules for dogfood:

1. Read the issue body and any linked vault notes before changing code.
2. Stay strictly within the scope the issue describes. Do not refactor adjacent
   code. Do not introduce new abstractions, backwards-compat shims, or fallback
   behaviors unless the issue asks for them.
3. Run `PATH=/home/caleb/.nvm/versions/node/v22.22.1/bin:$PATH pnpm verify`
   before declaring the work ready. Fix any failures before stopping.
4. When the work is ready for human review, post a short summary describing
   what changed, what was verified, and what is intentionally out of scope.
   Do not mark the Linear issue Done; the daemon will move it to In Review
   and a human reviewer will gate merge.
5. If you cannot make safe progress (ambiguous scope, missing context, repo
   in an unexpected state), say so and stop. Do not invent.

Only issues labeled `symphony-dogfood` are eligible; this is the conservative
dogfood guardrail until the conductor widens the include label.
