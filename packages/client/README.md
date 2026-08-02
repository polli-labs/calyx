# `@polli-labs/calyx-client`

Generated, capability-separated ESM transport for the Calyx HTTP control
plane. The root and `./consumer` entrypoints expose only consumer capabilities;
`./admin` is the explicit privileged entrypoint and exposes consumer plus admin
capabilities.

```ts
import { createCalyxClient } from "@polli-labs/calyx-client";

const app = createCalyxClient({
  baseUrl: "https://blade.example/calyx",
  bearerToken: async () => obtainToken(),
});

const turns = await app.consumer.activity.turns({
  path: { activityId: "interactive:codex:session" },
  query: { limit: "20" },
});
```

```ts
import { createCalyxAdminClient } from "@polli-labs/calyx-client/admin";

const operator = createCalyxAdminClient({ baseUrl, bearerToken });
await operator.consumer.work.list();
await operator.admin.run.launch({ body: portableRunIntent });
```

There is no internal-runtime, raw request, arbitrary URL/header, or generated
deep-import entrypoint. The generator consumes only exact canonical
`calyx-openapi.json` bytes—the repo generator's pretty form or compact
`JSON.stringify` output—and rejects parse/re-emit drift before trusting their
digest. Runtime
serialization copies only declared request properties. Non-empty
schema-valued `additionalProperties` are typed dictionaries and preserve
dynamic keys recursively under that value schema; arbitrary `true`/`{}` maps
require the named `explicit-json-metadata` extension. Response decoding checks
an intentional, generator-gated JSON Schema subset: references; object,
array, scalar, required, union, negation, bounds, pattern, literal, enum, and
the named `x-calyx-*` contracts used by the wire model. The compiler rejects a
new validation keyword rather than silently generating a runtime that ignores
it. `date-time` and `uri` are validation contracts executed on requests and
responses; `binary` is admitted only on an exact bytes-success media schema.
`default` and the remaining admitted annotation keywords remain documentary.
Every declared integer is explicitly intersected with JavaScript's safe-
integer range; response validation also proves the original JSON number token
is exactly that integer before adopting its binary64 value. Closed numeric
literals likewise compare the token's exact mathematical decimal value before
adoption. Additive fields and
open enum values are preserved where their generated policies say so.

`calyx.error/v1` envelopes have a package-wide fixed wire ceiling of 1 MiB,
named internally as `CALYX_ERROR_ENVELOPE_MAX_BYTES` for auditability. It is not
a caller-configurable public API. Successful JSON and binary response bounds
remain operation-specific generated contracts.

Generated path parameters are closed to string schemas and encoded as exactly
one segment. Raw OpenAPI parameter names remain raw TypeScript object keys;
nullable, cross-wire literals, compound schemas, malformed Unicode scalar
text, overlong values, and any grammar admitting a pure dot segment fail
generation. Pure `.` and `..` are unrepresentable because standards-compliant
URL parsing normalizes them even when percent-encoded. The client independently
rejects those values and lone UTF-16 surrogates with
`CalyxClientConfigurationError` before resolving credentials. It also enforces
the document's 8,000-byte limit on the complete encoded request target
(proxy base path, route, substituted segments, and query) before resolving a
credential, and applies the same law to authenticated recovery receipts.

Potentially admitted keyed writes use a recovery loop distinct from ordinary
retry. Exhaustion returns an operation-bound
`calyx.client-indeterminate-result/v1` receipt containing exact request bytes.
Those bytes may contain application secrets, so every receipt is typed
`sensitive_request_payload`. Automatic persistence requires a `recoveryStore`
whose `custody` is explicitly `encrypted_access_controlled`; the store is
responsible for encryption, access control, retention, and deletion. A store
also requires a separate 32-byte `recoveryReceiptIntegrityKey`. The client
authenticates every receipt with HMAC-SHA-256 before inspecting or replaying
its fields; without an explicit key, a process-local key limits replay to the
issuing client instance. One exact bearer credential is resolved and retained
for the complete logical operation, including ordinary retry, keyed recovery,
and SSE reconnect. A receipt carries only an opaque HMAC binding to that exact
credential. During a one-step static-token rotation, `previousBearerToken` may
retain the immediately preceding token for recovery only; ordinary operations
always use `bearerToken`. The daemon must continue accepting the preceding
credential, and operators must drain every receipt bound to it before retiring
it or advancing another rotation. Replay selects only the exact current or
retained token whose opaque binding matches; every other bearer fails locally
before `fetch`, while bearer material never enters the receipt. Call
`replayIndeterminate` on a client built for the same generated operation
recovery contract and canonical origin/base path. Pass `{ signal }` as its
second argument to cancel credential resolution and the replay request. The
whole-document OpenAPI digest is provenance/skew metadata only; it is never
durable replay or recovery authority.

Unkeyed stateful writes are never retried or replayed: receiving no response headers is
epistemically indeterminate, but it does not create retry authority or prove
non-admission. Reconcile through the operation’s named read projection before
deciding whether another write is safe. The typed replay receipt exists only
where the generated request contract proves a caller idempotency key. The sole
exception is the naturally convergent, bodyless
`admin.run.reconcile-preserving`: its fixed operation identity is explicit
retry authority, and a retry returns the latest converged pass. The service
serializes the whole reconciliation pass across processes, so an overlapping
retry cannot mistake the first pass's held per-run mutexes for convergence.
After response headers arrive, any result that still fails the generated
response contract consumes the operation-identity retry budget; it never
returns an unproven value.

Generated response headers are closed to Fetch-representable wire values:
field names are HTTP tokens; string values are non-empty, printable ASCII,
trim-stable, comma-free, and bounded; integer values are canonical,
non-negative, and bounded within JavaScript's safe-integer range. Generation
and runtime decoding both enforce the same envelope.

Protocol failures preserve wire evidence without turning the client into an
unbounded response recorder. `rawBodySnippet` contains at most the first 2 KiB
of Fetch-visible body bytes decoded lossily as UTF-8. `rawBodyBytes` is exact
when `rawBodyComplete` is true and otherwise records only the bytes observed
before the bounded sampler cancelled an interrupted, oversized, locked, or
non-closing body. `responseHeaders` is a frozen positive allowlist of bounded
diagnostic metadata; credential, cookie, authentication-challenge, and redirect
headers are never retained. Raw body evidence remains untrusted peer data and
may itself be sensitive, so the client neither logs nor persists it
automatically.

Privileged attachment-byte reads validate their generated custody headers
before returning a stream. Consume `body` to EOF and await `verified`; that
promise settles only after the observed byte length and SHA-256 digest match
the content-addressed ref, ETag, Digest, and declared size. A stream error,
early cancellation, or rejected `verified` promise means custody was not
established and the bytes must not be adopted as the requested attachment. For
non-streaming callers, `bufferVerifiedBinary(response)` consumes the one-shot
stream and returns a `Uint8Array` only after the same length and digest proof
settles; it is exported only from the privileged `./admin` entrypoint.
