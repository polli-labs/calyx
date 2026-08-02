export const CALYX_DAEMON_METRICS_SCHEMA_VERSION = "daemon-metrics/v1";

export interface CalyxDaemonMetrics {
  schema_version: typeof CALYX_DAEMON_METRICS_SCHEMA_VERSION;
  memory: {
    rss: number;
    heap_total: number;
    heap_used: number;
    external: number;
    array_buffers: number;
  };
  event_loop: {
    lag_ms_p50: number;
    lag_ms_p99: number;
  };
  connections: {
    sse_subscribers: number;
    codex_app_server_sessions: number;
  };
  runs: {
    active: number;
    total_serviced_since_start: number;
  };
}
