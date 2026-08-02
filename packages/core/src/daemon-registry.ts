export const CALYX_BUILD_INFO_SCHEMA_VERSION = "build-info/v1";
export const CALYX_DAEMON_DESCRIPTOR_SCHEMA_VERSION = "calyx-daemon/v1";
export const CALYX_RUN_SERVICE_DAEMON_KIND = "run-service";

export interface CalyxDirectDaemonSupervisor {
  kind: "direct";
  stop_grace_ms?: number;
}

export interface CalyxSystemdDaemonSupervisor {
  kind: "systemd";
  unit_name?: string;
}

export interface CalyxLaunchdDaemonSupervisor {
  kind: "launchd";
  label?: string;
  plistPath?: string;
}

export type CalyxDaemonSupervisor =
  | CalyxDirectDaemonSupervisor
  | CalyxSystemdDaemonSupervisor
  | CalyxLaunchdDaemonSupervisor;

export type CalyxDaemonSupervisorKind = CalyxDaemonSupervisor["kind"];

export interface CalyxBuildInfo {
  schema_version: typeof CALYX_BUILD_INFO_SCHEMA_VERSION;
  git_head: string;
  built_at: string;
  package_version: string;
  branch: string;
  dirty: boolean;
}

export interface CalyxDaemonBuildSummary {
  git_head: string;
  built_at: string;
  package_version: string;
}

export interface CalyxDaemonDescriptor {
  schema_version: typeof CALYX_DAEMON_DESCRIPTOR_SCHEMA_VERSION;
  daemon_id: string;
  daemon_kind: typeof CALYX_RUN_SERVICE_DAEMON_KIND;
  pid: number;
  argv: string[];
  cwd: string;
  runs_root: string;
  health_url: string;
  livez_url: string;
  supervisor: CalyxDaemonSupervisor;
  started_at: string;
  build: CalyxDaemonBuildSummary;
  restart_order: number;
  depends_on: string[];
  maintenance_mode?: boolean;
}

export function toCalyxDaemonBuildSummary(buildInfo: CalyxBuildInfo): CalyxDaemonBuildSummary {
  return {
    git_head: buildInfo.git_head,
    built_at: buildInfo.built_at,
    package_version: buildInfo.package_version,
  };
}
