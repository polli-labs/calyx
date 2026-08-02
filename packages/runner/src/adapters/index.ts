/**
 * @polli-labs/calyx-runner — Adapter factory.
 *
 * Deterministic mapping from RunSpec.backend → BackendAdapter instance.
 * New backends are added by explicit registry composition.
 *
 * @see docs/architecture/async-runner-vnext-contracts.md
 */

import type { BackendAdapter } from "./types.js";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude.js";

/** Union of per-adapter option types, keyed by backend name. */
export interface AdapterFactoryOptions {
  claude?: ClaudeAdapterOptions;
}

/** Supported backend names (compile-time exhaustive). */
export type SupportedBackend = "claude" | "codex";

export interface RuntimeAdapterFactory {
  (): BackendAdapter;
  activeSessionCount?: () => number;
  steerCodexAppServerTurn?: (input: CodexAppServerSteerInput) => Promise<CodexAppServerSteerResult>;
}

export interface RuntimeAdapterRegistry {
  register(backend: string, factory: RuntimeAdapterFactory): void;
  create(backend: string): BackendAdapter;
  has(backend: string): boolean;
  list(): readonly string[];
  activeSessionCount?(backend: string): number;
  steerCodexAppServerTurn?(input: CodexAppServerSteerInput): Promise<CodexAppServerSteerResult>;
}

export interface CodexAppServerSteerInput {
  run_id: string;
  thread_id: string;
  expected_turn_id: string;
  input: readonly Record<string, unknown>[];
  timeout_ms?: number | undefined;
}

export interface CodexAppServerSteerResult {
  turn_id: string;
  response?: unknown;
}

class DefaultRuntimeAdapterRegistry implements RuntimeAdapterRegistry {
  private readonly factories = new Map<string, RuntimeAdapterFactory>();

  register(backend: string, factory: RuntimeAdapterFactory): void {
    this.factories.set(backend, factory);
  }

  create(backend: string): BackendAdapter {
    const factory = this.factories.get(backend);
    if (!factory) {
      throw new Error(
        `Unsupported backend "${backend}". Registered: ${this.list().join(", ") || "(none)"}`,
      );
    }
    return factory();
  }

  has(backend: string): boolean {
    return this.factories.has(backend);
  }

  list(): readonly string[] {
    return [...this.factories.keys()].sort();
  }

  activeSessionCount(backend: string): number {
    return this.factories.get(backend)?.activeSessionCount?.() ?? 0;
  }

  async steerCodexAppServerTurn(input: CodexAppServerSteerInput): Promise<CodexAppServerSteerResult> {
    const steer = this.factories.get("codex")?.steerCodexAppServerTurn;
    if (!steer) {
      throw Object.assign(new Error("Registered Codex adapter does not expose app-server turn steering."), {
        code: "transport_unavailable",
      });
    }
    return await steer(input);
  }
}

/**
 * Create an empty runtime adapter registry.
 */
export function createRuntimeAdapterRegistry(): RuntimeAdapterRegistry {
  return new DefaultRuntimeAdapterRegistry();
}

/** All logical backend names currently supported by runner contracts. */
export const SUPPORTED_BACKENDS: readonly SupportedBackend[] = ["claude", "codex"];

export function registerBuiltInRuntimeAdapters(
  registry: RuntimeAdapterRegistry,
  opts?: AdapterFactoryOptions,
): RuntimeAdapterRegistry {
  registry.register("claude", () => new ClaudeAdapter(opts?.claude));
  return registry;
}

export function createBuiltInRuntimeAdapterRegistry(
  opts?: AdapterFactoryOptions,
): RuntimeAdapterRegistry {
  return registerBuiltInRuntimeAdapters(createRuntimeAdapterRegistry(), opts);
}

/**
 * Create an adapter instance for the given backend.
 *
 * @throws Error if the backend name is not registered.
 */
export function createAdapter(
  backend: string,
  opts?: AdapterFactoryOptions,
): BackendAdapter {
  return createBuiltInRuntimeAdapterRegistry(opts).create(backend);
}
