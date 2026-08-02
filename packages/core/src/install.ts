import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCalyxInstallBinPath, resolveCalyxInstallsRoot, resolveCurrentCalyxInstallLink } from "./calyx-installs";
import type { InstallBootstrapOptions, InstallBootstrapResult } from "./types";

const BOOTSTRAP_WRAPPER_MARKER = "CALYX_BOOTSTRAP_WRAPPER=1";

function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Render the `~/.agents/run/calyx` wrapper.
 *
 * The wrapper is written once at install time and then read for months, on a
 * host the writing process never sees again. Anything it decides about the
 * command tree is therefore frozen at install-time-N while the command tree
 * keeps moving — so it decides nothing: it locates a supported Node runtime and
 * execs the current CLI with argv untouched. Routing a command elsewhere is the
 * CLI's job, next to the command tree that defines it.
 */
function renderBootstrapWrapper(sourceExecutablePath: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

${BOOTSTRAP_WRAPPER_MARKER}
SOURCE_EXECUTABLE_PATH=${escapeShellValue(sourceExecutablePath)}
CALYX_NODE_MIN_VERSION='22.13.0'

node_version_supported() {
  local version="$1"
  if [[ "$version" =~ ^v?([0-9]+)\\.([0-9]+)\\.([0-9]+) ]]; then
    local major="\${BASH_REMATCH[1]}"
    local minor="\${BASH_REMATCH[2]}"
    local patch="\${BASH_REMATCH[3]}"
    (( major > 22 || (major == 22 && (minor > 13 || (minor == 13 && patch >= 0))) ))
    return $?
  fi
  return 1
}

candidate_node_version() {
  "$1" --version 2>/dev/null || true
}

node_runtime_supported() {
  local version
  version="$(candidate_node_version "$1")"
  node_version_supported "$version"
}

find_calyx_node() {
  local candidates=()
  local candidate
  local current_node=""

  if [[ -n "\${CALYX_NODE-}" ]]; then
    if [[ -x "$CALYX_NODE" ]] && node_runtime_supported "$CALYX_NODE"; then
      printf '%s\\n' "$CALYX_NODE"
      return 0
    fi
    return 1
  fi

  current_node="$(command -v node 2>/dev/null || true)"
  if [[ -n "$current_node" ]]; then
    candidates+=("$current_node")
  fi

  candidates+=(
    "/opt/homebrew/opt/node@22/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "/usr/bin/node"
  )

  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
      [[ -e "$candidate" ]] && candidates+=("$candidate")
    done
  fi

  for candidate in "\${candidates[@]}"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    if node_runtime_supported "$candidate"; then
      printf '%s\\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if [[ ! -x "$SOURCE_EXECUTABLE_PATH" ]]; then
  echo "[calyx] bootstrapped source executable missing or not executable: $SOURCE_EXECUTABLE_PATH" >&2
  echo "[calyx] Rerun 'calyx install bootstrap --apply' against a promoted install or a built checkout." >&2
  exit 1
fi

CALYX_NODE_BIN="$(find_calyx_node || true)"
if [[ -z "$CALYX_NODE_BIN" ]]; then
  current_node="$(command -v node 2>/dev/null || true)"
  current_version=""
  if [[ -n "\${CALYX_NODE-}" ]]; then
    current_version="$(candidate_node_version "$CALYX_NODE")"
    echo "[calyx] source wrapper requires Node >=$CALYX_NODE_MIN_VERSION for node:sqlite; CALYX_NODE is $current_version at $CALYX_NODE." >&2
  elif [[ -n "$current_node" ]]; then
    current_version="$("$current_node" --version 2>/dev/null || true)"
    echo "[calyx] source wrapper requires Node >=$CALYX_NODE_MIN_VERSION for node:sqlite; current node is $current_version at $current_node." >&2
  else
    echo "[calyx] source wrapper requires Node >=$CALYX_NODE_MIN_VERSION for node:sqlite; no node binary was found on PATH." >&2
  fi
  echo "[calyx] Install Node >=$CALYX_NODE_MIN_VERSION, set CALYX_NODE=/path/to/node, or activate nvm Node 22 before invoking calyx." >&2
  exit 1
fi

exec "$CALYX_NODE_BIN" "$SOURCE_EXECUTABLE_PATH" "$@"
`;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await stat(pathname);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutablePath(executablePath?: string): Promise<string | undefined> {
  if (!executablePath) {
    return undefined;
  }

  try {
    return await realpath(executablePath);
  } catch {
    return path.resolve(executablePath);
  }
}

async function resolvePromotedExecutablePath(installsRoot?: string): Promise<string | undefined> {
  const currentLink = resolveCurrentCalyxInstallLink(installsRoot ? path.resolve(installsRoot) : resolveCalyxInstallsRoot());
  let installPath: string;
  try {
    installPath = await realpath(currentLink);
  } catch {
    return undefined;
  }
  const resolvedExecutablePath = resolveCalyxInstallBinPath(installPath);
  return (await executableExists(resolvedExecutablePath)) ? resolveCalyxInstallBinPath(currentLink) : undefined;
}

async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);
  for (;;) {
    if (await pathExists(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

async function collectWorkspaceSourceCandidates(root: string): Promise<string[]> {
  const packagesDir = path.join(root, "packages");
  if (!(await pathExists(packagesDir))) {
    return [];
  }

  const candidates: string[] = [];
  const queue = [packagesDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }

      if (
        entry.name === "package.json" ||
        entry.name === "tsconfig.json" ||
        entry.name.endsWith(".ts") ||
        entry.name.endsWith(".mts") ||
        entry.name.endsWith(".cts") ||
        entry.name.endsWith(".js") ||
        entry.name.endsWith(".mjs")
      ) {
        candidates.push(absolutePath);
      }
    }
  }

  return candidates;
}

async function detectStaleBuiltExecutable(
  executablePath: string,
): Promise<InstallBootstrapResult["staleBuild"] | undefined> {
  const normalized = path.resolve(executablePath);
  if (path.basename(normalized) !== "bin.js" || path.basename(path.dirname(normalized)) !== "dist") {
    return undefined;
  }

  const packageDir = path.dirname(path.dirname(normalized));
  if (!(await pathExists(path.join(packageDir, "package.json"))) || !(await pathExists(path.join(packageDir, "src")))) {
    return undefined;
  }

  const workspaceRoot = await findWorkspaceRoot(packageDir);
  const sourceCandidates = await collectWorkspaceSourceCandidates(workspaceRoot);
  if (sourceCandidates.length === 0) {
    return undefined;
  }

  const executableStat = await stat(normalized);
  let newestSourcePath: string | undefined;
  let newestSourceMtimeMs = Number.NEGATIVE_INFINITY;
  for (const candidate of sourceCandidates) {
    const candidateStat = await stat(candidate);
    if (candidateStat.mtimeMs > newestSourceMtimeMs) {
      newestSourceMtimeMs = candidateStat.mtimeMs;
      newestSourcePath = candidate;
    }
  }

  if (!newestSourcePath || newestSourceMtimeMs <= executableStat.mtimeMs) {
    return undefined;
  }

  return {
    executablePath: normalized,
    packageDir,
    workspaceRoot,
    newestSourcePath,
    remediation: `Rebuild the checkout before bootstrapping (for example: pnpm build in ${workspaceRoot}).`,
  };
}

/**
 * Bootstrap agent installation by planning or executing the standard
 * installation steps.
 *
 * The bootstrap process:
 * 1. Ensure ~/.agents directory structure exists
 * 2. Remove any retired ~/.agents/run/calyx.legacy shadow wrapper
 * 3. Install the canonical ~/.agents/run/calyx wrapper for the current source binary
 * 4. Verify installation
 *
 * In plan mode (default), returns the planned steps without side effects.
 * In apply mode, executes each step.
 */
export async function installBootstrap(options: InstallBootstrapOptions = {}): Promise<InstallBootstrapResult> {
  const target = options.target ?? path.join(process.env["HOME"] ?? "/tmp", ".agents");
  const apply = Boolean(options.apply);
  const wrapperPath = path.join(target, "run", "calyx");
  const legacyWrapperPath = path.join(target, "run", "calyx.legacy");
  const legacyWrapperPresent = await pathExists(legacyWrapperPath);
  const requestedExecutablePath = await resolveExecutablePath(options.executablePath);
  const promotedExecutablePath = await resolvePromotedExecutablePath(options.installsRoot);
  const sourceExecutablePath = promotedExecutablePath ?? requestedExecutablePath;
  const staleBuild = !promotedExecutablePath && sourceExecutablePath
    ? await detectStaleBuiltExecutable(sourceExecutablePath)
    : undefined;
  const warnings = staleBuild
    ? [
        `[install] stale built executable detected at ${staleBuild.executablePath}; newest source evidence is ${staleBuild.newestSourcePath}. ${staleBuild.remediation}`,
      ]
    : [];
  if (promotedExecutablePath && requestedExecutablePath && requestedExecutablePath !== promotedExecutablePath) {
    warnings.push(
      `[install] using promoted Calyx install at ${promotedExecutablePath}; clone executable ${requestedExecutablePath} is a build surface, not the daemon serving path.`,
    );
  }

  const steps = [
    `Ensure directory: ${target}`,
    `Ensure directory: ${path.join(target, "run")}`,
    `Ensure directory: ${path.join(target, "skills")}`,
    `Ensure directory: ${path.join(target, "logs")}`,
    `Ensure directory: ${path.join(target, "docstore")}`,
    sourceExecutablePath
      ? `Install bootstrap wrapper: ${wrapperPath} -> ${sourceExecutablePath}`
      : `Verify calyx binary in PATH`
  ];

  if (legacyWrapperPresent) {
    steps.push(`Remove retired shadow wrapper: ${legacyWrapperPath}`);
  }

  if (staleBuild) {
    steps.push(`Blocked by stale built executable: ${staleBuild.executablePath}`);
  }

  if (apply) {
    if (staleBuild) {
      return {
        target,
        apply,
        action: "blocked-bootstrap",
        steps,
        wrapperPath,
        ...(sourceExecutablePath ? { sourceExecutablePath } : {}),
        warnings,
        staleBuild,
      };
    }

    const dirs = [
      target,
      path.join(target, "run"),
      path.join(target, "skills"),
      path.join(target, "logs"),
      path.join(target, "docstore")
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }

    if (sourceExecutablePath) {
      await writeFile(wrapperPath, renderBootstrapWrapper(sourceExecutablePath), "utf8");
      await chmod(wrapperPath, 0o755);
    }

    // `calyx.legacy` was this installer's own creation: a frozen copy of an
    // older wrapper that the generated wrapper delegated selected commands to.
    // With delegation deleted it is a shadow `calyx` that nothing reads and
    // every operator can still invoke by hand, so bootstrap retires it.
    if (legacyWrapperPresent) {
      await rm(legacyWrapperPath, { force: true });
    }
  }

  return {
    target,
    apply,
    action: apply ? "bootstrap" : "plan-bootstrap",
    steps,
    wrapperPath,
    ...(sourceExecutablePath ? { sourceExecutablePath } : {}),
    ...(legacyWrapperPresent ? { retiredLegacyWrapperPath: legacyWrapperPath } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(staleBuild ? { staleBuild } : {}),
  };
}
