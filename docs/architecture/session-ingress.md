# Exact session ingress

Session ingress is the live acceleration layer shared by correspondence and
monitor wakes. It is not a second inbox and it does not weaken durable message
or monitor storage.

## Laws

- Durable storage is the correctness floor. A bare `calyx msg send` only
  spools; it never launches/resumes a turn and never claims or acknowledges a
  message.
- One `calyx.session-wake/v1` envelope carries only a delivery id, exact
  recipient activity id, selected binding id/generation, durable pointer
  kind/id, first pull command, and creation time. Message and monitor bodies
  never cross the ingress transport.
- Resolution is exact-activity only. There is no newest-session, PID, fixed
  port, caller URL, or cross-session fallback.
- Receiver acceptance is `wake_delivered`, not `claimed` or `acked`. Handling
  remains an explicit inbox pull followed by acknowledgement.
- Binding generation is authority. Renewal and retirement must match both the
  binding id and generation, so an old heartbeat or `SessionEnd` cannot mutate
  a replacement session. The router resolves lease expiry from destination
  time, and the private receiver holds a state-store fence while verifying the
  selected binding is still current before accepting the pointer.

## Lifecycle

`prepareSessionIngressLaunch` creates a one-use launch nonce, binding
generation, and opaque endpoint reference. Only the nonce enters the selected
harness launch environment. `exchangeSessionIngressLaunch` consumes it exactly
once after `SessionStart` supplies the real
`interactive:<codex|claude>:<session-id>` identity. It atomically retires any
older active generation for that exact activity.

`renewSessionIngressBinding` extends a matching live lease.
`retireSessionIngressBinding` immediately retires a matching generation on
`SessionEnd`; `expireSessionIngressBindings` covers crashes and missing hooks.
Ordinary sessions never call this lifecycle and therefore remain unbound and
durable-only.

The named launcher/hook configuration that opts a Claude conductor into this
lifecycle belongs to POL-2007. It must not add a custom channel or receiver to
ordinary launches.

## Private transport

The initial adapter is a per-session Unix socket in a mode-0700 Calyx runtime
directory. The socket is mode 0600. Durable state stores only the opaque
endpoint reference; the destination process derives the local path inside the
adapter. No message, monitor, activity row, wake envelope, CLI output, or
delivery receipt exposes the socket path or a reusable credential.

`routeSessionWake` owns binding resolution, pointer-capability validation,
idempotent delivery admission, private transport, and typed completion. Both
`msg --wake` and monitor wakes owned by an exact interactive activity call it.
An exact-owner monitor uses this shared router for agent acceleration; legacy
`codex_*` and `claude_*` monitor adapters are skipped while distinct human
notification bindings still run.
The unique pointer-kind/pointer-id/activity key prevents reconnects or repeated
router calls from delivering the same attempt twice.

## Partial success

Once durable spooling succeeds, live acceleration cannot make the operation
incorrect. No binding, expired binding, unsupported pointer/adapter, or adapter
failure persists a failed delivery attempt while the message or monitor wake
remains pullable. `msg --wake` returns exit 0 with
`delivery_state=spooled` and a distinct non-success `wake_state`; callers must
not retry the whole durable send.

Cross-host callers first enqueue the message in the sender outbox and use the
authenticated daemon-to-daemon internal receive route. Only an exact
`calyx.msg-receive/v1` acknowledgement proving destination durable admission
allows the caller to submit the pointer to the destination host's authenticated
admin control plane. The destination router independently rejects a message
pointer absent from its local inbox before private IPC.
`admin.session-wake.deliver` accepts only the exact activity, deterministic
delivery id, durable pointer, and creation timestamp. The CLI resolves its URL
and credential from named-host truth, verifies the daemon advertises
`session.wake/v1`, and never accepts a caller URL or bearer override for this
path. Destination unavailable, destination unsupported, and transport failure
are distinct durable-success wake outcomes. The wake itself has no outbox or
remote-pull side channel; the preceding message transport reuses the canonical
authenticated correspondence outbox.
