import fs from "node:fs";
import path from "node:path";

const DARWIN_CODEX_COMMANDS = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
] as const;

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envPathEntries(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.PATH === undefined) {
    return undefined;
  }
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  return env.PATH.split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function codexCommandNames(): readonly string[] {
  return process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
}

function codexPathCandidates(env: NodeJS.ProcessEnv): string[] {
  const joinPath = process.platform === "win32" ? path.win32.join : path.join;
  return (envPathEntries(env) ?? []).flatMap((entry) => {
    return codexCommandNames().map((name) => joinPath(entry, name));
  });
}

function missingCodexError(tried: string[]): Error {
  return new Error(
    `Codex executable not found (tried: ${tried.join(", ")}). ` +
      "Install codex or set CALYX_CODEX_BIN.",
  );
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  const tried: string[] = [];
  const canonicalOverride = env.CALYX_CODEX_BIN?.trim();
  if (canonicalOverride) {
    tried.push(`CALYX_CODEX_BIN=${canonicalOverride}`);
    if (isExecutableFile(canonicalOverride)) {
      return canonicalOverride;
    }
    throw missingCodexError(tried);
  }

  const aliasOverride = env.CODEX_BIN?.trim();
  if (aliasOverride) {
    tried.push(`CODEX_BIN=${aliasOverride}`);
    if (isExecutableFile(aliasOverride)) {
      return aliasOverride;
    }
    throw missingCodexError(tried);
  }

  if (process.platform === "darwin") {
    for (const candidate of DARWIN_CODEX_COMMANDS) {
      tried.push(candidate);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  const pathCandidates = codexPathCandidates(env);
  if (pathCandidates.length === 0) {
    return "codex";
  }

  // POSIX fleet hosts intentionally keep PATH-compatible launcher semantics here;
  // macOS Homebrew and explicit overrides are the policy escapes from stale shims.
  tried.push("PATH");
  for (const candidate of pathCandidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw missingCodexError(tried);
}

/**
 * Best-effort variant of {@link resolveCodexCommand}.
 *
 * The app-server transport wants the throw: it has no other way to report a
 * missing binary. The one-shot exec transport already classifies spawn
 * failures, so for it a resolver exception would replace a good diagnosis with
 * a worse one. It still wants the *resolution*, though — a bare "codex" is
 * PATH-resolved by the OS, and PATH on a fleet host can lead to a stale
 * npm-global launcher whose vendored platform binary is gone. Prefer the
 * known-good absolute path when there is one; otherwise fall back to exactly
 * the name the caller would have used anyway.
 */
export function resolveCodexCommandOrDefault(env: NodeJS.ProcessEnv): string {
  try {
    return resolveCodexCommand(env);
  } catch {
    return "codex";
  }
}
