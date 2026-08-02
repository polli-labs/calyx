import { describe, expect, test, vi } from "vitest";
import { LinearTrackerClient, createLinearTrackerFactory } from "../runtime/index.js";

describe("LinearTrackerClient", () => {
  test("pollIssues queries Linear and normalizes issue payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [
            {
              id: "issue-1",
              identifier: "POL-918",
              title: "Implement daemon",
              url: "https://linear.app/polli/issue/POL-918",
              updatedAt: "2026-03-20T12:00:00.000Z",
              state: { name: "Todo", type: "unstarted" },
              labels: { nodes: [{ name: "scope:calyx" }, { name: "infra" }] },
              team: { name: "Polli Labs" },
              project: { name: "Calyx" },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    }), { status: 200 }));
    const client = new LinearTrackerClient({
      fetchImpl,
      env: { LINEAR_API_KEY: "linear-test-key" },
    });

    const result = await client.pollIssues({
      team: "Polli Labs",
      project: "Calyx",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.issues).toEqual([
      {
        id: "issue-1",
        identifier: "POL-918",
        title: "Implement daemon",
        url: "https://linear.app/polli/issue/POL-918",
        updated_at: "2026-03-20T12:00:00.000Z",
        state: { name: "Todo", type: "unstarted" },
        labels: ["scope:calyx", "infra"],
        team: "Polli Labs",
        project: "Calyx",
      },
    ]);
  });

  test("claimIssue resolves the workflow state id and issues an issueUpdate mutation", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      if (body.query.includes("CalyxResolveWorkflowState")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              id: "issue-1",
              team: {
                id: "team-1",
                states: {
                  nodes: [
                    { id: "state-todo", name: "Todo" },
                    { id: "state-in-progress", name: "In Progress" },
                    { id: "state-review", name: "In Review" },
                  ],
                },
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "POL-918",
              state: { name: "In Progress" },
            },
          },
        },
      }), { status: 200 });
    });

    const client = new LinearTrackerClient({
      fetchImpl,
      env: { LINEAR_API_KEY: "linear-test-key" },
    });

    const result = await client.claimIssue({
      issue: {
        id: "issue-1",
        identifier: "POL-918",
        title: "Ship daemon",
        updated_at: "2026-05-13T00:00:00.000Z",
        state: { name: "Todo", type: "unstarted" },
        labels: [],
      },
      target_state: "In Progress",
    });

    expect(result.transitioned).toBe(true);
    expect(result.current_state).toBe("In Progress");
    expect(result.previous_state).toBe("Todo");
    const updateCall = calls.find((call) => call.query.includes("CalyxSymphonyClaimIssue"));
    expect(updateCall?.variables).toMatchObject({ id: "issue-1", stateId: "state-in-progress" });
  });

  test("handoffIssue transitions and posts a comment, returning comment_id when present", async () => {
    const calls: Array<{ query: string }> = [];
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      calls.push({ query: body.query });
      if (body.query.includes("CalyxResolveWorkflowState")) {
        return new Response(JSON.stringify({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [
                    { id: "state-todo", name: "Todo" },
                    { id: "state-in-review", name: "In Review" },
                  ],
                },
              },
            },
          },
        }), { status: 200 });
      }
      if (body.query.includes("CalyxSymphonyHandoffIssue")) {
        return new Response(JSON.stringify({
          data: {
            issueUpdate: {
              success: true,
              issue: { id: "issue-1", identifier: "POL-918", state: { name: "In Review" } },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true, comment: { id: "comment-42" } } },
      }), { status: 200 });
    });

    const client = new LinearTrackerClient({
      fetchImpl,
      env: { LINEAR_API_KEY: "linear-test-key" },
    });

    const result = await client.handoffIssue({
      issue: {
        id: "issue-1",
        identifier: "POL-918",
        title: "Ship daemon",
        updated_at: "2026-05-13T00:00:00.000Z",
        state: { name: "In Progress" },
        labels: [],
      },
      target_state: "In Review",
      comment_body: "Calyx Symphony daemon handoff receipt",
    });

    expect(result.transitioned).toBe(true);
    expect(result.current_state).toBe("In Review");
    expect(result.comment_id).toBe("comment-42");
    expect(calls.some((call) => call.query.includes("CalyxSymphonyHandoffIssue"))).toBe(true);
    expect(calls.some((call) => call.query.includes("CalyxSymphonyHandoffComment"))).toBe(true);
  });

  test("factory builds linear tracker clients", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }), { status: 200 }));
    const factory = createLinearTrackerFactory({
      fetchImpl,
      env: { LINEAR_API_KEY: "linear-test-key" },
    });

    const client = factory();
    const result = await client.pollIssues({});

    expect(client.kind).toBe("linear");
    expect(result.issues).toEqual([]);
  });
});
