import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { CalyxBuildInfo } from "@polli-labs/calyx-core";
import { CALYX_BUILD_INFO_SCHEMA_VERSION } from "@polli-labs/calyx-core";
import {
  DAEMON_INFRA_ERROR_CURRENT_METRIC,
  DAEMON_METRICS_INSTRUMENTS,
  OTEL_DAEMON_DEFAULT_ENDPOINT,
  OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS,
  OTEL_DAEMON_EXPORT_TIMEOUT_MS,
  OTEL_DAEMON_SCHEMA_VERSION,
  buildDaemonMetricAttributes,
  buildResourceAttributes,
  initDaemonMetricsExporter,
  resolveExportIntervalMs,
  resolveOtelEndpoint,
  type InitDaemonMetricsExporterOptions,
  type OtelMetricsLogger,
  type OtelMetricsServerState,
  type OtelPushMetricExporterLike,
} from "../otel-metrics.js";
import { RunService } from "./support/test-run-service.js";

function buildInfoFixture(overrides: Partial<CalyxBuildInfo> = {}): CalyxBuildInfo {
  return {
    schema_version: CALYX_BUILD_INFO_SCHEMA_VERSION,
    git_head: "abc1234",
    built_at: "2026-04-21T00:00:00.000Z",
    package_version: "0.2.0",
    branch: "main",
    dirty: false,
    ...overrides,
  };
}

function stateFixture(overrides: Partial<OtelMetricsServerState> = {}): OtelMetricsServerState {
  return {
    daemonId: "run-serve-test",
    buildInfo: buildInfoFixture(),
    supportsFeatures: [],
    ...overrides,
  };
}

function silentLogger(): OtelMetricsLogger {
  return { info: vi.fn(), warn: vi.fn() };
}

interface FakeExporter extends OtelPushMetricExporterLike {
  exports: Array<{ metrics: unknown }>;
  shutdownCalls: number;
  forceFlushCalls: number;
  nextResult: { code: number; error?: Error };
}

function createFakeExporter(): FakeExporter {
  const exports: FakeExporter["exports"] = [];
  const exporter: FakeExporter = {
    exports,
    shutdownCalls: 0,
    forceFlushCalls: 0,
    nextResult: { code: 0 },
    export(metrics, callback) {
      exports.push({ metrics });
      // Resolve asynchronously to mimic real exporter behavior without racing
      // the reader's synchronous bookkeeping.
      queueMicrotask(() => callback(exporter.nextResult));
    },
    async forceFlush(): Promise<void> {
      exporter.forceFlushCalls += 1;
    },
    async shutdown(): Promise<void> {
      exporter.shutdownCalls += 1;
    },
  };
  return exporter;
}

interface CapturedMetricData {
  descriptor?: { name?: string };
  dataPoints?: Array<{ attributes?: Record<string, unknown>; value?: number }>;
}

interface CapturedResourceMetrics {
  scopeMetrics?: Array<{ metrics?: CapturedMetricData[] }>;
}

function exportedMetricData(exporter: FakeExporter): CapturedMetricData[] {
  return exporter.exports.flatMap(({ metrics }) => {
    const resourceMetrics = metrics as CapturedResourceMetrics;
    return resourceMetrics.scopeMetrics?.flatMap((scope) => scope.metrics ?? []) ?? [];
  });
}

function exportedMetricByName(exporter: FakeExporter, name: string): CapturedMetricData {
  const metric = exportedMetricData(exporter).find((candidate) => candidate.descriptor?.name === name);
  expect(metric).toBeDefined();
  return metric!;
}

function exportedMetricByNamePerCollection(
  exporter: FakeExporter,
  name: string,
): Array<CapturedMetricData | undefined> {
  return exporter.exports.map(({ metrics }) => {
    const resourceMetrics = metrics as CapturedResourceMetrics;
    return resourceMetrics.scopeMetrics
      ?.flatMap((scope) => scope.metrics ?? [])
      .find((candidate) => candidate.descriptor?.name === name);
  });
}

describe("resolveOtelEndpoint", () => {
  test("prefers OTEL_EXPORTER_OTLP_METRICS_ENDPOINT over base endpoint", () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector.example/v1/metrics",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://fallback.example",
    };
    expect(resolveOtelEndpoint(env)).toBe("http://collector.example/v1/metrics");
  });

  test("appends /v1/metrics to OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    expect(
      resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://base.example/" }),
    ).toBe("http://base.example/v1/metrics");
    expect(
      resolveOtelEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://base.example" }),
    ).toBe("http://base.example/v1/metrics");
  });

  test("falls back to the hardcoded blade endpoint when no env set", () => {
    expect(resolveOtelEndpoint({})).toBe(OTEL_DAEMON_DEFAULT_ENDPOINT);
  });
});

describe("resolveExportIntervalMs", () => {
  test("uses the spec default when unset", () => {
    expect(resolveExportIntervalMs({})).toBe(OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS);
  });

  test("parses OTEL_METRIC_EXPORT_INTERVAL when positive", () => {
    expect(resolveExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "5000" })).toBe(5000);
  });

  test("ignores non-positive or junk values", () => {
    expect(resolveExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "0" })).toBe(
      OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS,
    );
    expect(resolveExportIntervalMs({ OTEL_METRIC_EXPORT_INTERVAL: "abc" })).toBe(
      OTEL_DAEMON_DEFAULT_EXPORT_INTERVAL_MS,
    );
  });
});

describe("buildResourceAttributes", () => {
  test("populates service.* and calyx.* from state and short hostname", () => {
    const attrs = buildResourceAttributes(
      stateFixture({ daemonId: "run-serve-prod", buildInfo: buildInfoFixture({ git_head: "deadbeef" }) }),
      () => "blade.tail-scale.ts.net",
    );
    expect(attrs).toMatchObject({
      "service.name": "calyx.daemon",
      "service.version": "deadbeef",
      "service.instance.id": "run-serve-prod@blade",
      "host.name": "blade",
      "calyx.host": "blade",
      "calyx.daemon_id": "run-serve-prod",
      "calyx.build.git_head": "deadbeef",
      "calyx.build.built_at": "2026-04-21T00:00:00.000Z",
      "calyx.schema_version": OTEL_DAEMON_SCHEMA_VERSION,
    });
  });

  test("falls back to the raw hostname when it has no dot", () => {
    const attrs = buildResourceAttributes(stateFixture(), () => "Calebs-MacBook-Air-2");
    expect(attrs["service.instance.id"]).toBe("run-serve-test@Calebs-MacBook-Air-2");
    expect(attrs["host.name"]).toBe("Calebs-MacBook-Air-2");
    expect(attrs["calyx.host"]).toBe("Calebs-MacBook-Air-2");
  });

  test("falls back to unknown when the hostname is empty", () => {
    const attrs = buildResourceAttributes(stateFixture(), () => " ");
    expect(attrs["service.instance.id"]).toBe("run-serve-test@unknown");
    expect(attrs["host.name"]).toBe("unknown");
    expect(attrs["calyx.host"]).toBe("unknown");
  });
});

describe("buildDaemonMetricAttributes", () => {
  test("copies stable host identity from resource attributes onto metric points", () => {
    expect(
      buildDaemonMetricAttributes(
        buildResourceAttributes(
          stateFixture({ daemonId: "run-serve-prod" }),
          () => "blade.tail-scale.ts.net",
        ),
      ),
    ).toEqual({
      "host.name": "blade",
      "calyx.host": "blade",
      "calyx.daemon_id": "run-serve-prod",
    });
  });

  test("keeps a fallback host label if only the legacy calyx host is present", () => {
    expect(
      buildDaemonMetricAttributes({
        "calyx.host": "carbon",
        "calyx.daemon_id": "run-serve-prod",
      }),
    ).toEqual({
      "host.name": "carbon",
      "calyx.host": "carbon",
      "calyx.daemon_id": "run-serve-prod",
    });
  });
});

describe("initDaemonMetricsExporter: opt-out", () => {
  test("CALYX_DISABLE_OTEL=1 short-circuits before any SDK work", async () => {
    const logger = silentLogger();
    const exporterFactory = vi.fn();
    const service = { runningMetrics: vi.fn() };
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service,
      exporterFactory,
      logger,
      env: { CALYX_DISABLE_OTEL: "1" },
    });
    expect(handle.initialized).toBe(false);
    expect(handle.endpoint).toBeUndefined();
    expect(exporterFactory).not.toHaveBeenCalled();
    expect(service.runningMetrics).not.toHaveBeenCalled();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("initDaemonMetricsExporter: instrument registration", () => {
  async function initWithFake(
    overrides: Partial<InitDaemonMetricsExporterOptions> = {},
  ): Promise<{
    handle: Awaited<ReturnType<typeof initDaemonMetricsExporter>>;
    exporter: FakeExporter;
    exporterFactory: ReturnType<typeof vi.fn>;
    service: { runningMetrics: ReturnType<typeof vi.fn> };
  }> {
    const exporter = createFakeExporter();
    const exporterFactory = vi.fn(() => exporter);
    const service = {
      runningMetrics: vi.fn().mockResolvedValue({
        sse_subscribers: 2,
        codex_app_server_sessions: 1,
        active_runs: 3,
        total_serviced_since_start: 42,
      }),
    };
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service,
      exporterFactory,
      logger: silentLogger(),
      env: {},
      hostname: () => "blade.local",
      ...overrides,
    });
    return { handle, exporter, exporterFactory, service };
  }

  test("registers all 11 instruments with names, units, and kinds from the spec", () => {
    const names = DAEMON_METRICS_INSTRUMENTS.map((i) => i.name);
    expect(names).toEqual([
      "calyx.daemon.memory.rss",
      "calyx.daemon.memory.heap_total",
      "calyx.daemon.memory.heap_used",
      "calyx.daemon.memory.external",
      "calyx.daemon.memory.array_buffers",
      "calyx.daemon.event_loop.lag.p50",
      "calyx.daemon.event_loop.lag.p99",
      "calyx.daemon.connections.sse_subscribers",
      "calyx.daemon.connections.codex_sessions",
      "calyx.daemon.runs.active",
      "calyx.daemon.runs.serviced",
    ]);
    expect(DAEMON_METRICS_INSTRUMENTS).toHaveLength(11);
    const memory = DAEMON_METRICS_INSTRUMENTS.filter((i) => i.name.startsWith("calyx.daemon.memory."));
    expect(memory.every((i) => i.unit === "By" && i.kind === "observableGauge")).toBe(true);
    const lag = DAEMON_METRICS_INSTRUMENTS.filter((i) => i.name.startsWith("calyx.daemon.event_loop."));
    expect(lag.every((i) => i.unit === "ms" && i.kind === "observableGauge")).toBe(true);
    expect(DAEMON_METRICS_INSTRUMENTS.find((i) => i.name === "calyx.daemon.runs.serviced")).toMatchObject({
      kind: "observableCounter",
      unit: "{run}",
    });
    expect(DAEMON_INFRA_ERROR_CURRENT_METRIC).toMatchObject({
      name: "calyx_run_infra_error_current",
      kind: "observableGauge",
      unit: "{run}",
    });
  });

  test("passes the resolved endpoint and export timeout to the exporter factory", async () => {
    const { exporterFactory } = await initWithFake({
      env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://picked.example/v1/metrics" },
    });
    expect(exporterFactory).toHaveBeenCalledWith({
      url: "http://picked.example/v1/metrics",
      timeoutMillis: OTEL_DAEMON_EXPORT_TIMEOUT_MS,
    });
  });

  test("initialized handle advertises the resolved endpoint", async () => {
    const { handle } = await initWithFake();
    expect(handle.initialized).toBe(true);
    expect(handle.endpoint).toBe(OTEL_DAEMON_DEFAULT_ENDPOINT);
  });
});

describe("initDaemonMetricsExporter: async callbacks", () => {
  test("each export tick invokes the injected collectors on the reader's flush path", async () => {
    const exporter = createFakeExporter();
    const runningMetrics = vi.fn().mockResolvedValue({
      sse_subscribers: 7,
      codex_app_server_sessions: 4,
      active_runs: 2,
      total_serviced_since_start: 99,
    });
    const infraErrorCensus = vi.fn().mockResolvedValue([]);
    const readMemory = vi.fn().mockReturnValue({
      rss: 1,
      heap_total: 2,
      heap_used: 3,
      external: 4,
      array_buffers: 5,
    });
    const readEventLoop = vi.fn().mockReturnValue({ lag_ms_p50: 0.1, lag_ms_p99: 0.2 });

    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service: { runningMetrics, infraErrorCensus },
      exporterFactory: () => exporter,
      logger: silentLogger(),
      env: {},
      hostname: () => "blade",
      readMemory,
      readEventLoop,
    });

    // meterProvider.shutdown → reader.onShutdown → onForceFlush → _runOnce → collect
    // which invokes the batch observable callback, which pulls from all three collectors.
    await handle.shutdown();

    expect(readMemory).toHaveBeenCalled();
    expect(readEventLoop).toHaveBeenCalled();
    expect(runningMetrics).toHaveBeenCalled();
    expect(infraErrorCensus).toHaveBeenCalled();
    expect(exporter.shutdownCalls).toBe(1);
  });

  test("exports daemon gauges and counters with host attribution on data points", async () => {
    const exporter = createFakeExporter();
    const handle = await initDaemonMetricsExporter({
      state: stateFixture({ daemonId: "run-serve-prod" }),
      service: {
        runningMetrics: vi.fn().mockResolvedValue({
          sse_subscribers: 0,
          codex_app_server_sessions: 0,
          active_runs: 5,
          total_serviced_since_start: 13,
        }),
        infraErrorCensus: vi.fn().mockResolvedValue([]),
      },
      exporterFactory: () => exporter,
      logger: silentLogger(),
      env: {},
      hostname: () => "blade.tail-scale.ts.net",
    });

    await handle.shutdown();

    const activeRuns = exportedMetricByName(exporter, "calyx.daemon.runs.active");
    expect(activeRuns.dataPoints?.[0]?.attributes).toMatchObject({
      "host.name": "blade",
      "calyx.host": "blade",
      "calyx.daemon_id": "run-serve-prod",
    });
  });

  test("exports calyx_run_infra_error_current with bounded classification attributes", async () => {
    const exporter = createFakeExporter();
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service: {
        runningMetrics: vi.fn().mockResolvedValue({
          sse_subscribers: 0,
          codex_app_server_sessions: 0,
          active_runs: 0,
          total_serviced_since_start: 0,
        }),
        infraErrorCensus: vi.fn().mockResolvedValue([
          {
            failure_layer: "worktree_acquisition",
            failure_reason: "worktree_lease_refused",
            host: "carbon",
            kernel: "agent_runner",
            backend: "claude",
            count: 3,
          },
        ]),
      },
      exporterFactory: () => exporter,
      logger: silentLogger(),
      env: {},
      hostname: () => "blade",
    });

    await handle.shutdown();

    const infraError = exportedMetricByName(exporter, DAEMON_INFRA_ERROR_CURRENT_METRIC.name);
    expect(infraError.dataPoints?.[0]?.value).toBe(3);
    expect(infraError.dataPoints?.[0]?.attributes).toMatchObject({
      "host.name": "blade",
      "calyx.host": "blade",
      "calyx.daemon_id": "run-serve-test",
      layer: "worktree_acquisition",
      reason: "worktree_lease_refused",
      host: "carbon",
      kernel: "agent_runner",
      backend: "claude",
    });

    const exported = JSON.stringify(exporter.exports);
    expect(exported).toContain("calyx_run_infra_error_current");
    expect(exported).toContain("worktree_acquisition");
    expect(exported).toContain("worktree_lease_refused");
    expect(exported).toContain("carbon");
    expect(exported).toContain("agent_runner");
    expect(exported).toContain("claude");
  });

  test("long-lived provider clears retained gauge labels with explicit zero observations", async () => {
    vi.useFakeTimers();
    const exporter = createFakeExporter();
    const basePoint = {
      failure_layer: "worktree_acquisition" as const,
      host: "carbon",
      kernel: "agent_runner" as const,
      backend: "claude" as const,
    };
    let points: Array<{
      failure_layer: "worktree_acquisition";
      failure_reason: "worktree_lease_refused" | "worktree_locked";
      host: string;
      kernel: "agent_runner";
      backend: "claude";
      count: number;
    }> = [];
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service: {
        runningMetrics: vi.fn().mockResolvedValue({
          sse_subscribers: 0,
          codex_app_server_sessions: 0,
          active_runs: 0,
          total_serviced_since_start: 0,
        }),
        infraErrorCensus: vi.fn().mockImplementation(async () => points),
      },
      exporterFactory: () => exporter,
      logger: silentLogger(),
      env: { OTEL_METRIC_EXPORT_INTERVAL: String(OTEL_DAEMON_EXPORT_TIMEOUT_MS) },
      hostname: () => "carbon",
    });

    const collect = async (): Promise<CapturedMetricData | undefined> => {
      await vi.advanceTimersByTimeAsync(OTEL_DAEMON_EXPORT_TIMEOUT_MS);
      await vi.runAllTicks();
      return exportedMetricByNamePerCollection(
        exporter,
        DAEMON_INFRA_ERROR_CURRENT_METRIC.name,
      ).at(-1);
    };
    const series = (metric: CapturedMetricData | undefined): Record<string, number> =>
      Object.fromEntries((metric?.dataPoints ?? []).map((point) => [
        String(point.attributes?.reason),
        point.value ?? Number.NaN,
      ]));

    try {
      expect(await collect()).toBeUndefined();

      points = [{
        ...basePoint,
        failure_reason: "worktree_lease_refused",
        count: 1,
      }];
      expect(series(await collect())).toEqual({ worktree_lease_refused: 1 });
      expect(series(await collect())).toEqual({ worktree_lease_refused: 1 });

      points = [
        { ...basePoint, failure_reason: "worktree_lease_refused", count: 0 },
        { ...basePoint, failure_reason: "worktree_locked", count: 1 },
      ];
      expect(series(await collect())).toEqual({
        worktree_lease_refused: 0,
        worktree_locked: 1,
      });

      points = [
        { ...basePoint, failure_reason: "worktree_lease_refused", count: 0 },
        { ...basePoint, failure_reason: "worktree_locked", count: 0 },
      ];
      expect(series(await collect())).toEqual({
        worktree_lease_refused: 0,
        worktree_locked: 0,
      });
    } finally {
      await handle.shutdown();
      vi.useRealTimers();
    }
  });

  test("real sibling writer exports absent then one across intervals and restart replay", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "calyx-infra-error-exporter-"));
    const exportInfraErrorCensus = async (service: RunService): Promise<CapturedMetricData | undefined> => {
      const exporter = createFakeExporter();
      const handle = await initDaemonMetricsExporter({
        state: stateFixture(),
        service,
        exporterFactory: () => exporter,
        logger: silentLogger(),
        env: {},
        hostname: () => "blade",
      });
      await handle.shutdown();
      return exportedMetricData(exporter)
        .find((candidate) => candidate.descriptor?.name === DAEMON_INFRA_ERROR_CURRENT_METRIC.name);
    };

    try {
      const observer = new RunService({ runsRoot });
      const writer = new RunService({ runsRoot });
      await observer.prepareGlobalEventAuthority();

      const absent = await exportInfraErrorCensus(observer);
      expect(absent?.dataPoints ?? []).toEqual([]);

      const intent = writer.createIntent({
        run_id: "metric-exporter-sibling-writer",
        host: "carbon.tail-scale.ts.net",
        backend: "claude",
        prompt: "Publish through the sibling writer",
        require_execplan: false,
      });
      const queued = await writer.initializeRun(intent);
      await writer.store.writeRunRecord(intent.run_id, {
        ...queued,
        state: "infra_error",
        infra_error_classification: {
          schema_version: "infra_error_classification/v1",
          failure_layer: "worktree_acquisition",
          failure_reason: "worktree_lease_refused",
          message: "Worktree DB lease acquisition refused by an active holder.",
        },
        summary: "Sibling writer terminal infra error.",
        updated_at: "2026-04-25T15:02:00.000Z",
        completed_at: "2026-04-25T15:02:00.000Z",
      });
      await writer.reconcile();

      const firstInterval = await exportInfraErrorCensus(observer);
      expect(firstInterval?.dataPoints).toEqual([
        expect.objectContaining({
          value: 1,
          attributes: expect.objectContaining({
            layer: "worktree_acquisition",
            reason: "worktree_lease_refused",
            host: "carbon",
            kernel: "agent_runner",
            backend: "claude",
          }),
        }),
      ]);

      const repeatedInterval = await exportInfraErrorCensus(observer);
      expect(repeatedInterval?.dataPoints?.map((point) => point.value)).toEqual([1]);

      const restartedObserver = new RunService({ runsRoot });
      await restartedObserver.prepareGlobalEventAuthority();
      const restartReplay = await exportInfraErrorCensus(restartedObserver);
      expect(restartReplay?.dataPoints?.map((point) => point.value)).toEqual([1]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe("initDaemonMetricsExporter: shutdown", () => {
  test("shutdown flushes the reader and calls exporter shutdown exactly once", async () => {
    const exporter = createFakeExporter();
    const service = {
      runningMetrics: vi.fn().mockResolvedValue({
        sse_subscribers: 0,
        codex_app_server_sessions: 0,
        active_runs: 0,
        total_serviced_since_start: 0,
      }),
    };
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service,
      exporterFactory: () => exporter,
      logger: silentLogger(),
      env: {},
      hostname: () => "blade",
    });

    await handle.shutdown();
    expect(exporter.shutdownCalls).toBe(1);

    await handle.shutdown();
    expect(exporter.shutdownCalls).toBe(1);
  });
});

describe("initDaemonMetricsExporter: exporter construction failure", () => {
  test("returns a no-op handle and logs a warning when the factory throws", async () => {
    const warn = vi.fn();
    const handle = await initDaemonMetricsExporter({
      state: stateFixture(),
      service: { runningMetrics: vi.fn() },
      exporterFactory: () => {
        throw new Error("boom");
      },
      logger: { info: vi.fn(), warn },
      env: {},
      hostname: () => "blade",
    });
    expect(handle.initialized).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exporter construction"),
      expect.objectContaining({ error: "boom" }),
    );
  });
});
