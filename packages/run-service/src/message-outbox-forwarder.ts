import { isDeepStrictEqual } from "node:util";

import {
  checkMessageSchema,
  claimMessageOutboxAttempt,
  completeMessageDelivery,
  createMessageDeliveryAttempt,
  expireMessageOutbox,
  listPendingMessageOutbox,
  markMessageOutboxAttemptFailed,
  markMessageOutboxDeliveryFailed,
  markMessageOutboxForwarded,
  openStateStore,
  parseJsonWithoutDuplicateObjectMembers,
  projectMessageOutboxAt,
  projectCompatibleMessageReceiptSnapshot,
  readMessage,
  readMessageOutbox,
  recoverExpiredMessageOutboxAttempts,
  validateApiProvenance,
  type MessageOutboxRow,
  type MessageRow,
  type StateOpenOptions,
} from "@polli-labs/calyx-core";
import { postJsonDeliveryV1, type DeliveryV1Fetch } from "./delivery.js";

export interface MessageOutboxForwarderOptions {
  enabled?: boolean | undefined;
  intervalMs?: number | undefined;
  state?: StateOpenOptions | undefined;
  fetch?: DeliveryV1Fetch | undefined;
  serverUrlForHost: (host: string) => string | Promise<string>;
  tokenForHost: (host: string) => string | undefined | Promise<string | undefined>;
  now?: (() => string) | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface MessageOutboxDrainResult {
  expired: number;
  scanned: number;
  forwarded: number;
  failed: number;
}

export type MessageOutboxObservationResult =
  | { status: "schema_unavailable" }
  | { status: "not_found" }
  | { status: "found"; outbox: MessageOutboxRow; message: MessageRow };

export type MessageOutboxForwardResult =
  | { status: "schema_unavailable"; accepted: false }
  | { status: "not_found"; accepted: false }
  | { status: "found"; accepted: boolean; outbox: MessageOutboxRow; message: MessageRow };

const DEFAULT_INTERVAL_MS = 15_000;
const RETRY_AFTER_MS = 60_000;

function internalMessageReceiveUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("configured message target must be an absolute HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(
      "configured message target must be an HTTP(S) URL without userinfo, query, or fragment",
    );
  }
  const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = `${basePath}/v1/internal/messages/receive`;
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validObservedEscalation(value: unknown): boolean {
  return isRecord(value)
    && value["mode"] === "pointer_only"
    && value["reason"] === "execution_requires_control_plane_authority";
}

function immutableIngressIdentity(message: MessageRow, includeCreatedProvenance: boolean): object {
  const payload = { ...message.payload };
  // The receiver records sender-side delivery metadata in its local row. It
  // excludes those local observations from duplicate-ingress identity, so the
  // acknowledgement verifier must apply the same wire law.
  delete payload["receipt_mirror"];
  delete payload["remote_sender_receipt_path"];
  delete payload["remote_sender_spooled_at"];
  return {
    message_id: message.message_id,
    schema_version: message.schema_version,
    sender: message.sender,
    recipient_address: message.recipient_address,
    recipient_class: message.recipient_class,
    recipient_host: message.recipient_host,
    subject: message.subject,
    body: message.body,
    thread_key: message.thread_key,
    reply_to: message.reply_to,
    idempotency_key: message.idempotency_key,
    urgency: message.urgency,
    ack_required: message.ack_required,
    expires_at: message.expires_at,
    payload,
    ...(includeCreatedProvenance
      ? { created_provenance: validateApiProvenance(message.created_provenance!) }
      : {}),
  };
}

function messageReceiveAcknowledges(responseText: string, attempted: MessageRow): boolean {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateObjectMembers(responseText);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (parsed["schema_version"] !== "calyx.msg-receive/v1") return false;
  if (typeof parsed["inserted"] !== "boolean") return false;
  const message = projectCompatibleMessageReceiptSnapshot(parsed["message"], attempted.message_id);
  if (!message) return false;
  const acknowledged = message as unknown as MessageRow;
  // Rolling-upgrade receivers may legitimately retain null provenance for a
  // row first accepted before migration 0023. Match the receiver's own
  // ingress-identity law: every other immutable field is still exact.
  const includeCreatedProvenance = acknowledged.created_provenance !== null
    && attempted.created_provenance !== null;
  if (!isDeepStrictEqual(
    immutableIngressIdentity(acknowledged, includeCreatedProvenance),
    immutableIngressIdentity(attempted, includeCreatedProvenance),
  )) {
    return false;
  }
  // Forwarding terminalizes from the exact persisted-message identity above.
  // Escalation is an inert current-contract observation; optional same-major
  // additions are ignored and never interpreted as execution authority.
  return validObservedEscalation(parsed["escalation"]);
}

export class MessageOutboxForwarder {
  private readonly options: MessageOutboxForwarderOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(options: MessageOutboxForwarderOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer || this.options.enabled === false) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    void this.drainOnce().catch((error: unknown) => this.reportError(error));
    this.timer = setInterval(() => {
      void this.drainOnce().catch((error: unknown) => this.reportError(error));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async drainOnce(): Promise<MessageOutboxDrainResult> {
    if (this.draining) {
      return { expired: 0, scanned: 0, forwarded: 0, failed: 0 };
    }
    this.draining = true;
    try {
      const now = this.now();
      const opened = await openStateStore(this.options.state ?? {});
      try {
        const schema = checkMessageSchema(opened.db);
        if (schema.status !== "ok") {
          throw new Error("message state schema is unavailable; run calyx state migrate --apply");
        }
        recoverExpiredMessageOutboxAttempts(opened.db, { now });
        const expired = expireMessageOutbox(opened.db, { now });
        const pending = listPendingMessageOutbox(opened.db, { now, limit: 50 });
        let forwarded = 0;
        let failed = 0;
        for (const row of pending) {
          const ok = await this.forwardOne(opened.db, row);
          if (ok) forwarded += 1;
          else failed += 1;
        }
        return {
          expired: expired.length,
          scanned: pending.length,
          forwarded,
          failed,
        };
      } finally {
        opened.db.close();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Synchronously forward one already-admitted outbox row. Explicit session
   * wake uses this as its durable destination acknowledgement gate.
   */
  async forwardOutbox(outboxId: string): Promise<MessageOutboxForwardResult> {
    const opened = await openStateStore(this.options.state ?? {});
    try {
      const schema = checkMessageSchema(opened.db);
      if (schema.status !== "ok") {
        return { status: "schema_unavailable", accepted: false };
      }
      const now = this.now();
      recoverExpiredMessageOutboxAttempts(opened.db, { now, outbox_id: outboxId });
      expireMessageOutbox(opened.db, { now, outbox_id: outboxId });
      const existing = this.observeFromStore(opened.db, outboxId, now);
      if (existing.status !== "found") {
        return { ...existing, accepted: false };
      }
      if (existing.outbox.status === "forwarded") {
        return { ...existing, accepted: true };
      }
      if (existing.outbox.status !== "pending") {
        return { ...existing, accepted: false };
      }
      await this.forwardOne(opened.db, existing.outbox);
      const observed = this.observeFromStore(opened.db, outboxId, this.now());
      if (observed.status !== "found") {
        return { ...observed, accepted: false };
      }
      return { ...observed, accepted: observed.outbox.status === "forwarded" };
    } finally {
      opened.db.close();
    }
  }

  /** Observe one outbox operation from the resident forwarder's exact store. */
  async observeOutbox(outboxId: string): Promise<MessageOutboxObservationResult> {
    const opened = await openStateStore(this.options.state ?? {});
    try {
      if (checkMessageSchema(opened.db).status !== "ok") {
        return { status: "schema_unavailable" };
      }
      return this.observeFromStore(opened.db, outboxId, this.now());
    } finally {
      opened.db.close();
    }
  }

  private observeFromStore(
    db: Awaited<ReturnType<typeof openStateStore>>["db"],
    outboxId: string,
    now: string,
  ): MessageOutboxObservationResult {
    const outbox = readMessageOutbox(db, outboxId);
    if (!outbox) return { status: "not_found" };
    const message = readMessage(db, outbox.message_id);
    if (!message) return { status: "not_found" };
    return { status: "found", outbox: projectMessageOutboxAt(outbox, { now }), message };
  }

  private async forwardOne(
    db: Awaited<ReturnType<typeof openStateStore>>["db"],
    row: MessageOutboxRow,
  ): Promise<boolean> {
    const attempt = claimMessageOutboxAttempt(db, row.outbox_id, { now: this.now() });
    if (!attempt?.attempt_id) return false;
    const attemptId = attempt.attempt_id;
    const message = readMessage(db, attempt.message_id);
    if (!message) {
      markMessageOutboxDeliveryFailed(db, attempt.outbox_id, {
        attempt_id: attemptId,
        now: this.now(),
        error_code: "message_missing",
        error_message: `message ${attempt.message_id} not found`,
      });
      return false;
    }
    const deliveryAttempt = createMessageDeliveryAttempt(db, {
      message,
      binding_id: `outbox_attempt:${attemptId}`,
      adapter: "daemon_outbox",
      attempted_at: this.now(),
      target: {
        target_host: attempt.target_host,
        transport: "authenticated_internal_receive",
      },
      evidence: { outbox_id: attempt.outbox_id, attempt_id: attemptId },
    });
    const failDelivery = (errorCode: string): void => {
      completeMessageDelivery(db, {
        delivery_id: deliveryAttempt.delivery.delivery_id,
        status: "failed",
        completed_at: this.now(),
        error_code: errorCode,
        error_message: "Destination durable admission was not acknowledged.",
        evidence: {
          outbox_id: attempt.outbox_id,
          attempt_id: attemptId,
          target_host: attempt.target_host,
        },
      });
    };
    try {
      const token = await this.options.tokenForHost(attempt.target_host);
      if (!token) {
        markMessageOutboxAttemptFailed(db, attempt.outbox_id, {
          attempt_id: attemptId,
          outcome: "not_accepted",
          now: this.now(),
          retry_after_ms: RETRY_AFTER_MS,
          error_code: "auth_token_missing",
          error_message: `no run-serve token configured for ${attempt.target_host}`,
        });
        failDelivery("auth_token_missing");
        return false;
      }
      // The configured host map is the sole transport authority. A durable row
      // may survive older code or be corrupt; it must never redirect a bearer.
      // The configured base path is part of that authority: private ingress
      // extends it rather than rebasing to the origin root.
      const baseUrl = await this.options.serverUrlForHost(attempt.target_host);
      const url = internalMessageReceiveUrl(baseUrl);
      const response = await postJsonDeliveryV1(this.options.fetch ?? defaultDeliveryFetch, url, {
        timeoutMs: 10_000,
        headers: {
          authorization: `Bearer ${token}`,
        },
        body: {
          schema_version: "calyx.msg-send/v1",
          message: {
            ...message,
            status: "pending",
          },
        },
      });
      if (!response.ok) {
        markMessageOutboxAttemptFailed(db, attempt.outbox_id, {
          attempt_id: attemptId,
          outcome: response.status >= 400 && response.status < 500
            ? "not_accepted"
            : "unknown",
          now: this.now(),
          retry_after_ms: RETRY_AFTER_MS,
          error_code: `http_${response.status}`,
          error_message: response.response_text.slice(0, 500),
        });
        failDelivery(`http_${response.status}`);
        return false;
      }
      if (!messageReceiveAcknowledges(response.response_text, message)) {
        markMessageOutboxAttemptFailed(db, attempt.outbox_id, {
          attempt_id: attemptId,
          outcome: "unknown",
          now: this.now(),
          retry_after_ms: RETRY_AFTER_MS,
          error_code: "invalid_target_acknowledgement",
          error_message: "target returned 2xx without a matching calyx.msg-receive/v1 acknowledgement",
        });
        failDelivery("invalid_target_acknowledgement");
        return false;
      }
      markMessageOutboxForwarded(db, attempt.outbox_id, {
        attempt_id: attemptId,
        now: this.now(),
      });
      completeMessageDelivery(db, {
        delivery_id: deliveryAttempt.delivery.delivery_id,
        status: "delivered",
        completed_at: this.now(),
        target: {
          target_host: attempt.target_host,
          transport: "authenticated_internal_receive",
        },
        evidence: {
          outbox_id: attempt.outbox_id,
          attempt_id: attemptId,
          acknowledgement_schema_version: "calyx.msg-receive/v1",
        },
      });
      return true;
    } catch (error) {
      markMessageOutboxAttemptFailed(db, attempt.outbox_id, {
        attempt_id: attemptId,
        outcome: "unknown",
        now: this.now(),
        retry_after_ms: RETRY_AFTER_MS,
        error_code: "daemon_unreachable",
        error_message: error instanceof Error ? error.message : String(error),
      });
      failDelivery("daemon_unreachable");
      return false;
    }
  }

  private reportError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(err);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

const defaultDeliveryFetch: DeliveryV1Fetch = async (url, init) => {
  return fetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body ? { body: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.redirect ? { redirect: init.redirect } : {}),
  });
};
