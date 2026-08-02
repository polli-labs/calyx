import type { CalyxDaemonDescriptor, CalyxDaemonSupervisorAdapter } from "@polli-labs/calyx-core";
import { createDirectSupervisorAdapter, type DirectSupervisorDependencies } from "./direct.js";
import { createLaunchdSupervisorAdapter } from "./launchd.js";
import { createSystemdSupervisorAdapter, type SystemdSupervisorDependencies } from "./systemd.js";

export interface SupervisorAdapterDependencies {
  direct?: DirectSupervisorDependencies;
  systemd?: SystemdSupervisorDependencies;
}

export function createSupervisorAdapter(
  descriptor: CalyxDaemonDescriptor,
  dependencies: SupervisorAdapterDependencies = {},
): CalyxDaemonSupervisorAdapter {
  if (descriptor.supervisor.kind === "systemd") {
    return createSystemdSupervisorAdapter(dependencies.systemd);
  }
  if (descriptor.supervisor.kind === "launchd") {
    return createLaunchdSupervisorAdapter();
  }
  return createDirectSupervisorAdapter(dependencies.direct);
}

export { createDirectSupervisorAdapter } from "./direct.js";
export type { DirectSupervisorDependencies } from "./direct.js";
export { createSystemdSupervisorAdapter } from "./systemd.js";
export type { SystemdSupervisorDependencies } from "./systemd.js";
export { createLaunchdSupervisorAdapter } from "./launchd.js";
