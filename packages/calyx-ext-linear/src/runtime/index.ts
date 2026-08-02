import type {
  TrackerClaimRequest,
  TrackerClaimResult,
  TrackerClient,
  TrackerClientFactory,
  TrackerHandoffRequest,
  TrackerHandoffResult,
  TrackerIssue,
  TrackerPollRequest,
  TrackerPollResult,
} from "@polli-labs/calyx-run-service";

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export interface LinearTrackerFactoryOptions {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  pageSize?: number;
}

interface LinearIssuesPayload {
  issues?: {
    nodes?: Array<{
      id?: string;
      identifier?: string;
      title?: string;
      url?: string;
      updatedAt?: string;
      state?: { name?: string; type?: string };
      labels?: { nodes?: Array<{ name?: string }> };
      team?: { name?: string };
      project?: { name?: string };
    }>;
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
  };
}

function buildFilter(request: TrackerPollRequest): Record<string, unknown> | undefined {
  const filters: Record<string, unknown>[] = [];
  if (request.team) {
    filters.push({ team: { name: { eq: request.team } } });
  }
  if (request.project) {
    filters.push({ project: { name: { eq: request.project } } });
  }
  if (filters.length === 0) {
    return undefined;
  }
  if (filters.length === 1) {
    return filters[0];
  }
  return { and: filters };
}

export class LinearTrackerClient implements TrackerClient {
  readonly kind = "linear";
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pageSize: number;

  constructor(options: LinearTrackerFactoryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? DEFAULT_LINEAR_API_URL;
    this.env = options.env ?? process.env;
    this.pageSize = options.pageSize ?? 50;
  }

  async pollIssues(request: TrackerPollRequest): Promise<TrackerPollResult> {
    const apiKey = this.env["LINEAR_API_KEY"];
    if (!apiKey) {
      throw new Error("LINEAR_API_KEY is required for the Linear tracker runtime.");
    }

    const issues: TrackerIssue[] = [];
    let after: string | undefined;

    do {
      const response = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
        },
        body: JSON.stringify({
          query: `
            query CalyxDaemonIssues($first: Int!, $after: String, $filter: IssueFilter) {
              issues(first: $first, after: $after, filter: $filter, includeArchived: false) {
                nodes {
                  id
                  identifier
                  title
                  url
                  updatedAt
                  state {
                    name
                    type
                  }
                  labels {
                    nodes {
                      name
                    }
                  }
                  team {
                    name
                  }
                  project {
                    name
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          `,
          variables: {
            first: this.pageSize,
            after,
            filter: buildFilter(request),
          },
        }),
      });

      const bodyText = await response.text();
      let parsed: LinearGraphqlResponse<LinearIssuesPayload>;
      try {
        parsed = JSON.parse(bodyText) as LinearGraphqlResponse<LinearIssuesPayload>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse Linear response: ${message}`);
      }

      if (!response.ok) {
        const message = parsed.errors?.map((item) => item.message).filter(Boolean).join("; ") || response.statusText;
        throw new Error(`Linear API request failed (${response.status}): ${message}`);
      }
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(parsed.errors.map((item) => item.message).filter(Boolean).join("; "));
      }

      const connection = parsed.data?.issues;
      for (const node of connection?.nodes ?? []) {
        if (!node.id || !node.identifier || !node.title || !node.updatedAt || !node.state?.name) {
          continue;
        }
        issues.push({
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          ...(node.url ? { url: node.url } : {}),
          updated_at: node.updatedAt,
          state: {
            name: node.state.name,
            ...(node.state.type ? { type: node.state.type } : {}),
          },
          labels: (node.labels?.nodes ?? [])
            .map((label) => label.name?.trim())
            .filter((value): value is string => Boolean(value)),
          ...(node.team?.name ? { team: node.team.name } : {}),
          ...(node.project?.name ? { project: node.project.name } : {}),
        });
      }

      const pageInfo = connection?.pageInfo;
      after = pageInfo?.hasNextPage ? (pageInfo.endCursor ?? undefined) : undefined;
    } while (after);

    return {
      fetched_at: new Date().toISOString(),
      issues,
    };
  }

  private async graphql<T>(input: { query: string; variables: Record<string, unknown>; errorContext: string }): Promise<T> {
    const apiKey = this.env["LINEAR_API_KEY"];
    if (!apiKey) {
      throw new Error("LINEAR_API_KEY is required for the Linear tracker runtime.");
    }
    const response = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: apiKey,
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    });
    const bodyText = await response.text();
    let parsed: LinearGraphqlResponse<T>;
    try {
      parsed = JSON.parse(bodyText) as LinearGraphqlResponse<T>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse Linear response (${input.errorContext}): ${message}`);
    }
    if (!response.ok) {
      const message = parsed.errors?.map((item) => item.message).filter(Boolean).join("; ") || response.statusText;
      throw new Error(`Linear ${input.errorContext} request failed (${response.status}): ${message}`);
    }
    if (parsed.errors && parsed.errors.length > 0) {
      throw new Error(`Linear ${input.errorContext} returned errors: ${parsed.errors.map((item) => item.message).filter(Boolean).join("; ")}`);
    }
    if (!parsed.data) {
      throw new Error(`Linear ${input.errorContext} returned no data`);
    }
    return parsed.data;
  }

  private async resolveStateId(issue: TrackerIssue, targetState: string): Promise<string> {
    const data = await this.graphql<LinearWorkflowStatesPayload>({
      query: `
        query CalyxResolveWorkflowState($issueId: String!) {
          issue(id: $issueId) {
            id
            team {
              id
              states {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      variables: { issueId: issue.id },
      errorContext: "resolveWorkflowState",
    });
    const states = data.issue?.team?.states?.nodes ?? [];
    const targetLower = targetState.trim().toLowerCase();
    const match = states.find((node) => node.name?.trim().toLowerCase() === targetLower && node.id);
    if (!match || !match.id) {
      const available = states.map((node) => node.name).filter(Boolean).join(", ");
      throw new Error(
        `Linear workflow state "${targetState}" not found for issue ${issue.identifier}. Available: ${available || "(none)"}.`,
      );
    }
    return match.id;
  }

  async claimIssue(request: TrackerClaimRequest): Promise<TrackerClaimResult> {
    const targetStateId = await this.resolveStateId(request.issue, request.target_state);
    const data = await this.graphql<LinearIssueUpdatePayload>({
      query: `
        mutation CalyxSymphonyClaimIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      `,
      variables: { id: request.issue.id, stateId: targetStateId },
      errorContext: "issueUpdate(claim)",
    });
    const updated = data.issueUpdate?.issue;
    return {
      issue_id: request.issue.id,
      identifier: request.issue.identifier,
      previous_state: request.issue.state.name,
      current_state: updated?.state?.name ?? request.target_state,
      transitioned: Boolean(data.issueUpdate?.success),
      transition_at: new Date().toISOString(),
    };
  }

  async handoffIssue(request: TrackerHandoffRequest): Promise<TrackerHandoffResult> {
    const targetStateId = await this.resolveStateId(request.issue, request.target_state);
    const transitionAt = new Date().toISOString();
    const updateData = await this.graphql<LinearIssueUpdatePayload>({
      query: `
        mutation CalyxSymphonyHandoffIssue($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      `,
      variables: { id: request.issue.id, stateId: targetStateId },
      errorContext: "issueUpdate(handoff)",
    });
    let commentId: string | undefined;
    try {
      const commentData = await this.graphql<LinearCommentCreatePayload>({
        query: `
          mutation CalyxSymphonyHandoffComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment { id }
            }
          }
        `,
        variables: { issueId: request.issue.id, body: request.comment_body },
        errorContext: "commentCreate",
      });
      commentId = commentData.commentCreate?.comment?.id;
    } catch {
      // Comment failure should not roll back the state transition.
      commentId = undefined;
    }
    const updated = updateData.issueUpdate?.issue;
    return {
      issue_id: request.issue.id,
      identifier: request.issue.identifier,
      previous_state: request.issue.state.name,
      current_state: updated?.state?.name ?? request.target_state,
      transitioned: Boolean(updateData.issueUpdate?.success),
      transition_at: transitionAt,
      ...(commentId ? { comment_id: commentId } : {}),
    };
  }
}

interface LinearWorkflowStatesPayload {
  issue?: {
    id?: string;
    team?: {
      id?: string;
      states?: {
        nodes?: Array<{ id?: string; name?: string }>;
      };
    };
  };
}

interface LinearIssueUpdatePayload {
  issueUpdate?: {
    success?: boolean;
    issue?: {
      id?: string;
      identifier?: string;
      state?: { name?: string };
    };
  };
}

interface LinearCommentCreatePayload {
  commentCreate?: {
    success?: boolean;
    comment?: { id?: string };
  };
}

export function createLinearTrackerFactory(
  options: LinearTrackerFactoryOptions = {},
): TrackerClientFactory {
  return () => new LinearTrackerClient(options);
}
