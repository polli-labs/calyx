import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  credentialMayUseProfile,
  hashConsumerApiBearer,
  type InterfaceProfile,
  type ResolvedConsumerApiCredentialVerifier,
} from "@polli-labs/calyx-core";

import { parseCalyxBearerAuthorization } from "./bearer-contract.js";

export interface AuthenticatedRequestContext {
  subject: string;
  credential_tier: ResolvedConsumerApiCredentialVerifier["credential_tier"];
  address_grants: ResolvedConsumerApiCredentialVerifier["address_grants"];
}

export function readBearerToken(request: IncomingMessage): string | undefined {
  const rawHeaders = request.rawHeaders;
  let authorization: string | undefined;
  if (rawHeaders.length > 0) {
    const authorizationValues: string[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === "authorization") {
        authorizationValues.push(rawHeaders[index + 1] ?? "");
      }
    }
    if (authorizationValues.length !== 1) {
      return undefined;
    }
    [authorization] = authorizationValues;
  } else {
    // IncomingMessage always carries rawHeaders in production. The normalized
    // map fallback keeps direct unit callers honest without weakening the
    // physical-header cardinality check at the HTTP boundary.
    authorization = request.headers.authorization;
  }
  if (!authorization) {
    return undefined;
  }
  return parseCalyxBearerAuthorization(authorization);
}

function verifierMatches(providedToken: string, expectedVerifier: string): boolean {
  const providedBuffer = Buffer.from(hashConsumerApiBearer(providedToken).slice("sha256:".length), "hex");
  const expectedBuffer = Buffer.from(expectedVerifier.slice("sha256:".length), "hex");
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function authenticateRequest(
  request: IncomingMessage,
  credentials: readonly ResolvedConsumerApiCredentialVerifier[],
): AuthenticatedRequestContext | undefined {
  if (credentials.length === 0) {
    throw new Error("Run server requires at least one credential.");
  }
  const providedToken = readBearerToken(request);
  if (!providedToken) {
    return undefined;
  }
  let matched: ResolvedConsumerApiCredentialVerifier | undefined;
  for (const credential of credentials) {
    if (verifierMatches(providedToken, credential.verifier)) {
      matched = credential;
    }
  }
  return matched
    ? {
        subject: matched.client_id,
        credential_tier: matched.credential_tier,
        address_grants: matched.address_grants,
      }
    : undefined;
}

export function authorizeRequestProfile(
  context: AuthenticatedRequestContext,
  profile: InterfaceProfile,
): boolean {
  return credentialMayUseProfile(context.credential_tier, profile);
}
