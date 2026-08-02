import type { OperationPlan, OperationSuccessPlan } from "../../packages/client/src/transport.js";

export interface ClientContractCompilerOptions {
  readonly expectedCounts?: { readonly consumer: number; readonly admin: number } | null;
}

export interface ClientContractRender {
  readonly files: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly byteCount: number;
  readonly counts: {
    readonly consumer: number;
    readonly admin: number;
  };
}

export interface ClientBearerTokenContract {
  readonly encoding: "ascii";
  readonly max_bytes: number;
  readonly pattern: string;
}

export interface ClientContractIRSurface {
  readonly openapiDocument: Readonly<Record<string, unknown>>;
  readonly schemas: Readonly<Record<string, unknown>>;
  readonly plans: readonly ClientContractIRPlan[];
  readonly operationIds: readonly string[];
}

export type ClientContractIRSuccessPlan = Omit<OperationSuccessPlan, "decoder" | "headerDecoders"> & {
  readonly schema: unknown;
  readonly headerSchemas: Readonly<Record<string, unknown>>;
};

export type ClientContractIRPlan = Omit<
  OperationPlan,
  | "pathParameterSerializers"
  | "requestSerializer"
  | "requestIdHeaderDecoder"
  | "success"
  | "errorEnvelopeDecoder"
  | "errorDecoders"
  | "errorRequiredHeaderDecoders"
> & {
  readonly pathParameters: Readonly<Record<string, unknown>>;
  readonly requestSchema: unknown;
  readonly requestIdHeaderSchema: unknown;
  readonly success: readonly ClientContractIRSuccessPlan[];
  readonly errorEnvelopeSchema: unknown;
  readonly errorSchemas: Readonly<Record<string, unknown>>;
  readonly errorRequiredHeaderSchemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

export interface ClientContractIR {
  readonly digest: string;
  readonly byteCount: number;
  readonly bearerTokenContract: ClientBearerTokenContract;
  readonly counts: { readonly consumer: number; readonly admin: number };
  readonly surfaces: Readonly<Record<"consumer" | "admin", ClientContractIRSurface>>;
}

export function buildClientContractIR(
  sourceBytes: Uint8Array,
  options?: ClientContractCompilerOptions,
): ClientContractIR;

export function assertClientOmissionPolicy(
  sourceBytes: Uint8Array,
  asOf: string,
): void;

export function compileClientContract(
  sourceBytes: Uint8Array,
  options?: ClientContractCompilerOptions,
): Promise<ClientContractRender>;
