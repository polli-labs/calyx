import {
  collectSelfDriftReports,
  toSelfDriftJsonResults,
  type SelfDriftDependencies,
  type SelfDriftJsonResult,
  type SelfDriftReport,
  type SelfDriftSeverity,
} from "../self-drift.js";
import {
  createLinearGraphqlRequester,
  type LinearGraphqlRequester,
} from "../linear-graphql-requester.js";

const DEFAULT_LINEAR_PROJECT = "Agents Tooling (Ongoing)";
const DEFAULT_LINEAR_TEAM = "Polli Labs";
const DEFAULT_LABEL_COLOR = "#6B7280";

type SelfNudgeActionKind = "close" | "create" | "noop" | "update";

interface LinearPageInfo {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
}

interface LinearConnection<T> {
  readonly nodes?: ReadonlyArray<T | null> | null;
  readonly pageInfo?: LinearPageInfo | null;
}

interface LinearTeamNode {
  readonly id?: string | null;
  readonly name?: string | null;
}

interface LinearProjectNode {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly slugId?: string | null;
}

interface LinearIssueLabelNode {
  readonly id?: string | null;
  readonly name?: string | null;
}

interface LinearWorkflowStateNode {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly type?: string | null;
}

interface LinearIssueNode {
  readonly id?: string | null;
  readonly identifier?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly url?: string | null;
  readonly updatedAt?: string | null;
  readonly state?: {
    readonly name?: string | null;
    readonly type?: string | null;
  } | null;
  readonly labels?: LinearConnection<LinearIssueLabelNode> | null;
}

interface LinearTeam {
  readonly id: string;
  readonly name: string;
}

interface LinearProject {
  readonly id: string;
  readonly name: string;
  readonly slugId?: string;
}

interface LinearIssueLabel {
  readonly id: string;
  readonly name: string;
}

interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

interface LinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly updatedAt: string;
  readonly state: {
    readonly name: string;
    readonly type?: string;
  };
  readonly labels: readonly LinearIssueLabel[];
}

export interface SelfNudgeOptions {
  readonly authToken?: string;
  readonly dryRun?: boolean;
  readonly fleet?: boolean;
  readonly project?: string;
}

export interface SelfNudgeDependencies extends SelfDriftDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly linearGraphql?: LinearGraphqlRequester;
  readonly linearApiUrl?: string;
  readonly now?: () => Date;
}

export interface SelfNudgeAction {
  readonly host: string;
  readonly drift: SelfDriftSeverity;
  readonly action: SelfNudgeActionKind;
  readonly dry_run: boolean;
  readonly fingerprint_label: string;
  readonly reason: string;
  readonly issue_id?: string;
  readonly issue_identifier?: string;
  readonly issue_url?: string;
  readonly title?: string;
  readonly description?: string;
  readonly comment?: string;
}

export interface SelfNudgeResult {
  readonly checked_at: string;
  readonly dry_run: boolean;
  readonly team: string;
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly slugId?: string;
  };
  readonly drift_reports: readonly SelfDriftJsonResult[];
  readonly actions: readonly SelfNudgeAction[];
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function fingerprintLabelForHost(host: string): string {
  return `drift-fingerprint-${host}`;
}

function driftIssueTitle(host: string, severity: SelfDriftSeverity): string {
  return `calyx daemon drift — ${host} (${severity})`;
}

function resolvedComment(checkedAt: string): string {
  return `drift resolved ${checkedAt.slice(0, 10)}`;
}

function requiresDriftIssue(severity: SelfDriftSeverity): boolean {
  // A blocked toolchain is operational drift that needs a standing repair
  // issue even when the underlying source comparison was only minor.
  return severity !== "current" && severity !== "needs_fetch";
}

function isOpenIssue(issue: LinearIssue): boolean {
  const stateType = normalizeLookupKey(issue.state.type ?? "");
  return stateType !== "canceled" && stateType !== "completed";
}

function ensureString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatMissingOperationalFixes(report: SelfDriftReport): string[] {
  if (report.missingOperationalFixes.length === 0) {
    return ["- None detected."];
  }
  return report.missingOperationalFixes.map((entry) =>
    `- \`${entry.id}\` (${entry.issue}, ${entry.severity}): ${entry.summary}`,
  );
}

function renderDriftIssueBody(report: SelfDriftReport, checkedAt: string, fingerprintLabel: string): string {
  const daemonHead = report.daemonHead ? `\`${report.daemonHead}\`` : "_unavailable_";
  const commitsBehind = report.commitsBehind === null ? "_unavailable_" : `\`${report.commitsBehind}\``;
  const remediation = report.toolchain_check?.status === "blocked"
    ? report.toolchain_check.next_action?.description
      ?? `Repair ${report.host}'s bootstrap toolchain before retrying self upgrade.`
    : `calyx self upgrade --host ${report.host}`;
  const lines = [
    "# Calyx daemon drift",
    "",
    `- Host: \`${report.host}\``,
    `- Drift: \`${report.drift}\``,
    `- Checked at: \`${checkedAt}\``,
    `- Fingerprint label: \`${fingerprintLabel}\``,
    `- Remediation: ${remediation}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Build heads",
    `- Daemon HEAD: ${daemonHead}`,
    `- Target HEAD: \`${report.targetHead}\``,
    `- Commits behind: ${commitsBehind}`,
  ];

  if (report.brokenReason) {
    lines.push("", "## Broken reason", report.brokenReason);
  }

  lines.push("", "## Missing operational fixes", ...formatMissingOperationalFixes(report));
  return lines.join("\n");
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function selectSingleOpenIssue(
  issues: readonly LinearIssue[],
  fingerprintLabel: string,
  host: string,
): LinearIssue | undefined {
  const matches = issues.filter((issue) =>
    isOpenIssue(issue) && issue.labels.some((label) => label.name === fingerprintLabel)
  );
  if (matches.length > 1) {
    const identifiers = matches.map((issue) => issue.identifier).sort().join(", ");
    throw new Error(`Multiple open drift issues found for ${host}: ${identifiers}`);
  }
  return matches[0];
}

class LinearSelfNudgeClient {
  constructor(private readonly graphql: LinearGraphqlRequester) {
  }

  async listTeams(): Promise<LinearTeam[]> {
    const teams: LinearTeam[] = [];
    let after: string | undefined;

    do {
      const data = await this.graphql.request<{
        teams?: LinearConnection<LinearTeamNode> | null;
      }>(
        `
          query CalyxSelfNudgeTeams($first: Int!, $after: String) {
            teams(first: $first, after: $after, includeArchived: false) {
              nodes {
                id
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          first: 50,
          ...(after ? { after } : {}),
        },
      );

      for (const node of data.teams?.nodes ?? []) {
        const id = ensureString(node?.id);
        const name = ensureString(node?.name);
        if (!id || !name) {
          continue;
        }
        teams.push({ id, name });
      }

      const pageInfo = data.teams?.pageInfo;
      after = pageInfo?.hasNextPage ? ensureString(pageInfo.endCursor) : undefined;
    } while (after);

    return teams;
  }

  async listProjects(): Promise<LinearProject[]> {
    const projects: LinearProject[] = [];
    let after: string | undefined;

    do {
      const data = await this.graphql.request<{
        projects?: LinearConnection<LinearProjectNode> | null;
      }>(
        `
          query CalyxSelfNudgeProjects($first: Int!, $after: String) {
            projects(first: $first, after: $after, includeArchived: false) {
              nodes {
                id
                name
                slugId
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          first: 100,
          ...(after ? { after } : {}),
        },
      );

      for (const node of data.projects?.nodes ?? []) {
        const id = ensureString(node?.id);
        const name = ensureString(node?.name);
        const slugId = ensureString(node?.slugId);
        if (!id || !name) {
          continue;
        }
        projects.push({
          id,
          name,
          ...(slugId ? { slugId } : {}),
        });
      }

      const pageInfo = data.projects?.pageInfo;
      after = pageInfo?.hasNextPage ? ensureString(pageInfo.endCursor) : undefined;
    } while (after);

    return projects;
  }

  async listIssueLabels(): Promise<LinearIssueLabel[]> {
    const labels: LinearIssueLabel[] = [];
    let after: string | undefined;

    do {
      const data = await this.graphql.request<{
        issueLabels?: LinearConnection<LinearIssueLabelNode> | null;
      }>(
        `
          query CalyxSelfNudgeIssueLabels($first: Int!, $after: String) {
            issueLabels(first: $first, after: $after, includeArchived: false) {
              nodes {
                id
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          first: 100,
          ...(after ? { after } : {}),
        },
      );

      for (const node of data.issueLabels?.nodes ?? []) {
        const id = ensureString(node?.id);
        const name = ensureString(node?.name);
        if (!id || !name) {
          continue;
        }
        labels.push({ id, name });
      }

      const pageInfo = data.issueLabels?.pageInfo;
      after = pageInfo?.hasNextPage ? ensureString(pageInfo.endCursor) : undefined;
    } while (after);

    return labels;
  }

  async listProjectIssues(projectId: string): Promise<LinearIssue[]> {
    const issues: LinearIssue[] = [];
    let after: string | undefined;

    do {
      const data = await this.graphql.request<{
        project?: {
          issues?: LinearConnection<LinearIssueNode> | null;
        } | null;
      }>(
        `
          query CalyxSelfNudgeProjectIssues($projectId: String!, $first: Int!, $after: String) {
            project(id: $projectId) {
              issues(first: $first, after: $after, includeArchived: false) {
                nodes {
                  id
                  identifier
                  title
                  description
                  url
                  updatedAt
                  state {
                    name
                    type
                  }
                  labels {
                    nodes {
                      id
                      name
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        {
          projectId,
          first: 100,
          ...(after ? { after } : {}),
        },
      );

      for (const node of data.project?.issues?.nodes ?? []) {
        const id = ensureString(node?.id);
        const identifier = ensureString(node?.identifier);
        const title = ensureString(node?.title);
        const updatedAt = ensureString(node?.updatedAt);
        const stateName = ensureString(node?.state?.name);
        const stateType = ensureString(node?.state?.type);
        const description = ensureString(node?.description);
        const url = ensureString(node?.url);
        if (!id || !identifier || !title || !updatedAt || !stateName) {
          continue;
        }

        issues.push({
          id,
          identifier,
          title,
          ...(description ? { description } : {}),
          ...(url ? { url } : {}),
          updatedAt,
          state: {
            name: stateName,
            ...(stateType ? { type: stateType } : {}),
          },
          labels: (node?.labels?.nodes ?? [])
            .map((labelNode) => {
              const labelId = ensureString(labelNode?.id);
              const labelName = ensureString(labelNode?.name);
              if (!labelId || !labelName) {
                return undefined;
              }
              return { id: labelId, name: labelName };
            })
            .filter((value): value is LinearIssueLabel => Boolean(value)),
        });
      }

      const pageInfo = data.project?.issues?.pageInfo;
      after = pageInfo?.hasNextPage ? ensureString(pageInfo.endCursor) : undefined;
    } while (after);

    return issues;
  }

  async listTeamStates(teamId: string): Promise<LinearWorkflowState[]> {
    const states: LinearWorkflowState[] = [];
    let after: string | undefined;

    do {
      const data = await this.graphql.request<{
        team?: {
          states?: LinearConnection<LinearWorkflowStateNode> | null;
        } | null;
      }>(
        `
          query CalyxSelfNudgeTeamStates($teamId: String!, $first: Int!, $after: String) {
            team(id: $teamId) {
              states(first: $first, after: $after, includeArchived: false) {
                nodes {
                  id
                  name
                  type
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        {
          teamId,
          first: 100,
          ...(after ? { after } : {}),
        },
      );

      for (const node of data.team?.states?.nodes ?? []) {
        const id = ensureString(node?.id);
        const name = ensureString(node?.name);
        const type = ensureString(node?.type);
        if (!id || !name) {
          continue;
        }
        states.push({
          id,
          name,
          ...(type ? { type } : {}),
        });
      }

      const pageInfo = data.team?.states?.pageInfo;
      after = pageInfo?.hasNextPage ? ensureString(pageInfo.endCursor) : undefined;
    } while (after);

    return states;
  }

  async createIssueLabel(args: {
    readonly name: string;
    readonly teamId: string;
  }): Promise<LinearIssueLabel> {
    const data = await this.graphql.request<{
      issueLabelCreate?: {
        success?: boolean | null;
        issueLabel?: LinearIssueLabelNode | null;
      } | null;
    }>(
      `
        mutation CalyxSelfNudgeIssueLabelCreate($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) {
            success
            issueLabel {
              id
              name
            }
          }
        }
      `,
      {
        input: {
          name: args.name,
          color: DEFAULT_LABEL_COLOR,
          teamId: args.teamId,
        },
      },
    );

    const label = data.issueLabelCreate?.issueLabel;
    const id = ensureString(label?.id);
    const name = ensureString(label?.name);
    if (!data.issueLabelCreate?.success || !id || !name) {
      throw new Error(`Failed to create Linear label ${args.name}.`);
    }
    return { id, name };
  }

  async createIssue(args: {
    readonly title: string;
    readonly description: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly labelIds: readonly string[];
  }): Promise<LinearIssue> {
    const data = await this.graphql.request<{
      issueCreate?: {
        success?: boolean | null;
        issue?: LinearIssueNode | null;
      } | null;
    }>(
      `
        mutation CalyxSelfNudgeIssueCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              url
              updatedAt
              state {
                name
                type
              }
              labels {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      {
        input: {
          title: args.title,
          description: args.description,
          teamId: args.teamId,
          projectId: args.projectId,
          labelIds: args.labelIds,
        },
      },
    );

    const issue = data.issueCreate?.issue;
    const id = ensureString(issue?.id);
    const identifier = ensureString(issue?.identifier);
    const title = ensureString(issue?.title);
    const updatedAt = ensureString(issue?.updatedAt);
    const stateName = ensureString(issue?.state?.name);
    const stateType = ensureString(issue?.state?.type);
    const description = ensureString(issue?.description);
    const url = ensureString(issue?.url);
    if (!data.issueCreate?.success || !id || !identifier || !title || !updatedAt || !stateName) {
      throw new Error(`Failed to create Linear issue for ${args.title}.`);
    }

    return {
      id,
      identifier,
      title,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      updatedAt,
      state: {
        name: stateName,
        ...(stateType ? { type: stateType } : {}),
      },
      labels: (issue?.labels?.nodes ?? [])
        .map((entry) => {
          const labelId = ensureString(entry?.id);
          const labelName = ensureString(entry?.name);
          if (!labelId || !labelName) {
            return undefined;
          }
          return { id: labelId, name: labelName };
        })
        .filter((value): value is LinearIssueLabel => Boolean(value)),
    };
  }

  async updateIssue(args: {
    readonly issueId: string;
    readonly title?: string;
    readonly description?: string;
    readonly stateId?: string;
  }): Promise<LinearIssue> {
    const input = {
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.stateId ? { stateId: args.stateId } : {}),
    };
    if (Object.keys(input).length === 0) {
      throw new Error(`No issue update fields provided for ${args.issueId}.`);
    }

    const data = await this.graphql.request<{
      issueUpdate?: {
        success?: boolean | null;
        issue?: LinearIssueNode | null;
      } | null;
    }>(
      `
        mutation CalyxSelfNudgeIssueUpdate($issueId: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $issueId, input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              url
              updatedAt
              state {
                name
                type
              }
              labels {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      {
        issueId: args.issueId,
        input,
      },
    );

    const issue = data.issueUpdate?.issue;
    const id = ensureString(issue?.id);
    const identifier = ensureString(issue?.identifier);
    const title = ensureString(issue?.title);
    const updatedAt = ensureString(issue?.updatedAt);
    const stateName = ensureString(issue?.state?.name);
    const stateType = ensureString(issue?.state?.type);
    const description = ensureString(issue?.description);
    const url = ensureString(issue?.url);
    if (!data.issueUpdate?.success || !id || !identifier || !title || !updatedAt || !stateName) {
      throw new Error(`Failed to update Linear issue ${args.issueId}.`);
    }

    return {
      id,
      identifier,
      title,
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
      updatedAt,
      state: {
        name: stateName,
        ...(stateType ? { type: stateType } : {}),
      },
      labels: (issue?.labels?.nodes ?? [])
        .map((entry) => {
          const labelId = ensureString(entry?.id);
          const labelName = ensureString(entry?.name);
          if (!labelId || !labelName) {
            return undefined;
          }
          return { id: labelId, name: labelName };
        })
        .filter((value): value is LinearIssueLabel => Boolean(value)),
    };
  }

  async createComment(args: {
    readonly issueId: string;
    readonly body: string;
  }): Promise<void> {
    const data = await this.graphql.request<{
      commentCreate?: {
        success?: boolean | null;
      } | null;
    }>(
      `
        mutation CalyxSelfNudgeCommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      {
        input: {
          issueId: args.issueId,
          body: args.body,
        },
      },
    );

    if (!data.commentCreate?.success) {
      throw new Error(`Failed to create Linear comment for ${args.issueId}.`);
    }
  }
}

async function ensureFingerprintLabel(
  client: LinearSelfNudgeClient,
  labelsCache: Map<string, LinearIssueLabel>,
  name: string,
  teamId: string,
): Promise<LinearIssueLabel> {
  const cached = labelsCache.get(name);
  if (cached) {
    return cached;
  }

  try {
    const created = await client.createIssueLabel({ name, teamId });
    labelsCache.set(created.name, created);
    return created;
  } catch (error) {
    const availableLabels = await client.listIssueLabels();
    for (const label of availableLabels) {
      labelsCache.set(label.name, label);
    }
    const existing = labelsCache.get(name);
    if (existing) {
      return existing;
    }
    throw error;
  }
}

export async function runSelfNudge(
  options: SelfNudgeOptions,
  deps: SelfNudgeDependencies = {},
): Promise<SelfNudgeResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const checkedAt = now().toISOString();
  const projectLookup = options.project?.trim()
    || env["CALYX_LINEAR_PROJECT"]?.trim()
    || env["LINEAR_PROJECT"]?.trim()
    || DEFAULT_LINEAR_PROJECT;
  const teamLookup = env["LINEAR_TEAM"]?.trim() || DEFAULT_LINEAR_TEAM;
  const linearApiKey = env["LINEAR_API_KEY"]?.trim();

  if (!linearApiKey) {
    throw new Error("LINEAR_API_KEY is required for calyx self nudge.");
  }

  const driftReports = await collectSelfDriftReports(
    {
      fleet: Boolean(options.fleet),
      ...(options.authToken ? { authToken: options.authToken } : {}),
    },
    deps,
  );

  const client = new LinearSelfNudgeClient(
    deps.linearGraphql ?? createLinearGraphqlRequester({
      apiKey: linearApiKey,
      ...(deps.linearApiUrl ? { apiUrl: deps.linearApiUrl } : {}),
    }),
  );

  const teams = await client.listTeams();
  const team = teams.find((entry) => normalizeLookupKey(entry.name) === normalizeLookupKey(teamLookup));
  if (!team) {
    throw new Error(`Unable to resolve Linear team "${teamLookup}".`);
  }

  const projects = await client.listProjects();
  const project = projects.find((entry) =>
    normalizeLookupKey(entry.name) === normalizeLookupKey(projectLookup)
      || normalizeLookupKey(entry.slugId ?? "") === normalizeLookupKey(projectLookup)
  );
  if (!project) {
    throw new Error(`Unable to resolve Linear project "${projectLookup}".`);
  }

  const issues = await client.listProjectIssues(project.id);
  const labelsCache = new Map<string, LinearIssueLabel>(
    (await client.listIssueLabels()).map((label) => [label.name, label] as const),
  );
  const actions: SelfNudgeAction[] = [];
  let completedStateId: string | undefined;

  for (const report of driftReports) {
    const fingerprintLabel = fingerprintLabelForHost(report.host);
    const existing = selectSingleOpenIssue(issues, fingerprintLabel, report.host);

    if (report.drift === "needs_fetch") {
      const repairAction = report.diagnostics[0]?.actions[0];
      actions.push({
        host: report.host,
        drift: report.drift,
        action: "noop",
        dry_run: Boolean(options.dryRun),
        fingerprint_label: fingerprintLabel,
        reason: repairAction
          ? `local compare repo needs repair: ${repairAction}`
          : "local compare repo needs repair before daemon drift can be classified",
      });
      continue;
    }

    if (requiresDriftIssue(report.drift)) {
      const title = driftIssueTitle(report.host, report.drift);
      const description = renderDriftIssueBody(report, checkedAt, fingerprintLabel);

      if (existing) {
        if (!options.dryRun) {
          const updated = await client.updateIssue({
            issueId: existing.id,
            title,
            description,
          });
          actions.push({
            host: report.host,
            drift: report.drift,
            action: "update",
            dry_run: false,
            fingerprint_label: fingerprintLabel,
            issue_id: updated.id,
            issue_identifier: updated.identifier,
            ...(updated.url ? { issue_url: updated.url } : {}),
            title,
            description,
            reason: `updated standing drift issue ${updated.identifier}`,
          });
        } else {
          actions.push({
            host: report.host,
            drift: report.drift,
            action: "update",
            dry_run: true,
            fingerprint_label: fingerprintLabel,
            issue_id: existing.id,
            issue_identifier: existing.identifier,
            ...(existing.url ? { issue_url: existing.url } : {}),
            title,
            description,
            reason: `would update standing drift issue ${existing.identifier}`,
          });
        }
        continue;
      }

      const label = options.dryRun
        ? labelsCache.get(fingerprintLabel)
        : await ensureFingerprintLabel(client, labelsCache, fingerprintLabel, team.id);

      if (!options.dryRun) {
        const created = await client.createIssue({
          title,
          description,
          teamId: team.id,
          projectId: project.id,
          labelIds: label ? [label.id] : [],
        });
        actions.push({
          host: report.host,
          drift: report.drift,
          action: "create",
          dry_run: false,
          fingerprint_label: fingerprintLabel,
          issue_id: created.id,
          issue_identifier: created.identifier,
          ...(created.url ? { issue_url: created.url } : {}),
          title,
          description,
          reason: `created standing drift issue ${created.identifier}`,
        });
      } else {
        actions.push({
          host: report.host,
          drift: report.drift,
          action: "create",
          dry_run: true,
          fingerprint_label: fingerprintLabel,
          title,
          description,
          reason: label
            ? "would create a new standing drift issue"
            : "would create fingerprint label and a new standing drift issue",
        });
      }
      continue;
    }

    if (existing) {
      const comment = resolvedComment(checkedAt);
      if (!options.dryRun) {
        if (!completedStateId) {
          completedStateId = (await client.listTeamStates(team.id))
            .find((state) => normalizeLookupKey(state.type ?? "") === "completed")
            ?.id;
        }
        if (!completedStateId) {
          throw new Error(`Unable to resolve a completed Linear workflow state for team "${team.name}".`);
        }
        await client.createComment({
          issueId: existing.id,
          body: comment,
        });
        const updated = await client.updateIssue({
          issueId: existing.id,
          stateId: completedStateId,
        });
        actions.push({
          host: report.host,
          drift: report.drift,
          action: "close",
          dry_run: false,
          fingerprint_label: fingerprintLabel,
          issue_id: updated.id,
          issue_identifier: updated.identifier,
          ...(updated.url ? { issue_url: updated.url } : {}),
          comment,
          reason: `closed standing drift issue ${updated.identifier}`,
        });
      } else {
        actions.push({
          host: report.host,
          drift: report.drift,
          action: "close",
          dry_run: true,
          fingerprint_label: fingerprintLabel,
          issue_id: existing.id,
          issue_identifier: existing.identifier,
          ...(existing.url ? { issue_url: existing.url } : {}),
          comment,
          reason: `would close standing drift issue ${existing.identifier}`,
        });
      }
      continue;
    }

    actions.push({
      host: report.host,
      drift: report.drift,
      action: "noop",
      dry_run: Boolean(options.dryRun),
      fingerprint_label: fingerprintLabel,
      reason: "host is current and no standing drift issue is open",
    });
  }

  return {
    checked_at: checkedAt,
    dry_run: Boolean(options.dryRun),
    team: team.name,
    project,
    drift_reports: toSelfDriftJsonResults(driftReports),
    actions,
  };
}

export function formatSelfNudgeResult(result: SelfNudgeResult): string {
  const lines = [
    `checked_at: ${result.checked_at}`,
    `team: ${result.team}`,
    `project: ${result.project.name}${result.project.slugId ? ` (${result.project.slugId})` : ""}`,
  ];

  if (result.actions.length === 0) {
    lines.push(result.dry_run ? "[dry-run] no actions" : "no actions");
    return lines.join("\n");
  }

  for (const action of result.actions) {
    const prefix = result.dry_run ? "[dry-run]" : "[nudge]";
    lines.push(
      `${prefix} ${action.action} host=${action.host} drift=${action.drift} label=${action.fingerprint_label} reason=${action.reason}`,
    );
    if (action.issue_identifier) {
      lines.push(`  issue: ${action.issue_identifier}${action.issue_url ? ` (${action.issue_url})` : ""}`);
    }
    if (action.title) {
      lines.push(`  title: ${action.title}`);
    }
    if (action.comment) {
      lines.push(`  comment: ${action.comment}`);
    }
    if (result.dry_run && action.description) {
      lines.push("  description:");
      lines.push(indentBlock(action.description, "    "));
    }
  }

  return lines.join("\n");
}
