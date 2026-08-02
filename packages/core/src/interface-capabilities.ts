export type InterfaceCapabilityEffectLevel =
  | "none"
  | "read"
  | "write"
  | "read_write"
  | "write_on_apply"
  | "write_without_dry_run";

/** Effects performed by the capability implementation on the receiving host. */
export interface InterfaceCapabilityEffectSet {
  local_files: InterfaceCapabilityEffectLevel;
  local_state: InterfaceCapabilityEffectLevel;
  remote_tracker: InterfaceCapabilityEffectLevel;
  remote_provider: InterfaceCapabilityEffectLevel;
  process_launch: boolean;
  creates_worktree: boolean;
  dispatches_run: boolean;
  dry_run_default: boolean;
  notes?: string;
}

export type InterfaceCapabilityReceiverEffects =
  | { kind: "uniform"; effects: InterfaceCapabilityEffectSet }
  | {
    kind: "by_success";
    branches: readonly {
      status: 200 | 202;
      condition?: {
        request_accept?: string;
        outcome?: string;
      };
      effects: InterfaceCapabilityEffectSet;
    }[];
  };

export interface InterfaceCapabilityContract {
  id: string;
  domain: string;
  /** Effects at the local receiver; a conservative union when operation_receiver_effects is present. */
  receiver_effects: InterfaceCapabilityReceiverEffects;
  /** Real CLI manifest sibling when this capability has one. */
  cli_sibling_id?: string;
  /** Real CLI manifest siblings when one capability has multiple projections. */
  cli_sibling_ids?: readonly string[];
  /** The CLI invokes the same local implementation boundary with the same effects. */
  cli_effects_match_receiver?: boolean;
  /** Exact receiver effects for operations whose capability-level effects are a conservative union. */
  operation_receiver_effects?: Readonly<Record<string, InterfaceCapabilityReceiverEffects>>;
}

function effectSet(
  overrides: Partial<InterfaceCapabilityEffectSet> = {},
): InterfaceCapabilityEffectSet {
  return {
    local_files: "none",
    local_state: "none",
    remote_tracker: "none",
    remote_provider: "none",
    process_launch: false,
    creates_worktree: false,
    dispatches_run: false,
    dry_run_default: false,
    ...overrides,
  };
}

function uniform(
  overrides: Partial<InterfaceCapabilityEffectSet> = {},
): InterfaceCapabilityReceiverEffects {
  return { kind: "uniform", effects: effectSet(overrides) };
}

function contract(
  id: string,
  domain: string,
  receiverEffects: InterfaceCapabilityReceiverEffects,
  options: Pick<
    InterfaceCapabilityContract,
    "cli_sibling_id" | "cli_sibling_ids" | "cli_effects_match_receiver" | "operation_receiver_effects"
  > = {},
): InterfaceCapabilityContract {
  return {
    id,
    domain,
    receiver_effects: receiverEffects,
    ...options,
  };
}

const FILE_READ = uniform({ local_files: "read" });
const FILE_STATE_READ = uniform({ local_files: "read", local_state: "read" });
const FILE_STATE_PROJECTED_READ = uniform({
  local_files: "read",
  local_state: "read_write",
  notes: "Reads authoritative files and may atomically materialize or repair the derived SQLite projection before returning.",
});
const STATE_READ = uniform({ local_state: "read" });
const STATE_READ_WRITE = uniform({ local_state: "read_write" });
const ACTIVITY_MARK_CREATE = uniform({
  local_files: "read",
  local_state: "read_write",
  notes: "Reads the authoritative local consumer-visible activity source to validate a fresh target, then writes only the SQLite mark and request-audit authorities.",
});
const DAEMON_HEALTH_READ = uniform({
  local_files: "read",
  local_state: "read_write",
  process_launch: true,
  notes: "Reads run, daemon-descriptor, promoted-build, and interactive-session state; may materialize the derived run-index projection; then launches git rev-parse to report the source checkout HEAD.",
});
const DAEMON_METRICS_READ = uniform({
  local_files: "read_write",
  local_state: "read_write",
  notes: "Reads daemon and active-run metrics; may materialize the derived run-index projection and create per-run execution-mutex SQLite files while observing ownership.",
});
const RUNTIME_CONFIG_APPLY = uniform({
  local_files: "read_write",
  local_state: "read_write",
});
const RUN_DISPATCH = uniform({
  local_files: "read_write",
  local_state: "read_write",
  process_launch: true,
  creates_worktree: true,
  dispatches_run: true,
  notes: "Persists the receiver-owned idempotency binding before dispatching the run effect.",
});
const RUN_RECONCILE = uniform({
  local_files: "read_write",
  local_state: "read_write",
  notes: "Rebuilds filesystem projections and reconciles terminal-run lease state in SQLite.",
});
const RUN_STOP = uniform({
  local_files: "read_write",
  local_state: "read_write",
  notes: "Mutates cancellation evidence and the receiver-owned SQLite request-audit ledger.",
});
const RUN_OBSERVATION = uniform({
  local_files: "read",
  process_launch: true,
  notes: "Reads bounded run evidence and launches ps/nvidia-smi collectors for process, GPU, and host-resource observations.",
});
const WORK_OBSERVE = uniform({
  local_files: "read",
  local_state: "read_write",
  process_launch: true,
  notes: "Conservative union for run observation projections, including first-use or corruption-recovery SQLite projection writes; exact effects are operation-specific.",
});
const MESSAGE_RECEIVE = uniform({
  local_files: "write",
  local_state: "read_write",
  notes: "Persists recipient state and the durable message receipt mirror on the receiving host.",
});
const SESSION_WAKE_DELIVER = uniform({
  local_files: "read",
  local_state: "read_write",
  notes: "Resolves one exact generation-bound activity binding, records an idempotent pointer delivery attempt, and connects only to daemon-local private IPC. Transport acceptance does not claim or acknowledge the durable pointer.",
});
const MESSAGE_SEND: InterfaceCapabilityReceiverEffects = {
  kind: "by_success",
  branches: [
    {
      status: 200,
      condition: { outcome: "local_inert" },
      effects: effectSet({
        local_files: "write",
        local_state: "read_write",
        notes: "Persists inert correspondence and its durable receipt mirror in the local recipient store.",
      }),
    },
    {
      status: 202,
      condition: { outcome: "cross_host_outbox" },
      effects: effectSet({
        local_files: "write",
        local_state: "read_write",
        remote_provider: "write_without_dry_run",
        notes: "Persists the local outbox operation and receipt mirror; the daemon forwarder delivers it to the recipient daemon.",
      }),
    },
  ],
};

/** Canonical capability identity and receiver-effect truth for HTTP projections. */
export const INTERFACE_CAPABILITY_CONTRACTS = {
  "work.observe": contract("work.observe", "run", WORK_OBSERVE, {
    operation_receiver_effects: {
      "work.list": FILE_STATE_PROJECTED_READ,
      "work.get": FILE_STATE_READ,
      "work.observe": STATE_READ,
      "admin.events": STATE_READ,
      "admin.run.list": FILE_STATE_PROJECTED_READ,
      "admin.run.get": FILE_READ,
      "admin.run.logs": FILE_READ,
      "admin.run.events": FILE_STATE_PROJECTED_READ,
      "admin.run.observation": RUN_OBSERVATION,
      "admin.run.receipt": FILE_READ,
    },
    cli_sibling_ids: ["run.ps", "run.subscribe", "run.status", "run.logs", "run.doctor", "run.receipt"],
  }),
  recall: contract("recall", "activity", FILE_STATE_PROJECTED_READ, {
    operation_receiver_effects: {
      "activity.list": FILE_STATE_PROJECTED_READ,
      "activity.get": FILE_READ,
      "activity.messages": FILE_READ,
      "activity.turns": FILE_READ,
      "activity.attachments": FILE_READ,
      "activity.text": FILE_READ,
    },
  }),
  "attention.mark": contract("attention.mark", "activity", ACTIVITY_MARK_CREATE, {
    cli_sibling_ids: ["activity.mark", "activity.unmark", "activity.marks"],
    operation_receiver_effects: {
      "attention.mark.create": ACTIVITY_MARK_CREATE,
      "attention.mark.revoke": STATE_READ_WRITE,
      "attention.mark.list": STATE_READ,
    },
  }),
  "msg.send": contract("msg.send", "msg", MESSAGE_SEND, {
    cli_sibling_id: "msg.send",
    operation_receiver_effects: {
      "admin.msg.forward": STATE_READ_WRITE,
      "admin.session-wake.deliver": SESSION_WAKE_DELIVER,
    },
  }),
  "msg.read": contract("msg.read", "msg", STATE_READ, {
    cli_sibling_ids: ["msg.inbox", "msg.thread", "msg.operation", "msg.doctor"],
    operation_receiver_effects: {
      "admin.msg.operation": STATE_READ,
    },
  }),
  "msg.receive": contract("msg.receive", "msg", MESSAGE_RECEIVE),
  "monitor.list": contract("monitor.list", "monitor", STATE_READ, { cli_sibling_id: "monitor.list" }),
  "monitor.show": contract("monitor.show", "monitor", STATE_READ, { cli_sibling_id: "monitor.show" }),
  "monitor.create": contract("monitor.create", "monitor", STATE_READ_WRITE, { cli_sibling_id: "monitor.create" }),
  "monitor.inbox": contract("monitor.inbox", "monitor", STATE_READ, {
    cli_sibling_id: "monitor.inbox",
    operation_receiver_effects: {
      "admin.monitor.claim": STATE_READ_WRITE,
    },
  }),
  "monitor.ack": contract("monitor.ack", "monitor", STATE_READ_WRITE, { cli_sibling_id: "monitor.ack" }),
  "monitor.cancel": contract("monitor.cancel", "monitor", STATE_READ_WRITE, { cli_sibling_id: "monitor.cancel" }),
  "lease.observe": contract("lease.observe", "lease", STATE_READ),
  "lease.acquire": contract("lease.acquire", "lease", STATE_READ_WRITE, { cli_sibling_id: "lease.acquire" }),
  "lease.renew": contract("lease.renew", "lease", STATE_READ_WRITE, { cli_sibling_id: "lease.renew" }),
  "lease.release": contract("lease.release", "lease", STATE_READ_WRITE, { cli_sibling_id: "lease.release" }),
  "lease.steal": contract("lease.steal", "lease", STATE_READ_WRITE, { cli_sibling_id: "lease.steal" }),
  "lease.list": contract("lease.list", "lease", STATE_READ, { cli_sibling_id: "lease.list" }),
  "lease.doctor": contract("lease.doctor", "lease", STATE_READ, { cli_sibling_id: "lease.doctor" }),
  "daemon.health": contract("daemon.health", "self", DAEMON_HEALTH_READ, {
    cli_sibling_id: "self.health",
  }),
  "self.upgrade": contract("self.upgrade", "self", FILE_READ, {
    cli_sibling_ids: ["self.upgrade", "self.upgrade.status"],
    operation_receiver_effects: {
      "admin.self-upgrade.receipt": FILE_READ,
    },
  }),
  "daemon.metrics": contract("daemon.metrics", "self", DAEMON_METRICS_READ),
  "run.launch": contract("run.launch", "run", RUN_DISPATCH, { cli_sibling_id: "run.launch" }),
  "run.reconcile": contract("run.reconcile", "run", RUN_RECONCILE, { cli_sibling_id: "run.reconcile" }),
  "run.stop": contract("run.stop", "run", RUN_STOP, { cli_sibling_id: "run.stop" }),
  "activity.overview": contract("activity.overview", "activity", FILE_READ, { cli_sibling_id: "activity.overview" }),
  "activity.show": contract("activity.show", "activity", FILE_READ, { cli_sibling_id: "activity.show" }),
  "activity.turns": contract("activity.turns", "activity", FILE_READ, { cli_sibling_id: "activity.turns" }),
  "activity.messages": contract("activity.messages", "activity", FILE_READ, { cli_sibling_id: "activity.messages" }),
  "activity.events": contract("activity.events", "activity", FILE_READ, { cli_sibling_id: "activity.events" }),
  "activity.attachments": contract("activity.attachments", "activity", FILE_READ, { cli_sibling_id: "activity.attachments" }),
  "activity.text": contract("activity.text", "activity", FILE_READ, { cli_sibling_id: "activity.text" }),
  "request-audit.read": contract("request-audit.read", "state", STATE_READ),
  "runtime-config.plan": contract("runtime-config.plan", "runtime-config", FILE_READ, {
    cli_sibling_id: "runtime-config.plan",
    cli_effects_match_receiver: true,
  }),
  "runtime-config.apply": contract("runtime-config.apply", "runtime-config", RUNTIME_CONFIG_APPLY, {
    cli_sibling_id: "runtime-config.apply",
    cli_effects_match_receiver: true,
  }),
  "runtime-config.verify": contract("runtime-config.verify", "runtime-config", FILE_READ, {
    cli_sibling_id: "runtime-config.verify",
    cli_effects_match_receiver: true,
  }),
} as const satisfies Readonly<Record<string, InterfaceCapabilityContract>>;

export type InterfaceCapabilityId = keyof typeof INTERFACE_CAPABILITY_CONTRACTS;

export function interfaceCapabilityContract(
  capabilityId: InterfaceCapabilityId,
): InterfaceCapabilityContract {
  return INTERFACE_CAPABILITY_CONTRACTS[capabilityId];
}

export function findInterfaceCapabilityContract(
  capabilityId: string,
): InterfaceCapabilityContract | undefined {
  return (INTERFACE_CAPABILITY_CONTRACTS as Readonly<Record<string, InterfaceCapabilityContract>>)[capabilityId];
}
