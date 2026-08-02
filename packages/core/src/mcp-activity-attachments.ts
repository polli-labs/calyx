import {
  CALYX_INTERFACE_MANIFEST,
  INTERFACE_MANIFEST_RECORDS,
  type InterfaceManifestRecord
} from "./interface-manifest";
import type {
  CalyxMcpJsonSchemaV1,
  CalyxMcpManifestValidationV1,
  CalyxMcpToolBackingCommandV1,
  CalyxMcpToolBoundV1,
  CalyxMcpToolExampleV1
} from "./mcp-vault-context";

export const CALYX_MCP_ACTIVITY_ATTACHMENTS_SCHEMA_VERSION = "calyx.mcp.activity-attachments/v0" as const;
export const CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE = "activity-attachments" as const;

export type CalyxMcpActivityAttachmentsSurfaceV1 = typeof CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE;

export type CalyxMcpActivityAttachmentsToolNameV1 =
  | "activity_attachments_list"
  | "activity_attachment_record"
  | "activity_attachment_image";

export interface CalyxMcpActivityAttachmentToolDescriptorV1 {
  name: CalyxMcpActivityAttachmentsToolNameV1;
  title: string;
  description: string;
  input_schema: CalyxMcpJsonSchemaV1;
  output_schema_ref: string;
  read_only: true;
  mutation_class: "read_only";
  risk_class: "activity_attachment_metadata" | "activity_attachment_image_materialization";
  trust_posture: {
    returned_content: "calyx_metadata" | "mcp_image_content_block";
    notes: string[];
  };
  defaults: Record<string, string | number | boolean | string[]>;
  bounds: Record<string, CalyxMcpToolBoundV1>;
  backing_command: CalyxMcpToolBackingCommandV1;
  related_backing_commands?: CalyxMcpToolBackingCommandV1[];
  examples: CalyxMcpToolExampleV1[];
}

export interface CalyxMcpActivityAttachmentsManifestV1 {
  schema_version: typeof CALYX_MCP_ACTIVITY_ATTACHMENTS_SCHEMA_VERSION;
  surface: CalyxMcpActivityAttachmentsSurfaceV1;
  owner: "@polli-labs/calyx";
  generated_from: {
    interface_manifest_schema: typeof CALYX_INTERFACE_MANIFEST.schema_version;
    source: "calyx-interface-metadata";
  };
  transport: {
    recommended: "streamable-http";
    endpoint_path: "/mcp";
    supported: ["streamable-http"];
  };
  security: {
    default_host: "127.0.0.1";
    non_local_requires_auth_token: true;
    write_tools_exposed: false;
    bytes_in_activity_projection: false;
    image_tool_success_shape: "image_only_content_block";
  };
  tools: CalyxMcpActivityAttachmentToolDescriptorV1[];
  validation: CalyxMcpManifestValidationV1;
}

export interface BuildCalyxMcpActivityAttachmentsManifestOptionsV1 {
  commandPaths?: readonly string[];
  manifestRecords?: readonly InterfaceManifestRecord[];
}

const REQUIRED_TOOL_NAMES: CalyxMcpActivityAttachmentsToolNameV1[] = [
  "activity_attachments_list",
  "activity_attachment_record",
  "activity_attachment_image"
];

function stringSchema(description: string, maxLength?: number): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    ...(maxLength ? { maxLength } : {}),
    description
  };
}

function backingCommand(
  path: string,
  schemaRef: string,
  interfaceRecordId: string
): CalyxMcpToolBackingCommandV1 {
  return {
    path,
    schema_ref: schemaRef,
    interface_record_id: interfaceRecordId
  };
}

export function getCalyxMcpActivityAttachmentToolDescriptorsV1(): CalyxMcpActivityAttachmentToolDescriptorV1[] {
  const activityAttachmentsCommand = backingCommand("activity attachments", "ActivityAttachmentsResult", "activity.attachments");
  const mcpServeCommand = backingCommand("mcp serve", "CalyxMcpServeStartResultV1", "mcp.serve");
  return [
    {
      name: "activity_attachments_list",
      title: "List Activity Attachment Refs",
      description:
        "Use when an MCP client needs to discover activity attachment refs and metadata before deciding whether to fetch image bytes.",
      input_schema: {
        type: "object",
        required: ["activity_id"],
        additionalProperties: false,
        properties: {
          activity_id: stringSchema("Activity id, run:<id>, interactive:<backend>:<id>, or supported activity locator."),
          host: stringSchema("Optional explicit origin host scope, matching calyx activity attachments --host semantics.")
        }
      },
      output_schema_ref: "ActivityAttachmentsResult",
      read_only: true,
      mutation_class: "read_only",
      risk_class: "activity_attachment_metadata",
      trust_posture: {
        returned_content: "calyx_metadata",
        notes: [
          "Returns attachment records and refs only; no bytes, base64, or data URLs.",
          "Use activity_attachment_image only after choosing a specific image ref."
        ]
      },
      defaults: {},
      bounds: {
        activity_id: { min: 1, max: 512 },
        host: { min: 1, max: 128, notes: "Optional explicit host scope; no fleet fan-out is performed." }
      },
      backing_command: activityAttachmentsCommand,
      related_backing_commands: [mcpServeCommand],
      examples: [
        {
          title: "List refs for an activity",
          arguments: { activity_id: "interactive:codex:019dcafe" }
        }
      ]
    },
    {
      name: "activity_attachment_record",
      title: "Inspect Activity Attachment Record",
      description:
        "Use when an MCP client needs one activity attachment record and diagnostics without fetching bytes.",
      input_schema: {
        type: "object",
        required: ["activity_id", "ref"],
        additionalProperties: false,
        properties: {
          activity_id: stringSchema("Activity id, run:<id>, interactive:<backend>:<id>, or supported activity locator."),
          ref: stringSchema("Content-addressed attachment ref: att:sha256:<digest>."),
          host: stringSchema("Optional explicit origin host scope, matching calyx activity attachments --host semantics.")
        }
      },
      output_schema_ref: "ActivityAttachmentRecordResult",
      read_only: true,
      mutation_class: "read_only",
      risk_class: "activity_attachment_metadata",
      trust_posture: {
        returned_content: "calyx_metadata",
        notes: [
          "Returns one metadata record and typed diagnostics only.",
          "Metadata-only records with exact_bytes_available=false are returned as records, not byte attempts."
        ]
      },
      defaults: {},
      bounds: {
        activity_id: { min: 1, max: 512 },
        ref: { min: 75, max: 75, notes: "att:sha256: plus a 64-character hex digest." },
        host: { min: 1, max: 128, notes: "Optional explicit host scope; no fleet fan-out is performed." }
      },
      backing_command: activityAttachmentsCommand,
      related_backing_commands: [mcpServeCommand],
      examples: [
        {
          title: "Inspect one attachment record",
          arguments: {
            activity_id: "interactive:codex:019dcafe",
            ref: "att:sha256:0000000000000000000000000000000000000000000000000000000000000000"
          }
        }
      ]
    },
    {
      name: "activity_attachment_image",
      title: "Render Activity Attachment Image",
      description:
        "Use when an MCP client needs a selected activity image ref as an image-only MCP content block.",
      input_schema: {
        type: "object",
        required: ["activity_id", "ref"],
        additionalProperties: false,
        properties: {
          activity_id: stringSchema("Activity id, run:<id>, interactive:<backend>:<id>, or supported activity locator."),
          ref: stringSchema("Content-addressed image attachment ref: att:sha256:<digest>."),
          host: stringSchema("Optional explicit origin host scope, matching calyx activity attachments --host semantics.")
        }
      },
      output_schema_ref: "McpImageContentBlock",
      read_only: true,
      mutation_class: "read_only",
      risk_class: "activity_attachment_image_materialization",
      trust_posture: {
        returned_content: "mcp_image_content_block",
        notes: [
          "Successful results contain exactly one MCP image content block and no structuredContent.",
          "Bytes are served only through sha256-verified cache materialization; activity projections remain byte-free."
        ]
      },
      defaults: {},
      bounds: {
        activity_id: { min: 1, max: 512 },
        ref: { min: 75, max: 75, notes: "att:sha256: plus a 64-character hex digest." },
        host: { min: 1, max: 128, notes: "Optional explicit host scope; no fleet fan-out is performed." }
      },
      backing_command: activityAttachmentsCommand,
      related_backing_commands: [mcpServeCommand],
      examples: [
        {
          title: "Return an image content block",
          arguments: {
            activity_id: "interactive:codex:019dcafe",
            ref: "att:sha256:0000000000000000000000000000000000000000000000000000000000000000"
          }
        }
      ]
    }
  ];
}

function commandPathsFromRecords(records: readonly InterfaceManifestRecord[]): string[] {
  return records.map((record) => record.agent_context.command_path);
}

function validateDescriptor(
  descriptor: CalyxMcpActivityAttachmentToolDescriptorV1,
  recordById: ReadonlyMap<string, InterfaceManifestRecord>,
  commandPathSet: ReadonlySet<string>
): CalyxMcpManifestValidationV1["checks"] {
  const checks: CalyxMcpManifestValidationV1["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id: `${descriptor.name}.${id}`, status: ok ? "ok" : "error", detail });
  };

  add("description", descriptor.description.startsWith("Use when "), "description starts with 'Use when'");
  add("input_schema", descriptor.input_schema.type === "object", "input schema is an object schema");
  add("output_schema_ref", descriptor.output_schema_ref.trim().length > 0, "output schema ref is present");
  add("read_only", descriptor.read_only === true && descriptor.mutation_class === "read_only", "tool is read-only");
  add("no_bytes_in_metadata", descriptor.name !== "activity_attachment_image" || descriptor.output_schema_ref === "McpImageContentBlock", "image bytes are isolated to the image tool");

  for (const command of [descriptor.backing_command, ...(descriptor.related_backing_commands ?? [])]) {
    add(
      `interface_record.${command.interface_record_id}`,
      recordById.has(command.interface_record_id),
      `interface record ${command.interface_record_id} exists`
    );
    add(
      `command_path.${command.path.replace(/\s+/g, ".")}`,
      commandPathSet.has(command.path),
      `backing command '${command.path}' exists in Commander/agent-context inventory`
    );
  }

  return checks;
}

export function validateCalyxMcpActivityAttachmentsManifestV1(
  tools: readonly CalyxMcpActivityAttachmentToolDescriptorV1[],
  options: BuildCalyxMcpActivityAttachmentsManifestOptionsV1 = {}
): CalyxMcpManifestValidationV1 {
  const records = options.manifestRecords ?? INTERFACE_MANIFEST_RECORDS;
  const recordById = new Map(records.map((record) => [record.id, record]));
  const commandPathSet = new Set(options.commandPaths ?? commandPathsFromRecords(records));
  const checks: CalyxMcpManifestValidationV1["checks"] = [];
  const toolNames = new Set(tools.map((tool) => tool.name));

  for (const name of REQUIRED_TOOL_NAMES) {
    checks.push({
      id: `required_tool.${name}`,
      status: toolNames.has(name) ? "ok" : "error",
      detail: `required tool ${name} is present`
    });
  }

  checks.push({
    id: "no_write_tools",
    status: tools.every((tool) => tool.read_only && tool.mutation_class === "read_only") ? "ok" : "error",
    detail: "all exposed tools are read-only"
  });
  checks.push({
    id: "image_only_success_shape",
    status: tools.some((tool) => tool.name === "activity_attachment_image" && tool.output_schema_ref === "McpImageContentBlock") ? "ok" : "error",
    detail: "activity_attachment_image declares image-only content output"
  });

  for (const tool of tools) {
    checks.push(...validateDescriptor(tool, recordById, commandPathSet));
  }

  return {
    ok: checks.every((check) => check.status === "ok"),
    checks
  };
}

export function buildCalyxMcpActivityAttachmentsManifestV1(
  options: BuildCalyxMcpActivityAttachmentsManifestOptionsV1 = {}
): CalyxMcpActivityAttachmentsManifestV1 {
  const tools = getCalyxMcpActivityAttachmentToolDescriptorsV1();
  return {
    schema_version: CALYX_MCP_ACTIVITY_ATTACHMENTS_SCHEMA_VERSION,
    surface: CALYX_MCP_ACTIVITY_ATTACHMENTS_SURFACE,
    owner: "@polli-labs/calyx",
    generated_from: {
      interface_manifest_schema: CALYX_INTERFACE_MANIFEST.schema_version,
      source: "calyx-interface-metadata"
    },
    transport: {
      recommended: "streamable-http",
      endpoint_path: "/mcp",
      supported: ["streamable-http"]
    },
    security: {
      default_host: "127.0.0.1",
      non_local_requires_auth_token: true,
      write_tools_exposed: false,
      bytes_in_activity_projection: false,
      image_tool_success_shape: "image_only_content_block"
    },
    tools,
    validation: validateCalyxMcpActivityAttachmentsManifestV1(tools, options)
  };
}
