import {
  PROVIDER_CONSTRAINT_SCHEMA_VERSION,
  type ProviderConstraint,
  type ProviderConstraintKind,
  type ProviderConstraintSource,
} from "./types.js";

const MAX_PROVIDER_CODE_CHARS = 64;
const MAX_RESET_HINT_CHARS = 256;
const CLAUDE_SESSION_LIMIT_PATTERN = /\byou(?:'|’)ve hit your session limit\b/iu;
const CODEX_USAGE_LIMIT_PATTERN = /\byou(?:'|’)ve hit your usage limit\b/iu;
const CODEX_CREDITS_REMEDIATION_PATTERN = /\b(?:purchase more credits?|try again at)\b/iu;
const RESET_PREFIX = String.raw`\b(?:resets?(?:\s+(?:at|on))?|try again(?:\s+(?:at|after|on))?)\s+`;
const UTC_CLOCK = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]m)?\s*(?:UTC|\(UTC\))`;
const MONTH_DATE_CLOCK = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s+\d{4})?\s+(?:at\s+)?(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]m)?(?:\s*(?:UTC|\(UTC\)))?`;
const RESET_HINT_PATTERNS = [
  new RegExp(`${RESET_PREFIX}${MONTH_DATE_CLOCK}`, "iu"),
  new RegExp(`${RESET_PREFIX}${UTC_CLOCK}`, "iu"),
];

export interface ProviderConstraintObservation {
  backend: string;
  source: ProviderConstraintSource;
  observed_at?: string;
  provider_code?: string;
  http_status?: number;
  message?: string;
  credits_available?: boolean;
  /** Direct stderr is terminal evidence only when the current turn failed. */
  terminal_failure?: boolean;
}

function normalizedProviderCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized
    && normalized.length <= MAX_PROVIDER_CODE_CHARS
    && /^[a-z0-9_-]+$/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizedTimestamp(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function resetHint(message: string | undefined): string | undefined {
  const match = RESET_HINT_PATTERNS
    .map((pattern) => message?.match(pattern)?.[0])
    .find((value): value is string => Boolean(value));
  if (!match) return undefined;
  const normalized = match.replace(/\s+/gu, " ").trim();
  return normalized.slice(0, MAX_RESET_HINT_CHARS) || undefined;
}

function classifyConstraint(
  observation: ProviderConstraintObservation,
  message: string,
  providerCode: string | undefined,
  httpStatus: number | undefined,
): ProviderConstraintKind | undefined {
  if (
    observation.backend === "claude"
    && (observation.source === "backend_stream" || observation.source === "session_transcript")
    && providerCode === "rate_limit"
    && httpStatus === 429
    && CLAUDE_SESSION_LIMIT_PATTERN.test(message)
  ) {
    return "session_window";
  }
  if (
    observation.backend === "codex"
    && observation.source === "session_transcript"
    && observation.credits_available === false
  ) {
    return "credits";
  }
  if (
    observation.backend === "codex"
    && observation.source === "backend_stderr"
    && observation.terminal_failure === true
    && CODEX_USAGE_LIMIT_PATTERN.test(message)
    && CODEX_CREDITS_REMEDIATION_PATTERN.test(message)
  ) {
    return "credits";
  }
  return undefined;
}

/**
 * Normalize exact provider-capacity evidence into one bounded terminal fact.
 *
 * A bare HTTP 429 or `rate_limit` code is intentionally insufficient: it may
 * describe transient service throttling rather than an exhausted user quota.
 */
export function detectProviderConstraint(
  observation: ProviderConstraintObservation,
): ProviderConstraint | undefined {
  const message = observation.message?.trim() ?? "";
  const providerCode = normalizedProviderCode(observation.provider_code);
  const httpStatus = Number.isInteger(observation.http_status)
    && observation.http_status! >= 100
    && observation.http_status! <= 599
    ? observation.http_status
    : undefined;
  const kind = classifyConstraint(observation, message, providerCode, httpStatus);
  if (!kind) return undefined;
  const hint = resetHint(message);

  return {
    schema_version: PROVIDER_CONSTRAINT_SCHEMA_VERSION,
    cause: "provider_capacity_exhausted",
    backend: observation.backend,
    kind,
    source: observation.source,
    observed_at: normalizedTimestamp(observation.observed_at),
    confidence: "definitive",
    ...(providerCode ? { provider_code: providerCode } : {}),
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(hint ? { reset_hint: hint } : {}),
  };
}
