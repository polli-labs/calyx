import path from "node:path";
import type { InstallBootstrapOptions, InstallBootstrapResult } from "./types";

/**
 * Bootstrap agent installation by planning or executing the standard
 * installation steps.
 *
 * The bootstrap process:
 * 1. Ensure ~/.agents directory structure exists
 * 2. Symlink calyx binary to PATH
 * 3. Copy default config files
 * 4. Verify installation
 *
 * In plan mode (default), returns the planned steps without side effects.
 * In apply mode, executes each step.
 */
export async function installBootstrap(options: InstallBootstrapOptions = {}): Promise<InstallBootstrapResult> {
  const target = options.target ?? path.join(process.env["HOME"] ?? "/tmp", ".agents");
  const apply = Boolean(options.apply);

  const steps = [
    `Ensure directory: ${target}`,
    `Ensure directory: ${path.join(target, "run")}`,
    `Ensure directory: ${path.join(target, "skills")}`,
    `Ensure directory: ${path.join(target, "logs")}`,
    `Ensure directory: ${path.join(target, "docstore")}`,
    `Verify calyx binary in PATH`
  ];

  if (apply) {
    const { mkdir } = await import("node:fs/promises");
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
  }

  return {
    target,
    apply,
    action: apply ? "bootstrap" : "plan-bootstrap",
    steps
  };
}
