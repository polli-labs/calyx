const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";

interface LinearGraphqlResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{
    readonly message?: string;
  }>;
}

export interface LinearGraphqlRequester {
  request<TData>(query: string, variables: Record<string, unknown>): Promise<TData>;
}

function ensureString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createLinearGraphqlRequester(args: {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): LinearGraphqlRequester {
  const apiUrl = args.apiUrl ?? DEFAULT_LINEAR_API_URL;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async request<TData>(query: string, variables: Record<string, unknown>): Promise<TData> {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: args.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });

      const bodyText = await response.text();
      let payload: LinearGraphqlResponse<TData>;
      try {
        payload = JSON.parse(bodyText) as LinearGraphqlResponse<TData>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse Linear response: ${message}`);
      }

      const errors = payload.errors?.map((entry) => ensureString(entry.message)).filter(Boolean) ?? [];
      if (!response.ok) {
        const message = errors.join("; ") || response.statusText || "request failed";
        throw new Error(`Linear API request failed (${response.status}): ${message}`);
      }
      if (errors.length > 0) {
        throw new Error(errors.join("; "));
      }
      if (!payload.data) {
        throw new Error("Linear API response omitted data.");
      }
      return payload.data;
    },
  };
}
