## Session Adapter Real-Corpus Fixtures

This fixture set is used by `context-session-adapters-real.test.ts` to gate Tier 1
session adapter promotion with real-format session artifacts.

Design constraints:
- No production secrets or auth tokens in fixtures.
- Deterministic replay with stable timestamps and IDs.
- Real format coverage:
  - Gemini: current `session-*.json` schema (`messages[]` object payload)
  - Hermes: SQLite `state.db` schema (`sessions` + `messages`)

`parity.expected.json` stores the normalized expectations used for the pass/fail report.
