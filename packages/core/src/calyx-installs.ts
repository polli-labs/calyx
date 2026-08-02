import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CalyxBuildInfo } from "./daemon-registry";
import { CALYX_BUILD_INFO_SCHEMA_VERSION } from "./daemon-registry";

export const CALYX_INSTALLS_ROOT_ENV = "CALYX_INSTALLS_ROOT";
export const CALYX_HOME_ENV = "CALYX_HOME";
export const CALYX_CURRENT_INSTALL_LINK = "current";
export const CALYX_INSTALL_BUILD_INFO_FILENAME = ".build-info.json";
export const CALYX_CLI_PACKAGE_NAME = "@polli-labs/calyx";

export interface ResolveCalyxInstallsRootOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: () => string;
}

export interface PromotedCalyxBuild {
  install_path: string;
  current_link: string;
  build_info_path: string;
  build: CalyxBuildInfo;
}

function resolveCalyxHome(options: ResolveCalyxInstallsRootOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitHome = env[CALYX_HOME_ENV]?.trim();
  if (explicitHome) {
    return path.resolve(explicitHome);
  }
  return path.join((options.homeDir ?? homedir)(), ".calyx");
}

export function resolveCalyxInstallsRoot(options: ResolveCalyxInstallsRootOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitRoot = env[CALYX_INSTALLS_ROOT_ENV]?.trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return path.join(resolveCalyxHome(options), "installs");
}

export function resolveCurrentCalyxInstallLink(installsRoot: string): string {
  return path.join(installsRoot, CALYX_CURRENT_INSTALL_LINK);
}

export function resolveCalyxInstallBinPath(installPath: string): string {
  return path.join(installPath, "node_modules", "@polli-labs", "calyx", "dist", "bin.js");
}

export function resolveCalyxInstallPackageBuildInfoPath(installPath: string): string {
  return path.join(installPath, "node_modules", "@polli-labs", "calyx", "dist", CALYX_INSTALL_BUILD_INFO_FILENAME);
}

export function resolveCalyxInstallBuildInfoPath(installPath: string): string {
  return path.join(installPath, CALYX_INSTALL_BUILD_INFO_FILENAME);
}

export function isCalyxBuildInfo(value: unknown): value is CalyxBuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CalyxBuildInfo>;
  return (
    candidate.schema_version === CALYX_BUILD_INFO_SCHEMA_VERSION
    && typeof candidate.git_head === "string"
    && typeof candidate.built_at === "string"
    && typeof candidate.package_version === "string"
    && typeof candidate.branch === "string"
    && typeof candidate.dirty === "boolean"
  );
}

export async function readCalyxBuildInfo(buildInfoPath: string): Promise<CalyxBuildInfo> {
  const raw = JSON.parse(await readFile(buildInfoPath, "utf8")) as unknown;
  if (!isCalyxBuildInfo(raw)) {
    throw new Error(`Invalid Calyx build metadata at ${buildInfoPath}.`);
  }
  return raw;
}

export async function readPromotedCalyxBuild(
  options: ResolveCalyxInstallsRootOptions = {},
): Promise<PromotedCalyxBuild | undefined> {
  const installsRoot = resolveCalyxInstallsRoot(options);
  const currentLink = resolveCurrentCalyxInstallLink(installsRoot);
  let installPath: string;
  try {
    installPath = await realpath(currentLink);
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const rootBuildInfoPath = resolveCalyxInstallBuildInfoPath(installPath);
  const packageBuildInfoPath = resolveCalyxInstallPackageBuildInfoPath(installPath);
  try {
    return {
      install_path: installPath,
      current_link: currentLink,
      build_info_path: rootBuildInfoPath,
      build: await readCalyxBuildInfo(rootBuildInfoPath),
    };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException;
    if (typed.code !== "ENOENT") {
      throw error;
    }
    return {
      install_path: installPath,
      current_link: currentLink,
      build_info_path: packageBuildInfoPath,
      build: await readCalyxBuildInfo(packageBuildInfoPath),
    };
  }
}
