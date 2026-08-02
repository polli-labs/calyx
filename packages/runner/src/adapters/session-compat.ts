import { randomUUID } from "node:crypto";
import type {
  AdapterCapabilities,
  AdapterResult,
  AdapterSession,
  AdapterSpawnOptions,
  AdapterStartOptions,
  AdapterTurnHandle,
  BackendAdapter,
  SessionInfo,
  TurnEvent,
  TurnInput,
  TurnResult,
} from "./types.js";

function emptyTurnEvents(): AsyncIterable<TurnEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
      return {
        next: async () => ({ done: true, value: undefined as never }),
      };
    },
  };
}

/**
 * Wrap a legacy spawn-only adapter in a single-turn session surface.
 *
 * This preserves the public `executeRun()` entrypoint while the runner moves
 * to session-owned execution. The wrapper intentionally allows one turn only;
 * multi-turn support comes from real session adapters such as app-server.
 */
export function createSpawnCompatibilitySession(
  adapter: BackendAdapter,
  start: AdapterStartOptions,
): AdapterSession {
  const sessionId = `${adapter.name}-compat-${randomUUID()}`;
  let closed = false;
  let turnStarted = false;
  let backendSession: SessionInfo | undefined;

  return {
    id: sessionId,
    get backend_session(): SessionInfo | undefined {
      return backendSession;
    },
    capabilities: adapter.capabilities,
    async startTurn(input: TurnInput): Promise<AdapterTurnHandle> {
      if (closed) {
        throw new Error(`Adapter session ${sessionId} is already closed.`);
      }
      if (turnStarted) {
        throw new Error(
          `Adapter session ${sessionId} is a spawn-compatibility shim and only supports a single turn.`,
        );
      }
      if (!adapter.spawn) {
        throw new Error(`Adapter ${adapter.name} does not implement spawn() for compatibility mode.`);
      }

      turnStarted = true;
      const turnId = `${adapter.name}-turn-${randomUUID()}`;
      const waitPromise = (async (): Promise<TurnResult> => {
        const spawnOptions: AdapterSpawnOptions = {
          run_id: start.run_id,
          cwd: start.cwd,
          prompt: input.prompt,
          ...(start.output_capture ? { output_capture: start.output_capture } : {}),
          ...(start.backend_options ? { backend_options: start.backend_options } : {}),
          ...(start.environment_redactions
            ? { environment_redactions: start.environment_redactions }
            : {}),
          ...(start.system_prompt ? { system_prompt: start.system_prompt } : {}),
          ...(start.append_system_prompt ? { append_system_prompt: start.append_system_prompt } : {}),
          ...(start.onEvent ? { onEvent: start.onEvent } : {}),
          ...(start.onActivity ? { onActivity: start.onActivity } : {}),
          onSession: (session) => {
            backendSession = session;
            start.onSession?.(session);
          },
          ...(backendSession?.id ?? start.resume_session_id
            ? { resume_session_id: backendSession?.id ?? start.resume_session_id }
            : {}),
        };
        const result: AdapterResult = await adapter.spawn!(spawnOptions);
        if (result.session) {
          backendSession = result.session;
        }
        return {
          ...result,
          backend_turn_id: turnId,
        };
      })();

      return {
        id: turnId,
        events: emptyTurnEvents(),
        wait: async (): Promise<TurnResult> => waitPromise,
        interrupt: async (): Promise<void> => {
          await adapter.stop(start.run_id);
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      await adapter.stop(start.run_id);
    },
  };
}

export async function ensureAdapterSession(
  adapter: BackendAdapter,
  start: AdapterStartOptions,
): Promise<AdapterSession> {
  if (adapter.startSession) {
    return adapter.startSession(start);
  }
  return createSpawnCompatibilitySession(adapter, start);
}

export const NO_SESSION_CAPABILITIES: AdapterCapabilities = {
  streaming: false,
  turnControl: false,
  resumeSession: false,
  forkSession: false,
  approvals: "none",
};
