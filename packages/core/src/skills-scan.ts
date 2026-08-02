/**
 * POL-1729 Slice 1 — advisory security scan for agent-authored skill content.
 *
 * This is a pure, best-effort heuristic scan. It is NOT a trust boundary: it
 * cannot prove content is safe, only flag shapes that warrant review. The
 * `calyx skills write` gate uses SHARP findings to refuse a write under the
 * default `gate-sharpest` policy (Posture A); SOFT findings are recorded but
 * never block. A determined author can trivially evade these patterns — the
 * real review path is `calyx skills propose`.
 *
 * Findings categories:
 *   - shell-destructive (sharp): `rm -rf`, `dd if=`, `mkfs`, fork bombs.
 *   - network-exfil    (sharp): `curl ... | sh`, base64-decode piped to a net tool.
 *   - credential       (sharp): inline secret shapes (api keys, bearer tokens,
 *                               private keys, AWS access key ids).
 *   - invisible-unicode (soft): zero-width / bidi-control characters that can
 *                               hide instructions from a human reviewer.
 */

export type SkillScanCategory =
  | "shell-destructive"
  | "credential"
  | "network-exfil"
  | "invisible-unicode";

export type SkillScanSeverity = "sharp" | "soft";

export interface SkillScanFinding {
  category: SkillScanCategory;
  detail: string;
  severity: SkillScanSeverity;
}

export interface SkillScanResult {
  /** True when there are no SHARP findings. Soft findings do not flip this. */
  ok: boolean;
  findings: SkillScanFinding[];
}

interface ScanRule {
  category: SkillScanCategory;
  severity: SkillScanSeverity;
  match: (content: string) => boolean;
  detail: string;
}

function regexRule(
  category: SkillScanCategory,
  severity: SkillScanSeverity,
  pattern: RegExp,
  detail: string,
): ScanRule {
  return { category, severity, detail, match: (content) => pattern.test(content) };
}

/**
 * Detect a destructive `rm`: an `rm` invocation whose flag run contains BOTH a
 * recursive flag (-r/-R/--recursive) and a force flag (-f/--force), in any order,
 * combined or separate. Implemented as a small scan rather than one fragile
 * regex to keep it readable and backtracking-safe.
 */
function matchesDestructiveRm(content: string): boolean {
  const rmInvocation = /\brm\b([^\n;&|]*)/gi;
  for (let m = rmInvocation.exec(content); m !== null; m = rmInvocation.exec(content)) {
    const args = m[1] ?? "";
    let recursive = false;
    let force = false;
    for (const token of args.split(/\s+/)) {
      if (token === "--recursive") recursive = true;
      else if (token === "--force") force = true;
      else if (/^-[a-z]*$/i.test(token)) {
        if (/r/i.test(token)) recursive = true;
        if (/f/i.test(token)) force = true;
      }
    }
    if (recursive && force) {
      return true;
    }
  }
  return false;
}

/**
 * Shell-destructive + network-exfil rules. Patterns are intentionally
 * conservative (anchored on the dangerous token) to keep false positives low;
 * this is advisory, not a sandbox.
 */
const SHARP_RULES: ScanRule[] = [
  {
    category: "shell-destructive",
    severity: "sharp",
    match: matchesDestructiveRm,
    detail: "recursive force-delete (`rm -rf`)",
  },
  regexRule("shell-destructive", "sharp", /\bdd\s+if=/i, "raw disk write (`dd if=`)"),
  regexRule("shell-destructive", "sharp", /\bmkfs(?:\.\w+)?\b/i, "filesystem format (`mkfs`)"),
  // classic bash fork bomb :(){ :|:& };:
  regexRule("shell-destructive", "sharp", /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"),
  // curl/wget piped directly into a shell interpreter.
  regexRule(
    "network-exfil",
    "sharp",
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    "remote script piped to a shell (`curl ... | sh`)",
  ),
  // base64 -d / --decode piped onward to a shell or network tool.
  regexRule(
    "network-exfil",
    "sharp",
    /\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:sh|bash|curl|wget|nc|ncat)\b/i,
    "base64-decoded payload piped to a shell or network tool",
  ),
];

/**
 * Credential-shape rules. The api-key / bearer patterns mirror
 * `validate.ts` DEFAULT_SECRET_PATTERNS; the private-key and AWS-key patterns
 * extend coverage for skill prose.
 */
const CREDENTIAL_RULES: ScanRule[] = [
  regexRule("credential", "sharp", /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9]{16,}/i, "inline API key assignment"),
  regexRule("credential", "sharp", /bearer\s+[A-Za-z0-9._-]{20,}/i, "inline bearer token"),
  regexRule(
    "credential",
    "sharp",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    "embedded private key block",
  ),
  regexRule("credential", "sharp", /\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"),
];

/**
 * Invisible / bidi-control unicode that can hide instructions from a human
 * reviewer. Soft because legitimate prose occasionally contains zero-width
 * joiners; we flag for review rather than block.
 *   U+200B..U+200F zero-width + LTR/RTL marks
 *   U+202A..U+202E bidi embedding/override (incl. RLO U+202E)
 *   U+2060..U+2064 word-joiner + invisible operators
 *   U+2066..U+2069 bidi isolates
 *   U+061C arabic letter mark, U+FEFF BOM/zero-width no-break space
 */
// Built from explicit codepoint ranges (via \u escapes) so no literal
// invisible characters live in this source file.
const INVISIBLE_UNICODE_PATTERN = new RegExp(
  "[" +
    "\\u200B-\\u200F" + // zero-width space..RTL mark
    "\\u202A-\\u202E" + // bidi embedding/override (incl. RLO)
    "\\u2060-\\u2064" + // word-joiner + invisible operators
    "\\u2066-\\u2069" + // bidi isolates
    "\\u061C" + // arabic letter mark
    "\\uFEFF" + // BOM / zero-width no-break space
    "]",
);

function describeInvisibleCodepoints(content: string): string {
  const seen = new Set<string>();
  for (const ch of content) {
    if (INVISIBLE_UNICODE_PATTERN.test(ch)) {
      seen.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  const codepoints = [...seen].sort();
  return `invisible or bidi-control characters present (${codepoints.join(", ")})`;
}

/**
 * Scan a single content string. Pure and synchronous; safe to call on every
 * payload file. Returns `ok=false` only when a SHARP finding is present.
 */
export function scanSkillContent(content: string): SkillScanResult {
  const findings: SkillScanFinding[] = [];

  for (const rule of [...SHARP_RULES, ...CREDENTIAL_RULES]) {
    if (rule.match(content)) {
      findings.push({
        category: rule.category,
        severity: rule.severity,
        detail: rule.detail,
      });
    }
  }

  if (INVISIBLE_UNICODE_PATTERN.test(content)) {
    findings.push({
      category: "invisible-unicode",
      severity: "soft",
      detail: describeInvisibleCodepoints(content),
    });
  }

  const ok = !findings.some((finding) => finding.severity === "sharp");
  return { ok, findings };
}

/**
 * Scan every file in a payload map (relpath -> content). Findings are prefixed
 * with their relpath so the operator can locate them. `ok` is false if any file
 * has a SHARP finding.
 */
export function scanSkillPayload(payload: Record<string, string>): SkillScanResult {
  const findings: SkillScanFinding[] = [];
  for (const relPath of Object.keys(payload).sort((left, right) => left.localeCompare(right))) {
    const fileResult = scanSkillContent(payload[relPath]!);
    for (const finding of fileResult.findings) {
      findings.push({
        ...finding,
        detail: `${relPath}: ${finding.detail}`,
      });
    }
  }
  const ok = !findings.some((finding) => finding.severity === "sharp");
  return { ok, findings };
}
