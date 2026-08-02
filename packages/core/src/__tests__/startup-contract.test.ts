import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { CALYX_HOST_ALIAS_ENV } from "../consumer-credentials";
import {
  CALYX_SERVER_STARTUP_CONTRACT,
  CALYX_CONSUMER_API_SECRET_POLICY,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
  CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV,
  CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH,
  CALYX_STARTUP_CONTRACT_SCHEMA_VERSION,
  assertStartupContractEnvPresent,
  assertStartupContractConsumerApiAmbientIsolation,
  evaluateStartupContract,
  parseStartupContract,
  type CalyxStartupContract,
} from "../startup-contract";

const manifestPath = fileURLToPath(new URL("../../startup-contract.json", import.meta.url));

describe("startup contract", () => {
  test("the imported committed manifest is the boot authority", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toEqual(CALYX_SERVER_STARTUP_CONTRACT);
    // The manifest path constant must actually point at the committed file so
    // the upgrade preflight reads the same artifact this test guards.
    expect(CALYX_STARTUP_CONTRACT_MANIFEST_RELATIVE_PATH.endsWith("startup-contract.json")).toBe(true);
  });

  test("the contract requires CALYX_HOST_ALIAS (the POL-1980 spine requirement)", () => {
    expect(CALYX_SERVER_STARTUP_CONTRACT.required_env).toContain(CALYX_HOST_ALIAS_ENV);
    expect(CALYX_SERVER_STARTUP_CONTRACT.required_env).toContain(CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV);
    expect(CALYX_SERVER_STARTUP_CONTRACT.required_env_values).toEqual({
      [CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV]: CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
    });
  });

  test("assertStartupContractEnvPresent throws naming every missing required env", () => {
    expect(() => assertStartupContractEnvPresent({})).toThrowError(/CALYX_HOST_ALIAS/);
    expect(() =>
      assertStartupContractEnvPresent({
        [CALYX_HOST_ALIAS_ENV]: "blade",
        [CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV]: CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT,
      }),
    ).not.toThrow();
    expect(() => assertStartupContractEnvPresent({
      [CALYX_HOST_ALIAS_ENV]: "blade",
      [CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV]: "wrong/v1",
    })).toThrowError(new RegExp(CALYX_SCOPED_SECRETS_PROJECTOR_CONTRACT_ENV));
  });

  test("assertStartupContractEnvPresent treats an explicitly-undefined var as missing", () => {
    expect(() =>
      assertStartupContractEnvPresent({ [CALYX_HOST_ALIAS_ENV]: undefined }),
    ).toThrowError(/CALYX_HOST_ALIAS/);
  });

  test("the manifest-backed boot predicate rejects a foreign consumer API secret", () => {
    const rows = [{
      client_id: "daemon:blade",
      credential_tier: "internal_runtime" as const,
      verifier_env: "CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256",
      token_env: "CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN",
      outbound: true,
      address_grants: { send_as: ["host:blade"], read: ["host:blade"] },
    }];
    expect(() => assertStartupContractConsumerApiAmbientIsolation("blade", rows, {
      CALYX_CONSUMER_API_DAEMON_BLADE_TOKEN: "selected",
      CALYX_CONSUMER_API_DAEMON_BLADE_VERIFIER_SHA256: "verifier",
      CALYX_CONSUMER_API_FOREIGN_TOKEN: "foreign",
    })).toThrow(/foreign consumer API secret env/);
  });

  test("parseStartupContract validates schema version and shape", () => {
    expect(parseStartupContract(CALYX_SERVER_STARTUP_CONTRACT)).toEqual(CALYX_SERVER_STARTUP_CONTRACT);
    expect(parseStartupContract(undefined)).toBeUndefined();
    expect(parseStartupContract({ schema_version: "other/v1", required_env: [], consumer_api_secret_policy: "host-scoped/v1" })).toBeUndefined();
    expect(
      parseStartupContract({
        schema_version: CALYX_STARTUP_CONTRACT_SCHEMA_VERSION,
        required_env: [1],
        consumer_api_secret_policy: "host-scoped/v1",
      }),
    ).toBeUndefined();
  });

  test("evaluateStartupContract reports missing and foreign secret names by name only", () => {
    const contract: CalyxStartupContract = {
      schema_version: CALYX_STARTUP_CONTRACT_SCHEMA_VERSION,
      required_env: ["CALYX_HOST_ALIAS", "CALYX_EXAMPLE"],
      consumer_api_secret_policy: CALYX_CONSUMER_API_SECRET_POLICY,
    };
    expect(evaluateStartupContract(contract, ["CALYX_HOST_ALIAS"])).toEqual({
      missing_env: ["CALYX_EXAMPLE"],
      mismatched_env: [],
      missing_consumer_api_secret_env: [],
      foreign_consumer_api_secret_env: [],
    });
    expect(evaluateStartupContract(
      contract,
      ["CALYX_HOST_ALIAS", "CALYX_EXAMPLE", "CALYX_CONSUMER_API_FOREIGN_TOKEN"],
      ["CALYX_CONSUMER_API_ALLOWED_TOKEN"],
    )).toEqual({
      missing_env: [],
      mismatched_env: [],
      missing_consumer_api_secret_env: ["CALYX_CONSUMER_API_ALLOWED_TOKEN"],
      foreign_consumer_api_secret_env: ["CALYX_CONSUMER_API_FOREIGN_TOKEN"],
    });
  });
});
