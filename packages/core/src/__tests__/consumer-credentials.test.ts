import { describe, expect, test } from "vitest";

import {
  addressGranted,
  assertConsumerApiServerAmbientIsolation,
  credentialMayUseProfile,
  hashConsumerApiBearer,
  normalizeAddressGrant,
  resolveConsumerApiClientToken,
  resolveConsumerApiCredentialVerifiers,
  resolveConsumerApiServerHostAlias,
  validateConsumerApiCredentialTruth,
  validateResolvedConsumerApiCredentialVerifiers,
} from "../consumer-credentials";
import type { ConsumerApiCredentialTruth } from "../consumer-credentials";
import type { HostTruthEntry } from "../agents-infra";

function credential(
  overrides: Partial<ConsumerApiCredentialTruth> = {},
): ConsumerApiCredentialTruth {
  return {
    client_id: "switchboard",
    credential_tier: "consumer",
    verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256",
    token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN",
    outbound: true,
    address_grants: {
      send_as: ["client:switchboard@blade"],
      read: ["run:*", "interactive:*", "client:switchboard@blade"],
    },
    ...overrides,
  };
}

const operatorCredential = credential({
  client_id: "operator_cli",
  credential_tier: "control_plane",
  verifier_env: "CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256",
  token_env: "CALYX_CONSUMER_API_OPERATOR_CLI_V1_TOKEN",
  address_grants: {
    send_as: ["client:operator_cli@blade"],
    read: ["host:*"],
  },
});

const daemonCredential = credential({
  client_id: "daemon:blade",
  credential_tier: "internal_runtime",
  verifier_env: "CALYX_CONSUMER_API_DAEMON_BLADE_V1_VERIFIER_SHA256",
  token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN",
  address_grants: {
    send_as: ["client:daemon.blade@blade"],
    read: ["host:blade"],
  },
});

function daemonCredentialFor(host: string): ConsumerApiCredentialTruth {
  const upper = host.toUpperCase();
  return credential({
    client_id: `daemon:${host}`,
    credential_tier: "internal_runtime",
    verifier_env: `CALYX_CONSUMER_API_DAEMON_${upper}_V1_VERIFIER_SHA256`,
    token_env: `CALYX_CONSUMER_API_DAEMON_${upper}_V1_TOKEN`,
    address_grants: {
      send_as: [`client:daemon.${host}@${host}`],
      read: [`host:${host}`],
    },
  });
}

describe("consumer API credentials", () => {
  test("server startup resolves verifier-only credentials and never reads token_env", () => {
    const accessed: string[] = [];
    const env = new Proxy<Record<string, string>>({
      CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256: hashConsumerApiBearer("operator-secret"),
      CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256: hashConsumerApiBearer("switch-secret"),
    }, {
      get(target, property) {
        accessed.push(String(property));
        if (String(property).endsWith("_TOKEN")) {
          throw new Error("server read plaintext token env");
        }
        return target[String(property)];
      },
    }) as NodeJS.ProcessEnv;

    const credentials = resolveConsumerApiCredentialVerifiers("blade", {
      consumer_api_credentials: [credential(), operatorCredential],
    }, env);

    expect(credentials).toEqual([
      {
        client_id: "operator_cli",
        credential_tier: "control_plane",
        verifier_env: "CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256",
        verifier: hashConsumerApiBearer("operator-secret"),
        address_grants: { send_as: ["client:operator_cli@blade"], read: ["host:*"] },
      },
      {
        client_id: "switchboard",
        credential_tier: "consumer",
        verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256",
        verifier: hashConsumerApiBearer("switch-secret"),
        address_grants: {
          send_as: ["client:switchboard@blade"],
          read: ["client:switchboard@blade", "interactive:*", "run:*"],
        },
      },
    ]);
    expect(accessed).toEqual([
      "CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256",
      "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256",
    ]);
    expect(JSON.stringify(credentials)).not.toContain("secret");
    expect(JSON.stringify(credentials)).not.toContain("token_env");
  });

  test("client resolution reads only the selected outbound row", () => {
    const rotation = [
      credential({
        verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER",
        token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN",
        outbound: false,
      }),
      credential({
        verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_VERIFIER",
        token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN",
        outbound: true,
      }),
      operatorCredential,
    ];
    const accessed: string[] = [];
    const env = new Proxy<Record<string, string>>({ CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN: "new-secret" }, {
      get(target, property) {
        accessed.push(String(property));
        if (property !== "CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN") {
          throw new Error(`client read unselected secret ${String(property)}`);
        }
        return target[String(property)];
      },
    }) as NodeJS.ProcessEnv;

    expect(resolveConsumerApiClientToken(
      "blade",
      { consumer_api_credentials: rotation },
      "switchboard",
      env,
    )).toBe("new-secret");
    expect(accessed).toEqual(["CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN"]);
    expect(resolveConsumerApiClientToken("blade", { consumer_api_credentials: rotation }, "unknown", env)).toBeUndefined();
  });

  test("rotation selection is order-independent and flips only through outbound", () => {
    const oldRow = credential({
      verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER",
      token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN",
      outbound: false,
    });
    const newRow = credential({
      verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_VERIFIER",
      token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN",
      outbound: true,
    });
    const verifierEnv = {
      CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER: hashConsumerApiBearer("old-secret"),
      CALYX_CONSUMER_API_SWITCHBOARD_V2_VERIFIER: hashConsumerApiBearer("new-secret"),
    };
    const first = resolveConsumerApiCredentialVerifiers(
      "blade",
      { consumer_api_credentials: [oldRow, newRow] },
      verifierEnv,
    );
    const reversed = resolveConsumerApiCredentialVerifiers(
      "blade",
      { consumer_api_credentials: [newRow, oldRow] },
      verifierEnv,
    );
    expect(reversed).toEqual(first);
    expect(resolveConsumerApiClientToken(
      "blade",
      { consumer_api_credentials: [oldRow, newRow] },
      "switchboard",
      { CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN: "new-secret" },
    )).toBe("new-secret");

    expect(resolveConsumerApiClientToken(
      "blade",
      {
        consumer_api_credentials: [
          { ...oldRow, outbound: true },
          { ...newRow, outbound: false },
        ],
      },
      "switchboard",
      { CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN: "old-secret" },
    )).toBe("old-secret");
  });

  test.each<[HostTruthEntry | undefined, string]>([
    [undefined, "no consumer_api_credentials"],
    [{ consumer_api_credentials: [] }, "no consumer_api_credentials"],
    [{ consumer_api_credentials: [credential({ token_env: "missing" })] }, "reserved CALYX_CONSUMER_API_*"],
    [{ consumer_api_credentials: [credential({ address_grants: { send_as: ["run:**"], read: [] } })] }, "one-kind wildcard"],
    [{ consumer_api_credentials: [credential({ address_grants: { send_as: ["run:one", "run:one"], read: [] } })] }, "duplicate"],
  ])("fails closed for malformed source truth %#", (truth, message) => {
    expect(() => resolveConsumerApiCredentialVerifiers("blade", truth, {})).toThrow(message);
  });

  test("rejects missing, malformed, and duplicate verifier material", () => {
    const truth = { consumer_api_credentials: [credential(), operatorCredential] };
    expect(() => resolveConsumerApiCredentialVerifiers("blade", truth, {}))
      .toThrow("CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256");
    expect(() => resolveConsumerApiCredentialVerifiers("blade", truth, {
      CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256: "sha256:not-a-digest",
      CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256: hashConsumerApiBearer("switch-secret"),
    })).toThrow("64 lowercase hex");
    const duplicate = hashConsumerApiBearer("same-secret");
    expect(() => resolveConsumerApiCredentialVerifiers("blade", truth, {
      CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256: duplicate,
      CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256: duplicate,
    })).toThrow("verifier collision");
  });

  test("rejects ambiguous rotation declarations and semantic drift", () => {
    const second = credential({
      verifier_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_VERIFIER",
      token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V2_TOKEN",
      outbound: false,
    });
    expect(() => validateConsumerApiCredentialTruth([
      credential({ outbound: false }),
      second,
    ])).toThrow("exactly one outbound");
    expect(() => validateConsumerApiCredentialTruth([
      credential(),
      { ...second, outbound: true },
    ])).toThrow("exactly one outbound");
    expect(() => validateConsumerApiCredentialTruth([
      credential(),
      { ...second, credential_tier: "control_plane" },
    ])).toThrow("identical tier and grants");
  });

  test("binds internal-runtime tier exactly to canonical daemon subjects", () => {
    expect(() => validateConsumerApiCredentialTruth([
      credential({ client_id: "daemon:worm", credential_tier: "consumer" }),
    ])).toThrow("if and only if client_id is daemon:<host>");
    expect(() => validateConsumerApiCredentialTruth([
      credential({ client_id: "switchboard", credential_tier: "internal_runtime" }),
    ])).toThrow("if and only if client_id is daemon:<host>");
    expect(() => validateConsumerApiCredentialTruth([
      credential({ client_id: "daemon:not_a_host", credential_tier: "internal_runtime" }),
    ])).toThrow("canonical daemon:<host>");

    expect(() => validateResolvedConsumerApiCredentialVerifiers([{
      client_id: "daemon:worm",
      credential_tier: "control_plane",
      verifier: hashConsumerApiBearer("mis-tiered-daemon"),
      verifier_env: "CALYX_MIS_TIERED_DAEMON_VERIFIER",
      address_grants: { send_as: ["client:daemon.worm@worm"], read: ["host:worm"] },
    }])).toThrow("if and only if client_id is daemon:<host>");
    expect(() => validateResolvedConsumerApiCredentialVerifiers([{
      client_id: "operator_cli",
      credential_tier: "internal_runtime",
      verifier: hashConsumerApiBearer("mis-tiered-operator"),
      verifier_env: "CALYX_MIS_TIERED_OPERATOR_VERIFIER",
      address_grants: { send_as: ["client:operator_cli@blade"], read: ["host:blade"] },
    }])).toThrow("if and only if client_id is daemon:<host>");
  });

  test("environment names are globally disjoint across verifier and token columns", () => {
    expect(() => validateConsumerApiCredentialTruth([
      credential(),
      { ...operatorCredential, token_env: "CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256" },
    ])).toThrow(/token_env .* must end in _TOKEN/u);
  });

  test("catalog credentials must use the globally recognizable reserved namespace", () => {
    expect(() => validateConsumerApiCredentialTruth([
      credential({ token_env: "CALYX_RETIRED_SWITCHBOARD_TOKEN" }),
    ])).toThrow(/reserved CALYX_CONSUMER_API_\* credential namespace/u);
    expect(() => validateConsumerApiCredentialTruth([
      credential({ verifier_env: "CALYX_RETIRED_SWITCHBOARD_VERIFIER" }),
    ])).toThrow(/reserved CALYX_CONSUMER_API_\* credential namespace/u);
  });

  test("server ambient isolation permits only its selected daemon token without reading token values", () => {
    const credentialTruth = [credential(), operatorCredential, daemonCredential];
    const allowedEnv = new Proxy({
      CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN: "daemon-secret",
      CALYX_CONSUMER_API_SWITCHBOARD_V1_VERIFIER_SHA256: "catalog-verifier",
      CALYX_CONSUMER_API_OPERATOR_CLI_V1_VERIFIER_SHA256: "catalog-verifier",
      CALYX_CONSUMER_API_DAEMON_BLADE_V1_VERIFIER_SHA256: "catalog-verifier",
    }, {
      get() {
        throw new Error("ambient isolation read a token value");
      },
    }) as NodeJS.ProcessEnv;
    expect(assertConsumerApiServerAmbientIsolation("blade", credentialTruth, allowedEnv)).toEqual({
      daemon_client_id: "daemon:blade",
      token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN",
    });

    const contaminatedEnv = new Proxy({
      CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN: "daemon-secret",
      CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN: "must-not-read",
    }, {
      get() {
        throw new Error("ambient isolation read a token value");
      },
    }) as NodeJS.ProcessEnv;
    expect(() => assertConsumerApiServerAmbientIsolation("blade", credentialTruth, contaminatedEnv))
      .toThrow(/foreign consumer API secret env\(s\): CALYX_CONSUMER_API_SWITCHBOARD_V1_TOKEN/);

    const undeclaredConventionEnv = new Proxy({
      CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN: "daemon-secret",
      CALYX_CONSUMER_API_STALE_TOKEN: "must-not-read",
    }, {
      get() {
        throw new Error("ambient isolation read a token value");
      },
    }) as NodeJS.ProcessEnv;
    expect(() => assertConsumerApiServerAmbientIsolation("blade", credentialTruth, undeclaredConventionEnv))
      .toThrow(/foreign consumer API secret env\(s\): CALYX_CONSUMER_API_STALE_TOKEN/);

    const undeclaredConventionVerifierEnv = new Proxy({
      CALYX_CONSUMER_API_DAEMON_BLADE_V1_TOKEN: "daemon-secret",
      CALYX_CONSUMER_API_STALE_VERIFIER_SHA256: "must-not-read",
    }, {
      get() {
        throw new Error("ambient isolation read a verifier value");
      },
    }) as NodeJS.ProcessEnv;
    expect(() => assertConsumerApiServerAmbientIsolation("blade", credentialTruth, undeclaredConventionVerifierEnv))
      .toThrow(/foreign consumer API secret env\(s\): CALYX_CONSUMER_API_STALE_VERIFIER_SHA256/);
  });

  test.each([
    { selected: "worm", colliding: "blade", home: "/home/caleb" },
    { selected: "mba", colliding: "carbon", home: "/Users/carbon" },
  ])("credentialized server identity uses explicit host alias across $colliding/$selected home collisions", ({ selected, colliding, home }) => {
    const selectedCredential = daemonCredentialFor(selected);
    const truth = {
      hosts: {
        [colliding]: { consumer_api_credentials: [daemonCredentialFor(colliding)] },
        [selected]: { consumer_api_credentials: [selectedCredential] },
      },
    };
    const env = {
      HOME: home,
      CALYX_HOST_ALIAS: selected,
      [selectedCredential.token_env]: "daemon-secret",
    };

    const hostAlias = resolveConsumerApiServerHostAlias(truth, env);
    expect(hostAlias).toBe(selected);
    expect(assertConsumerApiServerAmbientIsolation(
      hostAlias,
      truth.hosts[selected]!.consumer_api_credentials!,
      env,
    )).toMatchObject({ daemon_client_id: `daemon:${selected}` });
  });

  test("credentialized server identity fails closed when host alias is absent or unknown", () => {
    const truth = { hosts: { blade: { consumer_api_credentials: [daemonCredential] } } };
    expect(() => resolveConsumerApiServerHostAlias(truth, { HOME: "/home/caleb" }))
      .toThrow("requires CALYX_HOST_ALIAS");
    expect(() => resolveConsumerApiServerHostAlias(truth, { CALYX_HOST_ALIAS: "worm" }))
      .toThrow("unknown host worm");
    expect(() => resolveConsumerApiServerHostAlias(truth, { CALYX_HOST_ALIAS: "Blade" }))
      .toThrow("not a canonical host alias");
  });

  test("grants use one strict canonical grammar at source and runtime", () => {
    expect(normalizeAddressGrant("run:abc-123")).toBe("run:abc-123");
    expect(normalizeAddressGrant("interactive:codex:019f5d0e-84ef")).toBe("interactive:codex:019f5d0e-84ef");
    expect(normalizeAddressGrant("client:switchboard@blade")).toBe("client:switchboard@blade");
    expect(normalizeAddressGrant("role:conductor@blade")).toBe("role:conductor@blade");
    expect(addressGranted(["run:*"], "run:abc")).toBe(true);
    expect(addressGranted(["run:*"], "interactive:codex:abc")).toBe(false);
    expect(addressGranted(["fleet"], "fleet")).toBe(true);
    expect(addressGranted(["interactive:*"], "interactive:codex:019f5d0e-84ef")).toBe(true);

    for (const invalid of [
      "RUN:abc",
      "fleet:any",
      "fleet:*",
      "interactive:codex",
      "interactive:Codex:abc",
      "authorship_alias:*",
      "authorship_alias:codex:blade:019f5d0e-84ef",
      "authorship_alias:switchboard",
      "client:switchboard",
      "client:Switchboard@blade",
      "role:conductor",
      "host:Blade",
      " run:abc",
    ]) {
      expect(() => normalizeAddressGrant(invalid), invalid).toThrow();
    }

    expect(credentialMayUseProfile("consumer", "consumer_v1")).toBe(true);
    expect(credentialMayUseProfile("consumer", "control_plane_admin_v1")).toBe(false);
    expect(credentialMayUseProfile("control_plane", "internal_runtime")).toBe(false);
    expect(credentialMayUseProfile("internal_runtime", "internal_runtime")).toBe(true);
    expect(credentialMayUseProfile("internal_runtime", "consumer_v1")).toBe(false);
    expect(credentialMayUseProfile("internal_runtime", "control_plane_admin_v1")).toBe(false);
  });
});
