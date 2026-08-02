import path from "node:path";
import type {
  InteractiveSessionBackend,
  InteractiveSessionListEntry,
} from "./types.js";

export interface ParsedInteractiveActivityLocator {
  backend?: InteractiveSessionBackend;
  /**
   * Host named by an authorship alias (`<backend>:<host>:<session-id>`). Never filters
   * matches, but resolution gates session-id prefix expansion and the not-found hint on
   * it (POL-1774).
   */
  host?: string;
  sessionId: string;
}

const INTERACTIVE_ACTIVITY_ID_RE = /^interactive:(codex|claude):(.+)$/;
const CODEX_THREAD_DEEPLINK_RE = /^codex:\/\/threads\/([^/?#]+)\/?(?:[?#].*)?$/i;
// Vault authorship identity (`author:`/`updated_by:` frontmatter): `<backend>:<host>:<session_id>`.
// The session segment is restricted to uuid-shaped values (hex + dashes, prefixes allowed) so
// arbitrary colon-separated strings do not parse as authorship aliases. Matching is
// case-insensitive and all captures are lowercased: stored backends, hosts, and session ids
// are lowercase, so un-normalized captures would silently match nothing (POL-1774).
const AUTHORSHIP_ACTIVITY_ALIAS_RE = /^(codex|claude):([a-z0-9][a-z0-9._-]*):([0-9a-f][0-9a-f-]*)$/i;

/** Every locator form the resolver accepts, quoted verbatim in grammar errors. */
const ACTIVITY_LOCATOR_GRAMMAR = [
  "Accepted activity locators:",
  "  interactive:<backend>:<session-id>  canonical activity id (backend: codex|claude)",
  "  <backend>:<host>:<session-id>       vault authorship alias",
  "  codex://threads/<uuid>              Codex thread deeplink",
  "  run:<run-id>                        Calyx run handle",
  "  <session-id-prefix>                 unique prefix of a session id",
  "The host is a separate `--host <host>` argument, never a segment of the id.",
].join("\n");

export type MalformedActivityLocatorReason =
  | "missing_run_id"
  | "missing_session_id"
  | "not_canonical"
  | "unparseable";

export interface MalformedActivityLocator {
  reason: MalformedActivityLocatorReason;
  /** One clause naming exactly what is wrong with the supplied id. */
  problem: string;
  /** Canonical rewrite of the supplied segments, when one is derivable. */
  correctedActivityId?: string;
  /** Host segment found inside the id; it belongs in `--host`. */
  host?: string;
}

function activityBackendSegment(value: string): InteractiveSessionBackend | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "claude" ? normalized : undefined;
}

/**
 * Classify an activity locator that no accepted form can parse, so callers can
 * report a *grammar* error instead of an absence (POL-1825).
 *
 * Over-segmentation is the decidable signal. Every stored locator carries at
 * most two colons (`interactive:<backend>:<session-id>`), session ids are
 * uuid-shaped, and prefix expansion only ever matches a prefix of a stored
 * locator — so a three-or-more segment value that matches none of the accepted
 * forms cannot match any session on any host. One- and two-segment values stay
 * unclassified: they remain legitimate prefixes (`019dcafe`, `codex:019dcafe`,
 * `interactive:codex`) and their misses are genuine absences.
 */
export function describeMalformedActivityLocator(
  activityId: string,
): MalformedActivityLocator | undefined {
  const trimmed = activityId.trim();
  if (trimmed.startsWith("run:")) {
    return trimmed.slice("run:".length).trim()
      ? undefined
      : { reason: "missing_run_id", problem: "`run:` carries no run id" };
  }
  if (
    INTERACTIVE_ACTIVITY_ID_RE.test(trimmed)
    || AUTHORSHIP_ACTIVITY_ALIAS_RE.test(trimmed)
    || parseCodexThreadDeeplink(trimmed) !== undefined
  ) {
    return undefined;
  }

  const segments = trimmed.split(":").map((segment) => segment.trim());
  if (segments.length < 3) {
    return undefined;
  }

  const scoped = segments[0]!.toLowerCase() === "interactive" ? segments.slice(1) : segments;
  const backendIndex = scoped.findIndex((segment) => activityBackendSegment(segment) !== undefined);
  const backend = backendIndex < 0 ? undefined : activityBackendSegment(scoped[backendIndex]!);
  if (!backend || scoped.length > 3) {
    return {
      reason: "unparseable",
      problem: backend
        ? `it has ${segments.length} colon-separated segments; no activity locator has more than three`
        : "no `codex` or `claude` backend segment is present",
    };
  }

  const sessionId = backendIndex === scoped.length - 1 ? "" : scoped[scoped.length - 1]!;
  const hostIndex = scoped.length === 3 ? (backendIndex === 0 ? 1 : 0) : -1;
  const host = hostIndex >= 0 && hostIndex !== backendIndex && scoped[hostIndex]
    ? scoped[hostIndex]
    : undefined;
  if (!sessionId) {
    return {
      reason: "missing_session_id",
      problem: "no session id follows the backend segment",
      ...(host ? { host } : {}),
    };
  }
  return {
    reason: "not_canonical",
    problem: host
      ? `the host segment "${host}" belongs in --host, not in the activity id`
      : "the segments are not in canonical order",
    correctedActivityId: `interactive:${backend}:${sessionId}`,
    ...(host ? { host } : {}),
  };
}

/** Render a grammar error that names the defect, the fix, and the accepted forms. */
export function formatMalformedActivityLocator(
  activityId: string,
  malformed: MalformedActivityLocator,
): string {
  return [
    `Activity id "${activityId}" is malformed: ${malformed.problem}.`,
    ...(malformed.correctedActivityId
      ? [`Use: ${malformed.correctedActivityId}${malformed.host ? ` --host ${malformed.host}` : ""}`]
      : []),
    ACTIVITY_LOCATOR_GRAMMAR,
  ].join("\n");
}

function unique(values: Iterable<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      ids.add(normalized);
    }
  }
  return Array.from(ids);
}

export function parseCodexThreadDeeplink(value: string): string | undefined {
  const match = value.trim().match(CODEX_THREAD_DEEPLINK_RE);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]).trim() || undefined;
  } catch {
    return match[1].trim() || undefined;
  }
}

export function parseInteractiveActivityLocator(activityId: string): ParsedInteractiveActivityLocator {
  const trimmed = activityId.trim();
  const match = trimmed.match(INTERACTIVE_ACTIVITY_ID_RE);
  if (match?.[1] && match[2]) {
    const backend = match[1] as InteractiveSessionBackend;
    const rawSessionId = match[2].trim();
    const codexThreadId = backend === "codex"
      ? parseCodexThreadDeeplink(rawSessionId)
      : undefined;
    return {
      backend,
      sessionId: codexThreadId ?? rawSessionId,
    };
  }

  const codexThreadId = parseCodexThreadDeeplink(trimmed);
  if (codexThreadId) {
    return {
      backend: "codex",
      sessionId: codexThreadId,
    };
  }

  const authorship = trimmed.match(AUTHORSHIP_ACTIVITY_ALIAS_RE);
  if (authorship?.[1] && authorship[2] && authorship[3]) {
    return {
      backend: authorship[1].toLowerCase() as InteractiveSessionBackend,
      host: authorship[2].toLowerCase(),
      sessionId: authorship[3].toLowerCase(),
    };
  }

  return { sessionId: trimmed };
}

export function normalizeBackendSessionId(value: string, backend: InteractiveSessionBackend): string {
  const parsed = parseInteractiveActivityLocator(value);
  if (!parsed.backend || parsed.backend === backend) {
    return parsed.sessionId;
  }
  return value;
}

export function codexSessionIdFromPath(sessionPath: string): string | undefined {
  const filename = path.basename(sessionPath);
  const isoMatch = filename.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-([0-9a-f-]+)\.jsonl$/i);
  if (isoMatch?.[4]) {
    return isoMatch[4];
  }

  const numericMatch = filename.match(/^rollout-(\d+)-([0-9a-f-]+)\.jsonl$/i);
  return numericMatch?.[2];
}

export function interactiveSessionLocatorIds(session: InteractiveSessionListEntry): string[] {
  return unique([
    session.session_id,
    session.backend === "codex" ? codexSessionIdFromPath(session.session_path) : undefined,
  ]);
}

export function interactiveSessionMatchesLocator(
  session: InteractiveSessionListEntry,
  locator: ParsedInteractiveActivityLocator,
): boolean {
  if (locator.backend && session.backend !== locator.backend) {
    return false;
  }
  if (session.run_id === `interactive:${session.backend}:${locator.sessionId}`) {
    return true;
  }
  return interactiveSessionLocatorIds(session).some((id) => id === locator.sessionId);
}

export function interactiveSessionMatchesLocatorPrefix(
  session: InteractiveSessionListEntry,
  rawActivityId: string,
  locator: ParsedInteractiveActivityLocator,
): boolean {
  if (locator.backend && session.backend !== locator.backend) {
    return false;
  }
  return session.run_id.startsWith(rawActivityId)
    || session.run_id.includes(`:${rawActivityId}`)
    || interactiveSessionLocatorIds(session).some((id) => id.startsWith(locator.sessionId));
}
