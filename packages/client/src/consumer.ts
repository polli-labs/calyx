import type { CalyxIndeterminateReceipt, CalyxResult } from "./errors.js";
import { BEARER_TOKEN_CONTRACT } from "./generated/consumer/digest.js";
import { createConsumerOperations } from "./generated/consumer/operations.js";
import type { ConsumerClient } from "./generated/consumer/operations.js";
import { operationPlans } from "./generated/consumer/serializers.js";
import { CalyxTransport } from "./transport.js";
import type { CalyxClientOptions, CalyxReplayOptions } from "./transport.js";

export interface CalyxClient {
  readonly consumer: ConsumerClient;
  replayIndeterminate(
    receipt: CalyxIndeterminateReceipt,
    options?: CalyxReplayOptions,
  ): Promise<CalyxResult<unknown, string>>;
}

/** Creates the capability-separated consumer-only Calyx client. */
export function createCalyxClient(options: CalyxClientOptions): CalyxClient {
  const transport = new CalyxTransport(
    options,
    operationPlans,
    BEARER_TOKEN_CONTRACT,
  );
  return {
    consumer: createConsumerOperations(transport),
    replayIndeterminate: (receipt, replayOptions) => transport.replay(receipt, replayOptions) as Promise<CalyxResult<unknown, string>>,
  };
}

export type { ConsumerClient } from "./generated/consumer/operations.js";
export { consumerOperationRoutes } from "./generated/consumer/operations.js";
export type { ConsumerOperationRoutes } from "./generated/consumer/operations.js";
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
export type { CalyxClientOptions, CalyxRecoveryStore, CalyxReplayOptions } from "./transport.js";
export { CalyxClientConfigurationError } from "./errors.js";
