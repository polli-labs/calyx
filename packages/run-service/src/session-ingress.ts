import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import {
  SESSION_WAKE_ENVELOPE_SCHEMA_VERSION,
  attachSessionWakeDeliveryBinding,
  completeMessageDelivery,
  completeSessionWakeDelivery,
  createMessageDeliveryAttempt,
  createSessionWakeDeliveryAttempt,
  openStateStore,
  readMessage,
  resolveSessionIngressBinding,
  type SessionIngressBindingRow,
  type SessionWakeDeliveryRow,
  type SessionWakeEnvelopeV1,
  type SessionWakePointerKind,
  type StateDriverDatabase,
  type StateOpenOptions,
} from "@polli-labs/calyx-core";

export const SESSION_WAKE_RESULT_SCHEMA_VERSION = "calyx.session-wake-result/v1";
export const SESSION_WAKE_DELIVER_REQUEST_SCHEMA_VERSION = "calyx.session-wake-deliver-request/v1";
export const SESSION_WAKE_RECEIPT_SCHEMA_VERSION = "calyx.session-wake-receipt/v1";
export const DEFAULT_SESSION_INGRESS_RUNTIME_DIR = join(homedir(), ".calyx", "runtime", "session-ingress");
const MAX_SESSION_WAKE_BYTES = 32 * 1024;
const DEFAULT_SESSION_WAKE_TIMEOUT_MS = 2_000;

class SessionIngressBindingFenceError extends Error {}

class SessionWakeTransportRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface SessionWakeTransportReceipt {
  schema_version: typeof SESSION_WAKE_RECEIPT_SCHEMA_VERSION;
  delivery_id: string;
  accepted: boolean;
  accepted_at: string;
  error_code?: string | undefined;
  error_message?: string | undefined;
}

export interface SessionWakeTransportResult {
  target: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

export interface SessionWakeRouteDependencies {
  now?: (() => string) | undefined;
  runtimeDir?: string | undefined;
  timeoutMs?: number | undefined;
  deliver?: ((binding: SessionIngressBindingRow, envelope: SessionWakeEnvelopeV1) => Promise<SessionWakeTransportResult>) | undefined;
}

export type SessionWakeState =
  | "wake_delivered"
  | "pointer_unavailable"
  | "binding_unavailable"
  | "binding_expired"
  | "binding_replaced"
  | "unsupported_pointer"
  | "unsupported_adapter"
  | "delivery_indeterminate"
  | "adapter_failure";

export interface SessionWakeDeliverRequestV1 {
  schema_version: typeof SESSION_WAKE_DELIVER_REQUEST_SCHEMA_VERSION;
  delivery_id: string;
  recipient_activity_id: string;
  pointer: { kind: SessionWakePointerKind; id: string };
  created_at: string;
}

export interface SessionWakeDeliveryObservation {
  delivery_id: string;
  status: SessionWakeDeliveryRow["status"];
  attempted_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface SessionWakeRouteResult {
  schema_version: typeof SESSION_WAKE_RESULT_SCHEMA_VERSION;
  delivery_state: "spooled";
  wake_state: SessionWakeState;
  recipient_activity_id: string;
  pointer: { kind: SessionWakePointerKind; id: string };
  delivery: SessionWakeDeliveryObservation;
  first_command: string;
}

export async function routeSessionWake(
  db: StateDriverDatabase,
  input: {
    recipient_activity_id: string;
    pointer_kind: SessionWakePointerKind;
    pointer_id: string;
    created_at?: string | undefined;
  },
  deps: SessionWakeRouteDependencies = {},
): Promise<SessionWakeRouteResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const attemptedAt = input.created_at ?? now();
  const attempt = createSessionWakeDeliveryAttempt(db, {
    pointer_kind: input.pointer_kind,
    pointer_id: input.pointer_id,
    activity_id: input.recipient_activity_id,
    attempted_at: attemptedAt,
  });
  if (!attempt.inserted) {
    return resultForPersistedDelivery(attempt.delivery);
  }

  const resolution = resolveSessionIngressBinding(db, input.recipient_activity_id, { now: now() });
  if (resolution.state !== "available") {
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attempt.delivery.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: resolution.state,
      error_message: resolution.state === "binding_expired"
        ? "The exact activity ingress lease expired before delivery."
        : "The exact activity has no live ingress binding.",
      evidence: { resolution: resolution.state },
    }) ?? attempt.delivery;
    return buildResult(delivery, resolution.state);
  }

  const binding = resolution.binding;
  if (!binding.capabilities.includes(input.pointer_kind)) {
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attempt.delivery.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: "unsupported_pointer",
      error_message: `Binding ${binding.binding_id} does not accept ${input.pointer_kind} pointers.`,
      evidence: { binding_id: binding.binding_id, capabilities: binding.capabilities },
    }) ?? attempt.delivery;
    return buildResult(delivery, "unsupported_pointer");
  }

  const message = input.pointer_kind === "message" ? readMessage(db, input.pointer_id) : undefined;
  if (input.pointer_kind === "message" && !message) {
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attempt.delivery.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: "pointer_unavailable",
      error_message: "The message pointer is not present in the destination durable inbox.",
      evidence: { pointer_kind: input.pointer_kind },
    }) ?? attempt.delivery;
    return buildResult(delivery, "pointer_unavailable");
  }

  const safeTarget = {
    adapter: binding.adapter,
    endpoint_ref: binding.endpoint_ref,
    destination_host: binding.destination_host,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
  };
  const attached = attachSessionWakeDeliveryBinding(
    db,
    attempt.delivery.delivery_id,
    binding,
    safeTarget,
  ) ?? attempt.delivery;
  if (binding.adapter !== "unix_socket") {
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attached.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: "unsupported_adapter",
      error_message: `Session ingress adapter ${String(binding.adapter)} is not supported.`,
      evidence: { adapter: binding.adapter },
    }) ?? attached;
    return buildResult(delivery, "unsupported_adapter");
  }

  const current = resolveSessionIngressBinding(db, input.recipient_activity_id, { now: now() });
  if (
    current.state !== "available"
    || current.binding.binding_id !== binding.binding_id
    || current.binding.generation !== binding.generation
  ) {
    const wakeState: SessionWakeState = current.state === "binding_expired"
      ? "binding_expired"
      : "binding_replaced";
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attached.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: wakeState,
      error_message: wakeState === "binding_expired"
        ? "The exact activity ingress lease expired before delivery."
        : "The exact activity ingress binding changed before delivery.",
      evidence: {
        selected_binding_id: binding.binding_id,
        selected_generation: binding.generation,
      },
    }) ?? attached;
    return buildResult(delivery, wakeState);
  }

  const messageDeliveryAttempt = message
    ? createMessageDeliveryAttempt(db, {
        message,
        binding_id: binding.binding_id,
        adapter: "session_ingress",
        attempted_at: attemptedAt,
        target: safeTarget,
        evidence: { session_wake_delivery_id: attached.delivery_id },
      })
    : undefined;

  const envelope: SessionWakeEnvelopeV1 = {
    schema_version: SESSION_WAKE_ENVELOPE_SCHEMA_VERSION,
    delivery_id: attached.delivery_id,
    recipient_activity_id: input.recipient_activity_id,
    binding: {
      binding_id: binding.binding_id,
      generation: binding.generation,
    },
    pointer: { kind: input.pointer_kind, id: input.pointer_id },
    first_command: firstCommand(input.pointer_kind, input.recipient_activity_id),
    created_at: attemptedAt,
  };
  const deliver = deps.deliver ?? ((selectedBinding, selectedEnvelope) =>
    deliverSessionWakeViaPrivateIpc(selectedBinding, selectedEnvelope, {
      runtimeDir: deps.runtimeDir,
      timeoutMs: deps.timeoutMs,
    }));
  try {
    const transport = await deliver(binding, envelope);
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attached.delivery_id,
      status: "delivered",
      completed_at: now(),
      target: { ...safeTarget, ...transport.target },
      evidence: {
        envelope: {
          schema_version: envelope.schema_version,
          delivery_id: envelope.delivery_id,
          recipient_activity_id: envelope.recipient_activity_id,
          pointer: envelope.pointer,
          first_command: envelope.first_command,
          created_at: envelope.created_at,
        },
        transport: transport.evidence,
      },
    }) ?? attached;
    if (messageDeliveryAttempt) {
      completeMessageDelivery(db, {
        delivery_id: messageDeliveryAttempt.delivery.delivery_id,
        status: "delivered",
        completed_at: delivery.delivered_at ?? now(),
        target: { ...safeTarget, ...transport.target },
        evidence: {
          session_wake_delivery_id: delivery.delivery_id,
          transport: transport.evidence,
        },
      });
    }
    return buildResult(delivery, "wake_delivered");
  } catch (error) {
    const wakeState: SessionWakeState = error instanceof SessionWakeTransportRejectedError
      && error.code === "binding_replaced"
      ? "binding_replaced"
      : "adapter_failure";
    const delivery = completeSessionWakeDelivery(db, {
      delivery_id: attached.delivery_id,
      status: "failed",
      completed_at: now(),
      error_code: wakeState,
      error_message: errorMessage(error),
      evidence: {
        adapter: binding.adapter,
        endpoint_ref: binding.endpoint_ref,
        pointer: envelope.pointer,
      },
    }) ?? attached;
    if (messageDeliveryAttempt) {
      completeMessageDelivery(db, {
        delivery_id: messageDeliveryAttempt.delivery.delivery_id,
        status: "failed",
        completed_at: delivery.failed_at ?? now(),
        target: safeTarget,
        evidence: { session_wake_delivery_id: delivery.delivery_id },
        error_code: wakeState,
        error_message: "Session ingress transport failed.",
      });
    }
    return buildResult(delivery, wakeState);
  }
}

export interface SessionIngressReceiverHandle {
  endpoint_ref: string;
  close(): Promise<void>;
}

export async function startSessionIngressReceiver(options: {
  endpoint_ref: string;
  generation: string;
  state?: StateOpenOptions | undefined;
  runtimeDir?: string | undefined;
  now?: (() => string) | undefined;
  onWake: (envelope: SessionWakeEnvelopeV1) => Promise<void> | void;
}): Promise<SessionIngressReceiverHandle> {
  const runtimeDir = options.runtimeDir ?? DEFAULT_SESSION_INGRESS_RUNTIME_DIR;
  const endpointRef = normalizeEndpointRef(options.endpoint_ref);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  const socketPath = privateSocketPath(runtimeDir, endpointRef);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    void handleReceiverSocket(
      socket,
      options.onWake,
      options.now ?? (() => new Date().toISOString()),
      {
        endpoint_ref: endpointRef,
        generation: normalizeIngressIdentity("generation", options.generation),
        ...(options.state ? { state: options.state } : {}),
      },
    );
  });
  await listenOnSocket(server, socketPath);
  await chmod(socketPath, 0o600);
  return {
    endpoint_ref: endpointRef,
    async close() {
      await closeServer(server);
      await rm(socketPath, { force: true });
    },
  };
}

export async function deliverSessionWakeViaPrivateIpc(
  binding: SessionIngressBindingRow,
  envelope: SessionWakeEnvelopeV1,
  options: { runtimeDir?: string | undefined; timeoutMs?: number | undefined } = {},
): Promise<SessionWakeTransportResult> {
  const runtimeDir = options.runtimeDir ?? DEFAULT_SESSION_INGRESS_RUNTIME_DIR;
  const endpointRef = normalizeEndpointRef(binding.endpoint_ref);
  const receipt = await requestPrivateSocket(
    privateSocketPath(runtimeDir, endpointRef),
    envelope,
    options.timeoutMs ?? DEFAULT_SESSION_WAKE_TIMEOUT_MS,
  );
  if (!receipt.accepted) {
    throw new SessionWakeTransportRejectedError(receipt.error_code ?? "receiver_rejected");
  }
  if (receipt.delivery_id !== envelope.delivery_id) {
    throw new Error("session ingress receiver returned a mismatched delivery id");
  }
  return {
    target: { adapter: "unix_socket", endpoint_ref: endpointRef },
    evidence: {
      receipt_schema_version: receipt.schema_version,
      delivery_id: receipt.delivery_id,
      accepted: receipt.accepted,
      accepted_at: receipt.accepted_at,
      transport: "daemon_local_private_ipc",
    },
  };
}

function resultForPersistedDelivery(delivery: SessionWakeDeliveryRow): SessionWakeRouteResult {
  if (delivery.status === "delivered") return buildResult(delivery, "wake_delivered");
  if (delivery.status === "attempted") return buildResult(delivery, "delivery_indeterminate");
  const code = delivery.error_code;
  if (
    code === "binding_unavailable"
    || code === "binding_expired"
    || code === "binding_replaced"
    || code === "pointer_unavailable"
    || code === "unsupported_pointer"
    || code === "unsupported_adapter"
    || code === "adapter_failure"
  ) {
    return buildResult(delivery, code);
  }
  return buildResult(delivery, "adapter_failure");
}

function buildResult(delivery: SessionWakeDeliveryRow, wakeState: SessionWakeState): SessionWakeRouteResult {
  return {
    schema_version: SESSION_WAKE_RESULT_SCHEMA_VERSION,
    delivery_state: "spooled",
    wake_state: wakeState,
    recipient_activity_id: delivery.activity_id,
    pointer: { kind: delivery.pointer_kind, id: delivery.pointer_id },
    delivery: {
      delivery_id: delivery.delivery_id,
      status: delivery.status,
      attempted_at: delivery.attempted_at,
      delivered_at: delivery.delivered_at,
      failed_at: delivery.failed_at,
      error_code: delivery.error_code,
      error_message: publicDeliveryErrorMessage(delivery.error_code),
    },
    first_command: firstCommand(delivery.pointer_kind, delivery.activity_id),
  };
}

function firstCommand(kind: SessionWakePointerKind, activityId: string): string {
  return kind === "message"
    ? `calyx msg inbox --for ${activityId} --json`
    : "calyx monitor inbox --json";
}

async function handleReceiverSocket(
  socket: Socket,
  onWake: (envelope: SessionWakeEnvelopeV1) => Promise<void> | void,
  now: () => string,
  binding: {
    endpoint_ref: string;
    generation: string;
    state?: StateOpenOptions | undefined;
  },
): Promise<void> {
  let deliveryId = "unknown";
  try {
    const text = await readSocketText(socket, MAX_SESSION_WAKE_BYTES);
    const envelope = parseSessionWakeEnvelope(text);
    deliveryId = envelope.delivery_id;
    if (envelope.binding.generation !== binding.generation) {
      throw new SessionIngressBindingFenceError("session ingress generation is stale");
    }
    const opened = await openStateStore(binding.state ?? {});
    try {
      opened.db.exec("BEGIN IMMEDIATE");
      try {
        const current = resolveSessionIngressBinding(opened.db, envelope.recipient_activity_id, { now: now() });
        if (
          current.state !== "available"
          || current.binding.binding_id !== envelope.binding.binding_id
          || current.binding.generation !== envelope.binding.generation
          || current.binding.endpoint_ref !== binding.endpoint_ref
        ) {
          throw new SessionIngressBindingFenceError("session ingress binding is no longer current");
        }
        await onWake(envelope);
        opened.db.exec("COMMIT");
      } catch (error) {
        try {
          opened.db.exec("ROLLBACK");
        } catch {
          // Preserve the binding-fence failure.
        }
        throw error;
      }
    } finally {
      opened.db.close();
    }
    const receipt: SessionWakeTransportReceipt = {
      schema_version: SESSION_WAKE_RECEIPT_SCHEMA_VERSION,
      delivery_id: envelope.delivery_id,
      accepted: true,
      accepted_at: now(),
    };
    socket.end(JSON.stringify(receipt));
  } catch (error) {
    const receipt: SessionWakeTransportReceipt = {
      schema_version: SESSION_WAKE_RECEIPT_SCHEMA_VERSION,
      delivery_id: deliveryId,
      accepted: false,
      accepted_at: now(),
      error_code: error instanceof SessionIngressBindingFenceError ? "binding_replaced" : "invalid_wake",
      error_message: "Session wake was rejected by the current-binding fence.",
    };
    socket.end(JSON.stringify(receipt));
  }
}

function parseSessionWakeEnvelope(text: string): SessionWakeEnvelopeV1 {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("wake envelope must be an object");
  const row = value as Record<string, unknown>;
  const pointer = row["pointer"];
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) throw new Error("wake pointer must be an object");
  const pointerRow = pointer as Record<string, unknown>;
  const binding = row["binding"];
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("wake binding must be an object");
  const bindingRow = binding as Record<string, unknown>;
  if (row["schema_version"] !== SESSION_WAKE_ENVELOPE_SCHEMA_VERSION) throw new Error("unsupported wake envelope schema");
  if (pointerRow["kind"] !== "message" && pointerRow["kind"] !== "monitor_wake") throw new Error("unsupported wake pointer kind");
  for (const [label, field] of [
    ["delivery_id", row["delivery_id"]],
    ["recipient_activity_id", row["recipient_activity_id"]],
    ["binding.binding_id", bindingRow["binding_id"]],
    ["binding.generation", bindingRow["generation"]],
    ["pointer.id", pointerRow["id"]],
    ["first_command", row["first_command"]],
    ["created_at", row["created_at"]],
  ] as const) {
    if (typeof field !== "string" || !field.trim()) throw new Error(`${label} is required`);
  }
  return {
    schema_version: SESSION_WAKE_ENVELOPE_SCHEMA_VERSION,
    delivery_id: row["delivery_id"] as string,
    recipient_activity_id: row["recipient_activity_id"] as string,
    binding: {
      binding_id: bindingRow["binding_id"] as string,
      generation: bindingRow["generation"] as string,
    },
    pointer: {
      kind: pointerRow["kind"] as SessionWakePointerKind,
      id: pointerRow["id"] as string,
    },
    first_command: row["first_command"] as string,
    created_at: row["created_at"] as string,
  };
}

function requestPrivateSocket(
  socketPath: string,
  envelope: SessionWakeEnvelopeV1,
  timeoutMs: number,
): Promise<SessionWakeTransportReceipt> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.end(JSON.stringify(envelope)));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("timeout", () => socket.destroy(new Error("session ingress receiver timed out")));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SessionWakeTransportReceipt;
        if (value.schema_version !== SESSION_WAKE_RECEIPT_SCHEMA_VERSION) {
          throw new Error("session ingress receiver returned an unsupported receipt");
        }
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readSocketText(socket: Socket, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        socket.destroy();
        reject(new Error("wake envelope exceeds the private IPC size limit"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function privateSocketPath(runtimeDir: string, endpointRef: string): string {
  const normalized = normalizeEndpointRef(endpointRef);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return join(runtimeDir, `i-${digest}.sock`);
}

function normalizeEndpointRef(value: string): string {
  const normalized = value.trim();
  if (!/^ingress_endpoint_[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error("session ingress endpoint_ref is invalid");
  }
  return normalized;
}

function normalizeIngressIdentity(label: string, value: string): string {
  const normalized = value.trim();
  if (!/^ingress_(?:binding|generation)_[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error(`session ingress ${label} is invalid`);
  }
  return normalized;
}

function publicDeliveryErrorMessage(errorCode: string | null): string | null {
  switch (errorCode) {
    case null:
      return null;
    case "pointer_unavailable":
      return "The message pointer is not present in the destination durable inbox.";
    case "binding_unavailable":
      return "The exact activity has no live ingress binding.";
    case "binding_expired":
      return "The exact activity ingress lease expired before delivery.";
    case "binding_replaced":
      return "The exact activity ingress binding changed before delivery.";
    case "unsupported_pointer":
      return "The current ingress binding does not accept this pointer kind.";
    case "unsupported_adapter":
      return "The current ingress adapter is unsupported.";
    default:
      return "Session ingress transport failed; the durable pointer remains available.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
