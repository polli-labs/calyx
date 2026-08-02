import { describe, expect, test } from "vitest";
import {
  InfraErrorCensusAuthorityError,
  auditInfraErrorCensusAuthority,
  projectInfraErrorCensusAuthority,
} from "../infra-error-census.js";
import type { RunTerminalEvent } from "../types.js";

interface TerminalEventFixtureOptions {
  eventId: string;
  ordinal: number;
  runId?: string;
  incarnationId?: string;
  supersedes?: string;
  state?: RunTerminalEvent["run"]["state"];
}

function terminalEvent(options: TerminalEventFixtureOptions): RunTerminalEvent {
  const runId = options.runId ?? "shared-run";
  const emittedAt = `2026-05-10T00:00:${String(options.ordinal).padStart(2, "0")}.000Z`;
  return {
    schema_version: "1.0",
    event_id: options.eventId,
    cursor: `g1:${String(options.ordinal).padStart(20, "0")}`,
    emitted_at: emittedAt,
    event_type: "run.terminal",
    emitted_by: "reconcile",
    run: {
      run_id: runId,
      ...(options.incarnationId ? { incarnation_id: options.incarnationId } : {}),
      state: options.state ?? "infra_error",
      kernel: "agent_runner",
      backend: "codex",
      host: "carbon",
      created_at: "2026-05-10T00:00:00.000Z",
      recovery_mode: "normal",
    },
    origin: { launcher_kind: "cli" },
    pointers: {
      run_dir: `/tmp/${runId}`,
      run_record_path: `/tmp/${runId}/run_record.json`,
      events_path: `/tmp/${runId}/events.jsonl`,
    },
    summary: { one_line: "redacted fixture summary" },
    ...(options.supersedes
      ? {
          supersession: {
            schema_version: "calyx.run-terminal-supersession/v1",
            supersedes_event_id: options.supersedes,
            reason: "receipt_projection_corrected",
          },
        }
      : {}),
  };
}

describe("infra-error census terminal authority", () => {
  test("projects one legacy root by immutable root event id", () => {
    const root = terminalEvent({ eventId: "legacy-root", ordinal: 1 });

    const projection = projectInfraErrorCensusAuthority([root]);

    expect(projection.leaves).toEqual([{
      projection_key: JSON.stringify(["legacy-root", root.event_id]),
      event: root,
    }]);
    expect(projection.audit).toMatchObject({
      authoritative: true,
      terminal_event_count: 1,
      legacy_event_count: 1,
      uuid_incarnation_count: 0,
      legacy_roots: [{
        root_event_id: root.event_id,
        leaf_event_ids: [root.event_id],
        event_count: 1,
      }],
      ambiguities: [],
    });
  });

  test("folds a legacy correction chain to its unique current leaf", () => {
    const root = terminalEvent({ eventId: "legacy-root", ordinal: 1 });
    const correction = terminalEvent({
      eventId: "legacy-correction",
      ordinal: 2,
      supersedes: root.event_id,
      state: "failed",
    });

    const projection = projectInfraErrorCensusAuthority([root, correction]);

    expect(projection.leaves).toEqual([{
      projection_key: JSON.stringify(["legacy-root", root.event_id]),
      event: correction,
    }]);
    expect(projection.audit.legacy_roots).toEqual([{
      root_event_id: root.event_id,
      leaf_event_ids: [correction.event_id],
      event_count: 2,
    }]);
  });

  test("keeps two legacy roots distinct despite identical run id and timestamp", () => {
    const first = terminalEvent({ eventId: "legacy-root-a", ordinal: 1 });
    const second = terminalEvent({ eventId: "legacy-root-b", ordinal: 2 });

    const projection = projectInfraErrorCensusAuthority([first, second]);

    expect(projection.leaves.map((leaf) => leaf.projection_key)).toEqual([
      JSON.stringify(["legacy-root", first.event_id]),
      JSON.stringify(["legacy-root", second.event_id]),
    ]);
    expect(projection.audit.legacy_roots).toHaveLength(2);
  });

  test.each([
    {
      name: "missing parent",
      events: [terminalEvent({ eventId: "orphan", ordinal: 1, supersedes: "absent" })],
      code: "missing_parent",
    },
    {
      name: "branch ambiguity",
      events: [
        terminalEvent({ eventId: "root", ordinal: 1 }),
        terminalEvent({ eventId: "child-a", ordinal: 2, supersedes: "root" }),
        terminalEvent({ eventId: "child-b", ordinal: 3, supersedes: "root" }),
      ],
      code: "branch_ambiguity",
    },
    {
      name: "cycle",
      events: [
        terminalEvent({ eventId: "cycle-a", ordinal: 1, supersedes: "cycle-b" }),
        terminalEvent({ eventId: "cycle-b", ordinal: 2, supersedes: "cycle-a" }),
      ],
      code: "cycle",
    },
  ] as const)("fails the projection closed on $name", ({ events, code }) => {
    expect(() => projectInfraErrorCensusAuthority(events)).toThrowError(
      expect.objectContaining<Partial<InfraErrorCensusAuthorityError>>({
        name: "InfraErrorCensusAuthorityError",
        code,
      }),
    );
    expect(auditInfraErrorCensusAuthority(events)).toMatchObject({
      authoritative: false,
      ambiguities: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  test("coexists with a separate UUID incarnation for the same run id", () => {
    const legacy = terminalEvent({ eventId: "legacy-root", ordinal: 1 });
    const current = terminalEvent({
      eventId: "uuid-root",
      ordinal: 2,
      incarnationId: "f7ec4bd6-0472-4c2b-bfc0-abcd46a489f0",
    });

    const projection = projectInfraErrorCensusAuthority([legacy, current]);

    expect(projection.leaves).toHaveLength(2);
    expect(projection.audit).toMatchObject({
      authoritative: true,
      legacy_event_count: 1,
      uuid_incarnation_count: 1,
      legacy_roots: [{ root_event_id: legacy.event_id }],
    });
  });

  test("fails closed when a legacy chain and a separate root claim the same UUID incarnation", () => {
    const incarnationId = "f7ec4bd6-0472-4c2b-bfc0-abcd46a489f0";
    const legacyRoot = terminalEvent({ eventId: "legacy-root", ordinal: 1 });
    const uuidChild = terminalEvent({
      eventId: "uuid-child",
      ordinal: 2,
      incarnationId,
      supersedes: legacyRoot.event_id,
    });
    const uuidRoot = terminalEvent({
      eventId: "uuid-root",
      ordinal: 3,
      incarnationId,
    });

    expect(() => projectInfraErrorCensusAuthority([legacyRoot, uuidChild, uuidRoot]))
      .toThrowError(expect.objectContaining<Partial<InfraErrorCensusAuthorityError>>({
        name: "InfraErrorCensusAuthorityError",
        code: "incarnation_identity_conflict",
      }));
    expect(auditInfraErrorCensusAuthority([legacyRoot, uuidChild, uuidRoot])).toMatchObject({
      authoritative: false,
      ambiguities: expect.arrayContaining([
        expect.objectContaining({ code: "incarnation_identity_conflict" }),
      ]),
    });
  });

  test("globally bounds nested audit locators and marks omitted locators truncated", () => {
    const root = terminalEvent({ eventId: "wide-root", ordinal: 1 });
    const children = Array.from({ length: 1_500 }, (_, index) => terminalEvent({
      eventId: `wide-child-${String(index).padStart(4, "0")}`,
      ordinal: index + 2,
      supersedes: root.event_id,
    }));

    const audit = auditInfraErrorCensusAuthority([root, ...children]);
    const locators = [
      ...audit.ambiguities.flatMap((ambiguity) => ambiguity.event_ids),
      ...audit.legacy_roots.flatMap((legacyRoot) => [
        legacyRoot.root_event_id,
        ...legacyRoot.leaf_event_ids,
      ]),
    ];

    expect(audit).toMatchObject({
      authoritative: false,
      ambiguity_count: 1,
      legacy_root_count: 1,
      truncated: true,
    });
    expect(locators.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(locators.join(""), "utf8")).toBeLessThanOrEqual(64 * 1_024);
  });

  test("hashes oversized event-id locators within the bounded audit receipt", () => {
    const oversizedId = `oversized-${"x".repeat(4_096)}`;
    const audit = auditInfraErrorCensusAuthority([
      terminalEvent({ eventId: "orphan", ordinal: 1, supersedes: oversizedId }),
    ]);

    expect(audit.truncated).toBe(true);
    expect(audit.ambiguities[0]?.event_ids).toContainEqual(
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    );
    expect(audit.ambiguities[0]?.event_ids.every(
      (locator) => Buffer.byteLength(locator, "utf8") <= 256,
    )).toBe(true);
  });
});
