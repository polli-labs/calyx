import { createHash } from "node:crypto";

import type { RunTerminalEvent } from "./types.js";

export type InfraErrorCensusAuthorityAmbiguityCode =
  | "branch_ambiguity"
  | "cross_run_supersession"
  | "cycle"
  | "duplicate_event_id"
  | "duplicate_incarnation_root"
  | "incarnation_identity_conflict"
  | "missing_parent";

export interface InfraErrorCensusAuthorityAmbiguity {
  code: InfraErrorCensusAuthorityAmbiguityCode;
  /** Event identity locators only; terminal payload content is never included. */
  event_ids: string[];
}

export interface InfraErrorCensusLegacyRootAudit {
  root_event_id: string;
  leaf_event_ids: string[];
  event_count: number;
}

export interface InfraErrorCensusAuthorityAudit {
  schema_version: "calyx.infra-error-census-authority-audit/v1";
  authority_source: "sqlite" | "legacy_jsonl";
  authoritative: boolean;
  terminal_event_count: number;
  legacy_event_count: number;
  uuid_incarnation_count: number;
  legacy_root_count: number;
  ambiguity_count: number;
  legacy_roots: InfraErrorCensusLegacyRootAudit[];
  ambiguities: InfraErrorCensusAuthorityAmbiguity[];
  truncated: boolean;
}

export interface InfraErrorCensusProjectionLeaf {
  projection_key: string;
  event: RunTerminalEvent;
}

export interface InfraErrorCensusAuthorityProjection {
  audit: InfraErrorCensusAuthorityAudit;
  leaves: InfraErrorCensusProjectionLeaf[];
}

export class InfraErrorCensusAuthorityError extends Error {
  readonly code: InfraErrorCensusAuthorityAmbiguityCode;
  readonly audit: InfraErrorCensusAuthorityAudit;

  constructor(audit: InfraErrorCensusAuthorityAudit) {
    const first = audit.ambiguities[0];
    const code = first?.code ?? "missing_parent";
    const locators = first?.event_ids.join(",") ?? "unknown";
    super(
      `Infra-error census authority is malformed (${code}: ${locators}); `
      + "run `calyx run audit-terminal-authority --json` before deployment.",
    );
    this.name = "InfraErrorCensusAuthorityError";
    this.code = code;
    this.audit = audit;
  }
}

const AUDIT_ENTRY_LIMIT = 1_024;
const AUDIT_LOCATOR_LIMIT = 1_024;
const AUDIT_LOCATOR_BYTES_LIMIT = 64 * 1_024;
const AUDIT_SINGLE_LOCATOR_BYTES_LIMIT = 256;

function ambiguityKey(ambiguity: InfraErrorCensusAuthorityAmbiguity): string {
  return `${ambiguity.code}\0${ambiguity.event_ids.join("\0")}`;
}

function sortedEventIds(eventIds: Iterable<string>): string[] {
  return [...eventIds].sort((left, right) => left.localeCompare(right));
}

function projectionKeyForIncarnation(event: RunTerminalEvent): string {
  return JSON.stringify(["incarnation", event.run.run_id, event.run.incarnation_id]);
}

function boundAuditLocators(
  legacyRoots: readonly InfraErrorCensusLegacyRootAudit[],
  ambiguities: readonly InfraErrorCensusAuthorityAmbiguity[],
): {
  legacyRoots: InfraErrorCensusLegacyRootAudit[];
  ambiguities: InfraErrorCensusAuthorityAmbiguity[];
  truncated: boolean;
} {
  let remainingLocators = AUDIT_LOCATOR_LIMIT;
  let remainingBytes = AUDIT_LOCATOR_BYTES_LIMIT;
  let truncated = false;
  const takeLocator = (eventId: string): string | undefined => {
    const rawBytes = Buffer.byteLength(eventId, "utf8");
    const locator = rawBytes <= AUDIT_SINGLE_LOCATOR_BYTES_LIMIT
      ? eventId
      : `sha256:${createHash("sha256").update(eventId).digest("hex")}`;
    if (rawBytes > AUDIT_SINGLE_LOCATOR_BYTES_LIMIT) truncated = true;
    const locatorBytes = Buffer.byteLength(locator, "utf8");
    if (remainingLocators === 0 || locatorBytes > remainingBytes) {
      truncated = true;
      return undefined;
    }
    remainingLocators -= 1;
    remainingBytes -= locatorBytes;
    return locator;
  };

  // Deployment-blocking ambiguity locators take precedence over the
  // informational legacy-root inventory when sharing the global budget.
  const boundedAmbiguities: InfraErrorCensusAuthorityAmbiguity[] = [];
  for (const ambiguity of ambiguities) {
    if (boundedAmbiguities.length === AUDIT_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const eventIds: string[] = [];
    for (const eventId of ambiguity.event_ids) {
      const locator = takeLocator(eventId);
      if (locator === undefined) break;
      eventIds.push(locator);
    }
    if (eventIds.length < ambiguity.event_ids.length) truncated = true;
    boundedAmbiguities.push({ code: ambiguity.code, event_ids: eventIds });
  }
  if (boundedAmbiguities.length < ambiguities.length) truncated = true;

  const boundedLegacyRoots: InfraErrorCensusLegacyRootAudit[] = [];
  for (const root of legacyRoots) {
    if (boundedLegacyRoots.length === AUDIT_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const rootEventId = takeLocator(root.root_event_id);
    if (rootEventId === undefined) {
      truncated = true;
      break;
    }
    const leafEventIds: string[] = [];
    for (const eventId of root.leaf_event_ids) {
      const locator = takeLocator(eventId);
      if (locator === undefined) break;
      leafEventIds.push(locator);
    }
    if (leafEventIds.length < root.leaf_event_ids.length) truncated = true;
    boundedLegacyRoots.push({
      root_event_id: rootEventId,
      leaf_event_ids: leafEventIds,
      event_count: root.event_count,
    });
  }
  if (boundedLegacyRoots.length < legacyRoots.length) truncated = true;

  return {
    legacyRoots: boundedLegacyRoots,
    ambiguities: boundedAmbiguities,
    truncated,
  };
}

/**
 * Validate and project the immutable terminal supersession graph without
 * exposing terminal summaries, classifications, prompts, or other payload.
 *
 * A chain containing any pre-POL-2009 event is a legacy chain and is keyed by
 * its immutable root event id. A fully current chain is keyed by its durable
 * `(run_id, incarnation_id)` claim. Only the unique leaf of each valid chain
 * contributes to the current census.
 */
export function projectInfraErrorCensusAuthority(
  events: readonly RunTerminalEvent[],
  authoritySource: InfraErrorCensusAuthorityAudit["authority_source"] = "sqlite",
): InfraErrorCensusAuthorityProjection {
  const eventsById = new Map<string, RunTerminalEvent>();
  const ambiguitiesByKey = new Map<string, InfraErrorCensusAuthorityAmbiguity>();
  const addAmbiguity = (
    code: InfraErrorCensusAuthorityAmbiguityCode,
    eventIds: Iterable<string>,
  ): void => {
    const ambiguity = { code, event_ids: sortedEventIds(eventIds) };
    ambiguitiesByKey.set(ambiguityKey(ambiguity), ambiguity);
  };

  for (const event of events) {
    if (eventsById.has(event.event_id)) {
      addAmbiguity("duplicate_event_id", [event.event_id]);
      continue;
    }
    eventsById.set(event.event_id, event);
  }

  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  for (const event of eventsById.values()) {
    const parentId = event.supersession?.supersedes_event_id;
    if (!parentId) continue;
    parentByChild.set(event.event_id, parentId);
    const parent = eventsById.get(parentId);
    if (!parent) {
      addAmbiguity("missing_parent", [event.event_id, parentId]);
      continue;
    }
    if (parent.run.run_id !== event.run.run_id) {
      addAmbiguity("cross_run_supersession", [event.event_id, parentId]);
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(event.event_id);
    childrenByParent.set(parentId, siblings);
  }
  for (const [parentId, children] of childrenByParent) {
    if (children.length > 1) {
      addAmbiguity("branch_ambiguity", [parentId, ...children]);
    }
  }

  const globallyVisited = new Set<string>();
  for (const eventId of eventsById.keys()) {
    if (globallyVisited.has(eventId)) continue;
    const path: string[] = [];
    const positionByEvent = new Map<string, number>();
    let currentId: string | undefined = eventId;
    while (currentId && eventsById.has(currentId) && !globallyVisited.has(currentId)) {
      const priorPosition = positionByEvent.get(currentId);
      if (priorPosition !== undefined) {
        addAmbiguity("cycle", path.slice(priorPosition));
        break;
      }
      positionByEvent.set(currentId, path.length);
      path.push(currentId);
      currentId = parentByChild.get(currentId);
    }
    for (const visitedId of path) globallyVisited.add(visitedId);
  }

  const rootByEvent = new Map<string, string>();
  const resolveRoot = (eventId: string): string | undefined => {
    const cached = rootByEvent.get(eventId);
    if (cached) return cached;
    const path: string[] = [];
    const seen = new Set<string>();
    let currentId = eventId;
    while (true) {
      if (seen.has(currentId)) return undefined;
      seen.add(currentId);
      path.push(currentId);
      const parentId = parentByChild.get(currentId);
      if (!parentId) {
        for (const memberId of path) rootByEvent.set(memberId, currentId);
        return currentId;
      }
      if (!eventsById.has(parentId)) return undefined;
      const parentRoot = rootByEvent.get(parentId);
      if (parentRoot) {
        for (const memberId of path) rootByEvent.set(memberId, parentRoot);
        return parentRoot;
      }
      currentId = parentId;
    }
  };

  const chainEventsByRoot = new Map<string, RunTerminalEvent[]>();
  for (const event of eventsById.values()) {
    const rootId = resolveRoot(event.event_id);
    if (!rootId) continue;
    const chain = chainEventsByRoot.get(rootId) ?? [];
    chain.push(event);
    chainEventsByRoot.set(rootId, chain);
  }

  const legacyRoots: InfraErrorCensusLegacyRootAudit[] = [];
  const uuidRootIdsByProjectionKey = new Map<string, string[]>();
  for (const [rootId, chain] of chainEventsByRoot) {
    const incarnationIds = new Set(
      chain.flatMap((event) => event.run.incarnation_id ? [event.run.incarnation_id] : []),
    );
    if (incarnationIds.size > 1) {
      addAmbiguity("incarnation_identity_conflict", chain.map((event) => event.event_id));
    }
    const leafEventIds = chain
      .filter((event) => (childrenByParent.get(event.event_id)?.length ?? 0) === 0)
      .map((event) => event.event_id)
      .sort((left, right) => left.localeCompare(right));
    const hasLegacyEvent = chain.some((event) => !event.run.incarnation_id);
    if (hasLegacyEvent && incarnationIds.size > 0) {
      addAmbiguity("incarnation_identity_conflict", chain.map((event) => event.event_id));
    }
    if (hasLegacyEvent) {
      legacyRoots.push({
        root_event_id: rootId,
        leaf_event_ids: leafEventIds,
        event_count: chain.length,
      });
      continue;
    }
    const root = eventsById.get(rootId);
    if (!root?.run.incarnation_id) continue;
    const projectionKey = projectionKeyForIncarnation(root);
    const rootIds = uuidRootIdsByProjectionKey.get(projectionKey) ?? [];
    rootIds.push(rootId);
    uuidRootIdsByProjectionKey.set(projectionKey, rootIds);
  }
  for (const rootIds of uuidRootIdsByProjectionKey.values()) {
    if (rootIds.length > 1) {
      addAmbiguity("duplicate_incarnation_root", rootIds);
    }
  }

  legacyRoots.sort((left, right) => left.root_event_id.localeCompare(right.root_event_id));
  const allAmbiguities = [...ambiguitiesByKey.values()].sort((left, right) => (
    left.code.localeCompare(right.code)
    || left.event_ids.join("\0").localeCompare(right.event_ids.join("\0"))
  ));
  const boundedAudit = boundAuditLocators(legacyRoots, allAmbiguities);
  const audit: InfraErrorCensusAuthorityAudit = {
    schema_version: "calyx.infra-error-census-authority-audit/v1",
    authority_source: authoritySource,
    authoritative: allAmbiguities.length === 0,
    terminal_event_count: eventsById.size,
    legacy_event_count: [...eventsById.values()].filter((event) => !event.run.incarnation_id).length,
    uuid_incarnation_count: uuidRootIdsByProjectionKey.size,
    legacy_root_count: legacyRoots.length,
    ambiguity_count: allAmbiguities.length,
    legacy_roots: boundedAudit.legacyRoots,
    ambiguities: boundedAudit.ambiguities,
    truncated: boundedAudit.truncated,
  };
  if (!audit.authoritative) {
    throw new InfraErrorCensusAuthorityError(audit);
  }

  const leaves: InfraErrorCensusProjectionLeaf[] = [];
  for (const [rootId, chain] of chainEventsByRoot) {
    const leaf = chain.find((event) => !childrenByParent.has(event.event_id));
    if (!leaf) continue;
    const hasLegacyEvent = chain.some((event) => !event.run.incarnation_id);
    leaves.push({
      projection_key: hasLegacyEvent
        ? JSON.stringify(["legacy-root", rootId])
        : projectionKeyForIncarnation(leaf),
      event: leaf,
    });
  }
  leaves.sort((left, right) => left.event.cursor.localeCompare(right.event.cursor));
  return { audit, leaves };
}

export function auditInfraErrorCensusAuthority(
  events: readonly RunTerminalEvent[],
  authoritySource: InfraErrorCensusAuthorityAudit["authority_source"] = "sqlite",
): InfraErrorCensusAuthorityAudit {
  try {
    return projectInfraErrorCensusAuthority(events, authoritySource).audit;
  } catch (error) {
    if (error instanceof InfraErrorCensusAuthorityError) return error.audit;
    throw error;
  }
}
