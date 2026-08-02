import { describe, expect, test, vi } from "vitest";
import {
  INTERFACE_DOMAIN_CLASSIFICATIONS,
  INTERFACE_EXTERNAL_SERVICE_DESCRIPTORS,
  INTERFACE_MANIFEST_RECORDS,
  INTERFACE_MANIFEST_SCHEMA_VERSION,
  type InterfaceManifestRecord,
  type InterfaceSafetyContract,
} from "@polli-labs/calyx-core";
import { buildProgram } from "../run-cli";
import type { Command } from "commander";

const REQUIRED_FULL_RECORD_IDS = [
  "agent-context",
  "instructions.stack",
  "agents.list",
  "agents.show",
  "agents.validate",
  "client.replay",
  "run.launch",
  "run.daemon.plan",
  "run.daemon.tick",
  "run.status",
  "run.await",
  "run.receipt",
  "run.doctor",
  "run.audit-terminal-authority",
  "tasks.install",
  "tasks.run",
  "tasks.pause",
  "tasks.resume",
  "tasks.reconcile",
  "tasks.history",
  "tasks.doctor",
  "msg.send",
  "msg.inbox",
  "msg.ack",
  "msg.thread",
  "msg.operation",
  "msg.doctor",
  "monitor.create",
  "monitor.list",
  "monitor.show",
  "monitor.cancel",
  "monitor.history",
  "monitor.inbox",
  "monitor.ack",
  "monitor.doctor",
  "lease.acquire",
  "lease.renew",
  "lease.release",
  "lease.steal",
  "lease.list",
  "lease.doctor",
  "fleet.status",
  "self.freshness",
  "self.upgrade",
  "activity.self",
  "activity.turns",
  "activity.messages",
  "activity.text",
  "activity.attachments",
  "context.capture",
  "vault.toc",
  "vault.section.get",
  "vault.frontmatter.get",
  "vault.frontmatter.query",
  "vault.journal.entries",
  "vault.journal.get",
  "vault.journal.append",
  "vault.footnotes.list",
  "vault.footnotes.get",
  "vault.footnotes.add",
  "vault.footnotes.lint",
  "vault.footnotes.gc",
  "vault.stamp",
  "oracle.bundle",
  "oracle.run",
] as const;

function commandPathExists(program: Command, pathParts: readonly string[]): boolean {
  let current = program;
  for (const part of pathParts) {
    const child = current.commands.find((command) => command.name() === part);
    if (!child) {
      return false;
    }
    current = child;
  }
  return true;
}

describe("interface manifest", () => {
  test("uses the Wave 4 skeleton schema version", () => {
    expect(INTERFACE_MANIFEST_SCHEMA_VERSION).toBe("calyx.interface-manifest/v0");
  });

  test("classifies every visible top-level Commander domain", () => {
    const program = buildProgram();
    const commanderDomains = program.commands.map((command) => command.name());
    const manifestDomains = INTERFACE_DOMAIN_CLASSIFICATIONS.map((record) => record.domain);

    expect(manifestDomains).toEqual(commanderDomains);
    for (const record of INTERFACE_DOMAIN_CLASSIFICATIONS) {
      expect(record.lifecycle_status).toBeTruthy();
      expect(record.domain_status).toBeTruthy();
      expect(typeof record.agent_facing).toBe("boolean");
      expect(record.mutation_risk).toBeTruthy();
      expect(record.owner).toBeTruthy();
      expect(record.source_of_truth).toBeTruthy();
      expect(record.wave4_disposition).toBeTruthy();
    }
  });

  test("keeps full first-slice records pointed at live Commander paths", () => {
    const program = buildProgram();
    const recordIds = new Set(INTERFACE_MANIFEST_RECORDS.map((record) => record.id));

    for (const id of REQUIRED_FULL_RECORD_IDS) {
      expect(recordIds, `missing required manifest record: ${id}`).toContain(id);
    }

    for (const record of INTERFACE_MANIFEST_RECORDS.filter((entry) => entry.invocation_kind === "commander")) {
      expect(record.surface_kind).toBe("cli_command");
      expect(record.execution_boundary).toBe("calyx_owned");
      expect(record.invocation_kind).toBe("commander");
      expect(commandPathExists(program, record.path), `missing Commander path for ${record.id}`).toBe(true);
      if (record.id !== "self.health") {
        expect(record.output_contract.schema_version, `${record.id} missing output schema version`).toBeTruthy();
      }
      expect(record.output_contract.json_schema_ref, `${record.id} missing JSON schema ref`).toBeTruthy();
      expect(record.error_contract.common_failures, `${record.id} missing common failures`).toBeDefined();
      expect(record.agent_context.command_path).toBe(record.path.join(" "));
    }
  });

  test("states the concrete agent posture enforcement contract", () => {
    const launch = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "run.launch");
    const notes = launch && "guardrail_notes" in launch.safety_contract
      ? launch.safety_contract.guardrail_notes?.join("\n")
      : "";

    expect(notes).toContain("workspace_mutation=forbidden");
    expect(notes).toContain("Claude allowed-tools");
    expect(notes).toContain("native Codex read-only sandbox on app-server and legacy exec");
    expect(notes).toContain("rejected before launch");
  });

  test("keeps HTTP API records explicit without pretending they are Commander paths", () => {
    const routeRecords: InterfaceManifestRecord[] = INTERFACE_MANIFEST_RECORDS
      .filter((record) => record.invocation_kind === "http_api");

    expect(routeRecords.map((record) => record.id)).toEqual(
      expect.arrayContaining([
        "http.admin.monitor.list",
        "http.admin.monitor.create",
        "http.admin.monitor.get",
        "http.admin.monitor.wakes",
        "http.admin.monitor.ack",
        "http.admin.monitor.cancel",
        "http.admin.msg.forward",
        "http.internal.msg.receive",
      ]),
    );
    for (const record of routeRecords) {
      expect(record.surface_kind).toBe("external_service");
      expect(record.execution_boundary).toBe("calyx_owned");
      expect(record.agent_context.command_path).toBe(`${record.path[0]} /${record.path.slice(1).join("/")}`);
      const guardrailNotes = "guardrail_notes" in record.safety_contract
        ? record.safety_contract.guardrail_notes
        : [];
      expect(guardrailNotes?.join("\n")).toContain(`Requires ${record.profile}.`);
      expect(record.operation_id).toBe(record.id.slice("http.".length));
    }

    const msgReceive = routeRecords.find((record) => record.id === "http.internal.msg.receive");
    expect(msgReceive?.output_contract.schema_version).toBe("calyx.msg-receive/v1");
    expect(msgReceive?.effects).toMatchObject({
      local_state: "read_write",
      process_launch: false,
      receipt_required: true,
    });
    expect(msgReceive?.async_contract).toMatchObject({
      background: false,
      resumable: false,
    });
    const msgGuardrailNotes = msgReceive && "guardrail_notes" in msgReceive.safety_contract
      ? msgReceive.safety_contract.guardrail_notes
      : [];
    expect(msgGuardrailNotes?.join("\n")).toContain("receiving daemon's state store");
  });

  test("declares owning-host transport and local observation effects for CLI HTTP siblings", () => {
    const byId = new Map(INTERFACE_MANIFEST_RECORDS.map((record) => [record.id, record]));

    expect(byId.get("run.logs")?.effects).toMatchObject({
      remote_provider: "read",
      process_launch: false,
    });
    expect(byId.get("run.doctor")?.effects).toMatchObject({
      remote_provider: "read",
      process_launch: true,
    });
    expect(byId.get("run.reconcile")?.effects).toMatchObject({
      local_state: "read_write",
      remote_provider: "read_write",
    });
    expect(byId.get("run.audit-terminal-authority")).toMatchObject({
      mutation_class: "read_only",
      effects: {
        local_files: "read",
        local_state: "read",
        remote_provider: "none",
        process_launch: false,
      },
    });
    expect(byId.get("run.stop")?.effects).toMatchObject({
      local_state: "read_write",
      remote_provider: "read_write",
    });
    expect(byId.get("run.ps")?.effects).toMatchObject({
      local_files: "read",
      local_state: "read",
      remote_provider: "read",
    });
    expect(byId.get("run.subscribe")).toMatchObject({
      capability: "work.observe",
      effects: {
        local_files: "none",
        local_state: "none",
        remote_provider: "read",
      },
      async_contract: {
        waitable: true,
        resumable: true,
        cancellable: true,
      },
    });
    expect(byId.get("run.status")?.output_contract).toMatchObject({
      schema_version: "calyx.run-status/v2",
      json_schema_ref: "RunStatusResult",
      response_economics: {
        default_tier: "decision",
        detail_tier: "explicit",
        formats: {
          text: { target_bytes: 1_024, hard_bytes: 4_096 },
          json: { target_bytes: 4_096, hard_bytes: 16_384 },
        },
      },
    });
    expect(byId.get("run.await")).toMatchObject({
      capability: "work.observe",
      mutation_class: "read_only",
      effects: {
        local_files: "read",
        local_state: "read",
        remote_provider: "read",
        process_launch: false,
      },
      output_contract: {
        schema_version: "calyx.run-await/v2",
        json_schema_ref: "RunAwaitResult",
        response_economics: {
          default_tier: "decision",
          detail_tier: "explicit",
          formats: {
            text: { target_bytes: 1_024, hard_bytes: 4_096 },
            json: { target_bytes: 4_096, hard_bytes: 16_384 },
          },
        },
      },
      async_contract: {
        waitable: true,
        resumable: true,
        cancellable: true,
      },
    });
    for (const id of ["run.status", "run.await"]) {
      const outputContract = byId.get(id)?.output_contract as
        | InterfaceManifestRecord["output_contract"]
        | undefined;
      const economics = outputContract?.response_economics;
      expect(economics, `${id} missing response economics`).toBeDefined();
      expect(economics?.formats.text.target_bytes).toBeLessThan(economics?.formats.text.hard_bytes ?? 0);
      expect(economics?.formats.json.target_bytes).toBeLessThan(economics?.formats.json.hard_bytes ?? 0);
      expect(economics?.priority_order.slice(0, 8)).toEqual([
        "schema_version",
        "run_id",
        "state",
        "terminal",
        "successful",
        "cause",
        "partial_reason",
        "next_action",
      ]);
      expect(economics?.forbidden_default_classes).toEqual(expect.arrayContaining([
        "prompt",
        "resolved_spec",
        "run_record",
        "kernel_receipt",
        "health_observations",
        "artifact_names",
        "filesystem_paths",
      ]));
      expect(economics?.default_class_exceptions).toEqual([
        {
          content_class: "filesystem_paths",
          field: "continuation.scope.runs_root",
          reason: "accepted_nonsecret_address",
        },
      ]);
      expect(economics?.overflow).toEqual({
        strategy: "field_cap_or_omit",
        metadata_field: "response_economics.overflow",
      });
      expect(economics?.detail_operations).toEqual(expect.arrayContaining([
        { operation: "run.status", variant: "details" },
        { operation: "run.receipt", variant: "full_record" },
        { operation: "run.kernel-receipt", variant: "kernel_evidence" },
      ]));
      expect(economics?.continuation).toEqual({
        next_action_field: "next_action",
        continuation_field: "continuation",
        representation: "typed_operation_ref",
      });
    }
    for (const id of ["activity.show", "activity.events"]) {
      expect(byId.get(id)?.effects, id).toMatchObject({ remote_provider: "read" });
    }
  });

  test("catalogs the schema-less self health result array without inventing a payload version", () => {
    const record = INTERFACE_MANIFEST_RECORDS.find((candidate) => candidate.id === "self.health");
    expect(record?.output_contract).toMatchObject({
      schema_version: null,
      json_schema_ref: "SelfHealthResult[]",
    });
  });

  test("publishes the expired run-worktree and resource-quarantine lease law", () => {
    const leases = INTERFACE_MANIFEST_RECORDS.filter((record) => (
      record.id.startsWith("lease.") && record.invocation_kind === "commander"
    ));
    expect(leases.length).toBeGreaterThan(0);
    for (const record of leases) {
      const notes = "guardrail_notes" in record.safety_contract
        ? record.safety_contract.guardrail_notes?.join("\n")
        : "";
      expect(notes).toContain("Expired run-held worktree leases remain fenced");
      expect(notes).toContain("resource quarantine blocks ordinary acquire, renew, release");
    }
    expect(leases.find((record) => record.id === "lease.acquire")?.error_contract.common_failures)
      .toContain("resource-quarantined worktree");
  });

  test("records the effect and contract hooks needed by Symphony guardrails without implementing them", () => {
    const plan = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "run.daemon.plan");
    const tick = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "run.daemon.tick");

    expect(plan?.mutation_class).toBe("preview");
    expect(plan?.effects).toMatchObject({
      remote_tracker: "read",
      process_launch: false,
      creates_worktree: false,
      dispatches_run: false,
      dry_run_default: true,
    });
    expect(plan?.selection_contract_ref).toBe("symphony.selection/v0");
    expect(plan?.workflow_policy_contract_ref).toBe("symphony.workflow-policy/v0");
    expect(plan?.reconciliation_contract_ref).toBe("symphony.reconciliation/v0");
    expect(plan?.stop_condition_contract_ref).toBe("symphony.stop-condition/v0");

    expect(tick?.mutation_class).toBe("long_running");
    expect(tick?.effects).toMatchObject({
      remote_tracker: "write",
      process_launch: true,
      creates_worktree: true,
      dispatches_run: true,
      receipt_required: true,
    });
    expect(tick?.receipt_contract_ref).toBe("symphony.receipt/v0");
    expect(tick?.grouping_contract_ref).toBe("symphony.grouping/v0");
    expect(tick?.stop_condition_contract_ref).toBe("symphony.stop-condition/v0");
  });

  test("declares convergence state writers and status readers honestly", () => {
    const freshness = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "self.freshness");
    const fleetStatus = INTERFACE_MANIFEST_RECORDS.find((record) => record.id === "fleet.status");

    expect(freshness?.mutation_class).toBe("apply");
    expect(freshness?.effects).toMatchObject({
      local_state: "write",
      remote_provider: "read",
      dry_run_default: false,
    });
    const freshnessSafety = freshness?.safety_contract as InterfaceSafetyContract | undefined;
    expect(freshnessSafety?.guardrail_notes ?? []).toContain(
      "Persists daemon-build convergence rows best-effort; persistence warnings never change freshness exit codes.",
    );
    expect(fleetStatus?.mutation_class).toBe("read_only");
    expect(fleetStatus?.effects.local_state).toBe("read");
    expect(fleetStatus?.reconciliation_contract_ref).toBe("fleet.convergence-status/v1");
  });

  test("validates agent-context v1 against covered manifest records and recipes", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync(["node", "calyx", "agent-context", "--json"]);

    const payload = JSON.parse(String(out.mock.calls[0]?.[0])) as {
      schema_version: string;
      generated_from: string;
      commands: Array<{ path: string }>;
      recipes: Array<{ id: string; commands: string[] }>;
    };
    const commandPaths = new Set(payload.commands.map((command) => command.path));
    const recipeIds = new Set(payload.recipes.map((recipe) => recipe.id));

    expect(payload.schema_version).toBe("calyx.agent-context/v1");
    expect(payload.generated_from).toBe("commander-introspection");

    for (const record of INTERFACE_MANIFEST_RECORDS) {
      if (record.invocation_kind === "commander") {
        expect(commandPaths, `agent-context missing manifest command path: ${record.agent_context.command_path}`).toContain(
          record.agent_context.command_path,
        );
      }
      for (const recipeId of record.agent_context.recipe_ids) {
        expect(recipeIds, `agent-context missing recipe ${recipeId} for ${record.id}`).toContain(recipeId);
      }
    }

    const symphonyRecipe = payload.recipes.find((recipe) => recipe.id === "symphony-tick");
    expect(symphonyRecipe?.commands).toEqual(
      expect.arrayContaining([
        "calyx run daemon plan --project <project> --json",
        "calyx run daemon tick --project <project> --json",
      ]),
    );
  });

  test("keeps Remote Body as an external descriptor fixture", () => {
    const remoteBody = INTERFACE_EXTERNAL_SERVICE_DESCRIPTORS.find((descriptor) => descriptor.id === "remote-body-worktree");

    expect(remoteBody).toBeDefined();
    expect(remoteBody?.surface_kind).toBe("external_service");
    expect(remoteBody?.execution_boundary).toBe("external_descriptor");
    expect(remoteBody?.domain).toBe("remote_body");
    expect(remoteBody?.effects).toMatchObject({
      remote_tracker: "write_on_apply",
      dry_run_default: true,
      receipt_required: true,
    });
    expect(remoteBody?.notes.join("\n")).toContain("Remote Body remains external");
  });

});
