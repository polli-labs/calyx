import { z } from "zod";
import type {
  CtxpackContractVersion,
  CtxpackErrorCodeV1,
  CtxpackErrorEnvelopeV1,
  CtxpackPrimitiveV1
} from "../types";

export const CTXPACK_ERROR_CODES_V1 = [
  "validation_error",
  "not_found",
  "capability_unavailable",
  "adapter_error",
  "internal_error"
] as const satisfies readonly CtxpackErrorCodeV1[];

export const CTXPACK_ERROR_EXIT_CODES_V1: Readonly<Record<CtxpackErrorCodeV1, number>> = {
  validation_error: 2,
  not_found: 3,
  capability_unavailable: 4,
  adapter_error: 5,
  internal_error: 10
};

export const ctxpackErrorCodeSchemaV1 = z.enum(CTXPACK_ERROR_CODES_V1);

export const ctxpackErrorEnvelopeSchemaV1 = z.object({
  version: z.literal("v1"),
  ok: z.literal(false),
  primitive: z.string().min(1).optional(),
  error: z.object({
    code: ctxpackErrorCodeSchemaV1,
    exit_code: z.number().int().nonnegative(),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional()
  })
}).strict();

export interface CreateCtxpackErrorOptionsV1 {
  code: CtxpackErrorCodeV1;
  message: string;
  details?: Record<string, unknown>;
  primitive?: CtxpackPrimitiveV1;
  version?: CtxpackContractVersion;
}

export function ctxpackExitCodeForErrorV1(code: CtxpackErrorCodeV1): number {
  return CTXPACK_ERROR_EXIT_CODES_V1[code];
}

export function createCtxpackErrorEnvelopeV1(options: CreateCtxpackErrorOptionsV1): CtxpackErrorEnvelopeV1 {
  const exitCode = ctxpackExitCodeForErrorV1(options.code);

  return {
    version: options.version ?? "v1",
    ok: false,
    ...(options.primitive ? { primitive: options.primitive } : {}),
    error: {
      code: options.code,
      exit_code: exitCode,
      message: options.message,
      ...(options.details ? { details: options.details } : {})
    }
  };
}

export function createCtxpackNotImplementedErrorV1(
  primitive: CtxpackPrimitiveV1,
  details?: Record<string, unknown>
): CtxpackErrorEnvelopeV1 {
  return createCtxpackErrorEnvelopeV1({
    code: "capability_unavailable",
    primitive,
    message: `ctxpack/${primitive} is frozen in contract v1 and not implemented in this lane.`,
    ...(details ? { details } : {})
  });
}

export function isCtxpackErrorEnvelopeV1(value: unknown): value is CtxpackErrorEnvelopeV1 {
  return ctxpackErrorEnvelopeSchemaV1.safeParse(value).success;
}
