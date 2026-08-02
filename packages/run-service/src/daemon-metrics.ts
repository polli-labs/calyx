import { monitorEventLoopDelay } from "node:perf_hooks";
import type { CalyxDaemonMetrics } from "@polli-labs/calyx-core";

const EVENT_LOOP_MONITOR = monitorEventLoopDelay({ resolution: 20 });

// Node does not expose an unref() hook for this monitor, but the enabled
// histogram does not keep an otherwise idle process alive.
EVENT_LOOP_MONITOR.enable();

function normalizeLagPercentile(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value / 1_000_000;
}

export function readDaemonMemoryMetrics(): CalyxDaemonMetrics["memory"] {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heap_total: usage.heapTotal,
    heap_used: usage.heapUsed,
    external: usage.external,
    array_buffers: usage.arrayBuffers,
  };
}

export function readEventLoopLagMetrics(): CalyxDaemonMetrics["event_loop"] {
  const snapshot: CalyxDaemonMetrics["event_loop"] = {
    lag_ms_p50: normalizeLagPercentile(EVENT_LOOP_MONITOR.percentile(50)),
    lag_ms_p99: normalizeLagPercentile(EVENT_LOOP_MONITOR.percentile(99)),
  };
  EVENT_LOOP_MONITOR.reset();
  return snapshot;
}
