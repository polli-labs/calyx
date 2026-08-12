import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  STATE_MIGRATIONS,
  applyMigrations,
  applyStateMigrations,
  openStateStore,
  type OpenedState,
} from "@polli-labs/calyx-core";
import type { RunReceipt, RunSpec } from "@polli-labs/calyx-runner";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  MAX_REVIEW_CLAIM_TTL_MS,
  REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
  REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION,
  REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION,
  REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  acquireIndependentReviewClaim,
  adoptReviewerLaunchEffect,
  assertIndependentReviewFence,
  canonicalizeIndependentReviewJson,
  checkIndependentReviewCoordinatorSchema,
  claimIndependentReviewEffect,
  evaluateReviewFindingsV2,
  hashIndependentReviewValue,
  listIndependentReviewEvents,
  readIndependentReviewAdminProjection,
  recordIndependentReviewEvidenceFromRunService,
  recordReviewPublicationObservation,
  recordReviewerLaunchReconciliationFromRunService,
  recordReviewerRunObservationFromRunService,
  releaseIndependentReviewClaim,
  renewIndependentReviewClaim,
  submitIndependentReview as submitIndependentReviewAtTrustedClock,
  type IndependentReviewAdminProjection,
  type ProviderPublicationObservation,
  type ReviewFindingsV2,
  type ReviewRunEvidenceReceipt,
  type ReviewerLaunchReconciliationObservation,
  type SubmitIndependentReviewInput,
} from "../review-coordinator.js";
import { RunService } from "./support/test-run-service.js";
import type { ResolvedRunSpec } from "../types.js";

const BUILD_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const DEFINITION_DIGEST = "c".repeat(64);
const LAUNCH_RECEIPT_DIGEST = "d".repeat(64);
const BASE_TIME = "2026-07-14T18:00:00.000Z";

let tempRoot = "";
let originalStateHome: string | undefined;
let originalStateDb: string | undefined;

function at(seconds: number): string {
  return new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();
}

function submission(
  overrides: Partial<SubmitIndependentReviewInput> = {},
): SubmitIndependentReviewInput {
  return {
    instance_id: "review-instance-1",
    admission_key: "polli-labs/calyx-dev#300@bbbbbbbb",
    subject: "operator:caleb",
    asserted_actor: "interactive:codex:requester",
    policy_version: "independent-review/v1",
    submitted_at: at(0),
    target: {
      repository: "polli-labs/calyx-dev",
      pull_request: 300,
      commit_sha: TARGET_SHA,
    },
    publication_target: { linear_issue: "POL-1983" },
    round: 1,
    calyx_build_sha: BUILD_SHA,
    reviewer_definition_digest: DEFINITION_DIGEST,
    reviewer_run_id: "review-run-1",
    launch_id: "review-launch-1",
    launch_request: {
      schema_version: REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION,
      agent_ref: "reviewer-adversarial@v2",
      host: "blade",
      target_sha: TARGET_SHA,
      required_artifact: "findings.json",
    },
    producer_generation: 7,
    producer_fence: 11,
    ...overrides,
  };
}

function submitIndependentReview(
  db: OpenedState["db"],
  input: SubmitIndependentReviewInput,
  authority: { now: string } = { now: at(0) },
): ReturnType<typeof submitIndependentReviewAtTrustedClock> {
  return submitIndependentReviewAtTrustedClock(db, input, authority);
}

function durableCoordinatorState(db: OpenedState["db"], instanceId: string): unknown {
  return {
    instance: db.prepare(
      `SELECT state, state_version, claim_owner, claim_until, claim_fence,
              intrinsic_status, publication_status, disposition, next_event_seq,
              created_at, updated_at, terminal_at
       FROM review_instances WHERE instance_id = ?`,
    ).get(instanceId),
    attempt: db.prepare(
      `SELECT status, run_state, created_at, updated_at
       FROM review_attempts WHERE instance_id = ?`,
    ).get(instanceId),
    effects: db.prepare(
      `SELECT effect_id, status, claimed_fence, adoption_hash, created_at, updated_at
       FROM review_effects WHERE instance_id = ? ORDER BY effect_id`,
    ).all(instanceId),
    obligations: db.prepare(
      `SELECT obligation_id, status, detail_json, created_at, updated_at
       FROM review_obligations WHERE instance_id = ? ORDER BY obligation_id`,
    ).all(instanceId),
    evidence: db.prepare(
      `SELECT evidence_id, created_at
       FROM review_evidence WHERE instance_id = ? ORDER BY evidence_id`,
    ).all(instanceId),
    observations: db.prepare(
      `SELECT observation_id, effect_id, observation_seq, observed_at
       FROM review_effect_observations WHERE instance_id = ?
       ORDER BY effect_id, observation_seq`,
    ).all(instanceId),
    events: db.prepare(
      `SELECT event_id, event_seq, event_type, occurred_at
       FROM review_events WHERE instance_id = ? ORDER BY event_seq`,
    ).all(instanceId),
  };
}

function publisherIdentities() {
  return {
    github_author_node_id: "github-publisher-node-1",
    linear_actor_id: "linear-publisher-actor-1",
  };
}

function expectedEvidenceId(projection: IndependentReviewAdminProjection): string {
  const digest = createHash("sha256")
    .update(canonicalizeIndependentReviewJson([
      projection.instance_id,
      projection.attempt.attempt_id,
    ]), "utf8")
    .digest("hex");
  return `review-evidence-${digest.slice(0, 32)}`;
}

function findings(
  projection: IndependentReviewAdminProjection,
  rows: ReviewFindingsV2["findings"] = [],
): ReviewFindingsV2 {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, total: rows.length };
  for (const row of rows) counts[row.severity] += 1;
  return {
    schema_version: "review-findings/v2",
    evidence_id: expectedEvidenceId(projection),
    review_instance_id: projection.instance_id,
    reviewer_run_id: projection.attempt.reviewer_run_id,
    reviewer_attempt_id: projection.attempt.attempt_id,
    round: projection.round,
    producer_generation: projection.attempt.producer_generation,
    producer_fence: projection.attempt.producer_fence,
    target: projection.target,
    review_status: "complete",
    coverage_status: "full",
    verdict: rows.length === 0 ? "mergeable" : "not_mergeable",
    counts,
    findings: rows,
  };
}

function runEvidenceReceipt(
  projection: IndependentReviewAdminProjection,
  artifact: unknown,
  issuedAt = at(6),
): ReviewRunEvidenceReceipt {
  const canonical = canonicalizeIndependentReviewJson(artifact);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return {
    schema_version: REVIEW_RUN_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    issuer: "run_service",
    run_id: projection.attempt.reviewer_run_id,
    reviewer_attempt_id: projection.attempt.attempt_id,
    terminal_receipt_digest: "9".repeat(64),
    artifact: {
      name: "findings.json",
      locator: `calyx-run-artifact:${projection.attempt.reviewer_run_id}:findings.json`,
      media_type: "application/json",
      source_sha256: digest,
      source_size_bytes: Buffer.byteLength(canonical, "utf8"),
      canonical_sha256: digest,
      canonical_size_bytes: Buffer.byteLength(canonical, "utf8"),
    },
    issued_at: issuedAt,
  };
}

function providerObservation(
  observationId: string,
  adapter: "github_review" | "linear_comment",
  status: ProviderPublicationObservation["status"],
): ProviderPublicationObservation {
  return {
    schema_version: REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION,
    observation_id: observationId,
    adapter,
    status,
    failure: { reason_code: `${adapter}_${status}` },
  };
}

async function openMigratedState(): Promise<OpenedState> {
  await applyStateMigrations();
  return openStateStore();
}

function foreignKeySignatures(db: OpenedState["db"], table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    id: number | bigint;
    seq: number | bigint;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    const id = Number(row.id);
    const group = grouped.get(id) ?? [];
    group.push(row);
    grouped.set(id, group);
  }
  return [...grouped.values()].map((group) => {
    const ordered = [...group].sort((left, right) => Number(left.seq) - Number(right.seq));
    return `${ordered.map((row) => row.from).join(",")} -> ${ordered[0]!.table}(`
      + `${ordered.map((row) => row.to).join(",")}) ON DELETE ${ordered[0]!.on_delete}`;
  }).sort();
}

function adoptLaunch(
  db: OpenedState["db"],
  projection: IndependentReviewAdminProjection,
): IndependentReviewAdminProjection {
  const claim = acquireIndependentReviewClaim(db, {
    instance_id: projection.instance_id,
    owner: "daemon:blade",
    ttl_ms: 30_000,
    now: at(1),
  });
  claimIndependentReviewEffect(db, {
    instance_id: projection.instance_id,
    effect_id: projection.launch.effect_id,
    owner: claim.owner,
    fence: claim.fence,
    now: at(2),
  });
  return adoptReviewerLaunchEffect(db, {
    instance_id: projection.instance_id,
    effect_id: projection.launch.effect_id,
    effect_request_hash: projection.launch.request_hash,
    claimed_fence: claim.fence,
    outcome: {
      status: "created",
      run_id: projection.attempt.reviewer_run_id,
      observed_intent_hash: projection.attempt.launch_intent_hash,
      receipt_digest: LAUNCH_RECEIPT_DIGEST,
    },
    observed_at: at(3),
  }).projection;
}

function adoptIndeterminateLaunch(
  db: OpenedState["db"],
  projection: IndependentReviewAdminProjection,
): IndependentReviewAdminProjection {
  const claim = acquireIndependentReviewClaim(db, {
    instance_id: projection.instance_id,
    owner: "daemon:blade",
    ttl_ms: 30_000,
    now: at(1),
  });
  claimIndependentReviewEffect(db, {
    instance_id: projection.instance_id,
    effect_id: projection.launch.effect_id,
    owner: claim.owner,
    fence: claim.fence,
    now: at(2),
  });
  return adoptReviewerLaunchEffect(db, {
    instance_id: projection.instance_id,
    effect_id: projection.launch.effect_id,
    effect_request_hash: projection.launch.request_hash,
    claimed_fence: claim.fence,
    outcome: {
      status: "indeterminate",
      run_id: projection.attempt.reviewer_run_id,
      observed_intent_hash: projection.attempt.launch_intent_hash,
      reason_code: "supervisor_timeout",
    },
    observed_at: at(3),
  }).projection;
}

function launchReconciliationObservation(
  projection: IndependentReviewAdminProjection,
  overrides: Partial<ReviewerLaunchReconciliationObservation> = {},
): ReviewerLaunchReconciliationObservation {
  const common = {
    schema_version: REVIEW_LAUNCH_RECONCILIATION_OBSERVATION_SCHEMA_VERSION,
    observation_id: overrides.observation_id ?? "launch-reconciliation-1",
    issuer: "run_service",
    run_id: projection.attempt.reviewer_run_id,
    observed_intent_hash: projection.attempt.launch_intent_hash,
  } as const;
  if (overrides.status === "indeterminate") {
    return {
      ...common,
      status: "indeterminate",
      reason_code: "reason_code" in overrides
        ? overrides.reason_code ?? "supervisor_unreachable"
        : "supervisor_unreachable",
    };
  }
  if (overrides.status === "failed") {
    return {
      ...common,
      status: "failed",
      supervisor_receipt_digest: "supervisor_receipt_digest" in overrides
        ? overrides.supervisor_receipt_digest ?? LAUNCH_RECEIPT_DIGEST
        : LAUNCH_RECEIPT_DIGEST,
      reason_code: "reason_code" in overrides
        ? overrides.reason_code ?? "supervisor_failed"
        : "supervisor_failed",
    };
  }
  return {
    ...common,
    status: "adopted",
    supervisor_receipt_digest: "supervisor_receipt_digest" in overrides
      ? overrides.supervisor_receipt_digest ?? LAUNCH_RECEIPT_DIGEST
      : LAUNCH_RECEIPT_DIGEST,
  };
}

function prepareAwaitingEvidenceFor(
  db: OpenedState["db"],
  input: SubmitIndependentReviewInput,
  observationId: string,
): IndependentReviewAdminProjection {
  const admitted = submitIndependentReview(db, input).projection;
  const launched = adoptLaunch(db, admitted);
  return recordReviewerRunObservationFromRunService(db, {
    instance_id: launched.instance_id,
    observation_id: observationId,
    reviewer_run_id: launched.attempt.reviewer_run_id,
    run_state: "succeeded",
    observed_at: at(5),
  }).projection;
}

function prepareAwaitingEvidence(db: OpenedState["db"]): IndependentReviewAdminProjection {
  return prepareAwaitingEvidenceFor(db, submission(), "run-succeeded-1");
}

function prepareAwaitingPublication(db: OpenedState["db"]): IndependentReviewAdminProjection {
  const awaitingEvidence = prepareAwaitingEvidence(db);
  const artifact = findings(awaitingEvidence);
  return recordIndependentReviewEvidenceFromRunService(db, {
    instance_id: awaitingEvidence.instance_id,
    artifact,
    evidence_receipt: runEvidenceReceipt(awaitingEvidence, artifact),
    reviewer_run_issue: "POL-1983",
    publisher_identities: publisherIdentities(),
    recorded_at: at(6),
  }).projection;
}

function publicationEffect(
  projection: IndependentReviewAdminProjection,
  adapter: "github_review" | "linear_comment",
): NonNullable<IndependentReviewAdminProjection["publication"]>["effects"][number] {
  const effect = projection.publication?.effects.find((candidate) => candidate.adapter === adapter);
  if (!effect) throw new Error(`Missing ${adapter} publication effect.`);
  return effect;
}

function claimPublicationEffect(
  db: OpenedState["db"],
  projection: IndependentReviewAdminProjection,
  adapter: "github_review" | "linear_comment",
  now: string,
): ReturnType<typeof claimIndependentReviewEffect> {
  const effect = publicationEffect(projection, adapter);
  return claimIndependentReviewEffect(db, {
    instance_id: projection.instance_id,
    effect_id: effect.effect_id,
    owner: "daemon:blade",
    fence: projection.claim.fence,
    now,
  });
}

function makeKernelReceipt(
  runId: string,
  artifactPath: string,
  bytes: Buffer,
  overrides: Partial<RunReceipt> = {},
): RunReceipt {
  const spec: RunSpec = {
    run_id: runId,
    issue: "POL-1983",
    host: "blade",
    backend: "codex",
    prompt: "Review the pinned target.",
    require_execplan: false,
    pull_execplan: false,
    worktree: {},
    required_artifacts: ["findings.json"],
  };
  return {
    schema_version: "1.0",
    run_id: runId,
    state: "succeeded",
    run_spec: spec,
    timing: { created_at: at(4), completed_at: at(5) },
    exit: { exit_code: 0 },
    artifacts: {
      run_id: runId,
      finalized_at: at(5),
      required: [{
        name: "findings.json",
        location: "run_dir",
        path: artifactPath,
        size_bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        required: true,
        detected_at: at(5),
      }],
      discovered: [],
      gate_passed: true,
      missing: [],
    },
    log_summary: { total: 1, info: 1, warn: 0, error: 0 },
    environment: { host: "blade", backend: "codex" },
    summary: `Run ${runId} succeeded.`,
    ...overrides,
  };
}

async function publishAuthoritativeKernelReceipt(
  service: RunService,
  receipt: RunReceipt,
): Promise<void> {
  const intent = service.createIntent({
    run_id: receipt.run_id,
    issue: "POL-1983",
    host: "blade",
    backend: "codex",
    prompt: "Review the pinned target.",
    require_execplan: false,
    required_artifacts: ["findings.json"],
  });
  const queued = await service.initializeRun(intent);
  const spec: ResolvedRunSpec = {
    run_id: receipt.run_id,
    kernel: "agent_runner",
    host: "blade",
    backend: "codex",
    issue: "POL-1983",
    prompt: "Review the pinned target.",
    require_execplan: false,
    worktree: {},
    required_artifacts: ["findings.json"],
    resolved_at: at(0),
    resolution_log: [],
  };
  await service.store.writeSpec(receipt.run_id, spec);
  await service.store.writeKernelReceipt(receipt.run_id, receipt);
  await service.store.writeRunRecord(receipt.run_id, {
    ...queued,
    state: receipt.state,
    spec,
    kernel_receipt: receipt,
    summary: receipt.summary,
    updated_at: receipt.timing.completed_at,
    completed_at: receipt.timing.completed_at,
  });
}

async function replaceAuthoritativeKernelReceipt(
  service: RunService,
  receipt: RunReceipt,
): Promise<void> {
  const record = await service.getRunRecord(receipt.run_id);
  if (!record) throw new Error(`Missing run record ${receipt.run_id}.`);
  await service.store.writeKernelReceipt(receipt.run_id, receipt);
  await service.store.writeRunRecord(receipt.run_id, {
    ...record,
    state: receipt.state,
    kernel_receipt: receipt,
    summary: receipt.summary,
    updated_at: receipt.timing.completed_at,
    completed_at: receipt.timing.completed_at,
  });
}

beforeEach(async () => {
  originalStateHome = process.env["CALYX_STATE_HOME"];
  originalStateDb = process.env["CALYX_STATE_DB"];
  tempRoot = await mkdtemp(path.join(tmpdir(), "calyx-review-coordinator-"));
  process.env["CALYX_STATE_HOME"] = path.join(tempRoot, "state");
  delete process.env["CALYX_STATE_DB"];
});

afterEach(async () => {
  if (originalStateHome === undefined) delete process.env["CALYX_STATE_HOME"];
  else process.env["CALYX_STATE_HOME"] = originalStateHome;
  if (originalStateDb === undefined) delete process.env["CALYX_STATE_DB"];
  else process.env["CALYX_STATE_DB"] = originalStateDb;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("independent review authority and persistence", () => {
  test("migration 0034 creates the seven caller-owned tables with same-instance ownership", async () => {
    const opened = await openMigratedState();
    try {
      expect(checkIndependentReviewCoordinatorSchema(opened.db)).toEqual({
        status: "ok",
        findings: [],
      });
      const tables = (opened.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'review_%' ORDER BY name",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([
        "review_attempts",
        "review_effect_observations",
        "review_effects",
        "review_events",
        "review_evidence",
        "review_instances",
        "review_obligations",
      ]);
      expect(foreignKeySignatures(opened.db, "review_effects")).toEqual([
        "instance_id -> review_instances(instance_id) ON DELETE CASCADE",
        "instance_id,attempt_id -> review_attempts(instance_id,attempt_id) ON DELETE CASCADE",
      ]);
      expect(foreignKeySignatures(opened.db, "review_effect_observations")).toEqual([
        "instance_id -> review_instances(instance_id) ON DELETE CASCADE",
        "instance_id,effect_id -> review_effects(instance_id,effect_id) ON DELETE CASCADE",
      ]);
      expect(foreignKeySignatures(opened.db, "review_evidence")).toEqual([
        "instance_id -> review_instances(instance_id) ON DELETE CASCADE",
        "instance_id,attempt_id -> review_attempts(instance_id,attempt_id) ON DELETE CASCADE",
      ]);
      expect(foreignKeySignatures(opened.db, "review_obligations")).toEqual([
        "instance_id -> review_instances(instance_id) ON DELETE CASCADE",
        "instance_id,effect_id -> review_effects(instance_id,effect_id) ON DELETE CASCADE",
      ]);
    } finally {
      opened.db.close();
    }
  });

  test("migration 0034 upgrades a 0033 state database as the only pending step", async () => {
    const opened = await openStateStore();
    try {
      const through0033 = STATE_MIGRATIONS.filter((migration) => migration.id <= "0033");
      const only0034 = STATE_MIGRATIONS.filter((migration) => migration.id === "0034");
      applyMigrations(opened.db, through0033, opened.driver.id, () => at(0));
      expect((opened.db.prepare(
        "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
      ).get() as { id: string }).id).toBe("0033");
      expect(opened.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_instances'",
      ).get()).toBeUndefined();

      const result = applyMigrations(opened.db, only0034, opened.driver.id, () => at(1));
      expect(result.applied.map((migration) => migration.id)).toEqual(["0034"]);
      expect(result.current).toBe("0034");
      expect(checkIndependentReviewCoordinatorSchema(opened.db)).toEqual({
        status: "ok",
        findings: [],
      });
      expect(opened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  test("schema verification rejects a weakened singleton effect ownership foreign key", async () => {
    const opened = await openMigratedState();
    try {
      opened.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE review_obligations;
        CREATE TABLE review_obligations (
          obligation_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          effect_id TEXT NOT NULL REFERENCES review_effects(effect_id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          obligation_key TEXT NOT NULL,
          status TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(instance_id, kind, obligation_key),
          CHECK (status IN ('pending', 'resolved'))
        );
        CREATE INDEX idx_review_obligations_open
          ON review_obligations(status, updated_at);
        PRAGMA foreign_keys = ON;
      `);
      const result = checkIndependentReviewCoordinatorSchema(opened.db);
      expect(result.status).toBe("error");
      expect(result.findings).toContainEqual({
        table: "review_obligations",
        code: "missing-foreign-key",
        detail: "missing foreign key review_obligations.instance_id,effect_id -> review_effects(instance_id,effect_id) ON DELETE CASCADE",
      });
    } finally {
      opened.db.close();
    }
  });

  test("schema verification rejects a weakened observation schema/status check", async () => {
    const opened = await openMigratedState();
    try {
      opened.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE review_effect_observations;
        CREATE TABLE review_effect_observations (
          observation_id TEXT NOT NULL,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          effect_id TEXT NOT NULL,
          effect_key TEXT NOT NULL,
          observation_seq INTEGER NOT NULL,
          schema_version TEXT NOT NULL,
          status TEXT NOT NULL,
          receipt_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          PRIMARY KEY(effect_id, observation_id),
          UNIQUE(effect_id, observation_seq),
          FOREIGN KEY (instance_id, effect_id)
            REFERENCES review_effects(instance_id, effect_id) ON DELETE CASCADE,
          CHECK (observation_seq > 0),
          CHECK (schema_version = 'calyx.review-provider-observation/v1'),
          CHECK (status IN ('delivered', 'degraded', 'indeterminate')),
          CHECK (length(receipt_digest) = 64),
          CHECK (length(payload_hash) = 64)
        );
        CREATE INDEX idx_review_effect_observations_effect
          ON review_effect_observations(effect_id, observation_seq);
        PRAGMA foreign_keys = ON;
      `);
      expect(checkIndependentReviewCoordinatorSchema(opened.db)).toMatchObject({
        status: "error",
        findings: [{
          table: "review_effect_observations",
          code: "missing-check",
          detail: "missing conditional check on review_effect_observations",
        }],
      });
    } finally {
      opened.db.close();
    }
  });

  test("schema verification rejects a same-name index with weaker semantics", async () => {
    const opened = await openMigratedState();
    try {
      opened.db.exec(`
        DROP INDEX idx_review_effects_ready;
        CREATE INDEX idx_review_effects_ready
          ON review_effects(status, instance_id, kind, effect_key)
          WHERE status = 'pending';
      `);
      expect(checkIndependentReviewCoordinatorSchema(opened.db)).toMatchObject({
        status: "error",
        findings: [{
          table: "review_effects",
          code: "invalid-index",
        }],
      });
    } finally {
      opened.db.close();
    }
  });

  test("schema verification rejects a missing event idempotency key", async () => {
    const opened = await openMigratedState();
    try {
      opened.db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE review_events;
        CREATE TABLE review_events (
          event_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES review_instances(instance_id) ON DELETE CASCADE,
          event_seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          CHECK (event_seq > 0),
          CHECK (length(payload_hash) = 64)
        );
        CREATE INDEX idx_review_events_instance
          ON review_events(instance_id, event_seq);
        PRAGMA foreign_keys = ON;
      `);
      expect(checkIndependentReviewCoordinatorSchema(opened.db)).toMatchObject({
        status: "error",
        findings: [{
          table: "review_events",
          code: "missing-key",
          detail: "missing unique key review_events(instance_id,event_seq)",
        }],
      });
    } finally {
      opened.db.close();
    }
  });

  test("direct SQL cannot attach attempts or effects to a different review instance", async () => {
    const opened = await openMigratedState();
    try {
      const first = submitIndependentReview(opened.db, submission()).projection;
      const second = submitIndependentReview(opened.db, submission({
        instance_id: "review-instance-2",
        admission_key: "polli-labs/calyx-dev#301@bbbbbbbb",
        reviewer_run_id: "review-run-2",
        launch_id: "review-launch-2",
      })).projection;

      expect(() => opened.db.prepare(`
        INSERT INTO review_effects
          (effect_id, instance_id, attempt_id, kind, effect_key, request_json, request_hash,
           status, claimed_fence, adoption_json, adoption_hash, created_at, updated_at)
        SELECT ?, ?, attempt_id, kind, ?, request_json, request_hash,
               status, claimed_fence, adoption_json, adoption_hash, created_at, updated_at
        FROM review_effects WHERE effect_id = ?
      `).run(
        "forged-effect",
        second.instance_id,
        "forged-effect-key",
        first.launch.effect_id,
      )).toThrow(/FOREIGN KEY/);

      expect(() => opened.db.prepare(`
        INSERT INTO review_effect_observations
          (observation_id, instance_id, effect_id, effect_key, observation_seq, schema_version,
           status, receipt_digest, payload_json, payload_hash, observed_at)
        VALUES (?, ?, ?, ?, 1, ?, 'delivered', ?, '{}', ?, ?)
      `).run(
        "forged-observation",
        second.instance_id,
        first.launch.effect_id,
        "launch",
        REVIEW_PROVIDER_OBSERVATION_SCHEMA_VERSION,
        "d".repeat(64),
        hashIndependentReviewValue({}),
        at(1),
      )).toThrow(/FOREIGN KEY/);

      expect(() => opened.db.prepare(`
        INSERT INTO review_evidence
          (evidence_id, instance_id, attempt_id, schema_version, receipt_json, receipt_hash,
           artifact_json, artifact_digest, intrinsic_status, verdict, coverage_status,
           finding_count, invalid_reasons_json, created_at)
        VALUES (?, ?, ?, 'calyx.review-run-evidence/v1', '{}', ?, '{}', ?,
                'passed', 'mergeable', 'complete', 0, '[]', ?)
      `).run(
        "forged-evidence",
        second.instance_id,
        first.attempt.attempt_id,
        hashIndependentReviewValue({}),
        "e".repeat(64),
        at(1),
      )).toThrow(/FOREIGN KEY/);

      expect(() => opened.db.prepare(`
        INSERT INTO review_obligations
          (obligation_id, instance_id, effect_id, kind, obligation_key, status,
           detail_json, created_at, updated_at)
        VALUES (?, ?, ?, 'publication_reconciliation', ?, 'pending', '{}', ?, ?)
      `).run(
        "forged-obligation",
        second.instance_id,
        first.launch.effect_id,
        "forged-obligation",
        at(1),
        at(1),
      )).toThrow(/FOREIGN KEY/);
    } finally {
      opened.db.close();
    }
  });

  test("admission is atomic, immutable, and idempotent", async () => {
    const opened = await openMigratedState();
    try {
      const first = submitIndependentReview(opened.db, submission());
      expect(first.created).toBe(true);
      expect(first.projection).toMatchObject({
        state: "reviewer_launch_pending",
        axes: { intrinsic: "pending", publication: "not_started", disposition: "active" },
        attempt: { status: "planned", reviewer_run_id: "review-run-1" },
        launch: { status: "pending" },
      });
      expect(submitIndependentReview(opened.db, submission())).toMatchObject({
        created: false,
        request_hash: first.request_hash,
        attempt_id: first.attempt_id,
      });
      expect(() => submitIndependentReview(opened.db, submission({ round: 2 }))).toThrow(
        /different immutable bytes/,
      );
      const persisted = opened.db.prepare(
        `SELECT i.request_json, e.request_json AS launch_effect_json
           FROM review_instances i
           JOIN review_effects e ON e.instance_id = i.instance_id
          WHERE i.instance_id = ? AND e.kind = 'reviewer_launch'`,
      ).get(first.projection.instance_id) as {
        request_json: string;
        launch_effect_json: string;
      };
      expect(JSON.parse(persisted.request_json)).toMatchObject({
        publication_target: { linear_issue: "POL-1983" },
      });
      expect(JSON.parse(persisted.launch_effect_json)).toMatchObject({
        reviewer_definition_digest: DEFINITION_DIGEST,
        launch_request: { schema_version: REVIEW_LAUNCH_REQUEST_SCHEMA_VERSION },
      });
      expect(listIndependentReviewEvents(opened.db, first.projection.instance_id)).toHaveLength(1);
    } finally {
      opened.db.close();
    }
  });

  test("admission separates caller request time from the trusted transition clock", async () => {
    const opened = await openMigratedState();
    try {
      const first = submitIndependentReview(
        opened.db,
        submission({ submitted_at: at(0) }),
        { now: at(10) },
      );
      expect(first.projection).toMatchObject({
        created_at: at(10),
        updated_at: at(10),
      });
      const persisted = opened.db.prepare(
        `SELECT request_json, created_at, updated_at
         FROM review_instances WHERE instance_id = ?`,
      ).get(first.projection.instance_id) as {
        request_json: string;
        created_at: string;
        updated_at: string;
      };
      expect(JSON.parse(persisted.request_json)).toMatchObject({ submitted_at: at(0) });
      expect(persisted).toMatchObject({ created_at: at(10), updated_at: at(10) });

      expect(submitIndependentReview(
        opened.db,
        submission({ submitted_at: at(0) }),
        { now: at(20) },
      )).toMatchObject({ created: false });
      expect(opened.db.prepare(
        "SELECT created_at, updated_at FROM review_instances WHERE instance_id = ?",
      ).get(first.projection.instance_id)).toEqual({
        created_at: at(10),
        updated_at: at(10),
      });
    } finally {
      opened.db.close();
    }
  });

  test("event identity cannot collide through delimiter-bearing instance and observation IDs", async () => {
    const opened = await openMigratedState();
    try {
      const first = adoptLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission({ instance_id: "x" })).projection,
      );
      expect(recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: first.instance_id,
        observation_id: "o:admitted",
        reviewer_run_id: first.attempt.reviewer_run_id,
        run_state: "running",
        observed_at: at(4),
      }).recorded).toBe(true);

      const second = submitIndependentReview(
        opened.db,
        submission({
          instance_id: "x:run-observation:o",
          admission_key: "polli-labs/calyx-dev#300@delimiter-second",
          subject: "operator:delimiter-second",
          reviewer_run_id: "review-run-delimiter-second",
          launch_id: "review-launch-delimiter-second",
        }),
        { now: at(5) },
      );
      expect(second.created).toBe(true);
      const firstEvents = listIndependentReviewEvents(opened.db, first.instance_id);
      const secondEvents = listIndependentReviewEvents(opened.db, second.projection.instance_id);
      expect(secondEvents).toHaveLength(1);
      expect(new Set([...firstEvents, ...secondEvents].map((event) => event.event_id)).size)
        .toBe(firstEvents.length + secondEvents.length);
      expect([...firstEvents, ...secondEvents].every(
        (event) => /^review-event-[a-f0-9]{64}$/.test(event.event_id),
      )).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("admission refuses unbounded caller text, open launch capsules, and unsafe integers", async () => {
    const opened = await openMigratedState();
    try {
      expect(() => submitIndependentReview(opened.db, submission({
        instance_id: "x".repeat(257),
      }))).toThrow(/256-byte UTF-8 bound/);
      expect(() => submitIndependentReview(opened.db, submission({
        launch_request: {
          ...submission().launch_request,
          payload: "x".repeat(262_144),
        } as SubmitIndependentReviewInput["launch_request"],
      }))).toThrow(/must contain exactly/);
      expect(() => submitIndependentReview(opened.db, submission({
        round: Number.MAX_SAFE_INTEGER + 1,
      }))).toThrow(/positive safe integer/);
      expect((opened.db.prepare("SELECT COUNT(*) AS count FROM review_instances").get() as {
        count: number;
      }).count).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("renewal preserves a fence while reacquisition and stale fences fail closed", async () => {
    const opened = await openMigratedState();
    try {
      const projection = submitIndependentReview(opened.db, submission()).projection;
      const claim = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: 30_000,
        now: at(1),
      });
      claimIndependentReviewEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(2),
      });
      const renewed = renewIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        ttl_ms: 60_000,
        now: at(3),
      });
      expect(renewed.fence).toBe(claim.fence);
      expect(renewed.claim_until).toBe(at(63));
      expect(() => acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        ttl_ms: 30_000,
        now: at(4),
      })).toThrow(/renew the current fence/);
      expect(() => renewIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        ttl_ms: 1_000,
        now: at(5),
      })).toThrow(/cannot shorten/);
      expect(() => assertIndependentReviewFence(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:other",
        fence: claim.fence,
        now: at(6),
      })).toThrow(/not current/);
      const successor = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:successor",
        ttl_ms: 30_000,
        now: at(64),
      });
      expect(successor.fence).toBe(claim.fence + 1);
      expect(() => assertIndependentReviewFence(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(64),
      })).toThrow(/not current/);
    } finally {
      opened.db.close();
    }
  });

  test("claims enforce a sixty-second ceiling and release only the exact fence", async () => {
    const opened = await openMigratedState();
    try {
      const projection = submitIndependentReview(opened.db, submission()).projection;
      const beforeOversized = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS + 1,
        now: at(1),
      })).toThrow(/must not exceed 60000ms/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(beforeOversized);

      const claim = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS,
        now: at(1),
      });
      expect(claim.claim_until).toBe(at(61));
      claimIndependentReviewEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(2),
      });
      expect(() => renewIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS + 1,
        now: at(3),
      })).toThrow(/must not exceed 60000ms/);

      expect(releaseIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(3),
      })).toMatchObject({ released: true, fence: claim.fence });
      const afterRelease = durableCoordinatorState(opened.db, projection.instance_id);
      expect(releaseIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(4),
      })).toMatchObject({ released: false, fence: claim.fence });
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(afterRelease);
      expect((opened.db.prepare(
        "SELECT status FROM review_effects WHERE effect_id = ?",
      ).get(projection.launch.effect_id) as { status: string }).status).toBe("claimed");

      const successor = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:successor",
        ttl_ms: 30_000,
        now: at(5),
      });
      expect(successor.fence).toBe(claim.fence + 1);
      const successorState = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => releaseIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(6),
      })).toThrow(/stale/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(successorState);
    } finally {
      opened.db.close();
    }
  });

  test("an indeterminate launch creates one launch-specific obligation", async () => {
    const opened = await openMigratedState();
    try {
      const projection = submitIndependentReview(opened.db, submission()).projection;
      const claim = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: 30_000,
        now: at(1),
      });
      claimIndependentReviewEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(2),
      });
      const result = adoptReviewerLaunchEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        effect_request_hash: projection.launch.request_hash,
        claimed_fence: claim.fence,
        outcome: {
          status: "indeterminate",
          run_id: projection.attempt.reviewer_run_id,
          observed_intent_hash: projection.attempt.launch_intent_hash,
          reason_code: "supervisor_timeout",
        },
        observed_at: at(3),
      });
      expect(result.projection).toMatchObject({
        state: "launch_indeterminate",
        terminal_at: null,
        axes: { intrinsic: "pending", publication: "not_started", disposition: "pending" },
        launch: { reconciliation: null },
        open_obligations: [{
          kind: "reviewer_launch_reconciliation",
          obligation_key: "reviewer",
          status: "pending",
        }],
      });
    } finally {
      opened.db.close();
    }
  });

  test("RunService reconciles an indeterminate launch as adopted without a live reducer claim", async () => {
    const opened = await openMigratedState();
    try {
      const indeterminate = adoptIndeterminateLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const before = opened.db.prepare(
        "SELECT adoption_json, adoption_hash FROM review_effects WHERE effect_id = ?",
      ).get(indeterminate.launch.effect_id) as { adoption_json: string; adoption_hash: string };
      const rowCountsBefore = {
        attempts: (opened.db.prepare("SELECT COUNT(*) AS count FROM review_attempts").get() as { count: number }).count,
        effects: (opened.db.prepare("SELECT COUNT(*) AS count FROM review_effects").get() as { count: number }).count,
      };

      const adoptedObservation = launchReconciliationObservation(indeterminate);
      const result = recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: indeterminate.instance_id,
        observation: adoptedObservation,
        observed_at: at(40),
      });

      expect(result).toMatchObject({
        recorded: true,
        projection: {
          state: "reviewing",
          terminal_at: null,
          axes: { intrinsic: "pending", publication: "not_started", disposition: "active" },
          attempt: { status: "running", run_state: "queued" },
          launch: {
            status: "succeeded",
            reconciliation: {
              observation_count: 1,
              indeterminate_observed: false,
              latest_observation: { status: "adopted" },
            },
          },
          open_obligations: [],
        },
      });
      expect(opened.db.prepare(
        "SELECT adoption_json, adoption_hash FROM review_effects WHERE effect_id = ?",
      ).get(indeterminate.launch.effect_id)).toEqual(before);
      expect({
        attempts: (opened.db.prepare("SELECT COUNT(*) AS count FROM review_attempts").get() as { count: number }).count,
        effects: (opened.db.prepare("SELECT COUNT(*) AS count FROM review_effects").get() as { count: number }).count,
      }).toEqual(rowCountsBefore);
      expect((opened.db.prepare(
        "SELECT status FROM review_obligations WHERE instance_id = ? AND kind = 'reviewer_launch_reconciliation'",
      ).get(indeterminate.instance_id) as { status: string }).status).toBe("resolved");
      const serialized = JSON.stringify(result.projection.launch.reconciliation);
      expect(serialized).not.toContain("supervisor_receipt_digest");
      expect(serialized).not.toContain("reason_code");
      expect(serialized).not.toContain(LAUNCH_RECEIPT_DIGEST);
      expect(recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: indeterminate.instance_id,
        observation: adoptedObservation,
        observed_at: at(40),
      }).recorded).toBe(false);
      expect(() => recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: indeterminate.instance_id,
        observation: launchReconciliationObservation(indeterminate, {
          observation_id: "launch-reconciliation-conflict",
          status: "failed",
          reason_code: "cannot_override_adopted",
        }),
        observed_at: at(41),
      })).toThrow(/already resolved or no longer pending/);
    } finally {
      opened.db.close();
    }
  });

  test("RunService reconciles a known launch failure terminally and preserves original adoption", async () => {
    const opened = await openMigratedState();
    try {
      const indeterminate = adoptIndeterminateLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const before = opened.db.prepare(
        "SELECT adoption_json, adoption_hash FROM review_effects WHERE effect_id = ?",
      ).get(indeterminate.launch.effect_id);
      const result = recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: indeterminate.instance_id,
        observation: launchReconciliationObservation(indeterminate, {
          status: "failed",
          reason_code: "supervisor_tombstone",
        }),
        observed_at: at(4),
      });
      expect(result.projection).toMatchObject({
        state: "terminal",
        terminal_at: at(4),
        axes: { intrinsic: "invalid", publication: "not_started", disposition: "failed" },
        attempt: { status: "failed", run_state: null },
        launch: {
          status: "failed",
          reconciliation: { latest_observation: { status: "failed" } },
        },
        open_obligations: [],
      });
      expect(opened.db.prepare(
        "SELECT adoption_json, adoption_hash FROM review_effects WHERE effect_id = ?",
      ).get(indeterminate.launch.effect_id)).toEqual(before);
    } finally {
      opened.db.close();
    }
  });

  test("indeterminate reconciliation is append-only, replay-safe, reason-only, and unresolved", async () => {
    const opened = await openMigratedState();
    try {
      const projection = adoptIndeterminateLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const observation = launchReconciliationObservation(projection, {
        status: "indeterminate",
        reason_code: "supervisor_unreachable",
      });
      const first = recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation,
        observed_at: at(4),
      });
      expect(first).toMatchObject({
        recorded: true,
        projection: {
          state: "launch_indeterminate",
          terminal_at: null,
          axes: { intrinsic: "pending", publication: "not_started", disposition: "pending" },
          launch: {
            status: "indeterminate",
            reconciliation: {
              observation_count: 1,
              indeterminate_observed: true,
              latest_observation: { status: "indeterminate" },
            },
          },
          open_obligations: [{ kind: "reviewer_launch_reconciliation", status: "pending" }],
        },
      });
      expect(recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation,
        observed_at: at(4),
      }).recorded).toBe(false);
      expect(() => recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation: {
          ...observation,
          reason_code: "different_bytes",
        } as ReviewerLaunchReconciliationObservation,
        observed_at: at(4),
      })).toThrow(/different bytes/);
      expect(() => recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation: {
          ...observation,
          observation_id: "unknown-field",
          supervisor_receipt_digest: LAUNCH_RECEIPT_DIGEST,
        } as ReviewerLaunchReconciliationObservation,
        observed_at: at(5),
      })).toThrow(/closed status-specific contract/);
    } finally {
      opened.db.close();
    }
  });

  test("launch reconciliation is bound to the original attempt, adoption, and exact obligation", async () => {
    const opened = await openMigratedState();
    try {
      const first = adoptIndeterminateLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const second = adoptIndeterminateLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission({
          instance_id: "review-instance-2",
          admission_key: "polli-labs/calyx-dev#301@bbbbbbbb",
          reviewer_run_id: "review-run-2",
          launch_id: "review-launch-2",
        })).projection,
      );
      expect(() => recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: second.instance_id,
        observation: launchReconciliationObservation(first),
        observed_at: at(4),
      })).toThrow(/does not match the original adoption and attempt/);

      opened.db.prepare(
        "UPDATE review_obligations SET detail_json = ? WHERE instance_id = ? AND kind = 'reviewer_launch_reconciliation'",
      ).run(canonicalizeIndependentReviewJson({ adoption_hash: "0".repeat(64) }), first.instance_id);
      expect(() => recordReviewerLaunchReconciliationFromRunService(opened.db, {
        instance_id: first.instance_id,
        observation: launchReconciliationObservation(first),
        observed_at: at(4),
      })).toThrow(/no exact launch reconciliation obligation/);
    } finally {
      opened.db.close();
    }
  });

  test("RunService owns leaf observation and evidence entrypoints at the package boundary", async () => {
    const publicApi = await import("../index.js") as Record<string, unknown>;
    expect(publicApi["submitIndependentReview"]).toBeUndefined();
    expect(publicApi["recordReviewerRunObservationFromRunService"]).toBeUndefined();
    expect(publicApi["recordReviewerLaunchReconciliationFromRunService"]).toBeUndefined();
    expect(publicApi["recordIndependentReviewEvidenceFromRunService"]).toBeUndefined();
    expect(publicApi["adoptReviewPublicationEffect"]).toBeUndefined();
    expect(publicApi["recordReviewPublicationObservation"]).toBeUndefined();
    expect(RunService.prototype.observeIndependentReviewRun).toBeTypeOf("function");
    expect(RunService.prototype.recordIndependentReviewEvidence).toBeTypeOf("function");
    expect(RunService.prototype.readIndependentReviewAdminProjection).toBeTypeOf("function");
  });

  test("internal leaf observations are monotonic, replay-safe, and launch-gated", async () => {
    const opened = await openMigratedState();
    try {
      const admitted = submitIndependentReview(opened.db, submission()).projection;
      expect(() => recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: admitted.instance_id,
        observation_id: "too-early",
        reviewer_run_id: admitted.attempt.reviewer_run_id,
        run_state: "running",
        observed_at: at(1),
      })).toThrow(/adopted reviewer launch/);
      const launched = adoptLaunch(opened.db, admitted);
      const running = recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: launched.instance_id,
        observation_id: "running-1",
        reviewer_run_id: launched.attempt.reviewer_run_id,
        run_state: "running",
        observed_at: at(4),
      });
      expect(running).toMatchObject({ recorded: true, projection: { state: "reviewing" } });
      expect(recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: launched.instance_id,
        observation_id: "running-1",
        reviewer_run_id: launched.attempt.reviewer_run_id,
        run_state: "running",
        observed_at: at(4),
      }).recorded).toBe(false);
      expect(() => recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: launched.instance_id,
        observation_id: "queued-regression",
        reviewer_run_id: launched.attempt.reviewer_run_id,
        run_state: "queued",
        observed_at: at(5),
      })).toThrow(/cannot regress/);
    } finally {
      opened.db.close();
    }
  });

  test("every reducer write rejects a clock older than its durable dependencies", async () => {
    const opened = await openMigratedState();
    try {
      let projection = submitIndependentReview(
        opened.db,
        submission({ submitted_at: at(0) }),
        { now: at(10) },
      ).projection;

      let before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS,
        now: at(9),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);

      const claim = acquireIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: "daemon:blade",
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS,
        now: at(11),
      });
      before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => renewIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        ttl_ms: MAX_REVIEW_CLAIM_TTL_MS,
        now: at(10),
      })).toThrow(/precedes durable/);
      expect(() => releaseIndependentReviewClaim(opened.db, {
        instance_id: projection.instance_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(10),
      })).toThrow(/precedes durable/);
      expect(() => claimIndependentReviewEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(10),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);

      claimIndependentReviewEffect(opened.db, {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        owner: claim.owner,
        fence: claim.fence,
        now: at(12),
      });
      const launchInput = {
        instance_id: projection.instance_id,
        effect_id: projection.launch.effect_id,
        effect_request_hash: projection.launch.request_hash,
        claimed_fence: claim.fence,
        outcome: {
          status: "created" as const,
          run_id: projection.attempt.reviewer_run_id,
          observed_intent_hash: projection.attempt.launch_intent_hash,
          receipt_digest: LAUNCH_RECEIPT_DIGEST,
        },
      };
      before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => adoptReviewerLaunchEffect(opened.db, {
        ...launchInput,
        observed_at: at(11),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);
      projection = adoptReviewerLaunchEffect(opened.db, {
        ...launchInput,
        observed_at: at(13),
      }).projection;

      before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation_id: "backdated-run",
        reviewer_run_id: projection.attempt.reviewer_run_id,
        run_state: "succeeded",
        observed_at: at(12),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);
      projection = recordReviewerRunObservationFromRunService(opened.db, {
        instance_id: projection.instance_id,
        observation_id: "current-run",
        reviewer_run_id: projection.attempt.reviewer_run_id,
        run_state: "succeeded",
        observed_at: at(14),
      }).projection;

      const artifact = findings(projection);
      const evidenceInput = {
        instance_id: projection.instance_id,
        artifact,
        evidence_receipt: runEvidenceReceipt(projection, artifact),
        reviewer_run_issue: "POL-1983",
        publisher_identities: publisherIdentities(),
      };
      before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => recordIndependentReviewEvidenceFromRunService(opened.db, {
        ...evidenceInput,
        recorded_at: at(13),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);
      projection = recordIndependentReviewEvidenceFromRunService(opened.db, {
        ...evidenceInput,
        recorded_at: at(15),
      }).projection;

      const github = claimPublicationEffect(opened.db, projection, "github_review", at(16));
      before = durableCoordinatorState(opened.db, projection.instance_id);
      expect(() => recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation: providerObservation(
          "backdated-provider",
          "github_review",
          "indeterminate",
        ),
        observed_at: at(15),
      })).toThrow(/precedes durable/);
      expect(durableCoordinatorState(opened.db, projection.instance_id)).toEqual(before);
    } finally {
      opened.db.close();
    }
  });

  test("the internal evidence reducer rejects forged correspondence before occupying identity", async () => {
    const opened = await openMigratedState();
    try {
      const projection = prepareAwaitingEvidence(opened.db);
      const artifact = findings(projection);
      const forged = {
        ...runEvidenceReceipt(projection, artifact),
        run_id: "review-run-forged",
      };
      expect(() => recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: projection.instance_id,
        artifact,
        evidence_receipt: forged,
        reviewer_run_issue: "POL-1983",
        publisher_identities: publisherIdentities(),
        recorded_at: at(6),
      })).toThrow(/does not correspond/);
      expect((opened.db.prepare("SELECT COUNT(*) AS count FROM review_evidence").get() as {
        count: number;
      }).count).toBe(0);
      expect(recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: projection.instance_id,
        artifact,
        evidence_receipt: runEvidenceReceipt(projection, artifact),
        reviewer_run_issue: "POL-1983",
        publisher_identities: publisherIdentities(),
        recorded_at: at(6),
      }).recorded).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("RunService resolves terminal receipt and bytes, then mints source and canonical evidence", async () => {
    const opened = await openMigratedState();
    try {
      const launched = adoptLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const artifact = findings(launched);
      const source = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const artifactPath = path.join(tempRoot, "artifacts", "findings.json");
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, source);
      let now = at(0);
      const service = new RunService(
        {
          runsRoot: path.join(tempRoot, "runs"),
          reviewCoordinatorPublisherIdentities: publisherIdentities(),
        },
        { now: () => now },
      );
      await publishAuthoritativeKernelReceipt(
        service,
        makeKernelReceipt(launched.attempt.reviewer_run_id, artifactPath, source),
      );
      now = at(5);
      expect(await service.observeIndependentReviewRun({
        instance_id: launched.instance_id,
        observation_id: "service-succeeded-1",
      })).toMatchObject({ recorded: true, projection: { state: "awaiting_evidence" } });
      now = at(6);
      const result = await service.recordIndependentReviewEvidence({
        instance_id: launched.instance_id,
      });
      expect(result).toMatchObject({
        recorded: true,
        evaluation: { intrinsic_status: "passed" },
        projection: {
          state: "awaiting_publication",
          evidence: { artifact_locator: "calyx-run-artifact:review-run-1:findings.json" },
        },
      });
      const persisted = opened.db.prepare(
        "SELECT receipt_json, artifact_digest FROM review_evidence WHERE instance_id = ?",
      ).get(launched.instance_id) as { receipt_json: string; artifact_digest: string };
      const receipt = JSON.parse(persisted.receipt_json) as ReviewRunEvidenceReceipt;
      const canonical = canonicalizeIndependentReviewJson(artifact);
      expect(receipt.artifact).toMatchObject({
        source_sha256: createHash("sha256").update(source).digest("hex"),
        source_size_bytes: source.byteLength,
        canonical_sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
        canonical_size_bytes: Buffer.byteLength(canonical, "utf8"),
      });
      expect(receipt.artifact.source_sha256).not.toBe(receipt.artifact.canonical_sha256);
      expect(persisted.artifact_digest).toBe(receipt.artifact.canonical_sha256);
      expect(receipt.issued_at).toBe(at(5));

      now = at(20);
      const replay = await service.recordIndependentReviewEvidence({
        instance_id: launched.instance_id,
      });
      expect(replay).toMatchObject({
        recorded: false,
        projection: { observed_at: at(20), state: "awaiting_publication" },
      });
      const replayedReceipt = (opened.db.prepare(
        "SELECT receipt_json FROM review_evidence WHERE instance_id = ?",
      ).get(launched.instance_id) as { receipt_json: string }).receipt_json;
      expect(replayedReceipt).toBe(persisted.receipt_json);
    } finally {
      opened.db.close();
    }
  });

  test("RunService refuses malformed receipts and source bytes that disagree with receipt authority", async () => {
    const opened = await openMigratedState();
    try {
      const launched = adoptLaunch(
        opened.db,
        submitIndependentReview(opened.db, submission()).projection,
      );
      const artifact = findings(launched);
      const source = Buffer.from(JSON.stringify(artifact), "utf8");
      const artifactPath = path.join(tempRoot, "artifacts", "findings.json");
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, source);
      const runsRoot = path.join(tempRoot, "runs");
      let now = at(0);
      const orphanService = new RunService(
        { runsRoot, reviewCoordinatorPublisherIdentities: publisherIdentities() },
        { now: () => now },
      );
      await orphanService.store.writeKernelReceipt(
        launched.attempt.reviewer_run_id,
        makeKernelReceipt(launched.attempt.reviewer_run_id, artifactPath, source),
      );
      now = at(5);
      await expect(orphanService.observeIndependentReviewRun({
        instance_id: launched.instance_id,
        observation_id: "orphan-receipt-1",
      })).rejects.toThrow(/cannot establish authoritative terminal receipt state/);

      await rm(runsRoot, { recursive: true, force: true });
      now = at(0);
      const service = new RunService({
        runsRoot,
        reviewCoordinatorPublisherIdentities: publisherIdentities(),
      }, { now: () => now });
      const malformed = makeKernelReceipt(launched.attempt.reviewer_run_id, artifactPath, source);
      malformed.summary = "";
      await publishAuthoritativeKernelReceipt(service, malformed);
      now = at(5);
      await expect(service.observeIndependentReviewRun({
        instance_id: launched.instance_id,
        observation_id: "malformed-1",
      })).rejects.toThrow(/malformed/);

      const mismatched = makeKernelReceipt(launched.attempt.reviewer_run_id, artifactPath, source);
      mismatched.artifacts.required[0]!.sha256 = "0".repeat(64);
      await replaceAuthoritativeKernelReceipt(service, mismatched);
      await expect(service.recordIndependentReviewEvidence({
        instance_id: launched.instance_id,
      })).rejects.toThrow(/bytes do not match/);
      expect((opened.db.prepare("SELECT COUNT(*) AS count FROM review_evidence").get() as {
        count: number;
      }).count).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("RunService rejects duplicate JSON members before evidence or effect mutation", async () => {
    const opened = await openMigratedState();
    try {
      const cases = [
        {
          name: "root",
          mutate: (source: string) => source.replace(
            /^\{/,
            '{"schema_version":"review-findings/v2",',
          ),
        },
        {
          name: "nested",
          mutate: (source: string) => source.replace(
            '"target":{"repository":',
            '"target":{"repository":"polli-labs/calyx-dev","repository":',
          ),
        },
        {
          name: "escaped",
          mutate: (source: string) => source.replace(
            /^\{/,
            '{"ver\\u0064ict":"mergeable",',
          ),
        },
      ];
      for (const [index, duplicateCase] of cases.entries()) {
        const suffix = String(index + 1);
        const launched = adoptLaunch(
          opened.db,
          submitIndependentReview(opened.db, submission({
            instance_id: `duplicate-instance-${suffix}`,
            admission_key: `duplicate-admission-${suffix}`,
            subject: `operator:duplicate-${suffix}`,
            reviewer_run_id: `duplicate-run-${suffix}`,
            launch_id: `duplicate-launch-${suffix}`,
          })).projection,
        );
        const artifact = findings(launched);
        const source = Buffer.from(duplicateCase.mutate(JSON.stringify(artifact)), "utf8");
        const artifactPath = path.join(
          tempRoot,
          "artifacts",
          duplicateCase.name,
          "findings.json",
        );
        await mkdir(path.dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, source);
        let now = at(0);
        const service = new RunService({
          runsRoot: path.join(tempRoot, `runs-${duplicateCase.name}`),
          reviewCoordinatorPublisherIdentities: publisherIdentities(),
        }, { now: () => now });
        await publishAuthoritativeKernelReceipt(
          service,
          makeKernelReceipt(launched.attempt.reviewer_run_id, artifactPath, source),
        );
        now = at(5);
        await service.observeIndependentReviewRun({
          instance_id: launched.instance_id,
          observation_id: `duplicate-succeeded-${suffix}`,
        });
        now = at(6);
        await expect(service.recordIndependentReviewEvidence({
          instance_id: launched.instance_id,
        })).rejects.toThrow(/without duplicate object members/);
        expect((opened.db.prepare(
          "SELECT COUNT(*) AS count FROM review_evidence WHERE instance_id = ?",
        ).get(launched.instance_id) as { count: number }).count).toBe(0);
        expect((opened.db.prepare(
          `SELECT COUNT(*) AS count FROM review_effects
            WHERE instance_id = ? AND kind = 'provider_publication'`,
        ).get(launched.instance_id) as { count: number }).count).toBe(0);
      }
    } finally {
      opened.db.close();
    }
  });

  test("evidence creates one immutable effect and obligation per closed provider", async () => {
    const opened = await openMigratedState();
    try {
      const projection = prepareAwaitingPublication(opened.db);
      expect(projection.publication?.effects.map((effect) => effect.adapter)).toEqual([
        "github_review",
        "linear_comment",
      ]);
      expect(projection.open_obligations.map((obligation) => obligation.obligation_key)).toEqual([
        "github_review",
        "linear_comment",
      ]);
      const requests = opened.db.prepare(
        "SELECT effect_key, request_json, adoption_json FROM review_effects WHERE kind = 'provider_publication' ORDER BY effect_key",
      ).all() as Array<{ effect_key: string; request_json: string; adoption_json: string | null }>;
      expect(requests).toHaveLength(2);
      expect(requests[0]!.request_json).toContain('"github_review"');
      expect(requests[0]!.request_json).not.toContain('"POL-1983"');
      expect(requests[1]!.request_json).toContain('"POL-1983"');
      expect(JSON.parse(requests[0]!.request_json)).toMatchObject({
        adapter: "github_review",
        envelope: {
          repository: "polli-labs/calyx-dev",
          pull_request: 300,
          publisher_author_node_id: "github-publisher-node-1",
        },
      });
      expect(JSON.parse(requests[1]!.request_json)).toMatchObject({
        adapter: "linear_comment",
        envelope: {
          issue: "POL-1983",
          publisher_actor_id: "linear-publisher-actor-1",
        },
      });
      expect(requests[0]!.request_json).toContain("Calyx independent review receipt");
      expect(requests[0]!.request_json).toContain("calyx-independent-review/v1");
      expect(requests.every((request) => request.adoption_json === null)).toBe(true);
    } finally {
      opened.db.close();
    }
  });

  test("immutable admission target and daemon publisher authority gate evidence effects", async () => {
    const opened = await openMigratedState();
    try {
      const projection = prepareAwaitingEvidence(opened.db);
      const artifact = findings(projection);
      expect(() => recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: projection.instance_id,
        artifact,
        evidence_receipt: runEvidenceReceipt(projection, artifact),
        reviewer_run_issue: "POL-9999",
        publisher_identities: publisherIdentities(),
        recorded_at: at(6),
      })).toThrow(/does not match the immutable publication target/);

      expect(() => recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: projection.instance_id,
        artifact,
        evidence_receipt: runEvidenceReceipt(projection, artifact),
        reviewer_run_issue: "POL-1983",
        publisher_identities: {
          ...publisherIdentities(),
          linear_actor_id: "forged\nactor",
        },
        recorded_at: at(6),
      })).toThrow(/bounded non-empty identifier/);
      expect((opened.db.prepare("SELECT COUNT(*) AS count FROM review_evidence").get() as {
        count: number;
      }).count).toBe(0);
      expect((opened.db.prepare(
        "SELECT COUNT(*) AS count FROM review_effects WHERE kind = 'provider_publication'",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      opened.db.close();
    }
  });

  test("worker evidence text cannot occupy the global evidence identity namespace", async () => {
    const opened = await openMigratedState();
    try {
      const first = prepareAwaitingEvidenceFor(
        opened.db,
        submission(),
        "run-succeeded-first",
      );
      const second = prepareAwaitingEvidenceFor(opened.db, submission({
        instance_id: "review-instance-2",
        admission_key: "polli-labs/calyx-dev#300@bbbbbbbb:second",
        subject: "operator:second",
        reviewer_run_id: "review-run-2",
        launch_id: "review-launch-2",
      }), "run-succeeded-second");
      const firstArtifact = { ...findings(first), evidence_id: "worker-global-evidence" };
      const secondArtifact = { ...findings(second), evidence_id: "worker-global-evidence" };
      const firstResult = recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: first.instance_id,
        artifact: firstArtifact,
        evidence_receipt: runEvidenceReceipt(first, firstArtifact),
        reviewer_run_issue: "POL-1983",
        publisher_identities: publisherIdentities(),
        recorded_at: at(6),
      });
      const secondResult = recordIndependentReviewEvidenceFromRunService(opened.db, {
        instance_id: second.instance_id,
        artifact: secondArtifact,
        evidence_receipt: runEvidenceReceipt(second, secondArtifact),
        reviewer_run_issue: "POL-1983",
        publisher_identities: publisherIdentities(),
        recorded_at: at(6),
      });
      expect(firstResult.evaluation).toMatchObject({
        intrinsic_status: "invalid",
        invalid_reasons: expect.arrayContaining(["evidence_id_mismatch"]),
      });
      expect(secondResult.evaluation).toMatchObject({
        intrinsic_status: "invalid",
        invalid_reasons: expect.arrayContaining(["evidence_id_mismatch"]),
      });
      expect(firstResult.evaluation.evidence_id).not.toBe(secondResult.evaluation.evidence_id);
      expect(firstResult.evaluation.evidence_id).not.toBe("worker-global-evidence");
      expect((opened.db.prepare("SELECT COUNT(*) AS count FROM review_evidence").get() as {
        count: number;
      }).count).toBe(2);
    } finally {
      opened.db.close();
    }
  });

  test("source-only provider observations preserve obligations and cannot claim delivery", async () => {
    const opened = await openMigratedState();
    try {
      let projection = prepareAwaitingPublication(opened.db);
      const github = claimPublicationEffect(opened.db, projection, "github_review", at(7));
      const observation = providerObservation(
        "github-observation-1",
        "github_review",
        "indeterminate",
      );
      projection = recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation,
        observed_at: at(8),
      }).projection;
      expect(projection).toMatchObject({
        state: "awaiting_publication",
        axes: { publication: "indeterminate", disposition: "awaiting_publication" },
        open_obligations: [
          { obligation_key: "github_review" },
          { obligation_key: "linear_comment" },
        ],
      });
      expect(publicationEffect(projection, "github_review")).toMatchObject({
        status: "indeterminate",
        observation_count: 1,
        indeterminate_observed: true,
      });
      expect(recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation,
        observed_at: at(8),
      }).recorded).toBe(false);
      const forgedDelivered = {
        ...observation,
        observation_id: "github-forged-delivered",
        status: "delivered",
      } as unknown as ProviderPublicationObservation;
      expect(() => recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation: forgedDelivered,
        observed_at: at(9),
      })).toThrow(/invalid or unbounded/);
      expect(projection.axes.disposition).not.toBe("ready");
    } finally {
      opened.db.close();
    }
  });

  test("unresolved provider observation identities are effect-scoped, closed, and bounded", async () => {
    const opened = await openMigratedState();
    try {
      const projection = prepareAwaitingPublication(opened.db);
      const github = claimPublicationEffect(opened.db, projection, "github_review", at(7));
      const linear = claimPublicationEffect(opened.db, projection, "linear_comment", at(7));
      recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation: providerObservation("provider-observation-1", "github_review", "degraded"),
        observed_at: at(8),
      });
      recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: linear.effect_id,
        effect_request_hash: linear.request_hash,
        claimed_fence: linear.claimed_fence,
        observation: providerObservation("provider-observation-1", "linear_comment", "indeterminate"),
        observed_at: at(9),
      });
      expect((opened.db.prepare(
        "SELECT COUNT(*) AS count FROM review_effect_observations WHERE observation_id = ?",
      ).get("provider-observation-1") as { count: number }).count).toBe(2);

      const forged = {
        ...providerObservation("forged", "linear_comment", "indeterminate"),
        extra: "authority",
      } as unknown as ProviderPublicationObservation;
      expect(() => recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: linear.effect_id,
        effect_request_hash: linear.request_hash,
        claimed_fence: linear.claimed_fence,
        observation: forged,
        observed_at: at(10),
      })).toThrow(/closed reason-only contract/);

      for (let index = 1; index < 64; index += 1) {
        recordReviewPublicationObservation(opened.db, {
          instance_id: projection.instance_id,
          effect_id: github.effect_id,
          effect_request_hash: github.request_hash,
          claimed_fence: github.claimed_fence,
          observation: providerObservation(
            `github-bounded-${String(index)}`,
            "github_review",
            "degraded",
          ),
          observed_at: at(10 + index),
        });
      }
      expect(() => recordReviewPublicationObservation(opened.db, {
        instance_id: projection.instance_id,
        effect_id: github.effect_id,
        effect_request_hash: github.request_hash,
        claimed_fence: github.claimed_fence,
        observation: providerObservation("github-bounded-64", "github_review", "degraded"),
        observed_at: at(74),
      })).toThrow(/bounded to 64 rows/);
    } finally {
      opened.db.close();
    }
  });

  test("the admin projection is explicit-time, bounded, positive, and fail-closed", async () => {
    const opened = await openMigratedState();
    try {
      const projection = prepareAwaitingPublication(opened.db);
      const invalidReasons = Array.from({ length: 80 }, (_, index) => `reason-${String(index).padStart(2, "0")}`);
      opened.db.prepare(
        "UPDATE review_evidence SET invalid_reasons_json = ? WHERE instance_id = ?",
      ).run(canonicalizeIndependentReviewJson(invalidReasons), projection.instance_id);
      const observed = readIndependentReviewAdminProjection(opened.db, projection.instance_id, {
        now: at(31),
      });
      expect(observed).toMatchObject({
        observed_at: at(31),
        claim: { held: false },
        evidence: { invalid_reason_count: 80 },
      });
      expect(observed?.evidence?.invalid_reasons).toHaveLength(64);
      const serialized = JSON.stringify(observed);
      expect(serialized).not.toContain(tempRoot);
      expect(serialized).not.toContain("daemon:blade");
      expect(serialized).not.toContain("body_digest");
      expect(serialized).not.toContain("provider_receipt");
      opened.db.prepare(
        "UPDATE review_evidence SET receipt_hash = ? WHERE instance_id = ?",
      ).run("0".repeat(64), projection.instance_id);
      expect(() => readIndependentReviewAdminProjection(opened.db, projection.instance_id, {
        now: at(31),
      })).toThrow(/malformed persisted RunService evidence authority/);
    } finally {
      opened.db.close();
    }
  });

  test("findings evaluation remains strict and digest-bound", () => {
    const expected = {
      instance_id: "review-instance-1",
      attempt_id: "review-attempt-1",
      reviewer_run_id: "review-run-1",
      round: 1,
      producer_generation: 7,
      producer_fence: 11,
      target: { repository: "polli-labs/calyx-dev", pull_request: 300, commit_sha: TARGET_SHA },
    };
    const artifact = {
      schema_version: "review-findings/v2",
      evidence_id: `review-evidence-${hashIndependentReviewValue([
        expected.instance_id,
        expected.attempt_id,
      ]).slice(0, 32)}`,
      review_instance_id: expected.instance_id,
      reviewer_run_id: expected.reviewer_run_id,
      reviewer_attempt_id: expected.attempt_id,
      round: expected.round,
      producer_generation: expected.producer_generation,
      producer_fence: expected.producer_fence,
      target: expected.target,
      review_status: "complete",
      coverage_status: "full",
      verdict: "mergeable",
      counts: { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 },
      findings: [],
    };
    const digest = hashIndependentReviewValue(artifact);
    expect(evaluateReviewFindingsV2(artifact, {
      ...expected,
      expected_artifact_digest: digest,
    })).toMatchObject({ intrinsic_status: "passed", artifact_digest: digest });
    expect(evaluateReviewFindingsV2({ ...artifact, unknown: true }, {
      ...expected,
      expected_artifact_digest: hashIndependentReviewValue({ ...artifact, unknown: true }),
    })).toMatchObject({ intrinsic_status: "invalid", invalid_reasons: ["artifact_unknown_field"] });
  });
});
