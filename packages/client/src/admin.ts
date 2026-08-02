import type { CalyxIndeterminateReceipt, CalyxResult } from "./errors.js";
import { BEARER_TOKEN_CONTRACT as ADMIN_BEARER_TOKEN_CONTRACT } from "./generated/admin/digest.js";
import { createAdminOperations } from "./generated/admin/operations.js";
import type { AdminClient } from "./generated/admin/operations.js";
import { operationPlans as adminOperationPlans } from "./generated/admin/serializers.js";
import { createConsumerOperations } from "./generated/consumer/operations.js";
import type { ConsumerClient } from "./generated/consumer/operations.js";
import { CalyxTransport } from "./transport.js";
import type { CalyxClientOptions, CalyxReplayOptions } from "./transport.js";

export interface CalyxAdminClient {
  readonly consumer: ConsumerClient;
  readonly admin: AdminClient;
  replayIndeterminate(
    receipt: CalyxIndeterminateReceipt,
    options?: CalyxReplayOptions,
  ): Promise<CalyxResult<unknown, string>>;
}

/** Creates the explicit privileged client with consumer and admin surfaces. */
export function createCalyxAdminClient(options: CalyxClientOptions): CalyxAdminClient {
  const transport = new CalyxTransport(
    options,
    adminOperationPlans,
    ADMIN_BEARER_TOKEN_CONTRACT,
  );
  return {
    consumer: createConsumerOperations(transport),
    admin: createAdminOperations(transport),
    replayIndeterminate: (receipt, replayOptions) => transport.replay(receipt, replayOptions) as Promise<CalyxResult<unknown, string>>,
  };
}

export type { AdminClient } from "./generated/admin/operations.js";
export { adminOperationRoutes } from "./generated/admin/operations.js";
export type { AdminOperationRoutes } from "./generated/admin/operations.js";
export type { ConsumerClient } from "./generated/consumer/operations.js";
export type {
  CalyxApiFailure,
  CalyxErrorBody,
  CalyxErrorEnvelope,
  CalyxIndeterminateFailure,
  CalyxIndeterminateReceipt,
  CalyxProtocolFailure,
  CalyxResult,
  CalyxSuccess,
  CalyxTransportFailure,
  CalyxUnkeyedIndeterminateFailure,
  CalyxUnknownEnumValue,
} from "./errors.js";
export type { CalyxEventStream } from "./sse.js";
export { CalyxSseProtocolError } from "./sse.js";
export type {
  CalyxBinaryMetadata,
  CalyxBinaryResponse,
  CalyxClientOptions,
  CalyxRecoveryStore,
  CalyxReplayOptions,
} from "./transport.js";
export { bufferVerifiedBinary } from "./transport.js";
export { CalyxClientConfigurationError } from "./errors.js";
