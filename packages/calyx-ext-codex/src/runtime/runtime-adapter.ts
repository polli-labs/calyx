import type {
  AdapterCapabilities,
  AdapterSession,
  AdapterStartOptions,
  BackendAdapter,
  CodexAppServerSteerInput,
  CodexAppServerSteerResult,
  RuntimeAdapterFactory,
} from "@polli-labs/calyx-runner";

import {
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions,
} from "./app-server-adapter.js";
import {
  LegacyExecCodexAdapter,
  type LegacyExecCodexAdapterOptions,
} from "./legacy-exec-adapter.js";

export interface CodexRuntimeAdapterOptions extends CodexAppServerAdapterOptions {
  outputCaptureLegacy?: LegacyExecCodexAdapterOptions;
}

/**
 * Production Codex adapter router.
 *
 * Ordinary runs retain app-server sessions and live steer. Typed terminal
 * captures deliberately use the hardened one-shot exec transport because it
 * can disable inherited user MCP/plugin configuration and persist no session.
 */
export class CodexRuntimeAdapter implements BackendAdapter {
  readonly name = "codex";
  readonly capabilities: AdapterCapabilities;
  private readonly appServer: CodexAppServerAdapter;
  private readonly outputCaptureExec: LegacyExecCodexAdapter;

  constructor(options: CodexRuntimeAdapterOptions = {}) {
    const { outputCaptureLegacy, ...appServerOptions } = options;
    this.appServer = new CodexAppServerAdapter(appServerOptions);
    this.outputCaptureExec = new LegacyExecCodexAdapter(outputCaptureLegacy);
    this.capabilities = this.appServer.capabilities;
  }

  async startSession(options: AdapterStartOptions): Promise<AdapterSession> {
    if (options.output_capture) {
      return this.outputCaptureExec.startSession(options);
    }
    return this.appServer.startSession(options);
  }

  async stop(sessionOrRunId: string): Promise<void> {
    await Promise.all([
      this.appServer.stop(sessionOrRunId),
      this.outputCaptureExec.stop(sessionOrRunId),
    ]);
  }

  activeSessionCount(): number {
    return this.appServer.activeSessionCount();
  }

  async steerCodexAppServerTurn(input: CodexAppServerSteerInput): Promise<CodexAppServerSteerResult> {
    return this.appServer.steerCodexAppServerTurn(input);
  }
}

export function createCodexRuntimeAdapterFactory(
  options: CodexRuntimeAdapterOptions = {},
): RuntimeAdapterFactory {
  const adapter = new CodexRuntimeAdapter(options);
  const factory: RuntimeAdapterFactory = (): CodexRuntimeAdapter => adapter;
  factory.activeSessionCount = (): number => adapter.activeSessionCount();
  factory.steerCodexAppServerTurn = (input): Promise<CodexAppServerSteerResult> =>
    adapter.steerCodexAppServerTurn(input);
  return factory;
}
