import type { StateDriverDatabase } from "@polli-labs/calyx-core";
import {
  acquireLock,
  appendOrchestrationEvent,
  listEventsByAggregate,
  readLock,
  releaseLock,
  upsertSourceFreshness,
  writeEventCursor,
  type AcquireLockOutcome,
  type LockHolder,
  type OrchestrationEventRow,
} from "@polli-labs/calyx-core";

/**
 * Wave 3 daemon ledger bridge. Mirrors claim/launch/terminal/handoff
 * facts into the Wave 2 orchestration ledger so daemon restart truth
 * does not depend solely on the on-disk daemon state cache.
 *
 * Lock key shape: `symphony:<daemon-id>:issue:<identifier>`.
 * Aggregate type: `calyx.symphony.issue`.
 * Aggregate id:   `<daemon-id>:<identifier>` (matches lock key suffix).
 * Source id (cursors, freshness): `daemon:<daemon-id>`.
 */

export const DAEMON_LEDGER_DOMAIN = "calyx.symphony";
export const DAEMON_LEDGER_AGGREGATE_TYPE = "calyx.symphony.issue";

export type DaemonIssueEventType =
  | "issue.claimed"
  | "issue.launched"
  | "issue.terminal"
  | "issue.handoff";

export interface DaemonLedgerEventInput {
  daemonId: string;
  issueIdentifier: string;
  issueId: string;
  eventType: DaemonIssueEventType;
  occurredAt: string;
  host?: string | undefined;
  payload: Record<string, unknown>;
}

export interface DaemonLedgerEvent {
  event_id: string;
  cursor: string;
  inserted: boolean;
}

export function daemonLockKey(daemonId: string, issueIdentifier: string): string {
  return `symphony:${daemonId}:issue:${issueIdentifier}`;
}

export function daemonAggregateId(daemonId: string, issueIdentifier: string): string {
  return `${daemonId}:${issueIdentifier}`;
}

export function daemonSourceId(daemonId: string): string {
  return `daemon:${daemonId}`;
}

/**
 * Monotonic-cursor builder. Cursors are `<iso>#<counter>` strings; counter
 * is per-aggregate and read from the existing ledger so concurrent ticks
 * on different aggregates do not collide.
 */
function buildCursor(occurredAt: string, sequence: number): string {
  return `${occurredAt}#${sequence.toString().padStart(8, "0")}`;
}

function buildEventId(daemonId: string, issueIdentifier: string, eventType: DaemonIssueEventType, cursor: string): string {
  return `${daemonId}:${issueIdentifier}:${eventType}:${cursor}`;
}

function nextCursorSequence(events: OrchestrationEventRow[]): number {
  return events.length + 1;
}

export class DaemonLedger {
  constructor(
    private readonly db: StateDriverDatabase,
    private readonly host?: string,
  ) {}

  /**
   * Record a daemon issue event with a stable, monotonic cursor.
   * Updates `event_cursors` and `source_freshness` for the daemon source.
   */
  recordEvent(input: DaemonLedgerEventInput): DaemonLedgerEvent {
    const aggregateId = daemonAggregateId(input.daemonId, input.issueIdentifier);
    const existing = listEventsByAggregate(this.db, DAEMON_LEDGER_AGGREGATE_TYPE, aggregateId, {
      limit: 100_000,
    });
    const sequence = nextCursorSequence(existing);
    const cursor = buildCursor(input.occurredAt, sequence);
    const event_id = buildEventId(input.daemonId, input.issueIdentifier, input.eventType, cursor);

    const result = appendOrchestrationEvent(this.db, {
      event_id,
      domain: DAEMON_LEDGER_DOMAIN,
      aggregate_type: DAEMON_LEDGER_AGGREGATE_TYPE,
      aggregate_id: aggregateId,
      event_type: input.eventType,
      cursor,
      occurred_at: input.occurredAt,
      ...(this.host ? { host: this.host } : {}),
      ...(input.host ? { host: input.host } : {}),
      source: daemonSourceId(input.daemonId),
      payload: input.payload,
    });

    writeEventCursor(this.db, {
      source: daemonSourceId(input.daemonId),
      domain: DAEMON_LEDGER_DOMAIN,
      cursor,
      observed_at: input.occurredAt,
      payload: {
        issue_identifier: input.issueIdentifier,
        issue_id: input.issueId,
        event_type: input.eventType,
      },
    });

    upsertSourceFreshness(this.db, {
      source_kind: "calyx.symphony.daemon",
      source_id: daemonSourceId(input.daemonId),
      status: "fresh",
      observed_at: input.occurredAt,
      cursor,
      detail: input.eventType,
      payload: {
        last_event_type: input.eventType,
        last_issue_identifier: input.issueIdentifier,
      },
    });

    return { event_id, cursor, inserted: result.inserted };
  }

  /**
   * Attempt to acquire the per-issue claim lock. The daemon must hold
   * this lock before launching a run for the issue. Restart recovery
   * uses the same key to detect prior claims it should adopt rather
   * than re-claim.
   */
  acquireClaim(input: {
    daemonId: string;
    issueIdentifier: string;
    ttlMs: number;
    metadata?: Record<string, unknown>;
    now?: () => Date;
  }): AcquireLockOutcome {
    return acquireLock(
      this.db,
      {
        lock_key: daemonLockKey(input.daemonId, input.issueIdentifier),
        owner_id: input.daemonId,
        ttl_ms: input.ttlMs,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      input.now,
    );
  }

  releaseClaim(input: { daemonId: string; issueIdentifier: string }): void {
    releaseLock(this.db, {
      lock_key: daemonLockKey(input.daemonId, input.issueIdentifier),
      owner_id: input.daemonId,
    });
  }

  readClaim(input: { daemonId: string; issueIdentifier: string }): LockHolder | undefined {
    return readLock(this.db, daemonLockKey(input.daemonId, input.issueIdentifier));
  }

  /**
   * List ledger events for an issue in cursor order. Restart recovery
   * uses this to reconstruct claim/launch/terminal/handoff state for the
   * issue before consulting the local file-store cache.
   */
  listIssueEvents(input: {
    daemonId: string;
    issueIdentifier: string;
    limit?: number;
  }): OrchestrationEventRow[] {
    return listEventsByAggregate(
      this.db,
      DAEMON_LEDGER_AGGREGATE_TYPE,
      daemonAggregateId(input.daemonId, input.issueIdentifier),
      typeof input.limit === "number" ? { limit: input.limit } : {},
    );
  }

  /**
   * Return the highest cursor written for an issue, useful for receipt
   * payloads that need the ledger cursor at handoff time.
   */
  latestCursorForIssue(input: { daemonId: string; issueIdentifier: string }): string | undefined {
    const events = this.listIssueEvents({ ...input, limit: 100_000 });
    return events.length > 0 ? events[events.length - 1]!.cursor : undefined;
  }
}
