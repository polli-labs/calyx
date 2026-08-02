export function getPrimaryExecPlanIssue(frontmatter: Record<string, unknown>): string | undefined {
  const explicitIssue = frontmatter["issue"];
  if (typeof explicitIssue === "string" && explicitIssue.trim()) {
    return explicitIssue.trim();
  }

  const execplan = frontmatter["execplan"];
  if (!execplan || typeof execplan !== "object" || Array.isArray(execplan)) {
    return undefined;
  }

  const linear = (execplan as Record<string, unknown>)["linear"];
  if (!linear || typeof linear !== "object" || Array.isArray(linear)) {
    return undefined;
  }

  const issues = (linear as Record<string, unknown>)["issues"];
  if (!Array.isArray(issues)) {
    return undefined;
  }

  const primary = issues.find((value) => typeof value === "string" && value.trim());
  return typeof primary === "string" ? primary.trim() : undefined;
}
