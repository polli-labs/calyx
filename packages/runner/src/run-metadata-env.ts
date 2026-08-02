import type { BackendOptions } from "./types.js";

export const CALYX_RUN_METADATA_ENV_KEYS = [
  "CALYX_RUN_ID",
  "CALYX_RUN_DIR",
  "CALYX_RUN_HOST",
  "CALYX_RUN_ISSUE",
  "CALYX_RUN_WORKTREE",
] as const;

export type CalyxRunMetadataEnvKey = typeof CALYX_RUN_METADATA_ENV_KEYS[number];
export type CalyxRunMetadataEnv = Partial<Record<CalyxRunMetadataEnvKey, string>>;

export interface CalyxRunMetadataEnvInput {
  run_id?: string;
  run_dir?: string;
  host?: string;
  issue?: string;
  worktree?: string;
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildCalyxRunMetadataEnv(input: CalyxRunMetadataEnvInput): CalyxRunMetadataEnv {
  const env: CalyxRunMetadataEnv = {};
  if (isPresent(input.run_id)) env.CALYX_RUN_ID = input.run_id;
  if (isPresent(input.run_dir)) env.CALYX_RUN_DIR = input.run_dir;
  if (isPresent(input.host)) env.CALYX_RUN_HOST = input.host;
  if (isPresent(input.issue)) env.CALYX_RUN_ISSUE = input.issue;
  if (isPresent(input.worktree)) env.CALYX_RUN_WORKTREE = input.worktree;
  return env;
}

export function mergeBackendOptionsWithCalyxRunMetadataEnv(
  backendOptions: BackendOptions | undefined,
  metadataEnv: CalyxRunMetadataEnv,
): BackendOptions | undefined {
  const metadataEntries = Object.entries(metadataEnv).filter(([, value]) => isPresent(value));
  if (metadataEntries.length === 0) {
    return backendOptions;
  }

  const env: Record<string, string | null> = { ...(backendOptions?.env ?? {}) };
  for (const [key, value] of metadataEntries) {
    env[key] = value;
  }

  return {
    ...(backendOptions ?? {}),
    env,
  };
}
