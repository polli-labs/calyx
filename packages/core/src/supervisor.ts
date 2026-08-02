import type {
  CalyxDaemonDescriptor,
  CalyxDaemonSupervisorKind,
} from "./daemon-registry.js";

export interface CalyxDaemonSupervisorStatus {
  running: boolean;
  pid?: number;
  detail?: string;
}

export interface CalyxDaemonStopResult {
  pid?: number;
  signal?: string;
  forced?: boolean;
  detail?: string;
}

export interface CalyxDaemonStartResult {
  pid?: number;
  detail?: string;
}

export interface CalyxDaemonSupervisorAdapter {
  readonly kind: CalyxDaemonSupervisorKind;
  stop(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStopResult>;
  start(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonStartResult>;
  status(descriptor: CalyxDaemonDescriptor): Promise<CalyxDaemonSupervisorStatus>;
}
