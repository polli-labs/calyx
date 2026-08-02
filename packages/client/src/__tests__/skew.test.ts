import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { buildClientContractIR } from "../../../../scripts/lib/client-codegen.mjs";
import { CalyxTransport, generatedCodec as g } from "../transport.js";
import type { OperationPlan } from "../transport.js";

const fixtureRoot = resolve(import.meta.dirname, "../__fixtures__/skew");

interface FixtureClient {
  readonly transport: CalyxTransport;
  readonly plan: OperationPlan;
}

async function fixtureClient(version: "old" | "new", fetchImplementation: typeof fetch): Promise<FixtureClient> {
  const bytes = await readFile(resolve(fixtureRoot, `${version}-openapi.json`));
  const contract = buildClientContractIR(bytes, { expectedCounts: { consumer: 1, admin: 1 } });
  const surface = contract.surfaces.consumer;
  const rawPlan = surface.plans[0]! as any;
  const string = (enumValues?: readonly unknown[]) => g.requestGuard(
    g.requestString(undefined, undefined, undefined, undefined),
    false,
    enumValues,
    false,
    undefined,
  );
  const queryProperties = version === "old"
    ? { known: string(["shared"]) }
    : {
        known: string(["shared"]),
        new_filter: string(),
        numeric_literal: g.requestGuard(g.requestNumber(true, Number.MIN_SAFE_INTEGER, false, Number.MAX_SAFE_INTEGER, false), false, [1], false, undefined),
        boolean_literal: g.requestGuard(g.requestBoolean(), false, undefined, true, true),
      };
  const responseString = g.response(g.responseString(undefined, undefined, undefined, undefined), false, undefined, [], [], [], false, undefined, undefined, []);
  const responseInteger = g.response(g.responseNumber(true, Number.MIN_SAFE_INTEGER, false, Number.MAX_SAFE_INTEGER, false), false, undefined, [], [], [], false, undefined, undefined, []);
  const responseItems = g.response(g.responseArray(responseString, undefined, undefined), false, undefined, [], [], [], false, undefined, undefined, []);
  const responseProperties = {
    schema_version: g.response(g.responseString(undefined, undefined, undefined, undefined), false, undefined, [], [], [], false, undefined, ["calyx.fixture-response/v1"], ["calyx.fixture-response/v1"]),
    value: responseString,
    items: responseItems,
    count: responseInteger,
    state: responseString,
    ...(version === "new" ? { detail: responseString } : {}),
  };
  const responseDecoder = g.response(g.responseObject(
    responseProperties,
    ["schema_version", "value", "items", "count", "state"],
    false,
    undefined,
    (value) => Array.isArray(value["items"]) && value["count"] === value["items"].length,
  ), false, undefined, [], [], [], false, undefined, undefined, ["calyx.fixture-response/v1"]);
  const metadata = { ...rawPlan };
  const rawSuccess = metadata.success;
  for (const key of [
    "requestSchema",
    "pathParameters",
    "requestIdHeaderSchema",
    "errorEnvelopeSchema",
    "errorSchemas",
    "errorRequiredHeaderSchemas",
    "success",
  ]) delete metadata[key];
  const plan: OperationPlan = {
    ...metadata,
    pathParameterSerializers: {},
    requestSerializer: g.requestGuard(g.requestObject(queryProperties, [], undefined), false, undefined, false, undefined),
    requestIdHeaderDecoder: (value) => value.length > 0,
    success: rawSuccess.map(({ schema: _schema, headerSchemas: _headerSchemas, ...success }: any) => ({
      ...success,
      decoder: responseDecoder,
      headerDecoders: { "x-calyx-request-id": (value: string) => value.length > 0 },
    })),
    errorEnvelopeDecoder: g.response(g.responseAny(), false, undefined, [], [], [], false, undefined, undefined, []),
    errorDecoders: {},
    errorRequiredHeaderDecoders: {},
  };
  return {
    transport: new CalyxTransport(
      { baseUrl: "https://fixture.example/proxy", bearerToken: "fixture-token", fetch: fetchImplementation },
      { [plan.operationId]: plan },
      contract.bearerTokenContract,
    ),
    plan,
  };
}

function daemonResponse(version: "old" | "new"): Record<string, unknown> {
  return version === "old"
    ? { schema_version: "calyx.fixture-response/v1", value: "old", items: ["one"], count: 1, state: "ready" }
    : {
        schema_version: "calyx.fixture-response/v1",
        value: "new",
        items: ["one"],
        count: 1,
        state: "paused",
        detail: "additive same-major field",
      };
}

describe("same-major generated client skew", () => {
  for (const clientVersion of ["old", "new"] as const) {
    for (const daemonVersion of ["old", "new"] as const) {
      test(`${clientVersion} client accepts ${daemonVersion} daemon`, async () => {
        const fetchImplementation: typeof fetch = async (input, init) => {
          expect(String(input)).toBe("https://fixture.example/proxy/v1/fixture?known=shared");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
          return new Response(JSON.stringify(daemonResponse(daemonVersion)), {
            status: 200,
            headers: { "content-type": "application/json", "x-calyx-request-id": `req_${daemonVersion}` },
          });
        };
        const client = await fixtureClient(clientVersion, fetchImplementation);

        await expect(client.transport.execute("consumer", client.plan, {
          query: { known: "shared" },
        })).resolves.toMatchObject({ ok: true, requestId: `req_${daemonVersion}` });
      });
    }
  }

  test("old serializer omit-safely strips the new optional request field", async () => {
    let requestedUrl = "";
    const client = await fixtureClient("old", async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(daemonResponse("old")), {
        status: 200,
        headers: { "content-type": "application/json", "x-calyx-request-id": "req_old" },
      });
    });

    await client.transport.execute("consumer", client.plan, {
      query: { known: "shared", new_filter: "must-not-cross" },
    });
    expect(requestedUrl).toBe("https://fixture.example/proxy/v1/fixture?known=shared");
  });

  test("request serialization rejects future enum values before credentials", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = await fixtureClient("new", fetchImplementation);

    await expect(client.transport.execute("consumer", client.plan, {
      query: { known: "future-daemon-value" },
    })).rejects.toThrow(/declared enum member/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("request serialization enforces numeric enums and boolean literals before credentials", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = await fixtureClient("new", fetchImplementation);

    await expect(client.transport.execute("consumer", client.plan, {
      query: { numeric_literal: 2 },
    })).rejects.toThrow(/declared enum member/u);
    await expect(client.transport.execute("consumer", client.plan, {
      query: { boolean_literal: false },
    })).rejects.toThrow(/declared literal/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  test("unknown response schema major fails closed", async () => {
    const unknownMajor = await readFile(resolve(fixtureRoot, "unknown-major-response.json"), "utf8");
    const client = await fixtureClient("new", async () => new Response(unknownMajor, {
      status: 200,
      headers: { "content-type": "application/json", "x-calyx-request-id": "req_future" },
    }));

    await expect(client.transport.execute("consumer", client.plan)).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "schema_major_mismatch",
    });
  });

  test("dishonest generated pagination count fails closed", async () => {
    const client = await fixtureClient("new", async () => new Response(JSON.stringify({
      ...daemonResponse("new"),
      count: 2,
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-calyx-request-id": "req_dishonest" },
    }));

    await expect(client.transport.execute("consumer", client.plan)).resolves.toMatchObject({
      ok: false,
      kind: "protocol",
      stage: "invalid_response",
    });
  });
});
