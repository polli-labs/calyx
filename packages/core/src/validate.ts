import { z } from "zod";
import type { FleetInput, HostInput, ValidationMode } from "./types";

const arrayPolicySchema = z.enum(["replace", "append_unique"]);

const fleetSchema = z
  .object({
    version: z.string(),
    compiler: z
      .object({
        schema_version: z.string().optional(),
        output: z
          .object({
            format: z.string().optional(),
            path_template: z.string().optional()
          })
          .optional()
      })
      .passthrough()
      .optional(),
    array_policies: z
      .object({
        default: arrayPolicySchema.optional(),
        by_path: z.record(arrayPolicySchema).optional()
      })
      .passthrough()
      .optional(),
    secrets: z
      .object({
        mode: z.string().optional(),
        forbidden_literal_patterns: z.array(z.string()).optional()
      })
      .passthrough()
      .optional(),
    codex: z.record(z.unknown()).optional()
  })
  .passthrough();

const hostSchema = z
  .object({
    host: z.string().min(1),
    user: z.string().min(1),
    home: z.string().min(1),
    os: z.string().optional(),
    codex: z.record(z.unknown()).optional()
  })
  .passthrough();

const DEFAULT_SECRET_PATTERNS = [
  "(?i)api[_-]?key\\s*=\\s*\"[A-Za-z0-9]",
  "(?i)bearer\\s+[A-Za-z0-9._-]{20,}"
];

function buildSecretRegexes(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    const normalized = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
    const flags = pattern.startsWith("(?i)") ? "i" : "";
    return new RegExp(normalized, flags);
  });
}

function scanObjectForSecrets(value: unknown, regexes: RegExp[], path: string[] = []): string[] {
  if (typeof value === "string") {
    return regexes
      .filter((regex) => regex.test(value))
      .map((regex) => `Potential secret match at ${path.join(".") || "<root>"} using ${regex}`);
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanObjectForSecrets(entry, regexes, [...path, String(index)]));
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      scanObjectForSecrets(nested, regexes, [...path, key])
    );
  }

  return [];
}

function handleValidation(
  label: string,
  result: z.SafeParseReturnType<unknown, unknown>,
  mode: ValidationMode,
  warnings: string[]
): void {
  if (result.success) {
    return;
  }

  const issueSummary = result.error.issues
    .map((issue) => `${label}: ${issue.path.join(".") || "<root>"} ${issue.message}`)
    .join("; ");

  if (mode === "strict") {
    throw new Error(issueSummary);
  }

  warnings.push(issueSummary);
}

export function validateInputs(
  fleet: FleetInput,
  host: HostInput,
  mode: ValidationMode,
  warnings: string[]
): void {
  handleValidation("fleet", fleetSchema.safeParse(fleet), mode, warnings);
  handleValidation("host", hostSchema.safeParse(host), mode, warnings);

  const patterns = fleet.secrets?.forbidden_literal_patterns ?? DEFAULT_SECRET_PATTERNS;
  const regexes = buildSecretRegexes(patterns);
  const secretWarnings = scanObjectForSecrets(host, regexes).concat(scanObjectForSecrets(fleet, regexes));

  if (secretWarnings.length === 0) {
    return;
  }

  if (mode === "strict") {
    throw new Error(secretWarnings.join("; "));
  }

  warnings.push(...secretWarnings);
}
