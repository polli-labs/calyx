import { z } from "zod";
import type {
  CtxpackCapabilityReasonCodeV1,
  CtxpackCapabilitiesRequestV1,
  CtxpackCapabilitiesResponseDataV1,
  CtxpackCapabilityV1,
  CtxpackContractVersion,
  CtxpackDocsRequestV1,
  CtxpackIntrospectRequestV1,
  CtxpackOutputEnvelopeV1,
  CtxpackPackRequestV1,
  CtxpackPlanRequestV1,
  CtxpackPrimitiveV1,
  CtxpackProviderCapabilityV1,
  CtxpackProviderIdV1,
  CtxpackProviderPrimitiveStatusMapV1,
  CtxpackProviderPrimitiveSupportV1,
  CtxpackProviderTierV1,
  CtxpackRequestV1,
  CtxpackSuccessEnvelopeV1
} from "../types";
import {
  CTXPACK_ERROR_CODES_V1,
  CTXPACK_ERROR_EXIT_CODES_V1,
  createCtxpackErrorEnvelopeV1,
  createCtxpackNotImplementedErrorV1,
  ctxpackErrorEnvelopeSchemaV1
} from "./errors";
import { createCtxpackPlanHashV1, normalizeCtxpackRequestV1, normalizeCtxpackValueV1 } from "./normalize";
import { computeCtxpackDocsV1, computeCtxpackIntrospectV1 } from "./docs";
import { computeCtxpackPackV1, computeCtxpackPackWithSourcesV1 } from "./pack";
import { computeCtxpackPlanV1, computeCtxpackPlanWithSourcesV1 } from "./plan";
import {
  createSessionProviderAdapterV1,
  isFirstPartySessionProviderV1,
  normalizeRequestedProvidersV1
} from "./session-adapters";

export const CTXPACK_CONTRACT_VERSION_V1: CtxpackContractVersion = "v1";

export const CTXPACK_PRIMITIVES_V1 = [
  "capabilities",
  "plan",
  "pack",
  "docs",
  "introspect"
] as const satisfies readonly CtxpackPrimitiveV1[];

export const CTXPACK_PROVIDER_ORDER_V1 = [
  "claude",
  "codex",
  "aider",
  "continue",
  "cursor",
  "gemini",
  "hermes",
  "windsurf",
  "zed"
] as const satisfies readonly CtxpackProviderIdV1[];

const ctxpackPrimitiveSchemaV1 = z.enum(CTXPACK_PRIMITIVES_V1);

const ctxpackBaseRequestSchemaV1 = z.object({
  version: z.literal("v1"),
  primitive: ctxpackPrimitiveSchemaV1,
  request_id: z.string().min(1).optional(),
  json: z.boolean().optional()
});

const pathListSchema = z.array(z.string().min(1));
const providerListSchema = z.array(z.string().min(1));
const contextProfileSchema = z.enum(["default", "chatgpt-web"]);

const ctxpackCapabilitiesRequestSchemaV1 = ctxpackBaseRequestSchemaV1.extend({
  primitive: z.literal("capabilities"),
  include_undetected: z.boolean().optional(),
  providers: providerListSchema.optional()
}).strict();

const ctxpackPlanRequestSchemaV1 = ctxpackBaseRequestSchemaV1.extend({
  primitive: z.literal("plan"),
  goal: z.string().min(1).optional(),
  profile: contextProfileSchema.optional(),
  seeds: pathListSchema.optional(),
  vault_path: z.string().min(1).optional(),
  roots: pathListSchema.optional(),
  include_sessions: z.boolean().optional(),
  include_git_meta: z.boolean().optional(),
  include: pathListSchema.optional(),
  exclude: pathListSchema.optional(),
  budget: z.object({
    max_bytes: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional()
  }).optional(),
  inputs: z.record(z.unknown()).optional()
}).strict();

const ctxpackPackRequestSchemaV1 = ctxpackBaseRequestSchemaV1.extend({
  primitive: z.literal("pack"),
  goal: z.string().min(1).optional(),
  profile: contextProfileSchema.optional(),
  seeds: pathListSchema.optional(),
  vault_path: z.string().min(1).optional(),
  budget: z.object({
    max_bytes: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional()
  }).optional(),
  include: pathListSchema.optional(),
  exclude: pathListSchema.optional(),
  plan_hash: z.string().min(1).optional(),
  out_dir: z.string().min(1).optional(),
  apply: z.boolean().optional(),
  redaction_mode: z.enum(["strict", "advisory"]).optional()
}).strict();

const ctxpackDocsRequestSchemaV1 = ctxpackBaseRequestSchemaV1.extend({
  primitive: z.literal("docs"),
  bundle_path: z.string().min(1).optional(),
  format: z.enum(["markdown", "json"]).optional(),
  topic: z.string().min(1).optional()
}).strict();

const ctxpackIntrospectRequestSchemaV1 = ctxpackBaseRequestSchemaV1.extend({
  primitive: z.literal("introspect"),
  bundle_path: z.string().min(1).optional(),
  enable_experimental: z.boolean().optional(),
  target: z.string().min(1).optional()
}).strict();

export const ctxpackRequestSchemaV1 = z.discriminatedUnion("primitive", [
  ctxpackCapabilitiesRequestSchemaV1,
  ctxpackPlanRequestSchemaV1,
  ctxpackPackRequestSchemaV1,
  ctxpackDocsRequestSchemaV1,
  ctxpackIntrospectRequestSchemaV1
]);

const ctxpackDeterminismSchemaV1 = z.object({
  normalized: z.boolean(),
  normalization_version: z.string().min(1),
  plan_hash_input: z.string().min(1).optional(),
  plan_hash: z.string().min(1).optional()
}).strict();

export const ctxpackSuccessEnvelopeSchemaV1 = z.object({
  version: z.literal("v1"),
  ok: z.literal(true),
  primitive: ctxpackPrimitiveSchemaV1,
  determinism: ctxpackDeterminismSchemaV1,
  data: z.record(z.unknown())
}).strict();

export const ctxpackOutputEnvelopeSchemaV1 = z.union([
  ctxpackSuccessEnvelopeSchemaV1,
  ctxpackErrorEnvelopeSchemaV1
]);

export function parseCtxpackRequestV1(input: unknown): CtxpackRequestV1 {
  return ctxpackRequestSchemaV1.parse(input) as CtxpackRequestV1;
}

export function parseCtxpackOutputEnvelopeV1(input: unknown): CtxpackOutputEnvelopeV1 {
  return ctxpackOutputEnvelopeSchemaV1.parse(input) as CtxpackOutputEnvelopeV1;
}

export function makeCtxpackSuccessEnvelopeV1<
  TPrimitive extends CtxpackPrimitiveV1,
  TData extends object
>(
  primitive: TPrimitive,
  data: TData
): CtxpackSuccessEnvelopeV1<TPrimitive, TData> {
  const normalizedData = normalizeCtxpackValueV1(data);
  const hash = createCtxpackPlanHashV1({
    version: CTXPACK_CONTRACT_VERSION_V1,
    primitive,
    data: normalizedData
  });
  const explicitPlanHash =
    primitive === "plan" &&
    "plan_hash" in normalizedData &&
    typeof (normalizedData as { plan_hash?: unknown }).plan_hash === "string" &&
    "plan_hash_input" in normalizedData &&
    typeof (normalizedData as { plan_hash_input?: unknown }).plan_hash_input === "string"
      ? {
          plan_hash: (normalizedData as { plan_hash: string }).plan_hash,
          plan_hash_input: (normalizedData as { plan_hash_input: string }).plan_hash_input
        }
      : undefined;

  return {
    version: CTXPACK_CONTRACT_VERSION_V1,
    ok: true,
    primitive,
    determinism: {
      normalized: true,
      normalization_version: "ctxpack.v1",
      plan_hash_input: explicitPlanHash?.plan_hash_input ?? hash.plan_hash_input,
      plan_hash: explicitPlanHash?.plan_hash ?? hash.plan_hash
    },
    data: normalizedData
  };
}

function makePrimitiveSupport(provider: CtxpackProviderIdV1): CtxpackProviderPrimitiveSupportV1 {
  return {
    capabilities: isFirstPartySessionProviderV1(provider),
    plan: false,
    pack: false,
    docs: false,
    introspect: false
  };
}

function resolveProviderTier(provider: CtxpackProviderIdV1): CtxpackProviderTierV1 {
  if (provider === "claude" || provider === "codex") {
    return "tier_0";
  }
  if (provider === "gemini" || provider === "hermes") {
    return "tier_1";
  }
  return "tier_2";
}

function collectReadyEvidencePointers(evidence: CtxpackProviderCapabilityV1["evidence"]): string[] {
  const successProbes = evidence
    .filter((entry) => entry.result === "success")
    .map((entry) => entry.probe);
  const fallbackProbes = evidence.map((entry) => entry.probe);
  const probes = successProbes.length > 0 ? successProbes : fallbackProbes;
  return [...new Set(probes)];
}

function ensurePrimitiveUnavailableEvidencePointer(
  evidence: CtxpackProviderCapabilityV1["evidence"],
  provider: CtxpackProviderIdV1,
  primitive: CtxpackPrimitiveV1,
  reasonCode: CtxpackCapabilityReasonCodeV1
): string {
  const probe = `primitive:${provider}:${primitive}`;
  const existing = evidence.find((entry) => entry.probe === probe);
  if (!existing) {
    evidence.push({
      probe,
      result: "missing",
      detail: "primitive_unavailable_in_provider_contract",
      reason_code: reasonCode,
      metadata: {
        provider,
        primitive
      }
    });
  }
  return probe;
}

function makePrimitiveStatusMap(
  provider: CtxpackProviderIdV1,
  primitives: CtxpackProviderPrimitiveSupportV1,
  evidence: CtxpackProviderCapabilityV1["evidence"]
): CtxpackProviderPrimitiveStatusMapV1 {
  const readyEvidence = collectReadyEvidencePointers(evidence);
  const map = {} as CtxpackProviderPrimitiveStatusMapV1;

  for (const primitive of CTXPACK_PRIMITIVES_V1) {
    const available = primitives[primitive];
    if (available) {
      map[primitive] = {
        status: "ready",
        evidence: readyEvidence
      };
      continue;
    }

    const reasonCode: CtxpackCapabilityReasonCodeV1 = "adapter_not_implemented";
    const pointer = ensurePrimitiveUnavailableEvidencePointer(evidence, provider, primitive, reasonCode);
    map[primitive] = {
      status: "capability_unavailable",
      reason_code: reasonCode,
      evidence: [pointer]
    };
  }

  return map;
}

function makeFirstPartyProviderCapability(
  provider: CtxpackProviderIdV1,
  aliasTrace?: CtxpackProviderCapabilityV1["alias_trace"]
): CtxpackProviderCapabilityV1 {
  const adapter = createSessionProviderAdapterV1(provider);
  const detection = adapter.detect();
  const evidence = [...detection.evidence];
  const primitives = makePrimitiveSupport(provider);

  return {
    provider,
    tier: resolveProviderTier(provider),
    detected: detection.detected,
    capability_flags: adapter.capabilities(),
    primitives,
    primitive_status: makePrimitiveStatusMap(provider, primitives, evidence),
    ...(detection.reasons ? { reasons: detection.reasons } : {}),
    ...(aliasTrace && aliasTrace.length > 0 ? { alias_trace: aliasTrace } : {}),
    evidence
  };
}

function makeDeferredProviderCapability(
  provider: CtxpackProviderIdV1,
  aliasTrace?: CtxpackProviderCapabilityV1["alias_trace"]
): CtxpackProviderCapabilityV1 {
  const aliasEvidence = aliasTrace?.[0] ?? {
    input: provider,
    canonical_slug: provider,
    canonical_provider: provider,
    matched_alias: provider
  };
  const evidence: CtxpackProviderCapabilityV1["evidence"] = [
    {
      probe: "provider:alias",
      result: "success",
      detail: "provider_alias_normalized",
      metadata: { ...aliasEvidence }
    },
    {
      probe: `registry:first-party/${provider}`,
      result: "missing",
      detail: "provider_contract_not_registered",
      reason_code: "adapter_not_implemented",
      metadata: {
        provider
      }
    }
  ];
  const primitives = makePrimitiveSupport(provider);

  return {
    provider,
    tier: resolveProviderTier(provider),
    detected: false,
    capability_flags: {
      detect: "ready",
      list: "capability_unavailable",
      read: "capability_unavailable",
      normalize: "capability_unavailable",
      evidence: "ready"
    },
    primitives,
    primitive_status: makePrimitiveStatusMap(provider, primitives, evidence),
    reasons: ["adapter_not_implemented"],
    ...(aliasTrace && aliasTrace.length > 0 ? { alias_trace: aliasTrace } : {}),
    evidence
  };
}

function buildCapabilitiesProviders(
  request: CtxpackCapabilitiesRequestV1
): CtxpackOutputEnvelopeV1 | CtxpackProviderCapabilityV1[] {
  const includeUndetected = Boolean(request.include_undetected);
  const normalizedProviders = normalizeRequestedProvidersV1(request.providers);
  const requestedProviders = normalizedProviders.providers;

  if (normalizedProviders.unknown.length > 0) {
    return createCtxpackErrorEnvelopeV1({
      code: "adapter_error",
      primitive: "capabilities",
      message: "One or more requested providers are not supported by ctxpack v1.",
      details: {
        providers: normalizedProviders.unknown.map((trace) => trace.input),
        reason_code: "provider_not_supported",
        alias_trace: normalizedProviders.unknown
      }
    });
  }

  const selectedProviders =
    requestedProviders.length > 0
      ? CTXPACK_PROVIDER_ORDER_V1.filter((provider) => requestedProviders.includes(provider))
      : includeUndetected
        ? CTXPACK_PROVIDER_ORDER_V1
        : CTXPACK_PROVIDER_ORDER_V1.filter((provider) => isFirstPartySessionProviderV1(provider));

  if (!includeUndetected) {
    const blockedProviders = selectedProviders.filter((provider) => !isFirstPartySessionProviderV1(provider));
    if (blockedProviders.length > 0) {
      return createCtxpackErrorEnvelopeV1({
        code: "capability_unavailable",
        primitive: "capabilities",
        message: "Requested providers require --include-undetected because adapters are not yet implemented.",
        details: {
          providers: blockedProviders,
          reason_code: "include_undetected_required"
        }
      });
    }
  }

  const aliasTraceByProvider = new Map<CtxpackProviderIdV1, CtxpackProviderCapabilityV1["alias_trace"]>();
  for (const trace of normalizedProviders.traces) {
    if (!trace.canonical_provider) {
      continue;
    }
    const bucket = aliasTraceByProvider.get(trace.canonical_provider) ?? [];
    bucket.push(trace);
    aliasTraceByProvider.set(trace.canonical_provider, bucket);
  }

  const providerCapabilities = selectedProviders.map((provider) => {
    const aliasTrace = aliasTraceByProvider.get(provider);
    if (isFirstPartySessionProviderV1(provider)) {
      return makeFirstPartyProviderCapability(provider, aliasTrace);
    }
    return makeDeferredProviderCapability(provider, aliasTrace);
  });

  if (!includeUndetected) {
    const undetectedProviders = providerCapabilities
      .filter((provider) => !provider.detected)
      .map((provider) => provider.provider);

    if (requestedProviders.length > 0 && undetectedProviders.length > 0) {
      return createCtxpackErrorEnvelopeV1({
        code: "capability_unavailable",
        primitive: "capabilities",
        message: "Requested providers are currently undetected. Re-run with --include-undetected for probe evidence.",
        details: {
          providers: undetectedProviders,
          reason_code: "include_undetected_required"
        }
      });
    }
  }

  return includeUndetected
    ? providerCapabilities
    : providerCapabilities.filter((provider) => provider.detected);
}

export function createCtxpackCapabilitiesResponseV1(
  request: CtxpackCapabilitiesRequestV1 = {
    version: CTXPACK_CONTRACT_VERSION_V1,
    primitive: "capabilities"
  }
): CtxpackOutputEnvelopeV1 {
  const implementedPrimitiveSet = new Set<CtxpackPrimitiveV1>([
    "capabilities",
    "plan",
    "pack",
    "docs",
    "introspect"
  ]);
  const primitives: CtxpackCapabilityV1[] = CTXPACK_PRIMITIVES_V1.map((primitive) => {
    if (implementedPrimitiveSet.has(primitive)) {
      return {
        primitive,
        available: true,
        since: "v1",
        notes:
          primitive === "plan"
            ? "Deterministic planning surface is implemented in v1."
            : primitive === "pack"
              ? "Deterministic bundle materialization with redaction and truncation receipts is implemented in v1."
              : primitive === "docs"
                ? "Deterministic docs rendering from bundle receipts is implemented in v1."
                : primitive === "introspect"
                  ? "Experimental introspection metrics are available with --enable-experimental."
            : "Contract metadata is available in this freeze lane."
      };
    }

    return {
      primitive,
      available: false,
      since: "v1",
      notes: "Contract frozen in v1. Full implementation deferred to downstream lane."
    };
  });

  const providers = buildCapabilitiesProviders(request);
  if (!Array.isArray(providers)) {
    return providers;
  }

  const data: CtxpackCapabilitiesResponseDataV1 = {
    include_undetected: Boolean(request.include_undetected),
    primitives,
    providers,
    exit_code_map: { ...CTXPACK_ERROR_EXIT_CODES_V1 }
  };

  return makeCtxpackSuccessEnvelopeV1("capabilities", data);
}

function requestHasSourceGraphInputs(request: CtxpackRequestV1): boolean {
  if (request.primitive !== "plan" && request.primitive !== "pack") {
    return false;
  }
  return Boolean(
    request.profile === "chatgpt-web" ||
      request.goal?.trim() ||
      (request.seeds && request.seeds.some((seed) => seed.trim().length > 0)) ||
      request.vault_path?.trim()
  );
}

export async function runCtxpackContractV1(
  primitive: CtxpackPrimitiveV1,
  request: CtxpackRequestV1 | Record<string, unknown> = {}
): Promise<CtxpackOutputEnvelopeV1> {
  const requestCandidate = normalizeCtxpackRequestV1({
    version: CTXPACK_CONTRACT_VERSION_V1,
    primitive,
    ...(request as Record<string, unknown>)
  });

  const parsedRequest = ctxpackRequestSchemaV1.safeParse(requestCandidate);
  if (!parsedRequest.success) {
    return createCtxpackErrorEnvelopeV1({
      code: "validation_error",
      primitive,
      message: `ctxpack/${primitive} request failed contract v1 validation.`,
      details: {
        issues: parsedRequest.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  if (!requestHasSourceGraphInputs(parsedRequest.data as CtxpackRequestV1)) {
    return runCtxpackContractStubV1(primitive, parsedRequest.data as CtxpackRequestV1);
  }

  if (primitive === "plan") {
    let planned;
    try {
      planned = await computeCtxpackPlanWithSourcesV1(parsedRequest.data as CtxpackPlanRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (planned.error) {
      return createCtxpackErrorEnvelopeV1({
        code: planned.error.code,
        primitive,
        message: planned.error.message,
        ...(planned.error.details ? { details: planned.error.details } : {})
      });
    }
    if (!planned.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/plan computation completed without output data."
      });
    }
    return makeCtxpackSuccessEnvelopeV1("plan", planned.data);
  }

  if (primitive === "pack") {
    let packed;
    try {
      packed = await computeCtxpackPackWithSourcesV1(parsedRequest.data as CtxpackPackRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (packed.error) {
      return createCtxpackErrorEnvelopeV1({
        code: packed.error.code,
        primitive,
        message: packed.error.message,
        ...(packed.error.details ? { details: packed.error.details } : {})
      });
    }
    if (!packed.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/pack computation completed without output data."
      });
    }
    return makeCtxpackSuccessEnvelopeV1("pack", packed.data);
  }

  return createCtxpackErrorEnvelopeV1({
    code: "validation_error",
    primitive,
    message: `ctxpack/${primitive} does not accept goal/seed/profile inputs.`,
    details: {
      reason_code: "source_graph_inputs_not_supported"
    }
  });
}

export function runCtxpackContractStubV1(
  primitive: CtxpackPrimitiveV1,
  request: CtxpackRequestV1 | Record<string, unknown> = {}
): CtxpackOutputEnvelopeV1 {
  const requestCandidate = normalizeCtxpackRequestV1({
    version: CTXPACK_CONTRACT_VERSION_V1,
    primitive,
    ...(request as Record<string, unknown>)
  });

  const parsedRequest = ctxpackRequestSchemaV1.safeParse(requestCandidate);
  if (!parsedRequest.success) {
    return createCtxpackErrorEnvelopeV1({
      code: "validation_error",
      primitive,
      message: `ctxpack/${primitive} request failed contract v1 validation.`,
      details: {
        issues: parsedRequest.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.join("."),
          message: issue.message
        }))
      }
    });
  }

  if (primitive === "capabilities") {
    return createCtxpackCapabilitiesResponseV1(parsedRequest.data as CtxpackCapabilitiesRequestV1);
  }

  if (primitive === "plan") {
    let planned;
    try {
      planned = computeCtxpackPlanV1(parsedRequest.data as CtxpackPlanRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (planned.error) {
      return createCtxpackErrorEnvelopeV1({
        code: planned.error.code,
        primitive,
        message: planned.error.message,
        ...(planned.error.details ? { details: planned.error.details } : {})
      });
    }

    if (!planned.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/plan computation completed without output data."
      });
    }

    return makeCtxpackSuccessEnvelopeV1("plan", planned.data);
  }

  if (primitive === "pack") {
    let packed;
    try {
      packed = computeCtxpackPackV1(parsedRequest.data as CtxpackPackRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (packed.error) {
      return createCtxpackErrorEnvelopeV1({
        code: packed.error.code,
        primitive,
        message: packed.error.message,
        ...(packed.error.details ? { details: packed.error.details } : {})
      });
    }

    if (!packed.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/pack computation completed without output data."
      });
    }

    return makeCtxpackSuccessEnvelopeV1("pack", packed.data);
  }

  if (primitive === "docs") {
    let docs;
    try {
      docs = computeCtxpackDocsV1(parsedRequest.data as CtxpackDocsRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (docs.error) {
      return createCtxpackErrorEnvelopeV1({
        code: docs.error.code,
        primitive,
        message: docs.error.message,
        ...(docs.error.details ? { details: docs.error.details } : {})
      });
    }

    if (!docs.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/docs computation completed without output data."
      });
    }

    return makeCtxpackSuccessEnvelopeV1("docs", docs.data);
  }

  if (primitive === "introspect") {
    let introspect;
    try {
      introspect = computeCtxpackIntrospectV1(parsedRequest.data as CtxpackIntrospectRequestV1);
    } catch (error) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    if (introspect.error) {
      return createCtxpackErrorEnvelopeV1({
        code: introspect.error.code,
        primitive,
        message: introspect.error.message,
        ...(introspect.error.details ? { details: introspect.error.details } : {})
      });
    }

    if (!introspect.data) {
      return createCtxpackErrorEnvelopeV1({
        code: "internal_error",
        primitive,
        message: "ctxpack/introspect computation completed without output data."
      });
    }

    return makeCtxpackSuccessEnvelopeV1("introspect", introspect.data);
  }

  const codes = CTXPACK_ERROR_CODES_V1.join(", ");
  return createCtxpackNotImplementedErrorV1(primitive, {
    contract: CTXPACK_CONTRACT_VERSION_V1,
    supported_error_codes: codes,
    request: parsedRequest.data,
    exit_code: CTXPACK_ERROR_EXIT_CODES_V1.capability_unavailable
  });
}
