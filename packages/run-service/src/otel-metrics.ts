import { hostname as osHostname } from "node:os";
import type { CalyxBuildInfo, CalyxDaemonFeature } from "@polli-labs/calyx-core";
import type { RunService } from "./service.js";
import type { RunServiceInfraErrorCensusPoint } from "./types.js";
import { InfraErrorCensusAuthorityError } from "./infra-error-census.js";
import {
  readDaemonMemoryMetrics,
  readEventLoopLagMetrics,
} from "./daemon-metrics.js";

export const OTEL_DAEMON_SCHEMA_VERSION = "calyx.daemon/v1";
export const OTEL_DAEMON_SERVICE_NAME = "calyx.daemon";
export const OTEL_DAEMON_METER_NAME = "calyx.daemon";
export const OTEL_DAEMON_DEFAULT_ENDPOINT = "http://blade:4318/v1/metrics";
export const OTEL_DAEMON_EXPORT_TIMEOUT_MS = 5_000;
export const OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS = 15_000;
export const OTEL_DAEMON_HOST_NAME_ATTRIBUTE = "host.name";
export const OTEL_DAEMON_CALYX_HOST_ATTRIBUTE = "calyx.host";
export const OTEL_DAEMON_ID_ATTRIBUTE = "calyx.daemon_id";

export interface OtelMetricsServerState {
  daemonId: string;
  buildInfo: CalyxBuildInfo;
  supportsFeatures: readonly CalyxDaemonFeature[];
}

export interface OtelMetricsRunService {
  runningMetrics: RunService["runningMetrics"];
  infraErrorCensus?: RunService["infraErrorCensus"];
}

export interface InitDaemonMetricsExporterOptions {
  state: OtelMetricsServerState;
  service: OtelMetricsRunService;
  exporterFactory?: (config: OtelExporterConfig) => OtelPushMetricExporterLike;
  logger?: OtelMetricsLogger;
  env?: NodeJS.ProcessEnv;
  hostname?: () => string;
  readMemory?: typeof readDaemonMemoryMetrics;
  readEventLoop?: typeof readEventLoopLagMetrics;
}

export interface OtelExporterConfig {
  url: string;
  timeoutMillis: number;
}

/**
 * Minimal structural interface for the OTLP metric exporter. Matches
 * `@opentelemetry/sdk-metrics` `PushMetricExporter` without forcing an
 * eager type import (keeps the opt-out path free of dynamic SDK imports).
 */
export interface OtelPushMetricExporterLike {
  export(
    metrics: unknown,
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
  selectAggregationTemporality?(instrumentType: unknown): unknown;
  selectAggregation?(instrumentType: unknown): unknown;
}

export interface OtelMetricsLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DaemonMetricsExporterHandle {
  /**
   * `true` only when the SDK loaded, the exporter was constructed, and the
   * meter provider was wired. Callers gate `daemon.otel_metrics/v1`
   * advertisement on this.
   */
  initialized: boolean;
  endpoint: string | undefined;
  shutdown(): Promise<void>;
}

export function resolveOtelEndpoint(env: NodeJS.ProcessEnv): string {
  const metricsEndpoint = env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]?.trim();
  if (metricsEndpoint) {
    return metricsEndpoint;
  }
  const baseEndpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim();
  if (baseEndpoint) {
    return baseEndpoint.replace(/\/+$/, "") + "/v1/metrics";
  }
  return OTEL_DAEMON_DEFAULT_ENDPOINT;
}

export function resolveExportIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env["OTEL_METRIC_EXPORT_INTERVAL"]?.trim();
  if (!raw) {
    return OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS;
  }
  return parsed;
}

function defaultLogger(): OtelMetricsLogger {
  return {
    info(message, meta) {
      console.log(meta ? `${message} ${JSON.stringify(meta)}` : message);
    },
    warn(message, meta) {
      console.warn(meta ? `${message} ${JSON.stringify(meta)}` : message);
    },
  };
}

export interface DaemonMetricsInstrumentDescriptor {
  name: string;
  kind: "observableGauge" | "observableCounter" | "observableUpDownCounter";
  unit: string;
  description: string;
  read: (snapshot: DaemonMetricsSnapshot) => number;
}

export interface DaemonMetricsSnapshot {
  memory: ReturnType<typeof readDaemonMemoryMetrics>;
  eventLoop: ReturnType<typeof readEventLoopLagMetrics>;
  running: Awaited<ReturnType<RunService["runningMetrics"]>>;
  infraErrors: RunServiceInfraErrorCensusPoint[];
}

export const DAEMON_INFRA_ERROR_CURRENT_METRIC = {
  name: "calyx_run_infra_error_current",
  kind: "observableGauge",
  unit: "{run}",
  description: "Current authoritative infra-error terminal-run census by typed layer/reason and run target dimensions.",
} as const;

export const DAEMON_METRICS_INSTRUMENTS: readonly DaemonMetricsInstrumentDescriptor[] = [
  {
    name: "calyx.daemon.memory.rss",
    kind: "observableGauge",
    unit: "By",
    description: "Resident set size of the calyx daemon process.",
    read: (snapshot) => snapshot.memory.rss,
  },
  {
    name: "calyx.daemon.memory.heap_total",
    kind: "observableGauge",
    unit: "By",
    description: "V8 heap total for the calyx daemon.",
    read: (snapshot) => snapshot.memory.heap_total,
  },
  {
    name: "calyx.daemon.memory.heap_used",
    kind: "observableGauge",
    unit: "By",
    description: "V8 heap used by the calyx daemon.",
    read: (snapshot) => snapshot.memory.heap_used,
  },
  {
    name: "calyx.daemon.memory.external",
    kind: "observableGauge",
    unit: "By",
    description: "External memory held by the calyx daemon.",
    read: (snapshot) => snapshot.memory.external,
  },
  {
    name: "calyx.daemon.memory.array_buffers",
    kind: "observableGauge",
    unit: "By",
    description: "ArrayBuffer memory held by the calyx daemon.",
    read: (snapshot) => snapshot.memory.array_buffers,
  },
  {
    name: "calyx.daemon.event_loop.lag.p50",
    kind: "observableGauge",
    unit: "ms",
    description: "p50 event loop lag since the last collection window.",
    read: (snapshot) => snapshot.eventLoop.lag_ms_p50,
  },
  {
    name: "calyx.daemon.event_loop.lag.p99",
    kind: "observableGauge",
    unit: "ms",
    description: "p99 event loop lag since the last collection window.",
    read: (snapshot) => snapshot.eventLoop.lag_ms_p99,
  },
  {
    name: "calyx.daemon.connections.sse_subscribers",
    kind: "observableGauge",
    unit: "{connection}",
    description: "Active SSE subscribers on the run-service daemon.",
    read: (snapshot) => snapshot.running.sse_subscribers,
  },
  {
    name: "calyx.daemon.connections.codex_sessions",
    kind: "observableGauge",
    unit: "{session}",
    description: "Active codex app-server sessions held by the daemon.",
    read: (snapshot) => snapshot.running.codex_app_server_sessions,
  },
  {
    name: "calyx.daemon.runs.active",
    kind: "observableGauge",
    unit: "{run}",
    description: "Active runs currently tracked by the run service.",
    read: (snapshot) => snapshot.running.active_runs,
  },
  {
    name: "calyx.daemon.runs.serviced",
    kind: "observableCounter",
    unit: "{run}",
    description:
      "Runs serviced since daemon start; resets on daemon restart (observed each export tick).",
    read: (snapshot) => snapshot.running.total_serviced_since_start,
  },
];

function shortHostname(hostname: () => string): string {
  const raw = hostname().trim();
  const shortName = raw.split(".")[0]?.trim();
  return shortName || "unknown";
}

export function buildResourceAttributes(
  state: OtelMetricsServerState,
  hostname: () => string,
): Record<string, string> {
  const hostName = shortHostname(hostname);
  return {
    "service.name": OTEL_DAEMON_SERVICE_NAME,
    "service.version": state.buildInfo.git_head,
    "service.instance.id": `${state.daemonId}@${hostName}`,
    [OTEL_DAEMON_HOST_NAME_ATTRIBUTE]: hostName,
    [OTEL_DAEMON_CALYX_HOST_ATTRIBUTE]: hostName,
    [OTEL_DAEMON_ID_ATTRIBUTE]: state.daemonId,
    "calyx.build.git_head": state.buildInfo.git_head,
    "calyx.build.built_at": state.buildInfo.built_at,
    "calyx.schema_version": OTEL_DAEMON_SCHEMA_VERSION,
  };
}

export function buildDaemonMetricAttributes(
  resourceAttributes: Record<string, string>,
): Record<string, string> {
  const hostName =
    resourceAttributes[OTEL_DAEMON_HOST_NAME_ATTRIBUTE]
    ?? resourceAttributes[OTEL_DAEMON_CALYX_HOST_ATTRIBUTE]
    ?? "unknown";
  return {
    [OTEL_DAEMON_HOST_NAME_ATTRIBUTE]: hostName,
    [OTEL_DAEMON_CALYX_HOST_ATTRIBUTE]:
      resourceAttributes[OTEL_DAEMON_CALYX_HOST_ATTRIBUTE] ?? hostName,
    [OTEL_DAEMON_ID_ATTRIBUTE]: resourceAttributes[OTEL_DAEMON_ID_ATTRIBUTE] ?? "unknown",
  };
}

function noopHandle(): DaemonMetricsExporterHandle {
  return {
    initialized: false,
    endpoint: undefined,
    async shutdown(): Promise<void> {
      return;
    },
  };
}

/**
 * Wrap a push exporter so runtime export failures are gated: the first
 * failure warns with context, subsequent failures stay quiet until a
 * successful export resets the gate. Success/failure codes are passed
 * through unchanged to the SDK callback.
 */
function wrapExporterWithGatedLogging(
  inner: OtelPushMetricExporterLike,
  endpoint: string,
  logger: OtelMetricsLogger,
): OtelPushMetricExporterLike {
  let lastExportOk = true;
  const wrapped: OtelPushMetricExporterLike = {
    export(metrics, resultCallback) {
      inner.export(metrics, (result) => {
        if (result.code === 0) {
          if (!lastExportOk) {
            logger.info("calyx.daemon otel metrics export recovered", { endpoint });
          }
          lastExportOk = true;
        } else if (lastExportOk) {
          logger.warn("calyx.daemon otel metrics export failed", {
            endpoint,
            error: result.error instanceof Error ? result.error.message : String(result.error),
          });
          lastExportOk = false;
        }
        resultCallback(result);
      });
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  if (inner.selectAggregationTemporality) {
    wrapped.selectAggregationTemporality = (instrumentType) =>
      inner.selectAggregationTemporality!(instrumentType);
  }
  if (inner.selectAggregation) {
    wrapped.selectAggregation = (instrumentType) => inner.selectAggregation!(instrumentType);
  }
  return wrapped;
}

/**
 * Initialize the daemon-side OTel metrics exporter.
 *
 * Respects `CALYX_DISABLE_OTEL=1` by returning a no-op handle before any
 * dynamic SDK import. On init failure the daemon keeps running; the returned
 * handle is a no-op and the otelMetricsV1 feature flag is not advertised by
 * callers that gate on a successful init.
 */
export async function initDaemonMetricsExporter(
  options: InitDaemonMetricsExporterOptions,
): Promise<DaemonMetricsExporterHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger();

  if (env["CALYX_DISABLE_OTEL"] === "1") {
    logger.info("calyx.daemon otel metrics disabled via CALYX_DISABLE_OTEL=1");
    return noopHandle();
  }

  const endpoint = resolveOtelEndpoint(env);
  const exportIntervalMs = resolveExportIntervalMs(env);
  const hostnameFn = options.hostname ?? osHostname;
  const resourceAttributes = buildResourceAttributes(options.state, hostnameFn);
  const daemonMetricAttributes = buildDaemonMetricAttributes(resourceAttributes);

  let exporterFactory = options.exporterFactory;
  let sdkMetrics: typeof import("@opentelemetry/sdk-metrics");
  let resources: typeof import("@opentelemetry/resources");

  try {
    sdkMetrics = await import("@opentelemetry/sdk-metrics");
    resources = await import("@opentelemetry/resources");
    if (!exporterFactory) {
      const mod = await import("@opentelemetry/exporter-metrics-otlp-http");
      exporterFactory = (config) =>
        new mod.OTLPMetricExporter({
          url: config.url,
          timeoutMillis: config.timeoutMillis,
        }) as unknown as OtelPushMetricExporterLike;
    }
  } catch (error) {
    logger.warn("calyx.daemon otel metrics init failed: SDK import error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return noopHandle();
  }

  let rawExporter: OtelPushMetricExporterLike;
  try {
    rawExporter = exporterFactory({
      url: endpoint,
      timeoutMillis: OTEL_DAEMON_EXPORT_TIMEOUT_MS,
    });
  } catch (error) {
    logger.warn("calyx.daemon otel metrics init failed: exporter construction", {
      error: error instanceof Error ? error.message : String(error),
    });
    return noopHandle();
  }
  const exporter = wrapExporterWithGatedLogging(rawExporter, endpoint, logger);

  let meterProvider: import("@opentelemetry/sdk-metrics").MeterProvider;
  try {
    const reader = new sdkMetrics.PeriodicExportingMetricReader({
      exporter: exporter as unknown as import("@opentelemetry/sdk-metrics").PushMetricExporter,
      exportIntervalMillis: exportIntervalMs,
      exportTimeoutMillis: OTEL_DAEMON_EXPORT_TIMEOUT_MS,
    });
    meterProvider = new sdkMetrics.MeterProvider({
      resource: resources.resourceFromAttributes(resourceAttributes),
      readers: [reader],
    });
  } catch (error) {
    logger.warn("calyx.daemon otel metrics init failed: provider construction", {
      error: error instanceof Error ? error.message : String(error),
    });
    return noopHandle();
  }

  const meter = meterProvider.getMeter(OTEL_DAEMON_METER_NAME);
  const observables: Array<{
    descriptor: DaemonMetricsInstrumentDescriptor;
    observable: import("@opentelemetry/api").Observable;
  }> = [];
  for (const descriptor of DAEMON_METRICS_INSTRUMENTS) {
    const meterOptions = { unit: descriptor.unit, description: descriptor.description };
    const observable =
      descriptor.kind === "observableGauge"
        ? meter.createObservableGauge(descriptor.name, meterOptions)
        : descriptor.kind === "observableCounter"
          ? meter.createObservableCounter(descriptor.name, meterOptions)
          : meter.createObservableUpDownCounter(descriptor.name, meterOptions);
    observables.push({ descriptor, observable });
  }
  const infraErrorObservable = meter.createObservableGauge(
    DAEMON_INFRA_ERROR_CURRENT_METRIC.name,
    {
      unit: DAEMON_INFRA_ERROR_CURRENT_METRIC.unit,
      description: DAEMON_INFRA_ERROR_CURRENT_METRIC.description,
    },
  );

  const readMemory = options.readMemory ?? readDaemonMemoryMetrics;
  const readEventLoop = options.readEventLoop ?? readEventLoopLagMetrics;
  const collectSnapshot = async (): Promise<DaemonMetricsSnapshot> => ({
    memory: readMemory(),
    eventLoop: readEventLoop(),
    running: await options.service.runningMetrics(),
    infraErrors: await (options.service.infraErrorCensus?.() ?? Promise.resolve([])),
  });

  let lastSnapshotOk = true;
  const batchCallback: import("@opentelemetry/api").BatchObservableCallback = async (result) => {
    let snapshot: DaemonMetricsSnapshot;
    try {
      snapshot = await collectSnapshot();
    } catch (error) {
      if (lastSnapshotOk) {
        logger.warn("calyx.daemon otel metrics snapshot collection failed", {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof InfraErrorCensusAuthorityError
            ? {
                error_code: error.code,
                authority_ambiguity_count: error.audit.ambiguity_count,
              }
            : {}),
        });
      }
      lastSnapshotOk = false;
      return;
    }
    if (!lastSnapshotOk) {
      logger.info("calyx.daemon otel metrics snapshot collection recovered");
    }
    lastSnapshotOk = true;
    for (const { descriptor, observable } of observables) {
      result.observe(observable, descriptor.read(snapshot), daemonMetricAttributes);
    }
    for (const point of snapshot.infraErrors) {
      result.observe(infraErrorObservable, point.count, {
        ...daemonMetricAttributes,
        layer: point.failure_layer,
        reason: point.failure_reason,
        host: point.host,
        kernel: point.kernel,
        backend: point.backend,
      });
    }
  };

  const callbackObservables = [
    ...observables.map((entry) => entry.observable),
    infraErrorObservable,
  ];
  meter.addBatchObservableCallback(
    batchCallback,
    callbackObservables,
  );

  logger.info("calyx.daemon otel metrics exporter initialized", {
    endpoint,
    export_interval_ms: exportIntervalMs,
    instruments: DAEMON_METRICS_INSTRUMENTS.length + 1,
  });

  let shuttingDown = false;
  return {
    initialized: true,
    endpoint,
    async shutdown(): Promise<void> {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      // MeterProvider.shutdown forces a final flush; the batch callback must
      // still be registered at that point so the last export has data.
      try {
        await meterProvider.shutdown();
      } catch (error) {
        logger.warn("calyx.daemon otel metrics shutdown raised", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        meter.removeBatchObservableCallback(
          batchCallback,
          callbackObservables,
        );
      } catch {
        // best-effort cleanup
      }
    },
  };
}
