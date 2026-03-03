import type { AgentMailAdapterOptions, AgentMailAdapterResult } from "./types";

/**
 * Adapter for agent-mail CLI operations.
 *
 * Delegates to the `agent-mail` CLI via child_process when available,
 * returning structured results. Falls back to a descriptive error
 * if the agent-mail binary is not found.
 */
export async function agentMailAdapter(
  options: AgentMailAdapterOptions
): Promise<AgentMailAdapterResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const args: string[] = [options.verb];
  if (options.projectKey) {
    args.push("--project-key", options.projectKey);
  }
  if (options.threadId) {
    args.push("--thread-id", options.threadId);
  }
  if (options.message) {
    args.push("--message", options.message);
  }

  try {
    const { stdout } = await execFileAsync("agent-mail", args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    return {
      verb: options.verb,
      delegated: true,
      exitCode: 0,
      output: stdout.trim()
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exitCode = (err as { code?: number }).code ?? 1;
    return {
      verb: options.verb,
      delegated: false,
      exitCode: typeof exitCode === "number" ? exitCode : 1,
      output: `Agent-mail delegation failed: ${message}`
    };
  }
}
